import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { catalog } from "./catalog";
import { configSection } from "./config-view";
import { store } from "./store";
import type { Conversation } from "./types";
import { publishWorkers, registerWorkerSessions, workersFor } from "./worker-client";

const workspaceId = "app-navigation-workspace", worktreeId = "app-navigation-tree";
const conversation = (id: string, title: string): Conversation => ({
  id, title, harness: "claude-code", cwd: "/navigation-fixture", status: "completed", lastRunId: null,
  workspaceId, worktreeId, association: "resolved", availability: { canSend: true },
});
const live = conversation("app-navigation-live", "Live conversation");
const preview = conversation("app-navigation-preview", "Preview conversation");
type RequestRecord = { path: string; method: string; body?: string };
type Fixture = { browser: Window; host: HTMLDivElement; requests: RequestRecord[]; sends: () => number };

/** Snapshot own fields as well as public state: real Open in Chat starts store polling. */
function preserveOwnFields(target: object) {
  const descriptors = Object.getOwnPropertyDescriptors(target);
  for (const descriptor of Object.values(descriptors)) {
    if (descriptor.value instanceof Map) descriptor.value = new Map(descriptor.value);
  }
  return () => {
    for (const key of Object.keys(target)) if (!(key in descriptors)) Reflect.deleteProperty(target, key);
    Object.defineProperties(target, descriptors);
  };
}

