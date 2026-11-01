import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { FiX } from "react-icons/fi";
import { ChatIconButton, ChatMetadata } from "./chat-ui";

/** Shared anchored desktop panel/mobile sheet. Mount only while open. */
export function ComposerPanel({ id, title, summary, trigger, close, actions, children, footer, restoreFocus, initialFocus, className = "" }: {
  id: string;
  title: string;
  summary?: ReactNode;
  trigger: RefObject<HTMLButtonElement | null>;
  close: () => void;
  actions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  restoreFocus?: () => HTMLElement | null;
  initialFocus?: () => HTMLElement | null;
  className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  // Callbacks can change as the caller selects a navigation destination without
  // closing and reopening the native modal on each render.
  const focus = useRef({ restoreFocus, initialFocus, trigger });
  focus.current = { restoreFocus, initialFocus, trigger };
  useEffect(() => {
    const element = dialog.current!;
    const position = () => {
      const rect = focus.current.trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(460, window.innerWidth - 32);
      element.style.setProperty("--workers-right", `${Math.max(16, Math.min(window.innerWidth - rect.right, window.innerWidth - width - 16))}px`);
      element.style.setProperty("--workers-bottom", `${window.innerHeight - rect.top + 10}px`);
      element.style.setProperty("--workers-height", `${Math.max(160, rect.top - 26)}px`);
    };
    position();
    const initial = focus.current.initialFocus?.();
    const autofocus = initial?.hasAttribute("autofocus");
    initial?.setAttribute("autofocus", "");
    element.showModal();
    initial?.focus();
    if (initial && !autofocus) initial.removeAttribute("autofocus");
    window.addEventListener("resize", position);
    return () => {
      window.removeEventListener("resize", position);
      element.close();
      // A disconnected destination intentionally suppresses restoration when
      // navigation will establish focus elsewhere.
      const target = focus.current.restoreFocus ? focus.current.restoreFocus() : focus.current.trigger.current;
      if (target?.isConnected) target.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(<dialog ref={dialog} id={id} className={`workers-panel ${className}`.trim()} aria-modal="true" aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}><div className="workers-panel-content">
    <header className="workers-panel-header"><div><h2 id={`${id}-title`}>{title}</h2>{summary !== undefined && <ChatMetadata>{summary}</ChatMetadata>}</div><ChatIconButton aria-label={`Close ${title.toLowerCase()}`} onClick={close}><FiX size={18} /></ChatIconButton></header>
    {actions != null && <div className="workers-panel-actions">{actions}</div>}
    <div className="workers-panel-body">{children}</div>
    {footer != null && <footer className="workers-panel-footer">{footer}</footer>}
  </div></dialog>, document.body);
}
