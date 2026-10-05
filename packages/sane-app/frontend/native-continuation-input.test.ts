import { expect, test } from "bun:test";
import { createRun } from "./cc-reducer";
import { ChatStore, type State } from "./store";
import type { Availability, Conversation, ConversationClient, DiagnosticEvent, RunMetadata } from "./types";
import type { SendReceipt } from "../shared/conversation/queued-followup";

const id = "native-continuation-fixture", previousId = "completed-app-run", queuedId = "new-queued-app-run";
const time = "2026-10-01T00:00:00.000Z";
const nativeAvailability: Availability = { canSend: true, nativeQueue: true };
const metadata = (runId: string, status: RunMetadata["status"]): RunMetadata => ({ id: runId, conversationId: id, cwd: "/fixture", createdAt: time, status });
const nativeConversation: Conversation = { id, harness: "opencode", nativeSessionId: "ses_native_fixture", cwd: "/fixture", lastRunId: previousId, status: "completed", nativeActivity: "active", availability: nativeAvailability };

/** Startup/config/model/history requests are injected as well as submission;
 * no singleton startup, real HTTP, native writes, browser or services. */
function fixture() {
  let conversation: Conversation = { ...nativeConversation }, serverRuns = [metadata(previousId, "completed")];
  let submissions = 0, reconciliations = 0;
  const requests: Parameters<ConversationClient["submit"]>[0][] = [];
  const acceptance = Promise.withResolvers<SendReceipt>();
  const client: ConversationClient = {
    config: async () => ({ authenticated: true, authRequired: false }), login: async () => {}, logout: async () => {},
    conversations: async () => ({ conversations: [conversation], availability: { canSend: true } }),
    runs: async () => serverRuns,
    events: async run => ({ events: run.id === queuedId ? [{ seq: 1, sessionId: id, runId: queuedId, time, kind: "submission", data: { messageId: "msg_exact_queue", text: "followup" } } satisfies DiagnosticEvent] : [], nextCursor: run.id === queuedId ? 1 : 0, status: serverRuns.find(r => r.id === run.id)?.status ?? "completed" }),
    nativeHistory: async () => ({ history: null }),
    reconcile: async () => { reconciliations++; throw new Error("Unexpected reconciliation"); },
    models: async () => [], interactions: async () => [], reply: async () => {}, cancel: async () => { throw new Error("Unexpected native cancellation"); },
    submit: async input => { submissions++; requests.push(input); return acceptance.promise; },
  };
  const chat = new ChatStore(client);
  chat.state = { ...chat.state, phase: "ready", selected: id, conversations: [conversation], runs: serverRuns.map(createRun), availability: nativeAvailability, connected: true, loading: false };
  chat.executionUnavailable = () => ""; chat.modelUnavailable = () => false;
  const internal = chat as unknown as { poll(): Promise<void>; stop(): void };
  return {
    chat, client, acceptance, requests,
    server(nextConversation: Conversation, runs = serverRuns) { conversation = nextConversation; serverRuns = runs; },
    counts: () => ({ submissions, reconciliations }),
    async poll() { internal.stop(); try { await internal.poll(); } finally { internal.stop(); } },
    close: () => internal.stop(),
  };
}

function observe(chat: ChatStore, matches: (state: State) => boolean) {
  const result = Promise.withResolvers<void>();
  const unsubscribe = chat.subscribe(() => { if (matches(chat.state)) result.resolve(); });
  return { done: result.promise, unsubscribe };
}

test("native continuation queue requires active native state, both advertisements and no active App run", () => {
  const f = fixture();
  try {
    expect(f.chat.canQueueInput()).toBe(true);
    expect(f.chat.canQueueInput({ ...f.chat.state, runs: [] })).toBe(true);
    const cases: State[] = [
      { ...f.chat.state, selected: "different-conversation" },
      { ...f.chat.state, availability: { canSend: false, nativeQueue: true } },
      { ...f.chat.state, availability: { canSend: true } },
      { ...f.chat.state, availability: { canSend: true, nativeQueue: false } },
      { ...f.chat.state, conversations: [{ ...nativeConversation, availability: { canSend: true } }] },
      { ...f.chat.state, conversations: [{ ...nativeConversation, nativeActivity: "idle" }] },
      { ...f.chat.state, conversations: [{ ...nativeConversation, nativeActivity: "unknown" }] },
      { ...f.chat.state, conversations: [{ ...nativeConversation, nativeActivity: undefined }] },
      { ...f.chat.state, runs: [createRun(metadata(queuedId, "starting"))] },
      { ...f.chat.state, runs: [createRun(metadata(queuedId, "running"))] },
      { ...f.chat.state, conversations: [{ ...nativeConversation, harness: "claude-code" }] },
    ];
    for (const state of cases) expect(f.chat.canQueueInput(state)).toBe(false);
  } finally { f.close(); }
});

test("CC queue still requires a running, exact conversation-owned receipt target, never a native queue advertisement", () => {
  const f = fixture(), availability = { canSend: true, queueAfterRunId: previousId };
  const cc: Conversation = { ...nativeConversation, harness: "claude-code", nativeSessionId: "cc-fixture", status: "running", nativeActivity: undefined, availability };
  const state: State = { ...f.chat.state, conversations: [cc], availability, runs: [createRun(metadata(previousId, "running"))] };
  try {
    expect(f.chat.canQueueInput(state)).toBe(true);
    const cases: State[] = [
      { ...state, availability: { canSend: false, queueAfterRunId: previousId } },
      { ...state, availability: { canSend: true } },
      { ...state, availability: { canSend: true, nativeQueue: true } },
      { ...state, conversations: [{ ...cc, lastRunId: "other-run" }] },
      { ...state, conversations: [{ ...cc, availability: { canSend: true } }] },
      { ...state, conversations: [{ ...cc, availability: { canSend: true, queueAfterRunId: "other-run" } }] },
      { ...state, runs: [createRun(metadata(previousId, "completed"))] },
      { ...state, runs: [createRun(metadata(previousId, "starting"))] },
      { ...state, runs: [createRun({ ...metadata(previousId, "running"), conversationId: "other-conversation" })] },
      { ...state, runs: [createRun(metadata("other-run", "running"))] },
    ];
    for (const value of cases) expect(f.chat.canQueueInput(value)).toBe(false);
  } finally { f.close(); }
});

