import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiBook, FiCheck, FiClock, FiEdit2, FiEye, FiGlobe, FiMoreHorizontal, FiPause, FiRefreshCw, FiX } from "react-icons/fi";
import { workerStatusLabel } from "./worker-presentation";
import type { WorkerProtocolStatus } from "../src/worker-contract";
import { store, useStore } from "./store";
import { assignmentClass, assignmentLabel } from "./assignment-semantics";

/** Accent-tinted pill matching .harness-badge sizing; full `id · phases` in the tooltip. */
export function WorkstreamBadge({ workstreamId, phases }: { workstreamId: string; phases: string[] }) {
  const full = phases.length ? `${workstreamId} · ${phases.join(", ")}` : workstreamId;
  return <span className="harness-badge workstream-badge" title={full}>{workstreamId}</span>;
}

/** Lucide zodiac-aquarius; membership identity stays available without a text row. */
export function WorkstreamIcon({ workstreamId }: { workstreamId: string }) {
  const label = `Workstream · ${workstreamId}`;
  return <span className="conversation-sidebar-workstream-icon" title={label} role="img" aria-label={label}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m2 10 2.456-3.684a.7.7 0 0 1 1.106-.013l2.39 3.413a.7.7 0 0 0 1.096-.001l2.402-3.432a.7.7 0 0 1 1.098 0l2.402 3.432a.7.7 0 0 0 1.098 0l2.389-3.413a.7.7 0 0 1 1.106.013L22 10" />
      <path d="m2 18.002 2.456-3.684a.7.7 0 0 1 1.106-.013l2.39 3.413a.7.7 0 0 0 1.097 0l2.402-3.432a.7.7 0 0 1 1.098 0l2.402 3.432a.7.7 0 0 0 1.098 0l2.389-3.413a.7.7 0 0 1 1.106.013L22 18.002" />
    </svg>
  </span>;
}

/** Active assignment presentation is canonical; tooltip retains stored evidence. */
export function PhaseBadge({ phase }: { phase: string }) {
  return <span className={`harness-badge phase-badge ${assignmentClass(phase)}`.trim()} title={`Assignment · ${phase}`}>{assignmentLabel(phase)}</span>;
}

/** Status icon replacing the running/completed text; full state in the tooltip.
 * Protocol statuses come from the session-list projection, not a permission prompt. */
export function StatusIcon({ status, protocol }: { status: string; protocol?: WorkerProtocolStatus }) {
  if (protocol && protocol !== "running" && protocol !== "terminal") {
    const label = workerStatusLabel(protocol);
    return <span className={`status-icon${protocol === "uncertain" ? " status-unknown" : " status-muted"}`} title={label} role="img" aria-label={label}>{protocol === "idle" || protocol === "closing" ? <FiPause size={12} aria-hidden="true" /> : <FiClock size={12} aria-hidden="true" />}</span>;
  }
  if (protocol === "terminal") {
    const label = workerStatusLabel(protocol, status === "failed" || status === "interrupted" || status === "completed" ? status : undefined);
    if (status === "failed") return <span className="status-icon status-failed" title={label} role="img" aria-label={label}><FiX size={12} aria-hidden="true" /></span>;
    if (status === "interrupted") return <span className="status-icon status-muted" title={label} role="img" aria-label={label}><FiPause size={12} aria-hidden="true" /></span>;
    return <span className="status-icon status-completed" title={label} role="img" aria-label={label}><FiCheck size={12} aria-hidden="true" /></span>;
  }
  if (status === "running" || protocol === "running") return <span className="pulse status-icon" title="Running" role="img" aria-label="Running" />;
  if (status === "completed") return <span className="status-icon status-completed" title="Completed" role="img" aria-label="Completed"><FiCheck size={12} aria-hidden="true" /></span>;
  if (status === "failed") return <span className="status-icon status-failed" title="Failed" role="img" aria-label="Failed"><FiX size={12} aria-hidden="true" /></span>;
  if (status === "interrupted") return <span className="status-icon status-muted" title="Interrupted" role="img" aria-label="Interrupted"><FiPause size={12} aria-hidden="true" /></span>;
  return <span className="status-icon status-unknown" title="Status unavailable" role="img" aria-label="Status unavailable" />;
}

