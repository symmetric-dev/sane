import { expect, test } from "bun:test";
import { consume, createRun } from "../shared/conversation/cc-reducer";
import { transcriptMessages } from "../shared/conversation/transcript";
import type { ReconciledHistory } from "../shared/conversation/native-history-contract";
import type { Run as DisplayRun } from "../shared/conversation/types";
import type { MessageSnapshot } from "./oc-contract";
import type { Run, Session } from "./history";
import { TranscriptService } from "./transcript-service";

const time = (n = 0) => new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString();
const snapshot = (id: string, role: MessageSnapshot["role"], text = id, n = 1): MessageSnapshot => ({ messageId: id, role, createdAt: time(n), status: "completed", parts: [{ id: `${id}:text`, type: "text", text }] });
const history = (messages: MessageSnapshot[]): ReconciledHistory => ({ sessionId: "A", nativeSessionId: "ses_A", importedAt: time(10), activity: "active", reason: "mock observation", coveredRunIds: [], observation: true, messages });
const run = (id: string, nativeCommandId?: string, status: DisplayRun["status"] = "completed") => createRun({ id, conversationId: "A", cwd: "/fixture", harness: "opencode", nativeSessionId: "ses_A", nativeCommandId, status, createdAt: time() });
const event = (r: DisplayRun, seq: number, kind: string, data: unknown) => ({ runId: r.id, sessionId: r.conversationId, seq, kind, data, time: time(seq) });
const ids = (messages: ReturnType<typeof transcriptMessages>) => messages.map(m => [m.id, m.runId]);

test("restart continuation synthetic and new assistant remain native-import after a completed App run", () => {
  const r = run("R", "msg_command");
  consume(r, [event(r, 1, "submission", { messageId: "msg_command", text: "prompt" }), event(r, 2, "message", snapshot("msg_old_answer", "assistant", "old answer"))]);
  const observed = history([snapshot("msg_command", "user", "prompt"), snapshot("msg_old_answer", "assistant", "old answer"), snapshot("msg_restart", "system", "The server restarted while you were working. Continue from where you left off without repeating completed work."), snapshot("msg_continued", "assistant", "new answer")]);
  expect(ids(transcriptMessages(observed, [r]))).toEqual([["msg_command", "R"], ["msg_old_answer", "R"], ["msg_restart", "native-import"], ["msg_continued", "native-import"]]);
});

test("exact journaled native alias refreshes full content but retains canonical App identity and aliases", () => {
  const r = run("R");
  r.messages.push({ id: "canonical-answer", nativeIds: ["msg_alias", "another-alias"], runId: "R", role: "assistant", parts: [{ type: "text", text: "stale" }], time: time(), status: "running" });
  const fresh = snapshot("msg_alias", "assistant", "full fresh content", 2);
  fresh.parts.push({ id: "call", type: "tool", name: "Read", status: "completed", input: { path: "a" }, output: { nested: ["complete"] } });
  const projected = transcriptMessages(history([snapshot("msg_external", "user"), fresh]), [r]);
  expect(ids(projected)).toEqual([["msg_external", "native-import"], ["canonical-answer", "R"]]);
  expect(projected[1]).toMatchObject({ id: "canonical-answer", runId: "R", nativeIds: ["msg_alias", "another-alias"], time: time(2), status: "completed", parts: [{ type: "text", text: "full fresh content" }, { type: "tool", id: "call", toolCallId: "call", input: { path: "a" }, output: { nested: ["complete"] }, toolStatus: "completed" }] });
  expect(r.messages[0]!.parts).toEqual([{ type: "text", text: "stale" }]);
});

test("pending nativeCommandId submission stays once at tail then follows native delivery order, not admission clock", () => {
  const completed = run("R1", "msg_first"), queued = run("R2", "msg_queued", "running");
  queued.nativeDelivery = "queue";
  consume(completed, [event(completed, 1, "submission", { messageId: "msg_first", text: "first" }), event(completed, 2, "message", snapshot("msg_answer", "assistant", "answer", 4))]);
  consume(queued, [event(queued, 1, "submission", { messageId: "msg_queued", text: "queued" })]);
  const initial = [snapshot("msg_first", "user", "first"), snapshot("msg_answer", "assistant", "answer", 4)];
  expect(ids(transcriptMessages(history(initial), [completed, queued]))).toEqual([["msg_first", "R1"], ["msg_answer", "R1"], ["msg_queued", "R2"]]);
  const delivered = [...initial, snapshot("msg_queued", "user", "queued", 2), snapshot("msg_external_answer", "assistant", "unclaimed", 5)];
  expect(ids(transcriptMessages(history(delivered), [completed, queued]))).toEqual([["msg_first", "R1"], ["msg_answer", "R1"], ["msg_queued", "R2"], ["msg_external_answer", "native-import"]]);
});

