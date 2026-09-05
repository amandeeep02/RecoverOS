import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { buildDegradationView } from "@/app/_lib/dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const episodes = await store.listEpisodes();
  return NextResponse.json(buildDegradationView(episodes));
}
