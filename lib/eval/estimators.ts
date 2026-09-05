// lib/eval/estimators.ts
//
// Every interval in this file has a name and a stated construction. Nothing here
// averages interval endpoints: an average of endpoints is not an interval and has
// no coverage property. If a number in RESULTS.md cannot be traced to one of these
// functions, it does not belong in RESULTS.md.
import type { Rng } from "@/lib/rng";
import type { Paise } from "@/lib/money";

/** One episode as the estimator sees it. `customerId` is the CLUSTER label. */
export interface EpisodeRecord {
  episodeId: string;
  /** Cluster (resampling) unit. Episode amount is constant within a customer and
   *  contact fatigue is per-customer, so episodes are NOT independent. */
  customerId: string;
  amountPaise: number;
  arm: "TREATMENT" | "HOLDOUT";
  recovered: boolean;
  /** Planted probability the episode actually faced, after fatigue and after
   *  whatever the arm executed (or did not execute). */
  pRealized: number;
  /** Planted probability had nothing been executed. */
  pNative: number;
}

export interface HoldoutEstimate {
  nTreatment: number;
  nHoldout: number;
  nClusters: number;
  recoveryRateTreatment: number;
  recoveryRateHoldout: number;
  meanAmountTreatmentPaise: number;
  /**
   * RATE estimator: (rateT − rateH) × Ā_T × n_T. This is the quantity the product
   * reports and the one the holdout design was built around.
   */
  incrementalPaise: Paise;
  ciLoPaise: Paise;
  ciHiPaise: Paise;
  /** How the interval was built. Copied verbatim into RESULTS.md. */
  ciMethod: string;
  /**
   * REVENUE estimator: (mean_T[recovered·amount] − mean_H[recovered·amount]) × n_T.
   * The rate estimator multiplies a rate difference by the MEAN amount, which equals
   * the incremental rupees only when lift and amount are uncorrelated. They are not:
   * the policy's EIR gate acts preferentially on larger tickets, so the high-lift
   * episodes are also the high-amount ones and the rate form understates the money.
   * This difference-in-means on revenue per episode has no such assumption.
   */
  revenueIncrementalPaise: Paise;
  revenueCiLoPaise: Paise;
  revenueCiHiPaise: Paise;
  resamples: number;
  grossRecoveredPaise: Paise;
}

// ---------------------------------------------------------------------------
// t-interval
// ---------------------------------------------------------------------------

/** Two-sided 0.975 Student-t quantiles. Exact for the df listed, conservative
 *  (rounds down to the next tabulated df) in between. */
const T975: [number, number][] = [
  [1, 12.706], [2, 4.303], [3, 3.182], [4, 2.776], [5, 2.571], [6, 2.447],
  [7, 2.365], [8, 2.306], [9, 2.262], [10, 2.228], [11, 2.201], [12, 2.179],
  [13, 2.160], [14, 2.145], [15, 2.131], [16, 2.120], [17, 2.110], [18, 2.101],
  [19, 2.093], [20, 2.086], [21, 2.080], [22, 2.074], [23, 2.069], [24, 2.064],
  [25, 2.060], [26, 2.056], [27, 2.052], [28, 2.048], [29, 2.045], [30, 2.042],
  [40, 2.021], [60, 2.000], [120, 1.980],
];

export function tQuantile975(df: number): number {
  if (df < 1) return Number.POSITIVE_INFINITY;
  // Largest tabulated df not exceeding `df`. t decreases in df, so falling back to
  // the lower row is conservative (a slightly wider interval), never anti-conservative.
  let t = T975[0][1];
  for (const [d, v] of T975) {
    if (df >= d) t = v; else break;
  }
  return t;
}

export interface TIntervalStat {
  mean: number;
  standardDeviation: number;
  standardError: number;
  ciLo: number;
  ciHi: number;
  n: number;
  /** Name of the construction, for labelling. */
  method: string;
}

