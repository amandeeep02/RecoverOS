import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/store";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const episode = store.getEpisode(id);
  if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });
  return NextResponse.json({ episode, audit: store.getAudit(id) });
}
