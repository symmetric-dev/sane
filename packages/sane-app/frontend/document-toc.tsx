import { useEffect, useState, type ReactNode } from "react";
import { useChatFlowSidebarDismiss } from "./chat-flow-layout";
import { FiChevronDown, FiChevronRight, FiRefreshCw } from "react-icons/fi";
import type { WorkstreamDocument } from "../src/workstreams-contract";
import { reviewPhases, type ReviewPhase, type DocumentReviewController } from "./document-review-model";
import { documentOutline, type DocumentHeading } from "./document-outline";
import { workstreamRequest } from "./workstreams-client";

function Disclosure({ expanded, title, disabled, toggle }: { expanded: boolean; title: string; disabled?: boolean; toggle: () => void }) {
  return <button type="button" className="document-toc-disclosure" aria-label={`${expanded ? "Collapse" : "Expand"} ${title}`} aria-expanded={expanded} disabled={disabled} onClick={toggle}>{expanded ? <FiChevronDown aria-hidden="true" /> : <FiChevronRight aria-hidden="true" />}</button>;
}

function HeadingList({ headings, path, review }: { headings: DocumentHeading[]; path: string; review: DocumentReviewController }) {
  const dismiss = useChatFlowSidebarDismiss();
  const flow = review.flow!;
  const disabled = !review.active || flow.busy || flow.loading;
  return <>{headings.map(heading => {
    const key = JSON.stringify(["heading", path, heading.fragment]);
    const expanded = review.tocExpanded[key] ?? heading.level === 1;
    return <li key={heading.fragment}>
      <div className="document-toc-row">
        {heading.children.length > 0 ? <Disclosure expanded={expanded} title={heading.text} disabled={disabled} toggle={() => review.setTocExpanded(value => ({ ...value, [key]: !expanded }))} /> : <span className="document-toc-spacer" />}
        <button type="button" className="document-toc-link" disabled={disabled} aria-current={flow.path === path ? flow.fragment === heading.fragment ? "location" : !flow.fragment && heading.level === 1 && heading === headings[0] ? "page" : undefined : undefined} onClick={() => { review.navigate(path, heading.fragment); dismiss?.(); }}>{heading.text || "Untitled section"}</button>
      </div>
      {expanded && heading.children.length > 0 && <ul><HeadingList headings={heading.children} path={path} review={review} /></ul>}
    </li>;
  })}</>;
}

function DocumentBranch({ document, review }: { document: WorkstreamDocument; review: DocumentReviewController }) {
  const dismiss = useChatFlowSidebarDismiss();
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
    if (!document.exists || !review.active) return;
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
  }, [document.exists, cacheKey, content, review.active, identity, document.path, cache, attempt]);
  // Each file contributes only its Markdown headings: no extra file/title level.
  if (!document.exists) return <li className="document-toc-notice">A registered document is missing.</li>;
  if (headings?.length) return <HeadingList headings={headings} path={document.path} review={review} />;
  if (headings) return <li><button type="button" className="document-toc-link" disabled={disabled} onClick={() => { review.navigate(document.path); dismiss?.(); }}>Document without headings</button></li>;
  if (error) return <li className="document-toc-notice" role="alert">Couldn't load document headings. <button type="button" className="text-button" disabled={disabled} onClick={() => setAttempt(value => value + 1)}>Retry</button></li>;
  return <li className="document-toc-notice" role="status">Loading headings…</li>;
}

const titleCase = (slug: string) => slug.replace(/[-_]+/g, " ").replace(/\b\w/g, letter => letter.toUpperCase());

function TocGroup({ scope, title, subtitle, review, children }: { scope: string[]; title: string; subtitle?: string; review: DocumentReviewController; children: ReactNode }) {
  const key = JSON.stringify(scope);
  const expanded = review.tocExpanded[key] ?? true;
  const disabled = !review.active || review.flow!.busy || review.flow!.loading;
  const toggle = () => review.setTocExpanded(value => ({ ...value, [key]: !expanded }));
  return <li className="document-toc-directory">
    <div className="document-toc-row">
      <Disclosure expanded={expanded} title={title} disabled={disabled} toggle={toggle} />
      <button type="button" className="document-toc-link document-toc-directory-label" aria-expanded={expanded} disabled={disabled} onClick={toggle}>{title}{subtitle && <span className="document-toc-topic-path">{subtitle}</span>}</button>
    </div>
    {expanded && <ul>{children}</ul>}
  </li>;
}

function ResearchTopics({ documents, review }: { documents: WorkstreamDocument[]; review: DocumentReviewController }) {
  const topics = new Map<string, WorkstreamDocument[]>();
  for (const document of documents) {
    const parts = document.path.split("/");
    const topic = parts[0] === "research" && parts.length > 2 ? parts.slice(0, 2).join("/") : "";
    topics.set(topic, [...(topics.get(topic) ?? []), document]);
  }
  return <>{[...topics].map(([topic, documents]) => topic
    ? <TocGroup key={topic} scope={["directory", topic]} title={titleCase(topic.slice("research/".length))} subtitle={topic} review={review}>{documents.map(document => <DocumentBranch key={document.path} document={document} review={review} />)}</TocGroup>
    : documents.map(document => <DocumentBranch key={document.path} document={document} review={review} />))}</>;
}

export function DocumentToc({ review }: { review: DocumentReviewController }) {
  const flow = review.flow!;
  const documents = review.filteredDocuments;
  const disabled = !review.active || flow.busy || flow.loading;
  return <section className="document-toc">
    <div className="document-toc-filters">
      <label>Phase<select value={flow.phase} disabled={disabled} onChange={event => review.phase(event.target.value as ReviewPhase)}><option value="all">All phases</option>{reviewPhases.map(phase => <option key={phase} value={phase}>{titleCase(phase)}</option>)}</select></label>
      <label>Search documents<input type="search" value={flow.search} disabled={disabled} placeholder="Search documents" onChange={event => review.search(event.target.value)} /></label>
    </div>
    <div className="document-toc-toolbar"><h2>Contents</h2><button type="button" className="text-button" aria-label="Refresh table of contents" title="Refresh documents and headings" disabled={disabled || flow.reading} onClick={() => void review.refresh()}><FiRefreshCw aria-hidden="true" /></button></div>
    <nav aria-label="Document table of contents">
      {flow.loading && <p className="document-toc-notice" role="status">Loading documents…</p>}
      {flow.error && <p className="document-toc-notice" role="alert">{flow.error}</p>}
      {!flow.loading && !flow.error && !documents.length && <p className="document-toc-notice" role="status">{flow.search.trim() ? "No documents match your search." : flow.phase === "all" ? "No documents available." : "No documents in this phase."}</p>}
      <ul>{reviewPhases.map(phase => {
        const phaseDocuments = documents.filter(document => document.phase === phase);
        if (!phaseDocuments.length) return null;
        return <TocGroup key={phase} scope={["phase", phase]} title={titleCase(phase)} review={review}>
          {phase === "research" ? <ResearchTopics documents={phaseDocuments} review={review} /> : phaseDocuments.map(document => <DocumentBranch key={document.path} document={document} review={review} />)}
        </TocGroup>;
      })}</ul>
    </nav>
  </section>;
}
