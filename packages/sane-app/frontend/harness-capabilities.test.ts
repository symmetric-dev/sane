import { expect, test } from "bun:test";
import { act, createElement as h } from "react";
import type { Root } from "react-dom/client";
import { Window } from "happy-dom";
import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime } from "@assistant-ui/react";
import { capabilitiesFor, getHarnessDescriptor, type HarnessCapabilities } from "../shared/conversation/harness-capabilities";
import { builtinProfiles } from "../src/agent-profiles-contract";
import type { CompactState } from "../src/oc-contract";
import type { TranscriptPage } from "../src/transcript-contract";
import { ChatStore, store, type State } from "./store";
import { catalog } from "./catalog";
import { ChatComposer } from "./chat-composer";
import { CompactControl, CompactDialog } from "./compaction-ui";
import { BranchAction } from "./branch-ui";
import { ConfigView, configSection } from "./config-view";
import { Interactions } from "./interactions";
import { AttachConversation } from "./attach-conversation";
import { ChatMessage, convertMessage, Thread, TranscriptContext, type TranscriptContextValue } from "./thread";
import { mergePage } from "./transcript-pages";
import type { Conversation, ConversationClient, Harness, InteractionReply, Message } from "./types";

const unknown = "unknown-native" as Harness;
const time = "2026-10-03T00:00:00.000Z";
const conversation = (harness: Harness): Conversation => ({ id: "A", harness, nativeSessionId: "native-A", cwd: "/fixture", lastRunId: null, status: "completed", association: "resolved", workspaceId: "workspace", worktreeId: "tree" });
const compactState = (): CompactState => ({ sessionId: "A", eligibility: { eligible: true, supportsInstructions: true, nativeActivity: "idle" }, operations: [] });
const page = (): TranscriptPage => ({ sessionId: "A", revision: "r1", epoch: "e1", usage: null, messages: [], coverage: { firstId: null, lastId: null, firstIndex: null, lastIndex: null, totalMessages: 0, olderCursor: null, newerCursor: null }, continuation: { older: false, newer: false } });
function fixture(harness: Harness, advertised?: Partial<HarnessCapabilities>, paged = false) {
  const calls: string[] = [];
  const c = conversation(harness);
  const client: ConversationClient = {
    config: async () => ({ authenticated: true, authRequired: false }), login: async () => {}, logout: async () => {},
    conversations: async () => ({ conversations: [c], availability: { canSend: true } }), runs: async () => [], events: async () => ({ events: [], nextCursor: 0, status: "completed" }),
    models: async () => { calls.push("models"); return [{ id: "provider/model", name: "Model", efforts: [] }]; },
    interactions: async () => { calls.push("interactions"); return [{ id: "permission", type: "permission", title: "Permission" }, { id: "question", type: "question", title: "Question" }]; },
    reply: async (_id, _interaction, reply) => { calls.push(`reply:${reply.type}`); }, cancel: async () => { calls.push("cancel"); return { interrupted: true }; },
    reconcile: async () => { calls.push("reconcile"); return { history: { sessionId: "A", nativeSessionId: "native-A", importedAt: time, activity: "idle", reason: "fixture", coveredRunIds: [], messages: [] } }; },
    compactState: async () => { calls.push("compactState"); return compactState(); },
    compact: async (_id, input) => { calls.push("compact"); return { sessionId: "A", runId: "C", operation: { id: "C", sessionId: "A", harness, trigger: "manual", lifecycle: "requested", contextReset: false, requestId: input.requestId } }; },
    submit: async () => { calls.push("submit"); return { conversationId: "A", runId: "R" }; },
    ...(paged ? { transcriptPage: async () => page(), transcriptMeta: async () => ({ sessionId: "A", epoch: "e1", revision: "r1", usage: null, metadataRevision: "m1", items: [], nextCursor: null }), transcriptRefresh: async () => ({ sessionId: "A", epoch: "e1", revision: "r1", usage: null, processed: 0, upserts: [], removedIds: [] }) } : {}),
  };
  const chat = new ChatStore(client);
  chat.state = { ...chat.state, phase: "ready", selected: "A", conversations: [c], loading: false, connected: true, availability: { canSend: true }, compactState: compactState(), ...(advertised ? { config: { authenticated: true, authRequired: false, harnesses: [{ id: harness, available: true, connected: true, state: "connected", capabilities: advertised }] } } : {}) };
  chat.executionUnavailable = () => "";
  chat.reconnect = () => {};
  const internal = chat as unknown as { poll(): Promise<void>; stop(): void };
  return { chat, client, c, calls, close: () => internal.stop(), poll: async () => { try { await internal.poll(); } finally { internal.stop(); } } };
}

