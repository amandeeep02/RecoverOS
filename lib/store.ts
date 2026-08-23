import type { AuditEvent, CustomerProfile, ExecutionResult, RecoveryEpisode } from "@/lib/domain";
import type { PromiseToPay } from "@/lib/voice";

function copy<T>(value: T): T {
  return structuredClone(value);
}

/** Development persistence adapter. Replace this interface with Postgres in deployment. */
export class RecoveryStore {
  private readonly webhookEvents = new Map<string, string>();
  private readonly episodes = new Map<string, RecoveryEpisode>();
  private readonly profiles = new Map<string, CustomerProfile>();
  private readonly audits = new Map<string, ReadonlyArray<AuditEvent>>();
  private readonly executions = new Map<string, ExecutionResult>();
  private readonly promises = new Map<string, PromiseToPay[]>();

  registerWebhook(eventId: string, episodeId: string) {
    if (this.webhookEvents.has(eventId)) return { inserted: false, episodeId: this.webhookEvents.get(eventId)! };
    this.webhookEvents.set(eventId, episodeId);
    return { inserted: true, episodeId };
  }

  getEpisodeByWebhook(eventId: string) {
    const episodeId = this.webhookEvents.get(eventId);
    return episodeId ? this.getEpisode(episodeId) : undefined;
  }

  saveEpisode(episode: RecoveryEpisode) {
    this.episodes.set(episode.id, copy(episode));
    return this.getEpisode(episode.id)!;
  }

  getEpisode(id: string) {
    const value = this.episodes.get(id);
    return value ? copy(value) : undefined;
  }

  listEpisodes() {
    return [...this.episodes.values()].map(copy).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  saveProfile(profile: CustomerProfile) {
    this.profiles.set(`${profile.merchantId}:${profile.customerId}`, copy(profile));
  }

  getProfile(merchantId: string, customerId: string) {
    const value = this.profiles.get(`${merchantId}:${customerId}`);
    return value ? copy(value) : undefined;
  }

  appendAudit(event: AuditEvent) {
    const existing = this.audits.get(event.episodeId) ?? [];
    if (existing.some((entry) => entry.auditId === event.auditId)) throw new Error(`Audit event ${event.auditId} already exists`);
    const immutable = Object.freeze(copy(event));
    this.audits.set(event.episodeId, Object.freeze([...existing, immutable]));
  }

  getAudit(episodeId: string) {
    return (this.audits.get(episodeId) ?? []).map(copy);
  }

  getExecution(idempotencyKey: string) {
    const value = this.executions.get(idempotencyKey);
    return value ? copy(value) : undefined;
  }

  saveExecution(idempotencyKey: string, execution: ExecutionResult) {
    this.executions.set(idempotencyKey, copy(execution));
  }

  getPromises(episodeId: string) {
    return (this.promises.get(episodeId) ?? []).map(copy);
  }

  savePromises(episodeId: string, promises: PromiseToPay[]) {
    this.promises.set(episodeId, promises.map(copy));
  }

  reset() {
    this.webhookEvents.clear();
    this.episodes.clear();
    this.profiles.clear();
    this.audits.clear();
    this.executions.clear();
  }
}

const globalStore = globalThis as unknown as { recoverOsStore?: RecoveryStore };
export const store = globalStore.recoverOsStore ?? (globalStore.recoverOsStore = new RecoveryStore());
