import { useEffect, useRef, useState, type RefObject } from "react";
import { FiChevronDown, FiChevronUp, FiSearch, FiX } from "react-icons/fi";
import { store, type State } from "./store";
import "./session-search.css";

// Paint ranges without changing React-owned markdown/code DOM.
type HighlightRegistry = Map<string, unknown>;
const highlights = () => (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
function paint(name: string, ranges: Range[]) {
  const Highlight = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (Highlight) highlights()?.set(name, new Highlight(...ranges));
}

export function SessionSearch({ root, active, state }: { root: RefObject<HTMLDivElement | null>; active: boolean; state: State }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState("");
  const [caps, setCaps] = useState(false), [regex, setRegex] = useState(false);
  const [ranges, setRanges] = useState<Range[]>([]), [index, setIndex] = useState(0), [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null), previousFocus = useRef<HTMLElement | null>(null);
  const close = () => { setOpen(false); previousFocus.current?.focus({ preventScroll: true }); };
  useEffect(() => { setOpen(false); setQuery(""); }, [state.selected]);
  useEffect(() => {
    if (!active) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && open && !event.defaultPrevented && !(event.target as HTMLElement).closest('[role="dialog"]')) {
        event.preventDefault(); close(); return;
      }
      if (event.key.toLowerCase() === "f" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && !(event.target as HTMLElement).closest('[role="dialog"]')) {
        event.preventDefault();
        if (!open) previousFocus.current = document.activeElement as HTMLElement;
        setOpen(true); input.current?.focus(); input.current?.select();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [active, open]);
  useEffect(() => { if (open && active) { input.current?.focus(); input.current?.select(); } }, [open, active]);

  // Fill retained history while searching, including gaps between loaded islands.
  const edge = state.transcript?.islands.flatMap(island => (["older", "newer"] as const).filter(direction => !!island.coverage[direction === "older" ? "olderCursor" : "newerCursor"]).map(direction => ({ island: island.key, direction })))[0];
  const pageError = edge && state.pageErrors?.[`${edge.island}:${edge.direction}`];
  useEffect(() => {
    if (open && active && query && edge && !state.pageBusy && !pageError && !state.loading && state.connected) void store.loadTranscriptPage(edge);
  }, [open, active, query, edge?.island, edge?.direction, state.transcript, state.pageBusy, pageError, state.loading, state.connected]);

  useEffect(() => {
    if (!open || !active || !root.current) return;
    let timer: ReturnType<typeof setTimeout>;
    const scan = () => {
      const found: Range[] = [];
      let pattern: RegExp;
      try { pattern = new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caps ? "g" : "gi"); setError(""); }
      catch { setError("Invalid regex"); setRanges([]); return; }
      if (query) for (const block of root.current!.querySelectorAll<HTMLElement>(".transcript p, .transcript pre, .transcript li, .transcript h1, .transcript h2, .transcript h3, .transcript h4, .transcript td, .transcript th")) {
        if (!block.getClientRects().length || block.querySelector("p, pre, li")) continue;
        const nodes: { node: Text; start: number; end: number }[] = [];
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        let text = "", node: Node | null;
        while ((node = walker.nextNode())) {
          if (node.parentElement?.closest("button, [hidden], [aria-hidden=true]")) continue;
          const start = text.length; text += node.textContent; nodes.push({ node: node as Text, start, end: text.length });
        }
        pattern.lastIndex = 0;
        for (const match of text.matchAll(pattern)) {
          if (!match[0].length) continue;
          const start = nodes.find(n => n.end > match.index!), end = nodes.find(n => n.end >= match.index! + match[0].length);
          if (!start || !end) continue;
          const range = document.createRange(); range.setStart(start.node, match.index! - start.start); range.setEnd(end.node, match.index! + match[0].length - end.start); found.push(range);
        }
      }
      setRanges(found); setIndex(current => Math.min(current, Math.max(0, found.length - 1)));
    };
    scan();
    const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(scan, 100); });
    observer.observe(root.current, { subtree: true, childList: true, characterData: true });
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [open, active, query, caps, regex, root]);
  useEffect(() => { setIndex(0); }, [query, caps, regex]);
  useEffect(() => {
    if (!open || !active) return;
    paint("session-matches", ranges);
    const range = ranges[index];
    paint("session-current", range ? [range] : []);
    if (range) root.current?.closest(".viewport")?.dispatchEvent(new CustomEvent("session-search-jump", { detail: range }));
    return () => { highlights()?.delete("session-matches"); highlights()?.delete("session-current"); };
  }, [open, active, ranges, index]);
  if (!open || !active) return null;
  const move = (delta: number) => setIndex(current => ranges.length ? (current + delta + ranges.length) % ranges.length : 0);
  return <div className="session-search" role="search" aria-label="Search in session" onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === "Enter") { event.preventDefault(); move(event.shiftKey ? -1 : 1); }
  }}>
    <FiSearch size={14} aria-hidden="true" />
    <input ref={input} aria-label="Search in session" placeholder="Search in session…" value={query} aria-invalid={!!error} onChange={event => setQuery(event.target.value)} />
    <button type="button" title="Match case" aria-label="Match case" aria-pressed={caps} onClick={() => setCaps(!caps)}>Aa</button>
    <button type="button" title="Use regular expression" aria-label="Use regular expression" aria-pressed={regex} onClick={() => setRegex(!regex)}>.*</button>
    <span className="session-search-count" role="status" title={pageError || undefined}>{error || (query ? `${ranges.length ? index + 1 : 0}/${ranges.length}${pageError ? " · incomplete" : edge || state.pageBusy ? " · loading" : ""}` : "")}</span>
    <button type="button" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={!ranges.length} onClick={() => move(-1)}><FiChevronUp /></button>
    <button type="button" aria-label="Next match" title="Next match (Enter)" disabled={!ranges.length} onClick={() => move(1)}><FiChevronDown /></button>
    <button type="button" aria-label="Close search" title="Close (Escape)" onClick={close}><FiX /></button>
  </div>;
}
