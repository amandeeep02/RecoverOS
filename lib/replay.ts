import type { PaymentEvent, MerchantPolicy, CustomerProfile, ActionProposal } from "@/lib/domain";
import { diagnose } from "@/lib/diagnosis";
import { evaluatePolicy } from "@/lib/policy";
import { bestAction, scoreRecovery, interventionCosts } from "@/lib/scoring";
import { mulberry32, type Rng } from "@/lib/rng";

export interface ReplayConfig {
  policy: MerchantPolicy;
  modelVersion: string;
}

export interface ReplayEpisodeInput {
  event: PaymentEvent;
  profile: CustomerProfile;
  amountPaise: number;
  /** What the episode ACTUALLY did and what actually happened. `null` when the
   *  episode never reached an observed outcome, in which case every replayed
   *  outcome for it is modelled and is counted as such. */
  actualOutcome: {
    recovered: boolean;
    actualAction?: string | null;
  } | null;
}

export interface ReplayEpisodeResult {
  episodeId: string;
  customerId: string;
  amountPaise: number;
  originalAction: string | null;
  originalOutcome: { recovered: boolean } | null;
  replayAction: string | null;
  replayOutcome: { recovered: boolean } | null;
  usedObservedOutcome: boolean;
  /** The probability the modelled branch drew against. `null` when observed. */
  modelledProbability: number | null;
  eirPaise: number;
  incrementalLift: number;
  interventionCostPaise: number;
  netPaise: number;
}

export interface ReplayTotals {
  recoveredPaise: number;
  interventions: number;
  interventionCostPaise: number;
  protectedPaise: number;
  netPaise: number;
}

export interface ReplayResult {
  episodesReplayed: number;
  /** Episodes with a settled observed outcome. Every delta below is accumulated over
   *  exactly these; an in-flight episode has nothing to be compared against. */
  comparableEpisodes: number;
  /** What the replayed policy would have done. */
  replayed: ReplayTotals;
  /** What actually happened, over the same episodes. Only defined where an outcome
   *  was observed; episodes with no observed outcome contribute 0 to both sides. */
  observed: ReplayTotals;
  deltaRecoveredPaise: number;
  deltaInterventions: number;
  deltaInterventionCostPaise: number;
  deltaProtectedPaise: number;
  deltaNetPaise: number;
  /** Fraction of replayed episodes whose outcome is the REAL observed one because
   *  the replayed action matched what actually happened. The rest are modelled.
   *  This ratio is displayed permanently; a replay console that hides it is a
   *  fiction generator. */
  observedFraction: number;
  observedCount: number;
  modelledCount: number;
  byEpisode: ReplayEpisodeResult[];
}

const NON_INTERVENTION_ACTIONS = new Set(["WAIT", "STOP", "HELD_OUT", "HELD_DEGRADED", null]);

function isIntervention(action: string | null): boolean {
  return !NON_INTERVENTION_ACTIONS.has(action);
}

function costOf(action: string | null): number {
  if (!action) return 0;
  return interventionCosts[action as ActionProposal["action"]] ?? 0;
}

/** FNV-1a over the full episode id: the same episode faces the same draw in every
 *  replay, and two episodes never share a stream. */
