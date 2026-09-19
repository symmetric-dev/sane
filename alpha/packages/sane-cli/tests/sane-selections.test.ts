/**
 * SANE selections registry: multiple linked sessions per slot.
 *
 * One row per (slot, session_id); `listSelectionsBySlot` orders oldest
 * first (stable 1-based index semantics) and `getSelection` keeps its
 * signature as a latest-wins read for existing callers.
 */
import { describe, expect, test } from "bun:test"

import {
  deleteSelection,
  getLatestSelection,
  getSelection,
  initSchema,
  linkSelection,
  listSelectionsBySlot,
  openInMemoryDb,
  SaneDbError,
  unlinkSelection,
  upsertSelection,
  type MutationContext,
  type SaneIdentity,
} from "../src/sane-db.ts"

function mutationAt(
  role: string,
  session: string,
  timestamp: string,
): MutationContext {
  return { actorRole: role, sessionId: session, timestamp }
}

const identity: SaneIdentity = {
  repoRoot: "/repo-selections-test",
  user: "alice",
  workstreamId: "01-export",
}

describe("sane selections (multiple linked sessions per slot)", () => {
  test("link two sessions to engineering: listed in updated_at order, latest wins", () => {
    const db = openInMemoryDb()
    try {
      initSchema(db)

      linkSelection(
        db,
        identity,
        { slot: "engineering", sessionId: "ses_eng_1" },
        mutationAt("engineering", "ses_eng_1", "2026-09-18T10:00:00.000Z"),
      )
      linkSelection(
        db,
        identity,
        { slot: "engineering", sessionId: "ses_eng_2" },
        mutationAt("engineering", "ses_eng_2", "2026-09-18T11:00:00.000Z"),
      )

      const rows = listSelectionsBySlot(db, identity, "engineering")
      expect(rows.map((row) => row.session_id)).toEqual(["ses_eng_1", "ses_eng_2"])
      expect(getLatestSelection(db, identity, "engineering")?.session_id).toBe("ses_eng_2")
    } finally {
      db.close()
    }
  })

  test("duplicate (slot, session) link throws SaneDbError", () => {
    const db = openInMemoryDb()
    try {
      initSchema(db)
      linkSelection(
        db,
        identity,
        { slot: "design", sessionId: "ses_dup" },
        mutationAt("design", "ses_dup", "2026-09-18T10:00:00.000Z"),
      )
      expect(() =>
        linkSelection(
          db,
          identity,
          { slot: "design", sessionId: "ses_dup" },
          mutationAt("design", "ses_dup", "2026-09-18T11:00:00.000Z"),
        ),
      ).toThrow(SaneDbError)
      expect(listSelectionsBySlot(db, identity, "design")).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  test("getSelection returns latest (backward compat)", () => {
    const db = openInMemoryDb()
    try {
      initSchema(db)
      expect(getSelection(db, identity, "planning")).toBeNull()
      upsertSelection(
        db,
        identity,
        { slot: "planning", sessionId: "ses_plan_1" },
        mutationAt("planning", "ses_plan_1", "2026-09-18T10:00:00.000Z"),
      )
      upsertSelection(
        db,
        identity,
        { slot: "planning", sessionId: "ses_plan_2" },
        mutationAt("planning", "ses_plan_2", "2026-09-18T11:00:00.000Z"),
      )
      expect(getSelection(db, identity, "planning")?.session_id).toBe("ses_plan_2")
      expect(getLatestSelection(db, identity, "planning")?.session_id).toBe("ses_plan_2")
    } finally {
      db.close()
    }
  })

  test("unlink removes one row and keeps the other; deleteSelection clears the slot", () => {
    const db = openInMemoryDb()
    try {
      initSchema(db)
      for (const [session, timestamp] of [
        ["ses_exec_1", "2026-09-18T10:00:00.000Z"],
        ["ses_exec_2", "2026-09-18T11:00:00.000Z"],
      ] as const) {
        linkSelection(
          db,
          identity,
          { slot: "execution", sessionId: session },
          mutationAt("execution", session, timestamp),
        )
      }

      unlinkSelection(
        db,
        identity,
        "execution",
        "ses_exec_1",
        mutationAt("execution", "ses_exec_1", "2026-09-18T12:00:00.000Z"),
      )
      expect(listSelectionsBySlot(db, identity, "execution").map((row) => row.session_id)).toEqual([
        "ses_exec_2",
      ])
      expect(getSelection(db, identity, "execution")?.session_id).toBe("ses_exec_2")

      deleteSelection(db, identity, "execution", mutationAt("execution", "ses_exec_2", "2026-09-18T13:00:00.000Z"))
      expect(listSelectionsBySlot(db, identity, "execution")).toHaveLength(0)
      expect(getSelection(db, identity, "execution")).toBeNull()
    } finally {
      db.close()
    }
  })

  test("research:<topic> and bare research slots validate; bogus slots throw", () => {
    const db = openInMemoryDb()
    try {
      initSchema(db)
      const row = linkSelection(
        db,
        identity,
        { slot: "research:auth", sessionId: "ses_research" },
        mutationAt("research", "ses_research", "2026-09-18T10:00:00.000Z"),
      )
      expect(row.slot).toBe("research:auth")
      expect(listSelectionsBySlot(db, identity, "research:auth")).toHaveLength(1)

      // Bare `research` links and reads everywhere `research:<topic>` does.
      const bare = linkSelection(
        db,
        identity,
        { slot: "research", sessionId: "ses_research_bare" },
        mutationAt("research", "ses_research_bare", "2026-09-18T10:30:00.000Z"),
      )
      expect(bare.slot).toBe("research")
      expect(listSelectionsBySlot(db, identity, "research")).toHaveLength(1)
      expect(getLatestSelection(db, identity, "research")?.session_id).toBe(
        "ses_research_bare",
      )
      expect(getSelection(db, identity, "research")?.session_id).toBe("ses_research_bare")
      upsertSelection(
        db,
        identity,
        { slot: "research", sessionId: "ses_research_bare2" },
        mutationAt("research", "ses_research_bare2", "2026-09-18T10:35:00.000Z"),
      )
      expect(getSelection(db, identity, "research")?.session_id).toBe("ses_research_bare2")
      unlinkSelection(
        db,
        identity,
        "research",
        "ses_research_bare2",
        mutationAt("research", "ses_research_bare2", "2026-09-18T10:40:00.000Z"),
      )
      expect(listSelectionsBySlot(db, identity, "research").map((r) => r.session_id)).toEqual([
        "ses_research_bare",
      ])

      const m = mutationAt("research", "ses_research", "2026-09-18T11:00:00.000Z")
      expect(() => linkSelection(db, identity, { slot: "bogus", sessionId: "s" }, m)).toThrow(
        /Invalid selection slot/,
      )
      expect(() =>
        upsertSelection(db, identity, { slot: "bogus", sessionId: "s" }, m),
      ).toThrow(/Invalid selection slot/)
      expect(() => listSelectionsBySlot(db, identity, "bogus")).toThrow(
        /Invalid selection slot/,
      )
      expect(() => getLatestSelection(db, identity, "bogus")).toThrow(/Invalid selection slot/)
      expect(() => unlinkSelection(db, identity, "bogus", "s", m)).toThrow(
        /Invalid selection slot/,
      )
    } finally {
      db.close()
    }
  })

  test("bare research appends 1:many like research:<topic>", () => {
    const db = openInMemoryDb()
    try {
      initSchema(db)
      linkSelection(
        db,
        identity,
        { slot: "research", sessionId: "ses_res_1" },
        mutationAt("research", "ses_res_1", "2026-09-18T10:00:00.000Z"),
      )
      linkSelection(
        db,
        identity,
        { slot: "research", sessionId: "ses_res_2" },
        mutationAt("research", "ses_res_2", "2026-09-18T11:00:00.000Z"),
      )
      const rows = listSelectionsBySlot(db, identity, "research")
      expect(rows.map((row) => row.session_id)).toEqual(["ses_res_1", "ses_res_2"])
      expect(getLatestSelection(db, identity, "research")?.session_id).toBe("ses_res_2")
      expect(getSelection(db, identity, "research")?.session_id).toBe("ses_res_2")
      // Exact duplicate still throws.
      expect(() =>
        linkSelection(
          db,
          identity,
          { slot: "research", sessionId: "ses_res_1" },
          mutationAt("research", "ses_res_1", "2026-09-18T12:00:00.000Z"),
        ),
      ).toThrow(SaneDbError)
    } finally {
      db.close()
    }
  })
})
