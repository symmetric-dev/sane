import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { ChatComposer } from "./chat-composer";
import { catalog } from "./catalog";
import { store } from "./store";
import { Thread } from "./thread";

async function fixture(run: (context: { browser: Window; host: HTMLDivElement; root: Root }) => Promise<void>) {
  const browser = new Window({ url: "http://localhost" });
  const globals = { window: browser, self: browser, document: browser.document, navigator: browser.navigator,
    HTMLElement: browser.HTMLElement, Event: browser.Event, ResizeObserver: browser.ResizeObserver,
    MutationObserver: browser.MutationObserver, requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true };
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const oldState = store.state, oldCatalog = catalog.state;
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let root: Root | undefined;
  try {
    catalog.state = { ...oldCatalog, ready: true, workspaces: [{ workspaceId: "workspace", kind: "directory", name: "Fixture", commonDir: null,
      worktrees: [{ worktreeId: "tree", root: "/fixture", gitDir: null, bindingRevision: "binding", state: "available" }] }],
      navigation: { ...oldCatalog.navigation, workspaceId: "workspace", worktreeId: "tree", view: "chat" } };
    store.state = { ...oldState, selected: "", conversations: [], runs: [], messages: [], drafts: {}, profiles: null, config: undefined,
      connected: true, loading: false, sending: false, availability: { canSend: true }, submissionError: "", modelsError: "", interactions: [] };
    store.setDraft({ text: "first line\nsecond line  " });
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await run({ browser, host, root });
  } finally {
    if (root) await act(async () => root!.unmount());
    store.state = oldState; catalog.state = oldCatalog; browser.close();
    for (const [key, descriptor] of prior) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}

test("composer navigation never submits and streaming/activity updates keep the live IME input", async () => {
  await fixture(async ({ browser, host, root }) => {
    let active = true, routes = 0, sends = 0;
    const render = () => root.render(<div hidden={!active}><ChatComposer state={store.state} active={active} ack="" onAckChange={() => {}} sendDisabled={false} send={() => { sends++; }}
      navigation={<nav aria-label="Views"><button type="button" onClick={() => { routes++; }}>Terminal</button><button type="button">Files</button><button type="button">Settings</button></nav>} /></div>);
    await act(async () => render());
    expect(host.querySelector(".composer-options .composer-workers")).not.toBeNull();
    expect(host.querySelector(".composer-actions .composer-workers")).toBeNull();
    const workers = host.querySelector<HTMLButtonElement>(".composer-workers")!;
    expect(workers.textContent).toBe("0"); expect(workers.getAttribute("aria-label")).toContain("Workers, 0 active");
    await act(async () => host.querySelector<HTMLButtonElement>("nav button")!.click());
    expect(routes).toBe(1); expect(sends).toBe(0);

    const input = host.querySelector("textarea")!;
    input.focus(); input.setSelectionRange(5, 5);
    await act(async () => input.dispatchEvent(new browser.CompositionEvent("compositionstart", { bubbles: true }) as unknown as Event));
    input.value = "first 日本 line\nsecond line  "; input.setSelectionRange(8, 8);
    await act(async () => input.dispatchEvent(new browser.InputEvent("input", { bubbles: true, isComposing: true }) as unknown as Event));
    for (let tick = 0; tick < 3; tick++) {
      store.state = { ...store.state, actionNotice: `Stream ${tick}` };
      await act(async () => render());
    }
    expect(host.querySelector("textarea")).toBe(input); expect(input.selectionStart).toBe(8);
    active = false; await act(async () => render());
    expect(host.querySelector("textarea")).toBe(input);
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(sends).toBe(0);
    active = true; await act(async () => render());
    expect(input.value).toBe("first 日本 line\nsecond line  "); expect(input.selectionStart).toBe(8);
    await act(async () => input.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, isComposing: true, bubbles: true }) as unknown as Event));
    expect(sends).toBe(0);
    await act(async () => input.dispatchEvent(new browser.CompositionEvent("compositionend", { bubbles: true }) as unknown as Event));
    await act(async () => input.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }) as unknown as Event));
    expect(sends).toBe(1);
  });
});

