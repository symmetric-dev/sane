import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import { FiArrowRight, FiArrowUpRight, FiBookOpen, FiCheck, FiChevronRight, FiClock, FiCornerUpLeft, FiGitBranch, FiHelpCircle, FiInfo, FiPause, FiRefreshCw, FiSlash, FiSquare, FiUser, FiUsers, FiX } from "react-icons/fi";
import type { WorkerDelivery, WorkerExchange, WorkerRecord, WorkerResult } from "../src/worker-contract";
import { workerCountsAsActiveExecution, workerProtocolStatus, workerResults, workerStoppable } from "../src/worker-contract";
import { exchangeRecipientLabel, exchangeSenderLabel, workerStatusText } from "./worker-presentation";
import { builtinProfiles, type AgentProfile } from "../src/agent-profiles-contract";
import { WORKER_AGENT_CATALOG } from "sane-core/agent-catalog";
import { AGENT_ICONS, agentColor } from "./agent-visuals";
import { workerClient, useWorkers, useWorkerState, refreshWorkerState, openWorker, type WorkerStop } from "./worker-client";
import { harnessName, type Conversation, type Run, type RunMetadata } from "./types";
import { useStore } from "./store";
import { goToSend } from "./send-navigation";

function CancelWorker({ parent, input, children, disabled = false, className = "worker-action", label, icon = <FiSquare size={13} aria-hidden="true" /> }: { parent: string; input: WorkerStop; children: string; disabled?: boolean; className?: string; label?: string; icon?: ReactNode }) {
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  return <><button type="button" className={className} disabled={busy || disabled} aria-label={`${label ?? children}${busy ? ", requesting cancellation" : ""}`} aria-busy={busy} onClick={async () => { setBusy(true); setNotice(""); try { await workerClient.stop(parent, input); setNotice("Worker cancellation requested; inspect current status for confirmation."); } catch (e) { setNotice(e instanceof Error ? e.message : "Cancellation failed"); } finally { setBusy(false); } }}>{icon}{busy ? "Requesting…" : children}</button>{notice && <p role="status" className="notice">{notice}</p>}</>;
}
function workerExecution(w: WorkerRecord, runs: RunMetadata[], conversation?: Conversation, refreshed?: RunMetadata | null) {
  let latest = runs.filter(r => r.conversationId === w.sessionId).at(-1);
  // Manual snapshots may outlive a continuation discovered by normal listings.
  const refreshedCurrent = refreshed && (!w.continuation || w.continuation.runId === refreshed.id)
    && (!conversation?.lastRunId || conversation.lastRunId === refreshed.id || conversation.lastRunId === w.runId);
  if (refreshedCurrent && (!latest || refreshed.createdAt > latest.createdAt || refreshed.id === latest.id && !latest.endedAt)) latest = refreshed;
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
function WorkerStatusIcon({ state, label }: { state: string; label: string }) {
  const running = state === "running";
  const Glyph = state === "completed" ? FiCheck : state === "failed" ? FiX : state === "interrupted" ? FiSlash
    : state === "idle" ? FiPause : state === "awaiting-user" || state === "waiting" ? FiUser
    : state === "awaiting-parent" ? FiCornerUpLeft : state === "awaiting-children" ? FiUsers
    : state === "cancelling" ? FiSquare : ["reserved", "launching", "starting", "closing"].includes(state) ? FiClock : FiHelpCircle;
  return <span className={`worker-card-status${state === "completed" ? " is-completed" : state === "failed" ? " is-error" : ""}`} role="img" aria-label={label} title={label}>{running ? <span className="pulse" aria-hidden="true" /> : <Glyph size={14} aria-hidden="true" />}</span>;
}
function WorkerExchanges({ worker, compact = false }: { worker: WorkerRecord; compact?: boolean }) {
  const exchanges = worker.exchanges ?? [];
  if (!exchanges.length) return null;
  return <ul className={`worker-exchanges${compact ? " is-compact" : ""}`} aria-label="Worker messages">
    {exchanges.map(exchange => <WorkerExchangeRow key={exchange.id} exchange={exchange} compact={compact} />)}
  </ul>;
}
function WorkerExchangeRow({ exchange, compact }: { exchange: WorkerExchange; compact: boolean }) {
  const sender = exchangeSenderLabel(exchange);
  const recipient = exchangeRecipientLabel(exchange);
  return <li className="worker-exchange">
    <span className="worker-exchange-route">{sender} → {recipient}</span>
    <span className="worker-status" title="Native acceptance, not comprehension">{exchange.delivery.state}</span>
    {!compact && <span className="muted">{exchange.kind}</span>}
    {!compact && <pre className="worker-exchange-text">{exchange.text}</pre>}
  </li>;
}
type WorkerView = "history" | "details";
function WorkerDetails({ worker: w, view, close, trigger }: { worker: WorkerRecord; view: WorkerView; close: () => void; trigger: HTMLButtonElement | null }) {
  const profile = useWorkerVisual(w);
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const results = workerResults(w);
  const snapshot = useWorkerState(w.id).snapshot;
  const usage = snapshot?.contextUsage;
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => { element.close(); if (trigger?.isConnected) trigger.focus(); };
  }, [trigger]);
  const report = (r: WorkerResult) => <details className="worker-result" key={r.revision}><summary><strong>Result {r.revision}</strong><span className={`worker-status${r.outcome.status === "failed" ? " is-error" : ""}`}>{r.outcome.status}</span><time dateTime={r.outcome.at}>{new Date(r.outcome.at).toLocaleString()}</time><FiChevronRight className="worker-result-chevron" size={14} aria-hidden="true" /></summary><pre className="worker-result-output">{r.outcome.summary}</pre></details>;
  return createPortal(<dialog ref={dialog} className="worker-details-dialog" aria-modal="true" aria-labelledby={id} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <header className="worker-details-header"><WorkerIcon profile={profile} size={24} /><div><h2 id={id}>{profile.label || WORKER_AGENT_CATALOG[w.input.worker].label}</h2><p className="muted">{view === "history" ? `Result history · ${results.length}` : "Worker details"}</p></div><button type="button" className="icon-button" aria-label="Close worker details" onClick={close}><FiX size={18} aria-hidden="true" /></button></header>
    <div className="worker-details-body">{view === "history" ? results.length ? results.map(report) : <p className="muted">No results recorded yet.</p> : <>
      <dl className="facts">{[["Subject", w.input.subject ?? "None"], ["Jobs", w.input.jobs?.join(", ") || "None"], ["Status", workerStatusText(w) ?? w.state], ["Harness", harnessName(w.launch.harness)], ["Model", usage?.model ?? w.launch.model ?? "Native default"], ["Recorded tool calls", snapshot?.toolCallCount?.toLocaleString() ?? "Unavailable — refresh to observe"], ["Context usage", usage?.percentage === undefined ? "Unavailable" : `${Math.round(usage.percentage)}%${usage.stale ? " (stale while compacting)" : ""}`], ["Input context tokens", usage?.tokens.toLocaleString() ?? "Unavailable"], ["Model window", usage?.capacity?.toLocaleString() ?? "Unavailable"], ["Usage reported", usage ? new Date(usage.time).toLocaleString() : "Unavailable"], ["Refreshed", snapshot ? new Date(snapshot.observedAt).toLocaleString() : "Not yet refreshed"], ["Worker ID", w.id], ["Conversation ID", w.sessionId], ["Native session ID", w.child?.nativeId ?? "Unavailable"], ["Initial run", w.runId ?? "Unavailable"], ["Continuation run", w.continuation?.runId ?? "None"], ["Report-back", (w.latestResult ?? results.at(-1))?.notification.state ?? "No result yet"]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <p className="muted">Tool calls cover recorded activity in this worker session, including continuations but excluding descendants. Context is the last reported input usage, not a live token counter or the auto-compaction threshold.</p>
      {snapshot?.warnings.map(warning => <p key={warning} className="notice">{warning}</p>)}
      {w.error && <p className="notice error">{w.error}</p>}{w.continuation?.error && <p className="notice error">{w.continuation.error}</p>}{w.continuationCancellation && <p className="notice">Stop requested {new Date(w.continuationCancellation.requestedAt).toLocaleString()}. {w.continuationCancellation.error}</p>}
      {results.map(r => <p className="muted" key={r.revision}>Result {r.revision} · {r.notification.state}{r.notification.error && <span className="notice error">{r.notification.error}</span>}</p>)}
      <WorkerExchanges worker={w} />
    </>}</div>
  </dialog>, document.body);
}
export function WorkerCard({ worker: supplied, workers = [], runs = [], open = openWorker, sendAnchor = false }: { worker: WorkerRecord; workers?: WorkerRecord[]; runs?: Run[]; open?: (worker: WorkerRecord) => void; sendAnchor?: boolean }) {
  const read = useWorkerState(supplied.id);
  const snapshot = read.snapshot;
  const w = snapshot && snapshot.worker.updatedAt >= supplied.updatedAt ? snapshot.worker : supplied;
  const conversation = useStore(state => state.conversations.find(c => c.id === w.sessionId));
  const sending = useStore(state => state.sending);
  const execution = workerExecution(w, runs, conversation, snapshot?.latestRun);
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
  const protocol = workerProtocolStatus(w);
  const protocolLabel = workerStatusText(w);
  const status = protocolLabel ?? execution.executionState;
  const movingStatus = protocol === "running" || (!protocol && moving);
  const statusState = protocol === "terminal" ? w.outcome?.status ?? w.state : protocol ?? execution.executionState;
  const statusLabel = !protocol && execution.executionState === "waiting" ? "Waiting for input" : `${!protocol && execution.continuation ? "Continuation · " : ""}${status}`;
  const stoppable = workerStoppable(w, execution.active, execution.executionState);
  const usage = snapshot?.contextUsage;
  const refreshedAt = snapshot ? `Refreshed ${new Date(snapshot.observedAt).toLocaleString()}.` : "Refresh to observe worker state.";
  const contextLabel = usage?.percentage === undefined ? "Context —" : `Context ${Math.round(usage.percentage)}%${usage.stale ? " (stale)" : ""}`;
  const contextTitle = usage ? `${usage.tokens.toLocaleString()} input tokens${usage.capacity ? ` / ${usage.capacity.toLocaleString()}` : "; model window unavailable"}. ${usage.model}. Reported ${new Date(usage.time).toLocaleString()}.${usage.stale ? " Stale while compacting." : " Last reported input context, not a live token counter."} ${refreshedAt}` : `Context usage unavailable. ${refreshedAt}`;
  return <section className={`worker-card${movingStatus ? " is-active" : ""}`} data-send-kind={sendAnchor ? "worker" : undefined} data-send-id={sendAnchor ? w.id : undefined} tabIndex={sendAnchor ? -1 : undefined} aria-label={sendAnchor ? "Worker send" : undefined}>
    <header><WorkerStatusIcon state={statusState} label={statusLabel} /><WorkerIcon profile={profile} /><div className="worker-card-heading"><strong title={profile.label || WORKER_AGENT_CATALOG[w.input.worker].label}>{profile.label || WORKER_AGENT_CATALOG[w.input.worker].label}</strong>{!!w.input.jobs?.length && <span className="worker-card-jobs" title={`Jobs: ${w.input.jobs.join(", ")}`}><span className="sr-only">{w.input.jobs.length === 1 ? "Job: " : "Jobs: "}</span>{w.input.jobs.map(job => <code key={job}>{job}</code>)}</span>}{w.input.subject && <span className="worker-card-subject muted" title={w.input.subject}>{w.input.subject}</span>}</div><div className="worker-card-times"><time className="worker-card-timing" dateTime={timestamp} title={`Started ${new Date(timestamp).toLocaleString()}`} aria-label={`Started ${new Date(timestamp).toLocaleString()}`}>{new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><span className="worker-card-elapsed" aria-label={`Elapsed: ${duration}`}>{duration}</span></div></header>
    <div className="worker-card-controls">
      <div className="worker-actions worker-card-metrics">
        <button type="button" className="worker-action" disabled={read.loading} aria-label="Refresh worker state" aria-busy={read.loading} title={refreshedAt} onClick={() => void refreshWorkerState(w)}><FiRefreshCw size={13} aria-hidden="true" />{read.loading ? "Refreshing…" : "Refresh"}</button>
        <span className="worker-card-metric" title={`Recorded calls in this worker session, including continuations; excludes descendants. ${refreshedAt}`}>{snapshot?.toolCallCount == null ? "—" : snapshot.toolCallCount.toLocaleString()} tool calls</span>
        <span className="worker-card-metric" title={contextTitle}>{contextLabel}</span>
      </div>
      <div className="worker-actions worker-secondary-actions">
        <button type="button" className="worker-action" aria-haspopup="dialog" aria-label={`Result history, ${results.length} results`} title={`Result history (${results.length})`} disabled={!results.length} onClick={event => show("history", event.currentTarget)}><FiBookOpen size={14} aria-hidden="true" /><span className="worker-count" aria-hidden="true">{results.length}</span></button>
        <button type="button" className={`worker-action worker-info${attention ? " has-issue" : ""}`} aria-haspopup="dialog" aria-label={attention ? "Worker details, attention needed" : "Worker details"} title={attention ? "Worker details, attention needed" : "Worker details"} onClick={event => show("details", event.currentTarget)}><FiInfo size={14} aria-hidden="true" /></button>
        <button type="button" className="worker-action" aria-label="Open worker" disabled={sending} onClick={() => open(w)}><FiArrowUpRight size={13} aria-hidden="true" />Open</button>
        <CancelWorker parent={w.parent.sessionId} input={{ ids: [w.id] }} label="Cancel worker assignment" disabled={!stoppable}>Cancel</CancelWorker>
        {workers.some(child => child.parent.sessionId === w.sessionId) && <CancelWorker parent={w.parent.sessionId} input={{ ids: [w.id], includeDescendants: true }} label="Cancel worker tree" icon={<FiGitBranch size={13} aria-hidden="true" />}>Cancel Tree</CancelWorker>}
      </div>
    </div>
    {read.error && <p className="notice error" role="alert">Refresh failed: {read.error}{snapshot ? " Showing the previous snapshot." : ""}</p>}
    {snapshot?.warnings.map(warning => <p key={warning} className="notice" role="status">{warning}</p>)}
    <WorkerExchanges worker={w} compact />
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
  const sending = useStore(state => state.sending);
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
    <div className="worker-actions worker-receipt-actions"><button type="button" className="worker-action" disabled={sending || !w.parent.sessionId} onClick={() => goToSend({ kind: "worker", id: w.id, sessionId: w.parent.sessionId })}><FiArrowUpRight size={13} aria-hidden="true" />Go to send</button><button ref={trigger} type="button" className="worker-action" aria-haspopup="dialog" disabled={!results.length} onClick={() => setHistory(true)}>History</button></div>
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

export function WorkerExchangeMessage({ exchange, renderMessage }: { exchange: WorkerExchange; renderMessage: (text: string) => ReactNode }) {
  const status = { queued: "Queued", claimed: "Sending", "acceptance-unknown": "Acceptance unconfirmed", accepted: "Accepted", "not-submitted": "Not sent" }[exchange.delivery.state];
  const kind = { consultation: "Consultation", guidance: "Guidance", notice: "Notice" }[exchange.kind];
  return <section className="worker-exchange-card" aria-label="Worker exchange">
    <header><FiArrowRight className="worker-direction" size={16} aria-hidden="true" /><strong>Worker exchange</strong><span className="worker-exchange-route">{exchangeSenderLabel(exchange)} → {exchangeRecipientLabel(exchange)}</span><span>{kind}</span><time dateTime={exchange.createdAt} title={new Date(exchange.createdAt).toLocaleString()}>{new Date(exchange.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></header>
    <details className="worker-exchange-content"><summary><FiChevronRight size={13} aria-hidden="true" />Show message</summary><div>{renderMessage(exchange.text)}</div></details>
    <footer><span className={`worker-status${exchange.delivery.state === "not-submitted" ? " is-error" : exchange.delivery.state === "acceptance-unknown" ? " is-uncertain" : ""}`} title="Native acceptance, not comprehension or task completion">{status}</span></footer>
    {exchange.delivery.error && <p className="notice error" role="alert">{exchange.delivery.error}</p>}
  </section>;
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
  const count = workers.filter((worker, index) => workerCountsAsActiveExecution(worker, executions[index]?.active ?? false)).length;
  const idle = workers.filter(worker => workerProtocolStatus(worker) === "idle").length;
  const awaiting = workers.filter(worker => ["awaiting-user", "awaiting-parent", "awaiting-children"].includes(workerProtocolStatus(worker) ?? "")).length;
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
      <header className="workers-panel-header"><div><h2 id={`${id}-title`}>Workers</h2><p className="muted">{count} active · {workers.length} total{idle ? ` · ${idle} idle` : ""}{awaiting ? ` · ${awaiting} awaiting` : ""}{uncertain ? ` · ${uncertain} unconfirmed` : ""}</p></div><button type="button" className="icon-button" aria-label="Close workers" onClick={() => setOpened(false)}><FiX size={18} /></button></header>
      <div className="workers-panel-body">
        {projection.error && <p className="notice error" role="alert">Worker status unavailable: {projection.error}</p>}
        {projection.continuationSuppressed && <p className="notice" role="status">Automatic report-back is paused after an explicit stop. Results remain available; resuming this conversation re-enables delivery.</p>}
        {projection.deliveries.filter(d => d.error).map(d => <p key={d.id} className="notice error" role="alert">Report-back {d.state}: {d.error}</p>)}
        {!workers.length && <div className="workers-empty"><FiUsers size={26} aria-hidden="true" /><h3>No workers yet</h3><p>Delegated tasks will appear here with their progress and results.</p></div>}
        {newestWorkers.map(w => <WorkerCard key={w.id} worker={w} workers={workers} runs={runs} open={open} />)}
      </div>
      {!!workers.length && <footer className="workers-panel-footer"><CancelWorker parent={sessionId} input={{ all: true }}>Cancel all workers</CancelWorker><span className="muted">Includes nested workers</span></footer>}
    </div></dialog>, document.body)}
  </>;
}
export function WorkerSection({ sessionId, runId, open = openWorker, collapsible = false }: { sessionId: string; runId?: string; open?: (worker: WorkerRecord) => void; collapsible?: boolean }) {
  const projection = useWorkers(sessionId);
  const children = projection.workers.filter(w => w.parent.sessionId === sessionId && (!runId || w.parent.runId === runId));
  if (!children.length && !projection.error && !projection.continuationSuppressed) return null;
  const content = <>{projection.error && <p className="notice error">Worker status unavailable: {projection.error}</p>}{projection.continuationSuppressed && <p className="notice">Automatic report-back continuation is suppressed after an explicit stop. Outcomes remain available; user resumption re-enables delivery.</p>}{!runId && children.length > 0 && <CancelWorker parent={sessionId} input={{ all: true }}>Cancel all workers in this conversation tree</CancelWorker>}{children.map(w => <WorkerCard key={w.id} worker={w} workers={projection.workers} open={open} />)}{projection.deliveries.filter(d => d.error).map(d => <p key={d.id} className="notice error">Report-back {d.state}: {d.error}</p>)}</>;
  const label = <>Workers · {children.length}{projection.error || projection.deliveries.some(d => d.error) ? " · Attention needed" : projection.continuationSuppressed ? " · Report-back paused" : ""}</>;
  return collapsible ? <details className="worker-section"><summary>{label}</summary>{content}</details> : <section className="worker-section"><h3>{label}</h3>{content}</section>;
}
