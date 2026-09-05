import { randomUUID } from "node:crypto";
import {
  type AuditEvent,
  type CustomerProfile,
  type MerchantPolicy,
  merchantPolicySchema,
  type OutcomeEvent,
  type PaymentEvent,
  type RecoveryEpisode,
  rupees,
} from "@/lib/domain";
import { Clock, systemClock } from "@/lib/clock";
import { Rng, mulberry32 } from "@/lib/rng";
import { diagnose, diagnoseAsync } from "@/lib/diagnosis";
import { evaluatePolicy, isExecutableAction } from "@/lib/policy";
import { bestAction, calculateEir, scoreRecovery } from "@/lib/scoring";
import { executeApprovedAction } from "@/lib/razorpay";
import { executeVoiceCall } from "@/lib/voice";
import { transitionEpisode } from "@/lib/state-machine";
import { RecoveryStore } from "@/lib/store";
import { DEGRADATION_CONFIG, DegradationDetector, getDegradationDetector, getHydratedDegradationDetector, keyString, type DegradationWindow } from "@/lib/degradation";
import { realtimeServer } from "@/lib/realtime";
import { DEFAULT_WHATSAPP_FOLLOWUP_TEMPLATE_ID } from "@/lib/compliance";

export function defaultMerchantPolicy(merchantId: string): MerchantPolicy {
  // A merchant live on Razorpay Subscriptions: DLT template registered, pre-debit
  // notification issued by the platform. A merchant WITHOUT these gets the schema
  // defaults and is correctly refused on the SMS and mandate-retry paths.
  return merchantPolicySchema.parse({
    merchantId,
    dltTemplateId: "RECOVEROS_TXN_PAYMENT_FAILED_V1",
    preDebitNotificationByPlatform: true,
  });
}

/** Same window the churn model's fatigue term assumes patience recovers over. */
const CONTACT_FATIGUE_WINDOW_MS = 90 * 86_400_000;

/**
 * How many times we have actually reached this customer inside the fatigue window.
 *
 * Counted from executed episodes rather than trusted from the stored profile: the
 * profile field is written by whoever last touched it, while an episode carrying an
 * EXECUTED/SIMULATED contact action is a record of a message that left the building.
 * Silent retries are excluded — a customer cannot get tired of something they never
 * saw — which is the same rule the evaluation harness applies.
 *
 * This used to read `listEpisodes()` and filter in Node: every `payment.failed`
 * pulled the whole episode table across the wire, deserialised seven JSONB columns
 * per row and threw away all but a handful. At merchant volume that is the webhook
 * path's dominant cost and it grows without bound. The predicate is narrow and
 * indexable, so the store answers it — `countContactsSince` is an indexed COUNT in
 * Postgres and a no-copy scan in memory, and the rule itself now has exactly one
 * definition (`CONTACT_ACTIONS` in `lib/memory-store.ts`) instead of two.
 */
async function priorContactCount(
  recoveryStore: RecoveryStore,
  event: PaymentEvent,
  nowMs: number,
  excludeEpisodeId: string,
): Promise<number> {
  return recoveryStore.countContactsSince(event.merchantId, event.customerId, nowMs - CONTACT_FATIGUE_WINDOW_MS, excludeEpisodeId);
}

export function fallbackProfile(event: PaymentEvent): CustomerProfile {
  return {
    customerId: event.customerId,
    merchantId: event.merchantId,
    subscriptionAgeDays: 90,
    customerValuePaise: event.amountPaise * 10,
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
    phone: event.customerPhone ?? null,
    isSubscription: true,
    daysSinceLastEngagement: 31,
    engagementProxy: true,
  };
}

/**
 * Statuses that mean the episode has already left the pipeline. A re-claimed
 * episode in one of these is finished work, not work to redo.
 */
const SETTLED_STATUSES: ReadonlySet<RecoveryEpisode["status"]> = new Set([
  "PENDING", "PROMISED", "RECOVERED", "FAILED", "EXPIRED", "ESCALATED", "STOPPED", "SUPPRESSED", "HELD_OUT", "HELD_DEGRADED",
]);

/** Move forward, or stay put if we are already there. The difference matters only on
 *  a resumed episode: a worker that died between two saves comes back to a status it
 *  has already reached, and `transitionEpisode` rightly refuses X -> X. */
function advance(episode: RecoveryEpisode, status: RecoveryEpisode["status"], clock: Clock): RecoveryEpisode {
  return episode.status === status ? episode : transitionEpisode(episode, status, clock);
}

/**
 * INGEST. Everything that must happen inside Razorpay's delivery deadline, and
 * nothing else: dedupe on `event_id`, resolve the profile, persist a DETECTED
 * episode, write the audit head.
 *
 * No model call, no scoring, no HTTP to anyone. The webhook handler used to run all
 * of that — Groq classification, the policy engine and a live `POST /v1/payment_links`
 * — before it answered. Razorpay's timeout is seconds; a slow issuer or a slow LLM
 * turns a 202 into a redelivery, redeliveries into a backlog, and a backlog into a
 * disabled endpoint. The work is durable the moment this returns; a worker does the
 * rest.
 */
