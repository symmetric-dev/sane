import { commandBindings, commandHints, type CommandBindings, type CommandScope } from "./application-commands";
import { NAVIGATION_HOTKEYS, navigationBinding } from "./navigation-hotkeys";

/** Static documentation, independent of which views/commands are currently mounted. */
export type ShortcutDefinition = CommandBindings & {
  id: string;
  label: string;
  scope: CommandScope;
  /** Native/editor entries describe existing behavior, not registry interception. */
  owner: "application" | "editor" | "native";
  description?: string;
};

export const WORKSPACE_SELECTOR_SHORTCUT = {
  id: "workspace.toggle-selector", label: "Toggle workspace selection",
  scope: { kind: "global" }, owner: "application",
  bindings: [
    { ...navigationBinding("ArrowDown", true), platform: "mac" },
    { ...navigationBinding("ArrowDown", false), platform: "windows-linux" },
  ],
  description: "Open or close the workspace selection dialog.",
} as const satisfies ShortcutDefinition;

export const SIDEBAR_TOGGLE_SHORTCUT = {
  id: "workspace.toggle-sidebar", label: "Toggle sidebar",
  scope: { kind: "global" }, owner: "application",
  binding: { key: "b", mod: true },
  description: "Hide or show the desktop sidebar, or open or close the mobile navigation drawer. Focus a SANE control first when using an embedded preview.",
} as const satisfies ShortcutDefinition;

export const GLOBAL_SHORTCUTS: readonly ShortcutDefinition[] = [...NAVIGATION_HOTKEYS.map<ShortcutDefinition>(item => ({
  id: `navigation.${item.id}`,
  label: item.label,
  scope: { kind: "global" },
  owner: "application",
  bindings: [
    { ...navigationBinding(item.key, true), platform: "mac" },
    { ...navigationBinding(item.key, false), platform: "windows-linux" },
  ],
})), WORKSPACE_SELECTOR_SHORTCUT, SIDEBAR_TOGGLE_SHORTCUT];

export const FILE_SHORTCUTS = {
  quickOpen: {
    id: "workspace.quick-open", label: "Quick Open",
    scope: { kind: "view", view: "files", region: "view" }, owner: "application",
    binding: { key: "p", mod: true },
    description: "Open a file by its name or path in the active workspace.",
  },
  search: {
    id: "workspace.search", label: "Search saved files",
    scope: { kind: "view", view: "files", region: "view" }, owner: "application",
    binding: { key: "f", mod: true, shift: true },
    description: "Search saved file contents in the active workspace.",
  },
  rename: {
    id: "files.rename", label: "Rename",
    scope: { kind: "view", view: "files", region: "sidebar" }, owner: "application",
    binding: { key: "r", shift: true },
    description: "Rename the focused file within the same folder while the Files sidebar is focused.",
  },
  delete: {
    id: "files.delete", label: "Delete",
    scope: { kind: "view", view: "files", region: "sidebar" }, owner: "application",
    bindings: [{ key: "Delete" }, { key: "Backspace", meta: true, platform: "mac" }],
    description: "Open a confirmation dialog to delete the focused file while the Files sidebar is focused.",
  },
  copy: {
    id: "files.copy", label: "Copy file",
    scope: { kind: "view", view: "files", region: "sidebar" }, owner: "application",
    binding: { key: "c", mod: true },
    description: "Copy a reference to the focused file for pasting its saved bytes, not unsaved editor text, while the Files sidebar is focused.",
  },
  paste: {
    id: "files.paste", label: "Paste file",
    scope: { kind: "view", view: "files", region: "sidebar" }, owner: "application",
    binding: { key: "v", mod: true },
    description: "Open a paste dialog for the copied file in the focused folder or the focused file's parent folder.",
  },
  save: {
    id: "files.save", label: "Save file",
    scope: { kind: "view", view: "files", region: "main-panel" }, owner: "editor",
    binding: { key: "s", mod: true },
    description: "Save the editable file in the focused editor.",
  },
  find: {
    id: "files.find", label: "Find in file",
    scope: { kind: "view", view: "files", region: "main-panel" }, owner: "editor",
    binding: { key: "f", mod: true },
    description: "Find text in the focused file editor or supported preview.",
  },
  textCopy: {
    id: "files.text-copy", label: "Copy text",
    scope: { kind: "view", view: "files", region: "main-panel" }, owner: "native",
    binding: { key: "c", mod: true },
    description: "Copy selected text using the editor or browser's native behavior.",
  },
  textPaste: {
    id: "files.text-paste", label: "Paste text",
    scope: { kind: "view", view: "files", region: "main-panel" }, owner: "native",
    binding: { key: "v", mod: true },
    description: "Paste text into an editable editor or input using native behavior.",
  },
} as const satisfies Record<string, ShortcutDefinition>;

export const SHORTCUT_DEFINITIONS: readonly ShortcutDefinition[] = [
  ...GLOBAL_SHORTCUTS,
  ...Object.values(FILE_SHORTCUTS),
];

/** Use for Settings columns, toolbar hints, and command registration alike. */
export const shortcutBindings = commandBindings;
export const shortcutHints = commandHints;
export function shortcutHint(definition: ShortcutDefinition, mac?: boolean) {
  return shortcutHints(definition, mac).join(" / ");
}
