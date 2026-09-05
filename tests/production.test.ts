import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { RecoveryStore } from "@/lib/memory-store";
import { PostgresRecoveryStore, RECOVEROS_SCHEMA } from "@/lib/pg-store";
import { merchantPolicySchema, rupees, type CustomerProfile, type ExecutionResult, type PaymentEvent, type RecoveryEpisode } from "@/lib/domain";
import {
  drainProcessingQueue,
  ingestPaymentFailureQueued,
  processDueDrains,
  processPaymentFailure,
  processQueuedEpisode,
  recoverAfterRestart,
  resetBackgroundWorkers,
  tickDegradation,
  PROCESSING_CLAIM_TIMEOUT_MS,
} from "@/lib/pipeline";
import { executeApprovedAction } from "@/lib/razorpay";
import { DegradationDetector, DEGRADATION_CONFIG, resetDegradationDetector } from "@/lib/degradation";
import { fixedClock } from "@/lib/clock";

const policy = merchantPolicySchema.parse({ merchantId: "merchant_test", dltTemplateId: "DLT_1", preDebitNotificationByPlatform: true });

function event(overrides: Partial<PaymentEvent> = {}): PaymentEvent {
  return {
    eventId: `evt_${Math.random().toString(36).slice(2)}`,
    eventType: "payment.failed",
    occurredAt: "2026-08-21T10:14:03.000Z",
    merchantId: "merchant_test",
    customerId: "cust_test",
    paymentId: `pay_${Math.random().toString(36).slice(2)}`,
    subscriptionId: "sub_test",
    amountPaise: rupees(4_999),
    currency: "INR",
    paymentMethod: "card",
    failureCode: "expired_card",
    failureSource: "bank",
    nativeRecoveryState: "EXHAUSTED",
    customerPhone: null,
    railMetadata: { issuer: "HDFC", network: "VISA" },
    ...overrides,
  } as PaymentEvent;
}

function profile(overrides: Partial<CustomerProfile> = {}): CustomerProfile {
  return {
    customerId: "cust_test",
    merchantId: "merchant_test",
    subscriptionAgeDays: 240,
    customerValuePaise: rupees(50_000),
    successfulPaymentCount: 11,
    failedPaymentCount: 1,
    previousRecoveryRate: 0.58,
    previousInterventionCount: 0,
    previousInterventionSuccessCount: 0,
    daysSinceLastSuccess: 14,
    lastFailureReason: null,
    paymentMethodDistribution: { card: 1 },
    currentFailureEpisodeId: null,
    consentValid: true,
    optedOut: false,
    contactWindowOpen: true,
    phone: null,
    isSubscription: true,
    daysSinceLastEngagement: 14,
    engagementProxy: true,
    ...overrides,
  };
}

/** A stored episode carrying one delivered contact action, at a chosen time. */
function contactEpisode(overrides: {
  id: string;
  customerId?: string;
  merchantId?: string;
  action?: string;
  status?: ExecutionResult["status"];
  executedAt: string;
}): RecoveryEpisode {
  const ev = event({ customerId: overrides.customerId ?? "cust_test", merchantId: overrides.merchantId ?? "merchant_test" });
  return {
    id: overrides.id,
    event: ev,
    profile: profile({ customerId: ev.customerId, merchantId: ev.merchantId }),
    status: "PENDING",
    automatedAttemptCount: 1,
    reminderCount: 1,
    voiceCallCount: 0,
    diagnosis: null,
    prediction: null,
    eir: null,
    proposal: { action: (overrides.action ?? "REMINDER") as never, rationale: "t", expectedValuePaise: 0, guardrails: [], requiresApproval: false } as never,
    policyDecision: null,
    execution: {
      actionId: `act_${overrides.id}`,
      status: overrides.status ?? "EXECUTED",
      executor: "simulated_executor",
      externalReference: "ref",
      idempotentReplay: false,
      error: null,
      executedAt: overrides.executedAt,
    },
    outcome: null,
    customerResponses: [],
    createdAt: overrides.executedAt,
    updatedAt: overrides.executedAt,
  } as RecoveryEpisode;
}

