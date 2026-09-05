// lib/experiment.ts
import { mulberry32, type Rng } from "@/lib/rng";

export const EXPERIMENT_SALT = "recoveros-v1";
export const SALT_VERSION = "v1";
export const HOLDOUT_PCT = 5;
export const HOLDOUT_VALUE_CAP_PAISE = 5_000_000; // ₹50,000

/** FNV-1a 32-bit. Deterministic across Node and browser. Do not substitute. */
export function hashToBucket(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 100; // 0..99
}

/**
 * Assigns a randomization arm. The key is the **interference unit**, not the episode:
 * contact fatigue is per-customer, so two episodes of the same customer must land in the
 * same arm or treatment leaks into control (a SUTVA violation). `lib/policy.ts` passes
 * `event.customerId`. The parameter is named `clusterKey` rather than `episodeId`
 * precisely so the next caller cannot get this wrong by reading the signature — which is
 * how the original defect was introduced.
 */
export function assignArm(
  clusterKey: string,
  holdoutPct: number = HOLDOUT_PCT,
  salt: string = EXPERIMENT_SALT,
  rng?: Rng,
): "TREATMENT" | "HOLDOUT" {
  if (holdoutPct <= 0) return "TREATMENT";
  if (rng) {
    return rng.bernoulli(holdoutPct / 100) ? "HOLDOUT" : "TREATMENT";
  }
  return hashToBucket(clusterKey + salt) < holdoutPct ? "HOLDOUT" : "TREATMENT";
}

// `ExperimentAssignment` and `createAssignment` used to live here: a helper returning
// the full assignment record with salt version and timestamp. It had zero callers, and
// it called `assignArm(episodeId, ...)`. So the first person to persist assignments in
// the product path would have reached for the API that *looks* production-shaped and
// silently reintroduced episode-level randomization — the precise defect RESULTS.md
// devotes a section to. The `customersSplitAcrossArms === 0` assertion runs only in the
// eval harness, so nothing would have caught it. Deleted rather than fixed: a correct
// function nobody calls is still a loaded gun on the table.
