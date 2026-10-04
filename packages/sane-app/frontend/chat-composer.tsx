import { useEffect, useRef, useState, type ReactNode } from "react";
import { FiChevronDown, FiInfo } from "react-icons/fi";
import { AgentAvatar } from "./agent-visuals";
import { AgentPicker } from "./agent-picker";
import { ChatInput } from "./chat-input";
import { Icon } from "./nav";
import { ShellDialog } from "./shell-dialog";
import { store, type State } from "./store";
import { WorkersButton } from "./worker-ui";
import { ChatWorkstreamActions } from "./workstream-actions";
import { DocumentReviewComposer } from "./document-review";
import type { DocumentReviewController } from "./document-review-model";
import { compactCommand } from "./compaction";

/** Kept mounted with Thread: only the draft identity may replace the DOM input. */
export function ChatComposer({ state, active = true, navigation, ack, onAckChange, send, sendDisabled, parentId, review }: {
  state: State;
  active?: boolean;
  navigation?: ReactNode;
  ack: string;
  onAckChange: (ack: string) => void;
  send: (text: string) => unknown;
  sendDisabled: boolean;
  parentId?: string;
  review?: DocumentReviewController;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const agentTrigger = useRef<HTMLButtonElement>(null);
  const helpTrigger = useRef<HTMLButtonElement>(null);
  const normalComposer = useRef<HTMLFormElement>(null);
  const wasReviewing = useRef(!!review?.flow);
  // Dialog cleanup runs after a navigation render; consult the current activity,
  // not the value captured when the modal was opened. Body is an explicit safe
  // target because ShellDialog falls back to its old trigger for a null target.
  const activity = useRef(active); activity.current = active && !review?.flow;
  const restoreAgentFocus = () => activity.current ? agentTrigger.current : document.body;
  const restoreHelpFocus = () => activity.current ? helpTrigger.current : document.body;
  useEffect(() => { if (!active || review?.flow) { setHelpOpen(false); setPickerOpen(false); } }, [active, !!review?.flow]);
  useEffect(() => {
    if (active && wasReviewing.current && !review?.flow) normalComposer.current?.querySelector("textarea")?.focus({ preventScroll: true });
    wasReviewing.current = !!review?.flow;
  }, [active, !!review?.flow]);

  const conversation = state.conversations.find(c => c.id === state.selected);
  const capabilities = store.capabilities();
  const needsAck = !!capabilities.attachedSendRequiresNativeStopped && !!conversation?.attachment;
  const draft = store.draft();
  const harness = store.harness();
  const profile = store.effectiveProfile();
  // New conversations pick freely; a Base may upgrade once; an assistant is fixed.
  const fixed = !!state.selected && (store.conversationKind() === "assistant" || !!parentId);
  const missingModel = store.missingModel();
  const infoError = state.submissionError || (capabilities.catalogRequiredForSend ? state.modelsError : "");
  const infoStatus = (state.sending ? "Sending your message…" : "") || (state.loading ? "Loading your conversation…" : "") || store.executionUnavailable() || (!state.connected ? "Reconnecting to the bridge…" : "") || (!state.availability.canSend && state.availability.reason) || (store.modelUnavailable() ? "Waiting for the OpenCode model catalog for this directory." : "");
  const infoText = infoError || infoStatus;
  const command = compactCommand(draft.text);
  // A standalone /compact opens the same explicit dialog before ordinary-send
  // gates (including the separate composer acknowledgment or staged model).
  const blocked = !active || (command ? state.sending || !capabilities.compaction : !capabilities.prompt || sendDisabled || (needsAck && ack !== state.selected));
  const reviewBlocked = !active || !capabilities.prompt || sendDisabled || (needsAck && ack !== state.selected);
  const submit = () => { if (!blocked) void send(store.draft().text); };

  return <>
    {state.submissionError && <p className="notice error" role="alert">{state.submissionError}</p>}
    {capabilities.catalogRequiredForSend && state.modelsError && <p className="notice" role="status">{state.modelsError} <button type="button" className="text-button" disabled={state.modelsLoading || !capabilities.listModels} onClick={() => void store.loadModels(harness)}>Retry connection</button></p>}
    {needsAck && !conversation?.replacedBy && <label className="notice"><input type="checkbox" checked={ack === state.selected} onChange={e => onAckChange(e.target.checked ? state.selected : "")} />I confirm external assistant execution for this conversation is stopped before this send.</label>}
    {missingModel && <p className="notice" role="status">Model {missingModel} is not in the current OpenCode catalog for this directory. Sending will still use this selection.</p>}
    {conversation?.attachment?.state === "pending" && <p className="notice error">Attachment incomplete. Use Attach native conversation with the same ID and checkout to retry. {conversation.attachment.error}</p>}
    {!conversation?.replacedBy && review?.flow && <DocumentReviewComposer review={review} active={active} disabled={reviewBlocked} navigation={navigation} />}
    {!conversation?.replacedBy ? <form ref={normalComposer} className="composer" hidden={!!review?.flow} style={review?.flow ? { display: "none" } : undefined} onSubmit={event => { event.preventDefault(); submit(); }}>
      <ChatInput key={store.draftKey()} text={draft.text} save={text => store.setDraft({ text })} submit={submit} pathsActive={active && !review?.flow} className="composer-input" placeholder={state.selected ? "Go on..." : "Ask SANE anything… (@ for paths)"} aria-label="Message" />
      <div className="composer-toolbar"><div className="composer-options">
        {profile ? fixed
          ? <span className="agent-chip fixed" role="status" title={profile.label}><AgentAvatar profile={profile} size={20} /><span className="agent-chip-label">{profile.label}</span></span>
          : <button ref={agentTrigger} type="button" className="agent-chip" aria-haspopup="dialog" disabled={state.sending || !active} title={profile.label} aria-label={`${state.selected ? "Agent" : "Agent for new conversation"}: ${profile.label}${store.pendingUpgrade() ? " (pending)" : ""}`} onClick={() => setPickerOpen(true)}><AgentAvatar profile={profile} size={20} /><span className="agent-chip-label">{profile.label}</span>{store.pendingUpgrade() && <span className="agent-chip-pending">pending</span>}<FiChevronDown size={12} aria-hidden="true" /></button>
          : <span className="agent-chip fixed" role="status" title={store.conversationProfileLabel(state.selected)}><span className="agent-chip-label">{store.conversationProfileLabel(state.selected)}</span></span>}
        <div className="composer-utilities">
          <WorkersButton key={state.selected} sessionId={state.selected} active={active} />
          <ChatWorkstreamActions conversation={conversation} active={active && !review?.flow} onDocuments={review ? identity => void review.start(identity) : undefined} />
        </div>
      </div><div className="composer-actions">
        {navigation}
        <button ref={helpTrigger} type="button" className={`composer-help${infoError ? " has-issue" : ""}`} disabled={!active} aria-label={infoText ? `Sending messages help: ${infoText}` : "Sending messages help"} title="Sending messages" onClick={() => setHelpOpen(true)}><FiInfo size={14} aria-hidden="true" />{infoError ? <span className="composer-help-dot" aria-hidden="true" /> : null}</button>
        <button type="submit" className="send" disabled={blocked || !draft.text.trim()} aria-label="Send message" title="Send message"><Icon name="send" /></button>
      </div></div>
    </form> : navigation ? <footer className="composer-toolbar composer-navigation-only"><div className="composer-actions">{navigation}</div></footer> : null}
    {active && pickerOpen && <AgentPicker close={() => setPickerOpen(false)} restoreFocus={restoreAgentFocus} />}
    {active && helpOpen && <ShellDialog title="Sending messages" close={() => setHelpOpen(false)} restoreFocus={restoreHelpFocus}><div className="composer-help-notes">{infoText ? <p className={`notice${infoError ? " error" : ""}`} role={infoError ? "alert" : "status"}>{infoText}{capabilities.catalogRequiredForSend && state.modelsError ? <> <button type="button" className="text-button" disabled={state.modelsLoading || !capabilities.listModels} onClick={() => void store.loadModels(harness)}>Retry connection</button></> : null}</p> : null}<p className="muted">Enter inserts a newline · Ctrl/Cmd+Enter sends. Other conversations can run concurrently.</p><p className="muted">Type @ for paths in the execution directory. Arrow keys choose; Enter inserts text, not an attachment. Escape dismisses.</p><p className="muted">Concurrent conversations in this checkout share files; their edits can overlap.</p>{needsAck && <p className="muted">External assistant activity cannot be detected here. Stop it in its native harness before sending to this same conversation.</p>}</div></ShellDialog>}
  </>;
}
