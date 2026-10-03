import { expect, test } from "bun:test";
import { BridgeAuth, validateBridgeAuthOptions, type BridgeAuthOptions } from "./bridge-auth";
import { json } from "./bridge-http";

function fixture(overrides: Partial<BridgeAuthOptions> = {}) {
  let origin = "https://app.example", issued = 0;
  const revoked: string[] = [];
  const options: BridgeAuthOptions = { host: "127.0.0.1", allowRemote: false, publicOrigin: origin, password: "secret", ...overrides };
  const auth = new BridgeAuth(options, { getOrigin: () => origin, revokeTerminal: token => revoked.push(token), createToken: () => `token-${++issued}` });
  const server = (address: string | null = "127.0.0.1", port = 8123) => ({ port, requestIP: () => address === null ? null : { address } });
  const request = (method = "GET", headers: Record<string, string> = {}, data?: string, path = "/api/private") => new Request(`http://ignored.example${path}`, { method, headers: { host: new URL(origin).host, ...headers }, ...(data === undefined ? {} : { body: data }) });
  const login = async (...args: [] | [unknown]) => {
    const password = args.length ? args[0] : "secret";
    const req = request("POST", { origin }, JSON.stringify({ password }), "/api/login");
    const accepted = auth.browserBoundary(req, server());
    if (accepted instanceof Response) throw new Error("Fixture boundary rejected");
    return auth.login(req, accepted);
  };
  return { auth, server, request, login, revoked, setOrigin: (next: string) => { origin = next; }, issued: () => issued };
}

test("startup validation preserves rejection order and exact messages", () => {
  const options = { host: "0.0.0.0", allowRemote: false, publicOrigin: "http://app.example" };
  expect(() => validateBridgeAuthOptions(options)).toThrow("A non-loopback public origin requires SANE_APP_PASSWORD");
  expect(() => validateBridgeAuthOptions({ ...options, password: "secret" })).toThrow("Remote host requires --allow-remote, SANE_APP_PASSWORD and --public-origin https://...");
  expect(() => validateBridgeAuthOptions({ ...options, password: "secret", allowRemote: true })).toThrow("public-origin must be an exact HTTPS origin (or HTTP loopback origin for a local SSH forward)");
  expect(() => validateBridgeAuthOptions({ host: "127.0.0.1", allowRemote: false, publicOrigin: "http://localhost:8123" })).not.toThrow();
  expect(() => validateBridgeAuthOptions({ host: "0.0.0.0", allowRemote: true, password: "secret", publicOrigin: "https://app.example" })).not.toThrow();
  for (const publicOrigin of ["https://app.example/", "https://name:secret@app.example", "https://app.example/path", "http://app.example", "https://APP.example", "https://app.example:443"]) {
    expect(() => validateBridgeAuthOptions({ host: "localhost", allowRemote: false, password: "secret", publicOrigin })).toThrow("public-origin must be an exact HTTPS origin (or HTTP loopback origin for a local SSH forward)");
  }
});

test("browser boundary rejects Host before Origin, auth and login body parsing", async () => {
  const f = fixture();
  // The route order expected from the integrating bridge, without any listener.
  const route = async (req: Request) => {
    const accepted = f.auth.browserBoundary(req, f.server());
    if (accepted instanceof Response) return accepted;
    const path = new URL(req.url).pathname;
    if (path === "/api/login" && req.method === "POST") return f.auth.login(req, accepted);
    if (path === "/api/logout" && req.method === "POST") return f.auth.logout(req);
    return f.auth.authenticated(req) ? json({ ok: true }) : json({ error: "Authentication required" }, 401);
  };
  const hostRejected = f.request("POST", { host: "evil.example", origin: "https://evil.example" }, "not JSON", "/api/login");
  const a = await route(hostRejected);
  expect(a.status).toBe(403); expect(await a.json()).toEqual({ error: "Host rejected" }); expect(hostRejected.bodyUsed).toBe(false);
  const originRejected = f.request("POST", {}, "not JSON", "/api/login");
  const b = await route(originRejected);
  expect(b.status).toBe(403); expect(await b.json()).toEqual({ error: "Origin rejected" }); expect(originRejected.bodyUsed).toBe(false);
  const c = await route(f.request("POST", { origin: "https://app.example" }, "not JSON"));
  expect(c.status).toBe(401); expect(await c.json()).toEqual({ error: "Authentication required" });
  expect((await route(f.request("POST", { origin: "https://app.example" }, '{"password":"wrong"}', "/api/login"))).status).toBe(401);
  expect((await route(f.request("POST", { origin: "https://app.example" }, undefined, "/api/logout"))).status).toBe(200);
  expect(f.issued()).toBe(1);
});

