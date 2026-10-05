import { useEffect, useRef, useState, type ReactNode } from "react";
import { FiInfo } from "react-icons/fi";
import type { ChatStatus } from "./chat-status";
import { ShellDialog } from "./shell-dialog";
import { store } from "./store";

type StatusEvent = ChatStatus & { sequence: number; time: number };
type StatusLog = { signature: string; current: ChatStatus[]; events: StatusEvent[]; sequence: number };
const sameStatus = (left: ChatStatus, right: ChatStatus) => left.id === right.id && left.text === right.text && left.detail === right.detail && left.busy === right.busy && left.action === right.action;

/** Only the latest active change occupies the lid. Details retain a bounded,
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
  const latest = [...currentLog.events].reverse().find(event => statuses.some(status => sameStatus(status, event)));
  const summary = latest ?? statuses.at(-1);
  const recent = [...currentLog.events].reverse().filter(event => !statuses.some(status => sameStatus(status, event)));
  useEffect(() => { if (!active) setOpen(false); }, [active]);
  const restore = () => activity.current ? trigger.current?.isConnected ? trigger.current : restoreFocus() : document.body;
  const retry = (status: ChatStatus) => status.action === "reconnect" ? store.reconnect() : void store.loadModels(store.harness());

  return <>
    {summary && <div className="composer-status-lid">
      <span className={summary.busy ? "pulse" : "composer-status-dot"} aria-hidden="true" />
      <span className="composer-status-text" role="status" aria-live="polite" aria-atomic="true" title={summary.text}>{summary.text}</span>
      {actions}
      <button ref={trigger} type="button" className="composer-status-info" disabled={!active} aria-label="Show activity details" aria-haspopup="dialog" aria-expanded={open} title="Activity details" onClick={() => setOpen(true)}><FiInfo size={15} aria-hidden="true" /></button>
    </div>}
    {active && open && <ShellDialog title="Conversation activity" close={() => setOpen(false)} restoreFocus={restore}>
      <div className="composer-status-details">
        <h3>Current status</h3>
        {statuses.length ? <ul>{[...statuses].reverse().map(status => <li key={status.id}><strong>{status.text}</strong>{status.detail && <p>{status.detail}</p>}{status.action && <button type="button" className="text-button" disabled={status.action === "models" && (store.snapshot().modelsLoading || !store.capabilities().listModels)} onClick={() => retry(status)}>{status.action === "reconnect" ? "Reconnect" : "Retry model catalog"}</button>}</li>)}</ul> : <p className="muted">No background activity.</p>}
        {actions && <div className="composer-status-actions">{actions}</div>}
        {!!recent.length && <><h3>Recent updates</h3><ol>{recent.map(event => <li key={event.sequence}><time dateTime={new Date(event.time).toISOString()}>{new Date(event.time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</time><div><strong>{event.text}</strong>{event.detail && <p>{event.detail}</p>}</div></li>)}</ol></>}
      </div>
    </ShellDialog>}
  </>;
}
