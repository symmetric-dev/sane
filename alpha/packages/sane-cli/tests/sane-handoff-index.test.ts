/**
 * `sane handoff --session-index <n>` (multi-session slot targeting).
 *
 * - 1-based index into `listSelectionsBySlot` order (matches `sane sessions`).
 * - Indexed resolve is read-only: no create fetch, no registry write, no
 *   mutation record. Out-of-range fails instead of creating.
 * - Absent index keeps latest-wins reuse / create-if-empty behavior.
 * - `--json` envelope carries `session_index`.
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
  resolveOrCreateSession,
  runSaneHandoffCommand,
  USAGE,
  type HandoffFetch,
  type HandoffFetchResponse,
} from "../src/sane-handoff-command.ts"
import {
  initSchema,
  linkSelection,
  listMutations,
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

/** Seed two linked engineering sessions; returns [first, second] in slot order. */
function seedTwoLinked(db: Database, identity: SaneIdentity): [string, string] {
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
  return ["ses_eng_first", "ses_eng_second"]
}

describe("resolveOrCreateSession --session-index (unit)", () => {
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

  test("--session-index 1 resolves the first linked session without creating", async () => {
    seedTwoLinked(db!, identity)
    const mutationsBefore = listMutations(db!, { tableName: "selections" }).length
    const result = await resolveOrCreateSession(db!, identity, {
      serverUrl: "http://127.0.0.1:4096",
      slot: "engineering",
      mutation: mutation("design", "ses_design"),
      fetchImpl: failingFetch(),
      sessionIndex: 1,
    })
    expect(result.sessionId).toBe("ses_eng_first")
    expect(result.created).toBe(false)
    expect(result.targetIndex).toBe(1)
    expect(result.row.session_id).toBe("ses_eng_first")
    // Read-only: registry rows and mutation log untouched.
    expect(listSelectionsBySlot(db!, identity, "engineering")).toHaveLength(2)
    expect(listMutations(db!, { tableName: "selections" })).toHaveLength(mutationsBefore)
  })

  test("--session-index 2 resolves the second linked session without creating", async () => {
    seedTwoLinked(db!, identity)
    const result = await resolveOrCreateSession(db!, identity, {
      serverUrl: "http://127.0.0.1:4096",
      slot: "engineering",
      mutation: mutation("design", "ses_design"),
      fetchImpl: failingFetch(),
      sessionIndex: 2,
    })
    expect(result.sessionId).toBe("ses_eng_second")
    expect(result.created).toBe(false)
    expect(result.targetIndex).toBe(2)
  })

  test("out-of-range and empty-slot indexes fail instead of creating", async () => {
    seedTwoLinked(db!, identity)
    await expect(
      resolveOrCreateSession(db!, identity, {
        serverUrl: "http://127.0.0.1:4096",
        slot: "engineering",
        mutation: mutation(),
        fetchImpl: failingFetch(),
        sessionIndex: 3,
      }),
    ).rejects.toThrow('No session at index 3 for slot "engineering" (2 linked).')

    await expect(
      resolveOrCreateSession(db!, identity, {
        serverUrl: "http://127.0.0.1:4096",
        slot: "planning",
        mutation: mutation(),
        fetchImpl: failingFetch(),
        sessionIndex: 1,
      }),
    ).rejects.toThrow('No session at index 1 for slot "planning" (0 linked).')
  })

  test("zero, negative, and non-integer indexes fail", async () => {
    seedTwoLinked(db!, identity)
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(
        resolveOrCreateSession(db!, identity, {
          serverUrl: "http://127.0.0.1:4096",
          slot: "engineering",
          mutation: mutation(),
          fetchImpl: failingFetch(),
          sessionIndex: bad,
        }),
      ).rejects.toThrow("Option --session-index must be a positive integer.")
    }
  })

  test("forceNew and sessionIndex are mutually exclusive", async () => {
    seedTwoLinked(db!, identity)
    await expect(
      resolveOrCreateSession(db!, identity, {
        serverUrl: "http://127.0.0.1:4096",
        slot: "engineering",
        mutation: mutation(),
        fetchImpl: failingFetch(),
        forceNew: true,
        sessionIndex: 1,
      }),
    ).rejects.toThrow("Options --force-new and --session-index are mutually exclusive.")
  })

  test("absent index still latest-wins with the slot-order position", async () => {
    seedTwoLinked(db!, identity)
    const result = await resolveOrCreateSession(db!, identity, {
      serverUrl: "http://127.0.0.1:4096",
      slot: "engineering",
      mutation: mutation("design", "ses_design"),
      fetchImpl: failingFetch(),
    })
    expect(result.sessionId).toBe("ses_eng_second")
    expect(result.created).toBe(false)
    expect(result.targetIndex).toBe(2)
  })

  test("absent index still creates when the slot is empty (index 1)", async () => {
    const createFetch: HandoffFetch = (async () =>
      okJson({ id: "ses_plan_new" })) as unknown as HandoffFetch
    const created = await resolveOrCreateSession(db!, identity, {
      serverUrl: "http://127.0.0.1:4096",
      slot: "planning",
      mutation: mutation("design", "ses_design"),
      fetchImpl: createFetch,
    })
    expect(created.created).toBe(true)
    expect(created.sessionId).toBe("ses_plan_new")
    expect(created.targetIndex).toBe(1)
  })

  test("bare research creates-if-empty with index 1", async () => {
    const createFetch: HandoffFetch = (async () =>
      okJson({ id: "ses_research_new" })) as unknown as HandoffFetch
    const created = await resolveOrCreateSession(db!, identity, {
      serverUrl: "http://127.0.0.1:4096",
      slot: "research",
      mutation: mutation("design", "ses_design"),
      fetchImpl: createFetch,
    })
    expect(created.created).toBe(true)
    expect(created.sessionId).toBe("ses_research_new")
    expect(created.targetIndex).toBe(1)
    expect(listSelectionsBySlot(db!, identity, "research")).toHaveLength(1)
  })
})