async function withApp(run: (fixture: Fixture) => Promise<void>, options: { empty?: boolean; replaced?: boolean; historyError?: boolean } = {}) {
  const browser = new Window({ url: "http://localhost" });
  const requests: RequestRecord[] = [], unexpected: string[] = [];
  const restoreStore = preserveOwnFields(store), restoreCatalog = preserveOwnFields(catalog);
  const previousState = store.state, previousSection = configSection.snapshot();
  const previousWorkers = [live, preview].map(c => [c.id, workersFor(c.id)] as const);
  const nativeSetTimeout = globalThis.setTimeout, nativeClearTimeout = globalThis.clearTimeout;
  const nativeSetInterval = globalThis.setInterval, nativeClearInterval = globalThis.clearInterval;
  const timeouts = new Set<ReturnType<typeof setTimeout>>(), intervals = new Set<ReturnType<typeof setInterval>>();
  let sendCount = 0;
  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
    const method = init?.method ?? "GET";
    requests.push({ path: url.pathname + url.search, method, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.origin !== "http://localhost") unexpected.push(`External request: ${url}`);
    if (method === "PUT" && url.pathname === "/api/navigation") {
      const { expectedRevision, ...bookmark } = JSON.parse(String(init?.body));
      return Response.json({ ...bookmark, revision: expectedRevision + 1 });
    }
    if (method === "GET") {
      if (url.pathname === "/api/sessions") return Response.json({
        sessions: store.state.conversations.map(({ id, status, ...c }) => ({ ...c, sessionId: id, lastStatus: status })), availability: { canSend: true },
      });
      if ([live, preview].some(c => url.pathname === `/api/sessions/${c.id}/runs`)) {
        if (options.historyError) return Response.json({ error: "Recorded runs unavailable" }, { status: 503 });
        return Response.json({ runs: [] });
      }
      if ([live, preview].some(c => url.pathname === `/api/sessions/${c.id}/workers`)) return Response.json({ workers: [], deliveries: [], continuationSuppressed: false });
      if ([live, preview].some(c => url.pathname === `/api/sessions/${c.id}/native-history`)) return Response.json({ history: null });
      if ([live, preview].some(c => url.pathname === `/api/sessions/${c.id}/interactions`)) return Response.json({ interactions: [] });
      if (url.pathname === "/api/workstreams/overview" && url.searchParams.get("workspaceId") === workspaceId) return Response.json({ repositoryId: "navigation-domain", workstreams: [], conversations: [] });
      if (url.pathname === "/api/workstreams/inspect" && url.searchParams.get("workspaceId") === workspaceId) return Response.json({ error: "Repository inspection unavailable" }, { status: 503 });
      // A deliberate, realistic unavailable binding exercises the actual Files/Git error surfaces,
      // without populating the process-wide editor buffer cache or loading CodeMirror DOM editors.
      if ([worktreeId, "other-tree"].some(id => url.pathname === `/api/workspaces/${workspaceId}/worktrees/${id}`)) return Response.json({ error: "Fixture worktree unavailable", code: "workspace-changed" }, { status: 409 });
    }
    unexpected.push(`${method} ${url.pathname}${url.search}`);
    throw new Error(`Unexpected request: ${method} ${url.pathname}${url.search}`);
  };
  const globals = {
    window: browser, self: browser, document: browser.document, navigator: browser.navigator,
    localStorage: browser.localStorage, HTMLElement: browser.HTMLElement, Event: browser.Event,
    MouseEvent: browser.MouseEvent, FormData: browser.FormData, ResizeObserver: browser.ResizeObserver,
    MutationObserver: browser.MutationObserver, requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true, fetch: fetcher,
    WebSocket: class { constructor() { unexpected.push("WebSocket connection"); throw new Error("Unexpected WebSocket connection"); } },
    setTimeout: ((...args: Parameters<typeof setTimeout>) => { const timer = nativeSetTimeout(...args); timeouts.add(timer); return timer; }) as typeof setTimeout,
    setInterval: ((...args: Parameters<typeof setInterval>) => { const timer = nativeSetInterval(...args); intervals.add(timer); return timer; }) as typeof setInterval,
  };
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let root: Root | undefined;
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  try {
    catalog.invalidate();
    catalog.state = { ready: true, loading: false, error: "", workspaces: options.empty ? [] : [{
      workspaceId, kind: "repository", name: "Navigation fixture", commonDir: "/navigation-fixture/.git",
      worktrees: [
        { worktreeId, root: "/navigation-fixture", gitDir: "/navigation-fixture/.git", bindingRevision: "navigation-binding", state: "available", branch: "refs/heads/main" },
        { worktreeId: "other-tree", root: "/navigation-other", gitDir: "/navigation-other/.git", bindingRevision: "other-binding", state: "available", branch: "refs/heads/feature" },
      ],
    }], navigation: { revision: 0, workspaceId: options.empty ? null : workspaceId, worktreeId: options.empty ? null : worktreeId, conversationId: live.id, view: "chat", filePath: null, comparison: null } };
    // Authentication/startup is outside this checkpoint. Selection and navigation remain real.
    store.start = () => {};
    store.send = async () => { sendCount++; throw new Error("Navigation submitted a message"); };
    store.state = { ...previousState, phase: "ready", selected: live.id,
      conversations: options.empty ? [] : [{ ...live, ...(options.replaced ? { replacedBy: preview.id } : {}) }, preview],
      config: { authRequired: false, authenticated: true }, profiles: null, runs: [], messages: [], drafts: {},
      connected: true, loading: false, sending: false, availability: { canSend: true },
      connectionError: "", submissionError: "", authError: "", interactions: [], interactionError: "",
      actionBusy: false, actionNotice: "", models: [], modelsLoading: false, modelsLoaded: false, modelsError: "", modelsCwd: "",
      nativeHistory: null, profileBusy: false, profileError: "",
    };
    registerWorkerSessions(store.state.conversations);
    store.setDraft({ text: "Live draft\nkeep trailing spaces  " });
    configSection.set("agents");
    // App transitively imports xterm, which requires self before module evaluation.
    const [{ App }, { createRoot }] = await Promise.all([import("./app"), import("react-dom/client")]);
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => { root!.render(<App />); });
    await run({ browser, host, requests, sends: () => sendCount });
    expect(unexpected).toEqual([]);
    expect(sendCount).toBe(0);
    expect(requests.filter(request => request.method !== "GET" && !(request.method === "PUT" && request.path === "/api/navigation"))).toEqual([]);
  } finally {
    try { if (root) await act(async () => { root!.unmount(); }); }
    finally {
      // App deliberately does not own the singleton store lifecycle; cancel test-created polling.
      const lifecycle = store as unknown as { stop: () => void };
      lifecycle.stop(); catalog.invalidate();
      for (const timer of timeouts) nativeClearTimeout(timer);
      for (const timer of intervals) nativeClearInterval(timer);
      restoreStore(); restoreCatalog(); configSection.set(previousSection);
      for (const [id, projection] of previousWorkers) publishWorkers(id, projection);
      registerWorkerSessions(previousState.conversations);
      await browser.happyDOM.abort(); browser.close();
      for (const [key, descriptor] of prior) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  }
}

