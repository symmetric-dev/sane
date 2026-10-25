import { catalog } from "./catalog";
import { compactCommand } from "./compaction";
import { pendingInteractions } from "./interaction-presentation";
import { store, type State } from "./store";
import { active, liveInputReady } from "./types";
import { browserPairIntentMatches, type BrowserPairIntent } from "./browser-pair";
import { ApiError, conversationClient } from "./cc-client";

export function browserPairPreparationBusy(state: State): boolean {
  const conversation = state.conversations.find(item => item.id === state.selected);
  const running = !!conversation && (active(conversation.status) || state.runs.some(run => active(run.status)));
  // choose deliberately resets selected availability during hydration. Only an
  // already-known, matching live-input summary can admit an active target then.
  const availability = state.loading ? conversation?.availability ?? state.availability : state.availability;
  return state.sending || state.actionBusy || !!state.availability.nativeQueue || !!state.availability.queueAfterRunId
    || !!availability.nativeQueue || !!availability.queueAfterRunId || running && !liveInputReady(conversation, availability);
}

/** The modal is another ordinary prompt surface, not a queue or command runner. */
export function browserPairMessageBlocked(state: State, text: string, nativeStopped: boolean): string {
  const conversation = state.conversations.find(item => item.id === state.selected);
  const capabilities = store.capabilities();
  if (compactCommand(text)) return "Paired, but /compact was not sent. Use the composer or Context controls to compact this conversation.";
  if (!conversation) return "The paired conversation is unavailable. No message was sent.";
  if (pendingInteractions(state, capabilities).length || state.interactionError) return "Resolve pending requests in the conversation before sending this message.";
  if (store.pendingInputChainLocked() || state.pendingInputLoading || state.pendingInputError
    || Object.values(state.pendingInputOperations ?? {}).some(operation => operation.conversationId === conversation.id && ["pending", "unknown"].includes(operation.state))) {
    return "Resolve or check the existing input queue in the conversation before sending this message.";
  }
  if (Object.values(state.unconfirmedSubmissions ?? {}).some(item => item.conversationId === conversation.id) || state.sciencePending?.[conversation.id]
    || state.scienceSubmissions?.[conversation.id]?.some(item => item.state === "prepared" || item.state === "unknown") || state.scienceSubmissionError) {
    return "A previous submission is unresolved. Check this conversation’s history and submission controls before sending again.";
  }
  if (store.compactBlocked() || state.pendingCompacts?.[conversation.id]?.phase === "unconfirmed") return "Resolve the current or unconfirmed compaction in Context before sending this message.";
  if (!capabilities.prompt) return "This conversation does not support prompts. It is still paired for reading.";
  if (state.loading || state.transcriptInitialLoading || state.transcriptRefreshing || state.metadataError || state.transcriptError) return "Conversation history is not ready. Check the conversation, then try OK again.";
  if (state.actionBusy || state.sending) return "Wait for the current action to finish, then try OK again.";
  if (capabilities.attachedSendRequiresNativeStopped && conversation.attachment && !nativeStopped) return "Confirm that external assistant execution is stopped, or remove the optional message to pair without sending.";
  const running = active(conversation.status) || state.runs.some(run => active(run.status));
  if (state.availability.nativeQueue || state.availability.queueAfterRunId || running && !liveInputReady(conversation, state.availability)) return "The conversation is busy. It remains paired; use its composer when ready, or try OK again yourself.";
  if (!(state.interactive ?? state.connected) || !state.connected || !state.availability.canSend) return state.availability.reason || "The conversation cannot send right now. Check its composer, then try OK again.";
  if (store.modelUnavailable()) return "The conversation’s model is unavailable. Resolve its model selection in Chat before sending.";
  return store.executionUnavailable() || "";
}

/** Initial selection publishes connected/history before its interaction reads
 * finish. Reuse the existing read-only client to check those inboxes explicitly;
 * an empty, not-yet-hydrated inbox must never authorize this optional prompt. */
