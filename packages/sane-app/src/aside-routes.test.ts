import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { ASIDE_EXECUTION_AVAILABILITY } from "../shared/aside-contract";
import { createAsideRoute, matchesAsideRoute, type AsideRoutePorts } from "./aside-routes";
import { AsideService } from "./aside-service";
import { AsideError } from "./aside-store";
import { createRequest, ids, sourceFixture, storeFixture } from "./aside-fixtures";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const collection = `/api/sessions/${ids.session}/asides`;
function routeFixture() {
  const { store, failures } = storeFixture(directories);
  let current = true, checks = 0;
  const calls: string[] = [];
  const assertOwner = () => { if (!current) throw new AsideError(401, "owner-revoked"); };
  const service = new AsideService(store, {
    authorizeRead: sessionId => {
      if (sessionId !== ids.session) throw new AsideError(404, "source-missing");
      return assertOwner;
    },
    resolve: async () => { await Promise.resolve(); assertOwner(); return { source: sourceFixture(), assertCurrent: assertOwner }; },
  });
  // The bridge authenticates before handing off. This fixture exercises the
  // route's authenticated-current port and actual service/store commit guards.
  const ports: AsideRoutePorts = {
    assertCurrent: req => {
      checks++;
      if (req.headers.get("authorization") !== "Bearer aside-test") throw new AsideError(401, "unauthorized");
      assertOwner();
    },
    create: async (id, input) => { calls.push("create"); return service.create(id, input); },
    list: async id => { calls.push("list"); return service.list(id); },
    get: async id => { calls.push("get"); return service.get(id); },
    saveDraft: async (id, input) => { calls.push("draft"); return service.saveDraft(id, input); },
    setLifecycle: async (id, input) => { calls.push("lifecycle"); return service.setLifecycle(id, input); },
  };
  const handler = createAsideRoute(ports);
  const request = (path: string, method = "GET", input?: unknown, headers: Record<string, string> = {}) => {
    const req = new Request(`http://localhost${path}`, { method, headers: { authorization: "Bearer aside-test", ...headers },
      ...(input === undefined ? {} : { body: typeof input === "string" ? input : JSON.stringify(input) }) });
    return handler(req, new URL(req.url));
  };
  return { store, failures, calls, ports, handler, request, service,
    revoke: () => { current = false; }, checks: () => checks };
}
async function response(value: Promise<Response | null>) {
  const result = await value;
  expect(result).not.toBeNull();
  return result!;
}

