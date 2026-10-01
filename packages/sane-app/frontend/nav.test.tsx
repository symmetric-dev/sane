import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { contextualDestinations, ContextualNavigation, FilesModeControl, ViewNavigationCommands, viewGroup } from "./nav";
import { ApplicationCommandProvider } from "./application-commands";
import { WorkspaceShell } from "./workspace-shell";
import { store } from "./store";
import type { ActiveView } from "./workspace-controller";

test("existing bookmark leaves map to the three presentation groups", () => {
  for (const view of ["chat", "history", "terminal"] as const) expect(viewGroup(view)).toBe("chat");
  for (const view of ["code", "git"] as const) expect(viewGroup(view)).toBe("files");
  for (const view of ["config", "workstreams"] as const) expect(viewGroup(view)).toBe("settings");
});

test("contextual destinations retain leaf IDs and exclude the current destination", () => {
  const expected: Record<ActiveView, Array<"chat" | "terminal" | "code" | "config">> = {
    chat: ["terminal", "code", "config"], terminal: ["chat", "code", "config"],
    history: ["chat", "terminal", "code", "config"],
    code: ["chat", "terminal", "config"], git: ["chat", "terminal", "config"],
    config: ["chat", "terminal", "code"], workstreams: ["chat", "terminal", "code"],
  };
  for (const [view, destinations] of Object.entries(expected)) {
    expect(contextualDestinations(view as ActiveView).map(item => item.id)).toEqual(destinations);
  }
});