test("older configs receive known static capabilities; explicit harness lookup never uses aggregate permissions", async () => {
  const f = fixture("claude-code");
  try {
    f.chat.state.config = { authenticated: true, authRequired: false, capabilities: { permissionReplies: true } } as State["config"];
    expect(f.chat.capabilities().cancelRun).toBe(true);
    expect(f.chat.capabilities().permissionReplies).toBe(false);
    expect(f.chat.capabilities("opencode").permissionReplies).toBe(true);
    expect(f.chat.capabilities(unknown)).toEqual({});
    await f.chat.reply("permission", { type: "permission", decision: "once" });
    await f.chat.reply("question", { type: "question", answer: {} });
    expect(f.calls).toEqual([]);
  } finally { f.close(); }
});

test("matching advertisements narrow static actions and cannot alter native model/effort modes", async () => {
  const f = fixture("opencode", { cancelRun: false, compaction: false, listModels: false, permissionReplies: false, questionReplies: false, nativeHistoryRefresh: false, prompt: false, catalogRequiredForSend: false, modelInput: "free-text", effortMode: "fixed" });
  try {
    expect(f.chat.capabilities().modelInput).toBe("live-catalog");
    expect(f.chat.capabilities().effortMode).toBe("model-variant");
    expect(f.chat.capabilities().catalogRequiredForSend).toBe(true);
    expect(f.chat.capabilities("claude-code").compaction).toBe(true);
    await f.chat.cancel(); await f.chat.reconcile(); await f.chat.loadModels(); await f.chat.refreshCompact(); await f.chat.compact();
    await f.chat.reply("permission", { type: "permission", decision: "once" }); await f.chat.reply("question", { type: "question", answer: {} });
    expect(await f.chat.send("hello")).toEqual({ status: "blocked" });
    expect(f.calls).toEqual([]);
  } finally { f.close(); }
});

test("cancelRun-only overrides remain partial; known static false cannot be elevated", async () => {
  const f = fixture("opencode");
  try {
    f.chat.capabilities = () => ({ cancelRun: false });
    await f.chat.cancel(); await f.chat.reply("permission", { type: "permission", decision: "once" }); await f.chat.loadModels();
    expect(f.calls).toEqual(["reply:permission", "models"]);
    expect(f.chat.modelUnavailable()).toBe(false);
    f.c.harness = "claude-code";
    f.chat.capabilities = () => ({ cancelRun: true, permissionReplies: true, questionReplies: true });
    await f.chat.reply("permission", { type: "permission", decision: "once" }); await f.chat.reply("question", { type: "question", answer: {} });
    expect(f.calls).toEqual(["reply:permission", "models"]);
  } finally { f.close(); }
});

test("unknown harness makes no native action calls, even with positive advertisements", async () => {
  const f = fixture(unknown, { prompt: true, compaction: true, cancelRun: true, listModels: true, nativeHistoryRefresh: true, listInteractions: true, permissionReplies: true, questionReplies: true });
  try {
    expect(f.chat.capabilities()).toEqual({});
    f.chat.capabilities = () => ({ cancelRun: true });
    await f.chat.cancel(); await f.chat.reconcile(); await f.chat.loadModels(); await f.chat.refreshCompact(); await f.chat.compact();
    await f.chat.reply("permission", { type: "permission", decision: "once" }); await f.chat.reply("question", { type: "question", answer: {} });
    expect(await f.chat.send("hello")).toEqual({ status: "blocked" });
    await f.poll();
    expect(f.calls).toEqual([]);
  } finally { f.close(); }
});

for (const paged of [false, true]) for (const harness of ["opencode", "claude-code", unknown] as const) test(`${paged ? "paged" : "legacy"} interaction polling uses ${harness} static support with older config`, async () => {
  const f = fixture(harness, undefined, paged);
  try {
    await f.poll();
    expect(f.calls.filter(call => call === "interactions")).toHaveLength(harness === "opencode" ? 1 : 0);
    expect(f.chat.state.interactions).toHaveLength(harness === "opencode" ? 2 : 0);
  } finally { f.close(); }
});

