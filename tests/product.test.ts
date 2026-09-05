import { describe, expect, it } from "vitest";
import { RecoveryStore } from "@/lib/memory-store";
import { merchantPolicySchema, rupees, type CustomerProfile, type PaymentEvent } from "@/lib/domain";
import { processPaymentFailure, observeOutcome } from "@/lib/pipeline";
import { DegradationDetector, DEGRADATION_CONFIG } from "@/lib/degradation";
import { RealtimeServer, createSSEStream } from "@/lib/realtime";
import { replayBatch } from "@/lib/replay";
import { fixedClock } from "@/lib/clock";

function event(overrides: Partial<PaymentEvent> = {}): PaymentEvent {
  return {
    eventId: `evt_${Math.random().toString(36).slice(2)}`,
    eventType: "payment.failed",
    occurredAt: "2026-08-21T10:14:03.000Z",
    merchantId: "merchant_test",
    customerId: "cust_test",
    paymentId: `pay_${Math.random().toString(36).slice(2)}`,
    subscriptionId: "sub_test",
    amountPaise: rupees(4_999),
    currency: "INR",
    paymentMethod: "card",
    failureCode: "expired_card",
    failureSource: "bank",
    nativeRecoveryState: "EXHAUSTED",
    customerPhone: null,
    railMetadata: { issuer: "HDFC", network: "VISA" },
    ...overrides,
  } as PaymentEvent;
}

function profile(overrides: Partial<CustomerProfile> = {}): CustomerProfile {
  return {
    customerId: "cust_test",
    merchantId: "merchant_test",
    subscriptionAgeDays: 240,
    customerValuePaise: rupees(50_000),
    successfulPaymentCount: 11,
    failedPaymentCount: 1,
    previousRecoveryRate: 0.58,
    previousInterventionCount: 0,
    previousInterventionSuccessCount: 0,
    daysSinceLastSuccess: 14,
    lastFailureReason: null,
    paymentMethodDistribution: { card: 1 },
    currentFailureEpisodeId: null,
    consentValid: true,
    optedOut: false,
    contactWindowOpen: true,
    phone: null,
    isSubscription: true,
    daysSinceLastEngagement: 14,
    engagementProxy: true,
    ...overrides,
  };
}

/** Warm the detector past its 8-window seed with healthy traffic, then spike it. */
function drive(detector: DegradationDetector, probe: PaymentEvent) {
  const feed = (rate: number) => {
    for (let i = 0; i < 60; i++) detector.record(probe, i < Math.round(60 * rate));
  };
  for (let w = 0; w < DEGRADATION_CONFIG.BASELINE_SEED_WINDOWS; w++) {
    feed(0.05);
    detector.tick();
  }
  feed(0.6);
  return detector.tick();
}

