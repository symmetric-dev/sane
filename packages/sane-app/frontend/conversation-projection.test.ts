import { describe, expect, test } from "bun:test";
// These paths are the compatibility API, even if the projection moves elsewhere.
import { consume, createRun, messagesForRun } from "./cc-reducer";
import { messagesWithPendingTurn, transcriptMessages } from "./transcript";
import { contextUsageFor } from "./context-usage";
import { compactionPositions } from "./compaction";
import { receivedHandoff, sentHandoffs } from "./handoff-presentation";
import type { DiagnosticEvent, Message, ModelChoice, Run, RunMetadata, ToolPart } from "./types";
import type { CompactionRecord, MessageSnapshot } from "../src/oc-contract";
import type { ReconciledHistory } from "../src/reconcile";
import type { HandoffPresentation } from "../src/handoff-contract";

const time = (second = 0) => new Date(Date.UTC(2026, 9, 1, 0, 0, second)).toISOString();
const run = (patch: Partial<RunMetadata> = {}) => createRun({ id: "R", conversationId: "A", nativeSessionId: "native-A", harness: "claude-code", cwd: "/fixture", status: "running", createdAt: time(), ...patch });
const event = (seq: number, kind: string, data: unknown, patch: Partial<DiagnosticEvent> = {}): DiagnosticEvent => ({ seq, kind, data, runId: "R", sessionId: "A", time: time(seq), ...patch });
const feed = (target: Run, seq: number, kind: string, data: unknown, second = seq) => consume(target, [event(seq, kind, data, { runId: target.id, time: time(second) })]);
const raw = (content: unknown, patch: Record<string, unknown> = {}) => ({ type: "assistant", session_id: "native-A", uuid: "uuid-answer", message: { id: "answer", content }, ...patch });
const snapshot = (id: string, role: MessageSnapshot["role"] = "assistant", second = 1, patch: Partial<MessageSnapshot> = {}): MessageSnapshot => ({ messageId: id, role, parts: [{ id: `${id}:text`, type: "text", text: id }], status: "completed", createdAt: time(second), ...patch });
const history = (messages: MessageSnapshot[], patch: Partial<ReconciledHistory> = {}): ReconciledHistory => ({ sessionId: "A", nativeSessionId: "native-A", importedAt: time(20), activity: "idle", reason: "fixture", coveredRunIds: [], messages, ...patch });
const models: ModelChoice[] = [{ id: "provider/model", name: "Model", efforts: [], contextWindow: 1000 }];
const usageMessage = (id: string, second: number, input: number, patch: Partial<MessageSnapshot> = {}) => snapshot(id, "assistant", second, { model: "provider/model", usage: { tokens: { input, output: 9000, cache: { read: 20, write: 30 } } }, ...patch });
const boundary = (id = "boundary", second = 2): MessageSnapshot => snapshot(id, "system", second, { parts: [], contextReset: true, compaction: { nativeId: id, trigger: "auto", lifecycle: "completed", summaryUsage: { tokens: { input: 9999 } } } });
const compact = (id: string, patch: Partial<CompactionRecord> = {}): CompactionRecord => ({ id, sessionId: "A", harness: "opencode", trigger: "auto", lifecycle: "completed", contextReset: true, ...patch });
const view = (id: string, second = 1, patch: Partial<Message> = {}): Message => ({ id, runId: "native-import", role: "assistant", parts: [{ type: "text", text: id }], time: time(second), status: "completed", ...patch });