test("later native-anchored App message is emitted at its native position, not prematurely after its run's first turn", () => {
  const r = run("R", "msg_first");
  consume(r, [event(r, 1, "submission", { messageId: "msg_first", text: "first" }), event(r, 2, "message", snapshot("msg_first_answer", "assistant")), event(r, 3, "message", snapshot("msg_later_answer", "assistant", "journaled later"))]);
  const observed = history([snapshot("msg_first", "user", "first"), snapshot("msg_first_answer", "assistant"), snapshot("msg_external", "user"), snapshot("msg_later_answer", "assistant", "fresh later")]);
  const projected = transcriptMessages(observed, [r]);
  expect(ids(projected)).toEqual([["msg_first", "R"], ["msg_first_answer", "R"], ["msg_external", "native-import"], ["msg_later_answer", "R"]]);
  expect(projected[3]!.parts).toEqual([{ type: "text", text: "fresh later" }]);
});

test("unowned same-text native assistant cannot suppress an App terminal result fallback", () => {
  const r = run("R", "msg_command"); r.result = "same answer";
  consume(r, [event(r, 1, "submission", { messageId: "msg_command", text: "prompt" })]);
  const projected = transcriptMessages(history([snapshot("msg_command", "user", "prompt"), snapshot("msg_unowned", "assistant", "same answer")]), [r]);
  expect(ids(projected)).toEqual([["msg_command", "R"], ["msg_unowned", "native-import"], ["R:result", "R"]]);
  expect(projected[2]!.parts).toEqual([{ type: "text", text: "same answer" }]);
});

test("TranscriptService live provider preserves epoch/cursors for append and in-place UPSERT, resets for structural changes", async () => {
  const session: Session = { sessionId: "A", harness: "opencode", nativeSessionId: "ses_A", authorityId: "mock", cwd: "/fixture", lastStatus: "unknown", lastRunId: null };
  let observed = history([snapshot("msg_one", "user"), snapshot("msg_two", "user")]);
  const service = new TranscriptService(() => [session], () => [], { get: async () => observed });
  const first = await service.page(session, new URLSearchParams({ limit: "1" }));
  expect(first.nativeHistoryImportedAt).toBeUndefined();
  observed = history([snapshot("msg_one", "user"), snapshot("msg_two", "user", "full replacement"), snapshot("msg_three", "user")]);
  const appended = await service.page(session, new URLSearchParams());
  expect(appended.epoch).toBe(first.epoch); expect(appended.revision).not.toBe(first.revision);
  expect(appended.messages.map(m => m.id)).toEqual(["msg_one", "msg_two", "msg_three"]);
  expect((await service.page(session, new URLSearchParams({ cursor: first.coverage.olderCursor! }))).messages.map(m => m.id)).toEqual(["msg_one"]);
  const refreshed = await service.refresh(session, { epoch: first.epoch, messages: first.messages.map(({ id, version }) => ({ id, version })) });
  expect(refreshed.upserts).toEqual([appended.messages[1]!]); expect(refreshed.removedIds).toEqual([]);
  observed = history([snapshot("msg_one", "user"), snapshot("msg_inserted", "user"), ...observed.messages.slice(1)]);
  const inserted = await service.page(session, new URLSearchParams()); expect(inserted.epoch).not.toBe(appended.epoch);
  await expect(service.page(session, new URLSearchParams({ cursor: first.coverage.olderCursor! }))).rejects.toMatchObject({ status: 409, code: "transcript-reset" });
  observed = history([snapshot("msg_one", "user")]);
  expect((await service.page(session, new URLSearchParams())).epoch).not.toBe(inserted.epoch);
});

test("TranscriptService provider failure rejects the request rather than presenting a fabricated successful empty projection", async () => {
  const session: Session = { sessionId: "A", harness: "opencode", nativeSessionId: "ses_A", authorityId: "mock", cwd: "/fixture", lastStatus: "unknown", lastRunId: null };
  const stored: Run[] = [];
  let fail = false;
  const provider = { get: async () => { if (fail) throw new Error("native unavailable"); return history([snapshot("msg_one", "user")]); } };
  const service = new TranscriptService(() => [session], () => stored, provider);
  const first = await service.page(session, new URLSearchParams()); fail = true;
  await expect(service.page(session, new URLSearchParams())).rejects.toThrow("native unavailable");
  fail = false; expect((await service.page(session, new URLSearchParams())).messages).toEqual(first.messages);
});
