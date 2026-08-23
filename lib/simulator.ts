import type { ActionProposal, CustomerProfile, MerchantPolicy, PaymentEvent } from "@/lib/domain";
import { diagnose } from "@/lib/diagnosis";
import { evaluatePolicy } from "@/lib/policy";
import { calculateEir, proposalFor, scoreRecovery } from "@/lib/scoring";

export type SyntheticCase = {
  id: string;
  customerId: string;
  merchantId: string;
  amountInr: number;
  paymentMethod: PaymentEvent["paymentMethod"];
  failureCode: string;
  failureSource: PaymentEvent["failureSource"];
  nativeRecoveryState: PaymentEvent["nativeRecoveryState"];
  profile: CustomerProfile;
};

type HiddenTruth = {
  nativeProbability: number;
  actionProbability: Record<ActionProposal["action"], number>;
  sharedUniform: number;
};

export type StrategyDecision = {
  caseId: string;
  action: ActionProposal["action"];
  expectedEirInr: number;
  prediction: number;
  policyOutcome: "APPROVE" | "REJECT" | "ESCALATE";
};

export type StrategyMetrics = {
  name: "Baseline" | "Rules" | "RecoverOS";
  revenueAtRiskInr: number;
  recoveredRevenueInr: number;
  nativeRecoveredRevenueInr: number;
  incrementalRecoveredInr: number;
  recoveryRate: number;
  interventions: number;
  wastedInterventions: number;
  averageEirInr: number;
  policyRejectionRate: number;
  escalationRate: number;
  calibration: CalibrationPoint[];
};

export type CalibrationPoint = { bucket: string; predicted: number; observed: number; count: number };
export type SeedBenchmark = { seed: number; baseline: StrategyMetrics; rules: StrategyMetrics; recoverOs: StrategyMetrics };

export type BenchmarkReport = {
  eventCountPerSeed: number;
  seeds: number[];
  bySeed: SeedBenchmark[];
  summary: Record<"baseline" | "rules" | "recoverOs", Record<"recoveredRevenueInr" | "incrementalRecoveredInr" | "interventions" | "wastedInterventions" | "recoveryRate", { mean: number; standardDeviation: number }>>;
};

type SyntheticWorld = { cases: SyntheticCase[]; hidden: Map<string, HiddenTruth> };

const failureCodes = ["insufficient_funds", "bank_declined", "expired_card", "authentication_failed", "mandate_rejected", "permanent_decline", "network_error", "unmapped_code"] as const;

