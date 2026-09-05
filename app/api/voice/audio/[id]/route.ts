import { NextRequest, NextResponse } from "next/server";
import { getCachedVoiceAudio } from "@/lib/voice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Serves the ElevenLabs clip for one call to Twilio's `<Play>`. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const audio = getCachedVoiceAudio(id);
  if (!audio) return NextResponse.json({ error: "No audio for this call" }, { status: 404 });
  return new NextResponse(new Uint8Array(audio), { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
}
