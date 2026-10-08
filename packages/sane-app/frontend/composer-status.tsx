import { useEffect, useRef, useState, type ReactNode } from "react";
import { FiInfo } from "react-icons/fi";
import { chatStatusSummary, type ChatStatus } from "./chat-status";
import { ShellDialog } from "./shell-dialog";
import { store } from "./store";
import type { PendingInputLid } from "./pending-input-primary-action";

type StatusEvent = ChatStatus & { sequence: number; time: number };
type StatusLog = { signature: string; current: ChatStatus[]; events: StatusEvent[]; sequence: number };
const sameStatus = (left: ChatStatus, right: ChatStatus) => left.id === right.id && left.text === right.text && left.detail === right.detail && left.busy === right.busy && left.action === right.action;
const briefLoading = new Set(["conversation", "workspace", "history-page", "history-refresh", "handoffs", "workers", "native-subagents"]);

/** Mounted only in activity details. Elapsed time is measured, not a progress
 * estimate, and never becomes a repeatedly announced live-region message. */
function ActivityTiming({ status }: { status: ChatStatus }) {
  const [now, setNow] = useState(Date.now);
  const start = Date.parse(status.startedAt ?? "");
  useEffect(() => {
    if (!status.busy || !Number.isFinite(start)) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status.busy, start]);
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  return <>
    {status.busy && Number.isFinite(start) && seconds >= 10 && <p>Elapsed: {Math.floor(seconds / 60)}m {seconds % 60}s</p>}
    {status.observedAt && Number.isFinite(Date.parse(status.observedAt)) && <p>Last observed: <time dateTime={status.observedAt}>{new Date(status.observedAt).toLocaleTimeString()}</time></p>}
  </>;
}

/** The highest-priority active state occupies the lid. Details retain a bounded,
 * conversation-scoped history without creating synthetic chat messages. */
