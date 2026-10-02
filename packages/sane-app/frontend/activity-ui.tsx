import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { FiChevronDown, FiChevronLeft } from "react-icons/fi";
import type { ActivityEntrance, ActivityEntry, ActivityGroup } from "./transcript-activity";
import { active } from "./types";
import { activityGlyph, ACTIVITY_ANIMATION_CYCLES, ACTIVITY_ANIMATION_MS, type ActivityGlyph } from "./activity-visuals";

const triangleFaces = [
  ["M2 20.66h4L14 6.8l-2-3.46Z", .12],
  ["m12 3.34-2 3.46 8 13.86h4Z", .3],
  ["m22 20.66-2-3.46H4l-2 3.46Z", .2],
] as const;

/** Cyclic overlaps make the impossible triangle using only flat SVG faces. */
function PenroseTriangle() {
  return <g strokeWidth="1">
    {triangleFaces.map(([path, shade]) => <g key={path}>
      <path d={path} fill="var(--background)" stroke="none" />
      <path d={path} fill="currentColor" fillOpacity={shade} />
    </g>)}
    <path d="M2 20.66h4l2-3.46H4Z" fill="var(--background)" stroke="none" />
    <path d="M2 20.66h4l2-3.46H4Z" fill="currentColor" fillOpacity=".12" stroke="none" />
    <path d="M4 17.2 2 20.66h4l2-3.46" />
  </g>;
}

function ActivityIcon({ glyph, entrance, owner }: { glyph: ActivityGlyph; entrance?: ActivityEntrance; owner: object }) {
  const [animation, setAnimation] = useState<{ delay: number } | null>(null);
  useLayoutEffect(() => {
    if (!entrance || entrance.claimed && entrance.owner !== owner) return;
    if (!entrance.claimed) { entrance.claimed = true; entrance.startedAt = performance.now(); entrance.owner = owner; }
    const elapsed = performance.now() - entrance.startedAt!;
    // Moving the tail into the tab strip continues the remaining animation;
    // remounting the sequence has a different owner and cannot replay it.
    if (elapsed < ACTIVITY_ANIMATION_MS[glyph] * ACTIVITY_ANIMATION_CYCLES) setAnimation({ delay: -elapsed });
  }, [entrance, owner, glyph]);
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    className={`activity-icon activity-${glyph}${animation ? " activity-arriving" : ""}`} style={animation ? { animationDelay: `${animation.delay}ms`, "--activity-animation-duration": `${ACTIVITY_ANIMATION_MS[glyph]}ms`, "--activity-animation-cycles": ACTIVITY_ANIMATION_CYCLES } as CSSProperties : undefined} onAnimationEnd={() => setAnimation(null)}>
    {glyph === "wave" ? <path d="M2 12c2.5 0 2.5-7 5-7s2.5 14 5 14 2.5-14 5-14 2.5 7 5 7" /> : glyph === "pencil" ? <><path d="m16 3 5 5L8 21H3v-5Z" /><path d="m13 6 5 5M3 16l5 5" /></> : glyph === "document" ? <><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8Z" /><path d="M14 3v5h5M8 12h8M8 16h8" /></> : glyph === "briefcase" ? <><rect x="2" y="7" width="20" height="14" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M2 12h20M10 12v3h4v-3" /></> : glyph === "sparkles" ? <><path d="m12 5 2 6 6 2-6 2-2 6-2-6-6-2 6-2Z" /><path d="M20 2v4M18 4h4M4 3v4M2 5h4" /></> : <PenroseTriangle />}
  </svg>;
}

function ActivityLabel({ entry, entrance, owner }: { entry: ActivityEntry; entrance?: ActivityEntrance; owner: object }) {
  const part = entry.part;
  const toolStatus = part.type === "tool" ? part.error ? "Failed" : part.toolStatus || (part.output !== undefined ? undefined : active(entry.source.status) ? "Working" : "No result recorded") : undefined;
  const status = toolStatus && /^(result|completed|complete|success)$/i.test(toolStatus) ? undefined : toolStatus;
  return <><ActivityIcon glyph={activityGlyph(part.type === "tool" ? part.name : undefined)} entrance={entrance} owner={owner} /><span className="activity-name">{part.type === "reasoning" ? "Reasoning" : part.name}</span>{status && <span className={`activity-status${part.type === "tool" && part.error ? " activity-error" : ""}`}>{status}</span>}</>;
}

