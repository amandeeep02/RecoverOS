import { buildDemoSnapshot } from "@/lib/demo";
import { RecoveryDashboard } from "@/components/recovery-dashboard";

export default async function HomePage() {
  const snapshot = await buildDemoSnapshot();
  return <RecoveryDashboard snapshot={snapshot} />;
}
