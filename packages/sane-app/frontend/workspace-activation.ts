import { catalog } from "./catalog";
import { store } from "./store";
import { workerReference } from "./worker-client";
import type { Conversation } from "./types";

export const workspaceSelectionBlocked = () => {
  const current = store.snapshot();
  return current.phase !== "ready" || current.sending || !current.conversationsReady;
};

const activityTime = (conversation: Conversation) => {
  const time = conversation.updatedAt ? Date.parse(conversation.updatedAt) : NaN;
  return Number.isFinite(time) ? time : -Infinity;
};

export function resolveWorkspaceActivation(workspaceId: string, preferredWorktreeId?: string): { error: string } | { target: { workspaceId: string; worktreeId: string; conversationId: string | null } } {
  const current = store.snapshot(), repository = catalog.snapshot();
  if (workspaceSelectionBlocked()) return { error: current.sending ? "Wait for the message to finish submitting." : "Waiting for the conversation listing." };
  if (!repository.ready) return { error: "Waiting for the workspace catalog." };
  const workspace = repository.workspaces.find(item => item.workspaceId === workspaceId);
  if (!workspace) return { error: "This workspace is no longer available." };
  const worktrees = workspace.worktrees.filter(tree => tree.state === "available");
  if (!worktrees.length) return { error: "This workspace has no available worktree." };
  const eligible = current.conversations.filter(conversation => conversation.workspaceId === workspaceId
    && conversation.association === "resolved" && worktrees.some(tree => tree.worktreeId === conversation.worktreeId)
    && !conversation.hidden && !conversation.replacedBy && !conversation.worker && conversation.agentKind !== "worker"
    && !workerReference(conversation.id) && store.profileFor(conversation)?.kind !== "worker");
  eligible.sort((a, b) => {
    const left = activityTime(a), right = activityTime(b);
    return left !== right ? left > right ? -1 : 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const conversation = eligible[0];
  const worktreeId = conversation?.worktreeId ?? worktrees.find(tree => tree.worktreeId === preferredWorktreeId)?.worktreeId ?? worktrees[0]!.worktreeId;
  return { target: { workspaceId, worktreeId, conversationId: conversation?.id ?? null } };
}