/** Escape list clipping while staying inside a native modal's interactive subtree. */
export function ConversationMenu({ conversationId, hidden, disabled, metadataDisabled = false, onHistory, onConnect, connectDisabled = false }: { conversationId: string; hidden?: boolean; disabled: boolean; metadataDisabled?: boolean; onHistory?: (id: string) => void; onConnect?: (id: string) => void; connectDisabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const titleBusy = useStore(state => !!state.sessionTitleRequests?.[conversationId]);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const toggle = () => {
    if (open) { setOpen(false); return; }
    setPos(null);
    setOpen(true);
  };
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const margin = 8;
    const gap = 4;
    const rect = trigger.current.getBoundingClientRect();
    const bounds = menu.current.getBoundingClientRect();
    const height = menu.current.scrollHeight + bounds.height - menu.current.clientHeight;
    const above = Math.max(0, rect.top - gap - margin);
    const below = Math.max(0, window.innerHeight - rect.bottom - gap - margin);
    const upwards = height <= above || height > below && above > below;
    const maxHeight = Math.min(height, upwards ? above : below);
    setPos({
      top: Math.max(margin, Math.min(upwards ? rect.top - gap - maxHeight : rect.bottom + gap, window.innerHeight - margin - maxHeight)),
      left: Math.max(margin, Math.min(rect.right - bounds.width, window.innerWidth - margin - bounds.width)),
      maxHeight,
    });
  }, [open, onHistory, onConnect]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); }
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !menu.current?.contains(target)) setOpen(false);
    };
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return;
      setOpen(false);
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
  }, [open ]);
  const label = hidden ? "Unhide" : "Hide";
  return <div className="history-menu">
    <button ref={trigger} type="button" className="history-menu-button" aria-label="Conversation actions" aria-haspopup="menu" aria-expanded={open} title="Conversation actions" disabled={disabled && metadataDisabled && !onHistory && (!onConnect || connectDisabled)} onClick={toggle}><FiMoreHorizontal size={15} aria-hidden="true" /></button>
    {open && createPortal(<div ref={menu} className="history-menu-dropdown history-menu-floating" role="menu" aria-label="Conversation actions" style={pos ?? { visibility: "hidden" }}>
      {onHistory && <button type="button" role="menuitem" title="Open history for this conversation" onClick={() => { setOpen(false); onHistory(conversationId); }}><FiBook size={15} aria-hidden="true" />History</button>}
      {onConnect && <button type="button" role="menuitem" aria-haspopup="dialog" disabled={connectDisabled} title={connectDisabled ? "Select a browser tab and an available conversation and workspace; wait for any submission to finish before pairing" : "Pair conversation with browser view"} onClick={() => { setOpen(false); onConnect(conversationId); }}><FiGlobe size={15} aria-hidden="true" />Browser Pair</button>}
      <button type="button" role="menuitem" disabled={metadataDisabled || titleBusy} onClick={() => { setOpen(false); store.openSessionNameDialog(conversationId, "rename", () => trigger.current); }}><FiEdit2 size={15} aria-hidden="true" />Rename…</button>
      <button type="button" role="menuitem" disabled={metadataDisabled || titleBusy} onClick={() => { setOpen(false); store.openSessionNameDialog(conversationId, "regenerate", () => trigger.current); }}><FiRefreshCw size={15} aria-hidden="true" />Regenerate name</button>
      <button type="button" role="menuitem" disabled={disabled} title={hidden ? "Restore this conversation to the sidebar" : "Hide this conversation from the sidebar (history is kept)"} onClick={() => { setOpen(false); void (hidden ? store.unhide(conversationId) : store.hide(conversationId)); }}><FiEye size={15} aria-hidden="true" />{label}</button>
    </div>, trigger.current?.closest("dialog") ?? document.body)}
  </div>;
}
