import { NextRequest, NextResponse } from "next/server";
import { checkoutFailureWebhook, type CheckoutFailureReport, type RazorpayPaymentEntity } from "@/lib/checkout";
import { postSignedRazorpayWebhook } from "@/app/_lib/signed-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Razorpay's own record of the failed payment: method, issuer, network, E.164 contact, error fields. */
async function fetchPayment(paymentId: string): Promise<RazorpayPaymentEntity | null> {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !secret) return null;
  try {
    const auth = Buffer.from(`${keyId}:${secret}`).toString("base64");
    const response = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}?expand[]=card`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    return (await response.json()) as RazorpayPaymentEntity;
  } catch {
    return null;
  }
}

/**
 * The checkout page reports Razorpay Checkout's `payment.failed` here. We enrich it
 * from Razorpay's payment API, shape it as the `payment.failed` webhook Razorpay would
 * have delivered, sign it, and POST it to the real webhook route. From there on
 * nothing is demo-specific.
 */
export async function POST(request: NextRequest) {
  const report = (await request.json().catch(() => null)) as CheckoutFailureReport | null;
  if (!report?.orderId || !Number.isFinite(report.amountPaise) || typeof report.error !== "object") {
    return NextResponse.json({ error: "orderId, amountPaise and error are required" }, { status: 400 });
  }
  const payment = report.paymentId ? await fetchPayment(report.paymentId) : null;
  const { failureCode, payload } = checkoutFailureWebhook(report, payment);
  const posted = await postSignedRazorpayWebhook(request.nextUrl.origin, payload, `evt_ck_${report.orderId}_${Date.now().toString(36)}`);
  return NextResponse.json(
    { failureCode, enrichedFrom: payment ? "razorpay_payment_api" : "checkout_js_error", posted },
    { status: posted.ok ? 200 : posted.status },
  );
}
