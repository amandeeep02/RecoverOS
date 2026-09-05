// lib/degradation.ts
import { Clock } from "@/lib/clock";
import type { RecoveryStore } from "@/lib/store";
import type { PaymentEvent } from "@/lib/domain";
import { mulberry32, type Rng } from "@/lib/rng";

export const DEGRADATION_CONFIG = {
  WINDOW_MS: 15 * 60 * 1000,      // 15-minute tumbling window
  EWMA_ALPHA: 0.1,                 // baseline smoothing
  TRIGGER_RATIO: 3.0,              // fire when observed ≥ 3× baseline
  MIN_ATTEMPTS: 20,                // per window, per key — small-sample guard
  MIN_ABSOLUTE_RATE: 0.15,         // never fire below this failure rate
  CLOSE_RATIO: 2.1,                // = TRIGGER_RATIO × 0.7, hysteresis
  CLOSE_WINDOWS: 2,                // consecutive windows below CLOSE_RATIO
  DRAIN_JITTER_MS: 120_000,        // spread requeues over 2 min
  BASELINE_SEED_WINDOWS: 8,        // warm-up before detector may fire
} as const;

export interface DegradationKey {
  method: string;
  issuer: string | null;
  network: string | null;
}

export interface WindowCounter {
  attempts: number;
  failures: number;
}

export interface DegradationWindow {
  id: string;
  key: DegradationKey;
  baselineRate: number;
  observedRate: number;
  ratio: number;
  attempts: number;
  openedAtMs: number;
  closedAtMs: number | null;
  episodesHeld: number;
}

export interface DegradationResult {
  opened: DegradationWindow[];
  closed: DegradationWindow[];
  heldEpisodes: string[];
}

function keyToString(key: DegradationKey): string {
  return `${key.method}|${key.issuer ?? "-"}|${key.network ?? "-"}`;
}

export function degradationKey(e: PaymentEvent): DegradationKey {
  return {
    method: e.paymentMethod,
    issuer: (e.railMetadata?.issuer as string | null) ?? null,
    network: (e.railMetadata?.network as string | null) ?? null,
  };
}

export class DegradationDetector {
  private readonly windows = new Map<string, { 
    baseline: number; 
    open: boolean; 
    window: DegradationWindow | null; 
    consecutiveBelow: number; 
    seenWindows: number;
    counters: WindowCounter;
  }>();
  
  private readonly store: RecoveryStore;
  private readonly clock: Clock;
  private readonly rng: Rng;

  constructor(store: RecoveryStore, clock: Clock = { now: () => Date.now() }, rng?: Rng) {
    this.store = store;
    this.clock = clock;
    this.rng = rng ?? mulberry32(42);
  }

  record(e: PaymentEvent, failed: boolean): void {
    const key = degradationKey(e);
    const keyStr = keyToString(key);
    let state = this.windows.get(keyStr);
    if (!state) {
      state = {
        baseline: 0.05, // initial prior
        open: false,
        window: null,
        consecutiveBelow: 0,
        seenWindows: 0,
        counters: { attempts: 0, failures: 0 },
      };
      this.windows.set(keyStr, state);
    }
    state.counters.attempts++;
    if (failed) state.counters.failures++;
  }

