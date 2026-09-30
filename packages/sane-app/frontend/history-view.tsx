import { useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { catalog } from "./catalog";
import { store, type State } from "./store";
import { active, harnessName, harnessShort, type SearchHit } from "./types";
import { AgentAvatar } from "./agent-visuals";
import { defaultFilterFor, filterConversations, formatTitle } from "./conversation-filter";
import { buildWorkstreamMap, ConversationFilterDialog } from "./conversation-filter-dialog";
import { AttachConversation } from "./attach-conversation";
import { ConversationMenu, PhaseBadge, StatusIcon, WorkstreamBadge } from "./conversation-row";
import { Facts } from "./thread";
import { loadWorkstreams } from "./workstreams-client";
import type { WorkstreamOverview } from "../src/workstreams-contract";
import { worktreeDisplay, worktreeLabel } from "./catalog-selector";
import { workerReference as knownWorker, knownWorker as hydratedWorker, openWorkerSession, useWorkerDiscovery, useWorkerPolling } from "./worker-client";
import { WorkerCard, WorkerSection } from "./worker-ui";

const basename = (path?: string | null) => path?.split("/").filter(Boolean).at(-1) || path || "Conversation";

export function useWorkstreamOverview(workspaceId: string | null): WorkstreamOverview | null {
  const [overview, setOverview] = useState<WorkstreamOverview | null>(null);
  useEffect(() => {
    if (!workspaceId) { setOverview(null); return; }
    let current = true;
    setOverview(null);
    loadWorkstreams(workspaceId).then(next => { if (current) setOverview(next); }).catch(() => { if (current) setOverview(null); });
    return () => { current = false; };
  }, [workspaceId]);
  return overview;
}

export function useMessageHits(query: string, workspaceId: string | null | "all" | "unavailable", worktreeId: string | null | "all"): SearchHit[] {
  const [hits, setHits] = useState<SearchHit[]>([]);
  const request = useRef(0);
  const trimmed = query.trim();
  useEffect(() => {
    if (trimmed.length < 2) { setHits([]); return; }
    const generation = ++request.current;
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: trimmed.slice(0, 200), limit: "10" });
        if (workspaceId && workspaceId !== "all" && workspaceId !== "unavailable") params.set("workspaceId", workspaceId);
        if (worktreeId && worktreeId !== "all") params.set("worktreeId", worktreeId);
        const response = await fetch(`/api/sessions/search?${params.toString()}`, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(10000) });
        const data = await response.json().catch(() => ({}));
        if (generation === request.current) setHits(Array.isArray(data.results) ? data.results.slice(0, 10) : []);
      } catch {
        if (generation === request.current) setHits([]);
      }
    }, 320);
    return () => clearTimeout(timer);
  }, [trimmed, workspaceId, worktreeId]);
  return hits;
}

