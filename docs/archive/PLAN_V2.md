> **SUPERSEDED — historical planning document, not the plan of record.**
> The current plan is `IDEA.md`; the only trustworthy numbers are in `RESULTS.md`.
> Constants and file paths below describe an earlier design and are known to be stale.

# RecoverOS — Build Plan v2

**Razorpay AI Buildathon · Track 03: AI Revenue Recovery**

---

## 0. Thesis

> Every revenue recovery product reports **money recovered**. That number is dishonest — most of it was coming back anyway. RecoverOS reports **money that would not have arrived otherwise**, and can prove the difference.

Three consequences fall out of that one sentence, and they define the whole build:

1. We measure **incremental** recovery, not attributed recovery, and we hold back a permanent randomized control arm to keep ourselves honest.
2. The agent's most valuable behavior is often **not acting** — when the issuer is down, when the customer is dormant, when expected value is negative.
3. Because every decision is deterministic and logged, any policy change can be **replayed against history** before it touches a customer.

Everything below serves those three claims. Anything that doesn't is cut.

---

## 1. The Bar We're Being Judged Against

Track 3's stated bar:

> *"Don't just identify the problem. Show measured money recovered across a batch, with compliant escalation, stopping rules, and an audit trail."*

| Bar clause | Status today | Plan |
|---|---|---|
| Detects revenue at risk | ✅ Webhook ingestion + normalizer | Keep |
| Determines right intervention | ✅ Diagnosis → EIR → bounded proposal | Extend EIR (§4.3) |
| Bounded workflow | ✅ 7-action set, state machine, policy caps | Add `HELD_OUT`, `SUPPRESSED`, `HELD_DEGRADED` |
| Compliant escalation | ✅ Consent, contact window, ESCALATE | Keep |
| Stopping rules | ⚠️ Implemented but invisible | Make restraint a first-class UI surface (§4.2, §4.3) |
| Audit trail | ✅ Audit event at every stage | Add policy version stamp for replay |
| **Measured money recovered across a batch** | ❌ **5 hardcoded demo cases** | **§4.0 + §4.1 — the centerpiece** |

The last row is the entire gap. It gets built first and it gets the most attention.

---

## 2. What Already Exists (Retained)

| Layer | File | Status |
|---|---|---|
| Domain/Contracts (Zod) | `lib/domain.ts` | ✅ |
| Webhook ingestion + normalizer | `lib/normalizer.ts`, `app/api/webhooks/razorpay/route.ts` | ✅ |
| Diagnosis engine | `lib/diagnosis.ts` | ✅ |
| Scoring / EIR | `lib/scoring.ts` | ✅ Extended in §4.3 |
| Action proposal | `lib/proposal.ts` | ✅ |
| Policy engine | `lib/policy.ts` | ✅ Extended in §4.1, §4.2 |
| State machine | `lib/state-machine.ts` | ✅ New states added |
| Razorpay executor (test mode) | `lib/razorpay.ts` | ✅ |
| Voice executor (ElevenLabs Hinglish) | `lib/voice.ts` | ✅ |
| Pipeline orchestrator | `lib/pipeline.ts` | ✅ |
| Simulator (50K events, hidden ground truth) | `lib/simulator.ts` | ✅ Upgraded in §4.0 |
| Dashboard | `components/recovery-dashboard.tsx` | ✅ Rebuilt around new ledgers |
| Tests | `tests/recovery-engine.test.ts` | ✅ 11 passing, more added |

**Action set:** `WAIT | PAYMENT_LINK | REMINDER | ESCALATE | STOP | RETRY | VOICE_CALL`

The existing EIR formula is the strongest asset in the codebase and the seed of the whole thesis:

```
EIR = (p_action − p_native) × amount − cost
```

`p_native` is the counterfactual. Most submissions will model `p_recovery`. We model a **difference**. v2 makes that difference the product.

---

## 3. Explicit Non-Goals

Cut from the previous plan. None of these are scored, and each costs days that belong to §4.

