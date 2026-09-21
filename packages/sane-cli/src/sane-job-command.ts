/**
 * SANE `sane job` command.
 *
 * Three forms, one command:
 *
 * - `sane job <job-id>` shows the job's serialized context bundle: job row,
 *   absolute spec/report paths (with existence), report template, phase
 *   documents, and the planning approval. Workers consume it with `--json`
 *   instead of receiving pasted absolute paths: the CLI resolves everything
 *   from the database plus CWD auto-detection. The workstream is
 *   auto-detected from the current directory: agents never pass paths to
 *   this command.
 * - `sane job <job-id> <running|completed>` marks progress (ungated): the
 *   Execution Assistant moves jobs forward as work proceeds. Moves must go
 *   forward (`planned -> running -> completed`; same status is a no-op).
 *   `planned` comes from registration under Planning approval and is not an
 *   accepted target. This form is not approval: the user gate stays
 *   `sane approve execution`, which validates the final report plus job
 *   reports and batch-completes stragglers.
 * - `sane job --register` validates Planning documents and registers added
 *   specs under the existing Planning approval, without replacing it.
 */
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import {
  getApproval,
  getJob,
  getWorkstream,
  initSchema,
  openSaneDb,
  resolveSaneIdentity,
  updateJobStatus,
  type JobRow,
} from "./sane-db.ts"
import { resolveCommandAddress } from "./sane-cwd-target.ts"
import { registerPlannedJobs } from "./sane-job-registration.ts"
import { validatePhaseDocs } from "./sane-validate-command.ts"
import {
  ROOT_DOC_BY_TYPE,
  resolveBootstrappedWorkstream,
  resolveSaneRepository,
} from "./sane-repository.ts"
import type { WorkstreamType } from "./workstream-type.ts"
import { SaneWorkstreamStateError } from "./sane-workstream-state.ts"

export const JOB_TARGETS = ["running", "completed"] as const
export type JobTarget = (typeof JOB_TARGETS)[number]

const JOB_TARGET_SET = new Set<string>(JOB_TARGETS)

export interface SaneJobCommandOptions {
  implementationRepository: string
  workstreamPath: string
  jobId: string
  status: string
  json?: boolean
  userOverride?: string
  write?: (line: string) => void
}

export interface SaneJobViewOptions {
  implementationRepository: string
  workstreamPath: string
  jobId: string
  json?: boolean
  userOverride?: string
  write?: (line: string) => void
}

export interface SaneJobBundle {
  repoRoot: string
  user: string
  workstreamId: string
  job: {
    jobId: string
    status: string
    /** Absolute spec path. */
    specPath: string
    specExists: boolean
    /** Absolute report path: recorded value, else the conventional destination. */
    reportPath: string
    reportExists: boolean
  }
  /** Absolute report template path (never overwrite existing reports). */
  reportTemplate: string
  reportTemplateExists: boolean
  documents: {
    rootDoc: string
    sdd: string
    plan: string
    solutions: string[]
    /** Absolute final-report path, or null when not yet written. */
    finalReport: string | null
  }
  planningApproval: { approvalRef: string; saneHash: string } | null
}

export interface SaneJobCommandResult {
  repoRoot: string
  user: string
  workstreamId: string
  jobId: string
  status: string
  changed: boolean
}

export const USAGE =
  "Usage: sane job <job-id> [running|completed] [--json] | sane job --register [--json] (auto-detects the workstream; --register validates Planning docs and registers additions under existing Planning approval; never records approval)"

export function parseCliArguments(args: string[]): {
  implementationRepository: string
  workstreamPath: string
  jobId: string
  /** Target status, or null for the view-bundle or registration form. */
  status: string | null
  json: boolean
  register?: boolean
} {
  let json = false
  let register = false
  const positional: string[] = []
  let parseOptions = true

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (parseOptions && argument === "--") {
      parseOptions = false
    } else if (parseOptions && argument === "--json") {
      json = true
    } else if (parseOptions && argument === "--register") {
      register = true
    } else if (parseOptions && argument.startsWith("-")) {
      throw new SaneWorkstreamStateError(`Unknown option: ${argument}`)
    } else {
      positional.push(argument)
    }
  }

  if (register) {
    if (positional.length > 0) {
      throw new SaneWorkstreamStateError("Option --register cannot be combined with a job id or status.")
    }
    return { implementationRepository: "", workstreamPath: "", jobId: "", status: null, json, register: true }
  }
  if (positional.length < 1 || positional.length > 2 || !positional[0]) {
    throw new SaneWorkstreamStateError(
      "Provide exactly one job id, with an optional status (running|completed).",
    )
  }
  if (positional.length === 1) {
    // View-bundle form: the async run path auto-detects the target from CWD.
    return { implementationRepository: "", workstreamPath: "", jobId: positional[0], status: null, json }
  }
  const status = positional[1]!
  if (!JOB_TARGET_SET.has(status)) {
    throw new SaneWorkstreamStateError(
      `Invalid job status "${status}". Expected one of: ${JOB_TARGETS.join(", ")}.`,
    )
  }
  return { implementationRepository: "", workstreamPath: "", jobId: positional[0], status, json }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

