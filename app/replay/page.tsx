"use client";

import { useEffect, useMemo, useState } from "react";
import { formatInr, rupees } from "@/lib/domain";
import type { ReplayResult } from "@/lib/replay";

type ReplayResponse = ReplayResult & {
  policyApplied: { minimumEirPaise: number; maxAutomatedAttempts: number; churnAversion: number; allowRetry: boolean; holdoutPct: number };
  episodesConsidered: number;
  episodesWithObservedOutcome: number;
};

const PRESETS = [
  { id: "current", name: "Shipped defaults (₹150 EIR floor)", policy: { minimumEirPaise: rupees(150), churnAversion: 1 } },
  { id: "aggressive", name: "Aggressive (₹50 EIR floor)", policy: { minimumEirPaise: rupees(50), churnAversion: 1 } },
  { id: "conservative", name: "Conservative (₹500 EIR floor)", policy: { minimumEirPaise: rupees(500), churnAversion: 1 } },
  { id: "protective", name: "Churn-averse (×2 churn weight)", policy: { minimumEirPaise: rupees(150), churnAversion: 2 } },
  { id: "indifferent", name: "Churn-blind (×0 churn weight)", policy: { minimumEirPaise: rupees(150), churnAversion: 0 } },
];

function Delta({ paise }: { paise: number }) {
  return <span className={paise >= 0 ? "positive" : "negative"}>{paise >= 0 ? "+" : "−"}{formatInr(Math.abs(paise))}</span>;
}

