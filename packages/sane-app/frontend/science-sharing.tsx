import { useEffect, useState, type ReactNode } from "react";
import { ShellDialog } from "./shell-dialog";
import { conversationClient } from "./cc-client";
import { store, useStore } from "./store";
import type { ScienceSubmissionDetail, ScienceSubmissionView } from "./types";
import "./science-sharing.css";

const transportNote = "Text only. Images and interactive content are omitted; no image attachments are sent. Any serialization truncation or omission counts appear in the frozen text below.";

function SnapshotInfo({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <><button type="button" className="text-button" onClick={() => setOpen(true)}>Info</button>{open && <ShellDialog title="Python snapshot info" close={() => setOpen(false)}><div className="science-sharing-info"><p>{transportNote}</p>{children}</div></ShellDialog>}</>;
}

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
      <SnapshotInfo><h3>Rejected comment and snapshots</h3>
        {recovery.text && <pre>{recovery.text}</pre>}
        {recovery.snapshots.map(snapshot => <div key={snapshot.snapshotId}><p>Snapshot {snapshot.snapshotId}</p><pre>{snapshot.agentText}</pre></div>)}
      </SnapshotInfo>
      <button type="button" className="text-button" disabled={state.sending || state.actionBusy || !!store.draft().text || !!snapshots.length || store.pendingInputChainLocked()}
        onClick={() => store.consumeScienceRecovery(conversationId, recovery.requestId, true, state.config!.storeId!)}>Restore to empty draft</button>
      <button type="button" className="text-button" disabled={state.sending || state.actionBusy || store.pendingInputChainLocked()}
        onClick={() => store.consumeScienceRecovery(conversationId, recovery.requestId, false, state.config!.storeId!)}>Discard recovery</button>
    </div>)}
    {pending && <div className="science-sharing-pending" role="status">
      <strong>{state.sending ? "Science send pending" : "Science send unresolved"}</strong>
      <p>The original request is retained. It will not be resent automatically. Check recorded history for its outcome.</p>
      <SnapshotInfo>
        <h3>Original pending comment and snapshots</h3>
        <code>Request {pending.requestId}</code>
        <p className="science-sharing-note">{transportNote}</p>
        {pending.text && <pre>{pending.text}</pre>}
        {pending.snapshots.map(snapshot => <div key={snapshot.snapshotId}>
          <p className="science-sharing-label">Snapshot {snapshot.snapshotId}</p>
          <pre>{snapshot.agentText}</pre>
        </div>)}
      </SnapshotInfo>
    </div>}
    {snapshots.length > 0 && <>
      <header><strong>Python attachments</strong><span className="science-sharing-label">{snapshots.length} snapshot{snapshots.length === 1 ? "" : "s"}</span></header>
      <p className="science-sharing-note">Source and text only · images omitted</p>
      {snapshots.map((snapshot, index) => <article className="science-sharing-snapshot" key={snapshot.snapshotId}>
        <header>
          <span>Snapshot {index + 1}</span>
          <SnapshotInfo><p>Block {snapshot.blockId} · revision {snapshot.revision}</p><p>Snapshot {snapshot.snapshotId}. Editing the cell does not change this snapshot.</p><h3>Exact frozen text context</h3><pre>{snapshot.agentText}</pre><details><summary>Immutable source</summary><pre>{snapshot.source}</pre></details></SnapshotInfo>
          <button type="button" className="text-button" disabled={state.sending} aria-label={`Remove science snapshot ${snapshot.snapshotId}`}
            onClick={() => {
              const current = store.snapshot();
              if (current.selected === conversationId && current.config?.storeId === state.config?.storeId && current.phase === "ready" && !current.sending) store.removeScienceSnapshot(snapshot.snapshotId);
            }}>Remove</button>
        </header>
        <details><summary>Preview source</summary><pre>{snapshot.source}</pre></details>
      </article>)}
    </>}
    {state.scienceSubmissionError && <p className="science-sharing-error" role="status">{state.scienceSubmissionError}</p>}
  </section>;
}

export interface ScienceSentSnapshotsProps { conversationId: string; runId: string }

const emptyReceipts: ScienceSubmissionView[] = [];
const receiptIndexes = new WeakMap<ScienceSubmissionView[], Map<string, ScienceSubmissionView[]>>();
function receiptsForRun(receipts: ScienceSubmissionView[] | undefined, conversationId: string, runId: string) {
  if (!receipts) return emptyReceipts;
  let index = receiptIndexes.get(receipts);
  if (!index) {
    index = new Map();
    for (const receipt of receipts) {
      if (receipt.state !== "submitted") continue;
      const key = JSON.stringify([receipt.conversationId, receipt.runId]);
      const group = index.get(key) ?? [];
      group.push(receipt); index.set(key, group);
    }
    receiptIndexes.set(receipts, index);
  }
  return index.get(JSON.stringify([conversationId, runId])) ?? emptyReceipts;
}

/** Mount once beside a canonical user turn for this run. Never match prompt text.
 * Receipt metadata comes from the store's independent durable run-ID map. */
export function ScienceSentSnapshots({ conversationId, runId }: ScienceSentSnapshotsProps) {
  const storeId = useStore(state => state.phase === "ready" && state.config?.authenticated === true && state.selected === conversationId ? state.config.storeId : undefined);
  const receipts = useStore(state => receiptsForRun(state.scienceSubmissions?.[conversationId], conversationId, runId));
  if (!storeId || !runId) return null;
  if (!receipts.length) return null;
  if (receipts.length !== 1) return <p className="science-sharing-error" role="status">Science snapshot association is ambiguous. No snapshot is shown.</p>;
  const receipt = receipts[0];
  const scope = JSON.stringify([storeId, conversationId, runId, receipt.requestId, receipt.snapshots]);
  return <SentReceipt key={scope} scope={scope} storeId={storeId} receipt={receipt} />;
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
    <header><strong>Python attachments</strong><span className="science-sharing-label">Sent · text only</span></header>
    {state.status === "loading" && <p role="status">Loading frozen snapshots…</p>}
    {state.status === "error" && <p className="science-sharing-error" role="status">{state.message} No send was retried.</p>}
    {state.status === "ready" && <>
      <p className="science-sharing-note">Images omitted</p>
      {state.detail.snapshots.map((snapshot, index) => <article className="science-sharing-snapshot" key={snapshot.snapshotId}>
        <header><span>Snapshot {index + 1}</span><SnapshotInfo><p>Block {snapshot.blockId}</p><p>Snapshot {snapshot.snapshotId}</p><p>Submission is recorded for this run; this does not establish notebook execution success.</p><h3>Exact text sent to the agent</h3><pre>{snapshot.agentText}</pre><details><summary>Immutable source</summary><pre>{snapshot.source}</pre></details></SnapshotInfo></header>
        <details><summary>View source</summary><pre>{snapshot.source}</pre></details>
      </article>)}
    </>}
  </section>;
}
