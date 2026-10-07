import { useEffect, useId, useState } from "react";
import { FiChevronDown, FiChevronRight, FiRefreshCw } from "react-icons/fi";
import type { WorkstreamDocument } from "../src/workstreams-contract";
import type { DocumentReviewController } from "./document-review-model";
import { documentOutline, type DocumentHeading } from "./document-outline";
import { workstreamRequest } from "./workstreams-client";

function Disclosure({ expanded, title, disabled, toggle }: { expanded: boolean; title: string; disabled?: boolean; toggle: () => void }) {
  return <button type="button" className="document-toc-disclosure" aria-label={`${expanded ? "Collapse" : "Expand"} ${title}`} aria-expanded={expanded} disabled={disabled} onClick={toggle}>{expanded ? <FiChevronDown aria-hidden="true" /> : <FiChevronRight aria-hidden="true" />}</button>;
}

function HeadingList({ headings, path, review }: { headings: DocumentHeading[]; path: string; review: DocumentReviewController }) {
  const flow = review.flow!;
  const disabled = !review.active || flow.busy || flow.loading;
  return <>{headings.map(heading => {
    const key = JSON.stringify(["heading", path, heading.fragment]);
    const expanded = review.tocExpanded[key] ?? heading.level === 1;
    return <li key={heading.fragment}>
      <div className="document-toc-row">
        {heading.children.length > 0 ? <Disclosure expanded={expanded} title={heading.text} disabled={disabled} toggle={() => review.setTocExpanded(value => ({ ...value, [key]: !expanded }))} /> : <span className="document-toc-spacer" />}
        <button type="button" className="document-toc-link" disabled={disabled} aria-current={flow.path === path ? flow.fragment === heading.fragment ? "location" : !flow.fragment && heading.level === 1 && heading === headings[0] ? "page" : undefined : undefined} onClick={() => review.navigate(path, heading.fragment)}>{heading.text || "Untitled section"}</button>
      </div>
      {expanded && heading.children.length > 0 && <ul><HeadingList headings={heading.children} path={path} review={review} /></ul>}
    </li>;
  })}</>;
}

function DocumentBranch({ document, review }: { document: WorkstreamDocument; review: DocumentReviewController }) {
  const flow = review.flow!, identity = flow.identity;
  const cache = review.outlineCache.current;
  const cacheKey = JSON.stringify([identity.workspaceId, identity.repositoryId, identity.workstreamId, document.path, document.revision]);
  const entry = flow.entries[document.path];
  const content = entry?.readRevision === document.revision ? entry.content : undefined;
  const [result, setResult] = useState<{ key: string; headings?: DocumentHeading[]; error?: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const headings = cache.get(cacheKey) ?? (result?.key === cacheKey ? result.headings : undefined);
  const error = result?.key === cacheKey ? result.error : undefined;
  const disabled = !review.active || flow.busy || flow.loading;
  useEffect(() => {
    if (!review.tocVisible || !document.exists || !review.active) return;
    let current = true;
    setResult(null);
    // Outline reads never enter the review controller's read/decision state.
    if (content !== undefined) {
      const headings = documentOutline(content);
      cache.set(cacheKey, headings); setResult({ key: cacheKey, headings });
    } else if (!cache.has(cacheKey)) {
      void workstreamRequest<{ content: string; revision: string }>(identity.workspaceId, "artifacts/read", { id: identity.workstreamId, repositoryId: identity.repositoryId, path: document.path }).then(read => {
        if (!current) return;
        const headings = documentOutline(read.content);
        const actualKey = JSON.stringify([identity.workspaceId, identity.repositoryId, identity.workstreamId, document.path, read.revision]);
        cache.set(actualKey, headings);
        setResult({ key: cacheKey, headings });
      }).catch(error => { if (current) setResult({ key: cacheKey, error: error instanceof Error ? error.message : "Couldn't load headings." }); });
    }
    return () => { current = false; };
  }, [review.tocVisible, document.exists, cacheKey, content, review.active, identity, document.path, cache, attempt]);
  // Each file contributes only its Markdown headings: no extra file/title level.
  if (!document.exists) return <li className="document-toc-notice">A registered document is missing.</li>;
  if (headings?.length) return <HeadingList headings={headings} path={document.path} review={review} />;
  if (headings) return <li><button type="button" className="document-toc-link" disabled={disabled} onClick={() => review.navigate(document.path)}>Document without headings</button></li>;
  if (error) return <li className="document-toc-notice" role="alert">Couldn't load document headings. <button type="button" className="text-button" disabled={disabled} onClick={() => setAttempt(value => value + 1)}>Retry</button></li>;
  return <li className="document-toc-notice" role="status">Loading headings…</li>;
}

export function DocumentToc({ review }: { review: DocumentReviewController }) {
  const flow = review.flow!;
  const id = useId();
  const documents = flow.documents.filter(document => (flow.phase === "all" || document.phase === flow.phase) && !(document.path.startsWith("research/") && /(^|\/)README\.md$/i.test(document.path)));
  const disabled = !review.active || flow.busy || flow.loading;
  return <aside className={`document-toc${review.tocVisible ? " is-open" : ""}`}>
    <div className="document-toc-toolbar"><button type="button" className="text-button" aria-expanded={review.tocVisible} aria-controls={id} onClick={() => review.setTocVisible(value => !value)}>Contents</button>{review.tocVisible && <button type="button" className="text-button" aria-label="Refresh table of contents" title="Refresh documents and headings" disabled={disabled || flow.reading} onClick={() => void review.refresh()}><FiRefreshCw aria-hidden="true" /></button>}</div>
    <nav id={id} aria-label="Document table of contents" hidden={!review.tocVisible}>
      <ul>{documents.map(document => <DocumentBranch key={document.path} document={document} review={review} />)}</ul>
    </nav>
  </aside>;
}
