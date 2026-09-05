"use client";

import { useEffect, useRef, useState } from "react";
import type { StreamEvent } from "@/lib/realtime";

export type ConnectionState = "connecting" | "open" | "closed";

/**
 * Subscribes the browser to `/api/stream`.
 *
 * The previous components imported `realtimeServer` — the SERVER singleton — from a
 * `"use client"` file. That compiles, mounts, and can never deliver anything: the
 * bundle gets a second, empty `RealtimeServer` instance living in the tab, with no
 * connection to the process that emits. Nothing was broken at runtime and nothing
 * ever arrived. The transport has to be the SSE endpoint.
 *
 * `EventSource` resends the last `id:` it saw as `Last-Event-ID` on reconnect, which
 * is why the server now writes its own monotonic id into every frame. When the gap
 * is wider than the server's ring buffer it says so with an `event: gap` frame, and
 * we call `onGap` so the page refetches instead of quietly running on stale state.
 */
export function useRealtime(
  onEvent: (event: StreamEvent) => void,
  onGap?: () => void,
): ConnectionState {
  const [state, setState] = useState<ConnectionState>("connecting");
  const handlerRef = useRef(onEvent);
  const gapRef = useRef(onGap);
  handlerRef.current = onEvent;
  gapRef.current = onGap;

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    const source = new EventSource("/api/stream");

    const onMessage = (message: MessageEvent<string>) => {
      try {
        handlerRef.current(JSON.parse(message.data) as StreamEvent);
      } catch {
        // A frame we cannot parse is dropped rather than crashing the dashboard.
      }
    };
    const onOpen = () => setState("open");
    const onError = () => setState("connecting"); // EventSource retries on its own.
    const onGapFrame = () => gapRef.current?.();

    source.addEventListener("message", onMessage);
    source.addEventListener("open", onOpen);
    source.addEventListener("error", onError);
    source.addEventListener("gap", onGapFrame);

    return () => {
      source.removeEventListener("message", onMessage);
      source.removeEventListener("open", onOpen);
      source.removeEventListener("error", onError);
      source.removeEventListener("gap", onGapFrame);
      source.close();
      setState("closed");
    };
  }, []);

  return state;
}
