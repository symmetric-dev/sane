import { request } from "./cc-client";
import { isBrowserPairSnapshot, sameBrowserPairSession, type BrowserPairSession, type BrowserPairSnapshot, type BrowserPairTarget, type BrowserPairWrite } from "../shared/browser-pair-contract";
import { workspaceEpoch } from "./workspace-store";

const snapshots = new Map<string, BrowserPairSnapshot>();
const listeners = new Set<() => void>();
const key = (storeId: string, target: BrowserPairTarget, auth = workspaceEpoch()) => JSON.stringify([auth, storeId, target.workspaceId, target.tabId]);
export const browserPairCache = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  snapshot(storeId: string, target: BrowserPairTarget) { return snapshots.get(key(storeId, target)) ?? null; },
};
function publish(snapshot: BrowserPairSnapshot, auth: number) {
  if (auth !== workspaceEpoch()) return;
  const id = key(snapshot.storeId, snapshot, auth), previous = snapshots.get(id);
  if (previous && previous.revision > snapshot.revision) return;
  snapshots.set(id, snapshot); listeners.forEach(listener => listener());
}

export async function readBrowserPairs(storeId: string, target: BrowserPairTarget, signal?: AbortSignal): Promise<BrowserPairSnapshot> {
  const auth = workspaceEpoch();
  const result = await request(`/api/browser-pairs?${new URLSearchParams({ storeId, ...target })}`, { signal });
  if (!isBrowserPairSnapshot(result) || result.storeId !== storeId || result.workspaceId !== target.workspaceId || result.tabId !== target.tabId) throw new Error("Stored browser links could not be verified");
  publish(result, auth); return result;
}

/** No retries: a lost write receipt must be checked with a fresh read. */
export async function writeBrowserPairs(before: BrowserPairSnapshot, session: BrowserPairSession, operation: "replace" | "add" | "remove", signal?: AbortSignal): Promise<BrowserPairSnapshot> {
  const input: BrowserPairWrite = { version: 1, storeId: before.storeId, workspaceId: before.workspaceId, tabId: before.tabId, expectedRevision: before.revision, operation, session };
  const expected = operation === "remove" ? before.sessions.filter(link => link.sessionId !== session.sessionId)
    : operation === "replace" ? [session] : before.sessions.some(link => sameBrowserPairSession(link, session)) ? before.sessions : [...before.sessions, session];
  return commitBrowserPairs(before, input, expected, signal);
}
export function clearBrowserPairs(before: BrowserPairSnapshot, signal?: AbortSignal): Promise<BrowserPairSnapshot> {
  return commitBrowserPairs(before, { version: 1, storeId: before.storeId, workspaceId: before.workspaceId, tabId: before.tabId, expectedRevision: before.revision, operation: "clear" }, [], signal);
}
async function commitBrowserPairs(before: BrowserPairSnapshot, input: BrowserPairWrite, expected: BrowserPairSession[], signal?: AbortSignal): Promise<BrowserPairSnapshot> {
  const auth = workspaceEpoch();
  const result = await request("/api/browser-pairs", { method: "PUT", body: JSON.stringify(input), signal });
  if (!isBrowserPairSnapshot(result) || result.storeId !== before.storeId || result.workspaceId !== before.workspaceId || result.tabId !== before.tabId
    || ![before.revision, before.revision + 1].includes(result.revision)) throw new Error("Pairing update was not confirmed; check stored links before trying again");
  if (result.sessions.length !== expected.length || expected.some(link => !result.sessions.some(item => sameBrowserPairSession(item, link)))) throw new Error("Pairing update was not confirmed; check stored links before trying again");
  publish(result, auth); return result;
}
