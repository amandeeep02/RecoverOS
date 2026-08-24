# RecoverOS — Current Spec & Interactive Transformation Plan

---

## 1. Current System Specification (What Exists Today)

### 1.1 Architecture Layers (Implemented)

| Layer | File | Responsibility | Status |
|-------|------|----------------|--------|
| **Domain/Contracts** | `lib/domain.ts` | Zod schemas: PaymentEvent, CustomerProfile, Diagnosis, RecoveryPrediction, EIRScore, ActionProposal, PolicyDecision, ExecutionResult, OutcomeEvent, AuditEvent, RecoveryEpisode, RecoveryLedger | ✅ Complete |
| **Webhook Ingestion** | `lib/normalizer.ts`, `app/api/webhooks/razorpay/route.ts` | Verify signature, normalize Razorpay events → internal PaymentEvent, idempotent registration | ✅ Complete |
| **Diagnosis Engine** | `lib/diagnosis.ts` | Deterministic mapping: failure_code → category + confidence + certainty_class | ✅ Complete |
| **Scoring/EIR** | `lib/scoring.ts` | Transparent model: p_native, p_action, EIR = (p_action - p_native) × amount - cost | ✅ Complete |
| **Action Proposal** | `lib/proposal.ts` (in scoring) | Deterministic proposal from diagnosis + profile + policy caps | ✅ Complete |
| **Policy Engine** | `lib/policy.ts` | Deterministic checks: EIR threshold, attempt caps, consent, contact window, native recovery state, voice call budget | ✅ Complete |
| **State Machine** | `lib/state-machine.ts` | Valid transitions: DETECTED → DIAGNOSED → SCORED → PROPOSED → POLICY_CHECK → EXECUTING → PENDING/PROMISED → RECOVERED/FAILED/EXPIRED/ESCALATED/STOPPED | ✅ Complete |
| **Razorpay Executor** | `lib/razorpay.ts` | Payment Link creation (test mode), idempotent, SIMULATED fallback | ✅ Complete |
| **Voice Executor** | `lib/voice.ts` | ElevenLabs TTS (Hinglish), browser SpeechSynthesis fallback, promise-to-pay creation | ✅ Complete |
| **Pipeline Orchestrator** | `lib/pipeline.ts` | End-to-end episode flow, audit at every stage | ✅ Complete |
| **In-Memory Store** | `lib/store.ts` | Episodes, profiles, audits, executions, promises (dev only) | ✅ Complete |
| **Simulator** | `lib/simulator.ts` | 50K synthetic events, hidden ground truth, 3-arm benchmark (Baseline/Rules/RecoverOS) | ✅ Complete |
| **Dashboard** | `components/recovery-dashboard.tsx` | KPI cards, Recovery Queue, Why Panel, Audit Timeline, Benchmark comparison, Voice Call Simulator modal | ✅ Complete |
| **API Routes** | `app/api/*` | Episodes CRUD, outcome observation, benchmark, health, webhooks | ✅ Complete |
| **Tests** | `tests/recovery-engine.test.ts` | 11 passing tests: EIR, policy, idempotency, state machine, simulator reproducibility, benchmark | ✅ Complete |

### 1.2 Action Set (Bounded)
```
WAIT | PAYMENT_LINK | REMINDER | ESCALATE | STOP | RETRY | VOICE_CALL
```

### 1.3 Current Data Flow (Demo Mode)
```
Demo snapshot (5 hardcoded cases)
    → processPaymentFailure() for each
    → observeOutcome() for one (RECOVERED)
    → runBenchmark(5 seeds, 1K events)
    → Dashboard renders static snapshot
```

