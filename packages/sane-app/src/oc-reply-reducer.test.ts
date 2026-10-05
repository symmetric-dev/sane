import { expect, test } from "bun:test";
import type { SessionEventDurable } from "@opencode/client";
import { initialOpenCodeReplyState, openCodeIncarnation, openCodeLogItem, openCodeSyntheticKind, reduceOpenCodeReply, type OpenCodeReplyBinding } from "../shared/conversation/oc-reply-reducer";
import { isConversationUpdateCandidate, updateOccurrenceId, type ConversationUpdateCandidate } from "../shared/conversation/conversation-updates";

const createdAt = Date.parse("2026-10-01T00:00:00Z");
const restart = "The server restarted while you were working. Continue from where you left off without repeating completed work.";
const error = { type: "fixture", message: "Mock failure" };
const tokens = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } };
type Native<K extends SessionEventDurable["type"]> = Extract<SessionEventDurable, { type: K }>;

/** All fixtures use installed 2.0.18 durable envelopes/data, not V1 messages. */
function fixture(parentID?: string) {
  const creation = { eventId: "evt_created", createdAt };
  const binding: OpenCodeReplyBinding = { conversationId: "app_parent", creation,
    source: { harness: "opencode", authorityId: "mock_authority", nativeSessionId: "ses_fixture", incarnation: openCodeIncarnation(creation) } };
  let state = initialOpenCodeReplyState(binding);
  const events: SessionEventDurable[] = [], candidates: ConversationUpdateCandidate[] = [];
  function emit<K extends SessionEventDurable["type"]>(type: K, data: Omit<Native<K>["data"], "sessionID">, historical = false) {
    const seq = state.seq + 1;
    const event = { type, id: seq === 1 ? creation.eventId : `evt_${seq}`, created: createdAt + (seq === 1 ? 0 : seq),
      durable: { aggregateID: binding.source.nativeSessionId, seq, version: type === "session.deleted" || type === "session.forked" || type === "session.tool.success" || type === "session.tool.failed" || type === "session.instructions.updated" ? 2 : 1 },
      data: { sessionID: binding.source.nativeSessionId, ...data } } as unknown as Native<K>;
    events.push(event);
    const result = reduceOpenCodeReply(state, event, binding, historical);
    state = result.state;
    if (result.candidate) candidates.push(result.candidate);
    return result;
  }
  emit("session.created", { projectID: "project_fixture", location: { directory: "/fixture" }, slug: "fixture", version: "2.0.18", ...(parentID ? { parentID } : {}) });
  const start = () => emit("session.execution.started", {});
  const step = (assistantMessageID = "msg_final") => emit("session.step.started", { assistantMessageID, agent: "build", model: { providerID: "mock", id: "mock" }, started: createdAt });
  const text = (assistantMessageID = "msg_final", value = "Actual parent reply", ordinal = 0) => {
    emit("session.text.started", { assistantMessageID, ordinal });
    return emit("session.text.ended", { assistantMessageID, ordinal, text: value });
  };
  const end = (assistantMessageID = "msg_final", finish: Native<"session.step.ended">["data"]["finish"] = "stop") => emit("session.step.ended", { assistantMessageID, finish, cost: 0, tokens });
  const success = (historical = false) => emit("session.execution.succeeded", {}, historical);
  const reply = (messageID = "msg_final", historical = false) => { start(); step(messageID); text(messageID); end(messageID); return success(historical); };
  const user = () => {
    emit("session.inbox.enqueued", { inboxID: "inbox_user", item: { type: "user", payload: { text: "Mock user input" }, delivery: "queue" } });
    emit("session.inbox.delivered", { inboxID: "inbox_user" });
  };
  return { binding, emit, events, candidates, start, step, text, end, success, reply, user, state: () => state };
}

test("only execution terminal after a complete last stop step yields stable reply metadata", () => {
  const f = fixture(); f.user(); f.start(); f.step();
  expect(f.text().candidate).toBeUndefined();
  expect(f.end().candidate).toBeUndefined();
  const before = structuredClone(f.state());
  const { candidate } = f.success();
  expect(candidate).toMatchObject({ kind: "reply", messageId: "msg_final", nativeBoundaryId: f.events.at(-1)!.id, sourceSequence: f.state().seq });
  expect(candidate!.id).toBe(updateOccurrenceId(f.binding.source, f.events.at(-1)!.id));
  expect(isConversationUpdateCandidate(candidate)).toBe(true);
  expect(reduceOpenCodeReply(before, f.events.at(-1), f.binding).candidate).toEqual(candidate);
  expect(f.state().window).toBeUndefined();
  expect(JSON.stringify(candidate)).not.toContain("Actual parent reply");
});

test("tool/commentary intermediate steps never alert and only final model text is used", () => {
  const f = fixture(); f.start(); f.step("msg_tool"); f.text("msg_tool", "Intermediate commentary");
  f.emit("session.tool.input.started", { assistantMessageID: "msg_tool", id: "tool_fixture", name: "mock" });
  f.end("msg_tool", "tool-calls");
  expect(f.candidates).toEqual([]);
  f.step(); f.text(); f.end();
  expect(f.success().candidate?.messageId).toBe("msg_final");
});

