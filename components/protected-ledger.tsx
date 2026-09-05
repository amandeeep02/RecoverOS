"use client";

import { formatInr } from "@/lib/domain";
import type { EpisodeView, LedgerView } from "@/app/_lib/dashboard";

interface ProtectedLedgerProps {
  ledger: LedgerView;
  suppressed: EpisodeView[];
  onSelect?: (episodeId: string) => void;
}

/**
 * The Refusal (IDEA.md §11, 1:35) and §6.B.
 *
 * Every suppression is booked on BOTH sides. `Protected` alone is a number any
 * product could print; it only means something next to the recovery we gave up to
 * get it. When nothing was suppressed the ledger says so rather than showing a
 * flattering blank.
 */
export function ProtectedLedger({ ledger, suppressed, onSelect }: ProtectedLedgerProps) {
  const netPaise = ledger.protectedPaise - ledger.forgonePaise;
  const isPositive = netPaise >= 0;

  return (
    <section className="protected-ledger" aria-label="Revenue protected by not acting">
      <div className="ledger-header">
        <span className="label">Revenue protected by not acting</span>
        <span className={`net-value ${isPositive ? "positive" : "negative"}`}>
          {isPositive ? "+" : ""}{formatInr(netPaise)}
        </span>
      </div>

      {ledger.suppressedCount === 0 ? (
        <p className="ledger-empty">
          No episode in this queue was suppressed, so there is nothing to book. An empty
          ledger is the honest reading — not a zero we are hiding.
        </p>
      ) : (
        <>
          <div className="ledger-breakdown">
            <div className="breakdown-item positive">
              <span className="breakdown-label">Protected</span>
              <span className="breakdown-value">{formatInr(ledger.protectedPaise)}</span>
              <span className="breakdown-detail">
                residual subscription value preserved · {ledger.suppressedCount} suppressed
              </span>
            </div>
            <div className="breakdown-item negative">
              <span className="breakdown-label">Forgone</span>
              <span className="breakdown-value">{formatInr(ledger.forgonePaise)}</span>
              <span className="breakdown-detail">recovery given up to protect it</span>
            </div>
          </div>

          <ul className="suppressed-list">
            {suppressed.map((episode) => (
              <li key={episode.id}>
                <button type="button" onClick={() => onSelect?.(episode.id)}>
                  <strong>{episode.event.customerId}</strong>
                  <span className="suppressed-amount">{formatInr(episode.event.amountPaise)}</span>
                  <span className="suppressed-math">
                    {episode.eir
                      ? `${episode.eir.action} worth ${formatInr(episode.eir.eirWithoutChurnPaise)} · risks ${formatInr(episode.eir.churnCostPaise)} of ${formatInr(episode.eir.residualLtvPaise)} residual at ${(episode.eir.deltaPChurn * 100).toFixed(1)}% churn`
                      : "no score recorded"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="ledger-footnote">
        Contacting a dormant subscriber can destroy more remaining subscription value than
        the payment is worth. Both sides of that bet are on this card.
      </div>
    </section>
  );
}
