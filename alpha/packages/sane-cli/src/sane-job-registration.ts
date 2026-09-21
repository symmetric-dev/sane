import type { Database } from "bun:sqlite"
import { basename } from "node:path"

import { createJob, listJobs, type MutationContext, type SaneIdentity, type JobRow } from "./sane-db.ts"
import { SaneWorkstreamStateError } from "./sane-workstream-state.ts"

/** Register only validated spec paths. The caller owns the transaction. */
export function registerPlannedJobs(
  db: Database,
  identity: SaneIdentity,
  validatedFiles: string[],
  mutation: MutationContext,
): JobRow[] {
  const existing = listJobs(db, identity)
  const byId = new Map(existing.map((job) => [job.job_id, job]))
  const byPath = new Map(existing.map((job) => [job.spec_path, job]))
  const seen = new Set<string>()
  const specs = validatedFiles.filter((path) => path.startsWith("execution/jobs/")).map((specPath) => {
    const base = basename(specPath, ".md")
    const jobId = base.split("-")[0]!
    if (!jobId.trim()) throw new SaneWorkstreamStateError(`Invalid job ID in spec: ${specPath}`)
    if (seen.has(jobId)) throw new SaneWorkstreamStateError(`Duplicate job ID "${jobId}" in job specs.`)
    seen.add(jobId)
    const job = byId.get(jobId)
    if (job && job.spec_path !== specPath) {
      throw new SaneWorkstreamStateError(`Job ID "${jobId}" is already registered to ${job.spec_path}; cannot reassign it to ${specPath}.`)
    }
    const owner = byPath.get(specPath)
    if (owner && owner.job_id !== jobId) {
      throw new SaneWorkstreamStateError(`Spec path ${specPath} is already registered to job "${owner.job_id}"; cannot reassign it to "${jobId}".`)
    }
    return { jobId, specPath }
  })
  // Check the entire batch before inserting; existing rows are never updated.
  return specs.map((spec) => byId.get(spec.jobId) ?? createJob(db, identity, spec, mutation))
}
