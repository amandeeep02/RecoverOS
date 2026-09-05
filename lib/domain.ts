import { z } from "zod";
import { rupees, scale, assertPaise, type Paise } from "./money";

export { rupees, scale, assertPaise, type Paise } from "./money";

export const paymentMethodSchema = z.enum(["card", "upi", "netbanking", "wallet", "unknown"]);
export const failureSourceSchema = z.enum(["bank", "gateway", "customer", "mandate", "network", "unknown"]);
export const failureClassSchema = z.enum([
  "insufficient_balance",
  "expired_payment_credential",
  "temporary_bank_decline",
  "permanent_decline",
  "authentication_issue",
  "mandate_issue",
  "network_gateway_failure",
  "unknown",
]);
export const actionSchema = z.enum(["WAIT", "PAYMENT_LINK", "REMINDER", "ESCALATE", "STOP", "RETRY", "VOICE_CALL", "HELD_OUT", "HELD_DEGRADED"]);
export const nativeRecoveryStateSchema = z.enum(["ACTIVE", "EXHAUSTED", "NOT_ELIGIBLE", "UNKNOWN"]);
export const certaintySchema = z.enum(["known", "inferred", "unknown"]);
export const policyOutcomeSchema = z.enum(["APPROVE", "REJECT", "ESCALATE"]);
export const episodeStatusSchema = z.enum([
  "DETECTED",
  "DIAGNOSED",
  "SCORED",
  "PROPOSED",
  "POLICY_CHECK",
  "EXECUTING",
  "PENDING",
  "RECOVERED",
  "FAILED",
  "EXPIRED",
  "ESCALATED",
  "STOPPED",
  "PROMISED",
  "HELD_OUT",
  "HELD_DEGRADED",
  "SUPPRESSED",
]);

export const paymentEventSchema = z.object({
  eventId: z.string().min(1),
  eventType: z.enum(["payment.failed", "subscription.pending", "subscription.halted"]),
  occurredAt: z.string().datetime(),
  merchantId: z.string().min(1),
  customerId: z.string().min(1),
  paymentId: z.string().min(1),
  subscriptionId: z.string().nullable(),
  amountPaise: z.number().int().positive(),
  currency: z.literal("INR"),
  paymentMethod: paymentMethodSchema,
  failureCode: z.string().nullable(),
  failureSource: failureSourceSchema,
  nativeRecoveryState: nativeRecoveryStateSchema,
  customerPhone: z.string().nullable().default(null),
  railMetadata: z.record(z.string(), z.unknown()).default({}),
});
export type PaymentEvent = z.infer<typeof paymentEventSchema>;

export const customerProfileSchema = z.object({
  customerId: z.string(),
  merchantId: z.string(),
  subscriptionAgeDays: z.number().int().nonnegative(),
  customerValuePaise: z.number().int().nonnegative(),
  successfulPaymentCount: z.number().int().nonnegative(),
  failedPaymentCount: z.number().int().nonnegative(),
  previousRecoveryRate: z.number().min(0).max(1),
  /** Prior CONTACT attempts to this customer (reminder / payment link / voice
   *  call) inside the fatigue window. Silent retries do not count: a customer
   *  cannot get tired of something they never saw. Read by the contact-fatigue
   *  term of the EIR churn calculation in `lib/scoring.ts`. */
  previousInterventionCount: z.number().int().nonnegative(),
  previousInterventionSuccessCount: z.number().int().nonnegative(),
  daysSinceLastSuccess: z.number().int().nonnegative(),
  lastFailureReason: failureClassSchema.nullable(),
  paymentMethodDistribution: z.record(paymentMethodSchema, z.number().min(0)).default({}),
  currentFailureEpisodeId: z.string().nullable(),
  consentValid: z.boolean(),
  optedOut: z.boolean(),
  contactWindowOpen: z.boolean(),
  phone: z.string().nullable(),
  isSubscription: z.boolean().default(true),
  daysSinceLastEngagement: z.number().int().nonnegative().optional(),
  engagementProxy: z.boolean().default(false),
});
export type CustomerProfile = z.infer<typeof customerProfileSchema>;

export const diagnosisSchema = z.object({
  category: failureClassSchema,
  confidence: z.number().min(0).max(1),
  certaintyClass: certaintySchema,
  reasonCodes: z.array(z.string()),
  explanation: z.string(),
});
export type Diagnosis = z.infer<typeof diagnosisSchema>;

