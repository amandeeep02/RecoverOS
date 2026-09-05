import { NextRequest, NextResponse } from "next/server";
import { rupees, type PaymentEvent } from "@/lib/domain";
import { store } from "@/lib/store";
import { ingestPaymentFailure, recordAttempt, resumeHeldEpisode, tickDegradation } from "@/lib/pipeline";
import { DEGRADATION_CONFIG } from "@/lib/degradation";
import { buildDegradationView, demoPolicy, DEMO_MERCHANT } from "@/app/_lib/dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Kill Switch beat, driven against the REAL detector.
 *
 * What is synthetic: the issuer attempt feed. A 15-minute-window detector with an
 * 8-window warm-up needs two hours of live traffic before it may fire at all, and a
 * three-minute demo does not have two hours. So this endpoint injects attempts on
 * one key and advances the window cadence.
 *
 * What is NOT synthetic: everything the detector then does. The EWMA baseline, the
 * 3× trigger, the ≥20-attempt and ≥15%-absolute-rate guards, the 8-window warm-up,
 * the frozen baseline, the 2-window hysteresis close and the jittered drain are the
 * production code path in `lib/degradation.ts`, and the episodes it holds are real
 * episodes that went through the real policy engine. Every number this returns is
 * read back out of the detector, not asserted here.
 */

const OUTAGE_KEY = { method: "card" as const, issuer: "HDFC", network: "VISA" };
const HEALTHY_ATTEMPTS_PER_WINDOW = 60;
const HEALTHY_FAILURE_RATE = 0.05;
const SPIKE_FAILURE_RATE = 0.6;

function syntheticEvent(index: number, amountPaise: number): PaymentEvent {
  return {
    eventId: `evt_outage_${Date.now()}_${index}`,
    eventType: "payment.failed",
    occurredAt: new Date().toISOString(),
    merchantId: DEMO_MERCHANT,
    customerId: `cust_outage_${index}`,
    paymentId: `pay_outage_${Date.now()}_${index}`,
    subscriptionId: `sub_outage_${index}`,
    amountPaise,
    currency: "INR",
    paymentMethod: OUTAGE_KEY.method,
    failureCode: "expired_card",
    failureSource: "bank",
    nativeRecoveryState: "EXHAUSTED",
    customerPhone: null,
    railMetadata: { issuer: OUTAGE_KEY.issuer, network: OUTAGE_KEY.network },
  } as PaymentEvent;
}

/** One window of attempts on the outage key at a given failure rate. */
function feedWindow(failureRate: number) {
  const failures = Math.round(HEALTHY_ATTEMPTS_PER_WINDOW * failureRate);
  const probe = syntheticEvent(-1, rupees(1_000));
  for (let i = 0; i < HEALTHY_ATTEMPTS_PER_WINDOW; i++) {
    recordAttempt(probe, i < failures, store);
  }
  return { attempts: HEALTHY_ATTEMPTS_PER_WINDOW, failures };
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { action?: string; holdCount?: number };
  const action = body.action ?? "open";
  const policy = demoPolicy();

  if (action === "open") {
    const holdCount = Math.min(400, Math.max(1, body.holdCount ?? 24));
    const warmupWindows = DEGRADATION_CONFIG.BASELINE_SEED_WINDOWS;

    // 1. Warm-up. The detector refuses to fire before it has a baseline, and this
    //    is that baseline: `warmupWindows` windows of healthy traffic on one key.
    for (let w = 0; w < warmupWindows; w++) {
      feedWindow(HEALTHY_FAILURE_RATE);
      await tickDegradation(store);
    }

    // 2. The spike.
    const spike = feedWindow(SPIKE_FAILURE_RATE);
    const tick = await tickDegradation(store);

    // 3. Real episodes arriving on the degraded key while the window is open.
    const held: string[] = [];
    const notHeld: { id: string; status: string }[] = [];
    // Ingested in batches: each episode is several round trips to the store, and a
    // strictly serial loop makes the Kill Switch beat take longer than the beat.
    const BATCH = 8;
    for (let start = 0; start < holdCount; start += BATCH) {
      const batch = Array.from({ length: Math.min(BATCH, holdCount - start) }, (_, k) => start + k);
      const settled = await Promise.all(batch.map((i) =>
        ingestPaymentFailure(syntheticEvent(i, rupees(1_200 + ((i * 317) % 7_800))), store, policy),
      ));
      for (const { episode } of settled) {
        if (episode.status === "HELD_DEGRADED") held.push(episode.id);
        else notHeld.push({ id: episode.id, status: episode.status });
      }
    }

    const episodes = await store.listEpisodes();
    return NextResponse.json({
      action,
      opened: tick.opened.length,
      held: held.length,
      heldEpisodeIds: held,
      notHeld,
      synthetic: {
        warmupWindows,
        attemptsPerWindow: HEALTHY_ATTEMPTS_PER_WINDOW,
        healthyFailureRate: HEALTHY_FAILURE_RATE,
        spikeFailureRate: SPIKE_FAILURE_RATE,
        spikeWindow: spike,
      },
      degradation: buildDegradationView(episodes),
    });
  }

  if (action === "close") {
    // Hysteresis: the detector requires CLOSE_WINDOWS consecutive windows below
    // CLOSE_RATIO before it will believe the issuer is back.
    for (let w = 0; w < DEGRADATION_CONFIG.CLOSE_WINDOWS; w++) {
      feedWindow(HEALTHY_FAILURE_RATE);
      await tickDegradation(store);
    }
    const finalTick = await tickDegradation(store);
    const episodes = await store.listEpisodes();
    return NextResponse.json({
      action,
      closed: finalTick.closed.length,
      drainScheduled: finalTick.drainScheduled,
      degradation: buildDegradationView(episodes),
    });
  }

  if (action === "drain-now") {
    // Skips the 0–2 minute drain jitter so the release is visible inside a demo.
    // The jitter is a real production behaviour; this control only shortens the wait.
    const episodes = await store.listEpisodes();
    const heldIds = episodes.filter((e) => e.status === "HELD_DEGRADED").map((e) => e.id);
    const released: { id: string; status: string }[] = [];
    for (const id of heldIds) {
      const settled = await resumeHeldEpisode(id, store);
      if (settled) released.push({ id: settled.id, status: settled.status });
    }
    return NextResponse.json({ action, released, degradation: buildDegradationView(await store.listEpisodes()) });
  }

  return NextResponse.json({ error: "action must be open, close, or drain-now" }, { status: 400 });
}
