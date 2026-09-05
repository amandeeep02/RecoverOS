import { describe, expect, it } from "vitest";
import { eirScoreSchema, type CustomerProfile, type MerchantPolicy, type PaymentEvent } from "@/lib/domain";
import { bestAction, calculateEir, rupees } from "@/lib/scoring";
import { evaluatePolicy } from "@/lib/policy";
import { diagnose } from "@/lib/diagnosis";
import { processPaymentFailure, observeOutcome, observePaymentLinkPaid } from "@/lib/pipeline";
import { transitionEpisode } from "@/lib/state-machine";
import { RecoveryStore } from "@/lib/store";
import { extractPaymentLinkPaid, normalizeRazorpayEvent, verifyRazorpaySignature } from "@/lib/normalizer";
import { PostgresRecoveryStore } from "@/lib/pg-store";

const event: PaymentEvent = {
  eventId: "evt_test_001", eventType: "payment.failed", occurredAt: "2026-08-21T10:14:03.000Z",
  merchantId: "merchant_test", customerId: "customer_test", paymentId: "payment_test", subscriptionId: "subscription_test",
  amountPaise: rupees(15_000), currency: "INR", paymentMethod: "upi", failureCode: "expired_card", failureSource: "bank", nativeRecoveryState: "EXHAUSTED", customerPhone: null, railMetadata: {},
};
const profile: CustomerProfile = {
  customerId: event.customerId, merchantId: event.merchantId, subscriptionAgeDays: 150, customerValuePaise: rupees(90_000),
  successfulPaymentCount: 8, failedPaymentCount: 1, previousRecoveryRate: 0.65, previousInterventionCount: 0, previousInterventionSuccessCount: 0,
  daysSinceLastSuccess: 30, lastFailureReason: null, paymentMethodDistribution: { upi: 1 }, currentFailureEpisodeId: null,
  consentValid: true, optedOut: false, contactWindowOpen: true,
  phone: null,
  isSubscription: true, daysSinceLastEngagement: 30, engagementProxy: true,
};
const policy: MerchantPolicy = { merchantId: event.merchantId, minimumEirPaise: rupees(150), maxAutomatedAttempts: 3, maxMessagesPerEpisode: 2, maxVoiceCallsPerEpisode: 1, allowRetry: false, allowPaymentLinks: true, allowVoiceCalls: true, requireConsentForReminder: true, highValueEscalationThresholdPaise: rupees(50_000), dltTemplateId: "RECOVEROS_TXN_PAYMENT_FAILED_V1", dltSenderHeader: "RCVROS", preDebitNotificationByPlatform: true, minimumEscalationValuePaise: rupees(2_500), churnAversion: 1, holdoutPct: 5 };

describe("Expected Incremental Recovery", () => {
  it("uses incremental lift and intervention cost, not gross recovery", () => {
    expect(calculateEir("PAYMENT_LINK", rupees(15_000), { pRecoverNative: 0.55, pRecoverWithAction: 0.91 }, profile)).toMatchObject({ incrementalLift: 0.36, interventionCostPaise: rupees(12), eirPaise: rupees(5388) });
  });
});

