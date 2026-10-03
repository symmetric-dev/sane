import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type RefObject } from "react";
import { FiAlertCircle, FiLoader, FiMoreHorizontal, FiRefreshCw, FiSearch } from "react-icons/fi";
import type { WorkspaceEntry } from "../src/workspace-contract";
import { catalog, worktreeScope } from "./catalog";
import { store } from "./store";
import { subscribeWorkspace, workspaceEpoch, workspaceSnapshot } from "./workspace-store";
import { acquireWorktreeDirectories, DIRECTORY_SUCCESS_FRESH_MS, type DirectoryResult, type WorktreeDirectories } from "./workspace-directory-cache";
import { PATH_INVENTORY_SUCCESS_FRESH_MS, type PathInventoryResult } from "./workspace-path-cache";
import { executionRelativePath, matchWorkspacePaths } from "./workspace-path-matcher";
import { executionPrefix, pathInsertion, pathToken, safeRelativePath, type PathToken } from "./chat-path-token";
import "./chat-path-autocomplete.css";

function executionContext() {
  const state = store.snapshot(), conversation = state.conversations.find(c => c.id === state.selected);
  const pair = state.selected ? conversation : catalog.state.navigation;
  const worktree = catalog.state.workspaces.find(w => w.workspaceId === pair?.workspaceId)?.worktrees.find(w => w.worktreeId === pair?.worktreeId);
  const available = catalog.state.ready && (!state.selected || conversation?.association === "resolved" && !conversation.replacedBy)
    && pair?.workspaceId && pair.worktreeId && worktree?.state === "available";
  const scope = available ? worktreeScope(pair.workspaceId!, pair.worktreeId!) : undefined;
  const cwd = store.workspace(), draftKey = store.draftKey(), epoch = workspaceEpoch();
  return { scope, revision: worktree?.bindingRevision, cwd, draftKey, epoch,
    identity: JSON.stringify([draftKey, scope, worktree?.bindingRevision, cwd, epoch]),
    error: "Path suggestions unavailable. Choose an available execution worktree; existing conversations keep their recorded directory." };
}
type Snapshot = { identity: string; text: string; caret: number; token: PathToken };
type PathOption = { entry: WorkspaceEntry; relativePath: string };
type StatusKind = "ready" | "empty" | "incomplete" | "loading" | "refreshing" | "error" | "unavailable";
type Results = { snapshot: Snapshot; options: PathOption[]; status: string; statusKind: StatusKind; bounded?: boolean; reader?: WorktreeDirectories; directory?: DirectoryResult; paths?: PathInventoryResult; parent?: string; prefix?: string };
const MAX_OPTIONS = 50;
const recursiveQuery = (value: Snapshot) => !!value.token.path && !value.token.path.endsWith("/");
const incompleteStatus = "Results are incomplete; more matches may exist. Type a more specific path.";
const resultStatus = (count: number, bounded: boolean): Pick<Results, "status" | "statusKind"> => ({
  statusKind: bounded ? "incomplete" : count ? "ready" : "empty",
  status: `${count ? `${Math.min(count, MAX_OPTIONS)} path suggestions.` : bounded ? "No matching paths found in this incomplete listing." : "No matching paths."}${bounded ? ` ${incompleteStatus}` : ""}`,
});
function directoryResults(value: Snapshot, reader: WorktreeDirectories, cwd: string, result: DirectoryResult): Omit<Results, "snapshot"> {
  const prefix = executionPrefix(reader.workspace.root, cwd);
  if (prefix === undefined) return { options: [], statusKind: "unavailable", status: "Path suggestions unavailable: the execution directory is not a safely representable path under this worktree. Check the conversation directory." };
  const parent = [prefix, value.token.parent].filter(Boolean).join("/");
  if (result.error || !result.listing) return { reader, directory: result, prefix, parent, options: [], statusKind: "error", status: `${result.error || "Directory listing unavailable."} Check the path or sign in again; wait a few seconds, then edit the token to retry.` };
  if (result.listing.workspaceId !== reader.workspace.workspaceId || result.listing.path !== parent || !reader.current()) {
    return { options: [], statusKind: "unavailable", status: "Workspace changed. Choose the execution worktree again or edit the token to retry." };
  }
  const query = value.token.query.toLowerCase();
  const matches = result.listing.entries.filter(entry => {
    const relative = executionRelativePath(entry.path, prefix);
    return (entry.kind === "directory" || entry.kind === "file") && relative !== undefined && safeRelativePath(relative)
      && entry.path === [parent, entry.name].filter(Boolean).join("/") && !entry.name.includes("/")
      && entry.name.toLowerCase().includes(query);
  }).sort((a, b) => Number(!a.name.toLowerCase().startsWith(query)) - Number(!b.name.toLowerCase().startsWith(query)) || a.name.localeCompare(b.name));
  const bounded = result.listing.truncated || matches.length > MAX_OPTIONS;
  return { reader, directory: result, prefix, parent, bounded,
    options: matches.slice(0, MAX_OPTIONS).map(entry => ({ entry, relativePath: executionRelativePath(entry.path, prefix)! })),
    ...resultStatus(matches.length, bounded) };
}
function pathResults(value: Snapshot, reader: WorktreeDirectories, prefix: string, result: PathInventoryResult): Omit<Results, "snapshot"> {
  if (result.error || !result.index) return { reader, paths: result, prefix, options: [], statusKind: "error", status: `${result.error || "Path discovery unavailable."} Check the path or sign in again; wait a few seconds, then edit the token to retry.` };
  if (result.index.workspaceId !== reader.workspace.workspaceId || result.index.prefix !== prefix || !reader.current()) {
    return { options: [], statusKind: "unavailable", status: "Workspace changed. Choose the execution worktree again or edit the token to retry." };
  }
  const matches = matchWorkspacePaths(result.index, value.token.path, { prefix, includeDirectories: true, limit: MAX_OPTIONS });
  return { reader, paths: result, prefix, options: matches.matches, bounded: matches.bounded, ...resultStatus(matches.matchedCount, matches.bounded) };
}
function metadataCurrent(value: Omit<Results, "snapshot">) {
  if (!value.reader) return true; // Loading/resolve failures have no metadata.
  if (!value.reader.current()) return false;
  if (value.paths) {
    return !value.reader.pathsNeedsRefresh(value.prefix!, value.paths)
      && value.options.every(option => !!value.paths?.index?.entries.some(candidate => candidate.entry === option.entry && candidate.relativePath === option.relativePath));
  }
  const record = value.reader.directories.get(value.parent!);
  return !!value.directory && !value.reader.directoryNeedsRefresh(value.parent!, value.directory)
    && value.options.every(option => !!record?.result?.listing?.entries.includes(option.entry));
}

