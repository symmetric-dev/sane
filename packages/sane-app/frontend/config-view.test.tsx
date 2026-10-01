import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { WorkspaceRecord } from "../src/catalog-contract";
import type { WorkstreamOverview } from "../src/workstreams-contract";
import { catalog } from "./catalog";
import { ConfigMenu, ConfigView, configSection } from "./config-view";
import { store } from "./store";
import type { ArtifactSelection } from "./workstreams";

const repository: WorkspaceRecord = { workspaceId: "browsed", kind: "repository", name: "Repository", commonDir: "/repo/.git", worktrees: [] };
const overview: WorkstreamOverview = { repositoryId: "domain", workstreams: [], conversations: [] };

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
async function withSettingsDom(fetcher: Fetcher, run: (host: HTMLDivElement, root: Root) => Promise<void>, workspace = repository) {
  const browser = new Window({ url: "http://localhost" });
  const globals = {
    window: browser, document: browser.document, navigator: browser.navigator,
    localStorage: browser.localStorage, HTMLElement: browser.HTMLElement,
    Event: browser.Event, MouseEvent: browser.MouseEvent, FormData: browser.FormData,
    IS_REACT_ACT_ENVIRONMENT: true, fetch: fetcher,
  };
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const previousCatalog = catalog.snapshot(), previousSection = configSection.snapshot();
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let root: Root | undefined;
  try {
    catalog.invalidate();
    catalog.state = { ...previousCatalog, ready: false, loading: false, workspaces: [workspace], navigation: { ...previousCatalog.navigation, workspaceId: "execution-workspace", view: "config" } };
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div"); document.body.append(host);
    root = createRoot(host);
    await run(host, root);
  } finally {
    try { if (root) await act(async () => { root!.unmount(); }); }
    finally {
      catalog.invalidate(); catalog.state = previousCatalog;
      configSection.set(previousSection);
      browser.close();
      for (const [key, descriptor] of prior) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  }
}

const unexpectedFetch: Fetcher = async input => { throw new Error(`Unexpected request: ${input}`); };

test("Settings menu orders Agents, Workstreams, Application, Shortcuts and preserves the hotkeys bookmark", async () => {
  await withSettingsDom(unexpectedFetch, async (host, root) => {
    configSection.set("application");
    const selectedLeaves: string[] = [];
    await act(async () => { root.render(<ConfigMenu onSelect={() => selectedLeaves.push(catalog.snapshot().navigation.view)} />); });
    const buttons = [...host.querySelectorAll("button")];
    expect(buttons.map(button => button.querySelector(".history-title")?.textContent)).toEqual(["Agents", "Workstreams", "Application", "Shortcuts"]);
    const current = () => [...host.querySelectorAll('[aria-current="page"]')].map(button => button.querySelector(".history-title")?.textContent);
    expect(current()).toEqual(["Application"]);

    await act(async () => { buttons[1]!.click(); });
    expect(catalog.snapshot().navigation.view).toBe("workstreams");
    expect(current()).toEqual(["Workstreams"]);
    expect(configSection.snapshot()).toBe("application");
    expect(localStorage.getItem("sane.configSection")).toBe("application");

    await act(async () => { buttons[0]!.click(); });
    expect(catalog.snapshot().navigation.view).toBe("config");
    expect(current()).toEqual(["Agents"]);
    expect(localStorage.getItem("sane.configSection")).toBe("agents");
    await act(async () => { buttons[2]!.click(); });
    expect(catalog.snapshot().navigation.view).toBe("config");
    expect(current()).toEqual(["Application"]);
    await act(async () => { buttons[3]!.click(); });
    expect(current()).toEqual(["Shortcuts"]);
    expect(configSection.snapshot()).toBe("hotkeys");
    expect(localStorage.getItem("sane.configSection")).toBe("hotkeys");
    expect(catalog.snapshot().navigation.view).toBe("config");
    expect(selectedLeaves).toEqual(["workstreams", "config", "config", "config"]);

    // External restore/navigation wins over the saved local preference.
    await act(async () => { catalog.navigate({ view: "workstreams" }); configSection.set("agents"); });
    expect(current()).toEqual(["Workstreams"]);
    await act(async () => { catalog.navigate({ view: "config" }); });
    expect(current()).toEqual(["Agents"]);
    await act(async () => { catalog.navigate({ view: "chat" }); });
    expect(current()).toEqual([]);
  });
});

test("Shortcuts settings statically documents Global and local Files bindings without requesting data", async () => {
  await withSettingsDom(unexpectedFetch, async (host, root) => {
    configSection.set("hotkeys");
    await act(async () => root.render(<ConfigView state={store.snapshot()} signOut={() => {}} />));
    expect(host.querySelector("h2")?.textContent).toBe("Shortcuts");
    expect(host.querySelector('[aria-label="Shortcuts settings"]')).not.toBeNull();
    expect([...host.querySelectorAll("h3")].map(heading => heading.textContent)).toEqual(["Global", "Local to a View"]);
    const rows = (label: string) => [...host.querySelectorAll(`table[aria-labelledby="${label}"] tbody tr`)].map(row => [...row.children].map(cell => cell.textContent));
    for (const table of host.querySelectorAll("table")) expect([...table.querySelectorAll("thead th")].map(cell => cell.textContent)).toEqual(["Action", "Mac", "Windows / Linux"]);
    expect(rows("hotkeys-navigation")).toEqual([
      ["Chat", "Ctrl⌘C", "Ctrl+Alt+C"], ["Terminal", "Ctrl⌘T", "Ctrl+Alt+T"],
      ["Files", "Ctrl⌘F", "Ctrl+Alt+F"], ["Settings", "Ctrl⌘S", "Ctrl+Alt+S"],
    ]);
    expect(rows("hotkeys-files-view")).toEqual([["Search saved files", "⌘⇧F", "Ctrl+Shift+F"]]);
    expect(rows("hotkeys-files-sidebar")).toEqual([
      ["Rename", "⇧R", "Shift+R"], ["Delete", "Delete / ⌘Backspace", "Delete"],
      ["Copy file", "⌘C", "Ctrl+C"], ["Paste file", "⌘V", "Ctrl+V"],
    ]);
    expect(rows("hotkeys-files-main-panel")).toEqual([
      ["Save file", "⌘S", "Ctrl+S"], ["Find in file", "⌘F", "Ctrl+F"],
      ["Copy text", "⌘C", "Ctrl+C"], ["Paste text", "⌘V", "Ctrl+V"],
    ]);
    expect(host.textContent).toContain("Normal text copy/paste is unchanged");
    expect(host.textContent).toContain("dialog is open");
  });
});

test("Agent settings separates Base, Assistants and Workers into keyboard-accessible tabs", async () => {
  await withSettingsDom(unexpectedFetch, async (host, root) => {
    configSection.set("agents");
    await act(async () => root.render(<ConfigView state={store.snapshot()} signOut={() => {}} />));
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map(tab => tab.textContent)).toEqual(["Base", "Assistants", "Workers"]);
    const panel = (name: string) => host.querySelector<HTMLDivElement>(`#agents-panel-${name}`)!;
    const expectSelected = (name: string) => {
      expect(tabs.filter(tab => tab.getAttribute("aria-selected") === "true").map(tab => tab.id)).toEqual([`agents-tab-${name}`]);
      expect(tabs.filter(tab => tab.tabIndex === 0).map(tab => tab.id)).toEqual([`agents-tab-${name}`]);
      expect([...host.querySelectorAll<HTMLDivElement>('[role="tabpanel"]')].filter(item => !item.hidden)).toEqual([panel(name)]);
      expect(panel(name).getAttribute("aria-labelledby")).toBe(`agents-tab-${name}`);
    };
    expectSelected("assistants");
    for (const [name, kind] of [["base", "base"], ["assistants", "assistant"], ["workers", "worker"]] as const) {
      expect([...panel(name).querySelectorAll("[data-agent-id]")].map(card => card.getAttribute("data-agent-id"))).toEqual(store.profileList().filter(profile => profile.kind === kind).map(profile => profile.id));
    }
    expect(panel("base").textContent).toContain("Harness defaults without SANE instructions.");
    expect(panel("assistants").textContent).toContain("New assistant");
    expect(panel("assistants").textContent).not.toContain("Base defaults");
    await act(async () => tabs[0]!.click());
    expectSelected("base");
    await act(async () => tabs[2]!.click());
    expectSelected("workers");

    const key = async (value: string, target: number, selected: string) => {
      await act(async () => tabs[target]!.dispatchEvent(new window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })));
      expectSelected(selected);
      expect(document.activeElement?.id).toBe(`agents-tab-${selected}`);
    };
    await key("ArrowRight", 2, "base");
    await key("ArrowRight", 0, "assistants");
    await key("ArrowRight", 1, "workers");
    await key("ArrowLeft", 2, "assistants");
    await key("ArrowLeft", 1, "base");
    await key("ArrowLeft", 0, "workers");
    await key("Home", 2, "base");
    await key("End", 0, "workers");
  });
});

