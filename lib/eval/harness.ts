// lib/eval/harness.ts
import type { MerchantPolicy } from "@/lib/domain";
import { mulberry32, type Rng } from "@/lib/rng";
import { rupees, type Paise } from "@/lib/money";
import { diagnose } from "@/lib/diagnosis";
import { evaluatePolicy } from "@/lib/policy";
import { assignArm, HOLDOUT_VALUE_CAP_PAISE } from "@/lib/experiment";
import { bestAction, calculateEir, scoreRecovery } from "@/lib/scoring";
import {
  generateSyntheticWorld, eventFromSyntheticCase, oracleStrategy,
  fatiguedActionProbability, fatiguedChurn, DEFAULT_ASSUMPTIONS,
  type SyntheticCase, type SyntheticWorld, type HiddenTruth, type GeneratorAssumptions,
} from "@/lib/simulator";
import {
  clusteredBootstrapCi, tInterval, validateHoldoutEstimator,
  type EpisodeRecord, type HoldoutEstimate, type TIntervalStat, type CoverageReport,
} from "./estimators";

export interface EngineDeps {
  rng: Rng;
}

/**
 * Unit at which the holdout is randomized.
 *
 *  "customer" — randomization unit == interference unit. Contact fatigue, message
 *               caps and voice caps are all per-customer, so this is the only unit
 *               under which a treated episode cannot interfere with a held-out one.
 *               `lib/policy.ts` does this, so this is
 *               what the harness gets from the policy and what the report uses.
 *  "episode"   — what `lib/policy.ts` used to do: hash the episode id. Two episodes
 *               of the same customer could land in opposite arms. Retained ONLY as
 *               a retrospective probe: the harness overrides the policy's arm with
 *               an episode-level draw on exactly the episodes the policy admitted
 *               to randomization, reproducing the old assignment faithfully.
 */
export type RandomizationUnit = "episode" | "customer";

/**
 * Factual note on the randomization key, verified at runtime by
 * `HoldoutResult.customersSplitAcrossArms`. Printed to the console by
 * scripts/eval.ts so a run always states which behaviour produced its numbers.
 * It is deliberately NOT written into RESULTS.md: that is a results document,
 * not a code review.
 */
export const RANDOMIZATION_UNIT_NOTE =
  'lib/policy.ts randomizes the holdout on input.event.customerId. Contact fatigue '
  + 'and message caps are per-customer, so this puts the randomization unit and the '
  + 'interference unit in the same place. The harness asserts it every run: zero '
  + 'customers may have eligible episodes in both arms. The "episode" row in '
  + 'RESULTS.md is a retrospective sensitivity probe of episode-level assignment, '
  + 'produced by the harness overriding the arm — it is not the shipped behaviour.';

export interface EvalConfig {
  episodes: number;
  seeds: number[];
  policy: MerchantPolicy;
  holdoutPct: number;
  assumptions?: GeneratorAssumptions;
  /** Defaults to "customer" — the only unit under which the estimand is identified. */
  randomizationUnit?: RandomizationUnit;
  /** Also run RecoverOS under episode-level randomization to quantify the SUTVA bias. */
  sutvaProbe?: boolean;
  bootstrapResamples?: number;
}

export type ArmName = "BASELINE" | "RULES" | "RECOVEROS" | "ORACLE" | "RECOVEROS_COMPLIANT";
export type ArmKey = "baseline" | "rules" | "recoverOs" | "recoverOsCompliant" | "oracle";
export const ARM_KEYS: ArmKey[] = ["baseline", "rules", "recoverOs", "recoverOsCompliant", "oracle"];

