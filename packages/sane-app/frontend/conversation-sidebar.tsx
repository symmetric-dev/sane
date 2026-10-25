import { useEffect, useState, useSyncExternalStore } from "react";
import { FiBell, FiChevronDown, FiChevronRight, FiGitBranch, FiUsers } from "react-icons/fi";
import { store, type State } from "./store";
import { AgentAvatar } from "./agent-visuals";
import { formatTitle } from "./conversation-filter";
import { ConversationFilterDialog } from "./conversation-filter-dialog";
import { ConversationMenu, PhaseBadge, StatusIcon } from "./conversation-row";
import { Icon } from "./nav";
import { workerReference as knownWorker } from "./worker-client";
import { notificationStore } from "./notifications";
import type { ConversationSidebarMode, ConversationSidebarModel } from "./conversation-sidebar-model";
import { conversationSidebarGroups, type WorktreeBucket } from "./conversation-sidebar-buckets";
import { CHAT_WORKTREE_SHORTCUTS, shortcutHint } from "./shortcut-definitions";
import "./conversation-sidebar.css";

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
  const { repository, nav, filter, setFilter, workspaceSelection, worktreeSelectionVersion, overview, workstreamMap, membershipLoading, membershipPending, membershipError, visible, hits, messageHitsLoading, messageHitsError, page, workerCounts, scoped, activeFilterCount } = model;
  // Dialog visibility is presentation-local: opening the drawer must not create two modal dialogs.
  const [dialogOpen, setDialogOpen] = useState(false);
  const [expandedWorktrees, setExpandedWorktrees] = useState<Record<string, boolean>>({});
  const notifications = useSyncExternalStore(notificationStore.subscribe, notificationStore.snapshot);
  const unreadSessions = new Set(notifications.items.map(item => item.conversationId));
  const history = mode === "history";
  const hasQuery = !!filter.query.trim();
  const listBusy = !!page?.loading || membershipPending && !membershipError;
  const listError = page?.error || membershipError;
  const emptyLabel = listBusy ? "Loading conversations…" : listError ? "Conversations could not be loaded." : messageHitsLoading
    ? "Searching messages…" : messageHitsError ? "Message matches could not be fully loaded."
    : page?.hasMore ? "No conversations loaded in this worktree yet. Load more to continue." : history ? "No sessions in this selection." : "No conversations in this selection.";
  const bucketGroups = conversationSidebarGroups(model, mode, selectedId);
  const shortcutBuckets = bucketGroups.flatMap(group => group.buckets).slice(0, 9);

  useEffect(() => {
    if (!nav.workspaceId || !nav.worktreeId) return;
    const key = `${nav.workspaceId}:${nav.worktreeId}`;
    if (history) setExpandedWorktrees(prev => prev[key] === false ? { ...prev, [key]: true } : prev);
    else setExpandedWorktrees({ [key]: true });
  }, [nav.workspaceId, nav.worktreeId, worktreeSelectionVersion, history]);

  const isExpanded = (bucket: WorktreeBucket, isCurrentWorktree: boolean, hasSelected: boolean) => {
    if (hasQuery && bucket.conversations.length > 0) return true;
    if (bucket.key in expandedWorktrees) return expandedWorktrees[bucket.key]!;
    return isCurrentWorktree || (history && (hasSelected || bucket.conversations.length > 0));
  };

  const toggleBucket = (key: string, currentExpanded: boolean) => {
    setExpandedWorktrees(prev => ({ ...prev, [key]: !currentExpanded }));
  };

  const selectBucket = (bucket: WorktreeBucket, currentExpanded: boolean) => {
    if (!history && bucket.available && bucket.workspaceId && bucket.worktreeId) {
      setExpandedWorktrees({ [bucket.key]: true });
      workspaceSelection.selectWorktree(bucket.worktreeId, bucket.workspaceId);
      return;
    }
    toggleBucket(bucket.key, currentExpanded);
  };

  const newInBucket = (bucket: WorktreeBucket) => {
    if (!bucket.available || !bucket.worktreeId) return;
    setExpandedWorktrees({ [bucket.key]: true });
    if (bucket.workspaceId) workspaceSelection.selectWorktree(bucket.worktreeId, bucket.workspaceId);
    onSelect("");
  };

  let renderedBuckets = 0;

  return <>
    <div className="history-search-row">
      <label className="history-search"><span className="sr-only">{history ? "Search sessions" : "Search conversations"}</span><input value={filter.query} onChange={e => setFilter({ ...filter, query: e.target.value })} placeholder={history ? "Search sessions" : "Search conversations"} maxLength={200} /></label>
      <button type="button" className="history-filter-button" aria-label={history ? "Open session filters" : "Open conversation filters"} title={history ? "Filter sessions" : "Filter conversations"} onClick={() => setDialogOpen(true)}>Filter{activeFilterCount ? ` · ${activeFilterCount}` : ""}</button>
    </div>
    {dialogOpen && <ConversationFilterDialog value={filter} onChange={setFilter} defaults={model.defaults} workspaces={repository.workspaces} navigation={nav} overview={overview} resultCount={visible.length} partialResults={!!page} onClose={() => setDialogOpen(false)} />}
    {!!hits.length && <div className="history-hits" aria-label="Message matches"><p className="muted">Message matches · best effort</p>{hits.slice(0, 3).map((hit, index) => {
      const conversation = state.conversations.find(c => c.id === hit.sessionId);
      return <button key={`${hit.sessionId}:${hit.runId ?? "title"}:${index}`} type="button" className="history-hit" disabled={!history && state.sending} onClick={() => onSelect(hit.sessionId)} title={conversation?.title ? `${conversation.title}\n${conversation.cwd}` : conversation?.cwd || hit.sessionId}><span>{formatTitle(conversation?.title, basename(conversation?.cwd))}</span><small className="muted"> {hit.snippet}</small></button>;
    })}</div>}
    {messageHitsLoading && <p className="muted conversation-sidebar-search-status" role="status">Searching messages…</p>}
    {messageHitsError && <p className="muted conversation-sidebar-search-status" role="status">{messageHitsError}</p>}
    <nav className="history-list conversation-sidebar-list" aria-label={history ? "Sessions" : "Conversation history"} aria-busy={listBusy || !!page?.loadingMore}>{bucketGroups.map(group => {
      const { buckets } = group;
      renderedBuckets += buckets.length;
      return <section className="history-group" key={group.id ?? "unavailable"}>
        {(history || !scoped) && <h3>{group.name}</h3>}
        {buckets.map(bucket => {
          const isCurrentWorktree = !!bucket.workspaceId && bucket.workspaceId === nav.workspaceId && !!bucket.worktreeId && bucket.worktreeId === nav.worktreeId;
          const hasSelected = !!selectedId && bucket.conversations.some(c => c.id === selectedId);
          const expanded = isExpanded(bucket, isCurrentWorktree, hasSelected);
          const hasUnread = bucket.conversations.some(c => unreadSessions.has(c.id));
          const shortcut = !history && nav.view === "chat" && bucket.available ? CHAT_WORKTREE_SHORTCUTS[shortcutBuckets.indexOf(bucket)] : undefined;
          return <section className={`worktree-group${isCurrentWorktree ? " is-active" : ""}`} key={bucket.key} aria-label={`Worktree ${bucket.label}`}>
            <div className={`worktree-group-header${isCurrentWorktree ? " is-active" : ""}`}>
              <button
                type="button"
                className="worktree-group-toggle"
                aria-expanded={expanded}
                aria-label={`${expanded ? "Collapse" : "Expand"} ${bucket.label}`}
                title={expanded ? `Collapse ${bucket.label}` : `Expand ${bucket.label}`}
                onClick={() => toggleBucket(bucket.key, expanded)}
              >
                {expanded ? <FiChevronDown size={13} aria-hidden="true" /> : <FiChevronRight size={13} aria-hidden="true" />}
              </button>
              <button
                type="button"
                className={`worktree-group-select${isCurrentWorktree ? " is-active" : ""}`}
                aria-current={isCurrentWorktree ? "true" : undefined}
                disabled={!history && state.sending}
                title={shortcut ? `${bucket.title} · Open latest conversation (${shortcutHint(shortcut)})` : bucket.title}
                onClick={() => selectBucket(bucket, expanded)}
              >
                <FiGitBranch size={13} className="worktree-group-icon" aria-hidden="true" />
                <span className="worktree-group-name">{bucket.label}</span>
                {!bucket.available && bucket.worktreeId && <span className="worktree-group-unavailable" title="Worktree directory missing or unavailable">Missing</span>}
                {hasUnread && <span className="conversation-sidebar-unread" title="Unread update in worktree"><FiBell size={12} aria-hidden="true" /><span className="sr-only">Unread update</span></span>}
                <span className="worktree-group-count" title={page ? "Loaded conversations" : undefined} aria-label={`${bucket.conversations.length} ${page ? "loaded " : ""}${bucket.conversations.length === 1 ? "conversation" : "conversations"}`}>{bucket.conversations.length}</span>
              </button>
              {!history && bucket.available && bucket.worktreeId && (
                <button
                  type="button"
                  className="worktree-group-new"
                  disabled={state.sending}
                  aria-label={`New conversation in ${bucket.label}`}
                  title={`New conversation in ${bucket.label}`}
                  onClick={() => newInBucket(bucket)}
                >
                  <Icon name="plus" />
                </button>
              )}
            </div>
            {expanded && <div className="worktree-group-items">
              {bucket.conversations.map(c => {
                const membership = workstreamMap.get(c.id);
                const workstreamLoading = membershipLoading && c.workspaceId === nav.workspaceId;
                const selected = selectedId === c.id;
                const phases = membership?.phases ?? [];
                const workerCount = workerCounts.get(c.id) ?? 0;
                const profile = store.profileFor(c);
                return <div className="history-row conversation-sidebar-row" key={c.id}>
                  <button type="button" className={selected ? "selected" : ""} aria-current={selected ? "page" : undefined} disabled={!history && state.sending} onClick={() => onSelect(c.id)} title={c.title ? `${c.title}\n${c.cwd}` : c.cwd}>
                    <span className="history-line conversation-sidebar-heading">
                      {profile && <span className="agent-row-avatar" title={profile.label}><AgentAvatar profile={profile} size={16} /></span>}
                      <span className="history-title">{formatTitle(c.title, basename(c.cwd))}</span>
                      {unreadSessions.has(c.id) && <span className="conversation-sidebar-unread"><FiBell size={13} aria-hidden="true" /><span className="sr-only">Unread update</span></span>}
                    </span>
                    <span className="history-line conversation-sidebar-workstream" title={workstreamLoading ? "Loading workstream…" : membership?.workstreamId ?? undefined} aria-busy={workstreamLoading}>{workstreamLoading ? <><span className="conversation-sidebar-loading-dots" aria-hidden="true">…</span><span className="sr-only">Loading workstream</span></> : membership?.workstreamId || "-"}</span>
                    <span className="history-line conversation-sidebar-footer">
                      <span className="conversation-sidebar-metadata">
                        {phases.map(phase => <PhaseBadge key={phase} phase={phase} />)}
                        {!history && workerCount > 0 && <span className="history-workers" title={`${workerCount} direct workers`}><FiUsers size={12} aria-hidden="true" /><span aria-hidden="true">{workerCount}</span><span className="sr-only">{workerCount} direct workers</span></span>}
                        {history && knownWorker(c.id) && <span className="harness-badge">Worker</span>}
                        {history && c.replacedBy ? <span className="harness-badge">Replaced</span> : c.hidden && <span className="harness-badge">Hidden</span>}
                        {history && c.branchOrigin && <span className="harness-badge">Branch</span>}
                      </span>
                      <StatusIcon status={c.status} protocol={c.workerProtocol} />
                    </span>
                  </button>
                  <ConversationMenu conversationId={c.id} hidden={c.hidden} disabled={state.actionBusy || !!c.replacedBy} />
                </div>;
              })}
              {!bucket.conversations.length && <p className="muted worktree-group-empty">{page || messageHitsLoading || messageHitsError ? emptyLabel : membershipPending
                ? membershipError ? "Workstream membership is unavailable. Retrying…" : "Loading workstream membership…"
                : history ? "No sessions in this worktree." : "No conversations in this worktree."}</p>}
            </div>}
          </section>;
        })}
      </section>;
    })}{!visible.length && !renderedBuckets && <p className="muted history-empty" role="status">{page || messageHitsLoading || messageHitsError ? emptyLabel : membershipPending
      ? membershipError ? "Workstream membership is unavailable. Retrying…" : "Loading workstream membership…"
      : history ? "No sessions in this selection." : "No conversations in this selection."}</p>}
      {page && <div className="conversation-sidebar-pagination" aria-label="Conversation pagination">
        <p className="muted" role="status" aria-live="polite">{page.loading ? "Loading conversations…" : `${visible.length} loaded ${history ? "sessions" : "conversations"}`}</p>
        {page.error && <p className="notice error" role="alert">{page.error}</p>}
         {page.error ? <button type="button" disabled={page.loading || page.loadingMore} onClick={() => store.retryConversations()}>Retry loading conversations</button>
           : page.hasMore && <button type="button" disabled={page.loading || page.loadingMore} onClick={() => { void store.loadMoreConversations(); }}>{page.loadingMore ? "Loading more…" : "Load more conversations"}</button>}
         {!page.error && <button type="button" disabled={page.loading || page.loadingMore} onClick={() => store.retryConversations()} title="Start a fresh conversation list with the current filters">Refresh list</button>}
        {page.loadingMore && <span className="sr-only" role="status">Loading more conversations…</span>}
      </div>}
    </nav>
  </>;
}
