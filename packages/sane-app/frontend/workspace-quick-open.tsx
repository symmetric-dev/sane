import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import type { WorkspaceEntry } from "../src/workspace-contract";
import { useCommand, useRegisterCommand } from "./application-commands";
import { catalog, worktreeScope } from "./catalog";
import { ShellDialog } from "./shell-dialog";
import { FILE_SHORTCUTS } from "./shortcut-definitions";
import { subscribeWorkspaceMutations } from "./workspace-client";
import { useWorkspace } from "./workspace-controller";
import { PATH_INVENTORY_SUCCESS_FRESH_MS } from "./workspace-path-cache";
import { matchWorkspacePaths, WORKSPACE_PATH_MATCH_LIMIT } from "./workspace-path-matcher";
import { subscribeWorkspace, workspaceEpoch, workspaceSnapshot } from "./workspace-store";
import "./workspace-quick-open.css";

type Controller = ReturnType<typeof useWorkspace>;
type Scope = NonNullable<Controller["scope"]>;
type Session = { key: string; serial: number };
const scopeKey = (controller: Controller) => controller.scope ? JSON.stringify([
  controller.scope.id, controller.scope.workspace.workspaceId, controller.scope.generation,
  controller.scope.auth, controller.scope.bindingRevision, controller.view,
]) : "unavailable";
function eligible(controller: Controller) {
  const scope = controller.scope, navigation = catalog.snapshot().navigation;
  return !!scope && controller.view === "code" && navigation.view === "code"
    && scope.auth === workspaceEpoch() && scope.reader.current()
    && !!navigation.workspaceId && !!navigation.worktreeId
    && scope.id === worktreeScope(navigation.workspaceId, navigation.worktreeId);
}

/** One command/dialog owner outside the desktop/mobile shell and editor subtree. */
export function WorkspaceQuickOpenFeature({ children }: { children: ReactNode }) {
  const controller = useWorkspace(), key = scopeKey(controller);
  const [session, setSession] = useState<Session | null>(null);
  const serial = useRef(0), input = useRef<HTMLInputElement>(null), panel = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<{ key: string; path: string; revision: number } | null>(null);
  const open = session?.key === key && eligible(controller) ? session : null;
  if (session && !open) setSession(null);
  const live = useRef({ controller, key, open }); live.current = { controller, key, open };
  const command = useMemo(() => ({
    ...FILE_SHORTCUTS.quickOpen,
    contexts: ["application", "editor", "input", "modal"] as const, priority: 10,
    available: () => eligible(live.current.controller),
    keyboardEligible: (event: globalThis.KeyboardEvent, context: string) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('.xterm, [data-command-context="terminal"]')) return false;
      if (context !== "modal") return true;
      // A modal context is admitted only for this picker, never other dialogs.
      const dialog = panel.current?.closest("dialog");
      return !!live.current.open && !!target && !!dialog?.contains(target)
        && target.closest("dialog") === dialog
        && document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]').length === 1;
    },
    action: () => {
      if (live.current.open) { input.current?.focus(); input.current?.select(); return; }
      if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
      pendingFocus.current = null;
      setSession({ key: live.current.key, serial: ++serial.current });
    },
  }), []);
  useRegisterCommand(command);
  const current = (value: Session) => live.current.open === value && live.current.key === value.key && eligible(live.current.controller);
  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    if (open || pending.key !== key || !eligible(controller) || controller.selected !== pending.path
      || !controller.codeActivation || controller.codeActivation.revision <= pending.revision) { pendingFocus.current = null; return; }
    if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) { pendingFocus.current = null; return; }
    // Runs after ShellDialog cleanup, and again when buffer.attach announces a
    // newly mounted editor. Never let its previous-editor restoration win.
    if (controller.buffer?.view?.contentDOM.isConnected) { pendingFocus.current = null; controller.buffer.view.focus(); }
    else if (controller.error || controller.buffer && !controller.buffer.file.editable) pendingFocus.current = null;
  });
  return <>{children}{open && controller.scope && <QuickOpenDialog key={open.serial} scope={controller.scope} input={input} panel={panel}
    current={() => current(open)} close={() => setSession(value => value === open ? null : value)}
    activate={entry => {
      if (!current(open)) return;
      const active = live.current.controller;
      pendingFocus.current = { key, path: entry.path, revision: active.codeActivation?.revision ?? 0 };
      active.activate({ view: "code", path: entry.path });
      setSession(null);
    }} restoreOpenedFocus={() => {
      const active = live.current.controller, pending = pendingFocus.current;
      return pending && pending.key === live.current.key && active.selected === pending.path
        ? active.root?.buffers.get(pending.path)?.view?.contentDOM ?? document.body : document.body;
    }} />}</>;
}

