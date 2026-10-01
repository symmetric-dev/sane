import { expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { catalog } from "./catalog";
import type { TerminalClientMessage, TerminalServerMessage, TerminalState } from "../src/terminal-contract";

test("opening a worktree terminal auto-starts once and the styled Interact button explicitly claims keyboard control", async () => {
  const browser = new Window({ url: "http://localhost" });
  const sent: TerminalClientMessage[] = [], requests: string[] = [], sockets: FixtureSocket[] = [];
  class FixtureSocket {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { sockets.push(this); }
    send(data: string) { sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
    emit(message: TerminalServerMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
  }
  const initial: TerminalState = { workspaceId: "workspace", worktreeId: "tree", bindingRevision: "binding", capability: { available: true }, terminalId: null, status: "absent", cols: 80, rows: 24, generation: 0, controllerId: null, exitCode: null, ptyClosed: false };
  const running: TerminalState = { ...initial, terminalId: "terminal", status: "running" };
  const globals = {
    window: browser, self: browser, document: browser.document, navigator: browser.navigator,
    HTMLElement: browser.HTMLElement, ResizeObserver: browser.ResizeObserver, WebSocket: FixtureSocket,
    getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("/api/workspaces/workspace/worktrees/tree/terminal");
      requests.push(init?.method ?? "GET");
      return Response.json(init?.method === "POST" ? running : initial);
    },
  };
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const previousCatalog = catalog.state;
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let root: Root | undefined;
  const restores: (() => void)[] = [];
  try {
    // Keep the real TerminalSession/provider/protocol. Only replace emulator DOM
    // rendering, which requires a canvas unavailable in this headless fixture.
    const { Terminal } = await import("@xterm/xterm");
    const open = spyOn(Terminal.prototype, "open").mockImplementation(() => {}); restores.push(() => open.mockRestore());
    const write = spyOn(Terminal.prototype, "write").mockImplementation((_, callback) => callback?.()); restores.push(() => write.mockRestore());
    const focus = spyOn(Terminal.prototype, "focus").mockImplementation(() => {}); restores.push(() => focus.mockRestore());
    const [{ TerminalProvider, TerminalView }, { createRoot }] = await Promise.all([import("./terminal"), import("react-dom/client")]);
    catalog.state = { ...catalog.state, ready: true, workspaces: [{ workspaceId: "workspace", name: "Fixture", kind: "directory", commonDir: null,
      worktrees: [{ worktreeId: "tree", root: "/fixture", gitDir: null, bindingRevision: "binding", state: "available" }] }],
      navigation: { ...catalog.state.navigation, workspaceId: "workspace", worktreeId: "tree", view: "terminal" } };
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(<TerminalProvider view="terminal"><TerminalView /></TerminalProvider>));
    expect(requests).toEqual(["GET", "POST"]); expect(sockets).toHaveLength(1);
    expect(sent).toEqual([]);
    const socket = sockets[0]!;
    await act(async () => { socket.emit({ type: "hello", attachmentId: "here", state: running }); });
    expect([...host.querySelectorAll("button")].some(button => button.textContent === "Interact")).toBe(false);
    await act(async () => { socket.emit({ type: "snapshot", seq: 0, data: "", cols: 80, rows: 24 }); });
    const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === label)!;
    const interact = button("Interact");
    expect(interact).toBeDefined(); expect(interact.type).toBe("button"); expect(interact.classList.contains("primary-button")).toBe(true);
    expect(host.textContent).not.toContain("Use keyboard here");
    expect(sent).toEqual([{ type: "ack", seq: 0 }]);
    await act(async () => interact.click());
    expect(sent.at(-1)).toEqual({ type: "claim", generation: 0 });
    expect(button("Release keyboard")).toBeUndefined(); // Wait for server acknowledgement.
    await act(async () => { socket.emit({ type: "state", state: { ...running, controllerId: "here", generation: 1 } }); });
    expect(button("Release keyboard")).toBeDefined();
    await act(async () => button("Release keyboard").click());
    expect(sent.at(-1)).toEqual({ type: "release", generation: 1 }); expect(button("Interact")).toBeUndefined();
    await act(async () => { socket.emit({ type: "state", state: { ...running, generation: 2 } }); });
    expect(button("Interact")).toBeDefined();
    await act(async () => { socket.emit({ type: "state", state: { ...running, controllerId: "another-device", generation: 3 } }); });
    expect(button("Take control here").classList.contains("primary-button")).toBe(true);
    await act(async () => button("Take control here").click());
    expect(sent.at(-1)).toEqual({ type: "take", generation: 3 });
    expect(requests).toEqual(["GET", "POST"]);
  } finally {
    try { if (root) await act(async () => root!.unmount()); }
    finally {
      for (const restore of restores.reverse()) restore(); catalog.state = previousCatalog;
      await browser.happyDOM.close();
      for (const [key, descriptor] of prior) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    }
  }
});
