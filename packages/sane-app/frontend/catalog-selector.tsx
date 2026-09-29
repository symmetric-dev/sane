import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { FiChevronDown } from "react-icons/fi";
import type { WorktreeRecord } from "../src/catalog-contract";
import { catalog } from "./catalog";
import { useStore } from "./store";
import { ShellDialog } from "./shell-dialog";

export const worktreeLabel = (worktree: WorktreeRecord) => worktree.branch || (worktree.detached ? "Detached HEAD" : worktree.root.split("/").filter(Boolean).at(-1) || worktree.root);

export const worktreeShort = (worktree: WorktreeRecord): string => {
  const label = worktreeLabel(worktree);
  if (label.startsWith("refs/heads/")) return label.slice("refs/heads/".length) || label;
  if (label.startsWith("refs/")) return label.slice("refs/".length) || label;
  return label;
};

export const worktreeDisplay = (worktree: WorktreeRecord): string => {
  const alias = worktree.alias?.trim();
  return alias || worktreeShort(worktree);
};

export function CatalogSelector({ retry }: { retry: () => void }) {
  const state = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const chatCwd = useStore(s => s.config?.cwd ?? "");
  const [panel, setPanel] = useState<"context" | "directory" | null>(null);
  const [search, setSearch] = useState(""), [cwd, setCwd] = useState(""), [busy, setBusy] = useState(false), [feedback, setFeedback] = useState("");
  const [aliasDraft, setAliasDraft] = useState(""), [aliasBusy, setAliasBusy] = useState(false);
  const dialogIntent = useRef(0);
  const { navigation } = state;
  const workspace = state.workspaces.find(w => w.workspaceId === navigation.workspaceId);
  const worktree = workspace?.worktrees.find(w => w.worktreeId === navigation.worktreeId);
  const close = () => { dialogIntent.current++; setPanel(null); };
  const show = () => { dialogIntent.current++; setSearch(""); setFeedback(""); setPanel("context"); };
  useEffect(() => { setAliasDraft(worktree?.alias ?? ""); }, [worktree?.worktreeId, worktree?.alias, panel]);
  const display = worktree ? worktreeDisplay(worktree) : null;
  const fullRef = worktree ? worktreeLabel(worktree) : null;
  const openerLabel = workspace ? `${workspace.name}: ${display ?? "Choose worktree"}` : navigation.workspaceId ? "Unavailable workspace" : "Open workspace";
  const openerTitle = worktree ? `${fullRef} · ${worktree.root}` : workspace?.worktrees[0] ? `${workspace.worktrees[0].root}` : undefined;
  const openerAria = workspace ? (worktree ? `Workspace ${workspace.name}, worktree ${display}: ${fullRef} · ${worktree.root}` : `Workspace ${workspace.name}: Choose worktree`) : "Open workspace";
  const checkoutPicker = workspace && <section className="context-worktrees" aria-label="Browsing worktree">
    <label>Browsing worktree<select autoFocus={false} value={navigation.worktreeId ?? ""} disabled={busy} onChange={event => {
      if (event.target.value) catalog.navigate({ worktreeId: event.target.value, filePath: null, comparison: null });
      setFeedback("");
    }}><option value="">Choose worktree</option>{navigation.worktreeId && !worktree && <option value={navigation.worktreeId}>Unavailable worktree</option>}{workspace.worktrees.map(w => <option key={w.worktreeId} value={w.worktreeId} title={`${worktreeLabel(w)} · ${w.root}`}>{worktreeDisplay(w)} · {w.root}{w.state !== "available" ? " (unavailable)" : ""}</option>)}</select></label>
    {worktree && <small className="context-path" title={`${fullRef} · ${worktree.root}`}>{worktree.root}</small>}
    {worktree?.state === "invalid" && <p className="notice" role="status">{worktree.reason || "Worktree unavailable. History and local drafts remain accessible."}</p>}
    <button type="button" className="text-button" disabled={busy || !workspace.worktrees.length} onClick={async () => {
      const root = worktree?.root ?? workspace.worktrees[0]?.root;
      if (!root) return;
      const intent = dialogIntent.current;
      setBusy(true); setFeedback("");
      const refreshed = await catalog.refresh(workspace.workspaceId, root);
      setBusy(false);
      if (intent === dialogIntent.current && refreshed) setFeedback("Worktrees refreshed.");
    }}>{busy ? "Refreshing…" : "Refresh worktrees"}</button>
  </section>;
  const aliasEditor = workspace && worktree && <section className="context-alias" aria-label="Worktree alias">
    <label>Worktree alias<input value={aliasDraft} maxLength={80} placeholder={worktreeShort(worktree)} disabled={aliasBusy} onChange={event => setAliasDraft(event.target.value)} /></label>
    <div className="context-alias-actions">
      <button type="button" disabled={aliasBusy || aliasDraft.trim() === (worktree.alias ?? "") || aliasDraft.trim().length > 80} onClick={async () => {
        const trimmed = aliasDraft.trim();
        if (trimmed.length > 80) { setFeedback("Alias must be 1-80 characters."); return; }
        setAliasBusy(true);
        const ok = await catalog.setAlias(workspace.workspaceId, worktree.worktreeId, trimmed || null);
        setAliasBusy(false);
        if (ok) setFeedback(trimmed ? "Alias saved." : "Alias cleared.");
      }}>{aliasBusy ? "Saving…" : "Save alias"}</button>
      {worktree.alias && <button type="button" className="text-button" disabled={aliasBusy} onClick={async () => {
        setAliasBusy(true);
        const ok = await catalog.setAlias(workspace.workspaceId, worktree.worktreeId, null);
        setAliasBusy(false);
        if (ok) { setAliasDraft(""); setFeedback("Alias cleared."); }
      }}>Clear</button>}
    </div>
    <small className="muted">Short name for this worktree. Defaults to the short branch name.</small>
  </section>;
  return <div className="context-switcher">
    <button type="button" className="workspace-opener" aria-haspopup="dialog" aria-label={openerAria} title={openerTitle} onClick={show}><span>{openerLabel}</span><FiChevronDown size={13} aria-hidden="true" /></button>
    {panel && <ShellDialog title={panel === "directory" ? "Open directory" : "Workspace"} close={close}>
      {panel === "directory" ? <form className="open-directory" onSubmit={async event => {
        event.preventDefault();
        if (busy || !cwd.trim()) return;
        const intent = dialogIntent.current;
        setBusy(true);
        const opened = await catalog.open(cwd.trim(), () => intent === dialogIntent.current);
        setBusy(false);
        if (opened && intent === dialogIntent.current) close();
      }}><label>Directory path<input autoFocus required value={cwd} placeholder="/absolute/path/to/project" onChange={event => setCwd(event.target.value)} /></label><p className="muted">Open a local repository or folder. Repositories include their main and linked worktrees; other folders open as directory workspaces.</p><div className="dialog-actions"><button type="button" onClick={() => { dialogIntent.current++; setPanel("context"); }}>Back</button><button type="submit" disabled={busy || !cwd.trim()}>{busy ? "Opening…" : "Open directory"}</button></div></form> : <>
        <label className="workspace-search"><span className="sr-only">Search workspace names and paths</span><input autoFocus value={search} onChange={event => setSearch(event.target.value)} placeholder="Search names or paths…" /></label><div className="workspace-choices" aria-label="Existing workspaces">{state.workspaces.filter(w => `${w.name} ${w.worktrees.map(t => t.root).join(" ")}`.toLowerCase().includes(search.toLowerCase())).map(w => <button type="button" key={w.workspaceId} aria-current={w.workspaceId === navigation.workspaceId ? "true" : undefined} disabled={busy} onClick={() => {
          if (w.workspaceId !== navigation.workspaceId) catalog.navigate({ workspaceId: w.workspaceId, worktreeId: w.worktrees.find(t => t.state === "available")?.worktreeId ?? w.worktrees[0]?.worktreeId ?? null, filePath: null, comparison: null });
          setFeedback("");
        }}><span>{w.name}{w.workspaceId === navigation.workspaceId ? " · Current" : ""}</span><small title={w.worktrees[0]?.root}>{w.worktrees[0]?.root?.split("/").filter(Boolean).at(-1) || w.worktrees[0]?.root || "Unavailable directory"}</small></button>)}{!state.workspaces.some(w => `${w.name} ${w.worktrees.map(t => t.root).join(" ")}`.toLowerCase().includes(search.toLowerCase())) && <p className="muted">{state.loading ? "Loading workspaces…" : search ? "No matching workspaces." : "No workspaces yet."}</p>}</div>{checkoutPicker}{aliasEditor}<button type="button" className="secondary-directory" disabled={busy} onClick={() => { setCwd(worktree?.root || chatCwd || ""); setPanel("directory"); }}>Open directory…</button>
      </>}
      {feedback && <p className="context-feedback" role="status">{feedback}</p>}
      {state.error && <p className="notice error" role="status">{state.error}{!state.ready && <button type="button" onClick={retry}>Retry</button>}</p>}
    </ShellDialog>}
    {state.error && !panel && <button type="button" className="context-error" aria-label={`Workspace or navigation error: ${state.error}`} title={state.error} onClick={show}>!</button>}
  </div>;
}
