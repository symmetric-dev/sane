/** Canonical SANE assistant catalog shared by installers and the App. */
export const ASSISTANT_AGENT_IDS = [
  "design",
  "engineering",
  "execution",
  "curation",
  "experimentation",
  "planning",
  "research",
] as const

export type AssistantAgentId = (typeof ASSISTANT_AGENT_IDS)[number]

export const ASSISTANT_AGENT_LABELS: Record<AssistantAgentId, string> = {
  design: "Design",
  engineering: "Engineering",
  execution: "Execution",
  curation: "Curation",
  experimentation: "Experimentation",
  planning: "Planning",
  research: "Research",
}

export const ASSISTANT_AGENT_DESCRIPTIONS: Record<AssistantAgentId, string> = {
  design: "Helps the user develop the typed root doc and SDD for one single-scope workstream.",
  engineering: "Helps the user turn the approved SDD into comprehensive solution specs.",
  execution: "Coordinates authorized SANE job execution, read-only reviews, and bounded fixes.",
  curation: "Works with the user to review repository and SANE session evidence, preserve useful knowledge, and address operational gaps.",
  experimentation: "Works with the user to test hypotheses, develop proofs of concept, and create prototypes.",
  planning: "Helps the user confirm a compact Execution Plan, then drafts Job Specs and delegates bounded repository grounding before final package approval.",
  research: "Supports one workstream with topic evidence.",
}

export function isAssistantAgentId(value: unknown): value is AssistantAgentId {
  return typeof value === "string" && (ASSISTANT_AGENT_IDS as readonly string[]).includes(value)
}

/** Archival identity evidence, never new picker choices. Prototype was only a slot. */
export type StoredAssistantAgentId = AssistantAgentId | "knowledge"
export function isStoredAssistantAgentId(value: unknown): value is StoredAssistantAgentId {
  return value === "knowledge" || isAssistantAgentId(value)
}

export function validAgent(value: unknown): value is AssistantAgentId {
  return isAssistantAgentId(value)
}

export const WORKER_AGENT_IDS = ["implementer", "fixer", "tester", "grounder", "researcher", "reviewer", "scout", "scout-crew"] as const
export type WorkerAgentId = (typeof WORKER_AGENT_IDS)[number]
/** Descriptive metadata only; access is never an admission or permissions policy. */
export const WORKER_AGENT_CATALOG: Record<WorkerAgentId, { label: string; description: string; access: "code" | "artifacts" | "read" }> = {
  implementer: { label: "Implementer", description: "Implements one bounded assignment and reports its outcome or an evidenced prerequisite gap.", access: "code" },
  fixer: { label: "Fixer", description: "Applies a bounded correction and reports the verified outcome or remaining obstacle.", access: "code" },
  tester: { label: "Tester", description: "Writes and runs focused tests for specified behavior and reports the verified results.", access: "code" },
  grounder: { label: "Grounder", description: "Verifies a bounded repository scope and enriches assigned specification documents in place with evidence.", access: "artifacts" },
  researcher: { label: "Researcher", description: "Investigates one bounded external-evidence question and writes findings only to its assigned outputs.", access: "artifacts" },
  reviewer: { label: "Reviewer", description: "Reviews implemented work or assesses the prerequisites preventing an assignment from proceeding, read-only.", access: "read" },
  scout: { label: "Scout", description: "Inspects a bounded repository scope and returns findings or blockers inline to its parent without changing files.", access: "read" },
  "scout-crew": { label: "Scout Crew", description: "Coordinates parallel scouts to map a bounded repository question breadth-first and synthesize their findings.", access: "read" },
}
export function isWorkerAgentId(value: unknown): value is WorkerAgentId {
  return typeof value === "string" && (WORKER_AGENT_IDS as readonly string[]).includes(value)
}
/** Jobs a role may be assigned; SANE resolves their paths when it creates the worker. */
export const WORKER_JOB_ASSIGNMENT: Record<WorkerAgentId, "one" | "some" | "none"> = { implementer: "one", fixer: "some", tester: "some", reviewer: "some", grounder: "none", researcher: "none", scout: "none", "scout-crew": "none" }
export const MAX_WORKER_JOBS = 64
export const WORKER_JOB_ID_PATTERN = "^[a-z0-9][a-z0-9_-]{0,95}$"
const workerJobId = new RegExp(WORKER_JOB_ID_PATTERN)
/** Returns why jobs are invalid for the role, or undefined when acceptable (absent jobs included). */
export function workerJobsProblem(worker: WorkerAgentId, jobs: unknown): string | undefined {
  const rule = WORKER_JOB_ASSIGNMENT[worker]
  if (jobs === undefined) return rule === "one" ? `${worker} requires jobs with exactly one job ID.` : undefined
  if (rule === "none") return `jobs is not allowed for ${worker} workers.`
  if (!Array.isArray(jobs) || !jobs.length || jobs.length > (rule === "one" ? 1 : MAX_WORKER_JOBS) || !jobs.every(job => typeof job === "string" && workerJobId.test(job)) || new Set(jobs).size !== jobs.length) return rule === "one" ? `${worker} requires jobs with exactly one safe lowercase job ID.` : `jobs must list 1–${MAX_WORKER_JOBS} unique safe lowercase job IDs.`
  return undefined
}
export type SaneAgentIdentity = { kind: "assistant"; role: AssistantAgentId } | { kind: "worker"; role: WorkerAgentId }
export type StoredSaneAgentIdentity = { kind: "assistant"; role: StoredAssistantAgentId } | { kind: "worker"; role: WorkerAgentId }
/** Do not canonicalize archival selections: native instructions are identity-specific. */
export function nativeAgentId(identity: StoredSaneAgentIdentity, harness: "claude-code" | "opencode"): string {
  return harness === "opencode" ? `sane/${identity.kind}/${identity.role}` : `sane-${identity.kind}-${identity.role}`
}
