/**
 * SANE `sane job <job-id> <running|completed>` command.
 *
 * Progress tracking for the Execution Assistant, ungated: mark one job
 * `running` (in progress) or `completed` (report written) as work proceeds.
 * The workstream is auto-detected from the current directory: agents never
 * pass paths to this command.
 *
 * Moves must go forward (`planned -> running -> completed`; same status is
 * a no-op). `planned` comes only from planning-approval registration and is
 * not an accepted target. This command is not approval: the user gate stays
 * `sane approve execution`, which validates the final report plus job
 * reports and batch-completes stragglers.
 */
import {
  getJob,
  initSchema,
  openSaneDb,
  resolveSaneIdentity,
  updateJobStatus,
  type JobRow,
} from "./sane-db.ts"
import { resolveCommandAddress } from "./sane-cwd-target.ts"
import {
  resolveBootstrappedWorkstream,
  resolveSaneRepository,
} from "./sane-repository.ts"
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

export interface SaneJobCommandResult {
  repoRoot: string
  user: string
  workstreamId: string
  jobId: string
  status: string
  changed: boolean
}

export const USAGE =
  "Usage: sane job <job-id> <running|completed> [--json] (auto-detects the workstream from the current directory; progress only, not approval)"

export function parseCliArguments(args: string[]): {
  implementationRepository: string
  workstreamPath: string
  jobId: string
  status: string
  json: boolean
} {
  let json = false
  const positional: string[] = []
  let parseOptions = true

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (parseOptions && argument === "--") {
      parseOptions = false
    } else if (parseOptions && argument === "--json") {
      json = true
    } else if (parseOptions && argument.startsWith("-")) {
      throw new SaneWorkstreamStateError(`Unknown option: ${argument}`)
    } else {
      positional.push(argument)
    }
  }

  if (positional.length !== 2 || !positional[0] || !positional[1]) {
    throw new SaneWorkstreamStateError(
      "Provide exactly one job id and one status (running|completed).",
    )
  }
  const status = positional[1]
  if (!JOB_TARGET_SET.has(status)) {
    throw new SaneWorkstreamStateError(
      `Invalid job status "${status}". Expected one of: ${JOB_TARGETS.join(", ")}.`,
    )
  }
  // Bare invocation: the async run path auto-detects the target from CWD.
  return { implementationRepository: "", workstreamPath: "", jobId: positional[0], status, json }
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
    const before = getJob(db, identity, options.jobId)
    if (!before) {
      throw new SaneWorkstreamStateError(
        `Job not found: ${options.jobId} (workstream ${identity.workstreamId}). Jobs register on planning approval.`,
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
    await runSaneJobCommand({ ...parsed, ...address })
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