/** One sequence, one selection: the newest activity always has its own row. */
export function TranscriptActivity({ group, entrances, renderBody }: { group: ActivityGroup; entrances?: Map<string, ActivityEntrance>; renderBody: (entry: ActivityEntry) => ReactNode }) {
  const domId = useId();
  const animationOwner = useRef({}).current;
  const latest = group.entries.at(-1)!;
  const history = group.entries.slice(0, -1);
  const [selection, setSelection] = useState<{ id: string; expanded: boolean }>({ id: group.entries[0]!.id, expanded: false });
  const selected = group.entries.find(entry => entry.id === selection.id) ?? group.entries[0]!;
  const historySelection = history.find(entry => entry.id === selected.id) ?? history[0];
  const selectedIndex = history.findIndex(entry => entry.id === historySelection?.id);
  const historyId = `${domId}-history`, latestId = `${domId}-latest`;
  const root = useRef<HTMLDivElement>(null);
  const collapseButton = useRef<HTMLButtonElement>(null);
  const focusedCollapse = useRef(false);
  const focusedEntry = useRef<string | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const historyOpen = selection.expanded && selected.id !== latest.id;
  const latestOpen = selection.expanded && selected.id === latest.id;
  const choose = (entry: ActivityEntry) => setSelection({ id: entry.id, expanded: true });
  const activate = (entry: ActivityEntry) => setSelection({ id: entry.id, expanded: !selection.expanded || selected.id !== entry.id });
  const navigate = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const next = event.key === "Home" ? 0 : event.key === "End" ? history.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + history.length) % history.length;
    const entry = history[next]!;
    choose(entry);
    const button = buttons.current.get(entry.id);
    // Explicit keyboard navigation may reveal a wrapped row vertically. Live
    // updates below still restore focus without moving the transcript.
    button?.focus();
  };
  // If a focused control moves into the history row, follow that control,
  // rather than the new tail. Do not move focus from anywhere else in the UI.
  useLayoutEffect(() => {
    if (focusedCollapse.current && document.activeElement === document.body) { collapseButton.current?.focus({ preventScroll: true }); return; }
    if (!focusedEntry.current || document.activeElement !== document.body && !(document.activeElement === buttons.current.get(latest.id) && focusedEntry.current !== latest.id)) return;
    const button = buttons.current.get(focusedEntry.current);
    button?.focus({ preventScroll: true });
  }, [latest.id]);
  const toggle = (button: HTMLButtonElement) => {
    if (selection.expanded && root.current?.contains(document.activeElement) && document.activeElement !== button) button.focus({ preventScroll: true });
    setSelection({ id: selected.id, expanded: !selection.expanded });
  };
  const collapse = <button type="button" ref={collapseButton} className="activity-collapse" aria-label={selection.expanded ? "Collapse activity contents" : "Expand activity contents"}
    onFocus={() => { focusedCollapse.current = true; focusedEntry.current = null; }}
    aria-expanded={selection.expanded} aria-controls={`${historyId} ${latestId}`} onClick={event => toggle(event.currentTarget)}>
    {selection.expanded ? <FiChevronDown size={15} aria-hidden="true" /> : <FiChevronLeft size={15} aria-hidden="true" />}
  </button>;
  const register = (entry: ActivityEntry, button: HTMLButtonElement | null) => { if (button) buttons.current.set(entry.id, button); else buttons.current.delete(entry.id); };
  return <div className="transcript-activity" ref={root} onBlurCapture={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) { focusedEntry.current = null; focusedCollapse.current = false; } }}>
    {history.length > 0 && <div className="activity-row activity-history">
      <div className="activity-tabs" role="tablist" aria-label="Earlier consecutive tools and reasoning">
        {history.map((entry, index) => <button type="button" role="tab" key={entry.id} ref={button => register(entry, button)} id={`${domId}-tab-${index}`}
          className={`activity-tab${historyOpen && entry.id === selected.id ? " activity-selected" : ""}`}
          aria-selected={index === selectedIndex} aria-expanded={historyOpen && entry.id === selected.id} aria-controls={historyId} tabIndex={index === selectedIndex ? 0 : -1}
          onFocus={() => { focusedCollapse.current = false; focusedEntry.current = entry.id; }} onKeyDown={event => navigate(event, index)} onClick={() => activate(entry)}>
          <ActivityLabel entry={entry} entrance={entrances?.get(entry.id)} owner={animationOwner} />
        </button>)}
      </div>{collapse}
    </div>}
    <div id={historyId} role="tabpanel" aria-labelledby={history.length ? `${domId}-tab-${Math.max(0, selectedIndex)}` : undefined} hidden={!historyOpen} tabIndex={0} className="activity-body">
      {historyOpen && renderBody(selected)}
    </div>
    <div className="activity-row activity-latest">
      <button type="button" ref={button => register(latest, button)} id={`${domId}-latest-button`} className={`activity-tab${latestOpen ? " activity-selected" : ""}`}
        aria-expanded={latestOpen} aria-controls={latestId} onFocus={() => { focusedCollapse.current = false; focusedEntry.current = latest.id; }}
        onClick={() => activate(latest)}>
        <ActivityLabel key={latest.id} entry={latest} entrance={entrances?.get(latest.id)} owner={animationOwner} />
      </button>{!history.length && collapse}
    </div>
    <div id={latestId} role="region" aria-labelledby={`${domId}-latest-button`} hidden={!latestOpen} className="activity-body">
      {latestOpen && renderBody(latest)}
    </div>
  </div>;
}
