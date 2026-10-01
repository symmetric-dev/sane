import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { groupModels, ModelPicker } from "./model-picker";
import type { ModelChoice } from "./types";

const models: ModelChoice[] = [
  { id: "openai/gpt-5", name: "GPT 5", efforts: [{ id: "high", name: "high" }] },
  { id: "anthropic/claude-sonnet", name: "Claude Sonnet", efforts: [] },
  { id: "anthropic/claude-opus", name: "Claude Opus", efforts: [] },
  { id: "openrouter/vendor/model-v2", name: "Routed model", efforts: [] },
];

async function withPicker(run: (host: HTMLDivElement, render: (props?: { disabled?: boolean; loading?: boolean; models?: ModelChoice[] }) => Promise<void>, changes: string[]) => Promise<void>, initial = "") {
  const browser = new Window({ url: "http://localhost" });
  const globals = { window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement,
    HTMLButtonElement: browser.HTMLButtonElement, Event: browser.Event, KeyboardEvent: browser.KeyboardEvent, PointerEvent: browser.PointerEvent, IS_REACT_ACT_ENVIRONMENT: true };
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  // happy-dom has no top-layer implementation; exercise lifecycle with a small stub.
  Object.assign(browser.HTMLElement.prototype, {
    showPopover() { (this as HTMLElement).setAttribute("data-popover-open", ""); },
    hidePopover() { (this as HTMLElement).removeAttribute("data-popover-open"); },
  });
  let root: Root | undefined;
  const changes: string[] = [];
  function Fixture(props: { disabled?: boolean; loading?: boolean; models?: ModelChoice[] }) {
    const [value, setValue] = useState(initial);
    return <dialog open><label htmlFor="model">Model</label><ModelPicker id="model" models={props.models ?? models} value={value} defaultLabel="Agent default model" disabled={props.disabled} loading={props.loading} onChange={next => { changes.push(next); setValue(next); }} /><button id="outside" type="button">Save</button></dialog>;
  }
  try {
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    const render = async (props = {}) => { await act(async () => { root!.render(<Fixture {...props} />); }); };
    await render(); await run(host, render, changes);
  } finally {
    if (root) await act(async () => root!.unmount());
    browser.close();
    for (const [key, descriptor] of prior) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}
const click = async (element: Element | null) => { expect(element).not.toBeNull(); await act(async () => (element as HTMLElement).click()); };
const key = async (element: Element, value: string) => {
  let event!: KeyboardEvent;
  await act(async () => { event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }); element.dispatchEvent(event); });
  return event;
};
const input = async (host: HTMLElement, label: string, value: string) => {
  const element = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(async () => {
    // Bypass React's value tracker so the native input event is observed.
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

test("groups providers alphabetically, preserves native model order and nested model IDs", () => {
  expect(groupModels([...models, { id: "invalid", name: "Invalid", efforts: [] }]).map(group => [group.id, group.models.map(model => model.id)])).toEqual([
    ["anthropic", ["anthropic/claude-sonnet", "anthropic/claude-opus"]], ["openai", ["openai/gpt-5"]], ["openrouter", ["openrouter/vendor/model-v2"]],
  ]);
});

test("browsing providers never commits; selecting a model commits its complete ID and restores focus", async () => {
  await withPicker(async (host, _render, changes) => {
    await click(host.querySelector("#model"));
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Search providers");
    expect(host.querySelectorAll("[data-provider]")).toHaveLength(3);
    expect(host.querySelector('[aria-label="Search models"]')).toBeNull();
    await click(host.querySelector('[data-provider="anthropic"]'));
    expect(changes).toEqual([]);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Search models");
    expect(host.querySelectorAll(".model-picker-models .model-picker-list button")).toHaveLength(2);
    await click(host.querySelector('[data-provider="openrouter"]'));
    expect(host.querySelector(".model-picker-models .model-picker-list small")?.textContent).toBe("vendor/model-v2");
    await click(host.querySelector(".model-picker-models .model-picker-list button"));
    expect(changes).toEqual(["openrouter/vendor/model-v2"]);
    expect(host.querySelector("#model")?.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement?.id).toBe("model");
    await key(host.querySelector("#model")!, "ArrowDown");
    expect(host.querySelector(".model-picker-popover")?.getAttribute("data-step")).toBe("providers");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Search providers");
  });
});

test("search filters providers and model names/IDs, with empty results and back navigation", async () => {
  await withPicker(async host => {
    await click(host.querySelector("#model"));
    await input(host, "Search providers", "ANTH");
    expect(host.querySelectorAll("[data-provider]")).toHaveLength(1);
    await click(host.querySelector("[data-provider]"));
    await input(host, "Search models", "OPUS");
    expect(host.querySelectorAll(".model-picker-models .model-picker-list button")).toHaveLength(1);
    expect(host.querySelector(".model-picker-models .model-picker-list")?.textContent).toContain("Claude Opus");
    await input(host, "Search models", "no-such-model");
    expect(host.textContent).toContain("No matching models.");
    await click(host.querySelector(".model-picker-back"));
    expect(host.querySelector(".model-picker-popover")?.getAttribute("data-step")).toBe("providers");
    await input(host, "Search providers", "no-such-provider");
    expect(host.textContent).toContain("No matching providers.");
  });
});

test("mouse/touch provider selection tolerates native focus falling back to the parent dialog", async () => {
  await withPicker(async (host, _render, changes) => {
    await click(host.querySelector("#model"));
    for (const [pointerType, provider] of [["mouse", "anthropic"], ["touch", "openrouter"]]) {
      const button = host.querySelector<HTMLButtonElement>(`[data-provider="${provider}"]`)!;
      await act(async () => {
        button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType }));
        // Browsers that do not focus buttons on pointer activation may focus
        // the modal ancestor instead. This isn't an outside interaction.
        host.querySelector("dialog")!.dispatchEvent(new Event("focusin", { bubbles: true }));
      });
      expect(host.querySelector("#model")?.getAttribute("aria-expanded")).toBe("true");
      expect(button.isConnected).toBe(true);
      await click(button);
      expect(host.querySelector(".model-picker-popover")?.getAttribute("data-step")).toBe("models");
      expect(document.activeElement?.getAttribute("aria-label")).toBe("Search models");
      expect(changes).toEqual([]);
    }
    await click(host.querySelector(".model-picker-models .model-picker-list button"));
    expect(changes).toEqual(["openrouter/vendor/model-v2"]);
    expect(host.querySelector("#model")?.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector("dialog")?.hasAttribute("open")).toBe(true);
  });
});

