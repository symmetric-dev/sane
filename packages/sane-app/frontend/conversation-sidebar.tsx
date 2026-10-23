import { useEffect, useState, useSyncExternalStore } from "react";
import { FiBell, FiChevronDown, FiChevronRight, FiGitBranch, FiTrash2, FiUsers } from "react-icons/fi";
import { catalog } from "./catalog";
import { store, type State } from "./store";
import { AgentAvatar } from "./agent-visuals";
import { worktreeDisplay, worktreeLabel } from "./catalog-selector";
import { formatTitle } from "./conversation-filter";
import { ConversationFilterDialog } from "./conversation-filter-dialog";
import { ConversationMenu, PhaseBadge, StatusIcon } from "./conversation-row";
import { Icon } from "./nav";
import { ShellDialog } from "./shell-dialog";
import { workerReference as knownWorker } from "./worker-client";
import { notificationStore } from "./notifications";
import type { Conversation } from "./types";
import type { ConversationSidebarMode, ConversationSidebarModel } from "./conversation-sidebar-model";
import "./conversation-sidebar.css";

export { useConversationSidebarModel } from "./conversation-sidebar-model";
export type { ConversationSidebarMode, ConversationSidebarModel } from "./conversation-sidebar-model";

const basename = (path?: string | null) => path?.split("/").filter(Boolean).at(-1) || path || "Conversation";

