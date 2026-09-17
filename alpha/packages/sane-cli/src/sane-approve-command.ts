/**
 * SANE 0.2.0 M3-A: `sane-alpha approve` command.
 *
 * Records user approval for one of the five gates
 * (`root-plus-sdd | solutions | plan | jobs-batch | merge`) in the per-repo
 * sqlite source of truth (`<repo>/.sane/sane.db`; database wins). Computes
 * `sane_hash` via `hashFile` (content hash of the approved artifact) plus a
 * nullable `git_commit` (NULL when not git-backed). No hash enforcement yet;
 * values are recorded only (Explicit Non-Goals).
 *
 * Gate side effects (docs/SANE_0_2_0.md Section 2):
 * - `plan` with `--job` entries authorizes Jobs `planned -> authorized` via
 *   `authorizeJobsViaApproval` (does not start execution). Without `--job`
 *   it records the approval row only.
 * - `jobs-batch` with `--job` entries accepts results via
 *   `acceptJobsViaApproval`, or authorizes retry/fix via `--retry` (records
 *   the approval row then moves each job back to `authorized` for retry).
 *   Without `--job` it records the approval row only.
 * - All other gates record the approval row only.
 *
 * Every mutation records `(actor_role, session_id, timestamp)`. Approvals are
 * user actions (`--actor-role` defaults to `user`); no role self-approves is
 * enforced by audit (actor_role is recorded in `sane_mutations`), not by
 * blocking non-user roles here.
 *
 * New file only (M3-A); read-only use of `sane-db.ts` helpers (no schema
 * refactor). Does not touch `sane-workstream-state.ts`
 * `templates/`, or agents/skills.
 */
import { lstat } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"

import {
  acceptJobsViaApproval,
  APPROVAL_GATES,
  authorizeJobsViaApproval,
  getApproval,
  initSchema,
  openSaneDb,
  recordApproval,
  resolveSaneIdentity,
  updateJobStatus,
  type ApprovalGate,
  type JobRow,
} from "./sane-db.ts"
import { hashFile, normalizeGitCommit } from "./sane-hash.ts"
import { resolveCommandAddress } from "./sane-cwd-target.ts"
import {
  resolveBootstrappedWorkstream,
  resolveSaneRepository,
} from "./sane-repository.ts"
import { SaneWorkstreamStateError } from "./sane-workstream-state.ts"

export type ApproveGate = ApprovalGate

const APPROVAL_GATE_LIST = [...APPROVAL_GATES] as const
const APPROVAL_GATE_SET = new Set<string>(APPROVAL_GATE_LIST)

export interface SaneApproveCommandOptions {
  implementationRepository: string
  workstreamPath: string
  gate: string
  artifact: string
  approvalRef: string
  gitCommit?: string | null
  jobIds?: string[]
  retry?: boolean
  actorRole?: string
  sessionId?: string
  userOverride?: string
  json?: boolean
  write?: (line: string) => void
}

export interface SaneApproveCommandResult {
  repoRoot: string
  user: string
  workstreamId: string
  gate: ApproveGate
  artifactPath: string
  saneHash: string
  gitCommit: string | null
  approvalRef: string
  approvedAt: string
  jobs: JobRow[]
  retried: boolean
}

export const USAGE =
  "Usage: sane-alpha approve [<implementation-repository> <workstream-relative-path>] --gate <root-plus-sdd|solutions|plan|jobs-batch|merge> --artifact <path> --ref <approval_ref> [--git-commit <sha>] [--job <job-id>]... [--retry] [--actor-role <role>] [--session-id <id>] [--json] [--repo-root <path>] (no positionals: auto-detect the target from the current directory)"

export interface ParsedApproveArguments {
  implementationRepository: string
  workstreamPath: string
  gate: string
  artifact: string
  approvalRef: string
  gitCommit: string | null
  jobIds: string[]
  retry: boolean
  actorRole: string
  sessionId: string | undefined
  json: boolean
}

function requireOptionValue(
  args: string[],
  index: number,
  option: string,
): string {
  const value = args[index + 1]
  if (!value || value.startsWith("-")) {
    throw new SaneWorkstreamStateError(`Option ${option} requires a value.`)
  }
  return value
}

function assertSingleUse(
  seen: string | undefined,
  option: string,
): void {
  if (seen !== undefined) {
    throw new SaneWorkstreamStateError(`Option ${option} may be provided only once.`)
  }
}