  tick(): { opened: DegradationWindow[]; closed: DegradationWindow[] } {
    const now = this.clock.now();
    const opened: DegradationWindow[] = [];
    const closed: DegradationWindow[] = [];

    for (const [keyStr, state] of this.windows.entries()) {
      const { attempts, failures } = state.counters;
      const rate = attempts === 0 ? 0 : failures / attempts;

      if (state.open) {
        const ratio = state.baseline === 0 ? 0 : rate / state.baseline;
        if (ratio < DEGRADATION_CONFIG.CLOSE_RATIO) {
          state.consecutiveBelow++;
        } else {
          state.consecutiveBelow = 0;
        }
        if (state.consecutiveBelow >= DEGRADATION_CONFIG.CLOSE_WINDOWS) {
          // Close the window
          if (state.window) {
            state.window.closedAtMs = now;
            state.window.ratio = ratio;
            closed.push(state.window);
          }
          state.open = false;
          state.window = null;
          state.consecutiveBelow = 0;
        }
        // ⚠ DO NOT UPDATE BASELINE WHILE OPEN
      } else {
        // ⚠ ORDER MATTERS. The window under test is compared against the baseline as it
        // stood BEFORE this window, never against a baseline this window has already
        // been folded into. Updating first makes a spike inflate the very level it is
        // measured against: with α = 0.1 a true r = k·b reads as k / (0.1k + 0.9), so a
        // 3× step measured 2.5× and never fired, and a genuine 12× outage was reported
        // as 5.7×. The detector needed a 3.86× event to notice a 3× threshold breach.
        // This is the same failure as updating the baseline while a window is open
        // (§6.C) — one window earlier.
        const priorBaseline = state.baseline;
        const ratio = priorBaseline > 0 ? rate / priorBaseline : 0;
        const fires =
          state.seenWindows >= DEGRADATION_CONFIG.BASELINE_SEED_WINDOWS &&
          attempts >= DEGRADATION_CONFIG.MIN_ATTEMPTS &&
          rate >= DEGRADATION_CONFIG.MIN_ABSOLUTE_RATE &&
          priorBaseline > 0 &&
          ratio >= DEGRADATION_CONFIG.TRIGGER_RATIO;

        state.seenWindows++;

        if (fires) {
          // Open new degradation window. The baseline is NOT advanced: the freeze that
          // §6.C requires while a window is open starts with the window that opens it.
          const window: DegradationWindow = {
            id: `deg_${keyStr}_${now}`,
            key: this.parseKey(keyStr),
            baselineRate: priorBaseline,
            observedRate: rate,
            ratio,
            attempts,
            openedAtMs: now,
            closedAtMs: null,
            episodesHeld: 0,
          };
          state.open = true;
          state.window = window;
          opened.push(window);
        } else {
          // Healthy window (or one blocked by a guard): fold it into the baseline.
          state.baseline = DEGRADATION_CONFIG.EWMA_ALPHA * rate + (1 - DEGRADATION_CONFIG.EWMA_ALPHA) * priorBaseline;
        }
      }

      // Reset counters for next window
      state.counters = { attempts: 0, failures: 0 };
    }

    return { opened, closed };
  }

  private parseKey(keyStr: string): DegradationKey {
    const [method, issuer, network] = keyStr.split("|");
    return { method, issuer: issuer === "-" ? null : issuer, network: network === "-" ? null : network };
  }

  isDegraded(key: DegradationKey): DegradationWindow | null {
    const keyStr = keyToString(key);
    const state = this.windows.get(keyStr);
    return state?.open ? state.window! : null;
  }

  getAllOpen(): DegradationWindow[] {
    const result: DegradationWindow[] = [];
    for (const state of this.windows.values()) {
      if (state.open && state.window) result.push(state.window);
    }
    return result;
  }

  /** Observable state of every key the detector has ever seen. Read-only projection. */
  keyHealth(): KeyHealth[] {
    const rows: KeyHealth[] = [];
    for (const [keyStr, state] of this.windows.entries()) {
      const { attempts, failures } = state.counters;
      rows.push({
        key: this.parseKey(keyStr),
        keyString: keyStr,
        baselineRate: state.baseline,
        currentWindowAttempts: attempts,
        currentWindowFailures: failures,
        currentWindowRate: attempts === 0 ? null : failures / attempts,
        seenWindows: state.seenWindows,
        warmedUp: state.seenWindows >= DEGRADATION_CONFIG.BASELINE_SEED_WINDOWS,
        open: state.open,
        windowId: state.window?.id ?? null,
      });
    }
    return rows;
  }

  /**
   * Delay before a held episode is requeued. Releasing every held episode the
   * instant an issuer recovers is a thundering herd into a system that has just
   * come back up, so the drain is spread over `DRAIN_JITTER_MS`.
   */
  drainDelayMs(): number {
    return Math.floor(this.rng.next() * DEGRADATION_CONFIG.DRAIN_JITTER_MS);
  }
}

export interface KeyHealth {
  key: DegradationKey;
  keyString: string;
  baselineRate: number;
  currentWindowAttempts: number;
  currentWindowFailures: number;
  currentWindowRate: number | null;
  seenWindows: number;
  warmedUp: boolean;
  open: boolean;
  windowId: string | null;
}

export function keyString(key: DegradationKey): string {
  return keyToString(key);
}

/**
 * Process-wide detector. It has to be a singleton for the same reason `lib/store.ts`
 * is: the 15-minute window state, the frozen baseline and the hysteresis counter are
 * the detector's memory, and a per-request instance has none. Held to `globalThis` so
 * a dev-server hot reload does not silently reset an open outage window.
 */
const globalDetector = globalThis as unknown as { recoverOsDegradation?: DegradationDetector };

export function getDegradationDetector(store: RecoveryStore): DegradationDetector {
  return globalDetector.recoverOsDegradation ?? (globalDetector.recoverOsDegradation = new DegradationDetector(store));
}