async function resolveJobContext(options: {
  implementationRepository: string
  workstreamPath: string
  userOverride?: string
}): Promise<{
  db: import("bun:sqlite").Database
  identity: { repoRoot: string; user: string; workstreamId: string }
  workstream: { relativePath: string; path: string; type: WorkstreamType }
}> {
  const pointer = await resolveSaneRepository(options.implementationRepository)
  const workstream = await resolveBootstrappedWorkstream(
    pointer.workstreamsRoot,
    options.workstreamPath,
  )
  const identity = await resolveSaneIdentity(
    pointer.implementationRepository,
    workstream.relativePath,
    options.userOverride,
  )
  const db = await openSaneDb(pointer.implementationRepository)
  initSchema(db)
  return { db, identity, workstream }
}

function closeDb(db: import("bun:sqlite").Database): void {
  try {
    db.close()
  } catch {
    // Best effort.
  }
}

/**
 * Build the serialized context bundle for one job: everything a worker
 * needs (absolute paths, existence, phase documents, planning approval)
 * resolved from the database plus the workstream directory. Paths only,
 * never file contents: the worker reads the files itself.
 */
export async function buildJobBundle(
  db: import("bun:sqlite").Database,
  identity: { repoRoot: string; user: string; workstreamId: string },
  workstream: { path: string; type: WorkstreamType },
  jobId: string,
): Promise<SaneJobBundle> {
  const row = getJob(db, identity, jobId)
  if (!row) {
    throw new SaneWorkstreamStateError(
      `Job not found: ${jobId} (workstream ${identity.workstreamId}). Jobs register on planning approval or with sane job --register under existing Planning approval.`,
    )
  }
  const specPath = join(workstream.path, row.spec_path)
  const specName = row.spec_path.split("/").pop() ?? `${jobId}.md`
  const reportPath = row.report_path
    ? join(workstream.path, row.report_path)
    : join(workstream.path, "execution", "reports", specName)
  const reportTemplate = join(workstream.path, "resources", "EXECUTION_REPORT_TEMPLATE.md")
  const finalReportPath = join(workstream.path, "execution", "FINAL_REPORT.md")
  let solutionNames: string[] = []
  try {
    solutionNames = (await readdir(join(workstream.path, "design", "solutions")))
      .filter((name) => name.endsWith(".md"))
      .sort()
  } catch {
    solutionNames = []
  }
  const planningApproval = getApproval(db, identity, "planning")
  return {
    repoRoot: identity.repoRoot,
    user: identity.user,
    workstreamId: identity.workstreamId,
    job: {
      jobId: row.job_id,
      status: row.status,
      specPath,
      specExists: await pathExists(specPath),
      reportPath,
      reportExists: await pathExists(reportPath),
    },
    reportTemplate,
    reportTemplateExists: await pathExists(reportTemplate),
    documents: {
      rootDoc: join(workstream.path, ROOT_DOC_BY_TYPE[workstream.type]),
      sdd: join(workstream.path, "design", "SDD.md"),
      plan: join(workstream.path, "execution", "PLAN.md"),
      solutions: solutionNames.map((name) =>
        join(workstream.path, "design", "solutions", name),
      ),
      finalReport: (await pathExists(finalReportPath)) ? finalReportPath : null,
    },
    planningApproval: planningApproval
      ? { approvalRef: planningApproval.approval_ref, saneHash: planningApproval.sane_hash }
      : null,
  }
}

function bundleToJson(bundle: SaneJobBundle): Record<string, unknown> {
  return {
    repo_root: bundle.repoRoot,
    user: bundle.user,
    workstream_id: bundle.workstreamId,
    job: {
      job_id: bundle.job.jobId,
      status: bundle.job.status,
      spec_path: bundle.job.specPath,
      spec_exists: bundle.job.specExists,
      report_path: bundle.job.reportPath,
      report_exists: bundle.job.reportExists,
    },
    report_template: bundle.reportTemplate,
    report_template_exists: bundle.reportTemplateExists,
    documents: {
      root_doc: bundle.documents.rootDoc,
      sdd: bundle.documents.sdd,
      plan: bundle.documents.plan,
      solutions: bundle.documents.solutions,
      final_report: bundle.documents.finalReport,
    },
    planning_approval: bundle.planningApproval
      ? {
          approval_ref: bundle.planningApproval.approvalRef,
          sane_hash: bundle.planningApproval.saneHash,
        }
      : null,
  }
}