export interface ArmResult {
  arm: ArmName;
  episodes: number;
  recoveredPaise: Paise;
  atRiskPaise: Paise;
  interventions: number;
  /** Human reviews. Billed at ₹110 and, unlike the automated actions, executed
   *  outside the contact budget. Counted inside `interventions` as well. */
  escalations: number;
  interventionCostPaise: Paise;
  /** Residual LTV destroyed by contacting subscribers who churn on contact. */
  churnCostPaise: Paise;
  /**
   * DEPRECATED — not reported. An arm earns "protection" credit on an episode it
   * skipped, but the hazard it is credited against was inflated by that same arm's
   * OWN earlier contacts, so nagging a customer and then going quiet scores higher
   * than never nagging at all. It also fails to separate the arms. Kept as a raw
   * field only so nothing silently changes shape; do not put it in a report.
   */
  protectedPaise: Paise;
  /** recovered − intervention cost − churn cost. The only column that answers
   *  "was this worth doing". Omitting churn flatters any arm that contacts
   *  indiscriminately and penalises any arm that deliberately stays quiet. */
  netPaise: Paise;
  contactsMade: number;
  recoveryRate: number;
}

export interface HoldoutResult extends HoldoutEstimate {
  randomizationUnit: RandomizationUnit;
  /**
   * TRUE incremental rupees generated on the treated episodes, read from planted
   * ground truth: Σ_treated (p_realized − p_native) × amount. This is what the
   * holdout is trying to measure. Coverage against THIS is the real test.
   */
  trueIncrementalPaise: Paise;
  /**
   * E[Θ̂ | assignment, amounts] — the estimator's own estimand, computed from the
   * planted probabilities: (mean_T p_realized − mean_H p_native) × Ā_T × n_T.
   * Coverage against this isolates bootstrap performance from design bias; the
   * gap between it and `trueIncrementalPaise` IS the design bias.
   */
  plantedEstimandPaise: Paise;
  /** (incrementalPaise − trueIncrementalPaise) / |trueIncrementalPaise| */
  relativeBias: number;
  /** Same, for the revenue-weighted difference-in-means estimator. */
  revenueRelativeBias: number;
  /**
   * Customers with eligible episodes in BOTH arms. Under customer-level
   * randomization this must be 0; any other value means the randomization unit is
   * not the interference unit and the holdout is not a clean counterfactual. This
   * is a runtime assertion on `lib/policy.ts`, not a statistic.
   */
  customersSplitAcrossArms: number;
}

export interface SeedResult {
  seed: number;
  arms: Record<ArmKey, ArmResult>;
  holdout?: HoldoutResult;
  /** Same arm, episode-level randomization. Present only when `sutvaProbe`. */
  holdoutEpisodeRandomized?: HoldoutResult;
  /** Kept for backwards compatibility: equals `holdout.trueIncrementalPaise`. */
  plantedIncrementalPaise: Paise;
}

export type AggregateStat = TIntervalStat;

export interface EvalReport {
  config: EvalConfig;
  perSeed: SeedResult[];
  aggregate: Record<string, AggregateStat>;
  /** Estimator validation across seeds. The only evidence the estimator works. */
  coverage?: {
    againstTruth: CoverageReport;
    againstEstimand: CoverageReport;
    /** Revenue-weighted estimator vs the same planted truth. */
    revenueAgainstTruth: CoverageReport;
    /** Same, under the current (episode-level) policy.ts randomization. */
    episodeRandomizedAgainstTruth?: CoverageReport;
  };
  generatedAtIso: string;
  gitSha: string;
  /** True when the working tree differs from gitSha. A stamp naming a commit that
   *  cannot produce these numbers discredits every figure beside it. */
  gitDirty: boolean;
}

// ---------------------------------------------------------------------------
// per-episode RNG
// ---------------------------------------------------------------------------

/** FNV-1a over the FULL id, 32-bit. */
function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Common random numbers, correctly scoped.
 *
 * Episode ids are `tx_<seed>_<index>`. Seeding on the INDEX alone (the old
 * `Number(item.id.split("_")[2])`) gives episode 0 of seed 1 the identical RNG
 * stream as episode 0 of seed 7 — so 20 "independent seeds" shared one noise
 * realization and the across-seed spread was an underestimate of run-to-run
 * variance. Hashing the whole id keeps CRN where it is wanted (the same episode
 * faces the same draw in every ARM) and removes it where it is a bug (across
 * seeds).
 */
