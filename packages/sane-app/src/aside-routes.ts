import { ASIDE_EXECUTION_AVAILABILITY, type AsideRecord, type AsideSummary } from "../shared/aside-contract";
import { AsideError } from "./aside-store";
import { body, json } from "./bridge-http";

const collectionPattern = /^\/api\/sessions\/([^/]+)\/asides$/;
const recordPattern = /^\/api\/asides\/([^/]+)(?:\/(draft|lifecycle))?$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AsideRoutePorts {
  create(sessionId: string, input: unknown): Promise<AsideRecord>;
  list(sessionId: string): Promise<AsideSummary[]> | AsideSummary[];
  get(id: string): Promise<AsideRecord>;
  saveDraft(id: string, input: unknown): Promise<AsideRecord>;
  setLifecycle(id: string, input: unknown): Promise<AsideRecord>;
  /** Revalidate the authenticated startup/storage owner. Mutations must also
   * revalidate at their service commit boundary, not just at HTTP await points. */
  assertCurrent(req: Request): void;
}

export function matchesAsideRoute(url: URL): boolean {
  return collectionPattern.test(url.pathname) || recordPattern.test(url.pathname);
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
    if (error instanceof Error && error.message === "Body too large") {
      throw new AsideError(413, "aside-input", "Aside request body exceeds the 1 MiB limit");
    }
    throw new AsideError(400, "aside-input", "Invalid aside request body");
  }
}

/** App-owned durable drafts and captured references only. The bridge applies
 * authentication before this handler; no route submits or creates native work.
 * Discard is a lifecycle change that retains the source snapshot, not erasure. */
export function createAsideRoute(ports: AsideRoutePorts) {
  return async (req: Request, url: URL): Promise<Response | null> => {
    const collection = collectionPattern.exec(url.pathname);
    const record = recordPattern.exec(url.pathname);
    if (!collection && !record) return null;
    try {
      ports.assertCurrent(req);
      const id = pathId((collection ?? record)![1]!);
      if (url.searchParams.size) throw new AsideError(400, "aside-input", "Aside routes do not accept query parameters");
      const action = record?.[2];
      const allow = collection ? "GET, POST" : action ? "POST" : "GET";
      if (!(collection ? req.method === "GET" || req.method === "POST" : req.method === (action ? "POST" : "GET"))) {
        return json({ error: "Method not allowed", code: "aside-method-not-allowed" }, 405, { allow });
      }
      if (collection && req.method === "GET") {
        const asides = await ports.list(id);
        ports.assertCurrent(req);
        return json({ asides, execution: ASIDE_EXECUTION_AVAILABILITY });
      }
      if (record && !action) {
        const started = performance.now();
        const aside = await ports.get(id);
        ports.assertCurrent(req);
        const response = json({ aside, execution: ASIDE_EXECUTION_AVAILABILITY });
        response.headers.set("Server-Timing", `aside_reference;dur=${(performance.now() - started).toFixed(1)}`);
        return response;
      }
      const input = await requestBody(req);
      ports.assertCurrent(req);
      const started = performance.now();
      const aside = collection ? await ports.create(id, input)
        : action === "draft" ? await ports.saveDraft(id, input) : await ports.setLifecycle(id, input);
      ports.assertCurrent(req);
      const response = json({ aside, execution: ASIDE_EXECUTION_AVAILABILITY }, collection ? 201 : 200);
      response.headers.set("Server-Timing", `${collection ? "aside_capture" : "aside_write"};dur=${(performance.now() - started).toFixed(1)}`);
      return response;
    } catch (error) {
      // A failed await must not disclose results/errors after owner revocation.
      try { ports.assertCurrent(req); } catch (currentError) { error = currentError; }
      if (error instanceof AsideError) return json({ error: error.message, code: error.code }, error.status);
      return json({ error: "Asides are temporarily unavailable", code: "asides-unavailable" }, 503);
    }
  };
}
