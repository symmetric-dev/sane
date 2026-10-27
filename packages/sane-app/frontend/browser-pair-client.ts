import { request } from "./cc-client";
import { isPairLinkedSnapshot, isPairSnapshot, pairTargetKey, samePairSession, samePairTarget, type PairLinkedSnapshot, type PairSession, type PairSnapshot, type PairTarget, type PairWrite } from "../shared/resource-pair-contract";
import { workspaceEpoch } from "./workspace-store";

const snapshots = new Map<string, PairSnapshot>();
const listeners = new Set<() => void>();
const key = (storeId: string, target: PairTarget, auth = workspaceEpoch()) => JSON.stringify([auth, storeId, pairTargetKey(target)]);
export const browserPairCache = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  snapshot(storeId: string, target: PairTarget) { return snapshots.get(key(storeId, target)) ?? null; },
};
function publish(snapshot: PairSnapshot, auth: number) {
  if (auth !== workspaceEpoch()) return;
  const id = key(snapshot.storeId, snapshot.target, auth), previous = snapshots.get(id);
  if (previous && previous.revision > snapshot.revision) return;
  snapshots.set(id, snapshot); listeners.forEach(listener => listener());
}

export async function readBrowserPairs(storeId: string, target: PairTarget, signal?: AbortSignal): Promise<PairSnapshot> {
  const auth = workspaceEpoch();
  const result = await request(`/api/resource-pairs?${new URLSearchParams({ storeId, target: JSON.stringify(target) })}`, { signal });
  if (!isPairSnapshot(result) || result.storeId !== storeId || !samePairTarget(result.target, target)) throw new Error("Stored resource links could not be verified");
  signal?.throwIfAborted();
  publish(result, auth); return result;
}

/** Exact-session discovery is metadata only; the caller still confirms its chosen revision. */
export async function readLinkedPairs(storeId: string, scope: { workspaceId: string; worktreeId: string; kind: PairTarget["kind"] }, session: PairSession, signal?: AbortSignal): Promise<PairLinkedSnapshot> {
  const auth = workspaceEpoch();
  const result = await request(`/api/resource-pairs/linked?${new URLSearchParams({ storeId, ...scope, session: JSON.stringify(session) })}`, { signal });
  if (!isPairLinkedSnapshot(result) || result.storeId !== storeId || result.workspaceId !== scope.workspaceId
    || result.worktreeId !== scope.worktreeId || result.kind !== scope.kind || !samePairSession(result.session, session)
    || result.targets.some(snapshot => snapshot.storeId !== storeId || snapshot.target.workspaceId !== scope.workspaceId
      || snapshot.target.kind !== scope.kind || snapshot.target.kind === "file" && snapshot.target.worktreeId !== scope.worktreeId
      || !snapshot.sessions.some(link => samePairSession(link, session)))
    || new Set(result.targets.map(snapshot => pairTargetKey(snapshot.target))).size !== result.targets.length) {
    throw new Error("Stored resource links could not be verified");
  }
  signal?.throwIfAborted();
  for (const snapshot of result.targets) publish(snapshot, auth);
  return result;
}

/** No retries: a lost write receipt must be checked with a fresh read. */
export async function writeBrowserPairs(before: PairSnapshot, session: PairSession, operation: "replace" | "add" | "remove", signal?: AbortSignal): Promise<PairSnapshot> {
  const input: PairWrite = { version: 1, storeId: before.storeId, target: before.target, expectedRevision: before.revision, operation, session };
  const expected = operation === "remove" ? before.sessions.filter(link => link.sessionId !== session.sessionId)
    : operation === "replace" ? [session] : before.sessions.some(link => samePairSession(link, session)) ? before.sessions : [...before.sessions, session];
  return commitBrowserPairs(before, input, expected, signal);
}
export function clearBrowserPairs(before: PairSnapshot, signal?: AbortSignal): Promise<PairSnapshot> {
  return commitBrowserPairs(before, { version: 1, storeId: before.storeId, target: before.target, expectedRevision: before.revision, operation: "clear" }, [], signal);
}
async function commitBrowserPairs(before: PairSnapshot, input: PairWrite, expected: PairSession[], signal?: AbortSignal): Promise<PairSnapshot> {
  const auth = workspaceEpoch();
  const result = await request("/api/resource-pairs", { method: "PUT", body: JSON.stringify(input), signal });
  if (!isPairSnapshot(result) || result.storeId !== before.storeId || !samePairTarget(result.target, before.target)
    || ![before.revision, before.revision + 1].includes(result.revision)) throw new Error("Pairing update was not confirmed; check stored links before trying again");
  if (result.sessions.length !== expected.length || expected.some(link => !result.sessions.some(item => samePairSession(item, link)))) throw new Error("Pairing update was not confirmed; check stored links before trying again");
  publish(result, auth); return result;
}
