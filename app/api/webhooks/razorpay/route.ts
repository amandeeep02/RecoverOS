import { NextRequest, NextResponse } from "next/server";
import { normalizeRazorpayEvent, verifyRazorpaySignature } from "@/lib/normalizer";
import { processPaymentFailure } from "@/lib/pipeline";
import { store } from "@/lib/store";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const verification = verifyRazorpaySignature(rawBody, request.headers.get("x-razorpay-signature"));
  if (!verification.valid) return NextResponse.json({ error: "Invalid webhook signature" }, { status: 401 });
  try {
    const event = normalizeRazorpayEvent(JSON.parse(rawBody), {
      eventId: request.headers.get("x-razorpay-event-id") ?? undefined,
      accountId: request.headers.get("x-razorpay-account-id") ?? undefined,
    });
    const result = await processPaymentFailure(event, store);
    return NextResponse.json({ episodeId: result.episode.id, status: result.episode.status, duplicate: result.duplicate, signature: verification.verification }, { status: result.duplicate ? 200 : 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Malformed webhook" }, { status: 400 });
  }
}
