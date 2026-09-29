/**
 * C11 — handoff-created recipient session titles (pure, no server boot).
 *
 * When a handoff creates a new recipient session, it is titled `<Role> #<n>`
 * (e.g. `Engineering #2`): legacy `readyTitle` counting (1-based position in
 * slot order) minus the `[workstream]` prefix, which the UI renders
 * separately. Only handoff-created sessions get auto-titles; reply/attach
 * paths never rename, and a retried preparation never renames an already
 * titled session (guarded by `!session.title` at the creation site).
 */
import { describe, test, expect } from "bun:test";
import { handoffRecipientTitle, slotDisplayName, slotSessionIndex, type SlotAssignment } from "../src/handoff";
import { validateMetadata } from "../src/history";

const assignment = (id: string, phase: string, startedAt: string): SlotAssignment => ({ id, phase, startedAt });

describe("C11 recipient session naming", () => {
  test("title format is `<Role> #<n>`", () => {
    expect(handoffRecipientTitle("engineering", 2)).toBe("Engineering #2");
    expect(handoffRecipientTitle("design", 1)).toBe("Design #1");
  });

  test("display name capitalizes the role and strips research subtags", () => {
    expect(slotDisplayName("design")).toBe("Design");
    expect(slotDisplayName("engineering")).toBe("Engineering");
    expect(slotDisplayName("planning")).toBe("Planning");
    expect(slotDisplayName("execution")).toBe("Execution");
    expect(slotDisplayName("research")).toBe("Research");
    expect(slotDisplayName("research:frontend-audit")).toBe("Research");
  });

  test("index increments per slot in oldest-first order regardless of input order", () => {
    const rows = [
      assignment("c", "engineering", "2026-03-03T00:00:00.000Z"),
      assignment("a", "engineering", "2026-01-01T00:00:00.000Z"),
      assignment("b", "engineering", "2026-02-02T00:00:00.000Z"),
    ];
    expect(slotSessionIndex(rows, "engineering", "a")).toBe(1);
    expect(slotSessionIndex(rows, "engineering", "b")).toBe(2);
    expect(slotSessionIndex(rows, "engineering", "c")).toBe(3);
    expect(handoffRecipientTitle("engineering", slotSessionIndex(rows, "engineering", "c"))).toBe("Engineering #3");
  });

  test("counters are independent per slot (exact phase match)", () => {
    const rows = [
      assignment("e1", "engineering", "2026-01-01T00:00:00.000Z"),
      assignment("d1", "design", "2026-01-02T00:00:00.000Z"),
      assignment("e2", "engineering", "2026-01-03T00:00:00.000Z"),
      assignment("r1", "research:frontend-audit", "2026-01-04T00:00:00.000Z"),
      assignment("r2", "research:backend-audit", "2026-01-05T00:00:00.000Z"),
    ];
    expect(slotSessionIndex(rows, "engineering", "e2")).toBe(2);
    expect(slotSessionIndex(rows, "design", "d1")).toBe(1);
    // Research subtags share the display name but count independently.
    expect(slotSessionIndex(rows, "research:frontend-audit", "r1")).toBe(1);
    expect(slotSessionIndex(rows, "research:backend-audit", "r2")).toBe(1);
    expect(handoffRecipientTitle("research:backend-audit", 1)).toBe("Research #1");
  });

  test("ended assignments count toward the position (legacy selections persisted)", () => {
    const history = [assignment("old", "engineering", "2026-01-01T00:00:00.000Z")];
    const active = [assignment("new", "engineering", "2026-02-02T00:00:00.000Z")];
    expect(slotSessionIndex([...history, ...active], "engineering", "new")).toBe(2);
  });

  test("missing assignment falls back to 1 like legacy targetIndex", () => {
    expect(slotSessionIndex([assignment("a", "engineering", "2026-01-01T00:00:00.000Z")], "engineering", "gone")).toBe(1);
  });

  test("invalid index or empty slot throws", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => handoffRecipientTitle("engineering", bad)).toThrow();
    expect(() => handoffRecipientTitle("", 1)).toThrow();
    expect(() => slotDisplayName("")).toThrow();
  });

  test("metadata round-trips titles; untitled (existing) sessions validate untouched", () => {
    const session = (sessionId: string, nativeSessionId: string, extra?: Record<string, unknown>) => ({
      harness: "claude-code",
      nativeSessionId,
      authorityId: `sane-native-v1:cc:${"a".repeat(64)}`,
      cwd: "/repo",
      lastStatus: "unknown",
      lastRunId: null,
      sessionId,
      ...extra,
    });
    const meta = validateMetadata({
      sessions: [
        session("22222222-2222-2222-8222-222222222222", "11111111-1111-1111-8111-111111111111"),
        session("33333333-3333-3333-8333-333333333333", "44444444-4444-4444-8444-444444444444", { title: "Engineering #2" }),
      ],
      runs: [],
      reconciliationRequired: false,
    });
    expect(meta.sessions[0]!.title).toBeUndefined();
    expect(meta.sessions[1]!.title).toBe("Engineering #2");
    expect(() => validateMetadata({
      sessions: [session("22222222-2222-2222-8222-222222222222", "11111111-1111-1111-8111-111111111111", { title: "bad\ntitle" })],
      runs: [],
      reconciliationRequired: false,
    })).toThrow();
  });
});