function button(scope: ParentNode, selector: string) {
  const result = scope.querySelector<HTMLButtonElement>(selector);
  expect(result).not.toBeNull();
  return result!;
}
async function click(scope: ParentNode, selector: string) { await act(async () => { button(scope, selector).click(); }); }
function navigation(host: HTMLDivElement) {
  return host.querySelector<HTMLElement>(catalog.state.navigation.view === "chat" ? ".chat-surface .contextual-navigation" : catalog.state.navigation.view === "terminal" ? ".terminal-footer-navigation .contextual-navigation" : ".shell-content-footer .contextual-navigation")!;
}
async function navigate(host: HTMLDivElement, label: string) {
  expect(navigation(host)).not.toBeNull();
  await click(navigation(host), `[aria-label="${label}"]`);
}
function expectNavigation(host: HTMLDivElement, labels: string[]) {
  expect(navigation(host)).not.toBeNull();
  expect([...navigation(host).querySelectorAll("button")].map(b => b.getAttribute("aria-label"))).toEqual(labels);
  expect([...navigation(host).querySelectorAll("button")].every(b => b.type === "button" && !b.disabled)).toBe(true);
}

test("App History replaces the main pane with preview; only explicit Open in Chat changes the live conversation", async () => {
  await withApp(async ({ browser, host, requests }) => {
    const toolbarActions = host.querySelector(".composer-actions")!;
    expect(toolbarActions.firstElementChild?.className).toBe("contextual-navigation");
    expect(toolbarActions.children[1]?.classList.contains("composer-help")).toBe(true);
    expect(toolbarActions.lastElementChild?.getAttribute("aria-label")).toBe("Send message");
    expect((toolbarActions.lastElementChild as HTMLButtonElement).type).toBe("submit");
    const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
    input.focus(); input.setSelectionRange(5, 5);
    await act(async () => { input.dispatchEvent(new browser.CompositionEvent("compositionstart", { bubbles: true }) as unknown as Event); });
    input.value = "Live 日本 draft\nkeep trailing spaces  "; input.setSelectionRange(8, 8);
    await act(async () => { input.dispatchEvent(new browser.InputEvent("input", { bubbles: true, isComposing: true }) as unknown as Event); });
    const draft = { ...store.draft() };
    await click(host, ".sidebar .history-sidebar-button");
    expect(catalog.state.navigation.view).toBe("history");
    expect(host.querySelector(".chat-surface")?.hasAttribute("hidden")).toBe(true);
    expect(host.querySelector("main > .shell-content > .history-detail[aria-label='Session preview']")).not.toBeNull();
    expect(host.querySelector("main .thread")?.closest("[hidden]")).not.toBeNull();
    await click(host, `.sidebar .history-row > button[title^="${preview.title}"]`);
    expect(host.querySelector("main .history-detail h2")?.textContent).toBe(preview.title!);
    expect(store.state.selected).toBe(live.id);
    expect(catalog.state.navigation.conversationId).toBe(live.id);
    expect(store.draft(live.id)).toEqual(draft);
    expect(host.querySelector("textarea")).toBe(input);
    expect(input.value).toBe("Live 日本 draft\nkeep trailing spaces  "); expect(input.selectionStart).toBe(8);
    expect(requests.some(r => r.path === `/api/sessions/${preview.id}/runs`)).toBe(true);
    expectNavigation(host, ["Open Chat", "Terminal", "Files", "Settings"]);
    await navigate(host, "Open Chat");
    expect(store.state.selected).toBe(live.id); expect(host.querySelector("textarea")).toBe(input);
    expect(input.value).toContain("日本"); expect(input.selectionStart).toBe(8);
    await act(async () => { input.dispatchEvent(new browser.CompositionEvent("compositionend", { bubbles: true }) as unknown as Event); });
    await click(host, ".sidebar .history-sidebar-button");
    await click(host, `.sidebar .history-row > button[title^="${preview.title}"]`);
    await click(host, "main .history-detail-actions .primary-button");
    expect(store.state.selected).toBe(preview.id); expect(catalog.state.navigation.view).toBe("chat");
    expect(catalog.state.navigation.conversationId).toBe(preview.id);
    expect(store.draft(live.id).text).toContain("日本");
    expect(host.querySelector(".history-detail")).toBeNull();
  });
});

