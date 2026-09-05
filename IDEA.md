# RecoverOS — Idea & Build Plan

**Razorpay AI Buildathon · Track 3: AI Revenue Recovery**

---

## 0. One line

> **RecoverOS is a revenue recovery agent that measures its own value honestly, refuses to act when acting destroys money, and can prove what a policy change would have done before it ships.**

---

## 1. The problem nobody states honestly

A merchant on recurring payments loses revenue continuously: cards expire, mandates get rejected, issuers decline, balances run dry, gateways brown out. The industry answer is dunning — retry, then message, then message again.

Every product in this category reports one number: **money recovered**.

That number is close to meaningless. Card networks and issuers run their own retry cycles. Customers pay late without being asked. A large majority of "recovered" revenue was arriving regardless, and the recovery vendor bills for it anyway. Worse, the marginal message is not free: contacting a dormant subscriber to claw back ₹499 can remind them the subscription exists and cost you the remaining ₹4,000 of it.

So the real problem is not *"how do we recover more?"* It is:

1. **How much of this would have arrived anyway?** (attribution)
2. **When is acting worse than not acting?** (restraint)
3. **How do we know, before shipping, what a policy change will do?** (counterfactual)

Nobody in this category answers those. That is the opening.

---

## 2. What the brief actually asks for

Razorpay's Track 3 bar, in their words, is three things:

| Their requirement | Our answer |
|---|---|
| Problem identification alone is insufficient | Closed loop: real Razorpay test-mode execution, `payment_link.paid` webhook closes it |
| Quantified money recovered across test batches | **Randomized holdout** + bootstrap CI, and a coverage test proving the estimator is calibrated |
| Compliant escalation, stopping rules, audit trails | RBI / TRAI / DPDP encoded as **policy gates in code**, explicit `STOP` and `SUPPRESSED` terminal states, append-only audit per episode |

Their problem statement also *leads* with **"detect degradation"** — issuer/gateway-level health, not per-transaction diagnosis. Most submissions will skip this entirely. We build it.

---

## 3. Thesis

Three commitments, and every design decision below follows from them.

**1. Report the number that goes down.**
Gross recovered is the marketing number. Incremental recovered — measured against a randomized control — is the true number, and it is much smaller. We report the small one and can defend it.

**2. Restraint is a feature with a P&L line.**
Not acting is a first-class decision with its own terminal state, its own ledger, and its own reported value.

**3. The LLM proposes; deterministic policy disposes.**
Language models are used where language is the problem. They are never in the path where money is the decision.

**4. Find the frontier by measuring, not by assuming.**
There is a point where more recovery starts destroying more value than it creates. We do not guess where it is — we measure it, discover our shipped policy is on the wrong side of it, and move. The system's opinion of itself is an estimate, and estimates get tested.

The spine of the product is that progression: **MEASURE** the causal lift → **VALUE** the intervention net of cost and churn → **LEARN** where the frontier sits → **ALLOCATE** scarce attention against it.

---

## 4. Architecture, end to end

### 4.1 The episode

Everything is organized around a **recovery episode** — the full life of one failed payment from webhook to terminal state. Not a row that gets mutated: an append-only history with a state machine and an audit trail.

```
Razorpay webhook (payment.failed / subscription.halted)
        │
        ▼
┌───────────────────┐
│ 1. NORMALIZE      │  rail-specific JSON → rail-neutral PaymentEvent
│    lib/normalizer │  HMAC signature verify, E.164 phone, idempotency key
└─────────┬─────────┘
          ▼
┌───────────────────┐
│ 2. DIAGNOSE       │  failure code → category + confidence + certainty class
│    lib/diagnosis  │  structured codes win; long-tail codes → LLM → confidence floor
└─────────┬─────────┘
          ▼
┌───────────────────┐
│ 3. SCORE          │  p_native, p_action, and EIR (§5)
│    lib/scoring    │  observable operational features only
└─────────┬─────────┘
          ▼
┌───────────────────┐
│ 4. PROPOSE        │  pick an action from a closed set
│    lib/scoring    │  deterministic default; LLM variant parsed by lib/proposal
│    lib/proposal   │  ← UNTRUSTED. Zod-validated. Confidence capped by diagnosis.
└─────────┬─────────┘
          ▼
╔═══════════════════╗
║ 5. POLICY GATE    ║  ◀── THE TRUST BOUNDARY
║    lib/policy     ║  deterministic. no model, no prompt, no credentials.
╚═════════╤═════════╝
          │  order matters and is load-bearing:
          │    a. action known & merchant-enabled?
          │    b. diagnosis confidence floor
          │    c. attempt / message / voice budgets
          │    d. native recovery still active? → force WAIT
          │    e. EIR < 0 with churn term → SUPPRESSED
          │    f. EIR below merchant threshold → WAIT
          │    g. consent, contact window, phone, DLT template
          │    h. issuer degradation open? → HELD_DEGRADED
          │    i. randomize eligible → TREATMENT | HOLDOUT
          ▼
┌───────────────────┐
│ 6. EXECUTE        │  ◀── ONLY module that touches credentials
│    lib/razorpay   │  idempotency key = episodeId:action
│    lib/voice      │  Razorpay Payment Links, Twilio voice/WhatsApp, ElevenLabs TTS
│    lib/whatsapp   │
└─────────┬─────────┘
          ▼
┌───────────────────┐
│ 7. OBSERVE        │  payment_link.paid / payment.captured webhook
│    lib/pipeline   │  or promise-to-pay expiry
└─────────┬─────────┘
          ▼
┌───────────────────┐
│ 8. ATTRIBUTE      │  treatment vs holdout → incremental, with CI
│    lib/eval       │
└───────────────────┘
```

