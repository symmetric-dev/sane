import type { MessageSnapshot } from "./native-contract";

export type ReconciledHistory = {
  sessionId: string; nativeSessionId: string; importedAt: string;
  activity: "active" | "idle" | "unknown"; reason: string;
  coveredRunIds: string[]; messages: MessageSnapshot[];
};