### 1.4 What's Hardcoded/Simulated Today
- **Profiles**: 5 hardcoded in `lib/demo.ts` with fake phone numbers
- **Events**: 5 hardcoded payment failures in `lib/demo.ts`
- **Benchmark**: Synthetic generator, not real merchant data
- **Store**: In-memory `Map` — resets on server restart
- **Voice**: Browser SpeechSynthesis (no real call placed)
- **Razorpay**: SIMULATED executor unless test credentials provided
- **No auth**: No merchant login, no multi-tenancy
- **No real-time**: Dashboard is static SSR snapshot

---

## 2. Target Interactive System (What We Need)

### 2.1 Core Requirements
1. **Merchant Onboarding**: Real signup → Razorpay OAuth → webhook registration
2. **Real Data Pipeline**: Live webhooks → real profiles built from actual payment history
3. **Real-Time Visibility**: SSE/WebSocket for live episode updates (processing → executing → outcome)
4. **Persistent Storage**: PostgreSQL replacing in-memory Maps
5. **Background Workers**: Async webhook processing, retry logic, scheduled follow-ups
6. **Merchant Configuration UI**: Policy settings, thresholds, channel preferences
7. **Real Voice Calls**: Twilio integration (optional, free tier)
8. **Audit Export**: Downloadable CSV/JSON for compliance

### 2.2 User Journey (Interactive)
```
Merchant signs up
    → Connects Razorpay (OAuth)
    → Configures recovery policy
    → Receives real webhook (payment.failed)
    → Dashboard shows "Processing..." → "Diagnosing..." → "Scoring..." → "Proposed: VOICE_CALL"
    → Clicks to watch live call simulator (or real Twilio call)
    → Customer promises payment → "PROMISED" state with countdown
    → Payment webhook arrives → "RECOVERED" → Revenue ledger updates live
    → Audit trail complete, exportable
```

---

## 3. Transformation Plan (Phased)

### Phase A: Foundation — Persistence & Auth (Week 1)

| Task | Description | Files to Create/Modify |
|------|-------------|------------------------|
| **A1** | PostgreSQL schema + Prisma/Drizzle | `prisma/schema.prisma`, `lib/db.ts` |
| **A2** | Merchant auth (NextAuth.js) | `lib/auth.ts`, `app/api/auth/*` |
| **A3** | Razorpay OAuth connect flow | `app/api/razorpay/connect`, callback handler |
| **A4** | Webhook auto-registration on connect | `lib/razorpay-webhooks.ts` |
| **A5** | Migrate store interface → DB adapter | `lib/store.ts` → `lib/db-store.ts` |
| **A6** | Environment config for production | `.env.example` updates |

**Deliverable**: Merchant can sign up, connect Razorpay, webhooks registered automatically.

---

### Phase B: Real Data Pipeline (Week 1-2)

| Task | Description | Files to Create/Modify |
|------|-------------|------------------------|
| **B1** | Background job queue (BullMQ/Redis) | `lib/queue.ts`, worker processes |
| **B2** | Async webhook processing with retries | `app/api/webhooks/razorpay/route.ts` → queue |
| **B3** | Customer profile builder from payment history | `lib/profile-builder.ts` |
| **B4** | Subscription state sync (Razorpay API) | `lib/subscription-sync.ts` |
| **B5** | Idempotency + dead-letter queue | `lib/queue.ts` |

**Deliverable**: Real webhooks processed asynchronously, profiles built from actual history.

---

### Phase C: Real-Time Dashboard (Week 2)

| Task | Description | Files to Create/Modify |
|------|-------------|------------------------|
| **C1** | SSE/WebSocket server for live updates | `lib/realtime.ts`, `app/api/stream/route.ts` |
| **C2** | Client-side hooks for episode streaming | `hooks/useEpisodes.ts`, `hooks/useEpisode.ts` |
| **C3** | Live status badges: PROCESSING → DIAGNOSING → SCORING → PROPOSED → EXECUTING → PENDING/PROMISED → RECOVERED | Dashboard components |
| **C4** | Optimistic UI updates + rollback on error | React Query / SWR |
| **C5** | Empty state → "Waiting for failures..." → first event arrives live | Dashboard |

