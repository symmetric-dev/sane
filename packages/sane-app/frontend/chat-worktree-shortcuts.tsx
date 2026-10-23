import { useEffect, useMemo, useState } from "react";
import { useRegisterCommand } from "./application-commands";
import { catalog } from "./catalog";
import { conversationSidebarGroups, type WorktreeBucket } from "./conversation-sidebar-buckets";
import type { ConversationSidebarModel } from "./conversation-sidebar-model";
import { CHAT_WORKTREE_SHORTCUTS } from "./shortcut-definitions";
import { store, type State } from "./store";
import { resolveWorktreeActivation, workspaceSelectionBlocked } from "./workspace-activation";

type WorktreeTarget = { workspaceId: string; worktreeId: string; conversationId: string | null };

/** Mounted once above the desktop sidebar and mobile drawer. */
export function ChatWorktreeShortcuts({ model, onChoose }: { model: ConversationSidebarModel; onChoose: (id: string) => void }) {
  const buckets = conversationSidebarGroups(model, "chat", store.snapshot().selected).flatMap(group => group.buckets);
  const [focusRequest, setFocusRequest] = useState<{ target: WorktreeTarget; config: State["config"] } | null>(null);
  useEffect(() => {
    if (!focusRequest) return;
    const frame = requestAnimationFrame(() => {
      const current = store.snapshot(), navigation = catalog.snapshot().navigation;
      const { target, config } = focusRequest;
      if (current.phase !== "ready" || current.config !== config || current.selected !== (target.conversationId ?? "")
        || navigation.view !== "chat" || navigation.workspaceId !== target.workspaceId || navigation.worktreeId !== target.worktreeId
        || document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
      const surface = document.querySelector<HTMLElement>(".chat-surface:not([hidden]):not([inert])");
      const input = surface?.querySelector<HTMLTextAreaElement>(".composer textarea:not(:disabled)");
      if (input && !input.closest("[hidden], [inert]")) input.focus({ preventScroll: true });
      else if (surface) { surface.tabIndex = -1; surface.focus({ preventScroll: true }); }
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest]);
  const activate = (bucket: WorktreeBucket) => {
    if (!bucket.workspaceId || !bucket.worktreeId) return;
    const resolved = resolveWorktreeActivation(bucket.workspaceId, bucket.worktreeId);
    if ("error" in resolved) return;
    const { target } = resolved;
    model.workspaceSelection.selectWorktree(target.worktreeId, target.workspaceId);
    const navigation = catalog.snapshot().navigation;
    if (navigation.workspaceId !== target.workspaceId || navigation.worktreeId !== target.worktreeId) return;
    onChoose(target.conversationId ?? "");
    setFocusRequest({ target, config: store.snapshot().config });
  };
  return <>{CHAT_WORKTREE_SHORTCUTS.map((shortcut, index) => <ChatWorktreeShortcut key={shortcut.id} shortcut={shortcut} bucket={buckets[index]} model={model} activate={activate} />)}</>;
}

function ChatWorktreeShortcut({ shortcut, bucket, model, activate }: {
  shortcut: typeof CHAT_WORKTREE_SHORTCUTS[number]; bucket?: WorktreeBucket;
  model: ConversationSidebarModel; activate: (bucket: WorktreeBucket) => void;
}) {
  useRegisterCommand(useMemo(() => ({
    ...shortcut,
    contexts: ["application", "input", "editor", "terminal"] as const,
    available: () => {
      const repository = catalog.snapshot();
      return repository.ready && repository.navigation.view === "chat" && !workspaceSelectionBlocked() && !model.workspaceSelection.isOpen()
        && !!bucket?.available && !!bucket.workspaceId && !!bucket.worktreeId
        && !!repository.workspaces.find(workspace => workspace.workspaceId === bucket.workspaceId)?.worktrees
          .some(tree => tree.worktreeId === bucket.worktreeId && tree.state === "available");
    },
    action: () => { if (bucket) activate(bucket); },
  }), [shortcut, bucket, model, activate]));
  return null;
}
