import { catalog } from "./catalog";
import { store } from "./store";
import { workerReference } from "./worker-client";
import { compareConversationActivity } from "./conversation-activity";
import { conversationClient } from "./cc-client";
import { workspaceEpoch } from "./workspace-store";

export const workspaceSelectionBlocked = () => {
  const current = store.snapshot();
  return current.phase !== "ready" || current.sending || !current.conversationsReady;
};

function resolveActivation(workspaceId: string, preferredWorktreeId?: string, exactWorktree = false): { error: string } | { target: { workspaceId: string; worktreeId: string; conversationId: string | null } } {
  const current = store.snapshot(), repository = catalog.snapshot();
  if (workspaceSelectionBlocked()) return { error: current.sending ? "Wait for the message to finish submitting." : "Waiting for the conversation listing." };
  if (!repository.ready) return { error: "Waiting for the workspace catalog." };
  const workspace = repository.workspaces.find(item => item.workspaceId === workspaceId);
  if (!workspace) return { error: "This workspace is no longer available." };
  const worktrees = workspace.worktrees.filter(tree => tree.state === "available" && (!exactWorktree || tree.worktreeId === preferredWorktreeId));
  if (!worktrees.length) return { error: "This workspace has no available worktree." };
  const eligible = current.conversations.filter(conversation => conversation.workspaceId === workspaceId
    && conversation.association === "resolved" && worktrees.some(tree => tree.worktreeId === conversation.worktreeId)
    && !conversation.hidden && !conversation.replacedBy && !conversation.worker && conversation.agentKind !== "worker"
    && !workerReference(conversation.id) && store.profileFor(conversation)?.kind !== "worker");
  eligible.sort(compareConversationActivity);
  const conversation = eligible[0];
  const worktreeId = conversation?.worktreeId ?? worktrees.find(tree => tree.worktreeId === preferredWorktreeId)?.worktreeId ?? worktrees[0]!.worktreeId;
  return { target: { workspaceId, worktreeId, conversationId: conversation?.id ?? null } };
}

export function resolveWorkspaceActivation(workspaceId: string, preferredWorktreeId?: string) {
  return resolveActivation(workspaceId, preferredWorktreeId);
}

/** Unlike workspace activation, numbered shortcuts must never jump to another checkout. */
export function resolveWorktreeActivation(workspaceId: string, worktreeId: string) {
  return resolveActivation(workspaceId, worktreeId, true);
}

let activationSerial = 0;
/** Resolve the authoritative newest chat without enumerating another checkout's
 * history. The synchronous activation remains usable by selectors; this read may
 * refine its cached choice only while that exact navigation intent still owns it. */
export function refreshWorkspaceActivation(target: { workspaceId: string; worktreeId: string; conversationId: string | null }, exactWorktree = false, onError?: (message: string) => void) {
  const serial = ++activationSerial, auth = workspaceEpoch();
  const initial = store.snapshot(), navigation = catalog.snapshot().navigation;
  if (!initial.conversationPage || initial.phase !== "ready") return;
  const current = () => serial === activationSerial && auth === workspaceEpoch()
    && store.snapshot().phase === "ready" && store.snapshot().config === initial.config
    && !store.snapshot().sending && store.snapshot().selected === initial.selected
    && store.snapshot().drafts === initial.drafts
    && catalog.snapshot().ready && catalog.snapshot().navigation === navigation;
  void (async () => {
    try {
      const listing = await conversationClient.conversations(AbortSignal.timeout(25000), {
        mode: "chat", workspaceId: target.workspaceId,
        worktreeId: exactWorktree ? target.worktreeId : "all", availableOnly: true, limit: 1,
      });
      if (!current()) return;
      const candidate = listing.conversations[0];
      if (!candidate) {
        // A cached row is not proof that this workspace still has an active chat.
        if (initial.selected) {
          store.choose("");
          catalog.navigate({ workspaceId: target.workspaceId, worktreeId: target.worktreeId, conversationId: null, filePath: null, comparison: null });
        }
        return;
      }
      await store.ensureConversations([candidate.id], AbortSignal.timeout(25000));
      if (!current()) return;
      const conversation = store.snapshot().conversations.find(row => row.id === candidate.id);
      const workspace = catalog.snapshot().workspaces.find(row => row.workspaceId === target.workspaceId);
      if (!conversation || conversation.workspaceId !== target.workspaceId || conversation.association !== "resolved"
        || exactWorktree && conversation.worktreeId !== target.worktreeId || conversation.hidden || conversation.replacedBy
        || conversation.worker || conversation.agentKind === "worker"
        || !workspace?.worktrees.some(tree => tree.worktreeId === conversation.worktreeId && tree.state === "available")) return;
      store.choose(conversation.id);
      catalog.navigate({ workspaceId: target.workspaceId, worktreeId: conversation.worktreeId!, conversationId: conversation.id, filePath: null, comparison: null });
    } catch {
      if (current()) onError?.("Could not check this workspace’s latest conversation. Select it again to retry.");
    }
  })();
}
