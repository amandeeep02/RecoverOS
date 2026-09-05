import type { CustomerProfile, PaymentEvent } from "@/lib/domain";
import { formatInr, rupees } from "@/lib/domain";
import { observeOutcome, processPaymentFailure } from "@/lib/pipeline";
import { runEval } from "@/lib/eval/harness";
import { DegradationDetector } from "@/lib/degradation";
import { defaultMerchantPolicy } from "@/lib/pipeline";
import { RecoveryStore } from "@/lib/store";
import { mulberry32, type Rng, weighted } from "@/lib/rng";

export type DemoSnapshot = {
  episodes: Array<{
    id: string;
    status: string;
    event: { customerId: string; paymentMethod: string; paymentId: string; amountPaise: number };
    diagnosis?: { category: string; confidence: number } | null;
    eir?: { eirPaise: number; incrementalLift: number } | null;
    policyDecision?: { allowedAction: string | null; suppressionReason: string | null } | null;
  }>;
  ledger: { incrementalRecoveredPaise: number; protectedPaise: number; forgonePaise: number; suppressedCount: number };
  benchmark: { nTreatment: number; nHoldout: number; ciLoPaise: number; ciHiPaise: number; incrementalRecoveredPaise: number };
};

const INDIAN_NAMES = [
  "Aarav Sharma", "Aditi Patel", "Arjun Singh", "Ananya Reddy", "Dev Patel", "Diya Gupta",
  "Ishaan Kumar", "Kavya Nair", "Krish Mehta", "Maya Joshi", "Neha Shah", "Rohan Desai",
  "Priya Iyer", "Rahul Verma", "Saanvi Agarwal", "Vikram Rao", "Zara Khan", "Aryan Malhotra",
  "Isha Kapoor", "Kabir Sethi", "Meera Pillai", "Rohan Chopra", "Tara Menon", "Veer Khanna",
  "Aisha Rahman", "Dhruv Bansal", "Kiara Dutta", "Neil Joshi", "Riya Saxena", "Samir Patel",
  "Tanya Gupta", "Udit Singh", "Vivaan Agarwal", "Yash Mehta", "Zoya Khan", "Advait Reddy",
  "Anika Shah", "Devansh Kumar", "Esha Nair", "Kiaan Mehta", "Myra Joshi",
];

const FAILURE_CODES = [
  "insufficient_funds", "bank_declined", "expired_card", "authentication_failed",
  "mandate_rejected", "permanent_decline", "network_error", "unmapped_code",
] as const;

const PAYMENT_METHODS = ["card", "upi", "netbanking", "wallet"] as const;

