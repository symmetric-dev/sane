import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { FiCheckCircle, FiPauseCircle, FiX, FiXCircle } from "react-icons/fi";
import { catalog } from "./catalog";
import { notificationStore } from "./notifications";
import { PenroseTriangle } from "./penrose-triangle";
import { store, useShellState } from "./store";
import "./notification-center.css";

// Share opening ownership, not notification state, across shell/drawer triggers.
let activeCenter: { id: string; dismiss: (restore?: boolean) => void } | null = null;

function timestamp(time: string | number) {
  return new Date(time).getTime();
}

function timeLabel(time: string | number) {
  const date = new Date(time), value = date.getTime();
  if (!Number.isFinite(value)) return { label: "Time unavailable", iso: undefined };
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  const label = seconds < 60 ? "Just now" : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h ago` : `${Math.floor(seconds / 86400)}d ago`;
  return { label, iso: date.toISOString() };
}

function navigateButtons(event: KeyboardEvent<HTMLElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  if (!buttons.length) return;
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowDown" ? (index + 1) % buttons.length : event.key === "ArrowUp" ? (index - 1 + buttons.length) % buttons.length : -1;
  if (next < 0) return;
  event.preventDefault(); event.stopPropagation(); buttons[next]?.focus();
}

export function NotificationCenter({ onOpen, className = "", size = 28 }: {
  onOpen: (id: string) => boolean; className?: string; size?: number;
}) {
  const panelId = useId(), headingId = `${panelId}-heading`;
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [notice, setNotice] = useState("");
  const notifications = useSyncExternalStore(notificationStore.subscribe, notificationStore.snapshot);
  const catalogState = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const state = useShellState();
  const available = state.phase === "ready" && state.conversationsReady;
  const items = useMemo(() => [...notifications.items].sort((a, b) => (timestamp(b.time) || 0) - (timestamp(a.time) || 0)), [notifications.items]);
  const unread = notifications.unreadCount;
  const dismiss = useCallback((restore = true) => {
    const element = panel.current;
    if (element) {
      element.dataset.open = "false";
      try { element.hidePopover?.(); } catch { /* Already closed or unsupported. */ }
    }
    if (activeCenter?.id === panelId) activeCenter = null;
    setOpen(false);
    if (restore && trigger.current?.isConnected && trigger.current.getClientRects().length) trigger.current.focus({ preventScroll: true });
  }, [panelId]);
  const show = () => {
    if (!available) return;
    activeCenter?.dismiss(false);
    activeCenter = { id: panelId, dismiss };
    setNotice(""); setOpen(true);
  };

  useLayoutEffect(() => {
    if (!open) return;
    if (!available) { dismiss(false); return; }
    if (activeCenter?.id !== panelId) activeCenter?.dismiss(false);
    activeCenter = { id: panelId, dismiss };
    const element = panel.current!, anchor = trigger.current!;
    element.dataset.open = "true";
    let native = false;
    try {
      if (typeof element.showPopover === "function") { element.showPopover(); native = true; }
    } catch { /* Older browsers or an unavailable top layer use the local fallback. */ }
    if (!native) { element.removeAttribute("popover"); element.dataset.fallback = "true"; }

    const position = () => {
      const rect = anchor.getBoundingClientRect(), viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
      if (!anchor.isConnected || !anchor.getClientRects().length || !rect.width || !rect.height || getComputedStyle(anchor).visibility !== "visible" || anchor.closest("[inert], [hidden]") || rect.bottom <= top || rect.top >= top + height || rect.right <= left || rect.left >= left + width) {
        dismiss(false); return false;
      }
      const margin = 12, panelWidth = Math.max(0, Math.min(360, width - margin * 2));
      // Always descend from the anchor; never turn a header popup into an upward menu.
      const panelTop = Math.max(top + margin, rect.bottom + 6);
      const panelHeight = Math.max(0, Math.min(420, top + height - margin - panelTop));
      if (panelHeight < 80 || panelWidth < 80) { dismiss(false); return false; }
      element.style.width = `${panelWidth}px`;
      element.style.maxHeight = `${panelHeight}px`;
      element.style.left = `${Math.max(left + margin, Math.min(rect.left, left + width - panelWidth - margin))}px`;
      element.style.top = `${panelTop}px`;
      return true;
    };
    if (position()) element.querySelector<HTMLButtonElement>(".notification-center-close")?.focus({ preventScroll: true });
    const outside = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      // Modal focus recovery can focus a containing ancestor; that isn't an exit.
      if (event.type === "focusin" && target.contains(element)) return;
      if (!element.contains(target) && !anchor.contains(target)) dismiss(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); dismiss();
    };
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !element.contains(event.target)) position(); };
    const visibility = () => { if (document.hidden) dismiss(false); };
    const toggle = (event: Event) => { if ((event as Event & { newState?: string }).newState === "closed") dismiss(false); };
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(position);
    resizeObserver?.observe(anchor);
    // Drawer closure, breakpoint classes, or inertness can hide an unchanged-size anchor.
    const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(position);
    for (let parent: HTMLElement | null = anchor; parent; parent = parent.parentElement) {
      observer?.observe(parent, { attributes: true, attributeFilter: ["class", "style", "hidden", "inert", "open"] });
    }
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape, true);
    document.addEventListener("visibilitychange", visibility);
    element.addEventListener("toggle", toggle);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", scroll, true);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape, true);
      document.removeEventListener("visibilitychange", visibility);
      element.removeEventListener("toggle", toggle);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", scroll, true);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
      resizeObserver?.disconnect(); observer?.disconnect();
      element.dataset.open = "false";
      try { if (native) element.hidePopover(); } catch { /* May already be closed. */ }
      if (!native) { element.setAttribute("popover", "manual"); delete element.dataset.fallback; }
      if (activeCenter?.id === panelId) activeCenter = null;
    };
  }, [open, available, dismiss, panelId]);

  const choose = (conversationId: string) => {
    const current = store.snapshot();
    if (current.phase !== "ready" || !current.conversationsReady || current.sending || !current.conversations.some(item => item.id === conversationId)) {
      setNotice("This session cannot be opened right now."); return;
    }
    if (!onOpen(conversationId)) { setNotice("This session cannot be opened right now."); return; }
    notificationStore.markRead(conversationId);
    // Keep focus on the destination selected by the shell, not the old drawer trigger.
    dismiss(false);
  };

  return <>
    <button ref={trigger} type="button" className={`notification-center-trigger ${className}`} disabled={!available} data-unread={unread > 0 ? "true" : undefined} aria-label={`SANE notifications, ${unread} unread ${unread === 1 ? "session" : "sessions"}`} title={`Notifications · ${unread} unread`} aria-haspopup="dialog" aria-expanded={open} aria-controls={panelId} onClick={() => open ? dismiss() : show()} onKeyDown={event => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if (!open) show(); }
    }}>
      <PenroseTriangle size={size} />
      {unread > 0 && <span className="notification-center-badge" aria-hidden="true">{unread > 99 ? "99+" : unread}</span>}
    </button>
    <div ref={panel} id={panelId} popover="manual" role="dialog" aria-modal="false" aria-labelledby={headingId} className="notification-center-popover" data-open={open ? "true" : "false"} onKeyDown={navigateButtons}>
      {open && <>
        <div className="notification-center-header">
          <div><h2 id={headingId}>Notifications</h2><p>{unread} unread {unread === 1 ? "session" : "sessions"}</p></div>
          <button type="button" className="notification-center-close" aria-label="Close notifications" onClick={() => dismiss()}><FiX aria-hidden="true" /></button>
        </div>
        {notifications.storageError && <p className="notification-center-notice" role="status">{notifications.storageError}</p>}
        {state.sending && <p className="notification-center-notice">Session navigation is unavailable while sending.</p>}
        {notice && <p className="notification-center-notice" role="status">{notice}</p>}
        <div className="notification-center-list">
          {items.length ? <ul>{items.map(item => {
            const workspace = catalogState.workspaces.find(workspace => workspace.workspaceId === item.workspaceId);
            const worktree = workspace?.worktrees.find(worktree => worktree.worktreeId === item.worktreeId);
            const location = [workspace?.name || item.workspaceId, worktree?.alias || worktree?.branch].filter(Boolean).join(" · ") || "Unassociated workspace";
            const valid = state.conversations.some(conversation => conversation.id === item.conversationId);
            const disabled = state.sending || !valid;
            const time = timeLabel(item.time);
            const outcome = item.status === "completed" ? "Completed" : item.status === "failed" ? "Failed" : "Interrupted";
            const Icon = item.status === "completed" ? FiCheckCircle : item.status === "failed" ? FiXCircle : FiPauseCircle;
            return <li key={item.id}>
              <button type="button" className="notification-center-entry" disabled={disabled} onClick={() => choose(item.conversationId)}>
                <Icon aria-hidden="true" />
                <span className="notification-center-label">
                  <span className="notification-center-title">{item.title || "Untitled session"}</span>
                  <span className="notification-center-location" title={location}>{location}</span>
                  <span className="notification-center-outcome">{outcome}<span aria-hidden="true"> · </span><time dateTime={time.iso} title={time.iso}>{time.label}</time></span>
                  {!valid && <span className="notification-center-unavailable">Session unavailable</span>}
                </span>
              </button>
            </li>;
          })}</ul> : <p className="notification-center-empty">No session notifications yet.</p>}
        </div>
      </>}
    </div>
  </>;
}
