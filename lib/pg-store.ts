import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import type { AuditEvent, CustomerProfile, CustomerResponse, ExecutionResult, RecoveryEpisode } from "@/lib/domain";
import type { PromiseToPay } from "@/lib/voice";
import {
  CONTACT_ACTIONS,
  DELIVERED_EXECUTION_STATUSES,
  MAX_PROCESSING_ATTEMPTS,
  RecoveryStore,
  type EpisodeProcessing,
  type PersistedDegradationState,
  type ProcessingState,
} from "@/lib/memory-store";

// THE schema. `schema.sql` used to sit beside this declaring eight tables to this
// constant's six, and only this one was ever executed — so the file a reader would
// naturally trust was the one the database had never seen. One source of truth.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS ingested_webhook (
  event_id   TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL,
  at_ms      BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS episode (
  id                      TEXT PRIMARY KEY,
  event_id                TEXT UNIQUE NOT NULL,
  customer_id             TEXT NOT NULL,
  amount_paise            BIGINT NOT NULL,
  status                  TEXT NOT NULL,
  event_json              JSONB NOT NULL,
  profile_json            JSONB NOT NULL,
  diagnosis_json          JSONB,
  prediction_json         JSONB,
  eir_json                JSONB,
  proposal_json           JSONB,
  policy_decision_json    JSONB,
  execution_json          JSONB,
  outcome_json            JSONB,
  customer_responses_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  automated_attempts      INTEGER NOT NULL DEFAULT 0,
  reminder_count          INTEGER NOT NULL DEFAULT 0,
  voice_call_count        INTEGER NOT NULL DEFAULT 0,
  created_at_ms           BIGINT NOT NULL,
  updated_at_ms           BIGINT NOT NULL,
  processing_state        TEXT NOT NULL DEFAULT 'DONE',
  claimed_at_ms           BIGINT,
  processing_attempts     INTEGER NOT NULL DEFAULT 0,
  drain_due_at_ms         BIGINT
);
-- A table created by an earlier deploy predates the four columns above. Adding them
-- here rather than in a migration folder keeps the promise this constant makes: it
-- is the whole schema, and running it against any prior version produces the current
-- one. All four are nullable or defaulted, so the add is not a rewrite.
ALTER TABLE episode ADD COLUMN IF NOT EXISTS processing_state    TEXT NOT NULL DEFAULT 'DONE';
ALTER TABLE episode ADD COLUMN IF NOT EXISTS claimed_at_ms       BIGINT;
ALTER TABLE episode ADD COLUMN IF NOT EXISTS processing_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE episode ADD COLUMN IF NOT EXISTS drain_due_at_ms     BIGINT;

CREATE INDEX IF NOT EXISTS idx_episode_status ON episode(status);
CREATE INDEX IF NOT EXISTS idx_episode_phone ON episode ((profile_json->>'phone'));
CREATE INDEX IF NOT EXISTS idx_episode_execution_ref ON episode ((execution_json->>'externalReference'));
-- Contact fatigue asks "how many times have we reached THIS customer lately". Without
-- this the question was answered by reading the whole table into Node and
-- deserialising seven JSONB columns per row on every payment.failed.
CREATE INDEX IF NOT EXISTS idx_episode_contact_history
  ON episode ((event_json->>'merchantId'), customer_id, created_at_ms DESC);
-- The work queue. Partial, so it holds only the rows a worker can claim rather than
-- one entry per episode ever ingested.
CREATE INDEX IF NOT EXISTS idx_episode_processing
  ON episode (processing_state, created_at_ms)
  WHERE processing_state <> 'DONE';
-- Held episodes waiting for their jittered requeue.
CREATE INDEX IF NOT EXISTS idx_episode_drain_due
  ON episode (drain_due_at_ms)
  WHERE drain_due_at_ms IS NOT NULL;

CREATE TABLE IF NOT EXISTS customer_profile (
  merchant_id   TEXT NOT NULL,
  customer_id   TEXT NOT NULL,
  profile_json  JSONB NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (merchant_id, customer_id)
);

