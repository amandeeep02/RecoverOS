import { randomUUID } from "node:crypto";
import {
  type AuditEvent,
  type CustomerProfile,
  type MerchantPolicy,
  merchantPolicySchema,
  type OutcomeEvent,
  type PaymentEvent,
  type RecoveryEpisode,
} from "@/lib/domain";
import { diagnose } from "@/lib/diagnosis";
import { evaluatePolicy, isExecutableAction } from "@/lib/policy";
import { proposalFor, calculateEir, scoreRecovery } from "@/lib/scoring";
import { executeApprovedAction } from "@/lib/razorpay";
import { executeVoiceCall } from "@/lib/voice";
import { transitionEpisode } from "@/lib/state-machine";
import { RecoveryStore } from "@/lib/store";

export function defaultMerchantPolicy(merchantId: string): MerchantPolicy {
  return merchantPolicySchema.parse({ merchantId });
}

export function fallbackProfile(event: PaymentEvent): CustomerProfile {
  return {
    customerId: event.customerId,
    merchantId: event.merchantId,
    subscriptionAgeDays: 90,
    customerValueInr: event.amountInr * 10,
    successfulPaymentCount: 4,
    failedPaymentCount: 1,
    previousRecoveryRate: 0.5,
    previousInterventionCount: 0,
    previousInterventionSuccessCount: 0,
    daysSinceLastSuccess: 31,
    lastFailureReason: null,
    paymentMethodDistribution: { [event.paymentMethod]: 1 },
    currentFailureEpisodeId: null,
    consentValid: true,
    optedOut: false,
    contactWindowOpen: true,
    phone: null,
  };
}

export async function processPaymentFailure(
  event: PaymentEvent,
  recoveryStore: RecoveryStore,
  suppliedPolicy?: MerchantPolicy,
): Promise<{ episode: RecoveryEpisode; duplicate: boolean }> {
  const duplicate = recoveryStore.getEpisodeByWebhook(event.eventId);
  if (duplicate) return { episode: duplicate, duplicate: true };

  const now = new Date().toISOString();
  const episodeId = `ep_${randomUUID()}`;
  const registration = recoveryStore.registerWebhook(event.eventId, episodeId);
  if (!registration.inserted) return { episode: recoveryStore.getEpisode(registration.episodeId)!, duplicate: true };

  const baseProfile = recoveryStore.getProfile(event.merchantId, event.customerId) ?? fallbackProfile(event);
  const profile = { ...baseProfile, currentFailureEpisodeId: episodeId };
  recoveryStore.saveProfile(profile);
  const policy = suppliedPolicy ?? defaultMerchantPolicy(event.merchantId);
  let episode: RecoveryEpisode = {
    id: episodeId,
    event,
    profile,
    status: "DETECTED",
    automatedAttemptCount: 0,
    reminderCount: 0,
    voiceCallCount: 0,
    diagnosis: null,
    prediction: null,
    eir: null,
    proposal: null,
    policyDecision: null,
    execution: null,
    outcome: null,
    createdAt: now,
    updatedAt: now,
  };
  recoveryStore.saveEpisode(episode);
  audit(recoveryStore, episode, "INGESTED", { event, idempotency: "new" });

  const diagnosis = diagnose(event);
  episode = transitionEpisode(episode, "DIAGNOSED");
  episode = { ...episode, diagnosis };
  recoveryStore.saveEpisode(episode);
  audit(recoveryStore, episode, "DIAGNOSED", diagnosis);

  const proposal = proposalFor(event, diagnosis, profile, policy);
  const prediction = scoreRecovery(event, profile, diagnosis, proposal.action);
  const eir = calculateEir(proposal.action, event.amountInr, prediction);
  episode = transitionEpisode(episode, "SCORED");
  episode = { ...episode, prediction, eir };
  recoveryStore.saveEpisode(episode);
  audit(recoveryStore, episode, "SCORED", { prediction, eir });

  episode = transitionEpisode(episode, "PROPOSED");
  episode = { ...episode, proposal };
  recoveryStore.saveEpisode(episode);
  audit(recoveryStore, episode, "PROPOSED", proposal);

  const policyDecision = evaluatePolicy({
    event,
    profile,
    proposal,
    eir,
    policy,
    automatedAttemptCount: episode.automatedAttemptCount,
    reminderCount: episode.reminderCount,
    voiceCallCount: episode.voiceCallCount,
    diagnosisConfidence: diagnosis.confidence,
  });
  episode = transitionEpisode(episode, "POLICY_CHECK");
  episode = { ...episode, policyDecision };
  recoveryStore.saveEpisode(episode);
  audit(recoveryStore, episode, "POLICY", policyDecision);

  if (policyDecision.outcome !== "APPROVE") {
    return { episode: markTerminal(episode, recoveryStore, "ESCALATED", "policy_engine"), duplicate: false };
  }
  if (policyDecision.allowedAction === "STOP") {
    return { episode: markTerminal(episode, recoveryStore, "STOPPED", "policy_engine"), duplicate: false };
  }
  if (policyDecision.allowedAction === "WAIT") {
    return { episode: markPending(episode, recoveryStore, "native_recovery"), duplicate: false };
  }
  if (!isExecutableAction(policyDecision.allowedAction)) {
    return { episode: markTerminal(episode, recoveryStore, "ESCALATED", "safety_fallback"), duplicate: false };
  }

  episode = transitionEpisode(episode, "EXECUTING");
  recoveryStore.saveEpisode(episode);

  let execution;
  if (policyDecision.allowedAction === "VOICE_CALL") {
    execution = await executeVoiceCall(episode, recoveryStore);
    episode = {
      ...episode,
      execution: {
        actionId: execution.callId,
        status: execution.status === "initiated" ? "EXECUTED" : "SIMULATED",
        executor: execution.provider === "elevenlabs" ? "twilio_voice_api" : "browser_voice_simulator",
        externalReference: execution.callSid ?? execution.callId,
        idempotentReplay: false,
        error: execution.error ?? null,
        executedAt: execution.executedAt,
      },
      automatedAttemptCount: episode.automatedAttemptCount + 1,
      voiceCallCount: episode.voiceCallCount + 1,
    };
  } else {
    execution = await executeApprovedAction({ episodeId, event, action: policyDecision.allowedAction }, recoveryStore);
    episode = { ...episode, execution, automatedAttemptCount: episode.automatedAttemptCount + 1, reminderCount: episode.reminderCount + (policyDecision.allowedAction === "REMINDER" ? 1 : 0) };
  }
  recoveryStore.saveEpisode(episode);
  const auditPayload = typeof execution === "object" && execution !== null ? { ...execution } as Record<string, unknown> : { execution };
  audit(recoveryStore, episode, "EXECUTED", auditPayload);
  if (execution.status === "FAILED") return { episode: markTerminal(episode, recoveryStore, "FAILED", "executor"), duplicate: false };

  if (policyDecision.allowedAction === "VOICE_CALL") {
    const dueBy = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const callId = "callId" in execution ? execution.callId : execution.actionId;
    const promise = { promiseId: `promise_${randomUUID()}`, episodeId, promisedAmountInr: event.amountInr, promisedAt: new Date().toISOString(), dueBy, status: "PENDING", customerAcknowledged: false, callId } as any;
    const existingPromises = recoveryStore.getPromises(episodeId);
    recoveryStore.savePromises(episodeId, [...existingPromises, promise]);
    const promisedEpisode = transitionEpisode(episode, "PROMISED");
    return { episode: promisedEpisode, duplicate: false };
  }

  const executorSource = "executor" in execution ? execution.executor : execution.provider === "elevenlabs" ? "twilio_voice_api" : "browser_voice_simulator";
  return { episode: markPending(episode, recoveryStore, executorSource), duplicate: false };
}

