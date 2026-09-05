# Hosting RecoverOS

RecoverOS wants **one long-running Node process**, not serverless functions. The live
dashboard is fed by an in-process event stream, the webhook worker polls from inside the
server, the benchmark is computed once per process, and call audio for Twilio is held in
memory. Split across serverless instances, events emitted on one instance never reach a
browser connected to another, and the live beats stop landing. Railway, Render (paid
instance) or Fly.io fit; Vercel does not, for this app.

The database is already remote (Neon Postgres) and the schema self-creates on first
start, so nothing else has to be provisioned.

## Railway, about ten minutes

1. Push the branch: `git push -u origin production-readiness`.
2. railway.com → New Project → **Deploy from GitHub repo** → pick `RecoverOS`, branch
   `production-readiness`. Railway detects Next.js; build `npm run build`, start `npm start`.
   Next binds to Railway's `PORT` automatically.
3. Service → **Variables** → paste these (values from your local `.env.local`):

   ```
   RAZORPAY_KEY_ID
   RAZORPAY_KEY_SECRET
   RAZORPAY_WEBHOOK_SECRET
   RAZORPAY_TEST_MODE=true
   DATABASE_URL
   GROQ_API_KEY
   TWILIO_ACCOUNT_SID
   TWILIO_AUTH_TOKEN
   TWILIO_FROM_NUMBER
   ```
   Optional: `ELEVENLABS_API_KEY` (call audio in that voice), `RECOVEROS_DISABLE_QUIET_HOURS=1`
   (only while recording after 21:00 IST; the dashboard shows a banner).
4. Service → **Settings → Networking → Generate Domain**. Copy it.
5. Add `PUBLIC_BASE_URL=https://<that domain>` to Variables. Railway redeploys. This is the
   URL Twilio posts the spoken answer to and fetches call audio from; it replaces ngrok.
6. Open `https://<domain>/api/health`, then `/`, `/checkout`, `/frontier`.

## Optional: let Razorpay call you directly

Razorpay Dashboard → Settings → Webhooks → Add:
`https://<domain>/api/webhooks/razorpay`, secret = the same `RAZORPAY_WEBHOOK_SECRET`,
events `payment.failed` and `payment_link.paid`. Real failures and real link payments
then reach the same route the demo buttons use, and the demo buttons keep working.

## First request after a deploy

The first dashboard load computes the in-process benchmark (12 seeds × 3,000 episodes)
and takes several seconds; every load after that is sub-second. Warm it once before a demo.

## Render / Fly

Same variables. Render: a paid instance, because the free tier sleeps and cold-starts for
a minute. Fly: `fly launch` from the repo root accepts the Node defaults; set secrets with
`fly secrets set`. In both cases set `PUBLIC_BASE_URL` to the assigned domain.
