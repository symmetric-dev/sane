import { isBrowserPairTarget, isBrowserPairWrite, sameBrowserPairSession, type BrowserPairSession } from "../shared/browser-pair-contract";
import { body, json } from "./bridge-http";
import { BrowserPairError, type BrowserPairStore } from "./browser-pair-store";
import type { CatalogService } from "./catalog";
import type { Session } from "./history";

export type BrowserPairRoutePorts = {
  storeId: string;
  browserPairs: Pick<BrowserPairStore, "read" | "write">;
  catalog: Pick<CatalogService, "workspaceName" | "association">;
  findSession(sessionId: string): Session | undefined;
  sessionHarness(session: Session): BrowserPairSession["harness"];
  nativeSource(harness: Session["harness"]): string;
  assertDomainMutationOpen(): void;
  authenticated(req: Request): boolean;
  assertCatalogActive(session: Session): void;
  isWorkerSession(sessionId: string): boolean;
  branchReplaced(sessionId: string): boolean;
  branchPending(sessionId: string): boolean;
};

/** The bridge applies its browser/auth/startup boundaries before this route and
 * retains the outer error mapping, including BrowserPairError responses. */
export function createBrowserPairRoute(ports: BrowserPairRoutePorts): (req: Request, url: URL) => Promise<Response | null> {
  return async (req, url) => {
    if (url.pathname !== "/api/browser-pairs") return null;
    if (req.method === "GET") {
      if ([...url.searchParams.keys()].some(key => !["storeId", "workspaceId", "tabId"].includes(key))
        || ["storeId", "workspaceId", "tabId"].some(key => url.searchParams.getAll(key).length !== 1)) return json({ error: "Provide storeId, workspaceId and tabId only" }, 400);
      if (url.searchParams.get("storeId") !== ports.storeId) throw new BrowserPairError(409, "browser-pair-store", "The App store changed; reconnect before pairing");
      const target = { workspaceId: url.searchParams.get("workspaceId"), tabId: url.searchParams.get("tabId") };
      if (!isBrowserPairTarget(target)) throw new BrowserPairError(400, "browser-pair-input", "Invalid browser tab identity");
      if (!ports.catalog.workspaceName(target.workspaceId)) throw new BrowserPairError(404, "browser-pair-workspace", "Unknown browser workspace");
      return json(ports.browserPairs.read(target));
    }
    if (req.method !== "PUT") return json({ error: "Method not allowed" }, 405, { allow: "GET, PUT" });
    if (url.searchParams.size) throw new BrowserPairError(400, "browser-pair-input", "Pairing writes do not accept query parameters");
    const input = await body(req);
    if (!isBrowserPairWrite(input)) throw new BrowserPairError(400, "browser-pair-input", "Provide an exact browser tab, conversation identity, operation and expected revision");
    // Metadata only: no native refresh, prompt preparation or dispatch. The
    // browser owns its tab IDs; the server never fetches a tab's URL.
    const assertCurrent = () => {
      ports.assertDomainMutationOpen();
      if (req.signal.aborted || !ports.authenticated(req)) throw new BrowserPairError(409, "browser-pair-interrupted", "Pairing request is no longer current");
      if (!ports.catalog.workspaceName(input.workspaceId)) throw new BrowserPairError(404, "browser-pair-workspace", "Unknown browser workspace");
      // Removing a stale link must remain possible after retirement/replacement.
      if (input.operation === "remove") return;
      const session = ports.findSession(input.session.sessionId);
      if (!session || !sameBrowserPairSession(input.session, { sessionId: session.sessionId, harness: ports.sessionHarness(session), authorityId: session.authorityId ?? "", nativeSessionId: session.nativeSessionId ?? "" })) throw new BrowserPairError(409, "browser-pair-identity", "Conversation identity changed; reconnect before pairing");
      ports.assertCatalogActive(session);
      if (session.agentKind === "worker" || ports.isWorkerSession(session.sessionId) || session.attachment?.state === "pending"
        || ports.branchReplaced(session.sessionId) || ports.branchPending(session.sessionId) || ports.catalog.association(session.sessionId).association !== "resolved"
        || session.authorityId !== ports.nativeSource(session.harness)) throw new BrowserPairError(409, "browser-pair-unavailable", "This conversation is unavailable for browser pairing");
    };
    return json(ports.browserPairs.write(input, assertCurrent));
  };
}
