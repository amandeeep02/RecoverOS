// lib/money.ts
export type Paise = number;   // ALWAYS an integer

export const rupees = (r: number): Paise => Math.round(r * 100);
export const toRupees = (p: Paise): number => p / 100;

export function formatInr(p: Paise): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  }).format(p / 100);
}

export function scale(p: Paise, rate: number): Paise {
  return Math.round(p * rate);
}

export function assertPaise(p: number, label: string): void {
  if (!Number.isInteger(p)) throw new Error(`${label} must be integer paise, got ${p}`);
}