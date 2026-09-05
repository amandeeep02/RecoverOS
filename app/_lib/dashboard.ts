import type { AuditEvent, CustomerProfile, PaymentEvent, RecoveryEpisode } from "@/lib/domain";
import { merchantPolicySchema, rupees, type MerchantPolicy } from "@/lib/domain";
import { ingestPaymentFailure, observeOutcome, defaultMerchantPolicy } from "@/lib/pipeline";
import { store } from "@/lib/store";
import { fixedClock, systemClock } from "@/lib/clock";
import { getDegradationDetector, DEGRADATION_CONFIG, keyString } from "@/lib/degradation";
import { runEval } from "@/lib/eval/harness";
import { tInterval } from "@/lib/eval/estimators";

// ---------------------------------------------------------------------------
// Types the client components read. Everything here is derived from the live
// store or from the one evaluator. No figure on this page is written by hand.
// ---------------------------------------------------------------------------

export interface EpisodeView {
  id: string;
  status: string;
  createdAt: string;
  event: { customerId: string; paymentMethod: string; paymentId: string; amountPaise: number; failureCode: string | null; issuer: string | null };
  diagnosis: { category: string; confidence: number; explanation: string } | null;
  prediction: { pRecoverNative: number; pRecoverWithAction: number } | null;
  eir: {
    action: string;
    eirPaise: number;
    eirWithoutChurnPaise: number;
    churnCostPaise: number;
    residualLtvPaise: number;
    deltaPChurn: number;
    incrementalLift: number;
    interventionCostPaise: number;
  } | null;
  proposal: { action: string; explanation: string; reasonCodes: string[] } | null;
  policyDecision: { outcome: string; allowedAction: string | null; suppressionReason: string | null; reasons: string[]; arm?: string; degradationWindowId: string | null } | null;
  execution: { status: string; executor: string; externalReference: string | null; error: string | null } | null;
  outcome: { status: string; recoveredAmountPaise: number } | null;
  customerResponses: { responseId: string; channel: string; text: string; receivedAt: string; confidence: number | null }[];
}

export interface BenchmarkView {
  seeds: number[];
  episodesPerSeed: number;
  holdoutPct: number;
  /** Gross recovered on the TREATED episodes — the number every other product would
   *  quote. Struck through on screen, because most of it was already coming. */
  grossRecoveredOnTreatedPaise: number;
  incrementalRecoveredPaise: number;
  ciLoPaise: number;
  ciHiPaise: number;
  ciMethod: string;
  nTreatment: number;
  nHoldout: number;
  recoveryRateTreatment: number;
  recoveryRateHoldout: number;
  arms: { key: string; name: string; recoveredPaise: number; netPaise: number; interventions: number; contactsMade: number; recoveryRate: number }[];
  /** Coverage of the interval against the simulator's planted truth. The only
   *  evidence the instrument is calibrated. */
  coverage: { covered: number; n: number; coverage: number } | null;
  computedInMs: number;
}

export interface LedgerView {
  protectedPaise: number;
  forgonePaise: number;
  suppressedCount: number;
  suppressedEpisodeIds: string[];
}

export interface DegradationView {
  config: { windowMinutes: number; triggerRatio: number; closeRatio: number; closeWindows: number; minAttempts: number; minAbsoluteRate: number; warmupWindows: number; drainJitterMs: number };
  open: { id: string; key: string; ratio: number; baselineRate: number; observedRate: number; attempts: number; episodesHeld: number; openedAtMs: number }[];
  keys: { keyString: string; baselineRate: number; currentWindowAttempts: number; currentWindowFailures: number; currentWindowRate: number | null; seenWindows: number; warmedUp: boolean; open: boolean }[];
  heldEpisodeIds: string[];
}

/**
 * What the agent declined to do, and what declining was worth.
 *
 * Split by WHO refused, because the two are different claims and a merchant needs
 * to tell them apart. An economic refusal is the scorer's judgement and could be
 * wrong. A regulatory refusal is not a judgement at all — it cites a rule, and the
 * only question is whether the rule was read correctly.
 */
