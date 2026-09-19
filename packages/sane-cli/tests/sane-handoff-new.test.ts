/**
 * SANE handoff fresh-session path (`--new` / `new_session`).
 *
 * Opt-in only: default latest-wins reuse / create-if-empty behavior is
 * unchanged. `--new` / `new_session` forces a create even when the slot
 * already has linked sessions, and is mutually exclusive with explicit
 * targeting (`--session-index` / `session_index` / `to_session`).
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
  parseCliArguments,
  runSaneHandoffCommand,
  USAGE,
  type HandoffFetch,
  type HandoffFetchResponse,
} from "../src/sane-handoff-command.ts"
import { runHandoffAsSession } from "../src/sane-handoff-tool.ts"
import {
  initSchema,
  linkSelection,
  listSelectionsBySlot,
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

const identity: SaneIdentity = { repoRoot: "/repo", user: "alice", workstreamId: "01-demo" }

function seedTwoLinked(db: Database): void {
  linkSelection(
    db,
    identity,
    { slot: "engineering", sessionId: "ses_eng_first" },
    mutation("design", "ses_design", "2026-09-16T00:00:00.000Z"),
  )
  linkSelection(
    db,
    identity,
    { slot: "engineering", sessionId: "ses_eng_second" },
    mutation("design", "ses_design", "2026-09-16T00:00:01.000Z"),
  )
}

describe("sane handoff --new CLI parsing", () => {
  test("USAGE advertises --new and parsing accepts the flag (default false)", () => {
    expect(USAGE).toContain("--new")
    const parsed = parseCliArguments([
      "/repo",
      "01-demo",
      "--from",
      "design",
      "--to",
      "engineering",
      "--next",
      "Go.",
      "--new",
    ])
    expect(parsed.forceNew).toBe(true)
    const absent = parseCliArguments([
      "/repo",
      "01-demo",
      "--from",
      "design",
      "--to",
      "engineering",
      "--next",
      "Go.",
    ])
    expect(absent.forceNew).toBe(false)
  })

  test("--new with --session-index is rejected", () => {
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
        "--new",
        "--session-index",
        "1",
      ]),
    ).toThrow("Options --new and --session-index are mutually exclusive.")
  })
})

describe("runHandoffAsSession new_session (tool core)", () => {
  let db: Database | undefined

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

  test("new_session creates a third session when two are linked (mock fetch)", async () => {
    linkSelection(
      db!,
      identity,
      { slot: "design", sessionId: "ses_design" },
      mutation("design", "ses_design", "2026-09-16T00:00:00.000Z"),
    )
    seedTwoLinked(db!)
    let creates = 0
    const calls: string[] = []
    const fetchImpl: HandoffFetch = (async (url: string) => {
      calls.push(url)
      if (url.endsWith("/api/session")) {
        creates += 1
        return okJson({ id: "ses_eng_third" })
      }
      return okJson({})
    }) as unknown as HandoffFetch
    const result = await runHandoffAsSession(
      db!,
      identity,
      { fromSession: "ses_design", to: "engineering", message: "Fresh probe.", new_session: true },
      { fetchImpl, serverUrl: "http://127.0.0.1:4096" },
    )
    expect(creates).toBe(1)
    expect(listSelectionsBySlot(db!, identity, "engineering")).toHaveLength(3)
    expect(result.to).toEqual({
      slot: "engineering",
      session_id: "ses_eng_third",
      session_index: 3,
      created: true,
    })
    expect(result.message).toContain("To: engineering (ses_eng_third)")
  })

  test("absent new_session reuses latest without creating", async () => {
    linkSelection(
      db!,
      identity,
      { slot: "design", sessionId: "ses_design" },
      mutation("design", "ses_design", "2026-09-16T00:00:00.000Z"),
    )
    seedTwoLinked(db!)
    let creates = 0
    const fetchImpl: HandoffFetch = (async (url: string) => {
      if (url.endsWith("/api/session")) {
        creates += 1
        return okJson({ id: "ses_eng_unexpected" })
      }
      return okJson({})
    }) as unknown as HandoffFetch
    const result = await runHandoffAsSession(
      db!,
      identity,
      { fromSession: "ses_design", to: "engineering", message: "Reuse latest." },
      { fetchImpl, serverUrl: "http://127.0.0.1:4096" },
    )
    expect(creates).toBe(0)
    expect(result.to).toMatchObject({ session_id: "ses_eng_second", session_index: 2, created: false })
    expect(listSelectionsBySlot(db!, identity, "engineering")).toHaveLength(2)
  })

  test("new_session with session_index throws mutually exclusive", async () => {
    linkSelection(
      db!,
      identity,
      { slot: "design", sessionId: "ses_design" },
      mutation("design", "ses_design", "2026-09-16T00:00:00.000Z"),
    )
    seedTwoLinked(db!)
    await expect(
      runHandoffAsSession(
        db!,
        identity,
        {
          fromSession: "ses_design",
          to: "engineering",
          message: "Go.",
          new_session: true,
          session_index: 1,
        },
        { fetchImpl: failingFetch(), serverUrl: "http://127.0.0.1:4096" },
      ),
    ).rejects.toThrow("Options new_session and session_index/to_session are mutually exclusive.")
  })

  test("new_session with to_session throws mutually exclusive", async () => {
    linkSelection(
      db!,
      identity,
      { slot: "design", sessionId: "ses_design" },
      mutation("design", "ses_design", "2026-09-16T00:00:00.000Z"),
    )
    seedTwoLinked(db!)
    await expect(
      runHandoffAsSession(
        db!,
        identity,
        {
          fromSession: "ses_design",
          to: "engineering",
          message: "Go.",
          new_session: true,
          to_session: "ses_eng_first",
        },
        { fetchImpl: failingFetch(), serverUrl: "http://127.0.0.1:4096" },
      ),
    ).rejects.toThrow("Options new_session and session_index/to_session are mutually exclusive.")
  })
})

describe("sane handoff --new end to end (mock server)", () => {
  let tempDirectory = ""
  let implementationRepository = ""

  beforeEach(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "sane-handoff-new-"))
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
    const seededIdentity = await resolveSaneIdentity(implementationRepository, "01-demo")
    const seededDb = await openSaneDb(seededIdentity.repoRoot)
    try {
      initSchema(seededDb)
      upsertSelection(seededDb, seededIdentity, { slot: "design", sessionId: "ses_design_1" }, mutation())
      linkSelection(
        seededDb,
        seededIdentity,
        { slot: "engineering", sessionId: "ses_eng_first" },
        mutation("design", "ses_design_1", "2026-09-16T00:00:00.000Z"),
      )
      linkSelection(
        seededDb,
        seededIdentity,
        { slot: "engineering", sessionId: "ses_eng_second" },
        mutation("design", "ses_design_1", "2026-09-16T00:00:01.000Z"),
      )
    } finally {
      try {
        seededDb.close()
      } catch {
        // Best effort.
      }
    }
  })

  afterEach(async () => {
    await rm(tempDirectory, { recursive: true, force: true })
    tempDirectory = ""
  })

  test("forceNew creates a third session; default reuses latest", async () => {
    let creates = 0
    const fetchImpl: HandoffFetch = (async (url: string) => {
      if (url.endsWith("/api/session")) {
        creates += 1
        return okJson({ id: "ses_eng_third" })
      }
      return okJson({})
    }) as unknown as HandoffFetch

    const fresh = await runSaneHandoffCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      fromSlot: "design",
      toSlot: "engineering",
      nextAction: "Fresh probe.",
      forceNew: true,
      fetchImpl,
      write: () => {},
    })
    expect(fresh.toSession).toBe("ses_eng_third")
    expect(fresh.targetCreated).toBe(true)
    expect(fresh.targetIndex).toBe(3)
    expect(creates).toBe(1)

    const reused = await runSaneHandoffCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      fromSlot: "design",
      toSlot: "engineering",
      nextAction: "Reuse latest.",
      fetchImpl,
      write: () => {},
    })
    expect(reused.toSession).toBe("ses_eng_third")
    expect(reused.targetCreated).toBe(false)
    expect(reused.targetIndex).toBe(3)
    expect(creates).toBe(1)
  })

  test("forceNew with sessionIndex fails the handoff", async () => {
    let creates = 0
    const fetchImpl: HandoffFetch = (async (url: string) => {
      if (url.endsWith("/api/session")) {
        creates += 1
        return okJson({ id: "ses_eng_unexpected" })
      }
      return okJson({})
    }) as unknown as HandoffFetch
    await expect(
      runSaneHandoffCommand({
        implementationRepository,
        workstreamPath: "01-demo",
        fromSlot: "design",
        toSlot: "engineering",
        nextAction: "Go.",
        forceNew: true,
        sessionIndex: 1,
        fetchImpl,
        write: () => {},
      }),
    ).rejects.toThrow("Options --new and --session-index are mutually exclusive.")
    expect(creates).toBe(0)
  })
})