describe("policy boundary", () => {
  it("rejects unsupported actions, including malicious LLM-shaped output", () => {
    const result = evaluatePolicy({ event, profile, proposal: { action: "SEND_MONEY", confidence: 1 }, eir: calculateEir("PAYMENT_LINK", event.amountPaise, { pRecoverNative: .2, pRecoverWithAction: .8 }, profile), policy, automatedAttemptCount: 0, reminderCount: 0, voiceCallCount: 0, diagnosisConfidence: .9, degradationWindowId: null, episodeId: "test_ep" });
    expect(result.outcome).toBe("REJECT");
    expect(result.allowedAction).toBeNull();
  });

  it("forces WAIT while native card recovery is active", () => {
    const result = evaluatePolicy({ event: { ...event, paymentMethod: "card", nativeRecoveryState: "ACTIVE" }, profile, proposal: { action: "PAYMENT_LINK", confidence: .9 }, eir: calculateEir("PAYMENT_LINK", event.amountPaise, { pRecoverNative: .2, pRecoverWithAction: .8 }, profile), policy, automatedAttemptCount: 0, reminderCount: 0, voiceCallCount: 0, diagnosisConfidence: .9, degradationWindowId: null, episodeId: "test_ep" });
    expect(result).toMatchObject({ outcome: "APPROVE", allowedAction: "WAIT" });
  });

  it("escalates after the automated attempt cap", () => {
    const result = evaluatePolicy({ event, profile, proposal: { action: "PAYMENT_LINK", confidence: .9 }, eir: calculateEir("PAYMENT_LINK", event.amountPaise, { pRecoverNative: .2, pRecoverWithAction: .8 }, profile), policy, automatedAttemptCount: 3, reminderCount: 0, voiceCallCount: 0, diagnosisConfidence: .9, degradationWindowId: null, episodeId: "test_ep" });
    expect(result.outcome).toBe("ESCALATE");
  });
});

describe("end-to-end episode handling", () => {
  it("is idempotent, auditable, and permits outcomes only after PENDING", async () => {
    const recoveryStore = new RecoveryStore();
    await recoveryStore.saveProfile(profile);
    const first = await processPaymentFailure(event, recoveryStore, policy);
    const replay = await processPaymentFailure(event, recoveryStore, policy);
    expect(first.duplicate).toBe(false);
    expect(replay.duplicate).toBe(true);
    expect((await recoveryStore.listEpisodes())).toHaveLength(1);
    // Assert the outcome rather than branching on it: the previous version chose its
    // expected audit trail from the status it was supposed to be checking, so it
    // passed under either behaviour and tested nothing.
    expect(first.episode.status).toBe("PENDING");
    expect((await recoveryStore.getAudit(first.episode.id)).map((entry) => entry.stage))
      .toEqual(["INGESTED", "DIAGNOSED", "SCORED", "PROPOSED", "POLICY", "EXECUTED", "OUTCOME"]);
    const recovered = await observeOutcome(first.episode.id, "RECOVERED", recoveryStore);
    expect(recovered.status).toBe("RECOVERED");
    expect((await recoveryStore.getAudit(first.episode.id)).at(-1)?.stage).toBe("OUTCOME");
  });

  it("does not allow state transitions to bypass the state machine", () => {
    const episode = { id: "test", status: "DETECTED" as const, updatedAt: event.occurredAt } as never;
    const clock = { now: () => Date.now() };
    expect(() => transitionEpisode(episode, "RECOVERED", clock)).toThrow("Invalid recovery episode transition");
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
    expect(normalized).toMatchObject({ eventId: "evt_razor", paymentId: "pay_razor", amountPaise: 849900, paymentMethod: "upi", failureCode: "insufficient_funds" });
  });

  it("rejects a missing signature when signature validation is configured", () => {
    expect(verifyRazorpaySignature("{}", null, "test_secret")).toMatchObject({ valid: false, verification: "missing" });
  });
});

describe("persistence boundary", () => {
  it("Postgres store overrides every in-memory method, so nothing silently stays in RAM", () => {
    // PostgresRecoveryStore extends the in-memory store, which makes overriding
    // optional. A method inherited rather than overridden would write to a Map and
    // be lost on restart while the caller believed it was durable. Enumerate rather
    // than trust: this fails the moment someone adds a method to the base class.
    const base = Object.getOwnPropertyNames(RecoveryStore.prototype).filter((k) => k !== "constructor");
    const durable = new Set(Object.getOwnPropertyNames(PostgresRecoveryStore.prototype));
    const inheritedFromMemory = base.filter((k) => !durable.has(k));
    expect(inheritedFromMemory).toEqual([]);
  });
});

