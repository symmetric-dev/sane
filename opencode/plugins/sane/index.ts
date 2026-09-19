/**
 * SANE OpenCode plugin: `sane_link` tool (session self-registration).
 *
 * Lets an agent link its own session to a workstream phase slot without
 * passing `--session`: the session id comes from the tool execution context
 * (`toolCtx.sessionID`), and the repo/workstream resolves from the session
 * working directory exactly like a bare `sane link` invocation
 * (`resolveCommandAddress` with no positionals).
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
 * (`session.location.directory`), falling back to `process.cwd()`.
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

import {
  initSchema,
  openSaneDb,
  resolveSaneIdentity,
} from "../../../packages/sane-cli/src/sane-db.ts"
import {
  resolveBootstrappedWorkstream,
  resolveSaneRepository,
} from "../../../packages/sane-cli/src/sane-repository.ts"
import { resolveCommandAddress } from "../../../packages/sane-cli/src/sane-cwd-target.ts"
import { linkSessionSelection } from "../../../packages/sane-cli/src/sane-link-tool.ts"

/** Effective tool id referenced by the SANE skills. No namespace option. */
export const SANE_LINK_TOOL_NAME = "sane_link" as const

export const SANE_LINK_TOOL_DESCRIPTION =
  "Link the calling session to a SANE workstream phase slot (self-registration). " +
  "The workstream is resolved from the session working directory. " +
  "1:1 slots (design, planning, execution) refuse a second session unless force is true; " +
  "engineering and research:<topic> slots append."

export interface SaneLinkToolInput {
  slot: string
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
        "Phase slot to link: design, planning, execution, engineering, or research:<topic>.",
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

export const SanePlugin = Plugin.define({
  id: "sane",
  async setup(ctx) {
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
          // V2 tool contexts carry no working directory; resolve the session's
          // project directory, then follow the CLI bare-CWD path
          // (no positionals -> auto-detect).
          let cwd = process.cwd()
          try {
            const session = (await ctx.session.get({ sessionID: sessionId })) as unknown as {
              location?: { directory?: string }
            }
            if (typeof session?.location?.directory === "string" && session.location.directory !== "") {
              cwd = session.location.directory
            }
          } catch {
            // Fall through to process.cwd().
          }
          const address = await resolveCommandAddress(
            { implementationRepository: "", workstreamPath: "" },
            { cwd },
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
            const result = linkSessionSelection(db, identity, {
              slot: typedInput.slot,
              sessionId,
              worktreePath: typedInput.worktree_path ?? null,
              branch: typedInput.branch ?? null,
              force: typedInput.force ?? false,
            })
            return {
              content: JSON.stringify({
                slot: result.slot,
                session_id: result.sessionId,
                index: result.index,
                count: result.count,
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
