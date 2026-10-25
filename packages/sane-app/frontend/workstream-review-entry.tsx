import { useEffect, useId, useState } from "react";
import { FiMessageSquare } from "react-icons/fi";
import type { WorkstreamOverview } from "../src/workstreams-contract";
import type { DocumentReviewLaunch } from "./document-review-launch";
import { store, useShellState } from "./store";
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
  const [lookup, setLookup] = useState({ key: "", loading: false, error: "" });
  const [retry, setRetry] = useState(0);
  const id = useId();
  const lookupKey = JSON.stringify(overview.conversations.flatMap(row => row.sessionId && row.conversation?.workstreamId === workstreamId ? [row.sessionId] : []).sort());
  useEffect(() => {
    if (!state.conversationPage || state.phase !== "ready") return;
    const controller = new AbortController();
    setLookup({ key: lookupKey, loading: true, error: "" });
    void store.ensureConversations(JSON.parse(lookupKey), controller.signal).then(() => {
      if (!controller.signal.aborted) setLookup({ key: lookupKey, loading: false, error: "" });
    }).catch(() => {
      if (!controller.signal.aborted) setLookup({ key: lookupKey, loading: false, error: "Could not load this workstream’s review recipients." });
    });
    return () => controller.abort();
  }, [lookupKey, workspaceId, workstreamId, state.config, state.phase, !!state.conversationPage, retry]);
  const candidates = overview.conversations.filter(row => row.sessionId && row.conversation?.workstreamId === workstreamId
    && state.conversations.some(conversation => conversation.id === row.sessionId && conversation.workspaceId === workspaceId && !conversation.replacedBy));
  const selected = candidates.find(row => row.sessionId === recipient);
  return <section className="workstream-review-entry" aria-label="Sane Review in chat">
    <div className="workstream-review-entry-heading"><FiMessageSquare size={15} aria-hidden="true" /><strong>Sane Review</strong></div>
    {state.conversationPage && (lookup.key !== lookupKey || lookup.loading) && <p className="muted" role="status">Loading review recipients…</p>}
    {lookup.error && <p className="muted" role="status">{lookup.error} <button type="button" onClick={() => setRetry(value => value + 1)}>Retry</button></p>}
    {candidates.length ? <div className="workstream-review-entry-controls">
      <label htmlFor={id}>Review recipient<select id={id} value={selected ? recipient : ""} disabled={disabled || state.sending} onChange={event => setRecipient(event.target.value)}>
        <option value="">Choose a conversation…</option>
        {candidates.map(row => <option key={row.sessionId} value={row.sessionId!}>{row.title || "Untitled conversation"}{row.sessionId === state.selected ? " · Current chat" : ""}</option>)}
      </select></label>
      <button type="button" className="primary-button" disabled={!selected || disabled || state.sending} onClick={() => {
        if (selected?.sessionId) onReview({ sessionId: selected.sessionId, workspaceId, repositoryId: overview.repositoryId, workstreamId });
      }}>Sane Review</button>
    </div> : !(state.conversationPage && (lookup.key !== lookupKey || lookup.loading)) && !lookup.error
      && <p className="muted">Open or connect a conversation in this workstream to review its documents in chat.</p>}
  </section>;
}
