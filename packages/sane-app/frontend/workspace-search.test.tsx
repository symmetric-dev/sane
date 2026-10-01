import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import type { EditorView } from "@codemirror/view";
import { ApplicationCommandProvider } from "./application-commands";
import { WorkspaceProvider, useWorkspace } from "./workspace-controller";
import { WorkspaceSearchButton, WorkspaceSearchFeature, WorkspaceSearchPanel, searchDebounceMs, searchMatchId, useWorkspaceSearch, useWorkspaceSearchContext } from "./workspace-search";
import { WorkspaceSidebar } from "./workspace-tree";
import { FilesModeControl } from "./nav";
import { WorkspaceHeader, WorkspaceView } from "./workspace";
import type { WorkspaceSearchMatch } from "../src/workspace-contract";
import { catalog } from "./catalog";
import { dirty, invalidateWorkspaceRequests, notifyWorkspace, resetWorkspaceState } from "./workspace-store";

type Cleanup = () => void | Promise<void>;
async function withDOM(fetcher: typeof fetch, run: (host: HTMLDivElement, root: Root, browser: Window, cleanup: (action: Cleanup) => void) => Promise<void>) {
  const browser = new Window({ url: "http://localhost" });
  const globals = {
    window: browser, Window, document: browser.document, navigator: browser.navigator,
    Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement, Range: browser.Range, DOMRect: browser.DOMRect,
    Event: browser.Event, MouseEvent: browser.MouseEvent, KeyboardEvent: browser.KeyboardEvent, MutationObserver: browser.MutationObserver,
    ResizeObserver: browser.ResizeObserver, getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true, fetch: fetcher,
  };
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const previousCatalog = catalog.state;
  const cleanups: Cleanup[] = [];
  let root: Root | undefined;
  try {
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await run(host, root, browser, action => { cleanups.push(action); });
  } finally {
    try {
      await act(async () => {
        try { for (const cleanup of cleanups.reverse()) await cleanup(); }
        finally { root?.unmount(); }
      });
    } finally {
      try { resetWorkspaceState(); catalog.state = previousCatalog; }
      finally {
        // window.close() returns void and discards this asynchronous teardown.
        // Await the detached-window API so old observers/animation frames cannot
        // access the next test's globals, even when an assertion failed.
        try { await browser.happyDOM.close(); }
        finally {
          for (const [key, descriptor] of prior) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
        }
      }
    }
  }
}
const waitForSearch = () => act(async () => { await new Promise(resolve => setTimeout(resolve, searchDebounceMs + 20)); });
const result = (query: string) => ({ workspaceId: "binding", matches: [{ path: "notes.md", line: 1, column: 1, endColumn: query.length + 1, preview: query }], truncated: false, scannedFiles: 1, skippedFiles: 0 });
async function waitForElement(host: Element, selector: string): Promise<Element> {
  const deadline = Date.now() + 1000;
  // Headless Tree schedules hydration after mounting, even with a cached listing.
  // Yield one task inside act, then inspect the committed DOM; awaiting a mutation
  // inside a single act callback would prevent React from committing that mutation.
  while (true) {
    const element = host.querySelector(selector);
    if (element) return element;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${selector}: ${host.textContent}`);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  }
}

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

test("visible search and repeated shortcut focus the embedded main query; delayed/same-file activation preserves unsaved buffers", async () => {
  const fileRequests: string[] = [], navigations: string[] = [];
  await withDOM((async (input: string | URL | Request) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/tree")) return Response.json({ root: "/fixture", workspaceId: "binding", bindingRevision: "binding", catalogWorkspaceId: "workspace", worktreeId: "tree", maxFileBytes: 262144 });
    if (url.pathname.endsWith("/file")) { fileRequests.push(url.searchParams.get("path")!); return Response.json({ workspaceId: "binding", path: url.searchParams.get("path"), text: "hello saved\nsecond line", revision: "a".repeat(64), bytes: 23, editable: true, eol: "lf", bom: false }); }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch, async (host, root, browser, cleanup) => {
    resetWorkspaceState();
    catalog.state = { ...catalog.state, ready: false, workspaces: [], navigation: { revision: 0, workspaceId: "workspace", worktreeId: "tree", conversationId: null, view: "code", filePath: "notes.md", comparison: null } };
    let controller: ReturnType<typeof useWorkspace>;
    function Probe() { controller = useWorkspace(); return <><WorkspaceSearchButton /><WorkspaceSearchPanel><div>Existing file view</div></WorkspaceSearchPanel></>; }
    await act(async () => root.render(<ApplicationCommandProvider><WorkspaceProvider view="code" navigate={view => navigations.push(view)}><WorkspaceSearchFeature><Probe /></WorkspaceSearchFeature></WorkspaceProvider></ApplicationCommandProvider>));
    const opener = host.querySelector<HTMLButtonElement>('[aria-label="Search saved files"]')!;
    expect(opener.disabled).toBe(false); expect(opener.querySelector("kbd")!.textContent).toBeTruthy(); opener.focus();
    await act(async () => opener.click()); expect(host.querySelector("dialog")).toBeNull();
    const query = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(document.activeElement === query).toBe(true);
    expect(host.textContent).not.toContain("Existing file view");
    expect(host.textContent).toContain("Unsaved buffers are not searched or replaced");
    const mac = /Mac|iPhone|iPad|iPod/i.test(browser.navigator.platform);
    const key = new browser.KeyboardEvent("keydown", { key: "F", metaKey: mac, ctrlKey: !mac, shiftKey: true, bubbles: true, cancelable: true });
    opener.focus();
    await act(async () => opener.dispatchEvent(key as unknown as Event)); expect(key.defaultPrevented).toBe(true);
    expect(document.activeElement === query).toBe(true); expect(host.querySelector("dialog")).toBeNull();
    // Opening search always navigates through the shell seam, even when already in code.
    expect(navigations).toEqual(["code", "code"]); navigations.length = 0;
    const buffer = controller!.buffer!;
    await act(async () => { buffer.state = buffer.state.update({ changes: { from: buffer.state.doc.length, insert: "\nunsaved" } }).state; notifyWorkspace(); });
    const location = { path: "notes.md", line: 1, column: 1, endColumn: 6, preview: "hello saved", query: "hello" };
    await act(async () => controller!.activate({ view: "code", path: "notes.md", location }));
    const dispatches: any[] = []; let focuses = 0;
    const view = { dispatch: (transaction: any) => { dispatches.push(transaction); buffer.state = buffer.state.update({ selection: transaction.selection }).state; }, focus: () => focuses++ } as unknown as EditorView;
    cleanup(() => buffer.attach(null));
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

test("embedded search filters sidebar files, groups main previews, preserves results/scroll, and navigates matches without refetching or losing unsaved edits", async () => {
  const searches: { input: any; pending: ReturnType<typeof Promise.withResolvers<Response>> }[] = [];
  let artifactOpen = true;
  await withDOM((async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/tree")) return Response.json({ root: "/fixture", workspaceId: "binding", bindingRevision: "binding", catalogWorkspaceId: "workspace", worktreeId: "tree", maxFileBytes: 262144 });
    if (url.pathname.endsWith("/file")) return Response.json({ workspaceId: "binding", path: "notes.md", text: "hello saved\nhello again", revision: "a".repeat(64), bytes: 23, editable: true, eol: "lf", bom: false });
    if (url.pathname.endsWith("/list")) return Response.json({ workspaceId: "binding", path: "", entries: [{ kind: "file", path: "notes.md", name: "notes.md" }, { kind: "file", path: "unmatched.txt", name: "unmatched.txt" }], truncated: false });
    if (url.pathname.endsWith("/search")) { const pending = Promise.withResolvers<Response>(); searches.push({ input: JSON.parse(String(init?.body)), pending }); return pending.promise; }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch, async (host, root, browser, cleanup) => {
    resetWorkspaceState();
    catalog.state = { ...catalog.state, ready: false, workspaces: [], navigation: { revision: 0, workspaceId: "workspace", worktreeId: "tree", conversationId: null, view: "code", filePath: "notes.md", comparison: null } };
    let controller: ReturnType<typeof useWorkspace>;
    function Probe() { controller = useWorkspace(); return <><WorkspaceSearchButton /><aside><FilesModeControl activeView="code" onNavigate={() => {}} /><WorkspaceSidebar /></aside><main><WorkspaceSearchPanel><div data-testid="existing-editor">Existing file view</div></WorkspaceSearchPanel></main></>; }
    await act(async () => root.render(<ApplicationCommandProvider><WorkspaceProvider view="code" navigate={() => { artifactOpen = false; }}><WorkspaceSearchFeature><Probe /></WorkspaceSearchFeature></WorkspaceProvider></ApplicationCommandProvider>));
    await waitForElement(host.querySelector("aside")!, '[role="treeitem"][title="unmatched.txt"]');
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
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-expanded="false"]')!.click());
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
      { path: "src/other.md", line: 1, column: 1, endColumn: 6, preview: "hello other" },
    ], skippedFiles: 2, truncated: true })));
    expect(host.querySelectorAll(".workspace-search-results section")).toHaveLength(2);
    const sidebar = host.querySelector("aside")!;
    expect(sidebar.querySelectorAll('[role="treeitem"]')).toHaveLength(3);
    expect(sidebar.textContent).toContain("src"); expect(sidebar.textContent).toContain("other.md");
    expect(sidebar.textContent).not.toContain("hello saved"); expect(sidebar.textContent).not.toContain("hello other"); expect(sidebar.textContent).not.toContain("unmatched.txt");
    const folder = sidebar.querySelector<HTMLButtonElement>('[title="src"]')!;
    await act(async () => folder.focus());
    await act(async () => folder.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }) as unknown as Event));
    expect(sidebar.querySelectorAll('[role="treeitem"]')).toHaveLength(2);
    await act(async () => folder.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }) as unknown as Event));
    expect(sidebar.querySelectorAll('[role="treeitem"]')).toHaveLength(3);
    await act(async () => folder.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }) as unknown as Event));
    expect(document.activeElement).toBe(sidebar.querySelector('[title="src/other.md"]'));
    expect(host.textContent).toContain("2 files skipped"); expect(host.textContent).toContain("Results truncated");
    const results = host.querySelectorAll<HTMLButtonElement>(".workspace-search-results button");
    const resultList = host.querySelector<HTMLDivElement>(".workspace-search-results")!;
    resultList.scrollTop = 120;
    await act(async () => resultList.dispatchEvent(new browser.Event("scroll", { bubbles: true }) as unknown as Event));
    await act(async () => query.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }) as unknown as Event));
    expect(document.activeElement === results[0]).toBe(true);
    await act(async () => results[0]!.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }) as unknown as Event));
    expect(document.activeElement === results[1]).toBe(true);
    await act(async () => results[1]!.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event));
    expect(host.querySelector("dialog")).toBeNull(); expect(artifactOpen).toBe(false);
    expect(resultList.hidden).toBe(true); expect(host.querySelector('[data-testid="existing-editor"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Current file match"]')!.textContent).toBe("2 of 2");
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Next match"]')!.disabled).toBe(true);
    expect(sidebar.querySelector('[aria-selected="true"]')!.getAttribute("title")).toBe("notes.md");
    expect(controller!.buffer).toBe(buffer); expect(dirty(buffer)).toBe(true); expect(buffer.state.doc.toString()).toContain("unsaved");
    let focused = false;
    cleanup(() => buffer.attach(null));
    await act(async () => buffer.attach({ dispatch: (transaction: any) => { buffer.state = buffer.state.update({ selection: transaction.selection }).state; }, focus: () => { focused = true; } } as unknown as EditorView));
    expect(focused).toBe(true); expect(buffer.state.selection.main.from).toBe(12); expect(buffer.state.sliceDoc(buffer.state.selection.main.from, buffer.state.selection.main.to)).toBe("hello");
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Previous match"]')!.click());
    expect(buffer.state.selection.main.from).toBe(0); expect(host.querySelector('[aria-label="Current file match"]')!.textContent).toBe("1 of 2");
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Next match"]')!.click());
    expect(buffer.state.selection.main.from).toBe(12);
    const escape = new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    focused = false;
    await act(async () => query.dispatchEvent(escape as unknown as Event));
    expect(focused).toBe(true); expect(host.querySelector<HTMLInputElement>('input[type="search"]')).toBe(query);
    const allResults = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "All results")!;
    allResults.focus();
    await act(async () => allResults.click());
    expect(resultList.hidden).toBe(false); expect(resultList.scrollTop).toBe(120);
    expect(host.querySelector('[data-testid="existing-editor"]')).toBeNull(); expect(host.querySelectorAll(".workspace-search-results section")).toHaveLength(2);
    expect(document.activeElement).toBe(results[1]); // Explicit All results hands focus back without scrolling.
    await act(async () => sidebar.querySelector<HTMLButtonElement>('[title="notes.md"]')!.click());
    expect(buffer.state.selection.main.from).toBe(0); // Sidebar file opens its first match.
    const fileMode = sidebar.querySelector<HTMLButtonElement>('.workspace-search-modes button')!;
    await act(async () => fileMode.click());
    await waitForElement(sidebar, '[role="treeitem"][title="unmatched.txt"]');
    expect(host.querySelector('input[type="search"]')).toBeNull(); expect(sidebar.textContent).toContain("unmatched.txt");
    expect(host.querySelector('[data-testid="existing-editor"]')).not.toBeNull();
    await act(async () => sidebar.querySelectorAll<HTMLButtonElement>('.workspace-search-modes button')[1]!.click());
    expect(host.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe("hello");
    await waitForSearch(); expect(searches).toHaveLength(3);
    expect(dirty(buffer)).toBe(true); expect(controller!.buffer).toBe(buffer);
    // An option change fences visible results immediately, even before its debounce fires.
    await act(async () => host.querySelector<HTMLInputElement>('[aria-label="Case sensitive"]')!.click());
    expect(host.querySelectorAll(".workspace-search-results section")).toHaveLength(0);
    expect(sidebar.querySelectorAll('[role="treeitem"]')).toHaveLength(0);
    expect(host.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe("hello");
    await type(host.querySelector<HTMLInputElement>('input[type="search"]')!, "new query");
    expect(host.querySelectorAll(".workspace-search-results section")).toHaveLength(0);
    expect(sidebar.querySelectorAll('[role="treeitem"]')).toHaveLength(0);
    expect(host.querySelector('[data-testid="existing-editor"]')).toBeNull(); expect(host.textContent).toContain("Searching saved files");
    await act(async () => buffer.attach(null));
  });
});

test("match identities include path and both coordinates, independent of ordering or preview", () => {
  const match: WorkspaceSearchMatch = { path: "src/a.ts", line: 4, column: 2, endColumn: 6, preview: "match" };
  expect(searchMatchId(match)).toBe(searchMatchId({ ...match, preview: "new preview" }));
  for (const change of [{ path: "src/b.ts" }, { line: 5 }, { column: 3 }, { endColumn: 7 }]) expect(searchMatchId({ ...match, ...change })).not.toBe(searchMatchId(match));
});

test("delayed acquisition survives repeated search shortcuts and next/previous selection uses the cached buffer", async () => {
  const file = Promise.withResolvers<Response>(); let searches = 0, fileRequests = 0;
  await withDOM((async (input: string | URL | Request) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/tree")) return Response.json({ root: "/fixture", workspaceId: "binding", bindingRevision: "binding", catalogWorkspaceId: "workspace", worktreeId: "tree", maxFileBytes: 262144 });
    // Each real HTTP request owns a fresh response body, including later refreshes.
    // Reusing the consumed acquisition Response made refresh parse {} and erase a clean buffer.
    if (url.pathname.endsWith("/file")) { fileRequests++; return (await file.promise).clone(); }
    if (url.pathname.endsWith("/search")) {
      searches++;
      return Response.json({ ...result("hello"), matches: [{ path: "notes.md", line: 1, column: 1, endColumn: 6, preview: "hello saved" }, { path: "notes.md", line: 2, column: 1, endColumn: 6, preview: "hello again" }] });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch, async (host, root, browser, cleanup) => {
    catalog.state = { ...catalog.state, ready: false, workspaces: [], navigation: { revision: 0, workspaceId: "workspace", worktreeId: "tree", conversationId: null, view: "code", filePath: "", comparison: null } };
    let controller: ReturnType<typeof useWorkspace>;
    function Probe() { controller = useWorkspace(); return <><WorkspaceSearchButton /><WorkspaceSearchPanel><p>{controller.opening ? "Opening file…" : "Existing file editor"}</p></WorkspaceSearchPanel></>; }
    await act(async () => root.render(<ApplicationCommandProvider><WorkspaceProvider view="code" navigate={() => {}}><WorkspaceSearchFeature><Probe /></WorkspaceSearchFeature></WorkspaceProvider></ApplicationCommandProvider>));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Search saved files"]')!.click());
    const query = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(query, "hello"); query.dispatchEvent(new browser.Event("input", { bubbles: true }) as unknown as Event); });
    await waitForSearch();
    await act(async () => host.querySelectorAll<HTMLButtonElement>('.workspace-search-results button')[1]!.click());
    expect(controller!.opening).toBe(true); expect(host.textContent).toContain("Opening file…");
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Next match"]')!.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Previous match"]')!.disabled).toBe(true);
    const mac = /Mac|iPhone|iPad|iPod/i.test(browser.navigator.platform);
    for (let index = 0; index < 2; index++) {
      const shortcut = new browser.KeyboardEvent("keydown", { key: "F", metaKey: mac, ctrlKey: !mac, shiftKey: true, bubbles: true, cancelable: true });
      await act(async () => query.dispatchEvent(shortcut as unknown as Event));
      expect(shortcut.defaultPrevented).toBe(true); expect(document.activeElement).toBe(query);
      expect(controller!.opening).toBe(true); expect(fileRequests).toBe(1);
    }
    await act(async () => query.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event));
    expect(document.activeElement?.textContent).toBe("All results");
    await act(async () => file.resolve(Response.json({ workspaceId: "binding", path: "notes.md", text: "hello saved\nhello again", revision: "a".repeat(64), bytes: 23, editable: true, eol: "lf", bom: false })));
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Previous match"]')!.disabled).toBe(false);
    const buffer = controller!.buffer!;
    const selections: number[] = [];
    cleanup(() => buffer.attach(null));
    await act(async () => buffer.attach({ dispatch: (transaction: any) => { selections.push(transaction.selection.anchor); buffer.state = buffer.state.update({ selection: transaction.selection }).state; }, focus: () => {} } as unknown as EditorView));
    expect(buffer.state.selection.main.from).toBe(12); // Original pending match, not just the default cursor at zero.
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Previous match"]')!.click());
    expect(buffer.state.selection.main.from).toBe(0);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Next match"]')!.click());
    expect(buffer.state.selection.main.from).toBe(12); expect(searches).toBe(1);
    expect(controller!.buffer).toBe(buffer); expect(buffer.state.doc.toString()).toBe("hello saved\nhello again");
    expect(selections).toEqual([12, 0, 12]);
    await act(async () => buffer.attach(null));
  });
});

test("real header/editor integration preserves search and local editor state across Copy, New file and Git Open in Files", async () => {
  const saved = "hello saved\nhello again", revision = "a".repeat(64);
  const files = new Map([["notes.md", saved], ["changed.txt", "changed saved"]]);
  let searches = 0;
  const writes: { route: string; input: any }[] = [];
  await withDOM((async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost"), route = url.pathname.split("/").at(-1)!;
    const fileResult = (path: string) => ({ workspaceId: "binding", path, text: files.get(path), revision, bytes: files.get(path)!.length, editable: true, eol: "lf", bom: false });
    if (route === "tree") return Response.json({ root: "/fixture", workspaceId: "binding", bindingRevision: "binding", catalogWorkspaceId: "workspace", worktreeId: "tree", maxFileBytes: 262144 });
    if (route === "search") {
      searches++;
      return Response.json({ ...result("hello"), matches: [{ path: "notes.md", line: 1, column: 1, endColumn: 6, preview: "hello saved" }, { path: "notes.md", line: 2, column: 1, endColumn: 6, preview: "hello again" }] });
    }
    if (init?.method === "POST" && (route === "copy" || route === "file")) {
      const body = JSON.parse(String(init.body)); writes.push({ route, input: body });
      const path = route === "copy" ? body.destination : body.path;
      files.set(path, route === "copy" ? files.get(body.path)! : "");
      return Response.json(fileResult(path), { status: 201 });
    }
    if (route === "file") return Response.json(fileResult(url.searchParams.get("path")!));
    if (route === "git") return Response.json({ workspaceId: "binding", available: true, entries: [{ path: "changed.txt", comparisons: ["unstaged"], index: " ", worktree: "M" }], truncated: false });
    // A same-text comparison still permits the existing Open in Files action,
    // without introducing an unrelated diff-editor fixture into this checkpoint.
    if (route === "diff") return Response.json({ workspaceId: "binding", path: "changed.txt", comparison: "unstaged", beforeMode: "100644", afterMode: "100644", before: "changed saved", after: "changed saved", modeOnly: false });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch, async (host, root, browser) => {
    catalog.state = { ...catalog.state, ready: false, workspaces: [], navigation: { revision: 0, workspaceId: "workspace", worktreeId: "tree", conversationId: null, view: "code", filePath: "notes.md", comparison: null } };
    let controller: ReturnType<typeof useWorkspace>, search: NonNullable<ReturnType<typeof useWorkspaceSearchContext>>;
    function Probe() { controller = useWorkspace(); search = useWorkspaceSearchContext()!; return <><header><WorkspaceHeader /><WorkspaceSearchButton /></header><WorkspaceView /></>; }
    function Harness() {
      const [view, setView] = useState<"code" | "git">("code");
      return <ApplicationCommandProvider><WorkspaceProvider view={view} navigate={next => setView(next as "code" | "git")}><WorkspaceSearchFeature><Probe /></WorkspaceSearchFeature></WorkspaceProvider></ApplicationCommandProvider>;
    }
    await act(async () => root.render(<Harness />));
    const original = controller!.buffer!, originalView = original.view!;
    expect(originalView.contentDOM.isConnected).toBe(true);
    await act(async () => originalView.dispatch({ changes: { from: original.state.doc.length, insert: "\nunsaved local" } }));
    expect(dirty(original)).toBe(true); expect(original.state).toBe(originalView.state);
    const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === label)!;
    const type = (input: HTMLInputElement, value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new browser.Event("input", { bubbles: true }) as unknown as Event);
    });
    const enter = () => act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Search saved files"]')!.click());
    await enter();
    expect(original.view).toBeNull(); expect(host.querySelector(".cm-editor")).toBeNull();
    await type(host.querySelector<HTMLInputElement>('input[type="search"]')!, "hello"); await waitForSearch();
    expect(document.activeElement).toBe(host.querySelector('input[type="search"]')); // A response must not steal focus.
    const retainedResult = search!.state.result;
    const matches = host.querySelectorAll<HTMLButtonElement>(".workspace-search-results button");
    const list = host.querySelector<HTMLDivElement>(".workspace-search-results")!;
    list.scrollTop = 120;
    await act(async () => list.dispatchEvent(new browser.Event("scroll", { bubbles: true }) as unknown as Event));
    let resultScrolls = 0; matches[1]!.scrollIntoView = () => { resultScrolls++; };
    await act(async () => matches[1]!.click());
    expect(controller!.buffer).toBe(original); expect(original.view).not.toBe(originalView);
    expect(original.view!.contentDOM.isConnected).toBe(true); expect(original.view!.state).toBe(original.state);
    expect(original.state.selection.main.from).toBe(12); expect(original.state.sliceDoc(12, 17)).toBe("hello");
    expect(original.state.doc.toString()).toBe(`${saved}\nunsaved local`);
    await act(async () => button("All results").focus());
    await act(async () => button("All results").click());
    expect(document.activeElement).toBe(matches[1]); expect(list.scrollTop).toBe(120); expect(resultScrolls).toBe(0);
    expect(original.view).toBeNull(); expect(search!.state.result).toBe(retainedResult);
    await act(async () => matches[1]!.click());
    const cachedView = original.view!;
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Previous match"]')!.click());
    expect(original.state.selection.main.from).toBe(0);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Next match"]')!.click());
    expect(original.state.selection.main.from).toBe(12); expect(original.view).toBe(cachedView); expect(original.view!.state).toBe(original.state);

    // Even a same-path non-search activation means Files: this cannot be inferred
    // correctly from whether selected happens to equal the last result's path.
    await act(async () => controller!.activate({ view: "code", path: "notes.md" }));
    expect(search!.mode).toBe("files"); expect(host.querySelector('input[type="search"]')).toBeNull();
    expect(controller!.buffer).toBe(original); expect(original.state.selection.main.from).toBe(12); expect(dirty(original)).toBe(true);
    await enter();
    expect(search!.mode).toBe("search"); expect(original.view!.contentDOM.isConnected).toBe(true);
    expect(search!.state.result).toBe(retainedResult);

    // Actual header Copy dialog invokes controller.mutateFile -> a Files activation.
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="File actions"]')!.click());
    await act(async () => button("Copy file").click());
    await act(async () => host.querySelector("form")!.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
    expect(writes[0]).toEqual({ route: "copy", input: { workspaceId: "binding", path: "notes.md", destination: "notes-copy.md", expectedRevision: revision } });
    expect(search!.mode).toBe("files"); expect(controller!.selected).toBe("notes-copy.md");
    expect(controller!.buffer!.view!.contentDOM.isConnected).toBe(true); expect(controller!.buffer!.view!.state.doc.toString()).toBe(saved);
    expect(host.querySelector('input[type="search"]')).toBeNull(); expect(search!.options.query).toBe("hello"); expect(search!.state.result).toBe(retainedResult);
    expect(dirty(original)).toBe(true); expect(original.state.doc.toString()).toContain("unsaved local");

    // Re-entering keeps the previous search, then New file opens an unmatched file.
    await enter(); expect(search!.state.result).toBe(retainedResult);
    await act(async () => host.querySelector<HTMLButtonElement>('.workspace-search-results button')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="File actions"]')!.click());
    await act(async () => button("New file").click());
    await type(host.querySelector<HTMLInputElement>('#file-destination')!, "docs/new.md");
    await act(async () => host.querySelector("form")!.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
    expect(writes[1]).toEqual({ route: "file", input: { workspaceId: "binding", path: "docs/new.md" } });
    expect(search!.mode).toBe("files"); expect(controller!.selected).toBe("docs/new.md");
    expect(controller!.buffer!.view!.contentDOM.isConnected).toBe(true); expect(controller!.buffer!.view!.state.doc.toString()).toBe("");
    expect(search!.options.query).toBe("hello"); expect(search!.state.result).toBe(retainedResult);

    // Git Open in Files is another explicit file intent, not a search match.
    await enter();
    await act(async () => controller!.activate({ view: "git", path: "changed.txt", comparison: "unstaged" }));
    expect(search!.mode).toBe("search"); expect(controller!.view).toBe("git");
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Change actions"]')!.click());
    await act(async () => button("Open in Files").click());
    expect(controller!.view).toBe("code"); expect(controller!.selected).toBe("changed.txt"); expect(search!.mode).toBe("files");
    expect(controller!.buffer!.view!.contentDOM.isConnected).toBe(true); expect(controller!.buffer!.view!.state.doc.toString()).toBe("changed saved");
    expect(host.querySelector('input[type="search"]')).toBeNull(); expect(search!.options.query).toBe("hello"); expect(search!.state.result).toBe(retainedResult);
    expect(controller!.root!.buffers.get("notes.md")).toBe(original); expect(dirty(original)).toBe(true); expect(searches).toBe(1);
  });
});

test("Git opener enters code/search and repeated shortcuts focus the same query without duplicate requests", async () => {
  const navigations: string[] = [];
  await withDOM((async (input: string | URL | Request) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/tree")) return Response.json({ root: "/fixture", workspaceId: "binding", bindingRevision: "binding", catalogWorkspaceId: "workspace", worktreeId: "tree", maxFileBytes: 262144 });
    if (url.pathname.endsWith("/git")) return Response.json({ workspaceId: "binding", available: true, entries: [], truncated: false });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch, async (host, root, browser) => {
    catalog.state = { ...catalog.state, ready: false, workspaces: [], navigation: { revision: 0, workspaceId: "workspace", worktreeId: "tree", conversationId: null, view: "git", filePath: "", comparison: null } };
    let search: ReturnType<typeof useWorkspaceSearchContext>;
    function Probe() { search = useWorkspaceSearchContext(); return <><WorkspaceSearchButton /><WorkspaceSearchPanel><p>Normal workspace</p></WorkspaceSearchPanel></>; }
    function Harness() {
      const [view, setView] = useState<"code" | "git">("git");
      return <ApplicationCommandProvider><WorkspaceProvider view={view} navigate={next => { navigations.push(next); setView(next as "code" | "git"); }}><WorkspaceSearchFeature><Probe /></WorkspaceSearchFeature></WorkspaceProvider></ApplicationCommandProvider>;
    }
    await act(async () => root.render(<Harness />));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Search saved files"]')!.click());
    expect(navigations).toEqual(["code"]); expect(search!.mode).toBe("search");
    const query = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(document.activeElement === query).toBe(true);
    const mac = /Mac|iPhone|iPad|iPod/i.test(browser.navigator.platform);
    const key = new browser.KeyboardEvent("keydown", { key: "F", metaKey: mac, ctrlKey: !mac, shiftKey: true, bubbles: true, cancelable: true });
    await act(async () => query.dispatchEvent(key as unknown as Event));
    expect(key.defaultPrevented).toBe(true); expect(navigations).toEqual(["code", "code"]);
    expect(host.querySelector('input[type="search"]')).toBe(query); expect(document.activeElement === query).toBe(true);
  });
});

test("binding revision, worktree and auth changes synchronously hide search, abort pending requests, and fence old activations/responses", async () => {
  const searches: { signal: AbortSignal; pending: ReturnType<typeof Promise.withResolvers<Response>> }[] = [];
  let revision = "binding", tree = "tree";
  let resolution: ReturnType<typeof Promise.withResolvers<Response>> | undefined;
  await withDOM((async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith(`/worktrees/${tree}`)) {
      if (resolution) return resolution.promise;
      return Response.json({ root: `/fixture/${tree}`, workspaceId: revision, bindingRevision: revision, catalogWorkspaceId: "workspace", worktreeId: tree, maxFileBytes: 262144 });
    }
    if (url.pathname.endsWith("/search")) { const pending = Promise.withResolvers<Response>(); searches.push({ signal: init!.signal as AbortSignal, pending }); return pending.promise; }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch, async (host, root, browser) => {
    const workspaces = () => [{ workspaceId: "workspace", kind: "directory" as const, name: "fixture", commonDir: null, worktrees: [{ worktreeId: tree, root: `/fixture/${tree}`, gitDir: null, bindingRevision: revision, state: "available" as const }] }];
    catalog.state = { ...catalog.state, ready: false, workspaces: workspaces(), navigation: { revision: 0, workspaceId: "workspace", worktreeId: tree, conversationId: null, view: "code", filePath: "", comparison: null } };
    let controller: ReturnType<typeof useWorkspace>;
    const renders: { revision: string; scope?: string; count: number; query: string }[] = [];
    function Probe() {
      controller = useWorkspace(); const search = useWorkspaceSearchContext()!;
      renders.push({ revision, scope: controller.scope?.bindingRevision, count: search.matches.length, query: search.options.query });
      return <><input data-testid="retained-draft" defaultValue="draft" /><WorkspaceSearchButton /><WorkspaceSearchPanel><div>Normal file view</div></WorkspaceSearchPanel></>;
    }
    await act(async () => root.render(<ApplicationCommandProvider><WorkspaceProvider view="code" navigate={() => {}}><WorkspaceSearchFeature><Probe /></WorkspaceSearchFeature></WorkspaceProvider></ApplicationCommandProvider>));
    const typeQuery = async (value: string) => {
      const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
      await act(async () => { Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new browser.Event("input", { bubbles: true }) as unknown as Event); });
    };
    const enter = () => act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Search saved files"]')!.click());
    await enter(); await typeQuery("hello"); await waitForSearch();
    await act(async () => searches[0]!.pending.resolve(Response.json(result("hello"))));
    expect(host.querySelectorAll(".workspace-search-results section")).toHaveLength(1);
    const oldActivate = controller!.activate;
    const draft = host.querySelector<HTMLInputElement>('[data-testid="retained-draft"]')!;
    draft.value = "native unsent draft";
    await typeQuery("pending"); await waitForSearch();
    revision = "new-binding"; resolution = Promise.withResolvers<Response>();
    await act(async () => { catalog.state = { ...catalog.state, workspaces: workspaces() }; catalog.navigate({}); });
    expect(searches[1]!.signal.aborted).toBe(true); expect(controller!.scope).toBeUndefined();
    expect(host.querySelector('input[type="search"]')).toBeNull();
    expect(host.querySelector('[data-testid="retained-draft"]')).toBe(draft); expect(draft.value).toBe("native unsent draft");
    expect(renders.filter(render => render.revision === revision).every(render => render.scope === undefined && render.count === 0 && render.query === "")).toBe(true);
    await act(async () => oldActivate({ view: "code", path: "stale.md" }));
    expect(catalog.state.navigation.filePath).toBe("");
    await act(async () => searches[1]!.pending.resolve(Response.json(result("old binding"))));
    expect(host.textContent).not.toContain("old binding");
    await act(async () => resolution!.resolve(Response.json({ root: `/fixture/${tree}`, workspaceId: revision, bindingRevision: revision, catalogWorkspaceId: "workspace", worktreeId: tree, maxFileBytes: 262144 })));
    resolution = undefined;
    expect(controller!.scope!.bindingRevision).toBe(revision);
    await enter(); await typeQuery("auth pending"); await waitForSearch();
    await act(async () => invalidateWorkspaceRequests());
    expect(searches[2]!.signal.aborted).toBe(true); expect(host.querySelector('input[type="search"]')).toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Search saved files"]')!.disabled).toBe(true);
    await act(async () => searches[2]!.pending.resolve(Response.json(result("old auth"))));
    expect(host.textContent).not.toContain("old auth");
    tree = "other";
    await act(async () => { catalog.state = { ...catalog.state, workspaces: workspaces() }; catalog.navigate({ worktreeId: tree }); });
    await enter(); await typeQuery("worktree pending"); await waitForSearch();
    tree = "third";
    await act(async () => { catalog.state = { ...catalog.state, workspaces: workspaces() }; catalog.navigate({ worktreeId: tree }); });
    expect(searches[3]!.signal.aborted).toBe(true); expect(host.querySelector('input[type="search"]')).toBeNull();
    await act(async () => searches[3]!.pending.resolve(Response.json(result("old worktree"))));
    expect(host.textContent).not.toContain("old worktree"); expect(controller!.scope!.workspace.worktreeId).toBe("third");
  });
});

test("DOM harness detaches fake editors and restores globals after an assertion failure", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window"), previousFetch = globalThis.fetch;
  const failure = new Error("deliberate failed assertion");
  let buffer: NonNullable<ReturnType<typeof useWorkspace>["buffer"]> | undefined, detached = false, caught: unknown;
  try {
    await withDOM((async (input: string | URL | Request) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("/tree")) return Response.json({ root: "/fixture", workspaceId: "binding", bindingRevision: "binding", catalogWorkspaceId: "workspace", worktreeId: "tree", maxFileBytes: 262144 });
      if (url.pathname.endsWith("/file")) return Response.json({ workspaceId: "binding", path: "notes.md", text: "hello", revision: "a".repeat(64), bytes: 5, editable: true, eol: "lf", bom: false });
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch, async (_host, root, _browser, cleanup) => {
      catalog.state = { ...catalog.state, ready: false, workspaces: [], navigation: { revision: 0, workspaceId: "workspace", worktreeId: "tree", conversationId: null, view: "code", filePath: "notes.md", comparison: null } };
      function Probe() { buffer = useWorkspace().buffer; return null; }
      await act(async () => root.render(<WorkspaceProvider view="code" navigate={() => {}}><Probe /></WorkspaceProvider>));
      const acquired = buffer!;
      cleanup(() => { acquired.attach(null); detached = true; });
      await act(async () => acquired.attach({ focus: () => {} } as unknown as EditorView));
      expect(acquired.view).not.toBeNull();
      throw failure;
    });
  } catch (error) { caught = error; }
  expect(caught).toBe(failure); expect(detached).toBe(true); expect(buffer!.view).toBeNull();
  expect(Object.getOwnPropertyDescriptor(globalThis, "window")?.value).toBe(previousWindow?.value);
  expect(globalThis.fetch).toBe(previousFetch);
});
