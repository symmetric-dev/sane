/**
 * SANE `sane link`: link an OpenCode session to a workstream phase slot
 * (self-registration at session Pickup).
 *
 * Pure DB write (no server calls). One row per (slot, session_id) via
 * `linkSelection`; 1:1 slots (`design | planning | execution`) reject a
 * second distinct session without `--force`, while 1:many slots
 * (`engineering | research | research:*`) always append. Exact (slot, session)
 * duplicates always throw via `linkSelection`.
 *
 * New file only. Read-only use of `sane-db.ts` selections CRUD; does not
 * touch handoff behavior, skills, docs, or the `sessions` list command.
 */

import type { Database } from "bun:sqlite"

import {
  assertSelectionSlot,
  deleteSelection,
  initSchema,
  linkSelection,
  listSelectionsBySlot,
  openSaneDb,
  resolveSaneIdentity,
  type SaneIdentity,
  type SelectionRow,
} from "./sane-db.ts"
import {
  resolveBootstrappedWorkstream,
  resolveSaneRepository,
} from "./sane-repository.ts"
import { resolveCommandAddress } from "./sane-cwd-target.ts"
import { SaneWorkstreamStateError } from "./sane-workstream-state.ts"

export class SaneLinkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SaneLinkError"
  }
}

function toLinkError(error: unknown): SaneLinkError {
  if (error instanceof SaneLinkError) return error
  return new SaneLinkError((error as Error).message)
}

function assertSlot(slot: string): void {
  try {
    assertSelectionSlot(slot)
  } catch (error) {
    throw new SaneLinkError((error as Error).message)
  }
}

/** 1:1 slots: `design | planning | execution`. Everything else valid is 1:many. */
function isOneToOneSlot(slot: string): boolean {
  return slot === "design" || slot === "planning" || slot === "execution"
}

// ---------------------------------------------------------------------------
// CLI: sane link
// ---------------------------------------------------------------------------

export interface SaneLinkCommandOptions {
  implementationRepository: string
  workstreamPath: string
  slot: string
  sessionId: string
  worktreePath?: string | null
  branch?: string | null
  force?: boolean
  json?: boolean
  userOverride?: string
  write?: (line: string) => void
}

export interface SaneLinkCommandResult {
  repoRoot: string
  user: string
  workstreamId: string
  slot: string
  sessionId: string
  index: number
  count: number
  worktreePath: string | null
  branch: string | null
}

export interface ParsedLinkArguments {
  implementationRepository: string
  workstreamPath: string
  slot: string
  sessionId: string
  worktreePath: string | undefined
  branch: string | undefined
  force: boolean
  json: boolean
}

export const USAGE =
  "Usage: sane link [<implementation-repository> <workstream-relative-path>] --slot <slot> --session <ses_id> [--worktree-path <dir>] [--branch <name>] [--force] [--json] [--repo-root <path>] (no positionals: auto-detect the target from the current directory)"

function requireOptionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1]
  if (value === undefined || value.startsWith("-")) {
    throw new SaneLinkError(`Option ${option} requires a value.`)
  }
  return value
}

function assertSingleOption(seen: string | undefined, option: string): void {
  if (seen !== undefined) throw new SaneLinkError(`Option ${option} may be provided only once.`)
}

