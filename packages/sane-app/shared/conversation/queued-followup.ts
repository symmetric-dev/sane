/** A queue receipt is not acceptance of a native turn. */
export type QueuedSendConfiguration = { cwd: string; profileId: string; model?: string; effort?: string; agent?: string };
export type QueuedFollowup = {
  requestId: string; afterRunId: string; sessionId: string; prompt: string; time: string;
  state: "queued" | "not-submitted" | "admission-unconfirmed" | "dispatched";
  runId?: string;
  configuration?: QueuedSendConfiguration;
};
export type SendReceipt = { conversationId: string; queued?: false; runId: string }
  | { conversationId: string; queued: true; receipt: QueuedFollowup };
