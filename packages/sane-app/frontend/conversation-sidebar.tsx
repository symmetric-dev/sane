import { useState } from "react";
import { FiUsers } from "react-icons/fi";
import { store, type State } from "./store";
import { harnessName, harnessShort } from "./types";
import { AgentAvatar } from "./agent-visuals";
import { formatTitle } from "./conversation-filter";
import { ConversationFilterDialog } from "./conversation-filter-dialog";
import { ConversationMenu, PhaseBadge, StatusIcon, WorkstreamBadge } from "./conversation-row";
import { Icon } from "./nav";
import { workerReference as knownWorker } from "./worker-client";
import type { ConversationSidebarMode, ConversationSidebarModel } from "./conversation-sidebar-model";

export { useConversationSidebarModel } from "./conversation-sidebar-model";
export type { ConversationSidebarMode, ConversationSidebarModel } from "./conversation-sidebar-model";

const basename = (path?: string | null) => path?.split("/").filter(Boolean).at(-1) || path || "Conversation";

export type ConversationSidebarProps = {
  state: State;
  model: ConversationSidebarModel;
  mode: ConversationSidebarMode;
  selectedId: string | null;
  onChoose: (id: string) => void;
  onPreview: (id: string) => void;
  onHistory: () => void;
};

/** The shell renders its selector before this component. History selection is preview-only. */
export function ConversationSidebar({ state, model, mode, selectedId, onChoose, onPreview, onHistory }: ConversationSidebarProps) {
  return <>
    <ConversationSidebarList state={state} model={model} mode={mode} selectedId={selectedId} onSelect={mode === "history" ? onPreview : onChoose} />
    <footer className="conversation-sidebar-actions" aria-label="Conversation shortcuts">
      <button type="button" className="new-chat" disabled={state.sending || !model.nav.worktreeId} onClick={() => onChoose("")}><Icon name="plus" />New Conversation</button>
      <button type="button" className="history-sidebar-button" aria-pressed={mode === "history"} onClick={onHistory}>History</button>
    </footer>
  </>;
}

/** Shared list presentation also supports legacy callers without another data hook. */
export function ConversationSidebarList({ state, model, mode, selectedId, onSelect }: {
  state: State; model: ConversationSidebarModel; mode: ConversationSidebarMode; selectedId: string | null; onSelect: (id: string) => void;
}) {
  const { repository, nav, filter, setFilter, overview, workstreamMap, visible, hits, workerCounts, groups, scoped, activeFilterCount } = model;
  // Dialog visibility is presentation-local: opening the drawer must not create two modal dialogs.
  const [dialogOpen, setDialogOpen] = useState(false);
  const history = mode === "history";
  return <>
    <div className="history-search-row">
      <label className="history-search"><span className="sr-only">{history ? "Search sessions" : "Search conversations"}</span><input value={filter.query} onChange={e => setFilter({ ...filter, query: e.target.value })} placeholder={history ? "Search sessions" : "Search conversations"} maxLength={200} /></label>
      <button type="button" className="history-filter-button" aria-label={history ? "Open session filters" : "Open conversation filters"} title={history ? "Filter sessions" : "Filter conversations"} onClick={() => setDialogOpen(true)}>Filter{activeFilterCount ? ` · ${activeFilterCount}` : ""}</button>
    </div>
    {dialogOpen && <ConversationFilterDialog value={filter} onChange={setFilter} workspaces={repository.workspaces} navigation={nav} overview={overview} resultCount={visible.length} onClose={() => setDialogOpen(false)} />}
    {!!hits.length && <div className="history-hits" aria-label="Message matches"><p className="muted">Message matches · best effort</p>{hits.slice(0, 3).map((hit, index) => {
      const conversation = state.conversations.find(c => c.id === hit.sessionId);
      return <button key={`${hit.sessionId}:${hit.runId ?? "title"}:${index}`} type="button" className="history-hit" disabled={!history && state.sending} onClick={() => onSelect(hit.sessionId)} title={conversation?.title ? `${conversation.title}\n${conversation.cwd}` : conversation?.cwd || hit.sessionId}><span>{formatTitle(conversation?.title, basename(conversation?.cwd))}</span><small className="muted"> {hit.snippet}</small></button>;
    })}</div>}
    <nav className="history-list" aria-label={history ? "Sessions" : "Conversation history"}>{groups.map(group => {
      const conversations = visible.filter(c => group.id ? c.workspaceId === group.id : !c.workspaceId || !repository.workspaces.some(w => w.workspaceId === c.workspaceId));
      if (!conversations.length) return null;
      return <section className="history-group" key={group.id ?? "unavailable"}>
        {(history || !scoped) && <h3>{group.name}</h3>}
        {conversations.map(c => {
          const membership = workstreamMap.get(c.id);
          const workspaceName = repository.workspaces.find(w => w.workspaceId === c.workspaceId)?.name;
          const workspaceLabel = workspaceName ?? (c.association === "resolved" ? basename(c.cwd) : "Unavailable");
          const selected = selectedId === c.id;
          const phases = membership?.phases ?? [];
          const workerCount = workerCounts.get(c.id) ?? 0;
          const profile = store.profileFor(c);
          return <div className="history-row" key={c.id}>
            <button type="button" className={selected ? "selected" : ""} aria-current={selected ? "page" : undefined} disabled={!history && state.sending} onClick={() => onSelect(c.id)} title={c.title ? `${c.title}\n${c.cwd}` : c.cwd}>
              <span className="history-line">
                <span className="history-title">{formatTitle(c.title, basename(c.cwd))}</span>
                {!history && workerCount > 0 && <span className="history-workers" title={`${workerCount} direct workers`}><FiUsers size={12} aria-hidden="true" /><span aria-hidden="true">{workerCount}</span><span className="sr-only">{workerCount} direct workers</span></span>}
                {history && knownWorker(c.id) && <span className="harness-badge">Worker</span>}
                {history && c.replacedBy ? <span className="harness-badge">Replaced</span> : c.hidden && <span className="harness-badge">Hidden</span>}
                {history && c.branchOrigin && <span className="harness-badge">Branch</span>}
              </span>
              <span className="history-line">
                {profile?.kind === "assistant" && <span className="agent-row-avatar" title={profile.label}><AgentAvatar profile={profile} size={16} /></span>}
                <span className="harness-badge" title={harnessName(c.harness)}>{harnessShort(c.harness)}</span>
                <span className="harness-badge workspace-badge" title={history || c.association === "resolved" ? c.cwd : undefined}>{workspaceLabel}</span>
                {membership?.workstreamId && <WorkstreamBadge workstreamId={membership.workstreamId} phases={membership.phases} />}
                {!phases.length && <StatusIcon status={c.status} />}
              </span>
              {!!phases.length && <span className="history-line">{phases.map(phase => <PhaseBadge key={phase} phase={phase} />)}<StatusIcon status={c.status} /></span>}
            </button>
            <ConversationMenu conversationId={c.id} hidden={c.hidden} disabled={state.actionBusy || !!c.replacedBy} />
          </div>;
        })}
      </section>;
    })}{!visible.length && <p className="muted history-empty">{history ? "No sessions in this selection." : "No conversations in this selection."}</p>}</nav>
  </>;
}