/** Records every SQL statement the Postgres adapter emits, so the queries can be
 *  asserted on without a database. */
class RecordingPool {
  readonly queries: { text: string; values: unknown[] }[] = [];
  rows: Record<string, unknown>[] = [];
  async query(text: string, values?: unknown[]) {
    this.queries.push({ text, values: values ?? [] });
    return { rows: this.rows, rowCount: this.rows.length };
  }
  last() {
    return this.queries[this.queries.length - 1];
  }
}

function recordingStore() {
  const pool = new RecordingPool();
  const store = new PostgresRecoveryStore("postgres://unused", pool as unknown as Pool);
  return { pool, store };
}

beforeEach(() => {
  resetDegradationDetector();
  resetBackgroundWorkers();
});

afterEach(() => {
  resetBackgroundWorkers();
  resetDegradationDetector();
});

// ===========================================================================
// Defect 1 — the full-table scan on every webhook
// ===========================================================================

describe("contact fatigue is answered by an indexed count, not a table read", () => {
  /** Counts the reads the ingest path makes. `listEpisodes()` has no LIMIT and no
   *  WHERE: one call per webhook is one full table read per webhook. */
  class CountingStore extends RecoveryStore {
    listEpisodesCalls = 0;
    override async listEpisodes() {
      this.listEpisodesCalls += 1;
      return super.listEpisodes();
    }
  }

  it("never reads the whole episode table while ingesting a failure", async () => {
    const store = new CountingStore();
    await store.saveProfile(profile());
    // 200 unrelated episodes: exactly the rows the old scan pulled into Node and
    // then discarded.
    for (let i = 0; i < 200; i++) {
      await store.saveEpisode(contactEpisode({ id: `ep_other_${i}`, customerId: `cust_${i}`, executedAt: new Date(Date.now() - 86_400_000).toISOString() }));
    }

    const { episode } = await processPaymentFailure(event(), store, policy);

    expect(episode.status).not.toBe("DETECTED");
    expect(store.listEpisodesCalls).toBe(0);
  });

  it("counts exactly the contacts the fatigue rule counts", async () => {
    const store = new RecoveryStore();
    const now = Date.parse("2026-09-01T00:00:00.000Z");
    const since = now - 90 * 86_400_000;
    const inWindow = new Date(now - 10 * 86_400_000).toISOString();

    await store.saveEpisode(contactEpisode({ id: "ep_reminder", executedAt: inWindow }));
    await store.saveEpisode(contactEpisode({ id: "ep_link", action: "PAYMENT_LINK", executedAt: inWindow }));
    await store.saveEpisode(contactEpisode({ id: "ep_voice", action: "VOICE_CALL", status: "SIMULATED", executedAt: inWindow }));
    // Excluded: a silent retry is not a contact.
    await store.saveEpisode(contactEpisode({ id: "ep_retry", action: "RETRY", executedAt: inWindow }));
    // Excluded: never delivered.
    await store.saveEpisode(contactEpisode({ id: "ep_failed", status: "FAILED", executedAt: inWindow }));
    // Excluded: outside the 90-day window.
    await store.saveEpisode(contactEpisode({ id: "ep_old", executedAt: new Date(now - 120 * 86_400_000).toISOString() }));
    // Excluded: another customer, and another merchant.
    await store.saveEpisode(contactEpisode({ id: "ep_other_cust", customerId: "cust_zzz", executedAt: inWindow }));
    await store.saveEpisode(contactEpisode({ id: "ep_other_merchant", merchantId: "merchant_zzz", executedAt: inWindow }));

    expect(await store.countContactsSince("merchant_test", "cust_test", since)).toBe(3);
    expect(await store.countContactsSince("merchant_test", "cust_test", since, "ep_voice")).toBe(2);
    expect(await store.countContactsSince("merchant_test", "cust_absent", since)).toBe(0);
  });

  it("feeds the churn term the same number the old scan produced", async () => {
    const store = new RecoveryStore();
    await store.saveProfile(profile());
    const recent = new Date(Date.now() - 5 * 86_400_000).toISOString();
    await store.saveEpisode(contactEpisode({ id: "ep_a", executedAt: recent }));
    await store.saveEpisode(contactEpisode({ id: "ep_b", action: "PAYMENT_LINK", executedAt: recent }));

    const { episode } = await processPaymentFailure(event(), store, policy);
    expect(episode.profile.previousInterventionCount).toBe(2);
  });

  it("emits an indexed COUNT in Postgres, and the schema carries the index", async () => {
    const { pool, store } = recordingStore();
    await store.countContactsSince("merchant_test", "cust_test", Date.parse("2026-06-01T00:00:00.000Z"), "ep_self");
    const sql = pool.last().text;

    expect(sql).toMatch(/SELECT COUNT\(\*\)/);
    expect(sql).toMatch(/customer_id = \$2/);
    expect(sql).toMatch(/event_json->>'merchantId' = \$1/);
    // The failure mode being fixed: no bounded predicate, whole table into Node.
    expect(sql).not.toMatch(/FROM episode\s+ORDER BY/);
    expect(RECOVEROS_SCHEMA).toMatch(/idx_episode_contact_history/);
    expect(RECOVEROS_SCHEMA).toMatch(/ON episode \(\(event_json->>'merchantId'\), customer_id/);
  });
});

// ===========================================================================
// Defect 2 — the webhook did everything inline before answering
// ===========================================================================

describe("webhook ingest is separated from processing", () => {
  it("persists and enqueues without diagnosing, scoring, deciding or executing", async () => {
    const store = new RecoveryStore();
    await store.saveProfile(profile());

    const { episode, duplicate } = await ingestPaymentFailureQueued(event(), store);

    expect(duplicate).toBe(false);
    expect(episode.status).toBe("DETECTED");
    // Everything downstream of ingest is still unset: nothing that can take seconds
    // ran before the handler could answer.
    expect(episode.diagnosis).toBeNull();
    expect(episode.eir).toBeNull();
    expect(episode.policyDecision).toBeNull();
    expect(episode.execution).toBeNull();
    expect((await store.getAudit(episode.id)).map((entry) => entry.stage)).toEqual(["INGESTED"]);
    // ...and the event is durable and claimable, not lost.
    expect(await store.getEpisodeByWebhook(episode.event.eventId)).toMatchObject({ id: episode.id });
    expect(await store.getEpisodeProcessing(episode.id)).toMatchObject({ state: "PENDING", attempts: 0 });
  });

  it("the worker finishes the episode the webhook only enqueued", async () => {
    const store = new RecoveryStore();
    await store.saveProfile(profile());
    const { episode } = await ingestPaymentFailureQueued(event(), store);

    const settled = await processQueuedEpisode(store);

    expect(settled?.id).toBe(episode.id);
    expect(settled?.status).not.toBe("DETECTED");
    expect((await store.getAudit(episode.id)).map((entry) => entry.stage)).toContain("POLICY");
    expect(await store.getEpisodeProcessing(episode.id)).toMatchObject({ state: "DONE" });
    // Queue drained.
    expect(await processQueuedEpisode(store)).toBeUndefined();
  });

  it("stays idempotent on event_id: a redelivery opens no episode and queues no work", async () => {
    const store = new RecoveryStore();
    await store.saveProfile(profile());
    const incoming = event();

    const first = await ingestPaymentFailureQueued(incoming, store);
    const replay = await ingestPaymentFailureQueued(incoming, store);

    expect(replay.duplicate).toBe(true);
    expect(replay.episode.id).toBe(first.episode.id);
    expect(await store.listEpisodes()).toHaveLength(1);
    await drainProcessingQueue(store);
    expect(await processQueuedEpisode(store)).toBeUndefined();
  });

  it("a claim is exclusive: a second worker gets nothing while it is held", async () => {
    const store = new RecoveryStore();
    await store.saveProfile(profile());
    await ingestPaymentFailureQueued(event(), store);

    const now = Date.now();
    const first = await store.claimEpisodeForProcessing(now, PROCESSING_CLAIM_TIMEOUT_MS);
    const second = await store.claimEpisodeForProcessing(now, PROCESSING_CLAIM_TIMEOUT_MS);

    expect(first).toBeDefined();
    expect(second).toBeUndefined();
  });

  it("a claim held by a dead worker goes stale and is retried, up to a ceiling", async () => {
    const store = new RecoveryStore();
    await store.saveProfile(profile());
    const { episode } = await ingestPaymentFailureQueued(event(), store);
    const t0 = Date.now();

    expect(await store.claimEpisodeForProcessing(t0, PROCESSING_CLAIM_TIMEOUT_MS)).toBeDefined();
    // The worker dies here without completing. Before the timeout nobody may touch it.
    expect(await store.claimEpisodeForProcessing(t0 + PROCESSING_CLAIM_TIMEOUT_MS - 1, PROCESSING_CLAIM_TIMEOUT_MS)).toBeUndefined();
    // After it, the work is recoverable — this is what makes a redeploy mid-episode safe.
    expect(await store.claimEpisodeForProcessing(t0 + PROCESSING_CLAIM_TIMEOUT_MS, PROCESSING_CLAIM_TIMEOUT_MS)).toMatchObject({ id: episode.id });
    expect(await store.getEpisodeProcessing(episode.id)).toMatchObject({ attempts: 2 });

    // A poison event does not spin forever.
    for (let i = 0; i < 10; i++) await store.claimEpisodeForProcessing(t0 + (i + 2) * PROCESSING_CLAIM_TIMEOUT_MS, PROCESSING_CLAIM_TIMEOUT_MS);
    const state = await store.getEpisodeProcessing(episode.id);
    expect(state!.attempts).toBeLessThanOrEqual(5);
  });

  it("resumes a half-processed episode at the stage it reached, without re-executing", async () => {
    const store = new RecoveryStore();
    await store.saveProfile(profile());
    await ingestPaymentFailureQueued(event(), store);
    const settled = (await processQueuedEpisode(store))!;

    // Re-queue the finished episode, as a stale claim would. It must not be re-run
    // through diagnosis, scoring or the executor.
    await store.markEpisodeQueued(settled.id);
    const before = await store.getAudit(settled.id);
    const again = await processQueuedEpisode(store);

    expect(again?.status).toBe(settled.status);
    expect(await store.getAudit(settled.id)).toHaveLength(before.length);
  });

  it("Postgres claims with FOR UPDATE SKIP LOCKED and a claim timeout", async () => {
    const { pool, store } = recordingStore();
    await store.claimEpisodeForProcessing(1_000_000, PROCESSING_CLAIM_TIMEOUT_MS);
    const sql = pool.last().text;

    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(sql).toMatch(/processing_state = 'PENDING'/);
    expect(sql).toMatch(/claimed_at_ms <= \$2/);
    expect(pool.last().values).toEqual([1_000_000, 1_000_000 - PROCESSING_CLAIM_TIMEOUT_MS, 5]);
    expect(RECOVEROS_SCHEMA).toMatch(/processing_state\s+TEXT NOT NULL DEFAULT 'DONE'/);
    expect(RECOVEROS_SCHEMA).toMatch(/idx_episode_processing/);
  });
});

// ===========================================================================
// Defect 3 — transient executor failures were cached permanently
// ===========================================================================

describe("the executor tells a blip apart from a refusal", () => {
  const input = { episodeId: "ep_exec_test", event: event(), action: "PAYMENT_LINK" as const };

  beforeEach(() => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_key";
    process.env.RAZORPAY_KEY_SECRET = "secret";
  });

  afterEach(() => {
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
  });

  const noSleep = { sleep: async () => {}, retryBaseMs: 0 };

  it("does not burn the idempotency key on a 5xx, so the action can be retried", async () => {
    const store = new RecoveryStore();
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push(`${method} ${String(url)}`);
      if (method === "GET") return new Response(JSON.stringify({ payment_links: [] }), { status: 200 });
      return calls.filter((c) => c.startsWith("POST")).length === 1
        ? new Response(JSON.stringify({ error: { description: "server is having a moment" } }), { status: 502 })
        : new Response(JSON.stringify({ id: "plink_recovered" }), { status: 200 });
    }) as unknown as typeof fetch;

    const first = await executeApprovedAction(input, store, { fetch: fetchImpl, ...noSleep });
    expect(first.status).toBe("FAILED");
    // The key is still free. Before the fix this FAILED row was written and every
    // later attempt replayed it, permanently.
    expect(await store.getExecution("ep_exec_test:PAYMENT_LINK")).toBeUndefined();

    const second = await executeApprovedAction(input, store, { fetch: fetchImpl, ...noSleep });
    expect(second.status).toBe("EXECUTED");
    expect(second.externalReference).toBe("plink_recovered");
    expect(await store.getExecution("ep_exec_test:PAYMENT_LINK")).toMatchObject({ status: "EXECUTED" });
  });

  it("treats a timeout or dropped socket as transient", async () => {
    const store = new RecoveryStore();
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify({ payment_links: [] }), { status: 200 });
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    }) as unknown as typeof fetch;

    const result = await executeApprovedAction(input, store, { fetch: fetchImpl, ...noSleep });

    expect(result.status).toBe("FAILED");
    expect(result.error).toContain("TimeoutError");
    expect(await store.getExecution("ep_exec_test:PAYMENT_LINK")).toBeUndefined();
  });

  it("sends a deadline with the request", async () => {
    const store = new RecoveryStore();
    let signal: AbortSignal | null | undefined;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal;
      return new Response(JSON.stringify({ id: "plink_ok" }), { status: 200 });
    }) as unknown as typeof fetch;

    await executeApprovedAction(input, store, { fetch: fetchImpl, timeoutMs: 1_500, ...noSleep });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("backs off on 429 and succeeds, rather than reporting a permanent failure", async () => {
    const store = new RecoveryStore();
    const slept: number[] = [];
    let posts = 0;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify({ payment_links: [] }), { status: 200 });
      posts += 1;
      return posts === 1
        ? new Response("", { status: 429, headers: { "retry-after": "1" } })
        : new Response(JSON.stringify({ id: "plink_after_429" }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await executeApprovedAction(input, store, { fetch: fetchImpl, sleep: async (ms) => { slept.push(ms); }, retryBaseMs: 10 });

    expect(posts).toBe(2);
    expect(slept).toEqual([1_000]); // honoured Retry-After, not a fixed guess
    expect(result.status).toBe("EXECUTED");
  });

  it("exhausted 429 retries are still transient, not a poisoned key", async () => {
    const store = new RecoveryStore();
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) =>
      (init?.method ?? "GET") === "GET"
        ? new Response(JSON.stringify({ payment_links: [] }), { status: 200 })
        : new Response("", { status: 429 })) as unknown as typeof fetch;

    const result = await executeApprovedAction(input, store, { fetch: fetchImpl, ...noSleep });

    expect(result.status).toBe("FAILED");
    expect(await store.getExecution("ep_exec_test:PAYMENT_LINK")).toBeUndefined();
  });

  it("still records a genuine refusal exactly once — the idempotency guarantee is unchanged", async () => {
    const store = new RecoveryStore();
    let posts = 0;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify({ payment_links: [] }), { status: 200 });
      posts += 1;
      return new Response(JSON.stringify({ error: { description: "The amount must be at least INR 1" } }), { status: 400 });
    }) as unknown as typeof fetch;

    const first = await executeApprovedAction(input, store, { fetch: fetchImpl, ...noSleep });
    const replay = await executeApprovedAction(input, store, { fetch: fetchImpl, ...noSleep });

    expect(first.status).toBe("FAILED");
    expect(replay.idempotentReplay).toBe(true);
    expect(posts).toBe(1); // a decision is not asked twice
  });

  it("sends an idempotency key and a deterministic reference to Razorpay", async () => {
    const store = new RecoveryStore();
    let headers: Record<string, string> = {};
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      headers = (init?.headers ?? {}) as Record<string, string>;
      body = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ id: "plink_ok" }), { status: 200 });
    }) as unknown as typeof fetch;

    await executeApprovedAction(input, store, { fetch: fetchImpl, ...noSleep });

    expect(headers["X-Razorpay-Idempotency-Key"]).toBe("ep_exec_test:PAYMENT_LINK");
    expect(body.reference_id).toBe("ep_exec_test");
  });

  it("adopts a link that was created before the timeout instead of orphaning it", async () => {
    const store = new RecoveryStore();
    let posts = 0;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({ payment_links: [{ id: "plink_already_live" }] }), { status: 200 });
      }
      posts += 1;
      throw Object.assign(new Error("socket hang up"), { name: "TypeError" });
    }) as unknown as typeof fetch;

    const result = await executeApprovedAction(input, store, { fetch: fetchImpl, ...noSleep });

    expect(posts).toBe(1);
    expect(result.status).toBe("EXECUTED");
    expect(result.externalReference).toBe("plink_already_live");
    expect(await store.getExecution("ep_exec_test:PAYMENT_LINK")).toMatchObject({ externalReference: "plink_already_live" });
  });
});

