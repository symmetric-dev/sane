import type { BrowserSessionGrant, BrowserGrantScope } from "../../shared/browser-host-contract";
export type { BrowserGrantScope } from "../../shared/browser-host-contract";
export type BrowserGrantTarget = Pick<BrowserSessionGrant, "workspaceId" | "tabId">;
export type BrowserSessionIdentity = Pick<BrowserSessionGrant, "sessionId" | "harness" | "authorityId" | "nativeSessionId">;
export type BrowserGrant = BrowserSessionGrant;
export type BrowserGrantRevocation = (grant: BrowserGrant) => void;
const key = (target: BrowserGrantTarget, sessionId: string) => JSON.stringify([target.workspaceId, target.tabId, sessionId]);
const sameSession = (a: BrowserSessionIdentity, b: BrowserSessionIdentity) => a.sessionId === b.sessionId && a.harness === b.harness && a.authorityId === b.authorityId && a.nativeSessionId === b.nativeSessionId;

export class BrowserGrantError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export class BrowserGrantRegistry {
  private grants = new Map<string, BrowserGrant>();
  private revocations = new Set<BrowserGrantRevocation>();
  private changes = new Set<(workspaceId: string, activeGrantCount: number) => void>();
  onRevoke(callback: BrowserGrantRevocation): () => void {
    this.revocations.add(callback);
    return () => { this.revocations.delete(callback); };
  }
  onChange(callback: (workspaceId: string, activeGrantCount: number) => void): () => void {
    this.changes.add(callback);
    return () => { this.changes.delete(callback); };
  }
  private notify(removed: BrowserGrant[], workspaces: Set<string>) {
    const errors: unknown[] = [];
    for (const grant of removed) for (const callback of [...this.revocations]) {
      try { callback({ ...grant }); } catch (error) { errors.push(error); }
    }
    for (const workspaceId of workspaces) for (const callback of [...this.changes]) {
      try { callback(workspaceId, this.countForWorkspace(workspaceId)); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Browser grants changed, but a grant callback failed");
  }
  grant(target: BrowserGrantTarget, sessionIdentity: BrowserSessionIdentity, scope: BrowserGrantScope): BrowserGrant {
    if (![target.workspaceId, target.tabId, sessionIdentity.sessionId, sessionIdentity.harness, sessionIdentity.authorityId, sessionIdentity.nativeSessionId].every(value => typeof value === "string" && value.length > 0) || scope !== "observe" && scope !== "control") throw new BrowserGrantError(400, "browser-grant-input", "A complete verified session identity, target, and grant scope are required");
    const id = key(target, sessionIdentity.sessionId), previous = this.grants.get(id);
    if (previous && !sameSession(previous, sessionIdentity)) throw new BrowserGrantError(409, "browser-grant-identity", "Revoke the old browser grant before changing its paired session identity");
    const now = new Date().toISOString();
    const next: BrowserGrant = { workspaceId: target.workspaceId, tabId: target.tabId, sessionId: sessionIdentity.sessionId, harness: sessionIdentity.harness, authorityId: sessionIdentity.authorityId, nativeSessionId: sessionIdentity.nativeSessionId, scope, grantedAt: previous?.grantedAt ?? now, updatedAt: now };
    this.grants.set(id, next);
    this.notify(previous?.scope === "control" && scope === "observe" ? [previous] : [], new Set([target.workspaceId]));
    return { ...next };
  }
  revoke(target: BrowserGrantTarget, sessionId: string): void {
    this.remove(grant => grant.workspaceId === target.workspaceId && grant.tabId === target.tabId && grant.sessionId === sessionId);
  }
  private remove(matches: (grant: BrowserGrant) => boolean) {
    const removed: BrowserGrant[] = [], workspaces = new Set<string>();
    for (const [id, grant] of this.grants) if (matches(grant)) {
      this.grants.delete(id); removed.push(grant); workspaces.add(grant.workspaceId);
    }
    this.notify(removed, workspaces);
  }
  revokeAllForWorkspace(workspaceId: string): void { this.remove(grant => grant.workspaceId === workspaceId); }
  revokeAllForSession(sessionId: string): void { this.remove(grant => grant.sessionId === sessionId); }
  revokeAll(): void { this.remove(() => true); }
  check(sessionIdentity: BrowserSessionIdentity, requiredScope: BrowserGrantScope, target?: BrowserGrantTarget): boolean {
    if (requiredScope !== "observe" && requiredScope !== "control") return false;
    return [...this.grants.values()].some(grant => sameSession(grant, sessionIdentity)
      && (!target || grant.workspaceId === target.workspaceId && grant.tabId === target.tabId)
      && (grant.scope === "control" || requiredScope === "observe" && grant.scope === "observe"));
  }
  countForWorkspace(workspaceId: string): number { return [...this.grants.values()].filter(grant => grant.workspaceId === workspaceId).length; }
  listForTab(workspaceId: string, tabId: string): BrowserGrant[] {
    return [...this.grants.values()].filter(grant => grant.workspaceId === workspaceId && grant.tabId === tabId).map(grant => ({ ...grant }));
  }
  listForSession(sessionId: string): BrowserGrant[] {
    return [...this.grants.values()].filter(grant => grant.sessionId === sessionId).map(grant => ({ ...grant }));
  }
}
