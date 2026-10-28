import { afterEach, expect, test } from "bun:test";
import { ChatStore } from "./store";
import { catalog } from "./catalog";
import { conversationClient } from "./cc-client";
import { invalidateCoalescedRequests } from "./request-coalescing";
import { grokAvailability, GROK_UNKNOWN_NOTICE } from "./grok-presentation";
import type { Conversation, ConversationClient, GrokSessionView, GrokTurnInput } from "./types";
import { builtinProfiles } from "../src/agent-profiles-contract";

const ID = "22bb25ce-e876-4498-ae47-f5d6e88d7e38";
const time = "2026-10-28T00:00:00.000Z";
const view = (sessionId = ID, patch: Partial<GrokSessionView> = {}): GrokSessionView => ({
  protocol: "grok-capture", version: 1, sessionId, nativeSessionId: "native-grok", authorityId: "authority-grok",
  cwd: "/fixture", model: "custom model", effort: "custom effort", phase: "idle", nextTurnIndex: 1,
  active: false, blocked: false, nativeAcceptance: "unknown", acceptedMessageId: null,
  messages: [{ id: `${sessionId}:0:user`, runId: "run-0", role: "user", parts: [{ type: "text", text: "hello" }], time, status: "completed" }],
  runs: [{ id: "run-0", conversationId: sessionId, cwd: "/fixture", harness: "grok", status: "completed", createdAt: time }], ...patch,
});
const row = (): Conversation => ({ id: ID, harness: "grok", nativeSessionId: "native-grok", authorityId: "authority-grok", cwd: "/fixture",
  model: "saved model", effort: "saved effort", workspaceId: "workspace", worktreeId: "checkout", association: "resolved", status: "completed", lastRunId: "run-0" });
const stores: ChatStore[] = [];
const navigate = catalog.navigate;
const originalFetch = globalThis.fetch;
afterEach(() => {
  for (const chat of stores.splice(0)) (chat as any).stop();
  catalog.navigate = navigate;
  globalThis.fetch = originalFetch;
  invalidateCoalescedRequests();
});

function fixture(selected = false) {
  const calls: string[] = [], inputs: GrokTurnInput[] = [];
  const forbidden = (name: string) => async () => { calls.push(name); throw new Error(`Unexpected ${name}`); };
  const client = {
    grokTurn: async (input: GrokTurnInput) => { calls.push("turn"); inputs.push(input); return view(input.sessionId); },
    grokSession: async (id: string) => { calls.push(`status:${id}`); return view(id); },
    grokStop: async (id: string) => { calls.push(`stop:${id}`); return { interrupted: false, wrapperClosed: true, nativeCancellation: "unproven", reason: "No native proof." }; },
    submit: forbidden("legacy-submit"), submitAdmission: forbidden("v1-post"), lookupAdmission: forbidden("v1-get"),
    nativeHistory: forbidden("native-history"), runs: forbidden("runs"), events: forbidden("events"),
    transcriptPage: forbidden("transcript"), transcriptMeta: forbidden("transcript-meta"), transcriptRefresh: forbidden("transcript-refresh"),
    interactions: forbidden("interactions"), handoffApprovals: forbidden("handoffs"), workers: forbidden("workers"),
    scienceSubmissions: forbidden("science"), models: forbidden("models"), cancel: forbidden("native-cancel"),
    conversations: async () => ({ conversations: selected ? [row()] : [], availability: { canSend: true } }),
  } as unknown as ConversationClient;
  const chat = new ChatStore(client);
  stores.push(chat);
  const profiles = builtinProfiles().map(profile => profile.harness === "grok" ? { ...profile, hidden: false, model: "custom model", effort: "custom effort" } : profile);
  chat.state = { ...chat.state, phase: "ready", config: { authRequired: false, authenticated: true,
    grokCapability: { protocol: "grok-capture", version: 1, configured: true },
    appAdmissionCapability: { protocol: "app-admission", version: 1, state: "requires-initialization" } },
    profiles: { version: 1, defaultId: "base:gk", profiles }, selected: selected ? ID : "", conversations: selected ? [row()] : [],
    connected: true, interactive: true, loading: false, availability: { canSend: true } };
  chat.executionUnavailable = () => "";
  const poll = (chat as any).poll.bind(chat) as () => Promise<void>;
  (chat as any).poll = async () => {};
  (chat as any).requestSelectedRefresh = () => {};
  (chat as any).refreshConversationHead = async () => {};
  chat.capabilities = () => ({ prompt: true, cancelRun: true });
  catalog.navigate = () => {};
  chat.setDraft({ text: "hello", cwd: "/fixture" });
  return { chat, client, calls, inputs, poll };
}

