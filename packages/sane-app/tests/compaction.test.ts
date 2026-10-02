import { expect, test } from "bun:test";
import { normalizeClaudeCompactionBoundary, projectCompactions } from "../src/compaction";
import { compactionSnapshot, normalizeMessage, type NativeMessage } from "../src/opencode";
import type { Event, Run, Session } from "../src/history";
import type { MessageSnapshot } from "../src/oc-contract";

const t = (second = 0) => new Date(Date.UTC(2026, 9, 1, 0, 0, second)).toISOString();
const boundaryId = "11111111-1111-4111-8111-111111111111";
const session = (harness: Session["harness"] = "opencode") => ({ sessionId: "A", harness, nativeSessionId: harness === "opencode" ? "ses_A" : boundaryId });
const run = (patch: Partial<Run> = {}): Run => ({ runId: "R", sessionId: "A", cwd: "/fixture", status: "running", createdAt: t(), ...patch });
const event = (seq: number, kind: Event["kind"], data: unknown, runId = "R"): Event => ({ seq, kind, data, runId, sessionId: "A", time: t(seq) });
const native = (patch: Partial<NativeMessage> = {}): NativeMessage => ({ id: "msg_compact", type: "compaction", time: { created: Date.parse(t()), completed: Date.parse(t(2)) }, status: "completed", reason: "auto", ...patch });
const boundary = { type: "system", subtype: "compact_boundary", session_id: boundaryId, uuid: boundaryId, compact_metadata: { trigger: "auto", pre_tokens: 90000, post_tokens: 12000, custom: "retained" } };
const hook = (name: "PreCompact" | "PostCompact", patch: Record<string, unknown> = {}) => ({ event: name, payload: { hook_event_name: name, session_id: boundaryId, trigger: "auto", ...patch } });

test("OC lifecycle and reason are native evidence; summarizer usage is never context usage", () => {
  for (const status of ["running", "failed", "completed"] as const) {
    const message = normalizeMessage(native({ status, reason: "manual", summary: "summary", tokens: { input: 80000 }, cost: 0.25, preTokens: 90000, postTokens: 12000, durationMs: 2000 }))!;
    expect(message).toMatchObject({ role: "system", parts: [], compaction: { lifecycle: status, trigger: "manual", summary: "summary", preTokens: 90000, postTokens: 12000, durationMs: 2000, summaryUsage: { cost: 0.25, tokens: { input: 80000 } } } });
    expect(message.contextReset === true).toBe(status === "completed");
    expect(message.usage).toBeUndefined();
  }
  expect(normalizeMessage(native({ reason: "unrecognized" }))!.compaction!.trigger).toBe("unknown");
});

test("OC exact admitted failure wins over idle succeeded; unrelated/missing/conflicting IDs cannot confirm", () => {
  const failed = native({ status: "failed", error: { message: "summary failed" } });
  const history = [native({ id: "msg_other" }), failed, { id: "msg_idle", type: "idle", outcome: "succeeded", time: { created: Date.parse(t(3)) } }];
  expect(compactionSnapshot(history, "msg_compact")).toMatchObject({ outcome: "failed", compaction: { lifecycle: "failed", error: { message: "summary failed" } } });
  expect(compactionSnapshot(history, "msg_missing")).toEqual({ messages: [] });
  expect(compactionSnapshot([failed, failed], "msg_compact").messages).toHaveLength(1);
  expect(() => compactionSnapshot([failed, native()], "msg_compact")).toThrow("Conflicting native compaction identity");
});

