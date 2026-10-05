import { expect, test } from "bun:test";
import { createClaudeUpdateState, projectClaudeCommittedEvent, type ClaudeConversationUpdateState } from "./claude-conversation-updates";
import type { Event, Run, Session } from "./history";
import { consume, createRun, messagesForRun } from "../frontend/cc-reducer";
import { transcriptMessages } from "../frontend/transcript";
import type { ConversationUpdateCandidate } from "../shared/conversation/conversation-updates";

const time = (seq: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, seq)).toISOString();
const success = (patch: Record<string, unknown> = {}) => ({ type: "result", session_id: "native-A", subtype: "success", is_error: false, result: "reply", ...patch });
function fixture() {
  const run: Run = { runId: "R", sessionId: "A", cwd: "/fixture", createdAt: time(0), status: "running" };
  const session: Session = { sessionId: "A", cwd: run.cwd, harness: "claude-code", authorityId: "authority", nativeSessionId: "native-A", lastRunId: "R", lastStatus: "running" };
  const event = (seq: number, kind: Event["kind"], data: unknown, patch: Partial<Event> = {}): Event => ({ seq, time: time(seq), runId: run.runId, sessionId: session.sessionId, kind, data, ...patch });
  let state = createClaudeUpdateState();
  const candidates: ConversationUpdateCandidate[] = [];
  const feed = (...events: Event[]) => {
    const emitted: ConversationUpdateCandidate[] = [];
    for (const value of events) {
      const projection = projectClaudeCommittedEvent(session, run, value, state);
      state = projection.state; emitted.push(...projection.candidates);
    }
    candidates.push(...emitted); return emitted;
  };
  const restart = () => { state = JSON.parse(JSON.stringify(state)) as ClaudeConversationUpdateState; };
  const view = () => createRun({ id: run.runId, conversationId: session.sessionId, cwd: run.cwd, status: run.status, createdAt: run.createdAt, harness: session.harness, nativeSessionId: session.nativeSessionId, operation: run.operation });
  return { run, session, event, feed, restart, candidates, state: () => state, view };
}

test("two useful indexed results retain distinct stable IDs and transcript targets through restart and replay", () => {
  const f = fixture();
  const events = [f.event(1, "stdout", success({ result_index: 0, result: "same text" })), f.event(2, "stdout", JSON.stringify(success({ result_index: 8, result: "same text" })))];
  const first = f.feed(events[0]!);
  const before = JSON.stringify(f.state());
  f.restart();
  expect(f.feed(events[0]!)).toEqual([]);
  expect(JSON.stringify(f.state())).toBe(before);
  const second = f.feed(events[1]!);
  expect([...first, ...second].map(c => [c.nativeBoundaryId, c.messageId])).toEqual([["cc-result:R:index:0", "R:result:index:0"], ["cc-result:R:index:8", "R:result:index:8"]]);
  expect(first[0]!.id).not.toBe(second[0]!.id);
  expect(first[0]!.legacyRunId).toBeUndefined();
  expect(second[0]!.legacyRunId).toBeUndefined();
  const fresh = fixture();
  expect(fresh.feed(...events)).toEqual([...first, ...second]);
  const target = f.view(); consume(target, events);
  expect(transcriptMessages(null, [target]).map(m => [m.id, m.status, m.parts])).toEqual([
    ["R:result:index:0", "completed", [{ type: "text", text: "same text" }]],
    ["R:result:index:8", "completed", [{ type: "text", text: "same text" }]],
  ]);
  const completed = f.event(3, "status", { status: "completed" });
  const aliases = f.feed(completed);
  expect(aliases).toEqual([{ ...second[0]!, legacyRunId: "R" }]);
  expect(aliases[0]!.id).toBe(second[0]!.id);
  expect(aliases[0]!.occurredAt).toBeNull();
  expect(aliases[0]!.observedAt).toBe(time(2));
  expect(aliases[0]!.sourceSequence).toBe(2);
  f.restart(); expect(f.feed(...events, completed)).toEqual([]);
  expect(f.feed(f.event(4, "stdout", success({ result_index: 9 })))).toEqual([]);
});