test("only GET and HEAD skip Origin checking, including terminal GET upgrades", async () => {
  const f = fixture();
  const headerVariants: Record<string, string>[] = [{}, { origin: "https://evil.example", upgrade: "websocket" }];
  for (const method of ["GET", "HEAD"]) {
    for (const headers of headerVariants) expect(f.auth.browserBoundary(f.request(method, headers), f.server())).toBeInstanceOf(URL);
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    for (const origin of [undefined, "null", "https://evil.example", "https://app.example/"]) {
      const result = f.auth.browserBoundary(f.request(method, origin === undefined ? {} : { origin }), f.server());
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(403); expect(await (result as Response).json()).toEqual({ error: "Origin rejected" });
    }
    expect(f.auth.browserBoundary(f.request(method, { origin: "https://app.example" }), f.server())).toBeInstanceOf(URL);
  }
});

test("same-machine public proxy allowlist is limited to exact listener authorities", () => {
  const f = fixture();
  for (const host of ["localhost:8123", "127.0.0.1:8123", "[::1]:8123"]) {
    for (const address of ["127.0.0.1", "::1", "localhost", "[::1]", "::ffff:127.0.0.1"]) expect(f.auth.browserBoundary(f.request("GET", { host }), f.server(address))).toBeInstanceOf(URL);
    for (const address of [null, "192.0.2.1", "127.0.0.2"]) expect(f.auth.browserBoundary(f.request("GET", { host }), f.server(address))).toBeInstanceOf(Response);
    expect(fixture({ host: "0.0.0.0" }).auth.browserBoundary(f.request("GET", { host }), f.server())).toBeInstanceOf(Response);
    expect(fixture({ publicOrigin: undefined }).auth.browserBoundary(f.request("GET", { host }), f.server())).toBeInstanceOf(Response);
  }
  for (const host of ["localhost", "127.0.0.1:8124", "[::ffff:127.0.0.1]:8123", "LOCALHOST:8123", "127.0.0.2:8123", "app.example:443", "evil.example"]) expect(f.auth.browserBoundary(f.request("GET", { host }), f.server())).toBeInstanceOf(Response);
  expect(f.auth.browserBoundary(new Request("https://app.example"), f.server())).toBeInstanceOf(Response);
  expect(f.auth.browserBoundary(f.request(), f.server("192.0.2.1"))).toBeInstanceOf(URL);
});

test("Forwarded and X-Forwarded headers never authorize Host, peer or Origin", async () => {
  const f = fixture();
  const forwarded = { forwarded: 'for=127.0.0.1;host=app.example;proto=https', "x-forwarded-for": "127.0.0.1", "x-forwarded-host": "app.example", "x-forwarded-proto": "https", "x-forwarded-origin": "https://app.example" };
  expect(f.auth.browserBoundary(f.request("GET", { ...forwarded, host: "evil.example" }), f.server())).toBeInstanceOf(Response);
  expect(f.auth.browserBoundary(f.request("GET", { ...forwarded, host: "127.0.0.1:8123" }), f.server("192.0.2.1"))).toBeInstanceOf(Response);
  const result = f.auth.browserBoundary(f.request("POST", forwarded), f.server()) as Response;
  expect(await result.json()).toEqual({ error: "Origin rejected" });
  expect(f.auth.browserBoundary(f.request("POST", { ...forwarded, origin: "https://app.example" }), f.server())).toBeInstanceOf(URL);
});

test("live origin controls boundary and accepted snapshot controls secure login cookies", async () => {
  const f = fixture();
  const req = f.request("POST", { origin: "https://app.example" }, '{"password":"secret"}', "/api/login");
  const accepted = f.auth.browserBoundary(req, f.server()) as URL;
  f.setOrigin("http://localhost:9000");
  const result = await f.auth.login(req, accepted);
  expect(result.headers.get("set-cookie")).toBe("sane_app=token-2; HttpOnly; SameSite=Strict; Path=/; Secure");
  expect(f.auth.browserBoundary(f.request(), f.server(null, 9000))).toBeInstanceOf(URL);
  expect(f.auth.browserBoundary(req, f.server())).toBeInstanceOf(Response);
  expect((await f.login()).headers.get("set-cookie")).toBe("sane_app=token-3; HttpOnly; SameSite=Strict; Path=/");
});

