import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import { FiArrowLeft, FiArrowRight, FiArrowUpRight, FiCheck, FiClock, FiCornerUpLeft, FiHelpCircle, FiInfo, FiPause, FiPlay, FiSlash, FiSquare, FiUser, FiUsers, FiX } from "react-icons/fi";
import type { WorkerDelivery, WorkerExchange, WorkerRecord, WorkerResult } from "../src/worker-contract";
import { workerCountsAsActiveExecution, workerProtocolStatus, workerResults, workerStoppable } from "../src/worker-contract";
import { exchangeDeliveryPresentation, exchangeRouteLabel, workerStatusLabel, workerStatusText } from "./worker-presentation";
import { builtinProfiles, type AgentProfile } from "../src/agent-profiles-contract";
import { WORKER_AGENT_CATALOG } from "sane-core/agent-catalog";
import { AGENT_ICONS, agentColor } from "./agent-visuals";
import { workerClient, useWorkers, useWorkerState, openWorker, type WorkerStop } from "./worker-client";
import { useWorkerRefresh } from "./worker-refresh";
import { harnessName, type Conversation, type Run, type RunMetadata, type ToolPart } from "./types";
import { useStore } from "./store";
import { goToSend } from "./send-navigation";
import { WorkerActionsMenu, WorkerOverflowMenu } from "./worker-actions-menu";
import { ChatButton, ChatCard, ChatCardHeader, ChatDialog, ChatDialogBody, ChatDisclosure, ChatIconButton, ChatMetadata, ChatNotice, ChatReceipt, ChatStatus } from "./chat-ui";