describe("issuer degradation is reachable from the running pipeline", () => {
  it("refuses to fire before the warm-up is complete", () => {
    const detector = new DegradationDetector(new RecoveryStore());
    const probe = event();
    for (let w = 0; w < DEGRADATION_CONFIG.BASELINE_SEED_WINDOWS - 1; w++) {
      for (let i = 0; i < 60; i++) detector.record(probe, i < 36); // 60% failures throughout
      expect(detector.tick().opened).toHaveLength(0);
    }
  });

  it("opens a window, holds episodes at HELD_DEGRADED, and never contacts anyone", async () => {
    const store = new RecoveryStore();
    const detector = new DegradationDetector(store);
    const policy = merchantPolicySchema.parse({ merchantId: "merchant_test" });
    const opened = drive(detector, event());
    expect(opened.opened).toHaveLength(1);

    await store.saveProfile(profile());
    const { episode } = await processPaymentFailure(event(), store, policy, undefined, undefined, detector);

    expect(episode.status).toBe("HELD_DEGRADED");
    expect(episode.policyDecision?.allowedAction).toBe("HELD_DEGRADED");
    expect(episode.policyDecision?.degradationWindowId).toBe(opened.opened[0].id);
    // A hold is not an outcome: HELD_DEGRADED is the one non-terminal exit.
    expect(episode.outcome).toBeNull();
    expect(episode.execution).toBeNull();
    expect(detector.getAllOpen()[0].episodesHeld).toBeGreaterThan(0);
  });

  it("holds the baseline frozen while a window is open", () => {
    const detector = new DegradationDetector(new RecoveryStore());
    const probe = event();
    drive(detector, probe);
    const frozen = detector.getAllOpen()[0].baselineRate;
    for (let w = 0; w < 4; w++) {
      for (let i = 0; i < 60; i++) detector.record(probe, i < 36);
      detector.tick();
    }
    const open = detector.getAllOpen();
    expect(open).toHaveLength(1);
    expect(open[0].baselineRate).toBe(frozen);
  });

  it("closes only after the hysteresis windows and drains with bounded jitter", () => {
    const detector = new DegradationDetector(new RecoveryStore());
    const probe = event();
    drive(detector, probe);

    for (let w = 0; w < DEGRADATION_CONFIG.CLOSE_WINDOWS - 1; w++) {
      for (let i = 0; i < 60; i++) detector.record(probe, i < 3);
      expect(detector.tick().closed).toHaveLength(0);
    }
    for (let i = 0; i < 60; i++) detector.record(probe, i < 3);
    expect(detector.tick().closed).toHaveLength(1);
    expect(detector.getAllOpen()).toHaveLength(0);

    for (let i = 0; i < 50; i++) {
      const delay = detector.drainDelayMs();
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(DEGRADATION_CONFIG.DRAIN_JITTER_MS);
    }
  });

  it("fires on a step change of exactly TRIGGER_RATIO, and reports the ratio undamped", () => {
    const detector = new DegradationDetector(new RecoveryStore());
    const probe = event();

    // Warm the baseline up on healthy traffic. The 5% feed matches the detector's
    // own prior, so the EWMA settles on exactly 0.05 and the planted step below is
    // a clean multiple of a known level rather than of a drifting one.
    for (let w = 0; w < DEGRADATION_CONFIG.BASELINE_SEED_WINDOWS; w++) {
      for (let i = 0; i < 60; i++) detector.record(probe, i < 3);
      expect(detector.tick().opened).toHaveLength(0);
    }

    const baseline = detector.keyHealth()[0].baselineRate;
    const attempts = 4_000;
    // Smallest integer failure count whose rate clears exactly TRIGGER_RATIO × baseline.
    // (0.05 × 3 is 0.15000000000000002 in binary floating point, so 600/4000 is a hair
    //  short of the threshold — this is the step size, not a fudge factor.)
    let failures = Math.ceil(baseline * DEGRADATION_CONFIG.TRIGGER_RATIO * attempts);
    while (failures / attempts < baseline * DEGRADATION_CONFIG.TRIGGER_RATIO) failures++;
    const plantedRatio = failures / attempts / baseline;
    expect(plantedRatio).toBeGreaterThanOrEqual(DEGRADATION_CONFIG.TRIGGER_RATIO);
    expect(plantedRatio).toBeLessThan(DEGRADATION_CONFIG.TRIGGER_RATIO + 0.01);

    for (let i = 0; i < attempts; i++) detector.record(probe, i < failures);
    const { opened } = detector.tick();

    // Before the ordering fix the baseline absorbed this window before the ratio was
    // tested, so a 3× step measured 3 / (0.1 × 3 + 0.9) = 2.5× and nothing opened:
    // the detector needed a 3.86× event to notice a 3× threshold breach.
    expect(opened).toHaveLength(1);
    expect(opened[0].ratio).toBeCloseTo(plantedRatio, 9);
    expect(opened[0].baselineRate).toBe(baseline);
    expect(opened[0].observedRate).toBeCloseTo(failures / attempts, 12);
  });

  it("does not let the spike window inflate the baseline it is measured against", () => {
    const detector = new DegradationDetector(new RecoveryStore());
    const probe = event();
    for (let w = 0; w < DEGRADATION_CONFIG.BASELINE_SEED_WINDOWS; w++) {
      for (let i = 0; i < 60; i++) detector.record(probe, i < 3);
      detector.tick();
    }
    const before = detector.keyHealth()[0].baselineRate;

    for (let i = 0; i < 60; i++) detector.record(probe, i < 36); // 60% — a 12× event
    const { opened } = detector.tick();

    expect(opened).toHaveLength(1);
    expect(opened[0].baselineRate).toBe(before);
    expect(opened[0].ratio).toBeCloseTo(0.6 / before, 9); // 12×, not the damped 5.7×
  });
});

describe("realtime stream", () => {
  it("numbers frames with the server's own ids so resume addresses something", async () => {
    const server = new RealtimeServer();
    server.stopHeartbeat();
    server.emit({ type: "heartbeat", atMs: 1 });
    server.emit({ type: "heartbeat", atMs: 2 });
    server.emit({ type: "heartbeat", atMs: 3 });

    const reader = createSSEStream(server, "2").getReader();
    const text = new TextDecoder().decode((await reader.read()).value);
    const replayed = new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();

    expect(text).toContain("retry:");
    expect(replayed).toContain("id: 3");
    expect(replayed).not.toContain('"atMs":2');
  });

  it("reports a gap rather than silently skipping events it can no longer replay", async () => {
    const server = new RealtimeServer();
    server.stopHeartbeat();
    for (let i = 0; i < 400; i++) server.emit({ type: "heartbeat", atMs: i });
    expect(server.getEventsSince(1)).toBeNull();

    const reader = createSSEStream(server, "1").getReader();
    await reader.read(); // retry directive
    const frame = new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    expect(frame).toContain("event: gap");
  });

  it("drops its listener when the stream is cancelled", async () => {
    const server = new RealtimeServer();
    server.stopHeartbeat();
    const reader = createSSEStream(server).getReader();
    await reader.read();
    expect(server.subscriberCount).toBe(1);
    await reader.cancel();
    expect(server.subscriberCount).toBe(0);
  });
});

