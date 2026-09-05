import type { AuditEvent, CustomerProfile, PaymentEvent, RecoveryEpisode } from "@/lib/domain";
import { formatInr, rupees } from "@/lib/domain";
import { observeOutcome, processPaymentFailure } from "@/lib/pipeline";
import { defaultMerchantPolicy } from "@/lib/pipeline";
import { runEval } from "@/lib/eval/harness";
import { RecoveryStore, store as liveStore } from "@/lib/store";

type Stat = { mean: number; standardDeviation: number };

/**
 * The dashboard's view of the ONE evaluator (`lib/eval/harness.ts`, the same code
 * path as `npm run eval`). Every field below is a projection of that report — no
 * second simulator, no second set of headline numbers. `incrementalRecoveredPaise`
 * is defined against the Baseline arm in the identical world, which is exactly the
 * question the panel asks.
 */
export type DemoBenchmark = {
  seeds: number[];
  eventCountPerSeed: number;
  summary: Record<"baseline" | "rules" | "recoverOs", {
    recoveredRevenuePaise: Stat;
    incrementalRecoveredPaise: Stat;
    interventions: Stat;
    recoveryRate: Stat;
    interventionCostPaise: Stat;
    churnCostPaise: Stat;
    protectedPaise: Stat;
    netPaise: Stat;
  }>;
};

export type DemoSnapshot = {
  episodes: RecoveryEpisode[];
  audits: Record<string, AuditEvent[]>;
  benchmark: DemoBenchmark;
  queueSummary: { revenueAtRiskPaise: number; recoveredPaise: number; pendingPaise: number; escalated: number };
  /** Measured over the demo episodes below, not asserted. All three fields are 0
   *  when no episode was suppressed — an empty ledger is the honest reading. */
  ledger: { protectedPaise: number; forgonePaise: number; suppressedCount: number };
};

export async function buildDemoSnapshot(): Promise<DemoSnapshot> {
  const recoveryStore = new RecoveryStore();
  const cases = [
    makeCase("pay_8X1", "cust_aurora", rupees(8_499), "card", "bank_declined", "ACTIVE"),
    makeCase("pay_2K9", "cust_basil", rupees(15_000), "card", "expired_card", "EXHAUSTED"),
    makeCase("pay_7M4", "cust_cedar", rupees(2_999), "upi", "insufficient_funds", "EXHAUSTED"),
    makeCase("pay_3P6", "cust_delta", rupees(19_500), "upi", "unmapped_code", "UNKNOWN"),
    makeCase("pay_1N8", "cust_ember", rupees(6_999), "card", "permanent_decline", "EXHAUSTED"),
  ];
  for (const sample of cases) await recoveryStore.saveProfile(profileFor(sample.event, sample.index));
  const processed = await Promise.all(cases.map(({ event }) => processPaymentFailure(event, recoveryStore)));
  const linkEpisode = processed.find(({ episode }) => episode.event.paymentId === "pay_2K9")?.episode;
  if (linkEpisode?.status === "PENDING") await observeOutcome(linkEpisode.id, "RECOVERED", recoveryStore);
  const [demoEpisodes, liveEpisodes] = await Promise.all([recoveryStore.listEpisodes(), liveStore.listEpisodes()]);
  const episodes = [...demoEpisodes, ...liveEpisodes]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const benchmark = buildBenchmark([11, 12, 13, 14, 15], 1_000);
  const ledger = buildLedger(episodes);
  const audits: DemoSnapshot["audits"] = {};
  for (const episode of episodes) {
    const liveAudit = await liveStore.getAudit(episode.id);
    audits[episode.id] = liveAudit.length > 0 ? liveAudit : await recoveryStore.getAudit(episode.id);
  }
  return {
    episodes,
    audits,
    benchmark,
    queueSummary: {
      revenueAtRiskPaise: episodes.reduce((total, episode) => total + episode.event.amountPaise, 0),
      recoveredPaise: episodes.filter((episode) => episode.status === "RECOVERED").reduce((total, episode) => total + episode.event.amountPaise, 0),
      pendingPaise: episodes.filter((episode) => episode.status === "PENDING").reduce((total, episode) => total + episode.event.amountPaise, 0),
      escalated: episodes.filter((episode) => episode.status === "ESCALATED").length,
    },
    ledger,
  };
}

/**
 * Runs the single evaluator and projects it into the shape the dashboard reads.
 *
 * The policy overrides below are the ones `scripts/eval.ts` selects and justifies;
 * they are duplicated here on purpose so the panel and `RESULTS.md` are answering
 * the same question with the same knobs. Holdout is off only because the panel
 * renders no confidence interval and the bootstrap would cost seconds per request
 * — it does not change which arm wins, only the size of RecoverOS's measured lift.
 */
