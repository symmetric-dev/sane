/**
 * SANE 0.2.0 M4: session registry + handoff (`sane handoff`).
 *
 * Docs: `docs/SANE_0_2_0.md` Section 3 (Session Flow).
 *
 * - Each workstream has one long-lived top-level phase session per active
 *   phase (`design | engineering | planning | execution`), never subagents.
 *   Research is a support track (`research:<topic>`), kickoff-able from any
 *   phase, no gates.
 * - Handoff via shell to the OpenCode server API:
 *   `POST /api/session` (only when the target slot has none; created with
 *   the slot's assistant agent and pinned model) and
 *   `POST /api/session/{id}/prompt` (queue default; steer only for explicit
 *   user redirect + Execution abort).
 * - Message is workstream + sender + ask (`Workstream/Handoff From/Message`),
 *   never pasted contents. The target reads artifacts on Pickup.
 * - `selections` is the address book
 *   `(repo, user, workstream, slot) -> sessionID + worktree_path + branch`;
 *   stable IDs, new session only when slot empty or user-directed.
 * - No auto-open: rename target `[ready] <slot>: <next>` via the session
 *   rename API; the user switches.
 *
 * New file only (M4). Read-only use of `sane-db.ts` selections CRUD
 * (`upsertSelection`/`getSelection`); no schema refactor. Does not touch
 * `bin/sane.ts` (integrator wires), worktree/merge files,
 * `templates/`, or agents/skills.
 */

import type { Database } from "bun:sqlite"

import {
  assertSelectionSlot,
  getSelection,
  getWorkstream,
  initSchema,
  listSelectionsBySlot,
  openSaneDb,
  resolveSaneIdentity,
  upsertSelection,
  type MutationContext,
  type SaneIdentity,
  type SelectionRow,
} from "./sane-db.ts"
import {
  resolveBootstrappedWorkstream,
  resolveSaneRepository,
} from "./sane-repository.ts"
import { resolveCommandAddress } from "./sane-cwd-target.ts"
import { SaneWorkstreamStateError } from "./sane-workstream-state.ts"

export class SaneHandoffError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SaneHandoffError"
  }
}

