/**
 * SANE 0.2.0 M2 P0: `sane view` command.
 *
 * Renders workstream state from the per-repo sqlite source of truth
 * (`<repo>/.sane/sane.db`; database wins) via `renderSaneView` and prints
 * it to stdout. Writes no file: state is viewed by running this command,
 * never by reading a file. Supports `--json` and `--repo-root` detection
 * idioms matching existing CLIs.
 */
import { initSchema, openSaneDb, resolveSaneIdentity } from "./sane-db.ts"
import { resolveCommandAddress } from "./sane-cwd-target.ts"
import { renderSaneView, renderCompactSaneView } from "./sane-view.ts"
import {
  resolveBootstrappedWorkstream,
  resolveSaneRepository,
} from "./sane-repository.ts"
import { getWorkstreamStatus, SaneWorkstreamStateError } from "./sane-workstream-state.ts"

export interface SaneViewCommandOptions {
  implementationRepository: string
  workstreamPath: string
  json?: boolean
  verbose?: boolean
  userOverride?: string
  write?: (line: string) => void
}

export interface SaneViewCommandResult {
  repoRoot: string
  user: string
  workstreamId: string
  rendered: string
  json: boolean
}

export const USAGE =
  "Usage: sane view [<implementation-repository> <workstream-relative-path>] [--json] [--verbose] [--repo-root <path>] (default: compact state; --verbose: full detail; --json: structured state; no positionals: auto-detect target)"

export function parseCliArguments(args: string[]): {
  implementationRepository: string
  workstreamPath: string
  json: boolean
  verbose?: boolean
} {
  let json = false
  let verbose = false
  let repoRootOpt: string | undefined
  const positional: string[] = []
  let parseOptions = true

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (parseOptions && argument === "--") {
      parseOptions = false
    } else if (parseOptions && argument === "--json") {
      json = true
    } else if (parseOptions && argument === "--verbose") {
      verbose = true
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
      ...(verbose ? { verbose } : {}),
    }
  }

  if (positional.length === 2 && positional[0] && positional[1]) {
    return {
      implementationRepository: positional[0],
      workstreamPath: positional[1],
      json,
      ...(verbose ? { verbose } : {}),
    }
  }
  if (positional.length === 1 && positional[0]) {
    // Repo-root detection: default to the current working directory's git root.
    return { implementationRepository: process.cwd(), workstreamPath: positional[0], json, ...(verbose ? { verbose } : {}) }
  }
  if (positional.length === 0) {
    // Bare invocation: the async run path auto-detects the target from CWD.
    return { implementationRepository: "", workstreamPath: "", json, ...(verbose ? { verbose } : {}) }
  }
  throw new SaneWorkstreamStateError(
    "Provide an implementation repository and workstream relative path.",
  )
}

/**
 * Render the workstream's state from the DB (database wins) and print it to
 * stdout. Writes no file. Resolves the repo root via the existing git-root
 * detection and validates the bootstrapped workstream before rendering.
 */
export async function runSaneViewCommand(
  options: SaneViewCommandOptions,
): Promise<SaneViewCommandResult> {
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
    const state = getWorkstreamStatus(db, identity)
    const rendered = options.verbose ? renderSaneView(db, identity) : renderCompactSaneView(state)
    const result: SaneViewCommandResult = {
      repoRoot: identity.repoRoot,
      user: identity.user,
      workstreamId: identity.workstreamId,
      rendered,
      json: options.json === true,
    }
    if (result.json) {
      write(
        JSON.stringify(
          {
            repo_root: result.repoRoot,
            user: result.user,
            workstream_id: result.workstreamId,
            workstream: state.workstream,
            phases: state.phases,
            approvals: state.approvals,
            jobs: state.jobs,
            research_reports: state.researchReports,
            sessions: state.selections,
            merge: state.merge,
          },
          null,
          2,
        ),
      )
    } else {
      write(rendered)
    }
    return result
  } finally {
    try {
      db.close()
    } catch {
      // Best effort; close is idempotent for state flows.
    }
  }
}

export async function runCli(args: string[]): Promise<number> {
  try {
    const parsed = parseCliArguments(args)
    const address = await resolveCommandAddress(parsed)
    await runSaneViewCommand({ ...parsed, ...address })
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
