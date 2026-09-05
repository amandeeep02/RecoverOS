import {
  clampProbability,
  type ActionProposal,
  type CustomerProfile,
  type Diagnosis,
  type EIRScore,
  type MerchantPolicy,
  type PaymentEvent,
  type RecoveryPrediction,
  rupees,
  scale,
  formatInr,
  assertPaise,
} from "@/lib/domain";

export { rupees } from "@/lib/domain";

const nativeBase: Record<Diagnosis["category"], number> = {
  insufficient_balance: 0.22,
  expired_payment_credential: 0.03,
  temporary_bank_decline: 0.48,
  permanent_decline: 0.01,
  authentication_issue: 0.07,
  mandate_issue: 0.02,
  network_gateway_failure: 0.5,
  unknown: 0.2,
};

const actionLift: Record<Diagnosis["category"], number> = {
  insufficient_balance: 0.28,
  expired_payment_credential: 0.38,
  temporary_bank_decline: 0.15,
  permanent_decline: 0.01,
  authentication_issue: 0.32,
  mandate_issue: 0.22,
  network_gateway_failure: 0.01,
  unknown: 0.06,
};

export const interventionCosts: Record<ActionProposal["action"], number> = {
  WAIT: 0,
  PAYMENT_LINK: rupees(12),
  REMINDER: rupees(4),
  ESCALATE: rupees(110),
  STOP: 0,
  RETRY: rupees(3),
  VOICE_CALL: rupees(8),
  HELD_OUT: 0,
  HELD_DEGRADED: 0,
};

const DORMANCY_CHURN_CURVE: [number, number][] = [
  [0, 0.0], [30, 0.0], [60, 0.01], [120, 0.04], [180, 0.09], [365, 0.15],
];

function interpolateChurn(days: number): number {
  // Guard the low end explicitly. Without this a negative value matches no interval
  // and falls through to the final `return`, yielding the MAXIMUM hazard for a
  // customer who engaged today — inverting the entire dormancy model.
  if (days <= DORMANCY_CHURN_CURVE[0][0]) return DORMANCY_CHURN_CURVE[0][1];
  for (let i = 0; i < DORMANCY_CHURN_CURVE.length - 1; i++) {
    const [d1, c1] = DORMANCY_CHURN_CURVE[i];
    const [d2, c2] = DORMANCY_CHURN_CURVE[i + 1];
    if (days >= d1 && days <= d2) {
      const t = (days - d1) / (d2 - d1);
      return c1 + t * (c2 - c1);
    }
  }
  return DORMANCY_CHURN_CURVE[DORMANCY_CHURN_CURVE.length - 1][1];
}

/**
 * Cancellation hazard the model adds for EACH prior contact to this customer, on
 * top of the dormancy curve. Merchant-overridable via
 * `MerchantPolicy.contactFatigueChurnPerContact`.
 *
 * **Where this number did NOT come from.** It is not imported from, read from, or
 * copied out of `lib/simulator.ts`. The world carries its own fatigue constant as
 * part of the hidden truth; lifting it would make this model a transcription of
 * the answer key and every result downstream circular. This value is not equal to
 * the world's, and the plateau below is the reason that does not matter.
 *
 * **The prior.** Derived from this model's own dormancy curve, our only written
 * statement about what makes a subscriber cancel: silence costs 0.01 of hazard by
 * day 60 and 0.04 by day 120 — roughly 0.015 per extra 30-day billing period in
 * the range where dormancy starts to bite. Believing that one unwanted dunning
 * contact is about as corrosive as one extra billing period of silence gives
 * **0.015**. That was the pre-registered guess.
 *
 * **The measurement, and where the prior was wrong.** Swept on seeds 1–5 and
 * confirmed on seeds 6–20, which played no part in selection. Net value rises
 * monotonically in this parameter and then *saturates* from ~0.03 upward: 0.05,
 * 0.2 and 0.5 all produce the same decisions to within noise (paired Δ ₹1,868,
 * CI [−₹2,343, ₹6,078], 3/5). The prior under-weighted contact fatigue by roughly
 * three-fold, the same direction and magnitude by which `churnAversion` was
 * previously found to under-weight dormancy.
 *
 * **What the saturation means, stated plainly.** At 0.05 this term is no longer a
 * ranker; it is a hard rule — "do not make a second contact to the same customer
 * inside the fatigue window" — expressed through the hazard. Most of the money it
 * earns is that ban, not graded targeting. Anyone reading the ledger should know
 * which of the two they bought. The upside of sitting on a plateau is that the
 * result does not depend on the constant: any value from 0.03 to 0.5 buys the same
 * decisions, so it cannot have been fitted to a particular hidden number.
 */
