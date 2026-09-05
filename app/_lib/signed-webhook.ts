import { createHmac } from "node:crypto";

/**
 * Signs a Razorpay-shaped body exactly as Razorpay would and delivers it to our own
 * webhook route over HTTP, so an event that originated on this site (the demo button,
 * a checkout failure) runs the identical production path: signature check,
 * normalizer, idempotency, detector, policy engine, executor.
 */
export async function postSignedRazorpayWebhook(origin: string, payload: object, eventId: string, accountId = "merchant_demo") {
  // The verifier checks the received bytes, so sign exactly the string we send.
  const raw = JSON.stringify(payload);
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-razorpay-event-id": eventId,
    "x-razorpay-account-id": accountId,
  };
  if (secret) headers["x-razorpay-signature"] = createHmac("sha256", secret).update(raw).digest("hex");
  const target = new URL("/api/webhooks/razorpay", origin);
  const response = await fetch(target, { method: "POST", headers, body: raw });
  const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { url: target.pathname, signed: Boolean(secret), status: response.status, ok: response.ok, result };
}
