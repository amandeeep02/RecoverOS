import {
  clampProbability,
  type ActionProposal,
  type CustomerProfile,
  type Diagnosis,
  type EIRScore,
  type MerchantPolicy,
  type PaymentEvent,
  type RecoveryPrediction,
} from "@/lib/domain";

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
  PAYMENT_LINK: 12,
  REMINDER: 4,
  ESCALATE: 110,
  STOP: 0,
  RETRY: 3,
  VOICE_CALL: 8,
};

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

  const isHighValue = profile.customerValueInr > 20_000 || event.amountInr > 10_000;
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
      amount_inr: event.amountInr,
      failure_type: diagnosis.category,
      successful_payment_count: profile.successfulPaymentCount,
      failed_payment_count: profile.failedPaymentCount,
      previous_recovery_rate: profile.previousRecoveryRate,
      subscription_age_days: profile.subscriptionAgeDays,
      customer_value_inr: profile.customerValueInr,
      days_since_last_success: profile.daysSinceLastSuccess,
    },
  };
}

export function calculateEir(
  action: ActionProposal["action"],
  amountInr: number,
  prediction: Pick<RecoveryPrediction, "pRecoverNative" | "pRecoverWithAction">,
): EIRScore {
  const incrementalLift = prediction.pRecoverWithAction - prediction.pRecoverNative;
  return {
    action,
    amountInr,
    interventionCostInr: interventionCosts[action],
    incrementalLift,
    eirInr: Math.round(incrementalLift * amountInr - interventionCosts[action]),
  };
}

export function proposalFor(
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
  const highValue = profile.customerValueInr > 20_000 || event.amountInr > 10_000;
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