export function WorkspaceQuickOpenButton() {
  const { command, enabled, execute, hint } = useCommand(FILE_SHORTCUTS.quickOpen.id);
  return <button type="button" className="workspace-quick-open-opener" aria-haspopup="dialog" disabled={!enabled} onClick={execute}>
    <span>{command?.label ?? "Quick Open"}</span><kbd>{hint}</kbd>
  </button>;
}

/** Discovery is query-independent. Closing only retires this consumer, not the shared scan. */
function useInventory(scope: Scope, current: () => boolean) {
  useSyncExternalStore(subscribeWorkspace, workspaceSnapshot);
  const [, repaint] = useState(0), requestRefresh = useRef<(force: boolean) => void>(() => {});
  const [failure, setFailure] = useState<string>();
  const fence = useRef(current); fence.current = current;
  const cached = scope.reader.readPaths("");
  useLayoutEffect(() => {
    let disposed = false, busy = false, timer: ReturnType<typeof setTimeout> | undefined;
    let signature = "";
    let blockedError: { revision: number | undefined } | undefined;
    const valid = () => !disposed && fence.current() && scope.auth === workspaceEpoch() && scope.reader.current();
    const publish = () => {
      if (!valid()) return;
      const read = scope.reader.readPaths("");
      const next = JSON.stringify([read.freshness, read.loading, read.fresh, read.current]);
      if (next !== signature) { signature = next; repaint(value => value + 1); }
    };
    const refresh = async (allowExpiredError = false) => {
      if (!valid() || busy) return;
      clearTimeout(timer);
      const read = scope.reader.readPaths("");
      if (blockedError && read.fresh && !read.result?.error) { blockedError = undefined; setFailure(undefined); }
      if (blockedError && blockedError.revision === read.freshness?.revision && !allowExpiredError && !read.loading) { publish(); return; }
      // Error expiry alone never starts a retry loop. Mutations/invalidation or
      // an explicit Retry may revoke the error revision and permit discovery.
      const settledError = read.result?.error && read.freshness?.revision === read.freshness?.resultRevision;
      if ((!read.fresh && (!settledError || allowExpiredError)) || read.loading) {
        busy = true;
        setFailure(undefined);
        const request = scope.reader.listPaths(""); publish();
        try {
          const result = await request;
          if (valid()) {
            setFailure(result.error);
            blockedError = result.error ? { revision: scope.reader.readPaths("").freshness?.revision } : undefined;
          }
        } finally { busy = false; }
      }
      if (!valid()) return;
      publish();
      if (blockedError) return;
      const latest = scope.reader.readPaths("");
      if (latest.freshness && latest.freshness.revision !== latest.freshness.resultRevision) {
        // A mutation can land after shared discovery settles but before this
        // awaiting consumer resumes. Do not lose that invalidation while busy.
        timer = setTimeout(() => { void refresh(); }, 1);
      } else if (latest.result?.index && !latest.result.error && latest.freshness) {
        timer = setTimeout(() => { void refresh(); }, Math.max(1, latest.freshness.settledAt + PATH_INVENTORY_SUCCESS_FRESH_MS - Date.now() + 1));
      }
    };
    const invalidate = () => refresh();
    scope.invalidators.add(invalidate); scope.directoryRevalidators.add(refresh);
    const unsubscribe = subscribeWorkspaceMutations(mutation => {
      if (mutation.scopeId === scope.id && mutation.workspaceId === scope.workspace.workspaceId) void refresh();
    });
    requestRefresh.current = force => { if (valid()) { if (force) scope.reader.invalidate([""]); void refresh(force); } };
    // Reopening is a user retry boundary for an expired cached error; background
    // revalidation remains error-loop-free while this dialog stays open.
    void refresh(true);
    return () => { disposed = true; clearTimeout(timer); unsubscribe(); scope.invalidators.delete(invalidate); scope.directoryRevalidators.delete(refresh); requestRefresh.current = () => {}; };
  }, [scope]);
  return { cached, failure, retry: () => requestRefresh.current(true), refresh: () => requestRefresh.current(false) };
}