export default function ReplayConsolePage() {
  const [episodeCount, setEpisodeCount] = useState<number | null>(null);
  const [preset, setPreset] = useState(PRESETS[1].id);
  const [result, setResult] = useState<ReplayResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/episodes")
      .then((r) => r.json())
      .then((d) => setEpisodeCount(Array.isArray(d.episodes) ? d.episodes.length : 0))
      .catch(() => setEpisodeCount(null));
  }, []);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const chosen = PRESETS.find((p) => p.id === preset)!;
      const res = await fetch("/api/replay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy: chosen.policy }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Replay failed");
      setResult(data as ReplayResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Replay failed");
    } finally {
      setBusy(false);
    }
  };

  const observedPct = useMemo(() => (result ? result.observedFraction * 100 : 0), [result]);

  return (
    <main className="replay-console">
      <header className="replay-header">
        <div>
          <h1>Replay console</h1>
          <p className="subtitle">
            Change a policy knob, replay the episodes in the store, see the delta before shipping.
            {episodeCount !== null && ` ${episodeCount} episodes available.`}
          </p>
        </div>
        <div className="header-actions">
          <select value={preset} onChange={(e) => setPreset(e.target.value)} className="policy-select">
            {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button className="primary-btn" onClick={run} disabled={busy || episodeCount === 0}>
            {busy ? "Replaying…" : "Run replay"}
          </button>
          <a className="secondary-link" href="/">← Dashboard</a>
        </div>
      </header>

      {error && <p className="replay-error">{error}</p>}

      {result && (
        <>
          <section className="honesty-bar" aria-live="polite">
            <div className="honesty-split">
              <div className="observed-bar" style={{ width: `${observedPct}%` }} />
            </div>
            <p>
              <strong>{observedPct.toFixed(1)}% of these outcomes are observed</strong> — the replayed
              action matched what actually happened, so the real result was reused.
              {" "}<strong>{(100 - observedPct).toFixed(1)}% are modelled</strong> ({result.modelledCount} of{" "}
              {result.episodesReplayed} episodes), drawn from the same scorer that runs in production.
              {result.episodesWithObservedOutcome < result.episodesReplayed && (
                <> {result.episodesReplayed - result.episodesWithObservedOutcome} episode(s) have no settled outcome yet and can only be modelled.</>
              )}
            </p>
          </section>

          <section className="results-summary">
            <div className="summary-cards">
              <div className="summary-card">
                <span className="label">Interventions</span>
                <span className="value">{result.deltaInterventions >= 0 ? "+" : "−"}{Math.abs(result.deltaInterventions)}</span>
                <span className="footnote">{result.observed.interventions} → {result.replayed.interventions}</span>
              </div>
              <div className="summary-card">
                <span className="label">Gross recovered</span>
                <span className="value"><Delta paise={result.deltaRecoveredPaise} /></span>
                <span className="footnote">{formatInr(result.observed.recoveredPaise)} → {formatInr(result.replayed.recoveredPaise)}</span>
              </div>
              <div className="summary-card">
                <span className="label">Intervention cost</span>
                <span className="value"><Delta paise={result.deltaInterventionCostPaise} /></span>
                <span className="footnote">{formatInr(result.observed.interventionCostPaise)} → {formatInr(result.replayed.interventionCostPaise)}</span>
              </div>
              <div className="summary-card">
                <span className="label">Protected</span>
                <span className="value"><Delta paise={result.deltaProtectedPaise} /></span>
                <span className="footnote">residual LTV preserved by suppression</span>
              </div>
              <div className="summary-card highlight">
                <span className="label">Net</span>
                <span className="value"><Delta paise={result.deltaNetPaise} /></span>
                <span className="footnote">recovered − intervention cost</span>
              </div>
            </div>
            <p className="method-line">
              Policy applied: EIR floor {formatInr(result.policyApplied.minimumEirPaise)}, churn weight ×
              {result.policyApplied.churnAversion}, retries {result.policyApplied.allowRetry ? "on" : "off"},
              max {result.policyApplied.maxAutomatedAttempts} automated attempts.
              Deltas are replayed minus observed over the {result.comparableEpisodes} episodes that
              reached a settled outcome; the other {result.episodesReplayed - result.comparableEpisodes} are
              replayed and listed below but excluded from the totals, because an in-flight episode has
              nothing to be compared against.
            </p>
          </section>

          <section className="episodes-diff">
            <h2>Episode-by-episode diff</h2>
            <div className="table-wrapper">
              <table className="queue-table">
                <thead>
                  <tr>
                    <th>Customer</th><th>Amount</th><th>Was</th><th>Replay</th>
                    <th>Actual outcome</th><th>Replay outcome</th><th>EIR</th><th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {result.byEpisode.slice(0, 100).map((ep) => (
                    <tr key={ep.episodeId} className={ep.usedObservedOutcome ? "is-observed" : "is-modelled"}>
                      <td>{ep.customerId}</td>
                      <td>{formatInr(ep.amountPaise)}</td>
                      <td>{ep.originalAction ?? "—"}</td>
                      <td>{ep.replayAction ?? "—"}</td>
                      <td>{ep.originalOutcome ? (ep.originalOutcome.recovered ? "Recovered" : "Not recovered") : "unsettled"}</td>
                      <td>{ep.replayOutcome?.recovered ? "Recovered" : "Not recovered"}</td>
                      <td className={ep.eirPaise >= 0 ? "positive" : "negative"}>{formatInr(ep.eirPaise)}</td>
                      <td>
                        <span className={ep.usedObservedOutcome ? "observed-badge" : "modelled-badge"}>
                          {ep.usedObservedOutcome
                            ? "Observed"
                            : `Modelled p=${ep.modelledProbability !== null ? ep.modelledProbability.toFixed(2) : "—"}`}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      <section className="honesty-panel">
        <h3>The honesty rule</h3>
        <ul>
          <li><strong>Same action → observed outcome.</strong> If the replayed action matches what actually ran, we reuse the real result. No model is consulted.</li>
          <li><strong>Different action → modelled.</strong> The counterfactual is drawn from <code>scoreRecovery</code> under the replayed action — the same scorer production decides with — seeded per episode so a replay is reproducible.</li>
          <li><strong>The split is displayed permanently.</strong> A replay console that hides the observed/modelled ratio is a fiction generator.</li>
          <li><strong>Deltas are against what actually happened</strong>, over the same episodes, not against a second simulation.</li>
        </ul>
      </section>
    </main>
  );
}
