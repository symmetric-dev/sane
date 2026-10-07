import { expect, test } from "bun:test";
import type { BranchOperation } from "./branches";
import type { Event, Run, Session } from "./history";
import { sessionListProjection } from "./session-list-projection";
import { sessionListResponse, type SessionListResponseInput, type SessionListRow } from "./session-list-response";
import type { WorkerRecord } from "./worker-contract";

const session = (sessionId: string, fields: Partial<Session> = {}): Session => ({ sessionId, cwd: "/repo", harness: "opencode", nativeSessionId: `native-${sessionId}`, lastStatus: "completed", lastRunId: null, profileId: "profile", ...fields });
const row = (s: Session): SessionListRow => ({ session: s, availability: { canSend: true }, association: { workspaceId: null, worktreeId: null, association: "unresolved", associationReason: "not-associated" } });
const input = (rows: SessionListRow[]): SessionListResponseInput => ({ rows, runs: [], events: new Map(), indexes: sessionListProjection([], [], [], []), native: { active: {}, error: "" }, admissions: [], availability: { canSend: true } });
const wire = (value: unknown) => JSON.parse(JSON.stringify(value));
const followups = { followupPending: () => false };

test("native busy/unknown overlays preserve blocker precedence and wire omissions", () => {
  for (const harness of ["opencode", "claude-code", undefined] as const) for (const worker of [false, true]) for (const active of [false, true]) for (const error of ["", "activity unavailable"]) for (const blocked of [false, true]) {
    const s = session("one", { harness, ...(worker ? { agentKind: "worker" } : {}) });
    const r = row(s);
    r.availability = blocked ? { canSend: false, code: "startup-classifying", reason: "starting" } : { canSend: true, queueAfterRunId: "previous" };
    const read = input([r]);
    read.native = { active: active ? { "native-one": { type: "busy" } } : {}, error };
    const result = wire(sessionListResponse(read, followups)).sessions[0];
    // The original route's precedence: local blocker, unknown native state,
    // worker busy, then assistant native queue.
    const available = r.availability;
    const expectedAvailability = harness !== "opencode" || blocked ? available : error ? { canSend: false, reason: error }
      : active && worker ? { canSend: false, reason: "OpenCode worker is still active" }
      : active ? { ...available, nativeQueue: true } : available;
    expect(result.availability).toEqual(expectedAvailability);
    expect(result.lastStatus).toBe(harness === "opencode" && active ? "running" : "completed");
    expect(result.nativeActivity).toBe(harness === "opencode" ? error ? "unknown" : active ? "active" : "idle" : undefined);
    expect(Object.hasOwn(result, "nativeActivityReason")).toBe(harness === "opencode" && !!error);
    expect(Object.hasOwn(result, "queuedFollowups")).toBe(harness === "claude-code");
    for (const omitted of ["title", "admission", "branchDraft", "branchOrigin", "replacedBy", "worker", "lastRunStatus", "lastRunEndedAt", "activity", "updateSource"]) expect(Object.hasOwn(result, omitted)).toBe(false);
    expect(result.updatedAt).toBeNull();
  }
});

test("replacement, worker lineage, native status and App lifecycle metadata remain independent", () => {
  const source = session("source", { lastRunId: "run", hidden: false });
  const destination = session("destination", { lastRunId: "run" }); // Foreign last-run pointer must not leak metadata.
  const branch = { id: "branch", sourceId: "source", destinationId: "destination", state: "completed", replace: true, firstMessage: "draft" } as BranchOperation;
  const worker = { id: "worker", sessionId: "source", parent: { sessionId: "parent", runId: "parent-run", toolCallId: "tool" }, outcome: { status: "completed" } } as WorkerRecord;
  const read = input([row(source), row(destination), row(session("parent"))]);
  read.indexes = sessionListProjection([worker], [], [branch], []);
  read.runs = [{ runId: "run", sessionId: "source", cwd: "/repo", status: "completed", operation: "compact", createdAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-02T00:00:00Z" }];
  read.native.active = { "native-source": { type: "busy" } };
  const before = structuredClone(read);
  const result = wire(sessionListResponse(read, followups));
  expect(result.sessions[0]).toMatchObject({ hidden: true, replacedBy: "destination", lastStatus: "running", lastRunStatus: "completed", lastRunOperation: "compact", lastRunEndedAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-02T00:00:00.000Z", worker: { id: "worker", parent: worker.parent } });
  expect(result.sessions[1]).toMatchObject({ branchOrigin: "source", branchDraft: "draft" });
  expect(result.sessions[1]).not.toHaveProperty("lastRunStatus");
  expect(result.sessions[2].directWorkerCount).toBe(1);
  expect(read).toEqual(before);
});

test("draft suppression, derived titles, recency and recovered followups retain original semantics", () => {
  const s = session("destination", { harness: "claude-code", lastRunId: "failed" });
  const read = input([row(s)]);
  const run: Run = { runId: "failed", sessionId: s.sessionId, cwd: s.cwd, status: "failed", createdAt: "2026-01-01T00:00:00Z" };
  read.runs = [run];
  read.indexes = sessionListProjection([], [], [{ sourceId: "source", destinationId: s.sessionId, state: "completed", firstMessage: "draft" } as BranchOperation], []);
  const event = (kind: Event["kind"], data: unknown): Event => ({ seq: 1, runId: run.runId, sessionId: s.sessionId, time: "2026-01-03T00:00:00Z", kind, data });
  read.events = new Map([[run.runId, [event("submission", { text: "  Derived title \nrest" }), event("context", { source: "claude-followup", requestId: "queued", state: "queued", prompt: "followup", afterRunId: run.runId, sessionId: s.sessionId })]]]);
  const result = wire(sessionListResponse(read, followups)).sessions[0];
  expect(result.title).toBe("Derived title");
  expect(result.updatedAt).toBe("2026-01-03T00:00:00.000Z");
  expect(result.lastRunOperation).toBe("prompt");
  expect(result).not.toHaveProperty("lastRunEndedAt");
  expect(result).not.toHaveProperty("branchDraft");
  expect(result.queuedFollowups[0]).toMatchObject({ requestId: "queued", state: "not-submitted" });
  expect(sessionListResponse(read, { followupPending: () => true }).sessions[0]!.queuedFollowups![0]!.state).toBe("queued");
  s.title = "Stored title";
  expect(sessionListResponse(read, followups).sessions[0]!.title).toBe("Stored title");
});
