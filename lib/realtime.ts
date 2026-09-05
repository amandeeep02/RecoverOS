import { systemClock } from "@/lib/clock";

export interface StreamDegradationWindow {
  id: string;
  key: string;
  ratio: number;
  baselineRate: number;
  observedRate: number;
  attempts: number;
  episodesHeld: number;
  openedAtMs: number;
}

export type StreamEvent =
  | { type: "episode.created"; episode: { id: string; status: string; customerId: string; amountPaise: number; action?: string } }
  | { type: "episode.updated"; episode: { id: string; status: string; customerId: string; amountPaise: number; action?: string } }
  | { type: "ledger.updated"; ledger: { incrementalRecoveredPaise: number; protectedPaise: number; forgonePaise: number } }
  | { type: "degradation.opened"; window: StreamDegradationWindow }
  | { type: "degradation.closed"; window: { id: string; key: string; released: number; closedAtMs: number } }
  | { type: "degradation.drained"; window: { id: string; key: string; episodeId: string } }
  | { type: "heartbeat"; atMs: number };

/**
 * Listeners receive the SERVER's monotonic event id alongside the payload. The id
 * is the only thing that makes `last-event-id` resume mean anything: a stream that
 * renumbers from 0 on every connection hands the browser an id that addresses
 * nothing, and the reconnect silently replays or silently skips.
 */
type Listener = (event: StreamEvent, id: number) => void;

export class RealtimeServer {
  private listeners = new Set<Listener>();
  private eventId = 0;
  private ringBuffer: { id: number; event: StreamEvent }[] = [];
  private readonly maxRingSize = 200;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private clock = systemClock();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    this.startHeartbeat();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stopHeartbeat();
    };
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  get lastEventId(): number {
    return this.eventId;
  }

  emit(event: StreamEvent): number {
    const id = ++this.eventId;
    this.ringBuffer.push({ id, event });
    if (this.ringBuffer.length > this.maxRingSize) this.ringBuffer.shift();
    for (const listener of [...this.listeners]) {
      try { listener(event, id); } catch {}
    }
    return id;
  }

  /**
   * Replay window. Returns `null` when `lastId` is older than the ring buffer's
   * oldest retained event — the caller has a gap it cannot fill, and saying so is
   * the honest answer. Pretending the first retained event is the next one after
   * `lastId` would drop events without telling anybody.
   */
  getEventsSince(lastId: number): { id: number; event: StreamEvent }[] | null {
    if (lastId >= this.eventId) return [];
    const oldest = this.ringBuffer[0];
    if (oldest && lastId < oldest.id - 1) return null;
    return this.ringBuffer.filter((e) => e.id > lastId);
  }

  startHeartbeat(intervalMs = 15000) {
    if (this.heartbeatInterval) return;
    this.heartbeatInterval = setInterval(() => {
      this.emit({ type: "heartbeat", atMs: this.clock.now() });
    }, intervalMs);
    // Never hold the process open for a heartbeat.
    (this.heartbeatInterval as unknown as { unref?: () => void }).unref?.();
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }
}

const globalRealtime = globalThis as unknown as { recoverOsRealtime?: RealtimeServer };

export const realtimeServer = globalRealtime.recoverOsRealtime ?? (globalRealtime.recoverOsRealtime = new RealtimeServer());

/** SSE frame. `id:` carries the server's own event id so resume addresses something real. */
export function formatSSE(event: StreamEvent, id: number): string {
  return `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function createSSEStream(server: RealtimeServer, lastEventId?: string) {
  const parsed = lastEventId != null ? Number.parseInt(lastEventId, 10) : Number.NaN;
  const resumeFrom = Number.isFinite(parsed) ? parsed : null;
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let closed = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(chunk)); }
        catch { closed = true; unsubscribe?.(); }
      };

      // Tell the browser how fast to retry, and flush headers immediately.
      send(`retry: 3000\n\n`);

      if (resumeFrom !== null) {
        const missed = server.getEventsSince(resumeFrom);
        if (missed === null) {
          // The gap is larger than the ring buffer. Say so; the client refetches.
          send(`event: gap\ndata: ${JSON.stringify({ lastEventId: server.lastEventId })}\n\n`);
        } else {
          for (const { id, event } of missed) send(formatSSE(event, id));
        }
      }

      unsubscribe = server.subscribe((event, id) => send(formatSSE(event, id)));
    },
    cancel() {
      closed = true;
      unsubscribe?.();
      unsubscribe = null;
    },
  });
}
