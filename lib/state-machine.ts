import type { RecoveryEpisode } from "@/lib/domain";

const transitions: Record<RecoveryEpisode["status"], RecoveryEpisode["status"][]> = {
  DETECTED: ["DIAGNOSED", "ESCALATED"],
  DIAGNOSED: ["SCORED", "ESCALATED"],
  SCORED: ["PROPOSED", "ESCALATED"],
  PROPOSED: ["POLICY_CHECK", "ESCALATED"],
  POLICY_CHECK: ["EXECUTING", "PENDING", "STOPPED", "ESCALATED"],
  EXECUTING: ["PENDING", "FAILED", "PROMISED"],
  PENDING: ["RECOVERED", "FAILED", "EXPIRED", "ESCALATED"],
  PROMISED: ["RECOVERED", "FAILED", "EXPIRED", "ESCALATED"],
  RECOVERED: [],
  FAILED: [],
  EXPIRED: [],
  ESCALATED: [],
  STOPPED: [],
};

export function transitionEpisode<T extends RecoveryEpisode>(episode: T, nextStatus: RecoveryEpisode["status"]): T {
  if (!transitions[episode.status].includes(nextStatus)) {
    throw new Error(`Invalid recovery episode transition: ${episode.status} -> ${nextStatus}`);
  }
  return { ...episode, status: nextStatus, updatedAt: new Date().toISOString() };
}
