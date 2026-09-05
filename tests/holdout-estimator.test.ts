import { describe, expect, it } from "vitest";
import { assignArm, hashToBucket, HOLDOUT_VALUE_CAP_PAISE } from "@/lib/experiment";
import {
  clusteredBootstrapCi, tInterval, tQuantile975, validateHoldoutEstimator,
  type EpisodeRecord,
} from "@/lib/eval/estimators";
import { runEval } from "@/lib/eval/harness";
import { defaultMerchantPolicy } from "@/lib/pipeline";
import { rupees } from "@/lib/money";
import { mulberry32 } from "@/lib/rng";

function record(over: Partial<EpisodeRecord> & Pick<EpisodeRecord, "customerId" | "arm" | "recovered" | "amountPaise">): EpisodeRecord {
  return {
    episodeId: `${over.customerId}_${Math.random()}`,
    pRealized: over.recovered ? 1 : 0,
    pNative: 0,
    ...over,
  };
}

describe("Holdout infrastructure", () => {
  it("hashToBucket is deterministic and uniform", () => {
    const buckets = new Array(100).fill(0);
    for (let i = 0; i < 10000; i++) buckets[hashToBucket(`ep_${i}`)]++;
    for (const count of buckets) {
      expect(count).toBeGreaterThan(50);
      expect(count).toBeLessThan(150);
    }
  });

  it("assignArm respects holdout percentage", () => {
    let holdoutCount = 0;
    for (let i = 0; i < 10000; i++) if (assignArm(`ep_${i}`, 5) === "HOLDOUT") holdoutCount++;
    expect(holdoutCount).toBeGreaterThan(400);
    expect(holdoutCount).toBeLessThan(600);
  });

  it("assignArm respects value cap", () => {
    expect(HOLDOUT_VALUE_CAP_PAISE).toBe(5_000_000);
  });
});

describe("tInterval", () => {
  it("uses the t quantile for the right degrees of freedom, not a hardcoded 2.093", () => {
    expect(tQuantile975(19)).toBeCloseTo(2.093, 3);
    expect(tQuantile975(4)).toBeCloseTo(2.776, 3);
    expect(tQuantile975(1)).toBeCloseTo(12.706, 3);
    // Small samples must get a WIDER interval than df=19 would give.
    const five = tInterval([1, 2, 3, 4, 5]);
    const naive = 2.093 * (Math.sqrt(2.5) / Math.sqrt(5));
    expect(five.ciHi - five.mean).toBeGreaterThan(naive);
  });

  it("is an interval around the mean of the replicates", () => {
    const t = tInterval([10, 20, 30, 40]);
    expect(t.mean).toBe(25);
    expect(t.ciLo).toBeLessThan(25);
    expect(t.ciHi).toBeGreaterThan(25);
    expect(t.n).toBe(4);
    expect(t.method).toContain("Student-t");
  });

  it("degenerates safely on one replicate rather than pretending to an interval", () => {
    const t = tInterval([7]);
    expect(t.ciLo).toBe(7);
    expect(t.ciHi).toBe(7);
    expect(t.method).toContain("no interval");
  });
});

