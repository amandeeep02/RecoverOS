> **SUPERSEDED — historical planning document, not the plan of record.**
> The current plan is `IDEA.md`; the only trustworthy numbers are in `RESULTS.md`.
> Constants and file paths below describe an earlier design and are known to be stale.

# RecoverOS — SPEC.md

## 1. Product Definition

### Product Name
RecoverOS

### Tagline
**The intelligence layer for failed recurring payments.**

### Track
Razorpay AI Buildathon, Track 03: AI Revenue Recovery.

### Core Thesis
RecoverOS is not a better retry engine. It is the judgment layer on top of Razorpay's native recovery behavior.

Most recovery systems ask:

> Can we retry this payment?

RecoverOS asks:

> Is an intervention worth doing, given what would have happened without us?

The system therefore optimizes for **Expected Incremental Recovery (EIR)**, not gross recovered revenue.

### Core Loop

```text
Detect
  ↓
Diagnose
  ↓
Score
  ↓
Decide
  ↓
Policy
  ↓
Act
  ↓
Observe
  ↓
Audit
  ↓
Measure
```

---

# 2. Goals

## 2.1 Primary Goals

1. Detect failed recurring payments through Razorpay webhook events.
2. Build a revenue profile for each affected customer.
3. Diagnose the likely failure class using structured payment data and contextual history.
4. Estimate the incremental value RecoverOS can create beyond native Razorpay recovery.
5. Select a bounded recovery action.
6. Prevent the LLM from directly executing money-touching or customer-facing actions.
7. Execute approved actions through Razorpay test/sandbox APIs.
8. Track outcomes and calculate recovered and incremental revenue.
9. Maintain an append-only audit trail for every decision.
10. Demonstrate performance against:
   - a simple baseline,
   - a rules-based strategy,
   - RecoverOS.
11. Evaluate the agent against hidden simulator ground truth rather than its own predictions.

## 2.2 Secondary Goals

1. Provide a merchant-facing recovery queue.
2. Provide human-readable explanations for every decision.
3. Support payment-method-specific logic.
4. Support configurable merchant recovery policies.
5. Keep the recovery engine reusable for future revenue-recovery verticals.

## 2.3 Non-Goals

The core build does not attempt to fully implement:

- a second production-grade B2B receivables product,
- live voice calling,
- a new payment retry engine,
- unrestricted autonomous messaging,
- unrestricted LLM tool execution,
- causal inference in production as a solved problem,
- real-money payments,
- production financial operations.

---

# 3. Target Workflow

## 3.1 Primary Workflow

The primary use case is a failed recurring payment.

Example:

```text
Razorpay payment.failed event
        ↓
Normalize event
        ↓
Load customer revenue profile
        ↓
Diagnose failure
        ↓
Estimate:
  P(recovery | RecoverOS action)
  P(recovery | native recovery alone)
        ↓
Calculate EIR
        ↓
LLM proposes action
        ↓
Policy Engine validates
        ↓
WAIT / PAYMENT_LINK / REMINDER / ESCALATE / STOP
        ↓
Execute approved action
        ↓
Observe outcome
        ↓
Update revenue ledger
        ↓
Append audit event
```

---

# 4. Functional Requirements

## FR-001 — Webhook Ingestion

The system shall accept Razorpay webhook events relevant to recurring payment recovery.

Initial events:

- `payment.failed`
- `subscription.pending`
- `subscription.halted`

Requirements:

- Validate webhook authenticity where supported.
- Reject malformed payloads.
- Normalize events into an internal schema.
- Preserve the original event ID.
- Make webhook handling idempotent.

### Internal Event Schema

```json
{
  "event_id": "evt_...",
  "event_type": "payment.failed",
  "occurred_at": "2026-08-21T10:14:03Z",
  "customer_id": "cust_...",
  "payment_id": "pay_...",
  "subscription_id": "sub_...",
  "payment_method": "upi",
  "amount_inr": 8499,
  "failure_code": "bank_declined",
  "failure_source": "bank"
}
```

---

# 5. Event Normalization

## FR-002 — Event Normalizer

Different payment rails expose different event and failure shapes.

The normalizer shall convert external events into a common internal representation.

Minimum fields:

- event ID
- customer ID
- payment ID
- subscription ID
- amount
- currency
- payment method
- failure source
- failure reason/code
- timestamp
- native recovery state
- merchant ID

The normalized model must allow additional rail-specific metadata without changing the core schema.

---

# 6. Revenue Profile

## FR-003 — Customer Revenue Profile

RecoverOS shall maintain a derived profile for every customer with payment history.

Minimum information:

```text
customer_id
subscription_age
customer_value
successful_payment_count
failed_payment_count
previous_recovery_rate
previous_intervention_count
previous_intervention_success_count
days_since_last_success
last_failure_reason
payment_method_distribution
current_failure_episode
```

