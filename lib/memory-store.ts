import type { AuditEvent, CustomerProfile, CustomerResponse, ExecutionResult, RecoveryEpisode } from "@/lib/domain";
import type { PromiseToPay } from "@/lib/voice";

function copy<T>(value: T): T {
  return structuredClone(value);
}

/** In-memory persistence adapter. Used for tests and as the fallback when DATABASE_URL is unset. All methods are async. */
export class RecoveryStore {
  private readonly webhookEvents = new Map<string, string>();
  private readonly episodes = new Map<string, RecoveryEpisode>();
  private readonly profiles = new Map<string, CustomerProfile>();
  private readonly audits = new Map<string, ReadonlyArray<AuditEvent>>();
  private readonly executions = new Map<string, ExecutionResult>();
  private readonly promises = new Map<string, PromiseToPay[]>();

  async registerWebhook(eventId: string, episodeId: string) {
    if (this.webhookEvents.has(eventId)) return { inserted: false, episodeId: this.webhookEvents.get(eventId)! };
    this.webhookEvents.set(eventId, episodeId);
    return { inserted: true, episodeId };
  }

  async getEpisodeByWebhook(eventId: string) {
    const episodeId = this.webhookEvents.get(eventId);
    return episodeId ? this.getEpisode(episodeId) : undefined;
  }

  async getEpisodeByCallSid(callSid: string) {
    return (await this.listEpisodes()).find((episode) => episode.execution?.externalReference === callSid);
  }

  async getLatestEpisodeByPhone(phone: string) {
    return (await this.listEpisodes()).find((episode) => episode.profile.phone === phone);
  }

  async appendCustomerResponse(episodeId: string, response: CustomerResponse) {
    const episode = await this.getEpisode(episodeId);
    if (!episode) return undefined;
    return this.saveEpisode({ ...episode, customerResponses: [...episode.customerResponses, response], updatedAt: new Date().toISOString() });
  }

  async saveEpisode(episode: RecoveryEpisode) {
    this.episodes.set(episode.id, copy(episode));
    return (await this.getEpisode(episode.id))!;
  }

  async getEpisode(id: string) {
    const value = this.episodes.get(id);
    return value ? copy(value) : undefined;
  }

  async listEpisodes() {
    return [...this.episodes.values()].map(copy).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async saveProfile(profile: CustomerProfile) {
    this.profiles.set(`${profile.merchantId}:${profile.customerId}`, copy(profile));
  }

  async getProfile(merchantId: string, customerId: string) {
    const value = this.profiles.get(`${merchantId}:${customerId}`);
    return value ? copy(value) : undefined;
  }

  async appendAudit(event: AuditEvent) {
    const existing = this.audits.get(event.episodeId) ?? [];
    if (existing.some((entry) => entry.auditId === event.auditId)) throw new Error(`Audit event ${event.auditId} already exists`);
    const immutable = Object.freeze(copy(event));
    this.audits.set(event.episodeId, Object.freeze([...existing, immutable]));
  }

  async getAudit(episodeId: string) {
    return (this.audits.get(episodeId) ?? []).map(copy);
  }

  async getExecution(idempotencyKey: string) {
    const value = this.executions.get(idempotencyKey);
    return value ? copy(value) : undefined;
  }

  async saveExecution(idempotencyKey: string, episodeId: string, action: string, execution: ExecutionResult) {
    this.executions.set(idempotencyKey, copy(execution));
  }

  async getPromises(episodeId: string) {
    return (this.promises.get(episodeId) ?? []).map(copy);
  }

  async savePromises(episodeId: string, promises: PromiseToPay[]) {
    this.promises.set(episodeId, promises.map(copy));
  }

  async reset() {
    this.webhookEvents.clear();
    this.episodes.clear();
    this.profiles.clear();
    this.audits.clear();
    this.executions.clear();
  }
}
