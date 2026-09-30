import { useDeferredValue, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { catalog } from "./catalog";
import { store, type State } from "./store";
import { harnessName, harnessShort } from "./types";
import { AgentAvatar } from "./agent-visuals";
import { defaultFilterFor, filterConversations, formatTitle } from "./conversation-filter";
import { buildWorkstreamMap, ConversationFilterDialog } from "./conversation-filter-dialog";
import { ConversationMenu, PhaseBadge, StatusIcon, WorkstreamBadge } from "./conversation-row";
import { useMessageHits, useWorkstreamOverview } from "./history-view";
import { Icon } from "./nav";
import { workerReference as knownWorker, useWorkerDiscovery } from "./worker-client";

const basename = (path?: string | null) => path?.split("/").filter(Boolean).at(-1) || path || "Conversation";

export function History({ state, onChoose }: { state: State; onChoose: (id: string) => void }) {
  const workerDiscovery = useWorkerDiscovery();
  const repository = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const nav = repository.navigation;
  const [filter, setFilter] = useState(() => defaultFilterFor(nav.workspaceId, nav.worktreeId));
  useEffect(() => { setFilter(defaultFilterFor(nav.workspaceId, nav.worktreeId)); }, [nav.workspaceId, nav.worktreeId]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const overview = useWorkstreamOverview(nav.workspaceId);
  const deferred = useDeferredValue(filter);
  const workstreamMap = useMemo(() => buildWorkstreamMap(overview, state.conversations), [overview, state.conversations]);
  const visible = useMemo(() => filterConversations([...state.conversations].reverse().filter(c => !knownWorker(c.id)), deferred, { workstreamMap }), [state.conversations, deferred, workstreamMap, workerDiscovery]);
  const hits = useMessageHits(deferred.query, deferred.workspaceId, deferred.worktreeId).filter(hit => !knownWorker(hit.sessionId));
  const selectedWorkspace = repository.workspaces.find(w => w.workspaceId === nav.workspaceId);
  const groups = [...repository.workspaces.map(w => ({ id: w.workspaceId, name: w.name })), { id: null, name: "Unavailable workspace · recorded history" }];
  const scoped = deferred.workspaceId !== "all" && deferred.workspaceId !== "unavailable";
  const activeFilterCount = (deferred.harness !== "all" ? 1 : 0) + (deferred.status !== "all" ? 1 : 0) + (deferred.workstreamId !== "all" ? 1 : 0) + (deferred.phase !== "all" ? 1 : 0)
    + (deferred.workspaceId === nav.workspaceId && deferred.worktreeId === nav.worktreeId ? 0 : 1);
  return <><button type="button" className="new-chat" disabled={!nav.worktreeId} onClick={() => onChoose("")}><Icon name="plus" />New conversation</button><div className="history-search-row"><label className="history-search"><span className="sr-only">Search history</span><input value={filter.query} onChange={e => setFilter({ ...filter, query: e.target.value })} placeholder="Search conversations" maxLength={200} /></label><button type="button" className="history-filter-button" aria-label="Open conversation filters" title="Filter conversations" onClick={() => setDialogOpen(true)}>Filter{activeFilterCount ? ` · ${activeFilterCount}` : ""}</button></div>{dialogOpen && <ConversationFilterDialog value={filter} onChange={setFilter} workspaces={repository.workspaces} navigation={nav} overview={overview} resultCount={visible.length} onClose={() => setDialogOpen(false)} />}{!!hits.length && <div className="history-hits" aria-label="Message matches"><p className="muted">Message matches · best effort</p>{hits.slice(0, 3).map((hit, index) => { const hitConvo = state.conversations.find(c => c.id === hit.sessionId); return <button key={`${hit.sessionId}:${hit.runId ?? "title"}:${index}`} type="button" className="history-hit" onClick={() => onChoose(hit.sessionId)} title={hitConvo?.title ? `${hitConvo.title}\n${hitConvo.cwd}` : hitConvo?.cwd || hit.sessionId}><span>{hitConvo?.title ? formatTitle(hitConvo.title, basename(hitConvo.cwd)) : basename(hitConvo?.cwd) || "Conversation"}</span><small className="muted"> {hit.snippet}</small></button>; })}</div>}<nav className="history-list" aria-label="Conversation history">{groups.sort((a, b) => Number(b.id === selectedWorkspace?.workspaceId) - Number(a.id === selectedWorkspace?.workspaceId)).map(group => {
    const conversations = visible.filter(c => group.id ? c.workspaceId === group.id : !c.workspaceId || !repository.workspaces.some(w => w.workspaceId === c.workspaceId));
    return conversations.length ? <section className="history-group" key={group.id ?? "unavailable"}>{!scoped && <h3>{group.name}</h3>}{conversations.map(c => { const membership = workstreamMap.get(c.id); const workspaceName = repository.workspaces.find(w => w.workspaceId === c.workspaceId)?.name; const workspaceLabel = workspaceName ?? (c.association === "resolved" ? basename(c.cwd) : "Unavailable"); const phases = membership?.phases ?? []; return <div className="history-row" key={c.id}><button type="button" className={state.selected === c.id ? "selected" : ""} aria-current={state.selected === c.id ? "page" : undefined} onClick={() => onChoose(c.id)} title={c.title ? `${c.title}\n${c.cwd}` : c.cwd}><span className="history-line"><span className="history-title">{formatTitle(c.title, basename(c.cwd))}</span>{c.hidden && <span className="harness-badge">Hidden</span>}</span><span className="history-line">{(() => { const profile = store.profileFor(c); return profile?.kind === "assistant" ? <span className="agent-row-avatar" title={profile.label}><AgentAvatar profile={profile} size={16} /></span> : null; })()}<span className="harness-badge" title={harnessName(c.harness)}>{harnessShort(c.harness)}</span><span className="harness-badge workspace-badge" title={c.association === "resolved" ? c.cwd : undefined}>{workspaceLabel}</span>{membership?.workstreamId && <WorkstreamBadge workstreamId={membership.workstreamId} phases={membership.phases} />}{!phases.length && <StatusIcon status={c.status} />}</span>{!!phases.length && <span className="history-line">{phases.map(phase => <PhaseBadge key={phase} phase={phase} />)}<StatusIcon status={c.status} /></span>}</button><ConversationMenu conversationId={c.id} hidden={c.hidden} disabled={state.actionBusy} /></div>; })}</section> : null;
  })}{!visible.length && <p className="muted history-empty">No conversations in this selection.</p>}</nav></>;
}
