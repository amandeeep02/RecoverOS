# RecoverOS — PLAN.md

## 1. Objective

Build RecoverOS as a competition-ready Razorpay Track 03 submission with the following proof:

> **RecoverOS creates measurable incremental revenue over Razorpay's native recovery behavior while keeping every AI action bounded, auditable, and explainable.**

The implementation strategy is deliberately evidence-first.

Do not start by building a large UI or adding multiple recovery channels.

Build the decision loop, make the benchmark credible, connect it to Razorpay, then build the demo surface around proven behavior.

---

# 2. Final Build Order

```text
Phase 0  → Lock architecture and assumptions
Phase 1  → Repository + data contracts
Phase 2  → Synthetic world + hidden-ground-truth simulator
Phase 3  → Baseline + rules benchmark
Phase 4  → Recovery probability + EIR engine
Phase 5  → Diagnose + LLM decision layer
Phase 6  → Policy Engine + state machine
Phase 7  → Razorpay integration + executor
Phase 8  → Outcome observer + audit + revenue ledger
Phase 9  → Dashboard + Why panel
Phase 10 → Full benchmark + calibration
Phase 11 → Adversarial testing + hardening
Phase 12 → Demo + submission packaging
```

The dependency chain matters.

**Do not build Phase 9 before Phase 10 is producing trustworthy numbers.**

---

# 3. Phase 0 — Lock the Product

## Goal

Freeze scope before writing the main code.

## Decisions

### Primary wedge
Failed recurring payments.

### Core action set

```text
WAIT
PAYMENT_LINK
REMINDER
ESCALATE
STOP
RETRY (constrained fallback)
```

### Core metric

Expected Incremental Recovery.

### Core benchmark

```text
Baseline
vs
Rules-based
vs
RecoverOS
```

### Core product screen

Recovery Queue + Why Panel.

### Explicitly out of scope

- production payments,
- full B2B product,
- live voice,
- unrestricted autonomous messaging,
- complex multi-agent architecture.

## Exit Criteria

You should be able to explain the product in 30 seconds without adding another feature.

---

# 4. Phase 1 — Repository and Contracts

## Goal

Create the project skeleton and freeze internal interfaces.

## Suggested Repository

```text
recoveros/
├── apps/
│   └── dashboard/
├── services/
│   ├── api/
│   ├── webhook-ingestion/
│   ├── policy-engine/
│   ├── executor/
│   ├── simulator/
│   └── scoring/
├── packages/
│   ├── domain/
│   ├── schemas/
│   ├── policy/
│   └── shared/
├── data/
│   ├── generated/
│   └── seeds/
├── docs/
├── tests/
└── README.md
```

Adapt this to the actual stack you choose. Do not split into microservices unless the separation gives you something useful.

## First Contracts

Define typed schemas for:

- PaymentEvent
- CustomerProfile
- Diagnosis
- RecoveryPrediction
- EIRScore
- ActionProposal
- PolicyDecision
- ExecutionResult
- OutcomeEvent
- AuditEvent
- RecoveryEpisode

Use a schema validator such as Zod on the TypeScript side.

## Exit Criteria

A mocked event can move through the domain types without ambiguous fields.

---

# 5. Phase 2 — Build the Synthetic World First

## Goal

Create the benchmark foundation before building the agent.

This is the most important engineering phase.

## 5.1 Customer Generator

Generate customer states:

```text
subscription_age
customer_value
payment_history
failure_history
payment_method
```

## 5.2 Failure Generator

Generate failures by payment method and cause.

Include:

- temporary failures,
- permanent failures,
- authentication issues,
- mandate issues,
- insufficient balance,
- unknown/ambiguous failures.

## 5.3 Hidden Truth Generator

Generate a latent recovery probability that depends on underlying customer state.

Important:

**RecoverOS never sees this value.**

Example conceptual model:

```python
latent_logit =
    intercept
    + history_weight
    + customer_value_weight
    + failure_type_weight
    + payment_method_weight
    + time_weight
```