describe("contact fatigue in the churn term", () => {
  // A dormant-but-not-abandoned subscriber: interpolateChurn(90) sits halfway
  // between the 60d (0.01) and 120d (0.04) knots, so dormancy alone is 0.025 and
  // any movement in deltaPChurn is unambiguously the fatigue term.
  const dormant: CustomerProfile = { ...profile, daysSinceLastEngagement: 90, daysSinceLastSuccess: 90 };
  const pred = { pRecoverNative: 0.2, pRecoverWithAction: 0.5 };
  const eirFor = (priorContacts: number, aversion = 1, fatigue = 0.05) =>
    calculateEir("REMINDER", rupees(1_000), pred, { ...dormant, previousInterventionCount: priorContacts }, aversion, fatigue);

  it("is inert at zero prior contacts: an uncontacted customer keeps the pure dormancy hazard", () => {
    // The case that must never regress. If fatigue leaks in at zero, every single
    // customer gets silently suppressed harder and the arm comparison moves for a
    // reason nobody can point at.
    expect(eirFor(0).deltaPChurn).toBeCloseTo(0.025, 10);
    expect(eirFor(0, 1, 0.5).deltaPChurn).toBeCloseTo(0.025, 10);
    expect(eirFor(0).churnCostPaise).toBe(eirFor(0, 1, 0).churnCostPaise);
  });

  it("adds the merchant's per-contact hazard once per prior contact", () => {
    expect(eirFor(1).deltaPChurn).toBeCloseTo(0.075, 10);
    expect(eirFor(3).deltaPChurn).toBeCloseTo(0.175, 10);
    // Linear in the count, so the marginal cost of the next nag is constant.
    expect(eirFor(3).deltaPChurn - eirFor(2).deltaPChurn).toBeCloseTo(0.05, 10);
  });

  it("honours the merchant's own parameter, including switching the term off", () => {
    expect(eirFor(4, 1, 0).deltaPChurn).toBeCloseTo(0.025, 10);
    expect(eirFor(4, 1, 0.01).deltaPChurn).toBeCloseTo(0.065, 10);
  });

  it("never lets the hazard leave [0,1], whatever the contact count", () => {
    const absurd = eirFor(500, 1, 0.5);
    expect(absurd.deltaPChurn).toBeLessThanOrEqual(1);
    expect(absurd.deltaPChurn).toBeGreaterThanOrEqual(0);
    expect(() => eirScoreSchema.parse(absurd)).not.toThrow();
  });

  it("prices fatigue only for contact actions — a silent retry wakes nobody", () => {
    const retry = calculateEir("RETRY", rupees(1_000), pred, { ...dormant, previousInterventionCount: 5 }, 1, 0.05);
    expect(retry.deltaPChurn).toBe(0);
    expect(retry.churnCostPaise).toBe(0);
  });

  it("keeps churnAversion OUT of the face value we are allowed to claim as protected", () => {
    // The trap this repo has fallen into twice: booking the conservatism multiplier
    // as recovered value inflates the ledger by exactly (aversion − 1), and a
    // fatigue term makes the error bigger without announcing itself.
    const decided = eirFor(3, 2);
    const faceValue = eirFor(3, 1);
    expect(decided.deltaPChurn).toBeCloseTo(faceValue.deltaPChurn, 10);
    expect(decided.churnCostPaise).toBe(2 * faceValue.churnCostPaise);
    // What a report may quote is the face value, fatigue included, aversion removed.
    expect(Math.round(decided.residualLtvPaise * decided.deltaPChurn)).toBe(faceValue.churnCostPaise);
  });

  it("demotes contact for a fatigued customer while still contacting an identical fresh one", () => {
    // Targeting, not a blanket ban: the two profiles differ ONLY in contact history.
    const fatiguePolicy: MerchantPolicy = { ...policy, allowRetry: true, minimumEirPaise: 0, contactFatigueChurnPerContact: 0.05 };
    const event90: PaymentEvent = { ...event, amountPaise: rupees(2_000), failureCode: "insufficient_funds" };
    const diagnosis = diagnose(event90);
    const fresh = bestAction(event90, diagnosis, { ...dormant, previousInterventionCount: 0 }, fatiguePolicy);
    const nagged = bestAction(event90, diagnosis, { ...dormant, previousInterventionCount: 3 }, fatiguePolicy);
    expect(["REMINDER", "PAYMENT_LINK", "VOICE_CALL"]).toContain(fresh.proposal.action);
    expect(["REMINDER", "PAYMENT_LINK", "VOICE_CALL"]).not.toContain(nagged.proposal.action);
    // And the restraint is booked at FACE VALUE. Re-run at aversion 2: the decision
    // must move (it uses the multiplied hazard) while the number we may claim to
    // have protected must not, or the ledger silently gains (aversion − 1) of our
    // own conservatism as if it were recovered value.
    const protective = bestAction(event90, diagnosis, { ...dormant, previousInterventionCount: 3 }, { ...fatiguePolicy, churnAversion: 2 });
    expect(nagged.protectedPaise).toBeGreaterThan(0);
    expect(protective.protectedPaise).toBe(nagged.protectedPaise);
    const displaced = protective.candidates.find((c) => c.action === "REMINDER" && c.churnCostPaise !== undefined);
    if (displaced) expect(displaced.churnCostPaise).toBe(2 * displaced.churnCostUnscaledPaise!);
  });
});

