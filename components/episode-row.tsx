"use client";

import { formatInr } from "@/lib/domain";
import type { EpisodeView } from "@/app/_lib/dashboard";

const statusStyles: Record<string, string> = {
  RECOVERED: "status-recovered", PENDING: "status-pending", PROMISED: "status-promised",
  ESCALATED: "status-escalated", STOPPED: "status-stopped", FAILED: "status-failed",
  EXPIRED: "status-expired", HELD_OUT: "status-held-out", HELD_DEGRADED: "status-held-degraded",
  SUPPRESSED: "status-suppressed", EXECUTING: "status-executing", POLICY_CHECK: "status-policy-check",
  PROPOSED: "status-proposed", SCORED: "status-scored", DIAGNOSED: "status-diagnosed", DETECTED: "status-detected",
};

const actionColors: Record<string, string> = {
  WAIT: "action-wait", PAYMENT_LINK: "action-payment-link", REMINDER: "action-reminder",
  ESCALATE: "action-escalate", STOP: "action-stop", RETRY: "action-retry",
  VOICE_CALL: "action-voice-call", HELD_OUT: "action-held-out", HELD_DEGRADED: "action-held-degraded",
};

function label(value: string) {
  return value.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (l) => l.toUpperCase());
}

export function EpisodeRow({ episode, selected, onClick, onOpenVoice }: { episode: EpisodeView; selected?: boolean; onClick?: () => void; onOpenVoice?: () => void }) {
  const statusClass = statusStyles[episode.status] || "status-unknown";
  const action = episode.policyDecision?.suppressionReason
    ? "SUPPRESSED"
    : episode.policyDecision?.allowedAction ?? episode.proposal?.action ?? "—";
  const actionClass = actionColors[action] || "action-suppressed";
  const eirValue = episode.eir?.eirPaise ?? 0;

  return (
    <tr id={`episode-${episode.id}`} onClick={onClick} className={`episode-row ${statusClass} ${selected ? "selected" : ""}`}>
      <td className="col-customer">
        <strong>{episode.event.customerId}</strong>
        <span className="meta">
          {episode.event.paymentMethod.toUpperCase()}
          {episode.event.issuer ? ` · ${episode.event.issuer}` : ""} · {episode.event.paymentId}
        </span>
      </td>
      <td className="col-amount">{formatInr(episode.event.amountPaise)}</td>
      <td className="col-diagnosis">
        <span className="diagnosis">{episode.diagnosis ? label(episode.diagnosis.category) : "—"}</span>
        <span className="confidence">{episode.diagnosis ? `${Math.round(episode.diagnosis.confidence * 100)}%` : "—"}</span>
      </td>
      <td className={`col-eir ${eirValue > 0 ? "eir-positive" : eirValue < 0 ? "eir-negative" : ""}`}>
        {episode.eir ? formatInr(eirValue) : "—"}
      </td>
      <td className="col-action">
        <span
          className={`action-chip ${actionClass}${action === "VOICE_CALL" ? " is-clickable" : ""}`}
          onClick={action === "VOICE_CALL" ? (e) => { e.stopPropagation(); onOpenVoice?.(); } : undefined}
          title={action === "VOICE_CALL" ? "Open the Hinglish call simulator" : undefined}
        >
          {label(action)}
        </span>
      </td>
      <td className="col-status"><span className={`status-badge ${statusClass}`}>{label(episode.status)}</span></td>
    </tr>
  );
}