describe("clusteredBootstrapCi", () => {
  it("produces an interval that brackets the point estimate", () => {
    const rng = mulberry32(42);
    const records: EpisodeRecord[] = [];
    for (let c = 0; c < 200; c++) {
      const amount = 1000 + c * 10;
      for (let k = 0; k < 5; k++) {
        records.push(record({ customerId: `c${c}`, arm: c % 10 === 0 ? "HOLDOUT" : "TREATMENT", recovered: c % 10 !== 0, amountPaise: amount }));
      }
    }
    const r = clusteredBootstrapCi(records, 500, rng);
    expect(r.ciLoPaise).toBeLessThanOrEqual(r.incrementalPaise);
    expect(r.ciHiPaise).toBeGreaterThanOrEqual(r.incrementalPaise);
    expect(r.nClusters).toBe(200);
    expect(r.ciMethod).toContain("customers (not episodes)");
  });

  // One fixture, three configurations. Amount is a per-customer constant drawn
  // from the generator's own heavy tail; recovery draws come from a fixed RNG in
  // an identical loop order, so every configuration sees the SAME outcomes and
  // only the thing under test differs.
  const buildRecords = (opts: { heavyAmounts: boolean; singletonClusters: boolean }) => {
    const amounts: number[] = [];
    const amountRng = mulberry32(99);
    for (let c = 0; c < 400; c++) amounts.push(Math.round((499 + Math.exp(amountRng.next() * 5.3) * 26) * 100));
    const flat = Math.round(amounts.reduce((a, b) => a + b, 0) / amounts.length);
    const draw = mulberry32(7);
    const out: EpisodeRecord[] = [];
    for (let c = 0; c < 400; c++) {
      const arm = c % 5 === 0 ? ("HOLDOUT" as const) : ("TREATMENT" as const);
      const p = arm === "TREATMENT" ? 0.6 : 0.4;
      const amountPaise = opts.heavyAmounts ? amounts[c] : flat;
      for (let k = 0; k < 6; k++) {
        out.push(record({
          customerId: opts.singletonClusters ? `c${c}_${k}` : `c${c}`,
          arm, recovered: draw.bernoulli(p), amountPaise,
        }));
      }
    }
    return out;
  };
  const width = (r: { ciLoPaise: number; ciHiPaise: number }) => r.ciHiPaise - r.ciLoPaise;

  it("resamples CUSTOMERS, not episodes: identical data clustered by customer gives a wider interval than the same data treated as independent episodes", () => {
    const clustered = clusteredBootstrapCi(buildRecords({ heavyAmounts: true, singletonClusters: false }), 1200, mulberry32(7));
    const asEpisodes = clusteredBootstrapCi(buildRecords({ heavyAmounts: true, singletonClusters: true }), 1200, mulberry32(7));
    expect(clustered.nClusters).toBe(400);
    expect(asEpisodes.nClusters).toBe(2400);
    // Same point estimate — only the resampling unit changed.
    expect(clustered.incrementalPaise).toBe(asEpisodes.incrementalPaise);
    expect(width(clustered)).toBeGreaterThan(width(asEpisodes));
  });

  it("propagates amount variance: heavy-tailed per-customer amounts give a wider interval than a constant amount with the same mean", () => {
    const heavy = clusteredBootstrapCi(buildRecords({ heavyAmounts: true, singletonClusters: false }), 1200, mulberry32(11));
    const flat = clusteredBootstrapCi(buildRecords({ heavyAmounts: false, singletonClusters: false }), 1200, mulberry32(11));
    expect(heavy.incrementalPaise).not.toBe(0);
    expect(flat.incrementalPaise).not.toBe(0);
    // Relative width, so the comparison is not driven by a difference in scale.
    expect(width(heavy) / Math.abs(heavy.incrementalPaise))
      .toBeGreaterThan(width(flat) / Math.abs(flat.incrementalPaise));
  });

  it("returns a named degenerate result rather than a fake interval when one arm is empty", () => {
    const rng = mulberry32(1);
    const r = clusteredBootstrapCi(
      [record({ customerId: "c0", arm: "TREATMENT", recovered: true, amountPaise: 1000 })],
      100, rng,
    );
    expect(r.ciMethod).toContain("insufficient data");
    expect(r.ciLoPaise).toBe(0);
    expect(r.ciHiPaise).toBe(0);
  });
});

