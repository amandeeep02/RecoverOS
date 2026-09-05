import type { AuditEvent, CustomerProfile, CustomerResponse, ExecutionResult, RecoveryEpisode } from "@/lib/domain";
import type { PromiseToPay } from "@/lib/voice";

function copy<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Where an ingested webhook is in its lifecycle, independent of the recovery
 * `status` the merchant sees. Razorpay's delivery timeout is measured in seconds,
 * so the webhook handler persists the event and returns; a worker claims the row
 * and runs the pipeline. The claim is durable — a process that dies mid-episode
 * leaves a `PROCESSING` row whose claim goes stale and is re-claimed, rather than
 * an episode nobody owns.
 */
export type ProcessingState = "PENDING" | "PROCESSING" | "DONE" | "FAILED";

export interface EpisodeProcessing {
  state: ProcessingState;
  claimedAtMs: number | null;
  attempts: number;
  drainDueAtMs: number | null;
}

/**
 * Actions that put a message in front of a human. Contact fatigue counts these and
 * nothing else — a silent retry is not something a customer can get tired of.
 *
 * This lives beside the store rather than in the pipeline because both adapters
 * have to encode the same predicate: the in-memory scan and the Postgres `COUNT`
 * are one rule with two implementations, and `tests/production.test.ts` pins them
 * to the same answer.
 */
export const CONTACT_ACTIONS = ["REMINDER", "PAYMENT_LINK", "VOICE_CALL"] as const;
const CONTACT_ACTION_SET: ReadonlySet<string> = new Set(CONTACT_ACTIONS);
/** An execution that actually left the building. */
export const DELIVERED_EXECUTION_STATUSES = ["EXECUTED", "SIMULATED"] as const;
const DELIVERED_SET: ReadonlySet<string> = new Set(DELIVERED_EXECUTION_STATUSES);

/**
 * One degradation key's detector memory, in a shape that survives a deploy.
 * The EWMA baseline, the open window and the hysteresis counter ARE the detector;
 * a process-local copy means a restart silently re-arms an outage that never ended
 * and two instances behind a load balancer disagree about the same issuer.
 */
export interface PersistedDegradationState {
  keyString: string;
  baseline: number;
  open: boolean;
  consecutiveBelow: number;
  seenWindows: number;
  attempts: number;
  failures: number;
  window: Record<string, unknown> | null;
  updatedAtMs: number;
}

/** How many times a queued episode may be claimed before it is left alone. */
export const MAX_PROCESSING_ATTEMPTS = 5;

/** In-memory persistence adapter. Used for tests and as the fallback when DATABASE_URL is unset. All methods are async. */
export class RecoveryStore {
  private readonly webhookEvents = new Map<string, string>();
  private readonly episodes = new Map<string, RecoveryEpisode>();
  private readonly profiles = new Map<string, CustomerProfile>();
  private readonly audits = new Map<string, ReadonlyArray<AuditEvent>>();
  private readonly executions = new Map<string, ExecutionResult>();
  private readonly promises = new Map<string, PromiseToPay[]>();
  private readonly processing = new Map<string, EpisodeProcessing>();
  private readonly degradation = new Map<string, PersistedDegradationState>();

  async registerWebhook(eventId: string, episodeId: string) {
    if (this.webhookEvents.has(eventId)) return { inserted: false, episodeId: this.webhookEvents.get(eventId)! };
    this.webhookEvents.set(eventId, episodeId);
    return { inserted: true, episodeId };
  }

  async getEpisodeByWebhook(eventId: string) {
    const episodeId = this.webhookEvents.get(eventId);
    return episodeId ? this.getEpisode(episodeId) : undefined;
  }

  async getEpisodeByCallSid(callSid: string) {
    return (await this.listEpisodes()).find((episode) => episode.execution?.externalReference === callSid);
  }

  async getLatestEpisodeByPhone(phone: string) {
    return (await this.listEpisodes()).find((episode) => episode.profile.phone === phone);
  }

  async appendCustomerResponse(episodeId: string, response: CustomerResponse) {
    const episode = await this.getEpisode(episodeId);
    if (!episode) return undefined;
    return this.saveEpisode({ ...episode, customerResponses: [...episode.customerResponses, response], updatedAt: new Date().toISOString() });
  }

