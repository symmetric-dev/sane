/** Live execution observations, separate from send eligibility and run outcome.
 * Never persisted as ownership evidence or reconstructed from reply text. */
export type ConversationActivity = {
  phase: "starting" | "running" | "background" | "waiting" | "finishing" | "stopping" | "refreshing" | "unconfirmed";
  runId?: string;
  startedAt?: string;
  observedAt: string;
  backgroundTaskCount?: number;
};
