import { store, type State } from "./store";
import { active } from "./types";
import { pendingInteractions } from "./interaction-presentation";

export type ChatStatus = { id: string; text: string; detail?: string; busy?: boolean; action?: "reconnect" | "models"; priority?: number; observedAt?: string; startedAt?: string };
export type ChatStatusContext = { workspaceReady: boolean; handoffLoading?: boolean; handoffError?: string; workerError?: string; nativeSubagentLoading?: boolean };

const priorities: Record<string, number> = {
  connection: 100, "submission-error": 95, "interaction-error": 95,
  "handoffs-error": 85, "workers-error": 85, execution: 85, models: 80,
  availability: 80, "input-request": 88, "compact-request": 75, sending: 70, "followup-queue": 65,
  run: 60, "native-queue": 55, "history-refresh": 45, action: 40,
  conversation: 25, workspace: 25, "history-page": 20,
  handoffs: 15, workers: 15, "native-subagents": 15, "missing-model": 10, "action-notice": 5,
};

/** Semantic priority, never polling/arrival order, selects the activity lid. */
export function chatStatusSummary(statuses: ChatStatus[]): ChatStatus | undefined {
  return statuses.reduce<ChatStatus | undefined>((summary, status) => !summary
    || (status.priority ?? priorities[status.id] ?? 0) > (summary.priority ?? priorities[summary.id] ?? 0) ? status : summary, undefined);
}

/** Chat-wide progress belongs to the composer, not the transcript. Execution and
 * transcript loading are independent; a send restriction is not run activity. */
