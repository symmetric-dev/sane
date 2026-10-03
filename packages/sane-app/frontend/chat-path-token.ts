/** Text-only syntax: no escaping, filesystem normalization or attachment payloads. */
export type PathToken = { start: number; end: number; path: string; parent: string; query: string; quoted: boolean };
export function safeRelativePath(path: string, trailing = false) {
  if (/[\\"\u0000-\u001f\u007f]/.test(path) || path.startsWith("/")) return false;
  const value = trailing && path.endsWith("/") ? path.slice(0, -1) : path;
  return !value || value.split("/").every(part => !!part && part !== "." && part !== "..");
}
export function pathToken(text: string, start: number, end = start): PathToken | undefined {
  if (start !== end) return;
  const triggers = /(^|\s)@/g;
  let match: RegExpExecArray | null, token: PathToken | undefined;
  while ((match = triggers.exec(text))) {
    const at = match.index + match[1]!.length;
    if (at >= start) break;
    const quoted = text[at + 1] === '"', contentStart = at + (quoted ? 2 : 1);
    if (start < contentStart) continue;
    let contentEnd = contentStart;
    if (quoted) {
      while (contentEnd < text.length && text[contentEnd] !== '"' && !/[\r\n]/.test(text[contentEnd]!)) contentEnd++;
    } else {
      while (contentEnd < text.length && !/\s/.test(text[contentEnd]!)) contentEnd++;
    }
    const tokenEnd = contentEnd + (quoted && text[contentEnd] === '"' ? 1 : 0);
    if (start > tokenEnd || start > contentEnd && !quoted) continue;
    const path = text.slice(contentStart, Math.min(start, contentEnd));
    if (!safeRelativePath(path, true) || !safeRelativePath(text.slice(contentStart, contentEnd), true)) continue;
    const slash = path.lastIndexOf("/");
    token = { start: at, end: tokenEnd, path, parent: slash < 0 ? "" : path.slice(0, slash), query: path.slice(slash + 1), quoted };
  }
  return token;
}
function canonicalAbsolute(path: string) {
  if (!path.startsWith("/") || path.includes("//") || /[\\\u0000-\u001f\u007f]/.test(path)) return;
  const value = path !== "/" && path.endsWith("/") ? path.slice(0, -1) : path;
  if (value !== "/" && value.slice(1).split("/").some(part => !part || part === "." || part === "..")) return;
  return value;
}
/** Only represent an already-canonical cwd under the resolved root. Never repair it. */
export function executionPrefix(root: string, cwd: string): string | undefined {
  const base = canonicalAbsolute(root), execution = canonicalAbsolute(cwd);
  if (!base || !execution) return;
  if (execution === base) return "";
  const prefix = base === "/" ? "/" : `${base}/`;
  if (!execution.startsWith(prefix)) return;
  const relative = execution.slice(prefix.length);
  return safeRelativePath(relative) ? relative : undefined;
}
export function pathInsertion(path: string, directory: boolean, quoted: boolean) {
  const value = `${path}${directory ? "/" : ""}`;
  return quoted || /\s/.test(value) ? `@"${value}"` : `@${value}`;
}
