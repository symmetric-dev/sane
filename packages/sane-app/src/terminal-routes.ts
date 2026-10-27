import { body, json } from "./bridge-http";
import type { TerminalService, TerminalSocketData } from "./terminal";

const terminalPattern = /^\/api\/workspaces\/([^/]+)\/worktrees\/([^/]+)\/terminal(?:\/(socket|close|restart))?$/;
export const matchesTerminalRoute = (path: string): boolean => terminalPattern.test(path);

export type TerminalRouteResult = Readonly<{ handled: false }> | Readonly<{ handled: true; response: Response | undefined }>;
export type TerminalRoutePorts = Readonly<{
  terminals: Pick<TerminalService, "prepare" | "cancelUpgrade" | "get" | "change">;
  terminalToken: (req: Request) => string | undefined;
  readOrigin: () => string;
  closing: () => boolean;
}>;

/** An upgraded socket is handled even though Bun requires an undefined response.
 * Browser authentication and startup/mutation guards remain in the bridge. */
export function createTerminalRoute({ terminals, terminalToken, readOrigin, closing }: TerminalRoutePorts) {
  return async function terminalRoute(req: Request, url: URL,
    upgrade?: (req: Request, data: TerminalSocketData) => boolean): Promise<TerminalRouteResult> {
    const terminalMatch = terminalPattern.exec(url.pathname);
    if (!terminalMatch) return { handled: false };
    const handled = (response: Response | undefined): TerminalRouteResult => ({ handled: true, response });
    const workspaceId = decodeURIComponent(terminalMatch[1]!), worktreeId = decodeURIComponent(terminalMatch[2]!), operation = terminalMatch[3];
    // No query-string credentials or mutable cwd/directory overrides.
    if (url.search) return handled(json({ error: "Terminal routes do not accept query parameters", code: "terminal-query" }, 400));
    if (operation === "socket") {
      if (req.method !== "GET") return handled(json({ error: "Method not allowed" }, 405));
      if (req.headers.get("origin") !== readOrigin()) return handled(json({ error: "Origin rejected" }, 403));
      if (!upgrade || req.headers.get("upgrade")?.toLowerCase() !== "websocket") return handled(json({ error: "WebSocket upgrade required" }, 426));
      const token = terminalToken(req);
      if (!token) return handled(json({ error: "Authentication required" }, 401));
      const data = await terminals.prepare(workspaceId, worktreeId, token);
      if (closing() || terminalToken(req) !== token) { terminals.cancelUpgrade(data); return handled(json({ error: "Attachment authorization changed" }, 401)); }
      try { if (upgrade(req, data)) return handled(undefined); } catch { terminals.cancelUpgrade(data); return handled(json({ error: "WebSocket upgrade failed" }, 400)); }
      terminals.cancelUpgrade(data); return handled(json({ error: "WebSocket upgrade failed" }, 400));
    }
    if (!operation && req.method === "GET") {
      const token = terminalToken(req), state = await terminals.get(workspaceId, worktreeId);
      if (!token || terminalToken(req) !== token) return handled(json({ error: "Authentication revoked" }, 401));
      return handled(json(state));
    }
    if (req.method === "POST") {
      const token = terminalToken(req), input = await body(req);
      return handled(json(await terminals.change(workspaceId, worktreeId, operation === "close" ? "close" : operation === "restart" ? "restart" : "start", input, () => !closing() && !!token && terminalToken(req) === token)));
    }
    return handled(json({ error: "Method not allowed" }, 405));
  };
}
