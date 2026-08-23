import { describe, expect, it } from "vitest";
import type { CustomerProfile, MerchantPolicy, PaymentEvent } from "@/lib/domain";
import { calculateEir } from "@/lib/scoring";
import { evaluatePolicy } from "@/lib/policy";
import { processPaymentFailure, observeOutcome } from "@/lib/pipeline";
import { transitionEpisode } from "@/lib/state-machine";
import { RecoveryStore } from "@/lib/store";
import { runBenchmark, runSeedBenchmark } from "@/lib/simulator";
import { normalizeRazorpayEvent, verifyRazorpaySignature } from "@/lib/normalizer";

const event: PaymentEvent = {
  eventId: "evt_test_001", eventType: "payment.failed", occurredAt: "2026-08-21T10:14:03.000Z",
  merchantId: "merchant_test", customerId: "customer_test", paymentId: "payment_test", subscriptionId: "subscription_test",
  amountInr: 15_000, currency: "INR", paymentMethod: "upi", failureCode: "expired_card", failureSource: "bank", nativeRecoveryState: "EXHAUSTED", railMetadata: {},
};
const profile: CustomerProfile = {
  customerId: event.customerId, merchantId: event.merchantId, subscriptionAgeDays: 150, customerValueInr: 90_000,
  successfulPaymentCount: 8, failedPaymentCount: 1, previousRecoveryRate: 0.65, previousInterventionCount: 0, previousInterventionSuccessCount: 0,
  daysSinceLastSuccess: 30, lastFailureReason: null, paymentMethodDistribution: { upi: 1 }, currentFailureEpisodeId: null,
  consentValid: true, optedOut: false, contactWindowOpen: true,
};
const policy: MerchantPolicy = { merchantId: event.merchantId, minimumEirInr: 150, maxAutomatedAttempts: 3, maxMessagesPerEpisode: 2, allowRetry: false, allowPaymentLinks: true, requireConsentForReminder: true, highValueEscalationThresholdInr: 50_000 };

describe("Expected Incremental Recovery", () => {
  it("uses incremental lift and intervention cost, not gross recovery", () => {
    expect(calculateEir("PAYMENT_LINK", 15_000, { pRecoverNative: 0.55, pRecoverWithAction: 0.91 })).toMatchObject({ incrementalLift: 0.36, interventionCostInr: 12, eirInr: 5388 });
  });
});

describe("policy boundary", () => {
  it("rejects unsupported actions, including malicious LLM-shaped output", () => {
    const result = evaluatePolicy({ event, profile, proposal: { action: "SEND_MONEY", confidence: 1 }, eir: calculateEir("PAYMENT_LINK", event.amountInr, { pRecoverNative: .2, pRecoverWithAction: .8 }), policy, automatedAttemptCount: 0, reminderCount: 0, diagnosisConfidence: .9 });
    expect(result.outcome).toBe("REJECT");
    expect(result.allowedAction).toBeNull();
  });

  it("forces WAIT while native card recovery is active", () => {
    const result = evaluatePolicy({ event: { ...event, paymentMethod: "card", nativeRecoveryState: "ACTIVE" }, profile, proposal: { action: "PAYMENT_LINK", confidence: .9 }, eir: calculateEir("PAYMENT_LINK", event.amountInr, { pRecoverNative: .2, pRecoverWithAction: .8 }), policy, automatedAttemptCount: 0, reminderCount: 0, diagnosisConfidence: .9 });
    expect(result).toMatchObject({ outcome: "APPROVE", allowedAction: "WAIT" });
  });

  it("escalates after the automated attempt cap", () => {
    const result = evaluatePolicy({ event, profile, proposal: { action: "PAYMENT_LINK", confidence: .9 }, eir: calculateEir("PAYMENT_LINK", event.amountInr, { pRecoverNative: .2, pRecoverWithAction: .8 }), policy, automatedAttemptCount: 3, reminderCount: 0, diagnosisConfidence: .9 });
    expect(result.outcome).toBe("ESCALATE");
  });
});

describe("end-to-end episode handling", () => {
  it("is idempotent, auditable, and permits outcomes only after PENDING", async () => {
    const recoveryStore = new RecoveryStore();
    recoveryStore.saveProfile(profile);
    const first = await processPaymentFailure(event, recoveryStore, policy);
    const replay = await processPaymentFailure(event, recoveryStore, policy);
    expect(first.duplicate).toBe(false);
    expect(replay.duplicate).toBe(true);
    expect(recoveryStore.listEpisodes()).toHaveLength(1);
    expect(recoveryStore.getAudit(first.episode.id).map((entry) => entry.stage)).toEqual(["INGESTED", "DIAGNOSED", "SCORED", "PROPOSED", "POLICY", "EXECUTED", "OUTCOME"]);
    const recovered = observeOutcome(first.episode.id, "RECOVERED", recoveryStore);
    expect(recovered.status).toBe("RECOVERED");
    expect(recoveryStore.getAudit(first.episode.id).at(-1)?.stage).toBe("OUTCOME");
  });

  it("does not allow state transitions to bypass the state machine", () => {
    const episode = { id: "test", status: "DETECTED" as const, updatedAt: event.occurredAt } as never;
    expect(() => transitionEpisode(episode, "RECOVERED")).toThrow("Invalid recovery episode transition");
  });

  it("escalates an unknown failure without calling the executor", async () => {
    const recoveryStore = new RecoveryStore();
    const result = await processPaymentFailure({ ...event, eventId: "evt_unknown", paymentId: "payment_unknown", failureCode: "unmapped_code", failureSource: "unknown" }, recoveryStore, policy);
    expect(result.episode.status).toBe("ESCALATED");
    expect(result.episode.execution).toBeNull();
  });
});

describe("Razorpay event boundary", () => {
  it("normalizes an event into the rail-neutral contract", () => {
    const normalized = normalizeRazorpayEvent({
      event: "payment.failed", event_id: "evt_razor", created_at: 1_787_080_443,
      payload: { payment: { entity: { id: "pay_razor", customer_id: "cust_razor", subscription_id: "sub_razor", amount: 849900, method: "upi", error_code: "insufficient_funds", error_source: "bank" } } },
    });
    expect(normalized).toMatchObject({ eventId: "evt_razor", paymentId: "pay_razor", amountInr: 8499, paymentMethod: "upi", failureCode: "insufficient_funds" });
  });

  it("rejects a missing signature when signature validation is configured", () => {
    expect(verifyRazorpaySignature("{}", null, "test_secret")).toMatchObject({ valid: false, verification: "missing" });
  });
});

describe("simulator evaluation", () => {
  it("is reproducible for the same seed and never needs model output to generate outcomes", () => {
    expect(runSeedBenchmark(7, 300)).toEqual(runSeedBenchmark(7, 300));
  });

  it("creates more incremental revenue than baseline across fixed worlds", () => {
    const report = runBenchmark([1, 2, 3, 4, 5], 1_000);
    expect(report.summary.recoverOs.incrementalRecoveredInr.mean).toBeGreaterThan(report.summary.baseline.incrementalRecoveredInr.mean);
  });
});
