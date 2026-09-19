/**
 * SANE `sane sessions`: list sessions linked to workstream slots.
 *
 * Read side for the sessions registry (`selections` in `sane-db.ts`).
 * Agents use this to decide who to send an update to. Within each slot,
 * rows in `listSelectionsBySlot` order are numbered 1-based; the highest
 * index is the latest and the default send target.
 *
 * New file only. Read-only use of `sane-db.ts` selections reads; does not
 * touch link/handoff behavior, skills, or docs.
 */

import type { Database } from "bun:sqlite"

import {
  assertSelectionSlot,
  initSchema,
  listSelections,
  listSelectionsBySlot,
  openSaneDb,
  resolveSaneIdentity,
  type SelectionRow,
} from "./sane-db.ts"
import {
  resolveBootstrappedWorkstream,
  resolveSaneRepository,
} from "./sane-repository.ts"
import { resolveCommandAddress } from "./sane-cwd-target.ts"
import { SaneWorkstreamStateError } from "./sane-workstream-state.ts"

export class SaneSessionsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SaneSessionsError"
  }
}

function toSessionsError(error: unknown): SaneSessionsError {
  if (error instanceof SaneSessionsError) return error
  return new SaneSessionsError((error as Error).message)
}

function assertSlot(slot: string): void {
  try {
    assertSelectionSlot(slot)
  } catch (error) {
    throw new SaneSessionsError((error as Error).message)
  }
}

/** Phase order for grouped output, then `research` / `research:*` alphabetically (bare `research` first). */
const PHASE_ORDER = ["design", "engineering", "planning", "execution"] as const

function orderSlots(slots: string[]): string[] {
  const phaseRank = new Map<string, number>(
    PHASE_ORDER.map((phase, index) => [phase, index]),
  )
  return [...slots].sort((a, b) => {
    const rankA = phaseRank.get(a)
    const rankB = phaseRank.get(b)
    if (rankA !== undefined && rankB !== undefined) return rankA - rankB
    if (rankA !== undefined) return -1
    if (rankB !== undefined) return 1
    // Research group sorts after execution (non-phase, alphabetical);
    // bare `research` precedes `research:<topic>`.
    if (a === "research" && b !== "research") return -1
    if (b === "research" && a !== "research") return 1
    return a.localeCompare(b)
  })
}

// ---------------------------------------------------------------------------
// CLI: sane sessions
// ---------------------------------------------------------------------------

export interface SaneSessionsCommandOptions {
  implementationRepository: string
  workstreamPath: string
  slot?: string | undefined
  json?: boolean
  userOverride?: string
  write?: (line: string) => void
}

export interface SaneSessionsSlotEntry {
  index: number
  session_id: string
  worktree_path: string | null
  branch: string | null
  updated_at: string
  latest: boolean
}

export interface SaneSessionsCommandResult {
  repoRoot: string
  user: string
  workstreamId: string
  slots: Record<string, SaneSessionsSlotEntry[]>
  total: number
}

export interface ParsedSessionsArguments {
  implementationRepository: string
  workstreamPath: string
  slot: string | undefined
  json: boolean
}

export const USAGE =
  "Usage: sane sessions [<implementation-repository> <workstream-relative-path>] [--slot <slot>] [--json] [--repo-root <path>] (no positionals: auto-detect the target from the current directory)"

function requireOptionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1]
  if (value === undefined || value.startsWith("-")) {
    throw new SaneSessionsError(`Option ${option} requires a value.`)
  }
  return value
}

function assertSingleOption(seen: string | undefined, option: string): void {
  if (seen !== undefined) throw new SaneSessionsError(`Option ${option} may be provided only once.`)
}

