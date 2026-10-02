import { useEffect, useRef, useState } from "react";
import { request } from "./cc-client";
import type { HandoffProjection } from "../src/handoff-contract";

const empty: HandoffProjection = { handoffs: [] };
export function useHandoffs(sessionId: string, enabled = true): HandoffProjection & { loading: boolean } {
  const scope = useRef({ sessionId, enabled, revision: 0 });
  if (scope.current.sessionId !== sessionId || scope.current.enabled !== enabled) {
    scope.current = { sessionId, enabled, revision: scope.current.revision + 1 };
  }
  const revision = scope.current.revision;
  const [projection, setProjection] = useState<{ sessionId: string; revision: number; value: HandoffProjection }>({ sessionId: "", revision: -1, value: empty });
  useEffect(() => {
    if (!sessionId || !enabled) return;
    let current = true, timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const isCurrent = () => current && scope.current.revision === revision;
    const poll = async () => {
      try {
        const value: HandoffProjection = await request(`/api/sessions/${encodeURIComponent(sessionId)}/handoffs`, { signal: controller.signal });
        if (isCurrent()) setProjection(previous => previous.sessionId === sessionId && previous.revision === revision && JSON.stringify(previous.value) === JSON.stringify(value) ? previous : { sessionId, revision, value });
      } catch (error) {
        if (isCurrent()) setProjection(previous => ({ sessionId, revision, value: { ...(previous.sessionId === sessionId ? previous.value : empty), error: error instanceof Error ? error.message : "Handoff status unavailable" } }));
      } finally { if (isCurrent()) timer = setTimeout(() => void poll(), 1500); }
    };
    void poll();
    return () => { current = false; controller.abort(); clearTimeout(timer); };
  }, [sessionId, enabled, revision]);
  // Readiness changes during render, before any layout/rAF consumer can scan.
  // Matching last-known cards remain visible, but only this enabled scope's
  // settled read may establish readiness (and errors still cannot prove a miss).
  const matching = projection.sessionId === sessionId;
  return { ...(matching ? projection.value : empty), loading: !sessionId || !enabled || !matching || projection.revision !== revision };
}
