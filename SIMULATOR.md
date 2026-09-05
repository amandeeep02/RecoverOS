# RecoverOS Simulator — Generative Model & Assumptions

This document describes the synthetic data generator used for evaluation. All numbers in `RESULTS.md` are derived from this model.

---

## 1. Episode Generation

For each seed, generate `N` independent episodes:

```
paymentMethod ~ Categorical(card: 0.48, upi: 0.34, netbanking: 0.12, wallet: 0.06)
failureCode ~ Categorical(
  insufficient_funds: 0.28,
  bank_declined: 0.20,
  expired_card: 0.10,
  authentication_failed: 0.09,
  mandate_rejected: 0.08,
  permanent_decline: 0.08,
  network_error: 0.10,
  unmapped_code: 0.07
)
amountPaise ~ Round( (499 + exp(U * 5.3) * 26) * 100 )   // U ~ Uniform[0,1)
successes ~ Floor(U * 18)
failures ~ Floor(U * 6)
subscriptionAgeDays ~ 20 + Floor(U * 1300)
previousRecoveryRate ~ Clamp(0.1 + U*0.72 + successes*0.008 - failures*0.025, 0.02, 0.95)
daysSinceLastSuccess ~ 1 + Floor(U * 180)
nativeRecoveryState ~ (card AND U<0.46) ? ACTIVE : (U<0.7 ? EXHAUSTED : UNKNOWN)
```

Customer profile:
```
customerValuePaise = amountPaise * (3 + Floor(U * 24))
consentValid ~ Bernoulli(0.92)
optedOut ~ Bernoulli(0.04)
contactWindowOpen ~ Bernoulli(0.85)
phone ~ (U>0.3) ? "+91" + Floor(7e9 + U*3e9) : null
isSubscription = true
daysSinceLastEngagement = daysSinceLastSuccess
engagementProxy = true
```

---

## 2. Hidden Ground Truth

Each episode gets latent probabilities **never visible to any strategy**:

### Native Recovery Probability
```
nativeLogit =
  -0.85
  + successes * 0.11
  - failures * 0.22
  + previousRecoveryRate * 0.75
  - daysSinceLastSuccess / 360
  + methodBias
  + failureNativeEffect
  + (nativeRecoveryState == ACTIVE ? 0.17 : 0)

methodBias = card: 0.22, upi: -0.04, else: 0
failureNativeEffect = {
  insufficient_funds: -0.42,
  bank_declined: 0.28,
  expired_card: -1.25,
  authentication_failed: -0.92,
  mandate_rejected: -1.35,
  permanent_decline: -2.40,
  network_error: 0.36,
  unmapped_code: -0.30
}
pNative = sigmoid(nativeLogit)
```

### Action-True Probabilities
For each action, an additive effect on top of native:

```
actionProbability[action] = Clamp(pNative + effect, 0.005, 0.995)

effect(action, failureCode, nativeState, profile) =
  0 if action in {WAIT, STOP, ESCALATE}
  0 if nativeState == ACTIVE and profile.method == card
  else table[action][failureCode]
```

**Intervention Effect Table** (additive on pNative):

| failureCode | REMINDER | PAYMENT_LINK | RETRY | VOICE_CALL (high-value) | VOICE_CALL (other) |
|-------------|----------|--------------|-------|-------------------------|-------------------|
| insufficient_funds | 0.28 | 0.16 | 0.06 | 0.35 | 0.22 |
| bank_declined | 0.03 | 0.08 | 0.09 | 0.25 | 0.15 |
| expired_card | 0.17 | 0.42 | 0.01 | 0.45 | 0.30 |
| authentication_failed | 0.14 | 0.37 | 0.02 | 0.40 | 0.28 |
| mandate_rejected | 0.01 | 0.19 | 0.01 | 0.15 | 0.01 |
| permanent_decline | 0.005 | 0.005 | 0.005 | 0.005 | 0.005 |
| network_error | 0.005 | 0.005 | 0.005 | 0.005 | 0.005 |
| unmapped_code | 0.025 | 0.025 | 0.025 | 0.10 | 0.10 |

> High-value = profile.customerValuePaise > ₹20,000

### Churn-if-Contacted
```
willChurnIfContacted = isSubscription AND daysSinceLastEngagement > 180 AND Bernoulli(0.3)
```

---

## 3. Sweepable Assumptions (T4 / §4.5)

All parameters below are configurable via `SimAssumptions` and appear in the sensitivity sweep.

