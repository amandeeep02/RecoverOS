import { createHash } from "node:crypto";

/** What Razorpay Checkout hands the browser on its `payment.failed` event. */
export interface CheckoutFailureReport {
  orderId: string;
  paymentId: string | null;
  amountPaise: number;
  contact: string | null;
  name?: string | null;
  error: { code?: string | null; description?: string | null; source?: string | null; step?: string | null; reason?: string | null };
}

/** The slice of Razorpay's payment entity (`GET /v1/payments/:id?expand[]=card`) we read. */
export interface RazorpayPaymentEntity {
  id?: string;
  method?: string | null;
  contact?: string | null;
  bank?: string | null;
  wallet?: string | null;
  card?: { issuer?: string | null; network?: string | null } | null;
  error_code?: string | null;
  error_description?: string | null;
  error_source?: string | null;
  error_step?: string | null;
  error_reason?: string | null;
}

/** Failure codes the deterministic diagnosis table understands (lib/diagnosis.ts). */
const KNOWN_CODES = new Set(["insufficient_funds", "bank_declined", "expired_card", "authentication_failed", "mandate_rejected", "permanent_decline", "network_error"]);

/**
 * Razorpay reports a checkout failure more coarsely than the diagnosis table reads:
 * usually `reason: "payment_failed"` plus a human description and the `source` and
 * `step` where it died. This maps onto the table's vocabulary using only what the
 * error itself says. Anything it does not clearly say is passed through as Razorpay
 * sent it, so the diagnosis returns `unknown` and the policy escalates — the honest
 * path, not a guessed category.
 */
export function checkoutFailureCode(error: CheckoutFailureReport["error"]): string {
  const reason = (error.reason ?? "").toLowerCase();
  if (KNOWN_CODES.has(reason)) return reason;
  const text = `${error.description ?? ""} ${reason}`.toLowerCase();
  if (/insufficient/.test(text)) return "insufficient_funds";
  if (/expired/.test(text)) return "expired_card";
  if (/authenticat|\botp\b|3d ?secure/.test(text)) return "authentication_failed";
  if (/network|timed? ?out/.test(text)) return "network_error";
  if (error.step === "payment_authorization" && (error.source === "bank" || error.source === "issuer")) return "bank_declined";
  return reason || error.code || "unknown";
}

/**
 * A Razorpay-shaped `payment.failed` body for the real webhook route. Razorpay's own
 * payment record wins over what the browser saw, because it carries the method, the
 * issuer and network the degradation detector keys on, and the E.164 contact.
 */
export function checkoutFailureWebhook(report: CheckoutFailureReport, payment: RazorpayPaymentEntity | null, nowMs = Date.now()) {
  const error = {
    code: payment?.error_code ?? report.error.code,
    description: payment?.error_description ?? report.error.description,
    source: payment?.error_source ?? report.error.source,
    step: payment?.error_step ?? report.error.step,
    reason: payment?.error_reason ?? report.error.reason,
  };
  const failureCode = checkoutFailureCode(error);
  // One checkout order is one customer. A retry inside the same checkout is the same
  // person and accrues contact fatigue; a fresh order is a fresh customer, so the demo
  // beat is repeatable from a single phone.
  const customerId = `cust_ck_${createHash("sha1").update(report.orderId).digest("hex").slice(0, 12)}`;
  return {
    failureCode,
    payload: {
      event: "payment.failed",
      account_id: "merchant_demo",
      created_at: Math.floor(nowMs / 1000),
      // A one-off checkout has no issuer retry cycle behind it. Without this the
      // normalizer assumes an ACTIVE card cycle and the policy waits on it.
      native_recovery_state: "EXHAUSTED",
      payload: {
        payment: {
          entity: {
            id: report.paymentId ?? `pay_ck_${report.orderId}`,
            order_id: report.orderId,
            amount: report.amountPaise,
            currency: "INR",
            method: payment?.method ?? "card",
            status: "failed",
            contact: payment?.contact ?? report.contact,
            customer_id: customerId,
            subscription_id: `sub_ck_${report.orderId}`,
            bank: payment?.bank ?? null,
            wallet: payment?.wallet ?? null,
            card: payment?.card ? { issuer: payment.card.issuer ?? null, network: payment.card.network ?? null } : undefined,
            error_code: failureCode,
            error_description: error.description ?? null,
            error_source: error.source ?? "bank",
            error_step: error.step ?? null,
            error_reason: error.reason ?? null,
            notes: { recoveros_checkout_demo: "true", customer_name: report.name ?? null },
          },
        },
      },
    },
  };
}
