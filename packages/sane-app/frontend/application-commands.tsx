import { createContext, useContext, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

export type CommandContext = "application" | "editor" | "input" | "terminal" | "modal";
export type CommandScope = { kind: "global" } | { kind: "view"; view: "files"; region: "view" | "sidebar" | "main-panel" };
export type CommandBinding = {
  key: string; mod?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean;
  platform?: "mac" | "windows-linux";
};
export type CommandBindings = { binding?: CommandBinding; bindings?: readonly CommandBinding[] };
export type ApplicationCommand = {
  id: string; label: string; scope?: CommandScope; contexts?: readonly CommandContext[]; priority?: number;
  /** Keyboard-only target/region checks. Never used to disable buttons or programmatic execution. */
  keyboardEligible?: (event: KeyboardEvent, context: CommandContext) => boolean;
  available: () => boolean; action: () => void;
} & CommandBindings;
export const isMacPlatform = () => /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
export function bindingApplies(binding: CommandBinding, mac: boolean) {
  return !binding.platform || binding.platform === (mac ? "mac" : "windows-linux");
}
/** The singular binding remains supported; bindings adds alternatives in display order. */
export function commandBindings(command: CommandBindings, mac = isMacPlatform()): readonly CommandBinding[] {
  return [...(command.binding ? [command.binding] : []), ...(command.bindings ?? [])].filter(binding => bindingApplies(binding, mac));
}
export function commandHint(binding: CommandBinding, mac = isMacPlatform()) {
  const key = binding.key.length === 1 ? binding.key.toUpperCase() : binding.key;
  return [binding.mod ? mac ? "⌘" : "Ctrl" : "", binding.ctrl ? "Ctrl" : "", binding.meta ? "⌘" : "", binding.alt ? mac ? "⌥" : "Alt" : "", binding.shift ? mac ? "⇧" : "Shift" : "", key].filter(Boolean).join(mac ? "" : "+");
}
export function commandHints(command: CommandBindings, mac = isMacPlatform()) {
  return [...new Set(commandBindings(command, mac).map(binding => commandHint(binding, mac)))];
}
export function commandContext(target: EventTarget | null, document: Document): CommandContext {
  const element = target && "closest" in target ? target as Element : null;
  if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return "modal";
  if (element?.closest('.xterm, [data-command-context="terminal"]')) return "terminal";
  if (element?.closest('.cm-editor, [data-command-context="editor"]')) return "editor";
  if (element?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [data-command-context="input"]')) return "input";
  return "application";
}
export function matchesBinding(event: KeyboardEvent, binding: CommandBinding, mac: boolean) {
  return bindingApplies(binding, mac) && event.key.toLowerCase() === binding.key.toLowerCase()
    && event.ctrlKey === (!!binding.ctrl || (!!binding.mod && !mac))
    && event.metaKey === (!!binding.meta || (!!binding.mod && mac))
    && event.shiftKey === !!binding.shift && event.altKey === !!binding.alt;
}

/** A single capture listener dispatches only explicitly eligible commands. */
export class CommandRegistry {
  private commands = new Map<symbol, ApplicationCommand>();
  private listeners = new Set<() => void>();
  private version = 0;
  private leftAltDown = false;
  private rightAltDown = false;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.version;
  private changed() { this.version++; this.listeners.forEach(listener => listener()); }
  register(command: ApplicationCommand) {
    const token = Symbol(command.id); this.commands.set(token, command); this.changed();
    return () => { this.commands.delete(token); this.changed(); };
  }
  list() { return [...new Set([...this.commands.values()].map(command => command.id))].map(id => this.get(id)!); }
  get(id: string) {
    const commands = [...this.commands.values()].filter(command => command.id === id).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    return commands.find(command => command.available()) ?? commands[0];
  }
  run(id: string) { const command = this.get(id); if (!command?.available()) return false; command.action(); return true; }
  dispatch(event: KeyboardEvent, context: CommandContext, mac: boolean) {
    // Firefox on Windows also reports ordinary Ctrl+Alt as AltGraph. Only
    // allow that ambiguous state when the physical left Alt key is held;
    // right Alt/AltGr remains available for international text entry.
    if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || this.rightAltDown || (event.getModifierState?.("AltGraph") && !this.leftAltDown)) return false;
    const command = [...this.commands.values()].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)).find(command =>
      commandBindings(command, mac).some(binding => matchesBinding(event, binding, mac))
      && (command.contexts ?? ["application"]).includes(context)
      && (!command.keyboardEligible || command.keyboardEligible(event, context)) && command.available());
    if (!command) return false;
    event.preventDefault(); event.stopPropagation(); command.action(); return true;
  }
  attach(document: Document, mac = isMacPlatform()) {
    const resetModifiers = () => { this.leftAltDown = false; this.rightAltDown = false; };
    const listener = (event: KeyboardEvent) => {
      if (event.code === "AltLeft") this.leftAltDown = true;
      if (event.code === "AltRight" || event.key === "AltGraph") this.rightAltDown = true;
      this.dispatch(event, commandContext(event.target, document), mac);
    };
    const release = (event: KeyboardEvent) => {
      if (event.code === "AltLeft") this.leftAltDown = false;
      if (event.code === "AltRight" || event.key === "AltGraph") this.rightAltDown = false;
    };
    document.addEventListener("keydown", listener, true);
    document.addEventListener("keyup", release, true);
    document.defaultView?.addEventListener("blur", resetModifiers);
    return () => {
      document.removeEventListener("keydown", listener, true);
      document.removeEventListener("keyup", release, true);
      document.defaultView?.removeEventListener("blur", resetModifiers);
      resetModifiers();
    };
  }
}
const Commands = createContext<CommandRegistry | null>(null);
export function ApplicationCommandProvider({ children }: { children: ReactNode }) {
  const registry = useRef<CommandRegistry | null>(null);
  registry.current ??= new CommandRegistry();
  useEffect(() => registry.current!.attach(document), []);
  return <Commands.Provider value={registry.current}>{children}</Commands.Provider>;
}
function useRegistry() { const registry = useContext(Commands); if (!registry) throw new Error("ApplicationCommandProvider is required"); return registry; }
export function useRegisterCommand(command: ApplicationCommand) {
  const registry = useRegistry();
  useEffect(() => registry.register(command), [registry, command]);
}
export function useCommand(id: string) {
  const registry = useRegistry(); useSyncExternalStore(registry.subscribe, registry.snapshot);
  const command = registry.get(id);
  return { command, enabled: !!command?.available(), execute: () => registry.run(id), hint: command ? commandHints(command).join(" / ") : "" };
}
