/** Lifecycle is document authority/progress, never conversation membership. */
import type { MutationActor } from "./contracts.ts"
export const LIFECYCLE_PHASES = ["design", "engineering", "planning", "execution"] as const
export type LifecyclePhase = (typeof LIFECYCLE_PHASES)[number]
export const WORKSTREAM_STATUSES = ["open", "blocked", "done", "abandoned"] as const
export const STATE_ENTRY_STATUSES = ["pending", "in_progress", "delivered", "approved", "blocked"] as const
export const JOB_STATUSES = ["planned", "running", "completed"] as const
export type JobStatus = (typeof JOB_STATUSES)[number]
export interface LifecycleMutation { actor: MutationActor; correlationId: string; timestamp: string }
export interface LifecycleJob {
  job_id: string; spec_path: string; report_path: string | null; status: JobStatus
  updated_at: string
}
export interface LifecycleApproval {
  id: string; phase: LifecyclePhase; artifact_path: string; files: string[]; sane_hash: string
  approval_ref: string; approved_at: string
}
export interface Lifecycle {
  status: (typeof WORKSTREAM_STATUSES)[number]
  phases: { phase: LifecyclePhase; status: (typeof STATE_ENTRY_STATUSES)[number]; owner_role: string; approval_ref: string | null }[]
  approvals: LifecycleApproval[]
  jobs: LifecycleJob[]
  mutations: (LifecycleMutation & { operation: string })[]
}
export function initialLifecycle(): Lifecycle {
  return { status: "open", phases: LIFECYCLE_PHASES.map(phase => ({ phase, status: "pending", owner_role: phase, approval_ref: null })), approvals: [], jobs: [], mutations: [] }
}
export function lifecyclePhase(value: string): LifecyclePhase {
  if (!(LIFECYCLE_PHASES as readonly string[]).includes(value)) throw new Error(`Invalid phase "${value}". Expected one of: ${LIFECYCLE_PHASES.join(", ")}.`)
  return value as LifecyclePhase
}
export function jobStatusOrder(status: JobStatus): number { return JOB_STATUSES.indexOf(status) }
