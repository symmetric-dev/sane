/** Device-local configuration only. No server discovery, provisioning, or probes. */
export type NotebookConfiguration = { version: 1; server: string; root: string; generation: string };
const PREFIX = "sane.notebook.worktree.v1:";
const listeners = new Set<() => void>();

export function notebookSettingsKey(storeId: string, workspaceId: string, worktreeId: string, bindingRevision: string, root: string) {
  return PREFIX + JSON.stringify([storeId, workspaceId, worktreeId, bindingRevision, root]);
}

function safeSegment(segment: string) {
  let decoded: string;
  try { decoded = decodeURIComponent(segment); } catch { throw new Error("Use a valid path without encoded traversal."); }
  if (!segment || decoded === "." || decoded === ".." || /[/\\\u0000-\u001f\u007f]/.test(decoded) || /%[a-f\d]{2}/i.test(decoded)) {
    throw new Error("Paths must not contain traversal, empty segments, or encoded separators.");
  }
}

function relativePath(path: string) {
  if (!path || path.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(path) || /[\\\u0000-\u001f\u007f]/.test(path)) {
    throw new Error("Use a worktree-relative path without traversal.");
  }
  path.split("/").forEach(safeSegment);
  return path;
}

export function normalizeNotebookRoot(input: string) {
  const root = input.trim();
  if (!root || root === ".") return "";
  return relativePath(root.endsWith("/") ? root.slice(0, -1) : root);
}

export function normalizeNotebookServer(input: string) {
  const value = input.trim();
  // Validate the raw path before URL's dot-segment normalization can hide traversal.
  const parts = /^(https?:)\/\/([^/?#]+)(\/[^?#]*)?$/i.exec(value);
  if (!parts || /[\s\\\u0000-\u001f\u007f]/.test(value)) throw new Error("Enter an HTTP(S) server URL without credentials, query parameters, or a fragment.");
  const rawPath = parts[3] ?? "/";
  if (rawPath.includes("//")) throw new Error("Use a server path without empty segments.");
  const path = rawPath.slice(1).replace(/\/$/, "");
  if (path) path.split("/").forEach(safeSegment);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Enter a valid HTTP(S) server URL."); }
  if (url.username || url.password || parts[2]!.includes("@")) throw new Error("Credentials must not be stored here. Sign in through marimo's own login UI.");
  if (url.origin === window.location.origin) throw new Error("Use a dedicated marimo origin, not this SANE App origin.");
  if (window.location.protocol === "https:" && url.protocol === "http:") throw new Error("This HTTPS App needs an HTTPS marimo server; browsers block insecure frames.");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

export function readNotebookConfiguration(raw: string | null): { configuration?: NotebookConfiguration; error?: string } {
  if (!raw) return {};
  if (raw === "unavailable") return { error: "Device storage is unavailable. Notebook configuration cannot be read or saved." };
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") throw new Error();
    const item = value as Partial<NotebookConfiguration>;
    if (item.version !== 1 || typeof item.server !== "string" || typeof item.root !== "string" || typeof item.generation !== "string" || !item.generation) throw new Error();
    return { configuration: { version: 1, server: normalizeNotebookServer(item.server), root: normalizeNotebookRoot(item.root), generation: item.generation } };
  } catch {
    return { error: "The saved notebook mapping is invalid or no longer allowed. Configure this worktree again." };
  }
}

export function notebookFileMapping(configuration: NotebookConfiguration, path: string) {
  const file = relativePath(path);
  if (!file.endsWith(".py")) throw new Error("Select an existing .py file to use Notebook view.");
  const prefix = configuration.root ? configuration.root + "/" : "";
  if (!file.startsWith(prefix)) throw new Error("This file is outside the configured notebook root. Choose a file inside that root or change the mapping.");
  return relativePath(file.slice(prefix.length));
}

/** Call only from explicit activation; file paths never become arbitrary navigation URLs. */
export function notebookFrameUrl(configuration: NotebookConfiguration, path: string) {
  const url = new URL(normalizeNotebookServer(configuration.server));
  url.search = new URLSearchParams({ file: notebookFileMapping(configuration, path) }).toString();
  return url.href;
}

export const notebookSettings = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  snapshot(key: string | null) {
    if (!key) return null;
    try { return localStorage.getItem(key); } catch { return "unavailable"; }
  },
  save(key: string, server: string, root: string) {
    const configuration: NotebookConfiguration = { version: 1, server: normalizeNotebookServer(server), root: normalizeNotebookRoot(root), generation: crypto.randomUUID() };
    // Failed persistence is reported, never silently treated as success.
    localStorage.setItem(key, JSON.stringify(configuration));
    listeners.forEach(listener => listener());
  },
  clear(key: string) {
    localStorage.removeItem(key);
    listeners.forEach(listener => listener());
  },
};
if (typeof window !== "undefined") window.addEventListener("storage", event => {
  if (event.key === null || event.key.startsWith(PREFIX)) listeners.forEach(listener => listener());
});
