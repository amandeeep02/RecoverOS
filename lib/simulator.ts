import type { ActionProposal, CustomerProfile, PaymentEvent } from "@/lib/domain";
import { actionSchema } from "@/lib/domain";
import { rupees } from "@/lib/money";

export type SyntheticCase = {
  id: string;
  customerId: string;
  merchantId: string;
  amountPaise: number;
  paymentMethod: PaymentEvent["paymentMethod"];
  failureCode: string;
  failureSource: PaymentEvent["failureSource"];
  nativeRecoveryState: PaymentEvent["nativeRecoveryState"];
  profile: CustomerProfile;
  /** Wall-clock time of the failure. Real timestamps are what make the 15-minute
   *  degradation windows and any contact-frequency rule mean something. */
  occurredAtMs: number;
  /** Card issuer / PSP handle — the degradation detector keys on this. */
  issuer: string;
  /** How many times this customer has already failed, before this episode. */
  priorFailures: number;
};

export type HiddenTruth = {
  nativeProbability: number;
  actionProbability: Record<ActionProposal["action"], number>;
  sharedUniform: number;
  willChurnIfContacted: boolean;
  /** Pre-drawn uniform for the churn decision. Kept separate from the recovery
   *  draw so an evaluator can re-resolve churn against a fatigue-inflated hazard
   *  without disturbing the common random numbers on the recovery outcome. */
  churnUniform: number;
  /** Probability this customer churns if contacted — the expectation behind the draw. */
  deltaPChurn: number;
  /** Subscription value genuinely at stake, on a shorter horizon than the scorer assumes. */
  residualValuePaise: number;
  pActionTrue: Record<ActionProposal["action"], number>;
};

export type SyntheticWorld = { cases: SyntheticCase[]; hidden: Map<string, HiddenTruth> };

const failureCodes = ["insufficient_funds", "bank_declined", "expired_card", "authentication_failed", "mandate_rejected", "permanent_decline", "network_error", "unmapped_code"] as const;

export interface GeneratorAssumptions {
  /**
   * Baseline log-odds of native issuer recovery, keyed by raw failure code.
   * Deliberately NOT the same shape as scoring.ts's category-keyed table: the
   * merchant's model is a plausible estimator of this world, never a copy of it.
   */
  nativeLogitByCode: Record<string, number>;
  contactResponseRate: number;
  voiceLiftMultiplier: number;
  interventionCostPaise: Record<string, number>;
  /**
   * Dormancy churn hazard as a LOGISTIC in days dormant, with per-customer
   * heterogeneity — deliberately a different functional family from the one the
   * agent estimates with (`lib/scoring.ts` interpolates a fixed piecewise-linear
   * table with a hard zero below 30 days and a hard cap at 365). Real hazards do
   * not have kinks or dead zones, and real subscribers do not share one hazard:
   * `heterogeneityLogSd` gives each customer a latent susceptibility multiplier,
   * so the scorer's single population curve is a biased estimate of any
   * individual's risk even where the two curves agree on the population mean.
   * Levels are broadly matched (≈0.05 at 120d, ≈0.10 at 180d) so this is a shape
   * change, not a level change in disguise.
   *
   *   hazard(d) = ceiling / (1 + exp(-steepnessPerDay * (d - midpointDays))) * s
   *   s ~ LogNormal(-sigma^2/2, sigma^2)   (mean 1, so the population level holds)
   */
  dormancyChurnLogistic: {
    ceiling: number;
    midpointDays: number;
    steepnessPerDay: number;
    heterogeneityLogSd: number;
  };
  issuerOutageFrequency: number;
  issuerOutageDurationMinutes: [number, number];
  /** Mean failure episodes per customer. This is what makes customer attention a
   *  scarce resource: below ~2 there is no contention and no fatigue. */
  episodesPerCustomer: number;
  /** Multiplicative decay applied to an intervention's lift for each prior contact
   *  the SAME arm has already made to that customer. The second message works less
   *  well than the first; the fourth barely works at all. */
  contactFatigueDecay: number;
  /** Additional churn hazard per prior contact. Nagging is how you lose people. */
  contactFatigueChurnAdd: number;
}

