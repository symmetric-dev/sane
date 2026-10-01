import { expect, test } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import { Window } from "happy-dom";
import { ChatComposer } from "./chat-composer";
import { createRun } from "./cc-reducer";
import { ApiError } from "./cc-client";
import { catalog } from "./catalog";
import { ChatStore, store, type State } from "./store";
import { messagesWithPendingTurn } from "./transcript";
import { Thread } from "./thread";
import type { Conversation, ConversationClient, DiagnosticEvent, RunMetadata, RunStatus } from "./types";

const busyReason = "This conversation already has an active run or reconciliation";
const sessionId = "submission-loading-fixture";
const runId = "submission-loading-run";
const time = "2026-10-01T00:00:00.000Z";
const conversation: Conversation = { id: sessionId, harness: "claude-code", nativeSessionId: "native-fixture", cwd: "/fixture", lastRunId: null,
  status: "completed", workspaceId: "workspace", worktreeId: "tree", association: "resolved" };
const metadata = (status: RunStatus): RunMetadata => ({ id: runId, conversationId: sessionId, cwd: "/fixture", status, createdAt: time });

function fixture() {
  const acceptance = Promise.withResolvers<{ conversationId: string; runId: string }>();
  let status: RunStatus | null = null, responded = false, busy = false, submissions = 0, reconciliations = 0;
  const client: ConversationClient = {
    config: async () => ({ authenticated: true, authRequired: false }), login: async () => {}, logout: async () => {},
    conversations: async () => ({ conversations: [{ ...conversation, status: status ?? "completed", lastRunId: status ? runId : null,
      availability: busy ? { canSend: false, reason: busyReason } : { canSend: true } }], availability: { canSend: true } }),
    runs: async () => status ? [metadata(status)] : [],
    events: async () => {
      const events: DiagnosticEvent[] = [{ seq: 1, time, sessionId, runId, kind: "submission", data: { messageId: "user-fixture", text: "hello" } }];
      if (responded) events.push({ seq: 2, time, sessionId, runId, kind: "message", data: { messageId: "assistant-fixture", role: "assistant",
        parts: [{ id: "text-fixture", type: "text", text: "Hello back" }], status: "running", createdAt: time } });
      return { events, nextCursor: responded ? 2 : 1, status: status ?? "completed" };
    },
    nativeHistory: async () => ({ history: null }),
    reconcile: async () => { reconciliations++; throw new Error("Unexpected reconciliation"); },
    models: async () => [], interactions: async () => [], reply: async () => {}, cancel: async () => ({ interrupted: true }),
    submit: async () => { submissions++; return acceptance.promise; },
  };
  const chat = new ChatStore(client);
  chat.state = { ...chat.state, phase: "ready", selected: sessionId, conversations: [conversation], connected: true, loading: false,
    availability: { canSend: true } };
  // Isolate submission state from workspace/model discovery, neither of which is under test.
  chat.executionUnavailable = () => "";
  chat.modelUnavailable = () => false;
  const internal = chat as unknown as { poll(): Promise<void>; stop(): void };
  return {
    chat, client, acceptance,
    server: (next: RunStatus, hasResponse = false) => { status = next; responded = hasResponse; busy = next === "starting" || next === "running"; },
    reserve: () => { busy = true; },
    counts: () => ({ submissions, reconciliations }),
    poll: async () => { internal.stop(); await internal.poll(); internal.stop(); },
    close: () => internal.stop(),
  };
}

function nextSnapshot(chat: ChatStore, matches: (state: State) => boolean) {
  const result = Promise.withResolvers<void>();
  const unsubscribe = chat.subscribe(() => { if (matches(chat.state)) result.resolve(); });
  return { done: result.promise, unsubscribe };
}