### 4.2 The three-layer separation

This is the architectural claim, and it is enforced by module boundaries, not convention:

| Layer | May do | May **not** do |
|---|---|---|
| **Reasoner** (`diagnosis`, `scoring`, `proposal`) | Read features, produce a proposal | Execute anything, read credentials |
| **Policy** (`policy`) | Approve / reject / escalate / suppress / hold | Call a model, hold credentials, be non-deterministic |
| **Executor** (`razorpay`, `voice`, `whatsapp`) | Hold credentials, call external APIs | Decide anything |

Consequence: an LLM that hallucinates `SEND_MONEY` produces a `REJECT`, not a transfer. There is a test for exactly this.

### 4.3 State machine

16 statuses, explicit transition table, illegal transitions throw (`lib/state-machine.ts`).

```
DETECTED → DIAGNOSED → SCORED → PROPOSED → POLICY_CHECK
                                                │
        ┌──────────┬──────────┬─────────┬───────┼────────┬──────────────┐
        ▼          ▼          ▼         ▼       ▼        ▼              ▼
    EXECUTING  PENDING   SUPPRESSED  HELD_OUT  STOPPED  ESCALATED  HELD_DEGRADED
        │          │          │         │                              │
        ▼          ▼        (terminal)  ▼                              ▼
    PENDING /  RECOVERED              RECOVERED                   POLICY_CHECK
    PROMISED   FAILED                 FAILED                      (on window close,
        │      EXPIRED                EXPIRED                      with jitter)
        ▼
    RECOVERED / FAILED / EXPIRED
```

Two states carry the entire thesis:

- **`SUPPRESSED`** — we decided acting destroys value. Deliberately *not* merged with `WAIT`, because "we're waiting for the issuer" and "we refuse to contact this person" are different facts and must be countable separately.
- **`HELD_OUT`** — randomized control. Never acted on. This is where the honest number comes from.

### 4.4 The action space

Closed set. Anything outside it is a `REJECT`.

`WAIT` · `RETRY` · `PAYMENT_LINK` · `REMINDER` · `VOICE_CALL` · `ESCALATE` · `STOP`
plus two non-actions the policy can assign: `HELD_OUT` · `HELD_DEGRADED`

That is exactly `actionSchema` in `lib/domain.ts` — this list is generated from the code, not aspirational. `MIGRATE_MANDATE` is **not** in it; it is roadmap, see §6.D.

The four that compete in the argmax are `RETRY`, `REMINDER`, `PAYMENT_LINK`, `VOICE_CALL`, with `WAIT` always present at EIR 0.

---

## 5. The decision math

### 5.1 Expected Incremental Recovery

The formula everything hangs on:

```
EIR = (p_action − p_native) × amount  −  cost(action)  −  Δp_churn × residual_LTV
      └────────────┬─────────────┘      └─────┬─────┘   └──────────┬──────────┘
           what the action ADDS          what it costs     what it might destroy
```

**EIR ranks the action set; it does not veto a pre-chosen action.** `bestAction` in `lib/scoring.ts` scores every feasible candidate plus `WAIT` at zero and takes the argmax. This matters more than it sounds: scoring one pre-selected action makes EIR a veto, so when contact is too risky the fallback becomes *nothing* rather than the cheap silent action that was still worth taking. Measurement attributed roughly three quarters of this agent's shortfall against a silent-retry baseline to exactly that. Preconditions (no phone, no consent, cap exhausted, merchant disallows) **remove** an action from the set rather than penalising it, and an exhausted message cap now drops only `REMINDER` instead of escalating the whole episode to a ₹110 human review.

The lift term is the one most products get wrong. Ranking by `p_recovery × amount` ranks the payments **most likely to arrive on their own** at the top — you spend the most effort on the money you were getting for free. The lift `(p_action − p_native)` is the only quantity that describes what you contributed.

### 5.2 Intervention costs (paise, `lib/scoring.ts`)

| Action | Cost |
|---|---|
| `WAIT` / `STOP` | ₹0 |
| `RETRY` | ₹3 |
| `REMINDER` | ₹4 |
| `VOICE_CALL` | ₹8 |
| `PAYMENT_LINK` | ₹12 |
| `ESCALATE` | ₹110 *(a human minute is the most expensive thing here)* |

`ESCALATE` at ₹110 against a mean episode near ₹1,500 makes "escalate the ₹20,000 mandate, not the ₹499 one" a real decision the policy must get right — which is the point.

### 5.3 The churn term

```
Δp_churn      piecewise linear on days since last engagement:
              0 @ 30d → 0.01 @ 60d → 0.04 @ 120d → 0.09 @ 180d → 0.15 @ 365d

residual_LTV  expected remaining periods × amount,
              decaying with dormancy (capped at 6 periods)
```

Applies **only** to subscriptions **and** only to contact actions (`REMINDER`, `VOICE_CALL`, `PAYMENT_LINK`). A silent retry cannot wake anybody up, so it carries no churn penalty.

---

## 6. The five things nobody else will build

### A. The holdout — and proof the holdout works

**Assignment.** At `POLICY_CHECK`, *after* every gate has passed and the episode is genuinely eligible for action:

```ts
arm = FNV1a(customerId + "recoveros-v1") % 100 < holdoutPct ? "HOLDOUT" : "TREATMENT"
```

