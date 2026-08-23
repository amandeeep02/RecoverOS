import { NextRequest, NextResponse } from "next/server";
import { observeOutcome } from "@/lib/pipeline";
import { store } from "@/lib/store";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = await request.json() as { status?: "RECOVERED" | "FAILED" | "EXPIRED" };
    if (!body.status || !["RECOVERED", "FAILED", "EXPIRED"].includes(body.status)) throw new Error("status must be RECOVERED, FAILED, or EXPIRED");
    return NextResponse.json({ episode: observeOutcome(id, body.status, store) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not record outcome" }, { status: 400 });
  }
}
