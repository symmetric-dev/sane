import { useEffect, useRef, useState } from "react";
import { request } from "./cc-client";
import type { HandoffProjection } from "../src/handoff-contract";
import { pollWhileVisible } from "./visibility";

const empty: HandoffProjection = { handoffs: [] };
const handoffsInFlight = (value: HandoffProjection) => value.handoffs.some(item => !["completed", "failed"].includes(item.handoff.status));
export function useHandoffs(sessionId: string, enabled = true): HandoffProjection & { loading: boolean } {
  const scope = useRef({ sessionId, enabled, revision: 0 });
  if (scope.current.sessionId !== sessionId || scope.current.enabled !== enabled) {
    scope.current = { sessionId, enabled, revision: scope.current.revision + 1 };
  }
  const revision = scope.current.revision;
  const [projection, setProjection] = useState<{ sessionId: string; revision: number; value: HandoffProjection }>({ sessionId: "", revision: -1, value: empty });
  useEffect(() => {
    if (!sessionId || !enabled) return;
    let inFlight = projection.sessionId !== sessionId || handoffsInFlight(projection.value), failures = 0;
    return pollWhileVisible(async signal => {
      const isCurrent = () => !signal.aborted && scope.current.revision === revision;
      try {
        const value: HandoffProjection = await request(`/api/sessions/${encodeURIComponent(sessionId)}/handoffs`, { signal });
        if (isCurrent()) {
          inFlight = handoffsInFlight(value); failures = 0;
          const serialized = JSON.stringify(value);
          setProjection(previous => previous.sessionId === sessionId && previous.revision === revision && JSON.stringify(previous.value) === serialized ? previous : { sessionId, revision, value });
        }
      } catch (error) {
        if (isCurrent()) {
          failures++;
          setProjection(previous => ({ sessionId, revision, value: { ...(previous.sessionId === sessionId ? previous.value : empty), error: error instanceof Error ? error.message : "Handoff status unavailable" } }));
        }
      }
      return inFlight ? Math.min(1500 * 2 ** Math.min(failures, 4), 15_000) : 60_000;
    }, { sessionIds: [sessionId], onWake: () => { inFlight = true; failures = 0; } });
  }, [sessionId, enabled, revision]);
  // Readiness changes during render, before any layout/rAF consumer can scan.
  // Matching last-known cards remain visible, but only this enabled scope's
  // settled read may establish readiness (and errors still cannot prove a miss).
  const matching = projection.sessionId === sessionId;
  return { ...(matching ? projection.value : empty), loading: !sessionId || !enabled || !matching || projection.revision !== revision };
}