test("inactive composer dismisses Help, Agent and Workers without restoring a hidden trigger", async () => {
  await fixture(async ({ host, root }) => {
    let active = true;
    const render = () => root.render(<div hidden={!active}><ChatComposer state={store.state} active={active} ack="" onAckChange={() => {}} sendDisabled={false} send={() => {}} /></div>);
    await act(async () => render());
    for (const selector of [".composer-help", "button.agent-chip", ".composer-workers"]) {
      const trigger = host.querySelector<HTMLButtonElement>(selector)!;
      trigger.focus(); await act(async () => trigger.click());
      expect(document.querySelector("dialog")).not.toBeNull();
      let restored = 0;
      const focus = trigger.focus.bind(trigger);
      trigger.focus = () => { restored++; focus(); };
      active = false; await act(async () => render());
      expect(document.querySelector("dialog")).toBeNull(); expect(restored).toBe(0);
      active = true; await act(async () => render());
      expect(document.querySelector("dialog")).toBeNull();
      trigger.focus = focus;
    }
  });
});

test("mounted Thread clears Claude external-run acknowledgement when hidden; replaced history keeps only navigation", async () => {
  await fixture(async ({ host, root }) => {
    const id = "attached";
    store.state = { ...store.state, selected: id, conversations: [{ id, harness: "claude-code", cwd: "/fixture", status: "completed", lastRunId: null,
      workspaceId: "workspace", worktreeId: "tree", association: "resolved", attachment: { state: "ready" } }] };
    store.setDraft({ text: "Continue" });
    let active = true;
    const render = () => root.render(<div hidden={!active}><Thread state={store.state} active={active} navigation={<button type="button" aria-label="Terminal">Terminal</button>} /></div>);
    await act(async () => render());
    const input = host.querySelector("textarea")!, checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const send = () => host.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!;
    expect(send().disabled).toBe(true);
    await act(async () => checkbox.click()); expect(send().disabled).toBe(false);
    active = false; await act(async () => render());
    expect(checkbox.checked).toBe(false); expect(send().disabled).toBe(true);
    active = true; await act(async () => render());
    expect(checkbox.checked).toBe(false); expect(host.querySelector("textarea")).toBe(input); expect(send().disabled).toBe(true);
    store.state = { ...store.state, conversations: store.state.conversations.map(c => ({ ...c, replacedBy: "replacement" })) };
    await act(async () => render());
    expect(host.querySelector("form.composer")).toBeNull();
    expect(host.querySelector('.composer-navigation-only [aria-label="Terminal"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Send message"]')).toBeNull();
  });
});

test("terminal navigation is last/right and remains available without a selected worktree", async () => {
  await fixture(async ({ host, root }) => {
    catalog.state = { ...catalog.state, workspaces: [], navigation: { ...catalog.state.navigation, workspaceId: null, worktreeId: null } };
    // Import after browser globals are installed; xterm has a browser entrypoint.
    const { TerminalProvider, TerminalView } = await import("./terminal");
    let navigations = 0;
    await act(async () => root.render(<TerminalProvider view="terminal"><TerminalView navigation={<button type="button" onClick={() => { navigations++; }}>Open Chat</button>} /></TerminalProvider>));
    const footer = host.querySelector(".terminal-local-footer")!;
    expect(footer.querySelector('[role="status"]')?.textContent).toBe("Terminal");
    expect(footer.querySelector(".terminal-policy")).not.toBeNull();
    expect(footer.lastElementChild?.className).toBe("terminal-footer-controls");
    expect(footer.lastElementChild?.lastElementChild?.className).toBe("terminal-footer-navigation");
    await act(async () => host.querySelector<HTMLButtonElement>(".terminal-footer-navigation button")!.click());
    expect(navigations).toBe(1); expect(host.querySelector(".terminal-canvas")).toBeNull();
  });
});
