"use client";

import { formatInr } from "@/lib/domain";
import type { BenchmarkView } from "@/app/_lib/dashboard";

/**
 * The Subtraction (IDEA.md §11, 2:05).
 *
 * Gross recovered on the treated episodes is what every other product in this
 * category reports. It is struck through, because most of it was already coming.
 * What survives is the difference against a randomized control, with the interval
 * and the construction printed next to it.
 */
export function IncrementalLedger({ benchmark }: { benchmark: BenchmarkView }) {
  const gross = benchmark.grossRecoveredOnTreatedPaise;
  const incremental = benchmark.incrementalRecoveredPaise;
  const share = gross > 0 ? incremental / gross : null;

  return (
    <section className="incremental-ledger" aria-label="Incremental recovery headline">
      <div className="subtraction">
        <div className="subtraction-gross">
          <span className="label">Gross recovered on treated episodes</span>
          <s className="struck">{formatInr(gross)}</s>
          <small>What a recovery product would put on this slide.</small>
        </div>
        <div className="subtraction-arrow" aria-hidden="true">−</div>
        <div className="subtraction-net">
          <span className="label">Incremental recovery</span>
          <strong className="value">{formatInr(incremental)}</strong>
          <div className="ci-badge">
            <span>95% CI</span>
            <span className="ci-range">[{formatInr(benchmark.ciLoPaise)} – {formatInr(benchmark.ciHiPaise)}]</span>
          </div>
        </div>
      </div>

      <div className="sample-sizes">
        <span>Treatment n={benchmark.nTreatment.toLocaleString("en-IN")}</span>
        <span>Holdout n={benchmark.nHoldout.toLocaleString("en-IN")}</span>
        <span>Recovery rate {(benchmark.recoveryRateTreatment * 100).toFixed(1)}% vs {(benchmark.recoveryRateHoldout * 100).toFixed(1)}%</span>
        <span>{benchmark.seeds.length} worlds × {benchmark.episodesPerSeed.toLocaleString("en-IN")} episodes</span>
      </div>

      {share !== null && (
        <p className="subtraction-note">
          {(share * 100).toFixed(0)}% of the gross figure is ours to claim. The rest was arriving anyway,
          and the {benchmark.holdoutPct}% randomized holdout is how we know.
        </p>
      )}

      <p className="method-line">
        Interval: {benchmark.ciMethod}. Per-world figures, not a pooled total.
        {benchmark.coverage
          ? ` Estimator coverage against the simulator's planted truth: ${benchmark.coverage.covered}/${benchmark.coverage.n} (${(benchmark.coverage.coverage * 100).toFixed(0)}%).`
          : ""}
      </p>
    </section>
  );
}
