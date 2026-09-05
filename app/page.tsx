import { getDashboardSnapshot } from "@/app/_lib/dashboard";
import { RecoveryDashboardV2 } from "@/components/recovery-dashboard-v2";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  return <RecoveryDashboardV2 initial={await getDashboardSnapshot()} />;
}
