import { useState } from "react";
import { store, useStore, type State } from "./store";

const RECOVERY_PAGE_SIZE = 12;

/** Read-only retirement surface. Only explicit draft/rejected-recovery discard
 * is allowed; unresolved sends have status checks, never restore or resend. */
export function LegacyScienceRecovery({ state, active = true }: { state: State; active?: boolean }) {
  const id = state.selected, storeId = state.config?.storeId;
  const snapshots = state.drafts[store.draftKey()]?.scienceSnapshots ?? [];
  const pending = state.sciencePending?.[id];
  const recoveries = state.scienceRecoveries?.[id] ?? [];
  const unresolved = state.scienceSubmissions?.[id]?.filter(item => item.state === "prepared" || item.state === "unknown") ?? [];
  const blocked = store.legacyScienceSendBlocked();
  if (state.phase !== "ready" || !snapshots.length && !pending && !recoveries.length && !unresolved.length && !state.scienceSubmissionError && !blocked) return null;
  const disabled = !active || !state.config?.authenticated || !storeId || state.sending || state.actionBusy || store.pendingInputChainLocked();
  return <section className="notice legacy-science-recovery" aria-label="Legacy Python recovery">
    <p><strong>Python chat sharing is retired.</strong> Original payloads remain available below. Status checks never resend them; use Files for Notebook view.</p>
    {blocked && <p role="status">{blocked}</p>}
    {state.scienceSubmissionError && <p role="alert">{state.scienceSubmissionError}</p>}
    <button type="button" className="text-button" disabled={!active || !id || !state.config?.authenticated} onClick={() => { if (active) store.checkLegacyScienceRecovery(); }}>Check legacy status</button>
    {!!snapshots.length && <div>
      <details><summary>Retained draft snapshots ({snapshots.length})</summary><pre>{JSON.stringify(snapshots, null, 2)}</pre></details>
      <button type="button" className="text-button" disabled={disabled} onClick={() => { if (active && storeId) store.discardLegacyScienceDraft(id, storeId); }}>Discard draft snapshots; keep text</button>
    </div>}
    {pending && <details><summary>Unresolved original send · {pending.requestId}</summary><pre>{JSON.stringify(pending, null, 2)}</pre></details>}
    {unresolved.map(item => <p key={item.requestId}>Original request <code>{item.requestId}</code>: {item.state}. Inspect its original receipt or native history before sending again.</p>)}
    {recoveries.map(item => <div key={item.requestId}>
      <details><summary>Rejected original draft · {item.requestId}</summary><pre>{JSON.stringify(item, null, 2)}</pre></details>
      <button type="button" className="text-button" disabled={disabled} onClick={() => { if (active && storeId) store.discardLegacyScienceRecovery(id, item.requestId, storeId); }}>Discard rejected recovery</button>
    </div>)}
  </section>;
}

/** Recovery exposes status/restore only. There is deliberately no Send/Retry or
 * resume/cancel operation, and App admission is not native delivery evidence. */