The profile must be retrievable during decisioning.

---

# 7. Failure Diagnosis

## FR-004 — Root Cause Diagnosis

The system shall classify payment failures into explicit categories.

Example classes:

- insufficient balance
- expired payment credential
- temporary bank decline
- permanent decline
- authentication issue
- mandate issue
- network/gateway failure
- unknown

### Diagnosis Confidence

Every diagnosis shall contain:

```text
known
inferred
unknown
```

Example:

```json
{
  "diagnosis": "temporary_bank_decline",
  "confidence": 0.91,
  "certainty_class": "inferred"
}
```

### Diagnosis Principles

1. Structured failure codes should be handled deterministically wherever possible.
2. The LLM should only be used when combining heterogeneous context adds value.
3. Low-confidence and unknown diagnoses must reduce action confidence.
4. The system must not invent an unsupported bank-side cause.

---

# 8. Recovery Probability

## FR-005 — Recovery Probability Model

RecoverOS shall estimate two probabilities:

```text
P(recovery | RecoverOS action)
P(recovery | native Razorpay recovery alone)
```

These estimates may initially be produced by a deterministic/ML model.

Production implementation requirements:

- reproducible inputs,
- explicit feature set,
- calibration evaluation,
- no use of hidden simulator ground truth,
- confidence metadata.

---

# 9. Expected Incremental Recovery

## FR-006 — EIR Calculation

The core decision metric is:

```text
Expected Incremental Recovery
=
[
  P(recovery | RecoverOS action)
  -
  P(recovery | native recovery alone)
]
×
revenue at stake
-
intervention cost
```

The system shall calculate EIR for every candidate intervention.

### Example

```text
Payment value: ₹15,000

P(recover with RecoverOS): 91%
P(recover natively):       55%

Incremental lift:          36%

Expected incremental recovery:
0.36 × ₹15,000 = ₹5,400
```

The decision threshold must be merchant-configurable.

---

# 10. Action Selection

## FR-007 — Bounded Action Menu

RecoverOS can only select from an explicit action set.

### Action: WAIT

Use when:

- native Razorpay recovery is still active,
- intervention is unlikely to add incremental value,
- waiting improves the expected outcome.

Default behavior for eligible card failures still inside the native retry window.

### Action: PAYMENT_LINK

Use when:

- native retries are exhausted,
- incremental recovery is high,
- customer engagement makes a link useful.

Guardrails:

- expiry,
- rate limit,
- policy approval,
- merchant configuration.

### Action: REMINDER

Use when:

- recovery probability is moderate/high,
- a low-friction communication may increase payment completion.

Guardrails:

- contact policy,
- consent status,
- quiet hours,
- opt-out status,
- per-episode cap.

### Action: ESCALATE

Use when:

- diagnosis confidence is low,
- policy rejects the proposed action,
- customer/value threshold warrants human handling,
- retry/intervention budget is exhausted.

### Action: STOP

Use when:

- EIR is below threshold,
- further intervention has negative expected value,
- customer has exceeded intervention limits.

STOP must be logged with a reason.

### Action: RETRY

A constrained fallback only.

It is not the core product differentiator.

Use only when:

- native retry has ended,
- a retry is technically valid,
- the expected incremental benefit is positive,
- merchant policy explicitly allows it.

---

# 11. Agent Authority Model

## FR-008 — Three-Box Authority Separation

The architecture must explicitly separate:

```text
LLM
  ↓
Policy Engine
  ↓
Executor
```

### LLM

Allowed to:

- classify/interpret ambiguous context,
- propose an action,
- provide explanation,
- draft customer-facing content.

Not allowed to:

- directly call Razorpay,
- directly send messages,
- change policy,
- bypass limits,
- execute financial actions.

### Policy Engine

Allowed to:

- approve,
- reject,
- escalate,
- enforce all hard constraints.

The policy engine must be deterministic and testable.

### Executor

The executor is the only service permitted to hold credentials required to call Razorpay APIs or messaging providers.

---

# 12. Policy Engine

## FR-009 — Policy Enforcement

Minimum policy inputs:

- remaining intervention budget,
- native recovery status,
- minimum EIR threshold,
- contact-window rules,
- consent status,
- opt-out status,
- message cap,
- action type,
- customer configuration.

Policy outcomes:

```text
APPROVE
REJECT
ESCALATE
```

A rejected action must never execute.

---

# 13. Stopping Rules

## FR-010 — Hard Stop Rules

Initial implementation:

1. Maximum 3 automated intervention attempts per failure episode.
2. Mandatory human escalation after the cap.
3. Policy rejection automatically escalates.
4. STOP is terminal for the current episode unless a new qualifying event occurs.
5. The LLM cannot override a stop rule.

