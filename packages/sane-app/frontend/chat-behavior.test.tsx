import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { ChatInput } from "./chat-input";
import { FollowLatest } from "./chat-scroll";

test("typing, spaces, IME and earlier-line selection survive streaming parent updates without value writes", async () => {
  const browser = new Window({ url: "http://localhost" });
  const globals = { window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, Event: browser.Event, IS_REACT_ACT_ENVIRONMENT: true };
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let root: Root | undefined;
  try {
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    let saved = "first line\nsecond line\nthird line", tick = 0, sends = 0;
    const render = () => root!.render(<div><p>Stream event {tick++}</p><ChatInput key="conversation-a" text={saved} save={text => { saved = text; render(); }} submit={() => { sends++; }} /></div>);
    await act(async () => render());
    const textarea = host.querySelector("textarea")!;
    const descriptor = Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value")!;
    let writes = 0;
    Object.defineProperty(textarea, "value", { configurable: true, get() { return descriptor.get!.call(this); }, set(value) { writes++; descriptor.set!.call(this, value); } });
    textarea.focus(); textarea.setSelectionRange(5, 5); textarea.scrollTop = 9;
    for (const text of ["first  line\nsecond line\nthird line", "first é line\nsecond line\nthird line", "first 日本 line\nsecond line\nthird line"]) {
      // Native editing mutates the DOM before the input event, bypassing JS setter.
      descriptor.set!.call(textarea, text); textarea.setSelectionRange(7, 7); textarea.scrollTop = 9;
      await act(async () => { textarea.dispatchEvent(new browser.InputEvent("input", { bubbles: true, inputType: "insertCompositionText", isComposing: true }) as unknown as Event); });
      for (let i = 0; i < 5; i++) await act(async () => render());
      expect(host.querySelector("textarea")).toBe(textarea);
      expect(textarea.value).toBe(text);
      expect(saved).toBe(text);
      expect(textarea.selectionStart).toBe(7);
      expect(textarea.selectionEnd).toBe(7);
      expect(textarea.scrollTop).toBe(9);
    }
    expect(writes).toBe(0);
    // A delayed saved-draft update must not clobber a live composition. The
    // composition-end event commits the DOM buffer back to the saved draft.
    const composed = textarea.value;
    await act(async () => { textarea.dispatchEvent(new browser.CompositionEvent("compositionstart", { bubbles: true }) as unknown as Event); });
    saved = "stale saved draft";
    await act(async () => render());
    expect(textarea.value).toBe(composed); expect(writes).toBe(0);
    await act(async () => { textarea.dispatchEvent(new browser.CompositionEvent("compositionend", { bubbles: true }) as unknown as Event); });
    expect(saved).toBe(composed); expect(writes).toBe(0);
    await act(async () => { textarea.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, isComposing: true, bubbles: true }) as unknown as Event); });
    expect(sends).toBe(0);
    await act(async () => { textarea.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event); });
    expect(sends).toBe(0);
    await act(async () => { textarea.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }) as unknown as Event); });
    expect(sends).toBe(1);
    // An explicit accepted unchanged draft can clear; ordinary polls never do.
    saved = ""; await act(async () => render());
    expect(textarea.value).toBe(""); expect(writes).toBe(1);
    await act(async () => root!.render(<ChatInput key="conversation-b" text="other draft  " save={() => {}} submit={() => {}} />));
    expect(host.querySelector("textarea")!.value).toBe("other draft  ");
  } finally {
    if (root) await act(async () => root!.unmount()); browser.close();
    for (const [key, descriptor] of prior) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

test("upward scrolling during simultaneous history growth defeats follow-latest until explicitly restored", () => {
  const follow = new FollowLatest();
  follow.scrolled(600, 1000, 400); expect(follow.following).toBe(true);
  // Regression: installed assistant-ui's isUserScrollUp requires equal heights.
  // 1000 -> 1100 during this gesture previously left followBottom=true.
  follow.scrolled(500, 1100, 400); expect(follow.following).toBe(false);
  follow.scrolled(500, 1300, 400); expect(follow.following).toBe(false);
  follow.pause(); follow.scrolled(600, 1400, 400); expect(follow.following).toBe(false);
  follow.follow(); expect(follow.following).toBe(true);
  follow.pause(); follow.scrolled(1000, 1400, 400); expect(follow.following).toBe(true);
});
