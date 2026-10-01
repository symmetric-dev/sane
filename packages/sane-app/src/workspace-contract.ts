/** All paths are exact slash-separated workspace-relative paths (root is "").
 * Resolve first; every subsequent request carries workspaceId in its query or PUT body.
 * Errors are { error, code }; HTTP 409 means stale workspace or file revision.
 * Base: /api/sessions/:id/workspace
 * GET base -> Workspace; GET /list?path= -> WorkspaceList;
 * GET /file?path= -> WorkspaceFile; PUT /file (WorkspaceWrite) -> WorkspaceFile;
 * POST /file (WorkspaceCreate) -> WorkspaceFile; POST /copy (WorkspaceCopy) -> WorkspaceFile;
 * DELETE /file (WorkspaceDelete) -> { workspaceId, path };
 * GET /git -> WorkspaceGit; GET /diff?path=&comparison= -> WorkspaceDiff;
 * POST /search (WorkspaceSearchInput) -> WorkspaceSearch (also on worktree base).
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
export type WorkspaceCreate = { workspaceId: string; path: string };
export type WorkspaceDelete = WorkspaceCreate & { expectedRevision: string };
export type WorkspaceCopy = WorkspaceDelete & { destination: string };
/** Saved content only; query is a nonempty single-line literal (at most 1024 UTF-16 units).
 * Filters are comma-separated, case-sensitive globs: * and ? match within a path
 * segment, ** as a complete segment matches zero or more segments. Slash patterns
 * are root-relative; patterns without slashes match basenames at any depth. A
 * trailing / includes/excludes a directory and its descendants. No negation,
 * braces, character classes, escapes, or absolute/parent paths are supported.
 * Default dependency/build directories and safely readable workspace .gitignore
 * rules are excluded (including nested rules and negation, matched case-sensitively
 * without consulting Git configuration). These rules also
 * apply outside Git repositories. Global ignores, ancestors outside the workspace
 * and forbidden .git/info/exclude are deliberately not loaded. Unsafe, binary,
 * invalid-UTF8 and oversized ignore files supply no rules. Ignore parsing is
 * bounded separately; hitting its budget truncates discovery.
 * Cancellation is HTTP 499; an initial/final fence exceeding the same five-second
 * total deadline fails closed with HTTP 504 rather than returning unfenced results.
 * Whole words use Unicode letters, numbers, marks and underscore as word characters.
 */
export type WorkspaceSearchInput = { workspaceId: string; query: string; caseSensitive?: boolean; wholeWord?: boolean; include?: string; exclude?: string };
/** Line/columns are 1-based UTF-16 positions in BOM-free LF-normalized text;
 * endColumn is exclusive. Preview is a bounded excerpt, not necessarily the full line.
 */
export type WorkspaceSearchMatch = { path: string; line: number; column: number; endColumn: number; preview: string };
/** scannedFiles counts decoded text files examined; skippedFiles counts encountered
 * file-like entries excluded/unreadable/unsupported, not unseen descendants of
 * pruned directories. truncated means a discovery, depth, byte, result, output or
 * time budget stopped the search; counts describe only work actually performed.
 */
export type WorkspaceSearch = { workspaceId: string; matches: WorkspaceSearchMatch[]; truncated: boolean; scannedFiles: number; skippedFiles: number };
export type GitComparison = "staged" | "unstaged" | "untracked";
export type GitEntry = { path: string; originalPath?: string; index: string; worktree: string; comparisons: GitComparison[]; conflict: boolean; submodule: boolean; renameOutsideWorkspace: boolean };
export type WorkspaceGit = { workspaceId: string; available: boolean; reason?: string; entries: GitEntry[]; truncated: boolean };
export type DiffReason = "binary" | "oversize" | "invalid-utf8" | "conflict" | "submodule" | "symlink" | "rename-outside-workspace" | "unavailable";
export type WorkspaceDiff = { workspaceId: string; path: string; originalPath?: string; comparison: GitComparison; before: string | null; after: string | null; beforeMode: string | null; afterMode: string | null; modeOnly: boolean; reason?: DiffReason };