function toHandoffError(error: unknown): SaneHandoffError {
  if (error instanceof SaneHandoffError) return error
  return new SaneHandoffError((error as Error).message)
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type HandoffDeliveryMode = "queue" | "steer"

export const HANDOFF_STEER_REASONS = ["user-redirect", "execution-abort"] as const
export type HandoffSteerReason = (typeof HANDOFF_STEER_REASONS)[number]

const STEER_REASON_SET = new Set<string>(HANDOFF_STEER_REASONS)

export const DEFAULT_HANDOFF_SERVER_URL = "http://127.0.0.1:4096"

/**
 * Phase slot to OpenCode assistant agent. Created handoff sessions start
 * with the target phase's assistant so the user lands in the right role
 * (previously sessions came up as the default Build agent).
 */
export const ASSISTANT_AGENT_BY_SLOT: Record<string, string> = {
  design: "sane/assistant/design",
  engineering: "sane/assistant/engineering",
  planning: "sane/assistant/planning",
  execution: "sane/assistant/execution",
  research: "sane/assistant/research",
}

/**
 * Default model for created handoff sessions. Mirrors `models.yaml` (all
 * SANE assistants pin `opencode-go/muse-spark-1.3-contributor`, variant
 * high); keep in sync when `models.yaml` changes. Passed explicitly
 * because the server does not apply the agent's configured model on its
 * own (a bare create replies with the server default model).
 */
export const HANDOFF_DEFAULT_MODEL = {
  id: "muse-spark-1.3-contributor",
  providerID: "opencode-go",
  variant: "high",
} as const

/** Assistant agent for a target slot (`research:<topic>` shares the research assistant). */
export function assistantAgentForSlot(slot: string): string {
  if (slot === "research" || slot.startsWith("research:")) return ASSISTANT_AGENT_BY_SLOT["research"]!
  const agent = ASSISTANT_AGENT_BY_SLOT[slot]
  if (!agent) throw new SaneHandoffError(`No assistant agent for slot ${JSON.stringify(slot)}.`)
  return agent
}

export type HandoffFetchResponse = {
  ok: boolean
  status: number
  statusText?: string
  json(): Promise<unknown>
  text(): Promise<string>
}

export type HandoffFetch = (
  url: string,
  init?: RequestInit,
) => Promise<HandoffFetchResponse>

function defaultFetch(): HandoffFetch {
  const impl = (globalThis as unknown as { fetch?: HandoffFetch }).fetch
  if (!impl) throw new SaneHandoffError("No fetch implementation available.")
  return impl
}

/**
 * Basic-auth headers for the OpenCode server API. The server requires
 * `Authorization: Basic base64(user:pass)` when `OPENCODE_SERVER_PASSWORD`
 * is set (username defaults to `opencode`); without a password no header
 * is sent. Reads env at call time so tests can stub per-case.
 */
export function serverAuthHeaders(env?: NodeJS.ProcessEnv): Record<string, string> {
  const source = env ?? process.env
  const password = source["OPENCODE_SERVER_PASSWORD"]
  if (!password) return {}
  const username = source["OPENCODE_SERVER_USERNAME"] || "opencode"
  const token =
    typeof Buffer !== "undefined"
      ? Buffer.from(`${username}:${password}`, "utf8").toString("base64")
      : btoa(`${username}:${password}`)
  return { Authorization: `Basic ${token}` }
}

function normalizeServerUrl(serverUrl: string): string {
  if (!serverUrl || serverUrl.trim() === "") {
    throw new SaneHandoffError("Server URL must be non-empty.")
  }
  return serverUrl.trim().replace(/\/+$/, "")
}

function assertNonEmpty(field: string, value: string): void {
  if (!value || value.trim() === "") throw new SaneHandoffError(`${field} must be non-empty.`)
}

function assertSingleLine(field: string, value: string): void {
  if (value.includes("\n")) throw new SaneHandoffError(`${field} must be a single line.`)
}

function assertSlot(slot: string): void {
  try {
    assertSelectionSlot(slot)
  } catch (error) {
    throw new SaneHandoffError((error as Error).message)
  }
}

// ---------------------------------------------------------------------------
// composeHandoff
// ---------------------------------------------------------------------------

export interface ComposeHandoffInput {
  fromSlot: string
  fromSession: string
  workstreamId: string
  /** The ask (single line). The receiver knows its role; paths resolve from the workstream. */
  message: string
}

/**
 * Compose the exact Section 3 handoff message shape: workstream, sender,
 * and ask only — never pasted artifact contents or ref dumps. Paths resolve
 * from the workstream id on Pickup; approvals and revisions are read via
 * `sane view`. The target session reads artifacts itself during Pickup.
 */
export function composeHandoff(input: ComposeHandoffInput): string {
  assertNonEmpty("fromSlot", input.fromSlot)
  assertNonEmpty("fromSession", input.fromSession)
  assertNonEmpty("workstreamId", input.workstreamId)
  assertNonEmpty("message", input.message)
  assertSlot(input.fromSlot)
  assertSingleLine("fromSession", input.fromSession.trim())
  assertSingleLine("message", input.message.trim())

  const slot = input.fromSlot.trim()
  const sender = `${slot.charAt(0).toUpperCase()}${slot.slice(1)} Session`

  return [
    `Workstream: ${input.workstreamId}`,
    `Handoff From: ${sender} (${input.fromSession.trim()})`,
    `Message: ${input.message.trim()}`,
  ].join("\n")
}

// ---------------------------------------------------------------------------
// sendHandoff
// ---------------------------------------------------------------------------

export interface SendHandoffInput {
  serverUrl: string
  targetSessionId: string
  message: string
  mode?: HandoffDeliveryMode
  steerReason?: string
  fetchImpl?: HandoffFetch
}

export interface SendHandoffResult {
  url: string
  mode: HandoffDeliveryMode
  ok: boolean
}

/**
 * Deliver the handoff message via `POST /api/session/{id}/prompt`.
 *
 * Queue delivery is the default. `steer` (interrupting an in-progress turn)
 * is reserved for an explicit user redirect or an Execution abort; any
 * `steer` without `steerReason: 'user-redirect' | 'execution-abort'` throws
 * instead of sending.
 */
export async function sendHandoff(input: SendHandoffInput): Promise<SendHandoffResult> {
  const mode: HandoffDeliveryMode = input.mode ?? "queue"
  if (mode !== "queue" && mode !== "steer") {
    throw new SaneHandoffError(`Invalid handoff mode ${JSON.stringify(mode)}. Expected "queue" or "steer".`)
  }
  if (input.steerReason !== undefined && !STEER_REASON_SET.has(input.steerReason)) {
    throw new SaneHandoffError(
      `Invalid steer reason ${JSON.stringify(input.steerReason)}. Expected one of: ${HANDOFF_STEER_REASONS.join(", ")}.`,
    )
  }
  if (mode === "steer" && (input.steerReason === undefined || !STEER_REASON_SET.has(input.steerReason))) {
    throw new SaneHandoffError(
      `Steer delivery requires steerReason one of: ${HANDOFF_STEER_REASONS.join(", ")}.`,
    )
  }
  if (mode === "queue" && input.steerReason !== undefined) {
    throw new SaneHandoffError(`steerReason requires mode "steer" (got "queue").`)
  }
  assertNonEmpty("targetSessionId", input.targetSessionId)
  assertNonEmpty("message", input.message)
  assertSingleLine("targetSessionId", input.targetSessionId.trim())
  const base = normalizeServerUrl(input.serverUrl)
  const url = `${base}/api/session/${encodeURIComponent(input.targetSessionId)}/prompt`
  const fetchImpl = input.fetchImpl ?? defaultFetch()
  // Server prompt shape: `{ text, delivery }` where `delivery` is
  // `"queue" | "steer"`. `message` maps to `text`; `steerReason` is a
  // local SANE guard and is not sent to the server.
  const body = JSON.stringify({ text: input.message, delivery: mode })
  let response: HandoffFetchResponse
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...serverAuthHeaders() },
      body,
    })
  } catch (error) {
    throw new SaneHandoffError(`Handoff prompt POST failed: ${(error as Error).message}`)
  }
  if (!response.ok) {
    throw new SaneHandoffError(`Handoff prompt POST failed: ${response.status} ${response.statusText ?? ""}`.trim())
  }
  return { url, mode, ok: true }
}

