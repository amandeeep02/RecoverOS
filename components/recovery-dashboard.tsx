"use client";

import { useMemo, useState } from "react";
import type { DemoSnapshot } from "@/lib/demo";
import { formatInr } from "@/lib/domain";
import { VoiceCallSimulator } from "@/components/voice-call-simulator";

type Props = { snapshot: DemoSnapshot };

const statusClass: Record<string, string> = {
  RECOVERED: "good", PENDING: "pending", ESCALATED: "warn", STOPPED: "muted", FAILED: "bad",
};

export function RecoveryDashboard({ snapshot }: Props) {
  const defaultEpisode = snapshot.episodes.find((episode) => episode.status === "RECOVERED") ?? snapshot.episodes[0];
  const [selectedId, setSelectedId] = useState(defaultEpisode.id);
  const [voiceEpisode, setVoiceEpisode] = useState<typeof defaultEpisode | null>(null);
  const selected = snapshot.episodes.find((episode) => episode.id === selectedId) ?? defaultEpisode;
  const audit = snapshot.audits[selected.id] ?? [];
  const metrics = snapshot.benchmark.summary;
  const bestLift = metrics.recoverOs.incrementalRecoveredInr.mean;
  const recoveryRate = metrics.recoverOs.recoveryRate.mean;
  const totals = useMemo(() => ({
    recovered: metrics.recoverOs.recoveredRevenueInr.mean,
    native: metrics.baseline.recoveredRevenueInr.mean,
  }), [metrics]);

  return (
    <>
      <main className="shell">
        <aside className="sidebar">
        <a className="brand" href="#overview"><span className="brand-mark">R</span><span>Recover<span>OS</span></span></a>
        <div className="workspace"><span className="avatar">A</span><div><strong>Acme Subscriptions</strong><small>Merchant workspace</small></div><span className="chevron">⌄</span></div>
        <nav>
          <a className="nav-item active" href="#overview"><span>⌘</span> Overview</a>
          <a className="nav-item" href="#queue"><span>⊞</span> Recovery queue <b>{snapshot.episodes.length}</b></a>
          <a className="nav-item" href="#benchmark"><span>◔</span> Benchmark</a>
          <a className="nav-item" href="#audit"><span>≡</span> Audit log</a>
        </nav>
        <div className="sidebar-footer"><div className="secure-dot" /> Policy boundary active<br /><small>LLM proposals require approval</small></div>
      </aside>

      <section className="content" id="overview">
        <header className="topbar">
          <div className="crumb"><span>Recovery intelligence</span><i /> <strong>Overview</strong></div>
          <div className="top-actions"><span className="demo-pill"><i /> Demo workspace</span><button aria-label="Notifications" className="icon-button">♧</button><span className="avatar inverse">AK</span></div>
        </header>

        <div className="hero">
          <div><p className="eyebrow">Recurring payments · decision layer</p><h1>Recover revenue. <em>Not trust.</em></h1><p className="hero-copy">Every intervention is scored against native recovery, bounded by policy, and captured in an immutable audit trail.</p></div>
          <div className="hero-proof"><div className="proof-icon">↗</div><div><span>Expected incremental recovery</span><strong>{formatInr(bestLift)}</strong><small>Mean across {snapshot.benchmark.seeds.length} hidden-truth worlds</small></div></div>
        </div>

        <section className="kpi-grid" aria-label="Benchmark performance">
          <Metric label="Revenue at risk" value={formatInr(metrics.recoverOs.recoveredRevenueInr.mean / Math.max(recoveryRate, 0.01))} note="per benchmark world" />
          <Metric label="Native recovery" value={formatInr(totals.native)} note="generic retry baseline" />
          <Metric label="RecoverOS recovery" value={formatInr(totals.recovered)} note="policy-bounded actions" tone="success" />
          <Metric label="Incremental recovery" value={formatInr(bestLift)} note="above native recovery" tone="lift" />
          <Metric label="Recovery rate" value={`${(recoveryRate * 100).toFixed(1)}%`} note={`${Math.round(metrics.recoverOs.interventions.mean)} interventions`} />
        </section>

        <section className="panel decision-panel" id="queue">
          <div className="panel-heading"><div><p className="eyebrow">Decision queue</p><h2>Where judgment creates value</h2></div><span className="context-note">Click a payment to inspect the decision</span></div>
          <div className="queue-layout">
            <div className="queue-table-wrap">
              <table className="queue-table"><thead><tr><th>Customer</th><th>Amount</th><th>Diagnosis</th><th>Expected value</th><th>Action</th><th>Status</th></tr></thead>
                <tbody>{snapshot.episodes.map((episode) => <tr key={episode.id} onClick={() => setSelectedId(episode.id)} className={episode.id === selected.id ? "selected" : ""}>
                  <td><strong>{customerName(episode.event.customerId)}</strong><small>{episode.event.paymentMethod.toUpperCase()} · {episode.event.paymentId}</small></td>
                  <td>{formatInr(episode.event.amountInr)}</td>
                  <td><span className="diagnosis">{label(episode.diagnosis?.category ?? "unknown")}</span><small>{Math.round((episode.diagnosis?.confidence ?? 0) * 100)}% confidence</small></td>
                  <td className={(episode.eir?.eirInr ?? 0) > 0 ? "positive" : ""}>{formatInr(episode.eir?.eirInr ?? 0)}</td>
                  <td><span className="action-chip" onClick={(e) => { e.stopPropagation(); if ((episode.policyDecision?.allowedAction ?? episode.proposal?.action) === "VOICE_CALL") setVoiceEpisode(episode); }}>{label(episode.policyDecision?.allowedAction ?? episode.proposal?.action ?? "ESCALATE")}</span></td>
                  <td><span className={`status ${statusClass[episode.status] ?? "muted"}`}>{label(episode.status)}</span></td>
                </tr>)}</tbody>
              </table>
            </div>
            <WhyPanel episode={selected} />
          </div>
        </section>

        <section className="lower-grid">
          <section className="panel audit-panel" id="audit"><div className="panel-heading"><div><p className="eyebrow">Append-only evidence</p><h2>Decision audit</h2></div><span className="audit-id">{selected.id.slice(0, 16)}…</span></div>
            <div className="timeline">{audit.map((entry, index) => <div className="timeline-item" key={entry.auditId}><div className={`timeline-dot ${entry.stage.toLowerCase()}`}><span>{index + 1}</span></div><div><strong>{stageTitle(entry.stage)}</strong><p>{stageDescription(entry.stage, entry.payload)}</p><small>{formatAuditTime(entry.timestamp)} · {entry.stage}</small></div></div>)}</div>
          </section>
          <section className="panel controls-panel"><div className="panel-heading"><div><p className="eyebrow">Non-negotiables</p><h2>Safety controls</h2></div><span className="shield">⌑</span></div>
            <Control label="Authority separation" copy="Propose → policy → execute" state="Enforced" />
            <Control label="Automated attempt cap" copy="3 attempts per failure episode" state="Active" />
            <Control label="Contact policy" copy="Consent, opt-out & window checked" state="Active" />
            <Control label="Idempotency" copy="Webhook and executor replay protected" state="Active" />
            <div className="control-foot">No LLM output can invoke Razorpay directly.</div>
          </section>
        </section>

        <section className="panel benchmark-panel" id="benchmark"><div className="panel-heading"><div><p className="eyebrow">Measured, not claimed</p><h2>Same hidden world. Three strategies.</h2></div><span className="context-note">{snapshot.benchmark.seeds.length} seeds × {snapshot.benchmark.eventCountPerSeed.toLocaleString("en-IN")} events</span></div>
          <div className="strategy-grid">
            <Strategy name="Baseline" subtitle="Retry every eligible failure once" metrics={metrics.baseline} />
            <Strategy name="Rules" subtitle="Simple failure-code heuristics" metrics={metrics.rules} />
            <Strategy name="RecoverOS" subtitle="Diagnosis + EIR + policy" metrics={metrics.recoverOs} featured />
          </div>
          <div className="calibration"><div><strong>Calibration check</strong><p>Predicted likelihood compared with observed recovery for policy-approved interventions.</p></div><div className="calibration-bars">{snapshot.benchmark.bySeed[0].recoverOs.calibration.map((point) => <div className="calibration-row" key={point.bucket}><span>{point.bucket}</span><div><i style={{ width: `${point.predicted * 100}%` }} /><b style={{ width: `${point.observed * 100}%` }} /></div><small>{(point.observed * 100).toFixed(0)}%</small></div>)}</div></div>
          <p className="method-note">Simulator outcomes are generated from a private latent model. Strategy predictions never generate or access those outcomes.</p>
        </section>
      </section>
    </main>
      {voiceEpisode && <VoiceCallSimulator episode={voiceEpisode} onClose={() => setVoiceEpisode(null)} />}
    </>
  );
}

