"use client";

import { useState } from "react";
import type { DegradationView, EpisodeView } from "@/app/_lib/dashboard";

interface KillSwitchProps {
  degradation: DegradationView;
  held: EpisodeView[];
  onChanged: () => void;
}

type Busy = null | "open" | "close" | "drain-now" | "tick";

/**
 * The Kill Switch (IDEA.md §11, 1:05).
 *
 * Both columns are counted, not asserted. `held` is the number of episodes actually
 * sitting in HELD_DEGRADED, and the baseline column is the SAME number, because the
 * baseline strategy would have fired one attempt at every one of them. Nothing here
 * is priced in rupees: at a ₹3 retry cost the wasted spend is too small to carry the
 * moment, and inflating it would be the one dishonest number in the product. The
 * cost that matters is the attempt budget, and that is counted in attempts.
 *
 * "Soft declines hardened" is deliberately absent. We cannot observe it, so we do
 * not show it.
 */
export function KillSwitch({ degradation, held, onChanged }: KillSwitchProps) {
  const [busy, setBusy] = useState<Busy>(null);
  const [note, setNote] = useState<string | null>(null);
  const open = degradation.open;
  const heldCount = held.length;

  const call = async (action: Exclude<Busy, null>) => {
    setBusy(action);
    setNote(null);
    try {
      const url = action === "tick" ? "/api/degradation/tick" : "/api/demo/outage";
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: action === "tick" ? undefined : JSON.stringify({ action }),
      });
      const data = await res.json();
      if (action === "open") setNote(`Detector opened ${data.opened} window(s); ${data.held} episode(s) held by the policy gate.`);
      if (action === "close") setNote(`Detector closed ${data.closed} window(s); ${data.drainScheduled?.length ?? 0} episode(s) queued for jittered drain.`);
      if (action === "drain-now") setNote(`Released ${data.released?.length ?? 0} episode(s), skipping the drain jitter.`);
      if (action === "tick") setNote(`Window advanced: ${data.opened} opened, ${data.closed} closed.`);
      onChanged();
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Request failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="kill-switch" aria-label="Issuer weather">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Issuer weather · §6.C</p>
          <h2>{open.length > 0 ? "The agent has stopped itself" : "No open degradation window"}</h2>
        </div>
        <div className="kill-switch-actions">
          <button type="button" disabled={busy !== null} onClick={() => call("open")}>
            {busy === "open" ? "Injecting…" : "Simulate issuer outage"}
          </button>
          <button type="button" disabled={busy !== null || open.length === 0} onClick={() => call("close")}>
            {busy === "close" ? "Recovering…" : "Issuer recovers"}
          </button>
          <button type="button" disabled={busy !== null || heldCount === 0} onClick={() => call("drain-now")}>
            {busy === "drain-now" ? "Draining…" : "Skip drain jitter"}
          </button>
          <button type="button" disabled={busy !== null} onClick={() => call("tick")}>
            {busy === "tick" ? "…" : "Advance window"}
          </button>
        </div>
      </div>

      {open.length > 0 && (
        <div className="split-screen">
          <div className="split-column baseline">
            <h3>Retry-everything baseline</h3>
            <ul>
              <li><strong>{heldCount}</strong> attempts fired into a degraded issuer</li>
              <li><strong>{heldCount}</strong> attempt-budget slots burned</li>
              <li><strong>{heldCount}</strong> customers contacted during a known outage</li>
            </ul>
          </div>
          <div className="split-column recoveros">
            <h3>RecoverOS</h3>
            <ul>
              <li><strong>0</strong> attempts fired</li>
              <li><strong>{heldCount}</strong> episodes held, attempt budget intact</li>
              <li><strong>0</strong> customers contacted · contact deferred to a working issuer</li>
            </ul>
          </div>
        </div>
      )}

      <div className="weather-grid">
        {degradation.keys.length === 0 && <p className="muted-note">No attempts observed yet on any rail.</p>}
        {degradation.keys.map((key) => (
          <div key={key.keyString} className={`weather-key ${key.open ? "degraded" : key.warmedUp ? "healthy" : "warming"}`}>
            <strong>{key.keyString.replace(/\|/g, " · ")}</strong>
            <span>
              baseline {(key.baselineRate * 100).toFixed(1)}%
              {key.currentWindowRate !== null ? ` · window ${(key.currentWindowRate * 100).toFixed(0)}% of ${key.currentWindowAttempts}` : ` · ${key.currentWindowAttempts} attempts this window`}
            </span>
            <span className="weather-state">
              {key.open ? "DEGRADED" : key.warmedUp ? "HEALTHY" : `WARMING UP ${key.seenWindows}/${degradation.config.warmupWindows}`}
            </span>
          </div>
        ))}
      </div>

      {note && <p className="kill-switch-note">{note}</p>}

      <p className="method-line">
        Detector: {degradation.config.windowMinutes}-minute tumbling windows, EWMA baseline,
        fires at ≥{degradation.config.triggerRatio}× baseline with ≥{degradation.config.minAttempts} attempts and
        ≥{(degradation.config.minAbsoluteRate * 100).toFixed(0)}% absolute failure rate, after
        {" "}{degradation.config.warmupWindows} warm-up windows; baseline freezes while open; closes below
        {" "}{degradation.config.closeRatio}× for {degradation.config.closeWindows} consecutive windows; drains with
        0–{Math.round(degradation.config.drainJitterMs / 1000)}s jitter.
        The outage button injects a synthetic attempt feed on one key and advances the window
        cadence — a warm-up alone is {degradation.config.warmupWindows * degradation.config.windowMinutes} minutes
        of live traffic. The detector, the thresholds, the holds and the drain are the production ones.
      </p>
    </section>
  );
}