export function observeOutcome(
  episodeId: string,
  status: Extract<OutcomeEvent["status"], "RECOVERED" | "FAILED" | "EXPIRED">,
  recoveryStore: RecoveryStore,
): RecoveryEpisode {
  const existing = recoveryStore.getEpisode(episodeId);
  if (!existing) throw new Error("Recovery episode was not found");
  if (existing.status !== "PENDING" && existing.status !== "PROMISED") throw new Error(`Cannot observe an outcome for ${existing.status}`);
  const episode = transitionEpisode(existing, status);
  const outcome: OutcomeEvent = {
    outcomeId: `out_${randomUUID()}`,
    episodeId,
    paymentId: episode.event.paymentId,
    status,
    occurredAt: new Date().toISOString(),
    recoveredAmountInr: status === "RECOVERED" ? episode.event.amountInr : 0,
    source: "outcome_observer",
  };
  const updated = { ...episode, outcome };
  recoveryStore.saveEpisode(updated);
  audit(recoveryStore, updated, "OUTCOME", outcome);
  return updated;
}

function markPending(episode: RecoveryEpisode, recoveryStore: RecoveryStore, source: string) {
  const next = transitionEpisode(episode, "PENDING");
  const outcome: OutcomeEvent = {
    outcomeId: `out_${randomUUID()}`,
    episodeId: next.id,
    paymentId: next.event.paymentId,
    status: "PENDING",
    occurredAt: new Date().toISOString(),
    recoveredAmountInr: 0,
    source,
  };
  const updated = { ...next, outcome };
  recoveryStore.saveEpisode(updated);
  audit(recoveryStore, updated, "OUTCOME", outcome);
  return updated;
}

function markTerminal(
  episode: RecoveryEpisode,
  recoveryStore: RecoveryStore,
  status: Extract<RecoveryEpisode["status"], "ESCALATED" | "STOPPED" | "FAILED">,
  source: string,
) {
  const next = transitionEpisode(episode, status);
  const outcomeStatus = status === "ESCALATED" ? "ESCALATED" : status === "STOPPED" ? "STOPPED" : "FAILED";
  const outcome: OutcomeEvent = {
    outcomeId: `out_${randomUUID()}`,
    episodeId: next.id,
    paymentId: next.event.paymentId,
    status: outcomeStatus,
    occurredAt: new Date().toISOString(),
    recoveredAmountInr: 0,
    source,
  };
  const updated = { ...next, outcome };
  recoveryStore.saveEpisode(updated);
  audit(recoveryStore, updated, "OUTCOME", outcome);
  return updated;
}

function audit(recoveryStore: RecoveryStore, episode: RecoveryEpisode, stage: AuditEvent["stage"], payload: Record<string, unknown>) {
  recoveryStore.appendAudit({
    auditId: `audit_${randomUUID()}`,
    episodeId: episode.id,
    eventId: episode.event.eventId,
    customerId: episode.event.customerId,
    paymentId: episode.event.paymentId,
    timestamp: new Date().toISOString(),
    stage,
    payload,
  });
}
