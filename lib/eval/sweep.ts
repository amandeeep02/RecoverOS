// lib/eval/sweep.ts
import { runEval, type EvalConfig } from "./harness";
import { DEFAULT_ASSUMPTIONS as SIM_DEFAULTS, type GeneratorAssumptions } from "@/lib/simulator";
import { defaultMerchantPolicy } from "@/lib/pipeline";

// Use simulator defaults for sweep since they're what generateSyntheticWorld uses
const SWEEP_BASE_DEFAULTS: GeneratorAssumptions = SIM_DEFAULTS;

export interface SweepConfig {
  baseConfig: EvalConfig;
  paramGrids: Record<string, (number | string)[]>;
}

export interface SweepResult {
  param: string;
  value: number | string;
  netPaiseDiff: number; // recoverOs - baseline
  recoverOsNetPaise: number;
  baselineNetPaise: number;
}

export function runSweep(config: SweepConfig): SweepResult[] {
  const results: SweepResult[] = [];

  for (const [param, values] of Object.entries(config.paramGrids)) {
    for (const value of values) {
      const modifiedAssumptions = applyAssumption(SWEEP_BASE_DEFAULTS, param, value);

      const evalConfig = { ...config.baseConfig, assumptions: modifiedAssumptions };
      const report = runEval(evalConfig);

      const recoverOsNet = report.aggregate.recoverOs.mean;
      const baselineNet = report.aggregate.baseline.mean;
      const diff = recoverOsNet - baselineNet;

      results.push({
        param,
        value: typeof value === "number" ? Number(value.toFixed(3)) : value,
        netPaiseDiff: Math.round(diff * 100),
        recoverOsNetPaise: Math.round(recoverOsNet * 100),
        baselineNetPaise: Math.round(baselineNet * 100),
      });
    }
  }

  return results;
}

function applyAssumption(base: GeneratorAssumptions, param: string, value: number | string): GeneratorAssumptions {
  switch (param) {
    case "contactResponseRate":
      return { ...base, contactResponseRate: Number(value) };
    case "voiceLiftMultiplier":
      return { ...base, voiceLiftMultiplier: Number(value) };
    case "dormancyChurnScale":
      // The world's churn is a logistic now, not a table: scale its ceiling.
      return { ...base, dormancyChurnLogistic: { ...base.dormancyChurnLogistic, ceiling: base.dormancyChurnLogistic.ceiling * Number(value) } };
    case "interventionCostScale":
      return {
        ...base,
        interventionCostPaise: Object.fromEntries(
          Object.entries(base.interventionCostPaise).map(([k, v]) => [k, Math.round(v * Number(value))])
        ) as GeneratorAssumptions["interventionCostPaise"],
      };
    case "issuerOutageFrequency":
      return { ...base, issuerOutageFrequency: Number(value) };
    default:
      return base;
  }
}

export function formatSweepTable(results: SweepResult[]): string {
  const lines: string[] = [];
  // Integer rupees, Indian grouping — matching every other figure in the repo.
  // Fractional paise in a document about numerical discipline is its own tell.
  const inr = (paise: number) => `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
  const signed = (paise: number) =>
    `${paise >= 0 ? "+" : "−"}₹${Math.abs(Math.round(paise / 100)).toLocaleString("en-IN")}`;

  lines.push("## Sensitivity Sweep — Net Recovery Difference (RecoverOS − Baseline)");
  lines.push("");
  lines.push("| Parameter | Value | RecoverOS Net | Baseline Net | Difference |");
  lines.push("|---|---|---|---|---|");
  for (const r of results) {
    lines.push(`| ${r.param} | ${r.value} | ${inr(r.recoverOsNetPaise)} | ${inr(r.baselineNetPaise)} | **${signed(r.netPaiseDiff)}** |`);
  }
  lines.push("");

  const losing = results.filter((r) => r.netPaiseDiff <= 0);
  lines.push("### Where we stop winning");
  lines.push("");
  if (losing.length === results.length) {
    // Reprinting an identical table under a second heading is not a finding.
    const best = results.reduce((a, b) => (b.netPaiseDiff > a.netPaiseDiff ? b : a));
    lines.push(`**Every cell in the grid loses — ${results.length}/${results.length}.** There is no winning region here to`);
    lines.push("report, so this section is a single line rather than a copy of the table above.");
    lines.push("");
    lines.push(`The narrowest gap is \`${best.param} = ${best.value}\` at ${signed(best.netPaiseDiff)}; the sweep`);
    lines.push("does not cross zero anywhere. That is consistent with the Oracle bound: if a policy");
    lines.push("with perfect knowledge only clears silent retry by a low single-digit percentage,");
    lines.push("there is very little room in this world for an imperfect one to win.");
  } else if (losing.length === 0) {
    lines.push("**No losing cell was found, which means the grid is too narrow.** A sweep with no");
    lines.push("failure region is a marketing artifact. Widen the ranges until one exists.");
  } else {
    lines.push(`${losing.length} of ${results.length} cells are net-negative:`);
    lines.push("");
    lines.push("| Parameter | Value | Difference |");
    lines.push("|---|---|---|");
    for (const r of losing) lines.push(`| ${r.param} | ${r.value} | **${signed(r.netPaiseDiff)}** |`);
  }
  lines.push("");
  return lines.join("\n");
}

function sweepPolicy() {
  const policy = defaultMerchantPolicy("merchant_sweep");
  policy.allowRetry = true;        // both comparison arms retry freely
  policy.minimumEirPaise = 0;      // confirmed on held-out seeds
  policy.churnAversion = 1.5;      // confirmed on held-out seeds
  return policy;
}

export const DEFAULT_SWEEP_CONFIG: SweepConfig = {
  baseConfig: {
    episodes: 5000,
    seeds: [1, 2, 3, 4, 5],
    // MUST match the three overrides scripts/eval.ts applies, or the sweep
    // benchmarks a crippled policy against the headline's real one — the exact
    // "rigged comparison" defect this project called out in its own plan.
    policy: sweepPolicy(),
    holdoutPct: 0,
  },
  paramGrids: {
    contactResponseRate: [0.25, 0.33, 0.42, 0.50, 0.55],
    voiceLiftMultiplier: [1.0, 1.2, 1.35, 1.5, 1.6],
    dormancyChurnScale: [0.5, 0.75, 1.0, 1.5, 2.0],
    interventionCostScale: [0.5, 0.75, 1.0, 1.5, 2.0],
    issuerOutageFrequency: [0.01, 0.03, 0.05, 0.07, 0.08],
  },
};