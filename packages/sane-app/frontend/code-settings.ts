const STORAGE_KEY = "sane.code.wrapExtensions";
const DEFAULT_EXTENSIONS = [".md"];

export function parseWrapExtensions(input: string): string[] {
  const extensions = input.split(/[\s,]+/).filter(Boolean).map(value => value.toLowerCase().replace(/^\.?/, "."));
  if (extensions.some(value => !/^\.[a-z0-9][a-z0-9_+-]*$/.test(value))) throw new Error("Use file extensions such as .md, .txt, or .json, separated by commas or spaces.");
  return [...new Set(extensions)];
}
export function shouldWrap(path: string, extensions: readonly string[]): boolean {
  const name = path.split("/").at(-1) ?? "", index = name.lastIndexOf(".");
  return index >= 0 && extensions.includes(name.slice(index).toLowerCase());
}
function load(): readonly string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (Array.isArray(saved) && saved.every(value => typeof value === "string")) return parseWrapExtensions(saved.join(","));
  } catch { /* Missing or unavailable storage uses Markdown wrapping by default. */ }
  return DEFAULT_EXTENSIONS;
}
let extensions = load();
const listeners = new Set<() => void>();
if (typeof window !== "undefined") window.addEventListener("storage", event => {
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  extensions = load();
  listeners.forEach(listener => listener());
});
export const codeSettings = {
  snapshot: () => extensions,
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  setWrapExtensions(input: string) {
    const next = parseWrapExtensions(input);
    // Report storage failures instead of pretending the preference was saved.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    extensions = next;
    listeners.forEach(listener => listener());
  },
};
