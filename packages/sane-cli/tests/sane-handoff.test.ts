/**
 * SANE 0.2.0 M4: session registry + handoff tests.
 *
 * - compose shape contains From/To/Approvals/Revisions/Paths/Next
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
  composeHandoff,
  DEFAULT_HANDOFF_SERVER_URL,
  parseCliArguments,
  readyTitle,
  renameReady,
  resolveOrCreateSession,
  runCli,
  runSaneHandoffCommand,
  sendHandoff,
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

  test("compose shape contains From/To/Approvals/Revisions/Paths/Next and no artifact contents", () => {
    const secretContents = "SUPER SECRET ARTIFACT BODY THAT MUST NEVER APPEAR"
    const message = composeHandoff({
      fromSlot: "design",
      fromSession: "ses_design_1",
      toSlot: "engineering",
      toSessionOrNew: "ses_eng_1",
      user: "alice",
      workstreamId: "01-demo",
      approvals: [{ gate: "root-plus-sdd", approvalRef: "user-ok", saneHash: "abc123" }],
      revisions: "baseline r0, sdd r1, foundation 00-base@commit-a",
      paths: "/repo/.sane/workstreams/01-demo, SDD.md",
      nextAction: "Pick up SDD.md and draft solutions.",
    })
    expect(message).toContain("From: design (ses_design_1) / alice / workstream 01-demo")
    expect(message).toContain("To: engineering (ses_eng_1)")
    expect(message).toContain("Approvals:")
    expect(message).toContain("root-plus-sdd")
    expect(message).toContain("user-ok")
    expect(message).toContain("abc123")
    expect(message).toContain("Revisions:")
    expect(message).toContain("baseline r0")
    expect(message).toContain("Paths:")
    expect(message).toContain("/repo/.sane/workstreams/01-demo")
    expect(message).toContain("Next action: Pick up SDD.md and draft solutions.")
    expect(message).not.toContain(secretContents)
    // Exact six-line Sec 3 shape.
    const lines = message.split("\n")
    expect(lines).toHaveLength(6)
    expect(lines[0]!.startsWith("From: ")).toBe(true)
    expect(lines[1]!.startsWith("To: ")).toBe(true)
    expect(lines[2]!.startsWith("Approvals: ")).toBe(true)
    expect(lines[3]!.startsWith("Revisions: ")).toBe(true)
    expect(lines[4]!.startsWith("Paths: ")).toBe(true)
    expect(lines[5]!.startsWith("Next action: ")).toBe(true)
  })

  test("compose supports To new and empty refs as (none)", () => {
    const message = composeHandoff({
      fromSlot: "planning",
      fromSession: "ses_plan",
      toSlot: "execution",
      toSessionOrNew: "new",
      user: "bob",
      workstreamId: "02-work",
      approvals: [],
      revisions: "",
      paths: [],
      nextAction: "Start execution.",
    })
    expect(message).toContain("To: execution (new)")
    expect(message).toContain("Approvals: (none)")
    expect(message).toContain("Revisions: (none)")
    expect(message).toContain("Paths: (none)")
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
      message: "From: design (a) / alice / workstream w\nTo: engineering (b)\nApprovals: (none)\nRevisions: (none)\nPaths: (none)\nNext action: Go.",
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

  test("resolve handles alternate create-response shapes", async () => {
    for (const [slot, payload, expected] of [
      ["design", { sessionId: "ses_a" }, "ses_a"],
      ["engineering", { sessionID: "ses_b" }, "ses_b"],
      ["planning", { data: { id: "ses_c" } }, "ses_c"],
    ] as const) {
      const fetchImpl: HandoffFetch = (async () => okJson(payload)) as unknown as HandoffFetch
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

  test("rename prefix is [ready] <slot>: <next> via the rename API (mock fetch)", async () => {
    expect(readyTitle("engineering", "Draft solutions.")).toBe("[ready] engineering: Draft solutions.")
    const calls: Array<{ url: string; body: unknown }> = []
    const capture: HandoffFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String((init as { body?: string })?.body ?? "{}")) })
      return okJson({})
    }) as unknown as HandoffFetch
    const result = await renameReady({
      serverUrl: "http://127.0.0.1:4096",
      targetSessionId: "ses_eng_1",
      slot: "engineering",
      nextAction: "Draft solutions.",
      fetchImpl: capture,
    })
    expect(result.title).toBe("[ready] engineering: Draft solutions.")
    expect(result.url).toBe("http://127.0.0.1:4096/api/session/ses_eng_1/rename")
    expect(calls).toHaveLength(1)
    expect(calls[0]!.body).toMatchObject({ title: "[ready] engineering: Draft solutions." })
  })

  test("handoff CLI parses --from/--to/--next with --json/--repo-root idioms", () => {
    expect(USAGE).toContain("sane-alpha handoff")
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

  test("runSaneHandoffCommand resolves, sends queue-default, renames [ready], and reuses the target", async () => {
    const promptCalls: Array<{ url: string; body: unknown }> = []
    const renameCalls: Array<{ url: string; body: unknown }> = []
    let creates = 0
    const fetchImpl: HandoffFetch = (async (url: string, init?: RequestInit) => {
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
      if (url.includes("/rename")) {
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
    expect(first.message).toContain("From: design (ses_design_1)")
    expect(first.message).toContain("To: engineering (ses_eng_1)")
    expect(first.readyTitle).toBe("[ready] engineering: Draft solutions.")
    expect(creates).toBe(1)
    expect(promptCalls).toHaveLength(1)
    expect(promptCalls[0]!.body).toMatchObject({ delivery: "queue" })
    expect(renameCalls).toHaveLength(1)
    expect(renameCalls[0]!.body).toMatchObject({
      title: "[ready] engineering: Draft solutions.",
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
    expect(creates).toBe(1)
    expect(promptCalls).toHaveLength(2)
  })

  test("runCli returns 0/1 and --json emits the handoff envelope", async () => {
    const fetchImpl: HandoffFetch = (async (url: string) => {
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
      expect(String(parsed.message)).toContain("Next action:")
      expect(String(parsed.ready_title)).toMatch(/^\[ready\] planning: /)
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
