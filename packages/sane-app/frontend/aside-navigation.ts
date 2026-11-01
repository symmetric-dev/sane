import { parseAsideDraftRequest } from "../shared/aside-contract";
import { parseAsideConversationOpenResponse } from "../shared/aside-chat-contract";
import { catalog } from "./catalog";
import { ApiError, request } from "./cc-client";
import { chatPresentationKey, captureChatReturn, requestChatReturn, cancelChatReturn } from "./chat-return-state";
import { conversationKey } from "./conversation-cache";
import { store } from "./store";
import type { Conversation } from "./types";
import { getAsideReference, startAsideTiming } from "./aside-client";

export type OpenAsideConversationInput = {
  storeId: string; sourceSessionId: string; asideId: string; sourceFingerprint?: string; draft?: string;
};
const isId = (value: unknown): value is string => typeof value === "string"
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const bindingRevision = (conversation: Conversation) => catalog.snapshot().workspaces
  .find(workspace => workspace.workspaceId === conversation.workspaceId)?.worktrees
  .find(worktree => worktree.worktreeId === conversation.worktreeId)?.bindingRevision;
const sourceKey = (conversation: Conversation) => JSON.stringify([
  conversationKey(conversation), conversation.workspaceId, conversation.worktreeId, bindingRevision(conversation), conversation.replacedBy,
  conversation.aside?.id, conversation.aside?.parentSessionId, conversation.aside?.sourceFingerprint,
]);
// At most one normal-child hydration is pending. Identity stays private, never
// in User Timing names, and subscriptions only cancel; they do not load data.
let pendingHydration: { storeId: string; sessionId: string; current: () => boolean; settle: (ready: boolean) => void } | undefined;
function beginAsideHydration(storeId: string, child: Conversation): void {
  pendingHydration?.settle(false);
  const finish = startAsideTiming("hydrate"), navigation = catalog.snapshot().navigation;
  const storeCurrent = store.conversationNavigationFence(), identity = sourceKey(child);
  const current = () => {
    const state = store.snapshot(), live = state.conversations.find(item => item.id === child.id);
    return storeCurrent() && state.config?.storeId === storeId && !!state.config.authenticated && state.selected === child.id
      && catalog.snapshot().navigation === navigation && !!live && sourceKey(live) === identity;
  };
  let unstore = () => {}, uncatalog = () => {};
  const pending = { storeId, sessionId: child.id, current, settle: (ready: boolean) => {
    if (pendingHydration !== pending) return;
    pendingHydration = undefined;
    unstore(); uncatalog(); finish(ready);
  } };
  pendingHydration = pending;
  const cancelInvalid = () => { if (!current()) pending.settle(false); };
  unstore = store.subscribe(cancelInvalid);
  uncatalog = catalog.subscribe(cancelInvalid);
  cancelInvalid();
}
/** Called only after the regular runtime's transcript-ready marker commits. */
export function finishAsideHydration(storeId: string, sessionId: string): void {
  const pending = pendingHydration;
  if (!pending || pending.storeId !== storeId || pending.sessionId !== sessionId) return;
  if (!pending.current()) { pending.settle(false); return; }
  const state = store.snapshot();
  if (!state.loading && !state.transcriptInitialLoading && !state.transcriptError && state.connected && !state.connectionError && catalog.snapshot().ready) pending.settle(true);
}
let navigationIntent = 0;
function navigationFence(storeId: string) {
  const intent = ++navigationIntent;
  const selected = store.snapshot().selected, source = store.snapshot().conversations.find(item => item.id === selected);
  const identity = source && sourceKey(source), currentStore = store.conversationNavigationFence();
  const navigation = catalog.snapshot().navigation, ready = catalog.snapshot().ready;
  return () => {
    const state = store.snapshot(), currentSource = state.conversations.find(item => item.id === selected);
    return intent === navigationIntent && currentStore() && state.config?.storeId === storeId && !!state.config.authenticated && state.selected === selected
      && catalog.snapshot().ready === ready && catalog.snapshot().navigation === navigation
      && identity === (currentSource && sourceKey(currentSource));
  };
}
const consumedSeeds = new Set<string>();
/** Explain captures before creation too, while the original question is focused. */
export function captureAsideParentReturn(): void {
  const state = store.snapshot(), parent = state.conversations.find(item => item.id === state.selected);
  if (state.config?.storeId && parent) captureChatReturn(chatPresentationKey(state.config.storeId, parent, bindingRevision(parent)));
}
/** Only a consumption marker is durable here. Composer text and send recovery
 * belong exclusively to the normal store/admission ledger. Persist before transfer. */
function seedDraft(input: OpenAsideConversationInput, child: Conversation, text: string) {
  // Historical children and drafts owned by the normal store need no transfer.
  // An explicitly cleared empty entry is owned too; never test draft.text here.
  if (child.lastRunId || Object.hasOwn(store.snapshot().drafts, store.draftKey(child.id))) return;
  const key = `sane:aside-draft-transfer:v1:${JSON.stringify([input.storeId, input.asideId, child.id])}`;
  if (consumedSeeds.has(key)) return;
  let storage: Storage;
  try {
    storage = globalThis.sessionStorage;
    if (storage.getItem(key) === "consumed") { consumedSeeds.add(key); return; }
    storage.setItem(key, "consumed");
    check(storage.getItem(key) === "consumed", "Draft transfer could not be recorded.");
  } catch {
    throw new Error("One-time draft transfer could not be recorded for reload. Enable browser storage and retry opening; the saved aside draft is unchanged.");
  }
  consumedSeeds.add(key);
  store.setDraft({ text }, child.id);
}