export const DEFAULT_CONTACT_FATIGUE_CHURN_PER_CONTACT = 0.05;

function residualLtv(profile: CustomerProfile, amountPaise: number): number {
  if (!profile.isSubscription) return 0;
  const expectedRemainingPeriods = Math.min(
    6, Math.max(0, 6 - Math.floor((profile.daysSinceLastEngagement ?? profile.daysSinceLastSuccess) / 60))
  );
  return amountPaise * expectedRemainingPeriods;
}

/**
 * Transparent, deterministic first model. Its inputs are observable operational
 * features only; hidden simulator probabilities never enter this function.
 */
export function scoreRecovery(
  event: PaymentEvent,
  profile: CustomerProfile,
  diagnosis: Diagnosis,
  action: ActionProposal["action"],
): RecoveryPrediction {
  const historySignal = Math.min(0.15, profile.successfulPaymentCount * 0.009) - Math.min(0.12, profile.failedPaymentCount * 0.018);
  const loyaltySignal = Math.min(0.08, profile.subscriptionAgeDays / 3650) + (profile.previousRecoveryRate - 0.5) * 0.08;
  const recencyPenalty = Math.min(0.13, profile.daysSinceLastSuccess / 900);
  const cardNativeBoost = event.paymentMethod === "card" && event.nativeRecoveryState === "ACTIVE" ? 0.12 : 0;
  const native = clampProbability(nativeBase[diagnosis.category] + historySignal + loyaltySignal - recencyPenalty + cardNativeBoost);

  const isHighValue = profile.customerValuePaise > rupees(20_000) || event.amountPaise > rupees(10_000);
  const actionMultiplier = action === "WAIT" || action === "STOP" || action === "ESCALATE" ? 0 : action === "REMINDER" ? 0.65 : action === "RETRY" ? 0.32 : action === "VOICE_CALL" ? (isHighValue ? 1.1 : 0.85) : 1;
  const voiceBonus = action === "VOICE_CALL" && isHighValue ? 0.08 : 0;
  const confidenceAdjustment = diagnosis.certaintyClass === "unknown" ? -0.035 : 0;
  const actionProbability = clampProbability(native + actionLift[diagnosis.category] * actionMultiplier + confidenceAdjustment + voiceBonus);

  return {
    pRecoverNative: native,
    pRecoverWithAction: actionProbability,
    confidence: Math.min(0.96, 0.48 + diagnosis.confidence * 0.46),
    modelVersion: "transparent-v1",
    featureSnapshot: {
      payment_method: event.paymentMethod,
      amount_paise: event.amountPaise,
      failure_type: diagnosis.category,
      successful_payment_count: profile.successfulPaymentCount,
      failed_payment_count: profile.failedPaymentCount,
      previous_recovery_rate: profile.previousRecoveryRate,
      subscription_age_days: profile.subscriptionAgeDays,
      customer_value_paise: profile.customerValuePaise,
      days_since_last_success: profile.daysSinceLastSuccess,
    },
  };
}

