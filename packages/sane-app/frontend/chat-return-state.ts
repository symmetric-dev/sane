import { catalog } from "./catalog";
import { store } from "./store";
import type { Conversation } from "./types";

/** Presentation only: use the existing chat/runtime and the scoped draft owner. */
export function chatPresentationKey(storeId: string, conversation: Conversation, bindingRevision?: string): string {
  if (!storeId || !conversation.id || !conversation.harness || !conversation.authorityId || !conversation.nativeSessionId || !conversation.cwd || conversation.replacedBy) return "";
  return JSON.stringify([storeId, conversation.id, conversation.harness, conversation.authorityId, conversation.nativeSessionId, conversation.cwd, conversation.workspaceId ?? null, conversation.worktreeId ?? null, bindingRevision ?? null]);
}

type QuestionPresentation = {
  scope: string; id: string; page: string | null; expanded: string | undefined;
  contentTop: number; contextTop: number; contextLeft: number;
};
type SemanticFocus = { scope: string; id: string; kind: "explain" | "id" | "label" | "field" | "card"; value?: string };
export type ChatReturnPresentation = {
  top: number; anchor: { id: string; offset: number } | null;
  questions: QuestionPresentation[]; focus: SemanticFocus | null;
};
type ReturnRequest = { key: string; presentation: ChatReturnPresentation; started: number };
const saved = new Map<string, ChatReturnPresentation>();
const listeners = new Set<() => void>();
let pending: ReturnRequest | null = null;
let cleanup = () => {};
let watching = false;
const notify = () => listeners.forEach(listener => listener());
export const subscribeChatReturn = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const pendingChatReturn = (key: string) => pending?.key === key ? pending : null;
export function cancelChatReturn(): void {
  const previous = pending;
  pending = null; cleanup(); cleanup = () => {};
  if (previous) notify();
}
export function completeChatReturn(request: ReturnRequest): void {
  if (pending === request) cancelChatReturn();
}

/** Recheck against live identity, not just a retained DOM node or session ID. */
function identityMatches(key: string): boolean {
  const identity: unknown = JSON.parse(key);
  if (!Array.isArray(identity) || identity.length !== 9) return false;
  const [storeId, id, , , , , workspaceId, worktreeId, revision] = identity;
  const live = store.snapshot();
  if (live.phase !== "ready" || live.config?.authenticated !== true || live.config.storeId !== storeId) return false;
  const conversation = live.conversations.find(item => item.id === id);
  if (!conversation) return false;
  const binding = catalog.snapshot().workspaces.find(item => item.workspaceId === workspaceId)?.worktrees.find(item => item.worktreeId === worktreeId);
  return chatPresentationKey(storeId, conversation, revision === null ? undefined : binding?.bindingRevision) === key;
}
function watchIdentity() {
  if (watching) return;
  watching = true;
  const fence = () => {
    for (const key of saved.keys()) if (!identityMatches(key)) saved.delete(key);
    if (pending && !saved.has(pending.key)) cancelChatReturn();
  };
  // Clear old source presentation on logout, store switches, and native/repository
  // rebinding, even while the ordinary child conversation is being displayed.
  store.subscribe(fence); catalog.subscribe(fence);
}

export function captureChatReturn(key: string): void {
  cancelChatReturn();
  saved.delete(key);
  if (!key || !identityMatches(key)) return;
  // The regular viewport may live in the paired transcript portal outside Thread.
  const root = [...document.querySelectorAll<HTMLElement>("[data-chat-presentation-key]")].find(element => element.dataset.chatPresentationKey === key && element.dataset.chatPresentationActive === "true" && !element.closest("[hidden], [inert]") && element.clientHeight > 0);
  if (!root) return;
  if (root.querySelector<HTMLElement>("[data-send-transcript-ready]")?.dataset.sendTranscriptReady !== (JSON.parse(key) as unknown[])[1]) return;
  const bounds = root.getBoundingClientRect();
  const message = [...root.querySelectorAll<HTMLElement>("[data-transcript-message]")].find(element => { const rect = element.getBoundingClientRect(); return rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom; });
  const cards = [...root.querySelectorAll<HTMLElement>('[data-send-kind="questions"][data-question-scope][data-question-active="true"]')].filter(card => !card.closest("[hidden], [inert]"));
  const focused = root.ownerDocument.activeElement;
  const card = cards.find(element => focused instanceof HTMLElement && element.contains(focused))
    ?? cards.find(element => { const rect = element.getBoundingClientRect(); return element.dataset.expanded === "true" && rect.bottom > bounds.top && rect.top < bounds.bottom; });
  let focus: SemanticFocus | null = null;
  if (card) {
    const element = focused instanceof HTMLElement && card.contains(focused) ? focused : null;
    focus = { scope: card.dataset.questionScope!, id: card.dataset.sendId!, kind: "explain" };
    if (element?.dataset.questionFocus === "explain") { /* Prefer its semantic action after remount. */ }
    else if (element?.id) focus = { ...focus, kind: "id", value: element.id };
    else if (element?.getAttribute("aria-label")) focus = { ...focus, kind: "label", value: element.getAttribute("aria-label")! };
    else if (element) focus = { ...focus, kind: element.closest("[data-question-page]") ? "field" : "card" };
  }
  const presentation: ChatReturnPresentation = {
    top: root.scrollTop,
    anchor: message ? { id: message.dataset.transcriptMessage!, offset: message.getBoundingClientRect().top - bounds.top } : null,
    // Compact, unrelated history cards may leave the cached transcript island.
    // Only the selected/expanded questionnaire (and focused card) gates return.
    questions: cards.filter(element => element === card || element.dataset.expanded === "true").slice(0, 8).map(element => {
      const context = element.querySelector<HTMLElement>(".user-questions-context");
      return { scope: element.dataset.questionScope!, id: element.dataset.sendId!, page: element.querySelector<HTMLElement>("[data-question-page]")?.dataset.questionPage ?? null, expanded: element.dataset.expanded,
        contentTop: element.querySelector<HTMLElement>(".user-questions-content")?.scrollTop ?? 0, contextTop: context?.scrollTop ?? 0, contextLeft: context?.scrollLeft ?? 0 };
    }), focus,
  };
  saved.delete(key); saved.set(key, presentation);
  while (saved.size > 8) saved.delete(saved.keys().next().value!);
  watchIdentity();
}