export async function checkBrowserPairPrompt(intent: BrowserPairIntent, text: string, nativeStopped: boolean, signal: AbortSignal): Promise<string> {
  const assertCurrent = () => {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Preparing the optional message timed out or was cancelled. No message was sent.");
    if (!browserPairIntentMatches(intent, store.snapshot(), catalog.snapshot(), true)) throw new Error("Pairing changed. No message was sent. Close this dialog and connect again.");
    const blocked = browserPairMessageBlocked(store.snapshot(), text, nativeStopped);
    if (blocked) throw new Error(blocked);
  };
  assertCurrent();
  const capabilities = store.capabilities();
  let interactions: State["interactions"] = [], approvals: State["handoffApprovals"] = [];
  if (capabilities.listInteractions) {
    if (!conversationClient.interactions) return "Pending requests cannot be checked. Use this conversation’s composer instead.";
    interactions = await conversationClient.interactions(intent.sessionId, signal);
    assertCurrent();
  }
  if (capabilities.listHandoffApprovals) {
    if (!conversationClient.handoffApprovals) return "Pending approvals cannot be checked. Use this conversation’s composer instead.";
    try { approvals = await conversationClient.handoffApprovals(intent.sessionId, signal); }
    catch (error) {
      // Same compatibility policy as the ordinary conversation poll.
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
    assertCurrent();
  }
  if (capabilities.compaction) {
    if (!conversationClient.compactState) return "Context status cannot be checked. Use this conversation’s composer instead.";
    const compact = await conversationClient.compactState(intent.sessionId, signal);
    assertCurrent();
    if (compact.operations.some(item => ["requested", "running", "unconfirmed"].includes(item.lifecycle))) return "Resolve the current or unconfirmed compaction in Context before sending this message.";
  }
  // Science discovery also runs independently of selected-history hydration.
  if (conversationClient.scienceSubmissions) {
    const submissions = await conversationClient.scienceSubmissions(intent.sessionId, signal);
    assertCurrent();
    if (submissions.some(item => item.state === "prepared" || item.state === "unknown")) return "A science submission is unresolved. Check the conversation’s submission controls before sending again.";
  }
  const state = store.snapshot();
  const requests = pendingInteractions({ ...state, interactions: [...state.interactions, ...interactions], handoffApprovals: [...state.handoffApprovals, ...approvals] }, capabilities);
  return requests.length ? "Resolve pending requests in the conversation before sending this message." : "";
}

/** Subscription-only hydration wait. A running session is never waited into sendability. */
export function waitForBrowserPairHydration(intent: BrowserPairIntent, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let stopStore = () => {}, stopCatalog = () => {};
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      stopStore(); stopCatalog(); clearTimeout(deadline);
      signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    };
    const abort = () => finish(signal.reason instanceof Error ? signal.reason : new Error("Pairing scope changed or was closed. No message was sent."));
    const check = () => {
      const state = store.snapshot();
      if (signal.aborted || !browserPairIntentMatches(intent, state, catalog.snapshot(), true)) { abort(); return; }
      if (browserPairPreparationBusy(state)) {
        finish(new Error("The conversation is busy. It remains paired, but no message was sent. Use its composer when ready, or try OK again yourself."));
        return;
      }
      if (state.connectionError || state.metadataError || state.transcriptError) { finish(new Error("Conversation hydration failed. It remains paired. Check its connection and history, then try OK again.")); return; }
      if (!state.loading && !state.transcriptInitialLoading && !state.transcriptRefreshing && state.connected) finish();
    };
    stopStore = store.subscribe(check);
    stopCatalog = catalog.subscribe(check);
    signal.addEventListener("abort", abort, { once: true });
    deadline = setTimeout(() => finish(new Error("Conversation hydration timed out. It remains paired; no message was sent. Check its connection, then try OK again.")), 25000);
    check();
  });
}
