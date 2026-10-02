import { useEffect, useState } from "react";
import type { SearchHit } from "./types";
import { loadWorkstreams } from "./workstreams-client";
import type { WorkstreamOverview } from "../src/workstreams-contract";
import type { ProfileSnapshot } from "./profile-presentation";

/** Results are keyed by scope so a render cannot expose the previous workspace. */
export function useWorkstreamOverview(workspaceId: string | null, active = true): WorkstreamOverview | null {
  const [result, setResult] = useState<{ workspaceId: string; overview: WorkstreamOverview | null } | null>(null);
  useEffect(() => {
    // Membership can change through handoff/linking without changing the chat
    // listing. Refresh independently while active, just like conversation polling.
    if (!workspaceId || !active) { setResult(null); return; }
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setResult(null);
    const refresh = async () => {
      try {
        const overview = await loadWorkstreams(workspaceId);
        if (current) setResult(previous => previous?.workspaceId === workspaceId && JSON.stringify(previous.overview) === JSON.stringify(overview) ? previous : { workspaceId, overview });
      } catch {
        // Keep the last successful overview during transient failures; retry below.
      } finally {
        if (current) timer = setTimeout(() => void refresh(), 1500);
      }
    };
    void refresh();
    // Fence late responses and stop polling when unmounted, inactive or re-scoped.
    return () => { current = false; clearTimeout(timer); };
  }, [workspaceId, active]);
  return active && workspaceId && result?.workspaceId === workspaceId ? result.overview : null;
}

export function useMessageHits(query: string, workspaceId: string | null | "all" | "unavailable", worktreeId: string | null | "all"): SearchHit[] {
  const trimmed = query.trim();
  const key = JSON.stringify([trimmed, workspaceId, worktreeId]);
  const [result, setResult] = useState<{ key: string; hits: SearchHit[] } | null>(null);
  useEffect(() => {
    // Cleanup fences in-flight responses even when the next query is too short.
    if (trimmed.length < 2) return;
    let current = true;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    setResult(null);
    const timer = setTimeout(async () => {
      timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const params = new URLSearchParams({ q: trimmed.slice(0, 200), limit: "10" });
        if (workspaceId && workspaceId !== "all" && workspaceId !== "unavailable") params.set("workspaceId", workspaceId);
        if (worktreeId && worktreeId !== "all") params.set("worktreeId", worktreeId);
        const response = await fetch(`/api/sessions/search?${params.toString()}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
        const data = await response.json().catch(() => ({}));
        if (current) setResult({ key, hits: response.ok && Array.isArray(data.results) ? data.results.slice(0, 10) : [] });
      } catch {
        if (current) setResult({ key, hits: [] });
      } finally {
        clearTimeout(timeout);
      }
    }, 320);
    return () => { current = false; clearTimeout(timer); clearTimeout(timeout); controller.abort(); };
  }, [trimmed, workspaceId, worktreeId, key]);
  return trimmed.length >= 2 && result?.key === key ? result.hits : [];
}

export type PreviewRun = ProfileSnapshot & { id: string; status: string; createdAt: string; endedAt?: string; cwd?: string };
type PreviewResult = { previewId: string; runs: PreviewRun[]; loading: boolean; error: string };

/** Never reuse another session's runs (including model/effort fallbacks) while loading. */
export function usePreviewRuns(previewId: string | null): { runs: PreviewRun[]; loading: boolean; error: string } {
  const [result, setResult] = useState<PreviewResult | null>(null);
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
        if (!current) return;
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
      .catch(err => { if (current) setResult({ previewId, runs: [], loading: false, error: err instanceof Error ? err.message : "Could not load runs." }); })
      .finally(() => clearTimeout(timer));
    return () => { current = false; clearTimeout(timer); controller.abort(); };
  }, [previewId]);
  if (!previewId) return { runs: [], loading: false, error: "" };
  return result?.previewId === previewId ? result : { runs: [], loading: true, error: "" };
}
