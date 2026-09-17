/**
 * SANE 0.2.0 M2 P0: `sane-alpha state` command.
 *
 * Renders `SANE_STATE.md` from the per-repo sqlite source of truth
 * (`<repo>/.sane/sane.db`; database wins) via `writeSaneState` (atomic
 * temp-file + rename). Supports `--json` and `--repo-root` detection idioms
 * matching existing CLIs.
 *
 * New file only (M2 wiring P0).
 */
import { join } from "node:path"

import { initSchema, openSaneDb, resolveSaneIdentity } from "./sane-db.ts"
import { writeSaneState } from "./sane-state.ts"
import {
  resolveBootstrappedWorkstream,
  resolveSaneRepository,
} from "./sane-repository.ts"
import { SaneWorkstreamStateError } from "./sane-workstream-state.ts"

export interface SaneStateCommandOptions {
  implementationRepository: string
  workstreamPath: string
  json?: boolean
  userOverride?: string
  write?: (line: string) => void
}

export interface SaneStateCommandResult {
  repoRoot: string
  user: string
  workstreamId: string
  filePath: string
  rendered: string
  json: boolean
}

export const USAGE =
  "Usage: sane-alpha state <implementation-repository> <workstream-relative-path> [--json] [--repo-root <path>]"

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
    // Repo-root detection: default to the current working directory's git root.
    return { implementationRepository: process.cwd(), workstreamPath: positional[0], json }
  }
  throw new SaneWorkstreamStateError(
    "Provide an implementation repository and workstream relative path.",
  )
}

/**
 * Render the workstream's `SANE_STATE.md` from the DB (database wins) with an
 * atomic write. Resolves the repo root via the existing git-root detection
 * and validates the bootstrapped workstream before writing.
 */
export async function runSaneStateCommand(
  options: SaneStateCommandOptions,
): Promise<SaneStateCommandResult> {
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
    const filePath = join(workstream.path, "SANE_STATE.md")
    const rendered = await writeSaneState(db, identity, filePath)
    const result: SaneStateCommandResult = {
      repoRoot: identity.repoRoot,
      user: identity.user,
      workstreamId: identity.workstreamId,
      filePath,
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
            file: result.filePath,
            bytes: result.rendered.length,
          },
          null,
          2,
        ),
      )
    } else {
      write(`Wrote: ${filePath}`)
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
    await runSaneStateCommand(parsed)
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
