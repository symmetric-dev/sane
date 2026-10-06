import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { FiInfo } from "react-icons/fi";
import { consecutiveActivitySegments, type ActivityEntrance, type ActivityEntry, type ActivityGroup } from "./transcript-activity";
import { activityGlyph, ACTIVITY_ANIMATION_CYCLES, ACTIVITY_ANIMATION_MS, type ActivityGlyph } from "./activity-visuals";
import { PenroseTriangleFaces } from "./penrose-triangle";
import "./activity.css";

export function ActivityIcon({ glyph, entrances, owner }: { glyph: ActivityGlyph; entrances?: ActivityEntrance[]; owner?: object }) {
  const [animation, setAnimation] = useState<{ delay: number; key: number } | null>(null);
  const observed = useRef(new WeakSet<ActivityEntrance>());
  const sequence = useRef(0);
  useLayoutEffect(() => {
    if (!entrances || !owner) return;
    const now = performance.now();
    let startedAt: number | undefined;
    for (const entrance of entrances) {
      if (observed.current.has(entrance)) continue;
      observed.current.add(entrance);
      if (entrance.claimed && entrance.owner !== owner) continue;
      if (!entrance.claimed) { entrance.claimed = true; entrance.startedAt = now; entrance.owner = owner; }
      if (entrance.startedAt !== undefined) startedAt = Math.max(startedAt ?? entrance.startedAt, entrance.startedAt);
    }
    if (startedAt === undefined) return;
    const elapsed = now - startedAt;
    if (elapsed < ACTIVITY_ANIMATION_MS[glyph] * ACTIVITY_ANIMATION_CYCLES) setAnimation({ delay: -elapsed, key: ++sequence.current });
  }, [entrances, owner, glyph]);
  return <svg key={animation?.key ?? 0} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    className={`activity-icon activity-${glyph}${animation ? " activity-arriving" : ""}`} style={animation ? { animationDelay: `${animation.delay}ms`, "--activity-animation-duration": `${ACTIVITY_ANIMATION_MS[glyph]}ms`, "--activity-animation-cycles": ACTIVITY_ANIMATION_CYCLES } as CSSProperties : undefined} onAnimationEnd={() => setAnimation(null)}>
    {glyph === "wave" ? <path d="M2 12c2.5 0 2.5-7 5-7s2.5 14 5 14 2.5-14 5-14 2.5 7 5 7" /> : glyph === "pencil" ? <><path d="m16 3 5 5L8 21H3v-5Z" /><path d="m13 6 5 5M3 16l5 5" /></> : glyph === "document" ? <><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8Z" /><path d="M14 3v5h5M8 12h8M8 16h8" /></> : glyph === "briefcase" ? <><rect x="2" y="7" width="20" height="14" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M2 12h20M10 12v3h4v-3" /></> : glyph === "sparkles" ? <><path d="m12 5 2 6 6 2-6 2-2 6-2-6-6-2 6-2Z" /><path d="M20 2v4M18 4h4M4 3v4M2 5h4" /></> : <PenroseTriangleFaces />}
  </svg>;
}

export function ActivityLabel({ entry, count = 1, entrances, owner }: { entry: Pick<ActivityEntry, "type" | "name" | "status" | "error">; count?: number; entrances?: ActivityEntrance[]; owner?: object }) {
  const status = entry.status && !/^(result|completed|complete|success)$/i.test(entry.status) ? entry.status : entry.error ? "Failed" : undefined;
  return <><ActivityIcon glyph={activityGlyph(entry.type === "tool" ? entry.name : undefined)} entrances={entrances} owner={owner} /><span className="activity-name">{entry.type === "reasoning" ? "Reasoning" : entry.name}</span>{count > 1 && <span className="activity-count">×{count}</span>}{status && <span className={`activity-status${entry.error ? " activity-error" : ""}`}>{status}</span>}</>;
}

export function TranscriptActivity({ group, entrances, inspect, scope }: { group: ActivityGroup; entrances?: Map<string, ActivityEntrance>; inspect: (entryId: string, trigger: HTMLButtonElement) => void; scope: string }) {
  const animationOwner = useRef({}).current;
  const latest = group.entries.at(-1);
  if (!latest) return null;
  return <div className="transcript-activity">
    <div className="activity-summary-row">
      <div className="activity-summaries">
        {consecutiveActivitySegments(group.entries).map(segment => <span key={segment.id} className="activity-summary">
          <ActivityLabel entry={segment} count={segment.entries.length} entrances={entrances ? segment.entries.flatMap(entry => { const entrance = entrances.get(entry.id); return entrance ? [entrance] : []; }) : undefined} owner={animationOwner} />
        </span>)}
      </div>
      <button type="button" className="activity-inspect" aria-label="Inspect agent activity" aria-haspopup="dialog" data-activity-group-id={group.id} data-activity-scope={scope} onClick={event => inspect(latest.id, event.currentTarget)}>
        <FiInfo size={17} aria-hidden="true" />
      </button>
    </div>
  </div>;
}