**Deliverable**: Dashboard updates in real-time as episodes progress through states.

---

### Phase D: Merchant Configuration UI (Week 2-3)

| Task | Description | Files to Create/Modify |
|------|-------------|------------------------|
| **D1** | Settings page: Policy thresholds, attempt caps, channels | `app/settings/page.tsx` |
| **D2** | Channel toggles: Payment Link, Reminder, Voice Call, Retry | Settings UI |
| **D3** | Contact policy: consent, opt-out, quiet hours, window | Settings UI |
| **D4** | High-value escalation threshold | Settings UI |
| **D5** | Webhook health monitor (success/failure rate) | Settings UI |

**Deliverable**: Merchant configures their own recovery behavior via UI.

---

### Phase E: Voice & Communication (Week 3)

| Task | Description | Files to Create/Modify |
|------|-------------|------------------------|
| **E1** | Twilio Voice integration (free trial) | `lib/twilio-voice.ts` |
| **E2** | Real call placement + recording webhook | `app/api/twilio/voice-webhook` |
| **E3** | WhatsApp/SMS reminder executor | `lib/twilio-messaging.ts` |
| **E4** | Promise-to-pay scheduler (cron) | `lib/promise-scheduler.ts` |
| **E5** | Failed promise → auto-escalation workflow | Pipeline + scheduler |

**Deliverable**: Real voice calls placed, promises tracked, auto-followup.

---

### Phase F: Observability & Export (Week 3-4)

| Task | Description | Files to Create/Modify |
|------|-------------|------------------------|
| **F1** | Audit log export (CSV/JSON) | `app/api/episodes/export` |
| **F2** | Revenue ledger with real-time increments | Dashboard KPI cards |
| **F3** | Episode detail page with full timeline | `app/episodes/[id]/page.tsx` |
| **F4** | Webhook delivery logs + retry status | Settings page |
| **F5** | Health check + alerting endpoints | `app/api/health/detailed` |

**Deliverable**: Full auditability, compliance-ready exports.

---

### Phase G: Polish & Demo Readiness (Week 4)

| Task | Description |
|------|-------------|
| **G1** | Seed script for demo merchant with realistic history |
| **G2** | ngrok tunnel script for local webhook testing |
| **G3** | 5-min pitch video recording script |
| **G4** | README + architecture diagram update |
| **G5** | Load test: 1000 concurrent episodes |

---

## 4. Technical Decisions Needed

| Decision | Options | Recommendation |
|----------|---------|----------------|
| **Database** | Prisma + PostgreSQL vs Drizzle + PostgreSQL | Prisma (type safety, migration DX) |
| **Queue** | BullMQ (Redis) vs native Node worker threads | BullMQ (retries, delayed jobs, dashboard) |
| **Auth** | NextAuth.js (Credentials + OAuth) vs Clerk vs custom | NextAuth.js (Razorpay OAuth provider exists) |
| **Real-time** | SSE (simpler) vs Socket.io (bidirectional) | SSE (one-way server→client is enough) |
| **Voice** | ElevenLabs + Twilio vs browser-only | ElevenLabs TTS + Twilio for real calls |
| **Hosting** | Vercel + Railway/Render (Postgres+Redis) | Vercel (frontend) + Railway (Postgres, Redis, workers) |

---

## 5. File Structure After Transformation