function buildBenchmark(seeds: number[], episodes: number): DemoBenchmark {
  const policy = defaultMerchantPolicy("merchant_demo");
  policy.allowRetry = true;
  policy.minimumEirPaise = 0;
  policy.churnAversion = 1.5;
  const report = runEval({ episodes, seeds, policy, holdoutPct: 0 });
  const arms = ["baseline", "rules", "recoverOs"] as const;
  const summary = {} as DemoBenchmark["summary"];
  for (const arm of arms) {
    const rows = report.perSeed.map((seed) => seed.arms[arm]);
    const baselineRows = report.perSeed.map((seed) => seed.arms.baseline);
    summary[arm] = {
      recoveredRevenuePaise: stat(rows.map((row) => row.recoveredPaise)),
      // Incremental against the Baseline arm facing the identical world, per seed.
      incrementalRecoveredPaise: stat(rows.map((row, index) => row.recoveredPaise - baselineRows[index].recoveredPaise)),
      interventions: stat(rows.map((row) => row.interventions)),
      recoveryRate: stat(rows.map((row) => row.recoveryRate)),
      interventionCostPaise: stat(rows.map((row) => row.interventionCostPaise)),
      churnCostPaise: stat(rows.map((row) => row.churnCostPaise)),
      protectedPaise: stat(rows.map((row) => row.protectedPaise)),
      netPaise: stat(rows.map((row) => row.netPaise)),
    };
  }
  return { seeds, eventCountPerSeed: episodes, summary };
}

/**
 * The suppression ledger, measured over the episodes actually on this page.
 *
 * `protectedPaise` is the residual subscription value the scorer said was at risk
 * from contacting a dormant subscriber, summed over the episodes the policy
 * therefore declined. `forgonePaise` is the recovery value given up to protect it
 * — the other side of the same trade, which is the only reason the first number
 * means anything. Both are read off each episode's own EIR breakdown, so a reader
 * can reconcile them against the audit trail line by line.
 */
function buildLedger(episodes: RecoveryEpisode[]) {
  const suppressed = episodes.filter(
    (episode) => episode.status === "SUPPRESSED" || episode.policyDecision?.suppressionReason != null,
  );
  return {
    protectedPaise: suppressed.reduce((total, episode) => total + (episode.eir?.churnCostPaise ?? 0), 0),
    forgonePaise: suppressed.reduce((total, episode) => total + Math.max(0, episode.eir?.eirWithoutChurnPaise ?? 0), 0),
    suppressedCount: suppressed.length,
  };
}

function stat(values: number[]): Stat {
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  // Sample variance (n-1). These are seeds drawn from a population of worlds, not
  // the population itself; dividing by n understates the spread we display.
  const variance = values.length < 2
    ? 0
    : values.reduce((total, value) => total + (value - mean) ** 2, 0) / (values.length - 1);
  return { mean, standardDeviation: Math.sqrt(variance) };
}

function makeCase(
  paymentId: string,
  customerId: string,
  amountPaise: number,
  paymentMethod: PaymentEvent["paymentMethod"],
  failureCode: string,
  nativeRecoveryState: PaymentEvent["nativeRecoveryState"],
) {
  const index = parseInt(paymentId.slice(-1), 36) || 1;
  return {
    index,
    event: {
      eventId: `evt_${paymentId}`,
      eventType: "payment.failed" as const,
      occurredAt: "2026-08-21T10:14:03.000Z",
      merchantId: "merchant_demo",
      customerId,
      paymentId,
      subscriptionId: `sub_${paymentId}`,
      amountPaise,
      currency: "INR" as const,
      paymentMethod,
      failureCode,
      failureSource: failureCode === "unmapped_code" ? "unknown" as const : paymentMethod === "upi" ? "bank" as const : "bank" as const,
      nativeRecoveryState,
      customerPhone: null,
      railMetadata: {},
    },
  };
}

function profileFor(event: PaymentEvent, index: number): CustomerProfile {
  const phones = ["+919876543210", "+919876543211", "+919876543212", "+919876543213", "+91919876543214"];
  return {
    customerId: event.customerId,
    merchantId: event.merchantId,
    subscriptionAgeDays: 90 + index * 17,
    customerValuePaise: event.amountPaise * 18,
    successfulPaymentCount: 4 + (index % 5),
    failedPaymentCount: index % 2,
    previousRecoveryRate: 0.61,
    previousInterventionCount: 1,
    previousInterventionSuccessCount: 1,
    daysSinceLastSuccess: 28,
    lastFailureReason: null,
    paymentMethodDistribution: { [event.paymentMethod]: 1 },
    currentFailureEpisodeId: null,
    consentValid: true,
    optedOut: false,
    contactWindowOpen: true,
    phone: phones[index % phones.length],
    isSubscription: true,
    daysSinceLastEngagement: 28,
    engagementProxy: true,
  };
}

export { formatInr };