test("submission status ends on acknowledgement, before recorded history or assistant output, and the run unlocks normally", async () => {
  const f = fixture();
  const observed = nextSnapshot(f.chat, state => state.runs.length === 1 && state.connected);
  const recordedRuns = Promise.withResolvers<RunMetadata[]>();
  const originalRuns = f.client.runs;
  f.client.runs = () => recordedRuns.promise;
  try {
    f.chat.setDraft({ text: "hello" });
    const sending = f.chat.send("hello");
    expect(f.chat.draft().text).toBe("");
    expect(f.chat.state.sending).toBe(true);
    expect(f.chat.state.pendingTurn?.runId).toBeUndefined();
    expect(messagesWithPendingTurn(f.chat.state.messages, f.chat.state.pendingTurn).filter(m => m.role === "user")).toHaveLength(1);
    await f.chat.send("hello");
    expect(f.counts().submissions).toBe(1);

    f.server("starting");
    f.acceptance.resolve({ conversationId: sessionId, runId });
    await sending;
    // The POST succeeded but history is still buffered. The bubble is complete,
    // without a sending status, even though no assistant output exists yet.
    expect(f.chat.state.sending).toBe(false);
    expect(f.chat.state.pendingTurn?.runId).toBe(runId);
    expect(f.chat.state.messages).toHaveLength(0);
    expect(messagesWithPendingTurn(f.chat.state.messages, f.chat.state.pendingTurn)[0]?.parts).toEqual([{ type: "text", text: "hello" }]);
    recordedRuns.resolve([metadata("starting")]);
    await observed.done;
    f.client.runs = originalRuns;
    expect(f.chat.state.submissionError).toBe("");
    expect(f.chat.state.availability).toEqual({ canSend: false, reason: busyReason });
    expect(f.chat.state.pendingTurn).toBeNull();
    expect(f.chat.state.messages.some(m => m.role === "assistant")).toBe(false);
    expect(messagesWithPendingTurn(f.chat.state.messages, f.chat.state.pendingTurn).filter(m => m.role === "user")).toHaveLength(1);
    await f.chat.send("another message");
    expect(f.counts()).toEqual({ submissions: 1, reconciliations: 0 });

    f.server("running", true);
    await f.poll();
    expect(f.chat.state.pendingTurn).toBeNull();
    expect(f.chat.state.messages.find(m => m.role === "user")?.parts).toEqual([{ type: "text", text: "hello" }]);
    expect(f.chat.state.messages.some(m => m.role === "assistant")).toBe(true);
    // Busy is still expected after the first output: output is not run completion.
    expect(f.chat.state.availability.reason).toBe(busyReason);
    expect(f.chat.state.submissionError).toBe("");

    f.server("completed", true);
    await f.poll();
    expect(f.chat.state.availability).toEqual({ canSend: true });
    expect(f.chat.state.pendingTurn).toBeNull();
    expect(f.chat.state.sending).toBe(false);
    expect(f.counts()).toEqual({ submissions: 1, reconciliations: 0 });
  } finally { observed.unsubscribe(); f.close(); }
});

test("a new conversation keeps its submitted bubble during selection and preserves the next draft typed while sending", async () => {
  const f = fixture();
  f.chat.state = { ...f.chat.state, selected: "" };
  const observed = nextSnapshot(f.chat, state => state.selected === sessionId && state.runs.length === 1);
  const visibleTurnCounts: number[] = [];
  const unsubscribe = f.chat.subscribe(() => {
    if (f.chat.state.sending || f.chat.state.pendingTurn || f.chat.state.messages.length) {
      const turn = f.chat.state.pendingTurn?.conversationId === f.chat.state.selected ? f.chat.state.pendingTurn : null;
      visibleTurnCounts.push(messagesWithPendingTurn(f.chat.state.messages, turn).filter(m => m.role === "user").length);
    }
  });
  try {
    f.chat.setDraft({ text: "hello" });
    const sending = f.chat.send("hello");
    expect(f.chat.draft().text).toBe("");
    f.chat.setDraft({ text: "my next message" });
    f.server("starting");
    f.acceptance.resolve({ conversationId: sessionId, runId });
    await sending;
    await observed.done;
    expect(f.chat.state.selected).toBe(sessionId);
    expect(f.chat.draft().text).toBe("my next message");
    expect(f.chat.draft("").text).toBe("");
    expect(visibleTurnCounts.length).toBeGreaterThan(0);
    expect(visibleTurnCounts.every(count => count === 1)).toBe(true);
    expect(f.counts().submissions).toBe(1);
  } finally { unsubscribe(); observed.unsubscribe(); f.close(); }
});