/** Call immediately BEFORE the normal store.openConversation(parentId). */
export function requestChatReturn(key: string): void {
  cancelChatReturn();
  const presentation = saved.get(key);
  if (!presentation || !identityMatches(key)) return;
  const request: ReturnRequest = { key, presentation, started: performance.now() };
  pending = request;
  // Bound runtime/metadata catch-up; never start a second transcript fetcher or
  // keep a deferred focus that can fire after the user has moved elsewhere.
  const timer = setTimeout(() => { if (pending === request) cancelChatReturn(); }, 5000);
  cleanup = () => clearTimeout(timer);
  notify();
  // Ignore the initiating Back click and synchronous navigation publications.
  queueMicrotask(() => {
    if (pending !== request) return;
    const navigation = catalog.snapshot().navigation;
    const [, id, , , , , workspaceId, worktreeId] = JSON.parse(key) as unknown[];
    const fence = () => {
      const next = catalog.snapshot().navigation;
      if (!identityMatches(key) || store.snapshot().selected !== id || !["chat", "browser"].includes(next.view) || next.conversationId !== id || next.workspaceId !== workspaceId || next.worktreeId !== worktreeId
        || next.view !== navigation.view || next.conversationId !== navigation.conversationId || next.workspaceId !== navigation.workspaceId || next.worktreeId !== navigation.worktreeId) cancelChatReturn();
    };
    const interrupt = () => { if (pending === request) cancelChatReturn(); };
    const keydown = (event: KeyboardEvent) => { if (!["Shift", "Control", "Alt", "Meta", "AltGraph"].includes(event.key)) interrupt(); };
    const unstore = store.subscribe(fence), uncatalog = catalog.subscribe(fence);
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("pointerdown", interrupt, true);
    document.addEventListener("wheel", interrupt, { capture: true, passive: true });
    document.addEventListener("touchstart", interrupt, { capture: true, passive: true });
    cleanup = () => {
      clearTimeout(timer); unstore(); uncatalog();
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("pointerdown", interrupt, true);
      document.removeEventListener("wheel", interrupt, true);
      document.removeEventListener("touchstart", interrupt, true);
    };
    fence();
  });
}

/** Null means the exact scoped questionnaire/page has not remounted yet. */
export function restoreQuestionPresentation(root: HTMLElement, presentation: ChatReturnPresentation): { focus: HTMLElement | null } | null {
  const cards = [...root.querySelectorAll<HTMLElement>('[data-send-kind="questions"][data-question-scope][data-question-active="true"]')].filter(card => !card.closest("[hidden], [inert]"));
  const findCard = (scope: string, id: string) => cards.find(card => card.dataset.questionScope === scope && card.dataset.sendId === id);
  for (const saved of presentation.questions) {
    const card = findCard(saved.scope, saved.id);
    if (!card || card.dataset.expanded !== saved.expanded || card.querySelector<HTMLElement>("[data-question-page]")?.dataset.questionPage !== (saved.page ?? undefined)) return null;
  }
  for (const saved of presentation.questions) {
    const card = findCard(saved.scope, saved.id)!;
    const content = card.querySelector<HTMLElement>(".user-questions-content"), context = card.querySelector<HTMLElement>(".user-questions-context");
    if (content) content.scrollTop = saved.contentTop;
    if (context) { context.scrollTop = saved.contextTop; context.scrollLeft = saved.contextLeft; }
  }
  const savedFocus = presentation.focus;
  const card = savedFocus && findCard(savedFocus.scope, savedFocus.id);
  if (!card || !savedFocus) return { focus: null };
  const usable = (element: HTMLElement) => !element.closest("[hidden], [inert], :disabled") && element.getClientRects().length > 0;
  const controls = [...card.querySelectorAll<HTMLElement>("[id], [aria-label], [data-question-focus]")];
  const exact = controls.find(element => savedFocus.kind === "explain" ? element.dataset.questionFocus === "explain" : savedFocus.kind === "id" ? element.id === savedFocus.value : savedFocus.kind === "label" ? element.getAttribute("aria-label") === savedFocus.value : false);
  const field = card.querySelector<HTMLElement>("[data-question-page]");
  return { focus: exact && usable(exact) ? exact : field && usable(field) ? field : card };
}
