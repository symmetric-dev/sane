import { store, type State } from "./store";
import { active } from "./types";

export type ChatStatus = { id: string; text: string; detail?: string; busy?: boolean; action?: "reconnect" | "models" };
export type ChatStatusContext = { workspaceReady: boolean; handoffLoading?: boolean; handoffError?: string; workerError?: string; nativeSubagentLoading?: boolean };

/** Chat-wide progress belongs to the composer, not the transcript. Order breaks ties
 * when several states arrive together; subsequent changes determine the latest. */
export function chatStatuses(state: State, context: ChatStatusContext): ChatStatus[] {
  const statuses: ChatStatus[] = [];
  const add = (id: string, text: string, detail?: string, busy = false, action?: ChatStatus["action"]) => statuses.push({ id, text, detail, busy, action });
  const conversation = state.conversations.find(item => item.id === state.selected);
  const capabilities = store.capabilities();
  const appRunning = state.runs.some(run => active(run.status));
  const running = appRunning || active(conversation?.status ?? "completed");
  const nativeContinuing = conversation?.nativeActivity === "active" && !appRunning;
  const latestRun = state.runs.at(-1);
  const nativeQueueWaiting = active(latestRun?.status ?? "completed") && latestRun?.nativeDelivery === "queue"
    && !state.messages.some(message => message.id === latestRun.nativeCommandId && message.normalized);
  const nativeIssue = [...state.runs].reverse().find(run => active(run.status) && run.nativeConnection && run.nativeConnection !== "connected");
  const compacting = state.compactions?.some(record => record.lifecycle === "running");
  const pendingCompact = state.pendingCompacts?.[state.selected];

  if (context.handoffLoading && state.selected) add("handoffs", "Loading handoff status…", undefined, true);
  if (state.workerLoading && state.selected) add("workers", "Loading background workers…", undefined, true);
  if (context.nativeSubagentLoading) add("native-subagents", "Loading recorded native subagents…", undefined, true);
  if (context.handoffError) add("handoffs-error", "Handoff status unavailable", context.handoffError);
  if (context.workerError) add("workers-error", "Background worker status unavailable", context.workerError);
  if (state.actionNotice) add("action-notice", state.actionNotice);
  if (state.actionBusy) add("action", "Updating conversation…", undefined, true);
  if (state.pageBusy) add("history-page", "Loading conversation history…", undefined, true);
  if (state.availability.nativeQueue) add("native-queue", "OpenCode is continuing in the background…", "OpenCode is continuing in the background. Your next message will be queued for it.", true);
  if (running || compacting) {
    if (!state.connected) add("run", "Run state unconfirmed", "Connection unavailable. The run’s current state is not yet known.");
    else if (compacting) add("run", "Compacting context…", undefined, true);
    else if (nativeContinuing) add("run", "OpenCode is continuing after background work…", "OpenCode is continuing after background work; live output appears here. To stop this continuation, use the native OpenCode harness.", true);
    else if (latestRun?.operation === "compact") add("run", "Waiting for compaction to settle…", "Waiting for the compaction run’s native state to settle.", true);
    else if (nativeIssue) add("run", "Assistant connection unavailable", nativeIssue.nativeReason || "Assistant connection unavailable; execution state remains unconfirmed.");
    else if (nativeQueueWaiting) add("run", "Message queued…", "Message queued. OpenCode is finishing its current continuation.", true);
    else add("run", "Assistant is working…", "New output will appear in the conversation.", true);
  }
  if (pendingCompact && !state.compactions?.some(record => record.requestId === pendingCompact.payload.requestId)
    && (pendingCompact.phase === "sending" || pendingCompact.phase === "unconfirmed")) {
    add("compact-request", pendingCompact.phase === "sending" ? "Requesting context compaction…" : "Compaction acceptance unconfirmed", "Manual context compaction has been requested; completion requires native evidence.", pendingCompact.phase === "sending");
  }
  const missingModel = store.missingModel();
  if (missingModel) add("missing-model", "Selected model is not in the current catalog", `Model ${missingModel} is not in the current OpenCode catalog for this directory. Sending will still use this selection.`);
  if (capabilities.catalogRequiredForSend && state.modelsError) add("models", "Model catalog unavailable", state.modelsError, false, "models");
  else if (store.modelUnavailable()) add("models", "Waiting for the model catalog…", "Waiting for the OpenCode model catalog for this directory.", true);
  const executionUnavailable = store.executionUnavailable();
  if (executionUnavailable) add("execution", "Execution workspace unavailable", executionUnavailable);
  if (!state.availability.canSend && state.availability.reason) add("availability", state.availability.reason);
  // `connected` also gates conversation readiness. Selection clears it while
  // revalidating history/run state; that alone is not a bridge connection failure.
  const conversationLoading = state.loading || state.transcriptInitialLoading || (!state.connected && !state.connectionError);
  if (!context.workspaceReady || (!state.selected && conversationLoading)) add("workspace", "Preparing your workspace…", undefined, true);
  if (state.selected && conversationLoading) add("conversation", "Loading conversation…", undefined, true);
  if (state.connectionError) add("connection", "Reconnecting to the bridge…", state.connectionError, true, "reconnect");
  if (state.sending) add("sending", "Sending your message…", undefined, true);
  return statuses;
}
