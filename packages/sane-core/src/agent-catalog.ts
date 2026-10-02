/** Canonical SANE assistant catalog shared by installers and the App. */
export const ASSISTANT_AGENT_IDS = [
  "design",
  "engineering",
  "execution",
  "knowledge",
  "planning",
  "research",
] as const

export type AssistantAgentId = (typeof ASSISTANT_AGENT_IDS)[number]

export const ASSISTANT_AGENT_LABELS: Record<AssistantAgentId, string> = {
  design: "Design",
  engineering: "Engineering",
  execution: "Execution",
  knowledge: "Knowledge",
  planning: "Planning",
  research: "Research",
}

export const ASSISTANT_AGENT_DESCRIPTIONS: Record<AssistantAgentId, string> = {
  design: "Helps the user develop the typed root doc and SDD for one single-scope workstream.",
  engineering: "Helps the user turn the approved SDD into comprehensive solution specs.",
  execution: "Coordinates authorized SANE job execution, read-only reviews, and bounded fixes.",
  knowledge: "Helps the user improve repository skills, development scripts, documentation, and tooling from verified evidence.",
  planning: "Helps the user confirm a compact Execution Plan, then drafts Job Specs and delegates bounded repository grounding before final package approval.",
  research: "Supports one workstream with topic evidence.",
}

export function isAssistantAgentId(value: unknown): value is AssistantAgentId {
  return typeof value === "string" && (ASSISTANT_AGENT_IDS as readonly string[]).includes(value)
}

export function validAgent(value: unknown): value is AssistantAgentId {
  return isAssistantAgentId(value)
}

export const WORKER_AGENT_IDS = ["implementer", "fixer", "tester", "grounder", "researcher", "reviewer", "scout", "scout-crew"] as const
export type WorkerAgentId = (typeof WORKER_AGENT_IDS)[number]
/** Descriptive metadata only; access is never an admission or permissions policy. */
export const WORKER_AGENT_CATALOG: Record<WorkerAgentId, { label: string; description: string; access: "code" | "artifacts" | "read" }> = {
  implementer: { label: "Implementer", description: "Implements one bounded job and reports its outcome or prerequisite gap.", access: "code" },
  fixer: { label: "Fixer", description: "Applies a bounded correction and reports the outcome.", access: "code" },
  tester: { label: "Tester", description: "Writes and runs focused tests for an execution checkpoint.", access: "code" },
  grounder: { label: "Grounder", description: "Grounds job specifications and enriches execution context with repository evidence.", access: "artifacts" },
  researcher: { label: "Researcher", description: "Investigates a bounded external-evidence question and records findings.", access: "artifacts" },
  reviewer: { label: "Reviewer", description: "Reviews implementation or assesses prerequisites without modifying files.", access: "read" },
  scout: { label: "Scout", description: "Inspects a bounded repository scope and returns findings without modifying files.", access: "read" },
  "scout-crew": { label: "Scout Crew", description: "Coordinates repository scouts and synthesizes their findings.", access: "read" },
}
export function isWorkerAgentId(value: unknown): value is WorkerAgentId {
  return typeof value === "string" && (WORKER_AGENT_IDS as readonly string[]).includes(value)
}
export type SaneAgentIdentity = { kind: "assistant"; role: AssistantAgentId } | { kind: "worker"; role: WorkerAgentId }
export function nativeAgentId(identity: SaneAgentIdentity, harness: "claude-code" | "opencode"): string {
  return harness === "opencode" ? `sane/${identity.kind}/${identity.role}` : `sane-${identity.kind}-${identity.role}`
}
