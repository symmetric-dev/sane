import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { ChatComposer } from "./chat-composer";
import { catalog } from "./catalog";
import { store } from "./store";
import type { PendingInputItem } from "../shared/conversation/pending-input-contract";
import type { PendingInputView } from "./pending-input-presentation";
import { PendingInputDetails, pendingInputStopAction } from "./pending-input-ui";
import { ComposerStatus } from "./composer-status";

test("pending-input UI keeps explicit queue consent, backend waiting controls and the live IME composer", async () => {
  const browser = new Window({ url: "http://localhost" });
  const globals = { window: browser, self: browser, document: browser.document, navigator: browser.navigator,
    HTMLElement: browser.HTMLElement, Event: browser.Event, ResizeObserver: browser.ResizeObserver,
    MutationObserver: browser.MutationObserver, requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true };
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const oldState = store.state, oldCatalog = catalog.state;
  const spies: { mockRestore: () => void }[] = [];
  let root: Root | undefined;
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  try {
    const conversationId = "queue-conversation";
    const source = { harnessId: "claude-code", conversationId, authorityId: "authority", nativeSessionId: "native", cwd: "/fixture" };
    const configuration = { cwd: "/fixture", profileId: "base:cc" };
    const item = (sequence: number, state: "waiting" | "claimed", text: string): PendingInputItem => ({
      version: 1, conversationId, requestId: `input-request-${sequence}`, itemId: `item-${sequence}`, sequence, state, text, source, configuration,
    });
    const head = item(1, "claimed", "Original unresolved input");
    const waiting = [item(2, "waiting", "<img src=x onerror=alert(1)>\nLiteral text"), item(3, "waiting", "Second waiter"), item(4, "waiting", "Third waiter")];
    const view = (items: PendingInputItem[], locked = true): PendingInputView => ({
      snapshot: { version: 1, conversationId, revision: 7, paused: locked, reason: locked ? "Operator stopped the chain" : null, items, tombstones: [] },
      presentation: { maxWaiting: 3, waitingCount: items.filter(item => item.state === "waiting").length,
        chainLocked: locked, chainId: locked ? "chain" : null, source, configuration, currentAssertions: { source, configuration },
        removals: items.map(item => ({ itemId: item.itemId, allowed: item.state === "waiting" && item.sequence !== 3, code: item.state !== "waiting" ? "pending-input-claimed" : item.sequence === 3 ? "owner-unavailable" : null })),
        unresolved: items.some(item => item.state === "claimed") ? { itemId: head.itemId, requestId: head.requestId, classification: "uncertain" } : null,
        pauseCode: locked ? "stop" : null, enqueue: { allowed: true, code: null, reason: null }, removalAllowed: true,
        resumeAllowed: true, automation: { supported: true, reason: null }, hidden: false },
    });
    catalog.state = { ...oldCatalog, ready: true, workspaces: [{ workspaceId: "workspace", kind: "directory", name: "Fixture", commonDir: null,
      worktrees: [{ worktreeId: "tree", root: "/fixture", gitDir: null, bindingRevision: "binding", state: "available" }] }],
      navigation: { ...oldCatalog.navigation, workspaceId: "workspace", worktreeId: "tree", view: "chat" } };
    store.state = { ...oldState, phase: "ready", config: { authRequired: false, authenticated: true, storeId: "33333333-3333-4333-8333-333333333333" },
      selected: conversationId, conversations: [{ id: conversationId, harness: "claude-code", authorityId: "authority", nativeSessionId: "native", profileId: "base:cc", cwd: "/fixture", status: "completed", lastRunId: null,
        workspaceId: "workspace", worktreeId: "tree", association: "resolved" }], runs: [], messages: [], drafts: {}, profiles: null,
      connected: true, loading: false, sending: false, actionBusy: false, availability: { canSend: true }, submissionError: "", modelsError: "", interactions: [],
      pendingInputs: view([], false), pendingInputLoading: false, pendingInputError: "", pendingInputOperations: {} };
    store.setDraft({ text: "Preserved draft\nsecond line  " });
    let supported = true, unavailable = "", active = true, sends = 0, navigationClicks = 0;
    const support = spyOn(store, "pendingInputSupported").mockImplementation(() => supported); spies.push(support);
    const locked = spyOn(store, "pendingInputChainLocked").mockImplementation(() => supported && !!store.state.pendingInputs?.presentation.chainLocked); spies.push(locked);
    const unavailableSpy = spyOn(store, "pendingInputUnavailable").mockImplementation(() => unavailable); spies.push(unavailableSpy);
    const visible = spyOn(store, "setPendingInputVisible").mockImplementation(() => {}); spies.push(visible);
    const enqueue = spyOn(store, "enqueuePendingInput").mockImplementation(async () => ({ status: "queued", conversationId, requestId: "queued-request" })); spies.push(enqueue);
    const remove = spyOn(store, "removePendingInput").mockImplementation(async () => {}); spies.push(remove);
    const resume = spyOn(store, "resumePendingInputs").mockImplementation(async () => {}); spies.push(resume);
    const check = spyOn(store, "checkPendingInput").mockImplementation(async () => {}); spies.push(check);
    const retransmit = spyOn(store, "retransmitPendingInput").mockImplementation(async () => {}); spies.push(retransmit);
    const refresh = spyOn(store, "refreshPendingInputs").mockImplementation(async () => true); spies.push(refresh);
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    const render = () => root!.render(<ChatComposer state={store.state} active={active} ack="" onAckChange={() => {}} sendDisabled={false} send={() => { sends++; }}
      navigation={<nav aria-label="Views"><button type="button" onClick={() => { navigationClicks++; }}>Terminal</button></nav>} />);
    const button = (text: string) => Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === text)!;
    await act(async () => render());
    expect(host.querySelector(".pending-input-panel")).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>("button.agent-chip")!.click());
    expect(document.querySelector("dialog")).not.toBeNull();

    unavailable = "Waiting queue is full (3/3).";
    store.state = { ...store.state, pendingInputs: view([head, ...waiting]), availability: { canSend: false, code: "conversation-busy", reason: "Busy" } };
    await act(async () => render());
    expect(document.querySelector("dialog")).toBeNull();
    expect(host.querySelector<HTMLButtonElement>("button.agent-chip")!.disabled).toBe(true);
    expect(host.querySelector(".pending-input-details")).toBeNull();
    expect(host.querySelector(".composer-status-lid")!.textContent).toContain("Waiting 3/3");
    expect(host.querySelector(".pending-input-queue-action")).toBeNull();
    expect(button("Add to paused queue").disabled).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>(".composer-status-info")!.click());
    expect(document.querySelectorAll("dialog").length).toBe(1);
    expect(host.querySelector('[aria-label="Activity"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Queue"]')).not.toBeNull();
    expect(host.querySelector<HTMLDetailsElement>(".pending-input-debug")!.open).toBe(false);
    expect(host.querySelector(".pending-input-debug pre")!.textContent).toContain('"revision": 7');
    expect(host.querySelector(".pending-input-debug pre")!.textContent).not.toContain("Original unresolved input");
    expect(refresh).not.toHaveBeenCalled(); expect(check).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled();
    expect(host.querySelector(".pending-input-heading")!.textContent).toContain("Waiting 3/3");
    expect(host.querySelector(".pending-input-head")!.textContent).toContain("Uncertain (reconciliation needed)");
    expect(host.querySelectorAll(".pending-input-list li").length).toBe(3);
    expect(host.querySelectorAll(".pending-input-list button").length).toBe(3);
    expect(host.querySelector(".pending-input-list pre")!.textContent).toBe(waiting[0]!.text);
    expect(host.querySelector(".pending-input-details img")).toBeNull();
    expect(host.querySelector(".pending-input-head button")).toBeNull();
    expect(host.textContent).toContain("Waiting messages are paused. Unhide does not resume.");
    expect(host.textContent).toContain("Operator stopped the chain (stop)");
    expect(button("Resume waiting messages").disabled).toBe(true);
    expect(button("Add to paused queue").disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>(".send.pending-input-primary")!.parentElement?.classList.contains("chat-input-with-send")).toBe(true);
    const removeButtons = host.querySelectorAll<HTMLButtonElement>(".pending-input-list button");
    expect(removeButtons[0]!.disabled).toBe(false); expect(removeButtons[1]!.disabled).toBe(true);
    await act(async () => removeButtons[0]!.click());
    expect(remove).toHaveBeenCalledWith(waiting[0]!.itemId);
    expect(resume).not.toHaveBeenCalled();

    const input = host.querySelector<HTMLTextAreaElement>("textarea.composer-input")!;
    input.focus(); input.setSelectionRange(5, 5);
    await act(async () => input.dispatchEvent(new browser.CompositionEvent("compositionstart", { bubbles: true }) as unknown as Event));
    input.value = "Preserved 日本 draft\nsecond line  "; input.setSelectionRange(12, 12);
    await act(async () => input.dispatchEvent(new browser.InputEvent("input", { bubbles: true, isComposing: true }) as unknown as Event));
    unavailable = "";
    store.state = { ...store.state, pendingInputs: view([head, ...waiting.slice(0, 2)]) };
    await act(async () => render());
    expect(host.querySelector("textarea.composer-input")).toBe(input); expect(input.selectionStart).toBe(12);
    expect(button("Add to paused queue").disabled).toBe(true);
    await act(async () => input.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, isComposing: true, bubbles: true }) as unknown as Event));
    expect(enqueue).not.toHaveBeenCalled(); expect(sends).toBe(0);
    await act(async () => input.dispatchEvent(new browser.CompositionEvent("compositionend", { bubbles: true }) as unknown as Event));
    await act(async () => input.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }) as unknown as Event));
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(sends).toBe(0); expect(enqueue).toHaveBeenCalledTimes(2);
    await act(async () => button("Add to paused queue").click());
    expect(enqueue).toHaveBeenCalledTimes(3); expect(enqueue).toHaveBeenCalledWith(input.value);
    expect(store.draft().text).toBe(input.value); expect(host.querySelector("textarea.composer-input")).toBe(input);
    expect(host.querySelector(".composer-actions")!.lastElementChild?.getAttribute("aria-label")).toBe("Views");
    await act(async () => host.querySelector<HTMLButtonElement>("nav button")!.click());
    expect(navigationClicks).toBe(1); expect(sends).toBe(0); expect(enqueue).toHaveBeenCalledTimes(3);

    const originalRequestId = "11111111-1111-4111-8111-111111111111";
    store.state = { ...store.state, pendingInputOperations: { [originalRequestId]: { conversationId, requestId: originalRequestId, kind: "enqueue", state: "unknown", text: "Unconfirmed retained text" },
      other: { conversationId: "other-conversation", requestId: "other", kind: "enqueue", state: "unknown", text: "Private other text" } } };
    await act(async () => render());
    expect(host.textContent).toContain("Admission unconfirmed. Text is retained; this is not a waiting slot.");
    expect(host.textContent).not.toContain("Private other text");
    expect(host.querySelector(".pending-input-heading")!.textContent).toContain("Waiting 2/3");
    expect(button("Check request").disabled).toBe(false);
    expect(host.querySelector<HTMLButtonElement>(".pending-input-list button")!.disabled).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close conversation activity"]')!.click());
    await act(async () => button("Check request").click());
    expect(document.querySelectorAll("dialog").length).toBe(1);
    expect(check).not.toHaveBeenCalled(); expect(retransmit).not.toHaveBeenCalled();
    await act(async () => button("Check status").click());
    await act(async () => button("Resend same request").click());
    expect(check).toHaveBeenCalledWith(originalRequestId); expect(retransmit).toHaveBeenCalledWith(originalRequestId);
    expect(enqueue).toHaveBeenCalledTimes(3); expect(resume).not.toHaveBeenCalled();
    active = false; await act(async () => render()); expect(visible).toHaveBeenLastCalledWith(false);
    expect(document.querySelector("dialog")).toBeNull();
    active = true; await act(async () => render()); expect(visible).toHaveBeenLastCalledWith(true);
    expect(document.querySelector("dialog")).toBeNull();
    expect(resume).not.toHaveBeenCalled(); expect(host.querySelector("textarea.composer-input")).toBe(input);

    supported = false; store.state = { ...store.state, availability: { canSend: true }, pendingInputOperations: {} };
    await act(async () => render());
    expect(host.querySelector(".pending-input-details")).toBeNull(); expect(button("Add to paused queue")).toBeUndefined();
    expect(host.querySelector<HTMLButtonElement>("button.agent-chip")!.disabled).toBe(false);
    await act(async () => input.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }) as unknown as Event));
    expect(sends).toBe(1);

    // External requests are consumed even while hidden, never replayed by
    // navigation, and restore the live composer rather than a changed action.
    supported = true;
    let request = 0;
    const renderStatus = (reconciliation = false) => root!.render(<><textarea id="status-focus" /><ComposerStatus active={active} detailsRequest={request}
      statuses={reconciliation ? [{ id: "pending-input", text: "Requires reconciliation", priority: 95 }] : [{ id: "connection", text: "Connection lost · run status unknown", busy: true }]}
      restoreFocus={() => host.querySelector("#status-focus")}
      queue={{ lid: { text: reconciliation ? "Running" : "Paused", state: reconciliation ? "running" : "paused", waitingLabel: "2/3 waiting" },
        details: <PendingInputDetails state={store.state} active={active} busy={false} operate={action => { void action(); }} /> }} /></>);
    await act(async () => renderStatus());
    expect(document.querySelector("dialog")).toBeNull();
    expect(host.querySelector(".composer-status-text")!.textContent).toBe("Connection lost · run status unknown");
    expect(host.querySelector(".pending-input-status-badge")!.textContent).toBe("2/3 waiting");
    expect(host.querySelector(".composer-status-info")!.getAttribute("aria-label")).toBe("Show activity and queue details: Connection lost · run status unknown · 2/3 waiting");
    request = 1; await act(async () => renderStatus());
    expect(document.querySelectorAll("dialog").length).toBe(1);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close conversation activity"]')!.click());
    expect(document.activeElement).toBe(host.querySelector("#status-focus"));
    await act(async () => renderStatus()); expect(document.querySelector("dialog")).toBeNull();
    active = false; request = 2; await act(async () => renderStatus());
    active = true; await act(async () => renderStatus()); expect(document.querySelector("dialog")).toBeNull();
    request = 3; await act(async () => renderStatus()); expect(document.querySelectorAll("dialog").length).toBe(1);
    active = false; await act(async () => renderStatus()); expect(document.querySelector("dialog")).toBeNull();
    active = true; await act(async () => renderStatus()); expect(document.querySelector("dialog")).toBeNull();
    await act(async () => renderStatus(true));
    expect({ text: host.querySelector(".composer-status-text")!.textContent,
      icon: host.querySelector(".composer-status-lid > span")!.className,
      badge: host.querySelector(".pending-input-status-badge")!.textContent,
      reassuresRunning: host.querySelector(".composer-status-lid")!.textContent!.includes("Running")
        || host.querySelector(".composer-status-info")!.getAttribute("aria-label")!.includes("Running"),
      dialog: document.querySelector("dialog") }).toEqual({ text: "Requires reconciliation", icon: "composer-status-dot", badge: "2/3 waiting", reassuresRunning: false, dialog: null });
    expect(resume).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
  } finally {
    if (root) await act(async () => root!.unmount());
    for (const spy of spies.reverse()) spy.mockRestore();
    store.state = oldState; catalog.state = oldCatalog; browser.close();
    for (const [key, descriptor] of prior) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

test("Thread queue Pause is independent of native cancellation and preserves uncertain admissions", async () => {
  // Verify this is Thread's actual action gate, not a separate test-only control.
  const thread = readFileSync(new URL("./thread.tsx", import.meta.url), "utf8");
  expect(thread).toContain('import { pendingInputStopAction } from "./pending-input-ui";');
  expect(thread).toContain("const chainLocked = store.pendingInputSupported() && store.pendingInputChainLocked();");
  expect(thread).toMatch(/const statusActions = pendingInputStopAction\(\{ chainLocked, appRunning, cancelRun: capabilities\.cancelRun === true, nativeQueueWaiting,/);
  expect(thread).toMatch(/cancel: \(\) => void store\.cancel\(\) \}\);/);
  expect(thread).toContain("statusActions={statusActions}");

  const browser = new Window({ url: "http://localhost" });
  const globals = { window: browser, self: browser, document: browser.document, navigator: browser.navigator,
    HTMLElement: browser.HTMLElement, Event: browser.Event, ResizeObserver: browser.ResizeObserver,
    MutationObserver: browser.MutationObserver, requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true };
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const oldState = store.state, oldCatalog = catalog.state;
  const spies: { mockRestore: () => void }[] = [];
  let root: Root | undefined, settleCancel: (() => void) | undefined;
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  try {
    const conversationId = "pause-conversation";
    const source = { harnessId: "claude-code", conversationId, authorityId: "authority", nativeSessionId: "native", cwd: "/fixture" };
    const configuration = { cwd: "/fixture", profileId: "base:cc" };
    const item = (sequence: number, state: "claimed" | "waiting"): PendingInputItem => ({ version: 1, conversationId,
      requestId: `request-${sequence}`, itemId: `item-${sequence}`, sequence, state, text: `Original text ${sequence}`, source, configuration });
    const head = item(1, "claimed"), waiter = item(2, "waiting");
    const view: PendingInputView = {
      snapshot: { version: 1, conversationId, revision: 7, paused: true, reason: "Operator stopped the chain", items: [head, waiter], tombstones: [] },
      presentation: { maxWaiting: 3, waitingCount: 1, chainLocked: true, chainId: "known-chain", source, configuration,
        currentAssertions: { source, configuration }, removals: [{ itemId: waiter.itemId, allowed: true, code: null }],
        unresolved: { itemId: head.itemId, requestId: head.requestId, classification: "uncertain" }, pauseCode: "stop",
        enqueue: { allowed: false, code: "pending-input-claimed", reason: "Unresolved head" }, removalAllowed: true,
        resumeAllowed: true, automation: { supported: true, reason: null }, hidden: false },
    };
    catalog.state = { ...oldCatalog, ready: true, workspaces: [{ workspaceId: "workspace", kind: "directory", name: "Fixture", commonDir: null,
      worktrees: [{ worktreeId: "tree", root: "/fixture", gitDir: null, bindingRevision: "binding", state: "available" }] }],
      navigation: { ...oldCatalog.navigation, workspaceId: "workspace", worktreeId: "tree", view: "chat" } };
    const requestId = "22222222-2222-4222-8222-222222222222";
    store.state = { ...oldState, phase: "ready", config: { authRequired: false, authenticated: true, storeId: "33333333-3333-4333-8333-333333333333" },
      selected: conversationId, conversations: [{ id: conversationId, harness: "claude-code", authorityId: "authority", nativeSessionId: "native", profileId: "base:cc", cwd: "/fixture", status: "completed", lastRunId: null,
        workspaceId: "workspace", worktreeId: "tree", association: "resolved" }], runs: [], messages: [], drafts: {}, profiles: null,
      connected: false, loading: false, sending: false, actionBusy: false, availability: { canSend: false, reason: "Source unavailable" },
      submissionError: "", modelsError: "", interactions: [], pendingInputs: view, pendingInputLoading: false,
      pendingInputError: "Queue read failed; retained last known chain", pendingInputOperations: {
        [requestId]: { conversationId, requestId, kind: "enqueue", state: "unknown", text: "Retained uncertain admission" } } };
    const operations = store.state.pendingInputOperations;
    let supported = true, chainLocked = true, appRunning = false, cancelRun = false, active = true;
    spies.push(spyOn(store, "pendingInputSupported").mockImplementation(() => supported));
    spies.push(spyOn(store, "pendingInputChainLocked").mockImplementation(() => chainLocked));
    spies.push(spyOn(store, "pendingInputUnavailable").mockImplementation(() => "Source unavailable"));
    spies.push(spyOn(store, "setPendingInputVisible").mockImplementation(() => {}));
    const cancel = spyOn(store, "cancel").mockImplementation(() => new Promise<void>(resolve => { settleCancel = resolve; })); spies.push(cancel);
    const resume = spyOn(store, "resumePendingInputs").mockImplementation(async () => {}); spies.push(resume);
    const remove = spyOn(store, "removePendingInput").mockImplementation(async () => {}); spies.push(remove);
    const retransmit = spyOn(store, "retransmitPendingInput").mockImplementation(async () => {}); spies.push(retransmit);
    const enqueue = spyOn(store, "enqueuePendingInput").mockImplementation(async () => ({ status: "queued", conversationId, requestId })); spies.push(enqueue);
    const check = spyOn(store, "checkPendingInput").mockImplementation(async () => {}); spies.push(check);
    const refresh = spyOn(store, "refreshPendingInputs").mockImplementation(async () => true); spies.push(refresh);
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    const render = () => root!.render(<ChatComposer state={store.state} active={active} ack="" onAckChange={() => {}} sendDisabled send={() => {}}
      statusActions={pendingInputStopAction({ chainLocked: store.pendingInputSupported() && store.pendingInputChainLocked(), appRunning, cancelRun, nativeQueueWaiting: false,
        disabled: store.state.actionBusy || store.state.sending || (supported && chainLocked ? store.state.phase !== "ready" || store.state.config?.authenticated !== true : !store.state.connected),
        cancel: () => void store.cancel() })} />);
    const action = () => host.querySelector<HTMLButtonElement>(".composer-status-stop");
    await act(async () => render());
    expect(action()?.textContent).toBe("Pause waiting messages"); expect(action()?.disabled).toBe(false);
    await act(async () => host.querySelector<HTMLButtonElement>(".composer-status-info")!.click());
    expect(Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "Resume waiting messages")?.disabled).toBe(true);
    expect(host.textContent).toContain("Uncertain (reconciliation needed)");
    expect(host.textContent).toContain("This unconfirmed admission may not yet belong to that chain.");
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close conversation activity"]')!.click());
    const primary = () => host.querySelector<HTMLButtonElement>(".send.pending-input-primary")!;
    expect({ label: primary().textContent, disabled: primary().disabled }).toEqual({ label: "Check request", disabled: false });
    await act(async () => primary().click());
    expect({ dialogs: document.querySelectorAll("dialog").length, warning: host.textContent!.includes("This unconfirmed admission may not yet belong to that chain."),
      retained: store.state.pendingInputOperations?.[requestId]?.requestId }).toEqual({ dialogs: 1, warning: true, retained: requestId });
    expect({ cancel: cancel.mock.calls.length, enqueue: enqueue.mock.calls.length, resume: resume.mock.calls.length,
      remove: remove.mock.calls.length, replay: retransmit.mock.calls.length, check: check.mock.calls.length, refresh: refresh.mock.calls.length })
      .toEqual({ cancel: 0, enqueue: 0, resume: 0, remove: 0, replay: 0, check: 0, refresh: 0 });
    await act(async () => action()!.click());
    expect(cancel).toHaveBeenCalledTimes(1); expect(cancel).toHaveBeenCalledWith();
    expect(action()?.textContent).toBe("Pause waiting messages"); expect(action()?.title).toContain("does not remove claimed work or confirm native interruption");
    expect(store.state.pendingInputOperations).toBe(operations); expect(store.state.pendingInputs).toBe(view);
    expect(resume).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled(); expect(retransmit).not.toHaveBeenCalled();
    appRunning = true; await act(async () => render()); expect(action()?.textContent).toBe("Pause waiting messages");
    chainLocked = false; await act(async () => render()); expect(action()).toBeNull();
    cancelRun = true; store.state = { ...store.state, connected: true }; await act(async () => render()); expect(action()?.textContent).toBe("Stop run");
    chainLocked = true; await act(async () => render()); expect(action()?.textContent).toBe("Stop run and pause waiting");
    appRunning = false; await act(async () => render()); expect(action()?.textContent).toBe("Pause waiting messages");
    store.state = { ...store.state, actionBusy: true }; await act(async () => render()); expect(action()?.disabled).toBe(true);
    store.state = { ...store.state, actionBusy: false, sending: true }; await act(async () => render()); expect(action()?.disabled).toBe(true);
    chainLocked = false; cancelRun = false; store.state = { ...store.state, sending: false, pendingInputs: null }; await act(async () => render());
    expect({ pause: action(), unavailable: host.textContent!.includes("Queue status is unavailable."),
      advisory: host.textContent!.includes("This unconfirmed admission may not yet belong to that chain."),
      retained: store.state.pendingInputOperations?.[requestId]?.requestId }).toEqual({ pause: null, unavailable: true, advisory: true, retained: requestId });
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close conversation activity"]')!.click());
    await act(async () => primary().click());
    expect({ dialogs: document.querySelectorAll("dialog").length, cancel: cancel.mock.calls.length, enqueue: enqueue.mock.calls.length,
      resume: resume.mock.calls.length, replay: retransmit.mock.calls.length, retained: store.state.pendingInputOperations?.[requestId]?.requestId })
      .toEqual({ dialogs: 1, cancel: 1, enqueue: 0, resume: 0, replay: 0, retained: requestId });
    active = false; await act(async () => render()); expect(document.querySelector("dialog")).toBeNull();
    active = true; await act(async () => render()); expect(document.querySelector("dialog")).toBeNull();
    supported = false; await act(async () => render()); expect(action()).toBeNull(); expect(host.querySelector(".pending-input-panel")).toBeNull();
  } finally {
    settleCancel?.();
    if (root) await act(async () => root!.unmount());
    for (const spy of spies.reverse()) spy.mockRestore();
    store.state = oldState; catalog.state = oldCatalog; browser.close();
    for (const [key, descriptor] of prior) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
