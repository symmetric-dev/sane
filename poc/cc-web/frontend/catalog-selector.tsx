import { useRef, useState, useSyncExternalStore } from "react";
import type { WorktreeRecord } from "../src/catalog-contract";
import { catalog } from "./catalog";
import { store } from "./store";
import { ShellDialog } from "./shell-dialog";

export const worktreeLabel = (worktree: WorktreeRecord) => worktree.branch || (worktree.detached ? "Detached HEAD" : worktree.root.split("/").filter(Boolean).at(-1) || worktree.root);

export function CatalogSelector({ retry }: { retry: () => void }) {
  const state = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const chat = useSyncExternalStore(store.subscribe, store.snapshot);
  const [panel, setPanel] = useState<"workspaces" | "worktrees" | "directory" | null>(null);
  const [search, setSearch] = useState(""), [cwd, setCwd] = useState(""), [busy, setBusy] = useState(false), [feedback, setFeedback] = useState("");
  const dialogIntent = useRef(0);
  const { navigation } = state;
  const workspace = state.workspaces.find(w => w.workspaceId === navigation.workspaceId);
  const worktree = workspace?.worktrees.find(w => w.worktreeId === navigation.worktreeId);
  const close = () => { dialogIntent.current++; setPanel(null); };
  const show = (next: "workspaces" | "worktrees") => { dialogIntent.current++; setSearch(""); setFeedback(""); setPanel(next); };
  const checkoutPicker = workspace && <section className="context-worktrees" aria-label="Browsing worktree">
    <label>Browsing worktree<select autoFocus={panel === "worktrees"} value={navigation.worktreeId ?? ""} disabled={chat.sending || busy} onChange={event => {
      if (event.target.value) catalog.navigate({ worktreeId: event.target.value, filePath: null, comparison: null });
      setFeedback("");
    }}><option value="">Choose worktree</option>{navigation.worktreeId && !worktree && <option value={navigation.worktreeId}>Unavailable worktree</option>}{workspace.worktrees.map(w => <option key={w.worktreeId} value={w.worktreeId}>{worktreeLabel(w)} · {w.root}{w.state !== "available" ? " (unavailable)" : ""}</option>)}</select></label>
    {worktree && <small className="context-path">{worktree.root}</small>}
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
  return <div className="context-switcher">
    <button type="button" className="context-opener" aria-haspopup="dialog" aria-label={`Switch workspace${workspace ? `: ${workspace.name}` : ""}`} title={worktree?.root} onClick={() => show("workspaces")}><span>{workspace?.name || (navigation.workspaceId ? "Unavailable workspace" : "Open workspace")}</span><span aria-hidden="true">⌄</span></button>
    {workspace && <button type="button" className="worktree-opener" aria-haspopup="dialog" aria-label={`Browse worktrees: ${worktree ? worktreeLabel(worktree) : "Choose worktree"}`} title={worktree?.root} onClick={() => show("worktrees")}><span>{worktree ? worktreeLabel(worktree) : "Choose worktree"}</span><span aria-hidden="true">⌄</span></button>}
    {panel && <ShellDialog title={panel === "directory" ? "Open directory" : panel === "worktrees" ? "Worktrees" : "Workspaces"} close={close}>
      {panel === "directory" ? <form className="open-directory" onSubmit={async event => {
        event.preventDefault();
        if (busy || store.state.sending || !cwd.trim()) return;
        const intent = dialogIntent.current;
        setBusy(true);
        const opened = await catalog.open(cwd.trim(), () => intent === dialogIntent.current && !store.state.sending);
        setBusy(false);
        if (opened && intent === dialogIntent.current) close();
      }}><label>Directory path<input autoFocus required value={cwd} placeholder="/absolute/path/to/project" onChange={event => setCwd(event.target.value)} /></label><p className="muted">Open a local repository or folder. Repositories include their main and linked worktrees; other folders open as directory workspaces.</p><div className="dialog-actions"><button type="button" onClick={() => { dialogIntent.current++; setPanel("workspaces"); }}>Back</button><button type="submit" disabled={busy || chat.sending || !cwd.trim()}>{busy ? "Opening…" : "Open directory"}</button></div></form> : <>
        {panel === "workspaces" ? <><label className="workspace-search"><span className="sr-only">Search workspace names and paths</span><input autoFocus value={search} onChange={event => setSearch(event.target.value)} placeholder="Search names or paths…" /></label><div className="workspace-choices" aria-label="Existing workspaces">{state.workspaces.filter(w => `${w.name} ${w.worktrees.map(t => t.root).join(" ")}`.toLowerCase().includes(search.toLowerCase())).map(w => <button type="button" key={w.workspaceId} aria-current={w.workspaceId === navigation.workspaceId ? "true" : undefined} disabled={chat.sending || busy} onClick={() => {
          if (w.workspaceId !== navigation.workspaceId) catalog.navigate({ workspaceId: w.workspaceId, worktreeId: w.worktrees.find(t => t.state === "available")?.worktreeId ?? w.worktrees[0]?.worktreeId ?? null, filePath: null, comparison: null });
          close();
        }}><span>{w.name}{w.workspaceId === navigation.workspaceId ? " · Current" : ""}</span><small>{w.worktrees[0]?.root || "Unavailable directory"}</small></button>)}{!state.workspaces.some(w => `${w.name} ${w.worktrees.map(t => t.root).join(" ")}`.toLowerCase().includes(search.toLowerCase())) && <p className="muted">{state.loading ? "Loading workspaces…" : search ? "No matching workspaces." : "No workspaces yet."}</p>}</div>{checkoutPicker}<button type="button" className="secondary-directory" disabled={busy || chat.sending} onClick={() => { setCwd(worktree?.root || chat.config?.cwd || ""); setPanel("directory"); }}>Open directory…</button></> : <>{checkoutPicker}<button type="button" className="secondary-directory" onClick={() => setPanel("workspaces")}>Switch workspace…</button></>}
      </>}
      {feedback && <p className="context-feedback" role="status">{feedback}</p>}
      {state.error && <p className="notice error" role="status">{state.error}{!state.ready && <button type="button" onClick={retry}>Retry</button>}</p>}
    </ShellDialog>}
    {state.error && !panel && <button type="button" className="context-error" aria-label="Workspace or navigation error: open details" title={state.error} onClick={() => show("workspaces")}>!</button>}
  </div>;
}
