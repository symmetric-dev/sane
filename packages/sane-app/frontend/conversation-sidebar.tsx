import { useState, useSyncExternalStore } from "react";
import { FiBell, FiGitBranch, FiUsers } from "react-icons/fi";
import { store, type State } from "./store";
import { AgentAvatar } from "./agent-visuals";
import { formatTitle } from "./conversation-filter";
import { ConversationFilterDialog } from "./conversation-filter-dialog";
import { ConversationMenu, PhaseBadge, StatusIcon, WorkstreamIcon } from "./conversation-row";
import { Icon } from "./nav";
import { workerReference as knownWorker } from "./worker-client";
import { notificationStore } from "./notifications";
import type { ConversationSidebarMode, ConversationSidebarModel } from "./conversation-sidebar-model";
import { conversationSidebarBinding, conversationSidebarGroups, type WorktreeBucket } from "./conversation-sidebar-buckets";
import { CHAT_WORKTREE_SHORTCUTS, shortcutHint } from "./shortcut-definitions";
import type { Conversation } from "./types";
import { worktreeDisplay } from "./catalog-selector";
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
  onHistory: (id: string) => void;
  onConnect?: (id: string) => void;
  canConnect?: (conversation: Conversation) => boolean;
};

/** The shell renders its selector before this component. History selection is preview-only. */
export function ConversationSidebar({ state, model, mode, selectedId, onChoose, onPreview, onHistory, onConnect, canConnect }: ConversationSidebarProps) {
  return <ConversationSidebarList state={state} model={model} mode={mode} selectedId={selectedId} onSelect={mode === "history" ? onPreview : onChoose} onHistory={onHistory} onConnect={onConnect} canConnect={canConnect} />;
}

