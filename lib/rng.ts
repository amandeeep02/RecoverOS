// lib/rng.ts
export interface Rng {
  next(): number;          // uniform [0, 1)
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  bernoulli(p: number): boolean;
}

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (maxExclusive) => Math.floor(next() * maxExclusive),
    pick: (items) => items[Math.floor(next() * items.length)],
    bernoulli: (p) => next() < p,
  };
}

export function weighted<T>(rng: Rng, values: readonly T[], weights: number[]): T {
  let target = rng.next();
  for (let i = 0; i < values.length; i++) {
    target -= weights[i];
    if (target <= 0) return values[i];
  }
  return values[values.length - 1];
}