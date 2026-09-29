/**
 * SANE `sane validate <phase>` command.
 *
 * Validates the documents a phase owns, resolved by workstream
 * auto-detection (bare invocation from the session working directory).
 * Agents never pass paths to this command; paths are only for
 * reading/editing files.
 *
 * Phase expectations (path-based):
 * - design: exactly the typed root doc plus `design/SDD.md`.
 * - engineering: one or more `design/solutions/*.md`.
 * - planning: `execution/PLAN.md`, one or more `execution/jobs/*.md`, and one
 *   `execution/verification/<checkpoint-id>.md` per Plan checkpoint.
 * - execution: `execution/FINAL_REPORT.md` plus registered completed-job
 *   report coverage and checkpoint Test Reports at approval.
 * - execution report --id: only the assigned report, checked against its spec.
 *
 * General content rules per file: must exist, must be non-empty, and must contain
 * no `<!--` guidance comments (every template carries them with an
 * instruction to replace them, so an unedited template always fails).
 * Root docs have no template copy in `resources/`; the same three rules
 * apply uniformly. Job Specs reject unresolved {{...}} prose slots.
 * Execution job reports additionally enforce their title,
 * section structure, populated sections, and resolved placeholders.
 *
 * Research index divergences and approved-but-changed docs are warnings,
 * never failures. `sane approve <phase>` runs this validation first
 * and refuses to record when problems exist.
 */
import { LifecycleAccessError, ordinaryLifecycleFileSystem, type LifecycleFileSystem } from "./lifecycle-filesystem.ts"
import { basename, join } from "node:path"

import { createHash } from "node:crypto"
import { ROOT_DOC_BY_TYPE } from "./bootstrap-registry.ts"
import type { WorkstreamType } from "./workstream-type.ts"
import { jobSpecTitle, validateExecutionReport, validateJobPlaceholders, type ReportDiagnostic } from "./execution-report-validation.ts"
import { LIFECYCLE_PHASES, type LifecycleJob } from "./lifecycle.ts"