/** Returns observable cases only. Ground truth remains in the world closure. */
export function generateSyntheticWorld(seed: number, count = 50_000): SyntheticWorld {
  const random = mulberry32(seed);
  const cases: SyntheticCase[] = [];
  const hidden = new Map<string, HiddenTruth>();
  for (let index = 0; index < count; index += 1) {
    const paymentMethod = weighted(random, ["card", "upi", "netbanking", "wallet"] as const, [0.48, 0.34, 0.12, 0.06]);
    const failureCode = weighted(random, failureCodes, [0.28, 0.2, 0.1, 0.09, 0.08, 0.08, 0.1, 0.07]);
    const amountInr = Math.round(499 + Math.exp(random() * 5.3) * 26);
    const successes = Math.floor(random() * 18);
    const failures = Math.floor(random() * 6);
    const subscriptionAgeDays = 20 + Math.floor(random() * 1_300);
    const previousRecoveryRate = clamp(0.1 + random() * 0.72 + successes * 0.008 - failures * 0.025, 0.02, 0.95);
    const daysSinceLastSuccess = 1 + Math.floor(random() * 180);
    const nativeRecoveryState = paymentMethod === "card" && random() < 0.46 ? "ACTIVE" : random() < 0.7 ? "EXHAUSTED" : "UNKNOWN";
    const id = `tx_${seed}_${index}`;
    const customerId = `cust_${seed}_${index}`;
    const profile: CustomerProfile = {
      customerId,
      merchantId: "merchant_simulated",
      subscriptionAgeDays,
      customerValueInr: amountInr * (3 + Math.floor(random() * 24)),
      successfulPaymentCount: successes,
      failedPaymentCount: failures,
      previousRecoveryRate,
      previousInterventionCount: Math.floor(random() * 3),
      previousInterventionSuccessCount: Math.floor(random() * 2),
      daysSinceLastSuccess,
      lastFailureReason: null,
      paymentMethodDistribution: { [paymentMethod]: 1 },
      currentFailureEpisodeId: null,
      consentValid: random() > 0.08,
      optedOut: random() < 0.04,
      contactWindowOpen: random() > 0.15,
      phone: random() > 0.3 ? `+91${Math.floor(7000000000 + random() * 2999999999)}` : null,
    };
    const failureSource = sourceFor(failureCode);
    const visible: SyntheticCase = { id, customerId, merchantId: "merchant_simulated", amountInr, paymentMethod, failureCode, failureSource, nativeRecoveryState, profile };
    cases.push(visible);
    const nativeLogit =
      -0.85 + successes * 0.11 - failures * 0.22 + previousRecoveryRate * 0.75 - daysSinceLastSuccess / 360
      + (paymentMethod === "card" ? 0.22 : paymentMethod === "upi" ? -0.04 : 0)
      + hiddenFailureNativeEffect(failureCode)
      + (nativeRecoveryState === "ACTIVE" ? 0.17 : 0);
    const nativeProbability = sigmoid(nativeLogit);
    const actionProbability = {} as Record<ActionProposal["action"], number>;
    for (const action of ["WAIT", "PAYMENT_LINK", "REMINDER", "ESCALATE", "STOP", "RETRY"] as const) {
      const effect = hiddenInterventionEffect(action, failureCode, nativeRecoveryState, profile);
      actionProbability[action] = clamp(nativeProbability + effect, 0.005, 0.995);
    }
    hidden.set(id, { nativeProbability, actionProbability, sharedUniform: random() });
  }
  return { cases, hidden };
}

export function eventFromSyntheticCase(item: SyntheticCase): PaymentEvent {
  return {
    eventId: `evt_${item.id}`,
    eventType: "payment.failed",
    occurredAt: "2026-08-21T10:14:03.000Z",
    merchantId: item.merchantId,
    customerId: item.customerId,
    paymentId: item.id,
    subscriptionId: `sub_${item.id}`,
    amountInr: item.amountInr,
    currency: "INR",
    paymentMethod: item.paymentMethod,
    failureCode: item.failureCode,
    failureSource: item.failureSource,
    nativeRecoveryState: item.nativeRecoveryState,
    railMetadata: {},
  };
}

export function baselineStrategy(item: SyntheticCase): StrategyDecision {
  const eligible = !["permanent_decline", "mandate_rejected"].includes(item.failureCode);
  return { caseId: item.id, action: eligible ? "RETRY" : "WAIT", expectedEirInr: 0, prediction: 0, policyOutcome: "APPROVE" };
}

export function rulesStrategy(item: SyntheticCase): StrategyDecision {
  // A credible rules baseline still respects obvious rail and contact constraints.
  // It deliberately has no probability ranking, EIR, or contextual diagnosis.
  const action = item.paymentMethod === "card" && item.nativeRecoveryState === "ACTIVE"
    ? "WAIT"
    : item.failureCode === "insufficient_funds" && item.profile.consentValid && !item.profile.optedOut && item.profile.contactWindowOpen
      ? "REMINDER"
      : item.failureCode === "expired_card" || item.failureCode === "authentication_failed"
        ? "PAYMENT_LINK"
        : item.failureCode === "bank_declined"
          ? "RETRY"
          : "WAIT";
  return { caseId: item.id, action, expectedEirInr: 0, prediction: 0, policyOutcome: "APPROVE" };
}

const simulationPolicy: MerchantPolicy = {
  merchantId: "merchant_simulated",
  // This simulated merchant accepts any positive expected incremental value;
  // the production/default merchant threshold remains configurable at ₹150.
  minimumEirInr: 0,
  maxAutomatedAttempts: 3,
  maxMessagesPerEpisode: 2,
  maxVoiceCallsPerEpisode: 1,
  allowRetry: true,
  allowPaymentLinks: true,
  allowVoiceCalls: true,
  requireConsentForReminder: true,
  highValueEscalationThresholdInr: 50_000,
};

