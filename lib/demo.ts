import type { CustomerProfile, PaymentEvent, RecoveryEpisode } from "@/lib/domain";
import { formatInr } from "@/lib/domain";
import { observeOutcome, processPaymentFailure } from "@/lib/pipeline";
import { runBenchmark, type BenchmarkReport } from "@/lib/simulator";
import { RecoveryStore } from "@/lib/store";

export type DemoSnapshot = {
  episodes: RecoveryEpisode[];
  audits: Record<string, ReturnType<RecoveryStore["getAudit"]>>;
  benchmark: BenchmarkReport;
  queueSummary: { revenueAtRiskInr: number; recoveredInr: number; pendingInr: number; escalated: number };
};

export async function buildDemoSnapshot(): Promise<DemoSnapshot> {
  const recoveryStore = new RecoveryStore();
  const cases = [
    makeCase("pay_8X1", "cust_aurora", 8_499, "card", "bank_declined", "ACTIVE"),
    makeCase("pay_2K9", "cust_basil", 15_000, "card", "expired_card", "EXHAUSTED"),
    makeCase("pay_7M4", "cust_cedar", 2_999, "upi", "insufficient_funds", "EXHAUSTED"),
    makeCase("pay_3P6", "cust_delta", 19_500, "upi", "unmapped_code", "UNKNOWN"),
    makeCase("pay_1N8", "cust_ember", 6_999, "card", "permanent_decline", "EXHAUSTED"),
  ];
  for (const sample of cases) recoveryStore.saveProfile(profileFor(sample.event, sample.index));
  const processed = await Promise.all(cases.map(({ event }) => processPaymentFailure(event, recoveryStore)));
  const linkEpisode = processed.find(({ episode }) => episode.event.paymentId === "pay_2K9")?.episode;
  if (linkEpisode?.status === "PENDING") observeOutcome(linkEpisode.id, "RECOVERED", recoveryStore);
  const episodes = recoveryStore.listEpisodes();
  const benchmark = runBenchmark([11, 12, 13, 14, 15], 1_000);
  return {
    episodes,
    audits: Object.fromEntries(episodes.map((episode) => [episode.id, recoveryStore.getAudit(episode.id)])),
    benchmark,
    queueSummary: {
      revenueAtRiskInr: episodes.reduce((total, episode) => total + episode.event.amountInr, 0),
      recoveredInr: episodes.filter((episode) => episode.status === "RECOVERED").reduce((total, episode) => total + episode.event.amountInr, 0),
      pendingInr: episodes.filter((episode) => episode.status === "PENDING").reduce((total, episode) => total + episode.event.amountInr, 0),
      escalated: episodes.filter((episode) => episode.status === "ESCALATED").length,
    },
  };
}

function makeCase(
  paymentId: string,
  customerId: string,
  amountInr: number,
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
      amountInr,
      currency: "INR" as const,
      paymentMethod,
      failureCode,
      failureSource: failureCode === "unmapped_code" ? "unknown" as const : paymentMethod === "upi" ? "bank" as const : "bank" as const,
      nativeRecoveryState,
      railMetadata: {},
    },
  };
}

function profileFor(event: PaymentEvent, index: number): CustomerProfile {
  const phones = ["+919876543210", "+919876543211", "+919876543212", "+919876543213", "+919876543214"];
  return {
    customerId: event.customerId,
    merchantId: event.merchantId,
    subscriptionAgeDays: 90 + index * 17,
    customerValueInr: event.amountInr * 18,
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
  };
}

export { formatInr };