export function AppAdmissionRecoveryPanel({ active = true, onActionComplete }: { active?: boolean; onActionComplete?: () => void }) {
  const [pageIndex, setPageIndex] = useState(0);
  const records = useStore(state => state.appAdmissionRecoveries);
  const checking = useStore(state => state.appAdmissionChecking);
  const error = useStore(state => state.appAdmissionError);
  const phase = useStore(state => state.phase);
  const config = useStore(state => state.config);
  const science = useStore(state => state.scienceSubmissions);
  const selected = useStore(state => state.selected);
  const draft = useStore(state => state.drafts[store.draftKey()]);
  const busy = useStore(state => state.sending || state.actionBusy);
  if (phase !== "ready") return null;
  const entries = Object.values(records ?? {}), unresolved = entries.filter(record => !record.receipt || record.receipt.state === "pending").length;
  if (!entries.length) return config?.appAdmissionCapability?.state !== "enabled"
    ? <p className="notice">Ordinary sending requires an updated, explicitly initialized App admission store. History remains readable and your draft is unchanged.</p> : null;
  const pageCount = Math.ceil(entries.length / RECOVERY_PAGE_SIZE);
  // Retention or dismissal can remove the last page while it is selected.
  const currentPage = Math.min(pageIndex, pageCount - 1);
  const pageStart = currentPage * RECOVERY_PAGE_SIZE;
  const visibleEntries = entries.slice().reverse().slice(pageStart, pageStart + RECOVERY_PAGE_SIZE);
  return <details className="notice" open={unresolved > 0}>
    <summary>Message receipts · {unresolved ? `${unresolved} awaiting status / ` : ""}{entries.length} saved</summary>
    <p className="muted">App receipts track recording, not native delivery. Status checks never resend a request.</p>
    {error && <p role="alert">{error}</p>}
    <nav aria-label="App submission recovery pages">
      <p className="muted" role="status" aria-live="polite" aria-atomic="true">
        Showing {pageStart + 1}–{Math.min(pageStart + RECOVERY_PAGE_SIZE, entries.length)} of {entries.length} retained records, newest first. Page {currentPage + 1} of {pageCount}.
      </p>
      {pageCount > 1 && <div className="actions">
        <button type="button" disabled={!active || currentPage === 0} onClick={() => { if (active) setPageIndex(currentPage - 1); }}>Previous page</button>
        <button type="button" disabled={!active || currentPage === pageCount - 1} onClick={() => { if (active) setPageIndex(currentPage + 1); }}>Next page</button>
      </div>}
    </nav>
    {visibleEntries.map(record => {
      const id = record.envelope.clientRequestId, receipt = record.receipt;
      const legacyScience = record.envelope.intent.operation === "science-message" || !!record.recovery.scienceSnapshots?.length;
      const terminal = !!receipt && receipt.state !== "pending";
      const state = !receipt ? "Unconfirmed" : receipt.state === "pending" ? "Recorded — preparation unresolved"
        : receipt.state === "admitted" ? "App admitted — native outcome separate" : `App rejected (${receipt.rejection.code})`;
      const evidence = record.envelope.intent.operation === "science-message"
        ? science?.[record.envelope.intent.conversationId ?? ""]?.find(item => item.requestId === record.envelope.intent.payload.requestId) : undefined;
      const canDiscard = terminal && (record.envelope.intent.operation !== "science-message" || receipt?.state === "rejected"
        || evidence?.state === "submitted" || evidence?.state === "not-submitted");
      const canRestore = !legacyScience
        && record.draftKey === store.draftKey(selected) && !busy && !draft?.text && !draft?.scienceSnapshots?.length;
      return <section key={id} className={legacyScience ? "legacy-science-recovery" : undefined} aria-label={`Submission ${id}`}>
        <p><strong>{state}</strong> <code title={id}>{id.slice(0, 8)}</code></p>
        <p>{record.recovery.text.slice(0, 240)}{record.recovery.text.length > 240 ? "…" : ""}</p>
        {legacyScience && <details><summary>Original retired science payload</summary><pre>{JSON.stringify({ intent: record.envelope.intent, recovery: record.recovery }, null, 2)}</pre></details>}
        <div className="actions">
          <button type="button" disabled={!active || !store.appAdmissionSupported() || checking?.includes(id)} onClick={() => { if (active) void store.checkAppAdmission(id); }}>Check exact status</button>
          <button type="button" disabled={!active || !canRestore || checking?.includes(id)} onClick={async () => { if (active && await store.restoreAppAdmissionDraft(id)) onActionComplete?.(); }}>Restore to empty draft</button>
          {receipt?.state === "admitted" && <button type="button" disabled={!active || busy || checking?.includes(id)} onClick={async () => { if (active && await store.openAppAdmissionConversation(id)) onActionComplete?.(); }}>Open original conversation</button>}
          <button type="button" disabled={!active || !canDiscard || checking?.includes(id)} onClick={() => { if (active) void store.dismissAppAdmissionRecovery(id); }}>Discard terminal recovery</button>
        </div>
        {!!record.recovery.scienceSnapshots?.length && <p className="muted">The Python chat integration is retired. Original snapshot references remain retained for recovery; App admission alone does not establish their transport outcome. These records cannot be restored or resent.</p>}
      </section>;
    })}
  </details>;
}
