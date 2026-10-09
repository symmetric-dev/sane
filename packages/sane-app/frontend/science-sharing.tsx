import { useEffect, useState } from "react";
import { conversationClient } from "./cc-client";
import { store, useStore } from "./store";
import type { ScienceSubmissionDetail, ScienceSubmissionView } from "./types";
import "./science-sharing.css";

const transportNote = "Text only. Images and interactive content are omitted; no image attachments are sent. Any serialization truncation or omission counts appear in the frozen text below.";

/** Mount once in the ordinary composer, outside review/compaction forms. */
export function ScienceShareDraftPreview() {
  const state = useStore(state => state);
  const conversationId = state.selected;
  const snapshots = store.sciencePreview();
  const pending = state.sciencePending?.[conversationId];
  const recoveries = state.scienceRecoveries?.[conversationId] ?? [];
  if (state.phase !== "ready" || state.config?.authenticated !== true || !conversationId || !snapshots.length && !pending && !recoveries.length) return null;
  return <section className="science-sharing" aria-label="Science share draft">
    {recoveries.map(recovery => <div className="science-sharing-pending" key={recovery.requestId}>
      <strong>Rejected science draft retained</strong>
      <p>This request was refused. You can send your current draft without discarding this recovery.</p>
      <details><summary>Rejected comment and snapshots</summary>
        {recovery.text && <pre>{recovery.text}</pre>}
        {recovery.snapshots.map(snapshot => <div key={snapshot.snapshotId}><p>Snapshot {snapshot.snapshotId}</p><pre>{snapshot.agentText}</pre></div>)}
      </details>
      <button type="button" className="text-button" disabled={state.sending || state.actionBusy || !!store.draft().text || !!snapshots.length || store.pendingInputChainLocked()}
        onClick={() => store.consumeScienceRecovery(conversationId, recovery.requestId, true, state.config!.storeId!)}>Restore to empty draft</button>
      <button type="button" className="text-button" disabled={state.sending || state.actionBusy || store.pendingInputChainLocked()}
        onClick={() => store.consumeScienceRecovery(conversationId, recovery.requestId, false, state.config!.storeId!)}>Discard recovery</button>
    </div>)}
    {pending && <div className="science-sharing-pending" role="status">
      <strong>{state.sending ? "Science send pending" : "Science send unresolved"}</strong>
      <p>The original request is retained. It will not be resent automatically. Check recorded history for its outcome.</p>
      <code>Request {pending.requestId}</code>
      <details>
        <summary>Original pending comment and snapshots</summary>
        <p className="science-sharing-note">{transportNote}</p>
        {pending.text && <pre>{pending.text}</pre>}
        {pending.snapshots.map(snapshot => <div key={snapshot.snapshotId}>
          <p className="science-sharing-label">Snapshot {snapshot.snapshotId}</p>
          <pre>{snapshot.agentText}</pre>
        </div>)}
      </details>
    </div>}
    {snapshots.length > 0 && <>
      <header><strong>Science context staged for send</strong><span className="science-sharing-label">{snapshots.length} snapshot{snapshots.length === 1 ? "" : "s"}</span></header>
      <p className="science-sharing-note">{transportNote}</p>
      {snapshots.map(snapshot => <article className="science-sharing-snapshot" key={snapshot.snapshotId}>
        <header>
          <span className="science-sharing-label">Block {snapshot.blockId} · revision {snapshot.revision}</span>
          <button type="button" className="text-button" disabled={state.sending} aria-label={`Remove science snapshot ${snapshot.snapshotId}`}
            onClick={() => {
              const current = store.snapshot();
              if (current.selected === conversationId && current.config?.storeId === state.config?.storeId && current.phase === "ready" && !current.sending) store.removeScienceSnapshot(snapshot.snapshotId);
            }}>Remove</button>
        </header>
        <details open>
          <summary>Exact frozen text context</summary>
          <pre>{snapshot.agentText}</pre>
        </details>
        <details><summary>Immutable source</summary><pre>{snapshot.source}</pre></details>
        <small className="science-sharing-label">Snapshot {snapshot.snapshotId}. Editing the local block does not change this snapshot.</small>
      </article>)}
    </>}
    {state.scienceSubmissionError && <p className="science-sharing-error" role="status">{state.scienceSubmissionError}</p>}
  </section>;
}

