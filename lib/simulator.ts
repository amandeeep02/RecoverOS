import type { ActionProposal, CustomerProfile, PaymentEvent } from "@/lib/domain";
import { actionSchema } from "@/lib/domain";
import { rupees } from "@/lib/money";

export type SyntheticCase = {
  id: string;
  customerId: string;
  merchantId: string;
  amountPaise: number;
  paymentMethod: PaymentEvent["paymentMethod"];
  /** The string the gateway returned, and the only failure signal the agent sees. */
  failureCode: string;
  /**
   * The underlying failure. Equal to `failureCode` for the seven mapped codes; for a
   * long-tail surface string it is the code that string is an alias OF, and it is
   * HIDDEN from the agent. Every outcome in this world resolves through this field, so
   * a diagnosis that recovers it is worth money and one that guesses wrong is charged.
   */
  trueFailureCode: string;
  /** Whether the surface string carries enough signal for the category to be read off
   *  it. False means the only correct answer is `unknown`. Null for mapped codes. */
  longTailInferable: boolean | null;
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

/**
 * The long tail. See SIMULATOR.md §1b, written before this code.
 *
 * Each entry is a SURFACE string. `trueCode` is the underlying failure, and every
 * outcome in this world resolves through `trueCode` — only the string the agent sees
 * differs. That is what a real long tail is: one insufficient-funds failure arrives as
 * `insuff_bal` from one acquirer, `HDFC_E7743` from another, and `cust said card...`
 * from an operator who ran out of field width.
 *
 * `inferable: true`  — the words carry the category; a competent reader gets it.
 * `inferable: false` — the string carries NO categorical signal. The correct answer is
 *                      `unknown` and the correct behaviour is to fall back.
 *
 * Nothing here is drawn from a published code set. ISO 8583 and the card-network decline
 * reasons are published, therefore memorised — `RC_51` is opaque to a human and trivial
 * to a model, so a vocabulary built from them would measure recall of a specification and
 * report it as comprehension. The non-inferable class is bank-proprietary numerics,
 * vendor junk and truncated free text: the part of a real tail no specification covers.
 */
export const LONG_TAIL_VOCABULARY: readonly { surface: string; trueCode: string; inferable: boolean }[] = [
  // ---- Inferable: the category is recoverable from the words present ----
  { surface: "insuff_bal", trueCode: "insufficient_funds", inferable: true },
  { surface: "low_balance_retry_later", trueCode: "insufficient_funds", inferable: true },
  { surface: "acct_balance_low", trueCode: "insufficient_funds", inferable: true },
  { surface: "funds_unavailable_acct", trueCode: "insufficient_funds", inferable: true },
  { surface: "balance_short_for_debit", trueCode: "insufficient_funds", inferable: true },
  { surface: "card_exp_2024", trueCode: "expired_card", inferable: true },
  { surface: "cc_expired_reissue_needed", trueCode: "expired_card", inferable: true },
  { surface: "card_validity_over", trueCode: "expired_card", inferable: true },
  { surface: "expiry_date_in_past", trueCode: "expired_card", inferable: true },
  { surface: "otp_timeout_customer", trueCode: "authentication_failed", inferable: true },
  { surface: "3ds_auth_abandoned", trueCode: "authentication_failed", inferable: true },
  { surface: "cust_did_not_authenticate", trueCode: "authentication_failed", inferable: true },
  { surface: "pin_incorrect_3_attempts", trueCode: "authentication_failed", inferable: true },
  { surface: "mandate_cancelled_by_cust", trueCode: "mandate_rejected", inferable: true },
  { surface: "autopay_disabled_by_user", trueCode: "mandate_rejected", inferable: true },
  { surface: "standing_instruction_revoked", trueCode: "mandate_rejected", inferable: true },
  { surface: "mandate_not_active", trueCode: "mandate_rejected", inferable: true },
  { surface: "issuer_declined_generic", trueCode: "bank_declined", inferable: true },
  { surface: "bank_refused_transaction", trueCode: "bank_declined", inferable: true },
  { surface: "issuer_not_permitting_txn", trueCode: "bank_declined", inferable: true },
  { surface: "card_blocked_permanently", trueCode: "permanent_decline", inferable: true },
  { surface: "account_closed_by_bank", trueCode: "permanent_decline", inferable: true },
  { surface: "card_reported_lost", trueCode: "permanent_decline", inferable: true },
  { surface: "gateway_timeout_upstream", trueCode: "network_error", inferable: true },
  { surface: "switch_unavailable_retry", trueCode: "network_error", inferable: true },
  { surface: "connection_reset_by_issuer", trueCode: "network_error", inferable: true },

  // ---- Non-inferable: bank-proprietary numerics. Nothing published, nothing guessable.
  { surface: "HDFC_E7743", trueCode: "insufficient_funds", inferable: false },
  { surface: "ICICI_2201", trueCode: "bank_declined", inferable: false },
  { surface: "AXIS_ERR_88", trueCode: "expired_card", inferable: false },
  { surface: "SBI_0417", trueCode: "authentication_failed", inferable: false },
  { surface: "KOTAK_X12", trueCode: "mandate_rejected", inferable: false },
  { surface: "YESB_4409", trueCode: "network_error", inferable: false },
  { surface: "IDFC_D31", trueCode: "insufficient_funds", inferable: false },
  { surface: "INDUS_77Q", trueCode: "permanent_decline", inferable: false },

  // ---- Non-inferable: bare junk and vendor internals ----
  { surface: "E_2201", trueCode: "bank_declined", inferable: false },
  { surface: "ERR_5013", trueCode: "network_error", inferable: false },
  { surface: "9082", trueCode: "insufficient_funds", inferable: false },
  { surface: "FAIL_03", trueCode: "authentication_failed", inferable: false },
  { surface: "DECLINE", trueCode: "bank_declined", inferable: false },
  { surface: "TXN_FAIL", trueCode: "network_error", inferable: false },
  { surface: "ERROR", trueCode: "insufficient_funds", inferable: false },
  { surface: "NA", trueCode: "expired_card", inferable: false },
  { surface: "-", trueCode: "bank_declined", inferable: false },
  { surface: "unknown_error", trueCode: "mandate_rejected", inferable: false },
  { surface: "PG_INTERNAL_9", trueCode: "network_error", inferable: false },
  { surface: "vendor_code_x", trueCode: "permanent_decline", inferable: false },

  // ---- Non-inferable: truncated operator free text ----
  { surface: "cust said card...", trueCode: "expired_card", inferable: false },
  { surface: "agent note: cus", trueCode: "insufficient_funds", inferable: false },
  { surface: "called - no ans", trueCode: "bank_declined", inferable: false },
  { surface: "ref ticket 4412", trueCode: "authentication_failed", inferable: false },
  { surface: "per bank ops", trueCode: "mandate_rejected", inferable: false },
  { surface: "retry per SOP", trueCode: "network_error", inferable: false },
  { surface: "see note", trueCode: "insufficient_funds", inferable: false },
  { surface: "escalated 2x", trueCode: "permanent_decline", inferable: false },
];

/** Reported by `npm run eval` rather than restated in prose, so the documented
 *  fraction cannot drift from the vocabulary. */
export const LONG_TAIL_STATS = {
  total: LONG_TAIL_VOCABULARY.length,
  inferable: LONG_TAIL_VOCABULARY.filter((v) => v.inferable).length,
  nonInferable: LONG_TAIL_VOCABULARY.filter((v) => !v.inferable).length,
  get nonInferableFraction() { return this.nonInferable / this.total; },
};


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
      const drawnCode = outaged
        ? "network_error"
        : weighted(random, failureCodes, [0.28, 0.2, 0.1, 0.09, 0.08, 0.08, 0.1, 0.07]);
      // The 7% that used to be one literal string. The surface string is what the agent
      // sees; the world keeps the alias target and resolves every outcome through it.
      const longTail = drawnCode === "unmapped_code"
        ? LONG_TAIL_VOCABULARY[Math.floor(random() * LONG_TAIL_VOCABULARY.length)]
        : null;
      const failureCode = longTail ? longTail.surface : drawnCode;
      const trueFailureCode = longTail ? longTail.trueCode : drawnCode;

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
        paymentMethod: customer.paymentMethod, failureCode, trueFailureCode,
        longTailInferable: longTail ? longTail.inferable : null,
        // A long-tail episode reports source "unknown", NOT the source of its hidden
        // true code. Deriving the source from the truth leaks the answer through a
        // second channel: `lib/diagnosis.ts` infers `network_gateway_failure` from
        // `failureSource` alone, so five non-inferable strings were being classified
        // correctly for free — scoring the answer key, not the string. The assumption
        // is also the realistic one: a platform that could not map the code generally
        // could not attribute the source either.
        failureSource: longTail ? "unknown" : sourceFor(trueFailureCode),
        nativeRecoveryState, profile, occurredAtMs, issuer: customer.issuer, priorFailures,
      });

      const nativeLogit = (assumptions.nativeLogitByCode[trueFailureCode] ?? -0.3)
        + Math.min(customer.baseSuccesses, 12) * 0.05
        - Math.min(failedPaymentCount, 6) * 0.09
        - Math.min(daysSinceLastSuccess, 180) * 0.004
        + Math.min(profile.subscriptionAgeDays, 720) * 0.0004
        + (nativeRecoveryState === "ACTIVE" ? 0.55 : 0);
      const nativeProbability = clamp(sigmoid(nativeLogit), 0.005, 0.995);

      const actionProbability = {} as Record<ActionProposal["action"], number>;
      const isHighValue = profile.customerValuePaise > rupees(20_000);
      for (const action of actionSchema.options) {
        let effect = hiddenInterventionEffect(action, trueFailureCode, nativeRecoveryState, profile);
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