describe("sane handoff --session-index CLI parsing", () => {
  test("USAGE advertises --session-index and parsing accepts a positive integer", () => {
    expect(USAGE).toContain("--session-index")
    const parsed = parseCliArguments([
      "/repo",
      "01-demo",
      "--from",
      "design",
      "--to",
      "engineering",
      "--next",
      "Go.",
      "--session-index",
      "2",
    ])
    expect(parsed.sessionIndex).toBe(2)
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
    expect(absent.sessionIndex).toBeUndefined()
  })

  test("zero, negative, and non-numeric values fail", () => {
    const base = ["/repo", "01-demo", "--from", "design", "--to", "engineering", "--next", "Go."]
    for (const bad of ["0", "-1", "abc", "1.5", ""]) {
      expect(() => parseCliArguments([...base, "--session-index", bad])).toThrow(
        "Option --session-index must be a positive integer.",
      )
    }
    expect(() => parseCliArguments([...base, "--session-index"])).toThrow(
      "Option --session-index requires a value.",
    )
    expect(() =>
      parseCliArguments([...base, "--session-index", "1", "--session-index", "2"]),
    ).toThrow("Option --session-index may be provided only once.")
  })
})

describe("sane handoff --session-index end to end (mock server)", () => {
  let tempDirectory = ""
  let implementationRepository = ""

  beforeEach(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "sane-handoff-index-"))
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
    const db = await openSaneDb(identity.repoRoot)
    try {
      initSchema(db)
      upsertSelection(db, identity, { slot: "design", sessionId: "ses_design_1" }, mutation())
      linkSelection(
        db,
        identity,
        { slot: "engineering", sessionId: "ses_eng_first" },
        mutation("design", "ses_design_1", "2026-09-16T00:00:00.000Z"),
      )
      linkSelection(
        db,
        identity,
        { slot: "engineering", sessionId: "ses_eng_second" },
        mutation("design", "ses_design_1", "2026-09-16T00:00:01.000Z"),
      )
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

  /** Mock server fetch that counts session creates but otherwise succeeds. */
  function mockServer(counter: { creates: number }): HandoffFetch {
    return (async (url: string) => {
      if (url.endsWith("/api/session")) {
        counter.creates += 1
        return okJson({ id: "ses_eng_created" })
      }
      return okJson({})
    }) as unknown as HandoffFetch
  }

  test("--session-index 1 targets the first linked session with no create", async () => {
    const counter = { creates: 0 }
    const result = await runSaneHandoffCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      fromSlot: "design",
      toSlot: "engineering",
      nextAction: "Draft solutions.",
      sessionIndex: 1,
      fetchImpl: mockServer(counter),
      write: () => {},
    })
    expect(result.toSession).toBe("ses_eng_first")
    expect(result.targetCreated).toBe(false)
    expect(result.targetIndex).toBe(1)
    expect(counter.creates).toBe(0)
    expect(result.message).toContain("To: engineering (ses_eng_first)")
  })

  test("--session-index 2 targets the second linked session with no create", async () => {
    const counter = { creates: 0 }
    const result = await runSaneHandoffCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      fromSlot: "design",
      toSlot: "engineering",
      nextAction: "Draft solutions.",
      sessionIndex: 2,
      fetchImpl: mockServer(counter),
      write: () => {},
    })
    expect(result.toSession).toBe("ses_eng_second")
    expect(result.targetIndex).toBe(2)
    expect(counter.creates).toBe(0)
    expect(result.message).toContain("To: engineering (ses_eng_second)")
  })

  test("out-of-range index fails the handoff", async () => {
    const counter = { creates: 0 }
    await expect(
      runSaneHandoffCommand({
        implementationRepository,
        workstreamPath: "01-demo",
        fromSlot: "design",
        toSlot: "engineering",
        nextAction: "Draft solutions.",
        sessionIndex: 3,
        fetchImpl: mockServer(counter),
        write: () => {},
      }),
    ).rejects.toThrow('No session at index 3 for slot "engineering" (2 linked).')
    expect(counter.creates).toBe(0)
  })

  test("invalid sessionIndex values fail the handoff", async () => {
    const counter = { creates: 0 }
    for (const bad of [0, -2]) {
      await expect(
        runSaneHandoffCommand({
          implementationRepository,
          workstreamPath: "01-demo",
          fromSlot: "design",
          toSlot: "engineering",
          nextAction: "Draft solutions.",
          sessionIndex: bad,
          fetchImpl: mockServer(counter),
          write: () => {},
        }),
      ).rejects.toThrow("Option --session-index must be a positive integer.")
    }
    expect(counter.creates).toBe(0)
  })

  test("absent index still latest-wins; empty slot still creates", async () => {
    const counter = { creates: 0 }
    const latest = await runSaneHandoffCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      fromSlot: "design",
      toSlot: "engineering",
      nextAction: "Revise solutions.",
      fetchImpl: mockServer(counter),
      write: () => {},
    })
    expect(latest.toSession).toBe("ses_eng_second")
    expect(latest.targetIndex).toBe(2)
    expect(counter.creates).toBe(0)

    const created = await runSaneHandoffCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      fromSlot: "design",
      toSlot: "planning",
      nextAction: "Write the plan.",
      fetchImpl: mockServer(counter),
      write: () => {},
    })
    expect(created.targetCreated).toBe(true)
    expect(created.targetIndex).toBe(1)
    expect(counter.creates).toBe(1)
  })

  test("--json envelope contains session_index", async () => {
    const counter = { creates: 0 }
    const lines: string[] = []
    await runSaneHandoffCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      fromSlot: "design",
      toSlot: "engineering",
      nextAction: "Draft solutions.",
      sessionIndex: 1,
      json: true,
      fetchImpl: mockServer(counter),
      write: (line) => lines.push(line),
    })
    const parsed = JSON.parse(lines.join("\n")) as {
      to: { slot: string; session_id: string; created: boolean; session_index: number }
    }
    expect(parsed.to).toMatchObject({
      slot: "engineering",
      session_id: "ses_eng_first",
      created: false,
      session_index: 1,
    })

    const freshLines: string[] = []
    await runSaneHandoffCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      fromSlot: "design",
      toSlot: "planning",
      nextAction: "Write the plan.",
      json: true,
      fetchImpl: mockServer(counter),
      write: (line) => freshLines.push(line),
    })
    const fresh = JSON.parse(freshLines.join("\n")) as {
      to: { created: boolean; session_index: number }
    }
    expect(fresh.to).toMatchObject({ created: true, session_index: 1 })
  })
})
