import { useEffect, useState } from "react";
import { request } from "./cc-client";
import type { HandoffProjection } from "../src/handoff-contract";

const empty: HandoffProjection = { handoffs: [] };
export function useHandoffs(sessionId: string, enabled = true): HandoffProjection {
  const [projection, setProjection] = useState<{ sessionId: string; value: HandoffProjection }>({ sessionId: "", value: empty });
  useEffect(() => {
    if (!sessionId || !enabled) return;
    let current = true, timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const value: HandoffProjection = await request(`/api/sessions/${encodeURIComponent(sessionId)}/handoffs`, { signal: controller.signal });
        if (current) setProjection(previous => previous.sessionId === sessionId && JSON.stringify(previous.value) === JSON.stringify(value) ? previous : { sessionId, value });
      } catch (error) {
        if (current) setProjection(previous => ({ sessionId, value: { ...(previous.sessionId === sessionId ? previous.value : empty), error: error instanceof Error ? error.message : "Handoff status unavailable" } }));
      } finally { if (current) timer = setTimeout(() => void poll(), 1500); }
    };
    void poll();
    return () => { current = false; controller.abort(); clearTimeout(timer); };
  }, [sessionId, enabled]);
  return projection.sessionId === sessionId ? projection.value : empty;
}