```ts
interface SimAssumptions {
  // Failure-code recoverability (pNative, lift per action)
  failureCodeRecoverability: Record<string, { pNative: number; lift: number }>;

  // Contact response rate (used by Rules arm)
  contactResponseRate: number;              // default: 0.42

  // Voice lift multiplier vs PAYMENT_LINK
  voiceLiftMultiplier: number;              // default: 1.35

  // Intervention costs (paise)
  interventionCostPaise: Record<Action, Paise>;

  // Dormancy churn hazard. A LOGISTIC in days-dormant with per-customer latent
  // susceptibility — deliberately a different functional form from the scorer's
  // piecewise-linear table in lib/scoring.ts. See "Separation" below.
  dormancyChurnLogistic: {
    ceiling: number;            // default: 0.18
    midpointDays: number;       // default: 165
    steepnessPerDay: number;    // default: 0.02
    heterogeneityLogSd: number; // default: 0.55
  };

  // Population shape. Below ~2 episodes/customer there is no contention for
  // customer attention and contact fatigue cannot bind.
  episodesPerCustomer: number;              // default: 6
  contactFatigueDecay: number;              // default: 0.65 (lift multiplier per prior contact)
  contactFatigueChurnAdd: number;           // default: 0.03 (added hazard per prior contact)

  // Issuer outage
  issuerOutageFrequency: number;            // default: 0.03
  issuerOutageDurationMinutes: [number, number]; // default: [20, 90]
}
```

**Defaults** (in `lib/simulator.ts`, exported as `DEFAULT_ASSUMPTIONS`):
```ts
export const DEFAULT_ASSUMPTIONS: GeneratorAssumptions = {
  nativeLogitByCode: { /* per raw failure code, from §2 */ },
  contactResponseRate: 0.42,
  voiceLiftMultiplier: 1.35,
  interventionCostPaise: { WAIT: 0, PAYMENT_LINK: 1200, REMINDER: 400, ESCALATE: 11000, STOP: 0, RETRY: 300, VOICE_CALL: 800, HELD_OUT: 0, HELD_DEGRADED: 0 },
  dormancyChurnLogistic: { ceiling: 0.18, midpointDays: 165, steepnessPerDay: 0.02, heterogeneityLogSd: 0.55 },
  issuerOutageFrequency: 0.03,
  issuerOutageDurationMinutes: [20, 90],
  episodesPerCustomer: 6,
  contactFatigueDecay: 0.65,
  contactFatigueChurnAdd: 0.03,
};
```

### Separation from the agent's model

`lib/simulator.ts` imports **nothing** from the agent's decision stack — no `diagnose`,
no `evaluatePolicy`, no `scoreRecovery`, no `calculateEir`. The world cannot consult
the agent and the agent cannot read the world's parameters. Verify with:

```bash
grep -nE 'from "@/lib/(scoring|policy|diagnosis|proposal)"' lib/simulator.ts   # no matches
```

The two models differ in form, not only in constants:

| Quantity | World generates it as | Agent estimates it as |
|---|---|---|
| Native recovery | logit keyed on the **raw failure code**, adjusted by payment history | table keyed on the **diagnosed category**, plus operational features |
| Dormancy churn | **logistic** in days-dormant, smooth, with a per-customer lognormal susceptibility multiplier | **piecewise-linear** table interpolation, hard zero below 30d, hard cap at 365d, one population curve |

The heterogeneity term is the sharper of the two: because each customer carries a
latent susceptibility drawn once at creation, the scorer's single population curve
is a biased estimate of *any individual's* hazard even where the two agree on the
population mean. An earlier revision of this file documented a churn table that was
byte-identical to the scorer's — that was an answer key, and it is gone.

---

## 4. Three-Arm Behaviors

| Arm | Behavior |
|-----|----------|
| **BASELINE** | No intervention. Outcome = native retry only. Interventions = 0, cost = 0. |
| **RULES** | Contact **every** eligible episode with PAYMENT_LINK + one REMINDER at 24h. Ignores EIR. Respects only consent + opt-out (legal floor). |
| **RECOVEROS** | Full pipeline: diagnosis → EIR → proposal → policy → execute. Includes holdout assignment (5% of eligible). |

---

## 5. Statistics (§4.6)

| Question | Method | Output |
|----------|--------|--------|
| Does RecoverOS beat other arms? | **Across-seed** t-interval (df=N-1=19) over N seeds | `aggregate` in `EvalReport` |
| How much incremental value did holdout measure? | **Bootstrap** (10,000 resamples, percentile 2.5/97.5) over episodes within a run | `HoldoutResult` CI |

Bootstrap uses the injected `Rng` so CIs are reproducible.

---

## 6. Sweep Procedure

`npm run eval:sweep` varies each assumption over a 5-point grid holding others at default, emits matrix of `netPaise(RECOVEROS) - netPaise(BASELINE)`. Reports every cell where value ≤ 0 under **"Where we stop winning"**.

Grid spans:
- contactResponseRate: 0.25 → 0.55
- voiceLiftMultiplier: 1.0 → 1.6
- dormancyChurnLogistic.ceiling: scale factor 0.5× → 2.0×
- intervention costs: 0.5× → 2.0×
- issuerOutageFrequency: 0.01 → 0.08

---

## 7. Self-Validation (Holdout Estimator)

For seeds 1..20:
- Run eval with holdoutPct=5, episodes=20000
- Assert: `ciLo ≤ plantedIncrementalPaise ≤ ciHi`
- Expected coverage ≥ 17/20 for a correct 95% interval

If coverage = 20/20, interval is too wide — check bootstrap.

---

*This document is the single source of truth for all simulator parameters. Any parameter change must be reflected here and in `lib/eval/assumptions.default.ts`.*