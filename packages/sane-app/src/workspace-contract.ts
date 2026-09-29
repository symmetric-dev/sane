/** All paths are exact slash-separated workspace-relative paths (root is "").
 * Resolve first; every subsequent request carries workspaceId in its query or PUT body.
 * Errors are { error, code }; HTTP 409 means stale workspace or file revision.
 * Base: /api/sessions/:id/workspace
 * GET base -> Workspace; GET /list?path= -> WorkspaceList;
 * GET /file?path= -> WorkspaceFile; PUT /file (WorkspaceWrite) -> WorkspaceFile;
 * GET /git -> WorkspaceGit; GET /diff?path=&comparison= -> WorkspaceDiff.
 * File and diff text is BOM-free and LF-normalized. A null text/before/after
 * means unsupported content, not an empty file. Diff absence is the empty string.
 * Save sends normalized text plus the last raw-byte revision, preserving the
 * existing file's BOM and uniform EOL convention. Lists are single-level/bounded.
 */
export const WORKSPACE_MAX_BYTES = 256 * 1024;
export type Workspace = { workspaceId: string; sessionId: string; root: string; maxFileBytes: number };
export type WorkspaceEntry = { name: string; path: string; kind: "file" | "directory" | "symlink" | "other" };
export type WorkspaceList = { workspaceId: string; path: string; entries: WorkspaceEntry[]; truncated: boolean };
export type FileReason = "binary" | "oversize" | "invalid-utf8" | "mixed-eol" | "not-writable";
export type WorkspaceFile = { workspaceId: string; path: string; text: string | null; revision: string | null; editable: boolean; reason?: FileReason; eol: "lf" | "crlf" | "cr" | "none" | "mixed"; bom: boolean; bytes: number };
export type WorkspaceWrite = { workspaceId: string; path: string; text: string; expectedRevision: string };
export type GitComparison = "staged" | "unstaged" | "untracked";
export type GitEntry = { path: string; originalPath?: string; index: string; worktree: string; comparisons: GitComparison[]; conflict: boolean; submodule: boolean; renameOutsideWorkspace: boolean };
export type WorkspaceGit = { workspaceId: string; available: boolean; reason?: string; entries: GitEntry[]; truncated: boolean };
export type DiffReason = "binary" | "oversize" | "invalid-utf8" | "conflict" | "submodule" | "symlink" | "rename-outside-workspace" | "unavailable";
export type WorkspaceDiff = { workspaceId: string; path: string; originalPath?: string; comparison: GitComparison; before: string | null; after: string | null; beforeMode: string | null; afterMode: string | null; modeOnly: boolean; reason?: DiffReason };
