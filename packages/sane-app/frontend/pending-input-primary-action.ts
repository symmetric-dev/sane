import type { State } from "./store";
import { active as runtimeActive } from "./types";

export type PendingInputPrimaryAction = {
  mode: "send" | "queue" | "add-paused" | "check-request";
  label: "Send" | "Queue message" | "Add to paused queue" | "Check request";
  disabled: boolean;
  reason: string | null;
};

export type PendingInputLid = {
  text: string;
  waitingLabel: string | null;
  state: "running" | "paused" | "unconfirmed" | "reconciliation" | "checking";
};

/** Never borrow a queue snapshot or operation from a previous selection. */
function selectedQueue(state: State) {
  return state.pendingInputs?.snapshot.conversationId === state.selected ? state.pendingInputs : null;
}

export function pendingInputContextReady(state: State) {
  return state.phase === "ready" && state.config?.authenticated === true && typeof state.config.storeId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(state.config.storeId);
}

export function unresolvedOperations(state: State) {
  if (!pendingInputContextReady(state)) return [];
  return Object.values(state.pendingInputOperations ?? {}).filter(operation => operation.conversationId === state.selected
    && (operation.state === "pending" || operation.state === "unknown"));
}

export function pendingInputLid(state: State, supported: boolean): PendingInputLid | null {
  if (!state.selected || !pendingInputContextReady(state)) return null;
  const view = supported ? selectedQueue(state) : null;
  const operations = unresolvedOperations(state);
  const waiting = view?.snapshot.items.filter(item => item.state === "waiting").length ?? 0;
  const waitingLabel = view ? `Waiting ${waiting}/3` : null;
  if (operations.some(operation => operation.state === "unknown")) return { text: "Request unconfirmed", waitingLabel, state: "unconfirmed" };
  if (operations.length) return { text: "Checking queue…", waitingLabel, state: "checking" };
  if (state.pendingInputError) return { text: "Queue needs attention", waitingLabel, state: "reconciliation" };
  if (!supported) return null;
  if (Object.values(state.pendingInputOperations ?? {}).some(operation => operation.conversationId === state.selected
    && operation.state === "rejected" && operation.error)) return { text: "Queue request rejected", waitingLabel, state: "reconciliation" };
  if (view?.presentation.unresolved?.classification === "uncertain") return { text: "Reconciliation needed", waitingLabel, state: "reconciliation" };
  if (state.pendingInputLoading) return { text: "Checking queue…", waitingLabel, state: "checking" };
  if (view?.snapshot.paused) return { text: "Queue paused", waitingLabel, state: "paused" };
  const running = state.runs.some(run => run.conversationId === state.selected && !run.summaryOnly && runtimeActive(run.status));
  if (running) return { text: "Running", waitingLabel, state: "running" };
  const head = view?.snapshot.items.find(item => item.state !== "waiting");
  if (head) return { text: head.state === "run-linked" ? "Run linked" : "Claimed", waitingLabel, state: "checking" };
  if (waiting) return { text: "Queued", waitingLabel, state: "checking" };
  if (view?.presentation.chainLocked) return { text: "Waiting", waitingLabel, state: "checking" };
  return null;
}

export function pendingInputPrimaryAction({ state, supported, chainLocked, command, text, sendBlocked, sendReason, queueReason, inactive, composing }: {
  state: State;
  supported: boolean;
  chainLocked: boolean;
  command: boolean;
  text: string;
  sendBlocked: boolean;
  sendReason: string | null;
  queueReason: string | null;
  inactive: boolean;
  composing: boolean;
}): PendingInputPrimaryAction {
  const operations = unresolvedOperations(state);
  // Opening details is not a retry, a refresh, or a new admission.
  if (operations.length) return { mode: "check-request", label: "Check request", disabled: inactive || composing,
    reason: "Inspect the original request before submitting another message." };
  const view = supported ? selectedQueue(state) : null;
  const ordinaryBusy = state.availability.code === "conversation-busy" || (!state.availability.code
    && state.availability.reason === "This conversation already has an active run or reconciliation");
  const conversation = state.conversations.find(item => item.id === state.selected);
  const queueMode = supported && !!conversation && !conversation.replacedBy && !command && (chainLocked
    || !!view?.snapshot.items.length || !!view?.snapshot.paused || ordinaryBusy || state.runs.some(run => run.conversationId === state.selected && runtimeActive(run.status))
    || runtimeActive(conversation.status) || !!state.availability.nativeQueue || !!state.availability.queueAfterRunId);
  if (queueMode) {
    const waiting = view?.snapshot.items.filter(item => item.state === "waiting").length ?? 0;
    const reason = queueReason || (waiting >= 3 ? "Waiting queue is full (3/3)." : !view ? "Read current queue eligibility before queueing."
      : !view.presentation.automation.supported ? view.presentation.automation.reason || "Queue automation is unavailable."
      : !view.presentation.enqueue.allowed ? view.presentation.enqueue.reason || "Queue admission is unavailable." : null);
    return { mode: view?.snapshot.paused ? "add-paused" : "queue", label: view?.snapshot.paused ? "Add to paused queue" : "Queue message",
      disabled: inactive || composing || !!reason || !text.trim(), reason: reason || (!text.trim() ? "Write a message to queue." : null) };
  }
  return { mode: "send", label: "Send", disabled: inactive || composing || chainLocked || sendBlocked || !text.trim(), reason: sendReason };
}