export function recoverOsStrategy(item: SyntheticCase): StrategyDecision {
  const event = eventFromSyntheticCase(item);
  const diagnosis = diagnose(event);
  const proposal = proposalFor(event, diagnosis, item.profile, simulationPolicy);
  const prediction = scoreRecovery(event, item.profile, diagnosis, proposal.action);
  const eir = calculateEir(proposal.action, item.amountInr, prediction);
  const policy = evaluatePolicy({
    event,
    profile: item.profile,
    proposal,
    eir,
    policy: simulationPolicy,
    automatedAttemptCount: 0,
    reminderCount: 0,
    voiceCallCount: 0,
    diagnosisConfidence: diagnosis.confidence,
  });
  const action = policy.outcome === "APPROVE" && policy.allowedAction ? policy.allowedAction : "ESCALATE";
  return { caseId: item.id, action, expectedEirInr: eir.eirInr, prediction: prediction.pRecoverWithAction, policyOutcome: policy.outcome };
}

/** Evaluation has privileged hidden access; strategies receive only SyntheticCase fields. */
export function evaluateStrategy(
  world: SyntheticWorld,
  name: StrategyMetrics["name"],
  decide: (item: SyntheticCase) => StrategyDecision,
): StrategyMetrics {
  let revenueAtRiskInr = 0;
  let recoveredRevenueInr = 0;
  let nativeRecoveredRevenueInr = 0;
  let interventions = 0;
  let wastedInterventions = 0;
  let totalEir = 0;
  let policyRejections = 0;
  let escalations = 0;
  const calibrationSamples: { prediction: number; observed: boolean }[] = [];
  for (const item of world.cases) {
    const decision = decide(item);
    const truth = world.hidden.get(item.id)!;
    const intervention = ["PAYMENT_LINK", "REMINDER", "RETRY"].includes(decision.action);
    const recovered = truth.sharedUniform <= truth.actionProbability[decision.action];
    const nativeRecovered = truth.sharedUniform <= truth.nativeProbability;
    revenueAtRiskInr += item.amountInr;
    if (recovered) recoveredRevenueInr += item.amountInr;
    if (nativeRecovered) nativeRecoveredRevenueInr += item.amountInr;
    if (intervention) {
      interventions += 1;
      totalEir += decision.expectedEirInr;
      if (!recovered) wastedInterventions += 1;
      if (decision.prediction > 0) calibrationSamples.push({ prediction: decision.prediction, observed: recovered });
    }
    if (decision.policyOutcome === "REJECT") policyRejections += 1;
    if (decision.action === "ESCALATE" || decision.policyOutcome === "ESCALATE") escalations += 1;
  }
  return {
    name,
    revenueAtRiskInr,
    recoveredRevenueInr,
    nativeRecoveredRevenueInr,
    incrementalRecoveredInr: recoveredRevenueInr - nativeRecoveredRevenueInr,
    recoveryRate: recoveredRevenueInr / revenueAtRiskInr,
    interventions,
    wastedInterventions,
    averageEirInr: interventions ? Math.round(totalEir / interventions) : 0,
    policyRejectionRate: policyRejections / world.cases.length,
    escalationRate: escalations / world.cases.length,
    calibration: calibration(calibrationSamples),
  };
}

export function runSeedBenchmark(seed: number, count = 50_000): SeedBenchmark {
  const world = generateSyntheticWorld(seed, count);
  return {
    seed,
    baseline: evaluateStrategy(world, "Baseline", baselineStrategy),
    rules: evaluateStrategy(world, "Rules", rulesStrategy),
    recoverOs: evaluateStrategy(world, "RecoverOS", recoverOsStrategy),
  };
}

