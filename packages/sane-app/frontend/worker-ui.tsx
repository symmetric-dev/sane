import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import { FiArrowLeft, FiArrowRight, FiArrowUpRight, FiChevronRight, FiGitBranch, FiInfo, FiSquare, FiUsers, FiX } from "react-icons/fi";
import type { WorkerDelivery, WorkerRecord, WorkerResult } from "../src/worker-contract";
import { workerResults } from "../src/worker-contract";
import { builtinProfiles, type AgentProfile } from "../src/agent-profiles-contract";
import { WORKER_AGENT_CATALOG } from "sane-core/agent-catalog";
import { AGENT_ICONS, agentColor } from "./agent-visuals";
import { workerClient, useWorkers, openWorker, type WorkerStop } from "./worker-client";
import { harnessName, type Conversation, type Run } from "./types";
import { useStore } from "./store";

function Stop({ parent, input, children, disabled = false, className = "worker-action", label, icon = <FiSquare size={13} aria-hidden="true" /> }: { parent: string; input: WorkerStop; children: string; disabled?: boolean; className?: string; label?: string; icon?: ReactNode }) {
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  return <><button type="button" className={className} disabled={busy || disabled} aria-label={`${label ?? children}${busy ? ", requesting stop" : ""}`} aria-busy={busy} onClick={async () => { setBusy(true); setNotice(""); try { await workerClient.stop(parent, input); setNotice("Stop requested; inspect current status for confirmation."); } catch (e) { setNotice(e instanceof Error ? e.message : "Stop failed"); } finally { setBusy(false); } }}>{icon}{busy ? "Requesting…" : children}</button>{notice && <p role="status" className="notice">{notice}</p>}</>;
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
function WorkerIcon({ profile, size = 20 }: { profile: Pick<AgentProfile, "icon" | "color">; size?: number }) {
  const Glyph = AGENT_ICONS[profile.icon] ?? FiUsers;
  return <Glyph className="worker-glyph" size={size} style={{ color: agentColor(profile.color) }} aria-hidden="true" />;
}
type WorkerView = "history" | "details";
function WorkerDetails({ worker: w, view, close, trigger }: { worker: WorkerRecord; view: WorkerView; close: () => void; trigger: HTMLButtonElement | null }) {
  const profile = useWorkerVisual(w);
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const results = workerResults(w);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => { element.close(); if (trigger?.isConnected) trigger.focus(); };
  }, [trigger]);
  const report = (r: WorkerResult) => <details className="worker-result" key={r.revision}><summary><strong>Result {r.revision}</strong><span className={`worker-status${r.outcome.status === "failed" ? " is-error" : ""}`}>{r.outcome.status}</span><time dateTime={r.outcome.at}>{new Date(r.outcome.at).toLocaleString()}</time><FiChevronRight className="worker-result-chevron" size={14} aria-hidden="true" /></summary><pre className="worker-result-output">{r.outcome.summary}</pre></details>;
  return createPortal(<dialog ref={dialog} className="worker-details-dialog" aria-modal="true" aria-labelledby={id} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <header className="worker-details-header"><WorkerIcon profile={profile} size={24} /><div><h2 id={id}>{profile.label || WORKER_AGENT_CATALOG[w.input.worker].label}</h2><p className="muted">{view === "history" ? `Result history · ${results.length}` : "Worker details"}</p></div><button type="button" className="icon-button" aria-label="Close worker details" onClick={close}><FiX size={18} aria-hidden="true" /></button></header>
    <div className="worker-details-body">{view === "history" ? results.length ? results.map(report) : <p className="muted">No results recorded yet.</p> : <>
      <dl className="facts">{[["Harness", harnessName(w.launch.harness)], ["Model", w.launch.model || "Native default"], ["Worker ID", w.id], ["Conversation ID", w.sessionId], ["Native session ID", w.child?.nativeId ?? "Unavailable"], ["Initial run", w.runId ?? "Unavailable"], ["Continuation run", w.continuation?.runId ?? "None"], ["Report-back", (w.latestResult ?? results.at(-1))?.notification.state ?? "No result yet"]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      {w.error && <p className="notice error">{w.error}</p>}{w.continuation?.error && <p className="notice error">{w.continuation.error}</p>}{w.continuationCancellation && <p className="notice">Stop requested {new Date(w.continuationCancellation.requestedAt).toLocaleString()}. {w.continuationCancellation.error}</p>}
      {results.map(r => <p className="muted" key={r.revision}>Result {r.revision} · {r.notification.state}{r.notification.error && <span className="notice error">{r.notification.error}</span>}</p>)}
    </>}</div>
  </dialog>, document.body);
}
export function WorkerCard({ worker: w, workers = [], runs = [], open = openWorker }: { worker: WorkerRecord; workers?: WorkerRecord[]; runs?: Run[]; open?: (worker: WorkerRecord) => void }) {
  const conversation = useStore(state => state.conversations.find(c => c.id === w.sessionId));
  const sending = useStore(state => state.sending);
  const execution = workerExecution(w, runs, conversation);
  const profile = useWorkerVisual(w);
  const results = workerResults(w);
  const moving = execution.active;
  const [now, setNow] = useState(Date.now);
  const [view, setView] = useState<WorkerView | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { if (!moving) return; setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [moving]);
  const show = (next: WorkerView, button: HTMLButtonElement) => { trigger.current = button; setView(next); };
  const attention = !!(w.error || w.continuation?.error || w.continuationCancellation?.error || results.some(r => r.notification.error));
  const timestamp = execution.latest?.createdAt ?? w.createdAt;
  const duration = elapsed(w, execution, now);
  const status = execution.executionState;
  const statusClass = `${moving ? " is-active" : ""}${status === "failed" ? " is-error" : ""}${status === "uncertain" || status === "unknown" ? " is-uncertain" : ""}`;
  return <section className={`worker-card${moving ? " is-active" : ""}`}>
    <header><FiArrowLeft className="worker-direction" size={16} aria-hidden="true" /><WorkerIcon profile={profile} /><div className="worker-card-heading"><strong>{profile.label || WORKER_AGENT_CATALOG[w.input.worker].label}</strong><span className="worker-card-timing">{timestamp && <time dateTime={timestamp} title={new Date(timestamp).toLocaleString()}>{new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>}{duration && <span>{duration}</span>}</span></div><span className={`worker-status${statusClass}`} role="status">{`${execution.continuation ? "Continuation · " : ""}${status}`}</span></header>
    <div className="worker-card-controls">
      <div className="worker-actions">
        <button type="button" className="worker-action" aria-label="Open worker" disabled={sending} onClick={() => open(w)}><FiArrowUpRight size={13} aria-hidden="true" />Open</button>
        <Stop parent={w.parent.sessionId} input={{ ids: [w.id] }} label="Stop worker" disabled={!execution.active && !["uncertain", "unknown"].includes(execution.executionState)}>Stop</Stop>
        {workers.some(child => child.parent.sessionId === w.sessionId) && <Stop parent={w.parent.sessionId} input={{ ids: [w.id], includeDescendants: true }} label="Stop worker tree" icon={<FiGitBranch size={13} aria-hidden="true" />}>Stop Tree</Stop>}
      </div>
      <div className="worker-actions worker-secondary-actions">
        <button type="button" className="worker-action" aria-haspopup="dialog" disabled={!results.length} onClick={event => show("history", event.currentTarget)}>History <span className="worker-count">{results.length}</span></button>
        <button type="button" className={`worker-action worker-info${attention ? " has-issue" : ""}`} aria-haspopup="dialog" aria-label={attention ? "Worker details, attention needed" : "Worker details"} title={attention ? "Attention needed" : "Worker details"} onClick={event => show("details", event.currentTarget)}><FiInfo size={13} aria-hidden="true" />Details</button>
      </div>
    </div>
    {execution.executionState === "waiting" && <p className="worker-waiting muted">Waiting for input</p>}
    {view && <WorkerDetails worker={w} view={view} trigger={trigger.current} close={() => setView(null)} />}
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

function WorkerReceipt({ worker: w, revision }: { worker: WorkerRecord; revision: number }) {
  const profile = useWorkerVisual(w);
  const results = workerResults(w);
  // A receipt describes this delivered revision, never a later continuation.
  const result = results.find(record => record.revision === revision);
  const [history, setHistory] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  return <div className="worker-receipt">
    <FiArrowRight className="worker-direction" size={16} aria-hidden="true" />
    <WorkerIcon profile={profile} size={18} />
    <div className="worker-receipt-summary">
      <strong>{profile.label || WORKER_AGENT_CATALOG[w.input.worker].label}</strong>
      <span aria-hidden="true">·</span><span>Result {revision}</span>
      <span aria-hidden="true">·</span><span className={`worker-status${result?.outcome.status === "failed" ? " is-error" : !result ? " is-uncertain" : ""}`}>{result?.outcome.status ?? "Status unavailable"}</span>
      {result && <><span aria-hidden="true">·</span><time dateTime={result.outcome.at} title={new Date(result.outcome.at).toLocaleString()}>{new Date(result.outcome.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></>}
    </div>
    <button ref={trigger} type="button" className="worker-action worker-receipt-history" aria-haspopup="dialog" disabled={!results.length} onClick={() => setHistory(true)}>History</button>
    {history && <WorkerDetails worker={w} view="history" trigger={trigger.current} close={() => setHistory(false)} />}
  </div>;
}

export function WorkerOutcomeReport({ delivery, workers }: { delivery: WorkerDelivery; workers: WorkerRecord[] }) {
  const refs = delivery.resultRefs ?? delivery.workerIds.map(workerId => ({ workerId, revision: 1 }));
  return <section className="worker-outcome-report" aria-label="Worker outcome report">{refs.map(ref => {
    const worker = workers.find(w => w.id === ref.workerId);
    return worker ? <WorkerReceipt key={`${ref.workerId}:${ref.revision}`} worker={worker} revision={ref.revision} /> : <div key={`${ref.workerId}:${ref.revision}`} className="worker-receipt"><FiArrowRight className="worker-direction" size={16} aria-hidden="true" /><FiUsers className="worker-glyph" size={18} aria-hidden="true" /><div className="worker-receipt-summary"><strong>Worker</strong><span aria-hidden="true">·</span><span>Result {ref.revision}</span><span aria-hidden="true">·</span><span className="worker-status is-uncertain">Status unavailable</span></div></div>;
  })}</section>;
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
  const newestWorkers = [...workers].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const executions = workers.map(w => workerExecution(w, runs, conversations.find(c => c.id === w.sessionId)));
  const count = executions.filter(e => e.active).length;
  const uncertain = executions.filter(e => e.executionState === "uncertain" || e.executionState === "unknown").length;
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
  return <><button ref={trigger} type="button" disabled={!active} className="composer-workers" aria-haspopup="dialog" aria-expanded={opened && active} aria-controls={opened && active ? id : undefined} aria-label={`Workers, ${count} active`} title="Workers" onClick={() => setOpened(true)}><FiUsers size={14} aria-hidden="true" /><span className="workers-count" aria-hidden="true">{count}</span></button>
    {opened && active && createPortal(<dialog ref={dialog} id={id} className="workers-panel" aria-modal="true" aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); setOpened(false); }} onClick={event => { if (event.target === event.currentTarget) setOpened(false); }}><div className="workers-panel-content">
      <header className="workers-panel-header"><div><h2 id={`${id}-title`}>Workers</h2><p className="muted">{count} active · {workers.length} total{uncertain ? ` · ${uncertain} unconfirmed` : ""}</p></div><button type="button" className="icon-button" aria-label="Close workers" onClick={() => setOpened(false)}><FiX size={18} /></button></header>
      <div className="workers-panel-body">
        {projection.error && <p className="notice error" role="alert">Worker status unavailable: {projection.error}</p>}
        {projection.continuationSuppressed && <p className="notice" role="status">Automatic report-back is paused after an explicit stop. Results remain available; resuming this conversation re-enables delivery.</p>}
        {projection.deliveries.filter(d => d.error).map(d => <p key={d.id} className="notice error" role="alert">Report-back {d.state}: {d.error}</p>)}
        {!workers.length && <div className="workers-empty"><FiUsers size={26} aria-hidden="true" /><h3>No workers yet</h3><p>Delegated tasks will appear here with their progress and results.</p></div>}
        {newestWorkers.map(w => <WorkerCard key={w.id} worker={w} workers={workers} runs={runs} open={open} />)}
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
