> **SUPERSEDED — historical planning document, not the plan of record.**
> The current plan is `IDEA.md`; the only trustworthy numbers are in `RESULTS.md`.
> Constants and file paths below describe an earlier design and are known to be stale.

# RecoverOS — Winning Submission Document

**Razorpay AI Buildathon · Track 03: AI Revenue Recovery**

> **RecoverOS is the recovery agent that knows when to act, when to wait, and when acting would destroy revenue.**

This document is the submission-quality layer for the repository. It defines the product story, judge-facing proof, demo narrative, quality bar, and execution priorities required to turn the current prototype into a winning Track 03 submission.

It does not replace `BUILD_SPEC.md` as the implementation contract. When implementation details conflict, `BUILD_SPEC.md` wins. `PLAN_V2.md` is the current product and pitch strategy. `SPEC.md`, `PLAN.md`, and `SPEC_AND_PLAN.md` are historical documents and must not be used to introduce scope or contradict the v2 contract.

---



## 1. The Winning Wedge



### 1.1 The challenge asks for

The Track 03 brief asks for an agent that:

- detects revenue at risk;
- determines the right intervention;
- executes a bounded recovery workflow;
- shows measured money recovered across a batch;
- uses compliant escalation, stopping rules, and an audit trail.

The challenge examples include payment degradation, checkout drop-off, failed subscriptions, B2B receivables, mandate retry sequencing, Hinglish voice recovery, and promise-to-pay tracking.

### 1.2 RecoverOS focuses the brief

RecoverOS starts with **failed recurring payments**, where the product can demonstrate the entire loop with a clear financial counterfactual:

```text
Payment fails
    -> What would native recovery have done?
    -> Is an intervention worth its cost and customer risk?
    -> Act, wait, suppress, hold, or escalate
    -> Observe the outcome
    -> Prove the incremental value
```

The system is not another retry engine. It is the **judgment, restraint, and measurement layer on top of native recovery**.

### 1.3 The one-sentence pitch

> Most recovery tools claim every payment that comes back. RecoverOS keeps an always-on holdout, calculates expected incremental recovery, and refuses to contact customers when the intervention is likely to destroy more value than it creates.



### 1.4 The memorable close

> **We do not bill for gravity.**

The phrase means RecoverOS should ultimately be priced on measured incremental value, not on payments that would have arrived without intervention.

### 1.5 What makes this a winner

The winning submission must make these four ideas feel like one product, not four features:

1. **Incremental recovery:** distinguish money recovered from money caused by RecoverOS.
2. **Restraint:** make `WAIT`, `HELD_DEGRADED`, and `SUPPRESSED` visible product decisions.
3. **Bounded agency:** AI can interpret and propose; deterministic policy controls; executors act.
4. **Policy replay:** evaluate a policy change before exposing customers to it.

Everything else is supporting evidence. If a feature does not strengthen one of those four ideas, it is out of scope for the hackathon submission.

---

## 2. Authority And Scope



### 2.1 Document hierarchy

Use this hierarchy to prevent plan drift:

```text
BUILD_SPEC.md    implementation authority and invariant contract
DOC.md           submission quality, evidence, demo, and judge-readiness contract
PLAN_V2.md       current product strategy, scope, positioning, and demo narrative
SIMULATOR.md     simulator assumptions and evaluation methodology
SPEC.md          historical initial specification
PLAN.md          historical initial implementation plan
SPEC_AND_PLAN.md historical intermediate production-platform plan
```

The historical documents are useful context only. Do not reintroduce authentication, OAuth, multi-tenancy, Redis, BullMQ, ORM migration work, or production SaaS infrastructure from `SPEC_AND_PLAN.md`. Those are explicitly cut from the hackathon scope.

### 2.2 Must build

The submission must have these working end to end:

- deterministic synthetic evaluation against a common hidden world;
- true no-intervention native baseline;
- static rules comparison arm;
- RecoverOS diagnosis, scoring, policy, and bounded action arm;
- eligibility-gated holdout assignment and outcome observation;
- generated results with uncertainty, assumptions, Git SHA, and losing regions;
- distinct restraint states for holdout, issuer degradation, suppression, and ordinary wait;
- protected-versus-forgone ledger derived from episode data;
- one real Razorpay test-mode webhook to payment-link execution path;
- append-only audit timeline;
- persistent demo state across restart through the specified SQLite path;
- real-time dashboard update through SSE;
- replay that distinguishes observed outcomes from modeled counterfactuals;
- deterministic demo seed and five-minute runbook;
- `npm run verify` passing from a clean checkout.



### 2.3 Must not build

Do not spend hackathon time on:

- merchant signup or login;
- Razorpay OAuth;
- multi-tenancy;
- Redis, BullMQ, queues, or workers;
- Prisma, Drizzle, or an ORM;
- a second production-grade vertical;
- production financial operations;
- real Twilio voice calls;
- unrestricted autonomous messaging;
- a broad settings suite;
- load testing that does not improve the batch proof;
- decorative AI features without a visible decision benefit.



