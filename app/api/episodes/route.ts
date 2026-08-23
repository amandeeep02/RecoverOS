import { NextResponse } from "next/server";
import { store } from "@/lib/store";

export function GET() {
  return NextResponse.json({ episodes: store.listEpisodes() });
}
