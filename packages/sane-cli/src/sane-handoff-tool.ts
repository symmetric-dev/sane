/**
 * SANE `sane_handoff` tool core: phase-to-phase handoff without a session id.
 *
 * The caller id always comes from the tool execution context
 * (`toolCtx.sessionID`); there is no session/from-session input param. The
 * source slot is reverse-looked-up from the `selections` registry, the target
 * resolves latest-wins (or by 1-based `session_index`, or create-if-empty),
 * and the message is the exact Section 3 `composeHandoff` shape (workstream,
 * sender, and ask — never pasted contents).
 *
 * Queue ONLY: tools never steer. Steer (interrupting an in-progress turn)
 * is reserved for an explicit user redirect or an Execution abort issued
 * through the `sane handoff` CLI with `--steer-reason`; an OpenCode tool
 * call is agent-initiated background delivery, so interrupting the target's
 * live turn would be wrong. There is deliberately no steer/mode input here.
 *
 * New file only. SDK-free: pure DB logic plus the shared handoff primitives
 * (`composeHandoff`/`sendHandoff`/`renameReady`/`resolveOrCreateSession`) from
 * `sane-handoff-command.ts`. Does not touch the CLI, skills, docs, or
 * installer.
 */

import type { Database } from "bun:sqlite"

import {
  assertSelectionSlot,
  listSelections,
  listSelectionsBySlot,
  type SaneIdentity,
} from "./sane-db.ts"
import {
  composeHandoff,
  DEFAULT_HANDOFF_SERVER_URL,
  renameReady,
  resolveOrCreateSession,
  SaneHandoffError,
  sendHandoff,
  type HandoffFetch,
} from "./sane-handoff-command.ts"

function assertSlot(slot: string): void {
  try {
    assertSelectionSlot(slot)
  } catch (error) {
    throw new SaneHandoffError((error as Error).message)
  }
}

/**
 * Reverse-lookup which slot(s) hold `sessionId` in this workstream identity.
 *
 * Returns the single linked slot. Zero slots throws (link first); multiple
 * slots without an explicit `from` throws (ambiguous). With `from`, the slot
 * is validated and the (from, sessionId) row must exist.
 */
export function resolveFromSlot(
  db: Database,
  identity: SaneIdentity,
  sessionId: string,
  from?: string,
): string {
  if (!sessionId || sessionId.trim() === "") {
    throw new SaneHandoffError("Session id must be non-empty.")
  }
  const rows = listSelections(db, identity).filter((row) => row.session_id === sessionId)
  if (rows.length === 0) {
    throw new SaneHandoffError(`Session ${sessionId} is not linked to any slot; link first.`)
  }
  if (from !== undefined) {
    assertSlot(from)
    const match = rows.find((row) => row.slot === from)
    if (!match) {
      throw new SaneHandoffError(`Session ${sessionId} is not linked to slot "${from}".`)
    }
    return from
  }
  const slots: string[] = []
  for (const row of rows) {
    if (!slots.includes(row.slot)) slots.push(row.slot)
  }
  if (slots.length > 1) {
    throw new SaneHandoffError(
      `Session ${sessionId} is linked to <${slots.join(", ")}>; pass from to disambiguate.`,
    )
  }
  return slots[0]!
}

export interface HandoffAsSessionInput {
  /** Caller session id (from the tool context, never from tool input). */
  fromSession: string
  /** Target phase slot. */
  to: string
  /** The ask (single line); becomes the `Message:` line. */
  message: string
  /** 1-based index into the target slot's linked sessions (read-only resolve). */
  session_index?: number
  /** Exact session id to reply to (must be linked to the target slot). Prefer over session_index for replies. */
  to_session?: string
  /**
   * Create a fresh target session even when linked ones exist (prefer for
   * new research problems; default reuses latest). Mutually exclusive with
   * `session_index`/`to_session`.
   */
  new_session?: boolean
  /** Source slot; required only when the caller session holds several slots. */
  from?: string
}

export interface HandoffAsSessionResult {
  from: { slot: string; session_id: string }
  to: { slot: string; session_id: string; session_index: number; created: boolean }
  mode: "queue"
  ready_title: string
  /** Full composed Section 3 message delivered to the target. */
  message: string
}

export interface HandoffAsSessionOptions {
  fetchImpl?: HandoffFetch
  serverUrl?: string
}

/**
 * Tool core: resolve the caller slot, resolve-or-create the target, compose
 * the Section 3 message, queue it, and flag the target `[ready]`. Queue-only
 * by construction (see module note); there is no steer/mode input.
 */
export async function runHandoffAsSession(
  db: Database,
  identity: SaneIdentity,
  input: HandoffAsSessionInput,
  options?: HandoffAsSessionOptions,
): Promise<HandoffAsSessionResult> {
  if (!input.to || input.to.trim() === "") {
    throw new SaneHandoffError("Option to is required.")
  }
  if (!input.message || input.message.trim() === "") {
    throw new SaneHandoffError("Option message is required.")
  }
  if (input.message.includes("\n")) {
    throw new SaneHandoffError("Option message must be a single line.")
  }
  if (input.to_session !== undefined && input.session_index !== undefined) {
    throw new SaneHandoffError("Options to_session and session_index are mutually exclusive.")
  }
  if (input.new_session === true && (input.session_index !== undefined || input.to_session !== undefined)) {
    throw new SaneHandoffError("Options new_session and session_index/to_session are mutually exclusive.")
  }
  assertSlot(input.to)
  const fromSlot = resolveFromSlot(db, identity, input.fromSession, input.from)

  let sessionIndex = input.session_index
  if (input.to_session !== undefined) {
    const rows = listSelectionsBySlot(db, identity, input.to)
    const position = rows.findIndex((row) => row.session_id === input.to_session)
    if (position < 0) {
      throw new SaneHandoffError(`Session ${input.to_session} is not linked to slot "${input.to}".`)
    }
    sessionIndex = position + 1
  }

  const serverUrl =
    options?.serverUrl ?? process.env["OPENCODE_SERVER_URL"] ?? DEFAULT_HANDOFF_SERVER_URL
  const fetchImpl = options?.fetchImpl

  const target = await resolveOrCreateSession(db, identity, {
    serverUrl,
    slot: input.to,
    mutation: { actorRole: fromSlot, sessionId: input.fromSession },
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(sessionIndex !== undefined ? { sessionIndex } : {}),
    ...(input.new_session === true ? { forceNew: true } : {}),
  })

  const message = composeHandoff({
    fromSlot,
    fromSession: input.fromSession,
    workstreamId: identity.workstreamId,
    message: input.message,
  })

  await sendHandoff({
    serverUrl,
    targetSessionId: target.sessionId,
    message,
    fetchImpl,
  })

  const renamed = await renameReady({
    serverUrl,
    targetSessionId: target.sessionId,
    slot: input.to,
    nextAction: input.message,
    fetchImpl,
  })

  return {
    from: { slot: fromSlot, session_id: input.fromSession },
    to: { slot: input.to, session_id: target.sessionId, session_index: target.targetIndex, created: target.created },
    mode: "queue",
    ready_title: renamed.title,
    message,
  }
}