  async saveEpisode(episode: RecoveryEpisode) {
    this.episodes.set(episode.id, copy(episode));
    return (await this.getEpisode(episode.id))!;
  }

  async getEpisode(id: string) {
    const value = this.episodes.get(id);
    return value ? copy(value) : undefined;
  }

  async listEpisodes() {
    return [...this.episodes.values()].map(copy).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async saveProfile(profile: CustomerProfile) {
    this.profiles.set(`${profile.merchantId}:${profile.customerId}`, copy(profile));
  }

  async getProfile(merchantId: string, customerId: string) {
    const value = this.profiles.get(`${merchantId}:${customerId}`);
    return value ? copy(value) : undefined;
  }

  async appendAudit(event: AuditEvent) {
    const existing = this.audits.get(event.episodeId) ?? [];
    if (existing.some((entry) => entry.auditId === event.auditId)) throw new Error(`Audit event ${event.auditId} already exists`);
    const immutable = Object.freeze(copy(event));
    this.audits.set(event.episodeId, Object.freeze([...existing, immutable]));
  }

  async getAudit(episodeId: string) {
    return (this.audits.get(episodeId) ?? []).map(copy);
  }

  /** Every requested id is a key in the result, empty when the episode has no trail. */
  async getAuditForEpisodes(episodeIds: ReadonlyArray<string>): Promise<Record<string, AuditEvent[]>> {
    const audits: Record<string, AuditEvent[]> = {};
    for (const id of episodeIds) audits[id] = (this.audits.get(id) ?? []).map(copy);
    return audits;
  }

  async getExecution(idempotencyKey: string) {
    const value = this.executions.get(idempotencyKey);
    return value ? copy(value) : undefined;
  }

  async saveExecution(idempotencyKey: string, episodeId: string, action: string, execution: ExecutionResult) {
    this.executions.set(idempotencyKey, copy(execution));
  }

  async getPromises(episodeId: string) {
    return (this.promises.get(episodeId) ?? []).map(copy);
  }

  async savePromises(episodeId: string, promises: PromiseToPay[]) {
    this.promises.set(episodeId, promises.map(copy));
  }

  /**
   * How many contact actions reached this customer since `sinceMs`.
   *
   * The pipeline used to answer this by pulling every episode in the table into
   * Node and filtering in a loop — O(all episodes) on every `payment.failed`. The
   * predicate is narrow and indexable, so it belongs in the store: here it is a
   * scan over the live map with no cloning and no sort, and in Postgres it is an
   * indexed `COUNT` over one customer's rows.
   */
  async countContactsSince(merchantId: string, customerId: string, sinceMs: number, excludeEpisodeId?: string): Promise<number> {
    let n = 0;
    for (const episode of this.episodes.values()) {
      if (excludeEpisodeId && episode.id === excludeEpisodeId) continue;
      if (episode.event.customerId !== customerId) continue;
      if (episode.event.merchantId !== merchantId) continue;
      const execution = episode.execution;
      if (!execution || !DELIVERED_SET.has(execution.status)) continue;
      const action = episode.policyDecision?.allowedAction ?? episode.proposal?.action ?? null;
      if (!action || !CONTACT_ACTION_SET.has(action)) continue;
      const at = Date.parse(execution.executedAt);
      if (Number.isNaN(at) || at < sinceMs) continue;
      n += 1;
    }
    return n;
  }

  /** Episodes in one status, newest first. The degradation drain wants the handful
   *  of `HELD_DEGRADED` rows, not the whole table. */
  async listEpisodesByStatus(status: RecoveryEpisode["status"], limit = 1_000): Promise<RecoveryEpisode[]> {
    const out: RecoveryEpisode[] = [];
    for (const episode of this.episodes.values()) if (episode.status === status) out.push(episode);
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return out.slice(0, limit).map(copy);
  }

  /** Put a persisted episode on the work queue. Idempotent: re-queuing a row that is
   *  already pending is a no-op, and the attempt counter is never reset by it. */
  async markEpisodeQueued(episodeId: string): Promise<void> {
    const current = this.processing.get(episodeId);
    // A row a worker currently holds is left alone: re-queuing it under the worker
    // would hand the same episode to a second one. The Postgres adapter applies the
    // same guard in its WHERE clause.
    if (current?.state === "PROCESSING") return;
    this.processing.set(episodeId, {
      state: "PENDING",
      claimedAtMs: null,
      attempts: current?.attempts ?? 0,
      drainDueAtMs: current?.drainDueAtMs ?? null,
    });
  }

  /**
   * Take exclusive ownership of one queued episode, oldest first.
   *
   * A claim older than `claimTimeoutMs` is treated as abandoned and may be taken
   * again — that is what makes a crashed or redeployed worker recoverable without a
   * broker. `maxAttempts` stops a poison event from being retried forever.
   */
  async claimEpisodeForProcessing(nowMs: number, claimTimeoutMs: number, maxAttempts = MAX_PROCESSING_ATTEMPTS): Promise<RecoveryEpisode | undefined> {
    const staleBefore = nowMs - claimTimeoutMs;
    let bestId: string | undefined;
    let bestCreatedAt: string | undefined;
    for (const [episodeId, state] of this.processing.entries()) {
      if (state.attempts >= maxAttempts) continue;
      const claimable = state.state === "PENDING" || (state.state === "PROCESSING" && state.claimedAtMs !== null && state.claimedAtMs <= staleBefore);
      if (!claimable) continue;
      const episode = this.episodes.get(episodeId);
      if (!episode) continue;
      if (bestCreatedAt === undefined || episode.createdAt < bestCreatedAt) {
        bestCreatedAt = episode.createdAt;
        bestId = episodeId;
      }
    }
    if (!bestId) return undefined;
    const current = this.processing.get(bestId)!;
    this.processing.set(bestId, { ...current, state: "PROCESSING", claimedAtMs: nowMs, attempts: current.attempts + 1 });
    return this.getEpisode(bestId);
  }

  /** Release a claim. `FAILED` is a dead letter: it is not re-claimed. */
  async completeEpisodeProcessing(episodeId: string, state: Extract<ProcessingState, "DONE" | "FAILED">): Promise<void> {
    const current = this.processing.get(episodeId);
    if (!current) return;
    this.processing.set(episodeId, { ...current, state, claimedAtMs: null });
  }

  async getEpisodeProcessing(episodeId: string): Promise<EpisodeProcessing | undefined> {
    const value = this.processing.get(episodeId);
    return value ? { ...value } : undefined;
  }

  /** Persist when a held episode should be requeued, so the drain survives a deploy. */
  async scheduleEpisodeDrain(episodeId: string, dueAtMs: number): Promise<void> {
    const current = this.processing.get(episodeId) ?? { state: "DONE" as ProcessingState, claimedAtMs: null, attempts: 0, drainDueAtMs: null };
    this.processing.set(episodeId, { ...current, drainDueAtMs: dueAtMs });
  }

  /**
   * Claim every drain that has come due, clearing the due time in the same step so a
   * second reader gets nothing. Single-writer by construction — no lock service.
   */
  async claimDueDrains(nowMs: number, limit = 200): Promise<string[]> {
    const due: string[] = [];
    for (const [episodeId, state] of this.processing.entries()) {
      if (state.drainDueAtMs === null || state.drainDueAtMs > nowMs) continue;
      if (this.episodes.get(episodeId)?.status !== "HELD_DEGRADED") continue;
      due.push(episodeId);
      if (due.length >= limit) break;
    }
    for (const episodeId of due) {
      const state = this.processing.get(episodeId)!;
      this.processing.set(episodeId, { ...state, drainDueAtMs: null });
    }
    return due;
  }

  async saveDegradationState(states: ReadonlyArray<PersistedDegradationState>): Promise<void> {
    for (const state of states) this.degradation.set(state.keyString, copy(state) as PersistedDegradationState);
  }

  async loadDegradationState(): Promise<PersistedDegradationState[]> {
    return [...this.degradation.values()].map(copy);
  }

  async reset() {
    this.webhookEvents.clear();
    this.episodes.clear();
    this.profiles.clear();
    this.audits.clear();
    this.executions.clear();
    this.promises.clear();
    this.processing.clear();
    this.degradation.clear();
  }
}