export function calculateEir(
  action: ActionProposal["action"],
  amountPaise: number,
  prediction: Pick<RecoveryPrediction, "pRecoverNative" | "pRecoverWithAction">,
  profile: CustomerProfile,
  churnAversion = 1,
  contactFatigueChurnPerContact = DEFAULT_CONTACT_FATIGUE_CHURN_PER_CONTACT,
): EIRScore {
  assertPaise(amountPaise, "amountPaise");
  const incrementalLift = prediction.pRecoverWithAction - prediction.pRecoverNative;
  const costPaise = interventionCosts[action];
  const eirWithoutChurnPaise = scale(amountPaise, incrementalLift) - costPaise;

  let deltaPChurn = 0;
  let residualLtvPaise = 0;
  let churnCostPaise = 0;

  const isContactAction = ["REMINDER", "VOICE_CALL", "PAYMENT_LINK"].includes(action);
  if (profile.isSubscription && isContactAction) {
    const days = profile.daysSinceLastEngagement ?? profile.daysSinceLastSuccess;
    // Dormancy is what silence costs. Fatigue is what NOISE costs, and until this
    // term existed the churn model priced only the first: two customers equally
    // dormant scored identically whether we had contacted them five times this
    // quarter or never. The count is per-customer and observable — `bestAction`'s
    // callers thread it in from the arm's / the store's real contact history — so
    // treating it as unobservable was a modelling omission, not a data limit.
    const priorContacts = Math.max(0, profile.previousInterventionCount);
    deltaPChurn = Math.min(1, interpolateChurn(days) + priorContacts * contactFatigueChurnPerContact);
    residualLtvPaise = residualLtv(profile, amountPaise);
    // NOTE the ordering: `deltaPChurn` is the model's FACE VALUE, fatigue included,
    // and `churnAversion` multiplies it only here, inside the decision. Anything we
    // later CLAIM to have protected must be booked at `deltaPChurn`, never at this
    // product — see `churnCostUnscaledPaise`. Folding aversion into the hazard would
    // inflate the ledger by exactly (aversion − 1), and the fatigue term makes that
    // mistake bigger rather than announcing itself.
    churnCostPaise = scale(residualLtvPaise, deltaPChurn * churnAversion);
  }

  const eirPaise = eirWithoutChurnPaise - churnCostPaise;

  return {
    action,
    amountPaise,
    interventionCostPaise: costPaise,
    incrementalLift,
    eirPaise: Math.round(eirPaise),
    eirWithoutChurnPaise: Math.round(eirWithoutChurnPaise),
    deltaPChurn,
    residualLtvPaise,
    churnCostPaise,
  };
}

export type CandidateScore = {
  action: ActionProposal["action"];
  /** Present when the action was scored. Absent when it was never feasible. */
  eirPaise?: number;
  eirWithoutChurnPaise?: number;
  /** Churn cost AS USED IN THE DECISION — includes policy.churnAversion. */
  churnCostPaise?: number;
  /** Churn cost at the model's face value, aversion multiplier removed. This is
   *  what we may CLAIM to have protected; the multiplied figure is a safety margin
   *  we chose, and booking our own conservatism as recovered value would inflate
   *  the ledger by exactly (aversion - 1). */
  churnCostUnscaledPaise?: number;
  /** Set when a precondition removed it from the set — a constraint, not a value loss. */
  excludedBy?: string;
};

export type ActionChoice = {
  proposal: ActionProposal;
  eir: EIRScore;
  /** Residual subscription value preserved because the winner was a NON-contact
   *  action and the contact action it displaced would have destroyed more than it
   *  recovered. Zero unless churn is the reason contact lost. */
  protectedPaise: number;
  /** Gross incremental recovery given up to buy that protection. Both sides of the
   *  bet, or neither — reporting protection alone would be marketing. */
  forgonePaise: number;
  /** Everything considered and why each lost. This is the audit trail Track 3 asks
   *  for: not "we chose X" but "we considered X, Y, Z, and here is each one's number." */
  candidates: CandidateScore[];
};

