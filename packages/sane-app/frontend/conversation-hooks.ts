import { useEffect, useState } from "react";
import type { SearchHit } from "./types";
import type { ProfileSnapshot } from "./profile-presentation";
import { store } from "./store";
import { workspaceEpoch } from "./workspace-store";
import { useHistoryRunPreview } from "./history-run-preview";
export { useWorkstreamOverview, useWorkstreamOverviewState } from "./workstream-overview";

export function useMessageHits(query: string, workspaceId: string | null | "all" | "unavailable", worktreeId: string | null | "all"): SearchHit[] {
  return useMessageHitsState(query, workspaceId, worktreeId).hits;
}

/** Search and summary acquisition share a scope fence; neither scans sidebar pages. */
export function useMessageHitsState(query: string, workspaceId: string | null | "all" | "unavailable", worktreeId: string | null | "all", scope = "") {
  const trimmed = query.trim();
  const auth = workspaceEpoch();
  const key = JSON.stringify([trimmed, workspaceId, worktreeId, scope, auth]);
  const [result, setResult] = useState<{ key: string; hits: SearchHit[]; loading: boolean; error: string } | null>(null);
  useEffect(() => {
    // Cleanup fences in-flight responses even when the next query is too short.
    if (trimmed.length < 2) return;
    let current = true;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    setResult({ key, hits: [], loading: true, error: "" });
    const timer = setTimeout(async () => {
      timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const params = new URLSearchParams({ q: trimmed.slice(0, 200), limit: "10" });
        if (workspaceId && workspaceId !== "all" && workspaceId !== "unavailable") params.set("workspaceId", workspaceId);
        if (worktreeId && worktreeId !== "all") params.set("worktreeId", worktreeId);
        const response = await fetch(`/api/sessions/search?${params.toString()}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
        const data = await response.json().catch(() => ({}));
        if (!current || auth !== workspaceEpoch()) return;
        if (!response.ok || !Array.isArray(data.results)) throw new Error("Message search unavailable.");
        const hits: SearchHit[] = data.results.slice(0, 10);
        // Publish hits only after targeted summaries are available for exact filtering
        // and labels. The store owns auth/publication fences for the known-cache union.
        if (hits.length && store.ensureConversations) {
          try {
            await store.ensureConversations([...new Set(hits.map(hit => hit.sessionId))], controller.signal);
          } catch {
            if (current && auth === workspaceEpoch()) setResult({ key, hits, loading: false, error: "Some message matches could not be loaded." });
            return;
          }
        }
        if (current && auth === workspaceEpoch()) setResult({ key, hits, loading: false, error: "" });
      } catch {
        if (current && auth === workspaceEpoch()) setResult({ key, hits: [], loading: false, error: "Message search is unavailable. Change the search to retry." });
      } finally {
        clearTimeout(timeout);
      }
    }, 320);
    return () => { current = false; clearTimeout(timer); clearTimeout(timeout); controller.abort(); };
  }, [trimmed, workspaceId, worktreeId, key, auth]);
  if (trimmed.length < 2) return { hits: [], loading: false, error: "" };
  return result?.key === key ? result : { hits: [], loading: true, error: "" };
}

export type PreviewRun = ProfileSnapshot & { id: string; status: string; createdAt: string; endedAt?: string; cwd?: string };

/** Identity-fenced lean history, independent of the selected transcript. */
export function usePreviewRuns(previewId: string | null, source?: { harness?: string; authorityId?: string; nativeSessionId?: string; cwd: string }): {
  runs: PreviewRun[]; loading: boolean; loadingMore: boolean; error: string; total: number | null; hasMore: boolean;
  loadMore(): void; retry(): void; refresh(): void;
} {
  return useHistoryRunPreview(previewId, source);
}