describe("replay honesty rule", () => {
  const policy = merchantPolicySchema.parse({ merchantId: "merchant_test" });

  it("reuses the real outcome when the replayed action matches what happened", () => {
    const ev = event({ paymentId: "pay_match" });
    const first = replayBatch(
      [{ event: ev, profile: profile(), amountPaise: ev.amountPaise, actualOutcome: null }],
      { policy, modelVersion: "transparent-v1" },
    );
    const chosen = first.byEpisode[0].replayAction!;

    const matched = replayBatch(
      [{ event: ev, profile: profile(), amountPaise: ev.amountPaise, actualOutcome: { recovered: true, actualAction: chosen } }],
      { policy, modelVersion: "transparent-v1" },
    );
    expect(matched.byEpisode[0].usedObservedOutcome).toBe(true);
    expect(matched.byEpisode[0].replayOutcome?.recovered).toBe(true);
    expect(matched.byEpisode[0].modelledProbability).toBeNull();
    expect(matched.observedFraction).toBe(1);
  });

  it("models a diverging action against the production scorer, not a free-floating heuristic", () => {
    const ev = event({ paymentId: "pay_diverge" });
    const result = replayBatch(
      [{ event: ev, profile: profile(), amountPaise: ev.amountPaise, actualOutcome: { recovered: true, actualAction: "STOP" } }],
      { policy, modelVersion: "transparent-v1" },
    );
    const row = result.byEpisode[0];
    expect(row.usedObservedOutcome).toBe(false);
    expect(row.modelledProbability).not.toBeNull();
    expect(row.modelledProbability!).toBeGreaterThan(0);
    expect(row.modelledProbability!).toBeLessThan(1);
    expect(result.observedFraction).toBe(0);
    expect(result.modelledCount).toBe(1);
  });

  it("subtracts the intervention cost on the recovered branch too", () => {
    const ev = event({ paymentId: "pay_cost" });
    const row = replayBatch(
      [{ event: ev, profile: profile(), amountPaise: ev.amountPaise, actualOutcome: { recovered: true, actualAction: null } }],
      { policy, modelVersion: "transparent-v1" },
    ).byEpisode[0];
    // `recovered ? amount : 0 - cost` silently never charged the recovered branch.
    if (row.replayOutcome?.recovered) {
      expect(row.netPaise).toBe(ev.amountPaise - row.interventionCostPaise);
    } else {
      expect(row.netPaise).toBe(-row.interventionCostPaise);
    }
  });

  it("is reproducible: the same episodes replay to the same outcomes", () => {
    const inputs = Array.from({ length: 12 }, (_, i) => ({
      event: event({ paymentId: `pay_seed_${i}`, amountPaise: rupees(500 + i * 700) }),
      profile: profile({ customerId: `cust_${i}` }),
      amountPaise: rupees(500 + i * 700),
      actualOutcome: null,
    }));
    const a = replayBatch(inputs, { policy, modelVersion: "transparent-v1" });
    const b = replayBatch(inputs, { policy, modelVersion: "transparent-v1" });
    expect(a.byEpisode.map((e) => e.replayOutcome?.recovered)).toEqual(b.byEpisode.map((e) => e.replayOutcome?.recovered));
  });

  it("accumulates both sides of every delta over the same settled episodes", () => {
    const settled = { event: event({ paymentId: "pay_settled" }), profile: profile(), amountPaise: rupees(4_999), actualOutcome: { recovered: false, actualAction: "WAIT" } };
    const inFlight = { event: event({ paymentId: "pay_inflight" }), profile: profile(), amountPaise: rupees(4_999), actualOutcome: null };
    const result = replayBatch([settled, inFlight], { policy, modelVersion: "transparent-v1" });
    expect(result.episodesReplayed).toBe(2);
    expect(result.comparableEpisodes).toBe(1);
  });
});

describe("close the loop", () => {
  it("records a real outcome on a pending episode", async () => {
    const store = new RecoveryStore();
    const policy = merchantPolicySchema.parse({ merchantId: "merchant_test" });
    await store.saveProfile(profile());
    const { episode } = await processPaymentFailure(event(), store, policy, fixedClock(Date.parse("2026-08-21T10:00:00Z")));
    expect(["PENDING", "PROMISED"]).toContain(episode.status);

    const settled = await observeOutcome(episode.id, "RECOVERED", store);
    expect(settled.status).toBe("RECOVERED");
    expect(settled.outcome?.recoveredAmountPaise).toBe(episode.event.amountPaise);
  });
});
