import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { catalog } from "./catalog";
import { store, type State } from "./store";
import type { Conversation } from "./types";
import { registerWorkerSessions } from "./worker-client";
import { ConversationSidebar, useConversationSidebarModel, type ConversationSidebarMode, type ConversationSidebarModel } from "./conversation-sidebar";

test("one shell model preserves filters across modes and presentations while History stays preview-only", async () => {
  const browser = new Window({ url: "http://localhost" });
  const globals = { window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, Event: browser.Event, IS_REACT_ACT_ENVIRONMENT: true };
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const priorCatalog = catalog.state;
  const priorFetch = globalThis.fetch;
  const requests: string[] = [];
  let overviewVersion = "original";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input); requests.push(url);
    return Response.json(url.includes("/search?") ? { results: [] } : { repositoryId: overviewVersion, workstreams: [], conversations: [] });
  }) as typeof fetch;
  const conversation = (id: string, extra: Partial<Omit<Conversation, "workspaceId" | "worktreeId" | "association" | "associationReason">> = {}): Conversation => ({ id, title: `Conversation ${id}`, harness: "claude-code", cwd: "/repo", lastRunId: null, status: "completed", workspaceId: "ws", worktreeId: "wt", association: "resolved", ...extra });
  const conversations = [conversation("normal"), conversation("replaced", { hidden: true, replacedBy: "normal" }), conversation("worker", { worker: { id: "worker-record", parent: { sessionId: "normal", runId: "run", toolCallId: "tool" } } })];
  registerWorkerSessions(conversations);
  catalog.state = { ...priorCatalog, ready: false, workspaces: [{ workspaceId: "ws", kind: "repository", name: "Repo", commonDir: "/repo/.git", worktrees: [] }], navigation: { ...priorCatalog.navigation, workspaceId: "ws", worktreeId: "wt" } };
  let state: State = { ...store.snapshot(), conversations, selected: "normal", sending: false };
  let mode: ConversationSidebarMode = "chat", drawer = false;
  let model!: ConversationSidebarModel;
  const chosen: string[] = [], previews: string[] = [];
  let historyClicks = 0;
  const realSelected = store.snapshot().selected;
  let root: Root | undefined;
  try {
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    function Shell() {
      model = useConversationSidebarModel(state, mode);
      const props = { state, model, mode, selectedId: mode === "history" ? "replaced" : state.selected, onChoose: (id: string) => chosen.push(id), onPreview: (id: string) => previews.push(id), onHistory: () => { historyClicks++; } };
      return <><aside data-place="desktop"><ConversationSidebar {...props} /></aside>{drawer && <aside data-place="drawer"><ConversationSidebar {...props} /></aside>}</>;
    }
    const render = () => root!.render(<Shell />);
    await act(async () => render());
    expect(model.visible.map(c => c.id)).toEqual(["normal"]);
    const desktop = () => host.querySelector('[data-place="desktop"]')!;
    const actionButtons = () => [...desktop().querySelectorAll<HTMLButtonElement>(".conversation-sidebar-actions button")];
    expect(desktop().firstElementChild?.className).toBe("history-search-row");
    expect(desktop().querySelector(".history-search-row button")?.textContent).toBe("Filter");
    expect(desktop().lastElementChild?.className).toBe("conversation-sidebar-actions");
    expect(desktop().lastElementChild?.previousElementSibling?.className).toBe("history-list");
    expect(actionButtons().map(b => b.textContent)).toEqual(["New Conversation", "History"]);
    await act(async () => { actionButtons()[0]!.click(); actionButtons()[1]!.click(); });
    expect(chosen).toEqual([""]); expect(historyClicks).toBe(1);
    expect(actionButtons()[1]!.getAttribute("aria-pressed")).toBe("false");
    await act(async () => model.setFilter({ ...model.filter, query: "Conversation", harness: "claude-code" }));
    await act(async () => { mode = "history"; drawer = true; render(); });
    expect(model.filter.query).toBe("Conversation"); expect(model.filter.harness).toBe("claude-code");
    expect(model.visible.map(c => c.id)).toEqual(["worker", "replaced", "normal"]);
    expect(host.querySelectorAll('input[value="Conversation"]').length).toBe(2);
    const drawerSidebar = host.querySelector('[data-place="drawer"]')!;
    expect(drawerSidebar.firstElementChild?.className).toBe("history-search-row");
    expect(drawerSidebar.lastElementChild?.className).toBe("conversation-sidebar-actions");
    expect([...drawerSidebar.querySelectorAll(".conversation-sidebar-actions button")].map(b => b.textContent)).toEqual(["New Conversation", "History"]);
    expect(host.textContent).not.toContain("Session type");
    expect(actionButtons()[1]!.getAttribute("aria-pressed")).toBe("true");
    expect(desktop().querySelector('[aria-current="page"]')?.textContent).toContain("Conversation replaced");
    await act(async () => { (desktop().querySelector(".history-row > button") as HTMLButtonElement).click(); });
    expect(previews).toEqual(["worker"]); expect(chosen).toEqual([""]);
    expect(store.snapshot().selected).toBe(realSelected); expect(state.selected).toBe("normal");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
    expect(requests.filter(url => url.includes("/overview?")).length).toBe(1);
    expect(requests.filter(url => url.includes("/search?")).length).toBe(1);
    await act(async () => { mode = "chat"; drawer = false; state = { ...state, sending: true }; render(); });
    expect(model.filter.query).toBe("Conversation"); expect(model.visible.map(c => c.id)).toEqual(["normal"]);
    expect(actionButtons()[0]!.disabled).toBe(true);
    // Workstreams mutations happen with the same browsing workspace. Re-entry
    // reloads its overview while preserving the sidebar's shared filters.
    await act(async () => { catalog.navigate({ view: "workstreams" }); });
    expect(model.overview).toBeNull();
    overviewVersion = "updated-in-settings";
    await act(async () => { catalog.navigate({ view: "chat" }); });
    expect(model.overview?.repositoryId).toBe("updated-in-settings");
    expect(requests.filter(url => url.includes("/overview?")).length).toBe(2);
    expect(model.filter.query).toBe("Conversation");
    expect(model.filter.harness).toBe("claude-code");
    await act(async () => {
      state = { ...state, sending: false };
      catalog.state = { ...catalog.state, navigation: { ...catalog.state.navigation, worktreeId: null } };
      render();
    });
    expect(actionButtons()[0]!.disabled).toBe(true);
    expect(model.filter.query).toBe(""); expect(model.filter.harness).toBe("all"); expect(model.filter.worktreeId).toBe("all");
  } finally {
    if (root) await act(async () => root!.unmount());
    registerWorkerSessions(store.snapshot().conversations);
    catalog.state = priorCatalog; globalThis.fetch = priorFetch; browser.close();
    for (const [key, descriptor] of prior) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
