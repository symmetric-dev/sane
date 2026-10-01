import type { WorkspaceList, WorkspaceFile, WorkspaceGit, WorkspaceDiff, GitComparison, WorkspaceSearch, WorkspaceSearchInput } from "../src/workspace-contract";
import type { WorktreeResolution } from "../src/catalog-contract";

export class WorkspaceError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}
async function request<T>(conversationId: string, route = "", init: RequestInit = {}): Promise<T> {
  const [workspaceId, worktreeId] = JSON.parse(conversationId) as [string, string];
  const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/worktrees/${encodeURIComponent(worktreeId)}${route}`, {
    credentials: "same-origin", cache: "no-store", ...init,
    headers: { "Content-Type": "application/json", ...init.headers }, signal: init.signal ?? AbortSignal.timeout(25000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new WorkspaceError(body.error || `Workspace request failed (${response.status}).`, response.status, body.code);
  return body as T;
}
const query = (workspaceId: string, path?: string) => new URLSearchParams({ workspaceId, ...(path !== undefined ? { path } : {}) });
export const workspaceClient = {
  resolve: async (id: string): Promise<WorktreeResolution> => {
    const workspace = await request<WorktreeResolution>(id);
    return { ...workspace, workspaceId: workspace.bindingRevision };
  },
  list: (id: string, workspaceId: string, path: string) => request<WorkspaceList>(id, `/list?${query(workspaceId, path)}`),
  search: (id: string, input: WorkspaceSearchInput, signal: AbortSignal) => request<WorkspaceSearch>(id, "/search", { method: "POST", body: JSON.stringify(input), signal }),
  file: (id: string, workspaceId: string, path: string) => request<WorkspaceFile>(id, `/file?${query(workspaceId, path)}`),
  save: (id: string, workspaceId: string, path: string, text: string, expectedRevision: string) => request<WorkspaceFile>(id, "/file", { method: "PUT", body: JSON.stringify({ workspaceId, path, text, expectedRevision }) }),
  create: (id: string, workspaceId: string, path: string) => request<WorkspaceFile>(id, "/file", { method: "POST", body: JSON.stringify({ workspaceId, path }) }),
  copy: (id: string, workspaceId: string, path: string, destination: string, expectedRevision: string) => request<WorkspaceFile>(id, "/copy", { method: "POST", body: JSON.stringify({ workspaceId, path, destination, expectedRevision }) }),
  delete: (id: string, workspaceId: string, path: string, expectedRevision: string) => request<{ workspaceId: string; path: string }>(id, "/file", { method: "DELETE", body: JSON.stringify({ workspaceId, path, expectedRevision }) }),
  git: (id: string, workspaceId: string) => request<WorkspaceGit>(id, `/git?${query(workspaceId)}`),
  diff: (id: string, workspaceId: string, path: string, comparison: GitComparison) => request<WorkspaceDiff>(id, `/diff?${query(workspaceId, path)}&comparison=${comparison}`),
};
