import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { CommandRegistry, commandContext, commandHint, commandHints, type ApplicationCommand } from "./application-commands";

test("command capture uses precise platform Mod and ignores unrelated, repeat, IME and disabled keys", () => {
  const browser = new Window(), registry = new CommandRegistry();
  let calls = 0, enabled = true;
  registry.register({ id: "search", label: "Search", binding: { key: "f", mod: true, shift: true }, contexts: ["application", "editor"], available: () => enabled, action: () => calls++ });
  const event = (options: object = {}) => new browser.KeyboardEvent("keydown", { key: "F", metaKey: true, shiftKey: true, cancelable: true, bubbles: true, ...options }) as unknown as KeyboardEvent;
  const run = (options = {}, mac = true) => { const key = event(options); const handled = registry.dispatch(key, "application", mac); expect(key.defaultPrevented).toBe(handled); return handled; };
  expect(run()).toBe(true); expect(calls).toBe(1);
  expect(run({ metaKey: false, ctrlKey: true }, false)).toBe(true);
  for (const options of [{ shiftKey: false }, { altKey: true }, { ctrlKey: true }, { key: "p" }, { repeat: true }, { isComposing: true }, { metaKey: false }]) expect(run(options)).toBe(false);
  const legacyIME = event(); Object.defineProperty(legacyIME, "keyCode", { value: 229 }); expect(registry.dispatch(legacyIME, "application", true)).toBe(false);
  const altGraph = event(); altGraph.getModifierState = key => key === "AltGraph"; expect(registry.dispatch(altGraph, "application", true)).toBe(false);
  expect(run({}, false)).toBe(false);
  enabled = false; expect(run()).toBe(false); expect(registry.run("search")).toBe(false);
  expect(registry.run("absent")).toBe(false);
  enabled = true; const prevented = event(); prevented.preventDefault(); expect(registry.dispatch(prevented, "application", true)).toBe(false);
  for (const context of ["terminal", "input", "modal"] as const) { const key = event(); expect(registry.dispatch(key, context, true)).toBe(false); expect(key.defaultPrevented).toBe(false); }
  expect(commandHint({ key: "f", mod: true, shift: true }, true)).toBe("⌘⇧F");
  expect(commandHint({ key: "f", mod: true, shift: true }, false)).toBe("Ctrl+Shift+F");
  browser.close();
});

test("eligible command priority wins and disabled registrations do not intercept a fallback", () => {
  const browser = new Window(), registry = new CommandRegistry(), calls: string[] = [];
  let enabled = true;
  const common = { binding: { key: "f", mod: true, shift: true }, contexts: ["application", "modal"] as const };
  registry.register({ ...common, id: "global", label: "Global", priority: 0, available: () => true, action: () => calls.push("global") });
  const unregister = registry.register({ ...common, id: "local", label: "Local", priority: 100, available: () => enabled, action: () => calls.push("local") });
  const key = () => new browser.KeyboardEvent("keydown", { key: "f", ctrlKey: true, shiftKey: true, cancelable: true }) as unknown as KeyboardEvent;
  expect(registry.dispatch(key(), "modal", false)).toBe(true); enabled = false;
  expect(registry.dispatch(key(), "modal", false)).toBe(true); unregister();
  expect(registry.list().map(command => command.id)).toEqual(["global"]);
  expect(calls).toEqual(["local", "global"]); browser.close();
});

test("platform-specific aliases dispatch and display only on their platform", () => {
  const browser = new Window(), registry = new CommandRegistry();
  let calls = 0;
  const command: ApplicationCommand = { id: "delete", label: "Delete", bindings: [{ key: "Delete" }, { key: "Backspace", meta: true, platform: "mac" }], available: () => true, action: () => calls++ };
  registry.register(command);
  const run = (key: string, mac: boolean, metaKey = false) => {
    const event = new browser.KeyboardEvent("keydown", { key, metaKey, cancelable: true }) as unknown as KeyboardEvent;
    const handled = registry.dispatch(event, "application", mac);
    expect(event.defaultPrevented).toBe(handled); return handled;
  };
  expect(commandHints(command, true)).toEqual(["Delete", "⌘Backspace"]);
  expect(commandHints(command, false)).toEqual(["Delete"]);
  expect(run("Delete", true)).toBe(true); expect(run("Delete", false)).toBe(true);
  expect(run("Backspace", true, true)).toBe(true);
  expect(run("Backspace", false, true)).toBe(false);
  expect(run("Backspace", true)).toBe(false);
  expect(calls).toBe(3); browser.close();
});

test("keyboard-only eligibility does not disable visible execution or swallow an eligible fallback", () => {
  const browser = new Window(), registry = new CommandRegistry(), calls: string[] = [];
  let focused = false;
  const common = { binding: { key: "r", shift: true }, available: () => true };
  registry.register({ ...common, id: "fallback", label: "Fallback", action: () => calls.push("fallback") });
  registry.register({ ...common, id: "rename", label: "Rename", priority: 20, keyboardEligible: (_event, context) => focused && context === "application", action: () => calls.push("rename") });
  const key = () => new browser.KeyboardEvent("keydown", { key: "R", shiftKey: true, cancelable: true }) as unknown as KeyboardEvent;
  expect(registry.get("rename")?.available()).toBe(true);
  expect(registry.run("rename")).toBe(true);
  expect(registry.dispatch(key(), "application", false)).toBe(true);
  focused = true; expect(registry.dispatch(key(), "application", false)).toBe(true);
  for (const context of ["input", "editor", "terminal", "modal"] as const) {
    const event = key(); expect(registry.dispatch(event, context, false)).toBe(false); expect(event.defaultPrevented).toBe(false);
  }
  expect(calls).toEqual(["rename", "fallback", "rename"]); browser.close();
});

