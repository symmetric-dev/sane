import { useState } from "react";
import type { WorkerRecord } from "../src/worker-contract";
import { workerClient, useWorkers, openWorker, type WorkerStop } from "./worker-client";
import { harnessName, type Run } from "./types";
import { useStore } from "./store";

function Stop({ parent, input, children }: { parent: string; input: WorkerStop; children: string }) {
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  return <><button type="button" disabled={busy} onClick={async () => { setBusy(true); setNotice(""); try { await workerClient.stop(parent, input); setNotice("Stop requested; inspect current status for confirmation."); } catch (e) { setNotice(e instanceof Error ? e.message : "Stop failed"); } finally { setBusy(false); } }}>{busy ? "Requesting…" : children}</button>{notice && <p role="status" className="notice">{notice}</p>}</>;
}
export function WorkerCard({ worker: w, workers = [], runs = [], open = openWorker }: { worker: WorkerRecord; workers?: WorkerRecord[]; runs?: Run[]; open?: (worker: WorkerRecord) => void }) {
  const latest = runs.filter(r => r.conversationId === w.sessionId).at(-1);
  const conversation = useStore(state => state.conversations.find(c => c.id === w.sessionId));
  const currentRunId = latest?.id ?? conversation?.lastRunId;
  const continuation = currentRunId && currentRunId !== w.runId;
  const result = w.latestResult ?? w.results?.at(-1);
  const outcome = result?.outcome ?? w.outcome;
  const notification = result?.notification ?? w.notification;
  const observedState = latest?.status ?? conversation?.status;
  const newerActiveContinuation = continuation && currentRunId !== w.continuation?.runId && (observedState === "starting" || observedState === "running");
  const executionState = newerActiveContinuation ? observedState : w.continuation?.state ?? (continuation ? observedState ?? "unknown" : w.state);
  return <section className="worker-card"><header><strong>{w.input.worker}</strong><span className="harness-badge">{harnessName(w.launch.harness)}</span><span role="status">{w.continuation || continuation ? "Continuation: " : ""}{executionState}</span></header>
    <p>{w.input.prompt}</p><p className="muted">{latest?.observedModel || w.launch.model || "Native model default"} · Started {new Date(w.createdAt).toLocaleString()} · {Math.max(0, Math.floor(((w.outcome ? Date.parse(w.outcome.at) : Date.now()) - Date.parse(w.createdAt)) / 1000))}s initial run</p>
    {executionState === "waiting" && <p className="notice">Waiting for permission or input. Replies are unavailable in this read-only viewer.</p>}
    {w.continuation?.error && <p className="notice error">Continuation: {w.continuation.error}</p>}
    {w.error && <p className="notice error">{w.error}</p>}{w.continuationCancellation && <p className="notice">Continuation stop requested {w.continuationCancellation.requestedAt}. {w.continuationCancellation.error}</p>}
    {outcome && <details open><summary>Latest result{result ? ` · revision ${result.revision}` : ""} · {outcome.status}</summary><p className="muted">{new Date(outcome.at).toLocaleString()} · Run {result?.runId ?? outcome.log?.runId ?? "unavailable"}. Recorded result; current execution status is shown above.</p><pre>{outcome.summary}</pre></details>}
    {notification && <p className="muted">Latest result report-back: {notification.state}{notification.state === "delivered" ? " (accepted by harness; not proof of completed continuation)" : ""}{notification.error && <span className="notice error">{notification.error}</span>}</p>}
    {!!w.results?.length && <details><summary>Result history · {w.results.length}</summary>{w.results.map(r => <section key={r.revision}><strong>Revision {r.revision} · {r.outcome.status}</strong><p className="muted">{r.outcome.at} · Run {r.runId ?? "unavailable"} · Report-back: {r.notification.state}</p><pre>{r.outcome.summary}</pre>{r.notification.error && <p className="notice error">{r.notification.error}</p>}</section>)}</details>}
    {w.outcome && result && result.revision > 1 && <details><summary>Immutable initial outcome · {w.outcome.status}</summary><pre>{w.outcome.summary}</pre></details>}
    <div className="worker-actions"><button type="button" onClick={() => open(w)}>Open worker</button><Stop parent={w.parent.sessionId} input={{ ids: [w.id] }}>Stop worker</Stop>{workers.some(child => child.parent.sessionId === w.sessionId) && <Stop parent={w.parent.sessionId} input={{ ids: [w.id], includeDescendants: true }}>Stop worker tree</Stop>}</div>
  </section>;
}
export function WorkerSection({ sessionId, runId, open = openWorker }: { sessionId: string; runId?: string; open?: (worker: WorkerRecord) => void }) {
  const projection = useWorkers(sessionId);
  const children = projection.workers.filter(w => w.parent.sessionId === sessionId && (!runId || w.parent.runId === runId));
  if (!children.length && !projection.error && !projection.continuationSuppressed) return null;
  return <section className="worker-section"><h3>Workers · {children.length}</h3>{projection.error && <p className="notice error">Worker status unavailable: {projection.error}</p>}{projection.continuationSuppressed && <p className="notice">Automatic report-back continuation is suppressed after an explicit stop. Outcomes remain available; user resumption re-enables delivery.</p>}{!runId && children.length > 0 && <Stop parent={sessionId} input={{ all: true }}>Stop all workers in this conversation tree</Stop>}{children.map(w => <WorkerCard key={w.id} worker={w} workers={projection.workers} open={open} />)}{projection.deliveries.filter(d => d.error).map(d => <p key={d.id} className="notice error">Report-back {d.state}: {d.error}</p>)}</section>;
}