/** Shared list presentation also supports legacy callers without another data hook. */
export function ConversationSidebarList({ state, model, mode, selectedId, onSelect, onHistory, onConnect, canConnect }: {
  state: State; model: ConversationSidebarModel; mode: ConversationSidebarMode; selectedId: string | null; onSelect: (id: string) => void;
  onHistory?: (id: string) => void;
  onConnect?: (id: string) => void;
  canConnect?: (conversation: Conversation) => boolean;
}) {
  const { repository, nav, filter, setFilter, workspaceSelection, overview, workstreamMap, membershipLoading, membershipPending, membershipError, visible, hits, messageHitsLoading, messageHitsError, page, workerCounts, scoped, activeFilterCount, grouped, isWorktreeExpanded, setWorktreeExpanded } = model;
  // Dialog visibility is presentation-local: opening the drawer must not create two modal dialogs.
  const [dialogOpen, setDialogOpen] = useState(false);
  const notifications = useSyncExternalStore(notificationStore.subscribe, notificationStore.snapshot);
  const unreadSessions = new Set(notifications.items.map(item => item.conversationId));
  // Notification sources are hydrated independently of sidebar pages. A closed
  // panel must retain its unread badge without loading any conversation rows.
  const unreadWorktrees = new Set(notifications.items.map(item => conversationSidebarBinding(item, repository.workspaces).key));
  const history = mode === "history";
  const hasQuery = !!filter.query.trim() || model.searching;
  const listBusy = !!page?.loading || model.directoryLoading || membershipPending && !membershipError;
  const listError = page?.error || membershipError;
  const emptyLabel = listBusy ? "Loading conversations…" : listError ? "Conversations could not be loaded." : messageHitsLoading
    ? "Searching messages…" : messageHitsError ? "Message matches could not be fully loaded."
    : page?.hasMore ? "No conversations loaded in this worktree yet. Load more to continue." : history ? "No sessions in this selection." : "No conversations in this selection.";
  const bucketGroups = conversationSidebarGroups(model, mode, selectedId);
  const shortcutBuckets = bucketGroups.flatMap(group => group.buckets).slice(0, 9);

  const toggleBucket = (key: string, currentExpanded: boolean) => {
    setWorktreeExpanded(key, !currentExpanded);
  };

  const selectBucket = (bucket: WorktreeBucket, currentExpanded: boolean) => {
    if (!history && bucket.available && bucket.workspaceId && bucket.worktreeId) {
      setWorktreeExpanded(bucket.key, true);
      workspaceSelection.selectWorktree(bucket.worktreeId, bucket.workspaceId);
      return;
    }
    toggleBucket(bucket.key, currentExpanded);
  };

  const newInBucket = (bucket: WorktreeBucket) => {
    if (!bucket.available || !bucket.worktreeId) return;
    setWorktreeExpanded(bucket.key, true);
    if (bucket.workspaceId) workspaceSelection.selectWorktree(bucket.worktreeId, bucket.workspaceId);
    onSelect("");
  };

  let renderedBuckets = 0;
  const locationLabel = (conversation: Conversation) => {
    const workspace = repository.workspaces.find(workspace => workspace.workspaceId === conversation.workspaceId);
    const tree = workspace?.worktrees.find(tree => tree.worktreeId === conversation.worktreeId);
    return `${workspace?.name ?? "Unavailable workspace"} · ${tree ? worktreeDisplay(tree) : "Unavailable worktree"}`;
  };
  const renderConversation = (c: Conversation, showLocation = false) => {
    const membership = workstreamMap.get(c.id);
    const workstreamLoading = membershipLoading && c.workspaceId === nav.workspaceId;
    const selected = selectedId === c.id;
    const phases = membership?.phases ?? [];
    const workerCount = workerCounts.get(c.id) ?? 0;
    const profile = store.profileFor(c);
    const showConnect = !history && !!onConnect && !c.replacedBy && !c.worker && c.agentKind !== "worker" && !knownWorker(c.id);
    const connectDisabled = state.sending || state.actionBusy || canConnect?.(c) === false;
    return <div className="history-row conversation-sidebar-row" key={c.id}>
      <button type="button" className={selected ? "selected" : ""} aria-current={selected ? "page" : undefined} disabled={!history && state.sending} onClick={() => onSelect(c.id)} title={c.title ? `${c.title}\n${c.cwd}` : c.cwd}>
        <span className="history-line conversation-sidebar-heading">
          {profile && <span className="agent-row-avatar" title={profile.label}><AgentAvatar profile={profile} size={16} /></span>}
          <span className="history-title">{formatTitle(c.title, basename(c.cwd))}</span>
          {unreadSessions.has(c.id) && <span className="conversation-sidebar-unread"><FiBell size={13} aria-hidden="true" /><span className="sr-only">Unread update</span></span>}
        </span>
        <span className="history-line conversation-sidebar-footer">
          <span className="conversation-sidebar-metadata" aria-busy={workstreamLoading}>
            {membership?.workstreamId ? history && <WorkstreamIcon workstreamId={membership.workstreamId} /> : workstreamLoading && <span role="status" title="Loading workstream…"><span className="conversation-sidebar-loading-dots" aria-hidden="true">…</span><span className="sr-only">Loading workstream</span></span>}
            {phases.map(phase => <PhaseBadge key={phase} phase={phase} />)}
            {showLocation && <span className="conversation-sidebar-location" title={locationLabel(c)}>{locationLabel(c)}</span>}
            {!history && workerCount > 0 && <span className="history-workers" title={`${workerCount} direct workers`}><FiUsers size={12} aria-hidden="true" /><span aria-hidden="true">{workerCount}</span><span className="sr-only">{workerCount} direct workers</span></span>}
            {history && knownWorker(c.id) && <span className="harness-badge">Worker</span>}
            {history && c.replacedBy ? <span className="harness-badge">Replaced</span> : c.hidden && <span className="harness-badge">Hidden</span>}
            {history && c.branchOrigin && <span className="harness-badge">Branch</span>}
          </span>
          <StatusIcon status={c.status} protocol={c.workerProtocol} />
        </span>
      </button>
      <ConversationMenu conversationId={c.id} hidden={c.hidden} disabled={state.actionBusy || !!c.replacedBy} metadataDisabled={!!c.replacedBy} onHistory={onHistory ?? (history ? onSelect : undefined)} onConnect={showConnect ? onConnect : undefined} connectDisabled={connectDisabled} />
    </div>;
  };

  return <>
    <div className="history-search-row">
      <label className="history-search"><span className="sr-only">{history ? "Search sessions" : "Search conversations"}</span><input value={filter.query} onChange={e => setFilter({ ...filter, query: e.target.value })} placeholder={history ? "Search sessions" : "Search conversations"} maxLength={200} /></label>
      <button type="button" className="history-filter-button" aria-label={history ? "Open session filters" : "Open conversation filters"} title={history ? "Filter sessions" : "Filter conversations"} onClick={() => setDialogOpen(true)}>Filter{activeFilterCount ? ` · ${activeFilterCount}` : ""}</button>
    </div>
    {dialogOpen && <ConversationFilterDialog value={filter} onChange={setFilter} defaults={model.defaults} workspaces={repository.workspaces} navigation={nav} overview={overview} resultCount={grouped ? model.directoryReady ? bucketGroups.reduce((total, group) => total + group.buckets.reduce((sum, bucket) => sum + (bucket.total ?? 0), 0), 0) : undefined : visible.length} partialResults={!grouped && !!page} onClose={() => setDialogOpen(false)} />}
    {!!hits.length && <div className="history-hits" aria-label="Message matches"><p className="muted">Message matches · best effort</p>{hits.slice(0, 3).map((hit, index) => {
      const conversation = state.conversations.find(c => c.id === hit.sessionId);
      return <button key={`${hit.sessionId}:${hit.runId ?? "title"}:${index}`} type="button" className="history-hit" disabled={!history && state.sending} onClick={() => onSelect(hit.sessionId)} title={conversation?.title ? `${conversation.title}\n${conversation.cwd}` : conversation?.cwd || hit.sessionId}><span>{formatTitle(conversation?.title, basename(conversation?.cwd))}</span>{conversation && <small className="muted">{locationLabel(conversation)}</small>}<small className="muted"> {hit.snippet}</small></button>;
    })}</div>}
    {messageHitsLoading && <p className="muted conversation-sidebar-search-status" role="status">Searching messages…</p>}
    {messageHitsError && <p className="muted conversation-sidebar-search-status" role="status">{messageHitsError}</p>}
    <nav className="history-list conversation-sidebar-list" aria-label={history ? "Sessions" : "Conversation history"} aria-busy={listBusy || !!page?.loadingMore}>
      {grouped && !hasQuery && (model.directoryLoading || model.directoryError) && <div className="conversation-sidebar-pagination" aria-label="Worktree directory status">
        {model.directoryLoading && <p className="muted" role="status">Loading worktrees…</p>}
        {model.directoryError && <><p className="notice error" role="alert">{model.directoryError}</p><button type="button" onClick={() => store.retryConversationGroups()}>Retry loading worktrees</button></>}
      </div>}
      {hasQuery ? <div className="conversation-sidebar-search-results" aria-label="Search results">{!grouped && visible.map(conversation => renderConversation(conversation, true))}{(grouped || !visible.length) && <p className="muted history-empty" role="status">{grouped ? "Searching conversations…" : emptyLabel}</p>}</div> : bucketGroups.map(group => {
      const { buckets } = group;
      renderedBuckets += buckets.length;
      return <section className="history-group" key={group.id ?? "unavailable"}>
        {(history || !scoped) && <h3>{group.name}</h3>}
        {buckets.map(bucket => {
          const isCurrentWorktree = !!bucket.workspaceId && bucket.workspaceId === nav.workspaceId && !!bucket.worktreeId && bucket.worktreeId === nav.worktreeId;
          const expanded = isWorktreeExpanded(bucket.key);
          const groupPage = grouped ? model.groupPage(bucket) : undefined;
          const groupLoading = grouped && (!groupPage || groupPage.loading);
          const count = bucket.total ?? (grouped ? undefined : bucket.conversations.length);
          const hasUnread = unreadWorktrees.has(bucket.key);
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
                <FiGitBranch size={13} className="worktree-group-icon" aria-hidden="true" />
              </button>
              <button
                type="button"
                className={`worktree-group-select${isCurrentWorktree ? " is-active" : ""}`}
                aria-current={isCurrentWorktree ? "true" : undefined}
                disabled={!history && state.sending}
                title={shortcut ? `${bucket.title} · Select checkout (${shortcutHint(shortcut)})` : bucket.title}
                onClick={() => selectBucket(bucket, expanded)}
              >
                <span className="worktree-group-name">{bucket.label}</span>
                {!bucket.available && bucket.worktreeId && <span className="worktree-group-unavailable" title="Worktree directory missing or unavailable">Missing</span>}
                {hasUnread && <span className="conversation-sidebar-unread" title="Unread update in worktree"><FiBell size={12} aria-hidden="true" /><span className="sr-only">Unread update</span></span>}
                <span className="worktree-group-count" title={count === undefined ? "Conversation total unavailable" : !grouped && page ? "Loaded conversations" : "Matching conversations"} aria-label={count === undefined ? "Conversation total unavailable" : `${count} ${!grouped && page ? "loaded " : ""}${count === 1 ? "conversation" : "conversations"}`}>{count ?? "…"}</span>
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
            {expanded && <div className="worktree-group-items" aria-busy={groupLoading || !!groupPage?.loadingMore}>
              {bucket.conversations.map(conversation => renderConversation(conversation))}
              {bucket.pinned && <div className="worktree-group-current"><p className="muted worktree-group-current-label">Current conversation</p>{renderConversation(bucket.pinned)}</div>}
              {grouped ? <>
                {groupLoading && <p className="muted worktree-group-empty" role="status">Loading conversations…</p>}
                {groupPage?.error && <div className="worktree-group-pagination"><p className="notice error" role="alert">{groupPage.error}</p><button type="button" disabled={groupPage.loading || groupPage.loadingMore} onClick={() => store.retryConversationGroup(model.groupQuery(bucket))}>Retry loading conversations</button></div>}
                {!groupLoading && !groupPage?.error && !bucket.conversations.length && <p className="muted worktree-group-empty">{history ? "No sessions in this worktree." : "No conversations in this worktree."}</p>}
                {!groupPage?.error && <div className="worktree-group-pagination worktree-group-pagination-actions">
                  {groupPage?.hasMore && <button type="button" disabled={groupLoading || groupPage.loadingMore} onClick={() => { void store.loadMoreConversationGroup(model.groupQuery(bucket)); }}>{groupPage.loadingMore ? "Loading more…" : `Show ${model.groupQuery(bucket).limit} more`}<span className="sr-only"> in {bucket.label}</span></button>}
                  <button type="button" disabled={groupLoading || !!groupPage?.loadingMore} onClick={() => store.retryConversationGroup(model.groupQuery(bucket))} title={`Restart the conversation list in ${bucket.label}`} aria-label={`Refresh conversations in ${bucket.label}`}>Refresh</button>
                  {groupPage?.loadingMore && <span className="sr-only" role="status">Loading more conversations in {bucket.label}…</span>}
                </div>}
              </> : !bucket.conversations.length && <p className="muted worktree-group-empty">{page || messageHitsLoading || messageHitsError ? emptyLabel : membershipPending
                ? membershipError ? "Workstream membership is unavailable. Retrying…" : "Loading workstream membership…"
                : history ? "No sessions in this worktree." : "No conversations in this worktree."}</p>}
            </div>}
          </section>;
        })}
      </section>;
    })}{!hasQuery && !visible.length && !renderedBuckets && <p className="muted history-empty" role="status">{page || model.directoryLoading || model.directoryError || messageHitsLoading || messageHitsError ? model.directoryError ? "Worktrees could not be loaded." : emptyLabel : membershipPending
      ? membershipError ? "Workstream membership is unavailable. Retrying…" : "Loading workstream membership…"
      : history ? "No sessions in this selection." : "No conversations in this selection."}</p>}
      {page && hasQuery && <div className="conversation-sidebar-pagination" aria-label="Conversation pagination">
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
