import { afterEach, describe, expect, test } from "bun:test";
import type { BrowserNativeCaller } from "../../shared/browser-host-contract";
import { BrowserGrantError, BrowserGrantRegistry, type BrowserGrantTarget, type BrowserSessionIdentity } from "./browser-grant-registry";
import { BrowserService } from "./browser-service";

const HOST = "host-handoff-token";
const target: BrowserGrantTarget = { workspaceId: "workspace-1", tabId: "tab-1" };
const session: BrowserSessionIdentity = { sessionId: "session-1", harness: "claude-code", authorityId: "authority-1", nativeSessionId: "native-1" };
const caller: BrowserNativeCaller = { source: { kind: "test" }, authorityId: session.authorityId, nativeId: session.nativeSessionId, cwd: "/synthetic/checkout" };
const services: BrowserService[] = [];

afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });

function service() {
  const created = new BrowserService({
    dataDir: "/synthetic/browser-broker-auth",
    validToken: () => true,
    getOrigins: () => ({ publicOrigin: "http://127.0.0.1:9", loopbackOrigin: "http://127.0.0.1:9" }),
  });
  services.push(created);
  return created;
}

function request(token: string, body: Record<string, unknown>) {
  return new Request("http://127.0.0.1/native/browser", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const observe = { version: 1, tool: "browser_status", arguments: {} };
// reload skips URL registry checks and still reaches agentTarget's control grant check.
const control = { version: 1, tool: "browser_navigate", arguments: { action: "reload", generation: 0, leaseGeneration: 0 } };

type VisibleGrant = { grants: BrowserGrantRegistry; tabs: Map<string, { workspaceId: string; tabId: string; attachments: Set<unknown> }> };
function internals(browser: BrowserService) { return browser as unknown as VisibleGrant; }

function plantVisibleControlGrant(browser: BrowserService) {
  // setGrant requires a running tab. Plant the registry grant, then the two indexes the removed
  // unique-grant scan used (known tabs and session credentials), without booting Chromium.
  internals(browser).grants.grant(target, session, "control");
  const sessionToken = browser.issueSessionCredential(session, target);
  internals(browser).tabs.set(JSON.stringify([target.workspaceId, target.tabId]), { ...target, attachments: new Set() });
  return sessionToken;
}

async function body(res: Response) { return await res.json() as { error?: string; code?: string; ok?: boolean }; }

describe("handleNativeBroker host-token authority", () => {
  test("host token with no caller is unverified when no grant exists", async () => {
    const browser = service();
    const res = await browser.handleNativeBroker(request(HOST, control), HOST);
    expect(res.status).toBe(403);
    expect(await body(res)).toMatchObject({ code: "browser-session-unverified" });
  });

  test("host token with no caller does not impersonate the only Control grant", async () => {
    const browser = service();
    const sessionToken = plantVisibleControlGrant(browser);
    expect(sessionToken).not.toBe(HOST);
    const grants = browser.listGrants(target.workspaceId, target.tabId);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ scope: "control", sessionId: session.sessionId, workspaceId: target.workspaceId, tabId: target.tabId });
    let resolved = false;
    const res = await browser.handleNativeBroker(request(HOST, observe), HOST, () => { resolved = true; return session; });
    expect(resolved).toBe(false);
    expect(res.status).toBe(403);
    const payload = await body(res);
    expect(payload).toMatchObject({ code: "browser-session-unverified" });
    expect(payload.ok).toBeUndefined();
    expect(browser.listGrants(target.workspaceId, target.tabId)).toHaveLength(1);
  });

  test("unknown bearer is rejected before grant selection", async () => {
    const browser = service();
    plantVisibleControlGrant(browser);
    const res = await browser.handleNativeBroker(request("not-the-host-token", observe), HOST);
    expect(res.status).toBe(401);
    expect(await body(res)).toMatchObject({ code: "browser-auth" });
  });

  test("session credential without a grant is not accepted as control", async () => {
    const browser = service();
    const token = browser.issueSessionCredential(session, target);
    const res = await browser.handleNativeBroker(request(token, control), HOST);
    expect(res.status).toBe(403);
    expect(await body(res)).toMatchObject({ code: "browser-grant-required" });
  });

  test("host token with caller requires resolveCaller and does not accept a missing resolver", async () => {
    const browser = service();
    const res = await browser.handleNativeBroker(request(HOST, { ...observe, caller }), HOST);
    expect(res.status).toBe(403);
    expect(await body(res)).toMatchObject({ code: "browser-session-unverified" });
  });

  // A resolved caller is not followed through to a successful tool result. That needs a granted
  // running tab, and setGrant starts Chromium. These cases stay offline: a missing or non-returning
  // resolver is 403, and a returned identity still hits the existing grant check.
  test("host token with caller invokes resolveCaller and is unverified when it does not return an identity", async () => {
    const browser = service();
    const calls: BrowserNativeCaller[] = [];
    const res = await browser.handleNativeBroker(request(HOST, { ...observe, caller }), HOST, candidate => {
      calls.push(candidate);
      throw new BrowserGrantError(403, "browser-session-unverified", "This conversation is not an admitted SANE session");
    });
    expect(calls).toEqual([caller]);
    expect(res.status).toBe(403);
    expect(await body(res)).toMatchObject({ code: "browser-session-unverified" });
  });

  test("host token with a resolved caller still cannot take control without a grant", async () => {
    const browser = service();
    let resolved: BrowserSessionIdentity | undefined;
    const res = await browser.handleNativeBroker(request(HOST, { ...control, caller }), HOST, candidate => {
      expect(candidate).toEqual(caller);
      resolved = session;
      return session;
    });
    expect(resolved).toEqual(session);
    expect(res.status).toBe(403);
    expect(await body(res)).toMatchObject({ code: "browser-grant-required" });
  });
});
