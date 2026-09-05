import type { RecoveryEpisode } from "@/lib/domain";
import { Clock } from "./clock";

const transitions: Record<RecoveryEpisode["status"], RecoveryEpisode["status"][]> = {
  DETECTED: ["DIAGNOSED", "ESCALATED"],
  DIAGNOSED: ["SCORED", "ESCALATED"],
  SCORED: ["PROPOSED", "ESCALATED"],
  PROPOSED: ["POLICY_CHECK", "ESCALATED"],
  POLICY_CHECK: ["EXECUTING", "PENDING", "STOPPED", "ESCALATED", "HELD_OUT", "HELD_DEGRADED", "SUPPRESSED"],
  EXECUTING: ["PENDING", "FAILED", "PROMISED"],
  PENDING: ["RECOVERED", "FAILED", "EXPIRED", "ESCALATED"],
  PROMISED: ["RECOVERED", "FAILED", "EXPIRED", "ESCALATED"],
  HELD_OUT: ["RECOVERED", "FAILED", "EXPIRED", "ESCALATED"],
  HELD_DEGRADED: ["POLICY_CHECK"],
  SUPPRESSED: [],
  RECOVERED: [],
  FAILED: [],
  EXPIRED: [],
  ESCALATED: [],
  STOPPED: [],
};

export function transitionEpisode<T extends RecoveryEpisode>(episode: T, nextStatus: RecoveryEpisode["status"], clock: Clock): T {
  if (!transitions[episode.status].includes(nextStatus)) {
    throw new Error(`Invalid recovery episode transition: ${episode.status} -> ${nextStatus}`);
  }
  return { ...episode, status: nextStatus, updatedAt: new Date(clock.now()).toISOString() };
}