export async function buildDemoSnapshot(seed = 7): Promise<DemoSnapshot> {
  const rng = mulberry32(seed);
  const recoveryStore = new RecoveryStore();
  const degradationDetector = new DegradationDetector(recoveryStore, { now: () => Date.now() }, rng);

  // Generate 200 historical episodes with realistic Indian data
  const historicalEpisodes = Array.from({ length: 200 }, (_, i) => {
    const paymentMethod = weighted(rng, PAYMENT_METHODS, [0.48, 0.34, 0.12, 0.06]);
    const failureCode = weighted(rng, FAILURE_CODES, [0.28, 0.20, 0.10, 0.09, 0.08, 0.08, 0.10, 0.07]);
    const amountPaise = Math.round((499 + Math.exp(rng.next() * 5.3) * 26) * 100);
    const successes = Math.floor(rng.next() * 18);
    const failures = Math.floor(rng.next() * 6);
    const subscriptionAgeDays = 20 + Math.floor(rng.next() * 1_300);
    const previousRecoveryRate = Math.max(0.02, Math.min(0.95, 0.1 + rng.next() * 0.72 + successes * 0.008 - failures * 0.025));
    const daysSinceLastSuccess = 1 + Math.floor(rng.next() * 180);
    const nativeRecoveryState = paymentMethod === "card" && rng.next() < 0.46 ? "ACTIVE" : rng.next() < 0.7 ? "EXHAUSTED" : "UNKNOWN";
    const customerId = `cust_${seed}_${i}`;
    const name = INDIAN_NAMES[i % INDIAN_NAMES.length];

    return {
      id: `tx_${seed}_${i}`,
      customerId,
      name,
      amountPaise,
      paymentMethod,
      failureCode,
      nativeRecoveryState,
      profile: {
        customerId,
        merchantId: "merchant_demo",
        subscriptionAgeDays,
        customerValuePaise: amountPaise * (3 + Math.floor(rng.next() * 24)),
        successfulPaymentCount: successes,
        failedPaymentCount: failures,
        previousRecoveryRate,
        previousInterventionCount: Math.floor(rng.next() * 3),
        previousInterventionSuccessCount: Math.floor(rng.next() * 2),
        daysSinceLastSuccess,
        lastFailureReason: null,
        paymentMethodDistribution: { [paymentMethod]: 1 },
        currentFailureEpisodeId: null,
        consentValid: rng.next() > 0.08,
        optedOut: rng.next() < 0.04,
        contactWindowOpen: rng.next() > 0.15,
        phone: rng.next() > 0.3 ? `+91${Math.floor(7000000000 + rng.next() * 2999999999)}` : null,
        isSubscription: true,
        daysSinceLastEngagement: daysSinceLastSuccess,
        engagementProxy: true,
      },
      event: {
        eventId: `evt_tx_${seed}_${i}`,
        eventType: "payment.failed" as const,
        occurredAt: new Date(Date.now() - rng.next() * 30 * 24 * 60 * 60 * 1000).toISOString(),
        merchantId: "merchant_demo",
        customerId,
        paymentId: `pay_${seed}_${i}`,
        subscriptionId: `sub_${seed}_${i}`,
        amountPaise,
        currency: "INR" as const,
        paymentMethod,
        failureCode,
        failureSource: failureCode === "unmapped_code" ? "unknown" : paymentMethod === "upi" ? "bank" : "bank",
        nativeRecoveryState,
        railMetadata: { issuer: rng.next() > 0.5 ? "HDFC" : "ICICI", network: rng.next() > 0.5 ? "VISA" : "RUPAY" },
      },
    };
  });

  // Save all historical profiles
  for (const ep of historicalEpisodes) {
    await recoveryStore.saveProfile(ep.profile);
  }

  // Process all historical episodes
  // Process all historical episodes
  const policy = { merchantId: "merchant_demo", minimumEirPaise: rupees(150), maxAutomatedAttempts: 3, maxMessagesPerEpisode: 2, maxVoiceCallsPerEpisode: 1, allowRetry: true, allowPaymentLinks: true, allowVoiceCalls: true, requireConsentForReminder: true, highValueEscalationThresholdPaise: rupees(50_000), dltTemplateId: "RECOVEROS_TXN_PAYMENT_FAILED_V1", dltSenderHeader: "RCVROS", preDebitNotificationByPlatform: true, minimumEscalationValuePaise: rupees(2_500), churnAversion: 1, holdoutPct: 5 };
  
  for (const ep of historicalEpisodes) {
    await processPaymentFailure(ep.event as any, recoveryStore, policy);
  }

  // Resolve some outcomes
  const episodes = await recoveryStore.listEpisodes();
  for (const ep of episodes) {
    if (ep.status === "PENDING" || ep.status === "PROMISED") {
      const rng2 = mulberry32(ep.id.split("_").pop()?.charCodeAt(0) ?? 1);
      const recovered = rng2.bernoulli(ep.status === "PENDING" ? 0.6 : 0.4);
      await observeOutcome(ep.id, recovered ? "RECOVERED" : "FAILED", recoveryStore);
    }
  }

  // Create demo episodes for live demo (5 fresh episodes)
  const demoEpisodes = [
    makeCase("pay_DEMO1", "cust_demo_arav", rupees(8_499), "card", "bank_declined", "ACTIVE", "Aarav Sharma"),
    makeCase("pay_DEMO2", "cust_demo_aditi", rupees(15_000), "card", "expired_card", "EXHAUSTED", "Aditi Patel"),
    makeCase("pay_DEMO3", "cust_demo_ishaan", rupees(2_999), "upi", "insufficient_funds", "EXHAUSTED", "Ishaan Kumar"),
    makeCase("pay_DEMO4", "cust_demo_maya", rupees(19_500), "upi", "unmapped_code", "UNKNOWN", "Maya Joshi"),
    makeCase("pay_DEMO5", "cust_demo_neha", rupees(6_999), "card", "permanent_decline", "EXHAUSTED", "Neha Shah"),
  ];

  for (const ep of demoEpisodes) {
    await recoveryStore.saveProfile(ep.profile);
  }

  const processed = await Promise.all(demoEpisodes.map(({ event }) => processPaymentFailure(event as any, recoveryStore, policy)));

  // Resolve the payment link case
  const linkEpisode = processed.find(({ episode }) => episode.event.paymentId === "pay_DEMO2")?.episode;
  if (linkEpisode?.status === "PENDING") await observeOutcome(linkEpisode.id, "RECOVERED", recoveryStore);

  const finalEpisodes = (await recoveryStore.listEpisodes()).slice(0, 50);
  // Real evaluation on the ONE evaluator, same knobs as `npm run eval`. This block
  // previously called a deleted second evaluator, hardcoded the ledger, and invented
  // the experiment: nHoldout was `interventions * 0.05` and the "95% CI" was an
  // across-seed standard deviation relabelled as a holdout interval. A dashboard
  // that renders a fabricated confidence interval refutes the entire product claim.
  const evalPolicy = defaultMerchantPolicy("merchant_demo");
  evalPolicy.allowRetry = true;
  evalPolicy.minimumEirPaise = 0;
  evalPolicy.churnAversion = 1.5;
  evalPolicy.holdoutPct = 5;
  const report = runEval({ episodes: 5_000, seeds: [seed + 1, seed + 2, seed + 3], policy: evalPolicy, holdoutPct: 5 });
  const mean = (f: (s: (typeof report.perSeed)[number]) => number) =>
    report.perSeed.reduce((t, s) => t + f(s), 0) / report.perSeed.length;
  const tInterval = (values: number[]) => {
    const n = values.length;
    const m = values.reduce((a, b) => a + b, 0) / n;
    if (n < 2) return { ciLoPaise: Math.round(m), ciHiPaise: Math.round(m) };
    const sd = Math.sqrt(values.reduce((t, x) => t + (x - m) ** 2, 0) / (n - 1));
    const t = 4.303; // df=2, two-sided 95%
    return { ciLoPaise: Math.round(m - t * sd / Math.sqrt(n)), ciHiPaise: Math.round(m + t * sd / Math.sqrt(n)) };
  };

  // Derived from episodes actually suppressed. Zero is an honest reading.
  const suppressed = finalEpisodes.filter(
    (ep) => ep.status === "SUPPRESSED" || ep.policyDecision?.suppressionReason != null,
  );
  const ledger = {
    incrementalRecoveredPaise: Math.round(mean((s) => s.holdout?.incrementalPaise ?? 0)),
    protectedPaise: suppressed.reduce((t, ep) => t + (ep.eir?.churnCostPaise ?? 0), 0),
    forgonePaise: suppressed.reduce((t, ep) => t + Math.max(0, ep.eir?.eirWithoutChurnPaise ?? 0), 0),
    suppressedCount: suppressed.length,
  };

  return {
    episodes: finalEpisodes.map(ep => ({
      id: ep.id,
      status: ep.status,
      event: { customerId: ep.event.customerId, paymentMethod: ep.event.paymentMethod, paymentId: ep.event.paymentId, amountPaise: ep.event.amountPaise },
      diagnosis: ep.diagnosis,
      eir: ep.eir,
      policyDecision: ep.policyDecision,
    })),
    ledger,
    benchmark: {
      nTreatment: Math.round(mean((s) => s.holdout?.nTreatment ?? 0)),
      nHoldout: Math.round(mean((s) => s.holdout?.nHoldout ?? 0)),
      // Across-seed Student-t over the per-seed point estimates. NOT the mean of the
      // per-seed bootstrap endpoints — averaging interval bounds produces a number
      // with no coverage property, which is exactly what RESULTS.md calls out.
      ...tInterval(report.perSeed.map((s) => s.holdout?.incrementalPaise ?? 0)),
      incrementalRecoveredPaise: Math.round(mean((s) => s.holdout?.incrementalPaise ?? 0)),
    },
  };
}

