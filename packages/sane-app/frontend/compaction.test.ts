import { expect, test } from "bun:test";
import { ChatStore } from "./store";
import { ApiError } from "./cc-client";
import { compactCommand, compactionPositions } from "./compaction";
import { contextUsageFor } from "./context-usage";
import { consume, createRun, messagesForRun } from "./cc-reducer";
import { transcriptMessages } from "./transcript";
import type { Conversation, ConversationClient, DiagnosticEvent, Harness, RunMetadata } from "./types";
import type { CompactRequest, CompactState, CompactionLifecycle, CompactionRecord, MessageSnapshot } from "../src/oc-contract";
import type { ReconciledHistory } from "../src/reconcile";

const t = (second = 0) => new Date(Date.UTC(2026, 9, 1, 0, 0, second)).toISOString();
const operation = (lifecycle: CompactionLifecycle = "requested", patch: Partial<CompactionRecord> = {}): CompactionRecord => ({ id: "compact", sessionId: "A", harness: "opencode", runId: "C", trigger: "manual", lifecycle, contextReset: lifecycle === "completed", ...patch });
const eligible = (operations: CompactionRecord[] = [], harness: Harness = "opencode"): CompactState => ({ sessionId: "A", eligibility: { eligible: true, supportsInstructions: harness === "claude-code", nativeActivity: "idle" }, operations });
const meta = (patch: Partial<RunMetadata> = {}): RunMetadata => ({ id: "R", conversationId: "A", harness: "opencode", nativeSessionId: "ses_A", cwd: "/fixture", status: "completed", createdAt: t(), ...patch });
const event = (seq: number, kind: DiagnosticEvent["kind"], data: unknown, runId = "R"): DiagnosticEvent => ({ seq, kind, data, runId, sessionId: "A", time: t(seq) });
const assistant = (id = "msg_before", second = 1, tokens = 99000): MessageSnapshot => ({ messageId: id, role: "assistant", parts: [{ id: `${id}:text`, type: "text", text: "real response" }], status: "completed", createdAt: t(second), model: "provider/model", usage: { tokens: { input: tokens, cache: { read: 0, write: 0 } } } });
const boundary = (lifecycle: CompactionLifecycle): MessageSnapshot => ({ messageId: "msg_compact", role: "system", parts: [], status: lifecycle === "completed" ? "completed" : lifecycle === "failed" ? "failed" : "running", createdAt: t(2), contextReset: lifecycle === "completed", compaction: { nativeId: "msg_compact", lifecycle, trigger: "auto", summaryUsage: { tokens: { input: 50000 } } } });
const history = (messages: MessageSnapshot[]): ReconciledHistory => ({ sessionId: "A", nativeSessionId: "ses_A", importedAt: t(10), activity: "idle", reason: "fixture", coveredRunIds: [], messages });

function fixture(harness: Harness = "opencode", overrides: Partial<ConversationClient> = {}) {
  const mutations: { id: string; input: CompactRequest }[] = [], submissions: unknown[] = [];
  const conversation: Conversation = { id: "A", harness, nativeSessionId: harness === "opencode" ? "ses_A" : "native-A", cwd: "/fixture", lastRunId: "R", status: "completed" };
  const client: ConversationClient = {
    config: async () => ({ authenticated: true, authRequired: false }), login: async () => {}, logout: async () => {},
    conversations: async () => ({ conversations: [conversation], availability: { canSend: true } }), runs: async () => [], events: async () => ({ events: [], nextCursor: 0, status: "completed" }), models: async () => [], interactions: async () => [], reply: async () => {}, cancel: async () => ({ interrupted: true }),
    compactState: async () => eligible([], harness),
    compact: async (id, input) => { mutations.push({ id, input }); return { sessionId: id, runId: "C", operation: operation("requested", { harness, requestId: input.requestId }) }; },
    submit: async input => { submissions.push(input); return { conversationId: "A", runId: "next" }; }, ...overrides,
  };
  const store = new ChatStore(client);
  store.state = { ...store.state, selected: "A", conversations: [conversation], loading: false, connected: true, availability: { canSend: true }, compactState: eligible([], harness) };
  store.executionUnavailable = () => ""; store.modelUnavailable = () => false; store.reconnect = () => {};
  return { store, client, conversation, mutations, submissions, poll: () => (store as any).poll() as Promise<void>, close: () => (store as any).stop() };
}

