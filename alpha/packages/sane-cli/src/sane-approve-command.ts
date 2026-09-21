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
 * `execution/jobs/*.md` spec found on disk as `planned` (`planned` means
 * authorized), so job tracking needs no per-job approval. Approving
 * `execution` batch-accepts every outstanding job. Job statuses are progress
 * tracking, not per-job gates; there is no per-job approval in scope.
 *
 * Every mutation records `(actor_role, session_id, timestamp)`. Approvals
 * are user actions (`--ref` is the user's approval token).
 */
import {
  completeAllJobs,
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
import { registerPlannedJobs } from "./sane-job-registration.ts"
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
        `No workstream row for ${identity.workstreamId} (repo ${identity.repoRoot} user ${identity.user}). Re-create the workstream so its type is recorded in SANE state.`,
      )
    }
    if (dbRow.type !== workstream.type) {
      throw new SaneWorkstreamStateError(
        `Workstream type mismatch: SANE state has type "${dbRow.type}" but the filesystem root doc implies "${workstream.type}". Re-create the workstream or fix the root doc.`,
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
    const { approvalRow, jobs } = db.transaction(() => {
      const jobs = phase === "planning"
        ? registerPlannedJobs(db, identity, validation.files, mutation)
        : phase === "execution"
          ? completeAllJobs(db, identity, mutation)
          : []
      const approvalRow = recordApproval(db, identity, { phase, ...approvalInput }, mutation)
      upsertStateEntry(
        db,
        identity,
        { phase, status: "approved", ownerRole: phase, approvalRef: options.approvalRef },
        mutation,
      )
      return { approvalRow, jobs }
    }).immediate()

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
        const verb = result.phase === "execution" ? "completed" : "registered"
        write(`  jobs ${verb}: ${result.jobs.map((job) => job.job_id).join(", ")}`)
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
