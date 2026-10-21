import type { GitOperationInput, GitOperationResult, GitOperationsState } from "../src/git-operations-contract";
import { catalog, worktreeScope } from "./catalog";
import { coalescedFetch } from "./request-coalescing";
import { gitReadRevision, invalidateWorkspaceGit, subscribeGitInvalidations } from "./git-invalidation";
import { workspaceEpoch, workspaceFailure } from "./workspace-store";
import { WorkspaceError } from "./workspace-client";

export type GitTarget = { workspaceId: string; worktreeId: string; bindingRevision: string; root: string; authEpoch: number };
export type GitOperationIntent = GitOperationInput extends infer T ? T extends GitOperationInput ? Omit<T, "requestId" | "bindingRevision" | "snapshot"> : never : never;
export type GitFlowState = { state?: GitOperationsState; loading: boolean; error: string; busy: boolean; result?: GitOperationResult; commitNotice?: string; draft: string; unknown: boolean; reconciled: boolean };
type Record = { target: GitTarget; value: GitFlowState; readers: number; readGeneration: number; mutation: boolean; invalidationRevision: number; ownsInvalidation?: boolean };
const records = new Map<string, Record>();
const listeners = new Set<() => void>();
const id = (target: GitTarget) => JSON.stringify([target.workspaceId, target.worktreeId, target.bindingRevision, target.root, target.authEpoch]);
export const gitTargetScope = (target: GitTarget) => worktreeScope(target.workspaceId, target.worktreeId);
export function gitTargetCurrent(target: GitTarget) {
  const workspace = catalog.state.workspaces.find(row => row.workspaceId === target.workspaceId);
  const worktree = workspace?.worktrees.find(row => row.worktreeId === target.worktreeId);
  return target.authEpoch === workspaceEpoch() && catalog.state.ready && workspace?.kind === "repository" && worktree?.state === "available" && worktree.bindingRevision === target.bindingRevision && worktree.root === target.root;
}
function record(target: GitTarget) {
  const key = id(target);
  let row = records.get(key);
  if (!row) { row = { target, value: { loading: false, error: "", busy: false, draft: "", unknown: false, reconciled: false }, readers: 0, readGeneration: 0, mutation: false, invalidationRevision: gitReadRevision(gitTargetScope(target), target.bindingRevision) }; records.set(key, row); }
  return row;
}
function update(row: Record, patch: Partial<GitFlowState>) { row.value = { ...row.value, ...patch }; for (const listener of listeners) listener(); }
const url = (target: GitTarget) => `/api/workspaces/${encodeURIComponent(target.workspaceId)}/worktrees/${encodeURIComponent(target.worktreeId)}/git-operations`;
async function request<T>(target: GitTarget, init?: RequestInit) {
  const response = await coalescedFetch(url(target) + (!init ? `?${new URLSearchParams({ bindingRevision: target.bindingRevision })}` : ""), { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(init ? 120000 : 25000), ...init, headers: { "Content-Type": "application/json" } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new WorkspaceError(body.error || `Git request failed (${response.status}).`, response.status, body.code);
  return body as T;
}
function validState(target: GitTarget, state: GitOperationsState) {
  return state.workspaceId === target.workspaceId && state.worktreeId === target.worktreeId && state.bindingRevision === target.bindingRevision && state.root === target.root;
}
export async function refreshGitOperations(target: GitTarget, fresh = false) {
  const row = record(target);
  if (!gitTargetCurrent(target) || row.mutation) return;
  if (fresh) {
    // This caller owns the follow-up read. The synchronous invalidation listener
    // still retires stale state, but must not start a second read of its own.
    row.ownsInvalidation = true;
    try { invalidateWorkspaceGit(gitTargetScope(target), target.bindingRevision); }
    finally { row.ownsInvalidation = false; }
  }
  const generation = ++row.readGeneration, revision = gitReadRevision(gitTargetScope(target), target.bindingRevision);
  const current = () => gitTargetCurrent(target) && generation === row.readGeneration && revision === gitReadRevision(gitTargetScope(target), target.bindingRevision) && !row.mutation;
  update(row, { loading: true, error: "" });
  try {
    const state = await request<GitOperationsState>(target);
    if (!current()) return;
    if (!validState(target, state)) throw new Error("Git target changed. Exit and reopen Git for the new target.");
    update(row, { state, loading: false, error: "", reconciled: true });
  } catch (error) { if (current()) update(row, { loading: false, error: workspaceFailure(error), reconciled: false }); }
}
export const subscribeGitOperations = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const gitOperationsSnapshot = (target: GitTarget) => record(target).value;
export function setGitCommitDraft(target: GitTarget, draft: string) { update(record(target), { draft }); }
export function acknowledgeGitUnknown(target: GitTarget) {
  const row = record(target);
  if (row.value.reconciled && !row.value.loading && !row.value.busy) update(row, { unknown: false });
}
/** An active flow is a read consumer, never the shell-view-gated WorkspaceController. */
export function acquireGitOperations(target: GitTarget) {
  const row = record(target); row.readers++;
  void refreshGitOperations(target, true);
  const refresh = () => { if (!document.hidden && !row.mutation && !row.value.loading) void refreshGitOperations(target, true); };
  const timer = setInterval(refresh, 15000);
  window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
  return () => { row.readers--; clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
}
subscribeGitInvalidations(() => {
  for (const row of records.values()) {
    const revision = gitReadRevision(gitTargetScope(row.target), row.target.bindingRevision);
    if (row.invalidationRevision === revision) continue;
    row.invalidationRevision = revision;
    row.readGeneration++;
    // Clear the reviewed snapshot synchronously, fencing buttons as well as GET continuations.
    update(row, { state: undefined, reconciled: false });
    if (row.readers && !row.mutation && !row.ownsInvalidation && gitTargetCurrent(row.target)) void refreshGitOperations(row.target);
  }
});

/** One explicit intent, one UUID, one POST. Neither transport errors nor 409s replay it. */
export async function runGitOperation(target: GitTarget, snapshot: string, intent: GitOperationIntent) {
  const row = record(target);
  if (!gitTargetCurrent(target) || row.mutation || row.value.loading || row.value.unknown || row.value.state?.snapshot !== snapshot) return;
  const requestId = crypto.randomUUID();
  const input = { ...intent, requestId, bindingRevision: target.bindingRevision, snapshot } as GitOperationInput;
  row.mutation = true; row.readGeneration++;
  update(row, { busy: true, loading: false, error: "", result: undefined, reconciled: false });
  invalidateWorkspaceGit(gitTargetScope(target), target.bindingRevision);
  try {
    const result = await request<GitOperationResult>(target, { method: "POST", body: JSON.stringify(input) });
    if (target.authEpoch !== workspaceEpoch()) return;
    if (result.requestId !== requestId || result.action !== intent.action) throw new Error("Git operation returned an unrecognized result.");
    update(row, { result, unknown: result.outcome === "unknown", ...(intent.action === "commit" && result.outcome === "succeeded" ? { draft: "", commitNotice: `Committed${result.commit ? ` ${result.commit.slice(0, 12)}` : ""}.` } : {}) });
  } catch (error) {
    if (target.authEpoch !== workspaceEpoch()) return;
    const rejected = error instanceof WorkspaceError && error.status < 500;
    const message = error instanceof WorkspaceError && error.status === 409 ? "Git changed. State refreshed; review it and explicitly choose the action again." : workspaceFailure(error);
    update(row, { error: message, result: { requestId, action: intent.action, outcome: rejected ? "failed" : "unknown", message }, unknown: !rejected });
  } finally {
    row.mutation = false;
    if (target.authEpoch === workspaceEpoch()) {
      update(row, { busy: false });
      // Retire GETs made during the mutation before any consumer reads the result.
      await refreshGitOperations(target, true);
    }
  }
}
