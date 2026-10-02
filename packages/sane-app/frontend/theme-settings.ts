export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

// Keep the storage key, resolution rules, and colors in sync with public/index.html's early bootstrap.
const STORAGE_KEY = "sane.theme";
const THEME_COLORS: Record<ResolvedTheme, string> = { light: "#fcfbf9", dark: "#1d1b20" };

function parsePreference(value: string | null): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}
function load(): ThemePreference {
  try { return typeof window === "undefined" ? "system" : parsePreference(window.localStorage.getItem(STORAGE_KEY)); }
  catch { return "system"; }
}
function systemMedia(): MediaQueryList | undefined {
  try { return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : undefined; }
  catch { return undefined; }
}
const media = systemMedia();
function resolve(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? media?.matches ? "dark" : "light" : preference;
}
let preference = load();
let snapshot = { preference, resolved: resolve(preference) };
const listeners = new Set<() => void>();

function apply(resolved: ResolvedTheme) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[resolved]);
}
function update(next: ThemePreference) {
  const resolved = resolve(next);
  if (snapshot.preference === next && snapshot.resolved === resolved) return;
  preference = next;
  snapshot = { preference, resolved };
  apply(resolved);
  listeners.forEach(listener => listener());
}

// Initialize before React mounts, including when this module is imported outside the main entry point.
apply(snapshot.resolved);
const systemChanged = () => { if (preference === "system") update("system"); };
if (media?.addEventListener) media.addEventListener("change", systemChanged);
else if (media?.addListener) media.addListener(systemChanged);
if (typeof window !== "undefined") window.addEventListener("storage", event => {
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  try { if (event.storageArea && event.storageArea !== window.localStorage) return; }
  catch { return; }
  update(parsePreference(event.newValue));
});

export const themeSettings = {
  snapshot: () => snapshot,
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  setPreference(next: ThemePreference): void {
    update(next);
    try {
      if (typeof window === "undefined") throw new Error("Browser storage unavailable.");
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The theme still applies immediately, but callers must not claim it was persisted.
      throw new Error("Theme applied for this session, but could not be saved in this browser. Your preference may reset when you reload.");
    }
  },
};