const CONTACT_ACTIONS: ActionProposal["action"][] = ["REMINDER", "PAYMENT_LINK", "VOICE_CALL"];
const CANDIDATE_ACTIONS: ActionProposal["action"][] = ["RETRY", "REMINDER", "PAYMENT_LINK", "VOICE_CALL"];

function hardOverride(
  event: PaymentEvent,
  diagnosis: Diagnosis,
): ActionProposal | null {
  if (diagnosis.certaintyClass === "unknown" || diagnosis.confidence < 0.45) {
    return { action: "ESCALATE", confidence: diagnosis.confidence, reasonCodes: ["low_diagnosis_confidence"],
      explanation: "This failure lacks a sufficiently supported cause for autonomous customer contact.",
      draftedMessage: null, source: "deterministic" };
  }
  if (event.paymentMethod === "card" && event.nativeRecoveryState === "ACTIVE") {
    return { action: "WAIT", confidence: 0.88, reasonCodes: ["native_card_recovery_active"],
      explanation: "The issuer's own card-recovery window is active; intervening now is unlikely to be incremental.",
      draftedMessage: null, source: "deterministic" };
  }
  if (diagnosis.category === "permanent_decline") {
    return { action: "STOP", confidence: 0.95, reasonCodes: ["terminal_decline"],
      explanation: "The structured signal indicates a terminal decline, so more automated recovery is not justified.",
      draftedMessage: null, source: "deterministic" };
  }
  if (diagnosis.category === "network_gateway_failure") {
    return { action: "WAIT", confidence: 0.8, reasonCodes: ["transient_rail_issue"],
      explanation: "A transient rail issue is more likely to resolve through native recovery than customer contact.",
      draftedMessage: null, source: "deterministic" };
  }
  return null;
}

/**
 * Chooses the action by ARGMAX over expected incremental recovery, not by picking
 * one candidate and then vetoing it.
 *
 * The distinction is the whole point. Scoring a single pre-chosen action makes EIR a
 * veto: when contact is too risky the fallback becomes *nothing*, forfeiting a cheap
 * non-contact action that was still worth taking. Measurement attributed roughly
 * three quarters of this agent's shortfall against a silent-retry baseline to exactly
 * that. Here WAIT sits in the candidate set at EIR 0, so "doing nothing is better than
 * acting" falls out of the comparison instead of needing a separate gate.
 *
 * Preconditions REMOVE an action from the set rather than penalising it — a customer
 * with no phone is not a bad voice-call candidate, they are not a candidate at all.
 * Exhausted caps drop only the capped action, so a spent message budget lets a payment
 * link or a retry win instead of escalating the whole episode to a ₹110 human review.
 */
