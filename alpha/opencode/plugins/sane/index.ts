/**
 * SANE OpenCode plugin: `sane_link` tool (session self-registration).
 *
 * Lets an agent link its own session to a workstream phase slot without
 * passing `--session`: the session id comes from the tool execution context
 * (`toolCtx.sessionID`), and the repo/workstream resolves from the session
 * binding first, then working directory like a bare `sane link` invocation.
 * Explicit `workstream` creates a durable session binding. Child sessions
 * inherit their nearest bound ancestor without registering a phase slot.
 *
 * V2 API (`@opencode/plugin`, see https://opencode.ai/v2/docs/build/plugins/):
 * the module default-exports `Plugin.define({ id: "sane", setup })`, and the
 * tool registers via `ctx.tool.transform((editor) => editor.add({ ... }))`.
 * Effective tool id: `sane_link` — with no `options.namespace`, the `name`
 * IS the effective id (a namespaced tool would compose as
 * `<namespace>_<name>`), so skills keep referencing `sane_link`.
 *
 * Working directory: the V2 tool context carries only
 * `{ sessionID, agent, messageID, id, progress }` (no `directory`), so the
 * executor resolves the session's directory via `ctx.session.get`
 * (`session.location.directory`). Lookup failures must never route through
 * the server's working directory.
 *
 * Runtime layout note: this source imports the SANE DB logic via
 * `../../../packages/sane-cli/src/*.ts` (works in-repo under bun). The
 * `sane install context-packages` installer copies this file to
 * `<home>/.config/opencode/plugins/sane/index.ts` with that prefix
 * rewritten to `./sane-src/`, and vendors the imported closure
 * (`sane-link-tool.ts`, `sane-db.ts`, `sane-repository.ts`,
 * `sane-cwd-target.ts`, `create-sane-workstream.ts`, `workstream-type.ts`)
 * next to it — so the installed copy stays self-contained. The only npm
 * dependency is `@opencode/plugin`, resolved at runtime from
 * `<home>/.config/opencode/package.json` (which OpenCode installs/uses for
 * local-plugin dependencies).
 */

import { Plugin } from "@opencode/plugin"
import { existsSync } from "node:fs"
import { join } from "node:path"

import {
  initSchema,
  openSaneDb,
  resolveSaneIdentity,
  bindSessionWorkstream,
  currentUser,
  getSessionWorkstream,
} from "../../../packages/sane-cli/src/sane-db.ts"
import {
  resolveBootstrappedWorkstream,
  resolveSaneRepository,
} from "../../../packages/sane-cli/src/sane-repository.ts"
import { resolveCommandAddress } from "../../../packages/sane-cli/src/sane-cwd-target.ts"
import { bindAndLinkSession } from "../../../packages/sane-cli/src/sane-link-tool.ts"
import { runHandoffAsSession } from "../../../packages/sane-cli/src/sane-handoff-tool.ts"
import { resolveImplementationRoot, resolveSaneMainRepository } from "../../../packages/sane-cli/src/sane-implementation.ts"

/** Effective tool id referenced by the SANE skills. No namespace option. */
export const SANE_LINK_TOOL_NAME = "sane_link" as const

export const SANE_LINK_TOOL_DESCRIPTION =
  "Link the calling session to a SANE workstream phase slot (self-registration). " +
  "Pass workstream to bind explicitly; otherwise use the session binding or working directory. " +
  "1:1 slots (design, planning, execution) refuse a second session unless force is true; " +
  "engineering, research, and research:<topic> slots append."

export interface SaneLinkToolInput {
  slot: string
  workstream?: string
  implementation_worktree?: string
  reassign?: boolean
  worktree_path?: string | null
  branch?: string | null
  force?: boolean
}

/**
 * Plain JSON Schema input (no session param — the session always comes from
 * the tool context). `worktree_path`/`branch` are nullable optionals;
 * `force` is an optional boolean.
 */
export const saneLinkInputSchema = {
  type: "object",
  properties: {
    slot: {
      type: "string",
      description:
        "Phase slot to link: design, planning, execution, engineering, research, or research:<topic>.",
    },
    workstream: {
      type: "string",
      minLength: 1,
      description: "Explicit workstream name or relative path to persistently bind this session to.",
    },
    implementation_worktree: {
      type: "string",
      minLength: 1,
      description: "Persist the canonical implementation checkout for this workstream after validating Git ownership.",
    },
    reassign: {
      type: "boolean",
      description: "Explicitly replace this session's workstream binding or the workstream's implementation checkout binding.",
    },
    worktree_path: {
      type: ["string", "null"],
      description: "Worktree directory recording where this session works.",
    },
    branch: {
      type: ["string", "null"],
      description: "Branch recording where this session works.",
    },
    force: {
      type: "boolean",
      description:
        "Replace the existing session for 1:1 slots (design, planning, execution).",
    },
  },
  required: ["slot"],
  additionalProperties: false,
} as const

