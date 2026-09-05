"use client";

import type { DegradationView } from "@/app/_lib/dashboard";

interface DegradationBannerProps {
  degradation: DegradationView;
  className?: string;
}

/**
 * Presentational. The dashboard owns the degradation state — it arrives with the
 * server render and is updated from the SSE stream — so the banner cannot drift
 * from the queue below it. The previous version subscribed to the SERVER's realtime
 * singleton from inside a client bundle, which is a second, empty instance in the
 * tab: it could never receive an event and the banner could never appear.
 */
export function DegradationBanner({ degradation, className = "" }: DegradationBannerProps) {
  if (degradation.open.length === 0) return null;

  return (
    <div className={`degradation-banner ${className}`} role="alert" aria-live="polite">
      {degradation.open.map((window) => (
        <div key={window.id} className="degradation-alert">
          <span className="alert-icon">⚠</span>
          <div className="alert-content">
            <strong>ISSUER DEGRADATION</strong> — {window.key.replace(/\|/g, " · ")} · {window.ratio.toFixed(1)}× baseline
            <span className="episodes-held">
              {window.observedRate != null ? `${(window.observedRate * 100).toFixed(0)}% failure rate vs ${(window.baselineRate * 100).toFixed(1)}% baseline` : ""}
              {" · "}
              {window.episodesHeld} {window.episodesHeld === 1 ? "episode" : "episodes"} held · 0 contacted
            </span>
          </div>
          <span className="alert-status">AGENT HALTED</span>
        </div>
      ))}
    </div>
  );
}