test("focus moving to another field still dismisses the picker without changing the model", async () => {
  await withPicker(async (host, _render, changes) => {
    await click(host.querySelector("#model"));
    await act(async () => host.querySelector<HTMLElement>("#outside")!.focus());
    expect(host.querySelector("#model")?.getAttribute("aria-expanded")).toBe("false");
    expect(changes).toEqual([]);
    expect(document.activeElement?.id).toBe("outside");
  });
});

test("keyboard navigation and Escape dismiss only the picker, not its parent dialog", async () => {
  await withPicker(async (host, _render, changes) => {
    let escaped = 0; host.querySelector("dialog")!.addEventListener("keydown", event => { if ((event as KeyboardEvent).key === "Escape") escaped++; });
    await key(host.querySelector("#model")!, "ArrowDown");
    await key(document.activeElement!, "ArrowDown");
    expect((document.activeElement as HTMLElement).dataset.provider).toBe("anthropic");
    await key(document.activeElement!, "End");
    expect((document.activeElement as HTMLElement).dataset.provider).toBe("openrouter");
    await key(document.activeElement!, "ArrowRight");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Search models");
    await key(document.activeElement!, "ArrowDown");
    await key(document.activeElement!, "ArrowLeft");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Search providers");
    const event = await key(document.activeElement!, "Escape");
    expect(event.defaultPrevented).toBe(true); expect(escaped).toBe(0);
    expect(changes).toEqual([]); expect(host.querySelector("dialog")?.hasAttribute("open")).toBe(true);
    expect(document.activeElement?.id).toBe("model");
  });
});

test("defaults and missing saved models remain available; outside clicks do not change selection", async () => {
  await withPicker(async (host, _render, changes) => {
    expect(host.querySelector("#model")?.textContent).toContain("legacy/provider/model · not in catalog");
    await click(host.querySelector("#model"));
    await act(async () => host.querySelector("#outside")!.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(changes).toEqual([]); expect(host.querySelector("#model")?.getAttribute("aria-expanded")).toBe("false");
    await click(host.querySelector("#model")); await click(host.querySelector(".model-picker-defaults button"));
    expect(changes).toEqual([""]); expect(host.querySelector("#model")?.textContent).toBe("Agent default model");
  }, "legacy/provider/model");
});

test("disabled/loading lifecycle closes the popover and supports empty/refreshed catalogs", async () => {
  await withPicker(async (host, render) => {
    await click(host.querySelector("#model"));
    await render({ disabled: true });
    expect(host.querySelector("#model")?.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector("[data-popover-open]")).toBeNull();
    await render({ models: [], loading: true }); await click(host.querySelector("#model"));
    expect(host.textContent).toContain("Loading providers…");
    await render({ models: [], loading: false }); expect(host.textContent).toContain("No available providers.");
    await render(); expect(host.querySelectorAll("[data-provider]")).toHaveLength(3);
  });
});

test("popover chooses above/below placement and clamps its width to the viewport", async () => {
  await withPicker(async host => {
    const trigger = host.querySelector<HTMLElement>("#model")!;
    trigger.getBoundingClientRect = () => ({ left: 900, top: 600, bottom: 640 } as DOMRect);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 700 });
    await click(trigger);
    const panel = host.querySelector<HTMLElement>(".model-picker-popover")!;
    expect(panel.style.top).toBe("234px"); expect(panel.style.left).toBe("428px");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    trigger.getBoundingClientRect = () => ({ left: 20, top: 50, bottom: 90 } as DOMRect);
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(panel.style.top).toBe("96px"); expect(panel.style.width).toBe("366px"); expect(panel.style.left).toBe("12px");
  });
});
