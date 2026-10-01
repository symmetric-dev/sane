import { isMacPlatform, type CommandBinding } from "./application-commands";

/** Shared by command registration, navigation hints, and Settings. */
export const NAVIGATION_HOTKEYS = [
  { id: "chat", label: "Chat", key: "c" },
  { id: "terminal", label: "Terminal", key: "t" },
  { id: "code", label: "Files", key: "f" },
  { id: "config", label: "Settings", key: "s" },
] as const;

export function navigationBinding(key: string, mac = isMacPlatform()): CommandBinding {
  return { key, ctrl: true, meta: mac, alt: !mac };
}

export function navigationKeyShortcuts(key: string, mac = isMacPlatform()) {
  return `Control+${mac ? "Meta" : "Alt"}+${key}`;
}
