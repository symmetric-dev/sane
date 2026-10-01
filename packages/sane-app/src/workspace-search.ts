/** Fixed budgets apply per request, independently of caller-supplied filters. */
export const WORKSPACE_SEARCH_LIMITS = { entries: 10000, files: 2000, bytes: 16 * 1024 * 1024, matches: 1000, outputBytes: 512 * 1024, milliseconds: 5000, depth: 32, preview: 240, query: 1024, ignoreFiles: 256, ignoreBytes: 512 * 1024, ignoreRules: 2000 } as const;
export const SEARCH_IGNORED_DIRECTORIES = new Set(["node_modules", "dist", "build", "coverage", "vendor"]);

// Segment matching uses bounded dynamic programming rather than translating
// caller globs into potentially exponentially backtracking regular expressions.
function segment(pattern: string, value: string): boolean {
  let previous = new Uint8Array(value.length + 1); previous[0] = 1;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    const next = new Uint8Array(value.length + 1);
    if (char === "*") next[0] = previous[0]!;
    for (let i = 1; i <= value.length; i++) next[i] = char === "*" ? Number(!!(previous[i] || next[i - 1])) : Number(!!previous[i - 1] && (char === "?" || char === value[i - 1]));
    previous = next;
  }
  return !!previous[value.length];
}
function glob(pattern: string, path: string, rootRelative = false): boolean {
  if (!rootRelative && !pattern.includes("/")) return segment(pattern, path.slice(path.lastIndexOf("/") + 1));
  const patterns = pattern.split("/"), parts = path.split("/");
  let previous = new Uint8Array(parts.length + 1); previous[0] = 1;
  for (const part of patterns) {
    const next = new Uint8Array(parts.length + 1);
    if (part === "**") next[0] = previous[0]!;
    for (let i = 1; i <= parts.length; i++) next[i] = part === "**" ? Number(!!(previous[i] || next[i - 1])) : Number(!!previous[i - 1] && segment(part, parts[i - 1]!));
    previous = next;
  }
  return !!previous[parts.length];
}
export function searchPatterns(value: unknown): string[] {
  if (value === undefined || value === "") return [];
  if (typeof value !== "string" || value.length > 4096) throw new Error("Invalid filters");
  const patterns = value.split(",").map(part => part.trim());
  if (patterns.length > 32) throw new Error("Too many filters");
  return patterns.map(pattern => {
    if (!pattern || pattern.length > 256 || /[\\\0\r\n!\[\]{}]/.test(pattern) || pattern.startsWith("/") || pattern.split("/").some((part, index, parts) => part === "." || part === ".." || (!part && index !== parts.length - 1))) throw new Error("Invalid glob");
    if (pattern.split("/").some(part => part.includes("**") && part !== "**")) throw new Error("Use ** as a complete segment");
    return pattern;
  });
}
export const searchFilter = (patterns: string[], path: string, directory = false) => patterns.some(pattern => {
  if (!pattern.endsWith("/")) return glob(pattern, path);
  // Directory-only patterns also match descendants, but never a regular file
  // whose exact name happens to be the named directory (e.g. file "docs").
  const parts = path.split("/"), base = pattern.slice(0, -1);
  for (let length = parts.length - Number(!directory); length > 0; length--) if (glob(base, parts.slice(0, length).join("/"), true)) return true;
  return false;
});
export function literalMatcher(query: string, caseSensitive: boolean): RegExp {
  // Escaping every metacharacter makes this an exclusively literal search. The
  // Unicode flag preserves source UTF-16 positions during Unicode case folding.
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "gu" : "giu");
}
export function searchWholeWord(text: string, start: number, end: number): boolean {
  return !/[\p{L}\p{N}\p{M}_]$/u.test(text.slice(Math.max(0, start - 2), start)) && !/^[\p{L}\p{N}\p{M}_]/u.test(text.slice(end, end + 2));
}
export function searchPreview(line: string, start: number): string {
  let from = Math.max(0, start - 60), to = Math.min(line.length, from + WORKSPACE_SEARCH_LIMITS.preview);
  // Do not split an astral character at excerpt boundaries.
  if (from && /[\uDC00-\uDFFF]/.test(line[from]!)) from++;
  if (to < line.length && /[\uDC00-\uDFFF]/.test(line[to]!)) to--;
  return line.slice(from, to);
}