export interface RefusalView {
  count: number;
  /** Face value of the payments we were not permitted to chase, this run. */
  deferredPaise: number;
  codes: { regulation: string; code: string; count: number }[];
  episodeIds: string[];
}

export interface DashboardSnapshot {
  episodes: EpisodeView[];
  refusals: RefusalView;
  audits: Record<string, AuditEvent[]>;
  ledger: LedgerView;
  benchmark: BenchmarkView;
  degradation: DegradationView;
  queue: { revenueAtRiskPaise: number; recoveredPaise: number; pendingPaise: number; escalated: number; suppressed: number; held: number };
  policy: MerchantPolicy;
}

// ---------------------------------------------------------------------------
// Demo workspace — seeded ONCE into the live store, through the real pipeline
// ---------------------------------------------------------------------------

export const DEMO_MERCHANT = "merchant_demo";

/**
 * The demo workspace runs the SHIPPED DEFAULTS, unmodified — including
 * `allowRetry: false`, which is the default because a blind retry on a recurring
 * mandate is not a merchant's to make by default.
 *
 * This is not a cosmetic choice. A silent retry costs ₹3 and carries no churn term,
 * so wherever a merchant permits retries the argmax will almost always prefer one to
 * staying quiet, and the dormancy-suppression path becomes close to unreachable.
 * That is the correct economics — if a free-ish silent retry has positive expected
 * value, take it — but it means the Protected Ledger only ever binds for merchants
 * who cannot blind-retry. Overriding the default here would hide that.
 */
export function demoPolicy(): MerchantPolicy {
  return defaultMerchantPolicy(DEMO_MERCHANT);
}

/** Bumped when SEED_CASES changes, so a re-seed produces new episodes instead of
 *  silently colliding with stored decisions made under a previous policy. */
const SEED_VERSION = "v4";

const globalSeed = globalThis as unknown as { recoverOsSeeded?: Promise<void> };

type SeedCase = {
  paymentId: string;
  customerId: string;
  amountRupees: number;
  method: PaymentEvent["paymentMethod"];
  failureCode: string;
  native: PaymentEvent["nativeRecoveryState"];
  issuer: string;
  network: string;
  daysDormant: number;
  phone: string | null;
  resolveAs?: "RECOVERED";
  /**
   * Decide this episode at a fixed wall-clock instead of "now".
   *
   * The regulatory gate reads the clock at the moment of decision, which is correct
   * and which makes a quiet-hours refusal invisible for the twelve hours a day the
   * window is open — including, most likely, whenever this is being demonstrated.
   * `lib/pipeline.ts` already takes the clock as an injected dependency, so pinning
   * it for one seeded episode changes nothing about the path that episode travels:
   * the same normalizer, the same scorer, the same gate, the same audit trail.
   */
  decideAtIso?: string;
};

/**
 * The demo workspace. These are inputs, not outputs: every case below is an
 * ingested `payment.failed` event and a customer profile. What the agent does with
 * each one — the diagnosis, the action, the EIR, the suppression — is produced by
 * the same code path a real webhook takes. Nothing here asserts a result.
 */
