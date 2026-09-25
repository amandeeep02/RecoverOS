# RecoverOS

**Razorpay AI Buildathon · Track 3: AI Revenue Recovery**

[Live demo](https://recoveros-nine.vercel.app) · [Results](./RESULTS.md) · [Simulator](./SIMULATOR.md) · [Design](./IDEA.md) · [Deploy](./docs/DEPLOY.md)

Revenue recovery that measures its own value against a randomized control, and refuses
to act when acting destroys money.

```
  Silent retry         ₹3,05,06,605    the baseline: retries, contacts nobody
  RecoverOS            ₹3,07,93,186    +₹2,86,581  ·  20/20 worlds
  Compliance gate on   ₹3,06,95,408    +₹1,88,803  ·  20/20 worlds
  Perfect targeting    ₹3,16,32,098    +₹11,25,493 ·  the ceiling
```

<sub>Mean net ₹ per 50,000-episode world, after intervention cost and churn; 20 seeds.</sub>

**We beat a silent-retry baseline on all twenty worlds — and we capture 25% of what is
available.** A perfect-information policy takes ₹11.25L over that baseline; we take
₹2.87L of it, ₹1.89L with the compliance gate armed, and can name most of what we miss.

We know that because we built the yardstick before we built the policy, and it has been
wrong twice. It said the ceiling was 1.4% until a Razorpay engineer found our Oracle was
scored on a different objective than it was graded on; corrected, the ceiling is 3.69%.
And this result was **0/20** until late in the build — the sign flipped only when a
contact-fatigue term entered the churn model.

**The honest caveat, before you ask.** Most of that swing is a blunt rule, not clever
targeting. At the shipped fatigue rate the term stops discriminating and simply forbids a
second contact inside the window — graded targeting alone is worth ₹8.1L of the ₹10.9L
swing but only ties Baseline. We bought the win with restraint, not with precision, and
the remaining ₹7.73L to the Oracle needs a churn signal we do not currently measure.

Reproduce every number above: `npm i && npm run verify`
(tests, regenerates `RESULTS.md`, and fails if the committed report is not what this tree produces)

> Stated up front: the compliance gates now run **inside** the benchmark, as a fifth arm on
> the same worlds. They cost ₹97,778 per seed and the result survives them — but only the
> time-derived gates can bind, because the world plants no DLT/opt-in/e-mandate facts. The
> measured cost of compliance is a lower bound. Arming the gate for the first time also
> surfaced a product bug that had refused every silent mandate retry; see below.

---

## Run it

```bash
npm install
npm test          # 152 tests, no network, no API key required
npm run eval      # 50,000 episodes × 20 seeds → rewrites RESULTS.md
npm run verify    # tests + eval, fails if the committed RESULTS.md is stale (~5 min)
npm run dev       # http://localhost:3000
```

`RESULTS.md` is generated. Nothing in it is typed by hand. If a number here disagrees
with it, `RESULTS.md` is right and this file is stale.

| Page | What it shows |
|---|---|
| `/` | Live dashboard: episodes, the policy's reasoning, incremental ledger, regulatory refusals, degradation banner and kill switch, demo controls |
| `/checkout` | A real Razorpay test-mode checkout. A failed payment is signed as a `payment.failed` webhook and enters the same pipeline; with a phone on file it can escalate to a Twilio voice call |
| `/frontier` | The benchmark frontier: every arm against Baseline and Oracle |
| `/replay` | Re-score recorded episodes under alternative policy settings (EIR floor, churn weight) |
| `/classic` | The original single-screen dashboard, with the voice-call simulator |

**Configuration.** Every key is optional; copy `.env.example` to `.env.local` and fill what
you have. Without Razorpay keys the executor is an explicitly labelled simulated one;
without `DATABASE_URL` state is in memory; without `GROQ_API_KEY` the LLM slots fall back to
the deterministic path. The voice loop needs `TWILIO_*` and a public `PUBLIC_BASE_URL`
(e.g. an `ngrok http 3000` URL) for Twilio to post the answer back to; `ELEVENLABS_API_KEY`
switches the call audio voice. TRAI quiet hours (21:00–09:00 IST) refuse calls by design.

**Deploying.** `render.yaml` is a Render blueprint for a single long-running Node process,
which is what the in-process event stream wants; `vercel.json` pins the Vercel region
next to the Neon database, and the serverless paths drain work with `after()`. Details in
`docs/DEPLOY.md`. Razorpay test mode caps an account at 30 payment links for life; past
that, the executor degrades to the labelled simulated one rather than failing.

## What it does

- **Closes the loop.** Razorpay webhook → diagnose → score → policy → execute → `payment_link.paid` books the recovery. Real test-mode webhooks, HMAC-verified, idempotent. Failures arrive from subscriptions or from a live Checkout page.
- **Measures itself against a randomized holdout.** 5% of *eligible* episodes, randomized at the **customer** level, value-capped at ₹50,000.
- **Refuses to act when acting destroys value**, and books both sides of that bet.
- **Detects issuer degradation** and halts itself, rather than retrying into a dead issuer.
- **Compliance is code, not a slide** — 10 violation codes, 27 tests, enforced in the policy gate and in the executors.

## The thesis

Gross recovered is the category's number and it is mostly unearned. Incremental recovered —
measured against a control that was deliberately left alone — is the true one, and it is
much smaller. We report the smaller number.

## How it decides

Every failed payment is a decision problem. For each candidate action the scorer
(`lib/scoring.ts`) computes an expected incremental recovery:

```text
EIR(action) = (P(recover | action) − P(recover | do nothing)) × amount
            − intervention cost
            − churn cost        # contact actions on subscriptions only:
                                # dormancy + per-customer contact fatigue, × residual LTV
```

`WAIT` is in the candidate set at EIR 0, so "doing nothing beats every intervention" is an
ordinary outcome rather than a failure. The action set is closed: `WAIT`, `RETRY`,
`PAYMENT_LINK`, `REMINDER`, `VOICE_CALL`, `ESCALATE`, `STOP`, `HELD_OUT`, `HELD_DEGRADED`.
Anything below the minimum EIR floor (₹150 by default) is `SUPPRESSED` by the policy, and
both sides of that bet are booked: what the suppression protected and what it forwent.

**Holdout.** Of the episodes the policy *would* act on, 5% are randomized to do nothing,
by customer rather than by episode, because contact fatigue is per-customer and splitting
one customer across arms lets treatment leak into control. Episodes above ₹50,000 are
never held out; the experiment does not withhold large recoveries to measure them.

**Issuer degradation.** `lib/degradation.ts` watches failure rates per issuer. When one is
degrading, episodes move to `HELD_DEGRADED` instead of retrying into a dead issuer, and are
released when it recovers.

## What we measured, including where we lose

`npm run eval` — 50,000 episodes × 20 seeds, five arms on identical worlds, paired per seed.
The arm table and the method behind every interval are in `RESULTS.md`; this file does not
restate it. The holdout's incremental figure is reported there rather than here on
purpose — it measures lift on *treated* episodes only, its rate estimator covers planted
truth 17/20 against a floor we set at 18/20, and it did not pass through the compliance
gates. The Oracle gap survives all three qualifications; that number does not.

**We beat a silent-retry baseline by ₹2,86,581 on 20/20 worlds, and we capture 25% of what
a perfect-information policy would.** The remaining ₹8,38,912 to the Oracle is the roadmap,
and ₹65,314 of that gap opened when the world got a real long tail of failure codes — the
one slot in this system where a language model is the right tool and is not yet wired in.

Three findings we would rather not have published, all in the generated report:

- **We were 0/20 against that baseline until a contact-fatigue term landed.** Argmax over
  the action set — which we pre-registered as the fix — returned 0/20 and is recorded as a
  falsified hypothesis. The report explicitly refuses to credit it for the later win.
- **Most of the swing is a blunt rule, not targeting.** At the shipped fatigue rate the term
  stops discriminating and simply forbids a second contact in the window. Graded targeting
  alone only ties baseline.
- **Our own yardstick was wrong.** The Oracle was scored on a different objective than it
  optimised, understating the ceiling by 2.4×. A reviewer found it. Correcting it made our
  result look worse, not better.


## Architecture

```text
Razorpay webhook / Checkout failure
        │
   NORMALIZE     HMAC verify, idempotency key, rail-neutral event
        │
   DIAGNOSE      failure code → category + confidence   (LLM slot: long-tail codes)
        │
   SCORE         EIR for every candidate action, WAIT included
        │
   PROPOSE       best action, Zod-validated against the closed set
        │
╔═══════════════════════════════════════╗
║  POLICY  (trust edge)                 ║  deterministic
║  compliance · contact limits ·        ║  no model, no credentials
║  confidence · EIR floor ·             ║
║  issuer health · holdout assignment   ║
╚═══════════════════════════════════════╝
        │
   EXECUTE       Razorpay · WhatsApp · Twilio voice  (refuses unapproved actions)
        │
   OBSERVE       payment_link.paid / native recovery / churn
        │
   ATTRIBUTE     treatment vs holdout → incremental ₹
```

| Layer | May | May not |
|---|---|---|
| Reasoner (`diagnosis`, `scoring`, `proposal`) | read features, propose | execute, hold credentials |
| Policy (`policy`) | approve / reject / suppress / hold | call a model, be non-deterministic |
| Executor (`razorpay`, `voice`, `whatsapp`) | hold credentials, call APIs | decide |

An LLM that proposes `SEND_MONEY` produces a `REJECT`, not a transfer. There is a test.

**Where the LLM is** — long-tail failure-code diagnosis and cohort narration. Both are
language problems. Neither is in the path where money is decided. Prompt-injection input
is rejected before the model is called, so a hostile failure code is never sent and never
billed. With no `GROQ_API_KEY` the system falls back to the deterministic path and
every test still passes offline.

**Where things live**

| Path | Role |
|---|---|
| `lib/normalizer.ts`, `lib/pipeline.ts`, `lib/state-machine.ts` | webhook intake, the episode pipeline, legal state transitions |
| `lib/diagnosis.ts`, `lib/scoring.ts`, `lib/proposal.ts` | reasoner; `proposal.ts` is the untrusted-model-output boundary |
| `lib/policy.ts`, `lib/compliance.ts`, `lib/experiment.ts`, `lib/degradation.ts` | the trust edge: gates, holdout, issuer health |
| `lib/razorpay.ts`, `lib/whatsapp.ts`, `lib/voice.ts` | executors |
| `lib/llm.ts`, `lib/narration.ts` | the LLM slots (Groq), both optional |
| `lib/simulator.ts`, `lib/eval/`, `scripts/eval.ts` | the world, the harness and estimators, the report generator |
| `app/`, `components/` | Next.js 15 dashboard and API routes |

Stack: Next.js 15, React 19, TypeScript, Zod, Vitest, Postgres (Neon) or in-memory, Razorpay
test mode, Twilio + ElevenLabs voice, WhatsApp, Groq.

## Compliance

**The headline numbers now run through these gates**, as a fifth arm — `RecoverOS
(regulatory gate on)` — on identical worlds under identical draws, so the difference is
paired. It costs **₹97,778 per seed**, 95% CI [₹74,001, ₹1,21,555], and the compliant
arm still clears silent-retry Baseline by **₹1,88,803 on 20/20 seeds**. Money recovered
and compliant escalation are measured in the same run rather than in two runs that never
met.

**That measurement is a lower bound, and the reason is worth stating.** Only the
time-derived gates can bind: TRAI quiet hours are adjudicated from each episode's own
timestamp, which the world has always planted. DLT registration, WhatsApp opt-in, and the
RBI pre-debit/AFA facts are *granted* to the arm by the harness, because the simulator
plants no such facts and a fail-closed gate on absent metadata would refuse every contact
— measuring the simulator's silence rather than the regulation. Planting them is a world
change and is deliberately not folded in here.

**Arming the gate found a bug that no test caught.** For a silent mandate `RETRY`,
`lib/policy.ts` declared the channel as `sms` for the compliance check but never populated
the SMS payload, so the DLT check fell through to its absent-field branch and refused
*every* mandate retry for want of a template it would never have used — along with quiet
hours and DPDP contact gates applied to an action that contacts nobody. Measured on 4,000
episodes: 1,376 of 1,376 approved retries became `REJECT`. Twenty-seven compliance tests
passed throughout, because they exercised `lib/compliance.ts` directly and nothing armed
the gate through `lib/policy.ts`. Fixed, with three regression tests that fail against the
previous version. The defect was reachable only in production, which is the argument for
running the gate inside the benchmark rather than beside it.

Gates in `lib/compliance.ts`, enforced in `lib/policy.ts` and refused in the executors:
TRAI quiet hours and DLT template registration, DND with a transactional/promotional
split, WhatsApp 24-hour service window and opt-in, RBI e-mandate pre-debit notification
and AFA threshold, DPDP consent and audit-payload redaction. Thresholds live in config
with source comments — **verify current RBI/TRAI limits before quoting them publicly;
several have been revised.**

## Not built

`MIGRATE_MANDATE` (card mandate → UPI Autopay) is designed and not implemented. Estimator
coverage against its own estimand is 17/20, below the 18/20 floor we set — reported, not
tuned. `lib/normalizer.ts` accepts `payment.failed`, `subscription.pending` and
`subscription.halted` as failures (a failed Checkout payment arrives as `payment.failed`),
plus `payment_link.paid` as the outcome. Checkout abandonment without a payment attempt and
B2B receivables are not handled, and checkout failures are not in the benchmark's world.

**The LLM is not in the measured path, and the world now shows what that costs.**
`lib/eval/harness.ts` calls the synchronous `diagnose()`, so no figure in `RESULTS.md`
reflects a model call. The simulator carries a 54-string long tail (`LONG_TAIL_VOCABULARY`,
51.9% of it deliberately non-inferable — see `SIMULATOR.md` §1b) on which the deterministic
table returns `unknown` 100% of the time. Wiring the model onto that slice and measuring it
as a paired arm is the next piece of work and is specified, not done. We would rather ship
the measured gap than an unmeasured claim about closing it.

## Reproducibility

Seeds 1–20, FNV-1a assignment on `customerId` with salt `recoveros-v1`, 50,000 episodes
each. The world (`lib/simulator.ts`) imports **nothing** from the agent's decision stack —
verify with `grep -nE 'from "@/lib/(scoring|policy|diagnosis)"' lib/simulator.ts`. Its
generative forms deliberately differ from the scorer's: native recovery is a logit on the
raw failure code vs the agent's category table; churn is a logistic with per-customer
heterogeneity vs the agent's piecewise-linear population curve. Assumptions in
`SIMULATOR.md`, plan in `IDEA.md`.

## Principles

- **Measure causality, not activity.** A recovery is not an incremental recovery until a
  control says so.
- **Every action has a cost**, including the churn it causes. Doing nothing is a decision.
- **The model reasons; the policy decides; the executor acts.** Credentials never sit
  where a model can reach them.
- **The benchmark is part of the product.** If the yardstick is wrong, the result is wrong,
  and ours has been.
- **Ship the gap.** An unmeasured improvement is not reported as one.
