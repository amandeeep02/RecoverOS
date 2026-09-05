"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatInr } from "@/lib/domain";
import type { DashboardSnapshot } from "@/app/_lib/dashboard";
import { IncrementalLedger } from "@/components/incremental-ledger";
import { ProtectedLedger } from "@/components/protected-ledger";
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

  const connection = useRealtime(
    useCallback((event) => {
      if (event.type === "heartbeat") return;
      setLiveEvents((n) => n + 1);
      if (event.type === "episode.created" || event.type === "episode.updated") {
        setLastEventLabel(`${label(event.type.split(".")[1])} ${event.episode.id.slice(0, 12)}… → ${label(event.episode.status)}`);
      } else if (event.type === "degradation.opened") {
        setLastEventLabel(`Degradation opened on ${event.window.key.replace(/\|/g, " · ")} at ${event.window.ratio.toFixed(1)}× baseline`);
      } else if (event.type === "degradation.closed") {
        setLastEventLabel(`Degradation closed on ${event.window.key.replace(/\|/g, " · ")} · ${event.window.released} queued for drain`);
      } else if (event.type === "degradation.drained") {
        setLastEventLabel(`Drained ${event.window.episodeId.slice(0, 12)}…`);
      }
      scheduleRefresh();
    }, [scheduleRefresh]),
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
          <a className="secondary-link" href="/frontier">Frontier →</a>
          <a className="secondary-link" href="/replay">Replay console →</a>
        </div>
      </header>

      {lastEventLabel && <p className="last-event">{lastEventLabel}</p>}

      <DegradationBanner degradation={snapshot.degradation} />

      <section className="hero-section">
        <IncrementalLedger benchmark={snapshot.benchmark} />
      </section>

      <section className="ledger-grid">
        <ProtectedLedger ledger={snapshot.ledger} suppressed={suppressed} onSelect={setSelectedId} />
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

      <DemoControls onFired={scheduleRefresh} />

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
            <h2>Same hidden worlds. Four strategies.</h2>
          </div>
          <span className="context-note">
            {snapshot.benchmark.seeds.length} seeds × {snapshot.benchmark.episodesPerSeed.toLocaleString("en-IN")} episodes
            {" · "}computed in {(snapshot.benchmark.computedInMs / 1000).toFixed(1)}s
          </span>
        </div>
        <div className="arms-grid">
          {snapshot.benchmark.arms.map((arm) => (
            <article key={arm.key} className={`arm ${arm.key === "recoverOs" ? "featured" : ""}`}>
              <span className="arm-name">{arm.name}</span>
              <strong>{formatInr(arm.netPaise)}</strong>
              <small>net per world — recovered − intervention cost − churn cost</small>
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
