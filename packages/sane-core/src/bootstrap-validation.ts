import { lstatSync } from "node:fs"
import { join } from "node:path"
import { ROOT_DOC_BY_TYPE } from "./bootstrap-registry.ts"
import type { WorkstreamType } from "./workstream-type.ts"

export const REQUIRED_WORKSTREAM_FILES = ["design/SDD.md", "resources/SDD_TEMPLATE.md", "resources/SOLUTION_SPEC_TEMPLATE.md", "resources/RESEARCH_REPORT_TEMPLATE.md", "resources/PLAN_TEMPLATE.md", "resources/JOB_TEMPLATE.md", "resources/EXECUTION_REPORT_TEMPLATE.md", "resources/EXECUTION_FINAL_REPORT_TEMPLATE.md"] as const
export const ROOT_DOC_CANDIDATES = ["PRD.md", "FOUNDATION.md", "ISSUE.md", "MAINTENANCE.md"] as const
export const OLD_WORKSTREAM_FILES = ["SANE_CONTEXT.md", "SDD.md", "execution/BRIEF.md"] as const
export const OLD_WORKSTREAM_DIRS = ["solutions", "plan", "planning"] as const
export const RETIRED_WORKSTREAM_FILES = ["resources/IMPLEMENTATION_REPORT_TEMPLATE.md", "resources/STAGE_IMPLEMENTATION_BRIEF_TEMPLATE.md", "resources/SECTION_SPEC_TEMPLATE.md", "resources/ROOT_DESIGN_SPEC_TEMPLATE.md", "resources/STAGES_TEMPLATE.md", "resources/STAGE_DESIGN_SPEC_TEMPLATE.md", "resources/STAGE_SECTIONS_TEMPLATE.md", "resources/EXECUTION_PLAN_TEMPLATE.md"] as const
/** Existing ordinary bootstrap admission policy. Inspection never repairs files/state. */
export function inspectBootstrappedWorkstream(path: string, inspect: typeof lstatSync = lstatSync): WorkstreamType {
  const stat = (path: string) => { try { return inspect(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error } }
  if (!stat(path)?.isDirectory()) throw new Error(`Workstream is not an existing directory: ${path}`)
  for (const filename of RETIRED_WORKSTREAM_FILES) if (stat(join(path, filename))?.isFile()) throw new Error(`Workstream contains retired Stage artifact and is not a current workstream: ${join(path, filename)}`)
  for (const filename of OLD_WORKSTREAM_FILES) if (stat(join(path, filename))?.isFile()) throw new Error(`Workstream contains old-layout file ${filename} at ${join(path, filename)}; expected new layout with design/SDD.md, design/solutions/, execution/PLAN.md, execution/jobs/, execution/FINAL_REPORT.md, execution/reports/. Re-create the workstream with the current bootstrap.`)
  for (const dirname of OLD_WORKSTREAM_DIRS) if (stat(join(path, dirname))) throw new Error(`Workstream contains old-layout directory ${dirname}/ at ${join(path, dirname)}; expected new layout with top-level dirs exactly design/, execution/, research/, resources/. Re-create the workstream with the current bootstrap.`)
  for (const filename of REQUIRED_WORKSTREAM_FILES) if (!stat(join(path, filename))?.isFile()) throw new Error(`Workstream is not bootstrapped; missing regular file: ${join(path, filename)}`)
  const present = ROOT_DOC_CANDIDATES.filter(candidate => stat(join(path, candidate))?.isFile())
  if (present.length === 0) throw new Error(`Workstream is not bootstrapped; missing root document (exactly one of ${ROOT_DOC_CANDIDATES.join(", ")} required): ${path}`)
  if (present.length > 1) throw new Error(`Workstream must contain exactly one root document; found ${present.join(", ")} in ${path}`)
  return (Object.keys(ROOT_DOC_BY_TYPE) as WorkstreamType[]).find(type => ROOT_DOC_BY_TYPE[type] === present[0])!
}
