import { expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { ComposerStatus } from "./composer-status";
import { store } from "./store";

test("Verify completion requires explicit confirmation and Cancel does not submit", async () => {
  const browser = new Window({ url: "http://localhost" });
  const globals = { window: browser, self: browser, document: browser.document, navigator: browser.navigator,
    HTMLElement: browser.HTMLElement, Event: browser.Event, MutationObserver: browser.MutationObserver,
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true };
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const state = store.state;
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let calls = 0, root: Root | undefined;
  const target = { sessionId: "A", runId: "00000000-0000-4000-8000-000000000001", nativeSessionId: "ses_A", nativeCommandId: "msg_A" };
  const prepare = spyOn(store, "prepareCompletionVerification").mockImplementation(input => {
    expect(input).toEqual(target); return async () => { calls++; };
  });
  try {
    store.state = { ...state, selected: "A", actionBusy: false };
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(<ComposerStatus active statuses={[{ id: "run", text: "Run completion needs verification", action: "verify-completion", verificationTarget: target }]} restoreFocus={() => host} />));
    const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text)!;
    await act(async () => button("Verify completion").click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain("latest native OpenCode execution is idle");
    expect(document.body.textContent).toContain("does not resend your prompt");
    expect(calls).toBe(0);
    await act(async () => button("Cancel").click()); expect(calls).toBe(0);
    await act(async () => button("Verify completion").click());
    await act(async () => button("Confirm verification").click()); expect(calls).toBe(1);
  } finally {
    if (root) await act(async () => root!.unmount());
    prepare.mockRestore(); store.state = state; browser.close();
    for (const [key, descriptor] of prior) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