Four properties that matter, and each is a decision:

1. **Eligibility-gated.** Only episodes we would actually have acted on enter randomization. Randomizing all traffic — including everything headed for `WAIT` — dilutes the estimate toward zero and makes it meaningless.
2. **Hash-based, not RNG.** The same customer always lands in the same arm. Assignment is replayable and auditable months later.
2b. **Randomized on the CUSTOMER, not the episode.** Contact fatigue is per-customer, so splitting one customer's episodes across arms lets treatment interfere with control — a SUTVA violation. Measured: the unit choice does not move *this* estimand detectably (the paired difference contains zero), because fatigue enters lift and churn but never native recovery. It is justified on design, not on a measured effect, and `RESULTS.md` says so rather than claiming a number it does not have.
3. **Value-capped at ₹50,000.** We do not sacrifice real money to buy a data point. This biases the estimate slightly *downward*, which is the safe direction, and we say so.
4. **Nonparametric bootstrap clustered on customers** (10k resamples), carrying each episode's real amount — not a parametric resample of a binomial against a constant mean amount, which is what shipped first and which cannot see amount variance at all.

**The holdout is an information purchase, and it should be priced like one.** "5% holdout" invites the obvious question — *why 5%?* The better answer is that the experiment budget is proportional to uncertainty: hold out more where a cohort's CI is wide, shrink toward zero as it tightens. The holdout is not a fixed tax, it is what we spend to reduce uncertainty about whether recovery is worth doing, and it gets cheaper as we learn.

**A holdout alone cannot find the frontier.** This is the subtle part and it has a real design consequence. The holdout measures lift on episodes we *treated*. It says nothing about episodes we **suppressed** — those appear in neither arm, because we never acted on them. To learn whether our suppression boundary is in the right place we have to deliberately treat a small slice of episodes we would have suppressed. Exploration on the boundary of our own policy is a separate instrument from the holdout, and the frontier work below depends on it.

**And then the move that wins the technical conversation:** the estimator is validated against **planted truth**. Inside the simulator we know the real lift because we wrote it. We run the holdout estimator over 20 seeded worlds against a **floor of 18/20**. Current: planted truth covered **18/20** on the rate estimator and **19/20** on the revenue estimator — both clear. Coverage against its *own* estimand is **17/20**, below the floor, and is reported as such rather than tuned. We are not just measuring; we are demonstrating the instrument is calibrated.

### B. The Protected Ledger — twice wrong before it was right

This is the pillar that has been rebuilt most, and the history is worth keeping because it
is the clearest example of the project's own method catching the project.

**Version 1 was a literal.** `lib/demo.ts` hardcoded `{ protectedPaise: 1_82_000,
forgonePaise: 21_400, suppressedCount: 41 }` and the dashboard rendered it as measurement.
An earlier revision of *this document* then quoted those same constants as if they were a
result. A hardcoded number in a product whose entire claim is auditability.

**Version 2 measured the wrong thing.** Derived honestly, an arm earned protection credit
on every episode it *skipped*, scored against a churn hazard its own earlier contacts had
inflated — so nagging a customer and then going quiet scored better than never nagging.
It also failed to separate: the Baseline arm, which has no restraint logic at all and
simply never contacts anyone, scored comparably. It is **removed from `RESULTS.md`** and
marked deprecated in the harness. It is not a result.

**Version 3 prices the decision actually taken.** With a cheap churn-free `RETRY` in the
candidate set, the agent almost never falls silent — it *switches rails*. So the question
is not "what did we protect by doing nothing" but "what did we protect by choosing a
non-contact action over a contact one that would have won on gross":

```
protected = churn cost of the contact action that churn demoted
forgone   = gross incremental recovery given up to avoid it
```

Two rules make it honest. It is reported **only** when churn is demonstrably why the
contact action lost — not merely when a contact action was available. And it is booked at
the churn model's **face value**, with `policy.churnAversion` divided out: the decision may
carry a conservatism multiplier, but booking our own safety margin as protected revenue
would inflate the claim by exactly `(aversion − 1)`. Applying that alone cut the figure by
a third.

Current numbers: `RESULTS.md`, or the Refusal beat of the demo, which reconciles per row.

### C. Issuer Weather (degradation detection)

Per-key `(method, issuer, network)` health, in 15-minute tumbling windows.

```
Baseline        EWMA, α = 0.1
Fire            observed ≥ 3.0× baseline
Guards          ≥20 attempts in window AND ≥15% absolute failure rate
Warm-up         8 windows before the detector may fire at all
Close           <2.1× baseline for 2 consecutive windows (hysteresis)
Drain           requeue held episodes with 0–2 min jitter
```

Two details that separate this from a naive threshold:

- **The baseline freezes while a window is open.** Otherwise the outage's own elevated failure rate walks the EWMA upward until the ratio falls below trigger and the detector silently cancels its own alarm. This is a real bug and most implementations ship it.
- **Jittered drain.** Releasing 340 held episodes the instant an issuer recovers is a thundering herd into a system that just came back up.

Held episodes go to `HELD_DEGRADED` — the one non-terminal hold — and re-enter `POLICY_CHECK` on close.

