import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { WorkspaceSearch, WorkspaceSearchInput, WorkspaceSearchMatch } from "../src/workspace-contract";
import { useCommand, useRegisterCommand } from "./application-commands";
import { ShellDialog } from "./shell-dialog";
import { useWorkspace } from "./workspace-controller";
import { workspaceClient } from "./workspace-client";
import { workspaceEpoch, workspaceFailure } from "./workspace-store";
import "./workspace-search.css";

export const workspaceSearchCommand = "workspace.search";
export const workspaceSearchBinding = { key: "f", mod: true, shift: true } as const;
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

/** Registration lives above desktop/mobile headers; there is never a second shortcut owner. */
export function WorkspaceSearchFeature({ children }: { children: ReactNode }) {
  const controller = useWorkspace();
  const [open, setOpen] = useState(false);
  const origin = useRef<HTMLElement | null>(null);
  const current = useRef({ controller, open }); current.current = { controller, open };
  const command = useMemo(() => ({
    id: workspaceSearchCommand, label: "Search saved files", binding: workspaceSearchBinding,
    contexts: ["application", "editor", "input"] as const, priority: 10,
    available: () => !!current.current.controller.scope && current.current.controller.scope.auth === workspaceEpoch() && ["code", "git"].includes(current.current.controller.view),
    action: () => { if (current.current.open) return; origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setOpen(true); },
  }), [controller.scope, controller.view, open]);
  useRegisterCommand(command);
  const scope = controller.scope;
  useEffect(() => { setOpen(false); }, [scope, controller.view]);
  return <>{children}{open && scope && <WorkspaceSearchDialog key={`${scope.generation}:${scope.auth}:${scope.workspace.workspaceId}`} close={() => setOpen(false)} restoreFocus={() => origin.current} />}</>;
}

export function WorkspaceSearchButton() {
  const { command, enabled, execute, hint } = useCommand(workspaceSearchCommand);
  return <button type="button" className="workspace-search-opener" aria-haspopup="dialog" aria-label="Search saved files" disabled={!enabled} onClick={execute}>
    <span>{command?.label ?? "Search saved files"}</span><kbd>{hint}</kbd>
  </button>;
}

export function WorkspaceSearchDialog({ close, restoreFocus }: { close: () => void; restoreFocus: () => HTMLElement | null }) {
  const controller = useWorkspace(), scope = controller.scope;
  const [query, setQuery] = useState(""), [caseSensitive, setCaseSensitive] = useState(false), [wholeWord, setWholeWord] = useState(false);
  const [include, setInclude] = useState(""), [exclude, setExclude] = useState("");
  const input = useRef<HTMLInputElement>(null), buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const [active, setActive] = useState(0);
  const destination = useRef<string | null>(null);
  const state = useWorkspaceSearch(scope?.id, scope?.workspace.workspaceId, scope?.generation, { query, caseSensitive, wholeWord, include, exclude });
  const matches = state.result?.matches ?? [];
  const groups = new Map<string, { match: WorkspaceSearchMatch; index: number }[]>();
  matches.forEach((match, index) => { const group = groups.get(match.path) ?? []; group.push({ match, index }); groups.set(match.path, group); });
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { setActive(0); buttons.current.length = matches.length; }, [state.key, state.result]);
  const open = (match: WorkspaceSearchMatch) => {
    destination.current = match.path;
    controller.activate({ view: "code", path: match.path, location: { ...match, query, caseSensitive, wholeWord } });
    close();
  };
  const focusResult = (index: number) => {
    if (!matches.length) return;
    const next = Math.max(0, Math.min(matches.length - 1, index));
    setActive(next); buttons.current[next]?.focus(); buttons.current[next]?.scrollIntoView?.({ block: "nearest" });
  };
  return <ShellDialog title="Search saved files" className="workspace-search-dialog" close={close}
    restoreFocus={() => destination.current ? controller.root?.buffers.get(destination.current)?.view?.contentDOM ?? restoreFocus() : restoreFocus()}>
    <p className="workspace-search-scope">Saved files only in this worktree. Unsaved buffers are not searched or replaced.</p>
    <div onKeyDown={event => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
      const inResults = buttons.current.includes(event.target as HTMLButtonElement);
      if (event.key === "ArrowDown" && (inResults || event.target === input.current)) { if (matches.length) { event.preventDefault(); focusResult(inResults ? active + 1 : 0); } }
      else if (inResults && event.key === "ArrowUp") { event.preventDefault(); if (active === 0) input.current?.focus(); else focusResult(active - 1); }
      else if (inResults && (event.key === "Home" || event.key === "End")) { event.preventDefault(); focusResult(event.key === "Home" ? 0 : matches.length - 1); }
      else if (event.target === input.current && event.key === "Enter" && matches[0]) { event.preventDefault(); open(matches[0]); }
    }}>
      <label className="workspace-search-query">Find text<input ref={input} type="search" autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Literal text (not a regular expression)" /></label>
      <div className="workspace-search-options">
        <label><input type="checkbox" checked={caseSensitive} onChange={event => setCaseSensitive(event.target.checked)} />Case sensitive</label>
        <label><input type="checkbox" checked={wholeWord} onChange={event => setWholeWord(event.target.checked)} />Whole word</label>
      </div>
      <div className="workspace-search-paths">
        <label>Include paths<input value={include} onChange={event => setInclude(event.target.value)} placeholder="src/**, docs/**" /></label>
        <label>Exclude paths<input value={exclude} onChange={event => setExclude(event.target.value)} placeholder="**/*.lock, generated/**" /></label>
      </div>
      <p className="workspace-search-help">Paths use comma-separated, worktree-relative globs. Use ↓/↑ to navigate results and Enter to open.</p>
      <div role="status" aria-live="polite" className="workspace-search-status">
        {!query ? "Enter text to search saved files." : state.loading ? "Searching saved files…" : state.result ? `${matches.length} matches · ${state.result.scannedFiles} files scanned${state.result.skippedFiles ? ` · ${state.result.skippedFiles} files skipped (filtered, inaccessible, or unsupported)` : ""}${state.result.truncated ? " · Results truncated; narrow your search." : ""}${!matches.length ? " · No matches." : ""}` : ""}
      </div>
      {state.error && <p role="alert" className="workspace-search-error">{state.error}</p>}
      <div className="workspace-search-results" aria-label="Saved-file search results" aria-busy={!!state.loading}>
        {[...groups].map(([path, entries]) => <section key={path} aria-label={path}>
          <h3>{path}</h3><ul>{entries.map(({ match, index }) => <li key={`${match.line}:${match.column}:${index}`}>
            <button type="button" ref={node => { buttons.current[index] = node; }} tabIndex={index === active ? 0 : -1} onFocus={() => setActive(index)} onClick={() => open(match)} aria-label={`${path}, line ${match.line}, column ${match.column}: ${match.preview}`}>
              <span className="workspace-search-position">{match.line}:{match.column}</span><code>{match.preview}</code>
            </button>
          </li>)}</ul>
        </section>)}
      </div>
    </div>
  </ShellDialog>;
}