All values must be merchant-configurable where appropriate.

---

# 14. Payment-Rail Awareness

## FR-011 — Rail-Specific Logic

RecoverOS shall not assume all recurring payment rails behave identically.

### Cards

The system shall respect Razorpay's native retry lifecycle before intervening.

The current documented card subscription retry behavior used by the design is T+1, T+2 and T+3, followed by terminal subscription states if recovery fails.

### UPI Autopay

The system shall use separate UPI diagnosis and lifecycle handling.

The implementation must avoid hardcoding an unsupported universal UPI retry timing until verified directly against the applicable Razorpay documentation/sandbox behavior.

---

# 15. Communication Policy

## FR-012 — Contact Controls

Messaging behavior shall be:

- consent-aware,
- time-window-aware,
- opt-out-aware,
- merchant-configurable,
- auditable.

The architecture must support:

- transactional vs promotional classification,
- contact-window validation,
- consent validity,
- immediate opt-out handling,
- per-episode message limits.

Exact regulatory figures shall only be surfaced in public-facing materials after verification against current official rules.

---

# 16. Executor

## FR-013 — Razorpay Execution

Initial supported action:

**Payment Link creation/execution in Razorpay test/sandbox mode.**

The executor shall:

1. Receive an approved action.
2. Validate action IDempotency.
3. Call the appropriate Razorpay API.
4. Store the external request/result ID.
5. Update action status.
6. Emit an outcome event.

No execution shall occur without an approved policy decision.

---

# 17. Outcome Observer

## FR-014 — Outcome Tracking

Each action must transition through explicit states.

Example:

```text
PROPOSED
  ↓
POLICY_APPROVED
  ↓
EXECUTING
  ↓
EXECUTED
  ↓
PENDING
  ↓
RECOVERED / FAILED / EXPIRED
```

The observer shall map outcomes back to the originating recovery episode.

---

# 18. Audit Trail

## FR-015 — Append-Only Audit Log

Every decision must create an immutable record.

Minimum fields:

```json
{
  "event_id": "evt_...",
  "customer_id": "cust_...",
  "transaction_id": "pay_...",
  "timestamp": "2026-08-21T10:14:03Z",
  "signal": "payment.failed",
  "payment_method": "upi",
  "diagnosis": "insufficient_balance",
  "diagnosis_confidence": 0.87,
  "p_recovery_with_action": 0.71,
  "p_recovery_baseline": 0.42,
  "expected_incremental_recovery_inr": 2436,
  "proposed_action": "reminder",
  "policy_check": {
    "consent_valid": true,
    "within_contact_window": true,
    "attempts_remaining": 2,
    "result": "approved"
  },
  "action_taken": "reminder",
  "executed_via": "razorpay_payment_link_api",
  "outcome": "pending",
  "escalated": false
}
```

Audit records must never be silently overwritten.

---

# 19. Revenue Ledger

## FR-016 — Revenue Accounting

The ledger shall track:

- revenue at risk,
- native baseline recovered revenue,
- RecoverOS recovered revenue,
- incremental recovered revenue,
- intervention cost,
- wasted interventions,
- recovery rate,
- intervention count.

### Primary metric

```text
Incremental Revenue Recovered
=
RecoverOS recovered revenue
-
native baseline recovered revenue
```

---

# 20. Simulator

## FR-017 — Synthetic Recovery Simulator

The project must include a simulator for batch evaluation.

### Initial scale

Approximately 50,000 synthetic payment events.

### Features

```text
customer_id
transaction_id
amount
payment_method
failure_reason
failure_source
subscription_age
successful_payment_count
failed_payment_count
previous_recovery_rate
days_since_last_success
customer_value
time_of_failure
checkout_events
```

### Hidden Ground Truth

The simulator shall generate:

```text
customer state
↓
hidden latent recovery probability
↓
intervention
↓
actual outcome
```

RecoverOS must never see the hidden probability.

### Anti-Circularity Requirement

The model's predicted probability cannot be used to generate the ground-truth outcome.

---

# 21. Benchmark

## FR-018 — Three-Arm Evaluation

All strategies must run against the same generated world.

### Baseline

Retry every eligible failure once.

### Rules-Based

Retry only failures matching simple heuristics.

### RecoverOS

Diagnosis + probability estimates + EIR + policy-bounded actions.

### Evaluation Metrics

- revenue at risk,
- gross recovered revenue,
- incremental recovered revenue,
- recovery rate,
- interventions taken,
- wasted interventions,
- average EIR,
- prediction calibration,
- policy rejection rate,
- escalation rate.

### Multiple Seeds

Run the benchmark over multiple random seeds, initially 20.

Report mean and spread for major business metrics.

