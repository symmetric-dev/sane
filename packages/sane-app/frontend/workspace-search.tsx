import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { WorkspaceSearch, WorkspaceSearchInput, WorkspaceSearchMatch } from "../src/workspace-contract";
import { useCommand, useRegisterCommand } from "./application-commands";
import { useWorkspace } from "./workspace-controller";
import { workspaceClient } from "./workspace-client";
import { dirty, workspaceEpoch, workspaceFailure } from "./workspace-store";
import { FILE_SHORTCUTS } from "./shortcut-definitions";
import "./workspace-search.css";

export const workspaceSearchCommand = FILE_SHORTCUTS.search.id;
export const workspaceSearchBinding = FILE_SHORTCUTS.search.binding;
type SearchOptions = Omit<WorkspaceSearchInput, "workspaceId">;
export const searchDebounceMs = 250;

/** Requests and rendered results share the same scope/query/auth fence. */
export function useWorkspaceSearch(id: string | undefined, workspaceId: string | undefined, scopeGeneration: number | undefined, options: SearchOptions) {
  const auth = workspaceEpoch();
  const key = JSON.stringify([id, workspaceId, scopeGeneration, auth, options]);
  const identity = useRef(key); identity.current = key;
  const [state, setState] = useState<{ key: string; result?: WorkspaceSearch; error?: string; loading?: boolean }>();
  useEffect(() => {
    if (!id || !workspaceId || !options.query) return;
    const abort = new AbortController();
    const current = () => !abort.signal.aborted && identity.current === key && workspaceEpoch() === auth;
    setState({ key, loading: true });
    const timer = setTimeout(() => {
      void workspaceClient.search(id, { workspaceId, ...options }, abort.signal).then(result => {
        if (current()) setState({ key, result });
      }).catch(error => {
        if (current()) setState({ key, error: workspaceFailure(error) });
      });
    }, searchDebounceMs);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [key]);
  return state?.key === key ? state : { key, loading: !!id && !!workspaceId && !!options.query };
}

export const searchMatchId = (match: WorkspaceSearchMatch) => JSON.stringify([match.path, match.line, match.column, match.endColumn]);
const initialOptions: SearchOptions = { query: "", caseSensitive: false, wholeWord: false, include: "", exclude: "" };
type SearchSession = {
  scopeKey: string; codeActivationRevision: number; mode: "files" | "search"; options: SearchOptions; focusRequest: number;
  destination: { key: string; id: string } | null; active: { key: string; id: string } | null;
};
const freshSession = (scopeKey: string, codeActivationRevision: number): SearchSession => ({ scopeKey, codeActivationRevision, mode: "files", options: initialOptions, focusRequest: 0, destination: null, active: null });

function useSearchModel() {
  const controller = useWorkspace(), scope = controller.scope;
  const scopeKey = scope ? JSON.stringify([scope.id, scope.workspace.workspaceId, scope.generation, scope.auth, scope.bindingRevision]) : "unavailable";
  const codeActivationRevision = controller.codeActivation?.revision ?? 0;
  const [session, setSession] = useState(() => freshSession(scopeKey, codeActivationRevision));
  // Reset this state owner during render, without remounting the shell/chat/editor subtree.
  // The derived session also hides old data before effects or request cleanup can run.
  const scopedSession = session.scopeKey === scopeKey ? session : freshSession(scopeKey, codeActivationRevision);
  // Only an explicit controller activation changes this intent. Acquiring a file
  // asynchronously cannot accidentally exit search; create/copy/Open in Files can.
  const currentSession = scopedSession.codeActivationRevision === codeActivationRevision ? scopedSession : {
    ...scopedSession, codeActivationRevision,
    mode: controller.codeActivation?.source === "files" ? "files" as const : scopedSession.mode,
  };
  if (session !== currentSession) setSession(currentSession);
  const { mode, options, focusRequest, destination, active } = currentSession;
  const changeSession = (change: Partial<SearchSession>) => setSession(value => ({ ...(value.scopeKey === scopeKey ? value : freshSession(scopeKey, codeActivationRevision)), ...change }));
  const input = useRef<HTMLInputElement>(null);
  const resultButtons = useRef(new Map<string, HTMLButtonElement>());
  const results = useRef<HTMLDivElement>(null);
  const allResultsButton = useRef<HTMLButtonElement>(null);
  const resultScroll = useRef({ key: "", top: 0 });
  const pendingResultFocus = useRef<{ key: string; id: string } | null>(null);
  const state = useWorkspaceSearch(scope?.id, scope?.workspace.workspaceId, scope?.generation, options);
  const identity = useRef({ scopeKey, searchKey: state.key }); identity.current = { scopeKey, searchKey: state.key };
  const matches = state.result?.matches ?? [];
  const groups = useMemo(() => {
    const value = new Map<string, WorkspaceSearchMatch[]>();
    for (const match of matches) { const group = value.get(match.path) ?? []; group.push(match); value.set(match.path, group); }
    return value;
  }, [state.result]);
  const activeId = active?.key === state.key && matches.some(match => searchMatchId(match) === active.id) ? active.id : matches[0] ? searchMatchId(matches[0]) : "";
  const opened = destination?.key === state.key ? matches.find(match => searchMatchId(match) === destination.id) : undefined;
  const showingFile = !!opened && controller.selected === opened.path;
  const enter = () => {
    pendingResultFocus.current = null;
    changeSession({ mode: "search", focusRequest: focusRequest + 1 });
    // Also closes the mobile drawer / artifact preview through the existing shell navigation.
    controller.navigateView("code");
  };
  const open = (match: WorkspaceSearchMatch) => {
    if (!scope || scope.auth !== workspaceEpoch() || identity.current.scopeKey !== scopeKey || identity.current.searchKey !== state.key || !matches.includes(match)) return;
    if (results.current && !showingFile) resultScroll.current = { key: state.key, top: results.current.scrollTop };
    pendingResultFocus.current = null;
    const id = searchMatchId(match);
    changeSession({ destination: { key: state.key, id }, active: { key: state.key, id } });
    controller.activate({ view: "code", source: "search", path: match.path, location: { ...match, ...options } });
  };
  const focusResult = (id = activeId) => {
    const node = resultButtons.current.get(id);
    if (node) { changeSession({ active: { key: state.key, id } }); node.focus(); node.scrollIntoView?.({ block: "nearest" }); }
  };
  const allResults = () => { pendingResultFocus.current = { key: state.key, id: activeId }; changeSession({ destination: null }); };
  const update = (change: Partial<SearchOptions>) => { pendingResultFocus.current = null; changeSession({ options: { ...options, ...change }, destination: null, active: null }); };
  return { mode, available: !!scope, options, state, matches, groups, activeId, opened, showingFile, input, resultButtons, results, allResultsButton, resultScroll, pendingResultFocus, focusRequest,
    enter, open, focusResult, allResults, update, setActive: (id: string) => changeSession({ active: { key: state.key, id } }),
    files: () => { pendingResultFocus.current = null; changeSession({ mode: "files" }); controller.activate({ view: "code", path: controller.selected }); },
  };
}
const SearchContext = createContext<ReturnType<typeof useSearchModel> | null>(null);
export function useWorkspaceSearchContext() { return useContext(SearchContext); }

/** One owner above desktop/mobile composition; changing scope resets and aborts atomically. */
export function WorkspaceSearchFeature({ children }: { children: ReactNode }) {
  return <SearchProvider>{children}</SearchProvider>;
}
function SearchProvider({ children }: { children: ReactNode }) {
  const controller = useWorkspace(), model = useSearchModel();
  const current = useRef({ controller, model }); current.current = { controller, model };
  const command = useMemo(() => ({
    ...FILE_SHORTCUTS.search,
    contexts: ["application", "editor", "input"] as const, priority: 10,
    available: () => !!current.current.controller.scope && current.current.controller.scope.auth === workspaceEpoch() && ["code", "git"].includes(current.current.controller.view),
    action: () => current.current.model.enter(),
  }), [controller.scope, controller.view]);
  useRegisterCommand(command);
  return <SearchContext.Provider value={model}>{children}</SearchContext.Provider>;
}

export function WorkspaceSearchButton() {
  const { command, enabled, execute, hint } = useCommand(workspaceSearchCommand);
  return <button type="button" className="workspace-search-opener" aria-label="Search saved files" disabled={!enabled} onClick={execute}>
    <span>{command?.label ?? "Search saved files"}</span><kbd>{hint}</kbd>
  </button>;
}

export function WorkspaceSearchStatus() {
  const search = useWorkspaceSearchContext();
  if (!search) return null;
  const { options, state, matches, groups } = search;
  return <>
    <div role="status" aria-live="polite" className="workspace-search-status">
      {!options.query ? "Enter text to search saved files." : state.loading ? "Searching saved files…" : state.result ? `${matches.length} matches in ${groups.size} files · ${state.result.scannedFiles} files scanned${state.result.skippedFiles ? ` · ${state.result.skippedFiles} files skipped (filtered, inaccessible, or unsupported)` : ""}${state.result.truncated ? " · Results truncated; narrow your search." : ""}${!matches.length ? " · No matches." : ""}` : ""}
    </div>
    {state.error && <p role="alert" className="workspace-search-error">{state.error}</p>}
  </>;
}

/** The query lives in the main panel, above either all results or the existing file editor. */
export function WorkspaceSearchPanel({ children }: { children: ReactNode }) {
  const search = useWorkspaceSearchContext(), controller = useWorkspace();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const enabled = search?.mode === "search" && controller.view === "code";
  useEffect(() => { if (enabled && search?.focusRequest) search.input.current?.focus(); }, [enabled, search?.focusRequest]);
  useLayoutEffect(() => {
    if (!enabled || !search || search.showingFile || !search.results.current) return;
    search.results.current.scrollTop = search.resultScroll.current.key === search.state.key ? search.resultScroll.current.top : 0;
    const pending = search.pendingResultFocus.current;
    search.pendingResultFocus.current = null;
    if (pending?.key === search.state.key) {
      // This one-shot handoff is requested only by All results, never by a normal
      // response render. Do not scroll the retained match into view.
      (search.resultButtons.current.get(pending.id) ?? search.results.current).focus({ preventScroll: true });
    }
  }, [search?.showingFile, search?.state.key, enabled]);
  if (!enabled || !search) return <>{children}</>;
  const { options, matches, opened, groups } = search;
  const fileMatches = opened ? groups.get(opened.path) ?? [] : [];
  const fileIndex = opened ? fileMatches.indexOf(opened) : -1;
  const plainKey = (event: KeyboardEvent) => !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.nativeEvent.isComposing;
  const keyDown = (event: KeyboardEvent) => {
    if (!plainKey(event)) return;
    const node = event.target as HTMLElement;
    const inResults = [...search.resultButtons.current.values()].includes(node as HTMLButtonElement);
    const index = matches.findIndex(match => searchMatchId(match) === search.activeId);
    if (event.key === "Escape") {
      event.preventDefault();
      if (search.showingFile) { const editor = controller.buffer?.view; if (editor) editor.focus(); else search.allResultsButton.current?.focus(); }
      else if (matches.length) search.focusResult(); else search.results.current?.focus();
    } else if (!search.showingFile && event.key === "ArrowDown" && (inResults || node === search.input.current) && matches.length) {
      event.preventDefault(); search.focusResult(searchMatchId(matches[inResults ? Math.min(matches.length - 1, index + 1) : 0]!));
    } else if (inResults && event.key === "ArrowUp") {
      event.preventDefault(); if (index <= 0) search.input.current?.focus(); else search.focusResult(searchMatchId(matches[index - 1]!));
    } else if (inResults && (event.key === "Home" || event.key === "End")) {
      event.preventDefault(); search.focusResult(searchMatchId(matches[event.key === "Home" ? 0 : matches.length - 1]!));
    } else if (event.key === "Enter" && (inResults || node === search.input.current) && matches.length) {
      event.preventDefault(); search.open(matches[inResults ? Math.max(0, index) : 0]!);
    }
  };
  return <div className="workspace-search-panel" onKeyDown={keyDown} role="region" aria-label="Search saved files panel">
    <div className="workspace-search-toolbar">
      <div className="workspace-search-query-row">
        <label className="workspace-search-query">Find text<input ref={search.input} type="search" value={options.query} onChange={event => search.update({ query: event.target.value })} placeholder="Literal text (not a regular expression)" /></label>
        <div className="workspace-search-options">
          <label title="Case sensitive"><input type="checkbox" aria-label="Case sensitive" checked={!!options.caseSensitive} onChange={event => search.update({ caseSensitive: event.target.checked })} />Aa</label>
          <label title="Whole word"><input type="checkbox" checked={!!options.wholeWord} onChange={event => search.update({ wholeWord: event.target.checked })} />Whole word</label>
          <button type="button" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(value => !value)}>Path filters{options.include || options.exclude ? " •" : ""}</button>
        </div>
      </div>
      {filtersOpen && <div className="workspace-search-paths">
        <label>Include paths<input value={options.include} onChange={event => search.update({ include: event.target.value })} placeholder="src/**, docs/**" /></label>
        <label>Exclude paths<input value={options.exclude} onChange={event => search.update({ exclude: event.target.value })} placeholder="**/*.lock, generated/**" /></label>
        <p>Comma-separated, worktree-relative globs.</p>
      </div>}
      <p className="workspace-search-scope">Saved files only in this worktree. Unsaved buffers are not searched or replaced.</p>
      <WorkspaceSearchStatus />
    </div>
    {search.showingFile && opened && <div className="workspace-search-filebar">
      <button ref={search.allResultsButton} type="button" onClick={search.allResults}>All results</button>
      <span className="workspace-search-filename" title={opened.path}>{opened.path}</span>
      <span aria-label="Current file match">{fileIndex + 1} of {fileMatches.length}</span>
      <button type="button" aria-label="Previous match" disabled={!controller.buffer || controller.opening || fileIndex <= 0} onClick={() => search.open(fileMatches[fileIndex - 1]!)}>↑</button>
      <button type="button" aria-label="Next match" disabled={!controller.buffer || controller.opening || fileIndex < 0 || fileIndex >= fileMatches.length - 1} onClick={() => search.open(fileMatches[fileIndex + 1]!)}>↓</button>
    </div>}
    <div ref={search.results} className="workspace-search-results" hidden={search.showingFile} role="region" tabIndex={-1} aria-label="Saved-file search results" aria-busy={!!search.state.loading}
      onScroll={event => { if (!search.showingFile) search.resultScroll.current = { key: search.state.key, top: event.currentTarget.scrollTop }; }}>
      {[...groups].map(([path, entries]) => <section key={path} aria-label={path}>
        <h3>{path}<span>{entries.length}</span></h3><ul>{entries.map(match => {
          const id = searchMatchId(match);
          return <li key={id}><button type="button" ref={node => { if (node) search.resultButtons.current.set(id, node); else search.resultButtons.current.delete(id); }}
            className={id === search.activeId ? "is-active" : ""} tabIndex={id === search.activeId ? 0 : -1} onFocus={() => search.setActive(id)} onClick={() => search.open(match)}
            aria-label={`${path}, line ${match.line}, column ${match.column}: ${match.preview}`}>
            <span className="workspace-search-position">{match.line}:{match.column}</span><code>{match.preview}</code>
          </button></li>;
        })}</ul>
      </section>)}
    </div>
    {search.showingFile && <div className="workspace-search-file">{children}</div>}
  </div>;
}

