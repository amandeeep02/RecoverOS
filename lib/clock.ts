// lib/clock.ts
export interface Clock { now(): number; }                 // epoch millis

export function systemClock(): Clock {
  return { now: () => Date.now() };
}

export function fixedClock(startMs: number, stepMs = 0): Clock {
  let t = startMs;
  return { now: () => { const v = t; t += stepMs; return v; } };
}

export function scaledClock(startMs: number, speed: number): Clock {
  const origin = Date.now();
  return { now: () => startMs + (Date.now() - origin) * speed };
}