### 2.4 Proof separation rule

RecoverOS must present two separate proofs and label them accurately:


| Proof                             | What it demonstrates                                                                            | What it does not demonstrate                  |
| --------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Real Razorpay test-mode episode   | webhook ingestion, normalization, policy gate, executor, payment-link integration, auditability | causal incremental revenue in production      |
| Synthetic hidden-truth evaluation | reproducible policy comparison, holdout measurement mechanics, sensitivity, uncertainty         | real customer behavior or production efficacy |


Never combine these into a claim that a test-mode payment proves incremental recovery. The separation increases credibility.

---



## 3. Judge Scorecard

The product should be optimized against the following scorecard. A feature is only high priority if it improves one or more of these dimensions.


| Dimension          | Winning evidence                                                                       | Failure mode to avoid                             |
| ------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Problem value      | Failed recurring payments tied directly to merchant revenue and churn                  | Generic “AI automation” language                  |
| Differentiation    | Incremental recovery, restraint, holdout, replay                                       | “We retry better”                                 |
| AI quality         | AI assists ambiguous diagnosis/explanation behind deterministic controls               | LLM theater or uncontrolled tool use              |
| Technical depth    | Hidden-world evaluation, state machine, idempotency, policy boundary, SSE, persistence | Static mock or disconnected components            |
| Trust              | Honest labels, sample sizes, CIs, assumptions, losing regions                          | Handpicked or contradictory numbers               |
| Business value     | Performance pricing on incremental recovery and saved intervention cost                | Gross recovery vanity metrics                     |
| Demo clarity       | One failure traverses detect-to-measure, with a visible restraint decision             | Feature tour with no narrative                    |
| Razorpay relevance | Real test-mode webhook/payment-link flow and cross-merchant issuer insight             | Pretending to be an independent payment processor |
| Safety             | Consent, opt-out, contact windows, caps, suppression, escalation                       | Agent can contact or execute freely               |
| Finish quality     | Clean build, reproducible commands, coherent UI, no hardcoded claims                   | Great concept that fails when run                 |




### Target quality bar

The project is submission-ready only when a skeptical judge can:

1. understand the thesis in 20 seconds;
2. see a payment failure become a bounded decision;
3. see at least one action and one deliberate non-action;
4. trace a decision through the audit trail;
5. inspect the exact benchmark definition;
6. reproduce the result without network access;
7. distinguish observed, simulated, and modeled values;
8. run the application without provider side effects during build;
9. ask “where do you lose?” and receive an honest answer;
10. understand why Razorpay is uniquely positioned to make the product stronger.

---



## 4. Product Contract



### 4.1 Primary user

The initial ideal customer profile is:

> An Indian subscription merchant with enough recurring payment volume to observe failure patterns, a payments or revenue-operations owner responsible for involuntary churn, and an existing native recovery process that produces gross recovery but weak attribution.

The buyer is a Head of Payments, Revenue Operations lead, subscription-platform owner, or payments product manager.

Small merchants may not have enough volume for issuer-level detection or statistically useful holdouts. This is not a weakness to hide. It creates a strong Razorpay platform insight: cross-merchant aggregation can make degradation signals useful without exposing merchant data.

### 4.2 Primary job to be done

> When a recurring payment fails, tell me whether to act, what bounded action is justified, what would likely have happened without us, and whether the action created net incremental value.



### 4.3 Bounded action set

The action set is frozen:

```text
WAIT | PAYMENT_LINK | REMINDER | ESCALATE | STOP | RETRY | VOICE_CALL
```

No new actions may be introduced for the hackathon. New restraint behavior is represented through state and reason, not an invented action.

### 4.4 State semantics

The UI and engine must keep these states distinct:


| State                    | Meaning                                                          | Ledger treatment               |
| ------------------------ | ---------------------------------------------------------------- | ------------------------------ |
| `WAIT` / waiting outcome | Native recovery or low EIR makes intervention unjustified        | Not suppression                |
| `HELD_OUT`               | Eligible action deliberately withheld for measurement            | Counts in holdout estimator    |
| `HELD_DEGRADED`          | Issuer or rail is currently degraded; no contact or retry burn   | Requeued after close           |
| `SUPPRESSED`             | Contact has negative expected value, usually dormancy churn risk | Feeds protected/forgone ledger |
| `ESCALATED`              | Human judgment required                                          | No automated execution         |
| `STOPPED`                | Terminal no-action decision                                      | No further automated action    |
| `PENDING`                | Approved action has executed and outcome is not final            | Await observation              |
| `RECOVERED`              | Outcome observed as recovered                                    | Recovered revenue              |
| `FAILED` / `EXPIRED`     | Outcome observed as unsuccessful                                 | No recovered revenue           |


The most important UX rule is that restraint must be visible. Invisible safety does not score with judges.

---



## 5. The Core Decision Loop

Every episode must be explainable through this exact chain:

