import { useEffect, useRef, type ReactNode, type Ref } from "react";
import { FiArrowLeft, FiLogOut } from "react-icons/fi";
import "./flow-navigation.css";

export function FlowNavigation({ back, exit, escape, escapeRegion, disabled, backLabel = "Back to Flows", backRef, exitRef, children }: {
  back?: () => void;
  exit: () => void;
  escape?: () => void;
  escapeRegion?: string;
  disabled?: boolean;
  backLabel?: string;
  backRef?: Ref<HTMLButtonElement>;
  exitRef?: Ref<HTMLButtonElement>;
  children?: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (disabled || event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || event.key !== "Escape" || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const target = event.target instanceof Element ? event.target : null;
      const region = root.current?.closest(".workstream-status-composer, .document-review-composer");
      if (!target || !region || target.closest("[hidden], [inert]") || region.closest("[hidden], [inert]")) return;
      const related = escapeRegion && target.closest(escapeRegion) && target.closest(".chat-surface") === region.closest(".chat-surface");
      if (!region.contains(target) && !related) return;
      // Native selects own Escape. Modals and expanded controls always get
      // first refusal, even if their dismissal happens later in this event.
      if (target.closest('select, [aria-expanded="true"][role="combobox"]') || document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
      event.preventDefault(); event.stopPropagation();
      (escape ?? exit)();
    };
    // Bubble after React and editor handlers: a consumed Escape cannot also exit.
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [disabled, escape, escapeRegion, exit]);
  return <div ref={root} className="flow-navigation">
    {children}
    {back && <button ref={backRef} type="button" className="text-button" disabled={disabled} onClick={back} title={backLabel} aria-label={backLabel}><FiArrowLeft size={15} aria-hidden="true" />Back</button>}
    <button ref={exitRef} type="button" className="text-button flow-exit" disabled={disabled} onClick={exit} title="Exit to chat" aria-label="Exit to chat"><FiLogOut size={15} aria-hidden="true" /></button>
  </div>;
}
