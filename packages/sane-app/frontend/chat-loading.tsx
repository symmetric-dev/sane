import { PenroseTriangle } from "./penrose-triangle";

/** Submission status ends at server acknowledgement, not at assistant output. */
export function PendingUserText({ text, sending }: { text: string; sending: boolean }) {
  return <><p className="user-text">{text}</p>{sending && <span className="user-submission-status" role="status"><span className="pulse" aria-hidden="true" />Sending…</span>}</>;
}

/** The composer activity lid supplies the loading text and live announcement. */
export function ConversationLoading() {
  return <div className="conversation-loading" aria-hidden="true">
    <span className="conversation-loading-mark" aria-hidden="true"><PenroseTriangle size={22} /></span>
    <div className="conversation-loading-lines" aria-hidden="true"><span /><span /><span /></div>
  </div>;
}
