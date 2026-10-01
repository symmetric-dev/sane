import { FiZap } from "react-icons/fi";

/** Submission status ends at server acknowledgement, not at assistant output. */
export function PendingUserText({ text, sending }: { text: string; sending: boolean }) {
  return <><p className="user-text">{text}</p>{sending && <span className="user-submission-status" role="status"><span className="pulse" aria-hidden="true" />Sending…</span>}</>;
}

export function ConversationLoading({ label = "Opening conversation…" }: { label?: string }) {
  return <div className="conversation-loading" role="status">
    <span className="conversation-loading-mark" aria-hidden="true"><FiZap size={22} /></span>
    <p>{label}</p>
    <div className="conversation-loading-lines" aria-hidden="true"><span /><span /><span /></div>
  </div>;
}
