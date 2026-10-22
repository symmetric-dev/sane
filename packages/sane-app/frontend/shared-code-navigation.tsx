import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { FiChevronLeft, FiChevronRight } from "react-icons/fi";
import type { CodeShareSnapshot } from "../shared/code-share-contract";
import { codeShareSnippetPresentation } from "./code-share-presentation";

type Entry = { index: number; title: string; tooltip: string };

/** A native popover stays above clipped cards and inside a modal's focus scope. */
function SnippetOverflow({ entries, side, select }: { entries: Entry[]; side: "before" | "after"; select: (index: number) => void }) {
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const last = useRef(false);
  const dismiss = useCallback((restore = false) => { setOpen(false); if (restore) trigger.current?.focus({ preventScroll: true }); }, []);
  useLayoutEffect(() => {
    if (!open) return;
    const element = panel.current!, anchor = trigger.current!;
    let native = false;
    try { if (typeof element.showPopover === "function") { element.showPopover(); native = true; } } catch { /* Retain a local fallback on older browsers. */ }
    if (!native) element.removeAttribute("popover");
    const position = () => {
      const rect = anchor.getBoundingClientRect(), viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
      if (!anchor.isConnected || !anchor.getClientRects().length || rect.bottom <= top || rect.top >= top + height) { dismiss(); return; }
      const above = rect.top - top - 12, below = top + height - rect.bottom - 12, upwards = above >= below;
      element.style.width = `${Math.max(0, Math.min(360, width - 16))}px`;
      element.style.maxHeight = `${Math.max(40, Math.min(280, upwards ? above : below))}px`;
      const bounds = element.getBoundingClientRect();
      element.style.left = `${Math.max(left + 8, Math.min(rect.left, left + width - bounds.width - 8))}px`;
      element.style.top = `${Math.max(top + 8, upwards ? rect.top - bounds.height - 4 : rect.bottom + 4)}px`;
    };
    position();
    const buttons = element.querySelectorAll<HTMLButtonElement>("button");
    (last.current ? buttons[buttons.length - 1] : buttons[0])?.focus({ preventScroll: true });
    const outside = (event: Event) => { if (event.target instanceof Node && !element.contains(event.target) && !anchor.contains(event.target)) dismiss(); };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(true); }
    };
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !element.contains(event.target)) position(); };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", scroll, true);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", scroll, true);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
      try { if (native) element.hidePopover(); } catch { /* The card may already be unmounted. */ }
      if (!native) element.setAttribute("popover", "manual");
    };
  }, [open, dismiss]);
  const label = `${entries.length} more ${entries.length === 1 ? "snippet" : "snippets"} ${side === "before" ? "before" : "after"} the visible tabs`;
  return <>
    <button ref={trigger} type="button" className={`shared-code-overflow shared-code-overflow-${side}`} title={label} aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={id} onClick={() => { last.current = false; setOpen(!open); }} onKeyDown={event => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); last.current = event.key === "ArrowUp"; setOpen(true); }
    }}>+{entries.length}</button>
    <div ref={panel} id={id} popover="manual" className="shared-code-overflow-menu" data-open={open ? "true" : "false"} role="menu" aria-label={label} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null) && event.relatedTarget !== trigger.current) dismiss();
    }} onKeyDown={event => {
      if (event.key === "Tab") { dismiss(true); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")], current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length;
      buttons[next]?.focus();
    }}>{open && entries.map(entry => <button key={entry.index} type="button" role="menuitem" tabIndex={-1} title={entry.tooltip} onClick={() => { dismiss(); select(entry.index); }}><span className="shared-code-menu-index">{entry.index + 1}</span><span>{entry.title}</span></button>)}</div>
  </>;
}

export function SharedCodeNavigation({ snippets, page, select, viewId }: { snippets: readonly CodeShareSnapshot[]; page: number; select: (index: number) => void; viewId: string }) {
  const tabs = useRef<HTMLDivElement>(null), focusSelected = useRef(false);
  const count = snippets.length, start = Math.max(0, Math.min(page - 1, count - 3)), end = Math.min(count, start + 3);
  const entries = snippets.map((snippet, index) => { const { tabTitle, tooltip } = codeShareSnippetPresentation(snippet); return { index, title: tabTitle, tooltip }; });
  const focusTab = () => tabs.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus({ preventScroll: true });
  const choose = (index: number) => {
    if (index === page) { focusTab(); return; }
    focusSelected.current = true; select(index);
  };
  useLayoutEffect(() => { if (focusSelected.current) { focusSelected.current = false; focusTab(); } }, [page]);
  return <nav className="shared-code-pagination" aria-label="Code snippet navigation">
    <button type="button" className="shared-code-page-button shared-code-previous" aria-label="Previous snippet" title="Previous snippet" disabled={page === 0} onClick={() => choose(page - 1)}><FiChevronLeft aria-hidden="true" /></button>
    {start > 0 && <SnippetOverflow key={`before-${start}`} entries={entries.slice(0, start)} side="before" select={choose} />}
    <div ref={tabs} className="shared-code-tabs" role="tablist" aria-label="Code snippets" onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      choose(event.key === "Home" ? 0 : event.key === "End" ? count - 1 : (page + (event.key === "ArrowRight" ? 1 : count - 1)) % count);
    }}>{entries.slice(start, end).map(entry => <button key={entry.index} type="button" className="shared-code-tab" role="tab" id={`${viewId}-tab-${entry.index}`} aria-selected={page === entry.index} aria-posinset={entry.index + 1} aria-setsize={count} aria-controls={`${viewId}-panel`} aria-label={entry.tooltip} tabIndex={page === entry.index ? 0 : -1} title={entry.tooltip} onClick={() => choose(entry.index)}><span>{entry.title}</span></button>)}</div>
    {end < count && <SnippetOverflow key={`after-${end}`} entries={entries.slice(end)} side="after" select={choose} />}
    <button type="button" className="shared-code-page-button shared-code-next" aria-label="Next snippet" title="Next snippet" disabled={page === count - 1} onClick={() => choose(page + 1)}><FiChevronRight aria-hidden="true" /></button>
    <span className="shared-code-count" role="status" aria-live="polite" aria-atomic="true"><span className="sr-only">Snippet </span>{page + 1}<span aria-hidden="true">/</span><span className="sr-only"> of </span>{count}</span>
  </nav>;
}