function Metric({ label, value, note, tone = "" }: { label: string; value: string; note: string; tone?: string }) { return <article className={`metric ${tone}`}><span>{label}</span><strong>{value}</strong><small>{note}</small></article>; }
function Control({ label, copy, state }: { label: string; copy: string; state: string }) { return <div className="control"><div><strong>{label}</strong><small>{copy}</small></div><span>{state}</span></div>; }
function Strategy({ name, subtitle, metrics, featured = false }: { name: string; subtitle: string; metrics: DemoSnapshot["benchmark"]["summary"]["recoverOs"]; featured?: boolean }) {
  return <article className={`strategy ${featured ? "featured" : ""}`}><div><span>{name}</span>{featured && <b>BEST LIFT</b>}<p>{subtitle}</p></div><strong>{formatInr(metrics.incrementalRecoveredInr.mean)}</strong><small>incremental recovery</small><div className="strategy-stats"><span><b>{Math.round(metrics.interventions.mean)}</b> actions</span><span><b>{Math.round(metrics.wastedInterventions.mean)}</b> wasted</span></div></article>;
}
function WhyPanel({ episode }: { episode: DemoSnapshot["episodes"][number] }) {
  const decision = episode.policyDecision;
  const prediction = episode.prediction;
  return <aside className="why-panel"><div className="why-header"><div><p className="eyebrow">Why this action</p><h3>{label(decision?.allowedAction ?? episode.proposal?.action ?? "ESCALATE")}</h3></div><span className={`status ${statusClass[episode.status] ?? "muted"}`}>{label(episode.status)}</span></div>
    <p className="why-copy">{episode.proposal?.explanation}</p><div className="reason-list">{episode.proposal?.reasonCodes.map((reason) => <span key={reason}>✓ {label(reason)}</span>)}</div>
    <div className="probability-grid"><div><span>RecoverOS</span><strong>{((prediction?.pRecoverWithAction ?? 0) * 100).toFixed(0)}%</strong></div><div><span>Native</span><strong>{((prediction?.pRecoverNative ?? 0) * 100).toFixed(0)}%</strong></div></div>
    <div className="eir-box"><span>Expected incremental recovery</span><strong>{formatInr(episode.eir?.eirInr ?? 0)}</strong><small>{((episode.eir?.incrementalLift ?? 0) * 100).toFixed(0)}% lift · {formatInr(episode.eir?.interventionCostInr ?? 0)} cost</small></div>
    <div className="policy-result"><span>Policy verdict</span><strong>{decision?.outcome === "APPROVE" ? "Approved" : "Escalated"}</strong><p>{decision?.reasons.map(label).join(" · ")}</p></div>
  </aside>;
}
function customerName(id: string) { return ({ cust_aurora: "Aurora Health", cust_basil: "Basil Labs", cust_cedar: "Cedar Studio", cust_delta: "Delta Works", cust_ember: "Ember Finance" } as Record<string, string>)[id] ?? id; }
function label(value: string) { return value.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function stageTitle(stage: string) { return ({ INGESTED: "Failure signal captured", DIAGNOSED: "Root cause diagnosed", SCORED: "Incremental value scored", PROPOSED: "Bounded action proposed", POLICY: "Policy checks completed", EXECUTED: "Approved action executed", OUTCOME: "Outcome observed" } as Record<string, string>)[stage] ?? stage; }
function stageDescription(stage: string, payload: Record<string, unknown>) {
  if (stage === "INGESTED") return "Normalized Razorpay event preserved with its original event ID.";
  if (stage === "DIAGNOSED") return `Classified as ${label(String(payload.category ?? "unknown"))} from supported payment signals.`;
  if (stage === "SCORED") return `Expected incremental recovery calculated before any action was allowed.`;
  if (stage === "PROPOSED") return `Proposal was created without payment credentials or execution authority.`;
  if (stage === "POLICY") return `Deterministic policy result: ${label(String(payload.outcome ?? "checked"))}.`;
  if (stage === "EXECUTED") return `Executor result: ${label(String(payload.status ?? "recorded"))}.`;
  return `Episode is now ${label(String(payload.status ?? "pending"))}.`;
}
function formatAuditTime(timestamp: string) { return `${timestamp.slice(11, 16)} UTC`; }
