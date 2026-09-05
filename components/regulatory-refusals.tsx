"use client";

import { formatInr } from "@/lib/domain";
import type { RefusalView } from "@/app/_lib/dashboard";

function readable(code: string) {
  return code.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (l) => l.toUpperCase());
}

/** Short, checkable statements of what each code actually forbids. A violation code
 *  with no plain-English gloss is a string, not a compliance control. */
const CODE_MEANING: Record<string, string> = {
  TRAI_QUIET_HOURS: "Outside the 09:00–21:00 telemarketing window",
  DLT_TEMPLATE_MISSING: "No registered DLT template for this message",
  DND_PROMOTIONAL_BLOCKED: "Customer is on DND and this is not transactional",
  WA_OPT_IN_MISSING: "No WhatsApp opt-in on file",
  WA_OUTSIDE_SERVICE_WINDOW: "Outside the 24h service window, no template",
  WA_TEMPLATE_NOT_PREAPPROVED: "WhatsApp template not pre-approved",
  RBI_PREDEBIT_NOTICE_MISSING: "No 24h pre-debit notification for this mandate",
  RBI_AFA_REQUIRED: "Above the no-AFA threshold; needs authentication",
  DPDP_CONSENT_ABSENT: "No valid consent for this contact purpose",
  DPDP_OPTED_OUT: "Customer has opted out of contact",
};

/**
 * The second kind of refusal, next to the economic one.
 *
 * `ProtectedLedger` shows the agent declining because contacting would destroy more
 * than it recovers — a judgement, and one the scorer could get wrong. This shows it
 * declining because a rule says no, which is not a judgement at all. Both are priced,
 * because a refusal with no rupee figure attached is a claim a merchant cannot audit.
 *
 * `deferredPaise` is FACE VALUE, not lost revenue, and the copy says so: the gate runs
 * per decision, so an episode refused at 22:00 is eligible again inside the window.
 * Calling it "revenue lost" would overstate the cost of compliance, which is the same
 * error in the opposite direction from ignoring the gate entirely.
 */
export function RegulatoryRefusals({ refusals, onSelect }: { refusals: RefusalView; onSelect?: (id: string) => void }) {
  return (
    <section className="regulatory-refusals" aria-label="Contacts refused by the regulatory gate">
      <div className="ledger-header">
        <span className="label">Refused by the regulator</span>
        <span className="net-value neutral">{formatInr(refusals.deferredPaise)}</span>
      </div>

      {refusals.count === 0 ? (
        <p className="ledger-empty">
          No contact in this queue hit a regulatory gate. The gate is armed on every
          decision (<code>lib/policy.ts</code>), so this is a measurement, not an
          absence of checking.
        </p>
      ) : (
        <>
          <p className="ledger-subhead">
            {refusals.count} {refusals.count === 1 ? "contact" : "contacts"} refused before execution.
            The figure above is the face value at stake, not revenue lost — the gate is
            evaluated per decision, so an episode refused at 22:00 is eligible again at 09:00.
          </p>
          <ul className="violation-list">
            {refusals.codes.map((c) => (
              <li key={`${c.regulation}:${c.code}`}>
                <span className="violation-code">{c.code}</span>
                <span className="violation-meaning">{CODE_MEANING[c.code] ?? readable(c.code)}</span>
                <span className="violation-reg">{readable(c.regulation)}</span>
                <span className="violation-count">×{c.count}</span>
              </li>
            ))}
          </ul>
          {onSelect && refusals.episodeIds[0] && (
            <button type="button" className="secondary-link" onClick={() => onSelect(refusals.episodeIds[0])}>
              Inspect a refused episode →
            </button>
          )}
        </>
      )}
    </section>
  );
}
