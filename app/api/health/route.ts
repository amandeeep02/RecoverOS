import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({ status: "ok", service: "RecoverOS", timestamp: new Date().toISOString() });
}
