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

Then click **Customer pays the link**. The demo route reads the `plink_…` id the executor
actually recorded on that episode, builds a Razorpay-shaped `payment_link.paid` for it,
signs it with the same secret, and POSTs it to the same `/api/webhooks/razorpay`. The
episode goes `PENDING → RECOVERED`, the outcome is booked at face value, and the ledger
updates over the live stream. Click it again: `duplicate: true`, no second transition —
Razorpay redelivers, and the loop has to be idempotent on both halves.

> "The same endpoint opens the loop and closes it. A paid link settles only the episode
> that issued it — a signed event naming our episode but a link we never created is
> acknowledged and dropped, not acted on."

Verified on this tree: `payment.failed` → `202`, real `plink_` created → `payment_link.paid`
→ `200 RECOVERED` → redelivery `200 duplicate:true` → forged link id `200 ignored`.

### 3b. The phone beat — `/checkout`

A real Razorpay test-mode checkout on our own site. Enter the phone that should ring,
pay ₹4,999, and fail it on the mock bank page. Checkout's `payment.failed` is reported
to `/api/checkout/failed`, enriched from Razorpay's payment API (method, issuer,
network, E.164 contact), shaped and signed like the webhook Razorpay would have sent,
and posted to the production route. From there nothing is demo-specific: the scorer
prefers a voice call at that amount with a phone on file, the policy gate approves it,
Twilio rings the phone, asks why the payment failed, and the spoken answer lands on the
episode. The dashboard jumps to that episode and shows the transcript the moment it
arrives; the checkout page shows the same timeline.

> "The customer failed a payment thirty seconds ago and RecoverOS has already asked
> them why, in their language, and written the answer into the audit trail."

What it needs, and what to say if it does not fire:

- **Between 09:00 and 21:00 IST.** Outside that window the TRAI quiet-hours gate refuses
  the call and the episode escalates with the citation on screen. That refusal is the
  compliance beat, so show it rather than apologise for it.
- **A public URL** for Twilio's callbacks: `ngrok http 3000`, then `PUBLIC_BASE_URL` in
  `.env.local` and a dev-server restart. Without it the call still happens, but the
  answer cannot come back.
- **Twilio trial** calls only its verified number. **ElevenLabs** is optional: with a key
  the call is in that voice, without it Twilio's Hindi voice reads the same script.

### 4. The measurement — `RESULTS.md`

| Claim | Figure |
|---|---|
| vs silent-retry Baseline | **+₹2,86,581**, 20/20 seeds |
| vs Rules | **+₹16,79,365**, 20/20 |
| vs Oracle (the ceiling) | **−₹8,38,912**, 0/20 |
| Cost of compliance | **₹97,778**/seed |
| Compliant arm vs Baseline | **+₹1,88,803**, 20/20 |

> "A perfect-information policy beats doing nothing by only 3.7%. That is the entire prize
> in this world once churn is priced. We take 25% of it, and we can name most of what we
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
crosses zero at **~1.61×** the modelled churn hazard, on held-out seeds 6–20.

**"Your world, your churn model."** Correct, and the sweep is the answer to how much
weight that assumption carries. Coverage against planted truth is 17/20 against a floor we
set at 18/20 — reported, not tuned.

**"What did the AI actually earn?"** Nothing measurable, and we say so. The win came from
a contact-fatigue term in a deterministic churn calculation, not from the model.

What we can show is the size of the slot. The world carries a 54-string long tail, 51.9%
of it deliberately non-inferable, on which the deterministic table returns `unknown` 100%
of the time — and ₹65,314 of our gap to the Oracle opened when that tail went in. That is
the measured headroom a language model would compete for. We built the slot and measured
it; we did not fill it, and we would rather report the gap than claim we closed it.

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
