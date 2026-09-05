import { buildDemoSnapshot } from "@/lib/demo";
import { RecoveryDashboard } from "@/components/recovery-dashboard";

export const dynamic = "force-dynamic";

/**
 * The original single-screen dashboard. Kept reachable because it still carries the
 * merchant-workspace framing and the voice-call simulator entry point; `/` now
 * renders v2, which is where the thesis lives.
 */
export default async function ClassicPage() {
  return <RecoveryDashboard snapshot={await buildDemoSnapshot()} />;
}