| Cut | Why |
|---|---|
| NextAuth / merchant login | Single hardcoded merchant. Nobody scores a login page. |
| Razorpay OAuth connect flow | Test-mode API keys in `.env` are sufficient proof. |
| Multi-tenancy | Zero demo value. |
| BullMQ + Redis + dead-letter queue | Synchronous processing handles demo scale. Queue depth is not a judged property. |
| Full settings CRUD UI | Replaced by the Replay Console (§4.4), which is strictly more interesting. |
| Twilio real voice calls | ElevenLabs + browser simulator already demonstrates Hinglish voice recovery. Real telephony adds cost and fragility, not score. *(Stretch only.)* |
| Webhook health monitor | Ops feature, invisible in a 5-min video. |
| Load test / 1000 concurrent episodes | Batch throughput is proven by the eval harness instead. |

**Persistence is kept, but minimal:** SQLite (or one Postgres instance) so state survives restart. No migrations ceremony, no Prisma-vs-Drizzle debate. One day of work, then move on.

---

## 4. What We're Building

### R0 — Evaluation Harness *(the deliverable, not a support artifact)*

**Files:** `lib/eval/harness.ts`, `lib/eval/estimators.ts`, `scripts/eval.ts`, `RESULTS.md`

One command produces the number the whole submission rests on:

```bash
npm run eval -- --episodes 50000 --seeds 20
```

Output table, committed to the repo:

| Arm | Recovered ₹ | Interventions | Cost ₹ | Net ₹ | vs Baseline |
|---|---|---|---|---|---|
| Baseline (native retry only) | … | 0 | 0 | … | — |
| Static rules (contact everyone) | … | … | … | … | … |
| **RecoverOS** | … | … | … | … | **…** |

Requirements:

- **≥ 20 seeds**, report mean ± 95% CI. Point estimates from one seed are worthless and judges know it.
- **Net of intervention cost.** Gross recovery without cost is a vanity metric.
- **Reproducible.** Fixed seed → byte-identical output. Already true of the engine; assert it in a test.

#### Simulator honesty upgrade

This is where a sharp judge attacks, so pre-empt it.

1. **Document the generative model explicitly** in `SIMULATOR.md`: how a failure code maps to true recoverability, how contact response rates are drawn, what intervention costs are assumed, what the dormancy distribution looks like.
2. **Sensitivity sweep** (`npm run eval:sweep`): vary each assumption across a grid; report where RecoverOS wins and, critically, **where it stops winning**.
3. **Publish the losing region.** A submission that names the parameter regime in which its own product isn't worth running reads as far more credible than one that only reports the favorable seed.

> **Deliverable:** `RESULTS.md` with the batch table, the sweep heatmap, and a plainly stated "here is where we lose" paragraph.

---

### R1 — The Holdout Ledger *(the thesis, made falsifiable)*

**Files:** `lib/experiment.ts`, `lib/eval/estimators.ts`, dashboard ledger panel

A **permanent, structural, always-on randomized control arm.** Not an experiment run once — a property of the policy engine.

**Assignment.** At `POLICY_CHECK`, *after* an episode is judged eligible for action but *before* execution:

```ts
const arm = hash(episodeId + EXPERIMENT_SALT) % 100 < holdoutPct
  ? 'HOLDOUT' : 'TREATMENT';
```

Deterministic, so replay and reproducibility survive. Recorded on the `PolicyDecision` and stamped into the audit trail.

**Critical detail — randomize only the eligible.** An episode that would have received `WAIT`/`STOP` anyway must never enter the randomization, or the control arm gets diluted with cases where treatment was never going to happen and the measured lift collapses toward zero. Eligibility gate first, coin flip second.

**New terminal-ish state:** `HELD_OUT`, distinct from `WAIT` and `STOP` so that deliberate non-action for measurement never pollutes the stopping-rule statistics.

**Estimator** (`lib/eval/estimators.ts`):

- Incremental ₹ = (recovery rate_treatment − recovery rate_holdout) × mean amount × n_treatment
- Bootstrap 95% CI over episodes (10k resamples)
- Report n per arm alongside every number — an interval without a sample size is decoration

**Policy guard:** cap holdout on very-high-value episodes (`amount > escalationThreshold`). Deliberately withholding recovery on a ₹2L failure to improve a statistic is not a trade a real merchant would accept, and saying so out loud demonstrates judgment.

