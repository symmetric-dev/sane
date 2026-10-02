import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FiArrowDownLeft, FiArrowUpRight, FiChevronRight, FiInfo, FiX } from "react-icons/fi";
import type { Phase } from "sane-core/contracts";
import type { HandoffParty, HandoffPresentation } from "../src/handoff-contract";
import type { ToolPart } from "./types";
import { store, useStore } from "./store";
import { handoffStatusLabel, phaseLabel } from "./handoff-presentation";

type MessageRenderer = (text: string) => ReactNode;
function MessageAccordion({ message, renderMessage }: { message: string; renderMessage: MessageRenderer }) {
  return <details className="handoff-message"><summary><FiChevronRight size={13} aria-hidden="true" />Show message</summary><div className="handoff-message-body">{renderMessage(message)}</div></details>;
}
function PhaseBadges({ phases }: { phases: Phase[] }) {
  return <span className="handoff-phases">{phases.length ? phases.map(phase => <span key={phase} className="handoff-phase">{phaseLabel(phase)}</span>) : <span className="handoff-phase is-unassigned">Unassigned</span>}</span>;
}
function Party({ label, party }: { label: string; party: HandoffParty }) {
  return <div className="handoff-party"><span className="handoff-party-label">{label}</span><strong>{party.title}</strong><PhaseBadges phases={party.phases} /></div>;
}
function Facts({ values }: { values: [string, string | null | undefined][] }) {
  return <dl className="facts">{values.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || "Unavailable"}</dd></div>)}</dl>;
}
function HandoffDetails({ presentation: p, stale, close, trigger, openDisabled }: { presentation: HandoffPresentation; stale?: string; close: () => void; trigger: HTMLButtonElement | null; openDisabled: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null), id = useId();
  const h = p.handoff;
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => { element.close(); if (trigger?.isConnected) trigger.focus(); };
  }, [trigger]);
  return createPortal(<dialog ref={dialog} className="handoff-details-dialog" aria-modal="true" aria-labelledby={id} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <header className="handoff-details-header"><FiArrowUpRight size={22} aria-hidden="true" /><div><h2 id={id}>Handoff details</h2><p>{p.sender.title} → {p.recipient.title}</p></div><button type="button" className="icon-button" aria-label="Close handoff details" onClick={close}><FiX size={18} aria-hidden="true" /></button></header>
    <div className="handoff-details-body">
      <Facts values={[
        ["Workstream", `${p.workstreamTitle} · ${h.workstreamId}`],
        ["Sender phase", p.sender.phases.length ? p.sender.phases.map(phaseLabel).join(", ") : "Unassigned"],
        ["Recipient phase", phaseLabel(h.input.to)],
        ["Recipient", h.input.createNew ? "New conversation" : "Existing conversation"],
        ["Status", `${handoffStatusLabel[h.status]}${stale ? " · last known" : ""}`],
        ["Sent", new Date(h.createdAt).toLocaleString()],
        ["Last updated", new Date(h.updatedAt).toLocaleString()],
      ]} />
      <p className="handoff-status-note">Completed means recipient execution ended successfully, not approval or a reply. Replies are separate handoffs.</p>
      {stale && <p className="notice" role="status">Status unavailable: {stale}</p>}
      {p.problem && <p className="notice error" role="alert">{p.problem}</p>}
      {h.evidence && <p className="handoff-evidence">{h.evidence}</p>}
      <details className="handoff-diagnostic"><summary>Technical identifiers</summary><Facts values={[
        ["Handoff ID", h.id], ["Request ID", h.input.requestId], ["Repository ID", h.repositoryId],
        ["Sender conversation", p.sender.sessionId], ["Sender native ID", h.sender.nativeId], ["Sender authority", h.sender.authorityId],
        ["Recipient conversation", p.recipient.sessionId], ["Recipient native ID", h.recipient.ref?.nativeId], ["Recipient authority", h.recipient.authorityId],
        ["Attempt ID", h.attemptId], ["Run ID", h.runId], ["Native command ID", h.nativeCommandId], ["Execution checkout", h.recipient.checkout.path],
      ]} /></details>
      <details className="handoff-diagnostic"><summary>Delivery history</summary>{p.history.length ? <ol className="handoff-history">{p.history.map(entry => <li key={entry.id}><div><strong>{handoffStatusLabel[entry.status]}</strong><time dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time></div>{entry.evidence && <p>{entry.evidence}</p>}</li>)}</ol> : <p className="muted">No delivery history available.</p>}</details>
    </div>
    <footer className="handoff-details-footer"><button type="button" className="handoff-action" disabled={openDisabled || !p.recipient.sessionId} onClick={() => { close(); store.openConversation(p.recipient.sessionId!); }}>Open recipient<FiArrowUpRight size={13} aria-hidden="true" /></button></footer>
  </dialog>, document.body);
}
export function HandoffCard({ presentation: p, direction, renderMessage, stale }: { presentation: HandoffPresentation; direction: "sent" | "received"; renderMessage: MessageRenderer; stale?: string }) {
  const [details, setDetails] = useState(false), trigger = useRef<HTMLButtonElement>(null);
  const sending = useStore(state => state.sending);
  const h = p.handoff, target = direction === "sent" ? p.recipient : p.sender;
  const label = target.phases[0] ? phaseLabel(target.phases[0]) : "sender";
  const moving = !stale && ["queued", "accepted", "running"].includes(h.status);
  return <section className={`handoff-card${h.status === "failed" || p.problem ? " has-issue" : ""}`} aria-label={`Assistant handoff ${direction}`}>
    <header>{direction === "sent" ? <FiArrowUpRight size={16} aria-hidden="true" /> : <FiArrowDownLeft size={16} aria-hidden="true" />}<span className="handoff-heading">Assistant handoff · {direction}</span><span className={`handoff-status${moving ? " is-active" : ""}${h.status === "failed" ? " is-error" : ""}`} role="status">{direction === "received" ? "Received" : handoffStatusLabel[h.status]}{direction === "sent" && stale ? " · last known" : ""}</span></header>
    <div className="handoff-correspondents"><Party label="From" party={p.sender} /><Party label="To" party={p.recipient} /></div>
    <div className="handoff-context"><span>Workstream · {p.workstreamTitle}</span><time dateTime={h.createdAt} title={new Date(h.createdAt).toLocaleString()}>{new Date(h.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div>
    <MessageAccordion message={h.input.message} renderMessage={renderMessage} />
    {(p.problem || h.status === "failed") && <p className="handoff-warning" role="alert">{p.problem || "Recipient execution failed. See Details for the recorded evidence."}</p>}
    {stale && <p className="handoff-warning" role="status">Live handoff status unavailable. Details show the last recorded state.</p>}
    <footer><button type="button" className="handoff-action" disabled={sending || !target.sessionId} title={!target.sessionId ? "This assistant has no local conversation to open" : undefined} onClick={() => store.openConversation(target.sessionId!)}><FiArrowUpRight size={13} aria-hidden="true" />Open {label}</button><button ref={trigger} type="button" className="handoff-action" aria-haspopup="dialog" aria-label="Handoff details" onClick={() => setDetails(true)}><FiInfo size={13} aria-hidden="true" />Details</button></footer>
    {details && <HandoffDetails presentation={p} stale={stale} trigger={trigger.current} close={() => setDetails(false)} openDisabled={sending} />}
  </section>;
}

/** Preserve unconfirmed or rejected calls without displaying raw tool payloads. */
export function PendingHandoffCard({ tool, running, renderMessage }: { tool: ToolPart; running: boolean; renderMessage: MessageRenderer }) {
  const input = tool.input && typeof tool.input === "object" && !Array.isArray(tool.input) ? tool.input as Record<string, unknown> : {};
  const phase = typeof input.to === "string" && /^(design|engineering|planning|execution|research(?::[a-z0-9_-]+)?)$/.test(input.to) ? input.to as Phase : null;
  return <section className="handoff-card" aria-label="Assistant handoff sent"><header><FiArrowUpRight size={16} aria-hidden="true" /><span className="handoff-heading">Assistant handoff · sent</span><span className={`handoff-status${tool.error ? " is-error" : ""}`} role="status">{tool.error ? "Admission unconfirmed" : running && tool.output === undefined ? "Sending" : "Status unavailable"}</span></header>
    <div className="handoff-correspondents"><div className="handoff-party"><span className="handoff-party-label">To</span><strong>{phase ? `${phaseLabel(phase)} assistant` : "Recipient unavailable"}</strong>{phase && <PhaseBadges phases={[phase]} />}</div></div>
    {typeof input.message === "string" && <MessageAccordion message={input.message} renderMessage={renderMessage} />}
    {tool.error && <p className="handoff-warning" role="alert">Handoff admission could not be confirmed. Inspect run details before retrying.</p>}
    {!running && !tool.error && <p className="handoff-warning" role="status">The durable handoff record is unavailable. See run details for the original tool evidence.</p>}
  </section>;
}