test("an unknown submission outcome restores the draft without automatically retrying", async () => {
  const f = fixture();
  try {
    f.chat.setDraft({ text: "hello" });
    const sending = f.chat.send("hello");
    expect(f.chat.draft().text).toBe("");
    f.acceptance.reject(new Error("Connection lost during submission"));
    await sending;
    expect(f.chat.draft().text).toBe("hello");
    expect(f.chat.state.pendingTurn).toBeNull();
    expect(f.chat.state.sending).toBe(false);
    expect(f.chat.state.submissionError).toContain("Acceptance is unknown");
    expect(f.chat.state.submissionError).toContain("will not be retried automatically");
    expect(f.counts().submissions).toBe(1);
  } finally { f.close(); }
});

test("a real 409 busy rejection restores the draft and is distinct from normal active-run availability", async () => {
  const f = fixture();
  const observed = nextSnapshot(f.chat, state => state.availability.reason === busyReason && state.connected);
  try {
    // Model the server becoming reserved after the client's last availability read.
    f.reserve();
    let attempts = 0;
    f.client.submit = async () => { attempts++; throw new ApiError(busyReason, 409); };
    f.chat.setDraft({ text: "hello" });
    await f.chat.send("hello");
    await observed.done;
    expect(f.chat.state.submissionError).toContain(busyReason);
    expect(f.chat.state.submissionError).toContain("Your draft is restored");
    expect(f.chat.draft().text).toBe("hello");
    expect(f.chat.state.pendingTurn).toBeNull();
    expect(f.chat.state.sending).toBe(false);
    expect(attempts).toBe(1);
    await f.chat.send("hello");
    expect(attempts).toBe(1);
  } finally { observed.unsubscribe(); f.close(); }
});

