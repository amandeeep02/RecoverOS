import { createHmac, timingSafeEqual } from "node:crypto";
import { paymentEventSchema, type PaymentEvent } from "@/lib/domain";

export function verifyRazorpaySignature(rawBody: string, receivedSignature: string | null, secret = process.env.RAZORPAY_WEBHOOK_SECRET) {
  if (!secret) return { valid: true, verification: "not_configured" as const };
  if (!receivedSignature) return { valid: false, verification: "missing" as const };
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBytes = Buffer.from(expected, "utf8");
  const receivedBytes = Buffer.from(receivedSignature, "utf8");
  return {
    valid: expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes),
    verification: "verified" as const,
  };
}

/** Maps the minimum Razorpay webhook shape into a rail-neutral internal event. */
export function normalizeRazorpayEvent(body: unknown, headers: { eventId?: string; accountId?: string } = {}): PaymentEvent {
  const source = body as Record<string, any>;
  const eventType = source.event;
  if (!['payment.failed', 'subscription.pending', 'subscription.halted'].includes(eventType)) {
    throw new Error("Unsupported Razorpay recovery event");
  }
  const payment = source.payload?.payment?.entity ?? {};
  const subscription = source.payload?.subscription?.entity ?? {};
  const method = payment.method === "card" || payment.method === "upi" || payment.method === "netbanking" || payment.method === "wallet" ? payment.method : "unknown";
  const amountPaise = payment.amount ?? source.payload?.payment?.amount ?? source.amount;
  const amountInr = Number.isFinite(amountPaise) ? Math.round(Number(amountPaise) / 100) : NaN;
  const rawFailureCode = payment.error_code ?? payment.error_reason ?? subscription.status ?? null;
  const failureSource = mapFailureSource(payment.error_source ?? payment.error_reason ?? "unknown");
  const nativeRecoveryState = source.native_recovery_state
    ?? (eventType === "subscription.halted" ? "EXHAUSTED" : method === "card" ? "ACTIVE" : "UNKNOWN");
  const normalized = {
    eventId: headers.eventId ?? source.event_id ?? source.id,
    eventType,
    occurredAt: new Date(source.created_at ? Number(source.created_at) * 1000 : Date.now()).toISOString(),
    merchantId: headers.accountId ?? source.account_id ?? "merchant_demo",
    customerId: payment.customer_id ?? subscription.customer_id ?? source.payload?.customer?.entity?.id,
    paymentId: payment.id ?? `subscription:${subscription.id ?? "unknown"}`,
    subscriptionId: payment.subscription_id ?? subscription.id ?? null,
    amountInr,
    currency: "INR",
    paymentMethod: method,
    failureCode: rawFailureCode ? String(rawFailureCode) : null,
    failureSource,
    nativeRecoveryState,
    railMetadata: { razorpayEvent: eventType, paymentStatus: payment.status ?? null, subscriptionStatus: subscription.status ?? null },
  };
  const parsed = paymentEventSchema.safeParse(normalized);
  if (!parsed.success) throw new Error(`Malformed Razorpay webhook: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
  return parsed.data;
}

function mapFailureSource(value: unknown): PaymentEvent["failureSource"] {
  const text = String(value).toLowerCase();
  if (text.includes("bank") || text.includes("issuer")) return "bank";
  if (text.includes("gateway")) return "gateway";
  if (text.includes("network")) return "network";
  if (text.includes("mandate")) return "mandate";
  if (text.includes("customer") || text.includes("auth")) return "customer";
  return "unknown";
}
