import { NextRequest, NextResponse } from "next/server";
import { runBenchmark } from "@/lib/simulator";

export function GET(request: NextRequest) {
  const count = Math.min(50_000, Math.max(100, Number(request.nextUrl.searchParams.get("count") ?? 1_000)));
  const seedCount = Math.min(20, Math.max(1, Number(request.nextUrl.searchParams.get("seeds") ?? 5)));
  return NextResponse.json(runBenchmark(Array.from({ length: seedCount }, (_, index) => index + 1), count));
}
