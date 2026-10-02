import type { ITheme } from "@xterm/xterm";
import { themeSettings, type ResolvedTheme } from "./theme-settings";

const palettes: Record<ResolvedTheme, ITheme> = {
  light: {
    black: "#29282d", red: "#a74238", green: "#4b8066", yellow: "#946b29",
    blue: "#426c97", magenta: "#796090", cyan: "#367f83", white: "#ded9d3",
    brightBlack: "#747078", brightRed: "#bc5147", brightGreen: "#548867", brightYellow: "#a87b31",
    brightBlue: "#4d7faf", brightMagenta: "#906ea7", brightCyan: "#459295", brightWhite: "#fcfbf9",
  },
  dark: {
    black: "#29262f", red: "#e18c85", green: "#9bc7a9", yellow: "#d8ba83",
    blue: "#97b9dc", magenta: "#c1a4d9", cyan: "#8fc9cd", white: "#d9d3df",
    brightBlack: "#8a8291", brightRed: "#f5a49c", brightGreen: "#b1dbbe", brightYellow: "#efd09a",
    brightBlue: "#afd0f1", brightMagenta: "#d7b9ed", brightCyan: "#a7dfe2", brightWhite: "#f4eff7",
  },
};
const fallback = {
  light: { background: "#fcfbf9", foreground: "#29282d", cursor: "#635877", selection: "#e4deed" },
  dark: { background: "#1d1b20", foreground: "#e8e3ec", cursor: "#c1acd9", selection: "#44394f" },
};

export function terminalTheme(host: HTMLElement): ITheme {
  const resolved = themeSettings.snapshot().resolved, defaults = fallback[resolved];
  const tokens = getComputedStyle(host);
  const color = (token: string, otherwise: string) => tokens.getPropertyValue(token).trim() || otherwise;
  const background = color("--background", defaults.background);
  const foreground = color("--foreground", defaults.foreground);
  const selection = color("--ws-selection", defaults.selection);
  return {
    ...palettes[resolved], background, foreground,
    cursor: color("--primary", defaults.cursor), cursorAccent: background,
    selectionBackground: selection, selectionInactiveBackground: selection, selectionForeground: foreground,
  };
}