describe("CC reducer compatibility", () => {
  test("wrong associations do not consume a sequence; accepted replay is first-write-wins", () => {
    const target = run();
    const accepted = event(7, "submission", { messageId: "user", text: "accepted" });
    consume(target, [{ ...accepted, runId: "other" }, { ...accepted, sessionId: "other" }]);
    expect(target.seen.size).toBe(0);
    consume(target, [accepted, { ...accepted, data: { messageId: "user", text: "replayed change" } }]);
    expect(target.events).toEqual([accepted]);
    expect([...target.seen]).toEqual([7]);
    expect(target.messages[0]?.parts).toEqual([{ type: "text", text: "accepted" }]);
  });

  test("raw chunks retain incomplete JSON, merge content blocks, and preserve UUID aliases", () => {
    const target = run();
    const encoded = JSON.stringify(raw([{ type: "text", text: "hello" }, { type: "thinking", thinking: "consider" }]));
    feed(target, 1, "stdout", `not JSON\n${encoded.slice(0, 30)}`);
    expect(target.messages).toEqual([]);
    expect(target.buffer).toBe(encoded.slice(0, 30));
    feed(target, 2, "stdout", encoded.slice(30));
    feed(target, 3, "stdout", `${JSON.stringify(raw([{ type: "text", text: "hello" }, { type: "tool_use", id: "call", name: "Read", input: { path: "a" } }], { uuid: "uuid-tool" }))}\n`);
    expect(target.buffer).toBe("");
    expect(target.messages).toHaveLength(1);
    expect(target.messages[0]).toMatchObject({ id: "R:assistant:answer", nativeIds: ["uuid-answer", "uuid-tool"], parts: [{ type: "text", text: "hello" }, { type: "reasoning", text: "consider" }, { type: "tool", id: "R:call", toolCallId: "call", name: "Read", input: { path: "a" } }] });
  });

  test("tool results arriving before calls survive later block replacement", () => {
    const target = run();
    feed(target, 1, "stdout", { type: "user", session_id: "native-A", content: [{ type: "tool_result", tool_use_id: "call", content: [{ type: "text", text: "denied" }], is_error: true }] });
    feed(target, 2, "stdout", raw([{ type: "tool_use", id: "call", name: "Read", input: { path: "a" } }]));
    feed(target, 3, "stdout", raw([{ type: "tool_use", id: "call", name: "Read", input: { path: "b" } }], { uuid: "uuid-update" }));
    expect(target.messages[0]?.parts).toEqual([{ type: "tool", id: "R:call", toolCallId: "call", name: "Read", input: { path: "b" }, output: [{ type: "text", text: "denied" }], error: true }]);
    expect(target.messages.some(message => message.role === "user")).toBe(false);
  });

  test("hooks require root native ownership, deduplicate effort, and hydrate failed tools", () => {
    const target = run();
    const hook = { session_id: "native-A", hook_event_name: "UserPromptSubmit", prompt: "hook prompt", effort: { level: "high" } };
    feed(target, 1, "hook", { payload: { ...hook, session_id: "foreign" } });
    feed(target, 2, "hook", { payload: { ...hook, agent_id: "child" } });
    feed(target, 3, "hook", JSON.stringify({ payload: hook }));
    feed(target, 4, "hook", { payload: { ...hook, prompt: "not a replacement" } });
    feed(target, 5, "hook", { payload: { session_id: "native-A", hook_event_name: "PostToolUseFailure", tool_use_id: "call", error: "failed" } });
    feed(target, 6, "stdout", raw([{ type: "tool_use", id: "call", name: "Read", input: {} }]));
    expect(target.observedEfforts).toEqual(["high"]);
    expect(target.messages[0]?.parts).toEqual([{ type: "text", text: "hook prompt" }]);
    expect(target.messages[1]?.parts[0]).toMatchObject({ output: "failed", error: true });
  });

  test("result identity is deduplicated, first usage is retained, and result text is fallback only", () => {
    const target = run({ status: "completed" });
    const result = { type: "result", session_id: "native-A", uuid: "result", result: "fallback", usage: { input_tokens: 1 } };
    feed(target, 1, "stdout", { ...result, session_id: "foreign" });
    feed(target, 2, "stdout", result);
    feed(target, 3, "stdout", { ...result, result: "latest fallback", usage: { input_tokens: 9 } });
    expect(target.resultCount).toBe(1);
    expect(target.usage?.record).toEqual(result);
    expect(messagesForRun(target).map(message => message.id)).toEqual(["R:result"]);
    expect(messagesForRun(target)[0]?.parts).toEqual([{ type: "text", text: "latest fallback" }]);
    feed(target, 4, "stdout", raw("canonical"));
    expect(messagesForRun(target).map(message => message.id)).toEqual(["R:assistant:answer"]);
  });

  test("normalized UPSERTs replace parts; terminal run status settles active but not completed snapshots", () => {
    const target = run({ harness: "opencode" });
    feed(target, 1, "message", snapshot("answer", "assistant", 1, { status: "running", parts: [{ id: "reason", type: "reasoning", text: "thinking" }, { id: "call", type: "tool", name: "Read", status: "error", error: "denied" }] }));
    expect(target.messages[0]?.parts).toEqual([{ type: "reasoning", id: "reason", text: "thinking" }, { type: "tool", id: "call", toolCallId: "call", name: "Read", input: undefined, toolStatus: "error", output: "denied", error: true }]);
    feed(target, 2, "message", snapshot("answer", "assistant", 1, { status: "running" }));
    feed(target, 3, "message", snapshot("finished"));
    feed(target, 4, "status", { connection: "reconnecting", reason: "retry" });
    expect(target.nativeConnection).toBe("reconnecting");
    feed(target, 5, "status", { status: "failed", reason: "closed" });
    expect(target.nativeConnection).toBeUndefined();
    expect(target.nativeReason).toBe("closed");
    target.status = "failed";
    const projected = messagesForRun(target);
    expect(projected.map(message => [message.id, message.status])).toEqual([["answer", "failed"], ["finished", "completed"]]);
    expect(projected[0]?.parts).toEqual([{ type: "text", text: "answer" }]);
    expect(target.messages[0]?.status).toBe("running");
  });

  test("compact runs retain diagnostics but never create a conversation turn or result fallback", () => {
    const target = run({ operation: "compact", status: "completed" });
    feed(target, 1, "submission", { text: "/compact" });
    feed(target, 2, "stdout", raw("summary"));
    feed(target, 3, "stdout", { type: "result", session_id: "native-A", result: "summary" });
    feed(target, 4, "message", boundary());
    expect(target.events).toHaveLength(4);
    expect(target.messages).toEqual([]);
    expect(target.resultCount).toBe(0);
    expect(messagesForRun(target)).toEqual([]);
  });
});

