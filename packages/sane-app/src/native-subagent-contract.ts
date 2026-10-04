import type { Message } from "../shared/conversation/types";

/** A native child is recorded activity within a parent run, not an App session. */
export type NativeSubagentKey = {
  parentSessionId: string;
  runId: string;
  parentToolUseId: string;
};

export type NativeSubagentStatus = "unknown" | "running" | "completed" | "failed" | "interrupted";

export type NativeSubagentSummary = NativeSubagentKey & {
  toolName: "Agent" | "Task";
  name?: string;
  assignment?: string;
  parentMessageId?: string;
  status: NativeSubagentStatus;
  statusEvidence?: { kind: string; seq: number; time: string };
  activityObserved: boolean;
  /** Count of recorded child tool calls, not a native run total. */
  toolCallCount: number;
  returnedReport?: string;
  warnings?: string[];
};

/** Both endpoints are authenticated read-only journal projections. */
export type NativeSubagentList = {
  subagents: NativeSubagentSummary[];
  revision: string;
  nextCursor: string | null;
  coverage: "recorded-only";
};

export type NativeSubagentPage = {
  subagent: NativeSubagentSummary;
  messages: Message[];
  revision: string;
  /** Default is the latest slice. This cursor loads the preceding slice. */
  nextCursor: string | null;
  coverage: "recorded-only";
};

/** Pages contain whole messages, with no truncated text or tool evidence.
 * Byte budgets cover the whole response envelope, including summaries and cursors.
 * These are soft budgets: a list may return one oversized summary alone.
 * Detail pages always include the complete summary; if that mandatory envelope
 * exceeds the budget, at most one complete message is included for progress.
 * Otherwise one message exceeding the remaining budget is returned whole, alone.
 * Cursors are identity- and revision-bound; 409 native-subagent-reset asks the
 * client to reload a coherent snapshot rather than combine different revisions.
 */
export const NATIVE_SUBAGENT_MAX_MESSAGES = 100;
export const NATIVE_SUBAGENT_PAGE_BYTES = 512 * 1024;

// GET /api/sessions/:parentSessionId/native-subagents[?limit=...&cursor=...]
// GET /api/sessions/:parentSessionId/native-subagents/:runId/:parentToolUseId[?limit=...&cursor=...]