export function bestAction(
  event: PaymentEvent,
  diagnosis: Diagnosis,
  profile: CustomerProfile,
  policy: MerchantPolicy,
  caps: { automatedAttemptCount: number; reminderCount: number; voiceCallCount: number } =
    { automatedAttemptCount: 0, reminderCount: 0, voiceCallCount: 0 },
): ActionChoice {
  const fatiguePerContact = policy.contactFatigueChurnPerContact ?? DEFAULT_CONTACT_FATIGUE_CHURN_PER_CONTACT;
  const override = hardOverride(event, diagnosis);
  if (override) {
    const eir = calculateEir(override.action, event.amountPaise, { pRecoverNative: 0, pRecoverWithAction: 0 }, profile, policy.churnAversion, fatiguePerContact);
    return { proposal: override, eir, protectedPaise: 0, forgonePaise: 0, candidates: [{ action: override.action, excludedBy: "hard_override" }] };
  }

  const contactPermitted = profile.consentValid && !profile.optedOut && profile.contactWindowOpen;
  const candidates: CandidateScore[] = [];
  let best: { action: ActionProposal["action"]; eir: EIRScore; prediction: ReturnType<typeof scoreRecovery> } | null = null;

  for (const action of CANDIDATE_ACTIONS) {
    const excludedBy =
      action === "RETRY" && !policy.allowRetry ? "merchant_disallows_retry"
      : action === "PAYMENT_LINK" && !policy.allowPaymentLinks ? "merchant_disallows_payment_links"
      : action === "VOICE_CALL" && !(policy.allowVoiceCalls ?? false) ? "merchant_disallows_voice"
      : action === "VOICE_CALL" && !profile.phone ? "customer_phone_missing"
      : CONTACT_ACTIONS.includes(action) && !contactPermitted ? "contact_not_permitted"
      : action === "REMINDER" && caps.reminderCount >= policy.maxMessagesPerEpisode ? "message_cap_reached"
      : action === "VOICE_CALL" && caps.voiceCallCount >= (policy.maxVoiceCallsPerEpisode ?? 1) ? "voice_call_cap_reached"
      : caps.automatedAttemptCount >= policy.maxAutomatedAttempts ? "attempt_cap_reached"
      : undefined;
    if (excludedBy) { candidates.push({ action, excludedBy }); continue; }

    const prediction = scoreRecovery(event, profile, diagnosis, action);
    const eir = calculateEir(action, event.amountPaise, prediction, profile, policy.churnAversion, fatiguePerContact);
    candidates.push({
      action,
      eirPaise: eir.eirPaise,
      eirWithoutChurnPaise: eir.eirWithoutChurnPaise,
      churnCostPaise: eir.churnCostPaise,
      churnCostUnscaledPaise: Math.round(eir.residualLtvPaise * eir.deltaPChurn),
    });
    // Ties break toward the cheaper action: identical expected value should not buy
    // a more intrusive contact than necessary.
    if (!best || eir.eirPaise > best.eir.eirPaise
      || (eir.eirPaise === best.eir.eirPaise && eir.interventionCostPaise < best.eir.interventionCostPaise)) {
      best = { action, eir, prediction };
    }
  }

  const waitEir = calculateEir("WAIT", event.amountPaise, { pRecoverNative: 0, pRecoverWithAction: 0 }, profile, policy.churnAversion, fatiguePerContact);
  candidates.push({ action: "WAIT", eirPaise: 0 });

  // WAIT wins. But *why* it won is the difference between "nothing was worth doing"
  // and "the one thing worth doing would have cost us the customer" — and only the
  // second is the Protected Ledger. Without this the suppression path becomes
  // unreachable the moment WAIT joins the candidate set, and the restraint story
  // silently reports zero while appearing to work.
  // ---- the dormancy bet, priced against the action actually taken ----------
  // Originally this only fired when the agent chose to do NOTHING. With a cheap
  // churn-free RETRY in the candidate set that case essentially disappeared: the
  // agent does not fall silent, it switches rails. Restraint is still happening and
  // still has a price, but the mechanism is "picked a non-contact action over a
  // contact one" — so that is what gets measured. Measured on 20k episodes: 0 fired
  // under the old definition, ~4.9k under this one.
  const contactCandidates = candidates.filter(
    (c) => CONTACT_ACTIONS.includes(c.action) && c.eirPaise !== undefined,
  );
  const winnerEir = best ? best.eir.eirPaise : 0;
  const winnerIsContact = best ? CONTACT_ACTIONS.includes(best.action) : false;
  let protectedPaise = 0;
  let forgonePaise = 0;
  let churnDemoted: CandidateScore | null = null;
  if (!winnerIsContact && contactCandidates.length > 0) {
    // The contact action that would have won on GROSS recovery, ignoring churn.
    const byGross = contactCandidates.reduce((a, b) =>
      (b.eirWithoutChurnPaise ?? 0) > (a.eirWithoutChurnPaise ?? 0) ? b : a);
    const gross = byGross.eirWithoutChurnPaise ?? 0;
    // It lost, and churn is why: on gross it beat the winner, net of churn it did not.
    if (gross > winnerEir && (byGross.eirPaise ?? 0) <= winnerEir) {
      churnDemoted = byGross;
      // Face value, not the averted-with-margin figure the decision used.
      protectedPaise = byGross.churnCostUnscaledPaise ?? 0;
      forgonePaise = Math.max(0, gross - winnerEir);
    }
  }

  if (!best || best.eir.eirPaise <= 0) {
    const churnSuppressed = best
      && best.eir.eirWithoutChurnPaise >= policy.minimumEirPaise
      && best.eir.eirPaise < 0;
    return {
      proposal: {
        action: "WAIT",
        confidence: diagnosis.confidence,
        reasonCodes: churnSuppressed
          ? ["DORMANCY_CHURN_RISK", best!.action]
          : ["no_action_beats_waiting"],
        explanation: churnSuppressed
          ? `${best!.action} would add ${formatInr(best!.eir.eirWithoutChurnPaise)} of expected recovery, but contacting this dormant subscriber risks ${formatInr(best!.eir.churnCostPaise)} of remaining subscription value. Staying quiet is worth more.`
          : "No available action has positive expected incremental value over native recovery.",
        draftedMessage: null,
        source: "deterministic",
      },
      // Carry the suppressed candidate's economics so the policy can book both sides
      // of the bet rather than recording an empty WAIT.
      eir: churnSuppressed ? best!.eir : waitEir,
      protectedPaise: churnSuppressed ? Math.round(best!.eir.residualLtvPaise * best!.eir.deltaPChurn) : protectedPaise,
      forgonePaise: churnSuppressed ? Math.max(0, best!.eir.eirWithoutChurnPaise) : forgonePaise,
      candidates,
    };
  }

  const isHighValue = profile.customerValuePaise > rupees(20_000) || event.amountPaise > rupees(10_000);
  return {
    proposal: {
      action: best.action,
      confidence: Math.min(0.94, diagnosis.confidence + 0.02),
      reasonCodes: churnDemoted
        ? ["argmax_expected_incremental_recovery", "DORMANCY_CHURN_RISK", `displaced:${churnDemoted.action}`, diagnosis.category]
        : ["argmax_expected_incremental_recovery", diagnosis.category, isHighValue ? "high_value_customer" : "standard_recovery"],
      explanation: `${best.action} has the highest expected incremental recovery (${formatInr(best.eir.eirPaise)}) among ${candidates.filter((c) => c.eirPaise !== undefined).length} feasible actions, net of cost and churn risk.`,
      draftedMessage: best.action === "REMINDER"
        ? "Your subscription payment needs attention. Complete it securely using the link in your account."
        : best.action === "VOICE_CALL" ? "Voice call script generated at execution time" : null,
      source: "deterministic",
    },
    eir: best.eir,
    protectedPaise,
    forgonePaise,
    candidates,
  };
}