**Self-validation — this is the part that makes it bulletproof.** The simulator *plants* the true incremental value, so ground truth is known. Add a test asserting the estimator's CI covers the planted truth across ≥20 seeds. That converts the simulator from a liability ("it's all synthetic") into the instrument that proves the measurement works.

**Dashboard headline becomes:**

```
₹4,21,300 recovered · ₹1,62,800 incremental
holdout n=312 · 95% CI [₹1,31,400 – ₹1,89,200]
```

**Implied business model, stated in one line in the pitch:** performance pricing on incremental revenue only. *We don't bill for gravity.*

---

### R2 — Issuer Weather *(restraint as the headline capability)*

**Files:** `lib/degradation.ts`, `lib/policy.ts` (new gate), degradation banner component

Track 3's first example direction is *"payment degradation → root cause → recovery action."* Nearly everyone will read "root cause" as customer-side — insufficient funds, expired card, failed OTP. That's the obvious half.

The non-obvious half: **a large share of failures are not the customer's fault at all.** Issuer downtime, bank-side declines, UPI app degradation. And when that's the cause, **every intervention is destructive**: you burn a retry against a cap, you SMS a customer to blame them for a failure their bank caused, you call them at 9pm about a card that is fine.

**Detector.**

- Rolling counters keyed on `(method, issuer/bank, network)`
- 15-minute tumbling windows against an EWMA 24h baseline
- Fire when `rate > k × baseline` **AND** `attempts ≥ minVolume` — the volume gate prevents small-sample false alarms, which is the failure mode that would make this feature worse than useless
- Open a `DegradationWindow` record; close after M consecutive windows back below threshold

**Policy gate.** While a window is open, every matching episode routes to `HELD_DEGRADED`: no contact, no retry burn, requeue on close. Drain with jitter to avoid a thundering herd against a bank that just came back up.

**Relationship to EIR.** For issuer-side failures `p_native` is genuinely high, so EIR is already low — but that's a *per-episode* inference from a single failure code. The detector is **cross-episode**, catching the pattern that no single episode reveals.

**The honest caveat, and the insight worth stating out loud:** a single small merchant may not have the volume to detect issuer degradation reliably. Cross-merchant aggregation does — which is precisely Razorpay's structural advantage. Say this in the pitch. It reframes the feature as something the judges' own platform is uniquely positioned to run.

**Demo surface:**

```
⚠ ISSUER DEGRADATION — HDFC Cards, 4.2× baseline
47 episodes held · 0 customers contacted
```

…then on recovery: **41 of 47 recovered · 0 interventions spent.**

---

### R3 — Sleeping Dogs *(negative-EIR suppression)*

**Files:** `lib/scoring.ts` (churn term), `lib/domain.ts` (new fields), Protected ledger panel

From uplift modelling: intervening splits customers into persuadables, sure things, lost causes, and **sleeping dogs** — where contact makes the outcome *worse*.

Revenue recovery's vicious sleeping-dog case: **the forgotten subscription.** A ₹499/month service the customer hasn't opened in five months fails on a dead card. You send a polite recovery SMS. You have just reminded them they're paying for it. They cancel. Your "recovery attempt" destroyed ₹5,988 of remaining LTV to chase ₹499.

**Extended EIR:**

```
EIR = (p_action − p_native) × amount − cost − Δp_churn × residual_LTV
```

- `residual_LTV` = expected remaining billing periods × amount, derived from subscription age and dormancy
- `Δp_churn` = incremental cancellation probability *caused by the contact*, keyed on dormancy signal

This produces **genuinely negative EIR**, not merely sub-threshold — a different thing, and it deserves its own state: `SUPPRESSED`.

```
SUPPRESSED — dormancy churn risk
LTV at risk ₹5,988 > amount ₹499
```

**Second dashboard ledger: "Revenue Protected By Not Acting."** Judges will read that panel twice.

**Honest caveat:** `Δp_churn` is the least empirically grounded parameter in the system. It goes in the sensitivity sweep, it gets flagged in `RESULTS.md`, and — the satisfying part — **it is exactly the quantity the holdout arm would eventually measure for real.** The mechanics compose.

---

### R4 — Persistence *(minimal)*