export function parseCliArguments(args: string[]): ParsedSessionsArguments {
  let json = false
  let repoRootOpt: string | undefined
  let slot: string | undefined
  const positional: string[] = []
  let parseOptions = true

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (parseOptions && argument === "--") {
      parseOptions = false
    } else if (parseOptions && argument === "--json") {
      json = true
    } else if (parseOptions && argument === "--slot") {
      assertSingleOption(slot, "--slot")
      slot = requireOptionValue(args, index, "--slot")
      index += 1
    } else if (parseOptions && argument === "--repo-root") {
      const value = args[index + 1]
      if (value === undefined || value.startsWith("-")) {
        throw new SaneSessionsError("Option --repo-root requires a value.")
      }
      if (repoRootOpt !== undefined) {
        throw new SaneSessionsError("Option --repo-root may be provided only once.")
      }
      repoRootOpt = value
      index += 1
    } else if (parseOptions && argument.startsWith("-")) {
      throw new SaneSessionsError(`Unknown option: ${argument}`)
    } else {
      positional.push(argument)
    }
  }

  let implementationRepository: string
  let workstreamPath: string
  if (repoRootOpt !== undefined) {
    if (positional.length !== 1 || !positional[0]) {
      throw new SaneSessionsError(
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
    throw new SaneSessionsError(
      "Provide an implementation repository and workstream relative path.",
    )
  }

  if (slot !== undefined) {
    try {
      assertSelectionSlot(slot)
    } catch (error) {
      throw new SaneSessionsError((error as Error).message)
    }
  }

  return {
    implementationRepository,
    workstreamPath,
    slot,
    json,
  }
}

function entriesForRows(rows: SelectionRow[]): SaneSessionsSlotEntry[] {
  return rows.map((row, position) => ({
    index: position + 1,
    session_id: row.session_id,
    worktree_path: row.worktree_path,
    branch: row.branch,
    updated_at: row.updated_at,
    latest: position === rows.length - 1,
  }))
}

function formatSessionLine(entry: SaneSessionsSlotEntry): string {
  let line = `  [${entry.index}] ${entry.session_id}`
  if (entry.latest) line += " (latest)"
  if (entry.worktree_path !== null && entry.branch !== null) {
    line += ` [worktree ${entry.worktree_path} @ ${entry.branch}]`
  } else if (entry.worktree_path !== null) {
    line += ` [worktree ${entry.worktree_path}]`
  } else if (entry.branch !== null) {
    line += ` [branch ${entry.branch}]`
  }
  line += ` [updated ${entry.updated_at}]`
  return line
}

function collectSlots(db: Database, identity: { repoRoot: string; user: string; workstreamId: string }, filterSlot: string | undefined): Record<string, SaneSessionsSlotEntry[]> {
  // Cast to the full SaneIdentity shape for the db helpers.
  const fullIdentity = identity as Parameters<typeof listSelections>[1]
  if (filterSlot !== undefined) {
    const rows = listSelectionsBySlot(db, fullIdentity, filterSlot)
    return { [filterSlot]: entriesForRows(rows) }
  }
  const all = listSelections(db, fullIdentity)
  const distinct = [...new Set(all.map((row) => row.slot))]
  const slots: Record<string, SaneSessionsSlotEntry[]> = {}
  for (const slot of orderSlots(distinct)) {
    slots[slot] = entriesForRows(listSelectionsBySlot(db, fullIdentity, slot))
  }
  return slots
}

/**
 * List linked sessions grouped by slot. Read-only: never mutates the
 * registry. Indexing matches link/handoff addressing (1-based within each
 * slot, highest index is the latest / default send target).
 */
export async function runSaneSessionsCommand(
  options: SaneSessionsCommandOptions,
): Promise<SaneSessionsCommandResult> {
  const write = options.write ?? console.log
  if (options.slot !== undefined) assertSlot(options.slot)
  const slotFilter = options.slot

  const pointer = await resolveSaneRepository(options.implementationRepository).catch((error) => {
    throw toSessionsError(error)
  })
  const workstream = await resolveBootstrappedWorkstream(
    pointer.workstreamsRoot,
    options.workstreamPath,
  ).catch((error) => {
    throw toSessionsError(error)
  })
  const identity = await resolveSaneIdentity(
    pointer.implementationRepository,
    workstream.relativePath,
    options.userOverride,
  ).catch((error) => {
    throw toSessionsError(error)
  })

  const db = await openSaneDb(pointer.implementationRepository)
  try {
    initSchema(db)

    const slots = collectSlots(db, identity, slotFilter)
    const orderedSlotNames = orderSlots(Object.keys(slots))
    // Rebuild in display order so JSON key order matches human order.
    const orderedSlots: Record<string, SaneSessionsSlotEntry[]> = {}
    for (const name of orderedSlotNames) {
      orderedSlots[name] = slots[name]!
    }
    const total = orderedSlotNames.reduce((sum, name) => sum + (orderedSlots[name]?.length ?? 0), 0)

    const result: SaneSessionsCommandResult = {
      repoRoot: identity.repoRoot,
      user: identity.user,
      workstreamId: identity.workstreamId,
      slots: orderedSlots,
      total,
    }

    if (options.json === true) {
      write(
        JSON.stringify(
          {
            repo_root: result.repoRoot,
            user: result.user,
            workstream_id: result.workstreamId,
            slots: result.slots,
            total: result.total,
          },
          null,
          2,
        ),
      )
    } else {
      write(`sessions for workstream ${result.workstreamId} (${result.total} total)`)
      if (result.total === 0) {
        write("(no linked sessions)")
      } else {
        for (const name of orderedSlotNames) {
          const entries = orderedSlots[name]!
          // Omit empty slots (possible for a --slot filter with no rows).
          if (entries.length === 0) continue
          write(`${name} (${entries.length}):`)
          for (const entry of entries) {
            write(formatSessionLine(entry))
          }
        }
        // A --slot filter matching nothing is still an empty registry view.
        const shown = orderedSlotNames.reduce(
          (sum, name) => sum + (orderedSlots[name]?.length ?? 0),
          0,
        )
        if (shown === 0) write("(no linked sessions)")
      }
    }
    return result
  } catch (error) {
    if (error instanceof SaneSessionsError) throw error
    if (error instanceof SaneWorkstreamStateError) throw new SaneSessionsError(error.message)
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
    await runSaneSessionsCommand({ ...parsed, ...address })
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
