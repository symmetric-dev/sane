import { expect, test } from "bun:test";
import type { CatalogService } from "../src/catalog";
import { TerminalService, type TerminalSocketData } from "../src/terminal";
import { TERMINAL_LIMITS as L, type TerminalServerMessage, type TerminalState } from "../src/terminal-contract";

type Attachment = TerminalSocketData["attachment"];
type Resource = Attachment["resource"];
type Delta = Extract<TerminalServerMessage, { type: "output" | "resize" }>;
type Socket = Bun.ServerWebSocket<TerminalSocketData>;
type Probe = {
  resources: Map<string, Resource>;
  delta(resource: Resource, message: Delta): void;
  snapshots(resource: Resource): void;
  output(resource: Resource, bytes: Uint8Array): void;
};
type Connection = { attachment: Attachment; socket: Socket; sent: TerminalServerMessage[]; closed: { code: number; reason: string }[]; result: number; buffered: number; afterSendBuffered?: number; throws: boolean };

/** Real service/attachment handlers, mocked resource and socket; never spawn a shell.
 * A deterministic clock also proves deadlines and timer cleanup without sleeps. */
async function fixture(run: (f: {
  service: TerminalService; probe: Probe; resource: Resource;
  attach(): Promise<Connection>; ack(c: Connection, seq: unknown): void;
  delta(data?: string): void; resize(): void; advance(ms: number): void;
  timers: Map<object, { at: number; callback: () => void }>; authorize(value: boolean): void;
}) => Promise<void> | void) {
  let now = 0, authorized = true;
  const timers = new Map<object, { at: number; callback: () => void }>();
  const originalTimeout = globalThis.setTimeout, originalClear = globalThis.clearTimeout, originalNow = Date.now;
  globalThis.setTimeout = ((callback: () => void, ms: number) => {
    const timer = { unref() { return this; } };
    timers.set(timer, { at: now + ms, callback }); return timer;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((timer: object) => { timers.delete(timer); }) as unknown as typeof clearTimeout;
  Date.now = () => now;
  const state: TerminalState = { capability: { available: true }, workspaceId: "workspace", worktreeId: "tree", bindingRevision: "binding", terminalId: "terminal", status: "running", cols: 80, rows: 24, generation: 0, controllerId: null, exitCode: null, ptyClosed: false };
  const service = new TerminalService({ binding: async () => ({ cwd: "/fixture", bindingRevision: "binding" }) } as unknown as CatalogService, () => authorized);
  const probe = service as unknown as Probe;
  const resource: Resource = {
    bindingLease: { binding: { cwd: "/fixture", bindingRevision: "binding", protectedPaths: [] }, mode: "metadata", validate: async () => {} },
    state, cwd: "/fixture", screen: { write: (_bytes: Uint8Array, done: () => void) => done(), resize() {}, dispose() {} } as unknown as Resource["screen"],
    serializer: { serialize: () => "snapshot" } as Resource["serializer"],
    pty: { write() {}, resize() {}, close() {} } as unknown as Bun.Terminal,
    processExited: true, seq: 0, ring: [], ringBytes: 0, tail: Promise.resolve(), queuedBytes: 0, queuedTasks: 0, disposed: false,
    boundary: { safe: true, feed() {} } as unknown as Resource["boundary"], attachments: new Set(), inputBudget: 0, screenBudget: 0, partialBytes: 0, lastOutputAt: 0,
  };
  probe.resources.set("workspace/tree", resource);
  const attach = async () => {
    const data = await service.prepare("workspace", "tree", "token");
    const c: Connection = { attachment: data.attachment, socket: undefined as unknown as Socket, sent: [], closed: [], result: 1, buffered: 0, throws: false };
    c.socket = {
      data, send(raw: string) { if (c.throws) throw new Error("send failed"); if (c.result !== 0) c.sent.push(JSON.parse(raw)); if (c.afterSendBuffered !== undefined) c.buffered = c.afterSendBuffered; return c.result; },
      getBufferedAmount: () => c.buffered, close: (code: number, reason: string) => { c.closed.push({ code, reason }); },
    } as unknown as Socket;
    service.websocket.open!(c.socket); await resource.tail;
    return c;
  };
  const delta = (data = "eA==") => probe.delta(resource, { type: "output", seq: ++resource.seq, data });
  try {
    await run({ service, probe, resource, attach, delta,
      resize: () => probe.delta(resource, { type: "resize", seq: ++resource.seq, cols: 100, rows: 30 }),
      ack: (c, seq) => { service.websocket.message!(c.socket, JSON.stringify({ type: "ack", seq })); },
      timers, authorize: value => { authorized = value; },
      advance(ms) {
        const end = now + ms;
        for (;;) {
          const next = [...timers].filter(([, entry]) => entry.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
          if (!next) break;
          now = next[1].at; timers.delete(next[0]); next[1].callback();
        }
        now = end;
      },
    });
  } finally {
    await service.close();
    globalThis.setTimeout = originalTimeout; globalThis.clearTimeout = originalClear; Date.now = originalNow;
  }
}

const screenFrames = (c: Connection) => c.sent.filter((m): m is Extract<TerminalServerMessage, { seq: number }> => "seq" in m);
const outputs = (c: Connection) => c.sent.filter(m => m.type === "output");

test("snapshot ACK gates an immediate multi-frame window, including ordered resize", async () => {
  await fixture(async ({ attach, ack, delta, resize }) => {
    const c = await attach();
    expect(c.sent.map(m => m.type)).toEqual(["hello", "snapshot"]);
    delta(); resize(); delta();
    expect(screenFrames(c).map(m => m.seq)).toEqual([0]);
    ack(c, 0);
    expect(screenFrames(c).map(m => [m.type, m.seq])).toEqual([["snapshot", 0], ["output", 1], ["resize", 2], ["output", 3]]);
    expect(c.attachment.pending.map(m => m.seq)).toEqual([1, 2, 3]);
    ack(c, 1); ack(c, 2); ack(c, 3);
    expect(c.attachment.pendingBytes).toBe(0); expect(c.closed).toEqual([]);
  });
});

test("frame cap bounds tiny-output retention and each ACK refills one slot", async () => {
  await fixture(async ({ attach, ack, delta }) => {
    const c = await attach(); ack(c, 0);
    for (let i = 0; i < L.outputWindowFrames + 3; i++) delta();
    expect(outputs(c)).toHaveLength(L.outputWindowFrames);
    expect(c.attachment.pending).toHaveLength(L.outputWindowFrames);
    expect(c.attachment.pendingBytes).toBeLessThan(L.outputWindowBytes);
    ack(c, 1);
    expect(outputs(c)).toHaveLength(L.outputWindowFrames + 1);
    expect(c.attachment.pending).toHaveLength(L.outputWindowFrames);
    expect(c.attachment.next).toBe(L.outputWindowFrames + 2);
  });
});

test("serialized byte cap bounds full chunks independently of the frame cap and refills", async () => {
  await fixture(async ({ attach, ack, delta }) => {
    const c = await attach(); ack(c, 0);
    const data = Buffer.alloc(L.chunkBytes).toString("base64");
    for (let i = 0; i < L.outputWindowFrames; i++) delta(data);
    const count = outputs(c).length;
    expect(count).toBeGreaterThan(1); expect(count).toBeLessThan(L.outputWindowFrames);
    const bytes = outputs(c).reduce((sum, m) => sum + Buffer.byteLength(JSON.stringify(m)), 0);
    expect(c.attachment.pendingBytes).toBe(bytes); expect(bytes).toBeLessThanOrEqual(L.outputWindowBytes);
    expect(bytes + Buffer.byteLength(JSON.stringify(outputs(c)[0]))).toBeGreaterThan(L.outputWindowBytes);
    ack(c, 1);
    expect(outputs(c)).toHaveLength(count + 1);
    expect(c.attachment.pendingBytes).toBeLessThanOrEqual(L.outputWindowBytes);
  });
});

test("snapshot has its own bounded budget rather than consuming delta-window capacity", async () => {
  await fixture(async ({ resource, attach, ack, delta }) => {
    resource.serializer.serialize = () => "s".repeat(L.outputWindowBytes + 1);
    const c = await attach(); delta();
    expect(c.attachment.pendingBytes).toBeGreaterThan(L.outputWindowBytes);
    expect(outputs(c)).toHaveLength(0);
    ack(c, 0); expect(outputs(c)).toHaveLength(1);
    expect(c.attachment.pendingBytes).toBeLessThan(L.outputWindowBytes);
  });
});

test("reject stale, future, unsent, non-integer, and out-of-order ACKs", async () => {
  for (const seq of [-1, 0, 2, L.outputWindowFrames + 1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
    await fixture(async ({ attach, ack, delta, timers }) => {
      const c = await attach(); ack(c, 0);
      for (let i = 0; i < L.outputWindowFrames + 1; i++) delta();
      ack(c, seq);
      expect(c.closed[0]?.code).toBe(1008); expect(c.attachment.dead).toBe(true);
      expect(c.attachment.pending).toEqual([]); expect(c.attachment.pendingBytes).toBe(0); expect(timers.size).toBe(0);
    });
  }
  await fixture(async ({ attach, ack }) => {
    const c = await attach(); ack(c, 0); ack(c, 0);
    expect(c.closed[0]?.code).toBe(1008);
  });
});

test("later sends cannot extend the oldest unacknowledged frame deadline", async () => {
  await fixture(async ({ attach, ack, delta, advance, timers }) => {
    const c = await attach(); ack(c, 0); delta();
    const timer = c.attachment.timer;
    advance(14999); delta();
    expect(c.attachment.timer).toBe(timer); expect(c.closed).toEqual([]);
    advance(1);
    expect(c.closed[0]?.code).toBe(1013); expect(timers.size).toBe(0);
  });
});

test("ACK re-arms to the next frame's original deadline, not a fresh deadline", async () => {
  await fixture(async ({ attach, ack, delta, advance, timers }) => {
    const c = await attach(); ack(c, 0); delta(); advance(1000); delta();
    advance(13999); ack(c, 1);
    expect([...timers.values()].map(t => t.at)).toEqual([16000]);
    advance(1000); expect(c.closed).toEqual([]);
    advance(1); expect(c.closed[0]?.code).toBe(1013);
  });
});

test("slow viewer does not block a fast attachment and only the slow viewer times out", async () => {
  await fixture(async ({ attach, ack, delta, advance, resource }) => {
    const slow = await attach(), fast = await attach(); ack(slow, 0); ack(fast, 0);
    for (let i = 1; i <= L.outputWindowFrames + 10; i++) { delta(); ack(fast, i); }
    expect(outputs(slow)).toHaveLength(L.outputWindowFrames);
    expect(outputs(fast)).toHaveLength(L.outputWindowFrames + 10);
    expect(fast.attachment.pending).toEqual([]);
    advance(15000);
    expect(slow.closed[0]?.code).toBe(1013); expect(fast.closed).toEqual([]);
    expect(resource.attachments.has(fast.attachment)).toBe(true);
    delta(); ack(fast, resource.seq); expect(fast.closed).toEqual([]);
  });
});

test("-1 send is accepted exactly once; 0, exceptions and excessive socket backlog disconnect", async () => {
  for (const mode of ["queued", "dropped", "throw", "backlog", "backlog-after-send"] as const) {
    await fixture(async ({ attach, ack, delta, timers }) => {
      const c = await attach(); ack(c, 0);
      c.result = mode === "queued" ? -1 : mode === "dropped" ? 0 : 1;
      c.throws = mode === "throw"; c.buffered = mode === "backlog" ? L.snapshotBytes + 65537 : 0;
      if (mode === "backlog-after-send") c.afterSendBuffered = L.snapshotBytes + 65537;
      delta();
      if (mode === "queued") {
        delta(); expect(outputs(c).map(m => m.seq)).toEqual([1, 2]);
        ack(c, 1); ack(c, 2); expect(outputs(c)).toHaveLength(2); expect(c.closed).toEqual([]);
      } else {
        expect(c.closed[0]?.code).toBe(mode === "throw" ? 1011 : 1013);
        expect(c.attachment.pending).toEqual([]); expect(c.attachment.pendingBytes).toBe(0); expect(timers.size).toBe(0);
      }
    });
  }
});

test("failed snapshot send never leaves a live ACK gate or timer", async () => {
  await fixture(async ({ resource, attach, probe, timers }) => {
    Object.defineProperty(resource.boundary, "safe", { configurable: true, value: false });
    const c = await attach(); c.result = 0;
    Object.defineProperty(resource.boundary, "safe", { configurable: true, value: true });
    probe.snapshots(resource);
    expect(c.closed[0]?.code).toBe(1013); expect(c.attachment.ready).toBe(false);
    expect(c.attachment.snapshotPending).toBe(false); expect(c.attachment.pending).toEqual([]); expect(timers.size).toBe(0);
  });
});

test("control-generation checks reject stale/viewer input and reconnect never replays it", async () => {
  await fixture(async ({ service, resource, attach, ack }) => {
    const writes: number[][] = [];
    resource.pty!.write = (bytes => { writes.push([...bytes as Uint8Array]); return (bytes as Uint8Array).length; }) as Bun.Terminal["write"];
    const c = await attach(); ack(c, 0);
    service.websocket.message!(c.socket, JSON.stringify({ type: "claim", generation: 0 })); await resource.tail;
    expect(resource.state.controllerId).toBe(c.attachment.id); expect(resource.state.generation).toBe(1);
    service.websocket.message!(c.socket, JSON.stringify({ type: "input", generation: 0, data: "eA==" })); await resource.tail;
    expect(writes).toEqual([]); expect(c.sent.at(-1)).toMatchObject({ type: "error", code: "terminal-stale-control" });
    service.websocket.message!(c.socket, JSON.stringify({ type: "input", generation: 1, data: "eA==" })); await resource.tail;
    expect(writes).toEqual([[120]]);
    service.websocket.close!(c.socket, 1000, "closed");
    const next = await attach(); ack(next, 0);
    expect(resource.state.controllerId).toBeNull(); expect(resource.state.generation).toBe(2);
    service.websocket.message!(next.socket, JSON.stringify({ type: "input", generation: 2, data: "eQ==" })); await resource.tail;
    expect(next.sent.at(-1)).toMatchObject({ type: "error", code: "terminal-viewer" }); expect(writes).toEqual([[120]]);
  });
});

test("queued controller resize stays between preceding and following parsed PTY output", async () => {
  await fixture(async ({ service, probe, resource, attach, ack }) => {
    const c = await attach(); ack(c, 0);
    resource.state.controllerId = c.attachment.id; resource.state.generation = 1;
    const parsing: (() => void)[] = [], resizes: number[][] = [];
    resource.screen.write = ((_bytes: Uint8Array, done: () => void) => { parsing.push(done); }) as Resource["screen"]["write"];
    resource.pty!.resize = (cols, rows) => { resizes.push([cols, rows]); };
    probe.output(resource, Buffer.from("before"));
    service.websocket.message!(c.socket, JSON.stringify({ type: "resize", generation: 1, cols: 100, rows: 30 }));
    probe.output(resource, Buffer.from("after"));
    await Promise.resolve(); await Promise.resolve();
    expect(screenFrames(c).map(m => m.seq)).toEqual([0]); expect(resizes).toEqual([]);
    parsing[0]!();
    for (let i = 0; i < 24 && parsing.length < 2; i++) await Promise.resolve();
    expect(screenFrames(c).map(m => [m.type, m.seq])).toEqual([["snapshot", 0], ["output", 1], ["resize", 2]]);
    expect(resizes).toEqual([[100, 30]]); expect(parsing).toHaveLength(2);
    parsing[1]!(); await resource.tail;
    expect(screenFrames(c).map(m => [m.type, m.seq])).toEqual([["snapshot", 0], ["output", 1], ["resize", 2], ["output", 3]]);
    expect(c.attachment.pending.map(m => m.seq)).toEqual([1, 2, 3]);
  });
});

test("detach, cancelled upgrade, revocation and shutdown clear timers/window and release generation", async () => {
  for (const mode of ["close", "cancel", "revoke", "shutdown"] as const) {
    await fixture(async ({ service, attach, ack, delta, resource, timers, advance }) => {
      const c = await attach(); ack(c, 0); delta();
      resource.state.controllerId = c.attachment.id; resource.state.generation = 7;
      if (mode === "close") service.websocket.close!(c.socket, 1000, "closed");
      else if (mode === "cancel") service.cancelUpgrade(c.socket.data);
      else if (mode === "revoke") service.revoke("token");
      else await service.close();
      expect(c.attachment.dead).toBe(true); expect(resource.attachments.size).toBe(0);
      expect(resource.state.controllerId).toBeNull(); expect(resource.state.generation).toBe(8);
      expect(c.attachment.pending).toEqual([]); expect(c.attachment.pendingBytes).toBe(0);
      expect(c.attachment.timer).toBeUndefined(); expect(timers.size).toBe(0);
      const closed = c.closed.length; advance(30000); expect(c.closed).toHaveLength(closed);
    });
  }
});

test("safe-boundary snapshot fencing captures queued output without duplicate delta replay", async () => {
  await fixture(async ({ resource, attach, probe, ack, delta }) => {
    Object.defineProperty(resource.boundary, "safe", { configurable: true, value: false });
    const c = await attach(); delta();
    expect(c.sent.map(m => m.type)).toEqual(["hello"]);
    Object.defineProperty(resource.boundary, "safe", { configurable: true, value: true });
    probe.snapshots(resource); delta();
    expect(screenFrames(c).map(m => m.seq)).toEqual([1]);
    ack(c, 1); expect(screenFrames(c).map(m => m.seq)).toEqual([1, 2]);
  });
});

test("attachment and snapshot caps, pending-boundary timeout, retention gaps and auth remain fenced", async () => {
  await fixture(async ({ attach, ack, delta, resource }) => {
    const c = await attach(); ack(c, 0);
    for (let i = 0; i < 1100; i++) delta();
    ack(c, 1); expect(c.closed[0]?.reason).toContain("retention gap");
    expect(resource.ring.length).toBeLessThanOrEqual(1024); expect(resource.ringBytes).toBeLessThanOrEqual(L.backlogBytes);
  });
  await fixture(async ({ attach, resource }) => {
    for (let i = 0; i < L.attachments; i++) await attach();
    await expect(attach()).rejects.toMatchObject({ code: "terminal-attachments" });
    expect(resource.attachments.size).toBe(L.attachments);
  });
  await fixture(async ({ attach, resource, timers }) => {
    resource.serializer.serialize = () => "s".repeat(L.snapshotBytes);
    const c = await attach(); expect(c.closed[0]?.reason).toContain("snapshot limit"); expect(timers.size).toBe(0);
  });
  await fixture(async ({ attach, resource, advance, timers }) => {
    Object.defineProperty(resource.boundary, "safe", { value: false });
    const c = await attach(); advance(5000);
    expect(c.closed[0]?.reason).toContain("boundary timeout"); expect(timers.size).toBe(0);
  });
  await fixture(async ({ attach, ack, delta, authorize }) => {
    const c = await attach(); ack(c, 0); authorize(false); delta();
    expect(c.closed[0]?.code).toBe(4401); expect(outputs(c)).toHaveLength(0);
  });
});

test("PTY output chunking still parses before publishing each ordered frame", async () => {
  await fixture(async ({ attach, ack, probe, resource }) => {
    const c = await attach(); ack(c, 0);
    const parsing: { bytes: Uint8Array; done: () => void }[] = [];
    resource.screen.write = ((bytes: Uint8Array, done: () => void) => { parsing.push({ bytes, done }); }) as Resource["screen"]["write"];
    probe.output(resource, Buffer.alloc(L.chunkBytes + 1, 120));
    await Promise.resolve(); await Promise.resolve();
    expect(outputs(c)).toHaveLength(0); expect(parsing[0]?.bytes.length).toBe(L.chunkBytes);
    parsing[0]!.done();
    // The queue's second parser call is reached only after the first task settles.
    for (let i = 0; i < 12 && parsing.length < 2; i++) await Promise.resolve();
    expect(outputs(c).map(m => m.seq)).toEqual([1]); expect(parsing[1]?.bytes.length).toBe(1);
    parsing[1]!.done(); await resource.tail;
    expect(outputs(c).map(m => m.seq)).toEqual([1, 2]);
    expect(Buffer.from((outputs(c)[0] as Extract<Delta, { type: "output" }>).data, "base64").length).toBe(L.chunkBytes);
    expect(c.attachment.pending.map(m => m.seq)).toEqual([1, 2]);
  });
});
