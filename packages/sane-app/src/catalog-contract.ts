import type { GitComparison, Workspace } from "./workspace-contract";
import type { Session } from "./history";

/** Authenticated owner-scoped APIs (existing Host/Origin/cookie seam):
 * GET /api/workspaces -> CatalogResponse
 * POST /api/workspaces {cwd: absolutePath} -> RegistrationResponse (201)
 * POST /api/workspaces/create {requestId: UUID, parent: absolutePath, name: basename} -> RegistrationResponse (201); creates Git and SANE at the final path. Same request may be checked again, never blindly recreated.
 * GET /api/workspaces/:workspaceId -> WorkspaceRecord
 * GET /api/workspaces/:workspaceId/worktrees/:worktreeId -> WorktreeResolution
 * PUT /api/workspaces/:workspaceId/worktrees/:worktreeId/alias {alias: string | null} -> WorkspaceRecord (per-worktree display name, trimmed 1-80 chars, no controls; empty/null clears; duplicates allowed)
 * Same base + /list /file /git /diff /search /paths use workspace-contract shapes and paths
 * relative to the FULL worktree root. GET accepts workspaceId=<revision> or
 * bindingRevision=<revision>; PUT /file and POST /search /paths accept either token field.
 * GET /api/navigation -> NavigationBookmark
 * PUT /api/navigation NavigationWrite -> NavigationBookmark; conflict is 409.
 * Navigation workspaceId/worktreeId select the browsing root independently of
 * conversationId and its immutable execution cwd/association. Existing unresolved
 * conversations may be bookmarked for history; restore both selections and view
 * without replacing the browsing pair with the conversation's association.
 * GET /api/sessions adds Association to each legacy session. POST accepts both
 * stable workspaceId/worktreeId; omitted cwd defaults to the selected root.
 * Resumes retain their original cwd and immutable association.
 */

export type Association = { workspaceId: string; worktreeId: string; association: "resolved" } | { workspaceId: null; worktreeId: null; association: "unresolved"; associationReason: string };
export type CatalogSession = Session & Association;
export type WorktreeRecord = { worktreeId: string; root: string; gitDir: string | null; bindingRevision: string; state: "available" | "invalid"; reason?: string; branch?: string; detached?: boolean; alias?: string };
export type WorkspaceRecord = { workspaceId: string; kind: "repository" | "directory"; name: string; commonDir: string | null; worktrees: WorktreeRecord[] };
export type CatalogResponse = { version: 1; workspaces: WorkspaceRecord[] };
export type RegistrationResponse = { workspace: WorkspaceRecord; workspaceId: string; worktreeId: string };
export type WorkspaceCreationInput = { requestId: string; parent: string; name: string };
// The legacy operation shapes retain workspaceId as their filesystem revision
// token. The URL selects stable catalog IDs; bindingRevision is passed as the
// workspaceId query/body field for list/file/git/diff/search/paths, as in the legacy API.
export type WorktreeResolution = Workspace & { catalogWorkspaceId: string; worktreeId: string; bindingRevision: string };
export type NavigationBookmark = { revision: number; workspaceId: string | null; worktreeId: string | null; conversationId: string | null; view: "chat" | "code" | "git" | "terminal" | "workstreams" | "history" | "config"; filePath: string | null; comparison: GitComparison | null };
export type NavigationWrite = Omit<NavigationBookmark, "revision"> & { expectedRevision: number };