// ---------------------------------------------------------------------------
// resolveOrCreateSession
// ---------------------------------------------------------------------------

export interface ResolveOrCreateSessionOptions {
  serverUrl: string
  slot: string
  mutation: MutationContext
  fetchImpl?: HandoffFetch
  /** User-directed rebuild: create even when the slot already has a session. */
  forceNew?: boolean
  /**
   * 1-based index into `listSelectionsBySlot` order (matches `sane sessions`
   * `[n]`). When set, resolves the n-th linked session read-only: no creation,
   * no registry write, no mutation record. Mutually exclusive with `forceNew`.
   */
  sessionIndex?: number
  worktreePath?: string | null
  branch?: string | null
  /** Optional title for the created session (`POST /api/session`). */
  title?: string
}

export interface ResolveOrCreateSessionResult {
  sessionId: string
  created: boolean
  row: SelectionRow
  /** 1-based position of the resolved session in slot order (1 when freshly created). */
  targetIndex: number
}

function extractSessionId(payload: unknown): string | null {
  if (typeof payload === "string") {
    const trimmed = payload.trim()
    return trimmed === "" ? null : trimmed
  }
  if (typeof payload !== "object" || payload === null) return null
  const record = payload as Record<string, unknown>
  const candidates: unknown[] = [
    record["id"],
    record["sessionId"],
    record["sessionID"],
    record["session_id"],
  ]
  const nested = record["data"]
  if (typeof nested === "object" && nested !== null) {
    const inner = nested as Record<string, unknown>
    candidates.push(inner["id"], inner["sessionId"], inner["sessionID"], inner["session_id"])
  }
  const session = record["session"]
  if (typeof session === "object" && session !== null) {
    const inner = session as Record<string, unknown>
    candidates.push(inner["id"], inner["sessionId"], inner["sessionID"], inner["session_id"])
  }
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim()
  }
  return null
}

