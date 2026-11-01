import { body, json } from "./bridge-http";
import { AsideError } from "./aside-store";
import type { AsideChatState, AsideChatSendRequest, AsideChatSendResponse, AsideConversationOpenResponse } from "../shared/aside-chat-contract";
import { parseAsideDraftRequest } from "../shared/aside-contract";

const pattern = /^\/api\/asides\/([^/]+)\/(open|session|messages)$/;
export const matchesAsideChatRoute = (url: URL) => pattern.test(url.pathname);
export type AsideChatRoutePorts = {
  assertCurrent(): void;
  get(id: string): Promise<AsideChatState>;
  open(id: string): Promise<AsideChatState>;
  openConversation(id: string): Promise<AsideConversationOpenResponse>;
  send(id: string, input: AsideChatSendRequest): Promise<AsideChatSendResponse>;
};
export function createAsideChatRoute(ports: AsideChatRoutePorts) {
  return async (req: Request, url: URL): Promise<Response | null> => {
    const match = pattern.exec(url.pathname); if (!match) return null;
    try {
      ports.assertCurrent();
      let id: string;
      try { id = decodeURIComponent(match[1]!); } catch { throw new AsideError(400, "aside-input", "Invalid aside identifier"); }
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) || url.searchParams.size)
        throw new AsideError(400, "aside-input", "Provide an aside UUID without query parameters");
      if (match[2] === "session" && req.method === "GET") {
        const session = await ports.get(id); ports.assertCurrent(); return json({ session });
      }
      if (req.method !== "POST") return json({ error: "Method not allowed", code: "aside-method-not-allowed" }, 405, { allow: match[2] === "session" ? "GET, POST" : "POST" });
      let input: unknown;
      try { input = await body(req); } catch (error) {
        throw new AsideError(error instanceof Error && error.message === "Body too large" ? 413 : 400, "aside-input", "Invalid or oversized aside request body");
      }
      ports.assertCurrent();
      if (match[2] === "session" || match[2] === "open") {
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length) throw new AsideError(400, "aside-input", "Session opening accepts an empty object only");
        if (match[2] === "open") {
          const started = performance.now();
          const opened = await ports.openConversation(id); ports.assertCurrent();
          const response = json(opened);
          response.headers.set("Server-Timing", `aside_open;dur=${(performance.now() - started).toFixed(1)}`);
          return response;
        }
        const session = await ports.open(id); ports.assertCurrent(); return json({ session });
      }
      let request: AsideChatSendRequest;
      // Recovery-only: retain the persisted request schema, rather than applying
      // today's new-send policy to an exact historical receipt lookup.
      try { request = parseAsideDraftRequest(input); } catch { throw new AsideError(400, "aside-input", "Invalid aside message request"); }
      const response = await ports.send(id, request);
      // Revalidate the original principal for the response too. A lost/aborted
      // reply never cancels committed native intake; exact replay recovers it.
      ports.assertCurrent(); return json(response, 202);
    } catch (error) {
      try { ports.assertCurrent(); } catch (current) { error = current; }
      if (error instanceof AsideError) return json({ error: error.message, code: error.code }, error.status);
      if (error && typeof error === "object" && "status" in error && typeof error.status === "number" && error.status >= 400 && error.status <= 599)
        return json({ error: error instanceof Error ? error.message : "Aside conversation unavailable", code: "code" in error && typeof error.code === "string" ? error.code : "aside-chat-unavailable" }, error.status);
      return json({ error: "Aside conversation is temporarily unavailable", code: "aside-chat-unavailable" }, 503);
    }
  };
}