describe("native/App transcript ownership", () => {
  test("CC assistant UUID anchors one turn without duplicating the equal App submission", () => {
    const target = run({ status: "completed" });
    feed(target, 1, "submission", { messageId: "app-user", text: "prompt" });
    feed(target, 2, "stdout", raw("reply"));
    const imported = history([snapshot("native-user", "user", 1, { parts: [{ id: "p", type: "text", text: "prompt" }] }), snapshot("uuid-answer", "assistant", 2)]);
    expect(transcriptMessages(imported, [target]).map(message => [message.id, message.runId])).toEqual([["app-user", "R"], ["R:assistant:answer", "R"]]);
  });

  test("OC exact command ID owns its native response while changed prompt text stays visible", () => {
    const target = run({ harness: "opencode", nativeCommandId: "command", status: "completed" });
    feed(target, 1, "submission", { messageId: "app-user", text: "original prompt" });
    const imported = history([snapshot("command", "user", 1, { parts: [{ id: "p", type: "text", text: "native prompt" }] }), snapshot("response", "assistant", 2)]);
    expect(transcriptMessages(imported, [target]).map(message => [message.id, message.runId])).toEqual([["app-user", "R"], ["command", "R"], ["response", "R"]]);
  });

  test("equal prompts alone prove no ownership and native array order wins over timestamps", () => {
    const target = run({ harness: "opencode" });
    feed(target, 1, "submission", { messageId: "app-user", text: "repeat" });
    const imported = history([snapshot("external-user", "user", 9, { parts: [{ id: "p", type: "text", text: "repeat" }] }), snapshot("external-response", "assistant", 1), snapshot("later-user", "user", 2)]);
    expect(transcriptMessages(imported, [target]).map(message => [message.id, message.runId])).toEqual([["external-user", "native-import"], ["external-response", "native-import"], ["later-user", "native-import"], ["app-user", "R"]]);
  });

  test("conflicting command and message owners do not infer ownership for unrecorded native parts", () => {
    const commandOwner = run({ id: "command-owner", harness: "opencode", nativeCommandId: "command" });
    const responseOwner = run({ id: "response-owner", harness: "opencode" });
    feed(commandOwner, 1, "submission", { messageId: "app-user", text: "prompt" });
    feed(responseOwner, 2, "message", snapshot("response"));
    const imported = history([snapshot("command", "user"), snapshot("response"), snapshot("unrecorded")]);
    expect(transcriptMessages(imported, [commandOwner, responseOwner]).map(message => [message.id, message.runId])).toEqual([["command", "native-import"], ["response", "response-owner"], ["unrecorded", "native-import"], ["app-user", "command-owner"]]);
  });

  test("legacy coverage cannot drop rejected submissions before the next proven App turn", () => {
    const rejected = run({ id: "rejected", harness: "opencode", status: "failed" });
    const accepted = run({ id: "accepted", harness: "opencode", nativeCommandId: "command", status: "completed" });
    feed(rejected, 1, "submission", { messageId: "rejected-user", text: "reject" });
    feed(accepted, 2, "submission", { messageId: "accepted-user", text: "accept" });
    const imported = history([snapshot("command", "user", 3, { parts: [{ id: "p", type: "text", text: "accept" }] }), snapshot("response", "assistant", 4)], { coveredRunIds: ["rejected", "accepted"] });
    const messages = transcriptMessages(imported, [rejected, accepted]);
    expect(messages.map(message => message.id)).toEqual(["rejected-user", "rejected:empty", "accepted-user", "response"]);
    expect(messages[1]).toMatchObject({ status: "failed", parts: [{ type: "text", text: "No assistant response was recorded for this run." }] });
  });

  test("native output removes successful empty fallback but preserves failed and interrupted warnings", () => {
    for (const status of ["completed", "failed", "interrupted"] as const) {
      const target = run({ harness: "opencode", nativeCommandId: "command", status });
      const messages = transcriptMessages(history([snapshot("command", "user"), snapshot("response")]), [target]);
      expect(messages.map(message => message.id)).toEqual(status === "completed" ? ["command", "response"] : ["command", "response", "R:empty"]);
      if (status !== "completed") expect(messages[2]).toMatchObject({ status, parts: [] });
    }
    const target = run({ harness: "opencode", status: "failed" });
    feed(target, 1, "message", snapshot("completed-before-failure"));
    expect(transcriptMessages(null, [target]).map(message => [message.id, message.status, message.parts.length])).toEqual([["completed-before-failure", "completed", 1], ["R:outcome", "failed", 0]]);
  });

  test("pending turns retire by run identity, never prompt equality, and precede their response", () => {
    const existing = [view("external-user", 1, { role: "user", parts: [{ type: "text", text: "repeat" }] }), view("response", 2, { runId: "R" })];
    const turn = { id: "pending", conversationId: "A", runId: "R", text: "repeat", time: time(2) };
    expect(messagesWithPendingTurn(existing, turn).map(message => message.id)).toEqual(["external-user", "pending", "response"]);
    expect(messagesWithPendingTurn(existing, { ...turn, runId: undefined }).map(message => message.id)).toEqual(["external-user", "response", "pending"]);
    const recorded = [view("recorded-user", 1, { role: "user", runId: "R" }), ...existing];
    expect(messagesWithPendingTurn(recorded, turn)).toBe(recorded);
    expect(messagesWithPendingTurn(existing, null)).toBe(existing);
  });
});