Then:

```python
true_probability = sigmoid(latent_logit)
```

## 5.4 Counterfactual Outcomes

For each case, the simulator should be able to evaluate:

```text
native recovery outcome
RecoverOS intervention outcome
```

The same hidden world must be reused across strategy comparisons.

## 5.5 Seeds

Create deterministic seeds.

Initial benchmark set:

```text
seed_01 ... seed_20
```

## Exit Criteria

You can run:

```bash
python simulator/run.py --seed 1
```

and obtain deterministic results.

---

# 6. Phase 3 — Baseline and Rules Strategy

## Goal

Create competitive baselines before creating RecoverOS.

This prevents tuning RecoverOS against a weak strawman without knowing whether the approach actually provides value.

## Baseline

```text
Attempt one generic recovery intervention.
```

For subscription flows, represent native recovery according to the modeled Razorpay behavior.

## Rules Strategy

Example:

```text
temporary failure → retry/intervene
permanent failure → stop
unknown → escalate
```

## Metrics

Track:

- gross recovery,
- recovery rate,
- intervention count,
- wasted interventions,
- incremental recovery.

## Exit Criteria

The benchmark framework can run all strategies through the same event world.

---

# 7. Phase 4 — Recovery Probability and EIR

## Goal

Build the mathematical core of RecoverOS.

## 7.1 Feature Vector

Start with a small, transparent feature set:

```text
payment_method
amount
failure_type
successful_payment_count
failed_payment_count
previous_recovery_rate
subscription_age
customer_value
days_since_last_success
```

Avoid feature bloat.

## 7.2 Initial Model

Start with a simple calibrated model:

- logistic regression,
- gradient boosting,
- or another lightweight interpretable classifier.

The hackathon does not require an exotic model.

The goal is reliable ranking, not ML theater.

## 7.3 Two Predictions

Generate:

```text
P_recover_native
P_recover_action
```

These should come from different modeled intervention conditions.

## 7.4 EIR

Implement:

```text
EIR =
(P_recover_action - P_recover_native)
× amount
- intervention_cost
```

Make the code deterministic and heavily unit-tested.

## 7.5 Thresholding

Create merchant-level configuration:

```text
minimum_eir_inr
max_attempts
```

## Exit Criteria

Given a payment, the system can produce:

```json
{
  "p_recover_action": 0.91,
  "p_recover_native": 0.55,
  "eir_inr": 5400
}
```

and the result is reproducible.

---

# 8. Phase 5 — Diagnosis + LLM Layer

## Goal

Add AI only where AI actually adds value.

## 8.1 Deterministic Diagnosis

Handle structured failure codes first.

Example:

```text
known bank_declined
known expired_credential
known authentication_failed
```

No LLM needed.

## 8.2 LLM Diagnosis

Use the LLM for:

- heterogeneous context,
- ambiguous signals,
- human-readable explanation,
- action proposal.

## 8.3 Structured Output

Force the LLM to return a schema such as:

```json
{
  "diagnosis": "...",
  "certainty_class": "known|inferred|unknown",
  "confidence": 0.91,
  "recommended_action": "WAIT|PAYMENT_LINK|REMINDER|ESCALATE|STOP|RETRY",
  "reason_codes": [],
  "explanation": "..."
}
```

Reject malformed output.

Never let natural-language output directly trigger execution.

## 8.4 Prompting Strategy

Keep prompts small and explicit.

Include:

- normalized failure,
- customer profile,
- native recovery state,
- EIR,
- available actions,
- merchant policy.

Do not expose secrets or unnecessary PII.

## Exit Criteria

The LLM can propose an action and explanation, but cannot execute anything.

---

# 9. Phase 6 — Policy Engine and State Machine

## Goal

Turn agentic reasoning into bounded execution.

## 9.1 Policy Engine

Implement deterministic functions:

