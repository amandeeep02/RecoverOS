"use client";

import { useState } from "react";

/**
 * The live loop (IDEA.md §11, 0:35). Posts a signed, Razorpay-shaped
 * `payment.failed` to the real webhook route; the episode that appears in the queue
 * came through the same signature check, normalizer, detector and policy engine a
 * production webhook would.
 */
export function DemoControls({ onFired }: { onFired: () => void }) {
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [amount, setAmount] = useState(4_999);
  const [failureCode, setFailureCode] = useState("expired_card");

  const fire = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/demo/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountRupees: amount, failureCode, method: "card", nativeRecoveryState: "EXHAUSTED" }),
      });
      const data = await res.json();
      const line = data.result?.episodeId
        ? `${data.status} ${data.posted.signed ? "signed" : "unsigned"} → ${data.result.episodeId} · ${data.result.status}`
        : `${data.status} → ${JSON.stringify(data.result)}`;
      setLog((prev) => [line, ...prev].slice(0, 6));
      onFired();
    } catch (error) {
      setLog((prev) => [error instanceof Error ? error.message : "request failed", ...prev].slice(0, 6));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="demo-controls" aria-label="Live webhook loop">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Live loop</p>
          <h2>Fire a real webhook</h2>
        </div>
        <div className="demo-inputs">
          <label>
            <span>Amount ₹</span>
            <input type="number" min={1} value={amount} onChange={(e) => setAmount(Number(e.target.value) || 0)} />
          </label>
          <label>
            <span>Failure code</span>
            <select value={failureCode} onChange={(e) => setFailureCode(e.target.value)}>
              <option value="expired_card">expired_card</option>
              <option value="insufficient_funds">insufficient_funds</option>
              <option value="bank_declined">bank_declined</option>
              <option value="authentication_failed">authentication_failed</option>
              <option value="permanent_decline">permanent_decline</option>
              <option value="mandate_rejected">mandate_rejected</option>
              <option value="unmapped_code">unmapped_code</option>
            </select>
          </label>
          <button type="button" className="primary-btn" onClick={fire} disabled={busy}>
            {busy ? "Posting…" : "POST /api/webhooks/razorpay"}
          </button>
        </div>
      </div>
      {log.length > 0 && (
        <ul className="demo-log">
          {log.map((line, i) => <li key={`${line}-${i}`}>{line}</li>)}
        </ul>
      )}
    </section>
  );
}