describe("payment_link.paid closes the loop", () => {
  const paidWebhook = (episodeId: string, linkId: string) => ({
    event: "payment_link.paid",
    payload: {
      payment_link: { entity: { id: linkId, reference_id: episodeId.slice(0, 40), status: "paid", amount: event.amountPaise, amount_paid: event.amountPaise, notes: { recoveros_episode_id: episodeId } } },
      payment: { entity: { id: "pay_settle_001", amount: event.amountPaise, status: "captured" } },
    },
  });

  it("extracts the episode and link Razorpay hands back, and nothing from other events", () => {
    expect(extractPaymentLinkPaid({ event: "payment.failed" })).toBeNull();
    expect(extractPaymentLinkPaid(paidWebhook("ep_x", "plink_1"), { eventId: "evt_1" }))
      .toMatchObject({ eventId: "evt_1", episodeId: "ep_x", paymentLinkId: "plink_1", paymentId: "pay_settle_001", amountPaise: event.amountPaise });
  });

  it("recovers only the episode that issued the link, once, and 200-ignores everything else", async () => {
    const recoveryStore = new RecoveryStore();
    await recoveryStore.saveProfile(profile);
    const { episode } = await processPaymentFailure(event, recoveryStore, policy);
    expect(episode.status).toBe("PENDING");
    const linkId = episode.execution?.externalReference;
    expect(linkId).toBeTruthy();

    // A signed webhook naming our episode but a link we never issued is not evidence.
    const forged = await observePaymentLinkPaid(extractPaymentLinkPaid(paidWebhook(episode.id, "plink_not_ours"))!, recoveryStore);
    expect(forged).toMatchObject({ outcome: "IGNORED", reason: "link_mismatch" });
    expect((await recoveryStore.getEpisode(episode.id))?.status).toBe("PENDING");

    const settled = await observePaymentLinkPaid(extractPaymentLinkPaid(paidWebhook(episode.id, linkId!))!, recoveryStore);
    expect(settled.outcome).toBe("RECOVERED");
    expect(settled.episode?.status).toBe("RECOVERED");
    expect(settled.episode?.outcome?.recoveredAmountPaise).toBe(event.amountPaise);
    expect((await recoveryStore.getAudit(episode.id)).at(-1)?.stage).toBe("OUTCOME");

    // Razorpay redelivers; the second delivery is a duplicate, not a second transition.
    const redelivered = await observePaymentLinkPaid(extractPaymentLinkPaid(paidWebhook(episode.id, linkId!))!, recoveryStore);
    expect(redelivered.outcome).toBe("DUPLICATE");

    const unknown = await observePaymentLinkPaid(extractPaymentLinkPaid(paidWebhook("ep_missing", "plink_1"))!, recoveryStore);
    expect(unknown).toMatchObject({ outcome: "IGNORED", reason: "no_episode" });
  });
});
