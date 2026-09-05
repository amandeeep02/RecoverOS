import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { tickDegradation } from "@/lib/pipeline";
import { buildDegradationView } from "@/app/_lib/dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Closes the current 15-minute window immediately. The detector's arithmetic is
 *  untouched; only the cadence is advanced. */
export async function POST() {
  const result = await tickDegradation(store);
  const episodes = await store.listEpisodes();
  return NextResponse.json({
    opened: result.opened.length,
    closed: result.closed.length,
    drainScheduled: result.drainScheduled,
    degradation: buildDegradationView(episodes),
  });
}