test("Settings renders each leaf using the browsed workspace and forwards artifact navigation", async () => {
  const requests: string[] = [], opened: ArtifactSelection[] = [];
  const detail: WorkstreamOverview = { ...overview, workstreams: [{
    workstream: { repositoryId: "domain", id: "feature", title: "Feature", type: "feature", defaultCheckout: null, createdAt: "2026-09-30T00:00:00Z", updatedAt: "2026-09-30T00:00:00Z", revision: 1, lifecycle: { status: "open", phases: [], approvals: [], jobs: [], mutations: [] } },
    conversations: [], activePhases: [], phaseHistory: [], research: { registered: [], unregistered: [], warnings: [] },
  }] };
  await withSettingsDom(async input => {
    const url = String(input); requests.push(url);
    if (url.startsWith("/api/workstreams/inspect?")) return Response.json({ state: "ready" });
    if (url.startsWith("/api/workstreams/overview?")) return Response.json(detail);
    if (url.startsWith("/api/workstreams/artifacts/list?")) return Response.json(["README.md"]);
    throw new Error(`Unexpected request: ${url}`);
  }, async (host, root) => {
    configSection.set("application");
    await act(async () => { root.render(<ConfigView state={store.snapshot()} signOut={() => {}} workspaceId="browsed" openArtifact={artifact => opened.push(artifact)} />); });
    expect(host.querySelector("h2")?.textContent).toBe("Application");
    expect(requests).toHaveLength(0);

    await act(async () => { catalog.navigate({ view: "workstreams" }); });
    expect(host.querySelector("h2")?.textContent).toBe("Workstreams");
    expect(requests.every(url => url.includes("workspaceId=browsed"))).toBe(true);
    expect(requests).toHaveLength(2);
    expect(host.querySelector('[aria-current="true"] .workstreams-list-title')?.textContent).toBe("Feature");
    const documents = host.querySelector<HTMLButtonElement>('[role="tab"]:last-child')!;
    await act(async () => { documents.click(); });
    const artifactButton = host.querySelector<HTMLButtonElement>('[aria-label="Open Workstream overview in Files"]')!;
    await act(async () => { artifactButton.click(); });
    expect(opened).toEqual([{ workspaceId: "browsed", workstreamId: "feature", path: "README.md", repositoryId: "domain" }]);

    await act(async () => { configSection.set("agents"); catalog.navigate({ view: "config" }); });
    expect(host.querySelector("h2")?.textContent).toBe("Agents");
    expect(host.querySelector("[aria-label='Agent configuration']")).not.toBeNull();
  });
});