Example:

```text
RecoverOS incremental recovery:
₹4.8L ± ₹0.4L
```

Numbers shown in the UI/pitch must be generated by the actual simulator and never hardcoded.

---

# 22. Calibration

## FR-019 — Probability Calibration

Evaluate whether predicted recovery probabilities correspond to observed simulator outcomes.

For example:

```text
Predicted bucket: 0.90–0.95
Observed recovery: approximately 0.90–0.95
```

The dashboard may visualize a calibration curve for technical reviewers.

---

# 23. Dashboard

## FR-020 — Merchant Dashboard

The dashboard shall prioritize business impact.

### KPI cards

```text
Revenue at Risk
Native Recovery
RecoverOS Recovery
Incremental Recovery
Interventions
Recovery Rate
```

### Recovery Queue

Columns:

- customer,
- amount,
- diagnosis,
- EIR,
- recommended action,
- status.

### Why Panel

Clicking a row shows:

- known signals,
- inferred diagnosis,
- confidence,
- P(recovery | RecoverOS),
- P(recovery | native),
- EIR,
- proposed action,
- policy result,
- execution,
- outcome.

### Audit View

Full immutable event timeline.

### Benchmark View

Baseline vs Rules vs RecoverOS.

---

# 24. Secondary Vertical

The architecture shall be reusable for invoice receivables, but this is not part of the core build.

Architecture proof:

```text
Recovery Engine
   ├── Subscription payments
   └── Invoice receivables
```

Only the edge adapters and action vocabulary should differ.

A working second vertical is stretch-only.

---

# 25. Technical Stack

Recommended stack:

### Frontend
- Next.js
- React
- TypeScript
- Tailwind CSS

### Backend
- Node.js / TypeScript
- REST APIs
- Webhook service
- Worker/job processing

### Scoring/Simulation
- Python
- FastAPI or standalone service
- scikit-learn for initial ML model if required

### Database
- PostgreSQL

### Queue
- Redis/BullMQ if asynchronous orchestration is needed

### AI
- LLM API for ambiguous diagnosis, action proposal, message drafting, explanation

### Payment
- Razorpay test/sandbox APIs

### Observability
- structured application logs
- audit events
- optional OpenTelemetry/Sentry

---

# 26. Non-Functional Requirements

## NFR-001 Reliability
Webhook processing must be idempotent.

## NFR-002 Safety
No action can bypass the policy engine.

## NFR-003 Explainability
Every executed or rejected decision must be explainable from stored evidence.

## NFR-004 Auditability
Audit events are append-only.

## NFR-005 Reproducibility
Simulator results must be reproducible using fixed seeds.

## NFR-006 Isolation
Production-like credentials must never be exposed to the LLM.

## NFR-007 Observability
Every agent run must have a traceable request/episode ID.

## NFR-008 Testability
Policy rules and EIR calculations must have unit tests.

---

# 27. Security Requirements

- Razorpay credentials live only in the executor service.
- Secrets are stored in environment variables/secrets manager.
- The LLM receives only the minimum data necessary.
- Customer PII should be minimized in prompts.
- Logs should avoid storing unnecessary sensitive information.
- Webhook authenticity must be validated.
- All executor operations must be idempotent.
- Policy decisions must be persisted before execution.
- API actions should support replay protection.

---

# 28. Core User Stories

## Merchant

As a merchant, I want to know how much recurring revenue is at risk.

As a merchant, I want RecoverOS to prioritize which failures are worth intervention.

As a merchant, I want the agent to avoid unnecessary customer contact.

As a merchant, I want to understand why an action happened.

As a merchant, I want to see incremental recovery compared with native recovery.

As a merchant, I want to configure intervention thresholds and limits.

## Human Operator

As an operator, I want low-confidence cases escalated to me.

As an operator, I want complete context for every escalation.

As an operator, I want to override eligible actions through the policy layer.

---

# 29. Demo Acceptance Criteria

A successful demo must demonstrate:

1. A webhook/event arrives.
2. Customer history is loaded.
3. Root cause is diagnosed.
4. P(recovery | RecoverOS) is estimated.
5. P(recovery | native) is estimated.
6. EIR is calculated.
7. LLM proposes an allowed action.
8. Policy Engine approves/rejects it.
9. Executor performs the approved action in Razorpay test mode.
10. Outcome is observed.
11. Audit event is created.
12. Dashboard updates.
13. A `WAIT` example is shown.
14. A `STOP` example is shown.
15. Batch benchmark shows incremental revenue.
16. Benchmark uses hidden ground truth and multiple seeds.

---

# 30. Final Product Principle

> **ML predicts. LLM reasons. Policy controls. Executor acts. Audit proves. Measurement decides whether RecoverOS actually helped.**