function QuickOpenDialog({ scope, input, panel, current, close, activate, restoreOpenedFocus }: {
  scope: Scope; input: RefObject<HTMLInputElement | null>; panel: RefObject<HTMLDivElement | null>;
  current: () => boolean; close: () => void; activate: (entry: WorkspaceEntry) => void; restoreOpenedFocus: () => HTMLElement;
}) {
  const id = useId(), composing = useRef(false), opened = useRef(false);
  const [query, setQuery] = useState(""), [selection, setSelection] = useState("");
  const { cached, failure, retry, refresh } = useInventory(scope, current);
  const index = cached.result?.index;
  const validIndex = index?.workspaceId === scope.workspace.workspaceId && index.prefix === "" ? index : undefined;
  const results = useMemo(() => {
    if (!validIndex) return { entries: [] as WorkspaceEntry[], bounded: false };
    if (query) {
      const matched = matchWorkspacePaths(validIndex, query, { prefix: "" });
      return { entries: matched.matches.map(match => match.entry), bounded: matched.bounded };
    }
    // Index entries already have safe exact paths. Empty-query ordering is
    // deterministic and bounded; directories and unindexed raw rows stay out.
    const files = validIndex.entries.filter(candidate => candidate.entry.kind === "file").sort((a, b) =>
      a.normalizedPath < b.normalizedPath ? -1 : a.normalizedPath > b.normalizedPath ? 1 : a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0);
    return { entries: files.slice(0, WORKSPACE_PATH_MATCH_LIMIT).map(candidate => candidate.entry), bounded: validIndex.truncated || files.length > WORKSPACE_PATH_MATCH_LIMIT };
  }, [validIndex, query]);
  const active = results.entries.find(entry => entry.path === selection) ?? results.entries[0];
  if ((active?.path ?? "") !== selection) setSelection(active?.path ?? "");
  const fresh = current() && cached.current && cached.fresh && !cached.loading && !!validIndex && !cached.result?.error && !failure;
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  useLayoutEffect(() => { if (active) document.getElementById(`${id}-${results.entries.indexOf(active)}`)?.scrollIntoView({ block: "nearest" }); }, [active?.path, results]);
  const choose = (entry: WorkspaceEntry) => {
    if (composing.current || !current()) return;
    const latest = scope.reader.readPaths("");
    if (!fresh || !latest.current || !latest.fresh || latest.loading || latest.result !== cached.result) { refresh(); return; }
    if (entry.kind !== "file" || !results.entries.includes(entry)
      || !latest.result?.index?.entries.some(candidate => candidate.entry === entry && candidate.relativePath === entry.path)) return;
    opened.current = true; activate(entry);
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229
      || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (event.key === "Enter") { event.preventDefault(); if (active && fresh) choose(active); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (!results.entries.length) return;
    const position = active ? results.entries.indexOf(active) : 0;
    const next = event.key === "Home" ? 0 : event.key === "End" ? results.entries.length - 1
      : Math.max(0, Math.min(results.entries.length - 1, position + (event.key === "ArrowDown" ? 1 : -1)));
    setSelection(results.entries[next]!.path);
  };
  const error = failure || cached.result?.error;
  const unavailable = !cached.current || !!cached.result && !validIndex && !error && !cached.loading;
  const status = cached.loading ? validIndex ? "Refreshing files…" : "Loading files…" : error || (unavailable ? "Workspace unavailable." : !cached.result ? "Loading files…"
    : !fresh ? "Refreshing files…" : !results.entries.length ? "No matching files." : `${results.entries.length} files`);
  return <ShellDialog title="Quick Open" close={close} className="workspace-quick-open-dialog" restoreFocus={() => opened.current ? restoreOpenedFocus() : null}>
    <div ref={panel} className="workspace-quick-open-panel">
      <input ref={input} type="text" role="combobox" aria-label="File name or path" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded="true"
        aria-controls={`${id}-list`} aria-activedescendant={active ? `${id}-${results.entries.indexOf(active)}` : undefined}
        autoComplete="off" spellCheck={false} placeholder="File name or path…" value={query}
        onChange={event => setQuery(event.target.value)} onKeyDown={keyDown}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} />
      <div id={`${id}-list`} role="listbox" aria-label="Workspace files" aria-busy={cached.loading} className="workspace-quick-open-list">
        {results.entries.map((entry, position) => <div key={entry.path} id={`${id}-${position}`} role="option" aria-label={entry.path} aria-selected={active?.path === entry.path} aria-disabled={!fresh}
          className="workspace-quick-open-option" title={entry.path} onPointerDown={event => event.preventDefault()} onClick={() => { if (fresh) choose(entry); }}>
          <span className="workspace-quick-open-name">{entry.name}</span>
          <span className="workspace-quick-open-parent">{entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) + "/" : "./"}</span>
        </div>)}
      </div>
      <div className="workspace-quick-open-footer"><span role="status" aria-live="polite" title={status}>{status}{results.bounded ? " · Incomplete; narrow your path." : ""}</span>
        {(error || unavailable) && <button type="button" disabled={cached.loading} onClick={retry}>Retry</button>}
      </div>
    </div>
  </ShellDialog>;
}
