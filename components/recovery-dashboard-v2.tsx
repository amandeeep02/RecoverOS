"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatInr } from "@/lib/domain";
import type { DashboardSnapshot } from "@/app/_lib/dashboard";
import { IncrementalLedger } from "@/components/incremental-ledger";
import { ProtectedLedger } from "@/components/protected-ledger";
import { RegulatoryRefusals } from "@/components/regulatory-refusals";
import { DegradationBanner } from "@/components/degradation-banner";
import { KillSwitch } from "@/components/kill-switch";
import { DemoControls } from "@/components/demo-controls";
import { EpisodeRow } from "@/components/episode-row";
import { WhyPanel } from "@/components/why-panel";
import { useRealtime } from "@/components/use-realtime";
import { VoiceCallSimulator } from "@/components/voice-call-simulator";
import type { RecoveryEpisode } from "@/lib/domain";

function label(value: string) {
  return value.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (l) => l.toUpperCase());
}

export function RecoveryDashboardV2({ initial }: { initial: DashboardSnapshot }) {
  const [snapshot, setSnapshot] = useState(initial);
  const [selectedId, setSelectedId] = useState<string | null>(initial.episodes[0]?.id ?? null);
  const [liveEvents, setLiveEvents] = useState(0);
  const [lastEventLabel, setLastEventLabel] = useState<string | null>(null);
  const [voiceEpisode, setVoiceEpisode] = useState<RecoveryEpisode | null>(null);
  // The reveal. Off = the leaderboard every vendor would show (recovered − cost).
  // On = the same run with churn priced. The ranking flips, and that flip is the thesis.
  const [priceChurn, setPriceChurn] = useState(true);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);

  /**
   * The SSE stream is the TRIGGER; `/api/snapshot` is the truth.
   *
   * A stream frame carries only an episode id and a status — enough to know
   * something changed, not enough to render a row without inventing the rest. So an
   * event schedules a refetch (debounced) rather than patching a half-built row into
   * the table. Anything the stream cannot deliver, the page refetches.
   */
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetch("/api/snapshot", { cache: "no-store" });
      if (res.ok) setSnapshot(await res.json());
    } catch {
      // Leave the last good snapshot on screen rather than blanking the dashboard.
    } finally {
      inFlight.current = false;
    }
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => { void refresh(); }, 350);
  }, [refresh]);

  // Selecting from a card at the top of the page changes a panel that lives beside
  // the queue table, well below the fold. Without this the click "does nothing":
  // the state changes off-screen. On the two-column layout the why-panel is sticky
  // beside the table, so bringing the selected row into view brings the panel with it;
  // on the single-column layout the panel sits under the whole table, so go to it.
  const revealEpisode = useCallback((id: string) => {
    setSelectedId(id);
    requestAnimationFrame(() => {
      const singleColumn = window.matchMedia("(max-width: 1100px)").matches;
      const target = singleColumn ? document.getElementById("why-panel") : document.getElementById(`episode-${id}`);
      target?.scrollIntoView({ behavior: "smooth", block: singleColumn ? "start" : "center" });
    });
  }, []);

  const connection = useRealtime(
    useCallback((event) => {
      if (event.type === "heartbeat") return;
      setLiveEvents((n) => n + 1);
      if (event.type === "episode.updated" && event.episode.action === "VOICE_CALL" && event.episode.status === "EXECUTING") {
        setLastEventLabel(`📞 Calling the customer for ${event.episode.id.slice(0, 12)}… — policy approved a voice call`);
      } else if (event.type === "episode.created" || event.type === "episode.updated") {
        setLastEventLabel(`${label(event.type.split(".")[1])} ${event.episode.id.slice(0, 12)}… → ${label(event.episode.status)}`);
      } else if (event.type === "degradation.opened") {
        setLastEventLabel(`Degradation opened on ${event.window.key.replace(/\|/g, " · ")} at ${event.window.ratio.toFixed(1)}× baseline`);
      } else if (event.type === "degradation.closed") {
        setLastEventLabel(`Degradation closed on ${event.window.key.replace(/\|/g, " · ")} · ${event.window.released} queued for drain`);
      } else if (event.type === "degradation.drained") {
        setLastEventLabel(`Drained ${event.window.episodeId.slice(0, 12)}…`);
      } else if (event.type === "customer.responded") {
        // The phone answered. Bring the episode on screen so the transcript is seen
        // arriving, not discovered later in a panel nobody scrolled to.
        setLastEventLabel(`Customer said: “${event.text}”`);
        revealEpisode(event.episode.id);
      }
      scheduleRefresh();
    }, [scheduleRefresh, revealEpisode]),
    refresh,
  );

  useEffect(() => () => { if (refreshTimer.current) clearTimeout(refreshTimer.current); }, []);

  const episodes = snapshot.episodes;
  const selected = episodes.find((e) => e.id === selectedId) ?? episodes[0] ?? null;
  const suppressed = useMemo(
    () => episodes.filter((e) => snapshot.ledger.suppressedEpisodeIds.includes(e.id)),
    [episodes, snapshot.ledger.suppressedEpisodeIds],
  );
  const held = useMemo(() => episodes.filter((e) => e.status === "HELD_DEGRADED"), [episodes]);
  // Newest episode whose link could still be paid. Lets the "customer pays" beat run
  // straight after a page load, not only after a webhook fired in this tab.
  const payable = useMemo(() => episodes.find((e) => e.status === "PENDING" && e.execution?.externalReference) ?? null, [episodes]);


  // The queue carries a projection of each episode, not the whole record. The voice
  // simulator needs the full episode, so it is fetched on demand rather than shipping
  // every field of every row to the browser on first paint.
  const openVoice = useCallback(async (episodeId: string) => {
    const res = await fetch(`/api/episodes/${episodeId}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    if (data.episode) setVoiceEpisode(data.episode as RecoveryEpisode);
  }, []);

  return (
    <main className="dashboard-v2">
      <header className="dashboard-header">
        <div>
          <h1>RecoverOS</h1>
          <p className="dashboard-sub">Revenue recovery for Indian recurring payments — measured against a randomized control.</p>
        </div>
        <div className="header-meta">
          <span className={`live-pill live-${connection}`}>
            <i />{connection === "open" ? "LIVE" : connection === "connecting" ? "CONNECTING" : "OFFLINE"} · {liveEvents} events
          </span>
          <a className="secondary-link" href="/checkout">Checkout demo →</a>
          <a className="secondary-link" href="/frontier">Frontier →</a>
          <a className="secondary-link" href="/replay">Replay console →</a>
        </div>
      </header>

      {lastEventLabel && <p className="last-event">{lastEventLabel}</p>}

      {snapshot.quietHoursDisabled && (
        <p className="gate-notice" role="status">
          TRAI quiet-hours gate is <b>disabled on this server</b> (<code>RECOVEROS_DISABLE_QUIET_HOURS=1</code>). Calls and SMS are not time-gated here; the benchmark and tests still enforce 09:00–21:00 IST.
        </p>
      )}

      <DegradationBanner degradation={snapshot.degradation} />

      <section className="hero-section">
        <IncrementalLedger benchmark={snapshot.benchmark} />
      </section>

      {/* The two refusals, side by side and both priced. One is the scorer's
          judgement, the other is a rule; a merchant has to be able to tell them
          apart, so they never share a card. */}
      <section className="refusal-grid">
        <ProtectedLedger ledger={snapshot.ledger} suppressed={suppressed} onSelect={revealEpisode} />
        <RegulatoryRefusals refusals={snapshot.refusals} onSelect={revealEpisode} />
      </section>

      <section className="ledger-grid">
        <div className="ledger-card">
          <div className="ledger-stat">
            <span className="ledger-label">Revenue at risk in queue</span>
            <span className="ledger-value">{formatInr(snapshot.queue.revenueAtRiskPaise)}</span>
          </div>
          <div className="ledger-stat">
            <span className="ledger-label">Recovered</span>
            <span className="ledger-value highlight">{formatInr(snapshot.queue.recoveredPaise)}</span>
          </div>
          <div className="ledger-stat">
            <span className="ledger-label">Pending</span>
            <span className="ledger-value">{formatInr(snapshot.queue.pendingPaise)}</span>
          </div>
          <div className="ledger-stat">
            <span className="ledger-label">Held / suppressed / escalated</span>
            <span className="ledger-value">{snapshot.queue.held} · {snapshot.queue.suppressed} · {snapshot.queue.escalated}</span>
          </div>
          <p className="muted-note">
            Queue totals are counted over the {episodes.length} episodes in this workspace.
            They are not the benchmark above, which is measured over {snapshot.benchmark.seeds.length} simulated worlds.
          </p>
        </div>
      </section>

      <DemoControls onFired={scheduleRefresh} payableEpisodeId={payable?.id ?? null} />

      <KillSwitch degradation={snapshot.degradation} held={held} onChanged={scheduleRefresh} />

      <section className="queue-section">
        <div className="queue-header">
          <h2>Recovery queue</h2>
          <span className="queue-count">{episodes.length} episodes</span>
        </div>
        <div className="queue-layout">
          <div className="queue-table-wrapper">
            <table className="queue-table" role="grid">
              <thead>
                <tr>
                  <th>Customer</th><th>Amount</th><th>Diagnosis</th><th>EIR</th><th>Action</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {episodes.map((episode) => (
                  <EpisodeRow
                    key={episode.id}
                    episode={episode}
                    selected={episode.id === selected?.id}
                    onClick={() => setSelectedId(episode.id)}
                    onOpenVoice={() => void openVoice(episode.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {selected && <WhyPanel episode={selected} audit={snapshot.audits[selected.id] ?? []} />}
        </div>
      </section>

      <section className="benchmark-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Measured, not claimed</p>
            <h2>{priceChurn ? "Same hidden worlds. Four strategies. Churn priced." : "The leaderboard every vendor would show you."}</h2>
          </div>
          <div className="benchmark-controls">
            <button type="button" className={`churn-toggle ${priceChurn ? "on" : "off"}`} onClick={() => setPriceChurn((v) => !v)} aria-pressed={priceChurn}>
              <i />{priceChurn ? "Churn priced" : "Churn ignored"}
            </button>
            <span className="context-note">
              {snapshot.benchmark.seeds.length} seeds × {snapshot.benchmark.episodesPerSeed.toLocaleString("en-IN")} episodes
            </span>
          </div>
        </div>
        <div className="arms-grid">
          {[...snapshot.benchmark.arms]
            .map((arm) => ({ ...arm, shownNetPaise: priceChurn ? arm.netPaise : arm.netPaise + arm.churnCostPaise }))
            .sort((a, b) => b.shownNetPaise - a.shownNetPaise)
            .map((arm, rank) => (
            <article key={arm.key} className={`arm ${arm.key === "recoverOs" ? "featured" : ""} ${rank === 0 ? "leader" : ""}`}>
              <span className="arm-rank">#{rank + 1}</span>
              <span className="arm-name">{arm.name}</span>
              <strong>{formatInr(arm.shownNetPaise)}</strong>
              <small>{priceChurn ? "net per world — recovered − intervention cost − churn cost" : `recovered − intervention cost · hides ${formatInr(arm.churnCostPaise)} of churn`}</small>
              <div className="arm-stats">
                <span>Recovered <b>{formatInr(arm.recoveredPaise)}</b></span>
                <span>Actions <b>{arm.interventions.toLocaleString("en-IN")}</b></span>
                <span>Contacts <b>{arm.contactsMade.toLocaleString("en-IN")}</b></span>
                <span>Rate <b>{(arm.recoveryRate * 100).toFixed(1)}%</b></span>
              </div>
            </article>
          ))}
        </div>
        <p className="method-line">
          Simulator outcomes come from a private latent model. No strategy reads it. The Oracle
          does, and is a yardstick rather than a competitor: it separates &ldquo;our decision layer is
          weak&rdquo; from &ldquo;this world is hostile to intervention&rdquo;.
        </p>
      </section>

      {voiceEpisode && <VoiceCallSimulator episode={voiceEpisode} onClose={() => setVoiceEpisode(null)} />}
    </main>
  );
}