for (const final of ["reasoning", "textless", "blank", "incomplete", "tool", "length"] as const) {
  test(`last ${final} step cannot borrow earlier commentary`, () => {
    const f = fixture(); f.start(); f.step("msg_commentary"); f.text("msg_commentary"); f.end("msg_commentary"); f.step();
    if (final === "reasoning") {
      f.emit("session.reasoning.started", { assistantMessageID: "msg_final", ordinal: 0 });
      f.emit("session.reasoning.ended", { assistantMessageID: "msg_final", ordinal: 0, text: "Internal reasoning only" });
    } else if (final === "blank") f.text("msg_final", "  \n ");
    else if (final === "incomplete") f.emit("session.text.started", { assistantMessageID: "msg_final", ordinal: 0 });
    else if (final === "tool" || final === "length") {
      f.text();
      if (final === "tool") f.emit("session.tool.input.started", { assistantMessageID: "msg_final", id: "tool_fixture", name: "mock" });
    }
    f.end("msg_final", final === "length" ? "length" : "stop");
    expect(f.success().candidate).toBeUndefined();
  });
}

test("parent synthetic continuation produces distinct reply without new user or App admission", () => {
  const f = fixture(); const first = f.reply().candidate!;
  f.emit("session.synthetic", { text: "Background result ready", description: "arbitrary native description", metadata: { arbitrary: "not a fabricated worker whitelist" } });
  const second = f.reply("msg_continuation").candidate!;
  expect(second.kind).toBe("reply"); expect(second.messageId).toBe("msg_continuation");
  expect(second.id).not.toBe(first.id); expect(second.sourceSequence!).toBeGreaterThan(first.sourceSequence!);
  expect(f.events.some(event => event.type === "session.inbox.enqueued")).toBe(false);
  const third = f.reply("msg_autonomous").candidate!;
  expect(third.id).not.toBe(second.id);
});

for (const payload of [
  { text: "Framework instructions", metadata: { sane: "framework" } },
  { text: restart, metadata: { notice: "restart" } },
  { text: "Background result ready" },
]) {
  test(`synthetic input itself yields no candidate: ${payload.text.slice(0, 24)}`, () => {
    const f = fixture(); f.start(); f.step(); f.text(); f.end();
    expect(f.emit("session.synthetic", payload).candidate).toBeUndefined();
    expect(f.success().candidate).toBeUndefined();
    f.emit("session.synthetic", payload); f.start();
    expect(f.emit("session.execution.failed", { error }).candidate).toBeUndefined();
  });
  test(`control/result notice before genuine final model step does not suppress reply: ${payload.text.slice(0, 24)}`, () => {
    const f = fixture(); f.start(); f.emit("session.synthetic", payload); f.step(); f.text(); f.end();
    expect(f.success().candidate?.kind).toBe("reply");
  });
}

test("delivered native synthetic inbox input permits a parent continuation", () => {
  const f = fixture(); f.reply();
  f.emit("session.inbox.enqueued", { inboxID: "inbox_result", item: { type: "synthetic", payload: { text: "Native result", metadata: { custom: true } }, delivery: "queue" } });
  f.emit("session.inbox.delivered", { inboxID: "inbox_result" });
  expect(f.reply("msg_result").candidate?.kind).toBe("reply");
  expect(f.state().pending).toEqual({});
});

test("synthetic classifier uses only evidenced exact framework/restart markers", () => {
  expect(openCodeSyntheticKind({ text: restart, metadata: { notice: "restart" } })).toBe("control");
  expect(openCodeSyntheticKind({ text: "Not the native restart notice", metadata: { notice: "restart" } })).toBe("synthetic");
  expect(openCodeSyntheticKind({ text: "Any framework text", metadata: { sane: "framework" } })).toBe("control");
});

test("child sessions, compaction-only and unsafe reused message reopen are excluded", () => {
  const child = fixture("ses_parent"); expect(child.reply().candidate).toBeUndefined();
  const compact = fixture(); compact.start();
  compact.emit("session.compaction.started", { reason: "manual", recent: "msg_recent" }); compact.step(); compact.text(); compact.end();
  expect(compact.success().candidate).toBeUndefined();
  const ended = fixture(); ended.start(); ended.step(); ended.text(); ended.end();
  ended.emit("session.compaction.started", { reason: "manual", recent: "msg_recent" });
  ended.emit("session.compaction.ended", { reason: "manual", recent: "msg_recent", text: "Summary is not reply" });
  expect(ended.success().candidate).toBeUndefined();
  const reopen = fixture(); reopen.reply(); expect(reopen.reply().candidate).toBeUndefined();
  const overlap = fixture(); overlap.start(); overlap.start(); overlap.step(); overlap.text(); overlap.end();
  expect(overlap.success().candidate).toBeUndefined();
});

