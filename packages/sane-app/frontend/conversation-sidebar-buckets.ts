import { worktreeDisplay, worktreeLabel } from "./catalog-selector";
import { compareConversationActivity } from "./conversation-activity";
import type { ConversationSidebarMode, ConversationSidebarModel } from "./conversation-sidebar-model";
import type { Conversation } from "./types";
import type { WorkspaceRecord } from "../src/catalog-contract";
import type { SessionCatalogGroup } from "../shared/conversation/session-catalog";
import type { ConversationFilterState } from "./conversation-filter";

export type WorktreeBucket = {
  key: string;
  workspaceId: string | null;
  worktreeId: string | null;
  label: string;
  root?: string;
  title?: string;
  available: boolean;
  conversations: Conversation[];
  total?: number;
  pinned?: Conversation;
};

/** Source bindings stay immutable; only sidebar grouping normalizes unknown IDs. */
export function conversationSidebarBinding(conversation: Pick<Conversation, "workspaceId" | "worktreeId">, workspaces: WorkspaceRecord[]) {
  const workspace = workspaces.find(workspace => workspace.workspaceId === conversation.workspaceId);
  const workspaceId = workspace?.workspaceId ?? null;
  const worktreeId = workspace?.worktrees.find(tree => tree.worktreeId === conversation.worktreeId)?.worktreeId ?? null;
  return { workspaceId, worktreeId, key: `${workspaceId ?? "unavailable"}:${worktreeId ?? "unavailable"}` };
}

/** Directory order follows the catalog, never the newest conversation in a page. */
export function conversationSidebarBucketDirectory(workspaces: WorkspaceRecord[], currentWorkspaceId: string | null, filter: ConversationFilterState, directory: SessionCatalogGroup[], ready: boolean) {
  const workspaceGroups = [...workspaces.map(workspace => ({ id: workspace.workspaceId as string | null, name: workspace.name })), { id: null, name: "Unavailable workspace · recorded history" }]
    .sort((a, b) => Number(b.id === currentWorkspaceId) - Number(a.id === currentWorkspaceId));
  return workspaceGroups.flatMap(group => {
    if (filter.workspaceId === "unavailable" ? group.id !== null : filter.workspaceId && filter.workspaceId !== "all" && group.id !== filter.workspaceId) return [];
    const workspace = workspaces.find(workspace => workspace.workspaceId === group.id);
    const entries = directory.filter(entry => entry.workspaceId === group.id);
    const buckets: WorktreeBucket[] = [];
    const matchesTree = (id: string | null) => !filter.worktreeId || filter.worktreeId === "all" || filter.worktreeId === (id ?? "unavailable");
    for (const tree of workspace?.worktrees ?? []) {
      if (!matchesTree(tree.worktreeId)) continue;
      const entry = entries.find(entry => entry.worktreeId === tree.worktreeId);
      if (!entry && workspace?.workspaceId !== currentWorkspaceId) continue;
      buckets.push({ key: `${group.id}:${tree.worktreeId}`, workspaceId: group.id, worktreeId: tree.worktreeId,
        label: worktreeDisplay(tree), root: tree.root, title: `${worktreeLabel(tree)} · ${tree.root}${tree.state !== "available" ? " (Unavailable)" : ""}`,
        available: tree.state === "available", conversations: [], total: entry?.total ?? (ready ? 0 : undefined) });
    }
    for (const entry of [...entries].sort((a, b) => (a.worktreeId ?? "").localeCompare(b.worktreeId ?? ""))) {
      if (!matchesTree(entry.worktreeId) || buckets.some(bucket => bucket.worktreeId === entry.worktreeId)) continue;
      buckets.push({ key: `${group.id ?? "unavailable"}:${entry.worktreeId ?? "unavailable"}`, workspaceId: group.id, worktreeId: entry.worktreeId,
        label: "Unavailable worktree", title: "Conversations from an unavailable or removed worktree", available: false, conversations: [], total: entry.total });
    }
    return buckets.length ? [{ ...group, buckets }] : [];
  });
}