for (const status of ["failed", "interrupted"] as const) test(`useful replies survive an independent ${status} run terminal`, () => {
  const f = fixture();
  const events = [f.event(1, "stdout", success({ result_index: 0 })), f.event(2, "stdout", success({ result_index: 1 })), f.event(3, "status", { status })];
  const replies = f.feed(...events.slice(0, 2));
  f.restart(); const terminal = f.feed(events[2]!);
  expect(replies.map(c => c.kind)).toEqual(["reply", "reply"]);
  expect(replies.every(c => c.legacyRunId === undefined)).toBe(true);
  expect(terminal).toHaveLength(1);
  expect(terminal[0]).toMatchObject({ kind: status, nativeBoundaryId: "cc-run:R:terminal", runId: "R", legacyRunId: "R", sourceSequence: 3 });
  expect(terminal[0]!.messageId).toBeUndefined();
  expect(new Set([...replies, ...terminal].map(c => c.id)).size).toBe(3);
  const target = f.view(); consume(target, events); target.status = status;
  const messages = transcriptMessages(null, [target]);
  for (const reply of replies) expect(messages.find(m => m.id === reply.messageId)).toMatchObject({ role: "assistant", status: "completed", parts: [{ type: "text", text: "reply" }] });
  expect(messages.at(-1)).toMatchObject({ id: "R:outcome", status, parts: [] });
  f.restart(); expect(f.feed(...events)).toEqual([]);
});

test("completed status alone, assistant chunks, Stop, imported messages, and tools never synthesize reply occurrences", () => {
  const f = fixture();
  expect(f.feed(
    f.event(1, "stdout", { type: "assistant", session_id: "native-A", message: { id: "answer", content: "chunk" } }),
    f.event(2, "hook", { payload: { hook_event_name: "Stop", session_id: "native-A" } }),
    f.event(3, "message", { messageId: "imported", role: "assistant", parts: [{ type: "text", text: "imported" }], status: "completed" }),
    f.event(4, "stdout", { type: "user", session_id: "native-A", content: [{ type: "tool_result", tool_use_id: "tool", content: "tool text" }] }),
    f.event(5, "status", { status: "completed" }),
  )).toEqual([]);
});

for (const [label, result] of [
  ["empty", success({ result_index: 0, result: "" })],
  ["whitespace", success({ result_index: 0, result: " \n\t " })],
  ["non-string", success({ result_index: 0, result: ["reply"] })],
  ["error with text", success({ result_index: 0, subtype: "error", is_error: true })],
] as const) test(`${label} result does not create a reply or completed-status alias`, () => {
  const f = fixture();
  expect(f.feed(f.event(1, "stdout", result), f.event(2, "status", { status: "completed" }))).toEqual([]);
});

test("an empty trailing successful result aliases only the last useful reply", () => {
  const f = fixture();
  const reply = f.feed(f.event(1, "stdout", success({ result_index: 0 })))[0]!;
  expect(f.feed(f.event(2, "stdout", success({ result_index: 1, result: " " })))).toEqual([]);
  expect(f.feed(f.event(3, "status", { status: "completed" }))).toEqual([{ ...reply, legacyRunId: "R" }]);
});

test("a native error does not suppress a later useful reply but prevents a completed alias", () => {
  const f = fixture();
  expect(f.feed(f.event(1, "stdout", success({ result_index: 0, subtype: "error", is_error: true })))).toEqual([]);
  expect(f.feed(f.event(2, "stdout", success({ result_index: 4 })))).toHaveLength(1);
  expect(f.feed(f.event(3, "status", { status: "completed" }))).toEqual([]);
});

