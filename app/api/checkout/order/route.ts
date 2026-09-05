import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Creates a Razorpay test-mode order for the checkout demo. The secret never leaves the server. */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { amountRupees?: number; name?: string };
  const amountPaise = Math.round(Number(body.amountRupees ?? 4_999) * 100);
  if (!Number.isFinite(amountPaise) || amountPaise < 100 || amountPaise > 50_000_000) {
    return NextResponse.json({ error: "Amount must be between ₹1 and ₹5,00,000" }, { status: 400 });
  }
  const keyId = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !secret) return NextResponse.json({ error: "Razorpay keys are not configured" }, { status: 503 });

  const auth = Buffer.from(`${keyId}:${secret}`).toString("base64");
  const response = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: amountPaise,
      currency: "INR",
      receipt: `recoveros_ck_${Date.now().toString(36)}`,
      notes: { recoveros_checkout_demo: "true", customer_name: body.name ?? "" },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await response.json().catch(() => ({}))) as { id?: string; error?: { description?: string } };
  if (!response.ok || !data.id) {
    return NextResponse.json({ error: data.error?.description ?? "Razorpay refused the order" }, { status: 502 });
  }
  return NextResponse.json({ orderId: data.id, amountPaise, currency: "INR", keyId, testMode: keyId.startsWith("rzp_test_") });
}