/** Back-compatible wrapper over `bestAction`. Prefer `bestAction` at new call sites:
 *  it also returns the winning EIR and the full scored candidate list, so callers stop
 *  recomputing the score for an action the chooser already evaluated. */
export function proposalFor(
  event: PaymentEvent,
  diagnosis: Diagnosis,
  profile: CustomerProfile,
  merchantCapabilities: Pick<MerchantPolicy, "allowRetry"> | MerchantPolicy = { allowRetry: false },
): ActionProposal {
  const policy: MerchantPolicy = "merchantId" in merchantCapabilities
    ? merchantCapabilities as MerchantPolicy
    : { ...merchantPolicyDefaults(), allowRetry: merchantCapabilities.allowRetry };
  return bestAction(event, diagnosis, profile, policy).proposal;
}

function merchantPolicyDefaults(): MerchantPolicy {
  return {
    merchantId: "unknown", minimumEirPaise: rupees(150), maxAutomatedAttempts: 3,
    maxMessagesPerEpisode: 2, maxVoiceCallsPerEpisode: 1, allowRetry: false,
    allowPaymentLinks: true, allowVoiceCalls: true, requireConsentForReminder: true,
    highValueEscalationThresholdPaise: rupees(50_000), dltTemplateId: "RECOVEROS_TXN_PAYMENT_FAILED_V1", dltSenderHeader: "RCVROS", preDebitNotificationByPlatform: true, minimumEscalationValuePaise: rupees(2_500),
    churnAversion: 1, holdoutPct: 5,
  };
}

