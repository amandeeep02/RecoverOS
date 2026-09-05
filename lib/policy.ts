import { allowedActions, type ActionProposal, type CustomerProfile, type EIRScore, type MerchantPolicy, type PaymentEvent, type PolicyDecision } from "@/lib/domain";
import { assignArm, HOLDOUT_VALUE_CAP_PAISE } from "@/lib/experiment";
import { degradationKey } from "@/lib/degradation";
import { checkCompliance, checkEMandateDebit, isWithinTelemarketingWindow, type Channel, type ComplianceConfig, type ComplianceViolation } from "@/lib/compliance";

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
  degradationWindowId: string | null;
  episodeId: string;
  degradationDetector?: { isDegraded: (key: { method: string; issuer: string | null; network: string | null }) => { id: string; ratio: number; episodesHeld: number } | null };
  /** Wall-clock of the decision. Supplying it turns the regulatory gate ON: quiet
   *  hours become time-derived rather than trusting profile.contactWindowOpen, and
   *  DLT / WhatsApp / e-mandate checks run. Omitted (as the eval harness does today)
   *  the gate is skipped, so benchmark numbers are NOT silently changed by it.
   *  Enabling it in the eval is a deliberate, separately-measured change. */
  nowIso?: string;
  complianceConfig?: ComplianceConfig;
  /** Regulatory facts the policy cannot infer. Absent fields fail closed. */
  complianceContext?: {
    dltTemplateId?: string | null;
    whatsappOptedIn?: boolean;
    lastCustomerMessageAtIso?: string | null;
    whatsappTemplateId?: string | null;
    preDebitNotificationSentAtIso?: string | null;
    afaCompleted?: boolean;
    scheduledDebitAtIso?: string | null;
  };
};

