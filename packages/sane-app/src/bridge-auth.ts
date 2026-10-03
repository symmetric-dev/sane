import { body, equal, json, loopback } from "./bridge-http";

export type BridgeAuthOptions = { host: string; allowRemote: boolean; publicOrigin?: string; password?: string };
export type BridgeAuthDependencies = {
  getOrigin: () => string;
  revokeTerminal: (token: string) => void;
  createToken?: () => string;
};
export type BridgeAuthServer = { port: number | undefined; requestIP: (req: Request) => { address: string } | null };

/** Call at the existing startup validation point, before creating services. */
export function validateBridgeAuthOptions(options: BridgeAuthOptions): void {
  const remote = !loopback(options.host), password = options.password;
  if (options.publicOrigin && !loopback(new URL(options.publicOrigin).hostname) && !password) throw new Error("A non-loopback public origin requires SANE_APP_PASSWORD");
  if (remote && (!options.allowRemote || !password || !options.publicOrigin)) throw new Error("Remote host requires --allow-remote, SANE_APP_PASSWORD and --public-origin https://...");
  if (options.publicOrigin) { const u = new URL(options.publicOrigin); if ((u.protocol !== "https:" && !(u.protocol === "http:" && loopback(u.hostname) && !remote)) || u.origin !== options.publicOrigin || u.username || u.password) throw new Error("public-origin must be an exact HTTPS origin (or HTTP loopback origin for a local SSH forward)"); }
}

/** Browser sessions only. Native handoff bearer and Claude hook secrets stay
 * outside this boundary and must be routed before browserBoundary. */
export class BridgeAuth {
  private cookies = new Set<string>();
  private localTerminalToken: string;
  private readonly remote: boolean;
  private readonly createToken: () => string;

  constructor(private options: BridgeAuthOptions, private dependencies: BridgeAuthDependencies) {
    this.remote = !loopback(options.host);
    this.createToken = dependencies.createToken ?? (() => crypto.randomUUID());
    this.localTerminalToken = this.createToken();
  }

  get authRequired(): boolean { return !!this.options.password; }

  authenticated(req: Request): boolean {
    return !this.options.password || (req.headers.get("cookie") ?? "").split(";").some(s => { const [k, v] = s.trim().split("="); return k === "sane_app" && !!v && this.cookies.has(v); });
  }

  terminalToken(req: Request): string | undefined {
    for (const item of (req.headers.get("cookie") ?? "").split(";")) { const [key, value] = item.trim().split("="); if (key === "sane_app" && value && this.cookies.has(value)) return value; }
    return this.options.password ? undefined : this.localTerminalToken;
  }

  validTerminalToken(token: string): boolean {
    return this.cookies.has(token) || !this.options.password && token === this.localTerminalToken;
  }

  /** Host precedes Origin. Return the accepted origin snapshot for login's
   * cookie attributes, even if a live origin changes while its body is read. */
  browserBoundary(req: Request, srv: BridgeAuthServer): URL | Response {
    const origin = this.dependencies.getOrigin(), expected = new URL(origin);
    // Only this same-machine listener's concrete authorities may substitute
    // for the public Host. Forwarded headers are deliberately never consulted.
    const host = req.headers.get("host");
    const loopbackProxy = !!this.options.publicOrigin && !this.remote && loopback(srv.requestIP(req)?.address ?? "") &&
      [`localhost:${srv.port}`, `127.0.0.1:${srv.port}`, `[::1]:${srv.port}`].includes(host ?? "");
    if (host !== expected.host && !loopbackProxy) return json({ error: "Host rejected" }, 403);
    if (!["GET", "HEAD"].includes(req.method) && req.headers.get("origin") !== origin) return json({ error: "Origin rejected" }, 403);
    return expected;
  }

  /** Route only POST /api/login, after browserBoundary and the config route. */
  async login(req: Request, expected: URL): Promise<Response> {
    const input = await body(req);
    if (this.options.password && (typeof input.password !== "string" || !equal(input.password, this.options.password))) return json({ error: "Invalid password" }, 401);
    const token = this.createToken(); this.cookies.add(token);
    return json({ authenticated: true }, 200, { "set-cookie": `sane_app=${token}; HttpOnly; SameSite=Strict; Path=/${expected.protocol === "https:" ? "; Secure" : ""}` });
  }

  /** Logout is reachable without an authenticated cookie. Revoke every
   * matching occurrence, including unknown and duplicate token values. */
  logout(req: Request): Response {
    for (const s of (req.headers.get("cookie") ?? "").split(";")) { const [k, v] = s.trim().split("="); if (k === "sane_app" && v) { this.cookies.delete(v); this.dependencies.revokeTerminal(v); } }
    if (!this.options.password) { const old = this.localTerminalToken; this.localTerminalToken = this.createToken(); this.dependencies.revokeTerminal(old); }
    return json({ authenticated: false }, 200, { "set-cookie": "sane_app=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
  }
}