export function parseCliArguments(args: string[]): ParsedLinkArguments {
  let json = false
  let force = false
  let repoRootOpt: string | undefined
  let slot: string | undefined
  let sessionId: string | undefined
  let worktreePath: string | undefined
  let branch: string | undefined
  const positional: string[] = []
  let parseOptions = true

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (parseOptions && argument === "--") {
      parseOptions = false
    } else if (parseOptions && argument === "--json") {
      json = true
    } else if (parseOptions && argument === "--force") {
      force = true
    } else if (parseOptions && argument === "--slot") {
      assertSingleOption(slot, "--slot")
      slot = requireOptionValue(args, index, "--slot")
      index += 1
    } else if (parseOptions && argument === "--session") {
      assertSingleOption(sessionId, "--session")
      sessionId = requireOptionValue(args, index, "--session")
      index += 1
    } else if (parseOptions && argument === "--worktree-path") {
      assertSingleOption(worktreePath, "--worktree-path")
      worktreePath = requireOptionValue(args, index, "--worktree-path")
      index += 1
    } else if (parseOptions && argument === "--branch") {
      assertSingleOption(branch, "--branch")
      branch = requireOptionValue(args, index, "--branch")
      index += 1
    } else if (parseOptions && argument === "--repo-root") {
      const value = args[index + 1]
      if (value === undefined || value.startsWith("-")) {
        throw new SaneLinkError("Option --repo-root requires a value.")
      }
      if (repoRootOpt !== undefined) {
        throw new SaneLinkError("Option --repo-root may be provided only once.")
      }
      repoRootOpt = value
      index += 1
    } else if (parseOptions && argument.startsWith("-")) {
      throw new SaneLinkError(`Unknown option: ${argument}`)
    } else {
      positional.push(argument)
    }
  }

  let implementationRepository: string
  let workstreamPath: string
  if (repoRootOpt !== undefined) {
    if (positional.length !== 1 || !positional[0]) {
      throw new SaneLinkError(
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
    throw new SaneLinkError(
      "Provide an implementation repository and workstream relative path.",
    )
  }

  if (slot === undefined || slot.trim() === "") {
    throw new SaneLinkError("Option --slot is required.")
  }
  if (sessionId === undefined || sessionId.trim() === "") {
    throw new SaneLinkError("Option --session is required.")
  }
  try {
    assertSelectionSlot(slot)
  } catch (error) {
    throw new SaneLinkError((error as Error).message)
  }

  return {
    implementationRepository,
    workstreamPath,
    slot,
    sessionId,
    worktreePath,
    branch,
    force,
    json,
  }
}

/**
 * Link one session to a slot. Enforces the recommended multiplicity at the
 * CLI level: 1:1 slots reject a distinct second session without `--force`
 * (replace = delete-all then link); 1:many slots always append.
 */
export async function runSaneLinkCommand(
  options: SaneLinkCommandOptions,
): Promise<SaneLinkCommandResult> {
  const write = options.write ?? console.log
  if (!options.slot || options.slot.trim() === "") {
    throw new SaneLinkError("Option --slot is required.")
  }
  if (!options.sessionId || options.sessionId.trim() === "") {
    throw new SaneLinkError("Option --session is required.")
  }
  assertSlot(options.slot)
  const slot = options.slot
  const sessionId = options.sessionId
  const force = options.force === true

  const pointer = await resolveSaneRepository(options.implementationRepository).catch((error) => {
    throw toLinkError(error)
  })
  const workstream = await resolveBootstrappedWorkstream(
    pointer.workstreamsRoot,
    options.workstreamPath,
  ).catch((error) => {
    throw toLinkError(error)
  })
  const identity = await resolveSaneIdentity(
    pointer.implementationRepository,
    workstream.relativePath,
    options.userOverride,
  ).catch((error) => {
    throw toLinkError(error)
  })

  // Mutation audit: the linking phase session registers itself.
  const mutation = { actorRole: slot, sessionId }

  const db = await openSaneDb(pointer.implementationRepository)
  try {
    initSchema(db)

    if (isOneToOneSlot(slot)) {
      const existing = listSelectionsBySlot(db, identity, slot)
      const different = existing.filter((row) => row.session_id !== sessionId)
      if (different.length > 0) {
        if (!force) {
          const latest = existing[existing.length - 1] as SelectionRow
          throw new SaneLinkError(
            `Slot "${slot}" is already linked to ${latest.session_id} (${existing.length} session(s)); rerun with --force to replace.`,
          )
        }
        deleteSelection(db, identity, slot, mutation)
      }
    }

    let row: SelectionRow
    try {
      row = linkSelection(
        db,
        identity,
        {
          slot,
          sessionId,
          worktreePath: options.worktreePath ?? null,
          branch: options.branch ?? null,
        },
        mutation,
      )
    } catch (error) {
      throw toLinkError(error)
    }

    const after = listSelectionsBySlot(db, identity, slot)
    const count = after.length
    const found = after.findIndex((entry) => entry.session_id === sessionId)
    const index = found >= 0 ? found + 1 : count

    const result: SaneLinkCommandResult = {
      repoRoot: identity.repoRoot,
      user: identity.user,
      workstreamId: identity.workstreamId,
      slot,
      sessionId,
      index,
      count,
      worktreePath: row.worktree_path,
      branch: row.branch,
    }

    if (options.json === true) {
      write(
        JSON.stringify(
          {
            repo_root: result.repoRoot,
            user: result.user,
            workstream_id: result.workstreamId,
            slot: result.slot,
            session_id: result.sessionId,
            index: result.index,
            count: result.count,
            worktree_path: result.worktreePath,
            branch: result.branch,
          },
          null,
          2,
        ),
      )
    } else {
      write(`Linked: ${result.slot} -> ${result.sessionId} (workstream ${result.workstreamId})`)
      write(`session ${result.index} of ${result.count} for slot ${result.slot}`)
    }
    return result
  } catch (error) {
    if (error instanceof SaneLinkError) throw error
    if (error instanceof SaneWorkstreamStateError) throw new SaneLinkError(error.message)
    throw error
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
    await runSaneLinkCommand({ ...parsed, ...address })
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
