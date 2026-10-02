import type { WorkstreamOverview } from "../src/workstreams-contract";
import { sameAssignment } from "./assignment-semantics";
export async function workstreamRequest<T>(workspaceId: string, operation: string, input?: unknown): Promise<T> {
  const response = await fetch(`/api/workstreams${operation ? `/${operation}` : ""}?workspaceId=${encodeURIComponent(workspaceId)}`, {
    credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(25000),
    ...(input === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `Request failed (${response.status})`);
  return value;
}
export const loadWorkstreams = (workspaceId: string) => workstreamRequest<WorkstreamOverview>(workspaceId, "overview");
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