/**
 * Resolve the target sessionID from the `selections` address book. Creates a
 * session via `POST /api/session` only when the slot has none (or when
 * `forceNew` is set for a user-directed rebuild), then updates the registry.
 * SessionIDs are stable across handoffs.
 *
 * When `sessionIndex` is set (1-based, `sane sessions` order), resolves the
 * n-th linked session read-only instead: out-of-range (or an empty slot)
 * throws rather than creating, and the registry is left untouched.
 */
export async function resolveOrCreateSession(
  db: Database,
  identity: SaneIdentity,
  options: ResolveOrCreateSessionOptions,
): Promise<ResolveOrCreateSessionResult> {
  assertSlot(options.slot)
  if (!options.mutation?.actorRole || options.mutation.actorRole.trim() === "") {
    throw new SaneHandoffError("Mutation actorRole must be non-empty.")
  }
  if (!options.mutation?.sessionId || options.mutation.sessionId.trim() === "") {
    throw new SaneHandoffError("Mutation sessionId must be non-empty.")
  }
  const base = normalizeServerUrl(options.serverUrl)
  const forceNew = options.forceNew === true

  if (options.sessionIndex !== undefined) {
    if (!Number.isInteger(options.sessionIndex) || (options.sessionIndex as number) < 1) {
      throw new SaneHandoffError("Option --session-index must be a positive integer.")
    }
    if (forceNew) {
      throw new SaneHandoffError("Options --force-new and --session-index are mutually exclusive.")
    }
    // Explicit index names an existing session: read-only resolve, never create.
    const rows = listSelectionsBySlot(db, identity, options.slot)
    const row = rows[options.sessionIndex - 1]
    if (!row) {
      throw new SaneHandoffError(
        `No session at index ${options.sessionIndex} for slot "${options.slot}" (${rows.length} linked).`,
      )
    }
    return { sessionId: row.session_id, created: false, row, targetIndex: options.sessionIndex }
  }

  if (!forceNew) {
    const existing = getSelection(db, identity, options.slot)
    if (existing) {
      const rows = listSelectionsBySlot(db, identity, options.slot)
      const position = rows.findIndex((row) => row.session_id === existing.session_id)
      return {
        sessionId: existing.session_id,
        created: false,
        row: existing,
        targetIndex: position >= 0 ? position + 1 : rows.length,
      }
    }
  }

  const existingForPaths = getSelection(db, identity, options.slot)
  const fetchImpl = options.fetchImpl ?? defaultFetch()
  const url = `${base}/api/session`
  const createBody: Record<string, unknown> = {
    agent: assistantAgentForSlot(options.slot),
    model: { ...HANDOFF_DEFAULT_MODEL },
    // Create the session in the implementation repository so it appears in
    // the project-scoped session list (the server default lands elsewhere,
    // e.g. the server cwd, making the [ready] session invisible). The
    // workstream resolves from this directory on Pickup.
    location: { directory: identity.repoRoot },
  }
  if (options.title !== undefined) {
    if (options.title.trim() === "") throw new SaneHandoffError("Session title must be non-empty when provided.")
    createBody["title"] = options.title
  }
  let response: HandoffFetchResponse
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...serverAuthHeaders() },
      body: JSON.stringify(createBody),
    })
  } catch (error) {
    throw new SaneHandoffError(`Session create POST failed: ${(error as Error).message}`)
  }
  if (!response.ok) {
    throw new SaneHandoffError(`Session create POST failed: ${response.status} ${response.statusText ?? ""}`.trim())
  }
  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    try {
      payload = await response.text()
    } catch {
      payload = null
    }
  }
  const sessionId = extractSessionId(payload)
  if (!sessionId) {
    throw new SaneHandoffError("Session create response did not contain a session id.")
  }
  const row = upsertSelection(
    db,
    identity,
    {
      slot: options.slot,
      sessionId,
      worktreePath: options.worktreePath ?? existingForPaths?.worktree_path ?? null,
      branch: options.branch ?? existingForPaths?.branch ?? null,
    },
    options.mutation,
  )
  const ordered = listSelectionsBySlot(db, identity, options.slot)
  const position = ordered.findIndex((entry) => entry.session_id === sessionId)
  return { sessionId, created: true, row, targetIndex: position >= 0 ? position + 1 : 1 }
}