export const recoveryPredictionSchema = z.object({
  pRecoverNative: z.number().min(0).max(1),
  pRecoverWithAction: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  featureSnapshot: z.record(z.string(), z.number().or(z.string()).or(z.boolean())),
  modelVersion: z.string(),
});
export type RecoveryPrediction = z.infer<typeof recoveryPredictionSchema>;

export const eirScoreSchema = z.object({
  action: actionSchema,
  amountPaise: z.number().int().positive(),
  interventionCostPaise: z.number().int().nonnegative(),
  incrementalLift: z.number(),
  eirPaise: z.number().int(),
  eirWithoutChurnPaise: z.number().int().default(0),
  deltaPChurn: z.number().min(0).max(1).default(0),
  residualLtvPaise: z.number().int().default(0),
  churnCostPaise: z.number().int().default(0),
});
export type EIRScore = z.infer<typeof eirScoreSchema>;

export const actionProposalSchema = z.object({
  action: actionSchema,
  confidence: z.number().min(0).max(1),
  reasonCodes: z.array(z.string()),
  explanation: z.string(),
  draftedMessage: z.string().nullable(),
  source: z.enum(["deterministic", "llm"]),
});
export type ActionProposal = z.infer<typeof actionProposalSchema>;

export const merchantPolicySchema = z.object({
  merchantId: z.string(),
  minimumEirPaise: z.number().int().nonnegative().default(rupees(150)),
  maxAutomatedAttempts: z.number().int().min(0).max(10).default(3),
  maxMessagesPerEpisode: z.number().int().min(0).max(10).default(2),
  maxVoiceCallsPerEpisode: z.number().int().min(0).max(5).default(1),
  allowRetry: z.boolean().default(false),
  allowPaymentLinks: z.boolean().default(true),
  allowVoiceCalls: z.boolean().default(true),
  requireConsentForReminder: z.boolean().default(true),
  highValueEscalationThresholdPaise: z.number().int().nonnegative().default(rupees(50000)),
  /** Below this ticket value a human review cannot pay for itself, so the policy
   *  stops rather than escalating. A ₹110 review returning ~5pp breaks even near
   *  ₹2,200; the default leaves margin. Merchant-tunable, not a planted constant. */
  minimumEscalationValuePaise: z.number().int().nonnegative().default(rupees(2500)),
  /** Multiplier on the churn term of EIR. 0 disables dormancy suppression
   *  entirely, 1 trusts the model as written, >1 is more protective. This is the
   *  knob the recovery frontier is measured along. */
  churnAversion: z.number().min(0).max(3).default(1),
  /**
   * Cancellation hazard added by EACH prior contact to this customer, on top of
   * the dormancy curve. Reads `CustomerProfile.previousInterventionCount`, which
   * the churn term interprets as *prior contact attempts* (reminder / payment
   * link / voice call) inside the ~90-day patience window — not silent retries,
   * which nobody sees.
   *
   * Merchant belief, not a measured constant. Optional so that omitting it leaves
   * the model's own default in `lib/scoring.ts` in charge; a merchant who has
   * measured their own nag-driven cancellation sets it here.
   */
  contactFatigueChurnPerContact: z.number().min(0).max(0.5).optional(),
  /** DLT-registered template id for transactional recovery SMS. Absent ⇒ the SMS
   *  path is refused, which is the correct TRAI behaviour for an unregistered sender. */
  dltTemplateId: z.string().nullable().default(null),
  /** DLT-registered sender header (6 chars) that goes with the template above. */
  dltSenderHeader: z.string().nullable().default(null),
  /** Razorpay Subscriptions issues the RBI pre-debit notification on the merchant's
   *  behalf. A merchant on that rail has the obligation met by the platform; one
   *  running its own mandates does not and must not silently be assumed compliant. */
  preDebitNotificationByPlatform: z.boolean().default(false),
  holdoutPct: z.number().min(0).max(100).default(5),
});
export type MerchantPolicy = z.infer<typeof merchantPolicySchema>;

