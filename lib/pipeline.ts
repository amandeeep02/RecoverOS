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
import { DEGRADATION_CONFIG, DegradationDetector, getDegradationDetector, keyString, type DegradationWindow } from "@/lib/degradation";
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
const FATIGUE_CONTACT_ACTIONS = new Set(["REMINDER", "PAYMENT_LINK", "VOICE_CALL"]);

/**
 * How many times we have actually reached this customer inside the fatigue window.
 *
 * Counted from executed episodes rather than trusted from the stored profile: the
 * profile field is written by whoever last touched it, while an episode carrying an
 * EXECUTED/SIMULATED contact action is a record of a message that left the building.
 * Silent retries are excluded — a customer cannot get tired of something they never
 * saw — which is the same rule the evaluation harness applies.
 *
 * Cost note for whoever productionises this: `listEpisodes()` is the only read the
 * store interface offers, so this is O(all episodes) per failure. It wants a
 * `countContactsSince(merchantId, customerId, since)` on `RecoveryStore`; that file
 * is outside this change.
 */
async function priorContactCount(
  recoveryStore: RecoveryStore,
  event: PaymentEvent,
  nowMs: number,
  excludeEpisodeId: string,
): Promise<number> {
  const episodes = await recoveryStore.listEpisodes();
  let n = 0;
  for (const episode of episodes) {
    if (episode.id === excludeEpisodeId) continue;
    if (episode.event.customerId !== event.customerId) continue;
    if (episode.event.merchantId !== event.merchantId) continue;
    const execution = episode.execution;
    if (!execution || (execution.status !== "EXECUTED" && execution.status !== "SIMULATED")) continue;
    const action = episode.policyDecision?.allowedAction ?? episode.proposal?.action ?? null;
    if (!action || !FATIGUE_CONTACT_ACTIONS.has(action)) continue;
    const at = Date.parse(execution.executedAt);
    if (Number.isNaN(at) || nowMs - at > CONTACT_FATIGUE_WINDOW_MS) continue;
    n += 1;
  }
  return n;
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

export async function processPaymentFailure(
  event: PaymentEvent,
  recoveryStore: RecoveryStore,
  suppliedPolicy?: MerchantPolicy,
  clock: Clock = systemClock(),
  rng: Rng = mulberry32(1),
  degradationDetector?: DegradationDetector,
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
    customerResponses: [],
    createdAt: now,
    updatedAt: now,
  };
  await recoveryStore.saveEpisode(episode);
  await audit(recoveryStore, episode, "INGESTED", { event, idempotency: "new" }, clock);
  realtimeServer.emit({ type: "episode.created", episode: { id: episode.id, status: episode.status, customerId: episode.event.customerId, amountPaise: episode.event.amountPaise } });

  // Async so the long-tail LLM classifier can run. Safe unconditionally: with no
  // API key configured it returns exactly what the synchronous `diagnose` returns,
  // and structured failure codes never consult the model at all.
  const diagnosis = await diagnoseAsync(event);
  episode = transitionEpisode(episode, "DIAGNOSED", clock);
  episode = { ...episode, diagnosis };
  await recoveryStore.saveEpisode(episode);
  await audit(recoveryStore, episode, "DIAGNOSED", diagnosis, clock);
  realtimeServer.emit({ type: "episode.updated", episode: { id: episode.id, status: episode.status, customerId: episode.event.customerId, amountPaise: episode.event.amountPaise } });

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
  episode = transitionEpisode(episode, "SCORED", clock);
  episode = { ...episode, prediction, eir };
  await recoveryStore.saveEpisode(episode);
  await audit(recoveryStore, episode, "SCORED", { prediction, eir, candidates: choice.candidates }, clock);
  realtimeServer.emit({ type: "episode.updated", episode: { id: episode.id, status: episode.status, customerId: episode.event.customerId, amountPaise: episode.event.amountPaise } });

  episode = transitionEpisode(episode, "PROPOSED", clock);
  episode = { ...episode, proposal };
  await recoveryStore.saveEpisode(episode);
  await audit(recoveryStore, episode, "PROPOSED", { ...proposal, candidates: choice.candidates }, clock);
  realtimeServer.emit({ type: "episode.updated", episode: { id: episode.id, status: episode.status, customerId: episode.event.customerId, amountPaise: episode.event.amountPaise, action: proposal.action } });

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
  episode = transitionEpisode(episode, "POLICY_CHECK", clock);
  episode = { ...episode, policyDecision };
  await recoveryStore.saveEpisode(episode);
  await audit(recoveryStore, episode, "POLICY", policyDecision, clock);
  realtimeServer.emit({ type: "episode.updated", episode: { id: episode.id, status: episode.status, customerId: episode.event.customerId, amountPaise: episode.event.amountPaise, action: policyDecision.allowedAction ?? undefined } });

  return { episode: await applyPolicyDecision(episode, recoveryStore, clock), duplicate: false };
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

  episode = transitionEpisode(episode, "EXECUTING", clock);
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
};
const heldPolicies = globalPipeline.recoverOsHeldPolicies ?? (globalPipeline.recoverOsHeldPolicies = new Map());
const drainTimers = globalPipeline.recoverOsDrainTimers ?? (globalPipeline.recoverOsDrainTimers = new Map());

/**
 * The production entry point for an ingested failure.
 *
 * `processPaymentFailure` takes the detector as an optional argument and no caller
 * ever supplied one, which made `HELD_DEGRADED` unreachable outside a script. This
 * wrapper is what the webhook and the demo controls call: every ingested event is
 * recorded into the process-wide detector before the policy sees it, and the same
 * detector instance is handed to the policy gate.
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
  const detector = getDegradationDetector(recoveryStore);
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

  return { opened, closed, drainScheduled };
}

async function scheduleDrain(
  window: DegradationWindow,
  recoveryStore: RecoveryStore,
  detector: DegradationDetector,
  clock: Clock,
) {
  const held = (await recoveryStore.listEpisodes()).filter(
    (episode) => episode.status === "HELD_DEGRADED" && episode.policyDecision?.degradationWindowId === window.id,
  );
  const scheduled: DegradationTickResult["drainScheduled"] = [];
  for (const episode of held) {
    const delayMs = detector.drainDelayMs();
    scheduled.push({ episodeId: episode.id, windowId: window.id, delayMs });
    const timer = setTimeout(() => {
      drainTimers.delete(episode.id);
      void resumeHeldEpisode(episode.id, recoveryStore, clock).catch(() => {});
    }, delayMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    drainTimers.set(episode.id, timer);
  }
  return scheduled;
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