describe("context usage and compaction order", () => {
  test("CC sums fresh input and both caches from the latest root request, excluding output and cumulative results", () => {
    const target = run();
    const output = (input: number, patch: Record<string, unknown> = {}) => raw([], { message: { model: "cc-model", usage: { input_tokens: input, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 9999 } }, ...patch });
    const encoded = JSON.stringify(output(100));
    feed(target, 1, "stdout", encoded.slice(0, 40));
    feed(target, 2, "stdout", encoded.slice(40));
    feed(target, 3, "stdout", output(200));
    feed(target, 4, "stdout", output(800, { parent_tool_use_id: "child" }));
    feed(target, 5, "stdout", output(900, { session_id: "foreign" }));
    feed(target, 6, "stdout", { type: "result", session_id: "native-A", usage: { input_tokens: 99999 }, modelUsage: { "cc-model": { contextWindow: 1000, inputTokens: 99999, outputTokens: 99999 } } });
    expect(contextUsageFor("claude-code", [target], [])).toEqual({ tokens: 250, model: "cc-model", time: time(3), capacity: 1000, percentage: 25 });
  });

  test("CC invalid counts cannot replace valid input, while a model change invalidates the old window", () => {
    const target = run();
    const output = (model: string, input: number) => raw([], { message: { model, usage: { input_tokens: input } } });
    feed(target, 1, "stdout", output("cc-model", 100));
    feed(target, 2, "stdout", { type: "result", session_id: "native-A", modelUsage: { "cc-model": { contextWindow: 1000 } } });
    feed(target, 3, "stdout", output("cc-model", -1));
    expect(contextUsageFor("claude-code", [target], [])?.tokens).toBe(100);
    feed(target, 4, "stdout", { type: "system", subtype: "init", session_id: "native-A", model: "different-model" });
    expect(contextUsageFor("claude-code", [target], [])).toBeNull();
  });

  test("CC imported boundaries use native order without inventing clocks; unknown external responses hide old usage", () => {
    const target = run();
    feed(target, 1, "stdout", raw([], { uuid: "known", message: { model: "cc-model", usage: { input_tokens: 100 } } }));
    feed(target, 2, "stdout", { type: "result", session_id: "native-A", modelUsage: { "cc-model": { contextWindow: 1000 } } });
    const known = snapshot("known", "assistant", 1, { createdAt: "" });
    const importedBoundary = boundary("boundary", 2);
    importedBoundary.createdAt = "";
    expect(contextUsageFor("claude-code", [target], [], history([known, importedBoundary]))).toBeNull();
    expect(contextUsageFor("claude-code", [target], [], history([importedBoundary, known]))?.tokens).toBe(100);
    expect(contextUsageFor("claude-code", [target], [], history([known, snapshot("external")]))).toBeNull();
  });

  test("OC late UPSERT of an old message cannot displace newer native usage; pre-import UPSERTs are ignored", () => {
    const target = run({ harness: "opencode" });
    feed(target, 1, "message", usageMessage("old", 1, 900), 25);
    feed(target, 2, "message", usageMessage("new", 3, 800), 10);
    const imported = history([usageMessage("old", 1, 100), usageMessage("new", 3, 200)]);
    expect(contextUsageFor("opencode", [target], models, imported)).toEqual({ tokens: 250, model: "provider/model", time: time(20), capacity: 1000, percentage: 25 });
  });

  test("OC missing timestamps retain UPSERT insertion order and absent model identity never uses the picker", () => {
    const target = run({ harness: "opencode" });
    feed(target, 1, "message", usageMessage("old", 1, 100, { createdAt: "" }));
    feed(target, 2, "message", usageMessage("new", 2, 200, { createdAt: "" }));
    feed(target, 3, "message", usageMessage("old", 1, 900, { createdAt: "" }));
    expect(contextUsageFor("opencode", [target], models)?.tokens).toBe(250);
    feed(target, 4, "message", usageMessage("legacy", 4, 300, { createdAt: "", model: undefined }));
    expect(contextUsageFor("opencode", [target], models)).toBeNull();
  });

  test("OC repeated old boundary does not reset newer usage, and compact-run summary usage is excluded", () => {
    const target = run({ harness: "opencode" });
    feed(target, 1, "message", usageMessage("before", 1, 100));
    feed(target, 2, "message", boundary());
    feed(target, 3, "message", usageMessage("after", 3, 200));
    feed(target, 4, "message", boundary(), 30);
    const compactionRun = run({ id: "C", harness: "opencode", operation: "compact" });
    feed(compactionRun, 5, "message", usageMessage("summary", 5, 900));
    const records = [compact("operation", { nativeId: "boundary", endedAt: time(30) })];
    expect(contextUsageFor("opencode", [target, compactionRun], models, null, records)?.tokens).toBe(250);
    const imported = history([usageMessage("before", 1, 100), boundary()]);
    expect(contextUsageFor("opencode", [], models, imported)).toBeNull();
  });

  test("running compaction marks usage stale; only a newer unmatched reset record clears it", () => {
    const target = run({ harness: "opencode" });
    feed(target, 1, "message", usageMessage("answer", 1, 100));
    const running = compact("running", { lifecycle: "running", contextReset: false });
    expect(contextUsageFor("opencode", [target], models, null, [running])).toMatchObject({ tokens: 150, stale: true });
    expect(contextUsageFor("opencode", [target], models, null, [compact("failed", { lifecycle: "failed", contextReset: false, endedAt: time(5) })])?.tokens).toBe(150);
    expect(contextUsageFor("opencode", [target], models, null, [compact("older", { endedAt: time(1) })])?.tokens).toBe(150);
    expect(contextUsageFor("opencode", [target], models, null, [compact("newer", { endedAt: time(5) })])).toBeNull();
  });

  test("imported compaction placement follows native order and aliases, not observation clocks", () => {
    const imported = history([boundary("first", 8), boundary("second", 2), snapshot("uuid-after", "assistant", 1)]);
    const messages = [view("app-after", 1, { nativeIds: ["uuid-after"] })];
    const first = compact("first-record", { nativeId: "first", observedAt: time(50), startedAt: time(8) });
    const second = compact("second-record", { nativeId: "second", observedAt: time(40), startedAt: time(2) });
    const unknown = compact("unknown", { observedAt: time(1) });
    const positions = compactionPositions([second, unknown, first], messages, imported);
    expect(positions.get("app-after")).toEqual([first, second]);
    expect(positions.get("")).toEqual([unknown]);
  });

  test("App-only compaction prefers its own run anchor, then a genuine clock; unknown imported tail stays trailing", () => {
    const messages = [view("other-run", 3), view("same-run", 5, { runId: "R" })];
    const anchored = compact("anchored", { runId: "R", endedAt: time(2) });
    const clock = compact("clock", { endedAt: time(2) });
    const tail = compact("tail", { nativeId: "last-boundary", endedAt: time(1) });
    const positions = compactionPositions([anchored, clock, tail], messages, history([boundary("last-boundary")]));
    expect(positions.get("same-run")).toEqual([anchored]);
    expect(positions.get("other-run")).toEqual([clock]);
    expect(positions.get("")).toEqual([tail]);
  });
});

