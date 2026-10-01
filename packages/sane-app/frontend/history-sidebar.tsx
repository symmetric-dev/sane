import type { State } from "./store";
import { Icon } from "./nav";
import { ConversationSidebarList, useConversationSidebarModel } from "./conversation-sidebar";

/** Legacy Chat-only entry point. Shell callers should share a ConversationSidebar model instead. */
export function History({ state, onChoose }: { state: State; onChoose: (id: string) => void }) {
  const model = useConversationSidebarModel(state, "chat");
  return <>
    <button type="button" className="new-chat" disabled={state.sending || !model.nav.worktreeId} onClick={() => onChoose("")}><Icon name="plus" />New Conversation</button>
    <ConversationSidebarList state={state} model={model} mode="chat" selectedId={state.selected} onSelect={onChoose} />
  </>;
}
