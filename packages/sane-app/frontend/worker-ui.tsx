import { useEffect, useId, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { FiChevronDown, FiUsers, FiX } from "react-icons/fi";
import type { WorkerRecord } from "../src/worker-contract";
import { workerClient, useWorkers, openWorker, type WorkerStop } from "./worker-client";
import { harnessName, type Conversation, type Run } from "./types";
import { useStore } from "./store";

function Stop({ parent, input, children }: { parent: string; input: WorkerStop; children: string }) {
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  return <><button type="button" disabled={busy} onClick={async () => { setBusy(true); setNotice(""); try { await workerClient.stop(parent, input); setNotice("Stop requested; inspect current status for confirmation."); } catch (e) { setNotice(e instanceof Error ? e.message : "Stop failed"); } finally { setBusy(false); } }}>{busy ? "Requesting…" : children}</button>{notice && <p role="status" className="notice">{notice}</p>}</>;
}
function workerExecution(w: WorkerRecord, runs: Run[], conversation?: Conversation) {
  const latest = runs.filter(r => r.conversationId === w.sessionId).at(-1);
  const currentRunId = latest?.id ?? conversation?.lastRunId;
  const continuation = currentRunId && currentRunId !== w.runId;
  const observedState = latest?.status ?? conversation?.status;
  const newerActiveContinuation = continuation && currentRunId !== w.continuation?.runId && (observedState === "starting" || observedState === "running");
  const executionState = newerActiveContinuation ? observedState : w.continuation?.state ?? (continuation ? observedState ?? "unknown" : w.state);
  return { latest, continuation: !!(w.continuation || continuation), executionState, active: ["reserved", "launching", "starting", "running", "waiting", "cancelling"].includes(executionState) };
}
export function WorkerCard({ worker: w, workers = [], runs = [], open = openWorker }: { worker: WorkerRecord; workers?: WorkerRecord[]; runs?: Run[]; open?: (worker: WorkerRecord) => void }) {
  const conversation = useStore(state => state.conversations.find(c => c.id === w.sessionId));
  const sending = useStore(state => state.sending);
  const { latest, continuation, executionState } = workerExecution(w, runs, conversation);
  const result = w.latestResult ?? w.results?.at(-1);
  const outcome = result?.outcome ?? w.outcome;
  const notification = result?.notification ?? w.notification;
  return <section className="worker-card"><header><strong>{w.input.worker}</strong><span className="harness-badge">{harnessName(w.launch.harness)}</span><span role="status">{w.continuation || continuation ? "Continuation: " : ""}{executionState}</span></header>
    <p>{w.input.prompt}</p>{w.input.context && <details><summary>Task context</summary><pre>{w.input.context}</pre></details>}<p className="muted">{latest?.observedModel || w.launch.model || "Native model default"} · Started {new Date(w.createdAt).toLocaleString()} · {Math.max(0, Math.floor(((w.outcome ? Date.parse(w.outcome.at) : Date.now()) - Date.parse(w.createdAt)) / 1000))}s initial run</p>
    {executionState === "waiting" && <p className="notice">Waiting for permission or input. Open the worker conversation to review pending requests.</p>}
    {w.continuation?.error && <p className="notice error">Continuation: {w.continuation.error}</p>}
    {w.error && <p className="notice error">{w.error}</p>}{w.continuationCancellation && <p className="notice">Continuation stop requested {w.continuationCancellation.requestedAt}. {w.continuationCancellation.error}</p>}
    {outcome && <details open><summary>Latest result{result ? ` · revision ${result.revision}` : ""} · {outcome.status}</summary><p className="muted">{new Date(outcome.at).toLocaleString()} · Run {result?.runId ?? outcome.log?.runId ?? "unavailable"}. Recorded result; current execution status is shown above.</p><pre>{outcome.summary}</pre></details>}
    {notification && <p className="muted">Latest result report-back: {notification.state}{notification.state === "delivered" ? " (accepted by harness; not proof of completed continuation)" : ""}{notification.error && <span className="notice error">{notification.error}</span>}</p>}
    {!!w.results?.length && <details><summary>Result history · {w.results.length}</summary>{w.results.map(r => <section key={r.revision}><strong>Revision {r.revision} · {r.outcome.status}</strong><p className="muted">{r.outcome.at} · Run {r.runId ?? "unavailable"} · Report-back: {r.notification.state}</p><pre>{r.outcome.summary}</pre>{r.notification.error && <p className="notice error">{r.notification.error}</p>}</section>)}</details>}
    {w.outcome && result && result.revision > 1 && <details><summary>Immutable initial outcome · {w.outcome.status}</summary><pre>{w.outcome.summary}</pre></details>}
    <div className="worker-actions"><button type="button" disabled={sending} onClick={() => open(w)}>Open worker</button><Stop parent={w.parent.sessionId} input={{ ids: [w.id] }}>Stop worker</Stop>{workers.some(child => child.parent.sessionId === w.sessionId) && <Stop parent={w.parent.sessionId} input={{ ids: [w.id], includeDescendants: true }}>Stop worker tree</Stop>}</div>
  </section>;
}
function elapsed(w: WorkerRecord, execution: ReturnType<typeof workerExecution>, now: number) {
  const start = execution.latest?.createdAt ?? w.createdAt;
  const end = execution.active ? now : execution.latest?.endedAt ? Date.parse(execution.latest.endedAt) : execution.continuation ? Date.parse((w.latestResult ?? w.results?.at(-1))?.outcome.at ?? w.updatedAt) : Date.parse(w.outcome?.at ?? w.updatedAt);
  const seconds = Math.max(0, Math.floor((end - Date.parse(start)) / 1000));
  const duration = !Number.isFinite(seconds) ? "—" : seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  return `${duration}${execution.continuation && !execution.latest ? " since dispatch" : ""}`;
}

export function WorkersButton({ sessionId }: { sessionId: string }) {
  const projection = useWorkers(sessionId);
  const conversations = useStore(state => state.conversations);
  const runs = useStore(state => state.runs);
  const [opened, setOpened] = useState(false);
  const [now, setNow] = useState(Date.now);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const workers = projection.workers;
  const executions = workers.map(w => workerExecution(w, runs, conversations.find(c => c.id === w.sessionId)));
  const count = executions.filter(e => e.active).length;
  const uncertain = executions.filter(e => e.executionState === "uncertain" || e.executionState === "unknown").length;
  const attention = !!projection.error || projection.deliveries.some(d => d.error) || workers.some(w => w.error || w.continuation?.error || w.continuationCancellation?.error || (w.latestResult ?? w.results?.at(-1))?.notification.error || w.notification?.error);
  useEffect(() => {
    if (!opened) return;
    const element = dialog.current!;
    const position = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      element.style.setProperty("--workers-right", `${Math.max(16, window.innerWidth - rect.right)}px`);
      element.style.setProperty("--workers-bottom", `${window.innerHeight - rect.top + 10}px`);
      element.style.setProperty("--workers-height", `${Math.max(160, rect.top - 26)}px`);
    };
    position();
    element.showModal();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    window.addEventListener("resize", position);
    return () => { clearInterval(timer); window.removeEventListener("resize", position); element.close(); trigger.current?.focus(); };
  }, [opened]);
  const open = (w: WorkerRecord) => { flushSync(() => setOpened(false)); openWorker(w); };
  return <><button ref={trigger} type="button" className={`composer-workers${attention || projection.continuationSuppressed ? " has-issue" : ""}`} aria-haspopup="dialog" aria-expanded={opened} aria-controls={opened ? id : undefined} aria-label={`Workers, ${count} active${uncertain ? `, ${uncertain} unconfirmed` : ""}${attention ? ", attention needed" : ""}${projection.continuationSuppressed ? ", report-back paused" : ""}`} onClick={() => { setNow(Date.now()); setOpened(true); }}><FiUsers size={14} aria-hidden="true" /><span>Workers</span><span className="workers-count" aria-hidden="true">{count}</span>{(attention || projection.continuationSuppressed) && <span className="workers-attention" aria-hidden="true" />}</button>
    {opened && createPortal(<dialog ref={dialog} id={id} className="workers-panel" aria-modal="true" aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); setOpened(false); }} onClick={event => { if (event.target === event.currentTarget) setOpened(false); }}><div className="workers-panel-content">
      <header className="workers-panel-header"><div><h2 id={`${id}-title`}>Workers</h2><p className="muted">{count} active · {workers.length} total{uncertain ? ` · ${uncertain} unconfirmed` : ""}</p></div><button type="button" className="icon-button" aria-label="Close workers" onClick={() => setOpened(false)}><FiX size={18} /></button></header>
      <div className="workers-panel-body">
        {projection.error && <p className="notice error" role="alert">Worker status unavailable: {projection.error}</p>}
        {projection.continuationSuppressed && <p className="notice" role="status">Automatic report-back is paused after an explicit stop. Results remain available; resuming this conversation re-enables delivery.</p>}
        {projection.deliveries.filter(d => d.error).map(d => <p key={d.id} className="notice error" role="alert">Report-back {d.state}: {d.error}</p>)}
        {!workers.length && <div className="workers-empty"><FiUsers size={26} aria-hidden="true" /><h3>No workers yet</h3><p>Delegated tasks will appear here with their progress and results.</p></div>}
        {workers.map((w, index) => { const execution = executions[index]; return <details className="worker-row" key={w.id}><summary><span className={`worker-state-dot${execution.active ? " is-active" : ""}`} aria-hidden="true" /><span className="worker-row-label"><strong>{w.input.worker}</strong><span className="muted">{execution.continuation ? "Continuation · " : ""}{execution.executionState}{w.parent.sessionId !== sessionId ? " · nested worker" : ""}{w.error || w.continuation?.error || w.continuationCancellation?.error || (w.latestResult ?? w.results?.at(-1))?.notification.error || w.notification?.error ? " · Attention needed" : ""}</span></span><span className="worker-row-meta"><span className="harness-badge">{harnessName(w.launch.harness)}</span><span className="muted">{elapsed(w, execution, now)}</span></span><FiChevronDown className="worker-row-chevron" size={14} aria-hidden="true" /></summary><WorkerCard worker={w} workers={workers} runs={runs} open={open} /></details>; })}
      </div>
      {!!workers.length && <footer className="workers-panel-footer"><Stop parent={sessionId} input={{ all: true }}>Stop all workers</Stop><span className="muted">Includes nested workers</span></footer>}
    </div></dialog>, document.body)}
  </>;
}
export function WorkerSection({ sessionId, runId, open = openWorker, collapsible = false }: { sessionId: string; runId?: string; open?: (worker: WorkerRecord) => void; collapsible?: boolean }) {
  const projection = useWorkers(sessionId);
  const children = projection.workers.filter(w => w.parent.sessionId === sessionId && (!runId || w.parent.runId === runId));
  if (!children.length && !projection.error && !projection.continuationSuppressed) return null;
  const content = <>{projection.error && <p className="notice error">Worker status unavailable: {projection.error}</p>}{projection.continuationSuppressed && <p className="notice">Automatic report-back continuation is suppressed after an explicit stop. Outcomes remain available; user resumption re-enables delivery.</p>}{!runId && children.length > 0 && <Stop parent={sessionId} input={{ all: true }}>Stop all workers in this conversation tree</Stop>}{children.map(w => <WorkerCard key={w.id} worker={w} workers={projection.workers} open={open} />)}{projection.deliveries.filter(d => d.error).map(d => <p key={d.id} className="notice error">Report-back {d.state}: {d.error}</p>)}</>;
  const label = <>Workers · {children.length}{projection.error || projection.deliveries.some(d => d.error) ? " · Attention needed" : projection.continuationSuppressed ? " · Report-back paused" : ""}</>;
  return collapsible ? <details className="worker-section"><summary>{label}</summary>{content}</details> : <section className="worker-section"><h3>{label}</h3>{content}</section>;
}
