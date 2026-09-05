import { createHmac } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The live loop beat (IDEA.md §11, 0:35).
 *
 * This does not shortcut the pipeline. It builds a Razorpay-shaped `payment.failed`
 * body, signs it with the configured webhook secret, and POSTs it to the REAL
 * `/api/webhooks/razorpay` route over HTTP — so the signature check, the
 * normalizer, the idempotency guard, the degradation detector and the policy engine
 * all run exactly as they do for a webhook from Razorpay.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    amountRupees?: number;
    method?: "card" | "upi" | "netbanking" | "wallet";
    failureCode?: string;
    issuer?: string;
    network?: string;
    nativeRecoveryState?: "ACTIVE" | "EXHAUSTED" | "UNKNOWN";
  };

  const suffix = Date.now().toString(36);
  const amountPaise = Math.round((body.amountRupees ?? 4_999) * 100);
  const method = body.method ?? "card";
  const payload = {
    event: "payment.failed",
    account_id: "merchant_demo",
    created_at: Math.floor(Date.now() / 1000),
    native_recovery_state: body.nativeRecoveryState ?? "EXHAUSTED",
    payload: {
      payment: {
        entity: {
          id: `pay_live_${suffix}`,
          amount: amountPaise,
          method,
          status: "failed",
          error_code: body.failureCode ?? "expired_card",
          error_source: "bank",
          customer_id: `cust_live_${suffix}`,
          subscription_id: `sub_live_${suffix}`,
        },
      },
    },
  };

  // The verifier normalises by parse→stringify, so sign the same normalised string.
  const raw = JSON.stringify(payload);
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-razorpay-event-id": `evt_live_${suffix}`,
    "x-razorpay-account-id": "merchant_demo",
  };
  if (secret) headers["x-razorpay-signature"] = createHmac("sha256", secret).update(raw).digest("hex");

  const target = new URL("/api/webhooks/razorpay", request.nextUrl.origin);
  const response = await fetch(target, { method: "POST", headers, body: raw });
  const result = await response.json().catch(() => ({}));

  return NextResponse.json(
    {
      posted: { url: target.pathname, signed: Boolean(secret), issuer: body.issuer ?? null, network: body.network ?? null },
      status: response.status,
      result,
    },
    { status: response.ok ? 200 : response.status },
  );
}
