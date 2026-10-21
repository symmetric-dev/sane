import { invalidateCoalescedRequests } from "./request-coalescing";

const revisions = new Map<string, number>();
const listeners = new Set<() => void>();
const key = (scopeId: string, bindingRevision: string) => JSON.stringify([scopeId, bindingRevision]);
export const subscribeGitInvalidations = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const gitReadRevision = (scopeId: string, bindingRevision: string) => revisions.get(key(scopeId, bindingRevision)) ?? 0;
export function invalidateWorkspaceGit(scopeId: string, bindingRevision: string) {
  const [workspaceId, worktreeId] = JSON.parse(scopeId) as [string, string];
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/worktrees/${encodeURIComponent(worktreeId)}`;
  invalidateCoalescedRequests(url => url === base || url.startsWith(`${base}/git`) || url.startsWith(`${base}/diff`));
  const id = key(scopeId, bindingRevision);
  revisions.set(id, gitReadRevision(scopeId, bindingRevision) + 1);
  for (const listener of listeners) { try { listener(); } catch { /* A read consumer must not fail a committed disk write. */ } }
}