for (const [label, first, invalid] of [
  ["reused indexed slot", success({ result_index: 0 }), success({ result_index: 0, uuid: "new", result: "different" })],
  ["duplicate legacy", success(), success()],
  ["legacy/indexed mix", success(), success({ result_index: 1 })],
  ["indexed/legacy mix", success({ result_index: 0 }), success()],
  ["invalid index", success({ result_index: 0 }), success({ result_index: -1 })],
  ["mismatched result identity", success({ result_index: 0 }), success({ result_index: 1, session_id: "foreign" })],
] as const) test(`${label} cannot publish another reply or alias`, () => {
  const f = fixture();
  const firstReply = f.feed(f.event(1, "stdout", first)); expect(firstReply).toHaveLength(1);
  f.restart();
  expect(f.feed(f.event(2, "stdout", invalid), f.event(3, "stdout", success({ result_index: 10 })), f.event(4, "status", { status: "completed" }))).toEqual([]);
  expect(f.state().runs.R!.sequence.integrityRejected).toBe(true);
});

test("child records with wrong identities and reused indices cannot affect root replies or completed alias", () => {
  const f = fixture();
  const reply = f.feed(f.event(1, "stdout", success({ result_index: 0 })))[0]!;
  expect(f.feed(f.event(2, "stdout", success({ result_index: 0, session_id: "foreign", parent_tool_use_id: "child", is_error: true })))).toEqual([]);
  const second = f.feed(f.event(3, "stdout", success({ result_index: 5 })))[0]!;
  expect(second.id).not.toBe(reply.id);
  expect(f.feed(f.event(4, "status", { status: "completed" }))).toEqual([{ ...second, legacyRunId: "R" }]);
});

for (const uuid of [undefined, "legacy-uuid"]) test(`validated first legacy result is replay-stable with UUID ${uuid}`, () => {
  const f = fixture(); const event = f.event(7, "stdout", success({ uuid }));
  const reply = f.feed(event)[0]!;
  expect(reply.nativeBoundaryId).toBe(`cc-result:R:legacy:${uuid ?? "seq:7"}`);
  expect(reply.messageId).toBe(`R:result:legacy:${uuid ?? "seq:7"}`);
  const fresh = fixture(); expect(fresh.feed(event)).toEqual([reply]);
  f.restart(); expect(f.feed(event)).toEqual([]);
  const target = f.view(); consume(target, [event]);
  expect(messagesForRun(target).find(m => m.id === reply.messageId)).toMatchObject({ status: "completed" });
});

test("arbitrary alias-like fields cannot replace stable per-result targets or settle assistant rows", () => {
  for (const aliases of [{ message_id: "claimed" }, { assistant_message_id: "claimed" }, { message: { id: "claimed" } }]) {
    const f = fixture(); const target = f.view();
    const events = [
      f.event(1, "stdout", { type: "assistant", session_id: "native-A", message: { id: "nearby", content: "reply" } }),
      f.event(2, "stdout", success({ result_index: 0 })),
      f.event(3, "stdout", success({ result_index: 1, ...aliases })),
      f.event(4, "stdout", { type: "assistant", session_id: "native-A", message: { id: "claimed", content: "canonical" } }),
    ];
    const replies = f.feed(...events); consume(target, events);
    target.status = "failed";
    const messages = messagesForRun(target);
    expect(replies.map(reply => reply.messageId)).toEqual(["R:result:index:0", "R:result:index:1"]);
    expect(messages.map(m => [m.id, m.status])).toEqual([["R:assistant:nearby", "failed"], ["R:assistant:claimed", "failed"], ["R:result:index:0", "completed"], ["R:result:index:1", "completed"]]);
    for (const reply of replies) {
      expect(messages.filter(m => m.id === reply.messageId)).toHaveLength(1);
      expect(messages.find(m => m.id === reply.messageId)).toMatchObject({ status: "completed", parts: [{ type: "text", text: "reply" }] });
    }
    expect(messages.find(m => m.id === "R:assistant:claimed")!.parts).toEqual([{ type: "text", text: "canonical" }]);
  }
});

