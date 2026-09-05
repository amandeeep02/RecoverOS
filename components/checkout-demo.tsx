"use client";

import { useCallback, useEffect, useState } from "react";
import { formatInr } from "@/lib/domain";

/**
 * The live loop, started by a real customer action instead of a button that fakes one.
 *
 * Razorpay Checkout runs in test mode against a real order. When the customer fails
 * the payment, Checkout's `payment.failed` is reported to `/api/checkout/failed`,
 * which shapes and signs it like the webhook Razorpay would have sent and posts it to
 * the production route. Everything after that — diagnosis, EIR, the policy gate, the
 * Twilio call, the spoken answer — is the same code path with nothing demo-specific.
 */

type RazorpayFailure = {
  error?: { code?: string; description?: string; source?: string; step?: string; reason?: string; metadata?: { order_id?: string; payment_id?: string } };
};
type RazorpayCheckout = { open: () => void; on: (event: "payment.failed", handler: (response: RazorpayFailure) => void) => void };
declare global {
  interface Window { Razorpay?: new (options: Record<string, unknown>) => RazorpayCheckout }
}

type EpisodeRecord = {
  id: string;
  status: string;
  event: { amountPaise: number; failureCode: string | null; customerPhone: string | null; paymentMethod: string };
  diagnosis?: { category: string; confidence: number } | null;
  eir?: { eirPaise: number; action: string } | null;
  policyDecision?: { outcome: string; allowedAction: string | null; reasons: string[] } | null;
  execution?: { status: string; executor: string; externalReference: string | null; error: string | null } | null;
  customerResponses?: { responseId: string; text: string; receivedAt: string; confidence: number | null }[];
};

const CHECKOUT_JS = "https://checkout.razorpay.com/v1/checkout.js";

function loadCheckoutJs(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.Razorpay) return resolve();
    const script = document.createElement("script");
    script.src = CHECKOUT_JS;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Razorpay Checkout script failed to load"));
    document.body.appendChild(script);
  });
}

function toE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (raw.trim().startsWith("+") && digits.length >= 10) return `+${digits}`;
  return null;
}

const REGULATORY = /^(TRAI|DLT|DND|WA_|RBI|DPDP)/;

function statusLine(episode: EpisodeRecord): string {
  switch (episode.status) {
    case "PROMISED": return "Call placed. Waiting for the customer to answer.";
    case "PENDING": return "Waiting on the customer to pay.";
    case "ESCALATED": return "Escalated to a human.";
    case "SUPPRESSED": return "Deliberately not contacting: acting would destroy more value than it recovers.";
    case "HELD_DEGRADED": return "Held: the issuer looks degraded right now.";
    case "RECOVERED": return "Recovered.";
    case "FAILED": return "Execution failed.";
    default: return "Deciding…";
  }
}