const SEED_CASES: SeedCase[] = [
  { paymentId: "pay_8X1", customerId: "cust_aurora", amountRupees: 8_499, method: "card", failureCode: "bank_declined", native: "ACTIVE", issuer: "HDFC", network: "VISA", daysDormant: 12, phone: "+919876543210" },
  { paymentId: "pay_2K9", customerId: "cust_basil", amountRupees: 15_000, method: "card", failureCode: "expired_card", native: "EXHAUSTED", issuer: "HDFC", network: "VISA", daysDormant: 9, phone: "+919876543211", resolveAs: "RECOVERED" },
  { paymentId: "pay_7M4", customerId: "cust_cedar", amountRupees: 2_999, method: "upi", failureCode: "insufficient_funds", native: "EXHAUSTED", issuer: "ICICI", network: "UPI", daysDormant: 18, phone: null },
  { paymentId: "pay_3P6", customerId: "cust_delta", amountRupees: 19_500, method: "upi", failureCode: "unmapped_code", native: "UNKNOWN", issuer: "AXIS", network: "UPI", daysDormant: 21, phone: "+919876543213" },
  { paymentId: "pay_1N8", customerId: "cust_ember", amountRupees: 6_999, method: "card", failureCode: "permanent_decline", native: "EXHAUSTED", issuer: "SBI", network: "RUPAY", daysDormant: 30, phone: null },
  // Dormant subscribers. Whether these suppress is the scorer's call, not ours.
  { paymentId: "pay_5D2", customerId: "cust_frost", amountRupees: 999, method: "upi", failureCode: "insufficient_funds", native: "EXHAUSTED", issuer: "ICICI", network: "UPI", daysDormant: 210, phone: null },
  { paymentId: "pay_9G7", customerId: "cust_gale", amountRupees: 2_499, method: "upi", failureCode: "insufficient_funds", native: "EXHAUSTED", issuer: "KOTAK", network: "UPI", daysDormant: 200, phone: null },
  // Decided at 22:40 IST — inside TRAI's quiet hours. A healthy, contactable customer
  // whose only problem is the hour, so the refusal that follows is the regulator's and
  // nothing else's. Pinned rather than left to chance because otherwise the workspace
  // shows a regulatory refusal only between 21:00 and 09:00.
  { paymentId: "pay_4Q3", customerId: "cust_harrow", amountRupees: 11_250, method: "card", failureCode: "insufficient_funds", native: "EXHAUSTED", issuer: "AXIS", network: "VISA", daysDormant: 6, phone: "+919876543215", decideAtIso: "2026-03-04T17:10:00.000Z" },
];

function seedProfile(c: SeedCase): CustomerProfile {
  const amountPaise = rupees(c.amountRupees);
  return {
    customerId: c.customerId,
    merchantId: DEMO_MERCHANT,
    subscriptionAgeDays: 120 + c.daysDormant,
    customerValuePaise: amountPaise * 12,
    successfulPaymentCount: 11,
    failedPaymentCount: 1,
    previousRecoveryRate: 0.58,
    previousInterventionCount: 0,
    previousInterventionSuccessCount: 0,
    daysSinceLastSuccess: c.daysDormant,
    lastFailureReason: null,
    paymentMethodDistribution: { [c.method]: 1 },
    currentFailureEpisodeId: null,
    consentValid: true,
    optedOut: false,
    contactWindowOpen: true,
    phone: c.phone,
    isSubscription: true,
    daysSinceLastEngagement: c.daysDormant,
    engagementProxy: true,
  };
}

export function seedEvent(c: SeedCase, occurredAt = new Date().toISOString()): PaymentEvent {
  return {
    eventId: `evt_${SEED_VERSION}_${c.paymentId}`,
    eventType: "payment.failed",
    occurredAt,
    merchantId: DEMO_MERCHANT,
    customerId: c.customerId,
    paymentId: `${c.paymentId}_${SEED_VERSION}`,
    subscriptionId: `sub_${SEED_VERSION}_${c.paymentId}`,
    amountPaise: rupees(c.amountRupees),
    currency: "INR",
    paymentMethod: c.method,
    failureCode: c.failureCode,
    failureSource: c.failureCode === "unmapped_code" ? "unknown" : "bank",
    nativeRecoveryState: c.native,
    customerPhone: c.phone,
    railMetadata: { issuer: c.issuer, network: c.network },
  } as PaymentEvent;
}

async function seedOnce(): Promise<void> {
  const policy = demoPolicy();
  for (const c of SEED_CASES) {
    await store.saveProfile(seedProfile(c));
    const clock = c.decideAtIso ? fixedClock(Date.parse(c.decideAtIso)) : systemClock();
    const { episode } = await ingestPaymentFailure(seedEvent(c, c.decideAtIso), store, policy, clock);
    if (c.resolveAs === "RECOVERED" && (episode.status === "PENDING" || episode.status === "PROMISED")) {
      await observeOutcome(episode.id, "RECOVERED", store);
    }
  }
}

export function ensureSeeded(): Promise<void> {
  return globalSeed.recoverOsSeeded ?? (globalSeed.recoverOsSeeded = seedOnce());
}

