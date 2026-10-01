import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { EditorView } from "@codemirror/view";
import { ApplicationCommandProvider } from "./application-commands";
import { WorkspaceProvider, useWorkspace } from "./workspace-controller";
import { WorkspaceSearchButton, WorkspaceSearchFeature, searchDebounceMs, useWorkspaceSearch } from "./workspace-search";
import { catalog } from "./catalog";
import { dirty, invalidateWorkspaceRequests, notifyWorkspace, resetWorkspaceState } from "./workspace-store";

async function withDOM(fetcher: typeof fetch, run: (host: HTMLDivElement, root: Root, browser: Window) => Promise<void>) {
  const browser = new Window({ url: "http://localhost" });
  const globals = { window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, Event: browser.Event, MouseEvent: browser.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true, fetch: fetcher };
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const previousCatalog = catalog.state;
  let root: Root | undefined;
  try {
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await run(host, root, browser);
  } finally {
    if (root) await act(async () => root!.unmount());
    resetWorkspaceState(); catalog.state = previousCatalog; browser.close();
    for (const [key, descriptor] of prior) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}
const waitForSearch = () => act(async () => { await new Promise(resolve => setTimeout(resolve, searchDebounceMs + 20)); });
const result = (query: string) => ({ workspaceId: "binding", matches: [{ path: "notes.md", line: 1, column: 1, endColumn: query.length + 1, preview: query }], truncated: false, scannedFiles: 1, skippedFiles: 0 });

test("search debounces, forwards AbortSignal, and fences query, scope, auth and unmount responses", async () => {
  const requests: { body: any; signal: AbortSignal; pending: ReturnType<typeof Promise.withResolvers<Response>>; url: string }[] = [];
  await withDOM(((url: string, init: RequestInit) => {
    const pending = Promise.withResolvers<Response>(); requests.push({ url, body: JSON.parse(String(init.body)), signal: init.signal as AbortSignal, pending }); return pending.promise;
  }) as typeof fetch, async (host, root) => {
    let state: ReturnType<typeof useWorkspaceSearch>;
    let query = "a", tree = "tree", generation = 1;
    function Probe() { state = useWorkspaceSearch(JSON.stringify(["workspace", tree]), "binding", generation, { query }); return <div>{state.result?.matches[0]?.preview ?? (state.loading ? "loading" : state.error)}</div>; }
    const render = () => act(async () => root.render(<Probe />));
    await render(); expect(requests).toHaveLength(0);
    query = "ab"; await render(); query = "abc"; await render(); await waitForSearch();
    expect(requests).toHaveLength(1); expect(requests[0]!.body).toEqual({ workspaceId: "binding", query: "abc" });
    query = "next"; await render(); expect(requests[0]!.signal.aborted).toBe(true); expect(host.textContent).toBe("loading");
    await act(async () => requests[0]!.pending.resolve(Response.json(result("old")))); expect(state!.result).toBeUndefined();
    await waitForSearch(); expect(requests).toHaveLength(2);
    tree = "other"; generation++; await render(); expect(requests[1]!.signal.aborted).toBe(true);
    await act(async () => requests[1]!.pending.resolve(Response.json(result("old scope")))); expect(state!.result).toBeUndefined();
    await waitForSearch(); expect(requests[2]!.url).toContain("/worktrees/other/search");
    await act(async () => { invalidateWorkspaceRequests(); }); await render(); expect(requests[2]!.signal.aborted).toBe(true);
    await act(async () => requests[2]!.pending.resolve(Response.json(result("old auth")))); expect(state!.result).toBeUndefined();
    await waitForSearch(); await act(async () => requests[3]!.pending.resolve(Response.json(result("next"))));
    expect(host.textContent).toBe("next");
    query = ""; await render(); expect(state!.result).toBeUndefined(); await waitForSearch(); expect(requests).toHaveLength(4);
    query = "pending"; await render(); await waitForSearch(); await act(async () => root.render(null));
    expect(requests[4]!.signal.aborted).toBe(true);
    await act(async () => requests[4]!.pending.resolve(Response.json(result("after unmount"))));
  });
});

test("visible search and shortcut share availability; native modal restores focus; delayed/same-file activation preserves unsaved buffers", async () => {
  const fileRequests: string[] = [], navigations: string[] = [];
  await withDOM((async (input: string | URL | Request) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/tree")) return Response.json({ root: "/fixture", workspaceId: "binding", bindingRevision: "binding", catalogWorkspaceId: "workspace", worktreeId: "tree", maxFileBytes: 262144 });
    if (url.pathname.endsWith("/file")) { fileRequests.push(url.searchParams.get("path")!); return Response.json({ workspaceId: "binding", path: url.searchParams.get("path"), text: "hello saved\nsecond line", revision: "a".repeat(64), bytes: 23, editable: true, eol: "lf", bom: false }); }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch, async (host, root, browser) => {
    resetWorkspaceState();
    catalog.state = { ...catalog.state, ready: false, navigation: { revision: 0, workspaceId: "workspace", worktreeId: "tree", conversationId: null, view: "code", filePath: "notes.md", comparison: null } };
    let controller: ReturnType<typeof useWorkspace>;
    function Probe() { controller = useWorkspace(); return <WorkspaceSearchButton />; }
    await act(async () => root.render(<ApplicationCommandProvider><WorkspaceProvider view="code" navigate={view => navigations.push(view)}><WorkspaceSearchFeature><Probe /></WorkspaceSearchFeature></WorkspaceProvider></ApplicationCommandProvider>));
    const opener = host.querySelector<HTMLButtonElement>('[aria-label="Search saved files"]')!;
    expect(opener.disabled).toBe(false); expect(opener.querySelector("kbd")!.textContent).toBeTruthy(); opener.focus();
    await act(async () => opener.click()); expect(host.querySelector("dialog")).not.toBeNull();
    expect(host.textContent).toContain("Unsaved buffers are not searched or replaced");
    const modalMac = /Mac|iPhone|iPad|iPod/i.test(browser.navigator.platform);
    const modalKey = new browser.KeyboardEvent("keydown", { key: "F", ctrlKey: !modalMac, metaKey: modalMac, shiftKey: true, bubbles: true, cancelable: true });
    await act(async () => host.querySelector("input")!.dispatchEvent(modalKey as unknown as Event)); expect(modalKey.defaultPrevented).toBe(false);
    await act(async () => host.querySelector("dialog")!.dispatchEvent(new Event("cancel", { bubbles: true, cancelable: true })));
    expect(host.querySelector("dialog")).toBeNull(); expect(document.activeElement === opener).toBe(true);
    const mac = /Mac|iPhone|iPad|iPod/i.test(browser.navigator.platform);
    const key = new browser.KeyboardEvent("keydown", { key: "F", metaKey: mac, ctrlKey: !mac, shiftKey: true, bubbles: true, cancelable: true });
    await act(async () => opener.dispatchEvent(key as unknown as Event)); expect(key.defaultPrevented).toBe(true); expect(host.querySelector("dialog")).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close search saved files"]')!.click());
    const buffer = controller!.buffer!;
    await act(async () => { buffer.state = buffer.state.update({ changes: { from: buffer.state.doc.length, insert: "\nunsaved" } }).state; notifyWorkspace(); });
    const location = { path: "notes.md", line: 1, column: 1, endColumn: 6, preview: "hello saved", query: "hello" };
    await act(async () => controller!.activate({ view: "code", path: "notes.md", location }));
    const dispatches: any[] = []; let focuses = 0;
    const view = { dispatch: (transaction: any) => { dispatches.push(transaction); buffer.state = buffer.state.update({ selection: transaction.selection }).state; }, focus: () => focuses++ } as unknown as EditorView;
    await act(async () => buffer.attach(view));
    expect(dispatches).toHaveLength(1); expect(buffer.state.sliceDoc(buffer.state.selection.main.from, buffer.state.selection.main.to)).toBe("hello");
    expect(focuses).toBe(1); expect(dirty(buffer)).toBe(true); expect(buffer.state.doc.toString()).toContain("unsaved");
    await act(async () => controller!.activate({ view: "code", path: "notes.md", location })); expect(dispatches).toHaveLength(2); expect(navigations).toEqual(["code", "code"]);
    await act(async () => { buffer.state = buffer.state.update({ changes: { from: 0, insert: "changed " } }).state; notifyWorkspace(); });
    await act(async () => controller!.activate({ view: "code", path: "notes.md", location }));
    expect(dispatches).toHaveLength(2); expect(controller!.locationNotice).toContain("Local edits are preserved"); expect(buffer.state.doc.toString()).toContain("changed hello");
    expect(fileRequests.every(path => path === "notes.md")).toBe(true);
    await act(async () => { buffer.attach(null); invalidateWorkspaceRequests(); });
    expect(opener.disabled).toBe(true);
    const disabledKey = new browser.KeyboardEvent("keydown", { key: "F", metaKey: mac, ctrlKey: !mac, shiftKey: true, bubbles: true, cancelable: true });
    await act(async () => opener.dispatchEvent(disabledKey as unknown as Event)); expect(disabledKey.defaultPrevented).toBe(false);
  });
});

test("search UI sends controls, groups results, navigates with arrows/Enter, and opens the existing unsaved buffer", async () => {
  const searches: { input: any; pending: ReturnType<typeof Promise.withResolvers<Response>> }[] = [];
  let artifactOpen = true;
  await withDOM((async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/tree")) return Response.json({ root: "/fixture", workspaceId: "binding", bindingRevision: "binding", catalogWorkspaceId: "workspace", worktreeId: "tree", maxFileBytes: 262144 });
    if (url.pathname.endsWith("/file")) return Response.json({ workspaceId: "binding", path: "notes.md", text: "hello saved\nhello again", revision: "a".repeat(64), bytes: 23, editable: true, eol: "lf", bom: false });
    if (url.pathname.endsWith("/search")) { const pending = Promise.withResolvers<Response>(); searches.push({ input: JSON.parse(String(init?.body)), pending }); return pending.promise; }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch, async (host, root, browser) => {
    resetWorkspaceState();
    catalog.state = { ...catalog.state, ready: false, navigation: { revision: 0, workspaceId: "workspace", worktreeId: "tree", conversationId: null, view: "code", filePath: "notes.md", comparison: null } };
    let controller: ReturnType<typeof useWorkspace>;
    function Probe() { controller = useWorkspace(); return <WorkspaceSearchButton />; }
    await act(async () => root.render(<ApplicationCommandProvider><WorkspaceProvider view="code" navigate={() => { artifactOpen = false; }}><WorkspaceSearchFeature><Probe /></WorkspaceSearchFeature></WorkspaceProvider></ApplicationCommandProvider>));
    const buffer = controller!.buffer!;
    await act(async () => { buffer.state = buffer.state.update({ changes: { from: buffer.state.doc.length, insert: "\nunsaved" } }).state; notifyWorkspace(); });
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Search saved files"]')!.click());
    const query = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(document.activeElement === query).toBe(true);
    const type = async (input: HTMLInputElement, value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new browser.Event("input", { bubbles: true }) as unknown as Event);
    });
    await type(query, "hello");
    const paths = host.querySelectorAll<HTMLInputElement>(".workspace-search-paths input");
    await type(paths[0]!, "**/*.md"); await type(paths[1]!, "generated/**");
    for (const checkbox of host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) await act(async () => checkbox.click());
    await waitForSearch(); expect(searches).toHaveLength(1);
    expect(searches[0]!.input).toEqual({ workspaceId: "binding", query: "hello", caseSensitive: true, wholeWord: true, include: "**/*.md", exclude: "generated/**" });
    expect(host.textContent).toContain("Searching saved files");
    await act(async () => searches[0]!.pending.resolve(Response.json({ ...result("hello"), matches: [] })));
    expect(host.textContent).toContain("No matches");
    await type(query, "missing"); await waitForSearch();
    await act(async () => searches[1]!.pending.resolve(Response.json({ error: "Search unavailable" }, { status: 503 })));
    expect(host.querySelector('[role="alert"]')!.textContent).toBe("Search unavailable");
    await type(query, "hello"); await waitForSearch();
    await act(async () => searches[2]!.pending.resolve(Response.json({ ...result("hello"), matches: [
      { path: "notes.md", line: 1, column: 1, endColumn: 6, preview: "hello saved" },
      { path: "notes.md", line: 2, column: 1, endColumn: 6, preview: "hello again" },
      { path: "other.md", line: 1, column: 1, endColumn: 6, preview: "hello other" },
    ], skippedFiles: 2, truncated: true })));
    expect(host.querySelectorAll(".workspace-search-results section")).toHaveLength(2);
    expect(host.textContent).toContain("2 files skipped"); expect(host.textContent).toContain("Results truncated");
    const results = host.querySelectorAll<HTMLButtonElement>(".workspace-search-results button");
    await act(async () => query.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }) as unknown as Event));
    expect(document.activeElement === results[0]).toBe(true);
    await act(async () => results[0]!.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }) as unknown as Event));
    expect(document.activeElement === results[1]).toBe(true);
    // happy-dom does not synthesize native button activation from Enter; clicking
    // exercises the same native button action used by Enter in a real browser.
    await act(async () => results[1]!.click());
    expect(host.querySelector("dialog")).toBeNull(); expect(artifactOpen).toBe(false);
    expect(controller!.buffer).toBe(buffer); expect(dirty(buffer)).toBe(true); expect(buffer.state.doc.toString()).toContain("unsaved");
    let focused = false;
    await act(async () => buffer.attach({ dispatch: (transaction: any) => { buffer.state = buffer.state.update({ selection: transaction.selection }).state; }, focus: () => { focused = true; } } as unknown as EditorView));
    expect(focused).toBe(true); expect(buffer.state.selection.main.from).toBe(12); expect(buffer.state.sliceDoc(buffer.state.selection.main.from, buffer.state.selection.main.to)).toBe("hello");
    await act(async () => buffer.attach(null));
  });
});