```text
Razorpay event
    -> normalized PaymentEvent
    -> customer revenue profile
    -> deterministic or AI-assisted diagnosis
    -> native and action recovery probabilities
    -> EIR with intervention cost and churn cost
    -> bounded proposal
    -> deterministic policy gates
    -> holdout, degraded hold, suppression, wait, escalation, or execution
    -> observed outcome
    -> append-only audit
    -> ledger and benchmark measurement
```



### 5.1 Authority separation

```text
AI / model layer
  proposes diagnosis, explanation, or action
          |
          v
Deterministic policy engine
  checks eligibility, consent, caps, EIR, native state, degradation, holdout
          |
          v
Executor
  owns credentials and performs only approved actions
```

The AI layer must never:

- call Razorpay directly;
- send a message directly;
- change policy thresholds;
- bypass an attempt cap;
- assign itself to treatment;
- mark a payment recovered;
- access hidden simulator truth.



### 5.2 AI strategy

The strongest honest AI position is:

> RecoverOS uses an interpretable recovery model for counterfactual scoring, optional AI for ambiguous diagnosis and explanation, and a deterministic policy boundary for every customer-facing or money-touching action.

Implement one visible AI contribution rather than claiming an invisible general agent. Recommended path:

- known structured failure codes use deterministic diagnosis;
- ambiguous or unmapped failures receive an AI-generated structured diagnosis and explanation;
- output is validated against the domain schema;
- confidence below the policy floor escalates;
- the policy engine remains the only authority that can approve an action;
- the UI labels whether the diagnosis was known, inferred, or unknown.

If no external LLM is available during evaluation, use a deterministic fixture adapter. The product must still run offline. Never make eval or replay depend on a network model call.

### 5.3 Expected Incremental Recovery

The primary decision quantity is:

```text
eirWithoutChurn = round((pAction - pNative) * amountPaise) - actionCostPaise
churnCost       = round(deltaPChurn * residualLtvPaise)
eir             = eirWithoutChurn - churnCost
```

The system must store all three relevant values:

- `eirWithoutChurnPaise`;
- `churnCostPaise`;
- `eirPaise`.

Use integer paise throughout the engine. Format money only at the UI boundary.

### 5.4 Suppression semantics

```text
if eir < 0 and eirWithoutChurn >= threshold:
    SUPPRESSED / DORMANCY_CHURN_RISK
else if eir < 0:
    SUPPRESSED / NEGATIVE_EIR_OTHER
else if eir < threshold:
    WAIT / low EIR
else:
    continue through proposal and policy
```

The distinction is central:

- `WAIT` means acting is not worth the cost;
- `SUPPRESSED` means acting is actively harmful.



### 5.5 Issuer degradation semantics

The detector is cross-episode, not just a better per-payment classifier:

- key by payment method, issuer, and network;
- use the exact 15-minute window and EWMA constants in `BUILD_SPEC.md`;
- require the minimum attempt volume and absolute failure rate;
- freeze the baseline while the window is open;
- hold matching episodes without contacting customers or consuming attempt budget;
- close with hysteresis;
- requeue held episodes with deterministic jitter;
- show the number held and interventions avoided.

Use the following judge-facing line:

> A single merchant may not have enough volume to detect an issuer outage, but Razorpay sees the network. The prototype demonstrates the policy mechanism; the platform advantage is cross-merchant signal aggregation.

---



## 6. Measurement Contract

Measurement integrity is the product. A benchmark that looks favorable but is not reproducible loses more points than a benchmark that honestly shows a weak policy.

### 6.1 Canonical three-arm comparison

All three arms must consume the same generated episode batch and the same hidden world for each seed.


| Arm         | Definition                                                                                     | Cost                    |
| ----------- | ---------------------------------------------------------------------------------------------- | ----------------------- |
| `BASELINE`  | No RecoverOS intervention; native recovery only                                                | 0                       |
| `RULES`     | Contact every legally eligible episode with `PAYMENT_LINK`, then one `REMINDER` after 24 hours | Configured action costs |
| `RECOVEROS` | Diagnosis, prediction, EIR, policy, holdout, restraint, and bounded action                     | Configured action costs |


Do not call a generic retry policy “native recovery.” Do not count baseline intervention cost when the baseline is defined as no intervention.

### 6.2 Hidden truth

The observable case must not contain latent truth. Ground truth must remain in a separate evaluator-owned structure:

```ts
type GroundTruth = {
  pNativeTrue: number;
  pActionTrue: Record<Action, number>;
  willChurnIfContacted: boolean;
  issuerDegraded: boolean;
};
```

Only one function resolves outcomes:

```text
resolveOutcome(truth, action, seededRng)
```

Model predictions must never generate the benchmark outcomes.

### 6.3 Outcome rules

```text
WAIT, HELD_OUT, HELD_DEGRADED, SUPPRESSED -> resolve as WAIT/native outcome
executed action                         -> resolve using pActionTrue[action]
contact action + churn truth             -> record churn effect
```

