import { useCallback, useEffect, useRef, useState } from "react";
import { isCodeShareRecord, type CodeShareRecord } from "../shared/code-share-contract";
import { request } from "./cc-client";
import { documentHidden, pollWhileVisible } from "./visibility";

export type CodeShareProjection = { shares: readonly CodeShareRecord[]; loading: boolean; error: string; retry: () => void };
const empty: readonly CodeShareRecord[] = [];

export function useCodeShares(sessionId: string, { enabled = true, refreshKey, running = false }: { enabled?: boolean; refreshKey?: unknown; running?: boolean } = {}): CodeShareProjection {
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
        const data = await request(`/api/sessions/${encodeURIComponent(sessionId)}/code-shares`, { signal: AbortSignal.any([signal, current.signal, AbortSignal.timeout(25000)]) });
        if (!Array.isArray(data.shares) || data.shares.some((share: unknown) => !isCodeShareRecord(share) || share.sessionId !== sessionId)) throw new Error("Invalid shared code projection.");
        if (disposed || signal.aborted || current.signal.aborted) return;
        setState(previous => {
          const known = new Map(previous.sessionId === sessionId ? previous.shares.map(share => [share.id, share]) : []);
          const shares: CodeShareRecord[] = data.shares.map((share: CodeShareRecord) => known.get(share.id) ?? share);
          const unchanged = previous.sessionId === sessionId && shares.length === previous.shares.length && shares.every((share, index) => share === previous.shares[index]);
          return { sessionId, shares: unchanged ? previous.shares : shares, loading: false, error: "" };
        });
      } catch (error) {
        if (!disposed && !signal.aborted && !current.signal.aborted) setState(previous => ({ sessionId, shares: previous.sessionId === sessionId ? previous.shares : empty, loading: false, error: error instanceof Error ? error.message : "Shared code unavailable." }));
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
  // Fence synchronously: effects run after the new session has already rendered.
  return { shares: state.sessionId === sessionId ? state.shares : empty, loading: !!sessionId && enabled && (state.sessionId !== sessionId || state.loading), error: state.sessionId === sessionId ? state.error : "", retry };
}