const CHANNEL_FOR_ACTION: Record<string, Channel> = {
  REMINDER: "sms",
  PAYMENT_LINK: "whatsapp",
  VOICE_CALL: "voice",
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
  // profile.contactWindowOpen is a static flag nobody ever computed from a clock.
  // With nowIso present the real TRAI window governs and the flag becomes an AND.
  //
  // The two halves are kept separate because they are different facts and the audit
  // trail has to be able to tell them apart: one is a merchant preference the merchant
  // can change, the other is a regulation they cannot. Collapsed into a single boolean
  // — as they were — every quiet-hours refusal was recorded as
  // `outside_merchant_contact_window`, blaming the merchant for TRAI's rule and making
  // the regulatory refusal unattributable after the fact.
  const traiWindowOpen = input.nowIso ? isWithinTelemarketingWindow(input.nowIso, input.complianceConfig) : true;
  const withinContactWindow = input.profile.contactWindowOpen && traiWindowOpen;
  // Matches the `REGULATION:CODE` shape the compliance gate emits, so a consumer of
  // the audit trail sees one vocabulary for regulatory refusals regardless of which
  // check caught it first.
  const contactWindowReason = traiWindowOpen
    ? "outside_merchant_contact_window"
    : "TRAI_TCCCPR_2018:TRAI_QUIET_HOURS";
  const hasPhone = !!input.profile.phone;
  const eirAboveThreshold = input.eir.eirPaise >= input.policy.minimumEirPaise;
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

  // A human review costs ₹110. On a small ticket it cannot pay for itself, so an
  // escalation there is a guaranteed loss dressed up as caution. One rule, applied
  // to every escalation reason, rather than eight scattered value checks.
  const escalateOrStop = (reason: string): PolicyDecision =>
    input.event.amountPaise < (input.policy.minimumEscalationValuePaise ?? 0)
      ? approve(proposedAction, "STOP", checks, `${reason}__below_escalation_value`, undefined, input.policy.holdoutPct)
      : escalate(proposedAction, checks, reason, undefined, input.policy.holdoutPct);

  if (!actionKnown || !actionAllowed) {
    return reject(proposedAction, checks, "unsupported_or_disabled_action", undefined, input.policy.holdoutPct);
  }
  if (proposedAction === "ESCALATE" || input.diagnosisConfidence < 0.45) {
    return escalateOrStop("low_confidence_or_human_review_requested");
  }
  if (!attemptBudgetRemaining && !["WAIT", "STOP"].includes(proposedAction)) {
    return escalateOrStop("maximum_automated_attempts_reached");
  }
  if (input.event.paymentMethod === "card" && !nativeRecoveryComplete && proposedAction !== "WAIT" && proposedAction !== "STOP") {
    return approve(proposedAction, "WAIT", checks, "native_card_recovery_active", undefined, input.policy.holdoutPct);
  }

  // Suppression gate (T9) - check before experiment assignment
  if (input.eir.eirPaise < 0 && input.eir.eirWithoutChurnPaise >= input.policy.minimumEirPaise) {
    return suppress("DORMANCY_CHURN_RISK", proposedAction, checks, undefined, input.policy.holdoutPct);
  }
  if (input.eir.eirPaise < 0) {
    return suppress("NEGATIVE_EIR_OTHER", proposedAction, checks, undefined, input.policy.holdoutPct);
  }
  if (input.eir.eirPaise < input.policy.minimumEirPaise && !["WAIT", "STOP"].includes(proposedAction)) {
    return approve(proposedAction, "WAIT", checks, "eir_below_merchant_threshold", undefined, input.policy.holdoutPct);
  }
  if (proposedAction === "REMINDER") {
    if (input.policy.requireConsentForReminder && !consentValid) return escalateOrStop("contact_consent_missing_or_opted_out");
    if (!withinContactWindow) return escalateOrStop(contactWindowReason);
    if (!messageBudgetRemaining) return escalateOrStop("message_cap_reached");
  }
  if (proposedAction === "VOICE_CALL") {
    if (!hasPhone) return escalateOrStop("customer_phone_missing");
    if (!consentValid) return escalateOrStop("contact_consent_missing_or_opted_out");
    if (!withinContactWindow) return escalateOrStop(contactWindowReason);
    if (!voiceBudgetRemaining) return escalateOrStop("voice_call_cap_reached");
  }
  if (proposedAction === "RETRY" && !nativeRecoveryComplete) {
    return reject(proposedAction, checks, "native_recovery_has_not_ended", undefined, input.policy.holdoutPct);
  }

  // ===== REGULATORY GATE =====
  // Economics said yes; the regulator gets the next word. Deliberately AFTER the
  // value gates (so a refusal here is never confused with "not worth doing") and
  // BEFORE experiment assignment (an episode we may not legally touch must never
  // enter randomization — it would land in a treatment arm and go untreated,
  // biasing the estimate toward zero).
  if (input.nowIso) {
    const channel = CHANNEL_FOR_ACTION[proposedAction];
    const ctx = input.complianceContext ?? {};
    const isMandateDebit = proposedAction === "RETRY" && input.event.subscriptionId !== null;
    if (channel || isMandateDebit) {
      // The two regimes are composed separately and deliberately.
      //
      // A silent mandate retry SENDS NOTHING. It is governed by RBI's e-mandate
      // framework, not by TRAI quiet hours or DLT template registration. The
      // previous shape passed `channel ?? "sms"` into checkCompliance for a RETRY
      // while omitting the `sms` payload that only a real sms channel populated —
      // so the DLT check fell through to its absent-field branch and refused every
      // mandate retry on earth for want of a template it would never have used.
      // The gate had never been armed in the eval, so nothing caught it: measured
      // on 4,000 episodes, 1,376/1,376 approved RETRYs became REJECT, 1,422 of them
      // citing DLT_TEMPLATE_MISSING, plus quiet hours and DPDP contact gates applied
      // to an action that contacts nobody.
      const violations: ComplianceViolation[] = [];
      if (channel) {
        violations.push(...checkCompliance({
          channel,
          messageClass: "transactional",
          nowIso: input.nowIso,
          consentValid: input.profile.consentValid,
          optedOut: input.profile.optedOut,
          config: input.complianceConfig,
          ...(channel === "sms" ? { sms: { dltTemplateId: ctx.dltTemplateId ?? null } } : {}),
          ...(channel === "whatsapp" ? { whatsapp: {
            optedIn: ctx.whatsappOptedIn ?? false,
            lastCustomerMessageAtIso: ctx.lastCustomerMessageAtIso ?? null,
            templateId: ctx.whatsappTemplateId ?? null,
          } } : {}),
        }).violations);
      }
      if (isMandateDebit) {
        violations.push(...checkEMandateDebit({
          nowIso: input.nowIso,
          amountPaise: input.event.amountPaise,
          scheduledDebitAtIso: ctx.scheduledDebitAtIso ?? input.nowIso,
          preDebitNotificationSentAtIso: ctx.preDebitNotificationSentAtIso ?? null,
          afaCompleted: ctx.afaCompleted ?? false,
          config: input.complianceConfig,
        }).violations);
      }
      const seen = new Set<string>();
      const verdict = {
        allowed: violations.length === 0,
        violations: violations.filter((v) => (seen.has(v.code) ? false : (seen.add(v.code), true))),
      };
      if (!verdict.allowed) {
        const codes = verdict.violations.map((v) => v.code);
        return {
          outcome: "REJECT",
          proposedAction: proposedAction as PolicyDecision["proposedAction"],
          allowedAction: null,
          reasons: verdict.violations.map((v) => `${v.regulation}:${v.code}`),
          checks: { ...checks, actionAllowed: false },
          suppressionReason: null,
          degradationWindowId: null,
          policyVersionId: undefined,
          arm: undefined,
          holdoutPct: input.policy.holdoutPct,
          complianceViolations: codes,
        };
      }
    }
  }

  // ===== DEGRADATION GATE (T8) =====
  // Check issuer degradation BEFORE experiment assignment
  const degKey = degradationKey(input.event);
  const degWindow = input.degradationDetector?.isDegraded?.(degKey);
  if (degWindow) {
    degWindow.episodesHeld++;
    return {
      outcome: "ESCALATE",
      proposedAction: proposedAction as PolicyDecision["proposedAction"],
      allowedAction: "HELD_DEGRADED",
      reasons: [`Issuer degradation: ${degKey.method}|${degKey.issuer ?? "-"}|${degKey.network ?? "-"} at ${degWindow.ratio.toFixed(1)}× baseline`],
      checks: { ...checks, actionAllowed: false },
      suppressionReason: null,
      degradationWindowId: degWindow.id,
      policyVersionId: undefined,
      arm: undefined,
      holdoutPct: input.policy.holdoutPct,
    };
  }

  // ===== EXPERIMENT ASSIGNMENT (T6) =====
  // Step 3: Only randomize if we WOULD genuinely have acted
  const wouldAct = proposedAction !== "WAIT" && proposedAction !== "STOP" && proposedAction !== "SUPPRESSED" && proposedAction !== "HELD_DEGRADED";
  if (!wouldAct) {
    return approve(proposedAction, proposedAction as PolicyDecision["allowedAction"], checks, "all_policy_checks_passed", undefined, input.policy.holdoutPct);
  }

  // Step 4: Value cap - never hold out high-value episodes
  const amountPaise = input.event.amountPaise;
  if (amountPaise > HOLDOUT_VALUE_CAP_PAISE) {
    return approve(proposedAction, proposedAction as PolicyDecision["allowedAction"], checks, "all_policy_checks_passed", "TREATMENT", input.policy.holdoutPct);
  }

  // Step 5: Randomize only the eligible
  // Randomize on the CUSTOMER, not the episode. Contact fatigue is per-customer, so
  // splitting one customer's episodes across arms lets treatment interfere with
  // control (a SUTVA violation) and biases the measured lift. Every caller already
  // supplies `event`, so this needs no signature change.
  const arm = assignArm(input.event.customerId, input.policy.holdoutPct ?? 0);
  if (arm === "HOLDOUT") {
    return {
      outcome: "ESCALATE",
      proposedAction: proposedAction as PolicyDecision["proposedAction"],
      allowedAction: "HELD_OUT",
      reasons: ["experiment_holdout"],
      checks: { ...checks, actionAllowed: false },
      suppressionReason: null,
      degradationWindowId: null,
      policyVersionId: undefined,
      arm: "HOLDOUT",
    };
  }

  // Step 6: Proceed to execution as normal
  return approve(proposedAction, proposedAction as PolicyDecision["allowedAction"], checks, "all_policy_checks_passed", "TREATMENT", input.policy.holdoutPct);
}