function episodeRng(episodeId: string): Rng {
  return mulberry32(hashString(episodeId));
}

// ---------------------------------------------------------------------------
// contact history
// ---------------------------------------------------------------------------

const CAP_WINDOW_MS = 30 * 86_400_000;      // message/voice caps: one billing period
const FATIGUE_WINDOW_MS = 90 * 86_400_000;  // patience recovers slower than caps reset

const EXECUTED_ACTIONS = ["PAYMENT_LINK", "REMINDER", "RETRY", "VOICE_CALL"];
const CONTACT_ACTIONS = ["PAYMENT_LINK", "REMINDER", "VOICE_CALL"];

/**
 * Per-customer contact history for ONE arm. This is the scarce resource: an arm
 * that spends its contacts on the wrong episodes has fewer left, and the ones it
 * does spend work less well. It is arm-local by construction — each arm gets its
 * own history, so the comparison stays fair.
 */
class ContactHistory {
  private readonly contacts = new Map<string, number[]>();
  private readonly attempts = new Map<string, number[]>();
  private readonly reminders = new Map<string, number[]>();
  private readonly voice = new Map<string, number[]>();

  private static since(log: Map<string, number[]>, id: string, now: number, windowMs: number) {
    const times = log.get(id);
    if (!times) return 0;
    let n = 0;
    for (let i = times.length - 1; i >= 0; i--) {
      if (now - times[i] > windowMs) break;
      n++;
    }
    return n;
  }

  private static push(log: Map<string, number[]>, id: string, at: number) {
    const times = log.get(id);
    if (times) times.push(at); else log.set(id, [at]);
  }

  /** Counts the policy needs: caps are enforced over one billing period. */
  capsAt(customerId: string, now: number) {
    return {
      automatedAttemptCount: ContactHistory.since(this.attempts, customerId, now, CAP_WINDOW_MS),
      reminderCount: ContactHistory.since(this.reminders, customerId, now, CAP_WINDOW_MS),
      voiceCallCount: ContactHistory.since(this.voice, customerId, now, CAP_WINDOW_MS),
    };
  }

  /** Fatigue decays over a longer horizon than the caps reset. */
  priorContacts(customerId: string, now: number) {
    return ContactHistory.since(this.contacts, customerId, now, FATIGUE_WINDOW_MS);
  }

  record(customerId: string, action: string, at: number) {
    if (EXECUTED_ACTIONS.includes(action)) ContactHistory.push(this.attempts, customerId, at);
    if (CONTACT_ACTIONS.includes(action)) ContactHistory.push(this.contacts, customerId, at);
    if (action === "REMINDER") ContactHistory.push(this.reminders, customerId, at);
    if (action === "VOICE_CALL") ContactHistory.push(this.voice, customerId, at);
  }
}

// ---------------------------------------------------------------------------
// arm decisions
// ---------------------------------------------------------------------------

interface ArmDecision {
  action: string;
  /** Entered randomization: this arm would genuinely have acted here. */
  eligible: boolean;
  /**
   * Something actually happened. This is the single flag that governs BOTH the
   * bill and the effect: an action that is not executed is charged ₹0 and its
   * episode resolves at the native probability. Previously the cost was charged
   * outside the executed guard, so ESCALATE was billed ₹110 on episodes where
   * nothing ran while still collecting a planted +0.05 lift for free.
   */
  executed: boolean;
  arm?: "TREATMENT" | "HOLDOUT";
}

function baselineDecision(item: SyntheticCase): ArmDecision {
  const eligible = !["permanent_decline", "mandate_rejected"].includes(item.failureCode);
  const action = eligible ? "RETRY" : "WAIT";
  return { action, eligible, executed: eligible };
}