export function chatStatuses(state: State, context: ChatStatusContext): ChatStatus[] {
  const statuses: ChatStatus[] = [];
  const add = (id: string, text: string, detail?: string, busy = false, action?: ChatStatus["action"], observation?: Pick<ChatStatus, "priority" | "observedAt">) => statuses.push({ id, text, detail, busy, action, ...observation });
  const conversation = state.conversations.find(item => item.id === state.selected);
  const activity = conversation?.activity && (!conversation.activity.runId || conversation.activity.runId === conversation.lastRunId) ? conversation.activity : undefined;
  const capabilities = store.capabilities();
  const requests = pendingInteractions(state, capabilities);
  const appRunning = state.runs.some(run => active(run.status));
  const running = appRunning || active(conversation?.status ?? "completed") || (!!activity && activity.phase !== "refreshing");
  const nativeContinuing = conversation?.nativeActivity === "active" && !appRunning;
  const latestRun = state.runs.at(-1);
  const nativeQueueWaiting = active(latestRun?.status ?? "completed") && latestRun?.nativeDelivery === "queue"
    && !state.messages.some(message => message.id === latestRun.nativeCommandId && message.normalized);
  const nativeIssue = [...state.runs].reverse().find(run => active(run.status) && run.nativeConnection && run.nativeConnection !== "connected");
  const completionBoundary = [...state.runs].reverse().find(run => active(run.status) && run.nativeCompletionBoundary)?.nativeCompletionBoundary;
  const compacting = state.compactions?.some(record => record.lifecycle === "running");
  const pendingCompact = state.pendingCompacts?.[state.selected];
  const queuedFollowup = conversation?.queuedFollowups?.find(receipt => receipt.state === "queued" && receipt.sessionId === state.selected);

  if (state.submissionError) add("submission-error", "Message submission needs attention", state.submissionError);
  if (state.interactionError) add("interaction-error", "Conversation action needs attention", state.interactionError);
  if (context.handoffLoading && state.selected) add("handoffs", "Loading handoff status…", undefined, true);
  if (state.workerLoading && state.selected) add("workers", "Loading background workers…", undefined, true);
  if (context.nativeSubagentLoading) add("native-subagents", "Loading recorded native subagents…", undefined, true);
  if (context.handoffError) add("handoffs-error", "Handoff status unavailable", context.handoffError);
  if (context.workerError) add("workers-error", "Background worker status unavailable", context.workerError);
  if (state.actionNotice) add("action-notice", state.actionNotice);
  if (state.actionBusy) add("action", "Updating conversation…", undefined, true);
  if (requests.length) add("input-request", state.actionBusy ? "Sending your reply…" : requests.some(item => item.type === "permission") ? "Waiting for your permission" : "Waiting for your answer", `${requests.length} pending request${requests.length === 1 ? "" : "s"}. Respond in the composer to continue.`, state.actionBusy);
  if (state.pageBusy) add("history-page", "Loading conversation history…", undefined, true);
  if (activity?.phase === "refreshing" || state.transcriptRefreshing) add("history-refresh", "Refreshing conversation history…", undefined, true, undefined, { observedAt: activity?.observedAt });
  if (state.availability.nativeQueue) add("native-queue", "OpenCode is continuing in the background…", "OpenCode is continuing in the background. Your next message will be queued for it.", true);
  if (running || compacting) {
    if (state.connectionError) add("run", "Run status unknown", "The connection is unavailable. The assistant may still be running.", false, undefined, { priority: 90 });
    else if (activity?.phase === "unconfirmed") add("run", "Run state needs verification", "Process ownership or termination is unconfirmed. Check the original run before sending again.", false, undefined, { priority: 90 });
    else if (!state.connected && !activity) add("run", "Checking run status…", "Loading the current execution state. Previously recorded activity is not confirmation that the assistant is still running.", true);
    else if (activity?.phase === "stopping") add("run", "Stopping run…", "Stop was requested. Waiting for process termination to be confirmed.", true);
    else if (activity?.phase === "finishing") add("run", "Finishing run…", "The CLI is ending. Sending unlocks after output and storage finish settling.", true);
    else if (compacting) add("run", "Compacting context…", undefined, true);
    else if (nativeContinuing) add("run", "OpenCode is continuing after background work…", "OpenCode is continuing after background work; live output appears here. To stop this continuation, use the native OpenCode harness.", true);
    else if (latestRun?.operation === "compact") add("run", "Waiting for compaction to settle…", "Waiting for the compaction run’s native state to settle.", true);
    else if (nativeIssue) add("run", "Assistant connection unavailable", nativeIssue.nativeReason || "Assistant connection unavailable; execution state remains unconfirmed.", false, undefined, { priority: 90 });
    else if (completionBoundary) add("run", "Run completion needs verification", `A later ${completionBoundary.type} message prevents confirming this command’s outcome. The run remains reserved; no prompt is being resent.`, false, undefined, { priority: 90 });
    else if (nativeQueueWaiting) add("run", "Message queued…", "Message queued. OpenCode is finishing its current continuation.", true);
    else if (activity?.phase === "starting") add("run", "Starting assistant…", "The message was accepted. Preparing the Claude Code process.", true);
    else if (activity?.phase === "background") add("run", "Background tasks are running…", `The main assistant turn has stopped, but ${activity.backgroundTaskCount ?? "native"} background ${activity.backgroundTaskCount === 1 ? "task is" : "tasks are"} still active. The run has not completed.`, true);
    else if (activity?.phase === "waiting") add("run", "Waiting for run to finish…", "The main assistant turn has stopped. Waiting for the CLI to finish or report further activity.", true);
    else add("run", "Assistant is working…", "New output will appear in the conversation.", true);
    const runStatus = statuses.find(status => status.id === "run");
    if (runStatus) {
      runStatus.observedAt = activity?.observedAt;
      runStatus.startedAt = activity?.startedAt ?? (active(latestRun?.status ?? "completed") ? latestRun?.createdAt : undefined);
    }
  }
  if (queuedFollowup) add("followup-queue", "Your next message is queued", "It will start only after the current CLI run finishes successfully.", true, undefined, { observedAt: queuedFollowup.time });
  else if (!state.sending && state.pendingTurn?.conversationId === state.selected && state.pendingTurn.runId
    && !state.runs.some(run => run.id === state.pendingTurn?.runId) && !statuses.some(status => status.id === "run")) add("run", "Starting assistant…", "The message was accepted. Waiting for recorded run history.", true);
  if (pendingCompact && !state.compactions?.some(record => record.requestId === pendingCompact.payload.requestId)
    && (pendingCompact.phase === "sending" || pendingCompact.phase === "unconfirmed")) {
    add("compact-request", pendingCompact.phase === "sending" ? "Requesting context compaction…" : "Compaction acceptance unconfirmed", "Manual context compaction has been requested; completion requires native evidence.", pendingCompact.phase === "sending", undefined, pendingCompact.phase === "unconfirmed" ? { priority: 90 } : undefined);
  }
  const missingModel = store.missingModel();
  if (missingModel) add("missing-model", "Selected model is not in the current catalog", `Model ${missingModel} is not in the current OpenCode catalog for this directory. Sending will still use this selection.`);
  if (capabilities.catalogRequiredForSend && state.modelsError) add("models", "Model catalog unavailable", state.modelsError, false, "models");
  else if (store.modelUnavailable()) add("models", "Waiting for the model catalog…", "Waiting for the OpenCode model catalog for this directory.", true);
  const executionUnavailable = store.executionUnavailable();
  if (executionUnavailable) add("execution", "Execution workspace unavailable", executionUnavailable);
  if (!state.availability.canSend && state.availability.reason) {
    // Compatibility with an older bridge is limited to this exact known busy
    // reason; arbitrary restrictions/errors must never be hidden as progress.
    const ordinaryBusy = state.availability.code === "conversation-busy" || (!state.availability.code
      && state.availability.reason === "This conversation already has an active run or reconciliation");
    if (!ordinaryBusy) add("availability", state.availability.code === "reconciliation-required" ? "Run state needs verification" : state.availability.reason,
      state.availability.code === "reconciliation-required" ? state.availability.reason : undefined, false, undefined,
      ["reconciliation-required", "storage-unavailable"].includes(state.availability.code ?? "") ? { priority: 95 } : undefined);
    else if (!running && !queuedFollowup && !activity && !state.pendingTurn && !state.sending) add("availability", "Waiting for conversation availability…", "The bridge has reserved this conversation. Sending will unlock when the reservation is released.", true, undefined, { priority: 20 });
  }
  // `connected` also gates conversation readiness. Selection clears it while
  // revalidating history/run state; that alone is not a bridge connection failure.
  const conversationLoading = state.loading || state.transcriptInitialLoading || (!state.connected && !state.connectionError);
  if (!context.workspaceReady || (!state.selected && conversationLoading)) add("workspace", "Preparing your workspace…", undefined, true);
  if (state.selected && conversationLoading) add("conversation", "Loading conversation…", undefined, true);
  if (state.connectionError) add("connection", running || compacting ? "Connection lost · run status unknown" : "Reconnecting to the bridge…", state.connectionError, true, "reconnect");
  if (state.sending) add("sending", "Sending your message…", undefined, true);
  return statuses;
}
