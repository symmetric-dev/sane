import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { FiEdit2, FiMessageSquare, FiMoreVertical, FiRefreshCw, FiTrash2 } from "react-icons/fi";
import { catalog } from "./catalog";
import { worktreeDisplay, worktreeShort } from "./catalog-selector";
import { ShellDialog } from "./shell-dialog";

/** Worktree actions stay scoped to the menu's worktree, not the browsing checkout. */
export function WorktreeMenu({ workspaceId, worktreeId, label, disabled, onNew }: {
  workspaceId: string; worktreeId: string; label: string; disabled: boolean; onNew: () => void;
}) {
  const repository = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const workspace = repository.workspaces.find(item => item.workspaceId === workspaceId);
  const tree = workspace?.worktrees.find(item => item.worktreeId === worktreeId);
  const [panel, setPanel] = useState<"actions" | "alias" | "delete" | null>(null);
  const [alias, setAlias] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [force, setForce] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const locked = disabled || busy || !tree || !workspace;
  const removable = workspace?.kind === "repository" && workspace.worktrees.length > 1 && tree?.gitDir !== workspace.commonDir;
  const close = () => { if (!busy) setPanel(null); };
  useLayoutEffect(() => {
    if (panel !== "actions" || !trigger.current || !menu.current) return;
    const margin = 8, gap = 4;
    const rect = trigger.current.getBoundingClientRect();
    const bounds = menu.current.getBoundingClientRect();
    const height = menu.current.scrollHeight + bounds.height - menu.current.clientHeight;
    const above = Math.max(0, rect.top - gap - margin);
    const below = Math.max(0, window.innerHeight - rect.bottom - gap - margin);
    const upwards = height > below && above > below;
    const maxHeight = Math.min(height, upwards ? above : below);
    setPosition({
      top: Math.max(margin, Math.min(upwards ? rect.top - gap - maxHeight : rect.bottom + gap, window.innerHeight - margin - maxHeight)),
      left: Math.max(margin, Math.min(rect.right - bounds.width, window.innerWidth - margin - bounds.width)),
      maxHeight,
    });
  }, [panel, busy, feedback, repository.error]);
  useEffect(() => {
    if (panel !== "actions") return;
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setPanel(null); trigger.current?.focus(); }
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !menu.current?.contains(target)) setPanel(null);
    };
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return;
      setPanel(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [panel]);
  return <>
    <button ref={trigger} type="button" className="worktree-group-settings" aria-label={`Worktree actions for ${label}`} title={`Worktree actions for ${label}`} aria-haspopup="menu" aria-expanded={panel === "actions"} aria-controls={panel === "actions" ? menuId : undefined} onClick={() => { setFeedback(""); setForce(false); setPosition(null); setPanel(panel === "actions" ? null : "actions"); }}><FiMoreVertical size={14} aria-hidden="true" /></button>
    {panel === "actions" && createPortal(<div ref={menu} id={menuId} className="history-menu-dropdown history-menu-floating worktree-menu-dropdown" role="menu" aria-label={`Worktree actions for ${label}`} style={position ?? { visibility: "hidden" }} onKeyDown={event => {
      if (event.key === "Tab") { setPanel(null); trigger.current?.focus(); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[index]?.focus();
    }}>
          <button type="button" role="menuitem" disabled={locked || tree?.state !== "available"} onClick={() => { setPanel(null); onNew(); }}><FiMessageSquare size={15} aria-hidden="true" />New Conversation</button>
          <button type="button" role="menuitem" aria-haspopup="dialog" disabled={locked} onClick={() => { setAlias(tree?.alias ?? ""); setFeedback(""); setPanel("alias"); }}><FiEdit2 size={15} aria-hidden="true" />Edit worktree alias</button>
          <button type="button" role="menuitem" disabled={locked} onClick={async () => {
            if (!tree || !workspace) return;
            setBusy(true); setFeedback("");
            try { if (await catalog.refresh(workspaceId, tree.root)) setFeedback("Worktrees refreshed."); }
            finally { setBusy(false); }
          }}><FiRefreshCw size={15} aria-hidden="true" />{busy ? "Refreshing…" : "Refresh worktrees"}</button>
          <button type="button" role="menuitem" aria-haspopup="dialog" className="worktree-delete-action" disabled={locked || !removable} title={!removable ? "The main worktree cannot be deleted." : undefined} onClick={() => { setFeedback(""); setForce(false); setPanel("delete"); }}><FiTrash2 size={15} aria-hidden="true" />Delete Worktree</button>
          {feedback && <p className="worktree-menu-feedback" role="status">{feedback}</p>}
          {repository.error && <p className="worktree-menu-feedback" role="alert">{repository.error}</p>}
    </div>, trigger.current?.closest("dialog") ?? document.body)}
    {(panel === "alias" || panel === "delete") && createPortal(<ShellDialog title={panel === "alias" ? "Worktree alias" : "Delete worktree"} subtitle={tree?.root} className="worktree-actions-dialog" closeDisabled={busy} close={close} restoreFocus={() => trigger.current}>
      {!tree && <p className="notice error" role="alert">This worktree is no longer available.</p>}
      {panel === "alias" ? <form className="open-directory" onSubmit={async event => {
        event.preventDefault();
        if (locked) return;
        setBusy(true); setFeedback("");
        try { if (await catalog.setAlias(workspaceId, worktreeId, alias.trim() || null)) { setPanel("actions"); setFeedback(alias.trim() ? "Alias saved." : "Alias cleared."); } }
        finally { setBusy(false); }
      }}>
        <label>Worktree alias<input autoFocus maxLength={80} value={alias} disabled={locked} placeholder={tree ? worktreeShort(tree) : label} onChange={event => setAlias(event.target.value)} /></label>
        <p className="muted">Leave empty to use the branch name.</p>
        <div className="dialog-actions"><button type="button" disabled={busy} onClick={() => { setFeedback(""); setPanel("actions"); }}>Back</button><button type="submit" disabled={locked || alias.trim() === (tree?.alias ?? "")}>{busy ? "Saving…" : "Save alias"}</button></div>
      </form> : <div className="open-directory">
        <p>Delete <strong>{tree ? worktreeDisplay(tree) : label}</strong> and its checkout directory? Recorded conversations are kept.</p>
        {force && <p className="notice error" role="alert">This worktree contains uncommitted files. Force delete permanently discards them.</p>}
        <div className="dialog-actions"><button type="button" disabled={busy} onClick={() => { setFeedback(""); setForce(false); setPanel("actions"); }}>Cancel</button><button type="button" className="worktree-delete-action" disabled={locked || !removable} onClick={async () => {
          if (locked || !removable) return;
          setBusy(true); setFeedback("");
          try {
            const result = await catalog.removeWorktree(workspaceId, worktreeId, force);
            if (result.ok) setPanel(null);
            else { setFeedback(result.error); if (result.code === "worktree-dirty") setForce(true); }
          } finally { setBusy(false); }
        }}>{busy ? "Deleting…" : force ? "Force delete worktree" : "Delete worktree"}</button></div>
      </div>}
      {feedback && <p className="context-feedback" role="status">{feedback}</p>}
      {repository.error && <p className="notice error" role="alert">{repository.error}</p>}
    </ShellDialog>, document.body)}
  </>;
}