test("App Terminal Open Chat does not submit or invoke shell actions and preserves the mounted textarea", async () => {
  await withApp(async ({ host, requests, sends }) => {
    const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
    input.focus(); input.setSelectionRange(7, 12);
    const value = input.value, draft = { ...store.draft() };
    await navigate(host, "Terminal");
    expect(host.querySelector("main .terminal-view")?.textContent).toContain("Select an available worktree");
    expect(host.querySelector(".terminal-canvas")).toBeNull();
    expectNavigation(host, ["Open Chat", "Files", "Settings"]);
    expect(host.querySelector("textarea")).toBe(input);
    await navigate(host, "Open Chat");
    expect(catalog.state.navigation.view).toBe("chat"); expect(host.querySelector("textarea")).toBe(input);
    expect(input.value).toBe(value); expect(input.selectionStart).toBe(7); expect(input.selectionEnd).toBe(12);
    expect(store.draft()).toEqual(draft); expect(sends()).toBe(0);
    expect(requests.some(r => /terminal|\/cancel/.test(r.path))).toBe(false);
  }, { empty: true });
});

test("App Files and Git lead to Settings leaves with the same workspace selector in sidebar and drawer", async () => {
  await withApp(async ({ host, requests }) => {
    await navigate(host, "Files");
    expect(host.querySelector("main [role='alert']")?.textContent).toBe("Fixture worktree unavailable");
    expectNavigation(host, ["Chat", "Terminal", "Settings"]);
    await click(host, ".sidebar [aria-label='Files views'] button:last-child");
    expect(catalog.state.navigation.view).toBe("git");
    expect(button(host, ".sidebar [aria-label='Files views'] button:last-child").getAttribute("aria-pressed")).toBe("true");
    await navigate(host, "Settings");
    expect(host.querySelector("main .shell-content h2")?.textContent).toBe("Agents");
    expect(host.querySelector(".sidebar .shell-sidebar-header .workspace-opener")?.textContent).toContain("Navigation fixture: main");
    await click(host, ".sidebar .config-menu button:nth-child(2)");
    expect(catalog.state.navigation.view).toBe("workstreams");
    expect(host.querySelector("main .shell-content h2")?.textContent).toBe("Workstreams");
    expect(host.querySelector("main .shell-content [role='alert']")?.textContent).toBe("Repository inspection unavailable");
    expectNavigation(host, ["Chat", "Terminal", "Files"]);
    await click(host, "[aria-label='Open workspace navigation']");
    const drawer = host.querySelector<HTMLDialogElement>("dialog.drawer")!;
    expect(drawer.open).toBe(true);
    expect(drawer.querySelector(".shell-sidebar-header .workspace-opener")?.getAttribute("aria-label")).toBe(host.querySelector(".sidebar .workspace-opener")?.getAttribute("aria-label"));
    expect([...drawer.querySelectorAll(".config-menu .history-title")].map(e => e.textContent)).toEqual(["Agents", "Workstreams", "Application"]);
    expect(drawer.querySelector(".config-menu [aria-current='page'] .history-title")?.textContent).toBe("Workstreams");
    await click(drawer, ".workspace-opener");
    const picker = host.querySelector<HTMLDialogElement>("dialog.shell-dialog")!;
    const select = picker.querySelector<HTMLSelectElement>(".context-worktrees select")!;
    expect([...select.options].map(o => o.value)).toEqual(["", worktreeId, "other-tree"]);
    await act(async () => { select.value = "other-tree"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(catalog.state.navigation.worktreeId).toBe("other-tree");
    expect(host.querySelector(".sidebar .workspace-opener")?.textContent).toContain("feature");
    await click(picker, "[aria-label='Close workspace']");
    await click(drawer, ".config-menu button:first-child");
    expect(host.querySelector("dialog.drawer")).toBeNull();
    expect(host.querySelector("main [aria-label='Agent configuration']")).not.toBeNull();
    await click(host, ".sidebar .config-menu button:last-child");
    expect(host.querySelector("main .shell-content h2")?.textContent).toBe("Application");
    expect(catalog.state.navigation.view).toBe("config"); expect(store.state.selected).toBe(live.id);
    expect(requests.filter(r => r.path.startsWith("/api/workstreams/")).every(r => r.path.includes(`workspaceId=${workspaceId}`))).toBe(true);
    await navigate(host, "Files");
    expect(catalog.state.navigation.worktreeId).toBe("other-tree");
    expect(host.querySelector("main .topbar")?.textContent).toContain("Files");
  });
});

test("App empty non-chat views keep contextual navigation and a common selector", async () => {
  await withApp(async ({ host }) => {
    await click(host, ".sidebar .history-sidebar-button");
    expect(host.querySelector("main .history-detail")?.textContent).toContain("No session selected");
    expectNavigation(host, ["Open Chat", "Terminal", "Files", "Settings"]);
    await navigate(host, "Files");
    expect(host.querySelector("main .workspace-empty h2")?.textContent).toBe("Open a workspace");
    expectNavigation(host, ["Chat", "Terminal", "Settings"]);
    await click(host, ".sidebar [aria-label='Files views'] button:last-child");
    expect(host.querySelector("main .workspace-empty h2")?.textContent).toBe("Open a workspace");
    await navigate(host, "Settings");
    await click(host, ".sidebar .config-menu button:nth-child(2)");
    expect(host.querySelector("main .shell-content")?.textContent).toContain("Select a repository workspace");
    expectNavigation(host, ["Chat", "Terminal", "Files"]);
    expect(host.querySelector(".sidebar .shell-sidebar-header .workspace-opener")?.textContent).toBe("Open workspace");
    await navigate(host, "Terminal");
    expectNavigation(host, ["Open Chat", "Files", "Settings"]);
    await navigate(host, "Open Chat"); expect(catalog.state.navigation.view).toBe("chat");
  }, { empty: true });
});

test("App replaced conversations retain navigation; History errors do not strand the main pane", async () => {
  await withApp(async ({ host }) => {
    expect(host.querySelector("form.composer")).toBeNull();
    expect(host.querySelector(".composer-navigation-only .contextual-navigation")).not.toBeNull();
    expectNavigation(host, ["Terminal", "Files", "Settings"]);
    await click(host, ".sidebar .history-sidebar-button");
    expect(host.querySelector("main .history-detail [role='alert']")?.textContent).toBe("Recorded runs unavailable");
    expectNavigation(host, ["Open Chat", "Terminal", "Files", "Settings"]);
    await navigate(host, "Files");
    expect(host.querySelector("main [role='alert']")?.textContent).toBe("Fixture worktree unavailable");
    await navigate(host, "Settings");
    expect(host.querySelector("main .shell-content h2")?.textContent).toBe("Agents");
    await navigate(host, "Chat");
    expect(host.querySelector(".composer-navigation-only .contextual-navigation")).not.toBeNull();
    expect(store.state.selected).toBe(live.id);
  }, { replaced: true, historyError: true });
});