test("new normal Grok chat bypasses v1 initialization, records once, selects App UUID and renders service messages", async () => {
  const { chat, calls, inputs } = fixture();
  expect(chat.appAdmissionSupported()).toBe(false);
  expect(chat.captureSendSupported()).toBe(true);
  const outcome = await chat.send("hello");
  expect(outcome.status).toBe("recorded");
  expect(calls).toEqual(["turn"]);
  expect(inputs[0]).toMatchObject({ turnIndex: 0, prompt: "hello", model: "custom model", effort: "custom effort", cwd: "/fixture" });
  expect(inputs[0]!.sessionId).toMatch(/^[a-f0-9-]{36}$/);
  expect(chat.state.selected).toBe(inputs[0]!.sessionId);
  expect(chat.state.messages.map(message => message.id)).toEqual([`${chat.state.selected}:0:user`]);
  expect(chat.state.pendingTurn).toBeNull();
  expect(chat.state.runs[0]!.events).toEqual([]);
  expect(chat.state.runs[0]!.nativeCommandId).toBeUndefined();
  expect(chat.draft().text).toBe("");
});

test("continuation obtains exact nextTurnIndex and retains saved model/effort/workspace", async () => {
  const { chat, client, calls, inputs } = fixture(true);
  client.grokSession = async id => { calls.push(`status:${id}`); return view(id, { nextTurnIndex: 7 }); };
  expect((await chat.send("hello")).status).toBe("recorded");
  expect(calls).toEqual([`status:${ID}`, "turn"]);
  expect(inputs[0]).toMatchObject({ sessionId: ID, turnIndex: 7, model: "saved model", effort: "saved effort", workspaceId: "workspace", worktreeId: "checkout" });
  expect(chat.state.messages).toHaveLength(1);
});

test("lost POST response uses exact status only and never claims native acceptance", async () => {
  const { chat, client, calls } = fixture();
  client.grokTurn = async () => { calls.push("turn"); throw new Error("lost response"); };
  const outcome = await chat.send("hello");
  expect(outcome.status).toBe("recorded");
  expect(calls).toEqual(["turn", `status:${chat.state.selected}`]);
  expect(chat.state.grokView?.nativeAcceptance).toBe("unknown");
  expect(chat.state.grokView?.acceptedMessageId).toBeNull();
  expect(chat.state.messages).toHaveLength(1);
});

test("unknown POST and unavailable GET retain original UUID and draft, block repost, then resolve through polling", async () => {
  const { chat, client, calls, poll } = fixture();
  const originalDraft = chat.draftKey();
  client.grokTurn = async () => { calls.push("turn"); throw new Error("lost response"); };
  client.grokSession = async id => { calls.push(`status:${id}`); throw new Error("not found"); };
  expect((await chat.send("hello")).status).toBe("unknown");
  const originalSession = chat.state.selected;
  expect(originalSession).toBeTruthy();
  expect(chat.state.drafts[originalDraft]!.text).toBe("hello");
  expect(chat.state.messages).toEqual([]);
  expect(chat.state.submissionError).toBe(GROK_UNKNOWN_NOTICE);
  expect((await chat.send("hello")).status).toBe("blocked");
  client.grokSession = async id => { calls.push(`status:${id}`); return view(id); };
  await poll();
  expect(chat.state.selected).toBe(originalSession);
  expect(chat.state.availability.canSend).toBe(true);
  expect(chat.state.submissionError).toBe("");
  expect(chat.state.drafts[originalDraft]!.text).toBe("");
  expect(calls.filter(call => call === "turn")).toHaveLength(1);
});

test("stale idle status after a lost continuation response cannot authorize a second POST", async () => {
  const { chat, client, calls } = fixture(true);
  client.grokTurn = async () => { calls.push("turn"); throw new Error("lost response"); };
  expect((await chat.send("hello")).status).toBe("unknown");
  expect(chat.state.availability.canSend).toBe(false);
  expect(chat.draft().text).toBe("hello");
  expect((await chat.send("hello")).status).toBe("blocked");
  expect(calls).toEqual([`status:${ID}`, "turn", `status:${ID}`]);
});

test("pre-POST failure keeps the composer and requires explicit Grok model/effort", async () => {
  const { chat, calls } = fixture();
  chat.state.profiles!.profiles.find(profile => profile.id === "base:gk")!.model = "";
  expect((await chat.send("hello")).status).toBe("blocked");
  expect(calls).toEqual([]);
  expect(chat.draft().text).toBe("hello");
  expect(chat.state.submissionError).toContain("nothing was posted");
});

test("synchronous send guard prevents duplicate POST and preserves a newer composer edit", async () => {
  const { chat, client, inputs } = fixture();
  const pending = Promise.withResolvers<GrokSessionView>();
  client.grokTurn = async input => { inputs.push(input); return pending.promise; };
  const first = chat.send("hello");
  expect((await chat.send("hello")).status).toBe("blocked");
  chat.setDraft({ text: "newer edit" });
  const key = chat.draftKey();
  pending.resolve(view(inputs[0]!.sessionId));
  await first;
  expect(inputs).toHaveLength(1);
  expect(chat.state.drafts[key]!.text).toBe("newer edit");
});

test("late capture response cannot publish into a different auth/selection epoch", async () => {
  const { chat, client } = fixture(true);
  const pending = Promise.withResolvers<GrokSessionView>();
  client.grokTurn = async () => pending.promise;
  const sending = chat.send("hello");
  await Promise.resolve();
  (chat as any).authEpoch++;
  chat.state = { ...chat.state, selected: "other-chat", messages: [], sending: false };
  pending.resolve(view());
  expect((await sending).status).toBe("unknown");
  expect(chat.state.selected).toBe("other-chat");
  expect(chat.state.messages).toEqual([]);
});

