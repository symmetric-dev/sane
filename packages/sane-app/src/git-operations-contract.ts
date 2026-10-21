import type { WorkspaceGit } from "./workspace-contract";

/** Direct, authenticated worktree UI operations; never agent or chat commands.
 * GET /api/workspaces/:workspaceId/worktrees/:worktreeId/git-operations?bindingRevision=...
 * POST same path with GitOperationInput. Stable catalog IDs live in the URL;
 * bindingRevision pins the filesystem target, snapshot pins the reviewed Git state.
 */
export type GitOperationsState = {
  workspaceId: string;
  worktreeId: string;
  bindingRevision: string;
  root: string;
  snapshot: string;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  remotes: { name: string; url: string }[];
  git: WorkspaceGit;
  blockedReason?: string;
};

type GitOperationBase = { requestId: string; bindingRevision: string; snapshot: string };
export type GitOperationInput = GitOperationBase & (
  | { action: "stage" | "unstage"; paths: string[] }
  | { action: "commit"; message: string }
  | { action: "push"; remote: string; branch: string; setUpstream: boolean }
);
export type GitOperationAction = GitOperationInput["action"];
export type GitOperationResult = {
  requestId: string;
  action: GitOperationAction;
  outcome: "succeeded" | "failed" | "unknown";
  message: string;
  commit?: string;
  state?: GitOperationsState;
};
