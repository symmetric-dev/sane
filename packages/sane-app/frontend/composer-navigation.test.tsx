import { expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { ChatComposer } from "./chat-composer";
import { catalog } from "./catalog";
import { store } from "./store";
import { Thread } from "./thread";
import type { PendingInputItem } from "../shared/conversation/pending-input-contract";
import type { PendingInputView } from "./pending-input-presentation";
import { pendingInputLid, pendingInputPrimaryAction } from "./pending-input-primary-action";

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

test("visible queue primary routes shortcuts, paused/full/check states without resume or remount", async () => {
  await fixture(async ({ browser, host, root }) => {
    const conversationId = "primary-queue";
    const source = { harnessId: "claude-code", conversationId, authorityId: "authority", nativeSessionId: "native", cwd: "/fixture" };
    const configuration = { cwd: "/fixture", profileId: "base:cc" };
    const item = (sequence: number, state: "waiting" | "claimed"): PendingInputItem => ({ version: 1, conversationId,
      requestId: `request-${sequence}`, itemId: `item-${sequence}`, sequence, state, text: `Message ${sequence}`, source, configuration });
    const view = (waiting: number, paused = false): PendingInputView => ({
      snapshot: { version: 1, conversationId, revision: 1, paused, reason: paused ? "Operator stopped" : null,
        items: [item(1, "claimed"), ...Array.from({ length: waiting }, (_, index) => item(index + 2, "waiting"))], tombstones: [] },
      presentation: { maxWaiting: 3, waitingCount: waiting, chainLocked: true, chainId: "chain", source, configuration,
        currentAssertions: { source, configuration }, removals: Array.from({ length: waiting }, (_, index) => ({ itemId: `item-${index + 2}`, allowed: true, code: null })),
        unresolved: { itemId: "item-1", requestId: "request-1", classification: "uncertain" },
        pauseCode: paused ? "stop" : null, enqueue: { allowed: waiting < 3, code: waiting === 3 ? "pending-input-full" : null,
          reason: waiting === 3 ? "Waiting queue is full (3/3)." : null }, removalAllowed: true, resumeAllowed: false,
        automation: { supported: true, reason: null }, hidden: false },
    });
    store.state = { ...store.state, phase: "ready", config: { authRequired: false, authenticated: true, storeId: "33333333-3333-4333-8333-333333333333" },
      selected: conversationId, conversations: [{ id: conversationId, harness: "claude-code", authorityId: "authority", nativeSessionId: "native", profileId: "base:cc", cwd: "/fixture", status: "completed",
        lastRunId: null, workspaceId: "workspace", worktreeId: "tree", association: "resolved" }], pendingInputs: view(1),
      pendingInputLoading: false, pendingInputError: "", pendingInputOperations: {}, actionBusy: false,
      availability: { canSend: false, code: "conversation-busy", reason: "Busy" } };
    store.setDraft({ text: "Explicit future message" });
    let supported = true, locked = true;
    const spies: { mockRestore: () => void }[] = [spyOn(store, "pendingInputSupported").mockImplementation(() => supported),
      spyOn(store, "pendingInputChainLocked").mockImplementation(() => locked), spyOn(store, "pendingInputUnavailable").mockReturnValue(""),
      spyOn(store, "setPendingInputVisible").mockImplementation(() => {})];
    const enqueue = spyOn(store, "enqueuePendingInput").mockImplementation(async () => ({ status: "queued", conversationId, requestId: "receipt" })); spies.push(enqueue);
    const resume = spyOn(store, "resumePendingInputs").mockImplementation(async () => {}); spies.push(resume);
    const remove = spyOn(store, "removePendingInput").mockImplementation(async () => {}); spies.push(remove);
    const check = spyOn(store, "checkPendingInput").mockImplementation(async () => {}); spies.push(check);
    const refresh = spyOn(store, "refreshPendingInputs").mockImplementation(async () => true); spies.push(refresh);
    const retransmit = spyOn(store, "retransmitPendingInput").mockImplementation(async () => {}); spies.push(retransmit);
    let sends = 0;
    const render = () => root.render(<ChatComposer state={store.state} ack="" onAckChange={() => {}} sendDisabled={false} send={() => { sends++; }}
      navigation={<nav aria-label="Views"><button type="button">Terminal</button></nav>} />);
    const primary = () => host.querySelector<HTMLButtonElement>(".pending-input-primary")!;
    try {
      await act(async () => render());
      const input = host.querySelector<HTMLTextAreaElement>("textarea.composer-input")!;
      const shortcut = (metaKey = false) => input.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Enter", ctrlKey: !metaKey, metaKey, bubbles: true }) as unknown as Event);
      expect(primary().textContent).toBe("Queue message"); expect(primary().dataset.mode).toBe("queue"); expect(primary().disabled).toBe(false);
      expect(primary().closest(".chat-input-with-send")).not.toBeNull(); expect(host.querySelector(".pending-input-panel")).toBeNull();
      expect(host.querySelector(".composer-toolbar .pending-input-primary")).toBeNull();
      expect(host.querySelector(".composer-actions")!.lastElementChild?.getAttribute("aria-label")).toBe("Views");
      // Visible Queue is not consent to Send when capability changes before paint.
      const queueState = store.state;
      supported = false; locked = false; store.state = { ...queueState, pendingInputs: null, availability: { canSend: true } };
      await act(async () => { shortcut(); primary().click(); });
      expect({ sends, enqueue: enqueue.mock.calls.length }).toEqual({ sends: 0, enqueue: 0 });
      supported = true; locked = true; store.state = queueState;
      // Composition capture is synchronous, before React updates button disabled.
      await act(async () => {
        input.dispatchEvent(new browser.CompositionEvent("compositionstart", { bubbles: true }) as unknown as Event);
        primary().click(); shortcut();
      });
      expect(enqueue).not.toHaveBeenCalled();
      await act(async () => input.dispatchEvent(new browser.CompositionEvent("compositionend", { bubbles: true }) as unknown as Event));

      await act(async () => host.querySelector<HTMLButtonElement>(".composer-status-info")!.click());
      const removal = host.querySelector<HTMLButtonElement>(".pending-input-list button")!;
      expect(removal.disabled).toBe(false);
      store.state = { ...queueState, selected: "other" };
      await act(async () => removal.click());
      expect(remove).not.toHaveBeenCalled();
      store.state = queueState;
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close conversation activity"]')!.click());
      await act(async () => shortcut());
      expect(enqueue).toHaveBeenCalledTimes(1); expect(enqueue).toHaveBeenLastCalledWith("Explicit future message"); expect(sends).toBe(0);

      // Backend uncertainty is not an unknown frontend operation; appending is
      // allowed, and adding to a paused chain never silently resumes its head.
      store.state = { ...store.state, pendingInputs: view(1, true) }; await act(async () => render());
      expect(primary().textContent).toBe("Add to paused queue"); expect(primary().dataset.mode).toBe("add-paused"); expect(primary().disabled).toBe(false);
      await act(async () => shortcut(true)); expect(enqueue).toHaveBeenCalledTimes(2); expect(resume).not.toHaveBeenCalled();
      store.state = { ...store.state, pendingInputs: view(3) }; await act(async () => render());
      expect(primary().textContent).toBe("Queue message"); expect(primary().disabled).toBe(true); expect(primary().title).toContain("3/3");
      expect(pendingInputLid(store.state, true)?.waitingLabel).toBe("Waiting 3/3");
      await act(async () => { shortcut(); host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
      expect(enqueue).toHaveBeenCalledTimes(2); expect(sends).toBe(0);

      store.state = { ...store.state, pendingInputs: view(1) }; await act(async () => render());
      input.focus(); input.setSelectionRange(5, 5);
      await act(async () => input.dispatchEvent(new browser.CompositionEvent("compositionstart", { bubbles: true }) as unknown as Event));
      expect(primary().disabled).toBe(true);
      await act(async () => { shortcut(); host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
      expect(enqueue).toHaveBeenCalledTimes(2); expect(host.querySelector("textarea.composer-input")).toBe(input); expect(input.selectionStart).toBe(5);
      await act(async () => input.dispatchEvent(new browser.CompositionEvent("compositionend", { bubbles: true }) as unknown as Event));
      const requestId = "11111111-1111-4111-8111-111111111111";
      store.state = { ...store.state, pendingInputOperations: { [requestId]: { conversationId, requestId, kind: "enqueue", state: "unknown", text: "Original request" } } };
      await act(async () => render());
      expect(primary().textContent).toBe("Check request"); expect(primary().dataset.mode).toBe("check-request");
      await act(async () => shortcut());
      expect(document.querySelectorAll("dialog").length).toBe(1); expect(document.querySelector("dialog")!.textContent).toContain("Original request");
      expect(enqueue).toHaveBeenCalledTimes(2); expect(check).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
      expect(retransmit).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled(); expect(sends).toBe(0);
      expect(store.draft().text).toBe("Explicit future message"); expect(host.querySelector("textarea.composer-input")).toBe(input);
      // Losing feature/read availability must retain the original recovery UI.
      supported = false; locked = false;
      store.state = { ...store.state, pendingInputs: null, connected: false, pendingInputError: "Backend unavailable", availability: { canSend: false } };
      await act(async () => render());
      expect({ mode: primary().dataset.mode, disabled: primary().disabled, lid: !!host.querySelector(".composer-status-lid"),
        queueDetails: host.querySelector(".composer-status-info")!.getAttribute("aria-label")!.includes("queue details"), retainedLid: pendingInputLid(store.state, false)?.text })
        .toEqual({ mode: "check-request", disabled: false, lid: true, queueDetails: true, retainedLid: "Request unconfirmed" });
      await act(async () => primary().click());
      expect({ text: host.textContent!.includes("Original request"), id: host.textContent!.includes(requestId), debug: !!host.querySelector(".pending-input-debug"),
        unavailable: host.textContent!.includes("Queue execution is currently unavailable") }).toEqual({ text: true, id: true, debug: true, unavailable: true });
      const recovery = Array.from(host.querySelectorAll<HTMLButtonElement>(".pending-input-operation-actions button"));
      expect(recovery.map(button => button.disabled)).toEqual([false, false]);
      const retainedState = store.state;
      for (const staleState of [
        { ...retainedState, selected: "other" },
        { ...retainedState, config: { ...retainedState.config!, storeId: "44444444-4444-4444-8444-444444444444" } },
        { ...retainedState, config: { ...retainedState.config!, authenticated: false } },
        { ...retainedState, phase: "connecting" as const },
        ...["harness", "authorityId", "nativeSessionId", "cwd"].map(field => ({ ...retainedState,
          conversations: retainedState.conversations.map(conversation => ({ ...conversation, [field]: field === "harness" ? "opencode" : "rebound" })) })),
      ]) {
        store.state = staleState;
        await act(async () => { recovery.forEach(button => button.click()); shortcut(); primary().click(); });
      }
      expect({ check: check.mock.calls.length, replay: retransmit.mock.calls.length, remove: remove.mock.calls.length,
        resume: resume.mock.calls.length, enqueue: enqueue.mock.calls.length, sends }).toEqual({ check: 0, replay: 0, remove: 0, resume: 0, enqueue: 2, sends: 0 });
      // A rendered Check never becomes Send just because its operation disappears.
      store.state = { ...retainedState, pendingInputOperations: {}, connected: true, pendingInputError: "", availability: { canSend: true } };
      await act(async () => { shortcut(); primary().click(); });
      expect({ enqueue: enqueue.mock.calls.length, sends }).toEqual({ enqueue: 2, sends: 0 });
      store.state = retainedState;
      await act(async () => recovery[0]!.click());
      await act(async () => recovery[1]!.click());
      expect(check).toHaveBeenCalledWith(requestId); expect(retransmit).toHaveBeenCalledWith(requestId);
      store.state = { ...retainedState, config: { ...retainedState.config!, authenticated: false } };
      await act(async () => render());
      expect({ recovery: host.textContent!.includes("Original request"), dialogs: document.querySelectorAll("dialog").length }).toEqual({ recovery: false, dialogs: 0 });
      const otherSelection = { ...store.state, selected: "other", pendingInputOperations: {} };
      expect(pendingInputLid(otherSelection, true)).toBeNull();
      expect(pendingInputPrimaryAction({ state: otherSelection, supported: true, chainLocked: false, command: false, text: "Message", sendBlocked: false,
        sendReason: null, queueReason: null, inactive: false, composing: false }).mode).toBe("send");
    } finally { for (const spy of spies.reverse()) spy.mockRestore(); }
  });
});