test("accepted native queue followup uses a fresh run, clears Sending and never restores a draft error", async () => {
  const f = fixture();
  // Native active can be represented as conversation-level running without an
  // App owner. The completed App run must not block this exact queue admission.
  f.chat.state = { ...f.chat.state, conversations: [{ ...nativeConversation, status: "running" }] };
  const observed = observe(f.chat, state => state.connected && state.runs.some(run => run.id === queuedId) && !state.pendingTurn);
  try {
    f.chat.setDraft({ text: "followup" });
    const sending = f.chat.send("followup");
    expect(f.chat.state.sending).toBe(true); expect(f.chat.draft().text).toBe("");
    expect(f.chat.state.pendingTurn?.runId).toBeUndefined();
    expect(await f.chat.send("duplicate")).toEqual({ status: "blocked" });
    f.server({ ...nativeConversation, status: "running", lastRunId: queuedId, availability: { canSend: false } }, [metadata(previousId, "completed"), metadata(queuedId, "running")]);
    f.acceptance.resolve({ conversationId: id, runId: queuedId });
    expect(await sending).toEqual({ status: "accepted", conversationId: id, runId: queuedId });
    expect(f.chat.state.sending).toBe(false); expect(f.chat.state.submissionError).toBe(""); expect(f.chat.draft().text).toBe("");
    await observed.done;
    expect(f.chat.state.messages.filter(message => message.role === "user").map(message => message.runId)).toEqual([queuedId]);
    expect(f.chat.state.runs.find(run => run.id === previousId)?.status).toBe("completed");
    expect(f.chat.canQueueInput()).toBe(false);
    expect(f.requests).toEqual([{ conversationId: id, text: "followup" }]);
    expect(f.counts()).toEqual({ submissions: 1, reconciliations: 0 });
  } finally { observed.unsubscribe(); f.close(); }
});

test("accepted CC queue receipt remains receipt-bound without a restored draft or old-run pending bubble", async () => {
  const f = fixture(), availability = { canSend: true, queueAfterRunId: previousId };
  const cc: Conversation = { ...nativeConversation, harness: "claude-code", nativeActivity: undefined, status: "running", availability };
  f.chat.state = { ...f.chat.state, conversations: [cc], availability, runs: [createRun(metadata(previousId, "running"))] };
  const receipt = { requestId: "receipt-fixture", afterRunId: previousId, sessionId: id, prompt: "followup", time, state: "queued" as const };
  const observed = observe(f.chat, state => state.connected && state.conversations[0]?.queuedFollowups?.some(item => item.requestId === receipt.requestId) === true);
  try {
    f.chat.setDraft({ text: "followup" }); const sending = f.chat.send("followup");
    f.server({ ...cc, availability: { canSend: false }, queuedFollowups: [receipt] }, [metadata(previousId, "running")]);
    f.acceptance.resolve({ conversationId: id, queued: true, receipt });
    expect(await sending).toEqual({ status: "queued", conversationId: id, requestId: receipt.requestId });
    await observed.done;
    expect(f.chat.state.pendingTurn).toBeNull(); expect(f.chat.state.sending).toBe(false);
    expect(f.chat.draft().text).toBe(""); expect(f.chat.state.submissionError).toBe("");
    expect(f.chat.state.conversations[0]?.queuedFollowups).toEqual([receipt]);
    expect(f.counts()).toEqual({ submissions: 1, reconciliations: 0 });
  } finally { observed.unsubscribe(); f.close(); }
});

test("listing idle after unowned native continuation reopens normal send without relabeling the completed App run", async () => {
  const f = fixture();
  try {
    f.chat.state = { ...f.chat.state, conversations: [{ ...nativeConversation, status: "running", availability: { canSend: false } }], availability: { canSend: false } };
    expect(await f.chat.send("blocked" )).toEqual({ status: "blocked" });
    expect(f.counts().submissions).toBe(0);
    f.server({ ...nativeConversation, nativeActivity: "idle", availability: { canSend: true } });
    await f.poll();
    expect(f.chat.state.connected).toBe(true); expect(f.chat.state.availability).toEqual({ canSend: true });
    expect(f.chat.canQueueInput()).toBe(false);
    expect(f.chat.state.runs.find(run => run.id === previousId)?.status).toBe("completed");
    const observed = observe(f.chat, state => state.connected && state.runs.some(run => run.id === queuedId) && !state.pendingTurn);
    try {
      f.chat.setDraft({ text: "ordinary" }); const sending = f.chat.send("ordinary");
      f.server({ ...nativeConversation, nativeActivity: "active", status: "running", lastRunId: queuedId, availability: { canSend: false } }, [metadata(previousId, "completed"), metadata(queuedId, "running")]);
      f.acceptance.resolve({ conversationId: id, runId: queuedId });
      expect(await sending).toEqual({ status: "accepted", conversationId: id, runId: queuedId });
      await observed.done;
      expect(f.requests).toEqual([{ conversationId: id, text: "ordinary" }]);
      expect(f.chat.state.submissionError).toBe(""); expect(f.counts()).toEqual({ submissions: 1, reconciliations: 0 });
    } finally { observed.unsubscribe(); }
  } finally { f.close(); }
});