/** Materialize and navigate exactly like a hidden worker conversation. This
 * helper never reads live messages, starts polling, or submits a prompt. */
export async function openAsideConversation(input: OpenAsideConversationInput, options: { current?: () => boolean; captureReturn?: boolean } = {}): Promise<boolean> {
  input = { ...input };
  check(isId(input.storeId) && isId(input.sourceSessionId) && isId(input.asideId), "Aside navigation identity is invalid.");
  const navigationCurrent = navigationFence(input.storeId);
  const current = () => navigationCurrent() && (options.current?.() ?? true);
  if (!current()) return false;
  const parent = store.snapshot().conversations.find(item => item.id === input.sourceSessionId);
  check(parent && store.snapshot().selected === parent.id, "Open the original source conversation before opening its aside.");
  const parentIdentity = sourceKey(parent);
  const parentCurrent = () => current() && parentIdentity === sourceKey(store.snapshot().conversations.find(item => item.id === parent.id) ?? parent);
  if (options.captureReturn !== false) captureAsideParentReturn();
  try {
    const record = await getAsideReference({ storeId: input.storeId, sessionId: input.sourceSessionId }, input.asideId, parentCurrent);
    if (!parentCurrent()) return false;
    check(record.id === input.asideId && record.source.storeId === input.storeId && record.source.sessionId === input.sourceSessionId
      && (!input.sourceFingerprint || input.sourceFingerprint === record.source.transcript.fingerprint), "Aside does not match the requested store, source, or saved fingerprint.");
    const text = parseAsideDraftRequest({ requestId: "initial-transfer", expectedRevision: record.revision, text: input.draft ?? record.draft }).text;
    let opened: unknown;
    const finishOpening = startAsideTiming("open");
    try {
      opened = await request(`/api/asides/${encodeURIComponent(input.asideId)}/open`, { method: "POST", body: "{}" });
    } catch (error) {
      // Development rebuilds frontend assets, not the running backend. Only an
      // uncoded router 404 indicates a missing route; keep domain 404s intact.
      if (error instanceof ApiError && error.status === 404 && !error.code)
        throw new Error("The running App server does not support opening aside conversations. Restart the App server, reload, then retry opening this saved aside. Nothing was sent.");
      throw error;
    } finally { finishOpening(); }
    if (!parentCurrent()) return false;
    const destination = parseAsideConversationOpenResponse(opened);
    check(destination.conversationId !== parent.id && destination.asideId === record.id && destination.parentSessionId === parent.id
      && destination.sourceFingerprint === record.source.transcript.fingerprint,
    "Aside materialization did not confirm an independent conversation for this saved source.");
    const finishSummary = startAsideTiming("summary");
    let rows: Conversation[];
    try { rows = await store.ensureConversations([destination.conversationId]); }
    finally { finishSummary(); }
    if (!parentCurrent()) return false;
    const child = rows.find(item => item.id === destination.conversationId);
    const nativeHarness = { cc: "claude-code", oc: "opencode", gk: "grok" } as const;
    check(child && child.id !== parent.id && child.harness === parent.harness && !!child.nativeSessionId && !!child.authorityId
      && !(child.harness === nativeHarness[record.source.native.harness] && child.authorityId === record.source.native.authorityId && child.nativeSessionId === record.source.native.nativeId)
      && !(child.harness === parent.harness && child.authorityId === parent.authorityId && child.nativeSessionId === parent.nativeSessionId)
      && child.aside?.id === record.id && child.aside.parentSessionId === parent.id
      && child.aside.sourceFingerprint === record.source.transcript.fingerprint,
    "Aside conversation summary does not match its independent native identity and saved source.");
    seedDraft(input, child, text);
    if (!parentCurrent()) return false;
    const finishNavigation = startAsideTiming("navigation");
    try { check(store.openConversation(child.id), "Aside conversation could not be opened. Retry opening; nothing was sent."); }
    finally { finishNavigation(); }
    beginAsideHydration(input.storeId, child);
    return true;
  } catch (error) { if (!parentCurrent()) return false; throw error; }
}

/** Parent lookup is targeted (including hidden/historical known sessions), not
 * a sidebar replacement or a newly created conversation. */
export async function openAsideParent(conversation: Conversation): Promise<boolean> {
  const state = store.snapshot(), storeId = state.config?.storeId, aside = conversation.aside;
  check(storeId && aside, "This conversation has no aside parent.");
  const live = state.conversations.find(item => item.id === conversation.id);
  if (state.selected !== conversation.id || !live || sourceKey(live) !== sourceKey(conversation)) return false;
  const current = navigationFence(storeId);
  if (!current()) return false;
  try {
    const rows = await store.ensureConversations([aside.parentSessionId]);
    if (!current()) return false;
    const parent = rows.find(item => item.id === aside.parentSessionId);
    check(parent && parent.id !== conversation.id, "The original parent is no longer available in this App store.");
    requestChatReturn(chatPresentationKey(storeId, parent, bindingRevision(parent)));
    if (!current()) { cancelChatReturn(); return false; }
    if (!store.openConversation(parent.id)) {
      cancelChatReturn();
      throw new Error("The original parent could not be opened. Retry Back to parent.");
    }
    return true;
  } catch (error) { if (!current()) return false; throw error; }
}
