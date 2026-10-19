import type { State } from "./store";
import { active as runtimeActive } from "./types";

export type PendingInputPrimaryAction = {
  mode: "send";
  label: "Send";
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
  if (view?.snapshot.paused && (view.snapshot.items.length || view.presentation.chainLocked)) return { text: "Queue paused", waitingLabel, state: "paused" };
  const running = state.runs.some(run => run.conversationId === state.selected && !run.summaryOnly && runtimeActive(run.status));
  if (running) return { text: "Running", waitingLabel, state: "running" };
  const head = view?.snapshot.items.find(item => item.state !== "waiting");
  if (head) return { text: head.state === "run-linked" ? "Run linked" : "Claimed", waitingLabel, state: "checking" };
  if (waiting) return { text: "Queued", waitingLabel, state: "checking" };
  if (view?.presentation.chainLocked) return { text: "Waiting", waitingLabel, state: "checking" };
  return null;
}

export function pendingInputPrimaryAction({ state, chainLocked, text, sendBlocked, sendReason, inactive, composing }: {
  state: State;
  chainLocked: boolean;
  text: string;
  sendBlocked: boolean;
  sendReason: string | null;
  inactive: boolean;
  composing: boolean;
}): PendingInputPrimaryAction {
  const operations = unresolvedOperations(state);
  return { mode: "send", label: "Send", disabled: inactive || composing || operations.length > 0 || chainLocked || sendBlocked || !text.trim(),
    reason: operations.length ? "Check the original request in the queue details before sending another message."
      : chainLocked ? sendReason || "Resolve existing queued messages before sending."
      : !text.trim() ? "Write a message to send." : sendReason };
}
