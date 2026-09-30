import { useEffect, useId, useRef, type ReactNode } from "react";

/** Native modal containment supplies keyboard focus trapping and Escape handling. */
export function ShellDialog({ title, close, children, className = "", restoreFocus }: { title: string; close: () => void; children: ReactNode; className?: string; restoreFocus?: () => HTMLElement | null }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = ref.current!;
    dialog.showModal();
    return () => { dialog.close(); const target = restoreFocus?.() ?? previous; if (target?.isConnected) target.focus(); };
  }, []);
  return <dialog ref={ref} className={`shell-dialog ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="shell-dialog-content"><header><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" aria-label={`Close ${title.toLowerCase()}`} onClick={close}>×</button></header>{children}</div>
  </dialog>;
}