export const DEFAULT_ASSUMPTIONS: GeneratorAssumptions = {
  nativeLogitByCode: {
    insufficient_funds: -0.42,
    bank_declined: 0.28,
    expired_card: -1.25,
    authentication_failed: -0.92,
    mandate_rejected: -1.35,
    permanent_decline: -2.4,
    network_error: 0.36,
    unmapped_code: -0.3,
  },
  contactResponseRate: 0.42,
  voiceLiftMultiplier: 1.35,
  interventionCostPaise: {
    WAIT: 0,
    PAYMENT_LINK: 1200,
    REMINDER: 400,
    ESCALATE: 11000,
    STOP: 0,
    RETRY: 300,
    VOICE_CALL: 800,
    HELD_OUT: 0,
    HELD_DEGRADED: 0,
  },
  dormancyChurnLogistic: { ceiling: 0.18, midpointDays: 165, steepnessPerDay: 0.02, heterogeneityLogSd: 0.55 },
  issuerOutageFrequency: 0.03,
  issuerOutageDurationMinutes: [20, 90],
  episodesPerCustomer: 6,
  contactFatigueDecay: 0.65,
  contactFatigueChurnAdd: 0.03,
};

const ISSUERS = ["HDFC", "ICICI", "SBI", "AXIS", "KOTAK", "OTHER"] as const;
const EPOCH_MS = Date.UTC(2026, 0, 1);
const DAY_MS = 86_400_000;
const BILLING_PERIOD_DAYS = 30;

type LatentCustomer = {
  customerId: string;
  paymentMethod: PaymentEvent["paymentMethod"];
  issuer: string;
  amountPaise: number;
  subscriptionAgeDays: number;
  baseSuccesses: number;
  consentValid: boolean;
  optedOut: boolean;
  contactWindowOpen: boolean;
  phone: string | null;
  /** Relative weight for drawing failure episodes. A minority of customers
   *  generate most of the failures, which is what creates contention. */
  failureProneness: number;
  firstFailureOffsetDays: number;
  /** Latent churn susceptibility multiplier on the dormancy hazard. Mean 1 across
   *  the population, so it redistributes risk without moving the population level. */
  churnSusceptibility: number;
};

/**
 * Returns observable cases only; ground truth stays in the world closure.
 *
 * The population is deliberately SMALLER than the episode count: ~`count /
 * episodesPerCustomer` customers, each failing several times over a billing
 * timeline. That is the difference between a world where every failure is a
 * stranger and one where customer attention is a finite resource you can spend
 * badly. Contact fatigue, message caps and per-customer competition for the next
 * intervention only exist once a customer can appear twice.
 */