// ---------------------------------------------------------------------------
// renameReady
// ---------------------------------------------------------------------------

export interface RenameReadyInput {
  serverUrl: string
  targetSessionId: string
  slot: string
  nextAction: string
  fetchImpl?: HandoffFetch
}

export interface RenameReadyResult {
  url: string
  title: string
  ok: boolean
}

/** No-auto-open signal: `[ready] <slot>: <next action>`. The user switches. */
export function readyTitle(slot: string, nextAction: string): string {
  assertNonEmpty("slot", slot)
  assertNonEmpty("nextAction", nextAction)
  assertSlot(slot)
  assertSingleLine("nextAction", nextAction.trim())
  return `[ready] ${slot}: ${nextAction.trim()}`
}

/**
 * Rename the target session via `PATCH /api/session/{id}` so the user
 * sees the handoff without auto-open. Delivering the prompt never focuses
 * the target; the user decides when to switch.
 */
export async function renameReady(input: RenameReadyInput): Promise<RenameReadyResult> {
  assertNonEmpty("targetSessionId", input.targetSessionId)
  assertSingleLine("targetSessionId", input.targetSessionId.trim())
  const title = readyTitle(input.slot, input.nextAction)
  const base = normalizeServerUrl(input.serverUrl)
  const url = `${base}/api/session/${encodeURIComponent(input.targetSessionId)}`
  const fetchImpl = input.fetchImpl ?? defaultFetch()
  let response: HandoffFetchResponse
  try {
    response = await fetchImpl(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...serverAuthHeaders() },
      body: JSON.stringify({ title }),
    })
  } catch (error) {
    throw new SaneHandoffError(`Session rename POST failed: ${(error as Error).message}`)
  }
  if (!response.ok) {
    throw new SaneHandoffError(`Session rename POST failed: ${response.status} ${response.statusText ?? ""}`.trim())
  }
  return { url, title, ok: true }
}

// ---------------------------------------------------------------------------
// CLI: sane handoff
// ---------------------------------------------------------------------------

export interface SaneHandoffCommandOptions {
  implementationRepository: string
  workstreamPath: string
  fromSlot: string
  toSlot: string
  nextAction: string
  steerReason?: string
  serverUrl?: string
  fromSessionOverride?: string
  json?: boolean
  userOverride?: string
  worktreePath?: string | null
  branch?: string | null
  /** 1-based index into the target slot's linked sessions (read-only resolve). */
  sessionIndex?: number
  /**
   * User-directed rebuild: create a fresh target session even when the slot
   * already has linked sessions. Mutually exclusive with `sessionIndex`.
   */
  forceNew?: boolean
  fetchImpl?: HandoffFetch
  write?: (line: string) => void
}

export interface SaneHandoffCommandResult {
  repoRoot: string
  user: string
  workstreamId: string
  fromSlot: string
  fromSession: string
  toSlot: string
  toSession: string
  targetCreated: boolean
  /** 1-based position of the target in slot order (1 when freshly created). */
  targetIndex: number | null
  mode: HandoffDeliveryMode
  message: string
  readyTitle: string
}

export interface ParsedHandoffArguments {
  implementationRepository: string
  workstreamPath: string
  fromSlot: string
  toSlot: string
  nextAction: string
  steerReason: string | undefined
  serverUrl: string | undefined
  fromSessionOverride: string | undefined
  worktreePath: string | undefined
  branch: string | undefined
  sessionIndex: number | undefined
  /** `--new`: create a fresh target session even when linked ones exist. */
  forceNew: boolean
  json: boolean
}

