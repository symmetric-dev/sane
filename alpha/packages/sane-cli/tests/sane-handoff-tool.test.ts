/**
 * SANE `sane_handoff` tool tests (plugin core, SDK-free).
 *
 * - `resolveFromSlot` reverse-looks-up the caller session: single slot ok,
 *   unlinked throws, multi-slot ambiguous throws, explicit `from` resolves,
 *   and a (slot, session) mismatch throws.
 * - `runHandoffAsSession` targets latest-wins by default, honors 1-based
 *   `session_index` (1/2/out-of-range mirror the CLI text), creates the
 *   target when the slot is empty (mock fetch), composes the 6-line Section 3
 *   message (refs only, never artifact contents), and is queue-only (no
 *   steer/mode input — extras are ignored, delivery is always queue).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Database } from "bun:sqlite"

import {
  resolveFromSlot,
  runHandoffAsSession,
} from "../src/sane-handoff-tool.ts"
import type { HandoffFetch, HandoffFetchResponse } from "../src/sane-handoff-command.ts"
import {
  initSchema,
  linkSelection,
  listSelectionsBySlot,
  openInMemoryDb,
  type MutationContext,
  type SaneIdentity,
} from "../src/sane-db.ts"

const identity: SaneIdentity = { repoRoot: "/repo", user: "alice", workstreamId: "01-demo" }

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

interface RecordedCall {
  url: string
  body: unknown
}

/** Mock server: create returns `{ id }`; prompt/PATCH-title return ok and record. */
function mockServer(createdId: string | null, calls: RecordedCall[]): HandoffFetch {
  return (async (url: string, init?: RequestInit) => {
    if (url.includes("/api/agent?")) return okJson({ data: ["design", "engineering", "planning", "execution", "research"].map((slot) => ({
      id: `sane/assistant/${slot}`,
      model: { providerID: "openai", id: "gpt-6-astra", variant: "low" },
    })) })
    const body = JSON.parse(String((init as { body?: string })?.body ?? "{}"))
    calls.push({ url, body })
    if (url.endsWith("/api/session")) {
      if (createdId === null) throw new Error("unexpected session create POST")
      return okJson({ id: createdId })
    }
    return okJson({ data: { admitted: true } })
  }) as unknown as HandoffFetch
}

function link(
  db: Database,
  slot: string,
  sessionId: string,
  timestamp: string,
): void {
  linkSelection(db, identity, { slot, sessionId }, mutation(slot, sessionId, timestamp))
}

describe("resolveFromSlot (reverse lookup)", () => {
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

  test("single linked slot resolves", () => {
    link(db!, "design", "ses_a", "2026-09-16T00:00:00.000Z")
    expect(resolveFromSlot(db!, identity, "ses_a")).toBe("design")
  })

  test("unlinked session throws with the link-first text", () => {
    expect(() => resolveFromSlot(db!, identity, "ses_ghost")).toThrow(
      "Session ses_ghost is not linked to any slot; link first.",
    )
  })

  test("multi-slot session without from throws ambiguous", () => {
    link(db!, "design", "ses_m", "2026-09-16T00:00:00.000Z")
    link(db!, "planning", "ses_m", "2026-09-16T00:00:01.000Z")
    expect(() => resolveFromSlot(db!, identity, "ses_m")).toThrow(
      'Session ses_m is linked to <design, planning>; pass from to disambiguate.',
    )
  })

  test("explicit from resolves a multi-slot session", () => {
    link(db!, "design", "ses_m", "2026-09-16T00:00:00.000Z")
    link(db!, "planning", "ses_m", "2026-09-16T00:00:01.000Z")
    expect(resolveFromSlot(db!, identity, "ses_m", "planning")).toBe("planning")
    expect(resolveFromSlot(db!, identity, "ses_m", "design")).toBe("design")
  })

  test("from-slot mismatch throws", () => {
    link(db!, "design", "ses_a", "2026-09-16T00:00:00.000Z")
    expect(() => resolveFromSlot(db!, identity, "ses_a", "planning")).toThrow(
      'Session ses_a is not linked to slot "planning".',
    )
  })

  test("invalid from slot throws the slot text", () => {
    link(db!, "design", "ses_a", "2026-09-16T00:00:00.000Z")
    expect(() => resolveFromSlot(db!, identity, "ses_a", "bogus")).toThrow(
      /Invalid selection slot/,
    )
  })
})

