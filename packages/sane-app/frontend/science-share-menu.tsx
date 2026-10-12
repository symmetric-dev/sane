import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiShare2 } from "react-icons/fi";
import type { ScienceShareRepresentation } from "../shared/science-chat-contract";
import "./science-share-menu.css";

export function ScienceShareMenu({ disabled, sourceAvailable, outputAvailable, bothAvailable, share }: {
  disabled: boolean;
  sourceAvailable: boolean;
  outputAvailable: boolean;
  bothAvailable: boolean;
  share: (representation: ScienceShareRepresentation) => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const last = useRef(false);
  const blocked = disabled || !sourceAvailable && !outputAvailable && !bothAvailable;
  const visible = open && !blocked;
  const close = (restore = false) => { setOpen(false); if (restore) trigger.current?.focus({ preventScroll: true }); };
  useEffect(() => { if (blocked) setOpen(false); }, [blocked]);
  useLayoutEffect(() => {
    if (!visible || !trigger.current || !panel.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const bounds = panel.current.getBoundingClientRect();
    const top = anchor.bottom + 4 + bounds.height <= window.innerHeight - 8 ? anchor.bottom + 4 : anchor.top - bounds.height - 4;
    setPosition({ top: Math.max(8, top), left: Math.max(8, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 8)) });
    const buttons = panel.current.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
    (last.current ? buttons[buttons.length - 1] : buttons[0])?.focus({ preventScroll: true });
  }, [visible]);
  useEffect(() => {
    if (!visible) return;
    const pointer = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close();
    };
    const scroll = (event: Event) => { if (!panel.current?.contains(event.target as Node)) close(); };
    const resize = () => close();
    document.addEventListener("pointerdown", pointer);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", pointer);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", resize);
    };
  }, [visible]);
  const options = [
    { value: "source", label: "Share Source", available: sourceAvailable },
    { value: "observed-text", label: "Share Output", available: outputAvailable },
    { value: "source-and-observed-text", label: "Share Both", available: bothAvailable },
  ] as const;
  return <>
    <button ref={trigger} type="button" title="Share Python cell" disabled={blocked} aria-haspopup="menu" aria-expanded={visible} aria-controls={visible ? id : undefined} onClick={() => { last.current = false; setOpen(!open); }} onKeyDown={event => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); last.current = event.key === "ArrowUp"; setOpen(true); }
    }}><FiShare2 aria-hidden="true" />Share</button>
    {visible && createPortal(<div ref={panel} id={id} className="science-share-menu" role="menu" aria-label="Share Python cell" style={position} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null) && event.relatedTarget !== trigger.current) close(); }} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
      if (event.key === "Tab") { close(true); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length;
      buttons[next]?.focus();
    }}>{options.map(option => <button key={option.value} type="button" role="menuitem" disabled={!option.available} onClick={() => { close(true); share(option.value); }}>{option.label}</button>)}</div>, document.body)}
  </>;
}
