/**
 * SANE `sane approve <phase>` command.
 *
 * Records user approval for one phase (`design | engineering | planning |
 * execution`) in the per-repo sqlite source of truth (`<repo>/.sane/sane.db`;
 * database wins). The workstream is auto-detected from the current
 * directory: agents never pass paths to this command.
 *
 * Approval runs validation internally (`validatePhaseDocs`) and refuses to
 * record when problems exist. On success it records the approval row
 * (validated file list + composite hash) and marks the phase `approved` in
 * `state_entries`. Approving `planning` additionally registers every
 * `execution/jobs/*.md` spec found on disk and authorizes the planned ones, so
 * job tracking needs no per-job approval. No other job transitions happen
 * here; there is no per-job approval in scope.
 *
 * Every mutation records `(actor_role, session_id, timestamp)`. Approvals
 * are user actions (`--ref` is the user's approval token).
 */
import { readdir } from "node:fs/promises"
import { join } from "node:path"

import {
  authorizeJobsViaApproval,
  createJob,
  getJob,
  getWorkstream,
  initSchema,
  openSaneDb,
  recordApproval,
  resolveSaneIdentity,
  upsertStateEntry,
  type JobRow,
  type Phase,
} from "./sane-db.ts"
import { resolveCommandAddress } from "./sane-cwd-target.ts"
import {
  resolveBootstrappedWorkstream,
  resolveSaneRepository,
} from "./sane-repository.ts"
import {
  VALIDATE_PHASES,
  validatePhaseDocs,
  type ValidatePhase,
} from "./sane-validate-command.ts"
import { SaneWorkstreamStateError } from "./sane-workstream-state.ts"

export type ApprovePhase = Phase

const APPROVE_PHASE_SET = new Set<string>(VALIDATE_PHASES)

export interface SaneApproveCommandOptions {
  implementationRepository: string
  workstreamPath: string
  phase: string
  approvalRef: string
  userOverride?: string
  json?: boolean
  write?: (line: string) => void
}

export interface SaneApproveCommandResult {
  repoRoot: string
  user: string
  workstreamId: string
  phase: ApprovePhase
  files: string[]
  saneHash: string
  approvalRef: string
  approvedAt: string
  jobs: JobRow[]
}

export const USAGE =
  "Usage: sane approve <design|engineering|planning|execution> --ref <approval_ref> [--json] (auto-detects the workstream from the current directory; runs validation first and refuses on problems)"

export interface ParsedApproveArguments {
  implementationRepository: string
  workstreamPath: string
  phase: string
  approvalRef: string
  json: boolean
}

export function parseCliArguments(args: string[]): ParsedApproveArguments {
  let json = false
  let approvalRef: string | undefined
  const positional: string[] = []
  let parseOptions = true

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (parseOptions && argument === "--") {
      parseOptions = false
    } else if (parseOptions && argument === "--json") {
      json = true
    } else if (parseOptions && (argument === "--ref" || argument === "--approval-ref")) {
      if (approvalRef !== undefined) {
        throw new SaneWorkstreamStateError("Option --ref may be provided only once.")
      }
      const value = args[index + 1]
      if (!value || value.startsWith("-")) {
        throw new SaneWorkstreamStateError(`Option ${argument} requires a value.`)
      }
      approvalRef = value
      index += 1
    } else if (parseOptions && argument.startsWith("-")) {
      throw new SaneWorkstreamStateError(`Unknown option: ${argument}`)
    } else {
      positional.push(argument)
    }
  }

  if (positional.length !== 1 || !positional[0]) {
    throw new SaneWorkstreamStateError(
      `Provide exactly one phase. Expected one of: ${VALIDATE_PHASES.join(", ")}.`,
    )
  }
  const phase = positional[0]
  if (!APPROVE_PHASE_SET.has(phase)) {
    throw new SaneWorkstreamStateError(
      `Invalid approval phase "${phase}". Expected one of: ${VALIDATE_PHASES.join(", ")}.`,
    )
  }
  if (approvalRef === undefined || approvalRef.trim() === "") {
    throw new SaneWorkstreamStateError("Option --ref is required.")
  }
  // Bare invocation: the async run path auto-detects the target from CWD.
  return { implementationRepository: "", workstreamPath: "", phase, approvalRef, json }
}

function jobIdFromSpecFile(name: string): string {
  const base = name.endsWith(".md") ? name.slice(0, -".md".length) : name
  const dash = base.indexOf("-")
  if (dash > 0) return base.slice(0, dash)
  return base
}

/**
 * Register every `execution/jobs/*.md` spec found on disk (idempotent) and
 * authorize the planned ones. Gives job tracking without per-job approval.
 */