```text
can_act()
within_contact_window()
has_valid_consent()
attempt_budget_remaining()
eir_above_threshold()
native_recovery_complete()
action_allowed()
```

## 9.2 Decision Flow

```text
LLM proposal
    ↓
policy validation
    ↓
APPROVE / REJECT / ESCALATE
```

## 9.3 Recovery Episode State Machine

Example:

```text
DETECTED
  ↓
DIAGNOSED
  ↓
SCORED
  ↓
PROPOSED
  ↓
POLICY_CHECK
  ├── REJECT → ESCALATED
  └── APPROVE → EXECUTING
                    ↓
                 PENDING
               /         \
          RECOVERED      FAILED
                         ↓
                    NEXT DECISION
```

## 9.4 Hard Stops

Implement the three non-negotiables:

- max automated attempts,
- escalation after cap,
- policy rejection never executes.

## Exit Criteria

No possible LLM output can bypass policy constraints in unit tests.

---

# 10. Phase 7 — Razorpay Integration

## Goal

Connect the proven decision loop to Razorpay test/sandbox behavior.

## 10.1 Webhook Receiver

Implement:

```text
POST /webhooks/razorpay
```

Add:

- signature validation where supported,
- idempotency,
- event persistence,
- normalized internal event emission.

## 10.2 Native Recovery State

Model enough Razorpay subscription state to decide whether RecoverOS should WAIT.

Do not invent unsupported native behavior.

## 10.3 Payment Link Executor

Implement the first real recovery action:

```text
PAYMENT_LINK
```

Flow:

```text
Policy APPROVED
   ↓
Executor
   ↓
Razorpay API
   ↓
Payment Link
   ↓
Persist external reference
```

## Exit Criteria

A real Razorpay test-mode event can enter RecoverOS and reach an approved test-mode execution.

---

# 11. Phase 8 — Outcome Observer, Audit, Revenue Ledger

## Goal

Close the loop.

## 11.1 Outcome Observer

Consume subsequent events and update:

```text
PENDING
RECOVERED
FAILED
EXPIRED
ESCALATED
```

## 11.2 Audit

Every transition creates an append-only audit record.

Test that an audit event can reconstruct:

```text
signal
→ diagnosis
→ prediction
→ EIR
→ proposal
→ policy
→ execution
→ outcome
```

## 11.3 Revenue Ledger

Maintain aggregates:

```text
revenue_at_risk
native_recovered
recoveros_recovered
incremental_recovered
intervention_cost
```

## Exit Criteria

One end-to-end payment can be traced from failure to final outcome in a single audit view.

---

# 12. Phase 9 — Dashboard

## Goal

Build the smallest UI that communicates the entire product.

## Screen 1 — Overview

Show:

```text
Revenue at Risk
Native Recovery
RecoverOS Recovery
Incremental Recovery
Interventions
```

## Screen 2 — Recovery Queue

Columns:

```text
Customer
Amount
Diagnosis
EIR
Action
Status
```

## Screen 3 — Why Panel

Show:

```text
Known signals
Inferred diagnosis
Confidence
P(RecoverOS)
P(Native)
EIR
Action
Policy decision
Outcome
```

## Screen 4 — Audit

Timeline of every event.

## Screen 5 — Benchmark

Compare:

```text
Baseline
Rules
RecoverOS
```

## Design Rule

The dashboard should communicate business value before technical architecture.

---

# 13. Phase 10 — Full Benchmark and Calibration

## Goal

Generate the numbers that will appear in the pitch.

## Run

At least 20 seeds.

For each seed:

```text
Generate world
↓
Run baseline
↓
Run rules
↓
Run RecoverOS
↓
Score against identical hidden ground truth
```

## Collect

- recovered revenue,
- incremental revenue,
- interventions,
- wasted interventions,
- calibration,
- policy rejects,
- escalations,
- average EIR.

## Statistical Summary

Report:

```text
mean
standard deviation
```

for the headline metrics.

## Critical Rule

Never manually tune numbers after seeing results just to make the benchmark look better.