type SearchTreeNode = { path: string; name: string; count: number; match?: WorkspaceSearchMatch; children: Map<string, SearchTreeNode> };
/** Matching files only, never line previews or an independent search request. */
export function WorkspaceSearchFiles() {
  const search = useWorkspaceSearchContext(), controller = useWorkspace();
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [focused, setFocused] = useState("");
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  if (!search) return null;
  const tree: SearchTreeNode = { path: "", name: "", count: 0, children: new Map() };
  for (const [path, matches] of search.groups) {
    let parent = tree;
    path.split("/").forEach((name, index, parts) => {
      const nodePath = parts.slice(0, index + 1).join("/");
      let node = parent.children.get(name);
      if (!node) { node = { path: nodePath, name, count: 0, children: new Map() }; parent.children.set(name, node); }
      node.count += matches.length;
      if (index === parts.length - 1) node.match = matches[0];
      parent = node;
    });
  }
  const rows: { node: SearchTreeNode; level: number; parent: string }[] = [];
  const walk = (parent: SearchTreeNode, level: number) => {
    [...parent.children.values()].sort((a, b) => Number(!b.match) - Number(!a.match) || a.name.localeCompare(b.name)).forEach(node => {
      rows.push({ node, level, parent: parent.path });
      if (!collapsed.has(node.path)) walk(node, level + 1);
    });
  };
  walk(tree, 1);
  const active = rows.some(row => row.node.path === focused) ? focused : rows[0]?.node.path;
  const toggle = (path: string) => setCollapsed(value => { const next = new Set(value); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  const focus = (path: string | undefined) => { if (path) { setFocused(path); buttons.current.get(path)?.focus(); } };
  return <div className="workspace-search-files">
    <p className="workspace-search-help">Matching files · {search.groups.size} files · {search.matches.length} matches</p>
    <div role="tree" aria-label="Matching saved files" aria-busy={!!search.state.loading}>
      {rows.map(({ node, level, parent }, index) => {
        const expanded = !collapsed.has(node.path), selected = search.showingFile && controller.selected === node.path;
        const unsaved = controller.root?.buffers.get(node.path);
        return <button key={node.path} ref={button => { if (button) buttons.current.set(node.path, button); else buttons.current.delete(node.path); }} type="button" role="treeitem"
          className={`workspace-tree-row${selected ? " is-selected" : ""}`} aria-level={level} aria-expanded={!node.match ? expanded : undefined} aria-selected={!!selected}
          aria-label={`${node.name}, ${node.count} matches${unsaved && dirty(unsaved) ? ", Unsaved" : ""}`} title={node.path} tabIndex={node.path === active ? 0 : -1}
          style={{ paddingLeft: `${8 + (level - 1) * 15}px` }} onFocus={() => setFocused(node.path)}
          onClick={() => node.match ? search.open(node.match) : toggle(node.path)} onKeyDown={event => {
            if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
            if (["ArrowDown", "ArrowUp", "Home", "End", "ArrowLeft", "ArrowRight", "Enter"].includes(event.key)) event.preventDefault();
            if (event.key === "ArrowDown") focus(rows[Math.min(rows.length - 1, index + 1)]?.node.path);
            else if (event.key === "ArrowUp") focus(rows[Math.max(0, index - 1)]?.node.path);
            else if (event.key === "Home" || event.key === "End") focus(rows[event.key === "Home" ? 0 : rows.length - 1]?.node.path);
            else if (event.key === "ArrowRight" && !node.match) { if (!expanded) toggle(node.path); else focus(rows[index + 1]?.node.path); }
            else if (event.key === "ArrowLeft") { if (!node.match && expanded) toggle(node.path); else focus(parent); }
            else if (event.key === "Enter") { if (node.match) search.open(node.match); else toggle(node.path); }
            else if (event.key === "Escape") {
              event.preventDefault();
              if (search.showingFile) { if (controller.buffer?.view) controller.buffer.view.focus(); else search.allResultsButton.current?.focus(); }
              else search.focusResult();
            }
          }}>
          <span className="workspace-tree-glyph" aria-hidden="true">{node.match ? "·" : expanded ? "⌄" : "›"}</span>
          <span className="workspace-tree-label">{node.name}{unsaved && dirty(unsaved) ? " •" : ""}</span><span className="workspace-search-count">{node.count}</span>
        </button>;
      })}
    </div>
  </div>;
}