async function composerFixture(run: (host: HTMLDivElement, root: Root) => Promise<void>) {
  const browser = new Window({ url: "http://localhost" });
  const globals = { window: browser, self: browser, document: browser.document, navigator: browser.navigator,
    HTMLElement: browser.HTMLElement, Event: browser.Event, ResizeObserver: browser.ResizeObserver,
    MutationObserver: browser.MutationObserver, requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true };
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const oldState = store.state, oldCatalog = catalog.state;
  let root: Root | undefined;
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  try {
    catalog.state = { ...oldCatalog, ready: true, workspaces: [{ workspaceId: "workspace", kind: "directory", name: "Fixture", commonDir: null,
      worktrees: [{ worktreeId: "tree", root: "/fixture", gitDir: null, bindingRevision: "binding", state: "available" }] }] };
    store.state = { ...oldState, selected: sessionId, conversations: [conversation], connected: true, loading: false, sending: false,
      runs: [createRun(metadata("running"))], messages: [], drafts: {}, pendingTurn: null, submissionError: "", modelsError: "",
      availability: { canSend: false, reason: busyReason } };
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await run(host, root);
  } finally {
    if (root) await act(async () => root!.unmount());
    store.state = oldState; catalog.state = oldCatalog; browser.close();
    for (const [key, descriptor] of prior) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}

for (const scenario of ["active run", "accepted awaiting history", "submission awaiting server", "reconciliation"] as const) {
  test(`${scenario} is a neutral status, not an error, in the info panel`, async () => {
    await composerFixture(async (host, root) => {
      const reason = scenario === "submission awaiting server" ? "Sending your message…" : busyReason;
      if (scenario === "accepted awaiting history" || scenario === "submission awaiting server") store.state = { ...store.state,
        pendingTurn: { id: "pending-fixture", conversationId: sessionId, ...(scenario === "accepted awaiting history" ? { runId } : {}), text: "hello", time } };
      if (scenario !== "active run") store.state = { ...store.state, runs: [], sending: scenario === "submission awaiting server" };
      await act(async () => root.render(<ChatComposer state={store.state} ack="" onAckChange={() => {}} sendDisabled send={() => { throw new Error("Unexpected send"); }} />));
      expect(store.state.submissionError).toBe("");
      const help = host.querySelector<HTMLButtonElement>(".composer-help")!;
      expect(help.classList.contains("has-issue")).toBe(false);
      expect(help.querySelector(".composer-help-dot")).toBeNull();
      await act(async () => help.click());
      expect(document.querySelector(".composer-help-notes [role=alert]")).toBeNull();
      expect(document.querySelector(".composer-help-notes .notice[role=status]")?.textContent).toBe(reason);
      expect(host.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.disabled).toBe(true);
    });
  });
}

test("actual submission errors still receive error styling and an alert in the info panel", async () => {
  await composerFixture(async (host, root) => {
    store.state = { ...store.state, submissionError: `${busyReason}. Your draft is restored.` };
    await act(async () => root.render(<ChatComposer state={store.state} ack="" onAckChange={() => {}} sendDisabled send={() => {}} />));
    const help = host.querySelector<HTMLButtonElement>(".composer-help")!;
    expect(help.classList.contains("has-issue")).toBe(true);
    await act(async () => help.click());
    expect(document.querySelector(".composer-help-notes .notice.error[role=alert]")?.textContent).toBe(store.state.submissionError);
  });
});

test("the user bubble shows Sending only until server acknowledgement and assistant output renders normally", async () => {
  await composerFixture(async (host, root) => {
    store.state = { ...store.state, runs: [], sending: true,
      pendingTurn: { id: "pending-fixture", conversationId: sessionId, text: "hello", time } };
    const render = () => root.render(<Thread state={store.state} />);
    await act(async () => render());
    expect(host.querySelector("textarea")?.value).toBe("");
    expect(host.querySelector(".user-bubble .user-text")?.textContent).toBe("hello");
    expect(host.querySelector(".user-bubble .user-submission-status[role=status]")?.textContent).toBe("Sending…");
    expect(host.querySelector(".welcome")).toBeNull();

    store.state = { ...store.state, sending: false, loading: true, pendingTurn: { ...store.state.pendingTurn!, runId } };
    await act(async () => render());
    expect(host.querySelector(".user-submission-status")).toBeNull();
    expect(host.querySelector(".user-bubble .user-text")?.textContent).toBe("hello");
    expect(host.querySelectorAll(".user-message")).toHaveLength(1);
    expect(host.querySelector(".welcome")).toBeNull();

    const user = { id: "user-fixture", runId, role: "user" as const, parts: [{ type: "text" as const, text: "hello" }], time, status: "completed" as const };
    store.state = { ...store.state, loading: false, pendingTurn: null, messages: [user], runs: [createRun(metadata("running"))] };
    await act(async () => render());
    expect(host.querySelector(".user-submission-status")).toBeNull();
    expect(host.querySelectorAll(".user-message")).toHaveLength(1);

    store.state = { ...store.state, messages: [user, { id: "assistant-fixture", runId, role: "assistant", parts: [{ type: "text", text: "Hello back" }], time, status: "running" }] };
    await act(async () => render());
    expect(host.querySelector(".assistant-body")?.textContent).toBe("Hello back");
    expect(host.querySelector(".user-submission-status")).toBeNull();
    expect(host.querySelectorAll(".user-message")).toHaveLength(1);
  });
});