export function generateSyntheticWorld(
  seed: number,
  count = 50_000,
  assumptions: GeneratorAssumptions = DEFAULT_ASSUMPTIONS,
): SyntheticWorld {
  const random = mulberry32(seed);
  const cases: SyntheticCase[] = [];
  const hidden = new Map<string, HiddenTruth>();

  const perCustomer = Math.max(1, assumptions.episodesPerCustomer);
  const customerCount = Math.max(1, Math.round(count / perCustomer));

  // ---- 1. the population ---------------------------------------------------
  const customers: LatentCustomer[] = [];
  let pronenessTotal = 0;
  for (let c = 0; c < customerCount; c += 1) {
    const paymentMethod = weighted(random, ["card", "upi", "netbanking", "wallet"] as const, [0.48, 0.34, 0.12, 0.06]);
    // Heavy-tailed: most customers fail occasionally, a few fail constantly.
    const failureProneness = Math.exp(random() * 1.6);
    pronenessTotal += failureProneness;
    customers.push({
      customerId: `cust_${seed}_${c}`,
      paymentMethod,
      issuer: paymentMethod === "card" ? ISSUERS[Math.floor(random() * ISSUERS.length)] : "UPI_PSP",
      amountPaise: Math.round((499 + Math.exp(random() * 5.3) * 26) * 100),
      subscriptionAgeDays: 20 + Math.floor(random() * 1_300),
      baseSuccesses: Math.floor(random() * 18),
      consentValid: random() > 0.08,
      optedOut: random() < 0.04,
      contactWindowOpen: random() > 0.15,
      phone: random() > 0.3 ? `+91${Math.floor(7000000000 + random() * 2999999999)}` : null,
      failureProneness,
      firstFailureOffsetDays: Math.floor(random() * BILLING_PERIOD_DAYS),
      churnSusceptibility: Math.exp(
        assumptions.dormancyChurnLogistic.heterogeneityLogSd * standardNormal(random)
        - (assumptions.dormancyChurnLogistic.heterogeneityLogSd ** 2) / 2,
      ),
    });
  }

  // ---- 2. allocate episodes across the population --------------------------
  const episodeCounts = new Array(customerCount).fill(0);
  for (let i = 0; i < count; i += 1) {
    let target = random() * pronenessTotal;
    let picked = customerCount - 1;
    for (let c = 0; c < customerCount; c += 1) {
      target -= customers[c].failureProneness;
      if (target <= 0) { picked = c; break; }
    }
    episodeCounts[picked] += 1;
  }

  // ---- 3. issuer outages as intervals on the timeline ----------------------
  // Occupancy, not per-episode probability: if outages cover fraction f of the
  // timeline and episodes are spread across it, ~f of episodes land inside one.
  const maxEpisodesForOne = Math.max(...episodeCounts, 1);
  const spanMs = (maxEpisodesForOne + 1) * BILLING_PERIOD_DAYS * DAY_MS;
  const [outageMinMin, outageMaxMin] = assumptions.issuerOutageDurationMinutes;
  const meanOutageMs = ((outageMinMin + outageMaxMin) / 2) * 60_000;
  const outageCount = assumptions.issuerOutageFrequency <= 0
    ? 0
    : Math.round((assumptions.issuerOutageFrequency * spanMs) / meanOutageMs);
  const outages: { start: number; end: number }[] = [];
  for (let o = 0; o < outageCount; o += 1) {
    const start = EPOCH_MS + random() * spanMs;
    const durationMs = (outageMinMin + random() * (outageMaxMin - outageMinMin)) * 60_000;
    outages.push({ start, end: start + durationMs });
  }
  outages.sort((a, b) => a.start - b.start);
  const inOutage = (t: number) => {
    // Windows are short and few; a linear scan over a sorted list is fine here
    // and keeps world generation dependency-free.
    for (const w of outages) {
      if (t < w.start) return false;
      if (t <= w.end) return true;
    }
    return false;
  };

  // ---- 4. episodes, in per-customer sequence -------------------------------
  let episodeIndex = 0;
  for (let c = 0; c < customerCount; c += 1) {
    const customer = customers[c];
    const n = episodeCounts[c];
    for (let k = 0; k < n; k += 1) {
      const occurredAtMs = Math.round(
        EPOCH_MS
        + (customer.firstFailureOffsetDays + k * BILLING_PERIOD_DAYS) * DAY_MS
        + random() * DAY_MS,
      );
      const outaged = inOutage(occurredAtMs);
      const failureCode = outaged
        ? "network_error"
        : weighted(random, failureCodes, [0.28, 0.2, 0.1, 0.09, 0.08, 0.08, 0.1, 0.07]);

      // The profile is a SNAPSHOT at this point in the customer's history: prior
      // failures accumulate, and dormancy grows with each unresolved period.
      const priorFailures = k;
      const failedPaymentCount = priorFailures + Math.floor(random() * 2);
      const daysSinceLastSuccess = 1 + Math.floor(random() * 40) + priorFailures * BILLING_PERIOD_DAYS;
      const previousRecoveryRate = clamp(
        0.1 + random() * 0.72 + customer.baseSuccesses * 0.008 - failedPaymentCount * 0.025, 0.02, 0.95,
      );
      const nativeRecoveryState = customer.paymentMethod === "card" && random() < 0.46
        ? "ACTIVE" : random() < 0.7 ? "EXHAUSTED" : "UNKNOWN";

      const id = `tx_${seed}_${episodeIndex}`;
      episodeIndex += 1;
      const amountPaise = customer.amountPaise;
      const profile: CustomerProfile = {
        customerId: customer.customerId,
        merchantId: "merchant_simulated",
        subscriptionAgeDays: customer.subscriptionAgeDays + k * BILLING_PERIOD_DAYS,
        customerValuePaise: amountPaise * (3 + Math.floor(random() * 24)),
        successfulPaymentCount: customer.baseSuccesses,
        failedPaymentCount,
        previousRecoveryRate,
        previousInterventionCount: 0,
        previousInterventionSuccessCount: 0,
        daysSinceLastSuccess,
        lastFailureReason: null,
        paymentMethodDistribution: { [customer.paymentMethod]: 1 },
        currentFailureEpisodeId: null,
        consentValid: customer.consentValid,
        optedOut: customer.optedOut,
        contactWindowOpen: customer.contactWindowOpen,
        phone: customer.phone,
        isSubscription: true,
        daysSinceLastEngagement: daysSinceLastSuccess,
        engagementProxy: true,
      };
      cases.push({
        id, customerId: customer.customerId, merchantId: "merchant_simulated", amountPaise,
        paymentMethod: customer.paymentMethod, failureCode, failureSource: sourceFor(failureCode),
        nativeRecoveryState, profile, occurredAtMs, issuer: customer.issuer, priorFailures,
      });

      const nativeLogit = (assumptions.nativeLogitByCode[failureCode] ?? -0.3)
        + Math.min(customer.baseSuccesses, 12) * 0.05
        - Math.min(failedPaymentCount, 6) * 0.09
        - Math.min(daysSinceLastSuccess, 180) * 0.004
        + Math.min(profile.subscriptionAgeDays, 720) * 0.0004
        + (nativeRecoveryState === "ACTIVE" ? 0.55 : 0);
      const nativeProbability = clamp(sigmoid(nativeLogit), 0.005, 0.995);

      const actionProbability = {} as Record<ActionProposal["action"], number>;
      const isHighValue = profile.customerValuePaise > rupees(20_000);
      for (const action of actionSchema.options) {
        let effect = hiddenInterventionEffect(action, failureCode, nativeRecoveryState, profile);
        if (isContactAction(action)) effect *= assumptions.contactResponseRate;
        if (action === "VOICE_CALL" && isHighValue) effect *= assumptions.voiceLiftMultiplier;
        actionProbability[action] = clamp(nativeProbability + effect, 0.005, 0.995);
      }

      const daysDormant = daysSinceLastSuccess;
      const deltaPChurn = dormancyChurnHazard(daysDormant, customer.churnSusceptibility, assumptions);
      const residualValuePaise = Math.round(amountPaise * 4 * clamp(1 - daysDormant / 365, 0, 1));
      const churnUniform = random();
      hidden.set(id, {
        nativeProbability,
        actionProbability,
        sharedUniform: random(),
        churnUniform,
        willChurnIfContacted: deltaPChurn > 0 && churnUniform < deltaPChurn,
        deltaPChurn,
        residualValuePaise,
        pActionTrue: actionProbability,
      });
    }
  }

  // Chronological order: evaluators walk this sequence and accumulate per-customer
  // contact history as they go, so an arm's own past choices constrain its future.
  cases.sort((a, b) => a.occurredAtMs - b.occurredAtMs || a.id.localeCompare(b.id));
  return { cases, hidden };
}