const handoff = (id: string, senderSession = "A", requestId = "request", recipientSession = "B"): HandoffPresentation => {
  const sender = { harness: "oc" as const, authorityId: "authority", nativeId: `native-${senderSession}` };
  return {
    handoff: { id, repositoryId: "repository", sender, workstreamId: "workstream", input: { requestId, to: "engineering", message: "fixture" }, recipient: { ownerId: "owner", sessionId: recipientSession, ref: null, harness: "oc", authorityId: "authority", checkout: { path: "/fixture", commonDir: "/fixture/.git", gitDir: "/fixture/.git", device: 1, inode: 1, commonDevice: 1, commonInode: 1, gitDevice: 1, gitInode: 1 } }, status: "queued", revision: 1, attemptId: null, nativeCommandId: null, runId: null, evidence: null, createdAt: time(), updatedAt: time() },
    sender: { sessionId: senderSession, title: "Sender", phases: [], ref: sender }, recipient: { sessionId: recipientSession, title: "Recipient", phases: [], ref: null }, workstreamTitle: "Fixture", deliveries: [], history: [],
  };
};
const tool = (name: string, input: unknown, output?: unknown): ToolPart => ({ type: "tool", id: "tool", name, input, output });

describe("handoff presentation scoping", () => {
  test("nested execute replies decode native envelopes only and require the current sender session", () => {
    const own = handoff("own"), foreign = handoff("foreign", "other"), unrelated = handoff("unrelated");
    const output = { result: [{ type: "text", text: JSON.stringify({ replies: [{ id: "own", requestId: "request", to: "engineering" }, { id: "foreign", requestId: "request", to: "engineering" }] }) }] };
    const presentations = [own, foreign, unrelated];
    expect(sentHandoffs(tool("functions.execute", { code: "nested tools" }, output), "A", presentations)).toEqual([own]);
    expect(sentHandoffs(tool("functions.execute", { requestId: "request" }, "prose mentions own and request"), "A", presentations)).toEqual([]);
    expect(sentHandoffs(tool("Read", {}, output), "A", presentations)).toEqual([]);
    expect(sentHandoffs(tool("functions.execute", {}, { id: "own" }), "A", presentations)).toEqual([]);
  });

  test("direct handoff falls back to scoped request ID only without reply IDs; receipt requires user and recipient ownership", () => {
    const own = handoff("own"), different = handoff("different", "A", "other-request"), foreign = handoff("foreign", "other");
    own.deliveries = [{ runId: "delivery-run", commandId: "command" }];
    const presentations = [own, different, foreign];
    expect(sentHandoffs(tool("mcp__sane_sane_handoff", { requestId: "request" }), "A", presentations)).toEqual([own]);
    expect(sentHandoffs(tool("sane_handoff", { requestId: "request" }, { id: "different", requestId: "other-request", to: "engineering" }), "A", presentations)).toEqual([different]);
    expect(sentHandoffs(tool("sane_handoff", { requestId: "request" }, { id: "missing", requestId: "request", to: "engineering" }), "A", presentations)).toEqual([]);
    expect(receivedHandoff(view("command", 1, { role: "user" }), "B", presentations)).toBe(own);
    expect(receivedHandoff(view("other-command", 1, { role: "user", runId: "delivery-run" }), "B", presentations)).toBe(own);
    expect(receivedHandoff(view("command"), "B", presentations)).toBeUndefined();
    expect(receivedHandoff(view("command", 1, { role: "user" }), "A", presentations)).toBeUndefined();
  });
});
