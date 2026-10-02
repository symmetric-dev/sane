import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiCheck, FiMoreHorizontal, FiPause, FiX } from "react-icons/fi";
import { store } from "./store";
import { assignmentClass, assignmentLabel } from "./assignment-semantics";

/** Accent-tinted pill matching .harness-badge sizing; full `id · phases` in the tooltip. */
export function WorkstreamBadge({ workstreamId, phases }: { workstreamId: string; phases: string[] }) {
  const full = phases.length ? `${workstreamId} · ${phases.join(", ")}` : workstreamId;
  return <span className="harness-badge workstream-badge" title={full}>{workstreamId}</span>;
}

/** Active assignment presentation is canonical; tooltip retains stored evidence. */
export function PhaseBadge({ phase }: { phase: string }) {
  return <span className={`harness-badge phase-badge ${assignmentClass(phase)}`.trim()} title={`Assignment · ${phase}`}>{assignmentLabel(phase)}</span>;
}

/** Status icon replacing the running/completed text; full state in the tooltip. */
export function StatusIcon({ status }: { status: string }) {
  if (status === "running") return <span className="pulse status-icon" title="Running" role="img" aria-label="Running" />;
  if (status === "completed") return <span className="status-icon status-completed" title="Completed" role="img" aria-label="Completed"><FiCheck size={12} aria-hidden="true" /></span>;
  if (status === "failed") return <span className="status-icon status-failed" title="Failed" role="img" aria-label="Failed"><FiX size={12} aria-hidden="true" /></span>;
  if (status === "interrupted") return <span className="status-icon status-muted" title="Interrupted" role="img" aria-label="Interrupted"><FiPause size={12} aria-hidden="true" /></span>;
  return <span className="status-icon status-unknown" title="Status unavailable" role="img" aria-label="Status unavailable" />;
}

/** Ghost 3-dots button; dropdown portals to body so list clipping/stacking can't bury it. */
export function ConversationMenu({ conversationId, hidden, disabled }: { conversationId: string; hidden?: boolean; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ bottom: number; right: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const toggle = () => {
    if (open) { setOpen(false); return; }
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({ bottom: window.innerHeight - rect.top + 4, right: window.innerWidth - rect.right });
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); }
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !menu.current?.contains(target)) setOpen(false);
    };
    const onScroll = () => setOpen(false);
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
  }, [open ]);
  const label = hidden ? "Unhide" : "Hide";
  return <div className="history-menu">
    <button ref={trigger} type="button" className="history-menu-button" aria-label="Conversation actions" aria-haspopup="menu" aria-expanded={open} title="Conversation actions" disabled={disabled} onClick={toggle}><FiMoreHorizontal size={15} aria-hidden="true" /></button>
    {open && pos && createPortal(<div ref={menu} className="history-menu-dropdown history-menu-floating" role="menu" style={{ bottom: pos.bottom, right: pos.right }}><button type="button" role="menuitem" disabled={disabled} title={hidden ? "Restore this conversation to the sidebar" : "Hide this conversation from the sidebar (history is kept)"} onClick={() => { setOpen(false); void (hidden ? store.unhide(conversationId) : store.hide(conversationId)); }}>{label}</button></div>, document.body)}
  </div>;
}