**Why holding is economically right, not merely safe.** The tempting explanation is that an outage makes retry capacity *more* expensive. That has the mechanism backwards: if every retry is worth less right now, the capacity constraint binds *less*, and its shadow price falls. The correct argument is **option value**. A mandate has a finite, non-renewable number of retry attempts before the network or the issuer hardens the decline. Spending one during an outage forecloses spending it later when it would have worked. The attempt is a depleting option, and its opportunity cost rises exactly when current expected value collapses — which is why the economically correct move and the operationally safe move coincide here.

So the Kill Switch is not a reliability bolt-on sitting beside the economics. It is the economics: *do not exercise a scarce option at the moment its payoff is lowest.*

### D. Migrate the mandate, don't retry the card — **ROADMAP, NOT BUILT**

> Not in `actionSchema`, no cost entry, no executor, no planted lift in the simulator. It is described here because it is the strongest idea in the backlog, not because it ships. Adding it means inventing its ground truth in our own world — one more quantity graded against its own answer key — so it waits until there is real outcome data to calibrate against.

The highest-lift action available in India, and the one a payments person would actually take.

A card mandate failing repeatedly on expiry or AFA does not need a third retry — it needs a **different rail**. Converting it to a **UPI Autopay** mandate turns a recurring monthly failure into a permanent repair. Razorpay exposes the primitives for this.

Policy treats it as a high-value, low-frequency action: allowed once per episode, requires consent, and is preferred over `PAYMENT_LINK` when the failure class is `expired_payment_credential` or `mandate_issue` and the subscription has meaningful residual life.

> *"We don't retry a dying card three times. We move the customer to a rail that works."*

### E. The Replay Console

Change a policy knob, replay history, see the delta — before shipping.

```
Policy: minimumEir ₹150 → ₹50

  Interventions      +1,847
  Gross recovered    +₹3.2L
  Intervention cost  +₹1.9L
  Protected          −₹0.4L
  ─────────────────────────
  Net                +₹0.9L

  61% of these outcomes are observed. 39% are modelled.
```

**The honesty rule, non-negotiable:** where the replayed action matches what actually happened, we reuse the real observed outcome. Where it diverges, we are modelling, and the observed/modelled split is displayed permanently on screen. A replay console that hides that ratio is a fiction generator.

---

## 7. The measurement spine

### 7.1 Simulator with hidden ground truth

50,000 synthetic episodes per seed, 20 seeds. Each episode carries planted truth the policy cannot see: a true native recovery probability, a true per-action probability, a true churn draw, and true residual value.

Three properties that keep it honest:

- **The generative model is a different shape from the scorer.** The world generates native recovery from a per-failure-*code* logit adjusted by payment history; the scorer estimates it from a per-*category* table plus operational features. The agent's model is a plausible estimator of this world, never a copy of the answer key.
- **Common random numbers.** The per-episode RNG is seeded on a hash of the full episode id, so the same episode faces an identical draw in every arm while different seeds get genuinely different noise. An earlier version keyed on the within-seed index, which made all 20 "independent" worlds share one noise realization.
- **Correlated outage bursts.** Issuer outages are an alternating renewal process that forces runs of consecutive failures, not i.i.d. noise — which is what makes windowed detection worth having.

### 7.2 Four arms

| Arm | Policy |
|---|---|
| **Baseline** | Retry everything once, except terminal declines. What most merchants do. |
| **Rules** | Sensible hand-written rules. What a good engineer builds in a week. |
| **RecoverOS** | The full policy. |
| **Oracle** | Reads planted truth, picks the true value-maximizing action. |

The Oracle is not a competitor — it is a yardstick. **If the Oracle cannot beat Baseline, the generative assumptions are wrong** (intervention genuinely never pays in this world) and no amount of policy tuning is the answer. It is deliberately stronger than any achievable policy since it also knows each churn draw in advance.

### 7.3 The sensitivity sweep — "Where We Stop Winning"

Five generative parameters × five values each:

| Parameter | Default | Swept |
|---|---|---|
| `contactResponseRate` | 0.42 | 0.25 – 0.55 |
| `voiceLiftMultiplier` | 1.35 | 1.0 – 1.6 |
| `dormancyChurnScale` | 1.0 | 0.5 – 2.0 |
| `interventionCostScale` | 1.0 | 0.5 – 2.0 |
| `issuerOutageFrequency` | 0.03 | 0.01 – 0.08 |

Output is a table naming the **boundary conditions under which RecoverOS is net-negative**. If the sweep finds no losing cell, the grid is too narrow and we widen it until it does — a sweep with no failure region is a marketing artifact, not an analysis.

Volunteering your own failure region is the highest-credibility act available in a technical pitch, and it pre-empts the only question that can actually hurt.

### 7.4 The Recovery Frontier — measured, not assumed

There is an operating point past which additional recovery destroys more subscriber value than it creates. `scripts/frontier.ts` (`npm run frontier`) sweeps the two knobs that move along it — `churnAversion` (how much we trust the churn term) and `minimumEscalationValuePaise` (the ticket below which a ₹110 human review cannot pay for itself) — and reports net value at each point. **It is built to be allowed to discover that the shipped defaults are wrong, and on the first run it did.**

Three findings from that run, all of which contradicted a prior belief:

1. **The escalation gate was the smaller problem.** ₹2,500 turned out to be near-optimal; the failure was that no gate existed at all, costing ₹0.77L per 20k episodes.
2. **We were under-protective, not over-protective.** The prediction was that suppression was too aggressive. The measurement said the opposite: net value *rises* with churn aversion up to ~1.5, and disabling suppression entirely is the single worst setting on the grid. Our own churn model under-weights dormancy risk by roughly half.
3. **The real defect was a rigged comparison.** `defaultMerchantPolicy` ships `allowRetry: false` — correct conservative product behaviour, since you should not retry a customer's mandate without explicit merchant opt-in. But the Baseline and Rules arms both retry freely, so the benchmark was barring RecoverOS from the cheapest, churn-free action while its comparators used it. **Product default and benchmark configuration are different things**, and conflating them cost more than either tuning knob.