test("visible command execution and shortcuts agree when a higher-priority override is unavailable", () => {
  const browser = new Window(), registry = new CommandRegistry(), calls: string[] = [];
  const common = { id: "search", label: "Search", binding: { key: "f", mod: true, shift: true }, contexts: ["application"] as const };
  registry.register({ ...common, priority: 0, available: () => true, action: () => calls.push("fallback") });
  registry.register({ ...common, priority: 100, available: () => false, action: () => calls.push("override") });
  expect(registry.list()).toHaveLength(1);
  expect(registry.get("search")?.priority).toBe(0);
  expect(registry.run("search")).toBe(true);
  const key = new browser.KeyboardEvent("keydown", { key: "f", ctrlKey: true, shiftKey: true, cancelable: true }) as unknown as KeyboardEvent;
  expect(registry.dispatch(key, "application", false)).toBe(true);
  expect(calls).toEqual(["fallback", "fallback"]);
  browser.close();
});

test("one capture listener resolves editor/terminal/modal contexts and eligible priorities", () => {
  const browser = new Window(), document = browser.document as unknown as Document, registry = new CommandRegistry();
  const calls: string[] = [];
  const command = (id: string, priority: number, contexts: ApplicationCommand["contexts"]): ApplicationCommand => ({ id, label: id, priority, contexts, binding: { key: "f", mod: true, shift: true }, available: () => true, action: () => calls.push(id) });
  const dispose = registry.register(command("application", 0, ["application", "editor"]));
  registry.register(command("modal", 100, ["modal"]));
  const detach = registry.attach(document, false);
  document.body.innerHTML = '<div class="cm-editor"><div contenteditable="true"></div></div><div class="xterm"><textarea></textarea></div><input />';
  const emit = (target: Element) => { const event = new browser.KeyboardEvent("keydown", { key: "f", ctrlKey: true, shiftKey: true, cancelable: true, bubbles: true }); target.dispatchEvent(event as unknown as Event); return event.defaultPrevented; };
  expect(commandContext(document.querySelector(".cm-editor div"), document)).toBe("editor");
  expect(emit(document.querySelector(".cm-editor div")!)).toBe(true);
  expect(emit(document.querySelector("textarea")!)).toBe(false);
  expect(emit(document.querySelector("input")!)).toBe(false);
  const modal = document.createElement("dialog"); modal.setAttribute("open", ""); document.body.append(modal);
  expect(emit(document.body)).toBe(true); expect(calls).toEqual(["application", "modal"]);
  modal.remove(); dispose(); expect(emit(document.body)).toBe(false);
  detach(); expect(emit(document.body)).toBe(false); browser.close();
});

test("Ctrl+left Alt works when reported as AltGraph, while right Alt and lost-focus modifier state stay safe", () => {
  const browser = new Window(), document = browser.document as unknown as Document, registry = new CommandRegistry();
  let calls = 0;
  registry.register({ id: "chat", label: "Chat", binding: { key: "c", ctrl: true, alt: true }, contexts: ["input"], available: () => true, action: () => calls++ });
  const detach = registry.attach(document, false);
  const input = document.createElement("textarea"); document.body.append(input);
  const modifier = (type: "keydown" | "keyup", code: string, key = "Alt") => input.dispatchEvent(new browser.KeyboardEvent(type, { key, code, altKey: type === "keydown", bubbles: true }) as unknown as Event);
  const emit = () => {
    const event = new browser.KeyboardEvent("keydown", { key: "c", ctrlKey: true, altKey: true, bubbles: true, cancelable: true });
    // Firefox Windows aliases Ctrl+Alt to AltGraph (as does Happy DOM).
    event.getModifierState = key => key === "AltGraph";
    input.dispatchEvent(event as unknown as Event); return event.defaultPrevented;
  };
  expect(emit()).toBe(false);
  modifier("keydown", "AltLeft"); expect(emit()).toBe(true);
  modifier("keydown", "AltRight", "AltGraph"); expect(emit()).toBe(false);
  modifier("keyup", "AltRight", "AltGraph"); expect(emit()).toBe(true);
  modifier("keyup", "AltLeft"); expect(emit()).toBe(false);
  modifier("keydown", "AltRight", "AltGraph"); expect(emit()).toBe(false);
  browser.dispatchEvent(new browser.Event("blur"));
  modifier("keydown", "AltLeft"); expect(emit()).toBe(true);
  browser.dispatchEvent(new browser.Event("blur")); expect(emit()).toBe(false);
  modifier("keydown", "AltLeft"); detach(); expect(emit()).toBe(false);
  expect(calls).toBe(3); browser.close();
});
