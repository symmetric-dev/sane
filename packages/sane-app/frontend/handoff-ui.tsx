import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FiArrowLeft, FiArrowRight, FiArrowUpRight, FiInfo } from "react-icons/fi";
import { isStoredSlot, type Phase } from "sane-core/contracts";
import type { HandoffParty, HandoffPresentation } from "../src/handoff-contract";
import type { ToolPart } from "./types";
import { store, useStore } from "./store";
import { handoffStatusLabel, phaseLabel } from "./handoff-presentation";
import { goToSend } from "./send-navigation";
import { ChatButton, ChatCard, ChatCardBody, ChatCardFooter, ChatCardHeader, ChatDialog, ChatDialogBody, ChatDialogFooter, ChatDisclosure, ChatNotice, ChatReceipt, ChatStatus } from "./chat-ui";

type MessageRenderer = (text: string) => ReactNode;
function MessageAccordion({ message, renderMessage }: { message: string; renderMessage: MessageRenderer }) {
  return <ChatDisclosure className="handoff-message" title="Show message"><div className="handoff-message-body">{renderMessage(message)}</div></ChatDisclosure>;
}
function PhaseBadges({ phases }: { phases: Phase[] }) {
  return <span className="handoff-phases">{phases.length ? phases.map(phase => <span key={phase} className="handoff-phase" title={phase}>{phaseLabel(phase)}</span>) : <span className="handoff-phase is-unassigned">Unassigned</span>}</span>;
}
function Party({ label, party }: { label: string; party: HandoffParty }) {
  return <div className="handoff-party"><span className="handoff-party-label">{label}</span><strong>{party.title}</strong><PhaseBadges phases={party.phases} /></div>;
}
function Facts({ values }: { values: [string, string | null | undefined][] }) {
  return <dl className="facts">{values.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || "Unavailable"}</dd></div>)}</dl>;
}
function HandoffDetails({ presentation: p, stale, close, trigger, openDisabled }: { presentation: HandoffPresentation; stale?: string; close: () => void; trigger: HTMLButtonElement | null; openDisabled: boolean }) {
  const h = p.handoff;
  return createPortal(<ChatDialog title="Handoff details" subtitle={`${p.sender.title} → ${p.recipient.title}`} size="wide" className="handoff-details-dialog" close={close} restoreFocus={() => trigger}>
    <ChatDialogBody className="handoff-details-body">
      <Facts values={[
        ["Workstream", `${p.workstreamTitle} · ${h.workstreamId}`],
        ["Sender assignments", p.sender.phases.length ? p.sender.phases.map(phaseLabel).join(", ") : "Unassigned"],
        ["Recipient assignment", phaseLabel(h.input.to)],
        ["Recipient", h.input.createNew ? "New conversation" : "Existing conversation"],
        ["Status", `${handoffStatusLabel[h.status]}${stale ? " · last known" : ""}`],
        ["Sent", new Date(h.createdAt).toLocaleString()],
        ["Last updated", new Date(h.updatedAt).toLocaleString()],
      ]} />
      <p className="handoff-status-note">Completed means recipient execution/delivery ended successfully, not task completion, user acceptance, approval, or a reply. Replies are separate handoffs.</p>
      {stale && <ChatNotice tone="warning" role="status">Status unavailable: {stale}</ChatNotice>}
      {p.problem && <ChatNotice tone="danger" role="alert">{p.problem}</ChatNotice>}
      {h.evidence && <p className="handoff-evidence">{h.evidence}</p>}
      <ChatDisclosure className="handoff-diagnostic" title="Technical identifiers"><Facts values={[
        ["Handoff ID", h.id], ["Request ID", h.input.requestId], ["Repository ID", h.repositoryId],
        ["Stored destination", h.input.to], ["Stored sender assignments", p.sender.phases.join(", ")],
        ["Sender conversation", p.sender.sessionId], ["Sender native ID", h.sender.nativeId], ["Sender authority", h.sender.authorityId],
        ["Recipient conversation", p.recipient.sessionId], ["Recipient native ID", h.recipient.ref?.nativeId], ["Recipient authority", h.recipient.authorityId],
        ["Attempt ID", h.attemptId], ["Run ID", h.runId], ["Native command ID", h.nativeCommandId], ["Execution checkout", h.recipient.checkout.path],
      ]} /></ChatDisclosure>
      <ChatDisclosure className="handoff-diagnostic" title="Delivery history">{p.history.length ? <ol className="handoff-history">{p.history.map(entry => <li key={entry.id}><div><strong>{handoffStatusLabel[entry.status]}</strong><time dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time></div>{entry.evidence && <p>{entry.evidence}</p>}</li>)}</ol> : <p className="muted">No delivery history available.</p>}</ChatDisclosure>
    </ChatDialogBody>
    <ChatDialogFooter><ChatButton variant="ghost" icon={<FiArrowUpRight size={13} />} disabled={openDisabled || !p.recipient.sessionId} onClick={() => { close(); store.openConversation(p.recipient.sessionId!); }}>Open recipient</ChatButton></ChatDialogFooter>
  </ChatDialog>, document.body);
}
export function HandoffCard({ presentation: p, direction, renderMessage, stale }: { presentation: HandoffPresentation; direction: "sent" | "received"; renderMessage: MessageRenderer; stale?: string }) {
  const [details, setDetails] = useState(false), trigger = useRef<HTMLButtonElement>(null);
  const sending = useStore(state => state.sending);
  const h = p.handoff, target = direction === "sent" ? p.recipient : p.sender;
  const label = target.phases[0] ? phaseLabel(target.phases[0]) : "sender";
  const moving = !stale && ["queued", "accepted", "running"].includes(h.status);
  const received = direction === "received";
  const Frame = received ? ChatReceipt : ChatCard;
  const time = <time dateTime={h.createdAt} title={new Date(h.createdAt).toLocaleString()}>{new Date(h.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>;
  return <Frame className={`handoff-card${received ? " handoff-receipt" : ""}${h.status === "failed" || p.problem ? " has-issue" : ""}`} role={received ? "group" : undefined} aria-label={`Assistant handoff ${direction}`} data-send-kind={received ? undefined : "handoff"} data-send-id={received ? undefined : h.id} tabIndex={received ? undefined : -1}>
    {received ? <ChatCardHeader title={p.sender.title} icon={<FiArrowRight size={16} />} metadata={<><PhaseBadges phases={p.sender.phases} /><ChatStatus>Received</ChatStatus>{time}</>} /> : <>
      <ChatCardHeader title="Assistant handoff · sent" icon={<FiArrowLeft size={16} />} metadata={<ChatStatus tone={h.status === "failed" ? "danger" : stale ? "warning" : "neutral"} busy={moving} role="status">{handoffStatusLabel[h.status]}{stale ? " · last known" : ""}</ChatStatus>} />
      <div className="handoff-correspondents"><Party label="From" party={p.sender} /><Party label="To" party={p.recipient} /></div>
    </>}
    <div className="handoff-context"><span>Workstream · {p.workstreamTitle}</span>{!received && time}</div>
    <MessageAccordion message={h.input.message} renderMessage={renderMessage} />
    {(p.problem || h.status === "failed") && <ChatNotice className="handoff-warning" tone="danger" role="alert">{p.problem || "Recipient execution failed. See Details for the recorded evidence."}</ChatNotice>}
    {stale && <ChatNotice className="handoff-warning" tone="warning" role="status">Live handoff status unavailable. Details show the last recorded state.</ChatNotice>}
    <ChatCardFooter><ChatButton variant="ghost" icon={<FiArrowUpRight size={13} />} disabled={sending || !target.sessionId} title={!target.sessionId ? "This assistant has no local conversation to open" : undefined} onClick={() => received ? goToSend({ kind: "handoff", id: h.id, sessionId: p.sender.sessionId! }) : store.openConversation(target.sessionId!)}>{received ? "Go to send" : `Open ${label}`}</ChatButton><ChatButton ref={trigger} variant="ghost" icon={<FiInfo size={13} />} aria-haspopup="dialog" aria-label="Handoff details" onClick={() => setDetails(true)}>Details</ChatButton></ChatCardFooter>
    {details && <HandoffDetails presentation={p} stale={stale} trigger={trigger.current} close={() => setDetails(false)} openDisabled={sending} />}
  </Frame>;
}

/** Preserve unconfirmed or rejected calls without displaying raw tool payloads. */
export function PendingHandoffCard({ tool, running, renderMessage }: { tool: ToolPart; running: boolean; renderMessage: MessageRenderer }) {
  const input = tool.input && typeof tool.input === "object" && !Array.isArray(tool.input) ? tool.input as Record<string, unknown> : {};
  const phase = isStoredSlot(input.to) ? input.to : null;
  return <ChatCard density="compact" className="handoff-card" aria-label="Assistant handoff sent"><ChatCardHeader title="Assistant handoff · sent" icon={<FiArrowLeft size={16} />} metadata={<ChatStatus tone={tool.error ? "warning" : "neutral"} busy={!tool.error && running && tool.output === undefined} role="status">{tool.error ? "Admission unconfirmed" : running && tool.output === undefined ? "Sending" : "Status unavailable"}</ChatStatus>} />
    <ChatCardBody><div className="handoff-party"><span className="handoff-party-label">To</span><strong>{phase ? `${phaseLabel(phase)} assistant` : "Recipient unavailable"}</strong>{phase && <PhaseBadges phases={[phase]} />}</div></ChatCardBody>
    {typeof input.message === "string" && <MessageAccordion message={input.message} renderMessage={renderMessage} />}
    {tool.error && <ChatNotice className="handoff-warning" tone="warning" role="alert">Handoff admission could not be confirmed. Inspect run details before retrying.</ChatNotice>}
    {!running && !tool.error && <ChatNotice className="handoff-warning" role="status">The durable handoff record is unavailable. See run details for the original tool evidence.</ChatNotice>}
  </ChatCard>;
}