// ===========================================================================
// Defect 4 — degradation state was process-local and lost on deploy
// ===========================================================================

/** Warm the detector past its seed windows with healthy traffic, then spike it. */
function drive(detector: DegradationDetector, probe: PaymentEvent) {
  const feed = (rate: number) => {
    for (let i = 0; i < 60; i++) detector.record(probe, i < Math.round(60 * rate));
  };
  for (let w = 0; w < DEGRADATION_CONFIG.BASELINE_SEED_WINDOWS; w++) {
    feed(0.05);
    detector.tick();
  }
  feed(0.6);
  return detector.tick();
}

describe("issuer degradation survives a deploy", () => {
  it("an open window and its baseline are still there after a restart", async () => {
    const store = new RecoveryStore();
    const before = new DegradationDetector(store);
    const opened = drive(before, event());
    expect(opened.opened).toHaveLength(1);
    await before.persist();

    // The process dies. Everything in the old detector's Map is gone.
    const after = new DegradationDetector(store);
    expect(after.getAllOpen()).toHaveLength(0);
    await after.hydrate();

    expect(after.getAllOpen()).toHaveLength(1);
    expect(after.getAllOpen()[0].id).toBe(opened.opened[0].id);
    // The warm-up is not repeated, and the baseline is not relearned from scratch.
    expect(after.keyHealth()[0].seenWindows).toBeGreaterThanOrEqual(DEGRADATION_CONFIG.BASELINE_SEED_WINDOWS);
    expect(after.keyHealth()[0].baselineRate).toBeCloseTo(before.keyHealth()[0].baselineRate, 12);
  });

  it("the tick writes detector state through to the store", async () => {
    const store = new RecoveryStore();
    expect(await store.loadDegradationState()).toEqual([]);

    await ingestPaymentFailureQueued(event(), store);
    await tickDegradation(store);

    const persisted = await store.loadDegradationState();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].keyString).toBe("card|HDFC|VISA");
  });

  it("a held episode is not stranded when the process that held it goes away", async () => {
    const store = new RecoveryStore();
    await store.saveProfile(profile());
    const detector = new DegradationDetector(store);
    const opened = drive(detector, event());
    const { episode } = await processPaymentFailure(event(), store, policy, undefined, undefined, detector);
    expect(episode.status).toBe("HELD_DEGRADED");
    expect(episode.policyDecision?.degradationWindowId).toBe(opened.opened[0].id);

    // Deploy. The detector, its open window and every pending drain setTimeout die
    // with the process; the held episode is all that is left in the table.
    resetDegradationDetector();
    const recovery = await recoverAfterRestart(store, fixedClock(Date.now()));

    expect(recovery.rescheduled).toContain(episode.id);
    // Time passes; the drain comes due.
    const drained = await processDueDrains(store, fixedClock(Date.now() + DEGRADATION_CONFIG.DRAIN_JITTER_MS + 1));
    expect(drained).toContain(episode.id);
    const settled = await store.getEpisode(episode.id);
    // Positive assertion. `not.toBe("HELD_DEGRADED")` passes on a REJECT too, which is
    // exactly how the release path shipped refusing every episode it released while this
    // test stayed green.
    expect(settled?.policyDecision?.outcome).toBe("APPROVE");
    expect(settled?.status).toBe("PENDING");
  });

  it("does not refuse a released episode on regulatory facts the merchant has on file", async () => {
    // The test above asserts the released episode is no longer HELD_DEGRADED. A REJECT
    // satisfies that too, which is why this path shipped broken: `resumeHeldEpisode`
    // armed the gate with `nowIso` and passed no complianceContext, so every field
    // failed closed and the release refused on WA_OPT_IN_MISSING /
    // WA_OUTSIDE_SERVICE_WINDOW. Nothing about the customer had changed between the
    // two evaluations — only the code path had.
    const store = new RecoveryStore();
    await store.saveProfile(profile());
    const detector = new DegradationDetector(store);
    drive(detector, event());
    const { episode } = await processPaymentFailure(event(), store, policy, undefined, undefined, detector);
    expect(episode.status).toBe("HELD_DEGRADED");

    resetDegradationDetector();
    await recoverAfterRestart(store, fixedClock(Date.now()));
    await processDueDrains(store, fixedClock(Date.now() + DEGRADATION_CONFIG.DRAIN_JITTER_MS + 1));

    const settled = await store.getEpisode(episode.id);
    const reasons = (settled?.policyDecision?.reasons ?? []).join(",");
    for (const failClosed of ["WA_OPT_IN_MISSING", "WA_OUTSIDE_SERVICE_WINDOW", "DLT_TEMPLATE_MISSING"]) {
      expect(reasons).not.toContain(failClosed);
    }
  });

  it("leaves an episode held when its outage is genuinely still open", async () => {
    const store = new RecoveryStore();
    await store.saveProfile(profile());
    const detector = new DegradationDetector(store);
    drive(detector, event());
    const { episode } = await processPaymentFailure(event(), store, policy, undefined, undefined, detector);
    expect(episode.status).toBe("HELD_DEGRADED");
    await detector.persist();

    resetDegradationDetector();
    const recovery = await recoverAfterRestart(store, fixedClock(Date.now()));

    // The window is still open on the other side of the restart, so nothing is
    // released into an issuer that is still down.
    expect(recovery.rescheduled).not.toContain(episode.id);
    expect((await store.getEpisode(episode.id))?.status).toBe("HELD_DEGRADED");
  });

  it("a due drain is claimed by exactly one reader", async () => {
    const store = new RecoveryStore();
    await store.saveProfile(profile());
    const detector = new DegradationDetector(store);
    drive(detector, event());
    const { episode } = await processPaymentFailure(event(), store, policy, undefined, undefined, detector);
    await store.scheduleEpisodeDrain(episode.id, 1_000);

    const [a, b] = await Promise.all([store.claimDueDrains(2_000), store.claimDueDrains(2_000)]);

    expect([...a, ...b]).toEqual([episode.id]);
  });

  it("Postgres persists window state and claims drains in one statement", async () => {
    const { pool, store } = recordingStore();
    await store.saveDegradationState([{ keyString: "card|HDFC|VISA", baseline: 0.05, open: true, consecutiveBelow: 0, seenWindows: 9, attempts: 60, failures: 36, window: null, updatedAtMs: 1 }]);
    expect(pool.last().text).toMatch(/INSERT INTO degradation_state/);
    expect(pool.last().text).toMatch(/ON CONFLICT \(key_string\) DO UPDATE/);

    await store.claimDueDrains(5_000);
    expect(pool.last().text).toMatch(/UPDATE episode SET drain_due_at_ms = NULL/);
    expect(pool.last().text).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(RECOVEROS_SCHEMA).toMatch(/CREATE TABLE IF NOT EXISTS degradation_state/);
  });
});