**Selection discipline.** The two policy constants were chosen on seeds 1–5 and then confirmed on seeds 6–20, which were never used for selection. Reporting a grid-search winner on the data that selected it is exactly the overfitting this project exists to refuse.

Current measured position: **see `RESULTS.md`** — regenerate with `npm run eval`.

This document deliberately carries no result tables. Two earlier revisions of it quoted
figures from world models that were later replaced, and for a while the same page showed
numbers from both. A plan that hand-copies generated output goes stale silently, which is
the precise failure this project exists to refuse. The generated report is the only place
numbers live.

### 7.5 Repeat customers — and the model gap they exposed

The world used to generate 50,000 episodes across 50,000 distinct customers: one failure each, ever. Contact fatigue, message caps and competition for attention were therefore all unfalsifiable — the scarce resource did not exist. It now generates **~8,200 customers over a 642-day billing timeline, median 5 failures each, 94% of them repeat**, with issuer outages as real intervals on that timeline rather than runs of consecutive array indices.

Fatigue is **arm-local by construction**: each arm carries its own per-customer contact history, every prior contact decays the next intervention's lift (×0.65 each, 90-day window) and adds churn hazard (+3pp each). Message and voice caps are enforced over a rolling 30-day window. An arm that spends its contacts badly has fewer left, and the ones it does spend work less well. That is the scarcity λ would eventually price.

**Introducing it moved the frontier.** Current arm comparison: `RESULTS.md`.

Rules contacts indiscriminately and fatigue punishes it hard — its churn cost nearly doubled, to ₹27.9L. But **Baseline retries silently and contacts nobody, so it pays zero churn**, and once nagging is properly priced that is a strong strategy. We do not currently beat it.

**And the protocol caught us overfitting to ourselves.** Raising `churnAversion` to 2.5 looked like +₹48,722 on 5/5 selection seeds. On held-out seeds 6–20 it was **+₹2,045, CI [−₹25,649, +₹29,739], 8/15** — indistinguishable from zero. It is not shipped. Selecting and confirming on different seeds is not ceremony; it just prevented us from putting a false positive in the deck.

**At the time this was written we believed the fix was a fatigue term inside EIR. That was tested and it is not the answer** — see §13b. The churn term is still blind to contact history and threading it in remains worth doing, but the Oracle shows the gap is targeting on a *latent* susceptibility no observable feature exposes, which no amount of feature engineering on our side closes.

---

## 8. Compliance as code, not as a slide

These are not documentation. They are gates in `lib/policy.ts` and refusals in the executors. Current thresholds must be re-verified before quoting figures publicly — regulations here have been revised more than once.

| Constraint | Enforcement point |
|---|---|
| **RBI e-mandate pre-debit notification** (24h before debit) | `RETRY` on a mandate blocked until notification is confirmed sent |
| **AFA above the e-mandate threshold** | Above-limit recurring debits route to `ESCALATE`, never silent retry |
| **TRAI TCCCPR — DLT-registered header + template** | SMS executor **throws** without a registered template ID. Compliance as a type error. |
| **TRAI time restriction** (no telemarketing 9pm–9am) | The `contactWindowOpen` gate, with real hours and merchant timezone |
| **DND scrub; transactional vs promotional** | A payment-failure notice is transactional; an *incentive/discount* is promotional and is DND-gated separately |
| **WhatsApp Business 24-hour service window** | Outside the window, only pre-approved templates; opt-in enforced at the executor |
| **DPDP Act 2023** | Purpose limitation and consent drive `consentValid` / `optedOut`; contact data minimized in audit payloads |

Stopping rules, stated plainly:

```
STOP when   automated attempts exhausted (default 3)
      or    message budget exhausted (default 2) 
      or    voice budget exhausted (default 1)
      or    diagnosis is a terminal decline
      or    EIR < 0                              → SUPPRESSED
      or    consent withdrawn / opted out
      or    issuer degradation window open        → HELD_DEGRADED (resumable)
```

---

## 9. Where the LLM goes — and where it never goes

Two placements. Both are language problems.

**1. Long-tail failure-code diagnosis.** Gateways emit unmapped strings by the thousand. The LLM maps an unknown code + context → `{category, confidence, evidence[]}`. Anything below the confidence floor (0.45) falls through to `ESCALATE`, never to autonomous contact. Structured codes always win over the model.

**2. Cohort narration — BUILT, NOT WIRED.** `lib/narration.ts` works and is tested live, but nothing computes the cohort aggregate that feeds it and no component renders it. Turning 400 clustered failures into *"your HDFC credit-card mandates have been failing AFA at 3× baseline since Tuesday 14:00, ₹4.1L affected"* is genuinely a language task, and it is the merchant-facing surface with the most value per token.

Everything the model emits passes through `lib/proposal.ts` — Zod-validated, action constrained to the closed set, confidence capped at the structured diagnosis's confidence, malformed output silently replaced with the deterministic fallback and tagged `llm_output_rejected`.

> **The LLM is used where language is the problem. It is never used where money is the decision.**

---

## 10. Data model