function legacyProposalFor(
  event: PaymentEvent,
  diagnosis: Diagnosis,
  profile: CustomerProfile,
  merchantCapabilities: Pick<MerchantPolicy, "allowRetry"> = { allowRetry: false },
): ActionProposal {
  if (diagnosis.certaintyClass === "unknown" || diagnosis.confidence < 0.45) {
    return {
      action: "ESCALATE",
      confidence: diagnosis.confidence,
      reasonCodes: ["low_diagnosis_confidence"],
      explanation: "This failure lacks a sufficiently supported cause for autonomous customer contact.",
      draftedMessage: null,
      source: "deterministic",
    };
  }
  if (event.paymentMethod === "card" && event.nativeRecoveryState === "ACTIVE") {
    return {
      action: "WAIT",
      confidence: 0.88,
      reasonCodes: ["native_card_recovery_active"],
      explanation: "Razorpay's native card recovery window is active; intervening now is unlikely to be incremental.",
      draftedMessage: null,
      source: "deterministic",
    };
  }
  if (diagnosis.category === "permanent_decline") {
    return {
      action: "STOP",
      confidence: 0.95,
      reasonCodes: ["terminal_decline"],
      explanation: "The structured signal indicates a terminal decline, so more automated recovery is not justified.",
      draftedMessage: null,
      source: "deterministic",
    };
  }
  if (diagnosis.category === "network_gateway_failure") {
    return {
      action: "WAIT",
      confidence: 0.8,
      reasonCodes: ["transient_rail_issue"],
      explanation: "A transient rail issue is more likely to resolve through native recovery than through customer contact.",
      draftedMessage: null,
      source: "deterministic",
    };
  }
  if (diagnosis.category === "temporary_bank_decline" && merchantCapabilities.allowRetry) {
    return {
      action: "RETRY",
      confidence: Math.min(0.93, diagnosis.confidence),
      reasonCodes: ["temporary_decline", "merchant_retry_enabled"],
      explanation: "The native lifecycle has ended and the merchant explicitly permits one constrained retry for this temporary issuer decline.",
      draftedMessage: null,
      source: "deterministic",
    };
  }
  const prefersReminder = diagnosis.category === "insufficient_balance" && profile.consentValid && !profile.optedOut;
  const highValue = profile.customerValuePaise > rupees(20_000) || event.amountPaise > rupees(10_000);
  const voiceAppropriate = highValue && profile.phone && profile.consentValid && !profile.optedOut;
  return {
    action: voiceAppropriate ? "VOICE_CALL" : prefersReminder ? "REMINDER" : "PAYMENT_LINK",
    confidence: Math.min(0.94, diagnosis.confidence + 0.02),
    reasonCodes: ["native_recovery_exhausted", diagnosis.category, voiceAppropriate ? "high_value_customer" : "standard_recovery"],
    explanation: voiceAppropriate
      ? "High-value customer with phone consent; a personal Hinglish voice call maximizes recovery probability."
      : prefersReminder
      ? "A low-friction reminder is expected to create incremental recovery after native recovery has ended."
      : "A secure payment link can address the failed credential or authentication path after native recovery has ended.",
    draftedMessage: voiceAppropriate ? "Voice call script generated via ElevenLabs Hinglish TTS" : prefersReminder ? "Your subscription payment needs attention. Complete it securely using the link in your account." : null,
    source: "deterministic",
  };
}