// ---------------------------------------------------------------------------
// The benchmark — one evaluator, computed once per process
// ---------------------------------------------------------------------------

const BENCH_SEEDS = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
const BENCH_EPISODES = 3_000;
const BENCH_HOLDOUT_PCT = 5;

const globalBench = globalThis as unknown as { recoverOsBenchmark?: BenchmarkView };

const ARM_NAMES: Record<string, string> = {
  baseline: "Baseline — silent retry",
  rules: "Rules — failure-code heuristics",
  recoverOs: "RecoverOS — diagnosis + EIR + policy",
  oracle: "Oracle — reads planted truth (yardstick)",
};

/**
 * The dashboard's projection of `lib/eval/harness.ts` — the same evaluator as
 * `npm run eval`, with the holdout switched ON so the headline can carry an
 * interval instead of a bare point estimate.
 *
 * The interval is an ACROSS-SEED Student-t interval over the per-seed point
 * estimates, which is the construction RESULTS.md documents. It is deliberately
 * NOT the average of 12 per-seed bootstrap endpoints: an average of endpoints is
 * not an interval and has no coverage property.
 */
export function getBenchmark(): BenchmarkView {
  if (globalBench.recoverOsBenchmark) return globalBench.recoverOsBenchmark;
  const startedAt = Date.now();

  const policy = merchantPolicySchema.parse({ merchantId: DEMO_MERCHANT });
  policy.allowRetry = true;
  policy.minimumEirPaise = 0;
  policy.churnAversion = 1.5;
  policy.holdoutPct = BENCH_HOLDOUT_PCT;

  const report = runEval({
    episodes: BENCH_EPISODES,
    seeds: BENCH_SEEDS,
    policy,
    holdoutPct: BENCH_HOLDOUT_PCT,
    bootstrapResamples: 400,
  });

  const withHoldout = report.perSeed.filter((s) => s.holdout);
  const perSeedIncremental = withHoldout.map((s) => s.holdout!.incrementalPaise);
  const interval = tInterval(perSeedIncremental);
  const mean = (values: number[]) => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);

  const view: BenchmarkView = {
    seeds: BENCH_SEEDS,
    episodesPerSeed: BENCH_EPISODES,
    holdoutPct: BENCH_HOLDOUT_PCT,
    grossRecoveredOnTreatedPaise: Math.round(mean(withHoldout.map((s) => s.holdout!.grossRecoveredPaise))),
    incrementalRecoveredPaise: Math.round(interval.mean),
    ciLoPaise: Math.round(interval.ciLo),
    ciHiPaise: Math.round(interval.ciHi),
    ciMethod: interval.method,
    nTreatment: Math.round(mean(withHoldout.map((s) => s.holdout!.nTreatment))),
    nHoldout: Math.round(mean(withHoldout.map((s) => s.holdout!.nHoldout))),
    recoveryRateTreatment: mean(withHoldout.map((s) => s.holdout!.recoveryRateTreatment)),
    recoveryRateHoldout: mean(withHoldout.map((s) => s.holdout!.recoveryRateHoldout)),
    arms: (["baseline", "rules", "recoverOs", "oracle"] as const).map((key) => ({
      key,
      name: ARM_NAMES[key],
      recoveredPaise: Math.round(mean(report.perSeed.map((s) => s.arms[key].recoveredPaise))),
      netPaise: Math.round(mean(report.perSeed.map((s) => s.arms[key].netPaise))),
      interventions: Math.round(mean(report.perSeed.map((s) => s.arms[key].interventions))),
      contactsMade: Math.round(mean(report.perSeed.map((s) => s.arms[key].contactsMade))),
      recoveryRate: mean(report.perSeed.map((s) => s.arms[key].recoveryRate)),
    })),
    coverage: report.coverage
      ? { covered: report.coverage.againstTruth.covered, n: report.coverage.againstTruth.n, coverage: report.coverage.againstTruth.coverage }
      : null,
    computedInMs: Date.now() - startedAt,
  };

  globalBench.recoverOsBenchmark = view;
  return view;
}