Every `HELD_OUT` episode must receive an observed outcome. An unobserved holdout is not evidence.

### 6.4 Canonical reported metrics

Report these for every arm:

- episode count;
- amount at risk;
- recovered paise;
- recovery rate;
- intervention count;
- contacts made;
- intervention cost;
- net paise;
- wasted interventions;
- policy rejection rate;
- escalation rate.

The primary benchmark comparison is:

```text
netPaise = recoveredPaise - interventionCostPaise
deltaNet = recoverOsNetPaise - baselineNetPaise
```

The headline must never be called “incremental recovery” if it is actually gross recovered revenue or model-attributed uplift.

### 6.5 Intervals

Use the correct interval for the question:


| Question                            | Required method                                                       |
| ----------------------------------- | --------------------------------------------------------------------- |
| Does RecoverOS beat the other arms? | Across-seed mean with Student-t interval, df = N - 1                  |
| What did the holdout measure?       | Episode-level bootstrap, 10,000 seeded resamples, percentile interval |
| Does the estimator work?            | Coverage against planted truth across 20 deterministic seeds          |


Never use an across-seed interval as a holdout CI. Never use a parametric aggregate binomial bootstrap when the requirement is episode-level resampling with heterogeneous payment amounts.

### 6.6 Holdout assignment

Assignment happens only after all action eligibility gates, degradation, and suppression checks pass:

```text
1. Evaluate every normal policy gate.
2. Evaluate degradation and suppression.
3. If the result is WAIT, STOP, SUPPRESSED, or HELD_DEGRADED:
       eligible = false; arm = undefined.
4. Otherwise:
       eligible = true.
       amount above value cap -> TREATMENT.
       otherwise deterministic FNV-1a assignment.
5. HOLDOUT -> HELD_OUT and no execution.
6. TREATMENT -> execute normally.
```

The holdout ledger must display:

- treatment count;
- holdout count;
- treatment recovered amount;
- holdout recovered amount;
- treatment recovery rate;
- holdout recovery rate;
- incremental estimate;
- CI;
- value-cap exclusion count;
- observed outcome completion rate.



### 6.7 Estimator population

The estimator must use the same population as planted truth:

- action-eligible episodes only;
- episodes below the value cap only if they were eligible for assignment;
- the action actually selected by RecoverOS;
- the no-action/native counterfactual;
- the same outcome observation window;
- the same cost convention.

If the estimator uses a rate-times-mean-amount presentation, also report amount balance by arm and retain episode-level recovered-value samples for the bootstrap.

### 6.8 Honest assumptions

Every assumption must be:

- stored in one default assumptions module;
- printed verbatim into `RESULTS.md`;
- connected to the simulator path it claims to control;
- covered by a wiring test;
- included in the sensitivity sweep where applicable.

The least grounded parameter, `deltaPChurn`, must be visibly flagged:

> `deltaPChurn` is a scenario assumption in this prototype. A production holdout is the mechanism that would estimate it from real customer behavior.



### 6.9 Losing region

The submission must include a section literally titled:

```text
Where we stop winning
```

It must identify at least one parameter cell where RecoverOS net value is not better than baseline. A sweep with identical outputs across unrelated parameters is not evidence; it is a wiring bug.

### 6.10 Provenance

Every generated result must include:

- Git SHA;
- generation timestamp;
- canonical command;
- seed list;
- episodes per seed;
- holdout percentage;
- assumptions dump;
- estimator method;
- report schema version.

`RESULTS.md` is generated, never hand-edited.

---



## 7. Technical Quality Contract



### 7.1 Reproducibility

The following must be true:

- no `Math.random()` in engine or evaluator code;
- no uncontrolled wall-clock reads in engine code;
- seeded PRNG is injected explicitly;
- fixed clock can reproduce transitions;
- same eval command produces byte-identical output except generation timestamp;
- same demo seed produces the same customer, episode, state, and ledger data;
- replay does not call the network;
- evaluation does not touch disk or network except writing its output artifact.



### 7.2 Money safety

- all money fields are integer paise;
- all aggregation functions assert integer paise;
- no floating-point money fields in persistence;
- UI formatting is the only rupee conversion boundary;
- no operator-precedence ambiguity in net calculations;
- recovered revenue and incremental revenue are separate fields.



### 7.3 State and audit integrity

- every state transition goes through the state machine;
- episodes are never mutated in place;
- every transition emits exactly one audit event;
- state save and audit append are atomic within the store operation where possible;
- audit payload contains the inputs that explain the decision;
- policy version is stored with the decision;
- duplicate webhooks create one episode;
- duplicate execution calls return the first result;
- failed execution cannot produce a recovered status.



### 7.4 Build safety

The homepage and static generation must be side-effect-free:

- no Twilio call during render;
- no Razorpay API call during render;
- no external network dependency for the demo snapshot;
- no provider credential required to run the UI;
- real integrations run only after an explicit demo action;
- build must finish without external service access.



### 7.5 Webhook and outcome honesty

