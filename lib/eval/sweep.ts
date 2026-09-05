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

    // Locate the sign change on each losing axis and state it in units the reader
    // can act on. A list of negative cells without the crossing point tells nobody
    // how much of the model they have to believe.
    const axes = [...new Set(losing.map((r) => r.param))];
    for (const axis of axes) {
      const cells = results
        .filter((r) => r.param === axis && typeof r.value === "number")
        .sort((a, b) => Number(a.value) - Number(b.value));
      let lo: SweepResult | null = null;
      let hi: SweepResult | null = null;
      for (let i = 1; i < cells.length; i += 1) {
        if (cells[i - 1].netPaiseDiff > 0 && cells[i].netPaiseDiff <= 0) { lo = cells[i - 1]; hi = cells[i]; break; }
      }
      if (!lo || !hi) continue;
      // Linear interpolation between the bracketing cells. Stated as approximate
      // because it is: the grid has finite resolution and this is not a root-find.
      const span = lo.netPaiseDiff - hi.netPaiseDiff;
      const cross = Number(lo.value) + (Number(hi.value) - Number(lo.value)) * (span === 0 ? 0 : lo.netPaiseDiff / span);
      lines.push("");
      lines.push(`**\`${axis}\` crosses zero at approximately ${cross.toFixed(2)}×** — between`);
      lines.push(`\`${lo.value}\` (${signed(lo.netPaiseDiff)}) and \`${hi.value}\` (${signed(hi.netPaiseDiff)}).`);
    }

    if (axes.includes("dormancyChurnScale")) {
      lines.push("");
      lines.push("**Read the direction carefully, because it is the opposite of the intuition.**");
      lines.push("RecoverOS loses as churn gets *more* expensive, not less. Baseline is silent retry:");
      lines.push("it contacts nobody, so it pays no churn at any scale and is structurally immune to");
      lines.push("this axis. RecoverOS contacts, so every rupee the world adds to the churn hazard is");
      lines.push("charged to us and not to our comparator.");
      lines.push("");
      lines.push("So the operating window is bounded on **both** sides, and neither bound is comfortable:");
      lines.push("");
      lines.push("- Below it, churn is cheap enough that indiscriminate contact pays and the naive Rules");
      lines.push("  arm — which we beat by a wide margin here — is the right product instead of this one.");
      lines.push("- Above it, contact is so expensive that the correct policy is to contact *nobody*, and");
      lines.push("  RecoverOS is not restrained enough to find that. Baseline is, by accident.");
      lines.push("");
      lines.push("The headline result therefore rests on the world's churn hazard being within roughly a");
      lines.push("factor of two of what `SIMULATOR.md` assumes. That assumption is the load-bearing one");
      lines.push("in this repository, it is ours, and this is the sweep that says how much weight it carries.");
    }
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
    // HELD-OUT seeds. `scripts/eval.ts` records that minimumEirPaise and
    // churnAversion were SELECTED on seeds 1-5 and confirmed on 6-20. A robustness
    // map drawn on the selection seeds is drawn on the worlds the constants were
    // chosen in, which is the one place robustness is guaranteed by construction
    // rather than measured. So the sweep runs on 6-20 only.
    seeds: [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
    // MUST match the three overrides scripts/eval.ts applies, or the sweep
    // benchmarks a crippled policy against the headline's real one — the exact
    // "rigged comparison" defect this project called out in its own plan.
    policy: sweepPolicy(),
    holdoutPct: 0,
  },
  paramGrids: {
    contactResponseRate: [0.25, 0.33, 0.42, 0.50, 0.55],
    voiceLiftMultiplier: [1.0, 1.2, 1.35, 1.5, 1.6],
    // Widened past 2.0 deliberately. The narrow grid had no losing cell anywhere,
    // and a sweep with no failure region measures nothing — it is a marketing
    // artifact, which this file's own check says out loud. Churn scale is the axis
    // that decides whether this product has a reason to exist, so it is swept until
    // the win crosses zero.
    dormancyChurnScale: [0.25, 0.5, 1.0, 1.5, 1.75, 2.0, 3.0, 4.0, 6.0],
    interventionCostScale: [0.5, 0.75, 1.0, 1.5, 2.0],
    issuerOutageFrequency: [0.01, 0.03, 0.05, 0.07, 0.08],
  },
};