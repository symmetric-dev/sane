import { isAssistantAgentId, isWorkerAgentId, type StoredSaneAgentIdentity, type WorkerAgentId } from "./agent-catalog.ts"
import { readWorkerProcedure } from "./sane-worker-procedures.ts"
import { readFramework, standingFrameworkNames } from "./sane-framework.ts"

/** Composition/assignment format version; canonical prose revisions use pinned package hashes. */
export const SANE_CONTEXT_VERSION = 6

export type SaneFrameworkContext = { version: number; text: string }
/** Current assistants get core + assistant; Planning and Execution also get assignment discipline.
 * Workers get core; everything else gets none. */
export function frameworkContext(agent: StoredSaneAgentIdentity | undefined, pinned?: readonly { id: string; text: string }[]): SaneFrameworkContext | null {
  if (!agent || !(agent.kind === "assistant" ? isAssistantAgentId(agent.role) : isWorkerAgentId(agent.role))) return null
  const text = standingFrameworkNames(agent).map(name => {
    if (!pinned) return readFramework(name).text
    const asset = pinned.find(asset => asset.id === `framework.${name}`)
    if (!asset?.text.trim()) throw new Error(`Pinned framework context is missing: ${name}`)
    return asset.text
  }).join("\n\n")
  return { version: SANE_CONTEXT_VERSION, text }
}

export type SaneSessionRoots = { workstreamId: string | null; workstreamRoot: string | null; implementationRoot: string }
/** Startup membership; null when the conversation has no workstream. */
export function sessionContext(roots: SaneSessionRoots): string | null {
  if (roots.workstreamId === null) return null
  if (roots.workstreamRoot === null) throw new Error(`Workstream ${roots.workstreamId} has no workstream root`)
  return [
    "# SANE Session",
    "",
    `Workstream: ${roots.workstreamId}`,
    `Workstream root: ${roots.workstreamRoot}`,
    `Implementation root: ${roots.implementationRoot}`,
  ].join("\n")
}

export type SaneAssignmentRoots = { workstreamRoot: string | null; implementationRoot: string }
export type SaneAssignmentJob = { jobId: string; specPath: string; reportPath: string; reportTemplatePath: string }
/** Paths only, never file contents. Roots themselves arrive through the SANE Session block. */
export function assignmentContext(roots: SaneAssignmentRoots, jobs: readonly SaneAssignmentJob[]): string {
  return [
    "# SANE Assignment",
    "",
    "Directory conventions:",
    `- \`<implementation>/\` = ${roots.implementationRoot}`,
    ...(roots.workstreamRoot ? [`- \`<workstream>/\` = ${roots.workstreamRoot}`] : []),
    ...jobs.flatMap(job => [
      "",
      `Job: ${job.jobId}`,
      `Job spec: ${job.specPath}`,
      `Job report: ${job.reportPath}`,
      `Report template: ${job.reportTemplatePath}`,
    ]),
  ].join("\n")
}
/** A worker's assignment: its role procedure, then its roots and jobs. The implementer procedure
 * is Job-Spec specific, so a free-mode implementer (no job) receives only its roots. */
export function workerContext(role: WorkerAgentId, roots: SaneAssignmentRoots, jobs: readonly SaneAssignmentJob[], procedure?: string): string {
  if (role === "implementer" && !jobs.length) return assignmentContext(roots, jobs)
  return `${procedure ?? readWorkerProcedure(role)}\n\n${assignmentContext(roots, jobs)}`
}