- verify the exact raw webhook body, not a parsed and reserialized body;
- reject missing webhook secrets in configured integration mode;
- preserve the original event ID;
- make duplicate delivery idempotent;
- use provider-observed payment outcomes where available;
- label manual outcome injection as a simulator/demo-only path;
- never mark a payment recovered merely because an action was attempted.



### 7.6 Persistence

Use the SQLite adapter specified in `BUILD_SPEC.md` for demo persistence and the in-memory adapter for offline evaluation. Test:

```text
start -> process episode -> stop -> restart -> list episode -> inspect audit
```

The demo must survive restart without requiring a database server.

### 7.7 No fake realtime

The active dashboard must consume the SSE endpoint through a browser client hook. A server singleton imported into a client component is not realtime browser delivery.

SSE requirements:

- dynamic Node route;
- event-stream headers;
- heartbeat every 15 seconds;
- monotonic event IDs;
- `Last-Event-ID` replay from the last 200 events;
- cleanup on disconnect;
- reconnect backoff of 1, 2, 4, and 8 seconds;
- visible updates for episode creation, policy decisions, outcomes, ledger, and degradation.

---



## 8. Dashboard Experience

The dashboard is a merchant evidence surface, not an admin CRUD screen.

### 8.1 First viewport

The first viewport must communicate the thesis immediately:

```text
₹[gross recovered] recovered
₹[incremental] incremental
holdout n=[x] · treatment n=[y] · 95% CI [₹[lo] – ₹[hi]]
```

The incremental figure is visually dominant. Gross recovery is secondary and clearly labelled. Every synthetic number carries a `synthetic benchmark` label or method note.

### 8.2 KPI strip

Show:

- revenue at risk;
- native recovery;
- RecoverOS recovery;
- incremental recovery;
- intervention cost;
- recovery rate;
- interventions avoided or suppressed.



### 8.3 Queue

Columns:

- customer;
- amount;
- payment rail;
- diagnosis and confidence;
- native state;
- EIR;
- proposed/allowed action;
- restraint reason;
- status.

Rows must include examples of:

- one recovered treatment;
- one native-recovery `WAIT`;
- one `HELD_OUT`;
- one `SUPPRESSED`;
- one `HELD_DEGRADED`;
- one escalation.



### 8.4 Why panel

For each selected episode, show:

```text
Known signal
Diagnosis
Certainty class
Confidence
P(recovery | RecoverOS action)
P(recovery | native)
EIR without churn
Churn cost
Final EIR
Proposed action
Policy verdict
Execution result
Observed outcome
```

The panel must answer “why did it act?” and “why did it not act?” with equal clarity.

### 8.5 Protected ledger

Show both values, never only the flattering one:

```text
Revenue protected by not acting
Protected ₹X · Forgone ₹Y · Net ₹(X - Y)
[N] suppressed episodes
```

Definitions:

```text
protected = sum(churnCostPaise for SUPPRESSED episodes)
forgone   = sum(max(0, eirWithoutChurnPaise) for SUPPRESSED episodes)
net       = protected - forgone
```

Each figure must drill into contributing episodes.

### 8.6 Degradation banner

When active:

```text
ISSUER DEGRADATION — [issuer] [method] · [ratio]× baseline
[N] episodes held · 0 customers contacted · opened [time]
```

When resolved:

```text
RESOLVED — [N] of [M] released · 0 interventions spent during outage
```

Use a persistent simulation-clock chip when the demo accelerates time:

```text
sim clock 60×
```



### 8.7 Benchmark panel

The benchmark panel must show:

- three arms;
- net of cost;
- mean and 95% across-seed interval;
- interventions;
- recovery rate;
- generated-data label;
- method note;
- losing-region link or panel;
- calibration, with a warning if the scorer is overconfident.

Do not display “BEST LIFT” on RecoverOS if the canonical net comparison says it loses. The UI must reflect the actual report.

---



## 9. Five-Minute Winning Demo

The demo should feel like one argument, not a tour of features.

### 0:00–0:20 — The lie

**On screen:** dashboard headline with gross recovery secondary and incremental recovery dominant.

**Say:**

> Every recovery product reports money recovered. But some of that money was already coming back. RecoverOS measures the money that would not have arrived otherwise.



### 0:20–1:05 — Show the counterfactual

**On screen:** holdout ledger and one `HELD_OUT` episode audit trail.

**Say:**

> Five percent of genuinely action-eligible episodes are held out before execution. They still receive outcomes. That gives us a real no-action counterfactual inside the policy, not a post-hoc guess.

Point to:

- treatment count;
- holdout count;
- recovery rates;
- CI;
- value cap;
- observed outcome completion.



### 1:05–1:55 — Show restraint

**On screen:** a dormant subscription marked `SUPPRESSED`, then an issuer degradation banner.

**Say:**

> The agent's job is not to act as often as possible. A dormant customer may cancel after being reminded about a forgotten subscription. During an issuer outage, contacting thousands of customers is actively harmful. RecoverOS makes both decisions visible and auditable.

