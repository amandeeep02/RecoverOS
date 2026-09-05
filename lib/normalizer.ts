import { createHmac, timingSafeEqual } from "node:crypto";
import { paymentEventSchema, type PaymentEvent } from "@/lib/domain";

/** The event is well-formed but not one we act on. Acknowledge it; do not retry it. */
export class UnsupportedEventError extends Error {
  constructor(readonly eventType: string) {
    super(`Unsupported Razorpay recovery event: ${eventType}`);
    this.name = "UnsupportedEventError";
  }
}

export function verifyRazorpaySignature(rawBody: string, receivedSignature: string | null, secret = process.env.RAZORPAY_WEBHOOK_SECRET) {
  // Fail CLOSED. Returning valid:true when the secret is absent means one missing
  // env var on deploy silently accepts unsigned traffic on a money-moving endpoint.
  if (!secret) return { valid: false, verification: "not_configured" as const };
  if (!receivedSignature) return { valid: false, verification: "missing" as const };
  
  // Verify over the RECEIVED BYTES. The previous version re-stringified
  // (`JSON.stringify(JSON.parse(raw))`) to "normalize whitespace", which silently
  // breaks on any payload whose canonical form differs from what was signed — a
  // non-ASCII customer name, a \u escape, a number Razorpay wrote as 1.0. Those
  // webhooks would fail verification and be dropped as forgeries.
  const normalizedBody = rawBody;

  const expected = createHmac("sha256", secret).update(normalizedBody).digest("hex");
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
    // Distinguishable from a malformed payload so the route can 200-ack-and-drop.
    // Throwing a generic error here produced a 400, and Razorpay retries 4xx — an
    // unsubscribed event type would be redelivered indefinitely.
    throw new UnsupportedEventError(String(eventType));
  }
  const payment = source.payload?.payment?.entity ?? {};
  const subscription = source.payload?.subscription?.entity ?? {};
  const method = payment.method === "card" || payment.method === "upi" || payment.method === "netbanking" || payment.method === "wallet" ? payment.method : "unknown";
  const amountPaise = Number.isFinite(payment.amount) ? Number(payment.amount) :
    Number.isFinite(source.payload?.payment?.amount) ? Number(source.payload.payment.amount) :
    Number.isFinite(source.amount) ? Number(source.amount) : NaN;
  const rawFailureCode = payment.error_code ?? payment.error_reason ?? subscription.status ?? null;
  const failureSource = mapFailureSource(payment.error_source ?? payment.error_reason ?? "unknown");
  const rawPhone = payment.customer_contact ?? payment.contact ?? source.payload?.customer?.entity?.contact ?? null;
  const customerPhone = rawPhone ? normalizeToE164(String(rawPhone)) : null;
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
    amountPaise,
    currency: "INR",
    paymentMethod: method,
    failureCode: rawFailureCode ? String(rawFailureCode) : null,
    failureSource,
    nativeRecoveryState,
    customerPhone,
    // issuer/network are what lib/degradation.ts keys its windows on. Without them
    // every card collapses into a single `card|-|-` bucket and issuer-level detection
    // silently degrades to method-level detection on live traffic.
    railMetadata: {
      razorpayEvent: eventType,
      paymentStatus: payment.status ?? null,
      subscriptionStatus: subscription.status ?? null,
      issuer: payment.card?.issuer ?? payment.bank ?? payment.wallet ?? null,
      network: payment.card?.network ?? (method === "upi" ? "UPI" : null),
      acquirer: payment.acquirer_data?.authentication_reference_number ? "present" : null,
    },
  };
  const parsed = paymentEventSchema.safeParse(normalized);
  if (!parsed.success) throw new Error(`Malformed Razorpay webhook: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
  return parsed.data;
}

export interface PaymentLinkPaid {
  eventId: string;
  paymentLinkId: string;
  /** Our episode id, carried back on the link's `notes` and `reference_id` (see lib/razorpay.ts). */
  episodeId: string | null;
  paymentId: string | null;
  amountPaise: number;
}

/**
 * The closing half of the loop. `lib/razorpay.ts` creates every link with
 * `reference_id = episodeId` and `notes.recoveros_episode_id = episodeId`, so a
 * `payment_link.paid` webhook names the episode it settles without a lookup.
 * Returns null for any other event so the route can fall through to ingestion.
 */
export function extractPaymentLinkPaid(body: unknown, headers: { eventId?: string } = {}): PaymentLinkPaid | null {
  const source = body as Record<string, any>;
  if (source?.event !== "payment_link.paid") return null;
  const link = source.payload?.payment_link?.entity ?? {};
  const payment = source.payload?.payment?.entity ?? {};
  if (typeof link.id !== "string" || link.id.length === 0) throw new Error("Malformed Razorpay webhook: payload.payment_link.entity.id");
  const episodeId = link.notes?.recoveros_episode_id ?? link.reference_id ?? null;
  const amount = [link.amount_paid, payment.amount, link.amount].map(Number).find((n) => Number.isFinite(n) && n > 0);
  return {
    eventId: headers.eventId ?? source.event_id ?? source.id ?? `evt_${link.id}_paid`,
    paymentLinkId: link.id,
    episodeId: typeof episodeId === "string" && episodeId.length > 0 ? episodeId : null,
    paymentId: typeof payment.id === "string" ? payment.id : null,
    amountPaise: amount ?? NaN,
  };
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

/** Normalizes Indian customer contacts to E.164; defaults to +91 for bare 10-digit numbers. */
export function normalizeToE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (raw.startsWith("+")) return `+${digits}`;
  return null;
}
