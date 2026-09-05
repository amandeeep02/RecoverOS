"use client";

import { formatInr } from "@/lib/domain";
import type { AuditEvent } from "@/lib/domain";
import type { EpisodeView } from "@/app/_lib/dashboard";

function label(value: string) {
  return value.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (l) => l.toUpperCase());
}

/** A regulatory reason arrives as `REGULATION:CODE`. Sentence-casing it turns a
 *  citation into mush — "Trai Tcccpr 2018:trai Quiet Hours" — so it keeps its own
 *  shape: the code stays verbatim and machine-greppable, the regulation is the
 *  attribution beside it. */
const isRegulatory = (r: string) => r.includes(":") && r === r.toUpperCase();

const stageTitle: Record<string, string> = {
  INGESTED: "Failure signal captured",
  DIAGNOSED: "Root cause diagnosed",
  SCORED: "Incremental value scored",
  PROPOSED: "Bounded action proposed",
  POLICY: "Policy checks completed",
  EXECUTED: "Approved action executed",
  OUTCOME: "Outcome observed",
  CUSTOMER_RESPONSE: "Customer responded",
};

/**
 * "Don't trust the agent. Audit it." (IDEA.md §11, proof trail).
 *
 * One correctness rule governs this panel: incrementality is a POPULATION quantity.
 * A single episode either recovered or it did not, and there is no per-episode
 * counterfactual to observe — so no confidence interval appears here, and the
 * probabilities are labelled as the model's estimate rather than as a measurement.
 */
export function WhyPanel({ episode, audit }: { episode: EpisodeView; audit: AuditEvent[] }) {
  const decision = episode.policyDecision;
  const eir = episode.eir;

  return (
    <aside className="why-panel" aria-label="Decision details">
      <div className="why-header">
        <div>
          <p className="eyebrow">Why this decision</p>
          <h3>{label(decision?.allowedAction ?? episode.proposal?.action ?? "—")}</h3>
        </div>
        <span className={`status-badge status-${episode.status.toLowerCase().replaceAll("_", "-")}`}>{label(episode.status)}</span>
      </div>

      <p className="why-explanation">{episode.proposal?.explanation ?? episode.diagnosis?.explanation ?? "No proposal was recorded for this episode."}</p>

      {episode.proposal && episode.proposal.reasonCodes.length > 0 && (
        <div className="reason-list">
          {episode.proposal.reasonCodes.map((r) => <span key={r}>{label(r)}</span>)}
        </div>
      )}

      {episode.prediction && (
        <div className="probability-grid">
          <div><span>With action</span><strong>{(episode.prediction.pRecoverWithAction * 100).toFixed(0)}%</strong></div>
          <div><span>Native only</span><strong>{(episode.prediction.pRecoverNative * 100).toFixed(0)}%</strong></div>
        </div>
      )}

      {eir && (
        <div className="eir-box">
          <span>Expected incremental recovery</span>
          <strong>{formatInr(eir.eirPaise)}</strong>
          <small>
            {formatInr(eir.eirWithoutChurnPaise)} before churn · {formatInr(eir.churnCostPaise)} churn cost ·
            {" "}{formatInr(eir.interventionCostPaise)} action cost · {(eir.incrementalLift * 100).toFixed(1)}pp lift
          </small>
        </div>
      )}

      {decision && (
        <div className="policy-result">
          <span>Policy verdict</span>
          <strong>{label(decision.outcome)}{decision.arm ? ` · arm ${label(decision.arm)}` : ""}</strong>
          {decision.reasons.some(isRegulatory) && (
            <div className="regulatory-citations">
              {decision.reasons.filter(isRegulatory).map((r) => {
                const [regulation, code] = r.split(":");
                return (
                  <span key={r} className="regulatory-citation">
                    <code>{code}</code>
                    <small>{label(regulation)}</small>
                  </span>
                );
              })}
            </div>
          )}
          {decision.reasons.some((r) => !isRegulatory(r)) && (
            <p>{decision.reasons.filter((r) => !isRegulatory(r)).map(label).join(" · ")}</p>
          )}
          {decision.degradationWindowId && <p className="muted-note">Held under degradation window {decision.degradationWindowId}</p>}
        </div>
      )}

      {episode.execution && (
        <div className="execution-box">
          <span>Execution</span>
          <strong>{label(episode.execution.status)} · {label(episode.execution.executor)}</strong>
          {episode.execution.externalReference && <p className="muted-note">ref {episode.execution.externalReference}</p>}
          {episode.execution.error && <p className="execution-error">{episode.execution.error}</p>}
        </div>
      )}

      <p className="estimate-boundary">
        These probabilities are the model&apos;s estimate for this episode. They are not a
        measurement of it: incrementality is a population quantity and lives on the
        holdout card, not on a single row.
      </p>

      {episode.customerResponses.length > 0 && (
        <div className="customer-responses">
          <span>Customer said</span>
          {[...episode.customerResponses].reverse().map((r) => (
            <div className="response-item" key={r.responseId}>
              <b>{r.channel === "voice" ? "Voice" : "WhatsApp"}</b>
              <p>&ldquo;{r.text}&rdquo;</p>
              <small>{r.confidence != null ? `${Math.round(r.confidence * 100)}% confidence · ` : ""}{r.receivedAt.slice(11, 16)} UTC</small>
            </div>
          ))}
        </div>
      )}

      <div className="audit-trail">
        <span>Append-only audit · {audit.length} entries</span>
        {audit.map((entry, index) => (
          <div className="timeline-item" key={entry.auditId}>
            <div className={`timeline-dot ${entry.stage.toLowerCase()}`}><span>{index + 1}</span></div>
            <div>
              <strong>{stageTitle[entry.stage] ?? entry.stage}</strong>
              <small>{entry.timestamp.slice(11, 19)} UTC · {entry.stage}</small>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