**Files:** `lib/db-store.ts`, `schema.sql`

Swap the in-memory `Map` for SQLite behind the existing `RecoveryStore` interface. State survives restart. One day. New tables: `experiment_assignment`, `degradation_window`, `policy_version`.

---

### R5 — Real-Time Dashboard

**Files:** `lib/realtime.ts`, `app/api/stream/route.ts`, `hooks/useEpisodes.ts`

SSE, one-way, no Socket.io. Highest demo-value-per-hour item in the build: it's the difference between a video showing a table and a video showing an agent working.

Live status progression: `DETECTED → DIAGNOSED → SCORED → PROPOSED → POLICY_CHECK → EXECUTING → PENDING/PROMISED → RECOVERED`, plus the restraint states `HELD_OUT`, `HELD_DEGRADED`, `SUPPRESSED` rendered distinctly.

---

### R6 — Replay Console *(replaces the settings page)*

**Files:** `lib/replay.ts`, `app/replay/page.tsx`

Policy changes are normally shipped and evaluated a quarter later. Ours are evaluated **before** they ship.

Drag a threshold → replay the full historical batch → see the money delta:

```
EIR threshold ₹50 → ₹200 · replay 50,000 episodes
−₹31,400 recovered · −1,847 interventions
+₹18,200 protected · net +₹6,100
```

**Preconditions (already nearly satisfied):** deterministic diagnosis/scoring/proposal/policy layers, immutable event log, policy version stamped on every decision.

**The honesty requirement.** For the arm actually taken, we have the *observed* outcome. For the counterfactual arm, we have a *model*. Say so in the UI with a footnote, not a disclaimer buried in a README. And note the payoff: **the holdout arm supplies real counterfactual data that calibrates the replay model.** R1 makes R6 credible. That composition is worth a sentence in the pitch.

---

### R7 — One Real Test-Mode Episode

**Files:** `scripts/tunnel.ts`, demo runbook

One live, un-simulated end-to-end run: real webhook via ngrok → diagnosis → EIR → proposal → real Razorpay Payment Link → real recovery → full audit trail, with the Razorpay dashboard visible alongside.

Build this **early**, not last. It de-risks the entire submission by killing the "it's all synthetic" objection before it can follow you into the panel.

---

## 5. Schema Additions

```sql
-- Experiment arm assignment
CREATE TABLE experiment_assignment (
  episode_id      TEXT PRIMARY KEY,
  arm             TEXT NOT NULL,        -- TREATMENT | HOLDOUT
  eligible        BOOLEAN NOT NULL,     -- was it action-eligible pre-flip?
  holdout_pct     REAL NOT NULL,
  salt_version     TEXT NOT NULL,
  assigned_at     TIMESTAMP NOT NULL
);

-- Issuer degradation windows
CREATE TABLE degradation_window (
  id              TEXT PRIMARY KEY,
  method          TEXT NOT NULL,
  issuer          TEXT,
  network         TEXT,
  baseline_rate   REAL NOT NULL,
  observed_rate   REAL NOT NULL,
  ratio           REAL NOT NULL,
  attempts        INTEGER NOT NULL,
  opened_at       TIMESTAMP NOT NULL,
  closed_at       TIMESTAMP,
  episodes_held   INTEGER DEFAULT 0
);

-- Policy versioning for replay
CREATE TABLE policy_version (
  id              TEXT PRIMARY KEY,
  config          JSON NOT NULL,
  created_at      TIMESTAMP NOT NULL
);
```

**New episode states:** `HELD_OUT`, `HELD_DEGRADED`, `SUPPRESSED`
**New audit stages:** `EXPERIMENT_ASSIGNED`, `DEGRADATION_HELD`, `SUPPRESSED`
**New `PolicyDecision` fields:** `arm`, `policyVersionId`, `suppressionReason`, `degradationWindowId`

---

## 6. Build Order

```
R0  Eval harness + batch metrics + sensitivity sweep   ← start here
R7  Real test-mode episode (ngrok)                     ← de-risk early
R1  Holdout ledger + estimator + self-validation test
R4  Persistence (SQLite)
R2  Issuer weather detector + policy gate
R3  Dormancy suppression + Protected ledger
R5  SSE real-time dashboard
R6  Replay console
    Demo recording + README + architecture diagram
```