/**
 * 95% Student-t interval over `values`, treated as n iid replicates.
 * Used for ACROSS-SEED aggregation: each seed is one independent world, so the
 * 20 per-seed point estimates are 20 replicates of the same quantity and their
 * spread is the right measure of run-to-run uncertainty.
 */
export function tInterval(values: number[]): TIntervalStat {
  const n = values.length;
  if (n === 0) return { mean: 0, standardDeviation: 0, standardError: 0, ciLo: 0, ciHi: 0, n: 0, method: "no data" };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n < 2) {
    return { mean, standardDeviation: 0, standardError: 0, ciLo: mean, ciHi: mean, n, method: "single replicate — no interval" };
  }
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  const se = sd / Math.sqrt(n);
  const t = tQuantile975(n - 1);
  return {
    mean,
    standardDeviation: sd,
    standardError: se,
    ciLo: mean - t * se,
    ciHi: mean + t * se,
    n,
    method: `across-seed 95% Student-t interval over ${n} per-seed point estimates (df=${n - 1}, t=${t})`,
  };
}

// ---------------------------------------------------------------------------
// clustered nonparametric bootstrap
// ---------------------------------------------------------------------------

interface ClusterAggregate {
  nT: number; recT: number; amtT: number; revT: number;
  nH: number; recH: number; revH: number;
}

/**
 * Nonparametric bootstrap for the holdout estimator, resampling CUSTOMERS with
 * replacement and carrying each episode's ACTUAL amount.
 *
 * Why clusters: episode amount is a per-customer constant drawn from a heavy tail
 * (`exp(U·5.3)` in the generator) and there are ~6 episodes per customer, so
 * episodes within a customer are neither independent nor exchangeable. Resampling
 * episodes — or, worse, resampling Binomial(n, p̂) counts and multiplying by a
 * CONSTANT mean amount — understates the variance twice: once by ignoring the
 * within-customer correlation, once by pretending the amount is known.
 *
 * Estimand: Θ = (rateT − rateH) × Ā_T × n_T, the incremental rupees recovered on
 * the n_T treated episodes. n_T is the observed treated count (a known population
 * size, not an estimated quantity) and is therefore held FIXED across resamples;
 * rateT, rateH and Ā_T are all re-estimated on each resample.
 */