function approve(
  proposedAction: string,
  allowedAction: PolicyDecision["allowedAction"],
  checks: PolicyDecision["checks"],
  reason: string,
  arm: "TREATMENT" | "HOLDOUT" | undefined = undefined,
  holdoutPct: number | undefined = undefined,
): PolicyDecision {
  return { outcome: "APPROVE", proposedAction: proposedAction as PolicyDecision["proposedAction"], allowedAction, reasons: [reason], checks, suppressionReason: null, degradationWindowId: null, policyVersionId: undefined, arm, holdoutPct };
}

function reject(proposedAction: string, checks: PolicyDecision["checks"], reason: string, arm: "TREATMENT" | "HOLDOUT" | undefined = undefined, holdoutPct: number | undefined = undefined): PolicyDecision {
  return { outcome: "REJECT", proposedAction: proposedAction as PolicyDecision["proposedAction"], allowedAction: null, reasons: [reason], checks, suppressionReason: null, degradationWindowId: null, policyVersionId: undefined, arm, holdoutPct };
}

function escalate(proposedAction: string, checks: PolicyDecision["checks"], reason: string, arm: "TREATMENT" | "HOLDOUT" | undefined = undefined, holdoutPct: number | undefined = undefined): PolicyDecision {
  return { outcome: "ESCALATE", proposedAction: proposedAction as PolicyDecision["proposedAction"], allowedAction: "ESCALATE", reasons: [reason], checks, suppressionReason: null, degradationWindowId: null, policyVersionId: undefined, arm, holdoutPct };
}

function suppress(suppressionReason: "DORMANCY_CHURN_RISK" | "NEGATIVE_EIR_OTHER", proposedAction: string, checks: PolicyDecision["checks"], arm: "TREATMENT" | "HOLDOUT" | undefined = undefined, holdoutPct: number | undefined = undefined): PolicyDecision {
  return {
    outcome: "ESCALATE",
    proposedAction: proposedAction as PolicyDecision["proposedAction"],
    allowedAction: "ESCALATE",
    reasons: [suppressionReason],
    checks: { ...checks, actionAllowed: false },
    suppressionReason,
    degradationWindowId: null,
    policyVersionId: undefined,
    arm,
    holdoutPct,
  };
}

export function isExecutableAction(action: PolicyDecision["allowedAction"]) {
  return action === "PAYMENT_LINK" || action === "REMINDER" || action === "RETRY" || action === "VOICE_CALL";
}