// ---------------------------------------------------------------------------
// Projections of live state
// ---------------------------------------------------------------------------

export function toEpisodeView(episode: RecoveryEpisode): EpisodeView {
  return {
    id: episode.id,
    status: episode.status,
    createdAt: episode.createdAt,
    event: {
      customerId: episode.event.customerId,
      paymentMethod: episode.event.paymentMethod,
      paymentId: episode.event.paymentId,
      amountPaise: episode.event.amountPaise,
      failureCode: episode.event.failureCode ?? null,
      issuer: (episode.event.railMetadata?.issuer as string | undefined) ?? null,
    },
    diagnosis: episode.diagnosis
      ? { category: episode.diagnosis.category, confidence: episode.diagnosis.confidence, explanation: episode.diagnosis.explanation }
      : null,
    prediction: episode.prediction
      ? { pRecoverNative: episode.prediction.pRecoverNative, pRecoverWithAction: episode.prediction.pRecoverWithAction }
      : null,
    eir: episode.eir
      ? {
          action: episode.eir.action,
          eirPaise: episode.eir.eirPaise,
          eirWithoutChurnPaise: episode.eir.eirWithoutChurnPaise,
          churnCostPaise: episode.eir.churnCostPaise,
          residualLtvPaise: episode.eir.residualLtvPaise,
          deltaPChurn: episode.eir.deltaPChurn,
          incrementalLift: episode.eir.incrementalLift,
          interventionCostPaise: episode.eir.interventionCostPaise,
        }
      : null,
    proposal: episode.proposal
      ? { action: episode.proposal.action, explanation: episode.proposal.explanation, reasonCodes: [...episode.proposal.reasonCodes] }
      : null,
    policyDecision: episode.policyDecision
      ? {
          outcome: episode.policyDecision.outcome,
          allowedAction: episode.policyDecision.allowedAction,
          suppressionReason: episode.policyDecision.suppressionReason,
          reasons: [...episode.policyDecision.reasons],
          arm: episode.policyDecision.arm,
          degradationWindowId: episode.policyDecision.degradationWindowId,
        }
      : null,
    execution: episode.execution
      ? { status: episode.execution.status, executor: episode.execution.executor, externalReference: episode.execution.externalReference ?? null, error: episode.execution.error ?? null }
      : null,
    outcome: episode.outcome ? { status: episode.outcome.status, recoveredAmountPaise: episode.outcome.recoveredAmountPaise } : null,
    customerResponses: (episode.customerResponses ?? []).map((r) => ({
      responseId: r.responseId,
      channel: r.channel,
      text: r.text,
      receivedAt: r.receivedAt,
      confidence: r.confidence ?? null,
    })),
  };
}

/**
 * The Protected Ledger, measured over the episodes actually on this page.
 * `protectedPaise` is the residual subscription value the scorer said contacting
 * would put at risk; `forgonePaise` is the recovery given up to protect it. Both
 * sides, always — the first number means nothing without the second. Zero
 * suppressions is an honest reading and renders as zero.
 */
export function buildLedger(episodes: RecoveryEpisode[]): LedgerView {
  const suppressed = episodes.filter((e) => e.status === "SUPPRESSED" || e.policyDecision?.suppressionReason != null);
  return {
    protectedPaise: suppressed.reduce((t, e) => t + (e.eir?.churnCostPaise ?? 0), 0),
    forgonePaise: suppressed.reduce((t, e) => t + Math.max(0, e.eir?.eirWithoutChurnPaise ?? 0), 0),
    suppressedCount: suppressed.length,
    suppressedEpisodeIds: suppressed.map((e) => e.id),
  };
}

/**
 * Regulatory refusals only. The economic side already has an owner — `buildLedger`
 * books suppression on both sides — and duplicating it here would give the dashboard
 * two sources of truth for the same number.
 *
 * A regulatory refusal is a REJECT whose reasons carry a `REGULATION:CODE` pair. That
 * shape is produced only by the compliance gate in lib/policy.ts, so matching on it
 * cannot accidentally sweep in a budget or action-space rejection.
 */