/**
 * True lift of an action after fatigue. Each prior contact the SAME arm has made
 * to this customer multiplies the remaining lift down. Non-contact actions are
 * unaffected — a silent retry does not consume anybody's patience.
 */
export function fatiguedActionProbability(
  truth: HiddenTruth,
  action: ActionProposal["action"],
  priorContacts: number,
  assumptions: GeneratorAssumptions = DEFAULT_ASSUMPTIONS,
): number {
  const base = truth.pActionTrue[action] ?? truth.nativeProbability;
  if (!isContactAction(action) || priorContacts <= 0) return base;
  const lift = base - truth.nativeProbability;
  return clamp(truth.nativeProbability + lift * assumptions.contactFatigueDecay ** priorContacts, 0.005, 0.995);
}

/** Churn hazard rises with every prior contact. Nagging is how you lose people. */
export function fatiguedChurn(
  truth: HiddenTruth,
  priorContacts: number,
  assumptions: GeneratorAssumptions = DEFAULT_ASSUMPTIONS,
): boolean {
  const hazard = truth.deltaPChurn + priorContacts * assumptions.contactFatigueChurnAdd;
  return hazard > 0 && truth.churnUniform < hazard;
}

export function eventFromSyntheticCase(item: SyntheticCase): PaymentEvent {
  return {
    eventId: `evt_${item.id}`,
    eventType: "payment.failed",
    occurredAt: new Date(item.occurredAtMs).toISOString(),
    merchantId: item.merchantId,
    customerId: item.customerId,
    paymentId: item.id,
    subscriptionId: `sub_${item.id}`,
    amountPaise: item.amountPaise,
    currency: "INR",
    paymentMethod: item.paymentMethod,
    failureCode: item.failureCode,
    failureSource: item.failureSource,
    nativeRecoveryState: item.nativeRecoveryState,
    customerPhone: item.profile.phone,
    railMetadata: { issuer: item.issuer, network: item.paymentMethod === "card" ? "CARD" : null },
  };
}

