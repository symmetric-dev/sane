import { worktreeDisplay, worktreeLabel } from "./catalog-selector";
import { compareConversationActivity } from "./conversation-activity";
import type { ConversationSidebarMode, ConversationSidebarModel } from "./conversation-sidebar-model";
import type { Conversation } from "./types";

export type WorktreeBucket = {
  key: string;
  workspaceId: string | null;
  worktreeId: string | null;
  label: string;
  root?: string;
  title?: string;
  available: boolean;
  conversations: Conversation[];
};

/** Shared by sidebar rendering and numbered navigation; unavailable rows keep their positions. */
export function conversationSidebarGroups(model: ConversationSidebarModel, mode: ConversationSidebarMode, selectedId: string | null) {
  const { repository, nav, filter, visible, groups, scoped } = model;
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
      const showUnmatched = mode === "history" || (!!selectedId && unmatched.some(c => c.id === selectedId));
      if (showUnmatched && unmatched.length && (!filteredWorktreeId || unmatched.some(c => c.worktreeId === filteredWorktreeId))) buckets.push({
        key: `${workspace.workspaceId}:unavailable`, workspaceId: workspace.workspaceId, worktreeId: null,
        label: "Unavailable worktree", title: "Conversations from an unavailable or removed worktree",
        available: false, conversations: unmatched,
      });
    }
    return buckets.length ? [{ ...group, buckets }] : [];
  });
}
