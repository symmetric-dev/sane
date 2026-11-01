import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiArrowUpRight, FiInfo } from "react-icons/fi";
import { LuHandHelping } from "react-icons/lu";
import type { HandoffPresentation } from "../src/handoff-contract";
import { ChatButton, ChatCard, ChatCardHeader, ChatDialog, ChatDialogBody, ChatIconButton, ChatMetadata, ChatNotice, ChatStatus } from "./chat-ui";
import { handoffStatusLabel, phaseLabel } from "./handoff-presentation";
import "./handoff-interaction.css";

export type HandoffInteraction = {
  id: string;
  createdAt: string;
  direction: "sent" | "received";
  presentation: HandoffPresentation;
  title: string;
  searchText: string;
};

function timestamp(value: string) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

/** Durable handoffs only; self-handoffs appear once, as sent interactions. */
export function buildHandoffInteractions(sessionId: string, presentations: readonly HandoffPresentation[]): HandoffInteraction[] {
  const unique = new Map<string, HandoffPresentation>();
  for (const presentation of presentations) {
    if (presentation.sender.sessionId !== sessionId && presentation.recipient.sessionId !== sessionId) continue;
    const previous = unique.get(presentation.handoff.id);
    // Prefer the freshest lifecycle snapshot without changing the original tie order.
    if (!previous || timestamp(presentation.handoff.updatedAt) > timestamp(previous.handoff.updatedAt)) {
      unique.set(presentation.handoff.id, presentation);
    }
  }
  return Array.from(unique.values(), (presentation): HandoffInteraction => {
    const { handoff, sender, recipient } = presentation;
    const direction = sender.sessionId === sessionId ? "sent" : "received";
    const title = direction === "sent" ? `To: ${recipient.title}` : `From: ${sender.title}`;
    return {
      id: handoff.id,
      createdAt: handoff.createdAt,
      direction,
      presentation,
      title,
      searchText: [
        title, direction, direction === "sent" ? "outgoing" : "incoming", sender.title, recipient.title,
        ...sender.phases.map(phaseLabel), ...recipient.phases.map(phaseLabel), phaseLabel(handoff.input.to),
        presentation.workstreamTitle, handoff.workstreamId, handoff.input.message,
        handoffStatusLabel[handoff.status], handoff.status, presentation.problem, handoff.evidence,
        handoff.id, handoff.createdAt,
      ].filter(Boolean).join("\n").toLocaleLowerCase(),
    };
  }).sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt));
}

/** Picker cards never own transcript send anchors or mutate delivery state. */
export function HandoffInteractionCard({ entry, disabled = false, stale, onSelect }: {
  entry: HandoffInteraction;
  disabled?: boolean;
  stale?: string;
  onSelect: (entry: HandoffInteraction) => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsTrigger = useRef<HTMLButtonElement | null>(null);
  const p = entry.presentation, h = p.handoff;
  const received = entry.direction === "received";
  const target = received ? p.sender : p.recipient;
  const context = `${target.phases.length ? target.phases.map(phaseLabel).join(", ") : "Unassigned"} · ${p.workstreamTitle}`;
  const sourceAvailable = !!p.sender.sessionId;
  const destination = `Go to the original handoff send in ${p.sender.title}'s conversation`;
  const completionNote = "Completed describes recipient execution/delivery, not task approval or a reply.";
  const failed = h.status === "failed";
  const moving = !stale && ["queued", "accepted", "running"].includes(h.status);
  const date = new Date(entry.createdAt);
  const dateLabel = Number.isFinite(date.getTime()) ? date.toLocaleString() : "Time unavailable";

  return <ChatCard density="compact" className={`handoff-interaction-card${failed || p.problem ? " has-issue" : ""}`} aria-label={`Handoff ${received ? "incoming" : "outgoing"}: ${entry.title}`}>
    <ChatCardHeader className="handoff-interaction-header"
      icon={<LuHandHelping size={40} style={received ? undefined : { transform: "scaleX(-1)" }} />}
      title={<span title={entry.title}>{entry.title}</span>}
      description={<span title={context}>{context}</span>}
      actions={<>
        <ChatIconButton ref={detailsTrigger} aria-label={`Handoff details: ${entry.title}`} aria-haspopup="dialog"
          onClick={() => setDetailsOpen(true)}><FiInfo size={15} /></ChatIconButton>
        <ChatButton variant="ghost" icon={<FiArrowUpRight size={13} />}
          disabled={disabled || !sourceAvailable}
          aria-label={`${received ? "Go to send" : "Go to chat"}: original handoff send in ${p.sender.title}'s conversation`}
          title={sourceAvailable ? destination : "The original send is unavailable because the sender has no local conversation."}
          onClick={() => { if (!disabled && sourceAvailable) onSelect(entry); }}>
          {received ? "Go to send" : "Go to chat"}
        </ChatButton>
      </>} />
    <ChatMetadata className="handoff-interaction-metadata">
      <span className="handoff-interaction-direction">{received ? "Incoming" : "Outgoing"}</span>
      <ChatStatus tone={failed || p.problem ? "danger" : stale ? "warning" : h.status === "completed" ? "success" : "neutral"}
        busy={moving} title={h.status === "completed" ? completionNote : undefined}>
        {handoffStatusLabel[h.status]}{stale ? " · last known" : ""}
      </ChatStatus>
      <time dateTime={entry.createdAt} title={dateLabel}>{dateLabel}</time>
    </ChatMetadata>
    {(failed || p.problem) && <ChatNotice tone="danger">{p.problem || "Recipient execution failed. Open details for recorded evidence."}</ChatNotice>}
    {stale && <ChatNotice tone="warning">Live handoff status unavailable: {stale}. Showing the last known state.</ChatNotice>}
    {!sourceAvailable && <p className="handoff-interaction-unavailable">The original send is unavailable because the sender has no local conversation.</p>}
    {detailsOpen && createPortal(<ChatDialog title="Handoff details" subtitle={`${p.sender.title} → ${p.recipient.title}`} size="wide"
      close={() => setDetailsOpen(false)} restoreFocus={() => detailsTrigger.current}>
      <ChatDialogBody className="handoff-interaction-details-body">
        <section><h3>Message</h3><p>{h.input.message || "No message recorded."}</p></section>
        <section><h3>Recorded evidence</h3><p>{h.evidence || "No evidence recorded."}</p></section>
      </ChatDialogBody>
    </ChatDialog>, document.body)}
  </ChatCard>;
}