export function buildRefusals(episodes: EpisodeView[]): RefusalView {
  const isRegulatory = (r: string) => r.includes(":") && r === r.toUpperCase();
  // Not filtered on outcome. A regulatory refusal reaches the merchant as a REJECT
  // when the compliance gate catches it and as an ESCALATE when the earlier
  // contact-window check does — the customer is not contacted either way, so both
  // belong here. Keying on the `REGULATION:CODE` vocabulary rather than the outcome
  // is what makes that possible.
  const refused = episodes.filter((e) => e.policyDecision?.reasons.some(isRegulatory));
  const tally = new Map<string, number>();
  for (const e of refused) {
    for (const r of e.policyDecision!.reasons.filter(isRegulatory)) tally.set(r, (tally.get(r) ?? 0) + 1);
  }
  return {
    count: refused.length,
    deferredPaise: refused.reduce((t, e) => t + e.event.amountPaise, 0),
    codes: [...tally]
      .map(([pair, count]) => ({ regulation: pair.split(":")[0], code: pair.split(":")[1], count }))
      .sort((a, b) => b.count - a.count),
    episodeIds: refused.map((e) => e.id),
  };
}

export function buildDegradationView(episodes: RecoveryEpisode[]): DegradationView {
  const detector = getDegradationDetector(store);
  return {
    config: {
      windowMinutes: DEGRADATION_CONFIG.WINDOW_MS / 60_000,
      triggerRatio: DEGRADATION_CONFIG.TRIGGER_RATIO,
      closeRatio: DEGRADATION_CONFIG.CLOSE_RATIO,
      closeWindows: DEGRADATION_CONFIG.CLOSE_WINDOWS,
      minAttempts: DEGRADATION_CONFIG.MIN_ATTEMPTS,
      minAbsoluteRate: DEGRADATION_CONFIG.MIN_ABSOLUTE_RATE,
      warmupWindows: DEGRADATION_CONFIG.BASELINE_SEED_WINDOWS,
      drainJitterMs: DEGRADATION_CONFIG.DRAIN_JITTER_MS,
    },
    open: detector.getAllOpen().map((w) => ({
      id: w.id,
      key: keyString(w.key),
      ratio: w.ratio,
      baselineRate: w.baselineRate,
      observedRate: w.observedRate,
      attempts: w.attempts,
      episodesHeld: w.episodesHeld,
      openedAtMs: w.openedAtMs,
    })),
    keys: detector.keyHealth().map((k) => ({
      keyString: k.keyString,
      baselineRate: k.baselineRate,
      currentWindowAttempts: k.currentWindowAttempts,
      currentWindowFailures: k.currentWindowFailures,
      currentWindowRate: k.currentWindowRate,
      seenWindows: k.seenWindows,
      warmedUp: k.warmedUp,
      open: k.open,
    })),
    heldEpisodeIds: episodes.filter((e) => e.status === "HELD_DEGRADED").map((e) => e.id),
  };
}

export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  await ensureSeeded();
  const episodes = await store.listEpisodes();
  const audits: Record<string, AuditEvent[]> = {};
  for (const episode of episodes) audits[episode.id] = await store.getAudit(episode.id);

  return {
    episodes: episodes.map(toEpisodeView),
    refusals: buildRefusals(episodes.map(toEpisodeView)),
    audits,
    ledger: buildLedger(episodes),
    benchmark: getBenchmark(),
    degradation: buildDegradationView(episodes),
    queue: {
      revenueAtRiskPaise: episodes.reduce((t, e) => t + e.event.amountPaise, 0),
      recoveredPaise: episodes.filter((e) => e.status === "RECOVERED").reduce((t, e) => t + e.event.amountPaise, 0),
      pendingPaise: episodes.filter((e) => e.status === "PENDING" || e.status === "PROMISED").reduce((t, e) => t + e.event.amountPaise, 0),
      escalated: episodes.filter((e) => e.status === "ESCALATED").length,
      suppressed: episodes.filter((e) => e.status === "SUPPRESSED").length,
      held: episodes.filter((e) => e.status === "HELD_DEGRADED").length,
    },
    policy: demoPolicy(),
  };
}