Show:

- churn cost exceeding positive EIR without churn;
- protected and forgone ledger;
- zero intervention spend during degradation;
- requeue after close.



### 1:55–2:45 — Show one real Razorpay test-mode episode

**On screen:** Razorpay test-mode webhook, normalized event, decision timeline, payment-link creation, provider dashboard.

**Say:**

> The batch result is reproducible simulation evidence. This is a separate proof: one real Razorpay test-mode event traversing the same bounded pipeline into a payment link and complete audit trail.

Do not call this causal incremental revenue. Call it integration proof.

### 2:45–3:35 — Show replay

**On screen:** change EIR threshold and replay historical episodes.

**Say:**

> Before shipping a new policy, a merchant can replay it against history. Outcomes from the action actually taken are observed. Counterfactual outcomes are modelled, and the UI tells you exactly which is which. The holdout arm calibrates the no-action model.

Show:

- observed fraction;
- changed actions;
- recovered delta;
- intervention delta;
- protected delta;
- net delta.



### 3:35–4:25 — Show honest results

**On screen:** generated three-arm table, across-seed intervals, assumptions, losing region.

**Say:**

> Here is the result across the same hidden worlds, and here is where we stop winning. If the contact response is too low, the churn penalty is too high, or intervention costs rise, the product should not run. A recovery product that cannot name its losing region is selling attribution, not intelligence.



### 4:25–5:00 — Close

**On screen:** architecture diagram and one selected audit timeline.

**Say:**

> AI proposes. The model scores. Policy controls. The executor acts. Audit proves. Measurement decides whether RecoverOS actually helped. We do not get paid for gravity.



### Demo rules

- freeze the seed;
- label simulation speed;
- preflight the real integration;
- never rely on a provider call for the opening or closing beat;
- keep all fonts readable at 1080p;
- rehearse five times under five minutes;
- if a live integration fails, continue with the prerecorded or fixture path and state that it is a fixture;
- never fabricate a success state to recover from a demo failure.

---



## 10. Implementation Order And Quality Gates

Follow the order below. Do not start the next gate until its command passes.

### Gate 0 — Documentation and authority

Acceptance:

- current documents identify `BUILD_SPEC.md` as implementation authority;
- historical plans are labelled historical;
- no contradictory baseline definition remains in judge-facing material;
- the headline layout values are labelled illustrative, not data.



### Gate 1 — Deterministic foundations

Complete:

- paise money refactor;
- injected clock;
- injected Mulberry32 PRNG;
- domain schemas and new states;
- state-machine legal transitions;
- atomic transition-plus-audit store operation.

Command:

```bash
npx tsc --noEmit && npm test
```



### Gate 2 — Canonical evaluation

Complete:

- true no-intervention baseline;
- exact rules arm;
- RecoverOS arm;
- common-world evaluation;
- integer-paise metrics;
- actual confidence intervals;
- generated report and Git SHA;
- all assumptions wired;
- sweep with a real losing cell.

Commands:

```bash
npm run eval -- --episodes 1000 --seeds 3 --out /tmp/a.md
npm run eval -- --episodes 1000 --seeds 3 --out /tmp/b.md
diff <(grep -v generatedAtIso /tmp/a.md) <(grep -v generatedAtIso /tmp/b.md)
npm run eval:sweep
```



### Gate 3 — Holdout validity

Complete:

- no arm assigned to ineligible episodes;
- high-value cap honoured;
- all held-out outcomes observed;
- episode-level bootstrap;
- planted-truth estimand matches estimated estimand;
- coverage at least 17/20 deterministic seeds.

Command:

```bash
npm test -- holdout-estimator
```



### Gate 4 — Restraint behaviors

Complete:

- degradation detector seven-test matrix;
- baseline freeze while degraded;
- `HELD_DEGRADED` transition and release;
- suppression six-test matrix;
- protected ledger derived from episodes;
- distinct dashboard states and reasons.

Command:

```bash
npm test -- degradation suppression state-machine
```



### Gate 5 — Real integration and persistence

Complete:

- raw webhook signature verification;
- idempotent webhook ingestion;
- SQLite persistence across restart;
- test-mode payment-link execution;
- provider outcome mapping;
- no external call during build or eval.

Commands:

```bash
npm run build
npm run seed:demo -- --seed 7
```



### Gate 6 — Realtime and replay

Complete:

- browser SSE subscription;
- heartbeat and reconnect behavior;
- visible episode transitions;
- replay policy fields match domain fields;
- observed/modelled outcomes are labelled;
- unchanged-policy replay has deltas within the specified tolerance.

Commands:

```bash
npm run dev
curl -N localhost:3000/api/stream
npm test -- replay
```



### Gate 7 — Submission verification

The final command must pass:

```bash
npm run verify
```

Then run:

```bash
npm run eval -- --episodes 50000 --seeds 20 --holdout 5 --out RESULTS.md
git status --short
```