export function runBenchmark(seeds = Array.from({ length: 20 }, (_, index) => index + 1), count = 50_000): BenchmarkReport {
  const bySeed = seeds.map((seed) => runSeedBenchmark(seed, count));
  const fields = ["recoveredRevenueInr", "incrementalRecoveredInr", "interventions", "wastedInterventions", "recoveryRate"] as const;
  const summary = {} as BenchmarkReport["summary"];
  for (const key of ["baseline", "rules", "recoverOs"] as const) {
    summary[key] = {} as BenchmarkReport["summary"][typeof key];
    for (const field of fields) {
      const values = bySeed.map((row) => row[key][field]);
      summary[key][field] = { mean: mean(values), standardDeviation: standardDeviation(values) };
    }
  }
  return { eventCountPerSeed: count, seeds, bySeed, summary };
}

function calibration(samples: { prediction: number; observed: boolean }[]): CalibrationPoint[] {
  const buckets = Array.from({ length: 5 }, (_, index) => ({ lower: index * 0.2, upper: (index + 1) * 0.2, values: [] as typeof samples }));
  for (const sample of samples) buckets[Math.min(4, Math.floor(sample.prediction * 5))].values.push(sample);
  return buckets.filter((bucket) => bucket.values.length > 0).map((bucket) => ({
    bucket: `${bucket.lower.toFixed(1)}–${bucket.upper.toFixed(1)}`,
    predicted: mean(bucket.values.map((value) => value.prediction)),
    observed: mean(bucket.values.map((value) => Number(value.observed))),
    count: bucket.values.length,
  }));
}

function sourceFor(code: string): PaymentEvent["failureSource"] {
  if (code === "mandate_rejected") return "mandate";
  if (code === "network_error") return "network";
  if (code === "authentication_failed") return "customer";
  if (["insufficient_funds", "bank_declined", "expired_card", "permanent_decline"].includes(code)) return "bank";
  return "unknown";
}

function hiddenFailureNativeEffect(code: string) {
  return ({ insufficient_funds: -0.42, bank_declined: 0.28, expired_card: -1.25, authentication_failed: -0.92, mandate_rejected: -1.35, permanent_decline: -2.4, network_error: 0.36, unmapped_code: -0.3 } as Record<string, number>)[code] ?? -0.3;
}

function hiddenInterventionEffect(action: ActionProposal["action"], code: string, nativeState: PaymentEvent["nativeRecoveryState"], profile: CustomerProfile) {
  if (["WAIT", "STOP", "ESCALATE"].includes(action)) return 0;
  if (nativeState === "ACTIVE" && profile.paymentMethodDistribution.card) return 0;
  const highValue = profile.customerValueInr > 20_000;
  const table: Record<string, number> = {
    insufficient_funds: action === "REMINDER" ? 0.28 : action === "PAYMENT_LINK" ? 0.16 : action === "VOICE_CALL" ? (highValue ? 0.35 : 0.22) : 0.06,
    bank_declined: action === "RETRY" ? 0.09 : action === "PAYMENT_LINK" ? 0.08 : action === "VOICE_CALL" ? (highValue ? 0.25 : 0.15) : 0.03,
    expired_card: action === "PAYMENT_LINK" ? 0.42 : action === "REMINDER" ? 0.17 : action === "VOICE_CALL" ? (highValue ? 0.45 : 0.3) : 0.01,
    authentication_failed: action === "PAYMENT_LINK" ? 0.37 : action === "REMINDER" ? 0.14 : action === "VOICE_CALL" ? (highValue ? 0.4 : 0.28) : 0.02,
    mandate_rejected: action === "PAYMENT_LINK" ? 0.19 : action === "VOICE_CALL" ? 0.15 : 0.01,
    permanent_decline: 0.005,
    network_error: 0.005,
    unmapped_code: action === "VOICE_CALL" ? (highValue ? 0.18 : 0.1) : 0.025,
  };
  return table[code] ?? 0;
}

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function weighted<T>(random: () => number, values: readonly T[], weights: number[]): T {
  let target = random();
  for (let index = 0; index < values.length; index += 1) {
    target -= weights[index];
    if (target <= 0) return values[index];
  }
  return values[values.length - 1];
}

function sigmoid(value: number) { return 1 / (1 + Math.exp(-value)); }
function clamp(value: number, lower: number, upper: number) { return Math.min(upper, Math.max(lower, value)); }
function mean(values: number[]) { return values.reduce((total, value) => total + value, 0) / values.length; }
function standardDeviation(values: number[]) {
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}