test("Settings Workstreams distinguishes no workspace and plain directory without repository requests", async () => {
  await withSettingsDom(unexpectedFetch, async (host, root) => {
    catalog.navigate({ view: "workstreams" });
    await act(async () => { root.render(<ConfigView state={store.snapshot()} signOut={() => {}} />); });
    expect(host.textContent).toContain("Select a repository workspace");
    await act(async () => { root.render(<ConfigView state={store.snapshot()} signOut={() => {}} workspaceId="browsed" />); });
    expect(host.textContent).toContain("Workstreams require a repository");
    expect(host.textContent).not.toContain("Loading workstreams");
    expect(host.querySelector("button")).toBeNull();
  }, { ...repository, kind: "directory", commonDir: null });
});

test("Settings Workstreams stops loading for uninitialized stores and shows refresh failures separately", async () => {
  let resolve!: (response: Response) => void;
  let inspection = new Promise<Response>(done => { resolve = done; });
  await withSettingsDom(async input => {
    if (!String(input).startsWith("/api/workstreams/inspect?")) throw new Error(`Unexpected request: ${input}`);
    return inspection;
  }, async (host, root) => {
    catalog.navigate({ view: "workstreams" });
    await act(async () => { root.render(<ConfigView state={store.snapshot()} signOut={() => {}} workspaceId="browsed" />); });
    expect(host.textContent).toContain("Loading workstreams…");
    await act(async () => { resolve(Response.json({ state: "uninitialized", message: "No domain exists yet." })); });
    expect(host.textContent).toContain("Organize your repository work");
    expect(host.textContent).not.toContain("Loading workstreams");
    expect([...host.querySelectorAll("button")].some(button => button.textContent === "Enable workstreams")).toBe(true);

    inspection = Promise.resolve(Response.json({ error: "Inspection failed" }, { status: 503 }));
    const refresh = [...host.querySelectorAll("button")].find(button => button.textContent === "Refresh")!;
    await act(async () => { refresh.click(); });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Couldn't load workstreams. Try refreshing.");
    expect(host.querySelector("details")?.textContent).toContain("Inspection failed");
    expect(host.textContent).not.toContain("Loading workstreams");
    expect(host.textContent).not.toContain("Enable workstreams");

    inspection = Promise.resolve(Response.json({ state: "corrupt", message: "Repair the repository store." }));
    await act(async () => { refresh.click(); });
    expect(host.textContent).toContain("Workstreams aren't available right now");
    expect(host.textContent).toContain("Repair the repository store.");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).not.toContain("Loading workstreams");
  });
});
