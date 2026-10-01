import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { TerminalState } from "../src/terminal-contract";
import type { TerminalPresentation } from "./terminal-client";
import { workspaceEpoch } from "./workspace-store";

const selection = { workspaceId: "workspace", worktreeId: "tree", bindingRevision: "binding", root: "/fixture" };
const state = (patch: Partial<TerminalState> = {}): TerminalState => ({
  ...selection, capability: { available: true }, terminalId: null, status: "absent",
  cols: 80, rows: 24, generation: 0, controllerId: null, exitCode: null, ptyClosed: false, ...patch,
});
const running = () => state({ status: "running", terminalId: "terminal" });
type RequestRecord = { method: string; url: string; body?: unknown; signal?: AbortSignal | null };
type Probe = { load(startMissing?: boolean): Promise<void>; presentation: TerminalPresentation; disposed: boolean; auth: number };

/** Exercise the real lifecycle/request methods without creating a browser emulator or PTY. */
async function withSession(respond: (request: RequestRecord) => Promise<Response>, run: (fixture: {
  session: Probe; requests: RequestRecord[]; attached: () => number; deselect: () => void;
}) => Promise<void>) {
  const browser = new Window();
  const requests: RequestRecord[] = [];
  const globals = { self: browser, fetch: async (url: string | URL | Request, init?: RequestInit) => {
    const request = { url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined, signal: init?.signal };
    requests.push(request); return respond(request);
  } };
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  try {
    const { TerminalSession, emptyTerminal } = await import("./terminal-client");
    let selected = true, attachments = 0;
    const session = Object.assign(Object.create(TerminalSession.prototype), {
      selection, auth: workspaceEpoch(), disposed: false, selected: () => selected,
      abort: new AbortController(), base: "/api/workspaces/workspace/worktrees/tree/terminal",
      presentation: emptyTerminal(), terminal: { options: {} }, publish: () => {},
      attachment: "", released: false, attach: () => { attachments++; },
    }) as Probe;
    await run({ session, requests, attached: () => attachments, deselect: () => { selected = false; } });
  } finally {
    await browser.happyDOM.close();
    for (const [key, descriptor] of prior) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}

test("opening Terminal starts an absent shell once, then attaches as a viewer", async () => {
  await withSession(async request => Response.json(request.method === "GET" ? state() : running()), async ({ session, requests, attached }) => {
    await session.load(true);
    expect(requests.map(request => request.method)).toEqual(["GET", "POST"]);
    expect(requests[1]!.url).toBe("/api/workspaces/workspace/worktrees/tree/terminal");
    expect(requests[1]!.body).toEqual({ bindingRevision: "binding", cols: 80, rows: 24 });
    expect(requests[1]!.signal).toBeInstanceOf(AbortSignal);
    expect(attached()).toBe(1); expect(session.presentation.state?.status).toBe("running");
    expect(session.presentation.busy).toBe(false); expect(session.presentation.controlling).toBe(false);
    expect(session.presentation.error).toBe("");
    // Reconnection and page resume use the read-only form of load, even if absent.
    await session.load(); expect(requests.map(request => request.method)).toEqual(["GET", "POST", "GET"]);
  });
});

for (const status of ["running", "exited", "closed", "overloaded"] as const) test(`opening Terminal preserves a retained ${status} session`, async () => {
  await withSession(async () => Response.json(state({ status, terminalId: "existing" })), async ({ session, requests, attached }) => {
    await session.load(true);
    expect(requests.map(request => request.method)).toEqual(["GET"]);
    expect(attached()).toBe(status === "closed" ? 0 : 1);
    expect(session.presentation.state?.terminalId).toBe("existing");
  });
});

test("unsupported terminal capability never starts a shell", async () => {
  await withSession(async () => Response.json(state({ capability: { available: false, reason: "Unavailable" } })), async ({ session, requests, attached }) => {
    await session.load(true); expect(requests.map(request => request.method)).toEqual(["GET"]);
    expect(attached()).toBe(0); expect(session.presentation.state?.capability.available).toBe(false);
  });
});

test("an initial lookup failure or mismatched binding never starts a shell", async () => {
  for (const response of [Response.json({ error: "Lookup failed" }, { status: 503 }), Response.json(state({ bindingRevision: "new-binding" }))]) {
    await withSession(async () => response, async ({ session, requests, attached }) => {
      await session.load(true); expect(requests.map(request => request.method)).toEqual(["GET"]);
      expect(attached()).toBe(0); expect(session.presentation.error).not.toBe(""); expect(session.presentation.busy).toBe(false);
    });
  }
});

test("navigation, disposal, and auth changes during lookup fence automatic startup", async () => {
  for (const invalidate of [(session: Probe, deselect: () => void) => deselect(), (session: Probe) => { session.disposed = true; }, (session: Probe) => { session.auth--; }]) {
    const pending = Promise.withResolvers<Response>();
    await withSession(async () => pending.promise, async ({ session, requests, attached, deselect }) => {
      const loading = session.load(true); invalidate(session, deselect); pending.resolve(Response.json(state())); await loading;
      expect(requests.map(request => request.method)).toEqual(["GET"]); expect(attached()).toBe(0);
    });
  }
});

test("leaving during startup ignores a late response and never attaches", async () => {
  const pending = Promise.withResolvers<Response>(), started = Promise.withResolvers<void>();
  await withSession(async request => {
    if (request.method === "GET") return Response.json(state());
    started.resolve(); return pending.promise;
  }, async ({ session, deselect, attached }) => {
    const loading = session.load(true); await started.promise; deselect();
    pending.resolve(Response.json(running())); await loading;
    expect(attached()).toBe(0); expect(session.presentation.state?.status).toBe("absent");
  });
});

test("startup failures remain visible and are not automatically retried", async () => {
  await withSession(async request => request.method === "GET" ? Response.json(state()) : Response.json({ error: "Terminal limit reached", code: "terminal-limit" }, { status: 429 }), async ({ session, requests, attached }) => {
    await session.load(true); expect(session.presentation.error).toBe("Terminal limit reached");
    expect(session.presentation.busy).toBe(false); expect(attached()).toBe(0);
    await session.load(); expect(requests.map(request => request.method)).toEqual(["GET", "POST", "GET"]);
  });
});

test("a concurrent creation attaches to the existing shell rather than restarting it", async () => {
  let reads = 0;
  await withSession(async request => request.method === "GET" ? Response.json(++reads === 1 ? state() : running()) : Response.json({ error: "Terminal exists", code: "terminal-exists" }, { status: 409 }), async ({ session, requests, attached }) => {
    await session.load(true); expect(requests.map(request => request.method)).toEqual(["GET", "POST", "GET"]);
    expect(attached()).toBe(1); expect(session.presentation.error).toBe(""); expect(session.presentation.state?.terminalId).toBe("terminal");
  });
});