async function requestWorkerCancellation(parent: string, input: WorkerStop) {
  try { await workerClient.stop(parent, input); return "Worker cancellation requested; inspect current status for confirmation."; }
  catch (e) { return e instanceof Error ? e.message : "Cancellation failed"; }
}
function CancelWorker({ parent, input, children, disabled = false, className, label, icon = <FiSquare size={13} aria-hidden="true" /> }: { parent: string; input: WorkerStop; children: string; disabled?: boolean; className?: string; label?: string; icon?: ReactNode }) {
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  return <><ChatButton variant="danger" className={className} disabled={disabled} busy={busy} icon={icon} aria-label={`${label ?? children}${busy ? ", requesting cancellation" : ""}`} onClick={async () => { setBusy(true); setNotice(""); setNotice(await requestWorkerCancellation(parent, input)); setBusy(false); }}>{children}</ChatButton>{notice && <ChatNotice role="status">{notice}</ChatNotice>}</>;
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
  return <span className="worker-execution-status" data-state={state} title={label}>{running ? <span className="worker-running-dot" aria-hidden="true" /> : <Glyph size={14} aria-hidden="true" />}<span>{label}</span></span>;
}
function WorkerExchanges({ worker, compact = false }: { worker: WorkerRecord; compact?: boolean }) {
  const exchanges = worker.exchanges ?? [];
  if (!exchanges.length) return null;
  return <ul className={`worker-exchanges${compact ? " is-compact" : ""}`} aria-label="Worker messages">
    {exchanges.map(exchange => <WorkerExchangeRow key={exchange.id} exchange={exchange} compact={compact} recipient={exchange.recipient.sessionId === worker.sessionId ? worker : undefined} />)}
  </ul>;
}
function WorkerExchangeRow({ exchange, compact, recipient }: { exchange: WorkerExchange; compact: boolean; recipient?: WorkerRecord }) {
  const delivery = exchangeDeliveryPresentation(exchange, recipient);
  return <li className="worker-exchange">
    <span className="worker-exchange-route">{exchangeRouteLabel(exchange)}</span>
    <ChatStatus tone={delivery.tone} title={delivery.notice ?? "Native acceptance, not comprehension"}>{delivery.label}</ChatStatus>
    {!compact && <span className="muted">{exchange.kind}</span>}
    {!compact && <pre className="worker-exchange-text">{exchange.text}</pre>}
  </li>;
}
type WorkerView = "history" | "details";
function formatDirectWorkerCount(count: number | undefined) {
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count.toLocaleString() : "—";
}
function WorkerDetails({ worker: w, view, close, trigger, initialRevision }: { worker: WorkerRecord; view: WorkerView; close: () => void; trigger: HTMLButtonElement | null; initialRevision?: number }) {
  const profile = useWorkerVisual(w);
  const [activeView, setActiveView] = useState(view);
  const id = useId();
  const results = workerResults(w);
  const snapshot = useWorkerState(w).snapshot;
  const usage = snapshot?.contextUsage;
  const selectedResult = useRef<HTMLDivElement>(null);
  useEffect(() => { if (activeView === "history" && initialRevision !== undefined) selectedResult.current?.scrollIntoView({ block: "start" }); }, [activeView, initialRevision]);
  const report = (r: WorkerResult) => <ChatDisclosure className="worker-result" key={r.revision} ref={r.revision === initialRevision ? selectedResult : undefined} defaultOpen={r.revision === initialRevision} title={<><strong>Result {r.revision}</strong><ChatStatus tone={r.outcome.status === "failed" ? "danger" : r.outcome.status === "completed" ? "success" : "neutral"}>{r.outcome.status}</ChatStatus><time dateTime={r.outcome.at}>{new Date(r.outcome.at).toLocaleString()}</time></>}><pre className="worker-result-output">{r.outcome.summary}</pre></ChatDisclosure>;
  return createPortal(<ChatDialog title={profile.label || WORKER_AGENT_CATALOG[w.input.worker].label} subtitle="Worker details" size="wide" className="worker-details-dialog" close={close} restoreFocus={() => trigger}>
    <div className="worker-details-tabs" role="tablist" aria-label="Worker information" onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? "details" : event.key === "End" ? "history" : activeView === "details" ? "history" : "details";
      setActiveView(next);
      document.getElementById(`${id}-${next}-tab`)?.focus();
    }}>
      {(["details", "history"] as const).map(tab => <button key={tab} type="button" role="tab" id={`${id}-${tab}-tab`} aria-selected={activeView === tab} aria-controls={`${id}-${tab}-panel`} tabIndex={activeView === tab ? 0 : -1} onClick={() => setActiveView(tab)}>{tab === "details" ? "Details" : `History (${results.length})`}</button>)}
    </div>
    <ChatDialogBody className="worker-details-body" role="tabpanel" id={`${id}-history-panel`} aria-labelledby={`${id}-history-tab`} tabIndex={0} hidden={activeView !== "history"}>{results.length ? results.map(report) : <p className="muted">No results recorded yet.</p>}</ChatDialogBody>
    <ChatDialogBody className="worker-details-body" role="tabpanel" id={`${id}-details-panel`} aria-labelledby={`${id}-details-tab`} tabIndex={0} hidden={activeView !== "details"}>
      <dl className="facts">{[["Subject", w.input.subject ?? "None"], ["Jobs", w.input.jobs?.join(", ") || "None"], ["Status", workerStatusText(w) ?? w.state], ["Harness", harnessName(w.launch.harness)], ["Model", usage?.model ?? w.launch.model ?? "Native default"], ["Recorded tool calls", snapshot?.toolCallCount?.toLocaleString() ?? "Unavailable — refresh to observe"], ["Direct workers", formatDirectWorkerCount(snapshot?.directWorkerCount)], ["Context usage", usage?.percentage === undefined ? "Unavailable" : `${Math.round(usage.percentage)}%${usage.stale ? " (stale while compacting)" : ""}`], ["Input context tokens", usage?.tokens.toLocaleString() ?? "Unavailable"], ["Model window", usage?.capacity?.toLocaleString() ?? "Unavailable"], ["Usage reported", usage ? new Date(usage.time).toLocaleString() : "Unavailable"], ["Refreshed", snapshot ? new Date(snapshot.observedAt).toLocaleString() : "Not yet refreshed"], ["Worker ID", w.id], ["Conversation ID", w.sessionId], ["Native session ID", w.child?.nativeId ?? "Unavailable"], ["Initial run", w.runId ?? "Unavailable"], ["Continuation run", w.continuation?.runId ?? "None"], ["Report-back", (w.latestResult ?? results.at(-1))?.notification.state ?? "No result yet"]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <p className="muted">Tool calls cover recorded activity in this worker session, including continuations but excluding descendants. Direct workers count SANE child workers, including completed workers, but exclude deeper descendants and native subagents. Context is the last reported input usage, not a live token counter or the auto-compaction threshold.</p>
      {snapshot?.warnings.map(warning => <ChatNotice key={warning} tone="warning">{warning}</ChatNotice>)}
      {w.error && <ChatNotice tone="danger">{w.error}</ChatNotice>}{w.continuation?.error && <ChatNotice tone="danger">{w.continuation.error}</ChatNotice>}{w.continuationCancellation && <ChatNotice>Stop requested {new Date(w.continuationCancellation.requestedAt).toLocaleString()}. {w.continuationCancellation.error}</ChatNotice>}
      {results.map(r => <ChatReceipt key={r.revision}><ChatMetadata>Result {r.revision} · {r.notification.state}</ChatMetadata>{r.notification.error && <ChatNotice tone="danger">{r.notification.error}</ChatNotice>}</ChatReceipt>)}
      <WorkerExchanges worker={w} />
    </ChatDialogBody>
  </ChatDialog>, document.body);
}
export function WorkerCard({ worker: supplied, workers = [], runs = [], open = openWorker, sendAnchor = false }: { worker: WorkerRecord; workers?: WorkerRecord[]; runs?: Run[]; open?: (worker: WorkerRecord) => void; sendAnchor?: boolean }) {
  const read = useWorkerState(supplied);
  const refresh = useWorkerRefresh(supplied, read.loading);
  const snapshot = read.snapshot;
  const w = snapshot && snapshot.worker.updatedAt >= supplied.updatedAt ? snapshot.worker : supplied;
  const conversation = useStore(state => state.conversations.find(c => c.id === w.sessionId));
  const sending = useStore(state => state.sending);
  const execution = workerExecution(w, runs, conversation, snapshot?.latestRun);
  const profile = useWorkerVisual(w);
  const workerName = profile.label || WORKER_AGENT_CATALOG[w.input.worker].label;
  const title = sendAnchor ? `Start: ${workerName}` : workerName;
  const results = workerResults(w);
  const moving = execution.active;
  const [now, setNow] = useState(Date.now);
  const [view, setView] = useState<WorkerView | null>(null);
  const [cancelNotice, setCancelNotice] = useState("");
  const [cancelling, setCancelling] = useState(false);
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
  const cancel = async (includeDescendants = false) => {
    if (cancelling) return;
    setCancelling(true); setCancelNotice("");
    setCancelNotice(await requestWorkerCancellation(w.parent.sessionId, { ids: [w.id], includeDescendants }));
    setCancelling(false);
  };
  const usage = snapshot?.contextUsage;
  const refreshedAt = snapshot ? `Refreshed ${new Date(snapshot.observedAt).toLocaleString()}.` : "Refresh to observe worker state.";
  const contextLabel = usage?.percentage === undefined ? "Context —" : `Context ${Math.round(usage.percentage)}%${usage.stale ? " (stale)" : ""}`;
  const contextTitle = usage ? `${usage.tokens.toLocaleString()} input tokens${usage.capacity ? ` / ${usage.capacity.toLocaleString()}` : "; model window unavailable"}. ${usage.model}. Reported ${new Date(usage.time).toLocaleString()}.${usage.stale ? " Stale while compacting." : " Last reported input context, not a live token counter."} ${refreshedAt}` : `Context usage unavailable. ${refreshedAt}`;
  return <ChatCard density="compact" className={`worker-card${movingStatus ? " is-active" : ""}`} data-send-kind={sendAnchor ? "worker" : undefined} data-send-id={sendAnchor ? w.id : undefined} tabIndex={sendAnchor ? -1 : undefined} aria-label={sendAnchor ? "Worker send" : "Worker assignment"}>
    <ChatCardHeader className="worker-two-row-header" icon={<WorkerIcon profile={profile} size={40} />} title={<span title={title}>{sendAnchor && <><FiPlay className="worker-start-mark" size={13} aria-hidden="true" /><span className="sr-only">Start: </span></>}{workerName}</span>}
      description={w.input.subject && <span className="worker-card-subject" title={w.input.subject}>{w.input.subject}</span>}
      actions={<>
        <ChatButton variant="ghost" icon={<FiArrowUpRight size={13} />} aria-label="Open worker" disabled={sending} onClick={() => open(w)}>Open</ChatButton>
        <WorkerActionsMenu attention={attention} busy={cancelling} canCancel={stoppable} refresh={refresh} refreshedAt={refreshedAt} onDetails={button => show("details", button)} onCancel={() => void cancel()}
          onCancelTree={workers.some(child => child.parent.sessionId === w.sessionId) ? () => void cancel(true) : undefined} />
      </>} />
    {!!w.input.jobs?.length && <div className="worker-card-jobs" title={`Jobs: ${w.input.jobs.join(", ")}`}><span className="sr-only">{w.input.jobs.length === 1 ? "Job: " : "Jobs: "}</span>{w.input.jobs.map(job => <code key={job}>{job}</code>)}</div>}
      <ChatMetadata className="worker-card-metrics">
        <WorkerStatusIcon state={statusState} label={statusLabel} />
        <span className="worker-card-metric-group"><span className="worker-card-separator" aria-hidden="true">·</span><span className="worker-card-elapsed" title={`Started ${new Date(timestamp).toLocaleString()}`}><span className="sr-only">Elapsed: </span>{duration}</span></span>
        <span className="worker-card-metric-group"><span className="worker-card-separator" aria-hidden="true">·</span><span className="worker-card-metric" title={`Recorded calls in this worker session, including continuations; excludes descendants. ${refreshedAt}`}>{snapshot?.toolCallCount == null ? "—" : snapshot.toolCallCount.toLocaleString()} calls</span></span>
        <span className="worker-card-metric-group"><span className="worker-card-separator" aria-hidden="true">·</span><span className="worker-card-metric" title={contextTitle}>{contextLabel}</span></span>
      </ChatMetadata>
    {cancelNotice && <ChatNotice role="status">{cancelNotice}</ChatNotice>}
    {read.error && <ChatNotice tone="warning" role="alert">Refresh failed: {read.error}{snapshot ? " Showing the previous snapshot." : ""}</ChatNotice>}
    {snapshot?.warnings.map(warning => <ChatNotice key={warning} tone="warning" role="status">{warning}</ChatNotice>)}
    <WorkerExchanges worker={w} compact />
    {view && <WorkerDetails worker={w} view={view} trigger={trigger.current} close={() => setView(null)} />}
  </ChatCard>;
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
  const [view, setView] = useState<WorkerView | null>(null);
  const [selectedRevision, setSelectedRevision] = useState<number | undefined>();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const show = (next: WorkerView, button: HTMLButtonElement, selected?: number) => { trigger.current = button; setSelectedRevision(selected); setView(next); };
  const outcome = result ? workerStatusLabel("terminal", result.outcome.status) : "Status unavailable";
  return <ChatCard density="compact" className="worker-receipt" aria-label={`Worker result ${revision}`}>
    <ChatCardHeader className="worker-two-row-header" icon={<WorkerIcon profile={profile} size={40} />} title={<span title={profile.label || WORKER_AGENT_CATALOG[w.input.worker].label}>{profile.label || WORKER_AGENT_CATALOG[w.input.worker].label}</span>}
      description={<span title={`Result ${revision} · ${outcome}${result ? ` · ${new Date(result.outcome.at).toLocaleString()}` : ""}`}>Result {revision} · <span className="worker-result-outcome" data-outcome={result?.outcome.status ?? "unknown"}>{outcome}</span>{result && <> · <time dateTime={result.outcome.at}>{new Date(result.outcome.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></>}</span>}
      actions={<>
        <ChatButton variant="ghost" icon={<FiArrowUpRight size={13} />} disabled={sending || !w.parent.sessionId} onClick={() => goToSend({ kind: "worker", id: w.id, sessionId: w.parent.sessionId })}>Go to Send</ChatButton>
        <WorkerOverflowMenu label="Worker result actions" attention={!!result?.notification.error} items={[
          { id: "result", label: "View result", icon: <FiArrowRight />, disabled: !result, opensDialog: true, onSelect: button => show("history", button, revision) },
          { id: "history", label: "History", icon: <FiClock />, disabled: !results.length, opensDialog: true, onSelect: button => show("history", button) },
          { id: "details", label: "Details", icon: <FiInfo />, opensDialog: true, onSelect: button => show("details", button) },
        ]} />
      </>} />
    {view && <WorkerDetails worker={w} view={view} initialRevision={selectedRevision} trigger={trigger.current} close={() => setView(null)} />}
  </ChatCard>;
}

export function WorkerOutcomeReport({ delivery, workers }: { delivery: WorkerDelivery; workers: WorkerRecord[] }) {
  const refs = delivery.resultRefs ?? delivery.workerIds.map(workerId => ({ workerId, revision: 1 }));
  return <section className="worker-outcome-report" aria-label="Worker outcome report">{refs.map(ref => {
    const worker = workers.find(w => w.id === ref.workerId);
    return worker ? <WorkerReceipt key={`${ref.workerId}:${ref.revision}`} worker={worker} revision={ref.revision} /> : <ChatCard key={`${ref.workerId}:${ref.revision}`} density="compact" className="worker-receipt" aria-label={`Worker result ${ref.revision}`}><ChatCardHeader className="worker-two-row-header" title="Worker" icon={<FiUsers size={40} />} description={<span className="worker-result-outcome" data-outcome="unknown">Result {ref.revision} · Status unavailable</span>} /></ChatCard>;
  })}</section>;
}

export function WorkerExchangeMessage({ exchange, recipient, tool, renderMessage }: { exchange: WorkerExchange; recipient?: WorkerRecord; tool?: ToolPart; renderMessage: (text: string) => ReactNode }) {
  const [view, setView] = useState<"message" | "details" | "tool" | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const show = (next: "message" | "details" | "tool", button: HTMLButtonElement) => { trigger.current = button; setView(next); };
  const route = exchangeRouteLabel(exchange);
  const DirectionIcon = exchange.direction === "parent-to-child" ? FiArrowLeft : FiArrowRight;
  const delivery = exchangeDeliveryPresentation(exchange, recipient);
  const status = delivery.label;
  const kind = { consultation: "Consultation", guidance: "Guidance", notice: "Notice" }[exchange.kind];
  const acceptanceNote = delivery.parked ? "The recipient worker assignment finished before delivery. This message is retained as historical evidence, not awaiting automatic retry" : exchange.delivery.state === "wrapper-completed" ? "App delivery run completed; not a native acceptance receipt or task completion" : "Native acceptance, not comprehension or task completion";
  const metadata = <><span>{kind}</span><ChatStatus tone={delivery.tone} title={acceptanceNote}>{status}</ChatStatus><time dateTime={exchange.createdAt} title={new Date(exchange.createdAt).toLocaleString()}>{new Date(exchange.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></>;
  return <ChatCard density="compact" className="worker-exchange-card" aria-label="Worker exchange">
    <ChatCardHeader className="worker-two-row-header" title={<span title={route}>{route}</span>} icon={<DirectionIcon size={28} />}
      description={<span title={`${kind} · ${status} · ${new Date(exchange.createdAt).toLocaleString()}. ${acceptanceNote}`}>{kind} · <span className="worker-exchange-status" data-delivery={delivery.parked ? "not-delivered" : exchange.delivery.state}>{status}</span> · <time dateTime={exchange.createdAt}>{new Date(exchange.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></span>}
      actions={<>
        <ChatButton variant="ghost" aria-label="View worker exchange message" aria-haspopup="dialog" onClick={event => show("message", event.currentTarget)}>View</ChatButton>
        <WorkerOverflowMenu label="Worker exchange actions" attention={!!(exchange.delivery.error || tool?.error)} items={[
          { id: "delivery", label: "Delivery details", icon: <FiInfo />, opensDialog: true, onSelect: button => show("details", button) },
          ...(tool ? [{ id: "tool", label: "Tool details", icon: <FiInfo />, opensDialog: true, onSelect: (button: HTMLButtonElement) => show("tool", button) }] : []),
        ]} />
      </>} />
    {delivery.notice && <ChatNotice tone={delivery.parked ? "warning" : "danger"} role={delivery.parked ? undefined : "alert"}>{delivery.notice}</ChatNotice>}
    {tool?.error && <ChatNotice tone="warning" role="alert">The messaging tool reported an error. Inspect Tool details before retrying; the saved exchange is retained.</ChatNotice>}
    {view && createPortal(<ChatDialog title={view === "message" ? "Worker exchange" : view === "tool" ? "Worker message tool details" : "Worker exchange details"} subtitle={route} size="wide" className="worker-exchange-dialog" close={() => setView(null)} restoreFocus={() => trigger.current}>
      <ChatDialogBody>
        {view === "message" ? <><ChatMetadata>{metadata}</ChatMetadata><div className="worker-exchange-content">{renderMessage(exchange.text)}</div></> : view === "tool" && tool ? <><h3>{tool.name}</h3><h4>Input</h4><pre className="worker-result-output">{JSON.stringify(tool.input, null, 2)}</pre><h4>{tool.error ? "Error" : "Output"}</h4><pre className="worker-result-output">{typeof tool.output === "string" ? tool.output : JSON.stringify(tool.output, null, 2) ?? "No output recorded"}</pre></> : <>
          <ChatMetadata>{metadata}</ChatMetadata><p className="muted">{acceptanceNote}.</p>
          <dl className="facts">{[["Exchange ID", exchange.id], ["Correlation ID", exchange.correlationId], ["Sender conversation", exchange.sender.sessionId], ["Recipient conversation", exchange.recipient.sessionId], ["Delivery state", exchange.delivery.state], ["Delivery diagnostic", exchange.delivery.error ?? "None"], ["Delivery ID", exchange.delivery.deliveryId ?? "Unavailable"], ["Delivery run", exchange.delivery.runId ?? "Unavailable"], ["Delivery command", exchange.delivery.commandId ?? "Unavailable"], ["Created", new Date(exchange.createdAt).toLocaleString()]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        </>}
        {delivery.notice && <ChatNotice tone={delivery.parked ? "warning" : "danger"} role={delivery.parked ? undefined : "alert"}>{delivery.notice}</ChatNotice>}
      </ChatDialogBody>
    </ChatDialog>, document.body)}
  </ChatCard>;
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
      <header className="workers-panel-header"><div><h2 id={`${id}-title`}>Workers</h2><ChatMetadata>{count} active · {workers.length} total{idle ? ` · ${idle} idle` : ""}{awaiting ? ` · ${awaiting} awaiting` : ""}{uncertain ? ` · ${uncertain} unconfirmed` : ""}</ChatMetadata></div><ChatIconButton aria-label="Close workers" onClick={() => setOpened(false)}><FiX size={18} /></ChatIconButton></header>
      <div className="workers-panel-body">
        {projection.error && <ChatNotice tone="warning" role="alert">Worker status unavailable: {projection.error}</ChatNotice>}
        {projection.continuationSuppressed && <ChatNotice tone="warning" role="status">Automatic report-back is paused after an explicit stop. Results remain available; resuming this conversation re-enables delivery.</ChatNotice>}
        {projection.deliveries.filter(d => d.error).map(d => <ChatNotice key={d.id} tone="danger" role="alert">Report-back {d.state}: {d.error}</ChatNotice>)}
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
  const content = <>{projection.error && <ChatNotice tone="warning">Worker status unavailable: {projection.error}</ChatNotice>}{projection.continuationSuppressed && <ChatNotice tone="warning">Automatic report-back continuation is suppressed after an explicit stop. Outcomes remain available; user resumption re-enables delivery.</ChatNotice>}{!runId && children.length > 0 && <CancelWorker parent={sessionId} input={{ all: true }}>Cancel all workers in this conversation tree</CancelWorker>}{children.map(w => <WorkerCard key={w.id} worker={w} workers={projection.workers} open={open} />)}{projection.deliveries.filter(d => d.error).map(d => <ChatNotice key={d.id} tone="danger">Report-back {d.state}: {d.error}</ChatNotice>)}</>;
  const label = <>Workers · {children.length}{projection.error || projection.deliveries.some(d => d.error) ? " · Attention needed" : projection.continuationSuppressed ? " · Report-back paused" : ""}</>;
  return collapsible ? <ChatDisclosure className="worker-section" title={label}>{content}</ChatDisclosure> : <section className="worker-section"><h3>{label}</h3>{content}</section>;
}