// ===========================================================================
// Defect — one audit round trip per episode on every dashboard load

describe("batched audit lookup for the dashboard", () => {
  const auditFor = (episodeId: string, n: number) => ({
    auditId: `aud_${episodeId}_${n}`, episodeId, eventId: `evt_${episodeId}`, customerId: "cust_a", paymentId: `pay_${episodeId}`,
    timestamp: new Date(1_700_000_000_000 + n * 1_000).toISOString(), stage: (n === 0 ? "INGESTED" : "POLICY") as "INGESTED" | "POLICY", payload: { n },
  });

  it("in memory: returns exactly what per-episode getAudit returns, and an empty trail for unknown ids", async () => {
    const store = new RecoveryStore();
    await store.appendAudit(auditFor("ep_1", 0));
    await store.appendAudit(auditFor("ep_1", 1));
    await store.appendAudit(auditFor("ep_2", 0));
    const batched = await store.getAuditForEpisodes(["ep_1", "ep_2", "ep_none"]);
    expect(batched.ep_1).toEqual(await store.getAudit("ep_1"));
    expect(batched.ep_2).toEqual(await store.getAudit("ep_2"));
    expect(batched.ep_none).toEqual([]);
    expect(Object.keys(batched)).toEqual(["ep_1", "ep_2", "ep_none"]);
  });

  it("in Postgres: one query for any number of episodes, grouped by episode in time order, none for an empty list", async () => {
    const { pool, store } = recordingStore();
    pool.rows = [
      { id: "aud_ep_2_0", episode_id: "ep_2", event_id: "evt_ep_2", customer_id: "cust_a", payment_id: "pay_ep_2", stage: "INGESTED", payload_json: { n: 0 }, at_ms: "1700000000000" },
      { id: "aud_ep_1_0", episode_id: "ep_1", event_id: "evt_ep_1", customer_id: "cust_a", payment_id: "pay_ep_1", stage: "INGESTED", payload_json: { n: 0 }, at_ms: "1700000000000" },
      { id: "aud_ep_1_1", episode_id: "ep_1", event_id: "evt_ep_1", customer_id: "cust_a", payment_id: "pay_ep_1", stage: "POLICY", payload_json: { n: 1 }, at_ms: "1700000001000" },
    ];
    const batched = await store.getAuditForEpisodes(["ep_1", "ep_2", "ep_none"]);
    // The first statement on a fresh pool is the one-time schema bootstrap; every read after it counts.
    const reads = pool.queries.filter((q) => !q.text.includes("CREATE TABLE"));
    expect(reads).toHaveLength(1);
    expect(reads[0].text).toMatch(/WHERE episode_id = ANY\(\$1::text\[\]\) ORDER BY at_ms, seq/);
    expect(reads[0].values).toEqual([["ep_1", "ep_2", "ep_none"]]);
    // Same-millisecond rows must come back in the order they were written, in both forms.
    expect(RECOVEROS_SCHEMA).toMatch(/ALTER TABLE audit_event ADD COLUMN IF NOT EXISTS seq BIGSERIAL/);
    await store.getAudit("ep_1");
    expect(pool.last().text).toMatch(/WHERE episode_id = \$1 ORDER BY at_ms, seq/);
    expect(batched.ep_1.map((a) => a.auditId)).toEqual(["aud_ep_1_0", "aud_ep_1_1"]);
    expect(batched.ep_1[1]).toMatchObject({ stage: "POLICY", payload: { n: 1 }, timestamp: new Date(1_700_000_001_000).toISOString() });
    expect(batched.ep_2).toHaveLength(1);
    expect(batched.ep_none).toEqual([]);

    const { pool: emptyPool, store: emptyStore } = recordingStore();
    expect(await emptyStore.getAuditForEpisodes([])).toEqual({});
    expect(emptyPool.queries.filter((q) => !q.text.includes("CREATE TABLE"))).toHaveLength(0);
  });
});
