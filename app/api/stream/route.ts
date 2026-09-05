import { NextRequest } from "next/server";
import { realtimeServer, createSSEStream } from "@/lib/realtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Serverless platforms cap a response's lifetime. The browser's EventSource reconnects
// on its own with Last-Event-ID and the server replays the gap from its ring buffer.
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  // EventSource sends `Last-Event-ID` on reconnect. A query parameter is accepted
  // too, because `fetch`-based clients cannot set that header on a reconnect.
  const lastEventId =
    request.headers.get("last-event-id") ?? request.nextUrl.searchParams.get("lastEventId");

  const stream = createSSEStream(realtimeServer, lastEventId ?? undefined);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