/** Effective tool id referenced by the SANE skills. No namespace option. */
export const SANE_HANDOFF_TOOL_NAME = "sane_handoff" as const

export const SANE_HANDOFF_TOOL_DESCRIPTION =
  "Send a SANE phase handoff to another workstream slot (queue delivery). " +
  "The source slot is reverse-looked-up from the calling session; the workstream " +
  "is resolved from the persistent session binding, then its working directory. " +
  "The message is compact refs (From/To/Approvals/Revisions/Paths/Next action)."

export interface SaneHandoffToolInput {
  to: string
  message: string
  session_index?: number
  to_session?: string
  new_session?: boolean
  from?: string
}

/**
 * Plain JSON Schema input (no session param — the session always comes from
 * the tool context). `session_index` is a 1-based index into the target
 * slot's linked sessions; `from` disambiguates when the caller holds several
 * slots.
 */
export const saneHandoffInputSchema = {
  type: "object",
  properties: {
    to: {
      type: "string",
      description:
        "Target phase slot: design, planning, execution, engineering, research, or research:<topic>.",
    },
    message: {
      type: "string",
      description: "Concise next action for the target session (single line). Reference documents rather than repeating their contents; retain essential decisions and constraints. The full message is delivered; only the session title is truncated to 200 characters.",
    },
    session_index: {
      type: "number",
      description:
        "1-based index into the target slot's linked sessions (defaults to latest).",
    },
    to_session: {
      type: "string",
      description:
        "Exact session id to reply to (must be linked to the target slot; from the sender's From: line). Prefer over session_index for replies.",
    },
    new_session: {
      type: "boolean",
      description:
        "Create a fresh target session even when linked ones exist (prefer for new research problems; default reuses latest).",
    },
    from: {
      type: "string",
      description:
        "Source slot when the calling session is linked to several slots.",
    },
  },
  required: ["to", "message"],
  additionalProperties: false,
} as const