type WorktreeBucket = {
  key: string;
  workspaceId: string | null;
  worktreeId: string | null;
  label: string;
  root?: string;
  title?: string;
  available: boolean;
  removable: boolean;
  conversations: Conversation[];
};

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
  const { repository, nav, filter, setFilter, workspaceSelection, worktreeSelectionVersion, overview, workstreamMap, membershipLoading, membershipPending, membershipError, visible, hits, workerCounts, groups, scoped, activeFilterCount } = model;
  // Dialog visibility is presentation-local: opening the drawer must not create two modal dialogs.
  const [dialogOpen, setDialogOpen] = useState(false);
  const [expandedWorktrees, setExpandedWorktrees] = useState<Record<string, boolean>>({});
  const [removingBucket, setRemovingBucket] = useState<WorktreeBucket | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const [removeNeedsForce, setRemoveNeedsForce] = useState(false);
  const notifications = useSyncExternalStore(notificationStore.subscribe, notificationStore.snapshot);
  const unreadSessions = new Set(notifications.items.map(item => item.conversationId));
  const history = mode === "history";
  const hasQuery = !!filter.query.trim();
  const filteredWorktreeId = filter.worktreeId !== "all" && filter.worktreeId !== null ? filter.worktreeId : null;

  useEffect(() => {
    if (!nav.workspaceId || !nav.worktreeId) return;
    const key = `${nav.workspaceId}:${nav.worktreeId}`;
    if (history) setExpandedWorktrees(prev => prev[key] === false ? { ...prev, [key]: true } : prev);
    else setExpandedWorktrees({ [key]: true });
  }, [nav.workspaceId, nav.worktreeId, worktreeSelectionVersion, history]);

  const buildBuckets = (groupId: string | null, groupConversations: Conversation[]): WorktreeBucket[] => {
    const workspace = groupId ? repository.workspaces.find(w => w.workspaceId === groupId) : undefined;
    if (!workspace) {
      if (!groupConversations.length) return [];
      return [{
        key: "unavailable:unavailable",
        workspaceId: null,
        worktreeId: null,
        label: "Unavailable worktree",
        title: "Recorded history without an available worktree",
        available: false,
        removable: false,
        conversations: groupConversations,
      }];
    }
    const isCurrentWorkspace = workspace.workspaceId === nav.workspaceId;
    const buckets: WorktreeBucket[] = [];
    for (const tree of workspace.worktrees) {
      if (filteredWorktreeId && tree.worktreeId !== filteredWorktreeId) continue;
      const treeConversations = groupConversations.filter(c => c.worktreeId === tree.worktreeId);
      const isCurrentWorktree = isCurrentWorkspace && tree.worktreeId === nav.worktreeId;
      if (!treeConversations.length && !(isCurrentWorkspace && !hasQuery) && !isCurrentWorktree) continue;
      const removable = workspace.kind === "repository" && workspace.worktrees.length > 1 && tree.gitDir !== workspace.commonDir;
      buckets.push({
        key: `${workspace.workspaceId}:${tree.worktreeId}`,
        workspaceId: workspace.workspaceId,
        worktreeId: tree.worktreeId,
        label: worktreeDisplay(tree),
        root: tree.root,
        title: `${worktreeLabel(tree)} · ${tree.root}${tree.state !== "available" ? " (Unavailable)" : ""}`,
        available: tree.state === "available",
        removable,
        conversations: treeConversations,
      });
    }
    const unmatched = groupConversations.filter(c => !workspace.worktrees.some(t => t.worktreeId === c.worktreeId));
    const showUnmatched = history || (!!selectedId && unmatched.some(c => c.id === selectedId));
    if (showUnmatched && unmatched.length && (!filteredWorktreeId || unmatched.some(c => c.worktreeId === filteredWorktreeId))) {
      buckets.push({
        key: `${workspace.workspaceId}:unavailable`,
        workspaceId: workspace.workspaceId,
        worktreeId: null,
        label: "Unavailable worktree",
        title: "Conversations from an unavailable or removed worktree",
        available: false,
        removable: false,
        conversations: unmatched,
      });
    }
    return buckets;
  };

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

  const openRemoveDialog = (bucket: WorktreeBucket) => {
    setRemovingBucket(bucket);
    setRemoveBusy(false);
    setRemoveError("");
    setRemoveNeedsForce(false);
  };

  const confirmRemoveBucket = async (force: boolean) => {
    if (!removingBucket?.workspaceId || !removingBucket.worktreeId || removeBusy) return;
    setRemoveBusy(true);
    setRemoveError("");
    const result = await catalog.removeWorktree(removingBucket.workspaceId, removingBucket.worktreeId, force);
    setRemoveBusy(false);
    if (result.ok) {
      setRemovingBucket(null);
      setRemoveNeedsForce(false);
      return;
    }
    setRemoveError(result.error);
    if (result.code === "worktree-dirty") setRemoveNeedsForce(true);
  };

  let renderedBuckets = 0;

  return <>
    <div className="history-search-row">
      <label className="history-search"><span className="sr-only">{history ? "Search sessions" : "Search conversations"}</span><input value={filter.query} onChange={e => setFilter({ ...filter, query: e.target.value })} placeholder={history ? "Search sessions" : "Search conversations"} maxLength={200} /></label>
      <button type="button" className="history-filter-button" aria-label={history ? "Open session filters" : "Open conversation filters"} title={history ? "Filter sessions" : "Filter conversations"} onClick={() => setDialogOpen(true)}>Filter{activeFilterCount ? ` · ${activeFilterCount}` : ""}</button>
    </div>
    {dialogOpen && <ConversationFilterDialog value={filter} onChange={setFilter} defaults={model.defaults} workspaces={repository.workspaces} navigation={nav} overview={overview} resultCount={visible.length} onClose={() => setDialogOpen(false)} />}
    {removingBucket && <ShellDialog title="Remove worktree" closeDisabled={removeBusy} close={() => { if (!removeBusy) setRemovingBucket(null); }}>
      <div className="worktree-remove-dialog">
        <p><strong>{removingBucket.label}</strong></p>
        {removingBucket.root && <p className="context-path">{removingBucket.root}</p>}
        {removingBucket.available
          ? <p className="muted">Removes this linked worktree checkout directory on disk (<code>git worktree remove</code>) and unregisters it from SANE. Committed branches and recorded conversation history are kept.</p>
          : <p className="muted">This worktree directory is already missing or unavailable on disk. Removing it will prune its stale Git worktree metadata (<code>git worktree prune</code>) and remove it from SANE. Recorded conversation history is kept.</p>}
        {removeError && <p className="notice error" role="alert">{removeError}</p>}
        <div className="dialog-actions">
          <button type="button" disabled={removeBusy} onClick={() => setRemovingBucket(null)}>Cancel</button>
          {removeNeedsForce && <button type="button" className="worktree-remove-confirm" disabled={removeBusy} onClick={() => void confirmRemoveBucket(true)}>{removeBusy ? "Removing…" : "Force remove (discard uncommitted files)"}</button>}
          {!removeNeedsForce && <button type="button" className="worktree-remove-confirm" disabled={removeBusy} onClick={() => void confirmRemoveBucket(false)}>{removeBusy ? "Removing…" : "Remove worktree"}</button>}
        </div>
      </div>
    </ShellDialog>}
    {!!hits.length && <div className="history-hits" aria-label="Message matches"><p className="muted">Message matches · best effort</p>{hits.slice(0, 3).map((hit, index) => {
      const conversation = state.conversations.find(c => c.id === hit.sessionId);
      return <button key={`${hit.sessionId}:${hit.runId ?? "title"}:${index}`} type="button" className="history-hit" disabled={!history && state.sending} onClick={() => onSelect(hit.sessionId)} title={conversation?.title ? `${conversation.title}\n${conversation.cwd}` : conversation?.cwd || hit.sessionId}><span>{formatTitle(conversation?.title, basename(conversation?.cwd))}</span><small className="muted"> {hit.snippet}</small></button>;
    })}</div>}
    <nav className="history-list conversation-sidebar-list" aria-label={history ? "Sessions" : "Conversation history"} aria-busy={membershipPending && !membershipError}>{groups.map(group => {
      if (filter.workspaceId === "unavailable" && group.id !== null) return null;
      if (scoped && group.id !== filter.workspaceId) return null;
      const groupConversations = visible.filter(c => group.id ? c.workspaceId === group.id : !c.workspaceId || !repository.workspaces.some(w => w.workspaceId === c.workspaceId));
      const buckets = buildBuckets(group.id, groupConversations);
      if (!buckets.length) return null;
      renderedBuckets += buckets.length;
      return <section className="history-group" key={group.id ?? "unavailable"}>
        {(history || !scoped) && <h3>{group.name}</h3>}
        {buckets.map(bucket => {
          const isCurrentWorktree = !!bucket.workspaceId && bucket.workspaceId === nav.workspaceId && !!bucket.worktreeId && bucket.worktreeId === nav.worktreeId;
          const hasSelected = !!selectedId && bucket.conversations.some(c => c.id === selectedId);
          const expanded = isExpanded(bucket, isCurrentWorktree, hasSelected);
          const hasUnread = bucket.conversations.some(c => unreadSessions.has(c.id));
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
                title={bucket.title}
                onClick={() => selectBucket(bucket, expanded)}
              >
                <FiGitBranch size={13} className="worktree-group-icon" aria-hidden="true" />
                <span className="worktree-group-name">{bucket.label}</span>
                {!bucket.available && bucket.worktreeId && <span className="worktree-group-unavailable" title="Worktree directory missing or unavailable">Missing</span>}
                {hasUnread && <span className="conversation-sidebar-unread" title="Unread update in worktree"><FiBell size={12} aria-hidden="true" /><span className="sr-only">Unread update</span></span>}
                <span className="worktree-group-count" aria-label={`${bucket.conversations.length} ${bucket.conversations.length === 1 ? "conversation" : "conversations"}`}>{bucket.conversations.length}</span>
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
              {!history && bucket.removable && (
                <button
                  type="button"
                  className="worktree-group-remove"
                  disabled={state.sending}
                  aria-label={`Remove worktree ${bucket.label}`}
                  title={`Remove worktree ${bucket.label}`}
                  onClick={() => openRemoveDialog(bucket)}
                >
                  <FiTrash2 size={12} aria-hidden="true" />
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
              {!bucket.conversations.length && <p className="muted worktree-group-empty">{membershipPending
                ? membershipError ? "Workstream membership is unavailable. Retrying…" : "Loading workstream membership…"
                : history ? "No sessions in this worktree." : "No conversations in this worktree."}</p>}
            </div>}
          </section>;
        })}
      </section>;
    })}{!visible.length && !renderedBuckets && <p className="muted history-empty" role="status">{membershipPending
      ? membershipError ? "Workstream membership is unavailable. Retrying…" : "Loading workstream membership…"
      : history ? "No sessions in this selection." : "No conversations in this selection."}</p>}</nav>
  </>;
}
