import { NextResponse } from "next/server";
import { getDashboardSnapshot } from "@/app/_lib/dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Full refetch. The client calls this when the SSE stream reports a gap wider
 *  than the server's replay buffer, rather than running on state it knows is stale. */
export async function GET() {
  return NextResponse.json(await getDashboardSnapshot());
}
