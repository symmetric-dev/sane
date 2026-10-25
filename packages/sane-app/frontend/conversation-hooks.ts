import { useEffect, useState } from "react";
import type { SearchHit } from "./types";
import type { ProfileSnapshot } from "./profile-presentation";
import { store } from "./store";
import { workspaceEpoch } from "./workspace-store";
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
type PreviewResult = { previewId: string; runs: PreviewRun[]; loading: boolean; error: string };

/** Never reuse another session's runs (including model/effort fallbacks) while loading. */
export function usePreviewRuns(previewId: string | null): { runs: PreviewRun[]; loading: boolean; error: string } {
  const [result, setResult] = useState<PreviewResult | null>(null);
  const auth = workspaceEpoch();
  useEffect(() => {
    if (!previewId) return;
    let current = true;
    setResult({ previewId, runs: [], loading: true, error: "" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    fetch(`/api/sessions/${encodeURIComponent(previewId)}/runs`, { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(async response => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error((data as { error?: string }).error || `Request failed (${response.status})`);
        if (!current || auth !== workspaceEpoch()) return;
        const list = Array.isArray((data as { runs?: unknown }).runs) ? (data as { runs: Record<string, unknown>[] }).runs : [];
        const runs: PreviewRun[] = list.filter(r => r.sessionId === undefined || r.sessionId === previewId).map((r): PreviewRun => ({
          id: String(r.runId ?? r.id ?? ""),
          status: String(r.status ?? "unknown"),
          createdAt: String(r.createdAt ?? ""),
          endedAt: r.endedAt !== undefined ? String(r.endedAt) : undefined,
          model: r.model !== undefined ? String(r.model) : undefined,
          effort: r.effort !== undefined ? String(r.effort) : undefined,
          agent: typeof r.agent === "string" ? r.agent : undefined,
          agentKind: r.agentKind === "assistant" || r.agentKind === "worker" ? r.agentKind : undefined,
          nativeAgentSelected: typeof r.nativeAgentSelected === "boolean" ? r.nativeAgentSelected : undefined,
          profileId: typeof r.profileId === "string" ? r.profileId : undefined,
          cwd: r.cwd !== undefined ? String(r.cwd) : undefined,
        })).filter(r => r.id);
        runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        setResult({ previewId, runs, loading: false, error: "" });
      })
      .catch(err => { if (current && auth === workspaceEpoch()) setResult({ previewId, runs: [], loading: false, error: err instanceof Error ? err.message : "Could not load runs." }); })
      .finally(() => clearTimeout(timer));
    return () => { current = false; clearTimeout(timer); controller.abort(); };
  }, [previewId, auth]);
  if (!previewId) return { runs: [], loading: false, error: "" };
  return result?.previewId === previewId ? result : { runs: [], loading: true, error: "" };
}
