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
import { active as runtimeActive } from "./types";
import { PendingInputDetails } from "./pending-input-ui";
import { pendingInputContextReady, pendingInputLid, pendingInputPrimaryAction, unresolvedOperations } from "./pending-input-primary-action";

function pendingScopeFor(state: State) {
  const conversation = state.conversations.find(item => item.id === state.selected);
  return JSON.stringify([state.selected, state.config?.storeId, state.config?.authenticated, state.phase,
    conversation?.harness, conversation?.authorityId, conversation?.nativeSessionId, conversation?.cwd,
    conversation?.profileId, conversation?.model, conversation?.effort, conversation?.agent, conversation?.replacedBy]);
}

/** Capability loss must not hide an already-public original request. No new queue admission lives here. */
function RetainedInputDetails({ state, disabled, operate }: { state: State; disabled: boolean; operate: (action: () => Promise<unknown>) => void }) {
  const operations = unresolvedOperations(state);
  const view = state.pendingInputs?.snapshot.conversationId === state.selected ? state.pendingInputs : null;
  return <section className="pending-input-details" aria-label="Queue">
    <h3>Queue</h3>
    <p className="muted">Queue execution is currently unavailable. Original requests remain unconfirmed; no new input will be queued.</p>
    {operations.map(operation => <div key={operation.requestId} className="pending-input-operation">
      <p>{operation.kind === "enqueue" ? "Admission" : operation.kind === "remove" ? "Removal" : "Resume"} {operation.state === "unknown" ? "unconfirmed" : "pending"}.</p>
      <p className="muted">Original request: {operation.requestId}</p>
      {operation.text && <pre className="pending-input-text" tabIndex={0}>{operation.text}</pre>}
      {operation.error && <p className="muted">{operation.error}</p>}
      {operation.state === "unknown" && <div className="pending-input-operation-actions">
        <button type="button" className="text-button" disabled={disabled} onClick={() => operate(() => store.checkPendingInput(operation.requestId))}>Check status</button>
        <button type="button" className="text-button" disabled={disabled} onClick={() => operate(() => store.retransmitPendingInput(operation.requestId))}>Resend same request</button>
      </div>}
    </div>)}
    {state.pendingInputError && <p className="pending-input-error" role="alert">{state.pendingInputError}</p>}
    <details className="pending-input-debug"><summary>Debug details</summary><pre tabIndex={0}>{JSON.stringify({ conversationId: state.selected,
      source: view?.presentation.source ?? null, pinnedConfiguration: view?.presentation.configuration ?? null,
      operations: operations.map(({ requestId, kind, state, error }) => ({ requestId, kind, state, error })), readError: state.pendingInputError || null }, null, 2)}</pre></details>
  </section>;
}

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
  const [composing, setComposing] = useState(false);
  const composingRef = useRef(false);
  const [details, setDetails] = useState<{ scope: string; request: number } | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const pendingActionRef = useRef<{ scope: string } | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const agentTrigger = useRef<HTMLButtonElement>(null);
  const helpTrigger = useRef<HTMLButtonElement>(null);
  const normalComposer = useRef<HTMLFormElement>(null);
  const flowComposer = useRef<HTMLDivElement>(null);
  const conversation = state.conversations.find(c => c.id === state.selected);
  const draftIdentity = store.draftKey();
  useEffect(() => { composingRef.current = false; setComposing(false); }, [draftIdentity]);
  const pendingSupported = store.pendingInputSupported();
  const chainLocked = pendingSupported && store.pendingInputChainLocked();
  const pendingScope = pendingScopeFor(state);
  const scopeRef = useRef(pendingScope); scopeRef.current = pendingScope;
  const pendingBusy = pendingAction === pendingScope;
  useEffect(() => { pendingActionRef.current = null; setPendingAction(null); }, [pendingScope]);
  useEffect(() => {
    store.setPendingInputVisible(active && !!state.selected && pendingSupported && !conversation?.replacedBy);
    return () => store.setPendingInputVisible(false);
  }, [active, state.selected, state.config?.storeId, state.config?.authenticated, pendingSupported, conversation?.replacedBy]);
  useEffect(() => { if (chainLocked) setPickerOpen(false); }, [chainLocked]);
  const operatePending = (action: () => Promise<unknown>) => {
    const current = store.snapshot();
    const currentConversation = current.conversations.find(item => item.id === current.selected);
    if (!mounted.current || !activity.current || scopeRef.current !== pendingScope || pendingScopeFor(current) !== pendingScope
      || !pendingInputContextReady(state) || !pendingInputContextReady(current) || !current.selected
      || !currentConversation || [currentConversation.harness, currentConversation.authorityId, currentConversation.nativeSessionId, currentConversation.cwd]
        .some(value => typeof value !== "string" || !value.trim())
      || pendingActionRef.current?.scope === pendingScope) return;
    const scope = pendingScope;
    const operation = { scope };
    pendingActionRef.current = operation; setPendingAction(scope);
    void (async () => {
      try { await action(); }
      catch { /* Store methods retain scoped mutation errors and original intent. */ }
      finally {
        if (pendingActionRef.current === operation && mounted.current && scopeRef.current === scope && pendingScopeFor(store.snapshot()) === scope) {
          pendingActionRef.current = null;
          setPendingAction(current => current === scope ? null : current);
        }
      }
    })();
  };
  const { workspaces } = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const workspace = workspaces.find(item => item.workspaceId === conversation?.workspaceId);
  const flowScope = JSON.stringify([pendingScope, conversation?.workspaceId, conversation?.worktreeId, conversation?.replacedBy, workspace?.commonDir, workspace?.kind]);
  const [status, setStatus] = useState<{ scope: string; identity: WorkstreamStatusStart } | null>(null);
  const statusFlow = status?.scope === flowScope && !review?.flow ? status : null;
  const hasRequests = pendingInteractions(state, store.capabilities()).length > 0;
  const flowOpen = hasRequests || !!review?.flow || !!statusFlow;
  const wasFlowOpen = useRef(flowOpen);
  const hadRequests = useRef(hasRequests);
  useEffect(() => { setStatus(null); }, [flowScope]);
  useEffect(() => { setDetails(null); }, [flowScope]);
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
  const reviewBlocked = !active || hasRequests || chainLocked || !capabilities.prompt || sendDisabled || (needsAck && ack !== state.selected);
  const deriveAction = (current: State, text: string) => {
    const currentConversation = current.conversations.find(item => item.id === current.selected);
    const currentCapabilities = store.capabilities();
    const supported = store.pendingInputSupported();
    const locked = store.pendingInputChainLocked();
    const command = !!compactCommand(text);
    const requiresAck = !!currentCapabilities.attachedSendRequiresNativeStopped && !!currentConversation?.attachment;
    const ackMissing = requiresAck && ack !== current.selected;
    const busy = current.availability.code === "conversation-busy" || (!current.availability.code
      && current.availability.reason === "This conversation already has an active run or reconciliation");
    const running = current.runs.some(run => runtimeActive(run.status)) || runtimeActive(currentConversation?.status ?? "completed");
    const ordinaryBlocked = locked || supported && (current.phase !== "ready" || current.config?.authenticated !== true)
      || (command ? current.sending || !currentCapabilities.compaction
      : sendDisabled || !currentCapabilities.prompt || ackMissing || current.loading || current.sending || current.actionBusy
        || !current.connected || !current.availability.canSend || running && !store.canQueueInput(current)
        || store.compactBlocked() || store.modelUnavailable() || !!store.executionUnavailable());
    const sendReason = locked ? command ? "Resolve the existing input chain before compacting." : "Resolve the existing input chain before sending ordinary input."
      : current.sending ? "Sending your message…"
      : !command && ackMissing ? "Confirm external assistant execution is stopped before sending."
      : !command && !current.connected ? "Waiting for the conversation connection."
      : !command && !current.availability.canSend ? busy ? "Wait for the current run or conversation reservation to finish."
        : current.availability.reason || "Sending is currently unavailable." : "Send message";
    // Busy/retained-chain ordinary-send restrictions are intentionally not queue
    // gates. All other source, profile, flow and acknowledgment gates still apply.
    const queueReason = !supported ? null
      : current.phase !== "ready" || current.config?.authenticated !== true ? "Choose an authenticated conversation to queue an input."
      : store.pendingUpgrade() ? "Queue uses saved settings; clear pending assignment first."
      : pendingActionRef.current?.scope === pendingScope || current.actionBusy || current.sending || store.compactBlocked() ? "Wait for the current action to settle."
      : current.loading || !current.connected ? "Waiting for the conversation connection."
      : !currentCapabilities.prompt ? "Sending is unavailable for this harness."
      : ackMissing ? "Confirm external assistant execution is stopped before queueing."
      : store.executionUnavailable() || (store.modelUnavailable() ? "Waiting for the model catalog…" : "")
        || current.pendingInputError || (current.pendingInputLoading ? "Reading current queue eligibility…" : "") || store.pendingInputUnavailable() || null;
    return pendingInputPrimaryAction({ state: current, supported, chainLocked: locked, command, text, sendBlocked: !!ordinaryBlocked,
      sendReason, queueReason, inactive: !active || flowOpen || !!currentConversation?.replacedBy, composing: composingRef.current || composing });
  };
  const primary = deriveAction(state, draft.text);
  const lid = pendingInputLid(state, pendingSupported);
  const submit = () => {
    // The input shortcut and form submit share the same current-state decision.
    // Validate the rendered scope and consent before touching the current store.
    const current = store.snapshot();
    if (!mounted.current || !activity.current || scopeRef.current !== pendingScope || pendingScopeFor(current) !== pendingScope
      || store.draftKey() !== draftIdentity || composingRef.current) return;
    const text = store.draft().text;
    const action = deriveAction(current, text);
    if (action.disabled) return;
    // A concurrent state change must not reinterpret a visible Send as consent
    // to future execution (or a visible Queue as an ordinary immediate send).
    if (action.mode !== primary.mode) return;
    if (action.mode === "check-request") setDetails(previous => ({ scope: pendingScope, request: previous?.scope === pendingScope ? previous.request + 1 : 1 }));
    else if (action.mode === "queue" || action.mode === "add-paused") operatePending(() => store.enqueuePendingInput(text));
    else void send(text);
  };

  return <>
    {state.submissionError && <p className="notice error" role="alert">{state.submissionError}</p>}
    {needsAck && !conversation?.replacedBy && <label className="notice"><input type="checkbox" checked={ack === state.selected} onChange={e => onAckChange(e.target.checked ? state.selected : "")} />I confirm external assistant execution for this conversation is stopped before this send.</label>}
    {conversation?.attachment?.state === "pending" && <p className="notice error">Attachment incomplete. Use Attach native conversation with the same ID and checkout to retry. {conversation.attachment.error}</p>}
    <div className="composer-surface">
    <ComposerStatus key={flowScope} statuses={statuses} active={active} actions={statusActions}
      queue={lid ? { lid, details: pendingSupported
        ? <PendingInputDetails state={state} active={active && !flowOpen && !conversation?.replacedBy} busy={pendingBusy} operate={operatePending} />
        : <RetainedInputDetails state={state} disabled={!active || flowOpen || !!conversation?.replacedBy || pendingBusy || state.actionBusy || state.sending || state.loading || !!state.pendingInputLoading} operate={operatePending} /> } : undefined}
      detailsRequest={details?.scope === pendingScope ? details.request : 0}
      restoreFocus={() => !flowOpen ? normalComposer.current?.querySelector("textarea") ?? document.body : document.body} />
    {hasRequests && <Interactions key={flowScope} state={state} active={active && !helpOpen && !pickerOpen} navigation={navigation} showNotice={false} />}
    <div ref={flowComposer} className="composer-flow-slot" hidden={hasRequests} style={{ display: hasRequests ? "none" : "contents" }}>
      {!conversation?.replacedBy && review?.flow && <DocumentReviewComposer review={review} active={active && !hasRequests} disabled={reviewBlocked} navigation={navigation} />}
      {!conversation?.replacedBy && statusFlow && <WorkstreamStatusComposer key={JSON.stringify([statusFlow.scope, statusFlow.identity])} identity={statusFlow.identity} active={active && !hasRequests} close={() => setStatus(null)} navigation={navigation} />}
    </div>
    {!conversation?.replacedBy ? <form ref={normalComposer} className="composer" hidden={flowOpen} style={flowOpen ? { display: "none" } : undefined} onCompositionStartCapture={() => { composingRef.current = true; setComposing(true); }} onCompositionEndCapture={() => { composingRef.current = false; setComposing(false); }} onSubmit={event => { event.preventDefault(); submit(); }}>
      <ChatInput key={draftIdentity} text={draft.text} save={text => store.setDraft({ text })} submit={submit} pathsActive={active && !flowOpen} className="composer-input pending-input-primary-input" placeholder={state.selected ? "Go on..." : "Ask SANE anything… (@ for paths)"} aria-label="Message" sendButton={<button type="submit" className="send pending-input-primary" data-mode={primary.mode} disabled={primary.disabled} aria-label={primary.mode === "send" ? "Send message" : primary.label} title={primary.reason ?? (primary.mode === "add-paused" ? "Add using saved settings; waiting messages remain paused." : "Queue this message using the conversation's saved settings.")}><Icon name="send" /><span>{primary.label}</span></button>} />
      <div className="composer-toolbar"><div className="composer-options">
        {profile ? fixed
          ? <span className="agent-chip fixed" role="status" title={profile.label}><AgentAvatar profile={profile} size={20} /><span className="agent-chip-label">{profile.label}</span></span>
          : <button ref={agentTrigger} type="button" className="agent-chip" aria-haspopup="dialog" disabled={state.sending || !active || chainLocked} title={chainLocked ? "Agent settings are fixed while the pending-input chain is active." : profile.label} aria-label={`${state.selected ? "Agent" : "Agent for new conversation"}: ${profile.label}${store.pendingUpgrade() ? " (pending)" : ""}`} onClick={() => { if (!store.pendingInputChainLocked()) setPickerOpen(true); }}><AgentAvatar profile={profile} size={20} /><span className="agent-chip-label">{profile.label}</span>{store.pendingUpgrade() && <span className="agent-chip-pending">pending</span>}<FiChevronDown size={12} aria-hidden="true" /></button>
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
    {active && helpOpen && <ShellDialog title="Sending messages" close={() => setHelpOpen(false)} restoreFocus={restoreHelpFocus}><div className="composer-help-notes">{state.submissionError && <p className="notice error" role="alert">{state.submissionError}</p>}<p className="muted">Background progress and connection details appear in the activity row above the composer.</p><p className="muted">Enter inserts a newline · Ctrl/Cmd+Enter uses the visible primary action. Other conversations can run concurrently.</p><p className="muted">Type @ for paths in the execution directory. Arrow keys choose; Enter inserts text, not an attachment. Escape dismisses.</p><p className="muted">Concurrent conversations in this checkout share files; their edits can overlap.</p>{needsAck && <p className="muted">External assistant activity cannot be detected here. Stop it in its native harness before sending to this same conversation.</p>}</div></ShellDialog>}
  </>;
}