test("normal sidebar reopening polls only Grok status, even with generic transcript APIs present", async () => {
  const { chat, calls, poll } = fixture(true);
  await poll();
  expect(calls).toEqual([`status:${ID}`]);
  expect(chat.state.messages).toEqual(view().messages);
  expect(chat.state.transcriptPaged).toBe(false);
  expect(chat.state.connected).toBe(true);
});

test("switching between Grok and CC restores the correct transcript mode and revalidates cached Grok status", async () => {
  const { chat, calls, poll } = fixture(true);
  await poll();
  chat.state.conversations.push({ id: "cc", harness: "claude-code", cwd: "/fixture", lastRunId: null, status: "completed" });
  chat.choose("cc");
  expect(chat.state.transcriptPaged).toBe(true);
  expect(chat.state.grokView).toBeNull();
  chat.choose(ID);
  expect(chat.state.transcriptPaged).toBe(false);
  expect(chat.state.messages).toEqual(view().messages);
  expect(chat.state.availability.canSend).toBe(false);
  await poll();
  expect(chat.state.availability.canSend).toBe(true);
  expect(calls).toEqual([`status:${ID}`, `status:${ID}`]);
});

test("Grok does not reinterpret compact instructions or document/science sends as ordinary input", async () => {
  const { chat, calls } = fixture(true);
  expect((await chat.send("/compact")).status).toBe("blocked");
  expect((await chat.send("hello", false, { preserveDraft: true })).status).toBe("blocked");
  expect(calls).toEqual([]);
  expect(chat.draft().text).toBe("hello");
});

test("active and blocked capture statuses prevent sending; Stop targets the original Grok session without claiming native interruption", async () => {
  const { chat, client, calls, poll } = fixture(true);
  client.grokSession = async id => { calls.push(`status:${id}`); return view(id, { active: true, phase: "running" }); };
  await poll();
  expect((await chat.send("hello")).status).toBe("blocked");
  await chat.cancel();
  expect(calls).toEqual([`status:${ID}`, `stop:${ID}`]);
  expect(chat.state.actionNotice).toContain("Native cancellation is unproven");
  expect(chat.state.selected).toBe(ID);
  expect(grokAvailability(view(ID, { phase: "blocked", blocked: true, reason: "Drain unproven." })).reason).toContain("Drain unproven. Start a new chat.");
});

test("Grok Stop response cannot change another chat after navigation", async () => {
  const { chat, client, calls } = fixture(true);
  const pending = Promise.withResolvers<Awaited<ReturnType<NonNullable<ConversationClient["grokStop"]>>>>();
  client.grokStop = async id => { calls.push(`stop:${id}`); return pending.promise; };
  const stopping = chat.cancel();
  (chat as any).selectionEpoch++;
  chat.state = { ...chat.state, selected: "other-chat", actionNotice: "other notice" };
  pending.resolve({ interrupted: false, wrapperClosed: true, nativeCancellation: "unproven", reason: "Unproven." });
  await stopping;
  expect(calls).toEqual([`stop:${ID}`]);
  expect(chat.state.actionNotice).toBe("other notice");
});

test("CC and OC still require initialized v1 admission and never fall through to Grok or legacy submit", async () => {
  for (const harness of ["claude-code", "opencode"] as const) {
    const { chat, calls } = fixture();
    chat.state.profiles!.defaultId = harness === "claude-code" ? "base:cc" : "base:oc";
    expect(chat.captureSendSupported()).toBe(false);
    expect((await chat.send("hello")).status).toBe("blocked");
    expect(chat.state.submissionError).toContain("App admission requires initialization");
    expect(calls).toEqual([]);
    chat.state.config!.appAdmissionCapability!.state = "enabled";
    expect(chat.captureSendSupported()).toBe(true);
  }
});

test("Grok client transport makes one POST, exact status GET, and Grok Stop only", async () => {
  const requests: { url: string; method: string }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push({ url: String(url), method: init?.method ?? "GET" });
    if (String(url).endsWith("/stop")) return Response.json({ interrupted: false, nativeCancellation: "unproven", wrapperClosed: true, reason: "No native proof." });
    if (init?.method === "POST") throw new Error("response lost");
    return Response.json(view());
  }) as typeof fetch;
  await expect(conversationClient.grokTurn!({ sessionId: ID, turnIndex: 0, prompt: "hello", model: "custom", effort: "custom" })).rejects.toThrow("response lost");
  expect((await conversationClient.grokSession!(ID)).nativeAcceptance).toBe("unknown");
  expect((await conversationClient.grokStop!(ID)).interrupted).toBe(false);
  expect(requests).toEqual([{ url: "/api/grok/turns", method: "POST" }, { url: `/api/grok/sessions/${ID}`, method: "GET" }, { url: `/api/grok/sessions/${ID}/stop`, method: "POST" }]);
});
