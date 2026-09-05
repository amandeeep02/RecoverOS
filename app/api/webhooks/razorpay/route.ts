import { NextRequest, NextResponse } from "next/server";
import { normalizeRazorpayEvent, verifyRazorpaySignature, UnsupportedEventError } from "@/lib/normalizer";
import { ingestPaymentFailure } from "@/lib/pipeline";
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
    // `ingestPaymentFailure` is the production entry point: it records the attempt
    // into the process-wide degradation detector and hands that same detector to
    // the policy gate, which is what makes HELD_DEGRADED reachable at all.
    const result = await ingestPaymentFailure(event, store);
    return NextResponse.json({ episodeId: result.episode.id, status: result.episode.status, duplicate: result.duplicate, signature: verification.verification }, { status: result.duplicate ? 200 : 202 });
  } catch (error) {
    // 200 on a well-formed event we simply do not handle. A 4xx here makes Razorpay
    // redeliver forever and eventually disables the endpoint.
    if (error instanceof UnsupportedEventError) {
      return NextResponse.json({ ok: true, ignored: error.eventType }, { status: 200 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Malformed webhook" }, { status: 400 });
  }
}
