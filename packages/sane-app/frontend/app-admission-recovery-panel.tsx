import { useState } from "react";
import { store, useStore } from "./store";

const RECOVERY_PAGE_SIZE = 12;

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
      const terminal = !!receipt && receipt.state !== "pending";
      const state = !receipt ? "Unconfirmed" : receipt.state === "pending" ? "Recorded — preparation unresolved"
        : receipt.state === "admitted" ? "App admitted — native outcome separate" : `App rejected (${receipt.rejection.code})`;
      const evidence = record.envelope.intent.operation === "science-message"
        ? science?.[record.envelope.intent.conversationId ?? ""]?.find(item => item.requestId === record.envelope.intent.payload.requestId) : undefined;
      const canDiscard = terminal && (record.envelope.intent.operation !== "science-message" || receipt?.state === "rejected"
        || evidence?.state === "submitted" || evidence?.state === "not-submitted");
      const canRestore = record.draftKey === store.draftKey(selected) && !busy && !draft?.text && !draft?.scienceSnapshots?.length;
      return <section key={id} aria-label={`Submission ${id}`}>
        <p><strong>{state}</strong> <code title={id}>{id.slice(0, 8)}</code></p>
        <p>{record.recovery.text.slice(0, 240)}{record.recovery.text.length > 240 ? "…" : ""}</p>
        <div className="actions">
          <button type="button" disabled={!active || !store.appAdmissionSupported() || checking?.includes(id)} onClick={() => { if (active) void store.checkAppAdmission(id); }}>Check exact status</button>
          <button type="button" disabled={!active || !canRestore || checking?.includes(id)} onClick={async () => { if (active && await store.restoreAppAdmissionDraft(id)) onActionComplete?.(); }}>Restore to empty draft</button>
          {receipt?.state === "admitted" && <button type="button" disabled={!active || busy || checking?.includes(id)} onClick={async () => { if (active && await store.openAppAdmissionConversation(id)) onActionComplete?.(); }}>Open original conversation</button>}
          <button type="button" disabled={!active || !canDiscard || checking?.includes(id)} onClick={() => { if (active) void store.dismissAppAdmissionRecovery(id); }}>Discard terminal recovery</button>
        </div>
        {!!record.recovery.scienceSnapshots?.length && <p className="muted">Original science references remain retained. App admission alone does not establish their transport outcome.</p>}
      </section>;
    })}
  </details>;
}