describe("runHandoffAsSession (tool core)", () => {
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

  function seedDesignAndEngineering(): void {
    link(db!, "design", "ses_design", "2026-09-16T00:00:00.000Z")
    link(db!, "engineering", "ses_eng_first", "2026-09-16T00:00:01.000Z")
    link(db!, "engineering", "ses_eng_second", "2026-09-16T00:00:02.000Z")
  }

  test("defaults to latest-wins without creating", async () => {
    seedDesignAndEngineering()
    const calls: RecordedCall[] = []
    const result = await runHandoffAsSession(
      db!,
      identity,
      { fromSession: "ses_design", to: "engineering", message: "Draft solutions." },
      { fetchImpl: mockServer(null, calls), serverUrl: "http://127.0.0.1:4096" },
    )
    expect(result.from).toEqual({ slot: "design", session_id: "ses_design" })
    expect(result.to).toEqual({
      slot: "engineering",
      session_id: "ses_eng_second",
      session_index: 2,
      created: false,
    })
    expect(result.mode).toBe("queue")
    expect(result.ready_title).toBe("[ready] engineering: Draft solutions.")
    // No session-create POST: prompt + rename only.
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:4096/api/session/ses_eng_second/prompt",
      "http://127.0.0.1:4096/api/session/ses_eng_second",
    ])
    expect(calls[0]!.body).toMatchObject({ delivery: "queue" })
    expect(listSelectionsBySlot(db!, identity, "engineering")).toHaveLength(2)
  })

  test("caps the session title while delivering the complete handoff message", async () => {
    seedDesignAndEngineering()
    const calls: RecordedCall[] = []
    const message = `Draft solutions. ${"Essential context. ".repeat(30)}Preserve this final decision.`
    const result = await runHandoffAsSession(
      db!,
      identity,
      { fromSession: "ses_design", to: "engineering", message },
      { fetchImpl: mockServer(null, calls), serverUrl: "http://127.0.0.1:4096" },
    )
    expect(result.ready_title.length).toBeLessThanOrEqual(200)
    expect(result.ready_title).toEndWith("…")
    expect(result.message).toContain(message)
    expect(JSON.stringify(calls[0]!.body)).toContain(message)
    expect(calls[1]!.body).toMatchObject({ title: result.ready_title })
  })

  test("session_index 1 and 2 mirror CLI semantics", async () => {
    seedDesignAndEngineering()
    const first = await runHandoffAsSession(
      db!,
      identity,
      { fromSession: "ses_design", to: "engineering", message: "Go one.", session_index: 1 },
      { fetchImpl: mockServer(null, []), serverUrl: "http://127.0.0.1:4096" },
    )
    expect(first.to).toMatchObject({ session_id: "ses_eng_first", session_index: 1 })
    const second = await runHandoffAsSession(
      db!,
      identity,
      { fromSession: "ses_design", to: "engineering", message: "Go two.", session_index: 2 },
      { fetchImpl: mockServer(null, []), serverUrl: "http://127.0.0.1:4096" },
    )
    expect(second.to).toMatchObject({ session_id: "ses_eng_second", session_index: 2 })
  })

  test("session_index out-of-range throws the CLI text", async () => {
    seedDesignAndEngineering()
    await expect(
      runHandoffAsSession(
        db!,
        identity,
        { fromSession: "ses_design", to: "engineering", message: "Go.", session_index: 3 },
        { fetchImpl: failingFetch(), serverUrl: "http://127.0.0.1:4096" },
      ),
    ).rejects.toThrow('No session at index 3 for slot "engineering" (2 linked).')
  })

  test("non-integer session_index throws the CLI text", async () => {
    seedDesignAndEngineering()
    await expect(
      runHandoffAsSession(
        db!,
        identity,
        { fromSession: "ses_design", to: "engineering", message: "Go.", session_index: 1.5 },
        { fetchImpl: failingFetch(), serverUrl: "http://127.0.0.1:4096" },
      ),
    ).rejects.toThrow("Option --session-index must be a positive integer.")
  })

  test("empty target creates (mock fetch) with the 3-line shape", async () => {
    link(db!, "design", "ses_design", "2026-09-16T00:00:00.000Z")
    const calls: RecordedCall[] = []
    const result = await runHandoffAsSession(
      db!,
      identity,
      { fromSession: "ses_design", to: "planning", message: "Start planning." },
      { fetchImpl: mockServer("ses_plan_new", calls), serverUrl: "http://127.0.0.1:4096" },
    )
    expect(result.to).toEqual({ slot: "planning", session_id: "ses_plan_new", session_index: 1, created: true })
    expect(result.message).toBe(
      "Workstream: 01-demo\nHandoff From: Design Session (ses_design)\nMessage: Start planning.",
    )
    expect(calls[0]!.url).toBe("http://127.0.0.1:4096/api/session")
    expect(calls[0]!.body).toMatchObject({
      agent: "sane/assistant/planning",
      model: { id: "gpt-6-astra", providerID: "openai", variant: "low" },
      location: { directory: "/repo" },
    })
  })

  test("bare research target creates-if-empty (mock fetch)", async () => {
    link(db!, "design", "ses_design", "2026-09-16T00:00:00.000Z")
    const calls: RecordedCall[] = []
    const result = await runHandoffAsSession(
      db!,
      identity,
      { fromSession: "ses_design", to: "research", message: "Gather evidence." },
      { fetchImpl: mockServer("ses_research_new", calls), serverUrl: "http://127.0.0.1:4096" },
    )
    expect(result.to).toEqual({ slot: "research", session_id: "ses_research_new", session_index: 1, created: true })
    expect(result.message).toBe(
      "Workstream: 01-demo\nHandoff From: Design Session (ses_design)\nMessage: Gather evidence.",
    )
    expect(result.ready_title).toBe("[ready] research: Gather evidence.")
    expect(calls[0]!.url).toBe("http://127.0.0.1:4096/api/session")
    expect(calls[0]!.body).toMatchObject({ agent: "sane/assistant/research" })
    expect(listSelectionsBySlot(db!, identity, "research")).toHaveLength(1)
  })

  test("message shape is Workstream/Handoff From/Message, never artifact contents", async () => {
    seedDesignAndEngineering()
    const secretContents = "SUPER-SECRET-ARTIFACT-CONTENTS-9f8e7d"
    const result = await runHandoffAsSession(
      db!,
      identity,
      { fromSession: "ses_design", to: "engineering", message: "Pick up the SDD.", session_index: 1 },
      { fetchImpl: mockServer(null, []), serverUrl: "http://127.0.0.1:4096" },
    )
    expect(result.message).toBe(
      "Workstream: 01-demo\nHandoff From: Design Session (ses_design)\nMessage: Pick up the SDD.",
    )
    expect(result.message).not.toContain(secretContents)
  })

  test("queue-only: steer/mode inputs do not exist and extras are ignored", async () => {
    seedDesignAndEngineering()
    const calls: RecordedCall[] = []
    const result = await runHandoffAsSession(
      db!,
      identity,
      {
        fromSession: "ses_design",
        to: "engineering",
        message: "Stay queued.",
        // No steer/mode param exists: unknown extras must not change delivery.
        ...( { mode: "steer", steerReason: "user-redirect" } as unknown as Record<string, unknown> ),
      },
      { fetchImpl: mockServer(null, calls), serverUrl: "http://127.0.0.1:4096" },
    )
    expect(result.mode).toBe("queue")
    expect(calls[0]!.body).toMatchObject({ delivery: "queue" })
    expect(calls[0]!.body).not.toMatchObject({ delivery: "steer" })
  })

  test("unlinked caller and ambiguous caller throw before any fetch", async () => {
    await expect(
      runHandoffAsSession(
        db!,
        identity,
        { fromSession: "ses_ghost", to: "engineering", message: "Go." },
        { fetchImpl: failingFetch(), serverUrl: "http://127.0.0.1:4096" },
      ),
    ).rejects.toThrow("Session ses_ghost is not linked to any slot; link first.")

    link(db!, "design", "ses_m", "2026-09-16T00:00:00.000Z")
    link(db!, "planning", "ses_m", "2026-09-16T00:00:01.000Z")
    await expect(
      runHandoffAsSession(
        db!,
        identity,
        { fromSession: "ses_m", to: "engineering", message: "Go." },
        { fetchImpl: failingFetch(), serverUrl: "http://127.0.0.1:4096" },
      ),
    ).rejects.toThrow(/pass from to disambiguate/)

    const calls: RecordedCall[] = []
    const disambiguated = await runHandoffAsSession(
      db!,
      identity,
      { fromSession: "ses_m", to: "engineering", message: "Go.", from: "planning" },
      { fetchImpl: mockServer("ses_eng_new", calls), serverUrl: "http://127.0.0.1:4096" },
    )
    expect(disambiguated.from).toEqual({ slot: "planning", session_id: "ses_m" })
  })

  test("to_session resolves the exact session with no create", async () => {
    seedDesignAndEngineering()
    const calls: RecordedCall[] = []
    const result = await runHandoffAsSession(
      db!,
      identity,
      { fromSession: "ses_design", to: "engineering", message: "Reply one.", to_session: "ses_eng_first" },
      { fetchImpl: mockServer(null, calls), serverUrl: "http://127.0.0.1:4096" },
    )
    expect(result.to).toEqual({
      slot: "engineering",
      session_id: "ses_eng_first",
      session_index: 1,
      created: false,
    })
    // No session-create POST: prompt + rename only, addressed to the first session.
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:4096/api/session/ses_eng_first/prompt",
      "http://127.0.0.1:4096/api/session/ses_eng_first",
    ])
    expect(result.message).toBe(
      "Workstream: 01-demo\nHandoff From: Design Session (ses_design)\nMessage: Reply one.",
    )
    expect(listSelectionsBySlot(db!, identity, "engineering")).toHaveLength(2)
  })

  test("to_session unknown id throws not linked to slot", async () => {
    seedDesignAndEngineering()
    await expect(
      runHandoffAsSession(
        db!,
        identity,
        { fromSession: "ses_design", to: "engineering", message: "Go.", to_session: "ses_ghost" },
        { fetchImpl: failingFetch(), serverUrl: "http://127.0.0.1:4096" },
      ),
    ).rejects.toThrow(/not linked to slot/)
  })

  test("to_session and session_index together throw mutually exclusive", async () => {
    seedDesignAndEngineering()
    await expect(
      runHandoffAsSession(
        db!,
        identity,
        {
          fromSession: "ses_design",
          to: "engineering",
          message: "Go.",
          to_session: "ses_eng_first",
          session_index: 1,
        },
        { fetchImpl: failingFetch(), serverUrl: "http://127.0.0.1:4096" },
      ),
    ).rejects.toThrow(/mutually exclusive/)
  })

  test("to_session naming a session from a different slot throws", async () => {
    seedDesignAndEngineering()
    link(db!, "planning", "ses_plan_only", "2026-09-16T00:00:03.000Z")
    await expect(
      runHandoffAsSession(
        db!,
        identity,
        { fromSession: "ses_design", to: "engineering", message: "Go.", to_session: "ses_plan_only" },
        { fetchImpl: failingFetch(), serverUrl: "http://127.0.0.1:4096" },
      ),
    ).rejects.toThrow('Session ses_plan_only is not linked to slot "engineering".')
  })
})
