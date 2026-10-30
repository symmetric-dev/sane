import { useCallback, useEffect, useRef, useState } from "react";
import { isMediaShareRecord, type MediaShareRecord } from "../shared/media-share-contract";
import { request } from "./cc-client";
import { documentHidden, pollWhileVisible } from "./visibility";

export type MediaShareProjection = { shares: readonly MediaShareRecord[]; loaded: boolean; loading: boolean; error: string; retry: () => void };
const empty: readonly MediaShareRecord[] = [];

/** Retry reads persisted snapshots only; it never invokes the sharing tool again. */
export function useMediaShares(sessionId: string, { enabled = true, refreshKey, running = false }: { enabled?: boolean; refreshKey?: unknown; running?: boolean } = {}): MediaShareProjection {
  const [state, setState] = useState({ sessionId: "", shares: empty, loading: true, error: "" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  const refresh = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!sessionId || !enabled) return;
    let disposed = false, lastRead = 0;
    let pending: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    setState(previous => previous.sessionId === sessionId ? { ...previous, loading: true } : { sessionId, shares: empty, loading: true, error: "" });
    const read = async (signal: AbortSignal) => {
      if (controller || disposed) return;
      const current = controller = new AbortController();
      lastRead = Date.now();
      try {
        const data = await request(`/api/sessions/${encodeURIComponent(sessionId)}/media-shares`, { signal: AbortSignal.any([signal, current.signal, AbortSignal.timeout(25000)]) });
        if (!Array.isArray(data.shares) || data.shares.some((share: unknown) => !isMediaShareRecord(share) || share.sessionId !== sessionId)) throw new Error("Invalid shared media projection.");
        if (disposed || signal.aborted || current.signal.aborted) return;
        setState(previous => {
          const known = new Map(previous.sessionId === sessionId ? previous.shares.map(share => [share.id, share]) : []);
          const shares: MediaShareRecord[] = data.shares.map((share: MediaShareRecord) => known.get(share.id) ?? share);
          const unchanged = previous.sessionId === sessionId && shares.length === previous.shares.length && shares.every((share, index) => share === previous.shares[index]);
          return { sessionId, shares: unchanged ? previous.shares : shares, loading: false, error: "" };
        });
      } catch (error) {
        if (!disposed && !signal.aborted && !current.signal.aborted) setState(previous => ({ sessionId, shares: previous.sessionId === sessionId ? previous.shares : empty, loading: false, error: error instanceof Error ? error.message : "Shared media unavailable." }));
      } finally { if (controller === current) controller = undefined; }
    };
    const stop = pollWhileVisible(async signal => { await read(signal); return running ? 3000 : 60_000; }, { sessionIds: [sessionId], onWake: () => {} });
    refresh.current = () => {
      clearTimeout(pending);
      pending = setTimeout(() => { if (!documentHidden() && !disposed) void read(new AbortController().signal); }, Math.max(700, 3000 - (Date.now() - lastRead)));
    };
    return () => { disposed = true; refresh.current = null; clearTimeout(pending); stop(); controller?.abort(); };
  }, [sessionId, enabled, running, attempt]);
  useEffect(() => { refresh.current?.(); }, [sessionId, refreshKey]);
  // Fence the render before effects run when navigating between sessions.
  return { shares: state.sessionId === sessionId ? state.shares : empty, loaded: !!sessionId && state.sessionId === sessionId && !state.loading && !state.error, loading: !!sessionId && enabled && (state.sessionId !== sessionId || state.loading), error: state.sessionId === sessionId ? state.error : "", retry };
}