function makeCase(paymentId: string, customerId: string, amount: number, paymentMethod: PaymentEvent["paymentMethod"], failureCode: string, nativeRecoveryState: PaymentEvent["nativeRecoveryState"], name: string) {
  const rng = mulberry32(7);
  const idx = parseInt(paymentId.slice(-1), 36) || 1;
  const subscriptionAgeDays = 90 + idx * 17;
  const amountPaise = amount;
  const failures = idx % 2;
  const successes = 4 + (idx % 5);
  const previousRecoveryRate = 0.61;
  const daysSinceLastSuccess = 28;

  return {
    index: idx,
    name,
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
      failureSource: failureCode === "unmapped_code" ? "unknown" : paymentMethod === "upi" ? "bank" : "bank",
      nativeRecoveryState,
      railMetadata: { issuer: "HDFC", network: "VISA" },
    },
    profile: {
      customerId,
      merchantId: "merchant_demo",
      subscriptionAgeDays,
      customerValuePaise: amountPaise * 18,
      successfulPaymentCount: successes,
      failedPaymentCount: failures,
      previousRecoveryRate,
      previousInterventionCount: 1,
      previousInterventionSuccessCount: 1,
      daysSinceLastSuccess,
      lastFailureReason: null,
      paymentMethodDistribution: { [paymentMethod]: 1 },
      currentFailureEpisodeId: null,
      consentValid: true,
      optedOut: false,
      contactWindowOpen: true,
      phone: `+91${Math.floor(7000000000 + Math.random() * 2999999999)}`,
      isSubscription: true,
      daysSinceLastEngagement: 28,
      engagementProxy: true,
    },
  };
}

export { formatInr, rupees };