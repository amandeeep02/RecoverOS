import { NextRequest, NextResponse } from "next/server";
import { normalizeRazorpayEvent, verifyRazorpaySignature, UnsupportedEventError } from "@/lib/normalizer";
import { drainProcessingQueue, ensureBackgroundWorkers, ingestPaymentFailureQueued } from "@/lib/pipeline";
import { store } from "@/lib/store";

export const runtime = "nodejs";

/**
 * Razorpay's delivery deadline is measured in seconds, and a webhook that misses it
 * is retried, then retried again, and eventually the endpoint is disabled for the
 * merchant. So this handler does exactly the work that cannot be deferred —
 * verify the signature, normalise, persist the event, put it on the queue — and
 * answers. Diagnosis, scoring, the policy engine and the live payment-link create
 * all used to run inline, before the 202; they now run in a worker that holds a
 * durable claim on the episode row.
 *
 * What survives unchanged: idempotency is still keyed on `event_id` inside
 * `registerWebhook`, so a redelivery returns the original episode and enqueues
 * nothing.
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const verification = verifyRazorpaySignature(rawBody, request.headers.get("x-razorpay-signature"));
  if (!verification.valid) return NextResponse.json({ error: "Invalid webhook signature" }, { status: 401 });
  try {
    const event = normalizeRazorpayEvent(JSON.parse(rawBody), {
      eventId: request.headers.get("x-razorpay-event-id") ?? undefined,
      accountId: request.headers.get("x-razorpay-account-id") ?? undefined,
    });

    // Recovers anything a previous process left mid-flight and starts the poller.
    // Once per process, not once per request.
    ensureBackgroundWorkers(store);

    const result = await ingestPaymentFailureQueued(event, store);

    // Best effort, deliberately not awaited: on a long-lived Node server this makes
    // the queue latency effectively zero, and if the platform freezes the instance
    // after the response instead, the episode is still PENDING in the table and the
    // next poll — here or on another instance — claims it.
    if (!result.duplicate) void drainProcessingQueue(store).catch(() => {});

    return NextResponse.json(
      {
        episodeId: result.episode.id,
        status: result.episode.status,
        duplicate: result.duplicate,
        queued: !result.duplicate,
        signature: verification.verification,
      },
      { status: result.duplicate ? 200 : 202 },
    );
  } catch (error) {
    // 200 on a well-formed event we simply do not handle. A 4xx here makes Razorpay
    // redeliver forever and eventually disables the endpoint.
    if (error instanceof UnsupportedEventError) {
      return NextResponse.json({ ok: true, ignored: error.eventType }, { status: 200 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Malformed webhook" }, { status: 400 });
  }
}