test("only standalone /compact (including multiline instructions) opens the dialog; unsupported OC args preserve draft", async () => {
  expect(compactCommand("  /COMPACT\nkeep architecture\nand next steps  ")).toEqual({ instructions: "keep architecture\nand next steps" });
  expect(compactCommand(" /compact \n")).toEqual({});
  for (const text of ["mention /compact", "```\n/compact\n```", "/compactness", "/compact-foo", "explain\n/compact"]) expect(compactCommand(text)).toBeNull();
  for (const harness of ["claude-code", "opencode"] as const) {
    const f = fixture(harness);
    try {
      const draft = { text: "/compact\nkeep architecture\nand next steps", upgradeId: "template:engineering" };
      f.store.setDraft(draft);
      await f.store.send(draft.text);
      expect(f.mutations).toEqual([]); expect(f.submissions).toEqual([]); expect(f.store.draft()).toMatchObject(draft);
      if (harness === "claude-code") {
        expect(f.store.state.compactDialog).toBe("A");
        expect(f.store.state.compactInstructions?.A).toBe("keep architecture\nand next steps");
        f.store.closeCompact(); f.store.openCompact(); expect(f.store.state.compactDialog).toBe("A");
      } else {
        expect(f.store.state.compactDialog).toBeUndefined(); expect(f.store.state.submissionError).toContain("does not support instructions");
        await f.store.send("/compact"); expect(f.store.state.compactDialog).toBe("A");
      }
      await f.store.refreshCompact();
    } finally { f.close(); }
  }
});

