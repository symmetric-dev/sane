import type { WorkspaceEntry, WorkspacePaths } from "../src/workspace-contract";
import { safeRelativePath } from "./chat-path-token";

export type IndexedWorkspacePath = {
  entry: WorkspaceEntry;
  /** Exact execution-relative path, also used for display/insertion. */
  relativePath: string;
  normalizedPath: string;
  basename: string;
  directories: readonly string[];
};
export type WorkspacePathIndex = {
  workspaceId: string;
  prefix: string;
  entries: readonly IndexedWorkspacePath[];
  truncated: boolean;
};
export type WorkspacePathMatch = {
  entry: WorkspaceEntry;
  relativePath: string;
  /** 0 full path, 1 basename, 2 ordered directories, 3 prefix, 4 substring. */
  rank: number;
  skippedDirectories: number;
  depth: number;
};
export type WorkspacePathMatches = {
  matches: WorkspacePathMatch[];
  matchedCount: number;
  /** Discovery was bounded, independent of this query's result limit. */
  truncated: boolean;
  /** Either discovery or the result limit may hide more matches. */
  bounded: boolean;
};
export const WORKSPACE_PATH_MATCH_LIMIT = 50;

/** No normalization/repair: prefix and path must already be safe exact paths. */
export function executionRelativePath(path: string, prefix = ""): string | undefined {
  if (!safeRelativePath(prefix) || !path || !safeRelativePath(path)) return;
  const relative = prefix ? path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : undefined : path;
  return relative && safeRelativePath(relative) ? relative : undefined;
}

/** Build once per successful inventory, never once per keystroke. */
export function createWorkspacePathIndex(inventory: WorkspacePaths): WorkspacePathIndex {
  const entries: IndexedWorkspacePath[] = [];
  if (safeRelativePath(inventory.path)) {
    for (const entry of inventory.entries) {
      if (entry.kind !== "file" && entry.kind !== "directory") continue;
      const relativePath = executionRelativePath(entry.path, inventory.path);
      if (!relativePath || entry.name !== entry.path.split("/").at(-1)) continue;
      const components = relativePath.toLowerCase().split("/");
      entries.push({ entry, relativePath, normalizedPath: components.join("/"), basename: components.at(-1)!, directories: components.slice(0, -1) });
    }
  }
  return { workspaceId: inventory.workspaceId, prefix: inventory.path, entries, truncated: inventory.truncated };
}

const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const compare = (a: WorkspacePathMatch, b: WorkspacePathMatch) => a.rank - b.rank
  || a.skippedDirectories - b.skippedDirectories || a.depth - b.depth
  || lexical(a.relativePath.toLowerCase(), b.relativePath.toLowerCase())
  || lexical(a.relativePath, b.relativePath) || lexical(a.entry.kind, b.entry.kind);

/** Recursive nonempty queries only. Empty/trailing-slash browsing uses listDirectory.
 * Slash components match directories in order (prefixes allowed), never inverted;
 * the final component must occur literally in the basename. No fuzzy/subsequence
 * matching. Defaults to files only for Cmd+P; chat opts into directories.
 * prefix must match the inventory's exact execution-directory scope. */
export function matchWorkspacePaths(index: WorkspacePathIndex, query: string,
  options: { prefix?: string; includeDirectories?: boolean; limit?: number } = {}): WorkspacePathMatches {
  const output: WorkspacePathMatches = { matches: [], matchedCount: 0, truncated: index.truncated, bounded: index.truncated };
  const prefix = options.prefix ?? index.prefix;
  if (!query || !safeRelativePath(query) || !safeRelativePath(prefix) || prefix !== index.prefix) return output;
  const normalizedQuery = query.toLowerCase(), parts = normalizedQuery.split("/"), basename = parts.at(-1)!, directories = parts.slice(0, -1);
  const requestedLimit = options.limit ?? WORKSPACE_PATH_MATCH_LIMIT;
  const limit = Number.isFinite(requestedLimit) ? Math.max(0, Math.min(WORKSPACE_PATH_MATCH_LIMIT, Math.floor(requestedLimit))) : WORKSPACE_PATH_MATCH_LIMIT;
  for (const candidate of index.entries) {
    if (candidate.entry.kind !== "file" && !(options.includeDirectories && candidate.entry.kind === "directory")) continue;
    let cursor = 0;
    for (const component of candidate.directories) {
      if (cursor < directories.length && component.startsWith(directories[cursor]!)) cursor++;
    }
    if (cursor !== directories.length || !candidate.basename.includes(basename)) continue;
    const rank = candidate.normalizedPath === normalizedQuery ? 0
      : candidate.basename === basename ? 1
      : directories.length ? 2 : candidate.basename.startsWith(basename) ? 3 : 4;
    const match: WorkspacePathMatch = { entry: candidate.entry, relativePath: candidate.relativePath, rank,
      skippedDirectories: candidate.directories.length - directories.length, depth: candidate.directories.length };
    output.matchedCount++;
    // Retain only the best 50, not another full inventory-sized result array.
    let position = 0;
    while (position < output.matches.length && compare(output.matches[position]!, match) <= 0) position++;
    if (position < limit) {
      output.matches.splice(position, 0, match);
      if (output.matches.length > limit) output.matches.pop();
    }
  }
  output.bounded ||= output.matchedCount > output.matches.length;
  return output;
}