describe("authenticated aside foundation routes", () => {
  test("collection/create/get/draft/lifecycle CRUD uses durable records and advertises execution unavailable", async () => {
    const h = routeFixture();
    const empty = await response(h.request(collection));
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ asides: [], execution: ASIDE_EXECUTION_AVAILABILITY });
    const created = await response(h.request(collection, "POST", createRequest()));
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const { aside, execution } = await created.json();
    expect(execution).toEqual({ available: false, code: "aside-context-unconfigured" });
    expect(aside).toMatchObject({ lifecycle: "open", revision: 1, draft: createRequest().draft, source: sourceFixture() });
    const path = `/api/asides/${aside.id}`;
    expect(await (await response(h.request(path))).json()).toEqual({ aside, execution });
    const edited = await response(h.request(`${path}/draft`, "POST", { requestId: "edit", expectedRevision: 1, text: "New draft" }));
    expect(edited.status).toBe(200);
    expect((await edited.json()).aside).toMatchObject({ id: aside.id, draft: "New draft", revision: 2, source: aside.source });
    const archived = await response(h.request(`${path}/lifecycle`, "POST", { requestId: "archive", expectedRevision: 2, lifecycle: "archived" }));
    expect(archived.status).toBe(200);
    expect((await archived.json()).aside).toMatchObject({ lifecycle: "archived", revision: 3 });
    const listed = await (await response(h.request(collection))).json();
    expect(listed.asides).toHaveLength(1);
    expect(listed.asides[0]).toMatchObject({ id: aside.id, lifecycle: "archived", sourceSessionId: ids.session });
    expect(listed.asides[0].source).toBeUndefined();
    expect(listed.asides[0].draft).toBeUndefined();
    expect(h.calls).toEqual(["list", "create", "get", "draft", "lifecycle", "list"]);
    expect(h.failures).toEqual([]);
  });

  test("original create response replays through POST after edits rather than returning today's revision", async () => {
    const h = routeFixture(), request = createRequest();
    const initial = await (await response(h.request(collection, "POST", request))).json();
    h.service.saveDraft(initial.aside.id, { requestId: "edit", expectedRevision: 1, text: "later" });
    const replay = await response(h.request(collection, "POST", request));
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(initial);
  });

  test("authentication/current checks precede body parsing, selectors and unsupported methods", async () => {
    const h = routeFixture();
    for (const [path, method, input] of [[collection, "POST", "{bad"], [collection, "DELETE", undefined], ["/api/asides/not-a-uuid", "GET", undefined]] as const) {
      const result = await response(h.request(path, method, input, { authorization: "Bearer wrong" }));
      expect(result.status).toBe(401);
      expect((await result.json()).code).toBe("unauthorized");
    }
    expect(h.calls).toEqual([]);
    expect(h.store.summaries()).toEqual([]);
  });

  test("method restrictions preserve Allow and never invoke data operations", async () => {
    const h = routeFixture();
    for (const [path, method, allow] of [[collection, "DELETE", "GET, POST"], [`/api/asides/${ids.other}`, "POST", "GET"],
      [`/api/asides/${ids.other}/draft`, "GET", "POST"], [`/api/asides/${ids.other}/lifecycle`, "PATCH", "POST"]]) {
      const result = await response(h.request(path!, method));
      expect(result.status).toBe(405);
      expect(result.headers.get("allow")).toBe(allow!);
      expect((await result.json()).code).toBe("aside-method-not-allowed");
    }
    expect(h.calls).toEqual([]);
  });

  test("invalid encoded identifiers, malformed JSON, query selectors and missing bodies are 400", async () => {
    const h = routeFixture();
    for (const [path, method, input] of [["/api/asides/%ZZ", "GET", undefined], ["/api/asides/not-a-uuid", "GET", undefined],
      [collection + "?limit=1", "GET", undefined], [collection, "POST", "{bad-json"], [collection, "POST", undefined]] as const) {
      const result = await response(h.request(path, method, input));
      expect(result.status).toBe(400);
      expect((await result.json()).code).toBe("aside-input");
    }
    expect(h.calls).toEqual([]);
  });

  test("strict service input rejects JSON primitives and client-owned source/execution fields without creating records", async () => {
    const h = routeFixture();
    for (const input of ["null", "[]", "true", { ...createRequest(), source: sourceFixture() }, { ...createRequest(), execution: { available: true } }]) {
      const result = await response(h.request(collection, "POST", input));
      expect(result.status).toBe(400);
      expect((await result.json()).code).toBe("aside-input");
    }
    expect(h.store.summaries()).toEqual([]);
  });

  test("both advertised and streamed 1 MiB body limits return 413 before service calls", async () => {
    const h = routeFixture();
    const advertised = await response(h.request(collection, "POST", "{}", { "content-length": String(1024 * 1024 + 1) }));
    expect(advertised.status).toBe(413);
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); }, cancel() { cancelled = true; } });
    const req = new Request(`http://localhost${collection}`, { method: "POST", headers: { authorization: "Bearer aside-test" }, body: stream });
    const streamed = await response(h.handler(req, new URL(req.url)));
    expect(streamed.status).toBe(413);
    expect((await streamed.json()).code).toBe("aside-input");
    expect(cancelled).toBe(true);
    expect(h.calls).toEqual([]);
  });

  test("revision and changed-intent conflicts are 409; missing records are 404", async () => {
    const h = routeFixture(), created = await h.service.create(ids.session, createRequest()), path = `/api/asides/${created.id}`;
    const stale = await response(h.request(`${path}/draft`, "POST", { requestId: "edit", expectedRevision: 2, text: "wrong" }));
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("aside-conflict");
    const reuse = await response(h.request(collection, "POST", { ...createRequest(), draft: "different" }));
    expect(reuse.status).toBe(409);
    expect(h.store.get(created.id)).toEqual(created);
    const missing = await response(h.request(`/api/asides/${ids.other}`));
    expect(missing.status).toBe(404);
  });

  test("revocation while reading an async body prevents service entry and record commit", async () => {
    const h = routeFixture();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const req = new Request(`http://localhost${collection}`, { method: "POST", headers: { authorization: "Bearer aside-test" }, body: stream });
    const pending = h.handler(req, new URL(req.url));
    expect(h.checks()).toBe(1);
    h.revoke(); controller.enqueue(new TextEncoder().encode(JSON.stringify(createRequest()))); controller.close();
    const result = await response(pending);
    expect(result.status).toBe(401);
    expect((await result.json()).code).toBe("owner-revoked");
    expect(h.calls).toEqual([]);
    expect(h.store.summaries()).toEqual([]);
  });

  for (const operation of ["list", "get", "create", "saveDraft", "setLifecycle"] as const) {
    test(`${operation} rechecks authenticated owner after an async operation before exposing its result`, async () => {
      const h = routeFixture(), created = await h.service.create(ids.session, createRequest());
      const revokeAndReturn = async () => { await Promise.resolve(); h.revoke(); return created; };
      if (operation === "list") h.ports.list = async () => { await revokeAndReturn(); return []; };
      else h.ports[operation] = revokeAndReturn;
      const path = operation === "list" || operation === "create" ? collection
        : `/api/asides/${created.id}${operation === "saveDraft" ? "/draft" : operation === "setLifecycle" ? "/lifecycle" : ""}`;
      const method = operation === "list" || operation === "get" ? "GET" : "POST";
      const result = await response(h.request(path, method, method === "POST" ? {} : undefined));
      expect(result.status).toBe(401);
      expect(await result.json()).toMatchObject({ code: "owner-revoked" });
    });
  }

  test("failed asynchronous operations do not disclose stale errors after owner revocation", async () => {
    const h = routeFixture();
    h.ports.create = async () => { await Promise.resolve(); h.revoke(); throw new AsideError(409, "private-conflict", "private stale result"); };
    const result = await response(h.request(collection, "POST", createRequest()));
    expect(result.status).toBe(401);
    expect(await result.json()).toEqual({ error: "owner-revoked", code: "owner-revoked" });
  });

  test("unexpected failures return a bounded 503 without leaking internals; unrelated paths fall through", async () => {
    const h = routeFixture(); h.ports.list = async () => { throw new Error("private storage path"); };
    const result = await response(h.request(collection));
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: "Asides are temporarily unavailable", code: "asides-unavailable" });
    for (const path of ["/api/sessions", `${collection}/extra`, `/api/asides/${ids.other}/unknown-action`]) {
      expect(matchesAsideRoute(new URL(`http://localhost${path}`))).toBe(false);
      expect(await h.request(path)).toBeNull();
    }
    expect(matchesAsideRoute(new URL(`http://localhost${collection}`))).toBe(true);
  });
});