export interface ScienceSentSnapshotsProps { conversationId: string; runId: string }

/** Mount once beside a canonical user turn for this run. Never match prompt text.
 * Receipt metadata comes from the store's independent durable run-ID map. */
export function ScienceSentSnapshots({ conversationId, runId }: ScienceSentSnapshotsProps) {
  const state = useStore(state => state);
  if (state.phase !== "ready" || state.config?.authenticated !== true || !state.config.storeId || state.selected !== conversationId || !runId) return null;
  const receipts = (state.scienceSubmissions?.[conversationId] ?? []).filter(receipt => receipt.state === "submitted" && receipt.conversationId === conversationId && receipt.runId === runId);
  if (!receipts.length) return null;
  if (receipts.length !== 1) return <p className="science-sharing-error" role="status">Science snapshot association is ambiguous. No snapshot is shown.</p>;
  const receipt = receipts[0];
  const scope = JSON.stringify([state.config.storeId, conversationId, runId, receipt.requestId, receipt.snapshots]);
  return <SentReceipt key={scope} scope={scope} storeId={state.config.storeId} receipt={receipt} />;
}

type DetailState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; detail: ScienceSubmissionDetail };

function SentReceipt({ scope, storeId, receipt }: { scope: string; storeId: string; receipt: ScienceSubmissionView }) {
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const { conversationId, requestId, runId } = receipt;
  const expectedSnapshots = JSON.stringify(receipt.snapshots.map(({ snapshotId, blockId }) => ({ snapshotId, blockId })));
  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    const current = () => {
      const active = store.snapshot();
      return live && !controller.signal.aborted && active.selected === conversationId && active.phase === "ready"
        && active.config?.authenticated === true && active.config.storeId === storeId;
    };
    setState({ status: "loading" });
    const load = async () => {
      try {
        if (!conversationClient.scienceSubmission) throw new Error("Frozen science snapshot retrieval is unavailable.");
        const detail = await conversationClient.scienceSubmission(conversationId, requestId, controller.signal);
        if (!current()) return;
        if (!detail || detail.state !== "submitted" || detail.conversationId !== conversationId || detail.runId !== runId || detail.requestId !== requestId
          || typeof detail.text !== "string" || !Array.isArray(detail.snapshots)
          || detail.snapshots.some(snapshot => !snapshot || typeof snapshot.agentText !== "string" || typeof snapshot.source !== "string")
          || JSON.stringify(detail.snapshots.map(({ snapshotId, blockId }) => ({ snapshotId, blockId }))) !== expectedSnapshots) throw new Error("Frozen science snapshots do not match this run's submitted receipt.");
        setState({ status: "ready", detail });
      } catch (error) {
        if (current()) setState({ status: "error", message: error instanceof Error ? error.message : "Frozen science snapshots could not be loaded." });
      }
    };
    void load();
    return () => { live = false; controller.abort(); };
  }, [scope, storeId, conversationId, requestId, runId, expectedSnapshots]);

  return <section className="science-sharing science-sharing-sent" aria-label="Sent science snapshots" aria-busy={state.status === "loading"}>
    <header><strong>Sent science context</strong><span className="science-sharing-label">Immutable · text only</span></header>
    {state.status === "loading" && <p role="status">Loading frozen snapshots…</p>}
    {state.status === "error" && <p className="science-sharing-error" role="status">{state.message} No send was retried.</p>}
    {state.status === "ready" && <>
      <p className="science-sharing-note">{transportNote}</p>
      <p className="science-sharing-note">Submission is recorded for this run; this does not establish notebook execution success.</p>
      {state.detail.snapshots.map(snapshot => <article className="science-sharing-snapshot" key={snapshot.snapshotId}>
        <header><span className="science-sharing-label">Block {snapshot.blockId}</span></header>
        <details><summary>Exact text sent to the agent</summary><pre>{snapshot.agentText}</pre></details>
        <details><summary>Immutable source</summary><pre>{snapshot.source}</pre></details>
        <small className="science-sharing-label">Snapshot {snapshot.snapshotId}</small>
      </article>)}
    </>}
  </section>;
}
