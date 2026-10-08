import { store, type State } from "./store";
import "./pending-input.css";

export function pendingInputStopAction({ chainLocked, appRunning, cancelRun, nativeQueueWaiting, disabled, cancel }: {
  chainLocked: boolean;
  appRunning: boolean;
  cancelRun: boolean;
  nativeQueueWaiting: boolean;
  disabled: boolean;
  cancel: () => void;
}) {
  if (!chainLocked && !(appRunning && cancelRun)) return null;
  const stopRun = appRunning && cancelRun;
  return <button type="button" className="text-button composer-status-stop" disabled={disabled}
    title={chainLocked ? "Pauses waiting messages in the current server chain; does not remove claimed work or confirm native interruption. Unconfirmed admissions may not yet belong to that chain." : undefined}
    onClick={cancel}>{chainLocked ? stopRun ? "Stop run and pause waiting" : "Pause waiting messages" : nativeQueueWaiting ? "Cancel queued message" : "Stop run"}</button>;
}

export function pendingInputOperationsFor(state: State) {
  return Object.values(state.pendingInputOperations ?? {}).filter(operation => operation.conversationId === state.selected
    && (operation.state === "pending" || operation.state === "unknown" || operation.state === "rejected" && operation.error));
}

export function PendingInputDetails({ state, active, busy, operate }: {
  state: State;
  active: boolean;
  busy: boolean;
  operate: (action: () => Promise<unknown>) => void;
}) {
  if (!state.selected || !store.pendingInputSupported()) return null;
  const view = state.pendingInputs?.snapshot.conversationId === state.selected ? state.pendingInputs : null;
  const operations = pendingInputOperationsFor(state);
  const unconfirmed = operations.some(operation => operation.state === "pending" || operation.state === "unknown");
  const authenticated = state.phase === "ready" && state.config?.authenticated === true;
  const disabled = !active || !authenticated || busy || state.actionBusy || state.sending || state.loading || !!state.pendingInputLoading;
  const mutationsDisabled = disabled || !!state.pendingInputError || unconfirmed;
  const waiting = view?.snapshot.items.filter(item => item.state === "waiting") ?? [];
  const head = view?.snapshot.items.find(item => item.state !== "waiting");
  // Public projection only: no private admission ledger, payload dump or staged
  // settings. These are the pinned identities/configuration of this chain.
  const source = view?.presentation.source;
  const configuration = view?.presentation.configuration;
  const debug = {
    conversationId: state.selected,
    source: source ? { harnessId: source.harnessId, conversationId: source.conversationId, authorityId: source.authorityId, nativeSessionId: source.nativeSessionId, cwd: source.cwd } : null,
    pinnedConfiguration: configuration ? { cwd: configuration.cwd, profileId: configuration.profileId, model: configuration.model, effort: configuration.effort, agent: configuration.agent } : null,
    chainId: view?.presentation.chainId ?? null,
    revision: view?.snapshot.revision ?? null,
    paused: view?.snapshot.paused ?? null,
    pauseCode: view?.presentation.pauseCode ?? null,
    items: view?.snapshot.items.map(item => ({ itemId: item.itemId, requestId: item.requestId, runId: item.runId, state: item.state })) ?? [],
    operations: operations.map(operation => ({ requestId: operation.requestId, kind: operation.kind, state: operation.state, error: operation.error })),
    readError: state.pendingInputError || null,
    admissionReceipts: "Unavailable in the public queue projection",
  };
  return <section className="pending-input-details" aria-label="Queue">
    <h3>Queue</h3>
    <div className="pending-input-heading"><strong>Waiting {waiting.length}/3</strong>
      <span className="muted">App queue · not native acceptance</span></div>
    {!view && <p className="muted">{state.pendingInputLoading ? "Checking queue status…" : "Queue status is unavailable."}</p>}
    {view && !waiting.length && !head && <p className="muted">No waiting messages.</p>}
    {head && <div className="pending-input-head">
      <strong>{view?.presentation.unresolved?.classification === "uncertain" ? "Uncertain (reconciliation needed)" : head.state === "run-linked" ? "Run linked" : "Claimed"}</strong>
      <pre className="pending-input-text" tabIndex={0}>{head.text}</pre>
      <p className="muted">This unresolved input is not a waiting slot. Reconcile its original request and run identity; do not submit it again.</p>
    </div>}
    {!!waiting.length && <ol className="pending-input-list" aria-label="Waiting messages">{waiting.map((item, index) => {
      const removal = view?.presentation.removals.find(removal => removal.itemId === item.itemId);
      return <li key={item.itemId}><div className="pending-input-row"><span>Waiting {index + 1}</span>
        <button type="button" className="text-button" disabled={mutationsDisabled || !view?.presentation.removalAllowed || !removal?.allowed}
          title={removal?.code ?? undefined} aria-label={`Remove waiting message ${index + 1}`} onClick={() => operate(() => store.removePendingInput(item.itemId))}>Remove</button></div>
        <pre className="pending-input-text" tabIndex={0}>{item.text}</pre></li>;
    })}</ol>}
    {view?.snapshot.paused && <div className="pending-input-pause"><p>Waiting messages are paused. Unhide does not resume.</p>
      <p className="muted">{view.snapshot.reason}{view.presentation.pauseCode ? ` (${view.presentation.pauseCode})` : ""}</p>
      <button type="button" className="text-button" disabled={mutationsDisabled || !!head || !!view.presentation.unresolved || !view.presentation.resumeAllowed}
        onClick={() => operate(() => store.resumePendingInputs())}>Resume waiting messages</button></div>}
    {operations.map(operation => <div key={operation.requestId} className="pending-input-operation">
      <p>{operation.kind === "enqueue" ? "Admission" : operation.kind === "remove" ? "Removal" : "Resume"} {operation.state === "pending" ? "pending" : operation.state === "unknown" ? "unconfirmed" : "rejected"}.
        {operation.kind === "enqueue" && operation.state !== "rejected" ? " Text is retained; this is not a waiting slot." : ""}</p>
      {operation.kind === "enqueue" && operation.state !== "rejected" && <p className="muted">Pause affects only the current server chain. This unconfirmed admission may not yet belong to that chain.</p>}
      {operation.text && <pre className="pending-input-text" tabIndex={0}>{operation.text}</pre>}
      {operation.error && <p className="muted">{operation.error}</p>}
      {operation.state === "unknown" && <div className="pending-input-operation-actions">
        <button type="button" className="text-button" disabled={disabled} onClick={() => operate(() => store.checkPendingInput(operation.requestId))}>Check status</button>
        <button type="button" className="text-button" disabled={disabled} onClick={() => operate(() => store.retransmitPendingInput(operation.requestId))}>Resend same request</button>
      </div>}
    </div>)}
    {state.pendingInputError && <p className="pending-input-error" role="alert">{state.pendingInputError}</p>}
    {(state.pendingInputError || !!view?.snapshot.items.length) && <button type="button" className="text-button" disabled={disabled} onClick={() => operate(() => store.refreshPendingInputs())}>Refresh queue</button>}
    <details className="pending-input-debug"><summary>Debug details</summary><pre tabIndex={0}>{JSON.stringify(debug, null, 2)}</pre></details>
  </section>;
}

/** @deprecated Queue management now lives in ComposerStatus's existing dialog. */
export const PendingInputPanel = PendingInputDetails;