async function withDom(run: (host: HTMLDivElement, root: Root, browser: Window) => Promise<void>) {
  const browser = new Window({ url: "http://localhost" });
  const globals = { window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let root: Root | undefined;
  try {
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div"); document.body.append(host);
    root = createRoot(host);
    await run(host, root, browser);
  } finally {
    if (root) await act(async () => { root!.unmount(); });
    browser.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test("navigation is accessible, view-only, and never submits a surrounding composer", async () => {
  await withDom(async (host, root) => {
    const chosen: string[] = []; let submits = 0;
    const state = { ...store.snapshot(), sending: true };
    await act(async () => { root.render(<form onSubmit={event => { event.preventDefault(); submits++; }}><ContextualNavigation state={state} activeView="chat" onNavigate={view => chosen.push(view)} /></form>); });
    const buttons = [...host.querySelectorAll("button")];
    expect(buttons.map(button => button.getAttribute("aria-label"))).toEqual(["Terminal", "Files", "Settings"]);
    expect(buttons.every(button => button.type === "button" && !button.disabled)).toBe(true);
    expect(buttons.map(button => button.getAttribute("aria-keyshortcuts"))).toEqual(["Meta+`", "Control+Meta+f", "Control+Meta+d"]);
    expect(buttons.every(button => button.title.startsWith(`${button.getAttribute("aria-label")} (`))).toBe(true);
    await act(async () => { buttons.forEach(button => button.click()); });
    expect(chosen).toEqual(["terminal", "code", "config"]);
    expect(submits).toBe(0);
    await act(async () => { root.render(<ContextualNavigation state={state} activeView="terminal" onNavigate={view => chosen.push(view)} />); });
    expect(host.querySelector('[aria-label="Open Chat"]')?.textContent).toContain("Open Chat");
  });
});

test("view hotkeys capture input/editor/terminal keys precisely and clean up registrations", async () => {
  await withDom(async (host, root, browser) => {
    const chosen: ActiveView[] = [];
    const render = (onNavigate: (view: ActiveView) => void) => root.render(<ApplicationCommandProvider>
      <ViewNavigationCommands onNavigate={onNavigate} />
      <textarea /><div className="cm-editor"><input /></div><div className="xterm"><textarea /></div>
    </ApplicationCommandProvider>);
    await act(async () => render(view => chosen.push(view)));
    const targets = [document.body, ...host.querySelectorAll("textarea, input")];
    const emit = async (target: Element, key: string, options: object = {}) => {
      const event = new browser.KeyboardEvent("keydown", { key, metaKey: true, ctrlKey: key !== "`", bubbles: true, cancelable: true, ...options });
      await act(async () => { target.dispatchEvent(event as unknown as Event); });
      return event.defaultPrevented;
    };
    for (const target of targets) {
      for (const key of ["C", "`", "d", "f"]) expect(await emit(target, key)).toBe(true);
    }
    expect(chosen).toEqual(targets.flatMap(() => ["chat", "terminal", "config", "code"]));
    const count = chosen.length;
    for (const options of [{ metaKey: false }, { ctrlKey: false }, { shiftKey: true }, { altKey: true }, { repeat: true }, { isComposing: true }]) {
      expect(await emit(targets[1]!, "c", options)).toBe(false);
    }
    expect(await emit(targets[3]!, "`", { ctrlKey: true })).toBe(false);
    expect(await emit(targets[1]!, "Enter", { ctrlKey: true, metaKey: false })).toBe(false);
    const dialog = document.createElement("dialog"); dialog.setAttribute("open", ""); host.append(dialog);
    expect(await emit(document.body, "f")).toBe(false); dialog.remove();
    expect(chosen).toHaveLength(count);
    const updated: ActiveView[] = [];
    await act(async () => render(view => updated.push(view)));
    expect(await emit(document.body, "c")).toBe(true);
    expect(updated).toEqual(["chat"]); expect(chosen).toHaveLength(count);
    await act(async () => root.render(null));
    expect(await emit(document.body, "c")).toBe(false);
  });
});

test("Files and Git controls navigate without requiring or mutating a file target", async () => {
  await withDom(async (host, root) => {
    const chosen: string[] = [];
    await act(async () => { root.render(<FilesModeControl activeView="git" onNavigate={view => chosen.push(view)} />); });
    const buttons = [...host.querySelectorAll("button")];
    expect(buttons.map(button => button.textContent)).toEqual(["Files", "Git"]);
    expect(buttons.map(button => button.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
    await act(async () => { buttons[0]!.click(); });
    expect(chosen).toEqual(["code"]);
  });
});

test("every shell view puts the catalog before sidebar content and never in the topbar", async () => {
  await withDom(async (host, root) => {
    for (const view of ["chat", "history", "terminal", "code", "git", "config", "workstreams"] as const) {
      await act(async () => { root.render(<WorkspaceShell view={view} sidebar={<div data-testid="sidebar-content">Content</div>} header={<span>Heading</span>}
        retryCatalog={() => {}} sidebarOpen={false} openSidebar={() => {}} closeSidebar={() => {}}><div>View</div></WorkspaceShell>); });
      const sidebar = host.querySelector("aside")!;
      expect(sidebar.firstElementChild?.className).toBe("shell-sidebar-header");
      expect(sidebar.firstElementChild?.querySelector(".workspace-opener")).not.toBeNull();
      expect(sidebar.children[1]?.querySelector('[data-testid="sidebar-content"]')).not.toBeNull();
      expect(host.querySelector(".topbar .context-switcher")).toBeNull();
      expect(host.querySelector(".workspace-navigation")).toBeNull();
    }
    await act(async () => { root.render(<WorkspaceShell view="config" sidebar={<div>Settings sections</div>} header={<span>Settings</span>}
      retryCatalog={() => {}} sidebarOpen openSidebar={() => {}} closeSidebar={() => {}}><div>View</div></WorkspaceShell>); });
    const drawer = host.querySelector("dialog")!;
    expect(drawer.getAttribute("aria-labelledby")).toBeTruthy();
    expect(drawer.querySelector(".shell-sidebar-header .workspace-opener")).not.toBeNull();
    expect(drawer.querySelector(".sidebar-body")?.textContent).toBe("Settings sections");
  });
});
