import type { RunStatus } from "./types";

/** Read-only projection of saved SANE context, not a native model request. */
export type SystemPromptSnapshot = {
  schema: 1;
  scope: "sane";
  storeId: string;
  sessionId: string;
  runId: string;
  status: RunStatus;
} & ({
  state: "recorded";
  standing: string;
  injected: string;
  nativeRoleReference: string | null;
} | {
  state: "pending" | "unavailable";
});
