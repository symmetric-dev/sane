import type { AsideExecutionReadiness, AsideExecutionReadResponse } from "../shared/aside-execution-contract";
import type { AsideExecutionService } from "./aside-execution";
import { AsideError } from "./aside-store";
import { body, json } from "./bridge-http";

const pattern = /^\/api\/asides\/([^/]+)\/(execution|messages)$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Bridge authentication/POST permission guards run before this handler.
 * Instantiate per request with a request-bound AsideExecutionService. Both
 * layers revalidate ownership across their own await points, including errors. */
export interface AsideExecutionRoutePorts {
  inspect(id: string): ReturnType<AsideExecutionService["inspect"]>;
  submit(id: string, input: unknown): Promise<never>;
  assertCurrent(req: Request): void;
}

export function matchesAsideExecutionRoute(url: URL): boolean {
  return pattern.test(url.pathname);
}

function pathId(value: string): string {
  let id: string;
  try { id = decodeURIComponent(value); }
  catch { throw new AsideError(400, "aside-input", "Invalid aside route identifier"); }
  if (!uuidPattern.test(id)) throw new AsideError(400, "aside-input", "Invalid aside route identifier");
  return id;
}

async function requestBody(req: Request): Promise<unknown> {
  try { return await body(req); }
  catch (error) {
    if (error instanceof Error && error.message === "Body too large") throw new AsideError(413, "aside-input", "Aside request body exceeds the 1 MiB limit");
    throw new AsideError(400, "aside-input", "Invalid aside request body");
  }
}

function unavailable(code: string): AsideExecutionReadiness | undefined {
  if (code === "aside-context-unconfigured" || code === "aside-archived" || code === "aside-discarded") return { available: false, code };
}

/** No cancel endpoint or run stream exists: nothing has been independently
 * materialized or dispatched. A message POST is a truthful 409 rejection, never
 * a synthetic accepted response or a conversation seeded with raw snapshots. */
export function createAsideExecutionRoute(ports: AsideExecutionRoutePorts) {
  return async (req: Request, url: URL): Promise<Response | null> => {
    const match = pattern.exec(url.pathname);
    if (!match) return null;
    try {
      ports.assertCurrent(req);
      const id = pathId(match[1]!);
      if (url.searchParams.size) throw new AsideError(400, "aside-input", "Aside routes do not accept query parameters");
      const method = match[2] === "execution" ? "GET" : "POST";
      if (req.method !== method) return json({ error: "Method not allowed", code: "aside-method-not-allowed" }, 405, { allow: method });
      if (method === "GET") {
        const execution = await ports.inspect(id);
        ports.assertCurrent(req);
        const response: AsideExecutionReadResponse = { execution };
        return json(response);
      }
      const input = await requestBody(req);
      ports.assertCurrent(req);
      await ports.submit(id, input);
      // Defensive fail-closed handling for incorrectly wired JavaScript ports:
      // even a resolving submit implementation cannot manufacture acceptance.
      ports.assertCurrent(req);
      throw new AsideError(503, "asides-unavailable", "Aside execution is unavailable");
    } catch (error) {
      try { ports.assertCurrent(req); } catch (currentError) { error = currentError; }
      if (error instanceof AsideError) {
        const execution = unavailable(error.code);
        return json({ error: error.message, code: error.code, ...(execution ? { execution } : {}) }, error.status);
      }
      return json({ error: "Aside execution is temporarily unavailable", code: "asides-unavailable" }, 503);
    }
  };
}