async function authorizePlannedJobs(
  db: import("bun:sqlite").Database,
  identity: { repoRoot: string; user: string; workstreamId: string },
  workstreamDir: string,
  approval: { artifactPath: string; saneHash: string; approvalRef: string },
  mutation: { actorRole: string; sessionId: string },
): Promise<JobRow[]> {
  let names: string[] = []
  try {
    names = (await readdir(join(workstreamDir, "execution", "jobs")))
      .filter((name) => name.endsWith(".md"))
      .sort()
  } catch {
    return []
  }
  const authorized: JobRow[] = []
  const toAuthorize: string[] = []
  for (const name of names) {
    const jobId = jobIdFromSpecFile(name);
    if (!jobId) continue
    const existing = getJob(db, identity, jobId)
    if (!existing) {
      createJob(
        db,
        identity,
        { jobId, specPath: `execution/jobs/${name}` },
        mutation,
      )
      toAuthorize.push(jobId)
    } else if (existing.status === "planned") {
      toAuthorize.push(jobId)
    }
  }
  if (toAuthorize.length === 0) return authorized
  return authorizeJobsViaApproval(db, identity, toAuthorize, approval, mutation)
}

export async function runSaneApproveCommand(
  options: SaneApproveCommandOptions,
): Promise<SaneApproveCommandResult> {
  const write = options.write ?? console.log
  if (!APPROVE_PHASE_SET.has(options.phase)) {
    throw new SaneWorkstreamStateError(
      `Invalid approval phase "${options.phase}". Expected one of: ${VALIDATE_PHASES.join(", ")}.`,
    )
  }
  if (!options.approvalRef || options.approvalRef.trim() === "") {
    throw new SaneWorkstreamStateError("Option --ref is required.")
  }
  const phase = options.phase as ValidatePhase
  const sessionId = `cli-approve-${process.pid}-${Date.now()}`
  const mutation = { actorRole: "user", sessionId }

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
  try {
    initSchema(db)
    const dbRow = getWorkstream(db, identity)
    if (!dbRow) {
      throw new SaneWorkstreamStateError(
        `No workstream row for ${identity.workstreamId} (repo ${identity.repoRoot} user ${identity.user}). Re-create the workstream so its type is recorded in sqlite.`,
      )
    }
    if (dbRow.type !== workstream.type) {
      throw new SaneWorkstreamStateError(
        `Workstream type mismatch: sqlite has type "${dbRow.type}" but the filesystem root doc implies "${workstream.type}". Re-create the workstream or fix the root doc.`,
      )
    }
    const validation = await validatePhaseDocs(db, identity, workstream.path, phase, dbRow.type)
    if (!validation.ok) {
      throw new SaneWorkstreamStateError(
        `Cannot approve ${phase} for ${validation.workstreamId}:\n${validation.problems.map((problem) => `- ${problem}`).join("\n")}`,
      )
    }
    const approvalInput = {
      artifactPath: validation.files.join(", "),
      saneHash: validation.hash,
      approvalRef: options.approvalRef,
    }
    const approvalRow = recordApproval(db, identity, { phase, ...approvalInput }, mutation)
    upsertStateEntry(
      db,
      identity,
      { phase, status: "approved", ownerRole: phase, approvalRef: options.approvalRef },
      mutation,
    )
    const jobs =
      phase === "planning"
        ? await authorizePlannedJobs(db, identity, workstream.path, approvalInput, mutation)
        : []

    const result: SaneApproveCommandResult = {
      repoRoot: identity.repoRoot,
      user: identity.user,
      workstreamId: identity.workstreamId,
      phase: phase as ApprovePhase,
      files: validation.files,
      saneHash: approvalRow.sane_hash,
      approvalRef: approvalRow.approval_ref,
      approvedAt: approvalRow.approved_at,
      jobs,
    }

    if (options.json === true) {
      write(
        JSON.stringify(
          {
            repo_root: result.repoRoot,
            user: result.user,
            workstream_id: result.workstreamId,
            phase: result.phase,
            files: result.files,
            sane_hash: result.saneHash,
            approval_ref: result.approvalRef,
            approved_at: result.approvedAt,
            jobs: result.jobs.map((job) => ({
              job_id: job.job_id,
              status: job.status,
              spec_path: job.spec_path,
            })),
            warnings: validation.warnings,
          },
          null,
          2,
        ),
      )
    } else {
      write(`Approved ${result.phase} for ${result.workstreamId}: ${result.approvalRef}`)
      for (const file of result.files) write(`  validated: ${file}`)
      write(`  sane_hash: ${result.saneHash}`)
      if (result.jobs.length > 0) {
        write(`  jobs authorized: ${result.jobs.map((job) => job.job_id).join(", ")}`)
      }
      for (const warning of validation.warnings) write(`  warning: ${warning}`)
    }
    return result
  } finally {
    try {
      db.close()
    } catch {
      // Best effort.
    }
  }
}

export async function runCli(args: string[]): Promise<number> {
  try {
    const parsed = parseCliArguments(args)
    const address = await resolveCommandAddress(parsed)
    await runSaneApproveCommand({ ...parsed, ...address })
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