Persistence is an async `RecoveryStore` interface with two implementations: in-memory (tests, eval) and Postgres (`DATABASE_URL`).

| Table | Purpose |
|---|---|
| `ingested_webhook` | `event_id` primary key — idempotency at the boundary |
| `episode` | Full episode JSON per stage, plus queryable columns |
| `customer_profile` | Engagement, consent, history, dormancy |
| `audit_event` | **Append-only.** Duplicate `audit_id` throws. |
| `execution` | Keyed `episodeId:action` — idempotent execution |
| `experiment_assignment` | Arm, eligibility, salt version, assigned-at |
| `degradation_window` | Open/close times, baseline, ratio, episodes held |
| `promise_to_pay` | Voice-call commitments and their expiry |

**Money is integer paise everywhere.** A `Paise` type with an `assertPaise` guard on every boundary. No floats touch money — an accumulated rounding error in a recovery ledger is an unrecoverable credibility failure.

Audit payload per stage: who/what acted, why, evidence, policy version, model version, action, outcome.

---

## 11. The demo — three minutes

| Time | Beat |
|---|---|
| 0:00 | Black screen. `₹1,83,42,700`. *"This was supposed to be revenue. It never arrived."* |
| 0:20 | *"Every recovery product tells you how much of this they got back. Almost all of them are taking credit for money that was already coming."* |
| 0:35 | **Live loop.** Real Razorpay test-mode `payment.failed` → diagnose → payment link → `payment_link.paid` → **₹4,999 recovered.** ~20 seconds, real webhooks. |
| 1:05 | **The Kill Switch.** One issuer spikes 4×. Split screen — baseline fires 340 retries into a dead issuer, burning finite attempt budget and hardening soft declines into permanent ones. Ours halts itself, holds 340 episodes, drains with jitter on close. *"Our agent just stopped itself."* |
| 1:35 | **The Refusal.** ₹499 subscription, 210 days dormant, 8 periods residual. `SUPPRESSED`. *"Recovering this is worth ₹150. Waking this customer risks ₹4,000."* → Protected Ledger. |
| 2:05 | **The Subtraction.** 50,000 episodes. Gross on treated, struck through. **Incremental, with its interval, read live from the generated report** — never a slide constant. *"This is the number we can defend."* |
| 2:20 | **The Correction.** *"We shipped this policy believing it was intelligent. Then we measured it."* Frontier chart: shipped defaults sit **below baseline**. Move the knob. RecoverOS crosses above Rules on 20/20 worlds. *"We didn't optimise it. We measured it, found it was wrong, and moved it."* |
| 2:35 | **Where We Stop Winning.** The boundary conditions where we go net-negative. |
| 2:45 | **The Replay.** Judge names a policy change out loud. 50,000 episodes replayed live. Delta on screen with the observed/modelled split. |
| 2:55 | *"We don't measure how smart the agent sounds. We measure what wouldn't have arrived without it."* |

### The proof trail — "Don't trust the agent. Audit it." — **NOT BUILT**

> The per-episode audit chain and experiment assignment are rendered in the v2 dashboard's Why panel; the packaged "PROVE IT" affordance below is design, not shipped.

Every claim in the UI carries a **PROVE IT** affordance that opens the episode's own evidence. This is the thesis turned into an interaction, and it is the demo mode we name.

One correctness rule governs the whole panel: **incrementality is a population quantity, not an episode quantity.** A single episode either recovered or it didn't — there is no per-episode counterfactual to observe. Attaching a confidence interval to one outcome is exactly the statistical sleight-of-hand this product exists to refuse, and a judge who knows the difference will catch it. So the panel separates what we *observed* from what we *estimated*, and labels both:

```
₹12,499 RECOVERED                          ep_8f21c4

THIS EPISODE                               observed
  ✓ Arm: TREATMENT   assigned by hash, salt v1
  ✓ Payment link created           14:31:05
  ✓ payment_link.paid received     20:31:08
  ✓ ₹12,499 captured
  ✓ Policy v3 · model transparent-v1

ITS COHORT                        estimated · n=5,927
  expired_card · UPI · treatment-eligible
  Treatment recovery rate            41.8%
  Holdout recovery rate              23.1%
  Lift                              +18.7pp
  95% CI                      [+11.2, +26.1]

WE CLAIM
  ₹2,337 of this ₹12,499
  — this episode's share of a measured cohort lift,
    not a measurement of this episode.

                                      [ PROVE IT ]
```

Clicking through opens the full audit chain and the experiment assignment. Being visibly precise about the observed/estimated boundary is *more* impressive than a clean per-episode number, not less — it demonstrates we know which of the two we are holding.

### On the Kill Switch numbers

The side-by-side during an outage is the strongest single visual in the demo, so its arithmetic has to be unimpeachable. Two rules:

**Do not price the wasted retries in rupees.** At our own ₹3 retry cost, 340 retries is ₹1,020 — a number too small to carry the moment, and inflating it to a headline figure would be the one dishonest slide in a pitch built entirely on honesty. The real cost of retrying into a dead issuer is not the fee:

```
BASELINE                      RECOVEROS
340 retries fired             0 retries fired
340 attempt-budget slots      340 episodes held
  burned                        intact
N soft declines hardened      0 hardened
Customer contacted during     Contact deferred to
  a known outage                a working issuer
```

**Drop the "AUTONOMY: 87%" gauge** unless it has a real denominator. As a decorative percentage it is the one un-auditable number on screen, in a product whose entire claim is that every number is auditable. If we want a live gauge, make it countable — *episodes resolved without human escalation in the last window* — and let the outage visibly drive it down.

