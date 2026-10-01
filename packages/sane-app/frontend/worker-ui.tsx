import { useEffect, useId, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { FiCheckCircle, FiInfo, FiUsers, FiX } from "react-icons/fi";
import type { WorkerDelivery, WorkerRecord, WorkerResult } from "../src/worker-contract";
import { workerResults } from "../src/worker-contract";
import { builtinProfiles } from "../src/agent-profiles-contract";
import { WORKER_AGENT_CATALOG } from "sane-core/agent-catalog";
import { AgentAvatar } from "./agent-visuals";
import { workerClient, useWorkers, openWorker, type WorkerStop } from "./worker-client";
import { harnessName, type Conversation, type Run } from "./types";
import { useStore } from "./store";

function Stop({ parent, input, children, disabled = false }: { parent: string; input: WorkerStop; children: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  return <><button type="button" disabled={busy || disabled} onClick={async () => { setBusy(true); setNotice(""); try { await workerClient.stop(parent, input); setNotice("Stop requested; inspect current status for confirmation."); } catch (e) { setNotice(e instanceof Error ? e.message : "Stop failed"); } finally { setBusy(false); } }}>{busy ? "Requesting…" : children}</button>{notice && <p role="status" className="notice">{notice}</p>}</>;
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
const defaultWorkerProfiles = builtinProfiles("");
function useWorkerVisual(w: WorkerRecord) {
  const profiles = useStore(state => state.profiles ?? state.config?.agentProfiles);
  return profiles?.profiles.find(p => p.id === w.launch.profileId) ?? defaultWorkerProfiles.find(p => p.id === `worker:${w.input.worker}`)!;
}
type WorkerView = "result" | "history" | "details";
function WorkerDetails({ worker: w, view, result, close, trigger }: { worker: WorkerRecord; view: WorkerView; result?: WorkerResult; close: () => void; trigger: HTMLButtonElement | null }) {
  const profile = useWorkerVisual(w);
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const results = workerResults(w);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => { element.close(); if (trigger?.isConnected) trigger.focus(); };
  }, [trigger]);
  const report = (r: WorkerResult) => <section className="worker-result" key={r.revision}><header><strong>Result {r.revision}</strong><span className="worker-status">{r.outcome.status}</span><time dateTime={r.outcome.at}>{new Date(r.outcome.at).toLocaleString()}</time></header><pre className="worker-result-output">{r.outcome.summary}</pre></section>;
  return createPortal(<dialog ref={dialog} className="worker-details-dialog" aria-modal="true" aria-labelledby={id} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <header className="worker-details-header"><AgentAvatar profile={profile} /><div><h2 id={id}>{profile.label || WORKER_AGENT_CATALOG[w.input.worker].label}</h2><p className="muted">{view === "result" ? "Worker result" : view === "history" ? `Result history · ${results.length}` : "Worker details"}</p></div><button type="button" className="icon-button" aria-label="Close worker details" onClick={close}><FiX size={18} /></button></header>
    <div className="worker-details-body">{view === "result" ? result ? report(result) : <p className="muted">No result recorded yet.</p> : view === "history" ? results.map(report) : <>
      <dl className="facts">{[["Harness", harnessName(w.launch.harness)], ["Model", w.launch.model || "Native default"], ["Worker ID", w.id], ["Conversation ID", w.sessionId], ["Native session ID", w.child?.nativeId ?? "Unavailable"], ["Initial run", w.runId ?? "Unavailable"], ["Continuation run", w.continuation?.runId ?? "None"], ["Report-back", (w.latestResult ?? results.at(-1))?.notification.state ?? "No result yet"]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      {w.error && <p className="notice error">{w.error}</p>}{w.continuation?.error && <p className="notice error">{w.continuation.error}</p>}{w.continuationCancellation && <p className="notice">Stop requested {new Date(w.continuationCancellation.requestedAt).toLocaleString()}. {w.continuationCancellation.error}</p>}
      {results.map(r => <p className="muted" key={r.revision}>Result {r.revision} · {r.notification.state}{r.notification.error && <span className="notice error">{r.notification.error}</span>}</p>)}
    </>}</div>
  </dialog>, document.body);
}
export function WorkerCard({ worker: w, workers = [], runs = [], open = openWorker, resultRevision }: { worker: WorkerRecord; workers?: WorkerRecord[]; runs?: Run[]; open?: (worker: WorkerRecord) => void; resultRevision?: number }) {
  const conversation = useStore(state => state.conversations.find(c => c.id === w.sessionId));
  const sending = useStore(state => state.sending);
  const execution = workerExecution(w, runs, conversation);
  const profile = useWorkerVisual(w);
  const results = workerResults(w);
  const result = resultRevision === undefined ? results.at(-1) : results.find(r => r.revision === resultRevision);
  const reporting = resultRevision !== undefined;
  const moving = !reporting && execution.active;
  const [now, setNow] = useState(Date.now);
  const [view, setView] = useState<WorkerView | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { if (!moving) return; setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [moving]);
  const show = (next: WorkerView, button: HTMLButtonElement) => { trigger.current = button; setView(next); };
  const attention = !!(w.error || w.continuation?.error || w.continuationCancellation?.error || results.some(r => r.notification.error));
  const timestamp = reporting ? result?.outcome.at : execution.latest?.createdAt ?? w.createdAt;
  const reportRun = reporting && result ? runs.find(r => r.id === result.runId) : undefined;
  const reportStart = reportRun?.createdAt ?? (result?.runId === w.runId ? w.createdAt : undefined);
  const duration = reporting ? result && reportStart ? durationBetween(reportStart, Date.parse(result.outcome.at)) : undefined : elapsed(w, execution, now);
  return <section className={`worker-card${moving ? " is-active" : ""}${reporting ? " is-report" : ""}`}>
    <header><span className={`worker-avatar${moving ? " is-active" : ""}`}><AgentAvatar profile={profile} size={36} /></span><div className="worker-card-heading"><strong>{profile.label || WORKER_AGENT_CATALOG[w.input.worker].label}</strong><span className="worker-card-timing">{timestamp && <time dateTime={timestamp} title={new Date(timestamp).toLocaleString()}>{new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>}{duration && <span>{duration}</span>}</span></div><span className={`worker-status${moving ? " is-active" : ""}`} role="status">{reporting ? result?.outcome.status ?? "Result unavailable" : `${execution.continuation ? "Continuation · " : ""}${execution.executionState}`}</span></header>
    <div className="worker-result-links"><button type="button" className="text-button" disabled={!result} onClick={event => show("result", event.currentTarget)}>{reporting ? "Result" : "Latest result"} <span className="worker-count">{result?.revision ?? 0}</span></button><button type="button" className="text-button" disabled={!results.length} onClick={event => show("history", event.currentTarget)}>History <span className="worker-count">{results.length}</span></button>{execution.executionState === "waiting" && !reporting && <span className="muted">Waiting for input</span>}</div>
    <div className="worker-actions"><button type="button" disabled={sending} onClick={() => open(w)}>Open worker</button><Stop parent={w.parent.sessionId} input={{ ids: [w.id] }} disabled={!execution.active && !["uncertain", "unknown"].includes(execution.executionState)}>Stop worker</Stop>{workers.some(child => child.parent.sessionId === w.sessionId) && <Stop parent={w.parent.sessionId} input={{ ids: [w.id], includeDescendants: true }}>Stop worker tree</Stop>}<button type="button" className={`worker-info icon-button${attention ? " has-issue" : ""}`} aria-label={attention ? "Worker details, attention needed" : "Worker details"} title={attention ? "Attention needed" : "Worker details"} onClick={event => show("details", event.currentTarget)}><FiInfo size={15} /></button></div>
    {view && <WorkerDetails worker={w} view={view} result={result} trigger={trigger.current} close={() => setView(null)} />}
  </section>;
}
function durationBetween(start: string, end: number) {
  const seconds = Math.max(0, Math.floor((end - Date.parse(start)) / 1000));
  return !Number.isFinite(seconds) ? "—" : seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}
function elapsed(w: WorkerRecord, execution: ReturnType<typeof workerExecution>, now: number) {
  const start = execution.latest?.createdAt ?? w.createdAt;
  const end = execution.active ? now : execution.latest?.endedAt ? Date.parse(execution.latest.endedAt) : execution.continuation ? Date.parse((w.latestResult ?? w.results?.at(-1))?.outcome.at ?? w.updatedAt) : Date.parse(w.outcome?.at ?? w.updatedAt);
  return `${durationBetween(start, end)}${execution.continuation && !execution.latest ? " since dispatch" : ""}`;
}

export function WorkerOutcomeReport({ delivery, workers, runs, open = openWorker }: { delivery: WorkerDelivery; workers: WorkerRecord[]; runs: Run[]; open?: (worker: WorkerRecord) => void }) {
  const refs = delivery.resultRefs ?? delivery.workerIds.map(workerId => ({ workerId, revision: 1 }));
  return <section className="worker-outcome-report" aria-label="Worker outcome report"><header className="worker-outcome-heading"><FiCheckCircle size={15} aria-hidden="true" /><span>Worker {refs.length === 1 ? "result" : "results"} received</span><span className="worker-count">{refs.length}</span></header><div className="worker-outcome-cards">{refs.map(ref => {
    const worker = workers.find(w => w.id === ref.workerId);
    return worker ? <WorkerCard key={`${ref.workerId}:${ref.revision}`} worker={worker} workers={workers} runs={runs} open={open} resultRevision={ref.revision} /> : <p key={`${ref.workerId}:${ref.revision}`} className="muted">Worker result {ref.revision} · Status unavailable</p>;
  })}</div></section>;
}

export function WorkersButton({ sessionId, active = true }: { sessionId: string; active?: boolean }) {
  const projection = useWorkers(sessionId);
  const conversations = useStore(state => state.conversations);
  const runs = useStore(state => state.runs);
  const [opened, setOpened] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const activity = useRef(active); activity.current = active;
  const id = useId();
  const workers = projection.workers;
  const executions = workers.map(w => workerExecution(w, runs, conversations.find(c => c.id === w.sessionId)));
  const count = executions.filter(e => e.active).length;
  const uncertain = executions.filter(e => e.executionState === "uncertain" || e.executionState === "unknown").length;
  const attention = !!projection.error || projection.deliveries.some(d => d.error) || workers.some(w => w.error || w.continuation?.error || w.continuationCancellation?.error || (w.latestResult ?? w.results?.at(-1))?.notification.error || w.notification?.error);
  useEffect(() => { if (!active) setOpened(false); }, [active]);
  useEffect(() => {
    if (!opened || !active) return;
    const element = dialog.current!;
    const position = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      // The trigger now sits beside Agent on the left. Keep the panel inside
      // the viewport rather than letting its old right alignment clip it.
      const width = Math.min(460, window.innerWidth - 32);
      element.style.setProperty("--workers-right", `${Math.max(16, Math.min(window.innerWidth - rect.right, window.innerWidth - width - 16))}px`);
      element.style.setProperty("--workers-bottom", `${window.innerHeight - rect.top + 10}px`);
      element.style.setProperty("--workers-height", `${Math.max(160, rect.top - 26)}px`);
    };
    position();
    element.showModal();
    window.addEventListener("resize", position);
    return () => { window.removeEventListener("resize", position); element.close(); if (activity.current && trigger.current?.isConnected) trigger.current.focus(); };
  }, [opened, active]);
  const open = (w: WorkerRecord) => { flushSync(() => setOpened(false)); openWorker(w); };
  return <><button ref={trigger} type="button" disabled={!active} className={`composer-workers${attention || projection.continuationSuppressed ? " has-issue" : ""}`} aria-haspopup="dialog" aria-expanded={opened && active} aria-controls={opened && active ? id : undefined} aria-label={`Workers, ${count} active${uncertain ? `, ${uncertain} unconfirmed` : ""}${attention ? ", attention needed" : ""}${projection.continuationSuppressed ? ", report-back paused" : ""}`} title="Workers" onClick={() => setOpened(true)}><FiUsers size={14} aria-hidden="true" /><span className="workers-count" aria-hidden="true">{count}</span>{(attention || projection.continuationSuppressed) && <span className="workers-attention" aria-hidden="true" />}</button>
    {opened && active && createPortal(<dialog ref={dialog} id={id} className="workers-panel" aria-modal="true" aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); setOpened(false); }} onClick={event => { if (event.target === event.currentTarget) setOpened(false); }}><div className="workers-panel-content">
      <header className="workers-panel-header"><div><h2 id={`${id}-title`}>Workers</h2><p className="muted">{count} active · {workers.length} total{uncertain ? ` · ${uncertain} unconfirmed` : ""}</p></div><button type="button" className="icon-button" aria-label="Close workers" onClick={() => setOpened(false)}><FiX size={18} /></button></header>
      <div className="workers-panel-body">
        {projection.error && <p className="notice error" role="alert">Worker status unavailable: {projection.error}</p>}
        {projection.continuationSuppressed && <p className="notice" role="status">Automatic report-back is paused after an explicit stop. Results remain available; resuming this conversation re-enables delivery.</p>}
        {projection.deliveries.filter(d => d.error).map(d => <p key={d.id} className="notice error" role="alert">Report-back {d.state}: {d.error}</p>)}
        {!workers.length && <div className="workers-empty"><FiUsers size={26} aria-hidden="true" /><h3>No workers yet</h3><p>Delegated tasks will appear here with their progress and results.</p></div>}
        {workers.map(w => <WorkerCard key={w.id} worker={w} workers={workers} runs={runs} open={open} />)}
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
