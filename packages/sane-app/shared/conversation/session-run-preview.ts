/** Metadata-only History preview. Never includes prompts, context or native evidence. */
export type SessionRunPreviewSource = {
  storeId: string;
  sessionId: string;
  harness: "opencode" | "claude-code";
  authorityId: string;
  nativeSessionId: string;
  cwd: string;
};

export type SessionRunPreview = {
  runId: string;
  sessionId: string;
  status: "running" | "completed" | "failed" | "interrupted";
  createdAt: string;
  endedAt?: string;
  model?: string;
  effort?: string;
  agent?: string;
  agentKind?: "assistant" | "worker";
  nativeAgentSelected?: boolean;
  profileId?: string;
  cwd: string;
};

export type SessionRunPreviewResponse = {
  session: SessionRunPreviewSource;
  runs: SessionRunPreview[];
  total: number;
  page: { nextCursor: string | null; hasMore: boolean };
};