export async function runSaneJobViewCommand(
  options: SaneJobViewOptions,
): Promise<SaneJobBundle> {
  const write = options.write ?? console.log
  if (!options.jobId || options.jobId.trim() === "") {
    throw new SaneWorkstreamStateError("Provide exactly one job id.")
  }
  const { db, identity, workstream } = await resolveJobContext(options)
  try {
    const bundle = await buildJobBundle(db, identity, workstream, options.jobId)
    if (options.json === true) {
      write(JSON.stringify(bundleToJson(bundle), null, 2))
    } else {
      write(`job ${bundle.job.jobId} for ${bundle.workstreamId}: ${bundle.job.status}`)
      write(`  spec: ${bundle.job.specPath}${bundle.job.specExists ? "" : " (missing)"}`)
      write(`  report: ${bundle.job.reportPath}${bundle.job.reportExists ? "" : " (missing)"}`)
      write(`  report_template: ${bundle.reportTemplate}`)
      write(`  root_doc: ${bundle.documents.rootDoc}`)
      write(`  sdd: ${bundle.documents.sdd}`)
      write(`  plan: ${bundle.documents.plan}`)
      for (const solution of bundle.documents.solutions) write(`  solution: ${solution}`)
      write(`  final_report: ${bundle.documents.finalReport ?? "(not written)"}`)
      write(
        bundle.planningApproval
          ? `  planning_approval: ${bundle.planningApproval.approvalRef} ${bundle.planningApproval.saneHash}`
          : `  planning_approval: (none)`,
      )
    }
    return bundle
  } finally {
    closeDb(db)
  }
}

export async function runSaneJobCommand(
  options: SaneJobCommandOptions,
): Promise<SaneJobCommandResult> {
  const write = options.write ?? console.log
  if (!JOB_TARGET_SET.has(options.status)) {
    throw new SaneWorkstreamStateError(
      `Invalid job status "${options.status}". Expected one of: ${JOB_TARGETS.join(", ")}.`,
    )
  }
  if (!options.jobId || options.jobId.trim() === "") {
    throw new SaneWorkstreamStateError("Provide exactly one job id.")
  }
  const sessionId = `cli-job-${process.pid}-${Date.now()}`
  const mutation = { actorRole: "execution", sessionId }

  const { db, identity } = await resolveJobContext(options)
  try {
    const before = getJob(db, identity, options.jobId)
    if (!before) {
      throw new SaneWorkstreamStateError(
        `Job not found: ${options.jobId} (workstream ${identity.workstreamId}). Jobs register on planning approval or with sane job --register under existing Planning approval.`,
      )
    }
    const row: JobRow = updateJobStatus(db, identity, options.jobId, options.status, mutation)
    const changed = before.status !== row.status
    const result: SaneJobCommandResult = {
      repoRoot: identity.repoRoot,
      user: identity.user,
      workstreamId: identity.workstreamId,
      jobId: row.job_id,
      status: row.status,
      changed,
    }
    if (options.json === true) {
      write(JSON.stringify({ ...result }, null, 2))
    } else if (changed) {
      write(`Job ${result.jobId} for ${result.workstreamId}: ${before.status} -> ${result.status}`)
    } else {
      write(`Job ${result.jobId} for ${result.workstreamId}: already ${result.status}`)
    }
    return result
  } finally {
    closeDb(db)
  }
}

export async function runSaneJobRegisterCommand(
  options: Omit<SaneJobViewOptions, "jobId">,
): Promise<{ jobs: JobRow[]; warnings: string[] }> {
  const write = options.write ?? console.log
  const { db, identity, workstream } = await resolveJobContext(options)
  try {
    const requireApproval = () => {
      if (!getApproval(db, identity, "planning")) {
        throw new SaneWorkstreamStateError("Cannot register jobs without existing Planning approval. Ask the user to approve Planning first.")
      }
    }
    requireApproval()
    const row = getWorkstream(db, identity)
    if (!row || row.type !== workstream.type) {
      throw new SaneWorkstreamStateError("Missing or mismatched workstream type in SANE state; fix the workstream before registering jobs.")
    }
    const validation = await validatePhaseDocs(db, identity, workstream.path, "planning", row.type)
    if (!validation.ok) {
      throw new SaneWorkstreamStateError(`Cannot register jobs for ${identity.workstreamId}:\n${validation.problems.map((problem) => `- ${problem}`).join("\n")}`)
    }
    const jobs = db.transaction(() => {
      requireApproval()
      return registerPlannedJobs(db, identity, validation.files, {
        actorRole: "planning",
        sessionId: `cli-job-register-${process.pid}-${Date.now()}`,
      })
    }).immediate()
    const result = { jobs, warnings: validation.warnings }
    if (options.json === true) {
      write(JSON.stringify({ workstream_id: identity.workstreamId, ...result }, null, 2))
    } else {
      write(`Jobs registered for ${identity.workstreamId} (existing Planning approval retained): ${jobs.map((job) => job.job_id).join(", ")}`)
      for (const warning of validation.warnings) write(`  warning: ${warning}`)
    }
    return result
  } finally {
    closeDb(db)
  }
}

export async function runCli(args: string[]): Promise<number> {
  try {
    const parsed = parseCliArguments(args)
    const address = await resolveCommandAddress(parsed)
    if (parsed.register) {
      await runSaneJobRegisterCommand({ ...parsed, ...address })
    } else if (parsed.status === null) {
      await runSaneJobViewCommand({ ...parsed, ...address })
    } else {
      const status: string = parsed.status
      await runSaneJobCommand({ ...parsed, ...address, status })
    }
    return 0
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`)
    console.error(USAGE)
    return 1
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(Bun.argv.slice(2))
}