/** Shared by sidebar rendering and numbered navigation; unavailable rows keep their positions. */
export function conversationSidebarGroups(model: ConversationSidebarModel, mode: ConversationSidebarMode, selectedId: string | null) {
  const { repository, nav, filter, visible, groups, scoped } = model;
  if (model.grouped) {
    const known = new Map(model.visible.map(conversation => [conversation.id, conversation]));
    const selected = model.pinCandidates.find(conversation => conversation.id === selectedId);
    const selectedBinding = selected ? conversationSidebarBinding(selected, repository.workspaces) : undefined;
    return model.bucketDirectory.map(group => ({ ...group, buckets: group.buckets.map(bucket => {
      const page = model.groupPage(bucket);
      const conversations = page?.ids.flatMap(id => {
        const conversation = known.get(id);
        return conversation && conversationSidebarBinding(conversation, repository.workspaces).key === bucket.key ? [conversation] : [];
      }) ?? [];
      const pinned = selected && selectedBinding?.key === bucket.key && !conversations.some(conversation => conversation.id === selected.id) ? selected : undefined;
      return { ...bucket, conversations, pinned };
    }) }));
  }
  const hasQuery = !!filter.query.trim();
  const filteredWorktreeId = filter.worktreeId !== "all" && filter.worktreeId !== null ? filter.worktreeId : null;
  return groups.flatMap(group => {
    if (filter.workspaceId === "unavailable" && group.id !== null) return [];
    if (scoped && group.id !== filter.workspaceId) return [];
    const conversations = visible.filter(c => group.id ? c.workspaceId === group.id : !c.workspaceId || !repository.workspaces.some(w => w.workspaceId === c.workspaceId)).sort(compareConversationActivity);
    const workspace = group.id ? repository.workspaces.find(w => w.workspaceId === group.id) : undefined;
    const buckets: WorktreeBucket[] = [];
    if (!workspace) {
      if (conversations.length) buckets.push({
        key: "unavailable:unavailable", workspaceId: null, worktreeId: null,
        label: "Unavailable worktree", title: "Recorded history without an available worktree",
        available: false, conversations,
      });
    } else {
      const isCurrentWorkspace = workspace.workspaceId === nav.workspaceId;
      for (const tree of workspace.worktrees) {
        if (filteredWorktreeId && tree.worktreeId !== filteredWorktreeId) continue;
        const treeConversations = conversations.filter(c => c.worktreeId === tree.worktreeId);
        const isCurrentWorktree = isCurrentWorkspace && tree.worktreeId === nav.worktreeId;
        if (!treeConversations.length && !(isCurrentWorkspace && !hasQuery) && !isCurrentWorktree) continue;
        buckets.push({
          key: `${workspace.workspaceId}:${tree.worktreeId}`,
          workspaceId: workspace.workspaceId, worktreeId: tree.worktreeId,
          label: worktreeDisplay(tree), root: tree.root,
          title: `${worktreeLabel(tree)} · ${tree.root}${tree.state !== "available" ? " (Unavailable)" : ""}`,
          available: tree.state === "available",
          conversations: treeConversations,
        });
      }
      const unmatched = conversations.filter(c => !workspace.worktrees.some(t => t.worktreeId === c.worktreeId));
      const showUnmatched = mode === "history" || unmatched.length > 0 || (!!selectedId && unmatched.some(c => c.id === selectedId));
      if (showUnmatched && unmatched.length && (!filteredWorktreeId || unmatched.some(c => c.worktreeId === filteredWorktreeId))) buckets.push({
        key: `${workspace.workspaceId}:unavailable`, workspaceId: workspace.workspaceId, worktreeId: null,
        label: "Unavailable worktree", title: "Conversations from an unavailable or removed worktree",
        available: false, conversations: unmatched,
      });
    }
    return buckets.length ? [{ ...group, buckets }] : [];
  });
}