The generated report, machine-readable result, UI headline, and pitch script must all refer to the same run.

---



## 11. Required Test Matrix

The minimum serious test suite is:

### Foundations

- PRNG literal reproducibility;
- fixed and scaled clock behavior;
- paise round-trip and rounding;
- float rejection;
- domain schema validation.



### Decision engine

- diagnosis mappings and unknown confidence;
- native recovery `WAIT` gate;
- EIR arithmetic;
- churn term arithmetic;
- residual LTV;
- action set rejection;
- consent, opt-out, contact window, message cap, voice cap;
- maximum attempt escalation;
- invalid AI proposal cannot execute.



### State and audit

- all legal transitions;
- all illegal transitions throw;
- `HELD_OUT` receives outcome;
- `HELD_DEGRADED` releases correctly;
- `SUPPRESSED` is terminal;
- exactly one audit event per transition;
- duplicate webhook produces one episode;
- duplicate execution produces one external call.



### Measurement

- identical world consumed by all arms;
- no latent truth visible to engine;
- baseline has zero interventions;
- rules uses the documented two-contact behavior;
- all swept parameters affect the path they claim to affect;
- generated output is reproducible;
- across-seed interval uses correct degrees of freedom;
- bootstrap uses seeded episode resampling;
- estimator coverage meets threshold.



### Integrations

- invalid webhook signature rejected;
- raw-body signature works with provider payload;
- missing secret is not silently accepted in integration mode;
- test-mode payment link is idempotent;
- provider outcome maps to the originating episode;
- build makes no provider calls;
- outcome endpoint cannot forge production recovery.



### UI and replay

- all restraint states render distinctly;
- protected ledger drills into episodes;
- SSE event updates the browser;
- reconnect resumes from event ID;
- replay policy controls actually change policy;
- observed fraction is accurate;
- unchanged policy produces zero or near-zero deltas;
- no hardcoded headline metrics.

---



## 12. Honest Claims Guide



### Claims allowed

Use language like:

- “RecoverOS implements an incremental recovery measurement layer.”
- “The benchmark uses a hidden synthetic world and common outcomes across arms.”
- “The holdout estimator is validated against planted truth.”
- “The Razorpay path is demonstrated in test mode.”
- “The dashboard distinguishes observed outcomes from modeled counterfactuals.”
- “The prototype flags `deltaPChurn` as an assumption that requires production measurement.”
- “Razorpay is structurally positioned to aggregate issuer degradation signals across merchants.”



### Claims forbidden unless real evidence exists

Do not say:

- “RecoverOS recovered ₹X in production.”
- “The simulator proves real customer lift.”
- “The test-mode payment proves incremental recovery.”
- “The system is production-ready.”
- “The LLM autonomously recovers payments.”
- “The degradation detector is cross-merchant” when the prototype is single-merchant.
- “Protected revenue is ₹X” when the value is a fixture.
- “The model is calibrated” if calibration bins show material error.



### Recommended results wording

> In a reproducible synthetic benchmark of [N] seeds and [M] episodes per seed, RecoverOS produced [X] net value relative to the native no-intervention baseline, with a [CI] across seeds. These results are scenario-based, not production efficacy evidence. A separate Razorpay test-mode run demonstrates the live integration path.

This wording is less flashy than an unsupported revenue claim and much more likely to survive scrutiny.

---



## 13. Judge Questions And Answers



### “Is this just a retry engine?”

No. Retry is one bounded action. The product's value is deciding when not to retry or contact, estimating what native recovery would have done, measuring lift against holdouts, and replaying policy changes before release.

### “Why should I believe a synthetic benchmark?”

You should not treat it as production proof. It is a reproducible instrument for testing the measurement mechanics. We publish the assumptions, use hidden outcomes the policy cannot access, compare all arms in the same worlds, validate the estimator against planted truth, and publish where the product loses.

### “Why is the holdout only 5%?”

It is permanent and eligibility-gated. It is not assigned to cases where RecoverOS would have waited or stopped, and high-value episodes are protected from holdout. The dashboard reports the sample size and interval instead of hiding uncertainty.

### “What is the AI doing?”

Known structured failures are handled deterministically. AI is used where ambiguity and explanation benefit from context. It proposes a schema-valid diagnosis or action, but the deterministic policy engine controls every customer-facing and financial action.

### “Why would Razorpay care?”

Razorpay already owns native payment behavior and sees cross-merchant rail signals. RecoverOS can sit above that behavior, measure incremental merchant value, and detect issuer degradation at a network scale that one merchant cannot.

### “Why not let the agent contact everyone?”

Because contact has cost, legal constraints, customer fatigue, and possible churn impact. The product is valuable precisely when it prevents a low-quality intervention.

### “Does one test-mode payment prove recovery?”

It proves the integration path. It does not prove causal lift. Causal lift is the job of the holdout and controlled evaluation, and the product labels those proofs separately.

### “What happens when your model is wrong?”