test("explicit manual compact requires attached acknowledgement and preserves draft/upgrade without PendingTurn", async () => {
  const f = fixture("claude-code");
  f.conversation.attachment = { state: "ready" };
  f.store.state.compactState!.eligibility.requiresNativeStopped = true;
  f.store.setDraft({ text: "unsent\n日本  ", upgradeId: "template:engineering" });
  const draft = { ...f.store.draft() };
  try {
    await f.store.compact(); expect(f.mutations).toEqual([]); expect(f.store.state.compactError).toContain("Confirm external");
    f.store.setCompactInstructions("  preserve TODOs\nand decisions  ");
    await f.store.compact(true);
    expect(f.mutations).toHaveLength(1); expect(f.mutations[0]!.input).toMatchObject({ instructions: "preserve TODOs\nand decisions", nativeStopped: true });
    expect(f.mutations[0]!.input.requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(f.store.draft()).toEqual(draft); expect(f.store.state.pendingTurn).toBeUndefined(); expect(f.submissions).toEqual([]);
    expect(f.store.state.pendingCompacts?.A?.phase).toBe("accepted");
  } finally { f.close(); }
});

test("automatic lifecycle polling at high usage is observation-only and never erases a manual error; workers stay read-only", async () => {
  let operations: CompactionRecord[] = [];
  const f = fixture("opencode", { nativeHistory: async () => ({ history: history([assistant()]) }), compactState: async () => eligible(operations) });
  f.store.state = { ...f.store.state, phase: "ready", modelsLoaded: true, modelsCwd: "/fixture", models: [{ id: "provider/model", name: "Model", efforts: [], contextWindow: 100000 }], compactError: "Manual request refused" };
  try {
    await f.poll(); f.close(); expect(f.store.state.contextUsage?.percentage).toBe(99);
    for (const lifecycle of ["running", "completed", "failed"] as const) {
      operations = [operation(lifecycle, { trigger: "auto", observedAt: t(20), error: lifecycle === "failed" ? "native failure" : undefined })];
      await f.poll(); f.close();
      expect(f.store.state.compactions?.[0]!.lifecycle).toBe(lifecycle); expect(f.store.state.compactError).toBe("Manual request refused");
    }
    f.conversation.worker = { id: "worker-A", parent: { sessionId: "parent", runId: "parent-run", toolCallId: "call" } };
    await f.store.refreshCompact(); await f.store.compact();
    expect(f.store.state.compactError).toContain("Managed worker");
    expect(f.mutations).toEqual([]); expect(f.submissions).toEqual([]);
  } finally { f.close(); }
});

test("uncertain acceptance has no automatic retry: explicit recovery reuses UUID or observes the existing operation", async () => {
  for (const found of [false, true]) {
    let reads = 0;
    const payloads: CompactRequest[] = [];
    const f = fixture("opencode", {
      compact: async (_id, input) => { payloads.push(input); if (payloads.length === 1) throw new Error("ack lost"); return { sessionId: "A", runId: "C", operation: operation("requested", { requestId: input.requestId }) }; },
      compactState: async () => { reads++; return eligible(found && reads >= 3 ? [operation("completed", { requestId: payloads[0]!.requestId })] : []); },
    });
    f.store.setDraft({ text: "do not lose this" });
    try {
      await f.store.compact();
      expect(f.store.state.pendingCompacts?.A?.phase).toBe("unconfirmed"); expect(f.store.state.compactError).toContain("no automatic retry");
      await f.store.refreshCompact(); await f.store.refreshCompact(); expect(payloads).toHaveLength(1);
      await f.store.compact();
      expect(payloads).toHaveLength(found ? 1 : 2);
      if (!found) expect(payloads[1]).toEqual(payloads[0]);
      expect(f.store.state.pendingCompacts?.A?.phase).toBe("accepted"); expect(f.store.draft().text).toBe("do not lose this");
    } finally { f.close(); }
  }
});

test("A→B→A fences stale compaction reads, including stale authorization failure", async () => {
  for (const fails of [false, true]) {
    const old = Promise.withResolvers<CompactState>(), fresh = Promise.withResolvers<CompactState>(); let calls = 0;
    const f = fixture("opencode", { compactState: () => ++calls === 1 ? old.promise : fresh.promise });
    try {
      const previous = f.store.refreshCompact(); f.store.choose("B"); f.store.choose("A");
      const current = f.store.refreshCompact();
      fresh.resolve(eligible([operation("completed", { id: "fresh" })])); await current;
      if (fails) old.reject(new ApiError("stale denied", 401)); else old.resolve(eligible([operation("failed", { id: "obsolete" })]));
      expect(await previous).toBe(false); expect(f.store.state.compactions?.map(r => r.id)).toEqual(["fresh"]);
      expect(f.store.state.phase).not.toBe("login"); expect(f.store.state.compactError).toBe("");
    } finally { f.close(); }
  }
});

test("usage is stale while compacting, unknown on reset, retained on failure, and restored only by genuine later usage", () => {
  const models = [{ id: "provider/model", name: "Model", efforts: [], contextWindow: 100000 }];
  for (const lifecycle of ["running", "failed", "completed"] as const) {
    const prior = createRun(meta()); consume(prior, [event(1, "message", assistant())]);
    const compact = createRun(meta({ id: "C", operation: "compact" }));
    consume(compact, [event(2, "message", boundary(lifecycle), "C"), event(3, "message", assistant("msg_summary", 3, 0), "C")]);
    const projected = [operation(lifecycle, { nativeId: "msg_compact" })];
    const usage = contextUsageFor("opencode", [prior, compact], models, null, projected);
    if (lifecycle === "completed") expect(usage).toBeNull();
    else { expect(usage?.tokens).toBe(99000); expect(usage?.stale === true).toBe(lifecycle === "running"); }
    const later = createRun(meta({ id: "later", createdAt: t(4) })); consume(later, [event(4, "message", assistant("msg_later", 4, 12000), "later")]);
    expect(contextUsageFor("opencode", [prior, compact, later], models, null, [operation("completed", { nativeId: "msg_compact" })])?.percentage).toBe(12);
  }
  const cc = createRun(meta({ harness: "claude-code", nativeSessionId: "native-A" }));
  const output = (tokens: number) => ({ type: "assistant", session_id: "native-A", message: { model: "cc-model", usage: { input_tokens: tokens } } });
  consume(cc, [event(1, "stdout", output(90000)), event(2, "stdout", { type: "result", session_id: "native-A", modelUsage: { "cc-model": { contextWindow: 100000 } } })]);
  const ccCompact = createRun(meta({ id: "C", harness: "claude-code", nativeSessionId: "native-A", operation: "compact" }));
  consume(ccCompact, [event(3, "stdout", { type: "system", subtype: "compact_boundary", uuid: "boundary", session_id: "native-A" }, "C"), event(4, "stdout", output(0), "C")]);
  expect(contextUsageFor("claude-code", [cc, ccCompact], [])).toBeNull();
  const ccLater = createRun(meta({ id: "later", harness: "claude-code", nativeSessionId: "native-A" })); consume(ccLater, [event(5, "stdout", output(12000), "later")]);
  expect(contextUsageFor("claude-code", [cc, ccCompact, ccLater], [])?.percentage).toBe(12);
});

test("compact-only runs produce lifecycle markers, not fake turns/branch targets, and preserve branch composer draft", async () => {
  const compactMeta = meta({ id: "C", operation: "compact", compact: { requestId: "client" } });
  const evidence = [event(1, "submission", { text: "/compact", messageId: "fake" }, "C"), event(2, "message", boundary("completed"), "C"), event(3, "stdout", { type: "result", session_id: "ses_A", result: "summary" }, "C")];
  const compact = createRun(compactMeta); consume(compact, evidence);
  expect(messagesForRun(compact)).toEqual([]); expect(transcriptMessages(null, [compact])).toEqual([]);
  const nativeHistory = history([assistant(), boundary("completed"), assistant("msg_later", 3, 12000)]);
  const messages = transcriptMessages(nativeHistory, [compact]);
  expect(messages.map(m => m.id)).toEqual(["msg_before", "msg_later"]);
  expect(compactionPositions([operation("completed", { nativeId: "msg_compact" })], messages, nativeHistory).get("msg_later")).toHaveLength(1);
  const f = fixture("opencode", { runs: async () => [compactMeta], events: async () => ({ events: evidence, nextCursor: 3, status: "completed" }) });
  f.conversation.branchDraft = "continue from selected turn"; f.store.state.phase = "ready";
  try {
    await f.poll(); expect(f.store.state.messages).toEqual([]); expect(f.store.draft().text).toBe("continue from selected turn"); expect(f.store.state.pendingTurn).toBeUndefined();
  } finally { f.close(); }
});