function rulesDecision(item: SyntheticCase): ArmDecision {
  const action = item.paymentMethod === "card" && item.nativeRecoveryState === "ACTIVE"
    ? "WAIT"
    : item.failureCode === "insufficient_funds" && item.profile.consentValid && !item.profile.optedOut && item.profile.contactWindowOpen
      ? "REMINDER"
      : item.failureCode === "expired_card" || item.failureCode === "authentication_failed"
        ? "PAYMENT_LINK"
        : item.failureCode === "bank_declined"
          ? "RETRY"
          : "WAIT";
  const eligible = action !== "WAIT";
  return { action, eligible, executed: eligible };
}

/**
 * `regulatory` turns on the gate in lib/policy.ts by supplying the decision's
 * wall-clock. See COMPLIANCE_MEASUREMENT_NOTE for what that does and does not
 * measure — in short, only the time-derived gate can bind here, because the
 * world plants no DLT/opt-in/e-mandate facts and a fail-closed gate on absent
 * metadata would measure the simulator's silence rather than the regulation.
 */
function recoverOsDecision(
  item: SyntheticCase,
  policy: MerchantPolicy,
  caps: { automatedAttemptCount: number; reminderCount: number; voiceCallCount: number },
  unit: RandomizationUnit,
  priorContacts: number,
  regulatory = false,
): ArmDecision {
  const event = eventFromSyntheticCase(item);
  const diagnosis = diagnose(event);
  // The one observable the churn term used to be blind to. `ContactHistory` has
  // carried this arm's true per-customer contact count all along; the profile
  // shipped `previousInterventionCount: 0` and nothing read it, so EIR priced a
  // customer we had nagged five times this quarter exactly like one we had never
  // written to. This is not new information — it is information the harness
  // already held and threw away at the boundary. It stays arm-local: each arm has
  // its own history, so no arm can see another's contacts.
  const profile = { ...item.profile, previousInterventionCount: priorContacts };
  // Argmax over the feasible action set, with the arm's REAL per-customer caps.
  // Passing caps matters beyond bookkeeping: an exhausted message budget drops only
  // REMINDER from the candidate set, letting a payment link or a silent retry win,
  // instead of escalating the whole episode to a ₹110 human review. Use the EIR the
  // chooser already computed for the winner rather than re-deriving it — recomputing
  // was how the veto-shaped version drifted from the action it was scoring.
  const choice = bestAction(event, diagnosis, profile, policy, caps);
  const proposal = choice.proposal;
  const eir = choice.eir;
  const policyDecision = evaluatePolicy({
    event,
    profile,
    proposal,
    eir,
    policy,
    ...caps,
    diagnosisConfidence: diagnosis.confidence,
    degradationWindowId: null,
    episodeId: item.id,
    // Supplying nowIso is what arms the regulatory gate. The context below grants
    // the metadata the world does not model, so that exactly one gate can refuse:
    // the time-derived one. Granting it is the conservative choice — every field
    // left absent would fail closed and inflate the measured cost of compliance
    // with the simulator's missing data.
    ...(regulatory ? {
      nowIso: new Date(item.occurredAtMs).toISOString(),
      complianceContext: {
        dltTemplateId: "DLT_TXN_RECOVERY_001",
        whatsappOptedIn: true,
        whatsappTemplateId: "wa_txn_payment_failed_v1",
        lastCustomerMessageAtIso: new Date(item.occurredAtMs).toISOString(),
        preDebitNotificationSentAtIso: new Date(item.occurredAtMs - 25 * 60 * 60 * 1000).toISOString(),
        afaCompleted: true,
      },
    } : {}),
  });

  // Holdout, suppression and degradation holds all arrive as non-APPROVE
  // outcomes, so the specific disposition must be read BEFORE the generic
  // escalation fallback — exactly as lib/pipeline.ts does it. Checking
  // `outcome !== "APPROVE"` first makes the holdout branch unreachable and
  // silently collapses the experiment to a single arm.
  // `arm` is set by policy.ts exactly when the episode entered randomization (or
  // was exempted by the value cap). Read it BEFORE the generic escalation
  // fallback, exactly as lib/pipeline.ts does — checking `outcome !== "APPROVE"`
  // first makes the holdout branch unreachable and silently collapses the
  // experiment to a single arm.
  if (policyDecision.arm !== undefined) {
    // What would have run had this episode been treated.
    const wouldExecute = policyDecision.allowedAction === "HELD_OUT"
      ? String(policyDecision.proposedAction ?? "ESCALATE")
      : String(policyDecision.allowedAction ?? "ESCALATE");
    // Retrospective probe: re-draw the arm at the episode level on exactly the
    // episodes policy.ts admitted to randomization, honouring the same value cap.
    const arm = unit === "episode"
      ? (item.amountPaise > HOLDOUT_VALUE_CAP_PAISE ? "TREATMENT" : assignArm(item.id, policy.holdoutPct ?? 0))
      : policyDecision.arm;
    if (arm === "HOLDOUT") {
      // Eligible (it entered randomization) but deliberately untreated.
      return { action: "WAIT", eligible: true, executed: false, arm: "HOLDOUT" };
    }
    return { action: wouldExecute, eligible: true, executed: true, arm: "TREATMENT" };
  }
  if (policyDecision.suppressionReason || policyDecision.allowedAction === "HELD_DEGRADED") {
    // Nothing is executed, so the episode resolves against native recovery.
    // Resolving these as ESCALATE would hand them a human agent's lift for free.
    return { action: "WAIT", eligible: false, executed: false };
  }
  if (policyDecision.outcome === "REJECT") {
    // The action was refused outright. Nothing runs, nothing is billed, and the
    // episode resolves natively. A REJECT must never be dressed up as a ₹110 human
    // review just because `allowedAction` is null.
    return { action: "WAIT", eligible: false, executed: false };
  }
  if (policyDecision.outcome !== "APPROVE") {
    // ESCALATE is a real human review: it is billed ₹110 AND it runs, so it earns
    // the planted human-agent lift. It is not an automated contact, so it consumes
    // no message/voice budget and carries no contact-fatigue churn. It does not
    // enter the experiment: escalation is not a randomized treatment.
    const action = policyDecision.allowedAction || "ESCALATE";
    return { action, eligible: false, executed: action === "ESCALATE" };
  }
  if (policyDecision.allowedAction === "STOP" || policyDecision.allowedAction === "WAIT") {
    return { action: policyDecision.allowedAction, eligible: false, executed: false };
  }

  // Approved but never randomized (policy.ts leaves `arm` unset on the WAIT/STOP
  // short-circuit). Nothing executable is left; resolve it natively.
  return { action: policyDecision.allowedAction ?? "WAIT", eligible: false, executed: false };
}