export const USAGE =
  "Usage: sane handoff [<implementation-repository> <workstream-relative-path>] --from <slot> --to <slot> --next <action> [--session-index <n>] [--new] [--steer-reason <user-redirect|execution-abort>] [--server-url <url>] [--from-session <id>] [--worktree-path <dir>] [--branch <name>] [--json] [--repo-root <path>] (no positionals: auto-detect the target from the current directory)"

function requireOptionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1]
  if (value === undefined || value.startsWith("-")) {
    throw new SaneHandoffError(`Option ${option} requires a value.`)
  }
  return value
}

function assertSingleOption(seen: string | undefined, option: string): void {
  if (seen !== undefined) throw new SaneHandoffError(`Option ${option} may be provided only once.`)
}

function parseSessionIndexOption(raw: string): number {
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) {
    throw new SaneHandoffError("Option --session-index must be a positive integer.")
  }
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new SaneHandoffError("Option --session-index must be a positive integer.")
  }
  return parsed
}

export function parseCliArguments(args: string[]): ParsedHandoffArguments {
  let json = false
  let repoRootOpt: string | undefined
  let fromSlot: string | undefined
  let toSlot: string | undefined
  let nextAction: string | undefined
  let steerReason: string | undefined
  let serverUrl: string | undefined
  let fromSessionOverride: string | undefined
  let worktreePath: string | undefined
  let branch: string | undefined
  let sessionIndexRaw: string | undefined
  let sessionIndex: number | undefined
  let forceNew = false
  const positional: string[] = []
  let parseOptions = true

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (parseOptions && argument === "--") {
      parseOptions = false
    } else if (parseOptions && argument === "--json") {
      json = true
    } else if (parseOptions && argument === "--new") {
      forceNew = true
    } else if (parseOptions && argument === "--from") {
      assertSingleOption(fromSlot, "--from")
      fromSlot = requireOptionValue(args, index, "--from")
      index += 1
    } else if (parseOptions && argument === "--to") {
      assertSingleOption(toSlot, "--to")
      toSlot = requireOptionValue(args, index, "--to")
      index += 1
    } else if (parseOptions && argument === "--next") {
      assertSingleOption(nextAction, "--next")
      nextAction = requireOptionValue(args, index, "--next")
      index += 1
    } else if (parseOptions && argument === "--steer-reason") {
      assertSingleOption(steerReason, "--steer-reason")
      steerReason = requireOptionValue(args, index, "--steer-reason")
      index += 1
    } else if (parseOptions && argument === "--server-url") {
      assertSingleOption(serverUrl, "--server-url")
      serverUrl = requireOptionValue(args, index, "--server-url")
      index += 1
    } else if (parseOptions && argument === "--from-session") {
      assertSingleOption(fromSessionOverride, "--from-session")
      fromSessionOverride = requireOptionValue(args, index, "--from-session")
      index += 1
    } else if (parseOptions && argument === "--worktree-path") {
      assertSingleOption(worktreePath, "--worktree-path")
      worktreePath = requireOptionValue(args, index, "--worktree-path")
      index += 1
    } else if (parseOptions && argument === "--branch") {
      assertSingleOption(branch, "--branch")
      branch = requireOptionValue(args, index, "--branch")
      index += 1
    } else if (parseOptions && argument === "--session-index") {
      assertSingleOption(sessionIndexRaw, "--session-index")
      // Read the raw token directly (not requireOptionValue) so negative and
      // non-numeric values report the positive-integer error, not a missing
      // value error.
      const raw = args[index + 1]
      if (raw === undefined) {
        throw new SaneHandoffError("Option --session-index requires a value.")
      }
      sessionIndexRaw = raw
      sessionIndex = parseSessionIndexOption(raw)
      index += 1
    } else if (parseOptions && argument === "--repo-root") {
      const value = args[index + 1]
      if (value === undefined || value.startsWith("-")) {
        throw new SaneHandoffError("Option --repo-root requires a value.")
      }
      if (repoRootOpt !== undefined) {
        throw new SaneHandoffError("Option --repo-root may be provided only once.")
      }
      repoRootOpt = value
      index += 1
    } else if (parseOptions && argument.startsWith("-")) {
      throw new SaneHandoffError(`Unknown option: ${argument}`)
    } else {
      positional.push(argument)
    }
  }

  let implementationRepository: string
  let workstreamPath: string
  if (repoRootOpt !== undefined) {
    if (positional.length !== 1 || !positional[0]) {
      throw new SaneHandoffError(
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
    throw new SaneHandoffError(
      "Provide an implementation repository and workstream relative path.",
    )
  }

  if (fromSlot === undefined || fromSlot.trim() === "") {
    throw new SaneHandoffError("Option --from is required.")
  }
  if (toSlot === undefined || toSlot.trim() === "") {
    throw new SaneHandoffError("Option --to is required.")
  }
  if (nextAction === undefined || nextAction.trim() === "") {
    throw new SaneHandoffError("Option --next is required.")
  }
  if (nextAction.includes("\n")) {
    throw new SaneHandoffError("Option --next must be a single line.")
  }
  try {
    assertSelectionSlot(fromSlot)
  } catch (error) {
    throw new SaneHandoffError((error as Error).message)
  }
  try {
    assertSelectionSlot(toSlot)
  } catch (error) {
    throw new SaneHandoffError((error as Error).message)
  }
  if (steerReason !== undefined && !STEER_REASON_SET.has(steerReason)) {
    throw new SaneHandoffError(
      `Invalid steer reason ${JSON.stringify(steerReason)}. Expected one of: ${HANDOFF_STEER_REASONS.join(", ")}.`,
    )
  }
  if (serverUrl !== undefined && serverUrl.trim() === "") {
    throw new SaneHandoffError("Option --server-url must be non-empty.")
  }
  if (fromSessionOverride !== undefined && fromSessionOverride.trim() === "") {
    throw new SaneHandoffError("Option --from-session must be non-empty.")
  }
  if (forceNew && sessionIndex !== undefined) {
    throw new SaneHandoffError("Options --new and --session-index are mutually exclusive.")
  }

  return {
    implementationRepository,
    workstreamPath,
    fromSlot,
    toSlot,
    nextAction,
    steerReason,
    serverUrl,
    fromSessionOverride,
    worktreePath,
    branch,
    sessionIndex,
    forceNew,
    json,
  }
}

/**
 * Deliver the queue-default prompt and flag the target `[ready]` without
 * opening it. The target session reads artifacts on Pickup; this command
 * only passes the workstream, the sender, and the ask.
 */
export async function runSaneHandoffCommand(
  options: SaneHandoffCommandOptions,
): Promise<SaneHandoffCommandResult> {
  const write = options.write ?? console.log
  if (!options.fromSlot || options.fromSlot.trim() === "") {
    throw new SaneHandoffError("Option --from is required.")
  }
  if (!options.toSlot || options.toSlot.trim() === "") {
    throw new SaneHandoffError("Option --to is required.")
  }
  if (!options.nextAction || options.nextAction.trim() === "") {
    throw new SaneHandoffError("Option --next is required.")
  }
  if (options.nextAction.includes("\n")) {
    throw new SaneHandoffError("Option --next must be a single line.")
  }
  assertSlot(options.fromSlot)
  assertSlot(options.toSlot)
  if (
    options.sessionIndex !== undefined &&
    (!Number.isInteger(options.sessionIndex) || options.sessionIndex < 1)
  ) {
    throw new SaneHandoffError("Option --session-index must be a positive integer.")
  }
  if (options.forceNew === true && options.sessionIndex !== undefined) {
    throw new SaneHandoffError("Options --new and --session-index are mutually exclusive.")
  }
  if (options.steerReason !== undefined && !STEER_REASON_SET.has(options.steerReason)) {
    throw new SaneHandoffError(
      `Invalid steer reason ${JSON.stringify(options.steerReason)}. Expected one of: ${HANDOFF_STEER_REASONS.join(", ")}.`,
    )
  }
  const mode: HandoffDeliveryMode = options.steerReason !== undefined ? "steer" : "queue"
  const serverUrl =
    options.serverUrl ?? process.env["OPENCODE_SERVER_URL"] ?? DEFAULT_HANDOFF_SERVER_URL
  const fetchImpl = options.fetchImpl ?? defaultFetch()

  const pointer = await resolveSaneRepository(options.implementationRepository).catch((error) => {
    throw toHandoffError(error)
  })
  const workstream = await resolveBootstrappedWorkstream(
    pointer.workstreamsRoot,
    options.workstreamPath,
  ).catch((error) => {
    throw toHandoffError(error)
  })
  const identity = await resolveSaneIdentity(
    pointer.implementationRepository,
    workstream.relativePath,
    options.userOverride,
  ).catch((error) => {
    throw toHandoffError(error)
  })

  const db = await openSaneDb(pointer.implementationRepository)
  try {
    initSchema(db)

    let fromSession = options.fromSessionOverride?.trim() || null
    if (!fromSession) {
      const fromRow = getSelection(db, identity, options.fromSlot)
      if (!fromRow) {
        throw new SaneHandoffError(
          `No registered session for slot ${JSON.stringify(options.fromSlot)} (repo ${JSON.stringify(identity.repoRoot)} user ${JSON.stringify(identity.user)} workstream ${JSON.stringify(identity.workstreamId)}). Register the source slot first.`,
        )
      }
      fromSession = fromRow.session_id
    }

    const target = await resolveOrCreateSession(db, identity, {
      serverUrl,
      slot: options.toSlot,
      mutation: { actorRole: options.fromSlot, sessionId: fromSession },
      fetchImpl,
      sessionIndex: options.sessionIndex,
      forceNew: options.forceNew,
      // Pilot: record an OpenCode-native (foreign) worktree for the target
      // slot so CWD auto-detection resolves it. SANE-managed worktrees are
      // quarantined; SANE never creates the directory itself.
      worktreePath: options.worktreePath ?? null,
      branch: options.branch ?? null,
    })

    const message = composeHandoff({
      fromSlot: options.fromSlot,
      fromSession,
      workstreamId: identity.workstreamId,
      message: options.nextAction,
    })

    await sendHandoff({
      serverUrl,
      targetSessionId: target.sessionId,
      message,
      mode,
      steerReason: options.steerReason,
      fetchImpl,
    })

    const renamed = await renameReady({
      serverUrl,
      targetSessionId: target.sessionId,
      slot: options.toSlot,
      nextAction: options.nextAction,
      fetchImpl,
    })

    const result: SaneHandoffCommandResult = {
      repoRoot: identity.repoRoot,
      user: identity.user,
      workstreamId: identity.workstreamId,
      fromSlot: options.fromSlot,
      fromSession,
      toSlot: options.toSlot,
      toSession: target.sessionId,
      targetCreated: target.created,
      targetIndex: target.targetIndex,
      mode,
      message,
      readyTitle: renamed.title,
    }

    if (options.json === true) {
      write(
        JSON.stringify(
          {
            repo_root: result.repoRoot,
            user: result.user,
            workstream_id: result.workstreamId,
            from: { slot: result.fromSlot, session_id: result.fromSession },
            to: {
              slot: result.toSlot,
              session_id: result.toSession,
              created: result.targetCreated,
              session_index: result.targetIndex,
            },
            mode: result.mode,
            steer_reason: options.steerReason ?? null,
            message: result.message,
            ready_title: result.readyTitle,
          },
          null,
          2,
        ),
      )
    } else {
      const verb = mode === "steer" ? "steered" : "queued"
      write(`Handoff ${verb}: ${result.fromSlot} (${result.fromSession}) -> ${result.toSlot} (${result.toSession})`)
      write(result.message)
      write(`Renamed: ${result.readyTitle}`)
    }
    return result
  } catch (error) {
    if (error instanceof SaneHandoffError) throw error
    if (error instanceof SaneWorkstreamStateError) throw new SaneHandoffError(error.message)
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
    await runSaneHandoffCommand({ ...parsed, ...address })
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