export const policyDecisionSchema = z.object({
  outcome: policyOutcomeSchema,
  proposedAction: actionSchema,
  allowedAction: actionSchema.nullable(),
  reasons: z.array(z.string()),
  checks: z.object({
    eirAboveThreshold: z.boolean(),
    attemptBudgetRemaining: z.boolean(),
    nativeRecoveryComplete: z.boolean(),
    consentValid: z.boolean(),
    withinContactWindow: z.boolean(),
    messageBudgetRemaining: z.boolean(),
    voiceBudgetRemaining: z.boolean(),
    hasPhone: z.boolean(),
    actionAllowed: z.boolean(),
  }),
  arm: z.enum(["TREATMENT", "HOLDOUT"]).optional(),
  holdoutPct: z.number().min(0).max(100).optional(),
  policyVersionId: z.string().optional(),
  suppressionReason: z.enum(["DORMANCY_CHURN_RISK", "NEGATIVE_EIR_OTHER"]).nullable().default(null),
  /** Machine codes from lib/compliance.ts when a regulator, not economics, blocked
   *  the action. Optional so existing decision construction sites stay valid. */
  complianceViolations: z.array(z.string()).optional(),
  degradationWindowId: z.string().nullable().default(null),
});
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;

export const executionResultSchema = z.object({
  actionId: z.string(),
  status: z.enum(["EXECUTED", "SIMULATED", "SKIPPED", "FAILED"]),
  executor: z.enum(["razorpay_payment_link_api", "simulated_executor", "none", "twilio_voice_api", "browser_voice_simulator"]),
  externalReference: z.string().nullable(),
  idempotentReplay: z.boolean(),
  error: z.string().nullable(),
  executedAt: z.string().datetime(),
});
export type ExecutionResult = z.infer<typeof executionResultSchema>;

export const outcomeEventSchema = z.object({
  outcomeId: z.string(),
  episodeId: z.string(),
  paymentId: z.string(),
  status: z.enum(["PENDING", "RECOVERED", "FAILED", "EXPIRED", "ESCALATED", "STOPPED"]),
  occurredAt: z.string().datetime(),
  recoveredAmountPaise: z.number().int().nonnegative(),
  source: z.string(),
});
export type OutcomeEvent = z.infer<typeof outcomeEventSchema>;

export const auditEventSchema = z.object({
  auditId: z.string(),
  episodeId: z.string(),
  eventId: z.string(),
  customerId: z.string(),
  paymentId: z.string(),
  timestamp: z.string().datetime(),
  stage: z.enum(["INGESTED", "DIAGNOSED", "SCORED", "PROPOSED", "POLICY", "EXECUTED", "OUTCOME", "EXPERIMENT_ASSIGNED", "DEGRADATION_HELD", "DEGRADATION_RELEASED", "SUPPRESSED", "CUSTOMER_RESPONSE"]),
  payload: z.record(z.string(), z.unknown()),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const customerResponseSchema = z.object({
  responseId: z.string(),
  channel: z.enum(["voice", "whatsapp"]),
  text: z.string(),
  confidence: z.number().min(0).max(1).nullable(),
  externalRef: z.string().nullable(),
  receivedAt: z.string().datetime(),
});
export type CustomerResponse = z.infer<typeof customerResponseSchema>;

export const recoveryEpisodeSchema = z.object({
  id: z.string(),
  event: paymentEventSchema,
  profile: customerProfileSchema,
  status: episodeStatusSchema,
  automatedAttemptCount: z.number().int().nonnegative(),
  reminderCount: z.number().int().nonnegative(),
  voiceCallCount: z.number().int().nonnegative(),
  diagnosis: diagnosisSchema.nullable(),
  prediction: recoveryPredictionSchema.nullable(),
  eir: eirScoreSchema.nullable(),
  proposal: actionProposalSchema.nullable(),
  policyDecision: policyDecisionSchema.nullable(),
  execution: executionResultSchema.nullable(),
  outcome: outcomeEventSchema.nullable(),
  customerResponses: z.array(customerResponseSchema).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type RecoveryEpisode = z.infer<typeof recoveryEpisodeSchema>;

export const recoveryLedgerSchema = z.object({
  revenueAtRiskPaise: z.number().int().nonnegative(),
  nativeRecoveredPaise: z.number().int().nonnegative(),
  recoverOsRecoveredPaise: z.number().int().nonnegative(),
  incrementalRecoveredPaise: z.number().int(),
  interventionCostPaise: z.number().int().nonnegative(),
  wastedInterventions: z.number().int().nonnegative(),
  interventions: z.number().int().nonnegative(),
  protectedPaise: z.number().int().nonnegative().default(0),
  forgonePaise: z.number().int().nonnegative().default(0),
});
export type RecoveryLedger = z.infer<typeof recoveryLedgerSchema>;

export const allowedActions = actionSchema.options;

export function formatInr(paise: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(paise / 100);
}

export function clampProbability(value: number) {
  return Math.max(0.01, Math.min(0.99, value));
}
