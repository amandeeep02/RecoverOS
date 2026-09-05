# Demo runbook

Every command and figure below was executed against this tree, not written from memory.
If a number here disagrees with `RESULTS.md`, `RESULTS.md` is right and this file is stale.

---

## The fallback is the architecture, not a recording

**Verified on this tree.** Every external call in the repository is credential-gated, so
stripping the credentials removes the network from the demo without removing the demo:

```bash
RAZORPAY_KEY_ID= RAZORPAY_KEY_SECRET= GROQ_API_KEY= TWILIO_ACCOUNT_SID= ELEVENLABS_API_KEY= \
  npx next dev -p 3111
```

What was measured under exactly that command:

| Step | Result |
|---|---|
| `GET /api/health` | `{"status":"ok"}` |
| `GET /` | renders, both refusal cards present |
| `POST /api/demo/webhook` | `202`, `"signature":"verified"` |
| Episode decision | `APPROVE → PAYMENT_LINK` |
| Execution | `SIMULATED` · `simulated_executor` |

The signature check, normalizer, diagnosis, scorer, policy gate, compliance gate and audit
trail all run. Only the final API call is replaced — and it **labels itself**
`SIMULATED` / `simulated_executor` rather than pretending, so nothing on screen is a claim
the offline run cannot support. `npm test` and `npm run eval` never touch the network at
all: no key, no fixture, no recorded response.

**If the venue network dies, unset the keys and keep going.** The only thing lost is the
live `plink_…` reference. A previously-created real one is still in the store next to the
simulated one, which is itself the better slide: same code path, two executors, honestly
labelled.

**Residual risk this does not cover:** the laptop failing to run Node at all. That is what
a recording is for, and it is the only thing a recording is for.

---

## The walk (about four minutes)

### 1. The number, and the number under it — `/`

Lead with what is being claimed and what it is measured against.

> "Gross recovered is the category's number and most of it was already coming. Ours is
> measured against a randomized holdout — 5% of eligible episodes, randomized per
> **customer**, because contact fatigue is per customer and randomizing per episode would
> put the randomization unit and the interference unit in different places."

### 2. The two refusals — the strongest thing on screen

Side by side, both priced, and they are different claims:

- **Revenue protected by not acting** — the scorer's judgement, booked on both sides:
  protected *and* the recovery given up to get it. It could be wrong, and it is labelled
  as a judgement.
- **Refused by the regulator** — not a judgement at all. It cites a code
  (`TRAI_QUIET_HOURS`), names the regulation, and prices the face value at stake.

> "Nobody else will show you a recovery agent declining to act. We show it declining for
> two different reasons, and we price both."

Say the honest thing about the regulatory figure before anyone asks: it is **face value,
not revenue lost**. The gate runs per decision, so an episode refused at 22:00 is eligible
at 09:00. Overstating the cost of compliance is the same error as ignoring the gate.

Click **Inspect a refused episode →**. The panel shows the citation verbatim, the EIR
arithmetic, and the append-only audit trail.

### 3. The live loop — **Fire a real webhook**

Signed with the real secret, POSTed to the real `/api/webhooks/razorpay`, `202` in
milliseconds because diagnosis and execution run in a worker behind a durable claim —
Razorpay disables endpoints that miss the delivery deadline.

### 4. The measurement — `RESULTS.md`

| Claim | Figure |
|---|---|
| vs silent-retry Baseline | **+₹2,95,124**, 20/20 seeds |
| vs Rules | **+₹16,91,597**, 20/20 |
| vs Oracle (the ceiling) | **−₹7,73,598**, 0/20 |
| Cost of compliance | **₹1,09,483**/seed |
| Compliant arm vs Baseline | **+₹1,85,641**, 20/20 |

> "A perfect-information policy beats doing nothing by only 3.5%. That is the entire prize
> in this world once churn is priced. We take 28% of it, and we can name most of what we
> are missing."

### 5. Close on the finding, not the number

Four production defects, all the same shape — two components correct in isolation,
disagreeing at the seam, and a green suite blind to every one because the tests exercised
the components and never the join:

1. **Mandate retries.** The gate declared `channel: "sms"` for a silent retry but never
   populated the SMS payload, so DLT failed closed. Measured: 1,376 of 1,376 approved
   retries refused, for a template a silent retry would never use.
2. **Quiet-hours attribution.** TRAI's rule was recorded as
   `outside_merchant_contact_window` — a compliance log telling an auditor a statutory
   constraint was a merchant preference.
3. **DLT registry.** `defaultMerchantPolicy` declared a template id with no matching
   registry entry, so every SMS reminder was refused on a template the policy claimed was
   registered.
4. **Degradation release.** `resumeHeldEpisode` armed the gate with `nowIso` and passed no
   compliance context, so every field failed closed: an episode held through an issuer
   outage came back and was refused on `WA_OPT_IN_MISSING`. Nothing about the customer had
   changed, only the code path. The existing test asserted the released episode was no
   longer `HELD_DEGRADED` — which a `REJECT` also satisfies, which is why it stayed green.
   The context is now built by one function both call sites share.

> "Arming the compliance gate inside the measured run found four production bugs that a
> fully green compliance suite could not see. Every one lived in the seam between two
> components that were each correct on their own. That is the argument for the measurement
> discipline — better than any number in the report."

---

## Questions to expect

**"Delete the churn column."** Answer before it is asked — the report does.
Excluding churn, **Rules wins by ₹8,97,792** and this product has no reason to exist.
Pricing churn *is* the claim. The sweep says how much of it you have to grant: the win
crosses zero at **~1.74×** the modelled churn hazard, on held-out seeds 6–20.

**"Your world, your churn model."** Correct, and the sweep is the answer to how much
weight that assumption carries. Coverage against planted truth is 17/20 against a floor we
set at 18/20 — reported, not tuned.

**"What did the AI actually earn?"** Nothing measurable, and we say so. The LLM does
long-tail diagnosis and narration; `lib/eval/harness.ts` calls the synchronous
`diagnose()`, so no published figure reflects a model call. The win came from a
contact-fatigue term in a deterministic churn calculation.

**"Reproduce it."** `npm run verify` — tests, regenerates `RESULTS.md` via eval and sweep,
and fails if the committed report is not what the tree produces. Timestamp and commit
stamp are filtered; everything else must match byte for byte.

---

## Pre-flight

```bash
npm run verify        # must exit 0
npx next build        # must exit 0
```

Then open `/`, confirm both refusal cards render, and fire one webhook. If the regulatory
card is empty, the quiet-hours seed case did not load — it is pinned to 22:40 IST via
`decideAtIso` in `app/_lib/dashboard.ts` precisely so it does not depend on the hour you
present at.