export async function resolveToolWorkstream(sessionID: string, ctx: {
  session: { get: (args: { sessionID: string }) => Promise<unknown> }
}): Promise<{ cwd: string }> {
  const session = (await ctx.session.get({ sessionID })) as {
    location?: { directory?: string }
  }
  const cwd = session?.location?.directory
  if (typeof cwd !== "string" || cwd.trim() === "") {
    throw new Error(`Cannot resolve SANE target: session ${sessionID} has no working directory.`)
  }
  return { cwd }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Per-command shell environment, including pipelines and compound commands. */
export function injectShellSession(event: { tool: string; sessionID: string; input: unknown }): void {
  if (event.tool !== "shell" || !event.input || typeof event.input !== "object") return
  const input = event.input as Record<string, unknown>
  if (typeof input.command !== "string") return
  event.input = { ...input, command: `export OPENCODE_SESSION_ID=${shellQuote(event.sessionID)} SANE_SESSION_ID=${shellQuote(event.sessionID)}\n${input.command}` }
}

/** Read only durable bindings, never inherit a mutable current-workstream pointer. */
export async function resolveSessionContext(sessionID: string, ctx: {
  session: { get: (args: { sessionID: string }) => Promise<unknown> }
}): Promise<string | null> {
  const { cwd } = await resolveToolWorkstream(sessionID, ctx)
  // Plugins also load outside Git/SANE repositories.
  let repoRoot: string
  try {
    repoRoot = await resolveSaneMainRepository(cwd)
  } catch {
    return null
  }
  if (!existsSync(join(repoRoot, ".sane", "sane.db"))) return null
  const pointer = await resolveSaneRepository(repoRoot)
  const db = await openSaneDb(repoRoot)
  try {
    initSchema(db)
    const user = currentUser()
    let cursor: string | undefined = sessionID
    const visited = new Set<string>()
    while (cursor) {
      if (visited.has(cursor)) throw new Error("Cannot inherit SANE context: cyclic session ancestry.")
      visited.add(cursor)
      const workstreamId = getSessionWorkstream(db, { repoRoot, user, sessionId: cursor })
      if (workstreamId) {
        const workstream = await resolveBootstrappedWorkstream(pointer.workstreamsRoot, workstreamId)
        const identity = await resolveSaneIdentity(repoRoot, workstream.relativePath, user)
        const implementationRoot = await resolveImplementationRoot(db, identity)
        if (cursor !== sessionID) {
          db.transaction(() => {
            bindSessionWorkstream(db, identity, sessionID, { actorRole: "worker", sessionId: sessionID })
          })()
        }
        return [
          "SANE session context (persistent workstream binding):",
          `Workstream: ${workstream.relativePath}`,
          `Management repository: ${repoRoot}`,
          `Artifacts root: ${join(pointer.workstreamsRoot, workstream.relativePath)}`,
          `Implementation root: ${implementationRoot}`,
          "Run implementation commands in the implementation root; keep workstream documents at the artifacts root.",
          "Shell calls carry this session's OPENCODE_SESSION_ID automatically; bare SANE commands use its durable binding.",
        ].join("\n")
      }
      const session = await ctx.session.get({ sessionID: cursor }) as { parentID?: string }
      cursor = session.parentID
    }
    return null
  } finally {
    db.close()
  }
}

export const SanePlugin = Plugin.define({
  id: "sane",
  async setup(ctx) {
    await ctx.tool.hook?.("execute.before", injectShellSession)
    await ctx.session.hook?.("context", async (event) => {
      try {
        const context = await resolveSessionContext(event.sessionID, ctx)
        if (context) event.system.push({ type: "text", text: context })
      } catch (error) {
        event.system.push({ type: "text", text: `SANE context resolution failed: ${(error as Error).message}. Resolve the binding before running SANE commands.` })
      }
    })
    await ctx.tool.transform((editor) => {
      editor.add({
        name: SANE_LINK_TOOL_NAME,
        description: SANE_LINK_TOOL_DESCRIPTION,
        input: saneLinkInputSchema,
        execute: async (input, toolCtx) => {
          // The session always comes from the tool context, never from input:
          // there is no session param in the schema above.
          const sessionId = toolCtx.sessionID
          const typedInput = input as SaneLinkToolInput
          if (typedInput.workstream === undefined && !typedInput.reassign) await resolveSessionContext(sessionId, ctx)
          const { cwd } = await resolveToolWorkstream(sessionId, ctx)
          const address = await resolveCommandAddress(
            { implementationRepository: "", workstreamPath: "" },
            { cwd, sessionId, workstream: typedInput.workstream },
          )
          const pointer = await resolveSaneRepository(address.implementationRepository)
          const workstream = await resolveBootstrappedWorkstream(
            pointer.workstreamsRoot,
            address.workstreamPath,
          )
          const identity = await resolveSaneIdentity(
            pointer.implementationRepository,
            workstream.relativePath,
            address.userOverride,
          )

          const db = await openSaneDb(pointer.implementationRepository)
          try {
            initSchema(db)
            const result = await bindAndLinkSession(db, identity, {
              slot: typedInput.slot,
              sessionId,
              worktreePath: typedInput.worktree_path ?? null,
              branch: typedInput.branch ?? null,
              force: typedInput.force ?? false,
              reassign: typedInput.reassign ?? false,
              implementationWorktree: typedInput.implementation_worktree,
            })
            return {
              content: JSON.stringify({
                slot: result.slot,
                session_id: result.sessionId,
                index: result.index,
                count: result.count,
                workstream: workstream.relativePath,
                implementation_root: result.implementationRoot,
              }),
            }
          } finally {
            try {
              db.close()
            } catch {
              // Best effort.
            }
          }
        },
      })
      editor.add({
        name: SANE_HANDOFF_TOOL_NAME,
        description: SANE_HANDOFF_TOOL_DESCRIPTION,
        input: saneHandoffInputSchema,
        execute: async (input, toolCtx) => {
          // The session always comes from the tool context, never from input:
          // there is no session param in the schema above.
          const sessionId = toolCtx.sessionID
          const typedInput = input as SaneHandoffToolInput
          await resolveSessionContext(sessionId, ctx)
          const { cwd } = await resolveToolWorkstream(sessionId, ctx)
          const address = await resolveCommandAddress(
            { implementationRepository: "", workstreamPath: "" },
            { cwd, sessionId },
          )
          const pointer = await resolveSaneRepository(address.implementationRepository)
          const workstream = await resolveBootstrappedWorkstream(
            pointer.workstreamsRoot,
            address.workstreamPath,
          )
          const identity = await resolveSaneIdentity(
            pointer.implementationRepository,
            workstream.relativePath,
            address.userOverride,
          )

          const db = await openSaneDb(pointer.implementationRepository)
          try {
            initSchema(db)
            const result = await runHandoffAsSession(
              db,
              identity,
              {
                fromSession: sessionId,
                to: typedInput.to,
                message: typedInput.message,
                ...(typedInput.session_index !== undefined
                  ? { session_index: typedInput.session_index }
                  : {}),
                ...(typedInput.to_session !== undefined
                  ? { to_session: typedInput.to_session }
                  : {}),
                ...(typedInput.new_session !== undefined
                  ? { new_session: typedInput.new_session }
                  : {}),
                ...(typedInput.from !== undefined ? { from: typedInput.from } : {}),
              },
            )
            return {
              content: JSON.stringify({
                from: result.from,
                to: {
                  slot: result.to.slot,
                  session_id: result.to.session_id,
                  session_index: result.to.session_index,
                  created: result.to.created,
                },
                mode: result.mode,
                ready_title: result.ready_title,
              }),
            }
          } finally {
            try {
              db.close()
            } catch {
              // Best effort.
            }
          }
        },
      })
    })
  },
})

export default SanePlugin
