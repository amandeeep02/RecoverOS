import { NextRequest, NextResponse } from "next/server";
import { observeOutcome } from "@/lib/pipeline";
import { store } from "@/lib/store";

export const dynamic = "force-dynamic";

const allowed = ["RECOVERED", "FAILED", "EXPIRED"] as const;
type Allowed = (typeof allowed)[number];

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = await request.json() as { status?: string };
    if (!body.status || !allowed.includes(body.status as Allowed)) {
      throw new Error("status must be RECOVERED, FAILED, or EXPIRED");
    }
    // The await is the whole point: without it this serialises a pending Promise,
    // returns `{"episode":{}}`, and turns any store error into an unhandled rejection.
    const episode = await observeOutcome(id, body.status as Allowed, store);
    return NextResponse.json({ episode });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not record outcome" }, { status: 400 });
  }
}