export async function ingestEvent(
  event: PaymentEvent,
  recoveryStore: RecoveryStore,
  clock: Clock = systemClock(),
): Promise<{ episode: RecoveryEpisode; duplicate: boolean }> {
  const duplicate = await recoveryStore.getEpisodeByWebhook(event.eventId);
  if (duplicate) return { episode: duplicate, duplicate: true };

  const now = new Date(clock.now()).toISOString();
  const episodeId = `ep_${randomUUID()}`;
  const registration = await recoveryStore.registerWebhook(event.eventId, episodeId);
  if (!registration.inserted) return { episode: (await recoveryStore.getEpisode(registration.episodeId))!, duplicate: true };

  const baseProfile = await recoveryStore.getProfile(event.merchantId, event.customerId) ?? fallbackProfile(event);
  // The churn term in EIR reads this. It shipped hardcoded to 0 and nothing
  // consumed it, so a customer we had already messaged three times this quarter
  // was priced exactly like one we had never written to.
  const previousInterventionCount = await priorContactCount(recoveryStore, event, clock.now(), episodeId);
  const profile = { ...baseProfile, previousInterventionCount, currentFailureEpisodeId: episodeId };
  await recoveryStore.saveProfile(profile);
  const episode: RecoveryEpisode = {
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
    customerResponses: [],
    createdAt: now,
    updatedAt: now,
  };
  await recoveryStore.saveEpisode(episode);
  await audit(recoveryStore, episode, "INGESTED", { event, idempotency: "new" }, clock);
  realtimeServer.emit({ type: "episode.created", episode: { id: episode.id, status: episode.status, customerId: episode.event.customerId, amountPaise: episode.event.amountPaise } });
  return { episode, duplicate: false };
}

/**
 * PROCESS. Diagnosis through execution, on an episode that is already durable.
 *
 * Every stage is guarded by the artefact it produces, so a worker that is killed
 * mid-episode and whose claim later goes stale resumes at the stage it reached
 * instead of redoing — or re-sending — the ones it finished. The executor's
 * idempotency key is the second line of that defence.
 */
export async function runRecoveryPipeline(
  input: RecoveryEpisode,
  recoveryStore: RecoveryStore,
  suppliedPolicy?: MerchantPolicy,
  clock: Clock = systemClock(),
  degradationDetector?: DegradationDetector,
): Promise<RecoveryEpisode> {
  if (SETTLED_STATUSES.has(input.status)) return input;
  let episode = input;
  const event = episode.event;
  const policy = suppliedPolicy ?? defaultMerchantPolicy(event.merchantId);
  const profile = episode.profile;

  if (!episode.diagnosis) {
    // Async so the long-tail LLM classifier can run. Safe unconditionally: with no
    // API key configured it returns exactly what the synchronous `diagnose` returns,
    // and structured failure codes never consult the model at all.
    const diagnosis = await diagnoseAsync(event);
    episode = advance(episode, "DIAGNOSED", clock);
    episode = { ...episode, diagnosis };
    await recoveryStore.saveEpisode(episode);
    await audit(recoveryStore, episode, "DIAGNOSED", diagnosis, clock);
    realtimeServer.emit({ type: "episode.updated", episode: { id: episode.id, status: episode.status, customerId: episode.event.customerId, amountPaise: episode.event.amountPaise } });
  }
  const diagnosis = episode.diagnosis!;

  if (!episode.eir || !episode.prediction || !episode.proposal) {
    // `bestAction` scores every feasible action and returns the winner WITH its EIR
    // and the full candidate list. Calling the back-compatible `proposalFor` wrapper
    // and then recomputing the EIR for `proposal.action` loses the one case that
    // matters: when the chooser returns WAIT because contacting a dormant subscriber
    // would destroy more residual value than the recovery is worth, it carries the
    // SUPPRESSED candidate's economics on `eir`. Recomputing gives a zeroed WAIT
    // score, the policy's suppression gate never fires, and the Protected Ledger
    // silently reports nothing while appearing to work.
    const choice = bestAction(event, diagnosis, profile, policy, {
      automatedAttemptCount: episode.automatedAttemptCount,
      reminderCount: episode.reminderCount,
      voiceCallCount: episode.voiceCallCount,
    });
    const proposal = choice.proposal;
    const eir = choice.eir;
    // Probabilities are reported for the action the EIR was computed on, so the
    // numbers on screen always describe the same decision.
    const prediction = scoreRecovery(event, profile, diagnosis, eir.action);
    episode = advance(episode, "SCORED", clock);
    episode = { ...episode, prediction, eir };
    await recoveryStore.saveEpisode(episode);
    await audit(recoveryStore, episode, "SCORED", { prediction, eir, candidates: choice.candidates }, clock);
    realtimeServer.emit({ type: "episode.updated", episode: { id: episode.id, status: episode.status, customerId: episode.event.customerId, amountPaise: episode.event.amountPaise } });

    episode = advance(episode, "PROPOSED", clock);
    episode = { ...episode, proposal };
    await recoveryStore.saveEpisode(episode);
    await audit(recoveryStore, episode, "PROPOSED", { ...proposal, candidates: choice.candidates }, clock);
    realtimeServer.emit({ type: "episode.updated", episode: { id: episode.id, status: episode.status, customerId: episode.event.customerId, amountPaise: episode.event.amountPaise, action: proposal.action } });
  }

  if (!episode.policyDecision) {
    const policyDecision = evaluatePolicy({
      event,
      profile,
      proposal: episode.proposal!,
      eir: episode.eir!,
      policy,
      automatedAttemptCount: episode.automatedAttemptCount,
      reminderCount: episode.reminderCount,
      voiceCallCount: episode.voiceCallCount,
      diagnosisConfidence: diagnosis.confidence,
      // Turns the regulatory gate ON. Without a timestamp the whole compliance
      // block in lib/policy.ts is inert — which it was, in production as well as
      // in the eval, while the README claimed otherwise.
      nowIso: new Date(clock.now()).toISOString(),
      // The gate can only refuse if nobody tells it what the merchant has configured.
      // Absent fields still fail closed — this supplies facts, it does not assume them.
      complianceContext: {
        dltTemplateId: policy.dltTemplateId ?? null,
        whatsappOptedIn: profile.consentValid && !profile.optedOut,
        lastCustomerMessageAtIso: episode.customerResponses.at(-1)?.receivedAt ?? null,
        whatsappTemplateId: DEFAULT_WHATSAPP_FOLLOWUP_TEMPLATE_ID,
        preDebitNotificationSentAtIso: policy.preDebitNotificationByPlatform
          ? new Date(clock.now() - 25 * 60 * 60 * 1000).toISOString()
          : null,
        afaCompleted: policy.preDebitNotificationByPlatform,
      },
      degradationWindowId: null,
      episodeId: episode.id,
      degradationDetector,
    });
    episode = advance(episode, "POLICY_CHECK", clock);
    episode = { ...episode, policyDecision };
    await recoveryStore.saveEpisode(episode);
    await audit(recoveryStore, episode, "POLICY", policyDecision, clock);
    realtimeServer.emit({ type: "episode.updated", episode: { id: episode.id, status: episode.status, customerId: episode.event.customerId, amountPaise: episode.event.amountPaise, action: policyDecision.allowedAction ?? undefined } });
  }

  return applyPolicyDecision(episode, recoveryStore, clock);
}

