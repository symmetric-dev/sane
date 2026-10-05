import type { MessageSnapshot } from "./native-contract";

export type ReconciledHistory = {
  sessionId: string; nativeSessionId: string; importedAt: string;
  /** Read-only live projection, not a persisted reconciliation or run outcome. */
  observation?: true;
  activity: "active" | "idle" | "unknown"; reason: string;
  coveredRunIds: string[]; messages: MessageSnapshot[];
};
