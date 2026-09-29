import { basename } from "node:path"
import { jobStatusOrder, type JobStatus } from "./lifecycle.ts"

/** Register only validated spec paths. The caller owns the transaction. */
export function registerPlannedJobs<T extends { job_id: string; spec_path: string }>(
  existing: T[],
  validatedFiles: string[],
  createJob: (spec: { jobId: string; specPath: string }) => T,
): T[] {
  const byId = new Map(existing.map((job) => [job.job_id, job]))
  const byPath = new Map(existing.map((job) => [job.spec_path, job]))
  const seen = new Set<string>()
  const specs = validatedFiles.filter((path) => path.startsWith("execution/jobs/")).map((specPath) => {
    const base = basename(specPath, ".md")
    const jobId = base.split("-")[0]!
    if (!jobId.trim()) throw new Error(`Invalid job ID in spec: ${specPath}`)
    if (seen.has(jobId)) throw new Error(`Duplicate job ID "${jobId}" in job specs.`)
    seen.add(jobId)
    const job = byId.get(jobId)
    if (job && job.spec_path !== specPath) {
      throw new Error(`Job ID "${jobId}" is already registered to ${job.spec_path}; cannot reassign it to ${specPath}.`)
    }
    const owner = byPath.get(specPath)
    if (owner && owner.job_id !== jobId) {
      throw new Error(`Spec path ${specPath} is already registered to job "${owner.job_id}"; cannot reassign it to "${jobId}".`)
    }
    return { jobId, specPath }
  })
  // Check the entire batch before inserting; existing rows are never updated.
  return specs.map((spec) => byId.get(spec.jobId) ?? createJob(spec))
}

export function assertJobProgress(jobId: string, current: JobStatus, next: JobStatus): void {
  if (jobStatusOrder(next) < jobStatusOrder(current)) throw new Error(`Job "${jobId}" cannot move ${current} -> ${next} (backward moves rejected; statuses only track forward progress).`)
}

/** The caller owns the transaction and storage; effects/order match ordinary approval. */
export function approvalEffects<T>(phase: string, ports: { registerJobs: () => T[]; completeJobs: () => T[]; recordApproval: () => void; approvePhase: () => void }): T[] {
  const jobs = phase === "planning" ? ports.registerJobs() : phase === "execution" ? ports.completeJobs() : []
  ports.recordApproval()
  ports.approvePhase()
  return jobs
}