export function ComposerStatus({ statuses, active, actions, restoreFocus, queue, detailsRequest = 0 }: { statuses: ChatStatus[]; active: boolean; actions?: ReactNode; restoreFocus: () => HTMLElement | null; queue?: { lid: PendingInputLid; details: ReactNode }; detailsRequest?: number }) {
  const [open, setOpen] = useState(false);
  const [verification, setVerification] = useState<{ confirm: () => Promise<void>; sessionId: string }>();
  const trigger = useRef<HTMLButtonElement>(null);
  const consumedRequest = useRef(0);
  const requestedFromComposer = useRef(false);
  const activity = useRef(active); activity.current = active;
  const [log, setLog] = useState<StatusLog>({ signature: "", current: [], events: [], sequence: 0 });
  const signature = JSON.stringify(statuses);
  let currentLog = log;
  // Guarded render adjustment keeps the one-line summary current on the same
  // render as its source state; no effect briefly displays the previous status.
  if (signature !== log.signature) {
    let sequence = log.sequence;
    const changed = statuses.filter(status => !log.current.some(previous => sameStatus(previous, status)));
    const events = changed.map(status => ({ ...status, sequence: ++sequence, time: Date.now() }));
    currentLog = { signature, current: statuses, events: [...log.events, ...events].slice(-40), sequence };
    setLog(currentLog);
  }
  const summary = chatStatusSummary(statuses);
  // Only ordinary execution wording may yield to the queue state. Connection,
  // source, permission, error and reconciliation summaries remain primary.
  const queuePrimary = !!queue && (!summary || (summary.priority ?? (summary.id === "availability" ? 80 : 60)) < 80
    && (summary.id === "pending-input" || (summary.id === "run" && !!summary.busy) || (summary.id === "availability" && !!summary.busy)));
  const lidText = queuePrimary ? queue!.lid.text : summary?.text;
  const queueDescription = queue?.lid.waitingLabel ?? "";
  const queueBadge = queue?.lid.waitingLabel;
  const combinedText = [lidText, queueDescription].filter(Boolean).join(" · ");
  const lidBusy = queuePrimary ? queue!.lid.state === "running" || queue!.lid.state === "checking" : summary?.busy;
  const summaryKey = JSON.stringify([summary?.id, summary?.text]);
  const delayLoading = !!summary?.busy && briefLoading.has(summary.id);
  const [visibleLoading, setVisibleLoading] = useState<string>();
  useEffect(() => {
    if (!active || !delayLoading) { setVisibleLoading(undefined); return; }
    const timer = setTimeout(() => setVisibleLoading(summaryKey), 200);
    return () => clearTimeout(timer);
  }, [active, delayLoading, summaryKey]);
  const recent = [...currentLog.events].reverse().filter(event => !statuses.some(status => sameStatus(status, event)));
  useEffect(() => {
    const fresh = detailsRequest > consumedRequest.current && detailsRequest > 0;
    consumedRequest.current = detailsRequest;
    if (!active) setOpen(false);
    else if (fresh) { requestedFromComposer.current = true; setOpen(true); }
  }, [active, detailsRequest]);
  const restore = () => activity.current ? requestedFromComposer.current ? restoreFocus() : trigger.current?.isConnected ? trigger.current : restoreFocus() : document.body;
  const retry = (status: ChatStatus) => {
    if (status.action === "verify-completion" && status.verificationTarget) {
      const confirm = store.prepareCompletionVerification(status.verificationTarget);
      if (confirm) { setVerification({ confirm, sessionId: status.verificationTarget.sessionId }); setOpen(true); }
    } else if (status.action === "reconnect") store.reconnect();
    else void store.loadModels(store.harness());
  };
  const verifyStatus = statuses.find(status => status.action === "verify-completion");
  const confirming = verification && verification.sessionId === store.snapshot().selected;

  return <>
    <div className="composer-status-slot">
    {(queue || summary && (!delayLoading || visibleLoading === summaryKey)) && <div className="composer-status-lid">
      <span className={lidBusy ? "pulse" : "composer-status-dot"} aria-hidden="true" />
      <span className="composer-status-text" role="status" aria-live="polite" aria-atomic="true" aria-label={combinedText} title={combinedText}>{lidText}</span>
      {queueBadge && <span className="pending-input-status-badge" data-state={queue?.lid.state} title={queueDescription} aria-hidden="true">{queueBadge}</span>}
      {actions}
      {verifyStatus && <button type="button" className="text-button" disabled={!active || store.snapshot().actionBusy} onClick={() => retry(verifyStatus)}>Verify completion</button>}
      <button ref={trigger} type="button" className="composer-status-info" disabled={!active} aria-label={queue ? `Show activity and queue details: ${combinedText}` : "Show activity details"} aria-haspopup="dialog" aria-expanded={open} title={queue ? "Activity and queue details" : "Activity details"} onClick={() => { requestedFromComposer.current = false; setOpen(true); }}><FiInfo size={15} aria-hidden="true" /></button>
    </div>}
    </div>
    {active && open && <ShellDialog title="Conversation activity" close={() => { setOpen(false); setVerification(undefined); }} restoreFocus={restore}>
      <div className="composer-status-details">
        {confirming && <section aria-label="Verify completion">
          <h3>Verify completion?</h3>
          <p>Checks that the latest native OpenCode execution is idle and records your operator verification of its outcome. This does not resend your prompt.</p>
          <button type="button" className="text-button" onClick={() => { setVerification(undefined); void verification.confirm(); }}>Confirm verification</button>
          <button type="button" className="text-button" onClick={() => setVerification(undefined)}>Cancel</button>
        </section>}
        <section aria-label="Activity">
        {queue && <h3>Activity</h3>}
        <h3>Current status</h3>
        {statuses.length ? <ul>{[...statuses].reverse().map(status => <li key={status.id}><strong>{status.text}</strong>{status.detail && <p>{status.detail}</p>}<ActivityTiming status={status} />{status.action && <button type="button" className="text-button" disabled={status.action === "models" && (store.snapshot().modelsLoading || !store.capabilities().listModels) || status.action === "verify-completion" && store.snapshot().actionBusy} onClick={() => retry(status)}>{status.action === "reconnect" ? "Reconnect" : status.action === "verify-completion" ? "Verify completion" : "Retry model catalog"}</button>}</li>)}</ul> : <p className="muted">No background activity.</p>}
        {actions && <div className="composer-status-actions">{actions}</div>}
        {!!recent.length && <><h3>Recent updates</h3><ol>{recent.map(event => <li key={event.sequence}><time dateTime={new Date(event.time).toISOString()}>{new Date(event.time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</time><div><strong>{event.text}</strong>{event.detail && <p>{event.detail}</p>}</div></li>)}</ol></>}
        </section>
        {queue?.details}
      </div>
    </ShellDialog>}
  </>;
}