export function HistoryView({ state, onChoose }: { state: State; onChoose: (id: string) => void }) {
  const repository = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const nav = repository.navigation;
  const [filter, setFilter] = useState(() => defaultFilterFor(nav.workspaceId, nav.worktreeId));
  useEffect(() => { setFilter(defaultFilterFor(nav.workspaceId, nav.worktreeId)); }, [nav.workspaceId, nav.worktreeId]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const overview = useWorkstreamOverview(nav.workspaceId);
  const deferred = useDeferredValue(filter);
  const workstreamMap = useMemo(() => buildWorkstreamMap(overview, state.conversations), [overview, state.conversations]);
  const visible = useMemo(() => filterConversations([...state.conversations].reverse(), deferred, { workstreamMap }), [state.conversations, deferred, workstreamMap]);
  const hits = useMessageHits(deferred.query, deferred.workspaceId, deferred.worktreeId);
  const groups = useMemo(() => {
    const selected = repository.workspaces.find(w => w.workspaceId === nav.workspaceId);
    const list = [...repository.workspaces.map(w => ({ id: w.workspaceId as string | null, name: w.name })), { id: null, name: "Unavailable workspace · recorded history" }];
    return list.sort((a, b) => Number(b.id === selected?.workspaceId) - Number(a.id === selected?.workspaceId));
  }, [repository.workspaces, nav.workspaceId]);
  const activeFilterCount = (filter.harness !== "all" ? 1 : 0) + (filter.status !== "all" ? 1 : 0) + (filter.workstreamId !== "all" ? 1 : 0) + (filter.phase !== "all" ? 1 : 0) + (filter.showDeleted ? 1 : 0)
    + (filter.workspaceId === nav.workspaceId && filter.worktreeId === nav.worktreeId ? 0 : 1);

  return <section className="history-view" aria-label="Conversation history">
    <header className="history-view-header">
      <h2>History</h2>
      <label className="history-search"><span className="sr-only">Search history</span><input value={filter.query} onChange={e => setFilter({ ...filter, query: e.target.value })} placeholder="Search conversations" maxLength={200} /></label>
      <button type="button" onClick={() => setDialogOpen(true)}>Filter{activeFilterCount ? ` · ${activeFilterCount}` : ""}</button>
      <span className="muted" role="status">{visible.length} shown</span>
      <AttachConversation onChoose={onChoose} />
    </header>
    {!!hits.length && <section aria-label="Message matches"><h3>Message matches · best effort</h3><ul>{hits.map((hit, index) => {
      const convo = state.conversations.find(c => c.id === hit.sessionId);
      return <li key={`${hit.sessionId}:${hit.runId ?? "title"}:${index}`}><button type="button" onClick={() => onChoose(hit.sessionId)} title={convo?.title ? `${convo.title}\n${convo.cwd}` : convo?.cwd || hit.sessionId}><strong>{convo?.title ? formatTitle(convo.title, basename(convo.cwd)) : basename(convo?.cwd) || "Conversation"}</strong><span className="muted"> {hit.snippet}</span></button></li>;
    })}</ul></section>}
    {dialogOpen && <ConversationFilterDialog value={filter} onChange={setFilter} workspaces={repository.workspaces} navigation={nav} overview={overview} resultCount={visible.length} onClose={() => setDialogOpen(false)} />}
    {groups.map(group => {
      const conversations = visible.filter(c => group.id ? c.workspaceId === group.id : !c.workspaceId || !repository.workspaces.some(w => w.workspaceId === c.workspaceId));
      if (!conversations.length) return null;
      return <section key={group.id ?? "unavailable"}><h3>{group.name}</h3><ul className="history-list">{conversations.map(c => {
        const membership = workstreamMap.get(c.id);
        const worktree = repository.workspaces.find(w => w.workspaceId === c.workspaceId)?.worktrees.find(t => t.worktreeId === c.worktreeId);
        return <li key={c.id} className="history-row">
          <button type="button" className={state.selected === c.id ? "selected" : ""} aria-current={state.selected === c.id ? "page" : undefined} onClick={() => onChoose(c.id)} title={c.title ? `${c.title}\n${c.cwd}` : c.cwd}>
            <span className="history-title">{formatTitle(c.title, basename(c.cwd))}</span>
            <span className="history-meta"><span className="harness-badge" title={harnessName(c.harness)}>{harnessShort(c.harness)}</span>{c.hidden && <span className="harness-badge">Hidden</span>}{membership?.workstreamId && <WorkstreamBadge workstreamId={membership.workstreamId} phases={membership.phases} />}{active(c.status) && <span className="pulse" />}{c.status}</span>
            <small className="history-worktree" title={c.cwd || undefined}>{c.association === "resolved" && worktree ? `${worktreeDisplay(worktree)} · ${basename(c.cwd)}` : worktree ? `${worktreeLabel(worktree)} · ${basename(c.cwd)}` : c.association === "resolved" ? basename(c.cwd) : "Execution workspace unavailable"}</small>
          </button>
          <ConversationMenu conversationId={c.id} hidden={c.hidden} disabled={state.actionBusy} />
        </li>;
      })}</ul></section>;
    })}
    {!visible.length && <p className="muted history-empty">No conversations in this selection.</p>}
  </section>;
}

function useHistoryData(state: State) {
  useWorkerDiscovery();
  const [workerFilter, setWorkerFilter] = useState<"all" | "workers" | "conversations">("all");
  const repository = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const nav = repository.navigation;
  const [filter, setFilter] = useState(() => defaultFilterFor(nav.workspaceId, nav.worktreeId));
  useEffect(() => { setFilter(defaultFilterFor(nav.workspaceId, nav.worktreeId)); }, [nav.workspaceId, nav.worktreeId]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const overview = useWorkstreamOverview(nav.workspaceId);
  const deferred = useDeferredValue(filter);
  const workstreamMap = useMemo(() => buildWorkstreamMap(overview, state.conversations), [overview, state.conversations]);
  const visible = useMemo(() => filterConversations([...state.conversations].reverse(), deferred, { workstreamMap }), [state.conversations, deferred, workstreamMap]);
  const hits = useMessageHits(deferred.query, deferred.workspaceId, deferred.worktreeId);
  const groups = useMemo(() => {
    const selected = repository.workspaces.find(w => w.workspaceId === nav.workspaceId);
    const list = [...repository.workspaces.map(w => ({ id: w.workspaceId as string | null, name: w.name })), { id: null, name: "Unavailable workspace · recorded history" }];
    return list.sort((a, b) => Number(b.id === selected?.workspaceId) - Number(a.id === selected?.workspaceId));
  }, [repository.workspaces, nav.workspaceId]);
  const activeFilterCount = (filter.harness !== "all" ? 1 : 0) + (filter.status !== "all" ? 1 : 0) + (filter.workstreamId !== "all" ? 1 : 0) + (filter.phase !== "all" ? 1 : 0) + (filter.showDeleted ? 1 : 0)
    + (filter.workspaceId === nav.workspaceId && filter.worktreeId === nav.worktreeId ? 0 : 1);
  const matchesWorker = (id: string) => workerFilter === "all" || (workerFilter === "workers" ? !!knownWorker(id) : !knownWorker(id));
  return { repository, nav, filter, setFilter, dialogOpen, setDialogOpen, overview, workstreamMap, visible: visible.filter(c => matchesWorker(c.id)), hits: hits.filter(h => matchesWorker(h.sessionId)), groups, activeFilterCount, workerFilter, setWorkerFilter };
}

/** Sidebar session list for the History tab: preview-only, never opens chat. */
export function HistoryList({ state, previewId, onPreview }: { state: State; previewId: string | null; onPreview: (id: string) => void }) {
  const { nav, filter, setFilter, dialogOpen, setDialogOpen, overview, workstreamMap, visible, hits, groups, activeFilterCount, workerFilter, setWorkerFilter } = useHistoryData(state);
  const repository = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  return <>
    <label className="history-search">Session type<select value={workerFilter} onChange={e => setWorkerFilter(e.target.value as typeof workerFilter)}><option value="all">All sessions</option><option value="conversations">Conversations</option><option value="workers">Workers</option></select></label>
    <div className="history-search-row">
      <label className="history-search"><span className="sr-only">Search sessions</span><input value={filter.query} onChange={e => setFilter({ ...filter, query: e.target.value })} placeholder="Search sessions" maxLength={200} /></label>
      <button type="button" className="history-filter-button" aria-label="Open session filters" title="Filter sessions" onClick={() => setDialogOpen(true)}>Filter{activeFilterCount ? ` · ${activeFilterCount}` : ""}</button>
    </div>
    {dialogOpen && <ConversationFilterDialog value={filter} onChange={setFilter} workspaces={repository.workspaces} navigation={nav} overview={overview} resultCount={visible.length} onClose={() => setDialogOpen(false)} />}
    {!!hits.length && <div className="history-hits" aria-label="Message matches"><p className="muted">Message matches · best effort</p>{hits.slice(0, 3).map((hit, index) => {
      const hitConvo = state.conversations.find(c => c.id === hit.sessionId);
      return <button key={`${hit.sessionId}:${hit.runId ?? "title"}:${index}`} type="button" className="history-hit" onClick={() => onPreview(hit.sessionId)} title={hitConvo?.title ? `${hitConvo.title}\n${hitConvo.cwd}` : hitConvo?.cwd || hit.sessionId}><span>{hitConvo?.title ? formatTitle(hitConvo.title, basename(hitConvo.cwd)) : basename(hitConvo?.cwd) || "Conversation"}</span><small className="muted"> {hit.snippet}</small></button>;
    })}</div>}
    <nav className="history-list" aria-label="Sessions">{groups.map(group => {
      const conversations = visible.filter(c => group.id ? c.workspaceId === group.id : !c.workspaceId || !repository.workspaces.some(w => w.workspaceId === c.workspaceId));
      if (!conversations.length) return null;
      return <section className="history-group" key={group.id ?? "unavailable"}><h3>{group.name}</h3>{conversations.map(c => {
        const membership = workstreamMap.get(c.id);
        const workspaceName = repository.workspaces.find(w => w.workspaceId === c.workspaceId)?.name;
        const workspaceLabel = workspaceName ?? (c.association === "resolved" ? basename(c.cwd) : "Unavailable");
        const selected = previewId === c.id;
        const phases = membership?.phases ?? [];
        return <div className="history-row" key={c.id}><button type="button" className={selected ? "selected" : ""} aria-current={selected ? "page" : undefined} onClick={() => onPreview(c.id)} title={c.title ? `${c.title}\n${c.cwd}` : c.cwd}><span className="history-line"><span className="history-title">{formatTitle(c.title, basename(c.cwd))}</span>{knownWorker(c.id) && <span className="harness-badge">Worker</span>}{c.hidden && <span className="harness-badge">Hidden</span>}</span><span className="history-line">{(() => { const profile = store.profileFor(c); return profile?.kind === "assistant" ? <span className="agent-row-avatar" title={profile.label}><AgentAvatar profile={profile} size={16} /></span> : null; })()}<span className="harness-badge" title={harnessName(c.harness)}>{harnessShort(c.harness)}</span><span className="harness-badge workspace-badge" title={c.cwd}>{workspaceLabel}</span>{membership?.workstreamId && <WorkstreamBadge workstreamId={membership.workstreamId} phases={membership.phases} />}{!phases.length && <StatusIcon status={c.status} />}</span>{!!phases.length && <span className="history-line">{phases.map(phase => <PhaseBadge key={phase} phase={phase} />)}<StatusIcon status={c.status} /></span>}</button><ConversationMenu conversationId={c.id} hidden={c.hidden} disabled={state.actionBusy} /></div>;
      })}</section>;
    })}{!visible.length && <p className="muted history-empty">No sessions in this selection.</p>}</nav>
  </>;
}

type PreviewRun = { id: string; status: string; createdAt: string; endedAt?: string; model?: string; effort?: string; cwd?: string };

function usePreviewRuns(previewId: string | null): { runs: PreviewRun[]; loading: boolean; error: string } {
  const [runs, setRuns] = useState<PreviewRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!previewId) { setRuns([]); setLoading(false); setError(""); return; }
    let current = true;
    setLoading(true); setError("");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    fetch(`/api/sessions/${encodeURIComponent(previewId)}/runs`, { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(async response => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error((data as { error?: string }).error || `Request failed (${response.status})`);
        if (!current) return;
        const list = Array.isArray((data as { runs?: unknown }).runs) ? (data as { runs: Record<string, unknown>[] }).runs : [];
        const normalized: PreviewRun[] = list.map(r => ({
          id: String(r.runId ?? r.id ?? ""),
          status: String(r.status ?? "unknown"),
          createdAt: String(r.createdAt ?? ""),
          endedAt: r.endedAt !== undefined ? String(r.endedAt) : undefined,
          model: r.model !== undefined ? String(r.model) : undefined,
          effort: r.effort !== undefined ? String(r.effort) : undefined,
          cwd: r.cwd !== undefined ? String(r.cwd) : undefined,
        })).filter(r => r.id);
        normalized.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        setRuns(normalized);
      })
      .catch(err => { if (current) setError(err instanceof Error ? err.message : "Could not load runs."); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; clearTimeout(timer); controller.abort(); };
  }, [previewId]);
  return { runs, loading, error };
}

/** Main-panel session metadata for the History tab. Preview-only until Open in Chat. */
export function HistoryDetail({ state, previewId, onOpen }: { state: State; previewId: string | null; onOpen: (id: string) => void }) {
  useWorkerPolling(previewId !== state.selected ? previewId : null);
  useWorkerDiscovery();
  const worker = previewId ? knownWorker(previewId) : undefined;
  useWorkerPolling(worker?.parent.sessionId && worker.parent.sessionId !== state.selected ? worker.parent.sessionId : null);
  const record = previewId ? hydratedWorker(previewId) : undefined;
  const repository = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const conversation = state.conversations.find(c => c.id === previewId) ?? null;
  const overview = useWorkstreamOverview(conversation?.workspaceId ?? null);
  const membership = useMemo(() => (conversation ? buildWorkstreamMap(overview, state.conversations).get(conversation.id) : undefined), [overview, state.conversations, conversation]);
  const { runs, loading, error } = usePreviewRuns(previewId);
  if (!conversation) return <section className="history-detail" aria-label="Session preview"><p className="eyebrow">SESSION PREVIEW</p><h2>No session selected</h2><p className="muted">Choose a session on the left to preview its metadata. Opening chat only happens via Open in Chat.</p></section>;
  const workspace = repository.workspaces.find(w => w.workspaceId === conversation.workspaceId);
  const worktree = workspace?.worktrees.find(t => t.worktreeId === conversation.worktreeId);
  const lastActivity = runs[0]?.endedAt || runs[0]?.createdAt || "";
  return <section className="history-detail" aria-label="Session preview">
    <p className="eyebrow">{worker ? "WORKER SESSION · READ-ONLY" : "SESSION PREVIEW"}</p>
    {worker && <p><button type="button" onClick={() => { if (knownWorker(worker.parent.sessionId)) void openWorkerSession(worker.parent.sessionId); else onOpen(worker.parent.sessionId); }}>Parent conversation</button> · Parent run {worker.parent.runId}</p>}
    <div className="history-detail-header"><h2 title={conversation.title || undefined}>{formatTitle(conversation.title, basename(conversation.cwd))}</h2><span className={`status ${conversation.status}`}>{conversation.status}</span>{conversation.hidden && <span className="harness-badge">Hidden</span>}</div>
    <div className="history-detail-actions"><button type="button" className="primary-button" disabled={state.sending} onClick={() => worker ? void openWorkerSession(conversation.id) : onOpen(conversation.id)}>{worker ? "Open worker read-only" : "Open in Chat"}</button><button type="button" className="text-button" disabled={state.actionBusy} onClick={() => void (conversation.hidden ? store.unhide(conversation.id) : store.hide(conversation.id))}>{conversation.hidden ? "Unhide" : "Hide"}</button></div>
    {record && <WorkerCard worker={record} />}
    <WorkerSection sessionId={conversation.id} />
    <Facts values={[
      ["Conversation ID", conversation.id],
      ["Harness", harnessName(conversation.harness)],
      ["Native session ID", conversation.nativeSessionId],
      ["Launch directory", conversation.cwd],
      ["Workspace", workspace ? workspace.name : conversation.workspaceId || "Unavailable"],
      ["Worktree", worktree ? `${worktreeDisplay(worktree)} · ${worktree.root}` : conversation.worktreeId || "Unavailable"],
      ["Worktree state", worktree?.state],
      ["Model", conversation.model || "Native default / unchanged"],
      ["Effort / variant", conversation.effort || "Native default / unchanged"],
      ["Agent", store.conversationProfile(conversation.id)?.label ?? (conversation.agent || "Base")],
      ["Workstream", membership?.workstreamId ? `${membership.workstreamId}${membership.phases.length ? ` · ${membership.phases.join(", ")}` : ""}` : "Unassigned"],
      ["Association", conversation.association ?? "Unavailable"],
      ["Last run ID", conversation.lastRunId],
      ["Attachment", conversation.attachment ? `${conversation.attachment.state}${conversation.attachment.error ? ` · ${conversation.attachment.error}` : ""}` : "None"],
      ["Availability", conversation.availability?.canSend ? "Can send" : conversation.availability?.reason || "Unavailable"],
    ]} />
    <h3>Runs · {loading ? "loading…" : runs.length}</h3>
    {lastActivity && <p className="muted">Last activity: {lastActivity ? new Date(lastActivity).toLocaleString() : "Unknown"}</p>}
    {loading && <p className="muted" role="status">Loading runs…</p>}
    {error && <p className="notice error" role="alert">{error}</p>}
    {!loading && !error && !runs.length && <p className="muted">No runs recorded for this session.</p>}
    {!!runs.length && <ul className="history-run-list">{runs.map(run => <li key={run.id}><span title={run.id}>{run.createdAt ? new Date(run.createdAt).toLocaleString() : run.id}</span><span className={`status ${run.status}`}>{run.status}</span>{run.model && <span className="muted">{run.model}</span>}{run.effort && <span className="muted">{run.effort}</span>}</li>)}</ul>}
  </section>;
}