```
recoveros/
├── app/
│   ├── api/
│   │   ├── auth/                 # NextAuth endpoints
│   │   ├── razorpay/connect      # OAuth flow
│   │   ├── webhooks/razorpay     # Webhook ingestion → queue
│   │   ├── episodes/             # CRUD + export
│   │   ├── stream                # SSE endpoint
│   │   ├── twilio/voice-webhook  # Call status callbacks
│   │   └── benchmark             # (keep for reference)
│   ├── auth/signin               # Sign in page
│   ├── dashboard                 # Main merchant dashboard
│   ├── settings                  # Policy configuration
│   ├── episodes/[id]             # Episode detail
│   └── layout.tsx                # Auth provider
├── lib/
│   ├── auth.ts                   # NextAuth config
│   ├── db.ts                     # Prisma client
│   ├── db-store.ts               # PostgreSQL RecoveryStore impl
│   ├── queue.ts                  # BullMQ queue + workers
│   ├── profile-builder.ts        # Build profile from Razorpay history
│   ├── subscription-sync.ts      # Sync subscription state
│   ├── realtime.ts               # SSE broadcaster
│   ├── twilio-voice.ts           # Real voice calls
│   ├── twilio-messaging.ts       # WhatsApp/SMS
│   ├── promise-scheduler.ts      # Cron for promise follow-up
│   ├── razorpay-webhooks.ts      # Register webhooks on connect
│   └── ... (existing domain, policy, scoring, etc.)
├── prisma/
│   └── schema.prisma             # DB schema
├── hooks/
│   ├── useEpisodes.ts            # SSE hook for episode list
│   └── useEpisode.ts             # SSE hook for single episode
├── components/
│   ├── recovery-dashboard.tsx    # Updated for real-time
│   ├── voice-call-simulator.tsx  # Keep for demo/fallback
│   ├── settings-form.tsx         # Policy configuration
│   └── episode-timeline.tsx      # Live timeline component
└── scripts/
    ├── seed-demo.ts              # Demo data
    └── tunnel.ts                 # ngrok helper
```

---

## 6. Database Schema (Prisma)

```prisma
// prisma/schema.prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Merchant {
  id                String   @id @default(cuid())
  email             String   @unique
  name              String
  passwordHash      String
  razorpayAccountId String?  @unique
  razorpayAccessToken String?
  razorpayRefreshToken String?
  webhookSecret     String?  @default(uuid())
  policy            Json     // MerchantPolicy
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  episodes          Episode[]
  profiles          CustomerProfile[]
  auditEvents       AuditEvent[]
}

model CustomerProfile {
  id                          String   @id @default(cuid())
  merchantId                  String
  customerId                  String
  subscriptionAgeDays         Int
  customerValueInr            Float
  successfulPaymentCount      Int
  failedPaymentCount          Int
  previousRecoveryRate        Float
  previousInterventionCount   Int
  previousInterventionSuccessCount Int
  daysSinceLastSuccess        Int
  lastFailureReason           String?
  paymentMethodDistribution   Json
  currentFailureEpisodeId     String?
  consentValid                Boolean
  optedOut                    Boolean
  contactWindowOpen           Boolean
  phone                       String?
  email                       String?
  createdAt                   DateTime @default(now())
  updatedAt                   DateTime @updatedAt

  merchant Merchant @relation(fields: [merchantId], references: [id])
  @@unique([merchantId, customerId])
}

model Episode {
  id                     String   @id @default(cuid())
  merchantId             String
  eventId                String   @unique // Razorpay event ID
  event                  Json     // PaymentEvent
  profileId              String
  status                 EpisodeStatus
  automatedAttemptCount  Int      @default(0)
  reminderCount          Int      @default(0)
  voiceCallCount         Int      @default(0)
  diagnosis              Json?
  prediction             Json?
  eir                    Json?
  proposal               Json?
  policyDecision         Json?
  execution              Json?
  outcome                Json?
  createdAt              DateTime @default(now())
  updatedAt              DateTime @updatedAt

  merchant  Merchant     @relation(fields: [merchantId], references: [id])
  profile   CustomerProfile @relation(fields: [profileId], references: [id])
  audits    AuditEvent[]
  promises  PromiseToPay[]
}

model AuditEvent {
  id        String   @id @default(cuid())
  episodeId String
  eventId   String
  customerId String
  paymentId String
  timestamp DateTime @default(now())
  stage     AuditStage
  payload   Json

  episode Episode @relation(fields: [episodeId], references: [id])
  @@index([episodeId])
  @@index([eventId])
}

model PromiseToPay {
  id                    String   @id @default(cuid())
  episodeId             String
  promisedAmountInr     Float
  promisedAt            DateTime @default(now())
  dueBy                 DateTime
  status                PromiseStatus @default(PENDING)
  customerAcknowledged  Boolean  @default(false)
  callId                String?
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt

  episode Episode @relation(fields: [episodeId], references: [id])
}

model ExecutionLog {
  id              String   @id @default(cuid())
  episodeId       String
  action          ActionType
  status          ExecutionStatus
  executor        String
  externalRef     String?
  idempotencyKey  String   @unique
  error           String?
  executedAt      DateTime @default(now())

  @@index([episodeId])
  @@index([idempotencyKey])
}

enum EpisodeStatus {
  DETECTED
  DIAGNOSED
  SCORED
  PROPOSED
  POLICY_CHECK
  EXECUTING
  PENDING
  PROMISED
  RECOVERED
  FAILED
  EXPIRED
  ESCALATED
  STOPPED
}

enum AuditStage {
  INGESTED
  DIAGNOSED
  SCORED
  PROPOSED
  POLICY
  EXECUTED
  OUTCOME
}

enum PromiseStatus {
  PENDING
  FULFILLED
  BROKEN
  EXPIRED
}

enum ActionType {
  WAIT
  PAYMENT_LINK
  REMINDER
  ESCALATE
  STOP
  RETRY
  VOICE_CALL
}

enum ExecutionStatus {
  EXECUTED
  SIMULATED
  SKIPPED
  FAILED
}
```

