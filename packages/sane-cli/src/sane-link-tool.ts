/**
 * SANE `sane_link` tool core: session-to-slot self-registration policy.
 *
 * Pure DB operation shared by the OpenCode plugin
 * (`opencode/plugins/sane/index.ts`). Mirrors the `sane link` CLI policy in
 * `sane-link-command.ts` exactly: 1:1 slots (`design | planning | execution`)
 * refuse a distinct second session without `force` (same error text);
 * 1:many slots (`engineering | research:*`) always append; exact
 * (slot, session) duplicates throw via `linkSelection`.
 *
 * New file only. Read-only reuse of `sane-db.ts` selections CRUD; does not
 * touch the CLI, skills, docs, or handoff/sessions commands.
 */

import type { Database } from "bun:sqlite"

import {
  assertSelectionSlot,
  deleteSelection,
  linkSelection,
  listSelectionsBySlot,
  type SaneIdentity,
  type SelectionRow,
} from "./sane-db.ts"

export class SaneLinkToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SaneLinkToolError"
  }
}

function toLinkToolError(error: unknown): SaneLinkToolError {
  if (error instanceof SaneLinkToolError) return error
  return new SaneLinkToolError((error as Error).message)
}

function assertSlot(slot: string): void {
  try {
    assertSelectionSlot(slot)
  } catch (error) {
    throw new SaneLinkToolError((error as Error).message)
  }
}

/** 1:1 slots: `design | planning | execution`. Everything else valid is 1:many. */
function isOneToOneSlot(slot: string): boolean {
  return slot === "design" || slot === "planning" || slot === "execution"
}

export interface LinkSessionSelectionInput {
  slot: string
  sessionId: string
  worktreePath?: string | null
  branch?: string | null
  force?: boolean
}

export interface LinkSessionSelectionResult {
  slot: string
  sessionId: string
  /** 1-based position in `listSelectionsBySlot` order (stable by updated_at, rowid). */
  index: number
  count: number
  worktreePath: string | null
  branch: string | null
}

/**
 * Link one session to a slot. Enforces the recommended multiplicity exactly
 * like the `sane link` CLI: 1:1 slots reject a distinct second session
 * without `force` (replace = delete-all then link); 1:many slots always
 * append. Mutation-audited with `{ actorRole: slot, sessionId }`.
 */
export function linkSessionSelection(
  db: Database,
  identity: SaneIdentity,
  input: LinkSessionSelectionInput,
): LinkSessionSelectionResult {
  if (!input.slot || input.slot.trim() === "") {
    throw new SaneLinkToolError("Option --slot is required.")
  }
  if (!input.sessionId || input.sessionId.trim() === "") {
    throw new SaneLinkToolError("Option --session is required.")
  }
  assertSlot(input.slot)
  const slot = input.slot
  const sessionId = input.sessionId
  const force = input.force === true

  // Mutation audit: the linking phase session registers itself.
  const mutation = { actorRole: slot, sessionId }

  if (isOneToOneSlot(slot)) {
    const existing = listSelectionsBySlot(db, identity, slot)
    const different = existing.filter((row) => row.session_id !== sessionId)
    if (different.length > 0) {
      if (!force) {
        const latest = existing[existing.length - 1] as SelectionRow
        throw new SaneLinkToolError(
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
        worktreePath: input.worktreePath ?? null,
        branch: input.branch ?? null,
      },
      mutation,
    )
  } catch (error) {
    throw toLinkToolError(error)
  }

  const after = listSelectionsBySlot(db, identity, slot)
  const count = after.length
  const found = after.findIndex((entry) => entry.session_id === sessionId)
  const index = found >= 0 ? found + 1 : count

  return {
    slot,
    sessionId,
    index,
    count,
    worktreePath: row.worktree_path,
    branch: row.branch,
  }
}