function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function replayBatch(
  episodes: ReplayEpisodeInput[],
  config: ReplayConfig,
  _rng: Rng = mulberry32(42),
): ReplayResult {
  const replayed: ReplayTotals = { recoveredPaise: 0, interventions: 0, interventionCostPaise: 0, protectedPaise: 0, netPaise: 0 };
  const observed: ReplayTotals = { recoveredPaise: 0, interventions: 0, interventionCostPaise: 0, protectedPaise: 0, netPaise: 0 };
  let observedCount = 0;
  let comparable = 0;
  const results: ReplayEpisodeResult[] = [];

  for (const ep of episodes) {
    const event = { ...ep.event, amountPaise: ep.amountPaise };
    const episodeId = `replay_${ep.event.paymentId}`;
    const episodeRng = mulberry32(hashString(episodeId));

    const originalAction = ep.actualOutcome?.actualAction ?? null;
    const originalRecovered = ep.actualOutcome?.recovered ?? false;

    const diagnosis = diagnose(event);
    // `bestAction` returns the winning action WITH the EIR it was chosen on. Calling
    // the `proposalFor` wrapper and recomputing `calculateEir(proposal.action, …)`
    // throws that away: when the chooser returns WAIT to protect a dormant
    // subscriber it carries the SUPPRESSED candidate's economics, and recomputing
    // zeroes them — which is why every replay above reported `protected 0` and why
    // moving `churnAversion` changed nothing.
    const choice = bestAction(event, diagnosis, ep.profile, config.policy);
    const proposal = choice.proposal;
    const eir = choice.eir;
    const prediction = scoreRecovery(event, ep.profile, diagnosis, eir.action);
    const policyDecision = evaluatePolicy({
      event,
      profile: ep.profile,
      proposal,
      eir,
      policy: config.policy,
      automatedAttemptCount: 0,
      reminderCount: 0,
      voiceCallCount: 0,
      diagnosisConfidence: diagnosis.confidence,
      degradationWindowId: null,
      episodeId,
    });
    const replayAction = policyDecision.allowedAction ?? (policyDecision.outcome === "REJECT" ? null : "ESCALATE");

    // ===== THE HONESTY RULE (IDEA.md §6.E) =====
    // Where the replayed action matches what actually happened, the outcome is not
    // a prediction — it is the observed fact, and we reuse it. Everywhere else we
    // are modelling, and we say so per episode and in aggregate.
    let replayRecovered: boolean;
    let usedObserved = false;
    let modelledProbability: number | null = null;

    if (ep.actualOutcome && originalAction && replayAction === originalAction) {
      replayRecovered = originalRecovered;
      usedObserved = true;
      observedCount++;
    } else {
      // The modelled branch uses the SAME scorer the production policy is graded
      // on — `scoreRecovery` under the action actually being replayed — so a replay
      // and a live decision cannot disagree about what an action is worth. The old
      // `0.2 + previousRecoveryRate * 0.6` heuristic had no relationship to the
      // scorer, the diagnosis, the amount, or the action.
      const replayPrediction = isIntervention(replayAction)
        ? scoreRecovery(event, ep.profile, diagnosis, replayAction as ActionProposal["action"])
        : prediction;
      modelledProbability = isIntervention(replayAction)
        ? replayPrediction.pRecoverWithAction
        : replayPrediction.pRecoverNative;
      replayRecovered = episodeRng.bernoulli(modelledProbability);
    }

    const replayCost = costOf(replayAction);
    const replayNet = (replayRecovered ? ep.amountPaise : 0) - replayCost;

    // Both sides of the delta are accumulated over the SAME episodes — the ones that
    // actually reached a settled outcome. An episode still in flight has no observed
    // counterpart, so counting its replayed recovery against nothing would invent a
    // gain out of the fact that it has not finished yet.
    if (ep.actualOutcome) {
      comparable++;
      replayed.recoveredPaise += replayRecovered ? ep.amountPaise : 0;
      replayed.interventionCostPaise += replayCost;
      replayed.netPaise += replayNet;
      if (isIntervention(replayAction)) replayed.interventions++;
      // Protected: the scorer says acting is EV-positive before churn and EV-negative
      // after it, and the policy therefore declined. Booked on both sides.
      if (eir.eirPaise < 0 && eir.eirWithoutChurnPaise >= config.policy.minimumEirPaise) {
        replayed.protectedPaise += eir.churnCostPaise;
      }

      const originalCost = costOf(originalAction);
      observed.recoveredPaise += originalRecovered ? ep.amountPaise : 0;
      observed.interventionCostPaise += originalCost;
      observed.netPaise += (originalRecovered ? ep.amountPaise : 0) - originalCost;
      if (isIntervention(originalAction)) observed.interventions++;
    }

    results.push({
      episodeId,
      customerId: ep.event.customerId,
      amountPaise: ep.amountPaise,
      originalAction,
      originalOutcome: ep.actualOutcome ? { recovered: originalRecovered } : null,
      replayAction,
      replayOutcome: { recovered: replayRecovered },
      usedObservedOutcome: usedObserved,
      modelledProbability,
      eirPaise: eir.eirPaise,
      incrementalLift: eir.incrementalLift,
      interventionCostPaise: replayCost,
      netPaise: replayNet,
    });
  }

  const n = episodes.length;
  return {
    episodesReplayed: n,
    comparableEpisodes: comparable,
    replayed,
    observed,
    deltaRecoveredPaise: replayed.recoveredPaise - observed.recoveredPaise,
    deltaInterventions: replayed.interventions - observed.interventions,
    deltaInterventionCostPaise: replayed.interventionCostPaise - observed.interventionCostPaise,
    deltaProtectedPaise: replayed.protectedPaise - observed.protectedPaise,
    deltaNetPaise: replayed.netPaise - observed.netPaise,
    observedFraction: n === 0 ? 0 : observedCount / n,
    observedCount,
    modelledCount: n - observedCount,
    byEpisode: results,
  };
}