for (const paged of [false, true]) test(`${paged ? "paged" : "legacy"} listing restrictions are independent from individual reply support`, async () => {
  const f = fixture("opencode", { permissionReplies: false }, paged);
  try {
    await f.poll();
    expect(f.chat.state.interactions).toHaveLength(2);
    const permission: InteractionReply = { type: "permission", decision: "once" }, question: InteractionReply = { type: "question", answer: {} };
    await f.chat.reply("permission", permission); await f.chat.reply("question", question);
    expect(f.calls.filter(call => call.startsWith("reply:"))).toEqual(["reply:question"]);
    f.chat.state.config!.harnesses![0]!.capabilities = { listInteractions: false, questionReplies: false };
    f.calls.length = 0;
    await f.poll(); await f.chat.reply("question", question); await f.chat.reply("permission", permission);
    expect(f.calls.filter(call => call === "interactions" || call.startsWith("reply:"))).toEqual(["reply:permission"]);
  } finally { f.close(); }
});

test("optional client action methods remain a runtime restriction", async () => {
  const f = fixture("opencode");
  try {
    for (const key of ["cancel", "reply", "models", "interactions", "reconcile", "compact", "compactState"] as const) Reflect.deleteProperty(f.client, key);
    await f.chat.cancel(); await f.chat.reply("permission", { type: "permission", decision: "once" }); await f.chat.loadModels(); await f.chat.reconcile(); await f.chat.compact(); await f.chat.refreshCompact(); await f.poll();
    expect(f.calls).toEqual([]);
  } finally { f.close(); }
});

for (const type of ["permission", "question"] as const) for (const oldFirst of [false, true]) test(`${type} replies keep selection fences with partial cancel-only overrides (${oldFirst ? "old first" : "old last"})`, async () => {
  const f = fixture("opencode");
  const old = Promise.withResolvers<void>(), fresh = Promise.withResolvers<void>();
  let calls = 0;
  f.client.reply = () => ++calls === 1 ? old.promise : fresh.promise;
  f.chat.state.phase = "connecting";
  f.chat.state.conversations.push({ ...f.c, id: "B" });
  f.chat.capabilities = () => ({ cancelRun: true });
  const reply: InteractionReply = type === "permission" ? { type, decision: "once" } : { type, answer: {} };
  try {
    const previous = f.chat.reply(type, reply); f.chat.choose("B"); f.chat.choose("A");
    const current = f.chat.reply(type, reply);
    expect(calls).toBe(2);
    if (oldFirst) { old.resolve(); await previous; expect(f.chat.state.actionBusy).toBe(true); expect(f.chat.state.actionNotice).toBe(""); }
    fresh.resolve(); await current;
    const notice = f.chat.state.actionNotice;
    if (!oldFirst) { old.resolve(); await previous; }
    expect(f.chat.state.actionBusy).toBe(false); expect(f.chat.state.actionNotice).toBe(notice);
    expect(notice).toContain("Reply sent");
  } finally { old.resolve(); fresh.resolve(); f.close(); }
});

test("catalog-required send policy does not turn connection or directory availability into static support", async () => {
  const f = fixture("opencode");
  try {
    expect(f.chat.modelUnavailable()).toBe(true);
    expect(await f.chat.send("hello")).toEqual({ status: "blocked" });
    await f.chat.loadModels();
    expect(f.chat.modelUnavailable()).toBe(false);
    f.chat.state.modelsCwd = "/other"; expect(f.chat.modelUnavailable()).toBe(true);
    f.c.harness = "claude-code"; expect(f.chat.modelUnavailable()).toBe(false);
    f.chat.state.connected = false; expect(await f.chat.send("hello")).toEqual({ status: "blocked" });
    expect(f.calls).toEqual(["models"]);
  } finally { f.close(); }
});

test("catalog lookup uses its explicit profile harness rather than a different selected conversation", async () => {
  const f = fixture("claude-code");
  try {
    await f.chat.loadModels(); expect(f.calls).toEqual([]);
    await f.chat.loadModels("opencode"); expect(f.calls).toEqual(["models"]);
    await f.chat.loadModels(unknown); expect(f.calls).toEqual(["models"]);
    expect(f.chat.harness()).toBe("claude-code");
  } finally { f.close(); }
});