export function CheckoutDemo({ quietHoursDisabled }: { quietHoursDisabled: boolean }) {
  const [amount, setAmount] = useState(4_999);
  const [name, setName] = useState("Demo Customer");
  const [phone, setPhone] = useState("");
  const [stage, setStage] = useState<"idle" | "ordering" | "checkout" | "reporting" | "tracking" | "paid" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ description: string; reason: string; failureCode?: string; enrichedFrom?: string } | null>(null);
  const [episodeId, setEpisodeId] = useState<string | null>(null);
  const [episode, setEpisode] = useState<EpisodeRecord | null>(null);

  useEffect(() => {
    try { const saved = localStorage.getItem("recoveros.checkout.phone"); if (saved) setPhone(saved); } catch {}
  }, []);

  // The page follows its own episode. The dashboard follows it too, over the live stream.
  useEffect(() => {
    if (!episodeId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/episodes/${episodeId}`, { cache: "no-store" });
        if (res.ok) { const data = await res.json(); if (!cancelled) setEpisode(data.episode as EpisodeRecord); }
      } catch {}
    };
    void tick();
    const timer = setInterval(tick, 1500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [episodeId]);

  const pay = useCallback(async () => {
    setMessage(null); setFailure(null); setEpisode(null); setEpisodeId(null);
    const contact = toE164(phone);
    if (!contact) { setStage("error"); setMessage("Enter the phone that should receive the call: 10 digits, or +91…"); return; }
    try { localStorage.setItem("recoveros.checkout.phone", phone); } catch {}
    setStage("ordering");
    try {
      const res = await fetch("/api/checkout/order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amountRupees: amount, name }) });
      const order = await res.json();
      if (!res.ok) throw new Error(order.error ?? "Could not create the order");
      await loadCheckoutJs();
      if (!window.Razorpay) throw new Error("Razorpay Checkout did not initialise");
      setStage("checkout");
      const checkout = new window.Razorpay({
        key: order.keyId,
        amount: order.amountPaise,
        currency: "INR",
        order_id: order.orderId,
        name: "RecoverOS Demo Merchant",
        description: "Monthly subscription renewal",
        prefill: { name, contact },
        notes: { recoveros_checkout_demo: "true" },
        theme: { color: "#1f4738" },
        // One attempt per order: a failure closes Checkout and reaches RecoverOS instead of a retry prompt.
        retry: { enabled: false },
        modal: { ondismiss: () => setStage((s) => (s === "checkout" ? "idle" : s)) },
        handler: () => { setStage("paid"); setMessage("Payment succeeded, so there is nothing to recover. Fail it next time to see the loop."); },
      });
      checkout.on("payment.failed", async (response) => {
        setStage("reporting");
        const err = response.error ?? {};
        setFailure({ description: err.description ?? "Payment failed", reason: err.reason ?? err.code ?? "unknown" });
        try {
          const report = await fetch("/api/checkout/failed", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              orderId: order.orderId,
              paymentId: err.metadata?.payment_id ?? null,
              amountPaise: order.amountPaise,
              contact,
              name,
              error: { code: err.code, description: err.description, source: err.source, step: err.step, reason: err.reason },
            }),
          });
          const data = await report.json();
          if (!report.ok) throw new Error(data.error ?? "RecoverOS did not accept the failure");
          setFailure((f) => f && { ...f, failureCode: data.failureCode, enrichedFrom: data.enrichedFrom });
          const id = data.posted?.result?.episodeId as string | undefined;
          if (!id) throw new Error("No recovery episode was opened");
          setEpisodeId(id);
          setStage("tracking");
        } catch (e) {
          setStage("error");
          setMessage(e instanceof Error ? e.message : "Could not report the failure");
        }
      });
      checkout.open();
    } catch (e) {
      setStage("error");
      setMessage(e instanceof Error ? e.message : "Something went wrong");
    }
  }, [amount, name, phone]);

  const decision = episode?.policyDecision ?? null;
  const regulatory = decision?.reasons.filter((r) => REGULATORY.test(r.split(":").pop() ?? r)) ?? [];
  const execution = episode?.execution ?? null;
  const said = episode?.customerResponses?.at(-1) ?? null;
  const busy = stage === "ordering" || stage === "checkout" || stage === "reporting";

  return (
    <main className="checkout-page">
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">Live loop · Razorpay test mode</p>
          <h1>Subscription checkout</h1>
          <p className="dashboard-sub">Pay, fail it on purpose, and watch RecoverOS decide, call, and listen.</p>
        </div>
        <div className="header-meta"><a className="secondary-link" href="/">← Dashboard</a></div>
      </header>

      <div className="checkout-grid">
        <section className="panel checkout-card">
          <div className="panel-heading"><div><p className="eyebrow">Step 1</p><h2>Renew</h2></div></div>
          <div className="checkout-form">
            <label><span>Plan amount ₹</span><input type="number" min={1} value={amount} onChange={(e) => setAmount(Number(e.target.value) || 0)} /></label>
            <label><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label><span>Phone to call</span><input placeholder="+91 98xxxxxxx" value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
            <button type="button" className="primary-btn" onClick={pay} disabled={busy}>
              {stage === "ordering" ? "Creating order…" : stage === "checkout" ? "Checkout open…" : stage === "reporting" ? "Reporting failure…" : `Pay ${formatInr(Math.round(amount * 100))} with Razorpay`}
            </button>
            {message && <p className={`checkout-message ${stage === "error" ? "bad" : ""}`}>{message}</p>}
          </div>
          <div className="checkout-help">
            <p className="eyebrow">How to fail it</p>
            <p>Pick <b>Netbanking</b>, any bank, then press <b>Failure</b> on the mock bank page. Or use card <code>4111 1111 1111 1111</code>, any future expiry and CVV, then <b>Failure</b> on the mock authentication page.</p>
            <p>At ₹4,999 and above with a phone on file the scorer prefers a voice call.{" "}
              {quietHoursDisabled
                ? <>The TRAI quiet-hours gate is <b>disabled on this server</b>, so the call is placed at any hour.</>
                : <>Calls are placed only between 09:00 and 21:00 IST; outside that window the regulatory gate refuses them, and you will see that refusal here and on the dashboard.</>}
            </p>
          </div>
        </section>

        <section className="panel checkout-card">
          <div className="panel-heading"><div><p className="eyebrow">Step 2</p><h2>What RecoverOS did</h2></div>{episode && <span className="queue-count">{episode.id.slice(0, 16)}…</span>}</div>
          {!failure && !episode ? (
            <p className="ledger-empty">Nothing yet. Fail a payment and this fills in live.</p>
          ) : (
            <ol className="timeline">
              <li className="done">
                <b>Payment failed at Razorpay</b>
                <span>{failure?.description ?? "—"} · <code>{failure?.reason}</code>{failure?.failureCode && <> → diagnosed as <code>{failure.failureCode}</code></>}</span>
              </li>
              <li className={decision ? "done" : "active"}>
                <b>Policy decision</b>
                {decision ? (
                  <span>
                    <code>{decision.outcome}</code>{decision.allowedAction && <> → <code>{decision.allowedAction}</code></>}
                    {episode?.eir && <> · EIR {formatInr(episode.eir.eirPaise)}</>}
                    {regulatory.length > 0 && <><br /><em>Refused by the regulator: {regulatory.join(", ")}</em></>}
                  </span>
                ) : <span>Diagnosing and scoring…</span>}
              </li>
              <li className={execution ? "done" : decision?.allowedAction && decision.allowedAction !== "WAIT" ? "active" : ""}>
                <b>Execution</b>
                {execution ? (
                  <span>
                    {execution.executor === "twilio_voice_api" ? `Calling ${episode?.event.customerPhone ?? "the customer"} via Twilio` : execution.executor === "razorpay_payment_link_api" ? "Razorpay payment link created" : execution.executor.replace(/_/g, " ")}
                    {execution.externalReference && <> · <code>{execution.externalReference}</code></>}
                    {execution.error && <><br /><em>{execution.error}</em></>}
                  </span>
                ) : <span>{episode ? statusLine(episode) : "—"}</span>}
              </li>
              <li className={said ? "done" : execution?.executor === "twilio_voice_api" ? "active" : ""}>
                <b>Customer said</b>
                {said ? <span>“{said.text}”{said.confidence != null && <> · {Math.round(said.confidence * 100)}% confidence</>}</span> : <span>{execution?.executor === "twilio_voice_api" ? "Answer the phone and say why the payment failed." : "—"}</span>}
              </li>
            </ol>
          )}
          {episode && <p className="checkout-status">{statusLine(episode)} <a className="secondary-link" href="/">See it on the dashboard →</a></p>}
        </section>
      </div>
    </main>
  );
}