test("login preserves password type checks, parse errors, status and no-store", async () => {
  const f = fixture();
  expect(f.auth.authRequired).toBe(true); expect(f.auth.authenticated(f.request())).toBe(false);
  expect(f.auth.validTerminalToken("token-1")).toBe(false);
  for (const password of ["wrong", "secret ", 12, null, {}, undefined]) {
    const result = await f.login(password);
    expect(result.status).toBe(401); expect(await result.json()).toEqual({ error: "Invalid password" });
    expect(result.headers.get("cache-control")).toBe("no-store"); expect(result.headers.has("set-cookie")).toBe(false);
  }
  expect(f.issued()).toBe(1);
  await expect(f.auth.login(f.request("POST", {}, "not JSON"), new URL("https://app.example"))).rejects.toBeInstanceOf(SyntaxError);
  await expect(f.auth.login(f.request("POST", {}, "null"), new URL("https://app.example"))).rejects.toBeInstanceOf(TypeError);
  const result = await f.login();
  expect(result.status).toBe(200); expect(await result.json()).toEqual({ authenticated: true });
  expect(result.headers.get("cache-control")).toBe("no-store");
  // Native bearer credentials and hook secrets never become browser sessions.
  expect(f.auth.authenticated(f.request("GET", { authorization: "Bearer token-2", "x-cc-web-secret": "token-2" }))).toBe(false);
});

test("malformed and duplicate cookies retain literal splitting and first valid terminal token", async () => {
  const f = fixture(); await f.login(); await f.login();
  for (const cookie of ["sane_app=token-2", "  sane_app=token-2  ", "sane_app=invalid; sane_app=token-2", "sane_app; sane_app=; sane_app=token-2=trailing", "other=token-2; sane_app=token-2; sane_app=token-3"]) {
    const req = f.request("GET", { cookie });
    expect(f.auth.authenticated(req)).toBe(true); expect(f.auth.terminalToken(req)).toBe("token-2");
  }
  expect(f.auth.terminalToken(f.request("GET", { cookie: "sane_app=token-3; sane_app=token-2" }))).toBe("token-3");
  for (const cookie of ["sane_app", "sane_app=", "SANE_APP=token-2", "sane_app =token-2", "sane_app= token-2", "sane_app=%74oken-2", "sane_app=\"token-2\"", "other=token-2"]) {
    const req = f.request("GET", { cookie }); expect(f.auth.authenticated(req)).toBe(false); expect(f.auth.terminalToken(req)).toBeUndefined();
  }
});

test("logout revokes every literal matching occurrence and only those sessions", async () => {
  const f = fixture(); await f.login(); await f.login();
  const response = f.auth.logout(f.request("POST", { cookie: "sane_app=token-2=ignored; sane_app=unknown; sane_app=token-2; sane_app=; other=token-3; SANE_APP=token-3" }));
  expect(f.revoked).toEqual(["token-2", "unknown", "token-2"]);
  expect(f.auth.validTerminalToken("token-2")).toBe(false); expect(f.auth.validTerminalToken("token-3")).toBe(true);
  expect(f.auth.authenticated(f.request("GET", { cookie: "sane_app=token-2" }))).toBe(false);
  expect(f.auth.terminalToken(f.request("GET", { cookie: "sane_app=token-2; sane_app=token-3" }))).toBe("token-3");
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ authenticated: false });
  expect(response.headers.get("set-cookie")).toBe("sane_app=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  expect(response.headers.get("cache-control")).toBe("no-store"); expect(f.issued()).toBe(3);
});

for (const password of [undefined, ""]) test(`no-password fallback and local token rotation (${JSON.stringify(password)})`, async () => {
  const f = fixture({ password });
  expect(f.auth.authRequired).toBe(false); expect(f.auth.authenticated(f.request())).toBe(true);
  expect(f.auth.terminalToken(f.request())).toBe("token-1"); expect(f.auth.validTerminalToken("token-1")).toBe(true);
  await f.login("anything"); await f.login("anything");
  const req = f.request("GET", { cookie: "sane_app=token-2" });
  expect(f.auth.terminalToken(req)).toBe("token-2");
  f.auth.logout(req);
  expect(f.revoked).toEqual(["token-2", "token-1"]);
  expect(f.auth.authenticated(req)).toBe(true); expect(f.auth.terminalToken(req)).toBe("token-4");
  expect(f.auth.validTerminalToken("token-2")).toBe(false); expect(f.auth.validTerminalToken("token-1")).toBe(false);
  expect(f.auth.validTerminalToken("token-3")).toBe(true); expect(f.auth.validTerminalToken("token-4")).toBe(true);
  f.auth.logout(f.request());
  expect(f.revoked).toEqual(["token-2", "token-1", "token-4"]);
  expect(f.auth.validTerminalToken("token-4")).toBe(false); expect(f.auth.terminalToken(f.request())).toBe("token-5");
});