test("attached sends require a fresh acknowledgement only where static policy demands it", async () => {
  for (const harness of ["opencode", "claude-code"] as const) {
    const f = fixture(harness);
    f.c.attachment = { state: "ready" };
    f.chat.state.modelsLoaded = true; f.chat.state.modelsCwd = "/fixture";
    try {
      const first = await f.chat.send("hello");
      expect(first.status).toBe(harness === "claude-code" ? "blocked" : "accepted");
      if (harness === "claude-code") {
        expect(f.chat.state.submissionError).toContain("Confirm external");
        expect((await f.chat.send("hello", true)).status).toBe("accepted");
        f.close(); f.chat.state.connected = true; f.chat.state.availability = { canSend: true }; f.chat.state.loading = false;
        expect((await f.chat.send("hello again")).status).toBe("blocked");
      }
      expect(f.calls.filter(call => call === "submit")).toHaveLength(1);
    } finally { f.close(); }
  }
});

test("instructions and attached acknowledgement follow static policy plus runtime eligibility", async () => {
  for (const harness of ["opencode", "claude-code"] as const) {
    const f = fixture(harness);
    try {
      f.c.attachment = { state: "ready" };
      f.chat.setDraft({ text: "unchanged", upgradeId: "unchanged-upgrade" });
      f.chat.openCompact("preserve decisions");
      expect(f.chat.state.compactDialog).toBe(harness === "claude-code" ? "A" : undefined);
      expect(f.chat.draft()).toMatchObject({ text: "unchanged", upgradeId: "unchanged-upgrade" });
      f.calls.length = 0;
      f.chat.setCompactInstructions("preserve decisions"); await f.chat.compact();
      expect(f.calls).not.toContain("compact");
      expect(f.chat.state.compactError).toContain(harness === "claude-code" ? "Confirm external" : "does not support");
      if (harness === "claude-code") {
        f.chat.state.compactState!.eligibility.supportsInstructions = false;
        await f.chat.compact(true); expect(f.calls).not.toContain("compact");
        f.chat.state.compactState!.eligibility.supportsInstructions = true;
        await f.chat.compact(true); expect(f.calls).toContain("compact");
        expect(f.chat.draft().text).toBe("unchanged");
      }
    } finally { f.close(); }
  }
});