test("coalesced and late OC requests retain client identities and exact terminal outcome through stale replay", () => {
  const first = run({ operation: "compact", compact: { requestId: "client-first", instructions: undefined, nativeRequestId: "msg_requested_first", nativeAdmittedId: "msg_compact" }, nativeCommandId: "msg_requested_first", status: "completed" });
  const second = run({ runId: "R2", operation: "compact", compact: { requestId: "client-second", nativeRequestId: "msg_requested_second", nativeAdmittedId: "msg_compact" }, nativeCommandId: "msg_requested_second", status: "completed", createdAt: t(4) });
  const completed = normalizeMessage(native())!;
  const stale = normalizeMessage(native({ status: "running", time: { created: Date.parse(t()) } }))!;
  const records = projectCompactions(session(), [first, second], [event(1, "message", normalizeMessage(native({ id: "msg_unrelated", status: "failed" }))!), event(2, "message", completed), event(3, "message", stale)], [stale]);
  for (const [index, request] of [first.compact!, second.compact!].entries()) {
    expect(records.find(r => r.requestId === request.requestId)).toMatchObject({ requestId: request.requestId, nativeRequestId: request.nativeRequestId, nativeAdmittedId: "msg_compact", nativeId: "msg_compact", lifecycle: "completed", contextReset: true, runId: index === 0 ? "R" : "R2" });
  }
  expect(records.filter(r => r.requestId)).toHaveLength(2);
  expect(records.find(r => r.nativeId === "msg_unrelated")!.lifecycle).toBe("failed");
});

test("CC hooks/status/boundary deduplicate; committed reset survives interruption and old boundary cannot steal a new attempt", () => {
  const cc = session("claude-code");
  const events = [
    event(1, "hook", hook("PreCompact")),
    event(2, "stdout", { type: "system", subtype: "status", session_id: boundaryId, uuid: "status-1", status: "compacting" }),
    event(3, "stdout", boundary),
    event(4, "hook", hook("PostCompact", { compact_summary: "first summary" })),
    event(5, "hook", hook("PreCompact")),
    event(6, "stdout", boundary),
    event(7, "hook", hook("PostCompact", { compact_result: "failed", compact_error: "second failed" })),
    event(8, "stdout", { ...boundary, uuid: "22222222-2222-4222-8222-222222222222", parent_tool_use_id: "child" }),
    event(9, "hook", hook("PostCompact", { agent_id: "child", compact_result: "success" })),
  ];
  const records = projectCompactions(cc, [run({ status: "interrupted" })], [...events, events[2]!], [normalizeClaudeCompactionBoundary(boundary, boundaryId)!]);
  expect(records).toHaveLength(2);
  expect(records[0]).toMatchObject({ nativeId: boundaryId, lifecycle: "completed", contextReset: true, summary: "first summary", preTokens: 90000 });
  expect(records[1]).toMatchObject({ lifecycle: "failed", contextReset: false, error: "second failed" });
  const { session_id: _, compact_metadata: metadata, ...raw } = boundary;
  expect(normalizeClaudeCompactionBoundary({ ...raw, sessionId: boundaryId, compactMetadata: metadata }, boundaryId)).toEqual(normalizeClaudeCompactionBoundary(boundary, boundaryId));
  expect(normalizeClaudeCompactionBoundary({ ...boundary, session_id: "other" }, boundaryId)).toBeUndefined();
});

test("structured non-admission is failed/skipped, ordinary terminal status stays unconfirmed, committed evidence wins", () => {
  const request = run({ operation: "compact", compact: { requestId: "client", nativeRequestId: "msg_compact" }, nativeCommandId: "msg_compact", status: "interrupted" });
  for (const [proof, status, lifecycle] of [
    [{ compactAdmissionRejected: true, nativeStatus: 409 }, "failed", "failed"],
    [{ compactNotSubmitted: true }, "interrupted", "skipped"],
    [{ compactNotSubmitted: true }, "failed", "failed"],
    [{}, "failed", "unconfirmed"],
  ] as const) {
    const evidence = [event(1, "status", { operation: "compact", status: "running", reason: "not admitted", ...proof }), event(2, "status", { status, reason: "settled" })];
    const records = projectCompactions(session(), [{ ...request, status }], evidence);
    expect(records[0]).toMatchObject({ lifecycle, contextReset: false });
    if (lifecycle !== "unconfirmed") expect(records[0]!.error).toBe("not admitted");
  }
  const committed: MessageSnapshot = normalizeMessage(native())!;
  expect(projectCompactions(session(), [request], [event(1, "message", committed), event(2, "status", { operation: "compact", status: "interrupted", compactNotSubmitted: true })])[0]).toMatchObject({ lifecycle: "completed", contextReset: true });
});
