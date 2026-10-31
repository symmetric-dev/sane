import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { FiMoreHorizontal } from "react-icons/fi";
import { ChatButton, ChatIconButton } from "./chat-controls";
import "./chat-overflow-menu.css";

export type ChatMenuItem = { id: string; separator: true } | {
  id: string; label: string; icon?: ReactNode; disabled?: boolean; busy?: boolean;
  danger?: boolean; opensDialog?: boolean; title?: string; ariaLabel?: string;
  onSelect: (trigger: HTMLButtonElement) => void;
};

/** Domain-neutral presentation: callers own operations and their availability. */
export function ChatOverflowMenu({ label, attention = false, busy = false, busyLabel, items }: {
  label: string; attention?: boolean; busy?: boolean; busyLabel?: string; items: ChatMenuItem[];
}) {
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const last = useRef(false);
  const dismiss = useCallback((restore = false) => {
    setOpen(false);
    if (restore) trigger.current?.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => {
    const element = panel.current, anchor = trigger.current;
    if (!open || !element || !anchor) return;
    let native = false;
    try { if (typeof element.showPopover === "function") { element.showPopover(); native = true; } } catch { /* Local fallback for older browsers. */ }
    if (!native) element.removeAttribute("popover");
    const position = () => {
      const rect = anchor.getBoundingClientRect(), viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
      if (!anchor.isConnected || !anchor.getClientRects().length || rect.bottom <= top || rect.top >= top + height) { dismiss(); return; }
      const below = top + height - rect.bottom - 12, above = rect.top - top - 12;
      const upwards = below < 220 && above > below;
      element.style.width = `${Math.max(0, Math.min(220, width - 16))}px`;
      element.style.maxHeight = `${Math.max(40, upwards ? above : below)}px`;
      const bounds = element.getBoundingClientRect();
      element.style.left = `${Math.max(left + 8, Math.min(rect.right - bounds.width, left + width - bounds.width - 8))}px`;
      element.style.top = `${Math.max(top + 8, upwards ? rect.top - bounds.height - 4 : rect.bottom + 4)}px`;
    };
    position();
    const buttons = element.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
    (last.current ? buttons[buttons.length - 1] : buttons[0])?.focus({ preventScroll: true });
    const outside = (event: Event) => { if (event.target instanceof Node && !element.contains(event.target) && !anchor.contains(event.target)) dismiss(); };
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(true); }
    };
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !element.contains(event.target)) position(); };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", onEscape, true);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", scroll, true);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", onEscape, true);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", scroll, true);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
      try { if (native) element.hidePopover(); } catch { /* The card may already be unmounted. */ }
      if (!native) element.setAttribute("popover", "manual");
    };
  }, [open, dismiss]);
  return <>
    <ChatIconButton ref={trigger} className={attention ? "chat-menu-trigger has-issue" : "chat-menu-trigger"} busy={busy}
      aria-label={busy ? busyLabel ?? `${label}, busy` : attention ? `${label}, attention needed` : label}
      aria-haspopup="menu" aria-expanded={open} aria-controls={id}
      onClick={() => { last.current = false; setOpen(!open); }} onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); last.current = event.key === "ArrowUp"; setOpen(true); }
      }}><FiMoreHorizontal /></ChatIconButton>
    <div ref={panel} id={id} popover="manual" className="chat-overflow-menu" data-open={open ? "true" : "false"} role="menu" aria-label={label} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null) && event.relatedTarget !== trigger.current) dismiss();
    }} onKeyDown={event => {
      if (event.key === "Tab") { dismiss(true); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length;
      buttons[next]?.focus();
    }}>
      {open && items.map(item => "separator" in item ? <hr key={item.id} /> : <ChatButton key={item.id} variant={item.danger ? "danger" : "ghost"} role="menuitem" tabIndex={-1}
        icon={item.icon} disabled={item.disabled} busy={item.busy} title={item.title} aria-label={item.ariaLabel} aria-haspopup={item.opensDialog ? "dialog" : undefined}
        onClick={() => { dismiss(!item.opensDialog); if (trigger.current) item.onSelect(trigger.current); }}>{item.label}</ChatButton>)}
    </div>
  </>;
}
