import { useEffect, useMemo, useState } from "react";
import { useRegisterCommand } from "./application-commands";
import { catalog } from "./catalog";
import { NEW_CONVERSATION_SHORTCUT } from "./shortcut-definitions";
import { store, type State } from "./store";

/** One shell-level owner, shared by desktop and mobile navigation. */
export function NewConversationShortcut({ onNew, isSelectionOpen }: { onNew: () => void; isSelectionOpen: () => boolean }) {
  const [focusRequest, setFocusRequest] = useState<{ config: State["config"]; workspaceId: string; worktreeId: string } | null>(null);
  useEffect(() => {
    if (!focusRequest) return;
    const frame = requestAnimationFrame(() => {
      const current = store.snapshot(), navigation = catalog.snapshot().navigation;
      if (current.phase !== "ready" || current.config !== focusRequest.config || current.selected
        || navigation.view !== "chat" || navigation.workspaceId !== focusRequest.workspaceId || navigation.worktreeId !== focusRequest.worktreeId
        || document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
      const input = document.querySelector<HTMLTextAreaElement>('.chat-surface:not([hidden]):not([inert]) .composer textarea:not(:disabled)');
      if (input && !input.closest("[hidden], [inert]")) input.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest]);
  useRegisterCommand(useMemo(() => ({
    ...NEW_CONVERSATION_SHORTCUT,
    contexts: ["application", "input", "editor", "terminal"] as const,
    available: () => {
      const current = store.snapshot(), repository = catalog.snapshot();
      const { workspaceId, worktreeId } = repository.navigation;
      return current.phase === "ready" && !current.sending && repository.ready && !isSelectionOpen()
        && !!repository.workspaces.find(workspace => workspace.workspaceId === workspaceId)?.worktrees
          .some(tree => tree.worktreeId === worktreeId && tree.state === "available");
    },
    action: () => {
      const current = store.snapshot(), { workspaceId, worktreeId } = catalog.snapshot().navigation;
      if (!workspaceId || !worktreeId) return;
      onNew();
      setFocusRequest({ config: current.config, workspaceId, worktreeId });
    },
  }), [onNew, isSelectionOpen]));
  return null;
}
