import { useId, useState } from "react";
import type { CompactionRecord } from "../src/oc-contract";
import { ShellDialog } from "./shell-dialog";
import { store, type State } from "./store";
import "./compaction.css";

const triggerLabel = { auto: "Automatic", manual: "Manual", unknown: "Unknown trigger" };
const lifecycleLabel = { requested: "requested", running: "running", completed: "completed", failed: "failed", skipped: "skipped", unconfirmed: "completion unconfirmed" };

export function CompactionMarkers({ records = [] }: { records?: CompactionRecord[] }) {
  return <>{records.map(record => <div key={record.id} className={`compaction-marker ${record.lifecycle}`} data-compaction-id={record.id}>
    <span>{triggerLabel[record.trigger]} context compaction · {lifecycleLabel[record.lifecycle]}</span>
    {(record.preTokens !== undefined || record.postTokens !== undefined || record.durationMs !== undefined || record.error !== undefined) && <details><summary>Details</summary>
      {record.preTokens !== undefined && <span>Before: {record.preTokens.toLocaleString()} tokens</span>}
      {record.postTokens !== undefined && <span>After: {record.postTokens.toLocaleString()} tokens</span>}
      {record.durationMs !== undefined && <span>Duration: {record.durationMs.toLocaleString()} ms</span>}
      {record.error !== undefined && <pre>{typeof record.error === "string" ? record.error : JSON.stringify(record.error, null, 2)}</pre>}
    </details>}
  </div>)}</>;
}

export function CompactControl({ state }: { state: State }) {
  const reason = store.compactUnavailable();
  if (!store.capabilities().compaction) return null;
  return <button type="button" className="text-button compact-control" aria-haspopup="dialog" disabled={!state.selected} title={reason || "Summarize this conversation’s context without sending a message."} onClick={() => store.openCompact()}>Compact now</button>;
}

export function CompactDialog({ state }: { state: State }) {
  return store.capabilities().compaction && state.compactDialog && state.compactDialog === state.selected ? <CompactDialogBody key={state.selected} state={state} /> : null;
}

function CompactDialogBody({ state }: { state: State }) {
  const instructionsId = useId();
  // This acknowledgment belongs only to compaction, never to the composer send.
  const [nativeStopped, setNativeStopped] = useState(false);
  const pending = state.pendingCompacts?.[state.selected];
  const busy = pending?.phase === "sending";
  const uncertain = pending?.phase === "unconfirmed";
  const locked = busy || uncertain;
  const eligibility = state.compactState?.eligibility;
  const reason = store.compactUnavailable();
  const capabilities = store.capabilities();
  const needsAck = eligibility?.requiresNativeStopped || capabilities.attachedSendRequiresNativeStopped && !!state.conversations.find(c => c.id === state.selected)?.attachment;
  const instructions = locked ? pending?.payload.instructions ?? "" : state.compactInstructions?.[state.selected] ?? "";
  const visibleOperations = state.compactions?.slice(-3);
  return <ShellDialog title="Compact context" className="compact-dialog" close={store.closeCompact}>
    <form className="compact-form" aria-busy={busy} onSubmit={event => {
      event.preventDefault();
      const acknowledged = nativeStopped;
      setNativeStopped(false);
      void store.compact(acknowledged);
    }}>
      <p className="muted">Summarize the existing context in the native harness. This is not a conversation turn. Your message draft and pending agent upgrade are preserved.</p>
      {reason && <p className="notice" role="status">{reason}</p>}
      {capabilities.compactionInstructions && eligibility?.supportsInstructions && <label htmlFor={instructionsId}>Instructions <span className="muted">(optional)</span><textarea id={instructionsId} rows={4} maxLength={100000} value={instructions} readOnly={locked} placeholder="What should the summary preserve?" onChange={event => store.setCompactInstructions(event.target.value)} /></label>}
      {needsAck && <label className="notice compact-ack"><input type="checkbox" checked={nativeStopped} disabled={busy} onChange={event => setNativeStopped(event.target.checked)} />I confirm external assistant execution for this conversation is stopped before compacting.</label>}
      {busy && <p role="status" className="notice">Requesting compaction…</p>}
      {uncertain && <p role="status" className="notice">Acceptance is unconfirmed. This request will not be retried automatically. Check status or explicitly resume the same request.</p>}
      <CompactionMarkers records={visibleOperations} />
      {state.compactError && <p className="notice error" role="alert">{state.compactError}</p>}
      <div className="compact-actions"><button type="button" className="text-button" onClick={store.closeCompact}>Close</button><button type="button" className="text-button" disabled={busy} onClick={() => void store.refreshCompact()}>Check status</button><button type="submit" className="primary-button" disabled={busy || !!reason || !!needsAck && !nativeStopped}>{uncertain ? "Resume same request" : "Compact now"}</button></div>
      <p className="muted compact-hint">Native completion is shown only when confirmed. Stopping an App-owned run does not interrupt an external native session.</p>
    </form>
  </ShellDialog>;
}
