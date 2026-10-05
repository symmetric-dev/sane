import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { TerminalClientMessage, TerminalServerMessage, TerminalState } from "../src/terminal-contract";
import type { TerminalPresentation } from "./terminal-client";
import { workspaceEpoch } from "./workspace-store";

const selection = { workspaceId: "workspace", worktreeId: "tree", bindingRevision: "binding", root: "/fixture" };
const state: TerminalState = { ...selection, capability: { available: true }, terminalId: "terminal", status: "running", cols: 80, rows: 24, generation: 0, controllerId: null, exitCode: null, ptyClosed: false };
type Probe = {
  attach(): void; detach(): void; sendBytes(bytes: Uint8Array): void;
  presentation: TerminalPresentation; seq: number | null; queuedBytes: number; queue: unknown[]; writing: boolean;
  auth: number; disposed: boolean; restoring: boolean; attachment: string;
};
type Write = { data: string | Uint8Array; complete: () => void };

/** Exercise the real socket/render queue against manually completed emulator
 * writes. No constructor, browser renderer, module mocks, network or native PTY. */
async function fixture(run: (f: {
  session: Probe; sockets: MockSocket[]; writes: Write[]; events: unknown[][];
  complete(): void; hello(socket?: MockSocket, patch?: Partial<TerminalState>): void;
  deselect(): void;
}) => void | Promise<void>) {
  const browser = new Window({ url: "http://localhost:3111" });
  const sockets: MockSocket[] = [], writes: Write[] = [], events: unknown[][] = [];
  class Socket extends MockSocket {
    constructor(url: URL) { super(String(url)); sockets.push(this); }
  }
  const globals = { self: browser, window: browser, document: browser.document, WebSocket: Socket };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let session: Probe | undefined;
  try {
    const { TerminalSession, emptyTerminal } = await import("./terminal-client");
    let selected = true;
    const host = browser.document.createElement("div"); browser.document.body.append(host);
    session = Object.assign(Object.create(TerminalSession.prototype), {
      host, selection, auth: workspaceEpoch(), disposed: false, selected: () => selected,
      base: "/api/workspaces/workspace/worktrees/tree/terminal", presentation: emptyTerminal(), publish: () => {},
      socket: null, attachment: "", connection: 0, restoring: true, released: false, seq: null, queue: [], queuedBytes: 0, writing: false,
      retryDelay: 1000, pendingSize: "", inputWindow: 0, inputBytes: 0, inputMessages: 0,
      terminal: {
        options: {}, cols: 80, rows: 24,
        write(data: string | Uint8Array, complete: () => void) { writes.push({ data, complete }); events.push(["write", typeof data === "string" ? data : [...data]]); },
        reset: () => { events.push(["reset"]); },
        resize: (cols: number, rows: number) => { events.push(["resize", cols, rows]); },
        focus() {},
      },
      // Constructor-owned UI callbacks aren't under test; the lifecycle methods
      // and their connection fences are the actual TerminalSession prototype.
      release() {}, scheduleFit() {},
    }) as Probe;
    session.attach();
    await run({ session, sockets, writes, events,
      complete() { const write = writes.shift(); expect(write).toBeDefined(); write!.complete(); },
      hello(socket = sockets.at(-1)!, patch = {}) { socket.receive({ type: "hello", attachmentId: "attachment", state: { ...state, ...patch } }); },
      deselect: () => { selected = false; },
    });
  } finally {
    session?.detach();
    await browser.happyDOM.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}

class MockSocket {
  static OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: TerminalClientMessage[] = [];
  closed = 0;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  receive(message: TerminalServerMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
  close() { this.closed++; this.readyState = 3; this.onclose?.({ code: 1000 }); }
}

const snapshot = (seq = 0): TerminalServerMessage => ({ type: "snapshot", seq, data: "screen", cols: 80, rows: 24 });
const output = (seq: number, data = "eA=="): TerminalServerMessage => ({ type: "output", seq, data });
const acks = (socket: MockSocket) => socket.sent.filter(m => m.type === "ack");

test("snapshot ACK is sent only after both parser fences, never when received or enqueued", async () => {
  await fixture(({ session, sockets, writes, events, hello, complete }) => {
    hello(); const socket = sockets[0]!;
    socket.receive(snapshot(7));
    expect(writes.map(w => w.data)).toEqual([""]); expect(acks(socket)).toEqual([]);
    expect(session.presentation.ready).toBe(false); expect(events).toEqual([["write", ""]]);
    complete();
    expect(events).toEqual([["write", ""], ["reset"], ["resize", 80, 24], ["write", "screen"]]);
    expect(acks(socket)).toEqual([]); expect(session.seq).toBeNull();
    complete();
    expect(acks(socket)).toEqual([{ type: "ack", seq: 7 }]);
    expect(session.presentation.ready).toBe(true); expect(session.seq).toBe(7);
    expect(session.presentation.geometry).toEqual({ cols: 80, rows: 24 });
  });
});

test("multiple queued outputs parse in order, resize stays fenced, and every ACK follows its callback", async () => {
  await fixture(({ session, sockets, writes, events, hello, complete }) => {
    hello(); const socket = sockets[0]!; socket.receive(snapshot()); complete(); complete();
    socket.receive(output(1, "w6k=")); // Original UTF-8 bytes, not a decoded JS string.
    socket.receive(output(2));
    socket.receive({ type: "resize", seq: 3, cols: 100, rows: 30 });
    socket.receive(output(4, "eQ=="));
    expect(writes).toHaveLength(1); expect([...writes[0]!.data]).toEqual([195, 169]);
    expect(session.queue).toHaveLength(3); expect(acks(socket)).toEqual([{ type: "ack", seq: 0 }]);
    expect(events.filter(e => e[0] === "resize")).toEqual([["resize", 80, 24]]);
    complete();
    expect(acks(socket).map(m => m.seq)).toEqual([0, 1]); expect([...writes[0]!.data]).toEqual([120]);
    complete();
    expect(acks(socket).map(m => m.seq)).toEqual([0, 1, 2]); expect(writes[0]!.data).toBe("");
    expect(events.at(-2)).toEqual(["resize", 100, 30]);
    expect(session.presentation.geometry).toEqual({ cols: 80, rows: 24 });
    complete();
    expect(acks(socket).map(m => m.seq)).toEqual([0, 1, 2, 3]); expect([...writes[0]!.data]).toEqual([121]);
    expect(session.presentation.geometry).toEqual({ cols: 100, rows: 30 });
    complete();
    expect(acks(socket).map(m => m.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(session.queue).toEqual([]); expect(session.queuedBytes).toBe(0); expect(session.writing).toBe(false);
  });
});

test("old output callbacks and socket events cannot ACK, drain or mutate a replacement connection", async () => {
  await fixture(({ session, sockets, writes, hello, complete }) => {
    hello(); const old = sockets[0]!; old.receive(snapshot()); complete(); complete();
    old.receive(output(1)); old.receive(output(2));
    const oldWrite = writes.shift()!, oldMessage = old.onmessage!, oldClose = old.onclose!;
    session.attach(); hello(); const next = sockets[1]!;
    next.receive(snapshot(20));
    oldWrite.complete(); oldMessage({ data: JSON.stringify(output(3)) }); oldClose({ code: 1000 });
    expect(acks(old).map(m => m.seq)).toEqual([0]); expect(acks(next)).toEqual([]);
    expect(session.seq).toBeNull(); expect(session.writing).toBe(true); expect(session.queue).toEqual([]);
    complete(); complete();
    expect(acks(next)).toEqual([{ type: "ack", seq: 20 }]); expect(session.seq).toBe(20);
    next.receive(output(21)); complete(); expect(acks(next).map(m => m.seq)).toEqual([20, 21]);
  });
});

test("old snapshot fence cannot reset or resize a replacement screen", async () => {
  await fixture(({ session, sockets, writes, events, hello, complete }) => {
    hello(); sockets[0]!.receive(snapshot());
    const oldFence = writes.shift()!;
    session.attach(); hello(); sockets[1]!.receive(snapshot(10));
    oldFence.complete(); expect(events.filter(e => e[0] === "reset")).toEqual([]);
    complete(); complete();
    expect(events.filter(e => e[0] === "reset")).toHaveLength(1);
    expect(acks(sockets[0]!)).toEqual([]); expect(acks(sockets[1]!).map(m => m.seq)).toEqual([10]);
  });
});

test("disconnect clears the queue and ignores an in-progress parser completion", async () => {
  await fixture(({ session, sockets, writes, hello, complete }) => {
    hello(); const socket = sockets[0]!; socket.receive(snapshot()); complete(); complete();
    socket.receive(output(1)); socket.receive(output(2));
    const pending = writes.shift()!; socket.close(); pending.complete();
    expect(acks(socket).map(m => m.seq)).toEqual([0]); expect(session.seq).toBeNull();
    expect(session.queue).toEqual([]); expect(session.queuedBytes).toBe(0); expect(session.writing).toBe(false);
    expect(session.presentation.ready).toBe(false); expect(session.presentation.connected).toBe(false);
  });
});

test("selection, auth, and disposal fences suppress late parser ACKs", async () => {
  for (const fence of ["selection", "auth", "dispose"] as const) {
    await fixture(({ session, sockets, writes, hello, complete, deselect }) => {
      hello(); const socket = sockets[0]!; socket.receive(snapshot()); complete(); complete();
      socket.receive(output(1)); const pending = writes.shift()!;
      if (fence === "selection") deselect(); else if (fence === "auth") session.auth--; else session.disposed = true;
      pending.complete(); expect(acks(socket).map(m => m.seq)).toEqual([0]); expect(session.seq).toBe(0);
    });
  }
});

test("queued sequence gap closes rather than parsing or acknowledging the invalid frame", async () => {
  await fixture(({ session, sockets, hello, complete }) => {
    hello(); const socket = sockets[0]!; socket.receive(snapshot()); complete(); complete();
    socket.receive(output(1)); socket.receive(output(3)); complete();
    expect(acks(socket).map(m => m.seq)).toEqual([0, 1]); expect(socket.closed).toBe(1);
    expect(session.queue).toEqual([]); expect(session.seq).toBeNull();
  });
});

test("busy or disconnected input is dropped and never replayed on a fresh attachment", async () => {
  await fixture(({ session, sockets, hello, complete }) => {
    hello(undefined, { controllerId: "attachment", generation: 4 });
    const old = sockets[0]!; old.receive(snapshot()); complete(); complete();
    old.bufferedAmount = 20000; session.sendBytes(Uint8Array.of(120));
    expect(old.sent.filter(m => m.type === "input")).toEqual([]);
    session.detach(); session.sendBytes(Uint8Array.of(121));
    session.attach(); hello(); const next = sockets[1]!; next.receive(snapshot()); complete(); complete();
    expect(next.sent.filter(m => m.type === "input")).toEqual([]);
    expect(session.presentation.controlling).toBe(false);
  });
});
