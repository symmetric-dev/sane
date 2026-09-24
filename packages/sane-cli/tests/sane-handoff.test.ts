/**
 * SANE 0.2.0 M4: session registry + handoff tests.
 *
 * - compose shape is Workstream/Handoff From/Message (no artifact contents)
 *   (no artifact contents)
 * - queue default, steer rejected without a valid reason
 * - resolve uses the registry without creating when the slot has a session,
 *   creates only when empty
 * - rename prefix correct (mock fetch)
 * - CLI parses --from/--to/--next with --json/--repo-root idioms
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Database } from "bun:sqlite"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { initializeSaneRepository } from "../src/init-sane-repository.ts"
import { createSaneRepositoryWorkstream } from "../src/create-sane-repository-workstream.ts"
import {
  assistantAgentForSlot,
  composeHandoff,
  DEFAULT_HANDOFF_SERVER_URL,
  parseCliArguments,
  readyTitle,
  renameReady,
  resolveOrCreateSession,
  runCli,
  runSaneHandoffCommand,
  sendHandoff,
  serverAuthHeaders,
  USAGE,
  type HandoffFetch,
  type HandoffFetchResponse,
} from "../src/sane-handoff-command.ts"
import {
  getSelection,
  initSchema,
  openInMemoryDb,
  openSaneDb,
  resolveSaneIdentity,
  upsertSelection,
  type MutationContext,
  type SaneIdentity,
} from "../src/sane-db.ts"

const execFileAsync = promisify(execFile)

function mutation(
  role = "design",
  session = "ses_from",
  timestamp = "2026-09-16T00:00:00.000Z",
): MutationContext {
  return { actorRole: role, sessionId: session, timestamp }
}

function okJson(payload: unknown): HandoffFetchResponse {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }
}

function failingFetch(): HandoffFetch {
  return (async () => {
    throw new Error("fetch should not have been called")
  }) as unknown as HandoffFetch
}

describe("sane-handoff (M4 session registry + handoff)", () => {
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

  test("compose shape is Workstream/Handoff From/Message and no artifact contents", () => {
    const secretContents = "SUPER SECRET ARTIFACT BODY THAT MUST NEVER APPEAR"
    const message = composeHandoff({
      fromSlot: "design",
      fromSession: "ses_design_1",
      workstreamId: "01-demo",
      message: "Pick up design/SDD.md and draft solutions.",
    })
    // Exact three-line Sec 3 shape.
    const lines = message.split("\n")
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe("Workstream: 01-demo")
    expect(lines[1]).toBe("Handoff From: Design Session (ses_design_1)")
    expect(lines[2]).toBe("Message: Pick up design/SDD.md and draft solutions.")
    expect(message).not.toContain(secretContents)
  })

  test("compose rejects empty fields, multiline message, and bad slots", () => {
    expect(() =>
      composeHandoff({ fromSlot: "design", fromSession: "ses_a", workstreamId: "w", message: "  " }),
    ).toThrow(/non-empty/)
    expect(() =>
      composeHandoff({ fromSlot: "design", fromSession: "ses_a", workstreamId: "w", message: "one\ntwo" }),
    ).toThrow(/single line/)
    expect(() =>
      composeHandoff({ fromSlot: "bogus", fromSession: "ses_a", workstreamId: "w", message: "Go." }),
    ).toThrow(/Invalid selection slot/)
  })

  test("sendHandoff defaults to queue; steer requires a valid reason", async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const capture: HandoffFetch = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String((init as { body?: string })?.body ?? "{}"))
      calls.push({ url, body })
      return okJson({ data: { admitted: true } })
    }) as unknown as HandoffFetch

    const queued = await sendHandoff({
      serverUrl: "http://127.0.0.1:4096",
      targetSessionId: "ses_target",
      message: "Workstream: w\nHandoff From: Design Session (a)\nMessage: Go.",
      fetchImpl: capture,
    })
    expect(queued.mode).toBe("queue")
    expect(queued.url).toBe("http://127.0.0.1:4096/api/session/ses_target/prompt")
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain("/api/session/ses_target/prompt")
    expect(calls[0]!.body).toMatchObject({ delivery: "queue" })

    // Steer without a reason is rejected before any fetch.
    await expect(
      sendHandoff({
        serverUrl: "http://127.0.0.1:4096",
        targetSessionId: "ses_target",
        message: "hello",
        mode: "steer",
        fetchImpl: failingFetch(),
      }),
    ).rejects.toThrow(/steerReason/)

    // Steer with an invalid reason is rejected.
    await expect(
      sendHandoff({
        serverUrl: "http://127.0.0.1:4096",
        targetSessionId: "ses_target",
        message: "hello",
        mode: "steer",
        steerReason: "routine",
        fetchImpl: failingFetch(),
      }),
    ).rejects.toThrow(/steer reason/i)

    // Queue plus a steer reason is a caller error.
    await expect(
      sendHandoff({
        serverUrl: "http://127.0.0.1:4096",
        targetSessionId: "ses_target",
        message: "hello",
        mode: "queue",
        steerReason: "user-redirect",
        fetchImpl: failingFetch(),
      }),
    ).rejects.toThrow(/steerReason/)

    // Valid steer sends with delivery steer.
    const steerCalls: Array<{ url: string; body: unknown }> = []
    const steerCapture: HandoffFetch = (async (url: string, init?: RequestInit) => {
      steerCalls.push({ url, body: JSON.parse(String((init as { body?: string })?.body ?? "{}")) })
      return okJson({})
    }) as unknown as HandoffFetch
    for (const reason of ["user-redirect", "execution-abort"] as const) {
      const result = await sendHandoff({
        serverUrl: "http://127.0.0.1:4096/",
        targetSessionId: "ses_target",
        message: "steer me",
        mode: "steer",
        steerReason: reason,
        fetchImpl: steerCapture,
      })
      expect(result.mode).toBe("steer")
    }
    expect(steerCalls).toHaveLength(2)
    expect(steerCalls[0]!.body).toMatchObject({ delivery: "steer" })
  })

  test("resolve uses registry without creating when slot has session", async () => {
    upsertSelection(db!, identity, { slot: "engineering", sessionId: "ses_eng_stable" }, mutation())
    const result = await resolveOrCreateSession(db!, identity, {
      serverUrl: "http://127.0.0.1:4096",
      slot: "engineering",
      mutation: mutation("design", "ses_design"),
      fetchImpl: failingFetch(),
    })
    expect(result.sessionId).toBe("ses_eng_stable")
    expect(result.created).toBe(false)
    expect(result.row.session_id).toBe("ses_eng_stable")
    // Stable ID survives the lookup.
    expect(getSelection(db!, identity, "engineering")?.session_id).toBe("ses_eng_stable")
  })

  test("resolve creates only when empty and updates the registry", async () => {
    expect(getSelection(db!, identity, "planning")).toBeNull()
    const calls: string[] = []
    const createFetch: HandoffFetch = (async (url: string) => {
      if (url.includes("/api/agent?")) return okJson({ data: [{ id: "sane/assistant/planning" }] })
      calls.push(url)
      return okJson({ id: "ses_plan_new" })
    }) as unknown as HandoffFetch

    const created = await resolveOrCreateSession(db!, identity, {
      serverUrl: "http://127.0.0.1:4096",
      slot: "planning",
      mutation: mutation("design", "ses_design"),
      fetchImpl: createFetch,
    })
    expect(created.created).toBe(true)
    expect(created.sessionId).toBe("ses_plan_new")
    expect(calls).toHaveLength(1)
    expect(calls[0]).toBe("http://127.0.0.1:4096/api/session")
    expect(getSelection(db!, identity, "planning")?.session_id).toBe("ses_plan_new")

    // Second lookup reuses the stable ID without another create.
    const reused = await resolveOrCreateSession(db!, identity, {
      serverUrl: "http://127.0.0.1:4096",
      slot: "planning",
      mutation: mutation("design", "ses_design"),
      fetchImpl: failingFetch(),
    })
    expect(reused.created).toBe(false)
    expect(reused.sessionId).toBe("ses_plan_new")
    expect(calls).toHaveLength(1)
  })

  test("new sessions use the destination agent model and variant, or omit an unconfigured model", async () => {
    for (const model of [
      { id: "gpt-6-astra", providerID: "openai", variant: "low" },
      { id: "another-model", providerID: "another-provider" },
      undefined,
    ]) {
      const calls: string[] = []
      const fetchImpl: HandoffFetch = async (url, init) => {
        calls.push(url)
        if (url.includes("/api/agent?")) {
          expect(init?.method).toBe("GET")
          expect(new URL(url).searchParams.get("location[directory]")).toBe(identity.repoRoot)
          expect(new URL(url).pathname).toBe("/api/agent")
          return okJson({ data: [{ id: "sane/assistant/design", model: { id: "other", providerID: "other" } }, { id: "sane/assistant/engineering", ...(model ? { model } : {}) }] })
        }
        const body = JSON.parse(String(init?.body))
        expect(body.agent).toBe("sane/assistant/engineering")
        expect(body.model).toEqual(model)
        expect(Object.hasOwn(body, "model")).toBe(model !== undefined)
        return okJson({ id: "ses_model_test" })
      }
      await resolveOrCreateSession(db!, identity, {
        serverUrl: "http://127.0.0.1:4096", slot: "engineering", forceNew: true,
        mutation: mutation(), fetchImpl,
      })
      expect(calls).toHaveLength(2)
    }
  })

  test("agent lookup failures stop creation without registering a session", async () => {
    for (const payload of [{}, { data: [{ id: "wrong-agent" }] }, {
      data: [{ id: "sane/assistant/engineering", model: { id: "missing-provider" } }],
    }]) {
      let calls = 0
      await expect(resolveOrCreateSession(db!, identity, {
        serverUrl: "http://127.0.0.1:4096", slot: "engineering", mutation: mutation(),
        fetchImpl: async () => { calls++; return okJson(payload) },
      })).rejects.toThrow("Could not resolve handoff agent")
      expect(calls).toBe(1)
      expect(getSelection(db!, identity, "engineering")).toBeNull()
    }
  })

  test("resolve records a foreign (OpenCode-native) worktree path and branch", async () => {
    const createFetch: HandoffFetch = (async (url: string) =>
      url.includes("/api/agent?") ? okJson({ data: [{ id: "sane/assistant/execution" }] }) : okJson({ id: "ses_exec_new" })) as unknown as HandoffFetch
    const created = await resolveOrCreateSession(db!, identity, {
      serverUrl: "http://127.0.0.1:4096",
      slot: "execution",
      mutation: mutation("planning", "ses_plan"),
      fetchImpl: createFetch,
      worktreePath: "/wt/opencode-managed/01-demo",
      branch: "opencode/some-branch",
    })
    expect(created.created).toBe(true)
    const row = getSelection(db!, identity, "execution")
    expect(row?.worktree_path).toBe("/wt/opencode-managed/01-demo")
    expect(row?.branch).toBe("opencode/some-branch")
  })

  test("CLI parses --worktree-path and --branch", () => {
    const parsed = parseCliArguments([
      "/repo",
      "01-demo",
      "--from",
      "planning",
      "--to",
      "execution",
      "--next",
      "Run it.",
      "--worktree-path",
      "/wt/opencode-managed/01-demo",
      "--branch",
      "opencode/some-branch",
    ])
    expect(parsed.worktreePath).toBe("/wt/opencode-managed/01-demo")
    expect(parsed.branch).toBe("opencode/some-branch")
    expect(USAGE).toContain("--worktree-path")
  })

  test("resolve handles alternate create-response shapes", async () => {
    for (const [slot, payload, expected] of [
      ["design", { sessionId: "ses_a" }, "ses_a"],
      ["engineering", { sessionID: "ses_b" }, "ses_b"],
      ["planning", { data: { id: "ses_c" } }, "ses_c"],
    ] as const) {
      const fetchImpl: HandoffFetch = (async (url: string) => url.includes("/api/agent?")
        ? okJson({ data: [{ id: `sane/assistant/${slot}` }] }) : okJson(payload)) as unknown as HandoffFetch
      const result = await resolveOrCreateSession(db!, identity, {
        serverUrl: "http://127.0.0.1:4096",
        slot,
        mutation: mutation(),
        fetchImpl,
      })
      expect(result.sessionId).toBe(expected)
      expect(result.created).toBe(true)
    }
  })

  test("rename uses workstream, role and session index via PATCH /api/session/{id} (mock fetch)", async () => {
    expect(readyTitle("01-demo", "engineering", 2)).toBe("[01-demo] Engineering #2")
    expect(readyTitle("01-demo", "research:topic", 3)).toBe("[01-demo] Research #3")
    const longTitle = readyTitle("a".repeat(250), "execution", 12)
    expect(longTitle.length).toBe(200)
    expect(longTitle).toEndWith("…] Execution #12")
    const calls: Array<{ url: string; method: string; body: unknown }> = []
    const capture: HandoffFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: String((init as { method?: string })?.method ?? ""), body: JSON.parse(String((init as { body?: string })?.body ?? "{}")) })
      return okJson({})
    }) as unknown as HandoffFetch
    const result = await renameReady({
      serverUrl: "http://127.0.0.1:4096",
      targetSessionId: "ses_eng_1",
      slot: "engineering",
      workstreamId: "01-demo",
      sessionIndex: 2,
      fetchImpl: capture,
    })
    expect(result.title).toBe("[01-demo] Engineering #2")
    expect(result.url).toBe("http://127.0.0.1:4096/api/session/ses_eng_1")
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe("PATCH")
    expect(calls[0]!.body).toMatchObject({ title: "[01-demo] Engineering #2" })
  })

  test("assistantAgentForSlot maps every slot to its assistant", () => {
    expect(assistantAgentForSlot("design")).toBe("sane/assistant/design")
    expect(assistantAgentForSlot("engineering")).toBe("sane/assistant/engineering")
    expect(assistantAgentForSlot("planning")).toBe("sane/assistant/planning")
    expect(assistantAgentForSlot("execution")).toBe("sane/assistant/execution")
    expect(assistantAgentForSlot("research")).toBe("sane/assistant/research")
    expect(assistantAgentForSlot("research:deep-dive")).toBe("sane/assistant/research")
    expect(() => assistantAgentForSlot("bogus")).toThrow(/No assistant agent/)
  })

  test("serverAuthHeaders sends Basic auth only when a password is set", () => {
    expect(serverAuthHeaders({} as NodeJS.ProcessEnv)).toEqual({})
    expect(serverAuthHeaders({ OPENCODE_SERVER_PASSWORD: "pw" } as NodeJS.ProcessEnv)).toEqual({
      Authorization: `Basic ${Buffer.from("opencode:pw", "utf8").toString("base64")}`,
    })
    expect(
      serverAuthHeaders({
        OPENCODE_SERVER_PASSWORD: "pw",
        OPENCODE_SERVER_USERNAME: "custom",
      } as NodeJS.ProcessEnv),
    ).toEqual({
      Authorization: `Basic ${Buffer.from("custom:pw", "utf8").toString("base64")}`,
    })
  })

  test("handoff CLI parses --from/--to/--next with --json/--repo-root idioms", () => {
    expect(USAGE).toContain("sane handoff")
    expect(USAGE).toContain("--from")
    expect(USAGE).toContain("--to")
    expect(USAGE).toContain("--next")
    expect(USAGE).toContain("--steer-reason")
    expect(USAGE).toContain("--json")
    expect(USAGE).toContain("--repo-root")
    expect(DEFAULT_HANDOFF_SERVER_URL.trim()).not.toBe("")

    const parsed = parseCliArguments([
      "/repo",
      "01-demo",
      "--from",
      "design",
      "--to",
      "engineering",
      "--next",
      "Draft solutions.",
      "--json",
    ])
    expect(parsed).toMatchObject({
      implementationRepository: "/repo",
      workstreamPath: "01-demo",
      fromSlot: "design",
      toSlot: "engineering",
      nextAction: "Draft solutions.",
      json: true,
    })

    const viaRoot = parseCliArguments([
      "--repo-root",
      "/repo",
      "01-demo",
      "--from",
      "design",
      "--to",
      "research:auth",
      "--next",
      "Gather evidence.",
    ])
    expect(viaRoot.implementationRepository).toBe("/repo")
    expect(viaRoot.toSlot).toBe("research:auth")

    const steered = parseCliArguments([
      "/repo",
      "01-demo",
      "--from",
      "execution",
      "--to",
      "planning",
      "--next",
      "Replan.",
      "--steer-reason",
      "user-redirect",
    ])
    expect(steered.steerReason).toBe("user-redirect")

    expect(() =>
      parseCliArguments(["/repo", "01-demo", "--from", "design", "--to", "engineering"]),
    ).toThrow(/--next/)
    expect(() =>
      parseCliArguments(["/repo", "01-demo", "--to", "engineering", "--next", "Go."]),
    ).toThrow(/--from/)
    expect(() =>
      parseCliArguments(["/repo", "01-demo", "--from", "design", "--next", "Go."]),
    ).toThrow(/--to/)
    expect(() =>
      parseCliArguments([
        "/repo",
        "01-demo",
        "--from",
        "bogus",
        "--to",
        "engineering",
        "--next",
        "Go.",
      ]),
    ).toThrow(/slot/i)
    expect(() =>
      parseCliArguments([
        "/repo",
        "01-demo",
        "--from",
        "design",
        "--to",
        "engineering",
        "--next",
        "Go.",
        "--steer-reason",
        "routine",
      ]),
    ).toThrow(/steer reason/i)
    expect(() =>
      parseCliArguments([
        "/repo",
        "01-demo",
        "--from",
        "design",
        "--to",
        "engineering",
        "--next",
        "Go.",
        "--bogus",
      ]),
    ).toThrow(/Unknown option: --bogus/)
  })
})

describe("sane-handoff CLI end to end (mock server)", () => {
  let tempDirectory = ""
  let implementationRepository = ""

  beforeEach(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "sane-handoff-m4-"))
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
    // Seed the source slot; target starts empty to exercise create-once.
    const identity = await resolveSaneIdentity(implementationRepository, "01-demo")
    const db = await openSaneDb(identity.repoRoot)
    try {
      initSchema(db)
      upsertSelection(db, identity, { slot: "design", sessionId: "ses_design_1" }, mutation())
    } finally {
      try {
        db.close()
      } catch {
        // Best effort.
      }
    }
  })

  afterEach(async () => {
    await rm(tempDirectory, { recursive: true, force: true })
    tempDirectory = ""
  })

  test("runSaneHandoffCommand resolves, sends queue-default, titles and reuses the target", async () => {
    const promptCalls: Array<{ url: string; body: unknown }> = []
    const renameCalls: Array<{ url: string; body: unknown }> = []
    let creates = 0
    const fetchImpl: HandoffFetch = (async (url: string, init?: RequestInit) => {
      if (url.includes("/api/agent?")) return okJson({ data: [{ id: "sane/assistant/engineering" }] })
      const body = JSON.parse(String((init as { body?: string })?.body ?? "{}")) as Record<
        string,
        unknown
      >
      if (url.endsWith("/api/session")) {
        creates += 1
        return okJson({ id: "ses_eng_1" })
      }
      if (url.includes("/prompt")) {
        promptCalls.push({ url, body })
        return okJson({})
      }
      if (url.includes("/api/session/") && !url.includes("/prompt")) {
        renameCalls.push({ url, body })
        return okJson({})
      }
      throw new Error(`unexpected url ${url}`)
    }) as unknown as HandoffFetch

    const lines: string[] = []
    const first = await runSaneHandoffCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      fromSlot: "design",
      toSlot: "engineering",
      nextAction: "Draft solutions.",
      fetchImpl,
      write: (line) => lines.push(line),
    })
    expect(first.fromSession).toBe("ses_design_1")
    expect(first.toSession).toBe("ses_eng_1")
    expect(first.targetCreated).toBe(true)
    expect(first.mode).toBe("queue")
    expect(first.message).toBe(
      "Workstream: 01-demo\nHandoff From: Design Session (ses_design_1)\nMessage: Draft solutions.",
    )
    expect(first.readyTitle).toBe("[01-demo] Engineering #1")
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("ses_eng_1")
    expect(lines.join("\n")).not.toContain("Draft solutions.")
    expect(creates).toBe(1)
    expect(promptCalls).toHaveLength(1)
    expect(promptCalls[0]!.body).toMatchObject({ delivery: "queue", text: first.message })
    expect(renameCalls).toHaveLength(1)
    expect(renameCalls[0]!.body).toMatchObject({
      title: "[01-demo] Engineering #1",
    })

    // Second handoff reuses the stable target without creating.
    const second = await runSaneHandoffCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      fromSlot: "design",
      toSlot: "engineering",
      nextAction: "Revise solutions.",
      fetchImpl,
      write: () => {},
    })
    expect(second.toSession).toBe("ses_eng_1")
    expect(second.targetCreated).toBe(false)
    expect(second.readyTitle).toBe(first.readyTitle)
    expect(creates).toBe(1)
    expect(promptCalls).toHaveLength(2)
  })

  test("handoff to bare research creates-if-empty (mock server)", async () => {
    let creates = 0
    const fetchImpl: HandoffFetch = (async (url: string) => {
      if (url.includes("/api/agent?")) return okJson({ data: [{ id: "sane/assistant/research" }] })
      if (url.endsWith("/api/session")) {
        creates += 1
        return okJson({ id: "ses_research_new" })
      }
      return okJson({})
    }) as unknown as HandoffFetch
    const result = await runSaneHandoffCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      fromSlot: "design",
      toSlot: "research",
      nextAction: "Gather evidence.",
      fetchImpl,
      write: () => {},
    })
    expect(result.toSession).toBe("ses_research_new")
    expect(result.targetCreated).toBe(true)
    expect(result.targetIndex).toBe(1)
    expect(result.message).toBe(
      "Workstream: 01-demo\nHandoff From: Design Session (ses_design_1)\nMessage: Gather evidence.",
    )
    expect(result.readyTitle).toBe("[01-demo] Research #1")
    expect(creates).toBe(1)
  })

  test("runCli returns 0/1 and --json emits the handoff envelope", async () => {
    const fetchImpl: HandoffFetch = (async (url: string) => {
      if (url.includes("/api/agent?")) return okJson({ data: [{ id: "sane/assistant/planning" }] })
      if (url.endsWith("/api/session")) return okJson({ id: "ses_plan_1" })
      return okJson({})
    }) as unknown as HandoffFetch

    // runCli uses the ambient fetch; stub it for this test.
    const originalFetch = globalThis.fetch
    ;(globalThis as unknown as { fetch: HandoffFetch }).fetch = fetchImpl
    try {
      const lines: string[] = []
      const originalLog = console.log
      console.log = (line?: unknown) => {
        lines.push(String(line))
      }
      try {
        // Direct command with --json exercises the envelope path.
        const { runSaneHandoffCommand: run } = await import("../src/sane-handoff-command.ts")
        await run({
          implementationRepository,
          workstreamPath: "01-demo",
          fromSlot: "design",
          toSlot: "planning",
          nextAction: "Write the plan.",
          json: true,
          fetchImpl,
          write: (line) => lines.push(line),
        })
      } finally {
        console.log = originalLog
      }
      const parsed = JSON.parse(lines.join("\n"))
      expect(parsed).toMatchObject({
        workstream_id: "01-demo",
        mode: "queue",
      })
      expect(String(parsed.message)).toContain("Message:")
      expect(parsed.ready_title).toBe("[01-demo] Planning #1")
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(
      await runCli([implementationRepository, "01-demo", "--from", "design", "--next", "Go."]),
    ).toBe(1)
    expect(
      await runCli([
        implementationRepository,
        "01-demo",
        "--from",
        "design",
        "--to",
        "engineering",
        "--next",
        "Go.",
        "--steer-reason",
        "nope",
      ]),
    ).toBe(1)
  })
})
