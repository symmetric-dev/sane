import { useId, useState } from "react";
import { FiMessageSquare } from "react-icons/fi";
import type { WorkstreamOverview } from "../src/workstreams-contract";
import type { DocumentReviewLaunch } from "./document-review-launch";
import { useShellState } from "./store";
import "./workstream-review-entry.css";

export function WorkstreamReviewEntry({ overview, workspaceId, workstreamId, onReview, disabled = false }: {
  overview: WorkstreamOverview;
  workspaceId: string;
  workstreamId: string;
  onReview: (launch: DocumentReviewLaunch) => void;
  disabled?: boolean;
}) {
  const state = useShellState();
  const [recipient, setRecipient] = useState("");
  const id = useId();
  const candidates = overview.conversations.filter(row => row.sessionId && row.conversation?.workstreamId === workstreamId
    && state.conversations.some(conversation => conversation.id === row.sessionId && conversation.workspaceId === workspaceId && !conversation.replacedBy));
  const selected = candidates.find(row => row.sessionId === recipient);
  return <section className="workstream-review-entry" aria-label="Start document review in chat">
    <div className="workstream-review-entry-heading"><FiMessageSquare size={15} aria-hidden="true" /><strong>Review in chat</strong></div>
    {candidates.length ? <div className="workstream-review-entry-controls">
      <label htmlFor={id}>Review recipient<select id={id} value={selected ? recipient : ""} disabled={disabled || state.sending} onChange={event => setRecipient(event.target.value)}>
        <option value="">Choose a conversation…</option>
        {candidates.map(row => <option key={row.sessionId} value={row.sessionId!}>{row.title || "Untitled conversation"}{row.sessionId === state.selected ? " · Current chat" : ""}</option>)}
      </select></label>
      <button type="button" className="primary-button" disabled={!selected || disabled || state.sending} onClick={() => {
        if (selected?.sessionId) onReview({ sessionId: selected.sessionId, workspaceId, repositoryId: overview.repositoryId, workstreamId });
      }}>Start review</button>
    </div> : <p className="muted">Open or connect a conversation in this workstream to review its documents in chat.</p>}
  </section>;
}
