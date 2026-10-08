import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { FiArrowLeft, FiBookOpen, FiCheck, FiFileText, FiRefreshCw, FiX } from "react-icons/fi";
import { ChatInput } from "./chat-input";
import { DocumentMarkdown } from "./document-markdown";
import { reviewPhases, type DocumentReviewController } from "./document-review-model";
import "./document-review.css";

const label = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

export function DocumentReviewComposer({ review, disabled, active, navigation }: { review: DocumentReviewController; disabled: boolean; active: boolean; navigation?: ReactNode }) {
  const flow = review.flow!;
  const cancelButton = useRef<HTMLButtonElement>(null);
  const title = "Sane Review";
  const documents = review.filteredDocuments;
  const document = flow.documents.find(item => item.path === flow.path);
  const entry = document ? flow.entries[document.path] : undefined;
  const resource = document?.kind === "resource" || document?.phase === "resources";
  const blocked = !active || flow.busy;
  const decisionBlocked = blocked || flow.loading || flow.reading || !!flow.error || !entry?.readRevision;
  const count = flow.selected.filter(path => !!flow.entries[path]?.decision).length;
  // Launch/relaunch focus follows dialog cleanup; reader feedback keeps its autoFocus.
  useEffect(() => {
    if (!active || flow.busy || flow.path !== null) return;
    const target = cancelButton.current;
    if (target && !target.disabled && target.getClientRects().length) target.focus({ preventScroll: true });
  }, [flow.identity, active]);
  const status = (path: string) => {
    const entry = flow.entries[path];
    return entry?.changed ? "Changed · review again" : entry?.decision === "accepted" ? "Accepted" : entry?.decision === "needs-changes" ? "Needs changes" : entry?.feedback.trim() ? "Unsaved feedback" : "Not reviewed";
  };
  return <section className="document-review-composer" aria-label={title}>
    <header className="document-review-heading"><div><FiBookOpen size={16} aria-hidden="true" /><strong>{title}</strong></div><div>{!document && <button type="button" className="text-button" disabled={blocked || flow.loading} aria-label="Refresh documents" title="Refresh documents" onClick={() => void review.refresh()}><FiRefreshCw aria-hidden="true" /></button>}<button ref={cancelButton} type="button" className="text-button" disabled={blocked} onClick={() => review.cancel()} aria-label={`Cancel ${title}`}><FiX aria-hidden="true" />Cancel</button></div></header>
    <div className="document-review-body">
    {flow.error && <p className="document-review-notice error" role="alert">{flow.error} {!flow.unknown && <button type="button" className="text-button" disabled={blocked} onClick={() => document ? void review.open(document.path, flow.fragment) : void review.refresh()}>Retry</button>}</p>}
    {flow.unknown && <p className="document-review-notice"><button type="button" className="text-button" disabled={blocked} onClick={review.allowRetry}>I checked conversation history; allow retry</button></p>}
    {flow.confirmCancel && <div className="document-review-confirm" role="alert"><span>Discard this review’s decisions and feedback? Your normal chat draft will remain.</span><button type="button" disabled={blocked} onClick={() => review.cancel(true)}>Discard review</button><button type="button" disabled={blocked} onClick={review.dismissCancel}>Keep reviewing</button></div>}
    {document ? <>
      {resource ? <p className="document-review-notice">Reference document · browse only. No review decision is required.</p> : <ChatInput key={`${flow.identity.sessionId}:${document.path}`} autoFocus text={entry?.feedback ?? ""} save={review.edit} submit={() => review.decide("needs-changes")} disabled={blocked} className="composer-input" aria-label={`Feedback for ${document.title}`} placeholder="What needs to change? Feedback stays with this document…" />}
    </> : <>
      <div className="document-review-catalog" aria-busy={flow.loading}>
        {flow.loading ? <p className="muted" role="status">Loading workstream documents…</p> : reviewPhases.filter(phase => flow.phase === "all" || flow.phase === phase).map(phase => {
          const group = documents.filter(document => document.phase === phase);
          return group.length ? <section className="document-review-group" key={phase} aria-label={`${label(phase)} documents`}><h3>{label(phase)}{phase === "resources" && <span>Browse only</span>}</h3>{group.map(document => {
            const reference = document.kind === "resource" || phase === "resources";
            return <div className={`document-review-card${flow.entries[document.path]?.decision ? " is-decided" : ""}`} key={document.path}>
              {!reference && document.exists && <input type="checkbox" checked={flow.selected.includes(document.path)} disabled={blocked || flow.loading || document.required} aria-label={`Include ${document.title} in review${document.required ? " (required)" : ""}`} onChange={event => review.select(document.path, event.target.checked)} />}
              <button type="button" disabled={blocked || !document.exists} onClick={() => void review.open(document.path)}><FiFileText aria-hidden="true" /><span><strong>{document.title}</strong><small title={document.path}>{document.path}</small></span><span className="document-review-card-status">{!document.exists ? "Missing" : reference ? "Reference" : status(document.path)}</span></button>
            </div>;
          })}</section> : null;
        })}
        {!flow.loading && !documents.length && <p className="muted" role="status">No documents found in this scope.</p>}
      </div>
    </>}
    </div>
    {document ? <div className="document-review-toolbar"><div><button type="button" className="text-button" disabled={blocked} onClick={review.picker}><FiArrowLeft aria-hidden="true" />Documents</button><span className="document-review-status" role="status">{resource ? "Reference" : status(document.path)}</span></div><div>{!resource && <><button type="button" disabled={decisionBlocked} onClick={() => review.decide("accepted")}><FiCheck aria-hidden="true" />Accept document</button><button type="button" className="document-review-primary" disabled={decisionBlocked || !entry?.feedback.trim()} onClick={() => review.decide("needs-changes")}>Save feedback</button></>}{navigation}</div></div> : <div className="document-review-toolbar"><span className="document-review-status" role="status">{count} of {flow.selected.length} selected documents decided</span><div><button type="button" className="document-review-primary" disabled={blocked || disabled || !review.ready} onClick={() => void review.submit()}>{flow.busy ? "Sending review…" : "Send review"}</button>{navigation}</div></div>}
  </section>;
}