**On the gimmick.** The memorable gesture is the subtraction — showing a number 5× smaller than we could have claimed. It is memorable *because it is the product*, not a theme layered on top. We deliberately avoid a crime/heist framing: that metaphor rewards maximal chasing, which is the opposite of what makes this system good, and it mislabels dormant customers as adversaries — precisely the mindset that produces the bad dunning we are replacing.

---

## 12. Build plan

### 12.1 Already built and working

Pipeline with per-stage audit · state machine with enforced transitions · policy gate with the full check ladder · EIR with the churn term · integer-paise money type · Razorpay webhook normalization with HMAC verify · idempotent executors · Postgres + in-memory stores · simulator with hidden truth, common random numbers and an Oracle arm · degradation detector · SSE server · Hinglish voice + WhatsApp loop · 15 passing tests.

### 12.2 Done since this document was written

- **Holdout branch made reachable.** `harness.ts` read `outcome !== "APPROVE"` before the `HELD_OUT` check, so the experiment silently collapsed to one arm and `RESULTS.md` shipped a `NaN` interval. Now 20,068 control episodes across 20 seeds.
- **Four more evaluator defects**, each of which corrupted the published number: declined episodes never resolved an outcome (so RecoverOS got zero credit for native recovery on the majority of its episodes); suppressed and degradation-held episodes resolved at a human agent's lift without paying for it; holdout episodes were counted as interventions; and `ArmResult` had no churn term at all, which scored the product's central differentiator at zero.
- **Escalation value gate** — one rule applied to all nine escalation sites, worth ₹0.77L per 20k episodes.
- **`churnAversion` knob + `npm run frontier`**, and the selection/confirmation protocol behind it.
- Two duplicate arm evaluators collapsed into one; `eval`, `eval:sweep`, `frontier` scripts wired.
- **Repeat-customer world** (§7.5): ~8,200 customers over a 642-day timeline, arm-local contact fatigue, rolling-window message and voice caps that actually bind, and issuer outages as time intervals rather than array-index runs.

### 12.3 Also done since

Compliance gates as real code including the DLT-template refusal · both LLM placements built (slot 1 wired into the pipeline, slot 2 not) · degradation detector instantiated in the app path with jittered drain · the two evaluators collapsed to one · estimator coverage wired and reported · replay console rebuilt on the real scorer with an honest observed/modelled split · v2 dashboard mounted and consuming SSE · the missing `await` on the outcome route · `eval` / `eval:sweep` / `frontier` scripts · README regenerated from `RESULTS.md` · `lib/db-store.ts` deleted · 5,510 lines of superseded specs archived · provider swapped to Groq.

### 12.4 What is genuinely left

1. **Commit.** The entire build is uncommitted.
2. **Wire cohort narration.** Needs a cohort-clustering aggregate and a surface. It is the only LLM placement still dark.
3. **`lib/degradation.ts` folds the spike window into the EWMA before testing the trigger**, so the ratio self-damps — it fired at 5.64× where it should be ~12×. The freeze-while-open rule is correct; this is the ordering *before* a window opens. Fixing it moves a published number.
4. ~~Two schema sources of truth.~~ **Done** — `schema.sql` deleted; the `SCHEMA` constant in `lib/pg-store.ts` is authoritative and is the one that executes.
5. **Estimator coverage against its own estimand is 17/20** against an 18/20 floor. Reported, not tuned.
6. **Dead exports**: `createAssignment`, `diagnoseAndProposeAsync`, `checkSmsSend` (the last is defensible — there is no SMS executor to gate).
7. **The PROVE IT panel** (§11) as a packaged affordance.

### 12.3 Blocking — fix next

1. **Rewrite `README.md` from `RESULTS.md`.** It still contradicts the generated output and itself — the quoted CI does not contain its own point estimate. Never hand-write a figure that cannot be reproduced by a command.
2. **A fatigue term in EIR.** The churn term reads dormancy only. With repeat customers now in the world (§7.5), contact history is the dominant churn driver and the scorer cannot see it: `previousInterventionCount` is on the profile, hardcoded to 0, read by nothing. Thread the arm's own contact history into the profile and price it inside EIR. This is the reason we do not beat Baseline, and it is the first real piece of the learning loop.
3. **Wire the degradation detector into the app path.** It is currently instantiated only in `scripts/seed-demo.ts`; the pipeline accepts it as an optional parameter no caller supplies. The simulator substitutes a stub that returns "degraded" for every `network_error`, which is ground-truth peeking, not detection.
4. **Collapse the two evaluators.** `lib/simulator.ts` and `lib/eval/harness.ts` independently reimplement arms, costs, `mulberry32` and `hashToBucket`, and they disagree. One evaluator, sourced from `lib/rng.ts`, `lib/experiment.ts`, `lib/scoring.ts`.

### 12.4 Next — the differentiators

5. Estimator coverage test against planted truth (≥17/20 seeds).
6. Compliance gates as real code, including the DLT-template refusal.
7. `MIGRATE_MANDATE` action + policy rules.
8. The two LLM placements.
9. Replay console fidelity: real observed outcomes where actions match, honest modelled fraction where they don't. Fix the `netPaise` precedence bug at `lib/replay.ts:150` — `replayRecovered ? amount : 0 - cost` never subtracts cost from the recovered branch.
10. Mount the v2 dashboard and consume `/api/stream` with a real `EventSource`. Currently the client components import the server-side `realtimeServer` singleton and will never receive an event.
11. `await` the promise at `app/api/episodes/[id]/outcome/route.ts:12`.
12. Add `eval` and `eval:sweep` to `package.json` — the scripts exist and nothing invokes them.

