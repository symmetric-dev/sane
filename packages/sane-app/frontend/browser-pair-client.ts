import { request } from "./cc-client";
import { isBrowserPairSnapshot, sameBrowserPairSession, type BrowserPairSession, type BrowserPairSnapshot, type BrowserPairTarget, type BrowserPairWrite } from "../shared/browser-pair-contract";

export async function readBrowserPairs(storeId: string, target: BrowserPairTarget, signal?: AbortSignal): Promise<BrowserPairSnapshot> {
  const result = await request(`/api/browser-pairs?${new URLSearchParams({ storeId, ...target })}`, { signal });
  if (!isBrowserPairSnapshot(result) || result.storeId !== storeId || result.workspaceId !== target.workspaceId || result.tabId !== target.tabId) throw new Error("Stored browser links could not be verified");
  return result;
}

/** No retries: a lost write receipt must be checked with a fresh read. */
export async function writeBrowserPairs(before: BrowserPairSnapshot, session: BrowserPairSession, operation: BrowserPairWrite["operation"], signal?: AbortSignal): Promise<BrowserPairSnapshot> {
  const input: BrowserPairWrite = { version: 1, storeId: before.storeId, workspaceId: before.workspaceId, tabId: before.tabId, expectedRevision: before.revision, operation, session };
  const result = await request("/api/browser-pairs", { method: "PUT", body: JSON.stringify(input), signal });
  if (!isBrowserPairSnapshot(result) || result.storeId !== before.storeId || result.workspaceId !== before.workspaceId || result.tabId !== before.tabId
    || ![before.revision, before.revision + 1].includes(result.revision)) throw new Error("Pairing update was not confirmed; check stored links before trying again");
  const expected = operation === "remove" ? before.sessions.filter(link => link.sessionId !== session.sessionId)
    : operation === "replace" ? [session] : before.sessions.some(link => sameBrowserPairSession(link, session)) ? before.sessions : [...before.sessions, session];
  if (result.sessions.length !== expected.length || expected.some(link => !result.sessions.some(item => sameBrowserPairSession(item, link)))) throw new Error("Pairing update was not confirmed; check stored links before trying again");
  return result;
}
