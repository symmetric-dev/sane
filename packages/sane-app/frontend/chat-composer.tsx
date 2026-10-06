import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { FiChevronDown, FiInfo } from "react-icons/fi";
import { AgentAvatar } from "./agent-visuals";
import { AgentPicker } from "./agent-picker";
import { ChatInput } from "./chat-input";
import { Icon } from "./nav";
import { ShellDialog } from "./shell-dialog";
import { store, useStore, type State } from "./store";
import { WorkersButton } from "./worker-ui";
import { ChatWorkstreamActions } from "./workstream-actions";
import { DocumentReviewComposer } from "./document-review";
import type { DocumentReviewController } from "./document-review-model";
import { WorkstreamStatusComposer, type WorkstreamStatusStart } from "./workstream-status";
import { catalog } from "./catalog";
import { compactCommand } from "./compaction";
import { chatStatuses, chatStatusSummary, type ChatStatusContext } from "./chat-status";
import { ComposerStatus } from "./composer-status";
import { Interactions } from "./interactions";
import { pendingInteractions } from "./interaction-presentation";

/** Kept mounted with Thread: only the draft identity may replace the DOM input. */
export function ChatComposer({ state, active = true, navigation, ack, onAckChange, send, sendDisabled, parentId, review, statusContext, statusActions }: {
  state: State;
  active?: boolean;
  navigation?: ReactNode;
  ack: string;
  onAckChange: (ack: string) => void;
  send: (text: string) => unknown;
  sendDisabled: boolean;
  parentId?: string;
  review?: DocumentReviewController;
  statusContext?: ChatStatusContext;
  statusActions?: ReactNode;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const agentTrigger = useRef<HTMLButtonElement>(null);
  const helpTrigger = useRef<HTMLButtonElement>(null);
  const normalComposer = useRef<HTMLFormElement>(null);
  const flowComposer = useRef<HTMLDivElement>(null);
  const conversation = state.conversations.find(c => c.id === state.selected);
  const { workspaces } = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const workspace = workspaces.find(item => item.workspaceId === conversation?.workspaceId);
  const flowScope = JSON.stringify([state.selected, conversation?.workspaceId, conversation?.worktreeId, conversation?.replacedBy, workspace?.commonDir, workspace?.kind, state.phase]);
  const [status, setStatus] = useState<{ scope: string; identity: WorkstreamStatusStart } | null>(null);
  const statusFlow = status?.scope === flowScope && !review?.flow ? status : null;
  const hasRequests = pendingInteractions(state, store.capabilities()).length > 0;
  const flowOpen = hasRequests || !!review?.flow || !!statusFlow;
  const wasFlowOpen = useRef(flowOpen);
  const hadRequests = useRef(hasRequests);
  useEffect(() => { setStatus(null); }, [flowScope]);
  useEffect(() => { if (review?.flow) setStatus(null); }, [!!review?.flow]);
  // Dialog cleanup runs after a navigation render; consult the current activity,
  // not the value captured when the modal was opened. Body is an explicit safe
  // target because ShellDialog falls back to its old trigger for a null target.
  const activity = useRef(active); activity.current = active && !flowOpen;
  const restoreAgentFocus = () => activity.current ? agentTrigger.current : document.body;
  const restoreHelpFocus = () => activity.current ? helpTrigger.current : document.body;
  useEffect(() => { if (!active || flowOpen) { setHelpOpen(false); setPickerOpen(false); } }, [active, flowOpen]);
  useEffect(() => {
    if (active && wasFlowOpen.current && !flowOpen) normalComposer.current?.querySelector("textarea")?.focus({ preventScroll: true });
    else if (active && hadRequests.current && !hasRequests && review?.flow?.path) flowComposer.current?.querySelector<HTMLTextAreaElement>("textarea:not(:disabled)")?.focus({ preventScroll: true });
    wasFlowOpen.current = flowOpen;
    hadRequests.current = hasRequests;
  }, [active, flowOpen, hasRequests, review?.flow?.path]);

  const capabilities = store.capabilities();
  const needsAck = !!capabilities.attachedSendRequiresNativeStopped && !!conversation?.attachment;
  const draft = useStore(current => current.drafts[store.draftKey()]) ?? store.draft();
  const profile = store.effectiveProfile();
  // New conversations pick freely; a Base may upgrade once; an assistant is fixed.
  const fixed = !!state.selected && (store.conversationKind() === "assistant" || !!parentId);
  const infoError = state.submissionError || (capabilities.catalogRequiredForSend ? state.modelsError : "");
  const statuses = chatStatuses(state, statusContext ?? { workspaceReady: true });
  const infoText = infoError || chatStatusSummary(statuses)?.text;
  const command = compactCommand(draft.text);
  // A standalone /compact opens the same explicit dialog before ordinary-send
  // gates (including the separate composer acknowledgment or staged model).
  const blocked = !active || flowOpen || (command ? state.sending || !capabilities.compaction : !capabilities.prompt || sendDisabled || (needsAck && ack !== state.selected));
  const ordinaryBusy = state.availability.code === "conversation-busy" || (!state.availability.code
    && state.availability.reason === "This conversation already has an active run or reconciliation");
  const sendHelp = state.sending ? "Sending your message…"
    : needsAck && ack !== state.selected ? "Confirm external assistant execution is stopped before sending."
    : !command && !state.connected ? "Waiting for the conversation connection."
    : !command && !state.availability.canSend ? ordinaryBusy
      ? "Wait for the current run or conversation reservation to finish."
      : state.availability.reason || "Sending is currently unavailable."
    : "Send message";
  const reviewBlocked = !active || hasRequests || !capabilities.prompt || sendDisabled || (needsAck && ack !== state.selected);
  const submit = () => { if (!blocked) void send(store.draft().text); };

  return <>
    {state.submissionError && <p className="notice error" role="alert">{state.submissionError}</p>}
    {needsAck && !conversation?.replacedBy && <label className="notice"><input type="checkbox" checked={ack === state.selected} onChange={e => onAckChange(e.target.checked ? state.selected : "")} />I confirm external assistant execution for this conversation is stopped before this send.</label>}
    {conversation?.attachment?.state === "pending" && <p className="notice error">Attachment incomplete. Use Attach native conversation with the same ID and checkout to retry. {conversation.attachment.error}</p>}
    <div className="composer-surface">
    <ComposerStatus key={flowScope} statuses={statuses} active={active} actions={statusActions} restoreFocus={() => !flowOpen ? normalComposer.current?.querySelector("textarea") ?? document.body : document.body} />
    {hasRequests && <Interactions key={flowScope} state={state} active={active && !helpOpen && !pickerOpen} navigation={navigation} showNotice={false} />}
    <div ref={flowComposer} className="composer-flow-slot" hidden={hasRequests} style={{ display: hasRequests ? "none" : "contents" }}>
      {!conversation?.replacedBy && review?.flow && <DocumentReviewComposer review={review} active={active && !hasRequests} disabled={reviewBlocked} navigation={navigation} />}
      {!conversation?.replacedBy && statusFlow && <WorkstreamStatusComposer key={JSON.stringify([statusFlow.scope, statusFlow.identity])} identity={statusFlow.identity} active={active && !hasRequests} close={() => setStatus(null)} navigation={navigation} />}
    </div>
    {!conversation?.replacedBy ? <form ref={normalComposer} className="composer" hidden={flowOpen} style={flowOpen ? { display: "none" } : undefined} onSubmit={event => { event.preventDefault(); submit(); }}>
      <ChatInput key={store.draftKey()} text={draft.text} save={text => store.setDraft({ text })} submit={submit} pathsActive={active && !flowOpen} className="composer-input" placeholder={state.selected ? "Go on..." : "Ask SANE anything… (@ for paths)"} aria-label="Message" sendButton={<button type="submit" className="send" disabled={blocked || !draft.text.trim()} aria-label="Send message" title={sendHelp}><Icon name="send" /></button>} />
      <div className="composer-toolbar"><div className="composer-options">
        {profile ? fixed
          ? <span className="agent-chip fixed" role="status" title={profile.label}><AgentAvatar profile={profile} size={20} /><span className="agent-chip-label">{profile.label}</span></span>
          : <button ref={agentTrigger} type="button" className="agent-chip" aria-haspopup="dialog" disabled={state.sending || !active} title={profile.label} aria-label={`${state.selected ? "Agent" : "Agent for new conversation"}: ${profile.label}${store.pendingUpgrade() ? " (pending)" : ""}`} onClick={() => setPickerOpen(true)}><AgentAvatar profile={profile} size={20} /><span className="agent-chip-label">{profile.label}</span>{store.pendingUpgrade() && <span className="agent-chip-pending">pending</span>}<FiChevronDown size={12} aria-hidden="true" /></button>
          : <span className="agent-chip fixed" role="status" title={store.conversationProfileLabel(state.selected)}><span className="agent-chip-label">{store.conversationProfileLabel(state.selected)}</span></span>}
        <div className="composer-utilities">
          <WorkersButton key={state.selected} sessionId={state.selected} active={active && !flowOpen} />
          <ChatWorkstreamActions conversation={conversation} active={active && !flowOpen} onDocuments={review ? identity => { setStatus(null); void review.start(identity); } : undefined} onStatus={identity => setStatus({ scope: flowScope, identity })} />
        </div>
      </div><div className="composer-actions">
        <button ref={helpTrigger} type="button" className={`composer-help${infoError ? " has-issue" : ""}`} disabled={!active} aria-label={infoText ? `Sending messages help: ${infoText}` : "Sending messages help"} title="Sending messages" onClick={() => setHelpOpen(true)}><FiInfo size={14} aria-hidden="true" />{infoError ? <span className="composer-help-dot" aria-hidden="true" /> : null}</button>
        {navigation}
      </div></div>
    </form> : navigation ? <footer className="composer-toolbar composer-navigation-only"><div className="composer-actions">{navigation}</div></footer> : null}
    </div>
    {active && pickerOpen && <AgentPicker close={() => setPickerOpen(false)} restoreFocus={restoreAgentFocus} />}
    {active && helpOpen && <ShellDialog title="Sending messages" close={() => setHelpOpen(false)} restoreFocus={restoreHelpFocus}><div className="composer-help-notes">{state.submissionError && <p className="notice error" role="alert">{state.submissionError}</p>}<p className="muted">Background progress and connection details appear in the activity row above the composer.</p><p className="muted">Enter inserts a newline · Ctrl/Cmd+Enter sends. Other conversations can run concurrently.</p><p className="muted">Type @ for paths in the execution directory. Arrow keys choose; Enter inserts text, not an attachment. Escape dismisses.</p><p className="muted">Concurrent conversations in this checkout share files; their edits can overlap.</p>{needsAck && <p className="muted">External assistant activity cannot be detected here. Stop it in its native harness before sending to this same conversation.</p>}</div></ShellDialog>}
  </>;
}