test("framework required by launch must match SessionStart context; resumed runs without framework launch remain eligible", () => {
  const hook = (context: string) => ({ type: "system", subtype: "hook_response", hook_event: "SessionStart", outcome: "success", stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }) });
  for (const delivered of [false, true]) {
    const f = fixture(); f.session.saneContext = { version: 1, framework: "framework", assignment: "assignment" };
    expect(f.feed(f.event(1, "launch", { framework: { path: "/fixture/context" } }), f.event(2, "stdout", hook(delivered ? "framework\n\nassignment" : "wrong")), f.event(3, "stdout", { type: "system", subtype: "init", session_id: "native-A" }))).toEqual([]);
    f.restart();
    const candidates = f.feed(f.event(4, "stdout", success({ result_index: 0 })), f.event(5, "status", { status: "completed" }));
    expect(candidates).toHaveLength(delivered ? 2 : 0);
    expect(f.state().runs.R!.sequence.framework!.rejected).toBe(!delivered);
    if (delivered) expect(candidates[1]).toEqual({ ...candidates[0]!, legacyRunId: "R" });
  }
  const resumed = fixture(); resumed.session.saneContext = { version: 1, framework: "framework" };
  expect(resumed.feed(resumed.event(1, "launch", { framework: null }), resumed.event(2, "stdout", success({ result_index: 2 })))).toHaveLength(1);
  const missing = fixture();
  expect(missing.feed(missing.event(1, "launch", { framework: { path: "/fixture/context" } }), missing.event(2, "stdout", success({ result_index: 2 })))).toEqual([]);
});

for (const [label, patch] of [
  ["event run", { runId: "other" }], ["event session", { sessionId: "other" }], ["invalid sequence", { seq: 0 }],
] as const) test(`${label} integrity mismatch blocks later results`, () => {
  const f = fixture();
  expect(f.feed(f.event(1, "stdout", success({ result_index: 0 }), patch), f.event(2, "stdout", success({ result_index: 1 })))).toEqual([]);
  expect(f.state().runs.R!.sequence.integrityRejected).toBe(true);
});

test("immutable run source and conversation bindings gate replay after identity changes", () => {
  for (const changed of ["authorityId", "nativeSessionId", "sessionId"] as const) {
    const f = fixture(); expect(f.feed(f.event(1, "stdout", success({ result_index: 0 })))).toHaveLength(1);
    f.restart(); f.session[changed] = "changed";
    expect(f.feed(f.event(2, "stdout", success({ session_id: f.session.nativeSessionId, result_index: 1 })))).toEqual([]);
    expect(f.state().runs.R!.sequence.integrityRejected).toBe(true);
  }
  const f = fixture(); f.run.sessionId = "other";
  expect(f.feed(f.event(1, "stdout", success({ result_index: 0 })))).toEqual([]);
});

test("compact and unqualified sources create neither reply nor terminal updates", () => {
  for (const mode of ["compact", "opencode", "missing authority", "missing native"] as const) {
    const f = fixture();
    if (mode === "compact") f.run.operation = "compact";
    if (mode === "opencode") f.session.harness = "opencode";
    if (mode === "missing authority") delete f.session.authorityId;
    if (mode === "missing native") delete f.session.nativeSessionId;
    expect(f.feed(f.event(1, "stdout", success({ result_index: 0 })), f.event(2, "status", { status: "failed" }))).toEqual([]);
    expect(f.state()).toEqual(createClaudeUpdateState());
  }
});

test("launch requiring framework cannot publish a result or completion alias without hook delivery or init", () => {
  const f = fixture(); f.session.saneContext = { version: 1, framework: "framework" };
  expect(f.feed(f.event(1, "launch", { framework: { path: "/fixture/context" } }), f.event(2, "stdout", success({ result_index: 0 })), f.event(3, "status", { status: "completed" }))).toEqual([]);
});