/** What the Oracle arm decided for one episode. */
export type OracleDecision = {
  caseId: string;
  action: ActionProposal["action"];
  /** True incremental value of the chosen action, net of cost and expected churn. */
  expectedEirPaise: number;
  /** True post-action recovery probability. Only an oracle can know this. */
  prediction: number;
};

/**
 * Upper bound on what any policy could achieve in this world: picks the action that
 * maximises true incremental value, reading the planted truth directly. Not a
 * competitor — a yardstick. If the Oracle cannot beat Baseline, the generative
 * assumptions are wrong (intervention genuinely never pays) and no amount of policy
 * tuning is the answer. It is deliberately stronger than any achievable policy,
 * since it also knows each episode's churn draw in advance.
 */
/**
 * Upper bound on what ANY policy could achieve here. Not a competitor — a yardstick.
 *
 * It must optimise the objective it is graded on. An earlier version scored candidates
 * with the un-fatigued `actionProbability` and `deltaPChurn` while `evaluateArm` resolved
 * outcomes through `fatiguedActionProbability` / `fatiguedChurn`. That oracle was solving
 * a different problem from the one it was scored on: blind to fatigue, it systematically
 * overvalued contacting a customer it had already contacted, and understated the true
 * ceiling by more than half. A yardstick that is measured with a different ruler than the
 * things it measures is worse than no yardstick, because everyone trusts it.
 *
 * `priorContacts` is supplied by the evaluator from the oracle's OWN contact history, so
 * it plans against the same fatigue every other arm pays.
 */
export function oracleStrategy(
  world: SyntheticWorld,
  assumptions: GeneratorAssumptions = DEFAULT_ASSUMPTIONS,
): (item: SyntheticCase, priorContacts: number) => OracleDecision {
  return (item, priorContacts = 0) => {
    const truth = world.hidden.get(item.id)!;
    // Churn hazard as it will actually be charged, including accumulated fatigue.
    const churnHazard = Math.min(1, truth.deltaPChurn + priorContacts * assumptions.contactFatigueChurnAdd);
    const expectedChurnPaise = churnHazard * truth.residualValuePaise;
    let bestAction: ActionProposal["action"] = "WAIT";
    let bestValue = 0;
    let bestP = truth.nativeProbability;
    for (const action of ["PAYMENT_LINK", "REMINDER", "RETRY", "VOICE_CALL"] as const) {
      // Lift after fatigue decay — the same number the evaluator will resolve against.
      const p = fatiguedActionProbability(truth, action, priorContacts, assumptions);
      const lift = p - truth.nativeProbability;
      const churn = isContactAction(action) ? expectedChurnPaise : 0;
      const value = lift * item.amountPaise - (assumptions.interventionCostPaise[action] ?? 0) - churn;
      if (value > bestValue) { bestValue = value; bestAction = action; bestP = p; }
    }
    return { caseId: item.id, action: bestAction, expectedEirPaise: Math.round(bestValue), prediction: bestP };
  };
}

