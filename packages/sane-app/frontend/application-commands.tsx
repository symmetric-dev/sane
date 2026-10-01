import { createContext, useContext, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

export type CommandContext = "application" | "editor" | "input" | "terminal" | "modal";
export type CommandBinding = { key: string; mod?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean };
export type ApplicationCommand = {
  id: string; label: string; binding?: CommandBinding; contexts?: readonly CommandContext[]; priority?: number;
  available: () => boolean; action: () => void;
};
export const isMacPlatform = () => /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
export function commandHint(binding: CommandBinding, mac = isMacPlatform()) {
  return [binding.mod ? mac ? "⌘" : "Ctrl" : "", binding.ctrl ? "Ctrl" : "", binding.meta ? "⌘" : "", binding.alt ? mac ? "⌥" : "Alt" : "", binding.shift ? mac ? "⇧" : "Shift" : "", binding.key.toUpperCase()].filter(Boolean).join(mac ? "" : "+");
}
export function commandContext(target: EventTarget | null, document: Document): CommandContext {
  const element = target && "closest" in target ? target as Element : null;
  if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return "modal";
  if (element?.closest('.xterm, [data-command-context="terminal"]')) return "terminal";
  if (element?.closest('.cm-editor, [data-command-context="editor"]')) return "editor";
  if (element?.closest('input, textarea, select, [contenteditable="true"]')) return "input";
  return "application";
}
export function matchesBinding(event: KeyboardEvent, binding: CommandBinding, mac: boolean) {
  return event.key.toLowerCase() === binding.key.toLowerCase()
    && event.ctrlKey === (!!binding.ctrl || (!!binding.mod && !mac))
    && event.metaKey === (!!binding.meta || (!!binding.mod && mac))
    && event.shiftKey === !!binding.shift && event.altKey === !!binding.alt;
}

/** A single capture listener dispatches only explicitly eligible commands. */
export class CommandRegistry {
  private commands = new Map<symbol, ApplicationCommand>();
  private listeners = new Set<() => void>();
  private version = 0;
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
    if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || event.getModifierState?.("AltGraph")) return false;
    const command = [...this.commands.values()].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)).find(command =>
      command.binding && matchesBinding(event, command.binding, mac) && (command.contexts ?? ["application"]).includes(context) && command.available());
    if (!command) return false;
    event.preventDefault(); event.stopPropagation(); command.action(); return true;
  }
  attach(document: Document, mac = isMacPlatform()) {
    const listener = (event: KeyboardEvent) => this.dispatch(event, commandContext(event.target, document), mac);
    document.addEventListener("keydown", listener, true);
    return () => document.removeEventListener("keydown", listener, true);
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
  return { command, enabled: !!command?.available(), execute: () => registry.run(id), hint: command?.binding ? commandHint(command.binding) : "" };
}