If performance is weak, improve the system.

---

# 14. Phase 11 — Adversarial Testing

## Goal

Attack RecoverOS before a judge does.

### Test 1 — LLM Malicious/Invalid Output

Input:

```text
recommended_action = "SEND_MONEY"
```

Expected:

```text
Policy rejects.
```

### Test 2 — Low Confidence

Expected:

```text
Escalate.
```

### Test 3 — Native Recovery Already Likely

Expected:

```text
WAIT or STOP.
```

### Test 4 — Repeated Failure

Expected:

```text
STOP / ESCALATE after cap.
```

### Test 5 — Duplicate Webhook

Expected:

```text
No duplicate action.
```

### Test 6 — Unknown Failure

Expected:

```text
Unknown diagnosis.
Lower confidence.
No aggressive intervention.
```

### Test 7 — Policy Conflict

Expected:

```text
Policy rejection.
No executor call.
Audit event created.
```

### Test 8 — Executor Failure

Expected:

```text
Execution failure recorded.
No false claim of recovery.
```

### Test 9 — Simulator Leakage

Verify:

```text
agent process cannot access latent probability
```

### Test 10 — Reproducibility

Run the same seed twice.

Expected:

```text
same generated world
same benchmark result
```

---

# 15. Phase 12 — Final Demo Preparation

## Demo Duration

Target 5–8 minutes.

## Sequence

### 1. Open with money

```text
₹40L Revenue at Risk
```

### 2. Show native recovery

```text
₹10.6L
```

### 3. Show RecoverOS

```text
₹15.4L
```

### 4. Highlight incremental impact

```text
₹4.8L incremental
```

Then ask:

> Where did the extra ₹4.8L come from?

### 5. Click recovered transaction

Show:

```text
P(RecoverOS)
P(Native)
EIR
Action
Outcome
```

### 6. Show WAIT

Demonstrate RecoverOS deliberately doing nothing because native recovery should handle the case.

### 7. Show STOP

Demonstrate low expected incremental value.

### 8. Show policy rejection

Have the LLM propose an invalid action and let policy reject it.

### 9. Show audit trail

Explain the complete decision chain.

### 10. Close with benchmark

Show multi-seed results and calibration.

---

# 16. Build Priorities

## P0 — Must Work

- simulator,
- hidden ground truth,
- baseline,
- RecoverOS scoring,
- EIR,
- policy engine,
- Razorpay webhook,
- Payment Link executor,
- audit log,
- recovery queue,
- benchmark.

## P1 — Important

- calibration visualization,
- merchant configuration,
- human escalation UI,
- richer diagnosis,
- better analytics.

## P2 — Nice to Have

- secondary B2B architecture demo,
- richer message generation,
- voice,
- additional channels,
- extra payment rails.

Do not touch P2 until every P0 item is working.

---

# 17. Suggested Execution Order by Workstream

If multiple people are building in parallel:

## Engineer A — Simulation/ML

1. Data generator
2. Hidden truth generator
3. Baseline
4. Rules strategy
5. Prediction model
6. EIR
7. Calibration
8. Multi-seed benchmark

## Engineer B — Backend/Agent

1. Domain models
2. Webhook ingestion
3. Diagnosis
4. LLM proposal
5. Policy engine
6. State machine
7. Executor
8. Outcome observer

## Engineer C — Frontend

1. Dashboard shell
2. KPI cards
3. Recovery queue
4. Why panel
5. Audit timeline
6. Benchmark page
7. Demo polish

If working solo, follow the phases strictly rather than attempting the parallel plan.

---

# 18. Daily Build Strategy

For a compressed build:

## Day 1
Architecture, schemas, simulator skeleton.

## Day 2
Synthetic world + hidden ground truth.

## Day 3
Baseline + rules benchmark.

## Day 4
Recovery probability + EIR.

## Day 5
Diagnosis + LLM proposal.

## Day 6
Policy engine + recovery state machine.