### 12.5 Cut

- `lib/db-store.ts` — 405 unreferenced lines, plus a live `better-sqlite3` dependency it drags in.
- Whichever evaluator loses in (4).

### 12.6 The allocation primitive — deliberately deferred

Once repeat customers exist, contact slots become genuinely scarce and the right formulation is a shadow price, not a ratio:

```
maximise  Σ EIR_i(a_i)     subject to     Σ c_i(a_i) ≤ B
                                          c = contact slots, NOT rupee cost

per-episode decision:      EIR_i(a) − λ · c_i(a)
```

λ is the Lagrange multiplier on the contact budget: **the internal price of the right to interrupt a customer.** Expressed in rupees it is directly legible — *a contact is worth ₹183 to us, a human minute ₹1,420, a retry slot ₹37* — and it is discovered from the constraint rather than assumed.

Note what this is *not*: `EIR / cost` is wrong twice over. EIR already subtracts rupee cost, so dividing by it double-counts; and ratio-ranking only maximises value when the budget binds, whereas with slack you should take every positive-EIR action. The denominator has to be the non-monetary scarce thing.

**We do not build this until the simulator can make λ matter.** An allocator for a constraint that never binds is a slide, not a system.

### 12.7 Residency roadmap (months 1–12)

| Months | Focus |
|---|---|
| 1–3 | Closed loop hardened, holdout validated in production, compliance gates complete |
| 4–6 | **The learning loop** — outcome attribution feeding per-customer and per-cohort policy. This is the largest genuine gap: `previousInterventionSuccessCount` exists on the profile and is currently read by nothing. |
| 7–9 | Degradation detection at portfolio scale across merchants; issuer weather as a shared signal |
| 10–12 | Policy search — propose policy changes, validate on replay, ship behind the holdout |

---

## 13. How we get killed, and the answers

**"Your numbers come from your own simulator. Why should I believe any of it?"**
Four answers, in order: (1) the estimator's CI covers planted truth 18/20 on the rate estimator and 19/20 on the revenue estimator against a pre-set 18/20 floor — and we also report the one row that misses it; (2) the generative model is a different functional shape from the scorer, documented in `SIMULATOR.md`, so the agent is not reading its own answer key; (3) the sensitivity sweep publishes the region where we lose; (4) one real test-mode episode runs end to end on stage.

**"Isn't the 5% holdout just lost revenue?"**
Yes — approximately 5% of eligible episodes' incremental value, capped so no episode above ₹50,000 is ever withheld. That is the cost of knowing whether the other 95% is worth anything. A merchant who cannot answer that question is paying for the whole program blind.

**"Where's the AI?"**
In long-tail failure-code diagnosis and cohort narration. Deliberately nowhere near the money decision — the policy engine is deterministic and auditable by design, and we can show you the test where a proposed `SEND_MONEY` gets rejected.

**"You tuned it until it won."**
Constants were selected on seeds 1-5 and confirmed on seeds 6-20, which had no role in selection; the current figures are in `RESULTS.md`. The third — re-enabling `allowRetry` — was not tuning at all: the benchmark was barring RecoverOS from an action both comparison arms used freely. And the frontier script that found all of this is committed, runnable, and reported our shipped defaults as *below baseline* before it reported them as above it.

**"Your recovery rate is lower than the baseline arm."**
Correct, and intended. Baseline retries everything and books the issuer's own recoveries as its own. We intervene on roughly 1 episode in 8 and report only what the control arm didn't get. Compare net-of-cost and net-of-churn, which is the column that decides whether the program pays for itself.

---

## 13b. The finding this project actually produced

We set out to prove an agent could beat naive recovery. What we measured is more useful
than that and less flattering:

1. **We beat a rules engine decisively and do not beat a silent-retry baseline.** Both on
   20/20 worlds, both in `RESULTS.md`, neither buried.
2. **The Oracle — perfect knowledge of every outcome and every churn draw — beats silent
   retry by 1.4%.** That is the ceiling for *any* policy here once churn is priced. The
   category is thinner than it advertises.
3. **We pre-registered a diagnosis for the gap and it was wrong.** The action-space fix
   was real, worth ₹9.1L against Rules, and moved us 0/20 against Baseline. Reported as a
   falsified hypothesis rather than quietly dropped.
4. **The Oracle points at unobservability, not at tuning.** It contacts more people than
   we do and pays less churn per contact. The deciding variable — per-customer
   susceptibility to being contacted — is latent by construction. The Oracle-agent gap
   prices exactly that missing information, which tells a merchant what to start
   measuring.

A recovery agent that can tell you the ceiling of its own category, and how far short of
it the agent falls, is worth more than one that reports a large number.

---

## 14. Non-goals

- Not a chatbot, and not an "AI agent" wrapper around a dunning template library.
- Not multi-product on day one. Payment-failure recovery is the wedge; subscriptions and receivables reuse the same episode spine.
- Not a maximal-recovery system. A system tuned to recover every rupee is a system that will destroy customer relationships to do it.
- Not an autonomous spender. Discounts, credits and refunds require explicit merchant approval and never enter the autonomous action space.

---

*Every rupee we claim, we can prove. Every rupee we didn't chase, we can justify.*
