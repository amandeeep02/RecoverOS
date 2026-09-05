import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [episode, audit] = await Promise.all([store.getEpisode(id), store.getAudit(id)]);
  if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });
  return NextResponse.json({ episode, audit });
}
