import { z } from "zod";

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
export const actionSchema = z.enum(["WAIT", "PAYMENT_LINK", "REMINDER", "ESCALATE", "STOP", "RETRY", "VOICE_CALL"]);
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
]);

export const paymentEventSchema = z.object({
  eventId: z.string().min(1),
  eventType: z.enum(["payment.failed", "subscription.pending", "subscription.halted"]),
  occurredAt: z.string().datetime(),
  merchantId: z.string().min(1),
  customerId: z.string().min(1),
  paymentId: z.string().min(1),
  subscriptionId: z.string().nullable(),
  amountInr: z.number().int().positive(),
  currency: z.literal("INR"),
  paymentMethod: paymentMethodSchema,
  failureCode: z.string().nullable(),
  failureSource: failureSourceSchema,
  nativeRecoveryState: nativeRecoveryStateSchema,
  railMetadata: z.record(z.string(), z.unknown()).default({}),
});
export type PaymentEvent = z.infer<typeof paymentEventSchema>;

export const customerProfileSchema = z.object({
  customerId: z.string(),
  merchantId: z.string(),
  subscriptionAgeDays: z.number().int().nonnegative(),
  customerValueInr: z.number().nonnegative(),
  successfulPaymentCount: z.number().int().nonnegative(),
  failedPaymentCount: z.number().int().nonnegative(),
  previousRecoveryRate: z.number().min(0).max(1),
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
  amountInr: z.number().positive(),
  interventionCostInr: z.number().nonnegative(),
  incrementalLift: z.number(),
  eirInr: z.number(),
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
  minimumEirInr: z.number().nonnegative().default(150),
  maxAutomatedAttempts: z.number().int().min(0).max(10).default(3),
  maxMessagesPerEpisode: z.number().int().min(0).max(10).default(2),
  maxVoiceCallsPerEpisode: z.number().int().min(0).max(5).default(1),
  allowRetry: z.boolean().default(false),
  allowPaymentLinks: z.boolean().default(true),
  allowVoiceCalls: z.boolean().default(true),
  requireConsentForReminder: z.boolean().default(true),
  highValueEscalationThresholdInr: z.number().nonnegative().default(50000),
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
    actionAllowed: z.boolean(),
  }),
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
  recoveredAmountInr: z.number().nonnegative(),
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
  stage: z.enum(["INGESTED", "DIAGNOSED", "SCORED", "PROPOSED", "POLICY", "EXECUTED", "OUTCOME"]),
  payload: z.record(z.string(), z.unknown()),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

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
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type RecoveryEpisode = z.infer<typeof recoveryEpisodeSchema>;

export const recoveryLedgerSchema = z.object({
  revenueAtRiskInr: z.number().nonnegative(),
  nativeRecoveredInr: z.number().nonnegative(),
  recoverOsRecoveredInr: z.number().nonnegative(),
  incrementalRecoveredInr: z.number(),
  interventionCostInr: z.number().nonnegative(),
  wastedInterventions: z.number().int().nonnegative(),
  interventions: z.number().int().nonnegative(),
});
export type RecoveryLedger = z.infer<typeof recoveryLedgerSchema>;

export const allowedActions = actionSchema.options;

export function formatInr(amount: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(amount);
}

export function clampProbability(value: number) {
  return Math.max(0.01, Math.min(0.99, value));
}