The model cannot bypass policy. Low confidence escalates. EIR thresholds, consent, native-state checks, attempt caps, degradation holds, value caps, and audit records provide deterministic containment.

### “Where do you lose?”

The sweep must answer with an actual cell. Low contact response, high intervention cost, high churn risk, or weak action lift can make intervention less valuable than native recovery. RecoverOS should stop operating in those regions.

---



## 14. Submission Assets

The final repository must contain:

- `README.md` with the one-line thesis, generated headline, method, setup, and limitations;
- `DOC.md` with this submission-quality contract;
- `BUILD_SPEC.md` with implementation invariants;
- `SIMULATOR.md` with plain-English assumptions;
- generated `RESULTS.md`;
- committed machine-readable evaluation artifact with Git SHA;
- deterministic demo seed script;
- five-minute runbook or scene script;
- architecture diagram showing AI/model, policy, executor, audit, and measurement;
- one screenshot or recording of the real test-mode path if provider availability is fragile;
- tests covering the full matrix;
- `.env.example` with no secrets;
- clear statement of simulated, observed, and modeled values.



### Architecture diagram content

The diagram must show:

```text
Razorpay webhook
      |
      v
Normalizer -> Customer profile
      |
      v
Diagnosis / AI ambiguity adapter
      |
      v
Recovery scorer: p(native), p(action), EIR
      |
      v
Policy boundary
  |       |        |        |
WAIT  HOLDOUT  SUPPRESS  DEGRADE
      |
      v
Executor -> Razorpay test-mode payment link
      |
      v
Outcome observer -> SQLite + append-only audit
      |
      v
Ledger + SSE dashboard + replay + evaluation
```

The visual hierarchy should make the policy boundary look more important than the LLM.

---



## 15. Final Pre-Submission Checklist



### Product

- [ ] The failed recurring-payment problem is obvious within 20 seconds.
- [ ] The incremental counterfactual is the central metric.
- [ ] The target merchant and buyer are explicit.
- [ ] The four restraint states are visible.
- [ ] At least one action and one non-action are demonstrated.
- [ ] The performance-pricing idea is stated without claiming a current pricing contract.



### Evaluation

- [ ] Baseline is truly no intervention.
- [ ] Rules behavior matches its definition.
- [ ] All arms use the same generated world.
- [ ] Outcomes are generated only from hidden truth.
- [ ] Results are generated, not hand-edited.
- [ ] Git SHA is present.
- [ ] Assumptions are printed verbatim.
- [ ] Every sweep parameter is wired and tested.
- [ ] A losing region is reported.
- [ ] Holdout sample sizes are visible.
- [ ] Holdout outcomes are complete.
- [ ] Estimator coverage passes.
- [ ] Confidence intervals use the correct method.



### Safety and reliability

- [ ] No provider calls happen during build.
- [ ] No network calls happen in eval or replay.
- [ ] Raw webhook signatures are validated.
- [ ] Missing secrets do not fail open in integration mode.
- [ ] Duplicate webhook and execution behavior is idempotent.
- [ ] Failed executions cannot become recovered outcomes.
- [ ] AI cannot call an executor or change policy.
- [ ] Every state transition has exactly one audit event.
- [ ] SQLite state survives restart.



### Demo

- [ ] Dashboard loads without credentials.
- [ ] Demo seed is deterministic.
- [ ] Simulation speed is labelled.
- [ ] SSE updates are visible.
- [ ] Holdout ledger is understandable without narration.
- [ ] Suppression ledger has episode drill-down.
- [ ] Degradation opens, holds, closes, and requeues.
- [ ] Real test-mode integration has been rehearsed.
- [ ] Replay unchanged-policy deltas are approximately zero.
- [ ] Full demo is under five minutes.
- [ ] The fallback path is honest if a provider is unavailable.



### Narrative

- [ ] Opening line is the counterfactual problem, not the architecture.
- [ ] The demo shows restraint before showing feature breadth.
- [ ] Synthetic, observed, and modeled values are verbally and visually separated.
- [ ] The closing line is “We do not get paid for gravity.”
- [ ] No unsupported production or causal claims appear in the pitch.

---



## 16. Final Definition Of A Winning Submission

RecoverOS is ready to submit only when a judge can follow one episode and receive a complete answer:

```text
This payment failed.
These are the known signals.
This is the diagnosis and confidence.
Native recovery would likely recover this much.
This action would likely recover this much.
The expected incremental value was this.
The customer-risk cost was this.
Policy allowed, held, suppressed, waited, or escalated for this reason.
Only the approved executor acted.
The outcome was observed from this source.
The audit trail proves the sequence.
The batch result compares against the same native counterfactual.
The confidence interval and sample size are visible.
Here is where the product stops winning.
```

That complete chain is the product.

The submission does not win by having the most channels, the most infrastructure, or the most autonomous behavior. It wins by making a money claim that is more honest, more technically defensible, and more useful to a merchant than the incumbent claim.

> **RecoverOS: recover revenue, protect trust, and prove the difference.**