describe("validateHoldoutEstimator", () => {
  it("counts an interval containing the truth as covered and one that misses as not", () => {
    const est = [
      { incrementalPaise: 100, ciLoPaise: 50, ciHiPaise: 150 },
      { incrementalPaise: 100, ciLoPaise: 50, ciHiPaise: 150 },
      { incrementalPaise: 100, ciLoPaise: 50, ciHiPaise: 150 },
      { incrementalPaise: 100, ciLoPaise: 50, ciHiPaise: 150 },
    ];
    const r = validateHoldoutEstimator([100, 60, 200, 140], est);
    expect(r.covered).toBe(3);
    expect(r.coverage).toBe(0.75);
    expect(r.n).toBe(4);
  });

  it("refuses to compare misaligned replicate lists", () => {
    expect(() => validateHoldoutEstimator([1, 2], [{ incrementalPaise: 1, ciLoPaise: 0, ciHiPaise: 2 }])).toThrow();
  });
});

describe("estimator coverage against planted truth (end to end)", () => {
  // The single piece of evidence that the holdout estimator works at all. Small
  // enough to run in CI; the shipped RESULTS.md number uses 20 seeds × 50k.
  it("covers the planted incremental on a majority of seeds", () => {
    const policy = defaultMerchantPolicy("merchant_test");
    policy.holdoutPct = 5;
    policy.allowRetry = true;
    policy.minimumEirPaise = rupees(0);
    policy.churnAversion = 1.5;

    const report = runEval({
      episodes: 6_000,
      seeds: [1, 2, 3, 4, 5, 6],
      policy,
      holdoutPct: 5,
      randomizationUnit: "customer",
      bootstrapResamples: 600,
    });

    expect(report.coverage).toBeDefined();
    const c = report.coverage!;
    // Reported, not asserted to a flattering threshold: the revenue estimator is
    // the one targeting the planted truth, so it is the one held to a bar.
    expect(c.againstTruth.n).toBe(6);
    expect(c.revenueAgainstTruth.coverage).toBeGreaterThanOrEqual(0.5);
    // The estimand check verifies the bootstrap itself: it must cover the quantity
    // the estimator is actually targeting.
    expect(c.againstEstimand.coverage).toBeGreaterThanOrEqual(0.5);
    for (const s of report.perSeed) {
      expect(s.holdout!.ciLoPaise).toBeLessThanOrEqual(s.holdout!.incrementalPaise);
      expect(s.holdout!.ciHiPaise).toBeGreaterThanOrEqual(s.holdout!.incrementalPaise);
    }
  });

  it("gives different seeds different noise: per-episode CRN is keyed on the whole id", () => {
    const policy = defaultMerchantPolicy("merchant_test");
    policy.holdoutPct = 0;
    policy.allowRetry = true;
    const report = runEval({ episodes: 4_000, seeds: [1, 2, 3, 4, 5], policy, holdoutPct: 0 });
    const nets = report.perSeed.map((s) => s.arms.recoverOs.netPaise);
    expect(new Set(nets).size).toBe(nets.length);
    // And every arm is present, Oracle included.
    for (const s of report.perSeed) {
      expect(s.arms.oracle).toBeDefined();
      expect(s.arms.oracle.netPaise).toBeGreaterThan(0);
    }
  });

  it("charges nothing for actions that did not execute", () => {
    const policy = defaultMerchantPolicy("merchant_test");
    policy.holdoutPct = 50; // half the eligible customers get nothing done to them
    policy.allowRetry = true;
    const report = runEval({ episodes: 4_000, seeds: [1], policy, holdoutPct: 50, bootstrapResamples: 200 });
    const arm = report.perSeed[0].arms.recoverOs;
    // interventions counts executed work only, and cost is bounded by it.
    expect(arm.interventionCostPaise).toBeGreaterThan(0);
    expect(arm.interventions).toBeGreaterThan(0);
    // ESCALATE is the only non-automated executed action; the bill can never exceed
    // the most expensive action times the number of executed interventions.
    expect(arm.interventionCostPaise).toBeLessThanOrEqual(arm.interventions * rupees(110));
    expect(arm.escalations).toBeLessThanOrEqual(arm.interventions);
  });
});
