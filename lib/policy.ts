import { allowedActions, type ActionProposal, type CustomerProfile, type EIRScore, type MerchantPolicy, type PaymentEvent, type PolicyDecision } from "@/lib/domain";

type PolicyInput = {
  event: PaymentEvent;
  profile: CustomerProfile;
  proposal: Pick<ActionProposal, "action" | "confidence"> | { action: string; confidence: number };
  eir: EIRScore;
  policy: MerchantPolicy;
  automatedAttemptCount: number;
  reminderCount: number;
  voiceCallCount: number;
  diagnosisConfidence: number;
};

/** The policy boundary is deliberately deterministic and has no model, prompt, or credentials. */
export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const proposedAction = input.proposal.action;
  const actionKnown = allowedActions.includes(proposedAction as (typeof allowedActions)[number]);
  const nativeRecoveryComplete = input.event.nativeRecoveryState !== "ACTIVE";
  const attemptBudgetRemaining = input.automatedAttemptCount < input.policy.maxAutomatedAttempts;
  const messageBudgetRemaining = input.reminderCount < input.policy.maxMessagesPerEpisode;
  const voiceBudgetRemaining = input.voiceCallCount < (input.policy.maxVoiceCallsPerEpisode ?? 1);
  const consentValid = input.profile.consentValid && !input.profile.optedOut;
  const withinContactWindow = input.profile.contactWindowOpen;
  const hasPhone = !!input.profile.phone;
  const eirAboveThreshold = input.eir.eirInr >= input.policy.minimumEirInr;
  const actionAllowed = actionKnown
    && !(proposedAction === "RETRY" && !input.policy.allowRetry)
    && !(proposedAction === "PAYMENT_LINK" && !input.policy.allowPaymentLinks)
    && !(proposedAction === "VOICE_CALL" && !(input.policy.allowVoiceCalls ?? false));
  const checks = {
    eirAboveThreshold,
    attemptBudgetRemaining,
    nativeRecoveryComplete,
    consentValid,
    withinContactWindow,
    messageBudgetRemaining,
    voiceBudgetRemaining,
    hasPhone,
    actionAllowed,
  };

  if (!actionKnown || !actionAllowed) {
    return reject(proposedAction, checks, "unsupported_or_disabled_action");
  }
  if (proposedAction === "ESCALATE" || input.diagnosisConfidence < 0.45) {
    return escalate(proposedAction, checks, "low_confidence_or_human_review_requested");
  }
  if (!attemptBudgetRemaining && !["WAIT", "STOP"].includes(proposedAction)) {
    return escalate(proposedAction, checks, "maximum_automated_attempts_reached");
  }
  if (input.event.paymentMethod === "card" && !nativeRecoveryComplete && proposedAction !== "WAIT" && proposedAction !== "STOP") {
    return approve(proposedAction, "WAIT", checks, "native_card_recovery_active");
  }
  if (!eirAboveThreshold && !["WAIT", "STOP"].includes(proposedAction)) {
    return approve(proposedAction, "STOP", checks, "eir_below_merchant_threshold");
  }
  if (proposedAction === "REMINDER") {
    if (input.policy.requireConsentForReminder && !consentValid) return escalate(proposedAction, checks, "contact_consent_missing_or_opted_out");
    if (!withinContactWindow) return escalate(proposedAction, checks, "outside_merchant_contact_window");
    if (!messageBudgetRemaining) return escalate(proposedAction, checks, "message_cap_reached");
  }
  if (proposedAction === "VOICE_CALL") {
    if (!hasPhone) return escalate(proposedAction, checks, "customer_phone_missing");
    if (!consentValid) return escalate(proposedAction, checks, "contact_consent_missing_or_opted_out");
    if (!withinContactWindow) return escalate(proposedAction, checks, "outside_merchant_contact_window");
    if (!voiceBudgetRemaining) return escalate(proposedAction, checks, "voice_call_cap_reached");
  }
  if (proposedAction === "RETRY" && !nativeRecoveryComplete) {
    return reject(proposedAction, checks, "native_recovery_has_not_ended");
  }
  return approve(proposedAction, proposedAction as PolicyDecision["allowedAction"], checks, "all_policy_checks_passed");
}

function approve(
  proposedAction: string,
  allowedAction: PolicyDecision["allowedAction"],
  checks: PolicyDecision["checks"],
  reason: string,
): PolicyDecision {
  return { outcome: "APPROVE", proposedAction: proposedAction as PolicyDecision["proposedAction"], allowedAction, reasons: [reason], checks };
}

function reject(proposedAction: string, checks: PolicyDecision["checks"], reason: string): PolicyDecision {
  return { outcome: "REJECT", proposedAction: proposedAction as PolicyDecision["proposedAction"], allowedAction: null, reasons: [reason], checks };
}

function escalate(proposedAction: string, checks: PolicyDecision["checks"], reason: string): PolicyDecision {
  return { outcome: "ESCALATE", proposedAction: proposedAction as PolicyDecision["proposedAction"], allowedAction: "ESCALATE", reasons: [reason], checks };
}

export function isExecutableAction(action: PolicyDecision["allowedAction"]) {
  return action === "PAYMENT_LINK" || action === "REMINDER" || action === "RETRY" || action === "VOICE_CALL";
}