export interface ValidationState {
  jobs: Pick<LifecycleJob, "job_id" | "spec_path" | "report_path" | "status">[]
  approval: { sane_hash: string; approval_ref: string } | null
  researchWarnings?: () => Promise<string[]>
}
function sha256Hex(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex") }
function listJobs(state: ValidationState, _identity: unknown) { return state.jobs }
function getJob(state: ValidationState, _identity: unknown, id: string) { return state.jobs.find(job => job.job_id === id) }
function getApproval(state: ValidationState, _identity: unknown, _phase: string) { return state.approval }

export const VALIDATE_PHASES = LIFECYCLE_PHASES
export type ValidatePhase = (typeof VALIDATE_PHASES)[number]


const ROOT_DOCS: readonly string[] = ["PRD.md", "FOUNDATION.md", "ISSUE.md", "MAINTENANCE.md"]

/** Workstream-relative doc required by a phase. */
interface PhaseDocSpec {
  path: string
}

function expectedDocs(phase: ValidatePhase, type: WorkstreamType): PhaseDocSpec[] {
  switch (phase) {
    case "design":
      return [{ path: ROOT_DOC_BY_TYPE[type] }, { path: "design/SDD.md" }]
    case "engineering":
      return [{ path: "design/solutions/" }]
    case "planning":
      return [{ path: "execution/PLAN.md" }, { path: "execution/jobs/" }, { path: "execution/verification/" }]
    case "execution":
      return [{ path: "execution/FINAL_REPORT.md" }, { path: "execution/reports/" }]
  }
}

export interface ValidatePhaseResult {
  repoRoot: string
  user: string
  workstreamId: string
  phase: ValidatePhase
  /** Workstream-relative paths that passed validation. */
  files: string[]
  /** Composite hash over the validated files (sorted `path:hash`). */
  hash: string
  problems: string[]
  warnings: string[]
  ok: boolean
  diagnostics?: ReportDiagnostic[]
  reportId?: string
}

async function fileExists(fs: LifecycleFileSystem, path: string): Promise<boolean> {
  try {
    const bytes = await fs.readBytes(path)
    return bytes.length >= 0
  } catch (error) {
    if (error instanceof LifecycleAccessError) throw error
    return false
  }
}

async function listMarkdownFiles(fs: LifecycleFileSystem, directory: string): Promise<string[]> {
  try {
    return (await fs.listNames(directory)).filter((name) => name.endsWith(".md")).sort()
  } catch (error) {
    if (error instanceof LifecycleAccessError) throw error
    return []
  }
}

/**
 * Validate one phase's documents inside an already-resolved workstream
 * directory. Pure logic shared by `validate` and `approve`.
 */
export async function validatePhaseDocs(
  db: ValidationState,
  identity: { repoRoot: string; user: string; workstreamId: string },
  workstreamDir: string,
  phase: ValidatePhase,
  type: WorkstreamType,
  options: { reportId?: string; completingJobs?: boolean } = {},
  fs: LifecycleFileSystem = ordinaryLifecycleFileSystem,
): Promise<ValidatePhaseResult & { captureHashes: { path: string; hash: string }[] }> {
  const problems: string[] = []
  const warnings: string[] = []
  const files: string[] = []
  const hashes: string[] = []
  const diagnostics: ReportDiagnostic[] = []
  const captures = new Map<string, Buffer | null>()
  async function readIfExists(fs: LifecycleFileSystem, path: string): Promise<string | null> {
    if (!captures.has(path)) {
      try { captures.set(path, Buffer.from(await fs.readBytes(path))) }
      catch (error) { if (error instanceof LifecycleAccessError) throw error; captures.set(path, null) }
    }
    return captures.get(path)?.toString("utf8") ?? null
  }

  async function checkReport(job: ReturnType<typeof listJobs>[number]): Promise<void> {
    const path = job.report_path ?? `execution/reports/${basename(job.spec_path)}`
    const content = await readIfExists(fs, join(workstreamDir, path))
    const spec = await readIfExists(fs, join(workstreamDir, job.spec_path))
    const title = spec === null ? null : jobSpecTitle(spec, job.job_id)
    const errors: ReportDiagnostic[] = []
    if (content === null) errors.push({ path, line: 1, message: `Missing report for job ${job.job_id}; author its assigned report.` })
    if (title === null) errors.push({ path: job.spec_path, line: 1, message: `Expected Job Spec title: # Job Spec ${job.job_id}: <job name>` })
    if (content !== null && title !== null) errors.push(...validateExecutionReport(content, path, job.job_id, title))
    diagnostics.push(...errors)
    problems.push(...errors.map((e) => `${e.path}:${e.line}: ${e.message}`))
    if (!errors.length && content !== null && !files.includes(path)) {
      files.push(path)
      hashes.push(`${path}:${sha256Hex(captures.get(join(workstreamDir, path))!)}`)
    }
  }

  async function checkFile(relativePath: string): Promise<void> {
    const full = join(workstreamDir, relativePath)
    const content = await readIfExists(fs, full)
    if (content === null) {
      problems.push(`missing: ${relativePath}`)
      return
    }
    if (content.trim() === "") {
      problems.push(`empty: ${relativePath}`)
      return
    }
    if (content.includes("<!--")) {
      problems.push(`unresolved guidance comments (<!-- -->) in: ${relativePath}`)
      return
    }
    if ((phase === "planning" && (relativePath.startsWith("execution/jobs/") || relativePath.startsWith("execution/verification/")))
      || (phase === "execution" && relativePath.startsWith("execution/test-reports/"))) {
      const errors = validateJobPlaceholders(content, relativePath)
      if (errors.length) {
        problems.push(...errors.map((e) => `${e.path}:${e.line}: ${e.message}`))
        return
      }
    }
    files.push(relativePath)
    hashes.push(`${relativePath}:${sha256Hex(captures.get(full)!)}`)
  }

  if (options.reportId !== undefined) {
    const job = getJob(db, identity, options.reportId)
    if (!job) problems.push(`Unknown registered job: ${options.reportId}`)
    else await checkReport(job)
  } else if (phase === "execution") {
    await checkFile("execution/FINAL_REPORT.md")
    const jobs = listJobs(db, identity)
    const reportPaths = new Set<string>()
    for (const job of jobs) {
      const path = job.report_path ?? `execution/reports/${basename(job.spec_path)}`
      if (reportPaths.has(path)) problems.push(`${path}:1: Report path is assigned to multiple jobs; assign one report per job.`)
      reportPaths.add(path)
      if (options.completingJobs || job.status === "completed" || await fileExists(fs, join(workstreamDir, path))) await checkReport(job)
    }
    for (const name of await listMarkdownFiles(fs, join(workstreamDir, "execution/reports"))) {
      if (!reportPaths.has(`execution/reports/${name}`)) problems.push(`execution/reports/${name}:1: Report has no registered job assignment.`)
    }
    const specs = await listMarkdownFiles(fs, join(workstreamDir, "execution/verification"))
    const reportNames = await listMarkdownFiles(fs, join(workstreamDir, "execution/test-reports"))
    for (const name of specs) {
      const path = `execution/test-reports/${name}`
      if (options.completingJobs || reportNames.includes(name)) await checkFile(path)
    }
    for (const name of reportNames) {
      if (!specs.includes(name)) problems.push(`execution/test-reports/${name}: no matching Verification Spec`)
    }
  } else if (phase === "design") {
    const expectedRoot = ROOT_DOC_BY_TYPE[type]
    for (const root of ROOT_DOCS) {
      if (root === expectedRoot) continue
      if (await fileExists(fs, join(workstreamDir, root))) {
        problems.push(`unexpected root doc for type ${type}: ${root} (exactly one root doc allowed)`)
      }
    }
    for (const spec of expectedDocs(phase, type)) {
      await checkFile(spec.path)
    }
  } else {
    for (const spec of expectedDocs(phase, type)) {
      if (!spec.path.endsWith("/")) {
        await checkFile(spec.path)
        continue
      }
      const names = await listMarkdownFiles(fs, join(workstreamDir, spec.path))
      if (names.length === 0) {
        problems.push(`no documents in: ${spec.path}`)
        continue
      }
      for (const name of names) {
        await checkFile(`${spec.path}${name}`)
      }
    }
    if (phase === "planning") {
      const plan = await readIfExists(fs, join(workstreamDir, "execution/PLAN.md"))
      if (plan !== null && !plan.includes("<!--")) {
        const section = plan.split(/^## Execution Checkpoints\s*$/m)[1]?.split(/^## /m)[0] ?? ""
        const labels = [...section.matchAll(/^\|\s*([^|]+?)\s*\|/gm)]
          .map((match) => match[1]!.trim())
          .filter((label) => label !== "Checkpoint" && !/^[-: ]+$/.test(label))
        if (labels.length === 0) problems.push("execution/PLAN.md: no Execution Checkpoints defined")
        const expected = new Set<string>()
        for (const label of labels) {
          if (!/^[A-Za-z0-9][A-Za-z0-9_-]*(?: [A-Za-z0-9][A-Za-z0-9_-]*)*$/.test(label)) {
            problems.push(`execution/PLAN.md: invalid checkpoint label: ${label}`)
            continue
          }
          const name = `${label.toLowerCase().replace(/ +/g, "-")}.md`
          if (expected.has(name)) problems.push(`execution/PLAN.md: duplicate checkpoint filename: ${name}`)
          expected.add(name)
        }
        const actual = await listMarkdownFiles(fs, join(workstreamDir, "execution/verification"))
        for (const name of expected) {
          if (!actual.includes(name)) problems.push(`missing: execution/verification/${name}`)
        }
        for (const name of actual) {
          if (!expected.has(name)) problems.push(`execution/verification/${name}: no matching Plan checkpoint`)
        }
      }
    }
  }

  // Research index divergences are warnings (pickup absorption).
  if (options.reportId === undefined) try {
    for (const mismatch of await db.researchWarnings?.() ?? []) warnings.push(mismatch)
  } catch {
    // Research check is best-effort; document problems decide validity.
  }

  // Approved-but-changed docs warn (approvals stay authority).
  const approval = getApproval(
    db,
    { repoRoot: identity.repoRoot, user: identity.user, workstreamId: identity.workstreamId },
    phase,
  )
  const hash = sha256Hex([...hashes].sort().join("\n"))
  if (options.reportId === undefined && approval && approval.sane_hash !== hash) {
    warnings.push(
      phase === "planning"
        ? `planning is approved (${approval.approval_ref}) but its documents differ from the approved snapshot; routine amendments within existing authorization may continue without reapproval. Planning must escalate decisions exceeding that authorization directly to the user.`
        : `${phase} is approved (${approval.approval_ref}) but its documents changed since approval; re-approve to refresh authority.`,
    )
  }

  files.sort()
  return {
    repoRoot: identity.repoRoot,
    user: identity.user,
    workstreamId: identity.workstreamId,
    phase,
    files,
    hash,
    problems,
    warnings,
    ok: problems.length === 0,
    captureHashes: [...captures].filter((entry): entry is [string, Buffer] => entry[1] !== null).map(([path, bytes]) => ({ path: path.slice(workstreamDir.length + 1), hash: sha256Hex(bytes) })),
    ...(phase === "execution" ? { diagnostics } : {}),
    ...(options.reportId !== undefined ? { reportId: options.reportId } : {}),
  }
}
