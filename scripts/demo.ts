import { buildDemoSnapshot } from "@/lib/demo";
import { formatInr } from "@/lib/domain";

async function runDemoScene(scene: number) {
  console.log(`\n=== DEMO SCENE ${scene} ===`);
  const snapshot = await buildDemoSnapshot();
  
  switch (scene) {
case 1:
        console.log("🎬 Scene 1: The Lie - Dashboard opens with headline number");
        const inc = snapshot.benchmark.summary.recoverOs.incrementalRecoveredPaise.mean;
        console.log(`   Incremental vs Baseline (paired, same worlds): ${formatInr(inc)}`);
        // No CI is printed here on purpose. This snapshot runs with holdoutPct 0, so
        // there is no randomised control behind it and therefore no interval to quote.
        // The previous version printed `inc * 0.8 .. inc * 1.2` labelled "95% CI".
        console.log(`   Holdout CI: run \`npm run eval\` — see RESULTS.md`);
        break;
      
    case 2:
      console.log("🔬 Scene 2: Holdout Ledger - Drill into held-out episode");
      console.log(`   Protected: ${formatInr(snapshot.ledger.protectedPaise)}`);
      console.log(`   Forgone: ${formatInr(snapshot.ledger.forgonePaise)}`);
      console.log(`   Suppressed: ${snapshot.ledger.suppressedCount} episodes`);
      break;
      
    case 3:
      console.log("⚡ Scene 3: Issuer Weather - Fire outage, watch hold, resolve");
      console.log("   (Requires live SSE - see dashboard at /)");
      break;
      
    case 4:
      console.log("🔴 Scene 4: Real Test-Mode Episode - Live webhook via ngrok");
      console.log("   (Requires ngrok tunnel + Razorpay test credentials)");
      break;
      
    case 5:
      console.log("🔄 Scene 5: Replay Console - Threshold drag ₹50 → ₹200");
      console.log("   (Visit /replay and drag threshold)");
      break;
      
    case 6:
      console.log("📊 Scene 6: Numbers + Honesty - Batch table + sweep losing region");
      console.log("   (See RESULTS.md for full sweep table)");
      break;
      
    default:
      console.log("All scenes - run with --scene 1 through 6");
  }
  
  process.exit(0);
}

const scene = process.argv.find(arg => arg.startsWith("--scene"))?.split("=")[1] ?? "1";
runDemoScene(parseInt(scene)).catch(console.error);