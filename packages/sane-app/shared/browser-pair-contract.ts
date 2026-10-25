/** Passive metadata only. A link grants no browser or execution capabilities. */
export type BrowserPairTarget = { workspaceId: string; tabId: string };
export type BrowserPairSession = { sessionId: string; harness: "claude-code" | "opencode"; authorityId: string; nativeSessionId: string };
export type BrowserPairLink = BrowserPairSession & { linkedAt: string; lastPairedAt?: string };
export type BrowserPairSnapshot = BrowserPairTarget & { version: 1; storeId: string; revision: number; sessions: BrowserPairLink[] };
export type BrowserPairMode = "replace" | "add";
export type BrowserPairWrite = BrowserPairTarget & {
  version: 1; storeId: string; expectedRevision: number; operation: BrowserPairMode | "remove"; session: BrowserPairSession;
};
export const MAX_BROWSER_PAIR_SESSIONS = 100;
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, names: readonly string[], optional: readonly string[] = []) => names.every(name => Object.hasOwn(value, name)) && Object.keys(value).every(name => names.includes(name) || optional.includes(name));
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const target = (value: Record<string, any>) => uuid(value.workspaceId) && typeof value.tabId === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value.tabId);
const session = (value: Record<string, any>) => uuid(value.sessionId) && ["claude-code", "opencode"].includes(value.harness)
  && typeof value.authorityId === "string" && new RegExp(`^sane-native-v1:${value.harness === "opencode" ? "oc" : "cc"}:[a-f0-9]{64}$`).test(value.authorityId)
  && (value.harness === "claude-code" ? uuid(value.nativeSessionId) : typeof value.nativeSessionId === "string" && /^ses[a-zA-Z0-9_-]{1,200}$/.test(value.nativeSessionId));
const SESSION_KEYS = ["sessionId", "harness", "authorityId", "nativeSessionId"];
export const sameBrowserPairSession = (a: BrowserPairSession, b: BrowserPairSession) => SESSION_KEYS.every(key => a[key as keyof BrowserPairSession] === b[key as keyof BrowserPairSession]);
export function isBrowserPairSession(value: unknown): value is BrowserPairSession {
  return object(value) && keys(value, SESSION_KEYS) && session(value);
}
export function isBrowserPairSnapshot(value: unknown): value is BrowserPairSnapshot {
  return object(value) && keys(value, ["version", "storeId", "workspaceId", "tabId", "revision", "sessions"])
    && value.version === 1 && uuid(value.storeId) && target(value) && Number.isSafeInteger(value.revision) && value.revision >= 0
    && Array.isArray(value.sessions) && value.sessions.length <= MAX_BROWSER_PAIR_SESSIONS
    && (value.revision > 0 || value.sessions.length === 0)
    && value.sessions.every(link => object(link) && keys(link, [...SESSION_KEYS, "linkedAt"], ["lastPairedAt"]) && session(link)
      && typeof link.linkedAt === "string" && Number.isFinite(Date.parse(link.linkedAt))
      && (link.lastPairedAt === undefined || typeof link.lastPairedAt === "string" && Number.isFinite(Date.parse(link.lastPairedAt)) && Date.parse(link.lastPairedAt) >= Date.parse(link.linkedAt)))
    && new Set(value.sessions.map(link => link.sessionId)).size === value.sessions.length;
}
export function isBrowserPairWrite(value: unknown): value is BrowserPairWrite {
  return object(value) && keys(value, ["version", "storeId", "workspaceId", "tabId", "expectedRevision", "operation", "session"])
    && value.version === 1 && uuid(value.storeId) && target(value) && Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 0
    && ["replace", "add", "remove"].includes(value.operation) && isBrowserPairSession(value.session);
}
export function isBrowserPairTarget(value: unknown): value is BrowserPairTarget {
  return object(value) && keys(value, ["workspaceId", "tabId"]) && target(value);
}