## Day 7
Razorpay webhook integration.

## Day 8
Payment Link executor + outcome observer.

## Day 9
Audit log + revenue ledger.

## Day 10
Dashboard + Recovery Queue.

## Day 11
Benchmark hardening + 20 seeds + calibration.

## Day 12
Adversarial tests + reliability fixes.

## Day 13
Demo script + visual polish.

## Day 14
Full dry runs + submission packaging.

This is a reference schedule, not a requirement. Compress or expand based on actual time available.

---

# 19. Testing Plan

## Unit Tests

Test:

- EIR calculation,
- policy rules,
- action validation,
- attempt counters,
- state transitions,
- webhook idempotency,
- audit serialization.

## Integration Tests

Test:

```text
webhook
→ normalization
→ diagnosis
→ scoring
→ policy
→ executor
→ outcome
```

## Simulation Tests

Test:

- deterministic seeds,
- identical world across strategies,
- no latent truth leakage,
- multi-seed consistency.

## Security Tests

Test:

- invalid webhook signature,
- duplicate event,
- executor credential isolation,
- malformed LLM output,
- unauthorized action.

---

# 20. Definition of Done

RecoverOS is build-complete when all of the following are true:

### Product

- [ ] A failed recurring payment enters the system.
- [ ] The system creates a customer revenue profile.
- [ ] The payment gets diagnosed.
- [ ] RecoverOS estimates both native and intervention recovery probabilities.
- [ ] EIR is calculated.
- [ ] LLM proposes an action from the allowed menu.
- [ ] Policy Engine approves/rejects the proposal.
- [ ] Only the Executor can perform Razorpay actions.
- [ ] At least one recovery action works in test mode.
- [ ] Outcome is observed.
- [ ] Revenue ledger updates.
- [ ] Audit trail records the complete chain.

### Evaluation

- [ ] Synthetic simulator exists.
- [ ] Hidden latent truth is inaccessible to RecoverOS.
- [ ] Baseline exists.
- [ ] Rules strategy exists.
- [ ] RecoverOS strategy exists.
- [ ] All three use the same generated world.
- [ ] At least 20 seeds are evaluated.
- [ ] Incremental recovery is reported.
- [ ] Calibration is measured.
- [ ] Wasted interventions are measured.

### Safety

- [ ] LLM cannot call Razorpay.
- [ ] Policy cannot be bypassed.
- [ ] Attempt cap is enforced.
- [ ] Policy rejection escalates.
- [ ] Unknown diagnosis cannot produce unrestricted action.
- [ ] Duplicate webhook cannot cause duplicate execution.

### Demo

- [ ] Money-at-risk metric works.
- [ ] Baseline comparison works.
- [ ] RecoverOS comparison works.
- [ ] Recovered case works.
- [ ] WAIT case works.
- [ ] STOP case works.
- [ ] Policy rejection case works.
- [ ] Audit drill-down works.
- [ ] Benchmark screen works.

---

# 21. What Not To Do

Do not:

- add a second vertical before the main loop works,
- build voice before evaluation is complete,
- use an LLM to calculate EIR,
- use an LLM to enforce policy,
- let the LLM call payment APIs,
- hardcode benchmark results,
- generate outcomes from the model's own predictions,
- show gross recovery without baseline comparison,
- make regulatory claims without current verification,
- build UI before the decision engine is tested.

---

# 22. Final Engineering Principle

The build should follow this priority:

```text
Correctness
    ↓
Measurement
    ↓
Safety
    ↓
Integration
    ↓
Explainability
    ↓
UI polish
    ↓
Stretch features
```

The winning submission is not the one with the most features.

It is the one where a judge can ask:

> **“Why did RecoverOS act?”**

and you can answer:

```text
Because the payment looked like this.
The model estimated this.
Native recovery would have done this.
The incremental value was this.
The policy allowed this.
The executor performed this.
The customer outcome was this.
The benchmark shows this much incremental revenue.
```

That complete chain is the product.