test("control move and compaction inbox terminals do not generate attention", () => {
  const f = fixture(); f.start(); f.step(); f.text(); f.end();
  f.emit("session.moved", { location: { directory: "/other" }, projectID: "project_fixture" });
  expect(f.success().candidate).toBeUndefined();
  f.emit("session.inbox.enqueued", { inboxID: "inbox_compact", item: { type: "compaction", payload: {}, delivery: "queue" } });
  f.emit("session.inbox.delivered", { inboxID: "inbox_compact" }); f.start();
  expect(f.emit("session.execution.failed", { error }).candidate).toBeUndefined();
});

test("failed/interrupted terminals are not historical replies and never borrow previous text", () => {
  const f = fixture(); const previous = f.reply().candidate!;
  f.user(); f.start();
  const failed = f.emit("session.execution.failed", { error }, true).candidate!;
  expect(failed).toMatchObject({ kind: "failed", historical: true }); expect(failed.messageId).toBeUndefined();
  expect(failed.id).not.toBe(previous.id);
  f.user(); f.start();
  const interrupted = f.emit("session.execution.interrupted", { reason: "user" }, true).candidate!;
  expect(interrupted).toMatchObject({ kind: "interrupted", historical: true }); expect(interrupted.messageId).toBeUndefined();
  for (const reason of ["shutdown", "superseded"] as const) {
    f.user(); f.start(); f.step(`msg_${reason}`); f.text(`msg_${reason}`);
    expect(f.emit("session.execution.interrupted", { reason }).candidate).toBeUndefined();
  }
});

test("content replacement is event-time replacement, not append or mutable past-terminal lookup", () => {
  const f = fixture(); f.start(); f.step(); f.text();
  f.emit("session.message.content.updated", { messageID: "msg_final", content: [{ type: "reasoning", text: "Replaced original text" }] }); f.end();
  expect(f.success().candidate).toBeUndefined();
  f.emit("session.message.content.updated", { messageID: "msg_final", content: [{ type: "text", text: "Late edit" }] });
  expect(f.candidates).toEqual([]);
  f.start(); f.step("msg_replacement");
  f.emit("session.message.content.updated", { messageID: "msg_replacement", content: [{ type: "text", text: "Durable replacement" }] }); f.end("msg_replacement");
  expect(f.success().candidate?.messageId).toBe("msg_replacement");
});

test("evidenced retry resets prior failed generation; unannounced reuse is unsafe", () => {
  const f = fixture(); f.start(); f.step(); f.text(); f.emit("session.step.failed", { assistantMessageID: "msg_final", error });
  f.emit("session.retry.scheduled", { assistantMessageID: "msg_final", attempt: 1, at: createdAt, error });
  f.step(); expect(f.state().window?.step?.generation).toBe(2); expect(f.state().window?.step?.texts).toEqual([]);
  f.text("msg_final", "Retry result"); f.end(); expect(f.success().candidate?.kind).toBe("reply");
  const unsafe = fixture(); unsafe.start(); unsafe.step(); unsafe.emit("session.step.failed", { assistantMessageID: "msg_final", error });
  unsafe.step(); unsafe.text(); unsafe.end(); expect(unsafe.success().candidate).toBeUndefined();
});

test("sequence replay and creation incarnation are stable, gaps/duplicate/foreign/unknown logs rejected", () => {
  const f = fixture(); f.reply("msg_original", true);
  let state = initialOpenCodeReplyState(f.binding); const replay: ConversationUpdateCandidate[] = [];
  for (const event of f.events) { const r = reduceOpenCodeReply(state, event, f.binding, true); state = r.state; if (r.candidate) replay.push(r.candidate); }
  expect(state).toEqual(f.state()); expect(replay).toEqual(f.candidates);
  expect(replay[0]?.sourceSequence).toBe(f.events.at(-1)!.durable.seq);
  expect(() => reduceOpenCodeReply(state, f.events.at(-1), f.binding)).toThrow();
  expect(() => reduceOpenCodeReply(initialOpenCodeReplyState(f.binding), { ...f.events[0], durable: { ...f.events[0]!.durable, seq: 2 } }, f.binding)).toThrow();
  expect(() => openCodeLogItem({ ...f.events[0], durable: { ...f.events[0]!.durable, aggregateID: "ses_foreign" } }, "ses_fixture")).toThrow();
  expect(() => openCodeLogItem({ ...f.events[0], type: "session.idle" }, "ses_fixture")).toThrow();
  expect(() => openCodeLogItem({ ...f.events[0], durable: { ...f.events[0]!.durable, version: 99 } }, "ses_fixture")).toThrow();
  const creation = { eventId: "evt_recreated", createdAt: createdAt + 1 };
  const rebound = { ...f.binding, creation, source: { ...f.binding.source, incarnation: openCodeIncarnation(creation) } };
  expect(updateOccurrenceId(rebound.source, f.events.at(-1)!.id)).not.toBe(replay[0]!.id);
  expect(() => reduceOpenCodeReply(initialOpenCodeReplyState(rebound), f.events[0], rebound)).toThrow();
});
