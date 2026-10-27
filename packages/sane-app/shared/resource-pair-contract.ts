import { isBrowserPairSession, isBrowserPairSnapshot, MAX_BROWSER_PAIR_SESSIONS, sameBrowserPairSession, type BrowserPairLink, type BrowserPairMode, type BrowserPairSession } from "./browser-pair-contract";

/** Passive saved links only: no execution, file access or browser grants. */
export type PairTarget = { kind: "browser"; workspaceId: string; tabId: string }
  | { kind: "file"; workspaceId: string; worktreeId: string; path: string };
export type PairSession = BrowserPairSession;
export type PairLink = BrowserPairLink;
export type PairMode = BrowserPairMode;
export type PairSnapshot = { version: 1; storeId: string; target: PairTarget; revision: number; sessions: PairLink[] };
/** Read-only reverse lookup. Browser targets are workspace-scoped, not worktree-scoped. */
export type PairLinkedSnapshot = { version: 1; storeId: string; workspaceId: string; worktreeId: string; kind: "browser" | "file"; session: PairSession; targets: PairSnapshot[] };
export type PairWrite = { version: 1; storeId: string; target: PairTarget; expectedRevision: number }
  & ({ operation: PairMode | "remove"; session: PairSession } | { operation: "clear" });
export const MAX_PAIR_SESSIONS = MAX_BROWSER_PAIR_SESSIONS;
export const MAX_PAIR_TARGETS = 5000;
export const samePairSession = sameBrowserPairSession;
export const isPairSession = isBrowserPairSession;
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, names: readonly string[]) => names.every(name => Object.hasOwn(value, name)) && Object.keys(value).every(name => names.includes(name));
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const relativePath = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096
  && !/[\\\u0000-\u001f\u007f-\u009f]/.test(value) && !/^[a-z]:/i.test(value)
  && value.split("/").every(part => !!part && part !== "." && part !== ".." && ![".git", ".sane"].includes(part.toLowerCase()));

export function isPairTarget(value: unknown): value is PairTarget {
  return object(value) && uuid(value.workspaceId) && (value.kind === "browser"
    ? keys(value, ["kind", "workspaceId", "tabId"]) && typeof value.tabId === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value.tabId)
    : value.kind === "file" && keys(value, ["kind", "workspaceId", "worktreeId", "path"]) && uuid(value.worktreeId) && relativePath(value.path));
}
export const pairTargetKey = (target: PairTarget): string => target.kind === "browser"
  ? JSON.stringify([target.kind, target.workspaceId, target.tabId])
  : JSON.stringify([target.kind, target.workspaceId, target.worktreeId, target.path]);
export const samePairTarget = (a: PairTarget, b: PairTarget): boolean => pairTargetKey(a) === pairTargetKey(b);

export function isPairSnapshot(value: unknown): value is PairSnapshot {
  return object(value) && keys(value, ["version", "storeId", "target", "revision", "sessions"]) && isPairTarget(value.target)
    // Reuse the established identity, link metadata, revision and duplicate rules.
    && isBrowserPairSnapshot({ version: value.version, storeId: value.storeId, workspaceId: value.target.workspaceId,
      tabId: value.target.kind === "browser" ? value.target.tabId : "file", revision: value.revision, sessions: value.sessions });
}
export function isPairLinkedSnapshot(value: unknown): value is PairLinkedSnapshot {
  if (!object(value) || !keys(value, ["version", "storeId", "workspaceId", "worktreeId", "kind", "session", "targets"])
    || value.version !== 1 || !uuid(value.storeId) || !uuid(value.workspaceId) || !uuid(value.worktreeId)
    || !["browser", "file"].includes(value.kind) || !isPairSession(value.session)
    || !Array.isArray(value.targets) || value.targets.length > MAX_PAIR_TARGETS) return false;
  const seen = new Set<string>();
  return value.targets.every((snapshot: unknown) => {
    if (!isPairSnapshot(snapshot) || snapshot.storeId !== value.storeId || snapshot.target.workspaceId !== value.workspaceId
      || snapshot.target.kind !== value.kind || snapshot.target.kind === "file" && snapshot.target.worktreeId !== value.worktreeId
      || !snapshot.sessions.some(link => samePairSession(link, value.session))) return false;
    const key = pairTargetKey(snapshot.target);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
export function isPairWrite(value: unknown): value is PairWrite {
  return object(value) && keys(value, ["version", "storeId", "target", "expectedRevision", "operation", ...(value.operation === "clear" ? [] : ["session"])])
    && value.version === 1 && uuid(value.storeId) && isPairTarget(value.target) && Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 0
    && (value.operation === "clear" || ["replace", "add", "remove"].includes(value.operation) && isPairSession(value.session));
}
