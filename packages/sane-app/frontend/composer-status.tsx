import { useEffect, useRef, useState, type ReactNode } from "react";
import { FiInfo } from "react-icons/fi";
import { chatStatusSummary, type ChatStatus } from "./chat-status";
import { ShellDialog } from "./shell-dialog";
import { store } from "./store";

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
export function ComposerStatus({ statuses, active, actions, restoreFocus }: { statuses: ChatStatus[]; active: boolean; actions?: ReactNode; restoreFocus: () => HTMLElement | null }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
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
  const summaryKey = JSON.stringify([summary?.id, summary?.text]);
  const delayLoading = !!summary?.busy && briefLoading.has(summary.id);
  const [visibleLoading, setVisibleLoading] = useState<string>();
  useEffect(() => {
    if (!active || !delayLoading) { setVisibleLoading(undefined); return; }
    const timer = setTimeout(() => setVisibleLoading(summaryKey), 200);
    return () => clearTimeout(timer);
  }, [active, delayLoading, summaryKey]);
  const recent = [...currentLog.events].reverse().filter(event => !statuses.some(status => sameStatus(status, event)));
  useEffect(() => { if (!active) setOpen(false); }, [active]);
  const restore = () => activity.current ? trigger.current?.isConnected ? trigger.current : restoreFocus() : document.body;
  const retry = (status: ChatStatus) => status.action === "reconnect" ? store.reconnect() : void store.loadModels(store.harness());

  return <>
    {summary && (!delayLoading || visibleLoading === summaryKey) && <div className="composer-status-lid">
      <span className={summary.busy ? "pulse" : "composer-status-dot"} aria-hidden="true" />
      <span className="composer-status-text" role="status" aria-live="polite" aria-atomic="true" title={summary.text}>{summary.text}</span>
      {actions}
      <button ref={trigger} type="button" className="composer-status-info" disabled={!active} aria-label="Show activity details" aria-haspopup="dialog" aria-expanded={open} title="Activity details" onClick={() => setOpen(true)}><FiInfo size={15} aria-hidden="true" /></button>
    </div>}
    {active && open && <ShellDialog title="Conversation activity" close={() => setOpen(false)} restoreFocus={restore}>
      <div className="composer-status-details">
        <h3>Current status</h3>
        {statuses.length ? <ul>{[...statuses].reverse().map(status => <li key={status.id}><strong>{status.text}</strong>{status.detail && <p>{status.detail}</p>}<ActivityTiming status={status} />{status.action && <button type="button" className="text-button" disabled={status.action === "models" && (store.snapshot().modelsLoading || !store.capabilities().listModels)} onClick={() => retry(status)}>{status.action === "reconnect" ? "Reconnect" : "Retry model catalog"}</button>}</li>)}</ul> : <p className="muted">No background activity.</p>}
        {actions && <div className="composer-status-actions">{actions}</div>}
        {!!recent.length && <><h3>Recent updates</h3><ol>{recent.map(event => <li key={event.sequence}><time dateTime={new Date(event.time).toISOString()}>{new Date(event.time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</time><div><strong>{event.text}</strong>{event.detail && <p>{event.detail}</p>}</div></li>)}</ol></>}
      </div>
    </ShellDialog>}
  </>;
}
