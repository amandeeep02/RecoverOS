import { NextRequest, NextResponse } from "next/server";
import { replayBatch, type ReplayEpisodeInput } from "@/lib/replay";
import { merchantPolicySchema } from "@/lib/domain";
import { store } from "@/lib/store";
import { demoPolicy, ensureSeeded } from "@/app/_lib/dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Replays the episodes that are actually in the store against a modified policy.
 *
 * The episodes are read server-side rather than accepted from the request body. The
 * previous version took whatever the client posted and then INVENTED each episode's
 * original action as `"PAYMENT_LINK"` whenever an execution record existed, which
 * silently decided the observed/modelled split — the one ratio this console exists
 * to report honestly. The real action is on the policy decision.
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { policy?: Record<string, unknown>; limit?: number };
    await ensureSeeded();

    const base = demoPolicy();
    const policy = merchantPolicySchema.parse({ ...base, ...(body.policy ?? {}) });
    const limit = Math.min(2_000, Math.max(1, body.limit ?? 500));

    const episodes = (await store.listEpisodes()).slice(0, limit);
    const inputs: ReplayEpisodeInput[] = episodes.map((episode) => {
      const settled = episode.outcome && ["RECOVERED", "FAILED", "EXPIRED", "STOPPED"].includes(episode.outcome.status);
      return {
        event: episode.event,
        profile: episode.profile,
        amountPaise: episode.event.amountPaise,
        actualOutcome: settled
          ? {
              recovered: episode.outcome!.status === "RECOVERED",
              // What the policy engine ACTUALLY allowed on this episode. A suppressed
              // episode's real action is WAIT — we did not contact anyone.
              actualAction: episode.policyDecision?.suppressionReason
                ? "WAIT"
                : episode.policyDecision?.allowedAction ?? null,
            }
          : null,
      };
    });

    const result = replayBatch(inputs, { policy, modelVersion: "transparent-v1" });
    return NextResponse.json({
      ...result,
      policyApplied: {
        minimumEirPaise: policy.minimumEirPaise,
        maxAutomatedAttempts: policy.maxAutomatedAttempts,
        churnAversion: policy.churnAversion,
        allowRetry: policy.allowRetry,
        holdoutPct: policy.holdoutPct,
      },
      episodesConsidered: episodes.length,
      episodesWithObservedOutcome: inputs.filter((i) => i.actualOutcome).length,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Replay failed" }, { status: 400 });
  }
}
