/**
 * SANE 0.2.0 M2 P0: `sane-alpha pickup` command.
 *
 * Runs pickup precondition checks via `runPickupChecks`:
 * - `foundation_rev` missing/superseded -> throw (non-zero exit).
 * - Research index + SDD/solutions `sane_hash` -> warnings
 *   (exit 0, human lines or `--json`).
 *
 * Supports `--json` and `--repo-root` detection idioms matching existing CLIs.
 * Read-only; state is viewed via `sane-alpha state`, never written to disk.
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
  runPickupChecks,
} from "./sane-workstream-state.ts"

export interface SanePickupCommandOptions {
  implementationRepository: string
  workstreamPath: string
  json?: boolean
  userOverride?: string
  write?: (line: string) => void
}

export const USAGE =
  "Usage: sane-alpha pickup [<implementation-repository> <workstream-relative-path>] [--json] [--repo-root <path>] (no positionals: auto-detect the target from the current directory)"

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

/**
 * Run pickup checks. Foundation missing/superseded throws (caller maps to
 * exit 1); research/SDD/solutions divergences are returned as warnings.
 */
export async function runSanePickupCommand(options: SanePickupCommandOptions): Promise<void> {
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
    const result = await runPickupChecks(db, identity, workstream.path)
    if (options.json === true) {
      write(
        JSON.stringify(
          {
            repo_root: result.repoRoot,
            user: result.user,
            workstream_id: result.workstreamId,
            foundation: result.foundation,
            research: {
              reports: result.research.reports.map((report) => ({
                topic: report.topic,
                path: report.path,
                registered_hash: report.registeredHash,
                current_hash: report.currentHash,
                file_exists: report.fileExists,
              })),
              unregistered_files: result.research.unregisteredFiles,
            },
            sdd: {
              path: result.sdd.relativePath,
              file_exists: result.sdd.fileExists,
              current_hash: result.sdd.currentHash,
              approved_hash: result.sdd.approvedHash,
              match: result.sdd.match,
            },
            solutions: result.solutions.map((entry) => ({
              path: entry.relativePath,
              current_hash: entry.currentHash,
              approved_hash: entry.approvedHash,
              match: entry.match,
            })),
            warnings: result.warnings,
            ok: result.ok,
          },
          null,
          2,
        ),
      )
      return
    }
    if (result.foundation.status === "none") {
      write(`foundation: (none)`)
    } else {
      write(`foundation: ${result.foundation.rev} ok`)
    }
    write(
      result.research.reports.length === 0 && result.research.unregisteredFiles.length === 0
        ? `research: (no research registered)`
        : `research: ${result.research.reports.length} report(s)${result.research.unregisteredFiles.length === 0 ? "" : `, ${result.research.unregisteredFiles.length} unregistered file(s)`}`,
    )
    write(
      result.sdd.currentHash
        ? `sdd: ${result.sdd.relativePath} hash ${result.sdd.currentHash.slice(0, 12)}… match ${result.sdd.match === null ? "(no approval)" : String(result.sdd.match)}`
        : `sdd: ${result.sdd.relativePath} missing`,
    )
    write(`solutions: ${result.solutions.length} file(s)`)
    if (result.warnings.length === 0) {
      write(`Pickup ok: ${result.workstreamId}`)
    } else {
      for (const warning of result.warnings) {
        write(`Warning: ${warning}`)
      }
      write(`Pickup warnings: ${result.warnings.length} for ${result.workstreamId}`)
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
    await runSanePickupCommand({ ...parsed, ...address })
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
