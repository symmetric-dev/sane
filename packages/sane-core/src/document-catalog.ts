import { basename } from "node:path"
import { ROOT_DOC_BY_TYPE } from "./bootstrap-registry.ts"
import type { WorkstreamDocument, WorkstreamDocumentPhase, WorkstreamType } from "./contracts.ts"
import type { LifecycleJob } from "./lifecycle.ts"

type Descriptor = Omit<WorkstreamDocument, "exists" | "revision">
const PHASES: WorkstreamDocumentPhase[] = ["design", "engineering", "planning", "execution", "research", "resources"]
const TITLES: Record<string, string> = {
  "PRD.md": "Product Requirements", "FOUNDATION.md": "Foundation", "ISSUE.md": "Issue", "MAINTENANCE.md": "Maintenance",
  "design/SDD.md": "Software Design", "execution/PLAN.md": "Execution Plan", "execution/FINAL_REPORT.md": "Final Report",
  "design/solutions/SOLUTION.md": "Solution Specification", "README.md": "Workstream Overview",
  "resources/SDD_TEMPLATE.md": "Software design template", "resources/SOLUTION_SPEC_TEMPLATE.md": "Solution specification template",
  "resources/RESEARCH_REPORT_TEMPLATE.md": "Research report template", "resources/PLAN_TEMPLATE.md": "Execution plan template",
  "resources/JOB_TEMPLATE.md": "Job specification template", "resources/VERIFICATION_SPEC_TEMPLATE.md": "Verification specification template",
  "resources/EXECUTION_REPORT_TEMPLATE.md": "Job report template", "resources/TEST_REPORT_TEMPLATE.md": "Test report template",
  "resources/EXECUTION_FINAL_REPORT_TEMPLATE.md": "Final report template",
}
const direct = (path: string, directory: string) => path.startsWith(`${directory}/`) && !path.slice(directory.length + 1).includes("/")
function title(path: string): string {
  const topic = /^research\/([^/]+)\/REPORT\.md$/.exec(path)?.[1]
  if (topic) {
    const label = topic.replace(/[-_]+/g, " ")
    return `${label.charAt(0).toUpperCase()}${label.slice(1)} report`
  }
  return TITLES[path] ?? basename(path, ".md").replace(/[-_]+/g, " ")
}

/** Path policy only: cataloging does not validate, approve, or mutate documents. */
function classify(path: string, type: WorkstreamType): Descriptor {
  const descriptor: Descriptor = { path, title: title(path), phase: "resources", kind: "resource", required: false }
  if (path === ROOT_DOC_BY_TYPE[type] || path === "design/SDD.md") return { ...descriptor, phase: "design", kind: "primary", required: true }
  if (Object.values(ROOT_DOC_BY_TYPE).includes(path)) return { ...descriptor, phase: "design", kind: "supporting" }
  if (basename(path) === "README.md" || path.startsWith("resources/")) return descriptor
  if (path.startsWith("design/solutions/")) return { ...descriptor, phase: "engineering", kind: direct(path, "design/solutions") ? "primary" : "supporting", required: direct(path, "design/solutions") }
  if (path.startsWith("design/")) return { ...descriptor, phase: "design", kind: "supporting" }
  if (path === "execution/PLAN.md") return { ...descriptor, phase: "planning", kind: "primary", required: true }
  if (path.startsWith("execution/jobs/") || path.startsWith("execution/verification/")) {
    const primary = direct(path, "execution/jobs") || direct(path, "execution/verification")
    return { ...descriptor, phase: "planning", kind: primary ? "primary" : "supporting", required: primary }
  }
  if (path === "execution/FINAL_REPORT.md") return { ...descriptor, phase: "execution", kind: "primary", required: true }
  if (path.startsWith("execution/reports/") || path.startsWith("execution/test-reports/")) return { ...descriptor, phase: "execution", kind: direct(path, "execution/reports") || direct(path, "execution/test-reports") ? "primary" : "supporting" }
  if (path.startsWith("research/")) return { ...descriptor, phase: "research", kind: "supporting" }
  return descriptor
}

/** Use the same checkpoint label/filename convention as phase validation. */
function planReferences(plan: string): { jobs: string[]; checkpoints: string[] } {
  // Template guidance and fenced examples are not authored references.
  const authored = plan.replace(/<!--[\s\S]*?(?:-->|$)/g, "").replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*(?:\n|$)/gm, "")
  const section = authored.split(/^## Execution Checkpoints\s*$/m)[1]?.split(/^## /m)[0] ?? ""
  const labels = [...section.matchAll(/^\|\s*([^|]+?)\s*\|/gm)].map(match => match[1]!.trim())
  const checkpoints = labels.filter(label => label !== "Checkpoint" && /^[A-Za-z0-9][A-Za-z0-9_-]*(?: [A-Za-z0-9][A-Za-z0-9_-]*)*$/.test(label))
    .map(label => `${label.toLowerCase().replace(/ +/g, "-")}.md`)
  // A prose job name does not uniquely specify a slug; only explicit paths are authoritative.
  const jobs = [...authored.matchAll(/(?:^|[\s`(["'])(execution\/jobs\/[A-Za-z0-9_-]+\.md)(?=$|[\s`\])"'#])/gm)].map(match => match[1]!)
  return { jobs, checkpoints }
}

/** Merge known missing references with existing paths, one descriptor per path. */
export function documentDescriptors(input: {
  type: WorkstreamType; paths: string[]; jobs: Pick<LifecycleJob, "spec_path" | "report_path">[];
  researchPaths: string[]; plan: string | null;
}): Descriptor[] {
  const documents = new Map(input.paths.map(path => [path, classify(path, input.type)]))
  const expect = (path: string, phase: WorkstreamDocumentPhase) => documents.set(path, { path, title: title(path), phase, kind: "primary", required: true })
  expect(ROOT_DOC_BY_TYPE[input.type], "design")
  expect("design/SDD.md", "design")
  // The starter is only a missing-state affordance when no solution exists;
  // authored solutions are not required to use this particular filename.
  if (!input.paths.some(path => direct(path, "design/solutions") && basename(path) !== "README.md")) expect("design/solutions/SOLUTION.md", "engineering")
  expect("execution/PLAN.md", "planning")
  expect("execution/FINAL_REPORT.md", "execution")
  for (const job of input.jobs) {
    expect(job.spec_path, "planning")
    expect(job.report_path ?? `execution/reports/${basename(job.spec_path)}`, "execution")
  }
  for (const path of input.researchPaths) expect(path, "research")
  const references = planReferences(input.plan ?? "")
  for (const path of references.jobs) expect(path, "planning")
  const checkpoints = new Set(references.checkpoints)
  for (const path of input.paths) if (direct(path, "execution/verification") && basename(path) !== "README.md") checkpoints.add(basename(path))
  for (const name of checkpoints) {
    expect(`execution/verification/${name}`, "planning")
    expect(`execution/test-reports/${name}`, "execution")
  }
  const kinds = ["primary", "supporting", "resource"]
  return [...documents.values()].sort((a, b) => PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase) || kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