CREATE TABLE IF NOT EXISTS audit_event (
  id           TEXT PRIMARY KEY,
  episode_id   TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  customer_id  TEXT NOT NULL,
  payment_id   TEXT NOT NULL,
  stage        TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  at_ms        BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_episode ON audit_event(episode_id, at_ms);
-- Insertion order. Several audit rows of one episode can share a millisecond (a fixed
-- clock, a fast local store), and ORDER BY at_ms alone leaves their order to the sort
-- algorithm. Backfills existing rows in heap order, which for an append-only table is
-- the order they were written.
ALTER TABLE audit_event ADD COLUMN IF NOT EXISTS seq BIGSERIAL;

CREATE TABLE IF NOT EXISTS execution_log (
  id              TEXT PRIMARY KEY,
  episode_id      TEXT NOT NULL,
  action          TEXT NOT NULL,
  status          TEXT NOT NULL,
  executor        TEXT NOT NULL,
  external_ref    TEXT,
  idempotency_key TEXT UNIQUE NOT NULL,
  error           TEXT,
  executed_at_ms  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_execution_episode ON execution_log(episode_id);

CREATE TABLE IF NOT EXISTS promise_to_pay (
  id                    TEXT PRIMARY KEY,
  episode_id            TEXT NOT NULL,
  promised_amount_paise BIGINT NOT NULL,
  promised_at_ms        BIGINT NOT NULL,
  due_by_ms             BIGINT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'PENDING',
  customer_acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  call_id               TEXT
);
CREATE INDEX IF NOT EXISTS idx_promise_episode ON promise_to_pay(episode_id);

-- The issuer-degradation detector's memory. The EWMA baseline, the open window and
-- the hysteresis counter are state, not cache: a process that loses them re-arms an
-- outage that already ended, and two instances behind a load balancer hold two
-- different baselines for the same issuer.
CREATE TABLE IF NOT EXISTS degradation_state (
  key_string    TEXT PRIMARY KEY,
  state_json    JSONB NOT NULL,
  updated_at_ms BIGINT NOT NULL
);
`;

/** Exported so the schema can be asserted on without a live database. */
export const RECOVEROS_SCHEMA = SCHEMA;

interface EpisodeRow extends Record<string, unknown> {
  id: string;
  event_id: string;
  event_json: RecoveryEpisode["event"];
  profile_json: CustomerProfile;
  diagnosis_json: RecoveryEpisode["diagnosis"];
  prediction_json: RecoveryEpisode["prediction"];
  eir_json: RecoveryEpisode["eir"];
  proposal_json: RecoveryEpisode["proposal"];
  policy_decision_json: RecoveryEpisode["policyDecision"];
  execution_json: RecoveryEpisode["execution"];
  outcome_json: RecoveryEpisode["outcome"];
  customer_responses_json: CustomerResponse[];
  automated_attempts: number;
  reminder_count: number;
  voice_call_count: number;
  created_at_ms: number;
  updated_at_ms: number;
}

/**
 * NOTE: this `extends` the in-memory store, which makes every override optional —
 * a method added to the base class later would be silently inherited here and would
 * write to an in-memory Map while callers believed it was durable. Moving to a shared
 * interface is the real fix; until then `tests/recovery-engine.test.ts` asserts that
 * every base method is overridden, so the gap fails CI rather than losing data.
 */
type AuditRow = { id: string; episode_id: string; event_id: string; customer_id: string; payment_id: string; stage: AuditEvent["stage"]; payload_json: Record<string, unknown>; at_ms: string };

function auditFromRow(row: AuditRow): AuditEvent {
  return {
    auditId: row.id,
    episodeId: row.episode_id,
    eventId: row.event_id,
    customerId: row.customer_id,
    paymentId: row.payment_id,
    timestamp: new Date(Number(row.at_ms)).toISOString(),
    stage: row.stage,
    payload: row.payload_json,
  };
}

export class PostgresRecoveryStore extends RecoveryStore {
  private readonly pool: Pool;
  private ready: Promise<void>;

  /**
   * `pool` is injectable so the SQL this class emits can be asserted on without a
   * live Postgres. The queries below are the whole point of the class; a test that
   * cannot read them can only check that the in-memory adapter still works.
   */
  constructor(connectionString: string, pool?: Pool) {
    super();
    this.pool = pool ?? new Pool({ connectionString, max: 5 });
    this.ready = this.pool.query(SCHEMA).then(() => undefined);
  }

  private async q<T extends import("pg").QueryResultRow = EpisodeRow>(text: string, values: unknown[] = []) {
    await this.ready;
    return this.pool.query<T>(text, values);
  }

  private static rowToEpisode(row: EpisodeRow): RecoveryEpisode {
    return {
      id: row.id,
      event: row.event_json,
      profile: row.profile_json,
      status: row.status as RecoveryEpisode["status"],
      automatedAttemptCount: Number(row.automated_attempts),
      reminderCount: Number(row.reminder_count),
      voiceCallCount: Number(row.voice_call_count),
      diagnosis: row.diagnosis_json,
      prediction: row.prediction_json,
      eir: row.eir_json,
      proposal: row.proposal_json,
      policyDecision: row.policy_decision_json,
      execution: row.execution_json,
      outcome: row.outcome_json,
      customerResponses: row.customer_responses_json ?? [],
      createdAt: new Date(Number(row.created_at_ms)).toISOString(),
      updatedAt: new Date(Number(row.updated_at_ms)).toISOString(),
    };
  }

  private static episodeToRow(ep: RecoveryEpisode) {
    return [
      ep.id,
      ep.event.eventId,
      ep.event.customerId,
      ep.event.amountPaise,
      ep.status,
      JSON.stringify(ep.event),
      JSON.stringify(ep.profile),
      ep.diagnosis ? JSON.stringify(ep.diagnosis) : null,
      ep.prediction ? JSON.stringify(ep.prediction) : null,
      ep.eir ? JSON.stringify(ep.eir) : null,
      ep.proposal ? JSON.stringify(ep.proposal) : null,
      ep.policyDecision ? JSON.stringify(ep.policyDecision) : null,
      ep.execution ? JSON.stringify(ep.execution) : null,
      ep.outcome ? JSON.stringify(ep.outcome) : null,
      JSON.stringify(ep.customerResponses ?? []),
      ep.automatedAttemptCount,
      ep.reminderCount,
      ep.voiceCallCount,
      new Date(ep.createdAt).getTime(),
      new Date(ep.updatedAt).getTime(),
    ];
  }

  private static readonly EPISODE_COLUMNS = `id, event_id, status, event_json, profile_json, diagnosis_json, prediction_json, eir_json, proposal_json, policy_decision_json, execution_json, outcome_json, customer_responses_json, automated_attempts, reminder_count, voice_call_count, created_at_ms, updated_at_ms`;

  private static readonly EPISODE_INSERT_COLUMNS = `id, event_id, customer_id, amount_paise, status, event_json, profile_json, diagnosis_json, prediction_json, eir_json, proposal_json, policy_decision_json, execution_json, outcome_json, customer_responses_json, automated_attempts, reminder_count, voice_call_count, created_at_ms, updated_at_ms`;

  override async registerWebhook(eventId: string, episodeId: string) {
    const result = await this.q(
      `INSERT INTO ingested_webhook (event_id, episode_id, at_ms) VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING`,
      [eventId, episodeId, Date.now()],
    );
    return { inserted: (result.rowCount ?? 0) === 1, episodeId };
  }

  override async getEpisodeByWebhook(eventId: string) {
    const result = await this.q(`SELECT ${PostgresRecoveryStore.EPISODE_COLUMNS} FROM episode WHERE event_id = $1`, [eventId]);
    return result.rows[0] ? PostgresRecoveryStore.rowToEpisode(result.rows[0] as EpisodeRow) : undefined;
  }

  override async saveEpisode(episode: RecoveryEpisode) {
    const row = PostgresRecoveryStore.episodeToRow(episode);
    await this.q(
      `INSERT INTO episode (${PostgresRecoveryStore.EPISODE_INSERT_COLUMNS})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         event_json = EXCLUDED.event_json,
         profile_json = EXCLUDED.profile_json,
         diagnosis_json = EXCLUDED.diagnosis_json,
         prediction_json = EXCLUDED.prediction_json,
         eir_json = EXCLUDED.eir_json,
         proposal_json = EXCLUDED.proposal_json,
         policy_decision_json = EXCLUDED.policy_decision_json,
         execution_json = EXCLUDED.execution_json,
         outcome_json = EXCLUDED.outcome_json,
         customer_responses_json = EXCLUDED.customer_responses_json,
         automated_attempts = EXCLUDED.automated_attempts,
         reminder_count = EXCLUDED.reminder_count,
         voice_call_count = EXCLUDED.voice_call_count,
         updated_at_ms = EXCLUDED.updated_at_ms`,
      row,
    );
    return episode;
  }

  override async getEpisode(id: string) {
    const result = await this.q(`SELECT ${PostgresRecoveryStore.EPISODE_COLUMNS} FROM episode WHERE id = $1`, [id]);
    return result.rows[0] ? PostgresRecoveryStore.rowToEpisode(result.rows[0] as EpisodeRow) : undefined;
  }

  override async listEpisodes() {
    const result = await this.q(`SELECT ${PostgresRecoveryStore.EPISODE_COLUMNS} FROM episode ORDER BY created_at_ms DESC`);
    return result.rows.map((row) => PostgresRecoveryStore.rowToEpisode(row as EpisodeRow));
  }

  override async saveProfile(profile: CustomerProfile) {
    await this.q(
      `INSERT INTO customer_profile (merchant_id, customer_id, profile_json, updated_at_ms) VALUES ($1, $2, $3, $4)
       ON CONFLICT (merchant_id, customer_id) DO UPDATE SET profile_json = EXCLUDED.profile_json, updated_at_ms = EXCLUDED.updated_at_ms`,
      [profile.merchantId, profile.customerId, JSON.stringify(profile), Date.now()],
    );
  }

  override async getProfile(merchantId: string, customerId: string) {
    const result = await this.q<{ profile_json: CustomerProfile }>(`SELECT profile_json FROM customer_profile WHERE merchant_id = $1 AND customer_id = $2`, [merchantId, customerId]);
    return result.rows[0]?.profile_json;
  }

  override async appendAudit(event: AuditEvent) {
    await this.q(
      `INSERT INTO audit_event (id, episode_id, event_id, customer_id, payment_id, stage, payload_json, at_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO NOTHING`,
      [event.auditId, event.episodeId, event.eventId, event.customerId, event.paymentId, event.stage, JSON.stringify(event.payload), new Date(event.timestamp).getTime()],
    );
  }

  override async getAudit(episodeId: string): Promise<AuditEvent[]> {
    const result = await this.q<AuditRow>(
      `SELECT id, episode_id, event_id, customer_id, payment_id, stage, payload_json, at_ms FROM audit_event WHERE episode_id = $1 ORDER BY at_ms, seq`,
      [episodeId],
    );
    return result.rows.map(auditFromRow);
  }

  /**
   * One round trip for the whole dashboard. The per-episode form above, awaited in a
   * loop, cost one network round trip per episode — ~65 ms each against a remote
   * Postgres, so the page took as many seconds as it had hundreds of episodes.
   */
  override async getAuditForEpisodes(episodeIds: ReadonlyArray<string>): Promise<Record<string, AuditEvent[]>> {
    const audits: Record<string, AuditEvent[]> = {};
    for (const id of episodeIds) audits[id] = [];
    if (episodeIds.length === 0) return audits;
    const result = await this.q<AuditRow>(
      `SELECT id, episode_id, event_id, customer_id, payment_id, stage, payload_json, at_ms FROM audit_event WHERE episode_id = ANY($1::text[]) ORDER BY at_ms, seq`,
      [[...episodeIds]],
    );
    for (const row of result.rows) (audits[row.episode_id] ??= []).push(auditFromRow(row));
    return audits;
  }

  override async getExecution(idempotencyKey: string) {
    const result = await this.q<{ id: string; status: ExecutionResult["status"]; executor: string; external_ref: string | null; error: string | null; executed_at_ms: string }>(
      `SELECT id, status, executor, external_ref, error, executed_at_ms FROM execution_log WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      actionId: row.id,
      status: row.status,
      executor: row.executor as ExecutionResult["executor"],
      externalReference: row.external_ref || null,
      idempotentReplay: true,
      error: row.error || null,
      executedAt: new Date(Number(row.executed_at_ms)).toISOString(),
    } satisfies ExecutionResult;
  }

  override async saveExecution(idempotencyKey: string, episodeId: string, action: string, execution: ExecutionResult) {
    await this.q(
      `INSERT INTO execution_log (id, episode_id, action, status, executor, external_ref, idempotency_key, error, executed_at_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [execution.actionId || randomUUID(), episodeId, action, execution.status, execution.executor, execution.externalReference, idempotencyKey, execution.error, new Date(execution.executedAt).getTime()],
    );
  }

  override async getPromises(episodeId: string): Promise<PromiseToPay[]> {
    const result = await this.q<{ id: string; episode_id: string; promised_amount_paise: string; promised_at_ms: string; due_by_ms: string; status: PromiseToPay["status"]; customer_acknowledged: boolean; call_id: string | null }>(
      `SELECT id, episode_id, promised_amount_paise, promised_at_ms, due_by_ms, status, customer_acknowledged, call_id FROM promise_to_pay WHERE episode_id = $1 ORDER BY promised_at_ms`,
      [episodeId],
    );
    return result.rows.map((row) => ({
      promiseId: row.id,
      episodeId: row.episode_id,
      promisedAmountPaise: Number(row.promised_amount_paise),
      promisedAt: new Date(Number(row.promised_at_ms)).toISOString(),
      dueBy: new Date(Number(row.due_by_ms)).toISOString(),
      status: row.status,
      customerAcknowledged: row.customer_acknowledged,
      callId: row.call_id ?? undefined,
    }));
  }

  override async savePromises(episodeId: string, promises: PromiseToPay[]) {
    for (const p of promises) {
      await this.q(
        `INSERT INTO promise_to_pay (id, episode_id, promised_amount_paise, promised_at_ms, due_by_ms, status, customer_acknowledged, call_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO NOTHING`,
        [p.promiseId, p.episodeId, p.promisedAmountPaise, new Date(p.promisedAt).getTime(), new Date(p.dueBy).getTime(), p.status, p.customerAcknowledged, p.callId ?? null],
      );
    }
  }

  override async getEpisodeByCallSid(callSid: string) {
    const result = await this.q(`SELECT ${PostgresRecoveryStore.EPISODE_COLUMNS} FROM episode WHERE execution_json->>'externalReference' = $1 ORDER BY created_at_ms DESC LIMIT 1`, [callSid]);
    return result.rows[0] ? PostgresRecoveryStore.rowToEpisode(result.rows[0] as EpisodeRow) : undefined;
  }

  override async getLatestEpisodeByPhone(phone: string) {
    const result = await this.q(`SELECT ${PostgresRecoveryStore.EPISODE_COLUMNS} FROM episode WHERE profile_json->>'phone' = $1 ORDER BY created_at_ms DESC LIMIT 1`, [phone]);
    return result.rows[0] ? PostgresRecoveryStore.rowToEpisode(result.rows[0] as EpisodeRow) : undefined;
  }

  override async appendCustomerResponse(episodeId: string, response: CustomerResponse) {
    const episode = await this.getEpisode(episodeId);
    if (!episode) return undefined;
    return this.saveEpisode({ ...episode, customerResponses: [...episode.customerResponses, response], updatedAt: new Date().toISOString() });
  }

  /**
   * An indexed `COUNT`, not a table read.
   *
   * `executedAt` is compared as text: every writer produces it with
   * `Date.prototype.toISOString`, so the values are fixed-width UTC and sort
   * lexicographically in timestamp order. A `::timestamptz` cast would throw on one
   * malformed row and take the webhook path down with it; this cannot.
   */
  override async countContactsSince(merchantId: string, customerId: string, sinceMs: number, excludeEpisodeId?: string): Promise<number> {
    const result = await this.q<{ n: string }>(
      `SELECT COUNT(*) AS n FROM episode
        WHERE event_json->>'merchantId' = $1
          AND customer_id = $2
          AND ($4::text IS NULL OR id <> $4)
          AND execution_json->>'status' = ANY($5::text[])
          AND COALESCE(policy_decision_json->>'allowedAction', proposal_json->>'action') = ANY($6::text[])
          AND execution_json->>'executedAt' >= $3`,
      [merchantId, customerId, new Date(sinceMs).toISOString(), excludeEpisodeId ?? null, [...DELIVERED_EXECUTION_STATUSES], [...CONTACT_ACTIONS]],
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  override async listEpisodesByStatus(status: RecoveryEpisode["status"], limit = 1_000): Promise<RecoveryEpisode[]> {
    const result = await this.q(
      `SELECT ${PostgresRecoveryStore.EPISODE_COLUMNS} FROM episode WHERE status = $1 ORDER BY created_at_ms DESC LIMIT $2`,
      [status, limit],
    );
    return result.rows.map((row) => PostgresRecoveryStore.rowToEpisode(row as EpisodeRow));
  }

  override async markEpisodeQueued(episodeId: string): Promise<void> {
    await this.q(`UPDATE episode SET processing_state = 'PENDING', claimed_at_ms = NULL WHERE id = $1 AND processing_state <> 'PROCESSING'`, [episodeId]);
  }

  /**
   * The durable claim. `FOR UPDATE SKIP LOCKED` is what lets two instances share the
   * queue without a broker: each takes a different row and neither blocks. A claim
   * older than `claimTimeoutMs` is abandoned — that is the crash-recovery path, and
   * the reason a redeploy mid-episode does not orphan the work.
   */
  override async claimEpisodeForProcessing(nowMs: number, claimTimeoutMs: number, maxAttempts = MAX_PROCESSING_ATTEMPTS): Promise<RecoveryEpisode | undefined> {
    const result = await this.q(
      `UPDATE episode SET processing_state = 'PROCESSING', claimed_at_ms = $1, processing_attempts = processing_attempts + 1
        WHERE id = (
          SELECT id FROM episode
           WHERE processing_attempts < $3
             AND (processing_state = 'PENDING' OR (processing_state = 'PROCESSING' AND claimed_at_ms IS NOT NULL AND claimed_at_ms <= $2))
           ORDER BY created_at_ms
           LIMIT 1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING ${PostgresRecoveryStore.EPISODE_COLUMNS}`,
      [nowMs, nowMs - claimTimeoutMs, maxAttempts],
    );
    return result.rows[0] ? PostgresRecoveryStore.rowToEpisode(result.rows[0] as EpisodeRow) : undefined;
  }

  override async completeEpisodeProcessing(episodeId: string, state: Extract<ProcessingState, "DONE" | "FAILED">): Promise<void> {
    await this.q(`UPDATE episode SET processing_state = $2, claimed_at_ms = NULL WHERE id = $1`, [episodeId, state]);
  }

  override async getEpisodeProcessing(episodeId: string): Promise<EpisodeProcessing | undefined> {
    const result = await this.q<{ processing_state: ProcessingState; claimed_at_ms: string | null; processing_attempts: number; drain_due_at_ms: string | null }>(
      `SELECT processing_state, claimed_at_ms, processing_attempts, drain_due_at_ms FROM episode WHERE id = $1`,
      [episodeId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      state: row.processing_state,
      claimedAtMs: row.claimed_at_ms === null ? null : Number(row.claimed_at_ms),
      attempts: Number(row.processing_attempts),
      drainDueAtMs: row.drain_due_at_ms === null ? null : Number(row.drain_due_at_ms),
    };
  }

  override async scheduleEpisodeDrain(episodeId: string, dueAtMs: number): Promise<void> {
    await this.q(`UPDATE episode SET drain_due_at_ms = $2 WHERE id = $1`, [episodeId, dueAtMs]);
  }

  /** Claim and clear in one statement, so exactly one instance drains each episode. */
  override async claimDueDrains(nowMs: number, limit = 200): Promise<string[]> {
    const result = await this.q<{ id: string }>(
      `UPDATE episode SET drain_due_at_ms = NULL
        WHERE id IN (
          SELECT id FROM episode
           WHERE drain_due_at_ms IS NOT NULL AND drain_due_at_ms <= $1 AND status = 'HELD_DEGRADED'
           ORDER BY drain_due_at_ms
           LIMIT $2
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id`,
      [nowMs, limit],
    );
    return result.rows.map((row) => row.id);
  }

  override async saveDegradationState(states: ReadonlyArray<PersistedDegradationState>): Promise<void> {
    for (const state of states) {
      await this.q(
        `INSERT INTO degradation_state (key_string, state_json, updated_at_ms) VALUES ($1, $2, $3)
         ON CONFLICT (key_string) DO UPDATE SET state_json = EXCLUDED.state_json, updated_at_ms = EXCLUDED.updated_at_ms`,
        [state.keyString, JSON.stringify(state), state.updatedAtMs],
      );
    }
  }

  override async loadDegradationState(): Promise<PersistedDegradationState[]> {
    const result = await this.q<{ state_json: PersistedDegradationState }>(`SELECT state_json FROM degradation_state`);
    return result.rows.map((row) => row.state_json);
  }

  override async reset() {
    await this.ready;
    await this.pool.query(`TRUNCATE episode, customer_profile, audit_event, execution_log, promise_to_pay, ingested_webhook, degradation_state`);
  }
}
