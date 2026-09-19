/**
 * SANE `sane_link` tool tests (OpenCode plugin core + executor).
 *
 * - The pure `linkSessionSelection` operation mirrors the `sane link` CLI
 *   policy: 1:1 slots refuse a second session without force (same error
 *   text), force replaces, 1:many slots append, exact duplicates throw.
 * - The plugin executor takes the session from the tool context
 *   (`toolCtx.sessionID`), never from input: an input `session` key is
 *   ignored. Effective tool id is `sane_link`.
 * - Executor end-to-end against a tmp SANE repo via the session-directory
 *   (bare-CWD) resolution path — no server needed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Database } from "bun:sqlite"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { SanePlugin } from "../../../opencode/plugins/sane/index.ts"
import { initializeSaneRepository } from "../src/init-sane-repository.ts"
import { createSaneRepositoryWorkstream } from "../src/create-sane-repository-workstream.ts"
import { selectSaneWorkstream } from "../src/select-sane-workstream.ts"
import {
  initSchema,
  listSelectionsBySlot,
  openInMemoryDb,
  openSaneDb,
  resolveSaneIdentity,
  type SaneIdentity,
} from "../src/sane-db.ts"
import {
  linkSessionSelection,
  SaneLinkToolError,
} from "../src/sane-link-tool.ts"

const execFileAsync = promisify(execFile)

function outputText(result: { content?: string | readonly unknown[] }): string {
  const content = result.content
  expect(typeof content).toBe("string")
  return content as string
}

describe("linkSessionSelection (tool core policy)", () => {
  let db: Database | undefined
  const identity: SaneIdentity = { repoRoot: "/repo", user: "alice", workstreamId: "01-demo" }

  beforeEach(() => {
    db = openInMemoryDb()
    initSchema(db)
  })

  afterEach(() => {
    try {
      db?.close()
    } catch {
      // Best effort.
    }
    db = undefined
  })

  test("links design with worktree/branch recorded, index 1 of 1", () => {
    const result = linkSessionSelection(db!, identity, {
      slot: "design",
      sessionId: "ses_a",
      worktreePath: "/wt/01-demo",
      branch: "sane/alice/01-demo",
    })
    expect(result).toMatchObject({
      slot: "design",
      sessionId: "ses_a",
      index: 1,
      count: 1,
      worktreePath: "/wt/01-demo",
      branch: "sane/alice/01-demo",
    })
  })

  test("second distinct 1:1 session fails with the CLI error text; force replaces", () => {
    linkSessionSelection(db!, identity, { slot: "design", sessionId: "ses_a" })
    expect(() =>
      linkSessionSelection(db!, identity, { slot: "design", sessionId: "ses_b" }),
    ).toThrow(
      'Slot "design" is already linked to ses_a (1 session(s)); rerun with --force to replace.',
    )
    expect(listSelectionsBySlot(db!, identity, "design").map((row) => row.session_id)).toEqual([
      "ses_a",
    ])

    const replaced = linkSessionSelection(db!, identity, {
      slot: "design",
      sessionId: "ses_b",
      force: true,
    })
    expect(replaced).toMatchObject({ sessionId: "ses_b", index: 1, count: 1 })
    expect(listSelectionsBySlot(db!, identity, "design").map((row) => row.session_id)).toEqual([
      "ses_b",
    ])
  })

  test("engineering and research slots append with stable 1-based indexes", () => {
    const first = linkSessionSelection(db!, identity, { slot: "engineering", sessionId: "ses_e1" })
    const second = linkSessionSelection(db!, identity, { slot: "engineering", sessionId: "ses_e2" })
    expect(first).toMatchObject({ index: 1, count: 1 })
    expect(second).toMatchObject({ index: 2, count: 2 })
    const topic = linkSessionSelection(db!, identity, {
      slot: "research:auth",
      sessionId: "ses_r1",
    })
    expect(topic).toMatchObject({ index: 1, count: 1 })
  })

  test("exact (slot, session) duplicates throw; bad slots fail", () => {
    linkSessionSelection(db!, identity, { slot: "planning", sessionId: "ses_p" })
    expect(() =>
      linkSessionSelection(db!, identity, { slot: "planning", sessionId: "ses_p" }),
    ).toThrow(/already linked/)
    expect(() =>
      linkSessionSelection(db!, identity, { slot: "bogus", sessionId: "ses_x" }),
    ).toThrow(/Invalid selection slot/)
    expect(() => linkSessionSelection(db!, identity, { slot: "", sessionId: "ses_x" })).toThrow(
      /Option --slot is required\./,
    )
    expect(() => linkSessionSelection(db!, identity, { slot: "design", sessionId: "" })).toThrow(
      /Option --session is required\./,
    )
  })

  test("tool errors preserve CLI messages via SaneLinkToolError", () => {
    try {
      linkSessionSelection(db!, identity, { slot: "bogus", sessionId: "ses_x" })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(SaneLinkToolError)
      expect((error as Error).message).toContain("Invalid selection slot")
    }
  })
})

describe("sane_link plugin executor (session from tool context)", () => {
  let tempDirectory = ""
  let implementationRepository = ""

  interface CapturedTool {
    name: string
    description: string
    input: unknown
    options?: { namespace?: string }
    execute: (
      input: unknown,
      toolCtx: { sessionID: string },
    ) => Promise<{ content?: string | readonly unknown[] }>
  }

  /** Drive `Plugin.define({ id, setup })` with a fake plugin context. */
  async function loadSaneLinkTool(sessionDirectory: string): Promise<CapturedTool> {
    const added: CapturedTool[] = []
    const pluginCtx = {
      session: {
        get: async () => ({ location: { directory: sessionDirectory } }),
      },
      tool: {
        transform: async (callback: (editor: {
          add: (tool: CapturedTool) => void
        }) => void) => {
          callback({ add: (tool) => { added.push(tool) } })
        },
      },
    }
    await SanePlugin.setup(pluginCtx as never)
    const captured = added.find((tool) => tool.name === "sane_link")
    expect(captured).toBeDefined()
    return captured!
  }

  async function toolExecute(
    input: Record<string, unknown>,
    toolCtx: { sessionID: string; directory: string },
  ): Promise<string> {
    const definition = await loadSaneLinkTool(toolCtx.directory)
    expect(definition.name).toBe("sane_link")
    const result = await definition.execute(input, { sessionID: toolCtx.sessionID })
    return outputText(result)
  }

  beforeEach(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "sane-link-tool-"))
    implementationRepository = join(tempDirectory, "repo")
    await mkdir(implementationRepository, { recursive: true })
    await execFileAsync("git", ["init", "--quiet", implementationRepository])
    await initializeSaneRepository({ implementationRepository, write: () => {} })
    await createSaneRepositoryWorkstream({
      implementationRepository,
      workstreamPath: "01-demo",
      type: "feature",
      write: () => {},
    })
    const identity = await resolveSaneIdentity(implementationRepository, "01-demo")
    await selectSaneWorkstream({
      implementationRepository,
      workstreamPath: "01-demo",
      userOverride: identity.user,
      write: () => {},
    })
  })

  afterEach(async () => {
    await rm(tempDirectory, { recursive: true, force: true })
    tempDirectory = ""
  })

  test("registers under the effective tool id sane_link with no namespace", async () => {
    expect(SanePlugin.id).toBe("sane")
    const definition = await loadSaneLinkTool(implementationRepository)
    expect(definition.name).toBe("sane_link")
    expect(definition.options?.namespace).toBeUndefined()
    const schema = definition.input as {
      required?: readonly string[]
      properties?: Record<string, unknown>
    }
    expect(schema.required).toContain("slot")
    expect(Object.keys(schema.properties ?? {})).toEqual(
      expect.arrayContaining(["slot", "worktree_path", "branch", "force"]),
    )
  })

  test("default export is the loadable plugin definition", async () => {
    const loaded = (await import("../../../opencode/plugins/sane/index.ts")).default
    expect(loaded).toBe(SanePlugin)
    expect(typeof loaded.setup).toBe("function")
  })

  test("links the context session via the session-directory resolution path", async () => {
    const raw = await toolExecute(
      { slot: "design" },
      { sessionID: "ses_tool_1", directory: implementationRepository },
    )
    const parsed = JSON.parse(raw) as {
      slot: string
      session_id: string
      index: number
      count: number
    }
    expect(parsed).toEqual({ slot: "design", session_id: "ses_tool_1", index: 1, count: 1 })

    const identity = await resolveSaneIdentity(implementationRepository, "01-demo")
    const db = await openSaneDb(identity.repoRoot)
    try {
      initSchema(db)
      expect(listSelectionsBySlot(db, identity, "design").map((row) => row.session_id)).toEqual([
        "ses_tool_1",
      ])
    } finally {
      try {
        db.close()
      } catch {
        // Best effort.
      }
    }
  })

  test("an input session key is ignored: the context session wins", async () => {
    const raw = await toolExecute(
      { slot: "planning", session: "ses_evil" },
      { sessionID: "ses_tool_real", directory: implementationRepository },
    )
    const parsed = JSON.parse(raw) as { session_id: string }
    expect(parsed.session_id).toBe("ses_tool_real")
  })

  test("1:1 conflict and force-replace behave like the CLI", async () => {
    await toolExecute(
      { slot: "execution" },
      { sessionID: "ses_tool_1", directory: implementationRepository },
    )
    await expect(
      toolExecute({ slot: "execution" }, { sessionID: "ses_tool_2", directory: implementationRepository }),
    ).rejects.toThrow(
      'Slot "execution" is already linked to ses_tool_1 (1 session(s)); rerun with --force to replace.',
    )
    const raw = await toolExecute(
      { slot: "execution", force: true },
      { sessionID: "ses_tool_2", directory: implementationRepository },
    )
    expect(JSON.parse(raw)).toMatchObject({ session_id: "ses_tool_2", index: 1, count: 1 })
  })

  test("records worktree path and branch; rejects invalid slots", async () => {
    const raw = await toolExecute(
      { slot: "engineering", worktree_path: "/wt/01-demo", branch: "sane/alice/01-demo" },
      { sessionID: "ses_tool_wt", directory: implementationRepository },
    )
    expect(JSON.parse(raw)).toMatchObject({ slot: "engineering", index: 1, count: 1 })
    const identity = await resolveSaneIdentity(implementationRepository, "01-demo")
    const db = await openSaneDb(identity.repoRoot)
    try {
      initSchema(db)
      const rows = listSelectionsBySlot(db, identity, "engineering")
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ worktree_path: "/wt/01-demo", branch: "sane/alice/01-demo" })
    } finally {
      try {
        db.close()
      } catch {
        // Best effort.
      }
    }
    await expect(
      toolExecute({ slot: "bogus" }, { sessionID: "ses_x", directory: implementationRepository }),
    ).rejects.toThrow(/Invalid selection slot/)
  })
})