R0 first because every later claim is expressed in its units. R7 second because it's cheap and removes the largest single objection.

---

## 7. Demo Flow (5:00)

| Time | Beat | On screen | The line you say |
|---|---|---|---|
| 0:00–0:25 | **The lie** | Dashboard populated, headline number cuts in half | "Every recovery product reports money recovered. That number is dishonest — most of it was coming back anyway." |
| 0:25–1:10 | **Holdout ledger** | Ledger panel, CI, one held-out episode's audit trail, then ground-truth validation | "Five percent are randomized into a permanent control arm. Structural, in the policy engine. That's why we can put an interval on our own value." |
| 1:10–2:10 | **Issuer weather** | Failures stream, risk climbs, agent does *nothing*, banner fires, outage clears, 41/47 recover | "We assumed the agent's job was to act well. It isn't. It's to know when acting is negative." |
| 2:10–3:00 | **Real episode** | Live test-mode webhook → payment link → recovery, Razorpay dashboard alongside | "Everything so far was batch scale. This is one real episode, live, on test-mode APIs." |
| 3:00–3:50 | **Replay** | Threshold drag → 50K episodes replay → money delta | "Policy changes are normally shipped and evaluated a quarter later. Ours are evaluated before they ship." |
| 3:50–4:30 | **Numbers + honesty** | Batch table, then the sweep's losing region | "And here's where we stop winning." |
| 4:30–5:00 | **Architecture + close** | One diagram, 10 seconds | "Seven actions, every one gated, every decision logged and replayable. We don't get paid for money that was coming back anyway." |

**Production notes**

- **Open on the subversion, not the architecture.** Make the judge doubt something they believe in the first 20 seconds.
- **Never narrate what's visibly happening.** The screen carries the demo; you carry the reframe.
- **Rehearse against a frozen seed.** The engine is deterministic — use that. No live API roulette except in the R7 beat, where realness is the point.
- **Time-compress the outage and label it on screen** (`sim clock 60×`). An undisclosed speed-up looks like cheating if spotted.
- **Seed realistic merchant history.** Indian names, plausible amounts, real subscription ages. No "Customer 1, ₹500."
- **1080p minimum, large fonts.** A metrics-led pitch dies if the numbers are unreadable on a laptop.
- **Five full rehearsals.** Running long and rushing the close is the most common pitch-video failure. If you must cut: the batch table and architecture can shrink; the holdout and issuer-weather beats cannot.

---

## 8. Repo README Structure

The video sells the reframe; the repo has to survive scrutiny. A judge who watches the video and then finds a README that reproduces every number in it is a judge who calls you in.

```
1. The one-line thesis
2. Headline: ₹X incremental (not ₹Y recovered), with CI and n
3. One command to reproduce it
4. Batch results table — 3 arms, 20 seeds, net of cost
5. How the holdout works + estimator validation against planted truth
6. Simulator generative assumptions, stated plainly
7. Sensitivity sweep — including where we lose
8. Issuer weather: detector spec + the cross-merchant caveat
9. Sleeping dogs: extended EIR + the Δp_churn caveat
10. Architecture diagram: bounded actions, policy gates, state machine, audit
11. Real test-mode episode walkthrough
12. Test suite: what's asserted and why
```

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| Judge dismisses simulator as self-serving | Estimator validated against planted ground truth; assumptions published; sweep includes losing region |
| Holdout dilutes lift and the number looks weak | Randomize only action-eligible episodes; report n per arm |
| Degradation detector false-alarms on low volume | Minimum-attempts gate; caveat stated openly as the cross-merchant insight |
| `Δp_churn` looks invented | Flagged as least-grounded parameter; in sweep; named as what holdout would measure |
| Replay counterfactuals look like fabrication | Footnoted in-UI; holdout data calibrates the model |
| Video runs long | Fixed beat sheet; batch table and architecture are the compressible beats |

---

## 10. One-Line Positioning

**RecoverOS is a revenue recovery agent that measures its own value honestly, refuses to act when acting destroys money, and can prove what a policy change would have done before it ships.**