function sourceFor(code: string): PaymentEvent["failureSource"] {
  if (code === "mandate_rejected") return "mandate";
  if (code === "network_error") return "network";
  if (code === "authentication_failed") return "customer";
  if (["insufficient_funds", "bank_declined", "expired_card", "permanent_decline"].includes(code)) return "bank";
  return "unknown";
}

function isContactAction(action: ActionProposal["action"]) {
  return action === "REMINDER" || action === "PAYMENT_LINK" || action === "VOICE_CALL";
}

/**
 * True incremental lift of an action, before the contact-response and voice
 * multipliers the caller applies. Note that a card still inside the issuer's own
 * retry cycle has zero lift for every action — the money was arriving anyway. That
 * is the single largest source of wasted spend a recovery agent can avoid.
 */
function hiddenInterventionEffect(action: ActionProposal["action"], code: string, nativeState: PaymentEvent["nativeRecoveryState"], profile: CustomerProfile) {
  // A human agent who picks up an unclear failure does recover some of them — that is
  // why merchants staff a recovery desk. At ₹110 against a mean episode of ~₹1,500 it
  // is net-negative on small tickets and pays only on large ones, so "escalate the
  // ₹20,000 mandate, not the ₹499 one" is a real decision the policy has to get right.
  if (action === "ESCALATE") return 0.05;
  if (!["PAYMENT_LINK", "REMINDER", "RETRY", "VOICE_CALL"].includes(action)) return 0;
  if (nativeState === "ACTIVE" && profile.paymentMethodDistribution.card) {
    // Firing our own retry into the issuer's live retry schedule burns one of a
    // limited number of attempts and can convert a soft decline into a hard one.
    // Contact actions are merely wasted here; a retry is actively harmful.
    return action === "RETRY" ? -0.03 : 0;
  }
  const table: Record<string, number> = {
    insufficient_funds: action === "REMINDER" ? 0.28 : action === "PAYMENT_LINK" ? 0.16 : action === "VOICE_CALL" ? 0.22 : 0.06,
    bank_declined: action === "RETRY" ? 0.09 : action === "PAYMENT_LINK" ? 0.08 : action === "VOICE_CALL" ? 0.15 : 0.03,
    expired_card: action === "PAYMENT_LINK" ? 0.42 : action === "REMINDER" ? 0.17 : action === "VOICE_CALL" ? 0.3 : 0.01,
    authentication_failed: action === "PAYMENT_LINK" ? 0.37 : action === "REMINDER" ? 0.14 : action === "VOICE_CALL" ? 0.28 : 0.02,
    mandate_rejected: action === "PAYMENT_LINK" ? 0.19 : action === "VOICE_CALL" ? 0.15 : 0.01,
    permanent_decline: 0.005,
    network_error: 0.005,
    unmapped_code: action === "VOICE_CALL" ? 0.1 : 0.025,
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

/**
 * Dormancy churn hazard. Logistic in days dormant, scaled by the customer's
 * latent susceptibility. See `GeneratorAssumptions.dormancyChurnLogistic` for why
 * this deliberately does not share a functional family with `lib/scoring.ts`.
 */
function dormancyChurnHazard(daysDormant: number, susceptibility: number, assumptions: GeneratorAssumptions) {
  const { ceiling, midpointDays, steepnessPerDay } = assumptions.dormancyChurnLogistic;
  return clamp(ceiling * sigmoid(steepnessPerDay * (daysDormant - midpointDays)) * susceptibility, 0, 0.95);
}

/** Box-Muller. Two uniforms in, one standard normal out. */
function standardNormal(random: () => number) {
  const u1 = Math.max(random(), 1e-12);
  const u2 = random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}