async function withDom(run: (host: HTMLDivElement, root: Root, browser: Window, requests: string[]) => Promise<void>) {
  const browser = new Window({ url: "http://localhost" });
  const requests: string[] = [];
  const globals = { window: browser, self: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage, HTMLElement: browser.HTMLElement, Event: browser.Event, MouseEvent: browser.MouseEvent, FormData: browser.FormData, ResizeObserver: browser.ResizeObserver, MutationObserver: browser.MutationObserver, requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (input: string | URL | Request) => { const url = String(input); requests.push(url); if (url.includes("/branch?")) return Response.json({ eligible: true }); if (url.endsWith("/handoffs")) return Response.json({ handoffs: [] }); throw new Error(`Unexpected mocked request: ${url}`); } };
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const oldState = store.state, oldCatalog = catalog.state, oldSection = configSection.snapshot();
  let root: Root | undefined;
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  try {
    catalog.state = { ...oldCatalog, ready: true, workspaces: [{ workspaceId: "workspace", kind: "directory", name: "Fixture", commonDir: null, worktrees: [{ worktreeId: "tree", root: "/fixture", gitDir: null, bindingRevision: "binding", state: "available" }] }], navigation: { ...oldCatalog.navigation, view: "config", workspaceId: "workspace", worktreeId: "tree" } };
    const f = fixture("claude-code"); store.state = { ...f.chat.state, modelsLoaded: true, modelsCwd: "/fixture", modelsError: "", drafts: {} }; f.close();
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await run(host, root, browser, requests);
  } finally {
    if (root) await act(async () => root!.unmount());
    store.state = oldState; catalog.state = oldCatalog; configSection.set(oldSection); browser.close();
    for (const [key, descriptor] of prior) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}

test("composer and compaction UI use instruction/ack policies, and unknown harness exposes no native controls", async () => {
  await withDom(async (host, root) => {
    for (const harness of ["claude-code", "opencode", unknown] as const) {
      const c = conversation(harness); c.attachment = { state: "ready" };
      store.state = { ...store.state, conversations: [c], compactState: compactState(), compactDialog: "A" };
      await act(async () => store.setDraft({ text: "hello" }));
      await act(async () => root.render(h("div", {}, h(ChatComposer, { state: store.state, ack: "", onAckChange: () => {}, send: () => {}, sendDisabled: false }), h(CompactControl, { state: store.state }), h(CompactDialog, { state: store.state }))));
      expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(harness === "claude-code" ? 2 : 0);
      expect(host.querySelector(".compact-form textarea") !== null).toBe(harness === "claude-code");
      expect(host.querySelector(".compact-control") !== null).toBe(harness !== unknown);
      expect(host.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.disabled).toBe(harness !== "opencode");
    }
  });
});

test("interaction UI filters each reply type rather than treating an aggregate flag as permission", async () => {
  await withDom(async (host, root) => {
    store.state.interactions = [{ id: "p", type: "permission", title: "Permission" }, { id: "q", type: "question", title: "Question", fields: [] }];
    for (const harness of ["opencode", "claude-code", unknown] as const) {
      store.state.conversations = [conversation(harness)];
      store.state.config = { authenticated: true, authRequired: false, harnesses: [{ id: harness, connected: true, available: true, state: "connected", capabilities: { permissionReplies: false, questionReplies: true } }] };
      await act(async () => root.render(h(Interactions, { state: store.state })));
      expect([...host.querySelectorAll(".interaction h3")].map(node => node.textContent)).toEqual(harness === "opencode" ? ["Question"] : []);
    }
  });
});

test("attachment controls honor per-harness support without conflating it with connection availability", async () => {
  await withDom(async (host, root, _browser, requests) => {
    store.state.config = { authenticated: true, authRequired: false, harnesses: [{ id: "opencode", available: false, connected: false, state: "unavailable", capabilities: { attachHistory: false } }] };
    await act(async () => root.render(h(AttachConversation, { onChoose: () => {} })));
    expect(host.querySelector<HTMLButtonElement>(".new-chat")!.disabled).toBe(false);
    await act(async () => host.querySelector<HTMLButtonElement>(".new-chat")!.click());
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    const select = host.querySelector<HTMLSelectElement>("select")!;
    await act(async () => { select.value = "claude-code"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    expect(host.querySelector<HTMLInputElement>('[name="nativeSessionId"]')!.placeholder).toBe("Session UUID");
    expect(host.textContent).toContain("Before every SANE send");
    expect(requests).toEqual([]);
  });
});

test("profile editor dispatches explicit free-text/fixed and live-catalog/variant modes; unknown has neither", async () => {
  await withDom(async (host, root) => {
    for (const harness of ["claude-code", "opencode", unknown] as const) {
      const profile = { ...builtinProfiles("").find(p => p.kind === "assistant")!, id: `profile-${harness}`, harness, model: "", effort: "" };
      store.state = { ...store.state, config: undefined, profiles: { version: 1, defaultId: profile.id, profiles: [profile] }, models: [{ id: "provider/model", name: "Model", efforts: [{ id: "variant", name: "Variant" }] }] };
      configSection.set("agents");
      await act(async () => root.render(h(ConfigView, { key: harness, state: store.state, signOut: () => {} })));
      await act(async () => host.querySelector<HTMLButtonElement>(`[data-agent-id="${profile.id}"]`)!.click());
      expect(host.querySelector("#agent-cc-model") !== null).toBe(harness === "claude-code");
      expect(host.querySelector("#agent-cc-effort") !== null).toBe(harness === "claude-code");
      expect(host.querySelector("#agent-oc-model") !== null).toBe(harness === "opencode");
      expect(host.querySelector("#agent-oc-variant") !== null).toBe(harness === "opencode");
      if (harness === "claude-code") expect([...host.querySelectorAll("#agent-cc-effort option")].map(option => option.getAttribute("value"))).toEqual(["", "low", "medium", "high", "xhigh", "max"]);
      if (harness === unknown) expect(host.textContent).toContain("Unsupported harness.");
    }
  });
});

test("branch dialog respects first-prompt policy and unsupported native-message boundaries", async () => {
  await withDom(async (host, root, _browser, requests) => {
    for (const harness of ["claude-code", "opencode", unknown] as const) {
      await act(async () => root.render(h(BranchAction, { key: harness, sessionId: "A", harness, runId: "R" })));
      if (harness === unknown) { expect(host.querySelector("button")).toBeNull(); continue; }
      await act(async () => host.querySelector<HTMLButtonElement>(".branch-action")!.click());
      expect(host.querySelector<HTMLTextAreaElement>(".branch-prompt textarea")!.required).toBe(harness === "claude-code");
      expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(harness === "claude-code");
    }
    expect(requests.filter(url => url.includes("/branch?"))).toHaveLength(2);
    for (const harness of ["claude-code", unknown] as const) {
      await act(async () => root.render(h(BranchAction, { key: `native-${harness}`, sessionId: "A", harness, messageId: "native-message" })));
      expect(host.querySelector(".branch-action")).toBeNull();
    }
  });
});

function TestTranscript({ value }: { value: TranscriptContextValue }) {
  const runtime = useExternalStoreRuntime({ messages: value.messages, convertMessage, isRunning: false, isSendDisabled: true, onNew: async () => {} });
  return h(TranscriptContext.Provider, { value }, h(AssistantRuntimeProvider, { runtime }, h(ThreadPrimitive.Root, {}, h(ThreadPrimitive.Messages, { components: { Message: ChatMessage } }))));
}
const imported = (): Message => ({ id: "native-message", version: "v1", runId: "native-import", role: "assistant", parts: [{ type: "text", text: "Completed native turn" }], status: "completed", time });

test("imported branch actions still require completed, last-in-turn, proven paged boundaries", async () => {
  await withDom(async (host, root) => {
    const message = imported();
    const boundaryPage: TranscriptPage = { ...page(), messages: [message as TranscriptPage["messages"][number]], coverage: { firstId: message.id, lastId: message.id, firstIndex: 0, lastIndex: 0, totalMessages: 2, olderCursor: null, newerCursor: "more" }, continuation: { older: false, newer: true } };
    const transcript = mergePage(null, boundaryPage);
    for (const [harness, status, boundary, enabled] of [["opencode", "completed", true, true], ["opencode", "completed", false, false], ["opencode", "running", true, false], ["claude-code", "completed", true, false], [unknown, "completed", true, false]] as const) {
      const source = { ...message, status };
      const value: TranscriptContextValue = { sessionId: "A", harness, messages: [source], runs: [], workers: [], openWorker: () => {}, branchEnabled: true, ...(boundary ? {} : { pageState: { ...store.state, transcript } }) };
      await act(async () => root.render(h(TestTranscript, { value })));
      expect(host.querySelector(".branch-action") !== null).toBe(enabled);
    }
    const value: TranscriptContextValue = { sessionId: "A", harness: "opencode", messages: [message, { ...message, id: "next" }], runs: [], workers: [], openWorker: () => {}, branchEnabled: true };
    await act(async () => root.render(h(TestTranscript, { value })));
    expect(host.querySelectorAll(".branch-action")).toHaveLength(1);
  });
});

test("thread keeps attached CC and managed workers unbranchable while allowing idle attached OC", async () => {
  await withDom(async (host, root) => {
    for (const [harness, worker, enabled] of [["opencode", false, true], ["claude-code", false, false], ["opencode", true, false], [unknown, false, false]] as const) {
      const c = conversation(harness); c.attachment = { state: "ready" };
      if (worker) c.worker = { id: "worker-A", parent: { sessionId: "parent", runId: "parent-run", toolCallId: "call" } };
      store.state = { ...store.state, conversations: [c], messages: [imported()], compactState: null, compactions: [], config: undefined };
      await act(async () => root.render(h(Thread, { state: store.state, active: false })));
      expect(host.querySelector(".branch-action") !== null).toBe(enabled);
    }
    const c = conversation("opencode"); c.agent = "implementer"; c.agentKind = "worker";
    store.state = { ...store.state, conversations: [c] };
    expect(store.conversationKind()).toBe("worker");
    await act(async () => root.render(h(Thread, { state: store.state, active: false })));
    expect(host.querySelector(".branch-action")).toBeNull();
  });
});

test("native identity mapping is explicit and unknown descriptors do not resolve to CC", () => {
  expect(getHarnessDescriptor("opencode")?.nativeHarness).toBe("oc");
  expect(getHarnessDescriptor("claude-code")?.nativeHarness).toBe("cc");
  expect(getHarnessDescriptor(unknown)).toBeUndefined();
  expect(capabilitiesFor(unknown, { listInteractions: true })).toEqual({});
});
