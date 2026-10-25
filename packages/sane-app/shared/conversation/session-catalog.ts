import type { RunStatus } from "./types";

/** Opt in with summary=1 and limit. Omitted/null workspace and worktree mean all.
 * "unavailable" selects unregistered workspaces / unrecorded worktrees, not
 * recorded worktrees whose current filesystem state is unavailable. */
export type SessionCatalogQuery = {
  mode?: "chat" | "history";
  workspaceId?: string | null;
  worktreeId?: string | null;
  harness?: "all" | "opencode" | "claude-code";
  status?: "all" | RunStatus;
  workstreamId?: string;
  phase?: string;
  showDeleted?: boolean;
  /** Explicit workspace/checkout activation only; excludes unavailable bindings. */
  availableOnly?: boolean;
  query?: string;
  limit?: number;
  cursor?: string;
};

/** Membership/order are frozen; row presentation remains fresh. Refresh the head
 * for new members. Expired/evicted/invalid cursors return 409 session-catalog-reset. */
export type SessionCatalogPageInfo = {
  kind: "partial";
  nextCursor: string | null;
  hasMore: boolean;
};

/** Read-model grouping only; source conversation associations remain immutable. */
export type SessionCatalogGroup = {
  workspaceId: string | null;
  worktreeId: string | null;
  total: number;
};

/** GET /api/sessions/groups?summary=1&limit=5 with the same catalog filters.
 * Counts are unsliced; cursor is not accepted and no snapshot is retained. */
export type SessionCatalogGroupsResponse = {
  groups: SessionCatalogGroup[];
  availability: { canSend: boolean; reason?: string; code?: string; queueAfterRunId?: string; liveInputRunId?: string };
};
