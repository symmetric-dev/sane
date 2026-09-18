/**
 * SANE 0.2.0 M2 P0: `sane status` command.
 *
 * Reports DB status for one workstream via `getWorkstreamStatus`.
 * Supports `--json` and `--repo-root` detection idioms matching existing CLIs.
 * Read-only; full state is viewed via `sane view`, never written to disk.
 *
 * New file only (M2 wiring P0).
 */
import { initSchema, openSaneDb, resolveSaneIdentity } from "./sane-db.ts"
import { resolveCommandAddress } from "./sane-cwd-target.ts"
import {
  resolveBootstrappedWorkstream,
  resolveSaneRepository,
} from "./sane-repository.ts"
import {
  SaneWorkstreamStateError,
  getWorkstreamStatus,
} from "./sane-workstream-state.ts"

export interface SaneStatusCommandOptions {
  implementationRepository: string
  workstreamPath: string
  json?: boolean
  userOverride?: string
  write?: (line: string) => void
}

export const USAGE =
  "Usage: sane status [<implementation-repository> <workstream-relative-path>] [--json] [--repo-root <path>] (no positionals: auto-detect the target from the current directory)"

export function parseCliArguments(args: string[]): {
  implementationRepository: string
  workstreamPath: string
  json: boolean
} {
  let json = false
  let repoRootOpt: string | undefined
  const positional: string[] = []
  let parseOptions = true

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (parseOptions && argument === "--") {
      parseOptions = false
    } else if (parseOptions && argument === "--json") {
      json = true
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

  if (repoRootOpt !== undefined) {
    if (positional.length !== 1 || !positional[0]) {
      throw new SaneWorkstreamStateError(
        "Provide exactly one workstream relative path when --repo-root is used.",
      )
    }
    return {
      implementationRepository: repoRootOpt,
      workstreamPath: positional[0],
      json,
    }
  }

  if (positional.length === 2 && positional[0] && positional[1]) {
    return {
      implementationRepository: positional[0],
      workstreamPath: positional[1],
      json,
    }
  }
  if (positional.length === 1 && positional[0]) {
    return { implementationRepository: process.cwd(), workstreamPath: positional[0], json }
  }
  if (positional.length === 0) {
    // Bare invocation: the async run path auto-detects the target from CWD.
    return { implementationRepository: "", workstreamPath: "", json }
  }
  throw new SaneWorkstreamStateError(
    "Provide an implementation repository and workstream relative path.",
  )
}

const PHASE_ORDER = ["design", "engineering", "planning", "execution"]

function phaseGlyph(state: string): string {
  switch (state) {
    case "approved":
      return "✓"
    case "delivered":
      return "●"
    case "in_progress":
      return "◐"
    case "blocked":
      return "!"
    default:
      return "○"
  }
}
/** Report DB status for one workstream (human lines or `--json`). */
export async function runSaneStatusCommand(options: SaneStatusCommandOptions): Promise<void> {
  const write = options.write ?? console.log
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
    const status = getWorkstreamStatus(db, identity)
    if (options.json === true) {
      write(
        JSON.stringify(
          {
            repo_root: status.repoRoot,
            user: status.user,
            workstream_id: status.workstreamId,
            phases: status.phases.map((entry) => ({
              phase: entry.phase,
              status: entry.status,
              approval_ref: entry.approval_ref,
            })),
            approvals: status.approvals.map((approval) => ({
              phase: approval.phase,
              artifact_path: approval.artifact_path,
              sane_hash: approval.sane_hash,
              approval_ref: approval.approval_ref,
            })),
            jobs: status.jobs.map((job) => ({
              job_id: job.job_id,
              status: job.status,
              spec_path: job.spec_path,
              report_path: job.report_path,
            })),
            research_reports: status.researchReports.map((report) => ({
              topic: report.topic,
              path: report.path,
              created_at: report.created_at,
              sane_hash: report.sane_hash,
              git_commit: report.git_commit,
            })),
            merge: status.merge,
          },
          null,
          2,
        ),
      )
      return
    }
    write(`${status.workstreamId} (${status.workstream.type})`)
    const byPhase = new Map(status.phases.map((entry) => [entry.phase, entry]))
    const renderPhase = (phase: string, entry: { status: string; approval_ref: string | null } | undefined): void => {
      const state = entry?.status ?? "pending"
      const ref = entry?.approval_ref ? ` (${entry.approval_ref})` : ""
      write(`  ${phaseGlyph(state)} ${phase.padEnd(11)} ${state}${ref}`)
    }
    for (const phase of PHASE_ORDER) renderPhase(phase, byPhase.get(phase))
    for (const entry of status.phases) {
      if (!PHASE_ORDER.includes(entry.phase)) renderPhase(entry.phase, entry)
    }
    if (status.researchReports.length === 0) {
      write(`  ○ research    (none registered)`)
    } else {
      write(
        `  ● research    ${status.researchReports.map((report) => report.topic).join(", ")}`,
      )
    }
    if (status.jobs.length === 0) {
      write(`  ○ jobs        (none recorded)`)
    } else {
      write(
        `  ◐ jobs        ${status.jobs.map((job) => `${job.job_id} ${job.status}`).join(" · ")}`,
      )
    }
    if (!status.merge) {
      write(`  ○ merge       (none recorded)`)
    } else {
      const merged = status.merge.merge_commit ? `merged ${status.merge.merge_commit.slice(0, 12)}` : "open"
      write(`  ◐ merge       ${status.merge.branch} @ ${status.merge.base_rev.slice(0, 12)} (${merged})`)
    }
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
    await runSaneStatusCommand({ ...parsed, ...address })
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
