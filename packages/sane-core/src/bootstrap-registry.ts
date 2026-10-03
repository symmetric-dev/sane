import { fileURLToPath } from "node:url"
import type { WorkstreamType } from "./workstream-type.ts"
export const ROOT_DOC_BY_TYPE: Record<WorkstreamType, string> = { feature: "PRD.md", foundation: "FOUNDATION.md", issue: "ISSUE.md", maintenance: "MAINTENANCE.md" }

/** Root documents and fallback resources used by both ordinary and candidate create. */
export interface TemplateMapping { source: string; destination: string }
export type TemplateRegistry = readonly TemplateMapping[]
const SHARED_INITIAL_TEMPLATE_REGISTRY = [
  { source: "shared/sdd/SDD.md", destination: "design/SDD.md" },
  { source: "shared/sdd/SDD.md", destination: "resources/SDD_TEMPLATE.md" },
  { source: "shared/solutions/SOLUTION.md", destination: "resources/SOLUTION_SPEC_TEMPLATE.md" },
  { source: "shared/research/REPORT.md", destination: "resources/RESEARCH_REPORT_TEMPLATE.md" },
  { source: "shared/plan/PLAN.md", destination: "resources/PLAN_TEMPLATE.md" },
  { source: "shared/plan/JOB.md", destination: "resources/JOB_TEMPLATE.md" },
  { source: "shared/plan/VERIFICATION.md", destination: "resources/VERIFICATION_SPEC_TEMPLATE.md" },
  { source: "shared/execution/REPORT.md", destination: "resources/EXECUTION_REPORT_TEMPLATE.md" },
  { source: "shared/execution/TEST_REPORT.md", destination: "resources/TEST_REPORT_TEMPLATE.md" },
  { source: "shared/execution/FINAL_REPORT.md", destination: "resources/EXECUTION_FINAL_REPORT_TEMPLATE.md" },
] as const satisfies TemplateRegistry
const TYPE_INITIAL_TEMPLATE_REGISTRY: Record<WorkstreamType, TemplateRegistry> = {
  feature: [{ source: "feature/PRD.md", destination: "PRD.md" }],
  foundation: [{ source: "foundation/FOUNDATION.md", destination: "FOUNDATION.md" }],
  issue: [{ source: "issue/ISSUE.md", destination: "ISSUE.md" }],
  maintenance: [{ source: "maintenance/MAINTENANCE.md", destination: "MAINTENANCE.md" }],
}
export function initialTemplateRegistry(type: WorkstreamType): TemplateRegistry {
  return [...SHARED_INITIAL_TEMPLATE_REGISTRY, ...TYPE_INITIAL_TEMPLATE_REGISTRY[type]]
}
export const INITIAL_DIRECTORIES = ["design", "execution", "research", "resources"] as const
export const DEFAULT_TEMPLATE_ROOT = fileURLToPath(new URL("../../../templates/", import.meta.url))