/** Reader owns scrolling; the transcript viewport remains mounted and untouched. */
export function DocumentReviewReader({ review }: { review: DocumentReviewController }) {
  const flow = review.flow!;
  const document = flow.documents.find(item => item.path === flow.path);
  const entry = flow.path ? flow.entries[flow.path] : undefined;
  const viewport = useRef<HTMLDivElement>(null);
  const positions = review.readerPositions;
  const key = JSON.stringify([flow.identity.sessionId, flow.identity.workspaceId, flow.identity.repositoryId, flow.identity.workstreamId, flow.path, entry?.readRevision]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || !review.active || flow.reading) return;
    element.scrollTop = positions.current.get(key) ?? 0;
  }, [key, review.active, flow.reading]);
  const openLink = (path: string, fragment?: string) => {
    if (flow.documents.some(item => item.path === path && item.exists)) review.navigate(path, fragment);
  };
  return <div className="document-review-reader" ref={viewport} tabIndex={0} aria-busy={flow.reading} aria-label={`Document reader: ${document?.title ?? flow.path}`} onScroll={event => { if (review.active && !flow.reading) positions.current.set(key, event.currentTarget.scrollTop); }}>
    <article className="document-review-paper"><header><p className="eyebrow">{document ? label(document.phase) : "Document"}</p>{entry?.changed && <p className="notice" role="status">This document changed. Read the new revision and decide again. Your feedback is preserved.</p>}</header>
      {flow.reading && <p role="status" className="muted">Opening document…</p>}
      {entry?.content !== undefined ? <DocumentMarkdown text={entry.content} path={flow.path!} fragment={flow.reading ? undefined : flow.fragment} navigation={flow.navigation} onOpenDocument={openLink} /> : !flow.reading && <p role={flow.error ? "alert" : "status"} className="muted">{flow.error || "Document not loaded."} <button type="button" className="text-button" disabled={flow.busy} onClick={() => void review.open(flow.path!, flow.fragment)}>Retry</button></p>}
    </article>
  </div>;
}