/** All publishing and insertion fences belong to this consumer, not the shared reader. */
export function useChatPathAutocomplete(input: RefObject<HTMLTextAreaElement | null>, enabled: boolean, insert: (text: string) => void) {
  useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const workspaceVersion = useSyncExternalStore(subscribeWorkspace, workspaceSnapshot);
  const id = useId(), panel = useRef<HTMLDivElement>(null);
  const context = executionContext();
  const live = useRef({ enabled, context }); live.current = { enabled, context };
  const composing = useRef(false), nativeComposing = useRef(false), serial = useRef(0);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const snapshotRef = useRef<Snapshot | undefined>(undefined); snapshotRef.current = snapshot;
  const [results, setResults] = useState<Results>();
  const [activeIndex, setActiveIndex] = useState(-1);
  const [readAttempt, setReadAttempt] = useState(0);
  const loading = useRef<{ signature: string } | undefined>(undefined);
  const selection = useRef<{ signature: string; path: string } | undefined>(undefined);
  const scrollSelection = useRef<string | undefined>(undefined);
  const editing = useRef(false);
  const dismissed = useRef<string | undefined>(undefined);
  const leaseRef = useRef<ReturnType<typeof acquireWorktreeDirectories> | undefined>(undefined);
  const signature = (value: Snapshot) => JSON.stringify([value.identity, value.text, value.caret, value.token]);
  const cachedResults = (value: Snapshot, reader = leaseRef.current?.reader) => {
    if (!reader?.current()) return;
    const prefix = executionPrefix(reader.workspace.root, live.current.context.cwd);
    if (prefix === undefined) return;
    if (recursiveQuery(value)) {
      const cached = reader.readPaths(prefix);
      return cached.current && cached.result ? pathResults(value, reader, prefix, cached.result) : undefined;
    }
    const parent = [prefix, value.token.parent].filter(Boolean).join("/"), result = reader.directories.get(parent)?.result;
    return result ? directoryResults(value, reader, live.current.context.cwd, result) : undefined;
  };
  const capture = (): Snapshot | undefined => {
    const element = input.current;
    if (!live.current.enabled || editing.current || composing.current || nativeComposing.current || !element || document.activeElement !== element) return;
    const token = pathToken(element.value, element.selectionStart, element.selectionEnd);
    if (!token) return;
    return { identity: executionContext().identity, text: element.value, caret: element.selectionStart, token };
  };
  const current = (value: Snapshot) => {
    const now = capture();
    return !!now && signature(now) === signature(value) && store.draft().text === value.text;
  };
  const dismiss = () => {
    const value = capture(); dismissed.current = value ? signature(value) : undefined;
    serial.current++; snapshotRef.current = undefined; setSnapshot(undefined); setResults(undefined); setActiveIndex(-1);
    loading.current = undefined; selection.current = undefined; scrollSelection.current = undefined;
  };
  const refresh = (force = false) => {
    if (editing.current) return;
    const value = capture();
    if (!value || dismissed.current === signature(value)) {
      serial.current++; snapshotRef.current = undefined; setSnapshot(undefined); setResults(undefined); setActiveIndex(-1);
      loading.current = undefined; selection.current = undefined; scrollSelection.current = undefined; return;
    }
    if (snapshotRef.current && signature(snapshotRef.current) === signature(value)) {
      if (!force || loading.current?.signature === signature(value)) return;
      // Refresh the same token without throwing away the remembered selection:
      // Enter while its metadata is stale/loading must not become a newline.
      serial.current++; loading.current = { signature: signature(value) };
      setReadAttempt(attempt => attempt + 1); return;
    }
    const previous = snapshotRef.current, cached = cachedResults(value);
    const sameToken = previous?.identity === value.identity && previous.token.start === value.token.start
      && previous.token.quoted === value.token.quoted && previous.text.slice(0, previous.token.start) === value.text.slice(0, value.token.start)
      && previous.text.slice(previous.token.end) === value.text.slice(value.token.end);
    const selected = sameToken && selection.current ? cached?.options.findIndex(option => option.entry.path === selection.current!.path) ?? -1 : -1;
    selection.current = selected >= 0 ? { signature: signature(value), path: cached!.options[selected]!.entry.path } : undefined;
    loading.current = undefined; scrollSelection.current = undefined;
    serial.current++; snapshotRef.current = value; setSnapshot(value); setResults(cached ? { ...cached, snapshot: value } : undefined); setActiveIndex(selected);
  };
  // Fence old drafts/scopes at render time, and dismiss before the next paint.
  const open = !!snapshot && enabled && snapshot.identity === context.identity;
  useLayoutEffect(() => { dismiss(); }, [enabled, context.identity]);
  // Retain one lease while the token changes, so typing does not resolve a new
  // source or discard its directory/inventory records on every keystroke.
  useLayoutEffect(() => {
    if (!open || !context.scope) return;
    const lease = acquireWorktreeDirectories(context.scope, context.revision);
    leaseRef.current = lease;
    // A resolve may fail before the debounced consumer starts awaiting it.
    void lease.ready.catch(() => {});
    return () => { if (leaseRef.current === lease) leaseRef.current = undefined; lease.release(); };
  }, [open, context.identity]);
  useLayoutEffect(() => {
    if (!open || !snapshot) return;
    const value = snapshot, request = ++serial.current;
    const pending = { signature: signature(value) }; loading.current = pending;
    const finish = () => { if (loading.current === pending) loading.current = undefined; };
    let disposed = false, completed = false;
    const valid = () => !disposed && serial.current === request && current(value);
    const publish = (next: Omit<Results, "snapshot">, settled = true) => {
      if (valid()) {
        if (settled) { completed = true; finish(); }
        const selected = selection.current?.signature === signature(value)
          ? next.options.findIndex(option => option.entry.path === selection.current!.path) : -1;
        setResults({ ...next, snapshot: value }); setActiveIndex(selected);
        // Refreshed metadata can reorder options. Keep selection only by its
        // exact path, never by its previous index or across a token/scope change.
        if (settled && selected < 0) selection.current = undefined;
      }
    };
    if (!context.scope) { publish({ options: [], statusKind: "unavailable", status: context.error }); finish(); return; }
    const lease = leaseRef.current;
    if (!lease) { publish({ options: [], statusKind: "unavailable", status: context.error }); finish(); return; }
    const cached = cachedResults(value);
    if (cached) {
      const fresh = metadataCurrent(cached);
      publish(cached, fresh);
      if (fresh) return;
    }
    const loadingTimer = setTimeout(() => {
      if (valid() && !completed) setResults(previous => {
        const shown = previous?.snapshot === value ? previous : undefined;
        const refreshing = !!(shown?.directory?.listing || shown?.paths?.index);
        return { ...(shown ?? { snapshot: value, options: [] }), statusKind: refreshing ? "refreshing" : "loading",
          status: `${refreshing ? "Refreshing" : "Loading"} paths…${shown?.bounded ? ` ${incompleteStatus}` : ""}` };
      });
    }, 180);
    void lease.ready.then(reader => {
      if (!valid() || completed) return;
      const next = cachedResults(value, reader);
      if (next) publish(next, metadataCurrent(next));
    }).catch(() => {});
    const timer = setTimeout(() => {
      void lease.ready.then(async reader => {
        if (!valid() || completed) return;
        const prefix = executionPrefix(reader.workspace.root, context.cwd);
        if (prefix === undefined) {
          publish({ options: [], statusKind: "unavailable", status: "Path suggestions unavailable: the execution directory is not a safely representable path under this worktree. Check the conversation directory." }); return;
        }
        if (recursiveQuery(value)) {
          const result = await reader.listPaths(prefix);
          if (!valid()) return;
          publish(pathResults(value, reader, prefix, result));
        } else {
          const parent = [prefix, value.token.parent].filter(Boolean).join("/");
          const result = await reader.listDirectory(parent);
          if (!valid()) return;
          publish(directoryResults(value, reader, context.cwd, result));
        }
      }).catch(error => publish({ options: [], statusKind: "error", status: `${error instanceof Error ? error.message : "Path suggestions unavailable."} Check the execution worktree or sign in again; dismiss with Escape and edit @ to retry.` })).finally(finish);
    }, 100);
    return () => { disposed = true; clearTimeout(timer); clearTimeout(loadingTimer); finish(); };
  }, [snapshot, open, readAttempt]);

  const metadataFresh = !results || metadataCurrent(results);
  const visible = open && results?.snapshot === snapshot ? results : undefined;
  useLayoutEffect(() => {
    if (!open || !snapshot || results?.snapshot !== snapshot || !results.reader || !(results.directory?.listing || results.paths?.index)) return;
    if (!current(snapshot)) return;
    if (!metadataCurrent(results)) { refresh(true); return; }
    const settledAt = results.paths ? results.reader.readPaths(results.prefix!).freshness?.settledAt
      : results.reader.directories.get(results.parent!)?.freshness?.settledAt;
    if (settledAt === undefined) return;
    // One expiration alarm for this displayed success, not a metadata polling
    // loop. Error statuses never auto-retry when their short cache TTL expires.
    const timer = setTimeout(() => {
      if (current(snapshot) && !metadataCurrent(results)) refresh(true);
    }, Math.max(1, settledAt + (results.paths ? PATH_INVENTORY_SUCCESS_FRESH_MS : DIRECTORY_SUCCESS_FRESH_MS) - Date.now() + 1));
    return () => clearTimeout(timer);
  }, [open, snapshot, results, metadataFresh, workspaceVersion]);
  const choose = (index: number) => {
    const element = input.current, value = results?.snapshot === snapshot ? results : undefined, option = value?.options[index];
    if (!element || element.disabled || element.readOnly || !option || !value?.reader || !snapshot || !current(snapshot)) return false;
    // TTL expiry, invalidation and a newer shared result all revoke this option.
    if (!metadataCurrent(value)) { refresh(true); return true; }
    const path = option.relativePath;
    if (!safeRelativePath(path) || executionRelativePath(option.entry.path, value.prefix) !== path) return false;
    const directory = option.entry.kind === "directory";
    const tokenText = pathInsertion(path, directory, snapshot.token.quoted);
    const separator = directory || /\s/.test(snapshot.text[snapshot.token.end] ?? "") ? "" : " ";
    const replacement = tokenText + separator;
    const text = snapshot.text.slice(0, snapshot.token.start) + replacement + snapshot.text.slice(snapshot.token.end);
    const caret = snapshot.token.start + (directory && tokenText.endsWith('"') ? tokenText.length - 1 : replacement.length);
    const scrollTop = element.scrollTop, scrollLeft = element.scrollLeft;
    dismiss(); dismissed.current = undefined;
    editing.current = true;
    let edited = false, synchronized = false;
    try {
      element.focus({ preventScroll: true }); element.setSelectionRange(snapshot.token.start, snapshot.token.end);
      const owned = () => live.current.enabled && !composing.current && !nativeComposing.current
        && executionContext().identity === snapshot.identity && document.activeElement === element;
      const canEdit = () => owned() && element.value === snapshot.text && store.draft().text === snapshot.text
        && element.selectionStart === snapshot.token.start && element.selectionEnd === snapshot.token.end && metadataCurrent(value);
      if (canEdit()) {
        try {
          // Native insertText preserves the textarea undo transaction where
          // supported. Check the buffer, not just its unreliable return value.
          if (typeof document.execCommand === "function" && (typeof document.queryCommandSupported !== "function" || document.queryCommandSupported("insertText"))) {
            document.execCommand("insertText", false, replacement);
          }
        } catch { /* Unsupported commands fall through to range replacement. */ }
        // Never insert twice if the command changed text despite returning false
        // or throwing. A canceled/unsupported command leaves the original buffer.
        if (element.value === snapshot.text && canEdit()) element.setRangeText(replacement, snapshot.token.start, snapshot.token.end, "end");
        edited = element.value === text;
      }
      if (owned() && (store.draft().text === snapshot.text || store.draft().text === element.value)) {
        if (edited) element.setSelectionRange(caret, caret);
        else if (element.value === snapshot.text) element.setSelectionRange(snapshot.caret, snapshot.caret);
        insert(element.value); synchronized = true;
      }
    } finally {
      editing.current = false; element.scrollTop = scrollTop; element.scrollLeft = scrollLeft;
    }
    if (edited && synchronized && directory) refresh();
    return true;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) nativeComposing.current = true;
    // Return without preventing the native IME event; also bypass explicit send.
    if (nativeComposing.current || composing.current) { dismiss(); return true; }
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !open) return false;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); return true; }
    const selected = snapshot && selection.current?.signature === signature(snapshot);
    const waiting = snapshot && loading.current?.signature === signature(snapshot);
    const stale = results?.snapshot === snapshot && !!results.reader && !metadataCurrent(results);
    if (snapshot && current(snapshot) && ((event.key === "Enter" && selected && (stale || waiting))
      || ((event.key === "ArrowDown" || event.key === "ArrowUp") && (stale && !!(results?.directory?.listing || results?.paths?.index) || waiting && selected)))) {
      event.preventDefault(); refresh(true); return true;
    }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && visible?.options.length && snapshot && current(snapshot) && metadataCurrent(visible)) {
      event.preventDefault();
      const next = event.key === "ArrowDown" ? (activeIndex + 1) % visible.options.length : (activeIndex < 0 ? visible.options.length - 1 : (activeIndex - 1 + visible.options.length) % visible.options.length);
      selection.current = { signature: signature(snapshot), path: visible.options[next]!.entry.path }; scrollSelection.current = visible.options[next]!.entry.path; setActiveIndex(next);
      return true;
    }
    if (event.key === "Enter" && activeIndex >= 0 && choose(activeIndex)) { event.preventDefault(); return true; }
    return false;
  };
  useLayoutEffect(() => {
    if (!open) return;
    const element = panel.current!, textarea = input.current!;
    element.showPopover();
    let upwards: boolean | undefined;
    const position = () => {
      const rect = textarea.getBoundingClientRect(), width = Math.max(0, Math.min(480, window.innerWidth - 24));
      const above = Math.max(0, rect.top - 12), below = Math.max(0, window.innerHeight - rect.bottom - 12);
      upwards ??= above > below;
      const maxHeight = Math.min(260, upwards ? above : below);
      element.style.width = `${width}px`; element.style.maxHeight = `${maxHeight}px`;
      const height = element.getBoundingClientRect().height;
      element.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
      element.style.top = `${Math.max(6, Math.min(upwards ? rect.top - height - 6 : rect.bottom + 6, window.innerHeight - height - 6))}px`;
    };
    const outside = (event: Event) => { if (!element.contains(event.target as Node) && event.target !== textarea) dismiss(); };
    const scroll = (event: Event) => { if (!element.contains(event.target as Node)) position(); };
    position();
    const observer = new ResizeObserver(position); observer.observe(textarea); observer.observe(element);
    document.addEventListener("pointerdown", outside, true); document.addEventListener("focusin", outside);
    window.addEventListener("resize", position); window.addEventListener("scroll", scroll, true);
    return () => {
      element.hidePopover(); observer.disconnect();
      document.removeEventListener("pointerdown", outside, true); document.removeEventListener("focusin", outside);
      window.removeEventListener("resize", position); window.removeEventListener("scroll", scroll, true);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (activeIndex >= 0 && visible?.options[activeIndex]?.entry.path === scrollSelection.current) {
      scrollSelection.current = undefined; document.getElementById(`${id}-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, visible]);

  const StatusIcon = visible?.statusKind === "loading" ? FiLoader : visible?.statusKind === "refreshing" ? FiRefreshCw
    : visible?.statusKind === "error" || visible?.statusKind === "unavailable" ? FiAlertCircle
    : visible?.statusKind === "incomplete" ? FiMoreHorizontal : visible?.statusKind === "empty" ? FiSearch : undefined;

  return {
    refresh, dismiss, onKeyDown,
    onInput: (isComposing: boolean) => { if (editing.current) return; nativeComposing.current = isComposing; if (isComposing || composing.current) dismiss(); else refresh(); },
    onFocus: () => { nativeComposing.current = false; refresh(); },
    onCompositionStart: () => { composing.current = true; dismiss(); },
    onCompositionEnd: () => { composing.current = false; nativeComposing.current = false; dismissed.current = undefined; refresh(); },
    aria: { role: "combobox", "aria-autocomplete": "list" as const, "aria-haspopup": "listbox" as const, "aria-expanded": open,
      "aria-controls": `${id}-list`, "aria-activedescendant": open && visible?.options[activeIndex] ? `${id}-${activeIndex}` : undefined },
    popup: <div ref={panel} popover="manual" className="chat-path-popover" onPointerDown={event => event.preventDefault()}>
      <div id={`${id}-list`} role="listbox" aria-label="Paths relative to execution directory">
        {open && visible?.options.map(({ entry, relativePath }, index) => <div key={entry.path} id={`${id}-${index}`} role="option" aria-selected={activeIndex === index} aria-disabled={!metadataFresh}
          className="chat-path-option" onPointerDown={event => { if (event.isPrimary && event.button === 0) { event.preventDefault(); choose(index); } }}
          // Pointer gestures are consumed on down, even when choose only refreshes stale metadata.
          onClick={event => { if (event.detail === 0) choose(index); }}><span aria-hidden="true">{entry.kind === "directory" ? "▸" : "·"}</span><span className="chat-path-label"><span>{entry.name}{entry.kind === "directory" ? "/" : ""}</span><span className="chat-path-parent">{relativePath.includes("/") ? relativePath.slice(0, relativePath.lastIndexOf("/")) + "/" : "./"}</span></span></div>)}
      </div>
      <div className="chat-path-indicators">
        {open && StatusIcon && <span role="img" aria-label={visible!.status} title={visible!.status}><StatusIcon size={14} aria-hidden="true" /></span>}
        {open && visible?.bounded && (visible.statusKind === "loading" || visible.statusKind === "refreshing") && <span role="img" aria-label={incompleteStatus} title={incompleteStatus}><FiMoreHorizontal size={14} aria-hidden="true" /></span>}
      </div>
      <span className="chat-path-status" role="status" aria-live="polite" aria-atomic="true">{open ? visible?.status : undefined}</span>
    </div>,
  };
}