---

## 7. Immediate Next Steps (Start Here)

### Step 1: Initialize Prisma + Database
```bash
npm install prisma @prisma/client
npx prisma init
# Edit prisma/schema.prisma (from Section 6)
npx prisma migrate dev --name init
```

### Step 2: Create DB Store Adapter
Replace `lib/store.ts` in-memory implementation with `lib/db-store.ts` using Prisma client, keeping the same interface.

### Step 3: Add NextAuth with Razorpay OAuth
```bash
npm install next-auth @next-auth/prisma-adapter
```
Create `lib/auth.ts` with Razorpay OAuth provider.

### Step 4: Background Queue
```bash
npm install bullmq ioredis
```
Create `lib/queue.ts` with webhook processing worker.

---

## 8. Approval Checklist

Before starting, confirm:

- [ ] **Database**: Use Prisma + PostgreSQL (Railway/Neon/local)?
- [ ] **Queue**: BullMQ + Redis (Railway/Upstash/local)?
- [ ] **Auth**: NextAuth.js with Razorpay OAuth?
- [ ] **Real-time**: SSE (simpler) or Socket.io?
- [ ] **Voice**: ElevenLabs TTS (already) + Twilio for real calls?
- [ ] **Hosting**: Vercel (frontend) + Railway (Postgres, Redis, workers)?
- [ ] **Scope**: Build all phases A-G, or stop at Phase C (real-time dashboard)?

---

## 9. Demo Readiness Timeline

| Week | Milestone | Demo Capability |
|------|-----------|-----------------|
| 1 | Phase A + B | Merchant signs up, connects Razorpay, real webhook processes |
| 2 | Phase C | Live dashboard updates as episode flows through states |
| 3 | Phase D + E | Configure policy, place real voice call, promise-to-pay works |
| 4 | Phase F + G | Full audit export, pitch video recorded, submission ready |

---

**Total Estimate: 4 weeks part-time / 2 weeks full-time**

This plan transforms RecoverOS from a "demo with seeded data" to a **real, merchant-ready product** where every number on the dashboard comes from actual webhook events, every action is traceable in real-time, and the merchant controls their own recovery behavior.