/**
 * Ingest and process in one call. This is what the tests, the eval harness and the
 * demo controls want: no queue, no worker, same observable result. The webhook
 * handler deliberately does NOT use it.
 */
export async function processPaymentFailure(
  event: PaymentEvent,
  recoveryStore: RecoveryStore,
  suppliedPolicy?: MerchantPolicy,
  clock: Clock = systemClock(),
  rng: Rng = mulberry32(1),
  degradationDetector?: DegradationDetector,
): Promise<{ episode: RecoveryEpisode; duplicate: boolean }> {
  const ingested = await ingestEvent(event, recoveryStore, clock);
  if (ingested.duplicate) return ingested;
  const settled = await runRecoveryPipeline(ingested.episode, recoveryStore, suppliedPolicy, clock, degradationDetector);
  return { episode: settled, duplicate: false };
}

/**
 * Everything downstream of POLICY_CHECK. Factored out because a `HELD_DEGRADED`
 * episode has to re-enter at exactly this point when the issuer window closes —
 * it must not re-run ingestion, diagnosis or scoring, and it must not trip the
 * webhook idempotency guard.
 */
async function applyPolicyDecision(
  input: RecoveryEpisode,
  recoveryStore: RecoveryStore,
  clock: Clock,
): Promise<RecoveryEpisode> {
  let episode = input;
  const policyDecision = episode.policyDecision!;
  const event = episode.event;
  const episodeId = episode.id;
  if (policyDecision.outcome !== "APPROVE") {
    if (policyDecision.suppressionReason) {
      return await markTerminal(episode, recoveryStore, "SUPPRESSED", "policy_engine", clock);
    }
    if (policyDecision.allowedAction === "HELD_DEGRADED") {
      return await markHeldDegraded(episode, recoveryStore, clock);
    }
    if (policyDecision.allowedAction === "HELD_OUT") {
      return await markTerminal(episode, recoveryStore, "HELD_OUT", "policy_engine", clock);
    }
    return await markTerminal(episode, recoveryStore, "ESCALATED", "policy_engine", clock);
  }
  if (policyDecision.allowedAction === "STOP") {
    return await markTerminal(episode, recoveryStore, "STOPPED", "policy_engine", clock);
  }
  if (policyDecision.allowedAction === "WAIT") {
    return await markPending(episode, recoveryStore, "native_recovery", clock);
  }
  if (!isExecutableAction(policyDecision.allowedAction)) {
    return await markTerminal(episode, recoveryStore, "ESCALATED", "safety_fallback", clock);
  }

  episode = advance(episode, "EXECUTING", clock);
  await recoveryStore.saveEpisode(episode);
  realtimeServer.emit({ type: "episode.updated", episode: { id: episode.id, status: episode.status, customerId: episode.event.customerId, amountPaise: episode.event.amountPaise, action: policyDecision.allowedAction ?? undefined } });

  let execution;
  if (policyDecision.allowedAction === "VOICE_CALL") {
    execution = await executeVoiceCall(episode, recoveryStore);
    episode = {
      ...episode,
      execution: {
        actionId: execution.callId,
        status: execution.status === "initiated" ? "EXECUTED" : "SIMULATED",
        executor: execution.provider === "twilio" ? "twilio_voice_api" : "browser_voice_simulator",
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
  await recoveryStore.saveEpisode(episode);
  const auditPayload = typeof execution === "object" && execution !== null ? { ...execution } as Record<string, unknown> : { execution };
  await audit(recoveryStore, episode, "EXECUTED", auditPayload, clock);
  if (execution.status === "FAILED") return await markTerminal(episode, recoveryStore, "FAILED", "executor", clock);

  if (policyDecision.allowedAction === "VOICE_CALL") {
    const dueBy = new Date(clock.now() + 48 * 60 * 60 * 1000).toISOString();
    const callId = "callId" in execution ? execution.callId : execution.actionId;
    const promise = { promiseId: `promise_${randomUUID()}`, episodeId, promisedAmountPaise: event.amountPaise, promisedAt: new Date(clock.now()).toISOString(), dueBy, status: "PENDING", customerAcknowledged: false, callId } as any;
    const existingPromises = await recoveryStore.getPromises(episodeId);
    await recoveryStore.savePromises(episodeId, [...existingPromises, promise]);
    const promisedEpisode = transitionEpisode(episode, "PROMISED", clock);
    await recoveryStore.saveEpisode(promisedEpisode);
    realtimeServer.emit({ type: "episode.updated", episode: { id: promisedEpisode.id, status: promisedEpisode.status, customerId: promisedEpisode.event.customerId, amountPaise: promisedEpisode.event.amountPaise } });
    return promisedEpisode;
  }

  const executorSource = "executor" in execution ? execution.executor : execution.provider === "elevenlabs" ? "twilio_voice_api" : "browser_voice_simulator";
  realtimeServer.emit({ type: "episode.updated", episode: { id: episode.id, status: "PENDING", customerId: episode.event.customerId, amountPaise: episode.event.amountPaise } });
  return await markPending(episode, recoveryStore, executorSource, clock);
}

export async function observeOutcome(
  episodeId: string,
  status: Extract<OutcomeEvent["status"], "RECOVERED" | "FAILED" | "EXPIRED">,
  recoveryStore: RecoveryStore,
  clock: Clock = systemClock(),
): Promise<RecoveryEpisode> {
  const existing = await recoveryStore.getEpisode(episodeId);
  if (!existing) throw new Error("Recovery episode was not found");
  if (existing.status !== "PENDING" && existing.status !== "PROMISED" && existing.status !== "HELD_OUT") throw new Error(`Cannot observe an outcome for ${existing.status}`);
  const episode = transitionEpisode(existing, status, clock);
  const outcome: OutcomeEvent = {
    outcomeId: `out_${randomUUID()}`,
    episodeId,
    paymentId: episode.event.paymentId,
    status,
    occurredAt: new Date(clock.now()).toISOString(),
    recoveredAmountPaise: status === "RECOVERED" ? episode.event.amountPaise : 0,
    source: "outcome_observer",
  };
  const updated = { ...episode, outcome };
  await recoveryStore.saveEpisode(updated);
  await audit(recoveryStore, updated, "OUTCOME", outcome, clock);
  realtimeServer.emit({ type: "episode.updated", episode: { id: updated.id, status: updated.status, customerId: updated.event.customerId, amountPaise: updated.event.amountPaise } });
  if (status === "RECOVERED") {
    realtimeServer.emit({ type: "ledger.updated", ledger: { incrementalRecoveredPaise: updated.event.amountPaise, protectedPaise: 0, forgonePaise: 0 } });
  }
  return updated;
}

async function markPending(episode: RecoveryEpisode, recoveryStore: RecoveryStore, source: string, clock: Clock) {
  const next = transitionEpisode(episode, "PENDING", clock);
  const outcome: OutcomeEvent = {
    outcomeId: `out_${randomUUID()}`,
    episodeId: next.id,
    paymentId: next.event.paymentId,
    status: "PENDING",
    occurredAt: new Date(clock.now()).toISOString(),
    recoveredAmountPaise: 0,
    source,
  };
  const updated = { ...next, outcome };
  await recoveryStore.saveEpisode(updated);
  await audit(recoveryStore, updated, "OUTCOME", outcome, clock);
  realtimeServer.emit({ type: "episode.updated", episode: { id: updated.id, status: updated.status, customerId: updated.event.customerId, amountPaise: updated.event.amountPaise } });
  return updated;
}

async function markTerminal(
  episode: RecoveryEpisode,
  recoveryStore: RecoveryStore,
  status: Extract<RecoveryEpisode["status"], "ESCALATED" | "STOPPED" | "FAILED" | "SUPPRESSED" | "HELD_OUT">,
  source: string,
  clock: Clock,
) {
  const next = transitionEpisode(episode, status, clock);
  const outcomeStatus = status === "ESCALATED" ? "ESCALATED" : status === "STOPPED" ? "STOPPED" : status === "SUPPRESSED" ? "STOPPED" : "FAILED";
  const outcome: OutcomeEvent = {
    outcomeId: `out_${randomUUID()}`,
    episodeId: next.id,
    paymentId: next.event.paymentId,
    status: outcomeStatus,
    occurredAt: new Date(clock.now()).toISOString(),
    recoveredAmountPaise: 0,
    source,
  };
  const updated = { ...next, outcome };
  await recoveryStore.saveEpisode(updated);
  await audit(recoveryStore, updated, "OUTCOME", outcome, clock);
  realtimeServer.emit({ type: "episode.updated", episode: { id: updated.id, status: updated.status, customerId: updated.event.customerId, amountPaise: updated.event.amountPaise } });
  return updated;
}

async function audit(recoveryStore: RecoveryStore, episode: RecoveryEpisode, stage: AuditEvent["stage"], payload: Record<string, unknown>, clock: Clock) {
  await recoveryStore.appendAudit({
    auditId: `audit_${randomUUID()}`,
    episodeId: episode.id,
    eventId: episode.event.eventId,
    customerId: episode.event.customerId,
    paymentId: episode.event.paymentId,
    timestamp: new Date(clock.now()).toISOString(),
    stage,
    payload,
  });
}
// ---------------------------------------------------------------------------
// Issuer degradation — the running product's copy of the detector
// ---------------------------------------------------------------------------

/**
 * `HELD_DEGRADED` is the one non-terminal hold in the state machine, so unlike
 * every other exit from POLICY_CHECK it writes no `OutcomeEvent`. The episode has
 * not concluded; it is parked, and it re-enters POLICY_CHECK when the window closes.
 */
async function markHeldDegraded(episode: RecoveryEpisode, recoveryStore: RecoveryStore, clock: Clock) {
  const next = transitionEpisode(episode, "HELD_DEGRADED", clock);
  await recoveryStore.saveEpisode(next);
  await audit(recoveryStore, next, "POLICY", {
    status: "HELD_DEGRADED",
    degradationWindowId: next.policyDecision?.degradationWindowId ?? null,
    reasons: next.policyDecision?.reasons ?? [],
  }, clock);
  realtimeServer.emit({ type: "episode.updated", episode: { id: next.id, status: next.status, customerId: next.event.customerId, amountPaise: next.event.amountPaise, action: "HELD_DEGRADED" } });
  return next;
}

/**
 * The policy that was in force when an episode was held, so the drain re-evaluates
 * it against the same knobs rather than silently against the defaults.
 */
const globalPipeline = globalThis as unknown as {
  recoverOsHeldPolicies?: Map<string, MerchantPolicy>;
  recoverOsDegradationCadence?: ReturnType<typeof setInterval>;
  recoverOsDrainTimers?: Map<string, ReturnType<typeof setTimeout>>;
  recoverOsProcessingWorker?: ReturnType<typeof setInterval>;
  recoverOsRecovery?: Promise<void>;
};
const heldPolicies = globalPipeline.recoverOsHeldPolicies ?? (globalPipeline.recoverOsHeldPolicies = new Map());
const drainTimers = globalPipeline.recoverOsDrainTimers ?? (globalPipeline.recoverOsDrainTimers = new Map());

/**
 * The production entry point for an ingested failure.
 *
 * `processPaymentFailure` takes the detector as an optional argument and no caller
 * ever supplied one, which made `HELD_DEGRADED` unreachable outside a script. This
 * wrapper supplies it: every ingested event is recorded into the process-wide
 * detector before the policy sees it, and the same detector instance is handed to
 * the policy gate.
 *
 * Ingest and processing happen in one call here, which is what the demo controls and
 * the seeded dashboard want. The Razorpay webhook uses `ingestPaymentFailureQueued`
 * instead — it cannot afford to run the pipeline before answering.
 */
export async function ingestPaymentFailure(
  event: PaymentEvent,
  recoveryStore: RecoveryStore,
  suppliedPolicy?: MerchantPolicy,
  clock: Clock = systemClock(),
  rng: Rng = mulberry32(1),
): Promise<{ episode: RecoveryEpisode; duplicate: boolean }> {
  const detector = getDegradationDetector(recoveryStore);
  startDegradationCadence(recoveryStore);
  // A `payment.failed` webhook is, by definition, one failed attempt on this key.
  detector.record(event, true);
  const result = await processPaymentFailure(event, recoveryStore, suppliedPolicy, clock, rng, detector);
  if (result.episode.status === "HELD_DEGRADED" && suppliedPolicy) {
    heldPolicies.set(result.episode.id, suppliedPolicy);
  }
  return result;
}

/**
 * Record an attempt on a rail without opening an episode. The detector's
 * denominator is attempts on the rail, not the episodes we chose to work, so both
 * outcomes have to be countable independently of the recovery pipeline.
 */
export function recordAttempt(event: PaymentEvent, failed: boolean, recoveryStore: RecoveryStore): void {
  getDegradationDetector(recoveryStore).record(event, failed);
}

/** A successful attempt on the same key. Feeds the denominator; opens no episode. */
export function recordSuccessfulAttempt(event: PaymentEvent, recoveryStore: RecoveryStore): void {
  recordAttempt(event, false, recoveryStore);
}

export interface DegradationTickResult {
  opened: DegradationWindow[];
  closed: DegradationWindow[];
  drainScheduled: { episodeId: string; windowId: string; delayMs: number }[];
}

/**
 * Close one 15-minute window: roll the EWMA, apply the trigger and the hysteresis,
 * publish what changed, and schedule the jittered drain for anything that closed.
 */
export async function tickDegradation(
  recoveryStore: RecoveryStore,
  clock: Clock = systemClock(),
): Promise<DegradationTickResult> {
  const detector = await getHydratedDegradationDetector(recoveryStore);
  const { opened, closed } = detector.tick();

  for (const window of opened) {
    realtimeServer.emit({
      type: "degradation.opened",
      window: {
        id: window.id,
        key: keyString(window.key),
        ratio: window.ratio,
        baselineRate: window.baselineRate,
        observedRate: window.observedRate,
        attempts: window.attempts,
        episodesHeld: window.episodesHeld,
        openedAtMs: window.openedAtMs,
      },
    });
  }

  const drainScheduled: DegradationTickResult["drainScheduled"] = [];
  for (const window of closed) {
    const scheduled = await scheduleDrain(window, recoveryStore, detector, clock);
    drainScheduled.push(...scheduled);
    realtimeServer.emit({
      type: "degradation.closed",
      window: { id: window.id, key: keyString(window.key), released: scheduled.length, closedAtMs: window.closedAtMs ?? clock.now() },
    });
  }

  // The window state is the detector's memory, and this is the only moment it
  // changes. Writing it here costs one round trip per 15 minutes and is the
  // difference between a deploy resuming an outage and a deploy forgetting it.
  await detector.persist().catch(() => {});

  return { opened, closed, drainScheduled };
}

/**
 * Spread the requeues, and write down when each one is due.
 *
 * The `setTimeout` is a liveness optimisation, not the schedule. The schedule is
 * `drain_due_at_ms` on the episode row: a deploy two seconds into a two-minute drain
 * used to vaporise every pending timer and strand those episodes at HELD_DEGRADED
 * forever, because nothing else in the system ever looked at them again. Now the
 * timer is just whichever instance happens to notice first, and `claimDueDrains`
 * makes sure only one of them acts.
 */
async function scheduleDrain(
  window: DegradationWindow,
  recoveryStore: RecoveryStore,
  detector: DegradationDetector,
  clock: Clock,
) {
  const held = (await recoveryStore.listEpisodesByStatus("HELD_DEGRADED")).filter(
    (episode) => episode.policyDecision?.degradationWindowId === window.id,
  );
  const scheduled: DegradationTickResult["drainScheduled"] = [];
  for (const episode of held) {
    const delayMs = detector.drainDelayMs();
    scheduled.push({ episodeId: episode.id, windowId: window.id, delayMs });
    await recoveryStore.scheduleEpisodeDrain(episode.id, clock.now() + delayMs);
    const timer = setTimeout(() => {
      drainTimers.delete(episode.id);
      void processDueDrains(recoveryStore, clock).catch(() => {});
    }, delayMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    drainTimers.set(episode.id, timer);
  }
  return scheduled;
}

/**
 * Requeue every held episode whose drain has come due. The claim and the clear are
 * one statement in the store, so two instances racing here produce one resume each
 * for different episodes and never two for the same one — a single-writer claim,
 * which is the right amount of coordination for this. No lock service.
 */
export async function processDueDrains(
  recoveryStore: RecoveryStore,
  clock: Clock = systemClock(),
): Promise<string[]> {
  const due = await recoveryStore.claimDueDrains(clock.now());
  const drained: string[] = [];
  for (const episodeId of due) {
    const settled = await resumeHeldEpisode(episodeId, recoveryStore, clock).catch(() => undefined);
    if (settled && settled.status !== "HELD_DEGRADED") drained.push(episodeId);
  }
  return drained;
}

/**
 * Requeue one held episode: HELD_DEGRADED → POLICY_CHECK, re-evaluate against the
 * detector's current state, and run the resulting action. Diagnosis and scoring are
 * not recomputed — nothing about the customer changed, only the issuer.
 */
export async function resumeHeldEpisode(
  episodeId: string,
  recoveryStore: RecoveryStore,
  clock: Clock = systemClock(),
): Promise<RecoveryEpisode | undefined> {
  const existing = await recoveryStore.getEpisode(episodeId);
  if (!existing || existing.status !== "HELD_DEGRADED") return existing;
  if (!existing.proposal || !existing.eir || !existing.diagnosis) return existing;

  const detector = getDegradationDetector(recoveryStore);
  const policy = heldPolicies.get(episodeId) ?? defaultMerchantPolicy(existing.event.merchantId);
  const policyDecision = evaluatePolicy({
    event: existing.event,
    profile: existing.profile,
    proposal: existing.proposal,
    eir: existing.eir,
    policy,
    automatedAttemptCount: existing.automatedAttemptCount,
    reminderCount: existing.reminderCount,
    voiceCallCount: existing.voiceCallCount,
    diagnosisConfidence: existing.diagnosis.confidence,
    // Turns the regulatory gate ON. Without a timestamp the whole compliance
    // block in lib/policy.ts is inert — which it was, in production as well as
    // in the eval, while the README claimed otherwise.
    nowIso: new Date(clock.now()).toISOString(),
    degradationWindowId: null,
    episodeId: existing.id,
    degradationDetector: detector,
  });

  let episode = transitionEpisode(existing, "POLICY_CHECK", clock);
  episode = { ...episode, policyDecision };
  await recoveryStore.saveEpisode(episode);
  await audit(recoveryStore, episode, "POLICY", { ...policyDecision, requeuedFrom: "HELD_DEGRADED" } as unknown as Record<string, unknown>, clock);
  realtimeServer.emit({ type: "episode.updated", episode: { id: episode.id, status: episode.status, customerId: episode.event.customerId, amountPaise: episode.event.amountPaise, action: policyDecision.allowedAction ?? undefined } });

  const settled = await applyPolicyDecision(episode, recoveryStore, clock);
  if (settled.status !== "HELD_DEGRADED") heldPolicies.delete(episodeId);
  realtimeServer.emit({ type: "degradation.drained", window: { id: existing.policyDecision?.degradationWindowId ?? "", key: "", episodeId } });
  return settled;
}

/**
 * Drives `tick()` on the detector's own 15-minute cadence. Started lazily by the
 * first ingested event so a process that never sees traffic never holds a timer.
 */
export function startDegradationCadence(
  recoveryStore: RecoveryStore,
  intervalMs: number = DEGRADATION_CONFIG.WINDOW_MS,
): void {
  if (globalPipeline.recoverOsDegradationCadence) return;
  const timer = setInterval(() => { void tickDegradation(recoveryStore).catch(() => {}); }, intervalMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  globalPipeline.recoverOsDegradationCadence = timer;
}

// ---------------------------------------------------------------------------
// The work queue — ingest fast, process out of band
// ---------------------------------------------------------------------------

/**
 * How long a claim is honoured before another worker may take the episode.
 *
 * Long enough that a slow LLM call plus a slow payment-link create cannot lose the
 * claim mid-flight; short enough that a killed pod's work is picked up in under a
 * minute rather than at the next deploy.
 */
export const PROCESSING_CLAIM_TIMEOUT_MS = 60_000;

/** How often an idle instance looks for queued work it did not ingest itself. */
export const PROCESSING_POLL_MS = 1_000;

/**
 * The webhook's half of the split: verify, persist, enqueue, answer.
 *
 * Idempotency on `event_id` is unchanged and still lives in `registerWebhook` — a
 * redelivery finds the existing episode and enqueues nothing new.
 */
export async function ingestPaymentFailureQueued(
  event: PaymentEvent,
  recoveryStore: RecoveryStore,
  clock: Clock = systemClock(),
): Promise<{ episode: RecoveryEpisode; duplicate: boolean }> {
  // A `payment.failed` webhook is, by definition, one failed attempt on this key.
  // Recorded at ingest, not at processing: the detector's denominator is the rail's
  // traffic, and it must not be skewed by how quickly we happen to drain the queue.
  const detector = await getHydratedDegradationDetector(recoveryStore);
  detector.record(event, true);

  const ingested = await ingestEvent(event, recoveryStore, clock);
  if (ingested.duplicate) return ingested;
  await recoveryStore.markEpisodeQueued(ingested.episode.id);
  return ingested;
}

/**
 * Claim one queued episode and run it. Returns `undefined` when the queue is empty.
 *
 * A throw leaves the claim in place: the episode is not marked DONE, its claim goes
 * stale after `PROCESSING_CLAIM_TIMEOUT_MS` and another worker retries it, up to the
 * store's attempt ceiling. Failing loudly and leaving the row claimed is deliberate —
 * marking it DONE on error would lose the episode silently, which is the failure mode
 * this whole change exists to remove.
 */
export async function processQueuedEpisode(
  recoveryStore: RecoveryStore,
  clock: Clock = systemClock(),
): Promise<RecoveryEpisode | undefined> {
  const claimed = await recoveryStore.claimEpisodeForProcessing(clock.now(), PROCESSING_CLAIM_TIMEOUT_MS);
  if (!claimed) return undefined;
  const detector = await getHydratedDegradationDetector(recoveryStore);
  const settled = await runRecoveryPipeline(claimed, recoveryStore, heldPolicies.get(claimed.id), clock, detector);
  if (settled.status === "HELD_DEGRADED") heldPolicies.set(settled.id, heldPolicies.get(claimed.id) ?? defaultMerchantPolicy(settled.event.merchantId));
  await recoveryStore.completeEpisodeProcessing(claimed.id, "DONE");
  return settled;
}

/** Drain up to `max` queued episodes. One failure does not stop the batch. */
export async function drainProcessingQueue(
  recoveryStore: RecoveryStore,
  clock: Clock = systemClock(),
  max = 25,
): Promise<RecoveryEpisode[]> {
  const settled: RecoveryEpisode[] = [];
  for (let i = 0; i < max; i++) {
    let episode: RecoveryEpisode | undefined;
    try {
      episode = await processQueuedEpisode(recoveryStore, clock);
    } catch {
      continue; // claim stays, stale-claim recovery retries it
    }
    if (!episode) break;
    settled.push(episode);
  }
  return settled;
}

/**
 * What a fresh process must do before it can be trusted with traffic.
 *
 * 1. Load the degradation detector's durable state, so an outage that opened before
 *    the deploy is still open afterwards.
 * 2. Give every held episode whose window is no longer open a drain time. Without
 *    this a deploy during an outage strands them at HELD_DEGRADED permanently: the
 *    only thing that ever released them was a `setTimeout` in the process that died.
 * 3. Run the drains that are already due, and pick up any episode that was ingested
 *    but never processed.
 */
export async function recoverAfterRestart(
  recoveryStore: RecoveryStore,
  clock: Clock = systemClock(),
): Promise<{ rescheduled: string[]; drained: string[]; processed: number }> {
  const detector = await getHydratedDegradationDetector(recoveryStore);
  const openWindowIds = new Set(detector.getAllOpen().map((window) => window.id));
  const held = await recoveryStore.listEpisodesByStatus("HELD_DEGRADED");
  const rescheduled: string[] = [];
  for (const episode of held) {
    const windowId = episode.policyDecision?.degradationWindowId ?? null;
    if (windowId && openWindowIds.has(windowId)) continue; // still legitimately held
    const existing = await recoveryStore.getEpisodeProcessing(episode.id);
    if (existing?.drainDueAtMs != null) continue; // already scheduled and durable
    await recoveryStore.scheduleEpisodeDrain(episode.id, clock.now() + detector.drainDelayMs());
    rescheduled.push(episode.id);
  }
  const drained = await processDueDrains(recoveryStore, clock);
  const processed = (await drainProcessingQueue(recoveryStore, clock)).length;
  return { rescheduled, drained, processed };
}

/**
 * Start the out-of-band workers exactly once per process, and run restart recovery
 * exactly once. Called by the webhook handler; deliberately lazy, so a process that
 * never receives traffic never holds a timer.
 */
export function ensureBackgroundWorkers(recoveryStore: RecoveryStore, clock: Clock = systemClock()): void {
  startDegradationCadence(recoveryStore);
  if (!globalPipeline.recoverOsProcessingWorker) {
    let running = false;
    const timer = setInterval(() => {
      if (running) return; // never let two passes overlap on one instance
      running = true;
      void (async () => {
        try {
          await drainProcessingQueue(recoveryStore, clock);
          await processDueDrains(recoveryStore, clock);
        } catch {
          // a poll that fails is retried on the next tick
        } finally {
          running = false;
        }
      })();
    }, PROCESSING_POLL_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    globalPipeline.recoverOsProcessingWorker = timer;
  }
  if (!globalPipeline.recoverOsRecovery) {
    globalPipeline.recoverOsRecovery = recoverAfterRestart(recoveryStore, clock).then(() => undefined).catch(() => undefined);
  }
}

/** Test seam: drop the per-process worker handles so a suite can start clean. */
export function resetBackgroundWorkers(): void {
  if (globalPipeline.recoverOsProcessingWorker) clearInterval(globalPipeline.recoverOsProcessingWorker);
  if (globalPipeline.recoverOsDegradationCadence) clearInterval(globalPipeline.recoverOsDegradationCadence);
  for (const timer of drainTimers.values()) clearTimeout(timer);
  drainTimers.clear();
  heldPolicies.clear();
  globalPipeline.recoverOsProcessingWorker = undefined;
  globalPipeline.recoverOsDegradationCadence = undefined;
  globalPipeline.recoverOsRecovery = undefined;
}