// ---------------------------------------------------------------------------
// outcome resolution
// ---------------------------------------------------------------------------

function nonAction(action: string) {
  return action === "WAIT" || action === "STOP" || action === "HELD_OUT" || action === "HELD_DEGRADED";
}

/** Planted probability this episode faces, given what was actually executed. */
function realizedProbability(
  truth: HiddenTruth,
  action: string,
  executed: boolean,
  priorContacts: number,
  assumptions: GeneratorAssumptions,
): number {
  if (!executed || nonAction(action)) return truth.nativeProbability;
  return fatiguedActionProbability(truth, action as never, priorContacts, assumptions);
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

export function runEval(config: EvalConfig): EvalReport {
  const {
    episodes, seeds, policy, holdoutPct,
    assumptions = DEFAULT_ASSUMPTIONS,
    randomizationUnit = "customer",
    sutvaProbe = false,
    bootstrapResamples = 10_000,
  } = config;
  const perSeed: SeedResult[] = [];

  for (const seed of seeds) {
    const world = generateSyntheticWorld(seed, episodes, assumptions);
    const oracle = oracleStrategy(world, assumptions);

    const baselineRun = evaluateArm(world, "BASELINE", (item) => baselineDecision(item), assumptions);
    const rulesRun = evaluateArm(world, "RULES", (item) => rulesDecision(item), assumptions);
    const recoverOsRun = evaluateArm(world, "RECOVEROS", (item, caps, priorContacts) => recoverOsDecision(item, policy, caps, randomizationUnit, priorContacts), assumptions);
    // Identical policy, identical world, identical CRN — the only difference is that
    // the regulatory gate is armed. So the per-seed difference against `recoverOs` is
    // paired and is the cost of compliance, not a comparison of two products.
    const recoverOsCompliantRun = evaluateArm(world, "RECOVEROS_COMPLIANT", (item, caps, priorContacts) => recoverOsDecision(item, policy, caps, randomizationUnit, priorContacts, true), assumptions);
    const oracleRun = evaluateArm(world, "ORACLE", (item, _caps, priorContacts) => {
      const d = oracle(item, priorContacts);
      const acts = d.action !== "WAIT" && d.action !== "STOP";
      return { action: d.action, eligible: acts, executed: acts };
    }, assumptions);

    let holdout: HoldoutResult | undefined;
    let holdoutEpisodeRandomized: HoldoutResult | undefined;
    if (holdoutPct > 0) {
      holdout = summariseHoldout(recoverOsRun, randomizationUnit, bootstrapResamples, mulberry32(hashString(`boot_${seed}_${randomizationUnit}`)));
      if (sutvaProbe) {
        const other: RandomizationUnit = randomizationUnit === "customer" ? "episode" : "customer";
        const probeRun = evaluateArm(world, "RECOVEROS", (item, caps, priorContacts) => recoverOsDecision(item, policy, caps, other, priorContacts), assumptions);
        holdoutEpisodeRandomized = summariseHoldout(probeRun, other, bootstrapResamples, mulberry32(hashString(`boot_${seed}_${other}`)));
      }
    }

    perSeed.push({
      seed,
      arms: {
        baseline: baselineRun.result,
        rules: rulesRun.result,
        recoverOs: recoverOsRun.result,
        recoverOsCompliant: recoverOsCompliantRun.result,
        oracle: oracleRun.result,
      },
      holdout,
      holdoutEpisodeRandomized,
      plantedIncrementalPaise: holdout?.trueIncrementalPaise ?? 0,
    });
  }

  const aggregate = computeAggregate(perSeed);
  const withHoldout = perSeed.filter((s) => s.holdout);
  const coverage = withHoldout.length > 0
    ? {
      againstTruth: validateHoldoutEstimator(
        withHoldout.map((s) => s.holdout!.trueIncrementalPaise),
        withHoldout.map((s) => s.holdout!),
      ),
      againstEstimand: validateHoldoutEstimator(
        withHoldout.map((s) => s.holdout!.plantedEstimandPaise),
        withHoldout.map((s) => s.holdout!),
      ),
      revenueAgainstTruth: validateHoldoutEstimator(
        withHoldout.map((s) => s.holdout!.trueIncrementalPaise),
        withHoldout.map((s) => ({
          incrementalPaise: s.holdout!.revenueIncrementalPaise,
          ciLoPaise: s.holdout!.revenueCiLoPaise,
          ciHiPaise: s.holdout!.revenueCiHiPaise,
        })),
      ),
      episodeRandomizedAgainstTruth: perSeed.every((s) => s.holdoutEpisodeRandomized)
        ? validateHoldoutEstimator(
          perSeed.map((s) => s.holdoutEpisodeRandomized!.trueIncrementalPaise),
          perSeed.map((s) => s.holdoutEpisodeRandomized!),
        )
        : undefined,
    }
    : undefined;

  return {
    config,
    perSeed,
    aggregate,
    coverage,
    generatedAtIso: new Date().toISOString(),
    gitSha: "unknown",
    gitDirty: (() => { try { return require("node:child_process").execSync("git status --porcelain", { encoding: "utf8" }).trim().length > 0; } catch { return true; } })(),
  };
}

interface ArmRun {
  result: ArmResult;
  /** One record per ELIGIBLE episode — the experiment population. */
  records: EpisodeRecord[];
}

/**
 * Scores one arm against planted ground truth, walking the world in chronological
 * order so the arm's own past contacts constrain its future ones.
 *
 * EVERY episode resolves an outcome, including the ones the arm declines to
 * touch: a refusal is scored against native issuer recovery, not against zero.
 * Skipping declined episodes credits an arm with nothing for money that arrives
 * on its own, which understates any policy that waits and flatters any policy
 * that acts indiscriminately.
 *
 * Outcomes use a per-episode RNG seeded on a hash of the full episode id, so the
 * same episode faces the identical draw in every arm (common random numbers) and
 * different seeds are genuinely different noise realizations.
 *
 * The outcome is resolved ONCE, here, and the holdout estimator reads these same
 * records. Re-resolving outcomes inside the estimator (as the previous version
 * did, with a different RNG) made the reported lift inconsistent with the
 * reported recovery.
 */
function evaluateArm(
  world: SyntheticWorld,
  armName: ArmName,
  decide: (item: SyntheticCase, caps: { automatedAttemptCount: number; reminderCount: number; voiceCallCount: number }, priorContacts: number) => ArmDecision,
  assumptions: GeneratorAssumptions,
): ArmRun {
  let recoveredPaise = 0;
  let atRiskPaise = 0;
  let interventions = 0;
  let escalations = 0;
  let interventionCostPaise = 0;
  let churnCostPaise = 0;
  let protectedPaise = 0;
  let contactsMade = 0;
  const records: EpisodeRecord[] = [];
  const history = new ContactHistory();
  // A subscriber can be lost exactly once. Without this, every subsequent episode of an
  // already-churned customer books their residual value again — which inflates the churn
  // charged to any arm that contacts repeatedly, and flatters Baseline, which pays zero
  // churn by construction and therefore cannot be over-charged.
  const churned = new Set<string>();

  for (const item of world.cases) {
    const now = item.occurredAtMs;
    const priorContactsNow = history.priorContacts(item.customerId, now);
    const decision = decide(item, history.capsAt(item.customerId, now), priorContactsNow);
    const { action, eligible, executed, arm } = decision;
    const truth = world.hidden.get(item.id)!;
    const rng = episodeRng(item.id);
    const priorContacts = priorContactsNow;

    atRiskPaise += item.amountPaise;
    const pRealized = realizedProbability(truth, action, executed, priorContacts, assumptions);
    const recovered = rng.bernoulli(pRealized);
    if (recovered) recoveredPaise += item.amountPaise;

    // One flag governs the bill and the effect. Nothing is charged for work that
    // did not happen, and nothing that did not happen produces a lift.
    if (executed) {
      interventionCostPaise += getInterventionCost(action, assumptions);
      interventions += 1;
      if (action === "ESCALATE") escalations += 1;
      if (EXECUTED_ACTIONS.includes(action)) {
        if (CONTACT_ACTIONS.includes(action)) contactsMade += 1;
        history.record(item.customerId, action, now);
      }
    }

    // The dormancy bet. `protectedPaise` is computed but deliberately not reported
    // — see the field comment on ArmResult.
    if (executed && CONTACT_ACTIONS.includes(action)) {
      if (!churned.has(item.customerId) && fatiguedChurn(truth, priorContacts, assumptions)) {
        churned.add(item.customerId);
        churnCostPaise += truth.residualValuePaise;
      }
    } else if (fatiguedChurn(truth, priorContacts, assumptions)) {
      protectedPaise += truth.residualValuePaise;
    }

    if (eligible) {
      records.push({
        episodeId: item.id,
        customerId: item.customerId,
        amountPaise: item.amountPaise,
        arm: arm === "HOLDOUT" ? "HOLDOUT" : "TREATMENT",
        recovered,
        pRealized,
        pNative: truth.nativeProbability,
      });
    }
  }

  return {
    result: {
      arm: armName,
      episodes: world.cases.length,
      recoveredPaise,
      atRiskPaise,
      interventions,
      escalations,
      interventionCostPaise,
      churnCostPaise,
      protectedPaise,
      netPaise: recoveredPaise - interventionCostPaise - churnCostPaise,
      contactsMade,
      recoveryRate: atRiskPaise > 0 ? recoveredPaise / atRiskPaise : 0,
    },
    records,
  };
}

function summariseHoldout(
  run: ArmRun,
  unit: RandomizationUnit,
  resamples: number,
  rng: Rng,
): HoldoutResult {
  const estimate = clusteredBootstrapCi(run.records, resamples, rng);

  // Planted quantities, on exactly the population the estimator uses.
  let trueIncrementalPaise = 0;
  let sumRealizedT = 0, sumNativeH = 0, nT = 0, nH = 0, amtT = 0;
  for (const r of run.records) {
    if (r.arm === "TREATMENT") {
      trueIncrementalPaise += (r.pRealized - r.pNative) * r.amountPaise;
      sumRealizedT += r.pRealized;
      amtT += r.amountPaise;
      nT += 1;
    } else {
      sumNativeH += r.pNative;
      nH += 1;
    }
  }
  const seenArms = new Map<string, number>();
  for (const r of run.records) {
    seenArms.set(r.customerId, (seenArms.get(r.customerId) ?? 0) | (r.arm === "HOLDOUT" ? 1 : 2));
  }
  let customersSplitAcrossArms = 0;
  for (const v of seenArms.values()) if (v === 3) customersSplitAcrossArms += 1;

  const meanAmountT = nT > 0 ? amtT / nT : 0;
  const plantedEstimandPaise = nT > 0 && nH > 0
    ? Math.round((sumRealizedT / nT - sumNativeH / nH) * meanAmountT * nT)
    : 0;
  const truth = Math.round(trueIncrementalPaise);

  return {
    ...estimate,
    randomizationUnit: unit,
    trueIncrementalPaise: truth,
    plantedEstimandPaise,
    relativeBias: truth !== 0 ? (estimate.incrementalPaise - truth) / Math.abs(truth) : 0,
    revenueRelativeBias: truth !== 0 ? (estimate.revenueIncrementalPaise - truth) / Math.abs(truth) : 0,
    customersSplitAcrossArms,
  };
}

function computeAggregate(perSeed: SeedResult[]): Record<string, AggregateStat> {
  const result: Record<string, AggregateStat> = {};
  for (const arm of ARM_KEYS) {
    result[arm] = tInterval(perSeed.map((s) => s.arms[arm].netPaise / 100));
  }
  return result;
}

/**
 * What an action ACTUALLY costs, from the world — not what the agent believes it costs.
 *
 * This was a hardcoded table duplicating `interventionCosts` in lib/scoring.ts, so the
 * evaluator billed every arm at the agent's own price list. Two consequences, both bad:
 * the agent could never be penalised for mispricing its own actions (its beliefs and
 * its bill agreed by construction), and `interventionCostScale` in the sensitivity
 * sweep moved nothing at all — five values across a 4x range returned byte-identical
 * net, because the parameter fed a table the evaluator never read.
 */
function getInterventionCost(action: string, assumptions: GeneratorAssumptions): number {
  return assumptions.interventionCostPaise[action] ?? 0;
}

export { tInterval, validateHoldoutEstimator };