export function clusteredBootstrapCi(
  records: EpisodeRecord[],
  resamples: number,
  rng: Rng,
): HoldoutEstimate {
  const groups = new Map<string, ClusterAggregate>();
  let nT = 0, nH = 0, recT = 0, recH = 0, amtT = 0, revT = 0, revH = 0;

  for (const r of records) {
    let g = groups.get(r.customerId);
    if (!g) { g = { nT: 0, recT: 0, amtT: 0, revT: 0, nH: 0, recH: 0, revH: 0 }; groups.set(r.customerId, g); }
    if (r.arm === "TREATMENT") {
      g.nT += 1; g.amtT += r.amountPaise;
      nT += 1; amtT += r.amountPaise;
      if (r.recovered) { g.recT += 1; g.revT += r.amountPaise; recT += 1; revT += r.amountPaise; }
    } else {
      g.nH += 1;
      nH += 1;
      if (r.recovered) { g.recH += 1; g.revH += r.amountPaise; recH += 1; revH += r.amountPaise; }
    }
  }

  const clusters = [...groups.values()];
  const nClusters = clusters.length;
  const rateT = nT > 0 ? recT / nT : 0;
  const rateH = nH > 0 ? recH / nH : 0;
  const meanAmountT = nT > 0 ? amtT / nT : 0;
  const incrementalPaise = Math.round((rateT - rateH) * meanAmountT * nT);
  const revenueIncrementalPaise = nT > 0 && nH > 0 ? Math.round((revT / nT - revH / nH) * nT) : 0;
  const ciMethod = `nonparametric cluster bootstrap, ${resamples.toLocaleString("en-IN")} resamples of customers (not episodes) with replacement, carrying each episode's actual amount; percentile interval`;

  const base: HoldoutEstimate = {
    nTreatment: nT, nHoldout: nH, nClusters,
    recoveryRateTreatment: rateT, recoveryRateHoldout: rateH,
    meanAmountTreatmentPaise: meanAmountT,
    incrementalPaise, ciLoPaise: 0, ciHiPaise: 0,
    revenueIncrementalPaise, revenueCiLoPaise: 0, revenueCiHiPaise: 0,
    ciMethod, resamples,
    grossRecoveredPaise: Math.round(recT * meanAmountT),
  };
  if (nT === 0 || nH === 0 || nClusters === 0) {
    return { ...base, ciMethod: "insufficient data for an interval" };
  }

  const draws: number[] = [];
  const revDraws: number[] = [];
  for (let b = 0; b < resamples; b++) {
    let bnT = 0, brecT = 0, bamtT = 0, brevT = 0, bnH = 0, brecH = 0, brevH = 0;
    for (let k = 0; k < nClusters; k++) {
      const c = clusters[rng.int(nClusters)];
      bnT += c.nT; brecT += c.recT; bamtT += c.amtT; brevT += c.revT;
      bnH += c.nH; brecH += c.recH; brevH += c.revH;
    }
    if (bnT === 0 || bnH === 0) continue;
    draws.push((brecT / bnT - brecH / bnH) * (bamtT / bnT) * nT);
    revDraws.push((brevT / bnT - brevH / bnH) * nT);
  }
  if (draws.length < 2) return { ...base, ciMethod: "bootstrap degenerate — no interval" };
  draws.sort((a, b) => a - b);
  revDraws.sort((a, b) => a - b);
  const at = (xs: number[], q: number) => xs[Math.min(xs.length - 1, Math.max(0, Math.floor(q * xs.length)))];
  return {
    ...base,
    ciLoPaise: Math.round(at(draws, 0.025)), ciHiPaise: Math.round(at(draws, 0.975)),
    revenueCiLoPaise: Math.round(at(revDraws, 0.025)), revenueCiHiPaise: Math.round(at(revDraws, 0.975)),
  };
}

// ---------------------------------------------------------------------------
// estimator validation
// ---------------------------------------------------------------------------

export interface CoverageReport {
  covered: number;
  n: number;
  coverage: number;
  /** Signed relative error of the point estimate vs. truth, per replicate. */
  relativeBias: number[];
  meanRelativeBias: number;
  /** Nominal coverage the intervals claim. */
  nominal: number;
  passed: boolean;
}

/**
 * Does the interval contain the planted truth? This is the ONLY evidence that the
 * estimator works. It is reported whatever it says; it is never tuned until it
 * passes. `truth` and `estimates` must be aligned per replicate (per seed).
 */
export function validateHoldoutEstimator(
  truthPaise: Paise[],
  estimates: Pick<HoldoutEstimate, "incrementalPaise" | "ciLoPaise" | "ciHiPaise">[],
  nominal = 0.95,
): CoverageReport {
  if (truthPaise.length !== estimates.length) {
    throw new Error(`validateHoldoutEstimator: ${truthPaise.length} truths vs ${estimates.length} estimates`);
  }
  let covered = 0;
  const relativeBias: number[] = [];
  for (let i = 0; i < truthPaise.length; i++) {
    const e = estimates[i];
    const t = truthPaise[i];
    if (e.ciLoPaise <= t && t <= e.ciHiPaise) covered++;
    if (t !== 0) relativeBias.push((e.incrementalPaise - t) / Math.abs(t));
  }
  const n = truthPaise.length;
  const coverage = n > 0 ? covered / n : 0;
  const meanRelativeBias = relativeBias.length > 0
    ? relativeBias.reduce((a, b) => a + b, 0) / relativeBias.length
    : 0;
  // A binomial 95% interval on n replicates is wide; with n=20 the lower bound of
  // "nominal 95%" is ~0.75. Anything below that is a real failure, not noise.
  const floor = nominal - 2 * Math.sqrt((nominal * (1 - nominal)) / Math.max(n, 1));
  return { covered, n, coverage, relativeBias, meanRelativeBias, nominal, passed: coverage >= floor };
}