export function parseCliArguments(args: string[]): ParsedApproveArguments {
  let json = false
  let retry = false
  let repoRootOpt: string | undefined
  let gate: string | undefined
  let artifact: string | undefined
  let approvalRef: string | undefined
  let gitCommit: string | null | undefined
  let actorRole: string | undefined
  let sessionId: string | undefined
  const jobIds: string[] = []
  const positional: string[] = []
  let parseOptions = true

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (parseOptions && argument === "--") {
      parseOptions = false
    } else if (parseOptions && argument === "--json") {
      json = true
    } else if (parseOptions && argument === "--retry") {
      retry = true
    } else if (parseOptions && argument === "--gate") {
      assertSingleUse(gate, "--gate")
      gate = requireOptionValue(args, index, "--gate")
      index += 1
    } else if (parseOptions && argument === "--artifact") {
      assertSingleUse(artifact, "--artifact")
      artifact = requireOptionValue(args, index, "--artifact")
      index += 1
    } else if (parseOptions && (argument === "--ref" || argument === "--approval-ref")) {
      assertSingleUse(approvalRef, "--ref")
      approvalRef = requireOptionValue(args, index, argument)
      index += 1
    } else if (parseOptions && argument === "--git-commit") {
      assertSingleUse(gitCommit ?? undefined, "--git-commit")
      gitCommit = requireOptionValue(args, index, "--git-commit")
      index += 1
    } else if (parseOptions && argument === "--job") {
      const value = requireOptionValue(args, index, "--job")
      if (value.trim() === "") {
        throw new SaneWorkstreamStateError("Option --job requires a non-empty value.")
      }
      jobIds.push(value)
      index += 1
    } else if (parseOptions && argument === "--actor-role") {
      assertSingleUse(actorRole, "--actor-role")
      actorRole = requireOptionValue(args, index, "--actor-role")
      index += 1
    } else if (parseOptions && argument === "--session-id") {
      assertSingleUse(sessionId, "--session-id")
      sessionId = requireOptionValue(args, index, "--session-id")
      index += 1
    } else if (parseOptions && argument === "--repo-root") {
      const value = args[index + 1]
      if (!value || value.startsWith("-")) {
        throw new SaneWorkstreamStateError("Option --repo-root requires a value.")
      }
      if (repoRootOpt !== undefined) {
        throw new SaneWorkstreamStateError("Option --repo-root may be provided only once.")
      }
      repoRootOpt = value
      index += 1
    } else if (parseOptions && argument.startsWith("-")) {
      throw new SaneWorkstreamStateError(`Unknown option: ${argument}`)
    } else {
      positional.push(argument)
    }
  }

  let implementationRepository: string
  let workstreamPath: string
  if (repoRootOpt !== undefined) {
    if (positional.length !== 1 || !positional[0]) {
      throw new SaneWorkstreamStateError(
        "Provide exactly one workstream relative path when --repo-root is used.",
      )
    }
    implementationRepository = repoRootOpt
    workstreamPath = positional[0]
  } else if (positional.length === 2 && positional[0] && positional[1]) {
    implementationRepository = positional[0]
    workstreamPath = positional[1]
  } else if (positional.length === 1 && positional[0]) {
    implementationRepository = process.cwd()
    workstreamPath = positional[0]
  } else if (positional.length === 0) {
    // Bare invocation: the async run path auto-detects the target from CWD.
    implementationRepository = ""
    workstreamPath = ""
  } else {
    throw new SaneWorkstreamStateError(
      "Provide an implementation repository and workstream relative path.",
    )
  }

  if (gate === undefined) {
    throw new SaneWorkstreamStateError("Option --gate is required.")
  }
  if (!APPROVAL_GATE_SET.has(gate)) {
    throw new SaneWorkstreamStateError(
      `Invalid approval gate "${gate}". Expected one of: ${APPROVAL_GATE_LIST.join(", ")}.`,
    )
  }
  if (artifact === undefined || artifact.trim() === "") {
    throw new SaneWorkstreamStateError("Option --artifact is required.")
  }
  if (approvalRef === undefined || approvalRef.trim() === "") {
    throw new SaneWorkstreamStateError("Option --ref is required.")
  }
  if (retry && gate !== "jobs-batch") {
    throw new SaneWorkstreamStateError("Option --retry applies only to gate jobs-batch.")
  }

  return {
    implementationRepository,
    workstreamPath,
    gate,
    artifact,
    approvalRef,
    gitCommit: gitCommit ?? null,
    jobIds,
    retry,
    actorRole: actorRole ?? "user",
    sessionId,
    json,
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * Resolve the artifact file to hash. Absolute paths are used directly;
 * relative paths prefer the workstream directory (where SDD/solutions/plan
 * artifacts live) and fall back to cwd-relative resolution.
 */
async function resolveArtifactFile(workstreamDir: string, artifact: string): Promise<string> {
  if (isAbsolute(artifact)) return artifact
  const inside = join(workstreamDir, artifact)
  if (await fileExists(inside)) return inside
  const cwdRelative = resolve(artifact)
  if (await fileExists(cwdRelative)) return cwdRelative
  // Default to the workstream-relative path so the missing-file error names
  // the expected location.
  return inside
}

/**
 * Record a gate approval (hash-on-approve). Plan with jobs authorizes them;
 * jobs-batch with jobs accepts (or authorizes retry with `--retry`).
 */
export async function runSaneApproveCommand(
  options: SaneApproveCommandOptions,
): Promise<SaneApproveCommandResult> {
  const write = options.write ?? console.log
  if (!options.gate || !APPROVAL_GATE_SET.has(options.gate)) {
    throw new SaneWorkstreamStateError(
      `Invalid approval gate "${options.gate}". Expected one of: ${APPROVAL_GATE_LIST.join(", ")}.`,
    )
  }
  if (!options.artifact || options.artifact.trim() === "") {
    throw new SaneWorkstreamStateError("Option --artifact is required.")
  }
  if (!options.approvalRef || options.approvalRef.trim() === "") {
    throw new SaneWorkstreamStateError("Option --ref is required.")
  }
  if (options.retry && options.gate !== "jobs-batch") {
    throw new SaneWorkstreamStateError("Option --retry applies only to gate jobs-batch.")
  }
  const actorRole = options.actorRole ?? "user"
  if (!actorRole || actorRole.trim() === "") {
    throw new SaneWorkstreamStateError("Actor role must be non-empty.")
  }
  const sessionId = options.sessionId ?? `cli-approve-${process.pid}-${Date.now()}`
  if (!sessionId || sessionId.trim() === "") {
    throw new SaneWorkstreamStateError("Session id must be non-empty.")
  }
  const jobIds = options.jobIds ?? []

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
    const artifactFile = await resolveArtifactFile(workstream.path, options.artifact)
    let saneHash: string
    try {
      saneHash = await hashFile(artifactFile)
    } catch (error) {
      throw new SaneWorkstreamStateError(
        `Artifact file not found or unreadable: ${artifactFile} (${(error as Error).message})`,
      )
    }
    const gitCommit = normalizeGitCommit(options.gitCommit ?? null)
    const mutation = { actorRole, sessionId }
    const approvalInput = {
      artifactPath: options.artifact,
      saneHash,
      gitCommit,
      approvalRef: options.approvalRef,
    }

    let jobs: JobRow[] = []
    let retried = false
    if (options.gate === "plan" && jobIds.length > 0) {
      jobs = authorizeJobsViaApproval(db, identity, jobIds, approvalInput, mutation)
    } else if (options.gate === "jobs-batch" && jobIds.length > 0) {
      if (options.retry === true) {
        recordApproval(
          db,
          identity,
          { gate: "jobs-batch", ...approvalInput },
          mutation,
        )
        for (const jobId of jobIds) {
          jobs.push(updateJobStatus(db, identity, jobId, "authorized", mutation))
        }
        retried = true
      } else {
        jobs = acceptJobsViaApproval(db, identity, jobIds, approvalInput, mutation)
      }
    } else {
      recordApproval(db, identity, { gate: options.gate, ...approvalInput }, mutation)
    }

    const approvalRow = getApproval(db, identity, options.gate)
    if (!approvalRow) {
      throw new SaneWorkstreamStateError(`Failed to read back approval for gate "${options.gate}".`)
    }

    const result: SaneApproveCommandResult = {
      repoRoot: identity.repoRoot,
      user: identity.user,
      workstreamId: identity.workstreamId,
      gate: options.gate as ApproveGate,
      artifactPath: approvalRow.artifact_path,
      saneHash: approvalRow.sane_hash,
      gitCommit: approvalRow.git_commit,
      approvalRef: approvalRow.approval_ref,
      approvedAt: approvalRow.approved_at,
      jobs,
      retried,
    }

    if (options.json === true) {
      write(
        JSON.stringify(
          {
            repo_root: result.repoRoot,
            user: result.user,
            workstream_id: result.workstreamId,
            gate: result.gate,
            artifact_path: result.artifactPath,
            sane_hash: result.saneHash,
            git_commit: result.gitCommit,
            approval_ref: result.approvalRef,
            approved_at: result.approvedAt,
            retried: result.retried,
            jobs: result.jobs.map((job) => ({
              job_id: job.job_id,
              status: job.status,
              spec_path: job.spec_path,
              report_path: job.report_path,
            })),
          },
          null,
          2,
        ),
      )
    } else {
      write(`Approved ${result.gate} for ${result.workstreamId}: ${result.approvalRef}`)
      write(`  artifact: ${result.artifactPath}`)
      write(`  sane_hash: ${result.saneHash}`)
      write(`  git_commit: ${result.gitCommit ?? "(none)"}`)
      if (result.jobs.length > 0) {
        const verb =
          result.gate === "plan" ? "authorized" : retried ? "retry authorized" : "accepted"
        write(
          `  jobs ${verb}: ${result.jobs.map((job) => `${job.job_id}=${job.status}`).join(", ")}`,
        )
      }
    }
    return result
  } finally {
    try {
      db.close()
    } catch {
      // Best effort; close is idempotent for approve flows.
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
