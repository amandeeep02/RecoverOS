# RecoverOS

**The intelligence layer for failed recurring payments.**

RecoverOS decides whether an intervention can recover more revenue than Razorpay's native recovery behaviour, then makes that decision bounded, explainable, and auditable.

It implements the complete loop from the product specification:

```text
Razorpay webhook → normalize → diagnose → score → EIR → propose
                 → deterministic policy → executor → outcome → audit → ledger/benchmark
```

## Run it

```bash
npm install
npm run dev
```

Open `http://localhost:3000` for the merchant dashboard. It contains real demo episode outputs (including WAIT, STOP, PAYMENT_LINK, and ESCALATE) and a generated five-seed benchmark—not static KPI values.

```bash
npm test
npm run build
npm run benchmark
```

`npm run benchmark` evaluates 20 deterministic seeds with 50,000 events per seed and writes `data/generated/benchmark.json`. Use smaller values for a quick local run:

```bash
EVENTS_PER_SEED=1000 SEED_COUNT=5 npm run benchmark
```

## Architecture

| Layer | Responsibility | Cannot do |
| --- | --- | --- |
| `lib/diagnosis.ts`, `lib/scoring.ts`, `lib/proposal.ts` | Interpret structured signals, calculate probabilities/EIR, validate optional LLM proposals | Read payment credentials or execute actions |
| `lib/policy.ts` | Deterministic merchant constraints, cap enforcement, STOP/WAIT/escalation decisions | Call Razorpay or accept arbitrary actions |
| `lib/razorpay.ts` | Idempotent payment-link execution boundary | Change policy or make a diagnosis |
| `lib/pipeline.ts` | Orchestrate state transitions, outcomes, audit events | Bypass the policy result |
| `lib/simulator.ts` | Produce deterministic hidden-truth worlds and evaluate strategies | Expose latent probabilities to a strategy |

The initial persistence adapter is an in-memory, append-only development store. Its interface is deliberately small so a PostgreSQL adapter can replace it without changing the policy or pipeline contracts.

## Razorpay test mode

Copy `.env.example` to `.env.local` and set test-mode Razorpay credentials:

```text
RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...
```

`POST /api/webhooks/razorpay` reads the raw request body, verifies `x-razorpay-signature` whenever a webhook secret is configured, normalizes supported events, and processes each original event ID exactly once. With no test credentials, the executor returns an explicitly labelled `SIMULATED` result; it never implies a live Razorpay call.

Supported API surfaces:

- `POST /api/webhooks/razorpay`
- `GET /api/episodes`
- `GET /api/episodes/:id`
- `POST /api/episodes/:id/outcome` with `RECOVERED`, `FAILED`, or `EXPIRED`
- `GET /api/benchmark?count=1000&seeds=5`

## Safety and measurement

- Six actions only: `WAIT`, `PAYMENT_LINK`, `REMINDER`, `ESCALATE`, `STOP`, `RETRY`.
- EIR is `(P(action) - P(native)) × amount - intervention cost`.
- Native card recovery means `WAIT` is enforced before a customer intervention.
- There are at most three automated attempts per episode; over-cap and low-confidence cases escalate.
- Invalid/malformed LLM-shaped actions cannot reach the executor.
- Audit events are appended on every transition and cannot be silently overwritten.
- Baseline, rules, and RecoverOS evaluate the same private counterfactual world. The simulated ground-truth generator does not use predicted probabilities.

For production, replace the development store with PostgreSQL, place executor credentials in a secret manager, use a durable queue for webhook work, and configure Razorpay test-mode webhooks before enabling real test calls.
