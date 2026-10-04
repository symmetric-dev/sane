import type { WorkstreamOverview } from "../src/workstreams-contract";
import { sameAssignment } from "./assignment-semantics";
import { WorkspaceError } from "./workspace-client";
import { workspaceEpoch, workspaceFailure } from "./workspace-store";

type WorkstreamMutation = { workspaceId: string; operation: string };
const mutationListeners = new Set<(mutation: WorkstreamMutation) => void>();
const mutationOperations = new Set(["", "init", "manage", "default-checkout", "associate", "phase/assign", "phase/end", "approve", "provide"]);
export function subscribeWorkstreamMutations(listener: (mutation: WorkstreamMutation) => void): () => void {
  mutationListeners.add(listener);
  return () => { mutationListeners.delete(listener); };
}
export async function workstreamRequest<T>(workspaceId: string, operation: string, input?: unknown, signal?: AbortSignal): Promise<T> {
  const auth = workspaceEpoch();
  const response = await fetch(`/api/workstreams${operation ? `/${operation}` : ""}?workspaceId=${encodeURIComponent(workspaceId)}`, {
    credentials: "same-origin", cache: "no-store", signal: signal ?? AbortSignal.timeout(25000),
    ...(input === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }),
  });
  const value = await response.json().catch(error => { if (response.ok) throw error; return null; });
  if (!response.ok) {
    const error = new WorkspaceError(typeof value?.error === "string" && value.error ? value.error : `Request failed (${response.status})`, response.status, typeof value?.code === "string" ? value.code : undefined);
    if (error.status === 401 && auth === workspaceEpoch()) { try { workspaceFailure(error); } catch {} }
    throw error;
  }
  if (input !== undefined && mutationOperations.has(operation)) {
    for (const listener of mutationListeners) {
      if (auth !== workspaceEpoch()) break;
      try { listener({ workspaceId, operation }); } catch {}
    }
  }
  return value;
}
export const loadWorkstreams = (workspaceId: string, signal?: AbortSignal) => workstreamRequest<WorkstreamOverview>(workspaceId, "overview", undefined, signal);
export const refKey = (ref: { harness: string; authorityId: string; nativeId: string } | null) => JSON.stringify(ref ? [ref.harness, ref.authorityId, ref.nativeId] : null);
export function filterWorkstreamConversations(data: WorkstreamOverview, filter: { membership: string; phase: string; search: string }) {
  const assignments = data.workstreams.flatMap(w => w.activePhases);
  return data.conversations.filter(row => {
    const member = row.conversation ? row.conversation.workstreamId === null ? "unassigned" : `workstream:${row.conversation.workstreamId}` : "unknown";
    return (filter.membership === "all" || member === filter.membership)
      && (!filter.phase || assignments.some(p => refKey(p.ref) === refKey(row.ref) && sameAssignment(p.phase, filter.phase)))
      && `${row.title} ${row.ref?.nativeId ?? ""} ${row.conversation?.executionCheckout.path ?? ""}`.toLowerCase().includes(filter.search.toLowerCase());
  });
}
