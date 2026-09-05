import { formatInr } from "@/lib/domain";

/**
 * The shape written by `scripts/frontier.ts`. Every quantity this component draws
 * comes from here — there is deliberately not a single measured number literal in
 * this file. Edit `data/generated/frontier.json` and the chart moves; that is the
 * property that makes it evidence rather than an illustration.
 */
export interface FrontierRow {
  param: string;
  value: number;
  netPaise: number;
  recoveredPaise: number;
  costPaise: number;
  churnPaise: number;
  interventions: number;
}

export interface FrontierData {
  generatedAt?: string;
  episodes: number;
  seeds: number[];
  shippedPoint: { churnAversion: number; minimumEscalationRupees: number };
  bestOnGrid?: { param: string; value: number; netPaise: number };
  reference: { baselineNetPaise: number; rulesNetPaise: number; oracleNetPaise: number };
  shipped: { netPaise: number; recoveredPaise: number; costPaise: number; churnPaise: number; interventions: number };
  rows: FrontierRow[];
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

/** Compact Indian-numbering axis tick. ₹1,23,84,458 is unreadable on an axis. */
function compactInr(paise: number): string {
  const r = paise / 100;
  const sign = r < 0 ? "−" : "";
  const a = Math.abs(r);
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(2)}L`;
  return `${sign}₹${Math.round(a).toLocaleString("en-IN")}`;
}

function signedInr(paise: number): string {
  return `${paise >= 0 ? "+" : "−"}${formatInr(Math.abs(paise))}`;
}

/** Magnitude only — for phrases like "₹5.6L below", where the words carry the sign. */
function distanceInr(paise: number): string {
  return formatInr(Math.abs(paise));
}

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

const W = 940;
const H = 470;
const M = { top: 26, right: 178, bottom: 62, left: 104 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;

/** A "nice" round step so the y ticks are not 1173145591.4. */
function niceStep(span: number, target: number): number {
  const raw = span / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * mag) return m * mag;
  return 10 * mag;
}

export function FrontierChart({ data }: { data: FrontierData }) {
  const curve = data.rows
    .filter((r) => r.param === "churnAversion")
    .slice()
    .sort((a, b) => a.value - b.value);

  const gate = data.rows
    .filter((r) => r.param === "minimumEscalationValue")
    .slice()
    .sort((a, b) => a.value - b.value);

  const ref = data.reference;

  // --- domains, entirely data-derived -------------------------------------
  const xs = curve.map((r) => r.value);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yCandidates = [
    ...curve.map((r) => r.netPaise),
    ref.baselineNetPaise,
    ref.rulesNetPaise,
    ref.oracleNetPaise,
  ];
  const rawLo = Math.min(...yCandidates);
  const rawHi = Math.max(...yCandidates);
  const pad = (rawHi - rawLo) * 0.12 || Math.abs(rawHi) * 0.05 || 1;
  const step = niceStep(rawHi - rawLo + 2 * pad, 6);
  const yLo = Math.floor((rawLo - pad) / step) * step;
  const yHi = Math.ceil((rawHi + pad) / step) * step;

  const x = (v: number) => M.left + (xMax === xMin ? PLOT_W / 2 : ((v - xMin) / (xMax - xMin)) * PLOT_W);
  const y = (v: number) => M.top + PLOT_H - ((v - yLo) / (yHi - yLo)) * PLOT_H;

  const yTicks: number[] = [];
  for (let t = yLo; t <= yHi + 1e-6; t += step) yTicks.push(t);

  // --- the two points the story is about ----------------------------------
  const shippedAversion = data.shippedPoint.churnAversion;
  const shipped =
    curve.find((r) => r.value === shippedAversion) ??
    curve.reduce((a, b) => (Math.abs(b.value - shippedAversion) < Math.abs(a.value - shippedAversion) ? b : a));
  const best = curve.reduce((a, b) => (b.netPaise > a.netPaise ? b : a));
  const shippedIsOptimal = best.value === shipped.value;

  const gapToBest = best.netPaise - shipped.netPaise;
  const gapToOracle = ref.oracleNetPaise - shipped.netPaise;
  const bestGapToOracle = ref.oracleNetPaise - best.netPaise;

  const lines = [
    { key: "oracle", label: "Oracle — ceiling", v: ref.oracleNetPaise, color: "#1d7757", dash: "2 4" },
    { key: "baseline", label: "Baseline — silent retry", v: ref.baselineNetPaise, color: "#15231f", dash: "7 4" },
    { key: "rules", label: "Rules", v: ref.rulesNetPaise, color: "#9aa39e", dash: "4 5" },
  ]
    .slice()
    .sort((a, b) => b.v - a.v);

  const path = curve.map((r, i) => `${i === 0 ? "M" : "L"}${x(r.value).toFixed(2)},${y(r.netPaise).toFixed(2)}`).join(" ");

  // Secondary panel geometry — escalation gate sweep.
  const gW = 300;
  const gH = 132;
  const gPad = { l: 8, r: 8, t: 12, b: 26 };
  const gLo = gate.length ? Math.min(...gate.map((r) => r.netPaise)) : 0;
  const gHi = gate.length ? Math.max(...gate.map((r) => r.netPaise)) : 1;
  const gSpan = gHi - gLo || 1;
  const gx = (i: number) => gPad.l + (gate.length < 2 ? (gW - gPad.l - gPad.r) / 2 : (i / (gate.length - 1)) * (gW - gPad.l - gPad.r));
  const gy = (v: number) => gPad.t + (1 - (v - gLo) / gSpan) * (gH - gPad.t - gPad.b);

  return (
    <div className="frontier">
      <header className="frontier-head">
        <div>
          <p className="frontier-eyebrow">§7.4 · The Recovery Frontier</p>
          <h2>We shipped this policy believing it was intelligent. Then we measured it.</h2>
          <p className="frontier-sub">
            Net value as a function of <code>churnAversion</code>, the knob that says how much we trust our own churn
            term. Every point, and all three reference lines, is a measured mean over{" "}
            {data.episodes.toLocaleString("en-IN")} episodes × {data.seeds.length} seeds.
          </p>
        </div>
        <dl className="frontier-callouts">
          <div>
            <dt>Shipped point</dt>
            <dd>
              churnAversion {shipped.value} · {formatInr(shipped.netPaise)}
            </dd>
          </div>
          <div className={shippedIsOptimal ? "" : "miss"}>
            <dt>Best on this grid — vs shipped</dt>
            <dd>
              churnAversion {best.value} · {signedInr(gapToBest)}
            </dd>
          </div>
          <div>
            <dt>Shipped point to Oracle</dt>
            <dd>{distanceInr(gapToOracle)}</dd>
          </div>
        </dl>
      </header>

      <svg className="frontier-svg" viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={`Net value against churn aversion. Shipped point ${shipped.value} at ${formatInr(shipped.netPaise)}; best on grid ${best.value}; Oracle ceiling ${formatInr(ref.oracleNetPaise)}.`}>
        {/* y grid + ticks */}
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={M.left + PLOT_W} y1={y(t)} y2={y(t)} stroke="#eef1ed" strokeWidth={1} />
            <text x={M.left - 12} y={y(t) + 4} textAnchor="end" className="frontier-tick">
              {compactInr(t)}
            </text>
          </g>
        ))}

        {/* axes */}
        <line x1={M.left} x2={M.left} y1={M.top} y2={M.top + PLOT_H} stroke="#d7ddd8" />
        <line x1={M.left} x2={M.left + PLOT_W} y1={M.top + PLOT_H} y2={M.top + PLOT_H} stroke="#d7ddd8" />

        {/* x ticks */}
        {curve.map((r) => (
          <text key={`xt_${r.value}`} x={x(r.value)} y={M.top + PLOT_H + 20} textAnchor="middle" className="frontier-tick">
            {r.value}
          </text>
        ))}
        <text x={M.left + PLOT_W / 2} y={H - 20} textAnchor="middle" className="frontier-axis-label">
          churnAversion — how much the policy trusts its own churn term
        </text>
        <text
          transform={`translate(26 ${M.top + PLOT_H / 2}) rotate(-90)`}
          textAnchor="middle"
          className="frontier-axis-label"
        >
          Net value per {data.episodes.toLocaleString("en-IN")} episodes
        </text>

        {/* horizontal reference lines — the Oracle is the whole story */}
        {lines.map((l) => (
          <g key={l.key}>
            <line
              x1={M.left}
              x2={M.left + PLOT_W}
              y1={y(l.v)}
              y2={y(l.v)}
              stroke={l.color}
              strokeWidth={l.key === "oracle" ? 2 : 1.4}
              strokeDasharray={l.dash}
            />
            <text x={M.left + PLOT_W + 10} y={y(l.v) - 2} className="frontier-ref-label" fill={l.color}>
              {l.label}
            </text>
            <text x={M.left + PLOT_W + 10} y={y(l.v) + 13} className="frontier-ref-value" fill={l.color}>
              {formatInr(l.v)}
            </text>
          </g>
        ))}

        {/* the frontier itself */}
        <path d={path} fill="none" stroke="#b8862f" strokeWidth={2.5} strokeLinejoin="round" />
        {curve.map((r) => (
          <circle key={`p_${r.value}`} cx={x(r.value)} cy={y(r.netPaise)} r={4} fill="#b8862f" />
        ))}

        {/* the gap the demo names out loud */}
        <line
          x1={x(shipped.value)}
          x2={x(shipped.value)}
          y1={y(shipped.netPaise)}
          y2={y(ref.oracleNetPaise)}
          stroke="#cc725a"
          strokeWidth={1}
          strokeDasharray="3 3"
        />

        {/* best point on the grid */}
        {!shippedIsOptimal && (
          <g>
            <circle cx={x(best.value)} cy={y(best.netPaise)} r={7} fill="none" stroke="#1d7757" strokeWidth={2} />
            <circle cx={x(best.value)} cy={y(best.netPaise)} r={3.5} fill="#1d7757" />
            <text x={x(best.value)} y={y(best.netPaise) - 16} textAnchor="middle" className="frontier-point-label" fill="#1d7757">
              best on grid · {formatInr(best.netPaise)}
            </text>
          </g>
        )}

        {/* shipped operating point */}
        <g>
          <circle cx={x(shipped.value)} cy={y(shipped.netPaise)} r={9} fill="#fff" stroke="#cc725a" strokeWidth={2.5} />
          <circle cx={x(shipped.value)} cy={y(shipped.netPaise)} r={3.5} fill="#cc725a" />
          <text x={x(shipped.value)} y={y(shipped.netPaise) + 30} textAnchor="middle" className="frontier-point-label" fill="#cc725a">
            SHIPPED · {formatInr(shipped.netPaise)}
          </text>
          <text x={x(shipped.value)} y={y(shipped.netPaise) + 45} textAnchor="middle" className="frontier-point-sub" fill="#cc725a">
            {shippedIsOptimal ? "on the grid optimum" : `${distanceInr(gapToBest)} below the grid optimum`}
          </text>
        </g>
      </svg>

      <p className="frontier-zero-note">
        The y-axis does not start at zero — it is clipped to the measured range so the differences between arms are
        visible. Every level on it is labelled.
      </p>

      <div className="frontier-lower">
        <div className="frontier-read">
          <h3>How to read it</h3>
          <p>
            The <strong>Oracle</strong> line is the ceiling: an agent that reads planted ground truth, priced for the
            same fatigue and churn as everyone else. It does not read the swept knob, so it is flat. The distance from
            the curve up to it is the entire prize available to <em>any</em> policy in this world.
          </p>
          <p>
            The shipped operating point is <strong>{shippedIsOptimal ? "on" : "not on"}</strong> the maximum of the
            curve we measured{shippedIsOptimal ? "." : `, and sits ${distanceInr(gapToBest)} below it.`} The best point
            on this grid is still {distanceInr(bestGapToOracle)} short of the Oracle
            {best.netPaise < ref.baselineNetPaise ? " and still below Baseline" : ""}. We did not optimise this. We
            measured it, found it was wrong, and are showing you the distance.
          </p>
          <p className="frontier-discipline">
            <strong>Selection discipline.</strong> This grid runs on seeds {data.seeds.join(", ")}. Reading the argmax
            off it and shipping that would be selecting on the data that selected it — the exact overfitting §7.4
            refuses. A candidate only ships after it survives seeds that were never used to choose it.
          </p>
        </div>

        {gate.length > 0 && (
          <div className="frontier-gate">
            <h3>Second knob: escalation value gate</h3>
            <svg viewBox={`0 0 ${gW} ${gH}`} className="frontier-gate-svg" role="img" aria-label="Net value against the minimum escalation value gate.">
              <polyline
                fill="none"
                stroke="#4a6b5c"
                strokeWidth={2}
                points={gate.map((r, i) => `${gx(i).toFixed(1)},${gy(r.netPaise).toFixed(1)}`).join(" ")}
              />
              {gate.map((r, i) => {
                const isShipped = r.value === data.shippedPoint.minimumEscalationRupees;
                return (
                  <g key={`g_${r.value}`}>
                    <circle cx={gx(i)} cy={gy(r.netPaise)} r={isShipped ? 5 : 3} fill={isShipped ? "#cc725a" : "#4a6b5c"} />
                    <text x={gx(i)} y={gH - 8} textAnchor="middle" className="frontier-tick">
                      {r.value === 0 ? "₹0" : `₹${(r.value / 1000).toFixed(r.value % 1000 ? 1 : 0)}k`}
                    </text>
                  </g>
                );
              })}
            </svg>
            <p>
              Spread across the whole gate sweep:{" "}
              <strong>
                {formatInr(Math.max(...gate.map((r) => r.netPaise)) - Math.min(...gate.map((r) => r.netPaise)))}
              </strong>{" "}
              — against {formatInr(Math.max(...curve.map((r) => r.netPaise)) - Math.min(...curve.map((r) => r.netPaise)))}{" "}
              across the churn-aversion sweep. The gate was the smaller problem. The shipped gate is the red dot.
            </p>
          </div>
        )}
      </div>

      <footer className="frontier-foot">
        <span>
          Source: <code>data/generated/frontier.json</code> — written by <code>npm run frontier</code>. Nothing on this
          page is a literal.
        </span>
        <span>
          {data.episodes.toLocaleString("en-IN")} episodes × {data.seeds.length} seeds
          {data.generatedAt ? ` · generated ${data.generatedAt}` : ""}
        </span>
      </footer>
    </div>
  );
}
