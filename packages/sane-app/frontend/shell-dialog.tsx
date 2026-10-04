import { useEffect, useId, useRef, type ReactNode } from "react";

/** Native modal containment supplies focus trapping and Escape handling.
 * Bare layouts provide their own close button; title remains the accessible name. */
export function ShellDialog({ title, subtitle, close, children, className = "", restoreFocus, closeDisabled = false, bare = false }: { title: string; subtitle?: string; close: () => void; children: ReactNode; className?: string; restoreFocus?: () => HTMLElement | null; closeDisabled?: boolean; bare?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const subtitleId = useId();
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = ref.current!;
    dialog.showModal();
    return () => { dialog.close(); const target = restoreFocus?.() ?? previous; if (target?.isConnected) target.focus(); };
  }, []);
  return <dialog ref={ref} className={`shell-dialog ${className}`} role="dialog" aria-modal="true" aria-label={bare ? title : undefined} aria-labelledby={bare ? undefined : titleId} aria-describedby={!bare && subtitle !== undefined ? subtitleId : undefined} onCancel={event => { event.preventDefault(); if (!closeDisabled) close(); }} onClick={event => { if (event.target === event.currentTarget && !closeDisabled) close(); }}>
    {bare ? children : <div className="shell-dialog-content"><header>{subtitle !== undefined ? <div className="shell-dialog-heading"><h2 id={titleId}>{title}</h2><p id={subtitleId} className="shell-dialog-subtitle">{subtitle}</p></div> : <h2 id={titleId}>{title}</h2>}<button type="button" className="icon-button" disabled={closeDisabled} aria-label={`Close ${title.toLowerCase()}`} onClick={close}>×</button></header>{children}</div>}
  </dialog>;
}
