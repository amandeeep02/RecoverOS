import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runBenchmark } from "../lib/simulator";

const count = Number(process.env.EVENTS_PER_SEED ?? 50_000);
const seeds = Array.from({ length: Number(process.env.SEED_COUNT ?? 20) }, (_, index) => index + 1);
const report = runBenchmark(seeds, count);
const output = resolve(process.cwd(), "data/generated/benchmark.json");
mkdirSync(resolve(process.cwd(), "data/generated"), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2));
console.log(`Generated ${output} from ${seeds.length} identical hidden-truth worlds of ${count.toLocaleString("en-IN")} events each.`);
for (const [strategy, metrics] of Object.entries(report.summary)) {
  console.log(`${strategy}: incremental ₹${Math.round(metrics.incrementalRecoveredInr.mean).toLocaleString("en-IN")} ± ₹${Math.round(metrics.incrementalRecoveredInr.standardDeviation).toLocaleString("en-IN")}`);
}
