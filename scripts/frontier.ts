// scripts/frontier.ts
// Measures the recovery frontier: net value as a function of how protective the
// policy is. The point of this script is to be allowed to discover that the
// shipped defaults are NOT optimal — so it never tunes anything, it only reports.
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { runEval } from "../lib/eval/harness";
import { defaultMerchantPolicy } from "../lib/pipeline";
import { rupees } from "../lib/money";

const EPISODES = Number(process.env.EPISODES ?? 20_000);
const SEEDS = Array.from({ length: Number(process.env.SEED_COUNT ?? 5) }, (_, i) => i + 1);

// A sweep whose optimum sits at the edge of its own grid has not found an optimum, it
// has found the edge. Extended until net value turns over, so the chart marks a turning
// point rather than a boundary.
const CHURN_AVERSION = [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0];
const MIN_ESCALATION = [0, 1_000, 2_500, 5_000, 10_000];

function net(churnAversion: number, minEscalationRupees: number) {
  const policy = defaultMerchantPolicy("merchant_frontier");
  policy.churnAversion = churnAversion;
  policy.minimumEscalationValuePaise = rupees(minEscalationRupees);
  // Must match the overrides scripts/eval.ts applies, or this sweeps a policy the
  // product does not ship and labels the result "shipped defaults".
  policy.allowRetry = true;
  policy.minimumEirPaise = rupees(0);
  policy.holdoutPct = 0; // measuring the policy itself, not the estimator
  const r = runEval({ episodes: EPISODES, seeds: SEEDS, policy, holdoutPct: 0 });
  const mean = (f: (a: any) => number) => r.perSeed.reduce((t, s) => t + f(s.arms.recoverOs), 0) / r.perSeed.length;
  return {
    netPaise: mean((a) => a.netPaise),
    recoveredPaise: mean((a) => a.recoveredPaise),
    costPaise: mean((a) => a.interventionCostPaise),
    churnPaise: mean((a) => a.churnCostPaise),
    interventions: mean((a) => a.interventions),
    baselineNetPaise: r.perSeed.reduce((t, s) => t + s.arms.baseline.netPaise, 0) / r.perSeed.length,
    rulesNetPaise: r.perSeed.reduce((t, s) => t + s.arms.rules.netPaise, 0) / r.perSeed.length,
    // The Oracle reads planted ground truth and is graded through the same fatigued
    // outcome model it optimises against (the correction described in RESULTS.md).
    // It does not read `policy`, so it is a constant ceiling across the whole grid —
    // which is exactly what makes it a legitimate horizontal reference line.
    oracleNetPaise: r.perSeed.reduce((t, s) => t + s.arms.oracle.netPaise, 0) / r.perSeed.length,
  };
}

const inr = (p: number) => Math.round(p / 100).toLocaleString("en-IN");
console.log(`Frontier sweep — ${EPISODES.toLocaleString("en-IN")} episodes × ${SEEDS.length} seeds\n`);

const rows: any[] = [];
const shipped = net(1.0, 2_500);

console.log("A. CHURN AVERSION (escalation gate held at ₹2,500)\n");
console.log("| aversion | interventions | recovered ₹ | cost ₹ | churn ₹ | net ₹ | vs shipped |");
console.log("|---|---|---|---|---|---|---|");
for (const a of CHURN_AVERSION) {
  const r = a === 1.0 ? shipped : net(a, 2_500);
  rows.push({ param: "churnAversion", value: a, ...r });
  const d = r.netPaise - shipped.netPaise;
  console.log(`| ${a.toFixed(2)} | ${r.interventions.toFixed(0)} | ${inr(r.recoveredPaise)} | ${inr(r.costPaise)} | ${inr(r.churnPaise)} | **${inr(r.netPaise)}** | ${d >= 0 ? "+" : ""}${inr(d)} |`);
}

console.log("\nB. ESCALATION VALUE GATE (aversion held at 1.0)\n");
console.log("| min escalation ₹ | interventions | cost ₹ | net ₹ | vs shipped |");
console.log("|---|---|---|---|---|");
for (const m of MIN_ESCALATION) {
  const r = m === 2_500 ? shipped : net(1.0, m);
  rows.push({ param: "minimumEscalationValue", value: m, ...r });
  const d = r.netPaise - shipped.netPaise;
  console.log(`| ${m.toLocaleString("en-IN")} | ${r.interventions.toFixed(0)} | ${inr(r.costPaise)} | **${inr(r.netPaise)}** | ${d >= 0 ? "+" : ""}${inr(d)} |`);
}

const best = rows.reduce((a, b) => (b.netPaise > a.netPaise ? b : a));
console.log(`\nBaseline net: ₹${inr(shipped.baselineNetPaise)}   Rules net: ₹${inr(shipped.rulesNetPaise)}   Oracle net: ₹${inr(shipped.oracleNetPaise)}`);
console.log(`Shipped defaults: ₹${inr(shipped.netPaise)}`);
console.log(`Best on this grid: ${best.param}=${best.value} → ₹${inr(best.netPaise)}  (${best.netPaise > shipped.netPaise ? "+" : ""}₹${inr(best.netPaise - shipped.netPaise)})`);
console.log(`Beats baseline: ${best.netPaise > shipped.baselineNetPaise}   Beats rules: ${best.netPaise > shipped.rulesNetPaise}`);

mkdirSync(resolve(process.cwd(), "data/generated"), { recursive: true });
const out = resolve(process.cwd(), "data/generated/frontier.json");
const bestChurn = rows
  .filter((r) => r.param === "churnAversion")
  .reduce((a, b) => (b.netPaise > a.netPaise ? b : a));

writeFileSync(
  out,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      episodes: EPISODES,
      seeds: SEEDS,
      // The operating point the product actually ships, so the chart can mark it
      // rather than a component guessing which grid row is "ours".
      shippedPoint: { churnAversion: 1.0, minimumEscalationRupees: 2_500 },
      // Best point on the churnAversion sweep — the optimum the shipped point misses.
      bestOnGrid: { param: bestChurn.param, value: bestChurn.value, netPaise: bestChurn.netPaise },
      // Horizontal reference lines. None of these three arms reads the swept policy,
      // so each is a single constant across the grid.
      reference: {
        baselineNetPaise: shipped.baselineNetPaise,
        rulesNetPaise: shipped.rulesNetPaise,
        oracleNetPaise: shipped.oracleNetPaise,
      },
      shipped,
      rows,
    },
    null,
    2,
  ),
);
console.log(`\nWritten ${out}`);
