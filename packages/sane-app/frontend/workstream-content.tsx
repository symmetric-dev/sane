import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { SUPPORTED_WORKSTREAM_TYPES, type CheckoutPin, type WorkstreamType } from "sane-core/contracts";
import type { WorktreeRecord } from "../src/catalog-contract";
import type { WorkstreamDocument, WorkstreamDocumentCatalog, WorkstreamDocumentPhase, WorkstreamOverview } from "../src/workstreams-contract";
import type { ArtifactSelection } from "./workstreams";
import { catalog } from "./catalog";
import { ShellDialog } from "./shell-dialog";
import { workstreamRequest } from "./workstreams-client";
import "./workstream-content.css";

type WorkstreamDetail = WorkstreamOverview["workstreams"][number];
type ContentFailure = { message: string; diagnostic?: string };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const basename = (path: string) => path.split("/").filter(Boolean).at(-1) || path;
const readable = (value: string) => value.replace(/_/g, " ");
const typeLabels: Record<WorkstreamType, string> = { feature: "Feature", foundation: "Foundation", issue: "Issue", maintenance: "Maintenance" };
const fileLabels: Record<string, string> = {
  "README.md": "Workstream overview", "PRD.md": "Product requirements", "FOUNDATION.md": "Foundation brief",
  "ISSUE.md": "Issue brief", "MAINTENANCE.md": "Maintenance brief", "SDD.md": "Software design",
  "PLAN.md": "Execution plan", "FINAL_REPORT.md": "Final report", "SOLUTION.md": "Solution specification",
  "VERIFICATION.md": "Verification specification", "SDD_TEMPLATE.md": "Software design template",
  "SOLUTION_SPEC_TEMPLATE.md": "Solution specification template", "RESEARCH_REPORT_TEMPLATE.md": "Research report template",
  "PLAN_TEMPLATE.md": "Execution plan template", "JOB_TEMPLATE.md": "Job specification template",
  "VERIFICATION_SPEC_TEMPLATE.md": "Verification specification template", "EXECUTION_REPORT_TEMPLATE.md": "Job report template",
  "EXECUTION_FINAL_REPORT_TEMPLATE.md": "Final report template", "TEST_REPORT_TEMPLATE.md": "Test report template",
};
const fileLabel = (path: string) => fileLabels[basename(path)] ?? basename(path);
const topicLabel = (topic: string) => {
  const label = topic.replace(/[-_]+/g, " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
};
const documentLabel = (path: string, topics: string[] = []) => {
  const topic = basename(path) === "REPORT.md" ? /^research\/([^/]+)\//.exec(path)?.[1] : undefined;
  return topics.length ? topics.map(topicLabel).join(", ") : topic ? topicLabel(topic) : fileLabel(path);
};

function ContentError({ failure, retry, retryLabel = "Retry", busy = false }: { failure: ContentFailure; retry?: () => void; retryLabel?: string; busy?: boolean }) {
  return <div className="workstream-content-error">
    <p role="alert">{failure.message}</p>
    {retry && <button type="button" className="text-button" disabled={busy} onClick={retry}>{retryLabel}</button>}
    {failure.diagnostic && <details><summary>Technical details</summary><pre>{failure.diagnostic}</pre></details>}
  </div>;
}

/** The epoch also rejects an old completion across a StrictMode effect remount. */
function useCompletionGuard() {
  const guard = useRef({ mounted: true, epoch: 0 });
  useEffect(() => {
    guard.current.mounted = true;
    return () => { guard.current.mounted = false; guard.current.epoch++; };
  }, []);
  return guard;
}

export function WorkstreamDocuments({ workspaceId, detail, openArtifact }: { workspaceId: string; detail: WorkstreamDetail; openArtifact?: (artifact: ArtifactSelection) => void }) {
  const [result, setResult] = useState<{ scope: string; documents: WorkstreamDocument[]; loading: boolean; failure: ContentFailure | null }>({ scope: "", documents: [], loading: true, failure: null });
  const [retry, setRetry] = useState(0);
  const { repositoryId, id: workstreamId } = detail.workstream;
  const scope = JSON.stringify([workspaceId, repositoryId, workstreamId]);
  useEffect(() => {
    let current = true;
    setResult({ scope, documents: [], loading: true, failure: null });
    void workstreamRequest<WorkstreamDocumentCatalog>(workspaceId, "artifacts/catalog", { id: workstreamId, repositoryId }).then(catalog => {
      if (catalog.repositoryId !== repositoryId || catalog.workstreamId !== workstreamId) throw new Error("The document catalog does not match the selected workstream.");
      if (current) setResult({ scope, documents: catalog.documents, loading: false, failure: null });
    }).catch(error => {
      if (current) setResult({ scope, documents: [], loading: false, failure: { message: "Documents couldn't be loaded. Try again; the repository files have not been changed.", diagnostic: errorText(error) } });
    });
    return () => { current = false; };
  }, [scope, workspaceId, repositoryId, workstreamId, detail, retry]);
  const documents = result.scope === scope ? result.documents : [];
  const loading = result.scope !== scope || result.loading;
  const failure = result.scope === scope ? result.failure : null;
  const phases: { phase: WorkstreamDocumentPhase; title: string }[] = [
    { phase: "design", title: "Design" }, { phase: "engineering", title: "Engineering" },
    { phase: "planning", title: "Planning" }, { phase: "execution", title: "Execution" },
    { phase: "research", title: "Research" }, { phase: "resources", title: "Resources" },
  ];
  const missingCount = detail.research.registered.filter(report => report.missing).length;
  const modifiedCount = detail.research.registered.filter(report => report.modified).length;
  const warningCounts = [missingCount && `${missingCount} missing`, modifiedCount && `${modifiedCount} modified`, detail.research.unregistered.length && `${detail.research.unregistered.length} unregistered`].filter(Boolean).join(" · ");
  const hasWarnings = !!(warningCounts || detail.research.warnings.length);
  const list = (files: WorkstreamDocument[]) => <ul className="workstream-document-list">{files.map(document => {
    const { path } = document;
    const registered = detail.research.registered.filter(report => report.reportPath === path);
    const missing = !document.exists || registered.some(report => report.missing);
    const modified = registered.some(report => report.modified);
    const unregistered = detail.research.unregistered.includes(path);
    const label = registered.length ? documentLabel(path, registered.map(report => report.topic)) : document.title;
    return <li key={path} className={missing ? "workstream-document-missing" : undefined}>
      <div className="workstream-document-row"><span className="workstream-document-name">{label}</span>
        {document.kind === "supporting" && <span className="workstream-content-badge">Supporting</span>}
        {missing && <span className="workstream-content-badge warning">Missing</span>}
        {modified && <span className="workstream-content-badge warning">Modified</span>}
        {unregistered && <span className="workstream-content-badge warning">Unregistered</span>}
        {!missing && <button type="button" className="text-button" disabled={!openArtifact} aria-label={`Read ${label}`} onClick={() => openArtifact?.({ workspaceId, workstreamId, repositoryId, path })}>Read</button>}
      </div>
      {missing && <p className="workstream-document-expected">{document.required ? "Expected document · not created yet or unavailable." : "This document is unavailable."}</p>}
      <details className="workstream-document-diagnostics"><summary>File details</summary><p className="workstream-content-path">{path}</p>
        <dl className="workstream-content-facts"><dt>Document role</dt><dd>{document.kind}</dd><dt>Required</dt><dd>{document.required ? "Yes" : "No"}</dd><dt>Revision</dt><dd>{document.revision ?? "Not available"}</dd></dl>
        {registered.map(report => <dl className="workstream-content-facts" key={report.topic}><dt>Research topic</dt><dd>{report.topic}</dd><dt>Registered</dt><dd>{report.createdAt}</dd><dt>Updated</dt><dd>{report.updatedAt}</dd><dt>Registered content hash</dt><dd>{report.contentHash}</dd></dl>)}
      </details>
    </li>;
  })}</ul>;
  return <section className="workstream-content workstream-documents" aria-label="Workstream documents">
    <header className="workstream-content-heading"><h3>Documents</h3><span className="muted">Read only</span></header>
    {loading && <p role="status">Loading documents…</p>}
    {failure && <ContentError failure={failure} retry={() => setRetry(value => value + 1)} />}
    {hasWarnings && <div className="workstream-research-warning" role="status"><p><strong>Research needs attention.</strong> {warningCounts || `${detail.research.warnings.length} research warnings`}</p><details><summary>Research warning details</summary>
      {detail.research.warnings.length > 0 && <ul>{detail.research.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      {detail.research.registered.filter(report => report.missing || report.modified).map(report => <p key={report.topic}>{documentLabel(report.reportPath, [report.topic])}: {[report.missing && "Missing", report.modified && "Modified"].filter(Boolean).join(" · ")}</p>)}
      {detail.research.unregistered.map(path => <p key={path}>{documentLabel(path)}: Unregistered</p>)}
    </details></div>}
    {!openArtifact && documents.length > 0 && <p className="muted">Document navigation is unavailable in this view.</p>}
    {phases.map(({ phase, title }) => {
      const files = documents.filter(document => document.phase === phase);
      return <section className="workstream-document-group" aria-label={`${title} documents`} key={phase}><h4>{title}</h4>{files.length ? list(files) : !loading && !failure && <p className="muted">No {title.toLowerCase()} documents yet.</p>}</section>;
    })}
  </section>;
}

function checkoutLabel(tree: WorktreeRecord) {
  const branch = tree.branch?.replace(/^refs\/heads\//, "") || (tree.detached ? "Detached HEAD" : basename(tree.root));
  return tree.alias ? `${tree.alias}${branch !== tree.alias ? ` · ${branch}` : ""}` : branch;
}
function useCheckoutCatalog(workspaceId: string) {
  const state = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  return { trees: state.workspaces.find(workspace => workspace.workspaceId === workspaceId)?.worktrees ?? [], loading: state.loading, error: state.error };
}
type CheckoutDraft = { choice: string; path: string };
const customCheckout = "__absolute_path__";
function checkoutDraft(path: string | null | undefined, trees: WorktreeRecord[]): CheckoutDraft {
  return { choice: path ? trees.some(tree => tree.root === path && tree.state === "available") ? path : customCheckout : "", path: path ?? "" };
}
function checkoutValue(draft: CheckoutDraft, trees: WorktreeRecord[]) {
  if (!draft.choice) return null;
  if (draft.choice === customCheckout) {
    const path = draft.path.trim();
    if (!path.startsWith("/") || /[\u0000-\u001f\u007f]/.test(path)) throw new Error("Enter a valid absolute checkout path starting with /, or choose no default checkout.");
    return path;
  }
  if (!trees.some(tree => tree.root === draft.choice && tree.state === "available")) throw new Error("That checkout is no longer available. Choose another checkout or enter an absolute path.");
  return draft.choice;
}
function CheckoutPicker({ draft, setDraft, trees, busy }: { draft: CheckoutDraft; setDraft: (draft: CheckoutDraft) => void; trees: WorktreeRecord[]; busy: boolean }) {
  const hintId = useId();
  const available = trees.filter(tree => tree.state === "available");
  return <div className="workstream-checkout-picker">
    <label>Default working checkout<select value={draft.choice} disabled={busy} aria-describedby={hintId} onChange={event => setDraft({ ...draft, choice: event.target.value })}>
      <option value="">No default checkout</option>
      {available.map(tree => <option key={tree.worktreeId} value={tree.root}>{checkoutLabel(tree)}</option>)}
      {draft.choice && draft.choice !== customCheckout && !available.some(tree => tree.root === draft.choice) && <option value={draft.choice} disabled>Selected checkout unavailable</option>}
      <option value={customCheckout}>Enter an absolute path (advanced)</option>
    </select></label>
    <p id={hintId} className="muted">Used for new conversations. Existing conversations keep their pinned checkouts and never move.</p>
    {draft.choice === customCheckout && <details className="workstream-content-disclosure" open><summary>Advanced checkout path</summary><label>Absolute checkout path<input value={draft.path} disabled={busy} placeholder="/absolute/path/to/checkout" onChange={event => setDraft({ ...draft, path: event.target.value })} /></label></details>}
    {!available.length && <p className="muted">No available checkouts are listed. You can enter an absolute path; the repository will validate it.</p>}
  </div>;
}

function PinFacts({ pin }: { pin: CheckoutPin }) {
  return <dl className="workstream-content-facts"><dt>Checkout path</dt><dd>{pin.path}</dd><dt>Git directory</dt><dd>{pin.gitDir}</dd><dt>Common Git directory</dt><dd>{pin.commonDir}</dd><dt>Checkout device / inode</dt><dd>{pin.device} / {pin.inode}</dd><dt>Git device / inode</dt><dd>{pin.gitDevice} / {pin.gitInode}</dd><dt>Common device / inode</dt><dd>{pin.commonDevice} / {pin.commonInode}</dd></dl>;
}

export function WorkstreamDetails(props: { workspaceId: string; detail: WorkstreamDetail; close: () => void; onChanged: () => Promise<void> }) {
  return <WorkstreamDetailsDialog key={`${props.workspaceId}:${props.detail.workstream.id}`} {...props} />;
}
function WorkstreamDetailsDialog({ workspaceId, detail, close, onChanged }: { workspaceId: string; detail: WorkstreamDetail; close: () => void; onChanged: () => Promise<void> }) {
  const { trees, loading: catalogLoading, error: catalogError } = useCheckoutCatalog(workspaceId);
  const { workstream, conversations, phaseHistory, activePhases } = detail;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => checkoutDraft(workstream.defaultCheckout?.path, trees));
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<ContentFailure | null>(null), [notice, setNotice] = useState("");
  const [refreshPending, setRefreshPending] = useState(false);
  const saved = useRef(false), locked = useRef(false), guard = useCompletionGuard();
  const defaultPath = workstream.defaultCheckout?.path;
  const tree = trees.find(item => item.root === defaultPath);
  const dismiss = () => { if (!locked.current) close(); };
  async function save() {
    if (locked.current) return;
    let checkout: string | null = null;
    if (!saved.current) {
      try { checkout = checkoutValue(draft, trees); }
      catch (error) { setFailure({ message: errorText(error) }); return; }
    }
    locked.current = true;
    setBusy(true); setFailure(null); setNotice("");
    const epoch = guard.current.epoch;
    const current = () => guard.current.mounted && guard.current.epoch === epoch;
    try {
      if (!saved.current) {
        await workstreamRequest(workspaceId, "default-checkout", { id: workstream.id, checkout });
        if (!current()) return;
        saved.current = true;
      }
      await onChanged();
      if (!current()) return;
      saved.current = false; setRefreshPending(false); setEditing(false);
      setNotice("Default working checkout saved. Existing conversations are unchanged.");
    } catch (error) {
      if (current()) {
        setRefreshPending(saved.current);
        setFailure({ message: saved.current ? "The checkout was saved, but the workstream view couldn't refresh. Retry refresh without saving again." : "The default checkout couldn't be saved. Check that it belongs to this repository and try again.", diagnostic: errorText(error) });
      }
    } finally {
      locked.current = false;
      if (current()) setBusy(false);
    }
  }
  const lifecycle = workstream.lifecycle;
  return <ShellDialog title="Workstream details" className="workstream-content-dialog" close={dismiss} closeDisabled={busy}>
    <div className="workstream-content workstream-detail-content" aria-busy={busy}>
      <h3>{workstream.title}</h3>
      <dl className="workstream-content-facts"><dt>Identifier</dt><dd>{workstream.id}</dd><dt>Type</dt><dd>{typeLabels[workstream.type] ?? "Not set"}</dd><dt>Repository UUID</dt><dd>{workstream.repositoryId}</dd><dt>Created</dt><dd>{workstream.createdAt}</dd><dt>Updated</dt><dd>{workstream.updatedAt}</dd><dt>Revision</dt><dd>{workstream.revision}</dd></dl>
      <section className="workstream-default-checkout"><h4>Default working checkout</h4>
        <p>{defaultPath ? tree ? `${checkoutLabel(tree)}${tree.state !== "available" ? " (unavailable)" : ""}` : basename(defaultPath) : "Not set"}</p>
        {defaultPath && <details><summary>Pinned checkout details</summary><PinFacts pin={workstream.defaultCheckout!} /></details>}
        <p className="muted">Used for new conversations. Existing conversations keep their pinned checkouts and never move.</p>
        {!editing ? <button type="button" className="text-button" onClick={() => { setDraft(checkoutDraft(defaultPath, trees)); setFailure(null); setNotice(""); setEditing(true); }}>Change default checkout…</button> : <form className="workstream-content-form" onSubmit={event => { event.preventDefault(); void save(); }}>
          <fieldset disabled={busy || refreshPending}><CheckoutPicker draft={draft} setDraft={setDraft} trees={trees} busy={busy || refreshPending} /></fieldset>
          {catalogLoading && <p role="status" className="muted">Loading available checkouts…</p>}
          {catalogError && <ContentError failure={{ message: "The checkout catalog is unavailable. You can still enter an absolute path.", diagnostic: catalogError }} />}
          <div className="workstream-content-actions">
            <button type="button" className="text-button" disabled={busy || refreshPending} onClick={() => { setEditing(false); setFailure(null); }}>Cancel change</button>
            {draft.choice && <button type="button" className="text-button" disabled={busy || refreshPending} onClick={() => setDraft({ choice: "", path: "" })}>Clear default</button>}
            <button type="submit" className="primary-button" disabled={busy}>{busy ? refreshPending ? "Refreshing…" : "Saving…" : refreshPending ? "Retry refresh" : "Save default checkout"}</button>
          </div>
        </form>}
      </section>
      {failure && <ContentError failure={failure} />}
      {notice && <p role="status">{notice}</p>}
      <details className="workstream-content-disclosure"><summary>Document lifecycle · {readable(lifecycle.status)}</summary>
        <p className="muted">Document progress and approval evidence are separate from conversation phase assignments. These records are read only here.</p>
        <ul className="workstream-detail-list">{lifecycle.phases.map(phase => <li key={phase.phase}><strong>{readable(phase.phase)}</strong><dl className="workstream-content-facts"><dt>Status</dt><dd>{readable(phase.status)}</dd><dt>Owner role</dt><dd>{phase.owner_role}</dd><dt>Approval reference</dt><dd>{phase.approval_ref ?? "None recorded"}</dd></dl></li>)}</ul>
        <details><summary>Approval evidence · {lifecycle.approvals.length}</summary>{!lifecycle.approvals.length && <p>No approvals recorded.</p>}<ul className="workstream-detail-list">{lifecycle.approvals.map(approval => <li key={approval.id}><dl className="workstream-content-facts"><dt>Phase</dt><dd>{approval.phase}</dd><dt>Reference</dt><dd>{approval.approval_ref}</dd><dt>Approved</dt><dd>{approval.approved_at}</dd><dt>Approval ID</dt><dd>{approval.id}</dd><dt>Artifact path</dt><dd>{approval.artifact_path}</dd><dt>Snapshot hash</dt><dd>{approval.sane_hash}</dd><dt>Files</dt><dd>{approval.files.map(file => <div key={file}>{file}</div>)}</dd></dl></li>)}</ul></details>
      </details>
      <details className="workstream-content-disclosure"><summary>Jobs · {lifecycle.jobs.length}</summary>
        {!lifecycle.jobs.length && <p>No jobs registered.</p>}<ul className="workstream-detail-list">{lifecycle.jobs.map(job => <li key={job.job_id}><strong>{job.job_id}</strong><dl className="workstream-content-facts"><dt>Status</dt><dd>{job.status}</dd><dt>Specification path</dt><dd>{job.spec_path}</dd><dt>Report path</dt><dd>{job.report_path ?? "Not recorded"}</dd><dt>Updated</dt><dd>{job.updated_at}</dd></dl></li>)}</ul>
      </details>
      <details className="workstream-content-disclosure"><summary>Conversation phases and history · {phaseHistory.length}</summary>
        <p>{activePhases.length} active assignment{activePhases.length === 1 ? "" : "s"}. Conversation assignments do not imply document approval.</p>
        {!phaseHistory.length && <p>No phase assignments recorded.</p>}<ul className="workstream-detail-list">{phaseHistory.map(assignment => <li key={assignment.id}><strong>{assignment.phase}</strong><dl className="workstream-content-facts"><dt>Harness</dt><dd>{assignment.ref.harness === "cc" ? "Claude Code" : "OpenCode"}</dd><dt>Native authority</dt><dd>{assignment.ref.authorityId}</dd><dt>Native conversation</dt><dd>{assignment.ref.nativeId}</dd><dt>Assignment ID</dt><dd>{assignment.id}</dd><dt>Membership ID</dt><dd>{assignment.membershipId}</dd><dt>Started</dt><dd>{assignment.startedAt}</dd><dt>Ended</dt><dd>{assignment.endedAt ?? "Still active"}</dd></dl></li>)}</ul>
      </details>
      <details className="workstream-content-disclosure"><summary>Native conversations and pinned checkouts · {conversations.length}</summary>
        {!conversations.length && <p>No enrolled member conversations.</p>}<ul className="workstream-detail-list">{conversations.map(conversation => <li key={conversation.id}><dl className="workstream-content-facts"><dt>Harness</dt><dd>{conversation.ref.harness === "cc" ? "Claude Code" : "OpenCode"}</dd><dt>Native authority</dt><dd>{conversation.ref.authorityId}</dd><dt>Native conversation</dt><dd>{conversation.ref.nativeId}</dd><dt>Domain conversation ID</dt><dd>{conversation.id}</dd><dt>Enrolled</dt><dd>{conversation.createdAt}</dd>{conversation.parent && <><dt>Parent native identity</dt><dd>{conversation.parent.harness} · {conversation.parent.authorityId} · {conversation.parent.nativeId}</dd></>}</dl><PinFacts pin={conversation.executionCheckout} /></li>)}</ul>
      </details>
      <details className="workstream-content-disclosure"><summary>Lifecycle history · {lifecycle.mutations.length}</summary>
        {!lifecycle.mutations.length && <p>No lifecycle changes recorded.</p>}<ul className="workstream-detail-list">{lifecycle.mutations.map((mutation, index) => <li key={`${mutation.correlationId}:${index}`}><dl className="workstream-content-facts"><dt>Operation</dt><dd>{mutation.operation}</dd><dt>Timestamp</dt><dd>{mutation.timestamp}</dd><dt>Actor</dt><dd>{mutation.actor.kind}{mutation.actor.kind === "native" && <> · {mutation.actor.ref.harness} · {mutation.actor.ref.authorityId} · {mutation.actor.ref.nativeId}</>}</dd><dt>Correlation ID</dt><dd>{mutation.correlationId}</dd></dl></li>)}</ul>
      </details>
    </div>
  </ShellDialog>;
}

function titleSlug(title: string) {
  return title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96).replace(/-+$/g, "") || (title.trim() ? "workstream" : "");
}
export function CreateWorkstreamDialog(props: { workspaceId: string; close: () => void; onCreated: (id: string) => Promise<void> }) {
  return <CreateWorkstreamForm key={props.workspaceId} {...props} />;
}
function CreateWorkstreamForm({ workspaceId, close, onCreated }: { workspaceId: string; close: () => void; onCreated: (id: string) => Promise<void> }) {
  const { trees, loading: catalogLoading, error: catalogError } = useCheckoutCatalog(workspaceId);
  const [title, setTitle] = useState(""), [type, setType] = useState<WorkstreamType | "">("");
  const [identifier, setIdentifier] = useState(""), [customIdentifier, setCustomIdentifier] = useState(false), [advanced, setAdvanced] = useState(false);
  const [draft, setDraft] = useState<CheckoutDraft>({ choice: "", path: "" });
  const [busy, setBusy] = useState(false), [createdId, setCreatedId] = useState<string | null>(null), [failure, setFailure] = useState<ContentFailure | null>(null);
  const locked = useRef(false), created = useRef<string | null>(null), guard = useCompletionGuard();
  const identifierHintId = useId();
  const id = customIdentifier ? identifier : titleSlug(title);
  const dismiss = () => { if (!locked.current) close(); };
  async function submit() {
    if (locked.current) return;
    let checkout: string | null = null;
    if (!created.current) {
      if (!title.trim()) { setFailure({ message: "Enter a workstream title." }); return; }
      if (!type || !SUPPORTED_WORKSTREAM_TYPES.includes(type)) { setFailure({ message: "Choose a workstream type." }); return; }
      if (!/^[a-z0-9][a-z0-9_-]{0,95}$/.test(id)) { setAdvanced(true); setFailure({ message: "The identifier must be 1–96 lowercase letters, numbers, hyphens or underscores, starting with a letter or number. Edit it in Advanced options." }); return; }
      try { checkout = checkoutValue(draft, trees); }
      catch (error) { setAdvanced(true); setFailure({ message: errorText(error) }); return; }
    }
    locked.current = true; setBusy(true); setFailure(null);
    const epoch = guard.current.epoch;
    const current = () => guard.current.mounted && guard.current.epoch === epoch;
    try {
      if (!created.current) {
        await workstreamRequest(workspaceId, "", { id, title: title.trim(), type, ...(checkout ? { defaultCheckout: checkout } : {}) });
        if (!current()) return;
        created.current = id; setCreatedId(id);
      }
      const completedId = created.current;
      if (!completedId || !current()) return;
      await onCreated(completedId);
      if (current()) close();
    } catch (error) {
      if (current()) {
        const diagnostic = errorText(error);
        const conflict = /already exists|conflict|orphan|existing artifact|destination/i.test(diagnostic);
        if (conflict && !created.current) setAdvanced(true);
        setFailure({ message: created.current ? "The workstream was created, but the view couldn't refresh. Retry opening it; another workstream will not be created." : conflict ? "This identifier is already in use, or its document folder already exists. Choose a different identifier in Advanced options. Your entries have been kept." : "Creation couldn't be confirmed. Your entries have been kept. Check the checkout and connection; refresh workstreams before retrying if the connection was interrupted.", diagnostic });
      }
    } finally {
      locked.current = false;
      if (current()) setBusy(false);
    }
  }
  return <ShellDialog title="New workstream" className="workstream-content-dialog" close={dismiss} closeDisabled={busy}>
    <form className="workstream-content workstream-content-form" aria-busy={busy} onSubmit={event => { event.preventDefault(); void submit(); }}>
      <fieldset disabled={busy || !!createdId}>
        <label>Title<input autoFocus required value={title} onChange={event => setTitle(event.target.value)} placeholder="What are you working on?" /></label>
        <label>Type<select required value={type} onChange={event => setType(event.target.value as WorkstreamType | "")}><option value="" disabled>Choose a type</option>{SUPPORTED_WORKSTREAM_TYPES.map(value => <option key={value} value={value}>{typeLabels[value]}</option>)}</select></label>
        <details className="workstream-content-disclosure" open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}><summary>Advanced options</summary>
          <label>Identifier<input value={id} aria-describedby={identifierHintId} onChange={event => { setIdentifier(event.target.value); setCustomIdentifier(true); }} /></label>
          <p id={identifierHintId} className="muted">Generated from the title. This identifier cannot be renamed after creation. Use 1–96 lowercase letters, numbers, hyphens or underscores; start with a letter or number.</p>
          {customIdentifier && <button type="button" className="text-button" onClick={() => setCustomIdentifier(false)}>Generate from title again</button>}
          <CheckoutPicker draft={draft} setDraft={setDraft} trees={trees} busy={busy || !!createdId} />
          {catalogLoading && <p role="status" className="muted">Loading available checkouts…</p>}
          {catalogError && <ContentError failure={{ message: "The checkout catalog is unavailable. You can omit the default or enter an absolute path.", diagnostic: catalogError }} />}
        </details>
      </fieldset>
      {failure && <ContentError failure={failure} />}
      {createdId && <p role="status">Workstream created. Finishing refresh and selection…</p>}
      <div className="workstream-content-actions"><button type="button" className="text-button" disabled={busy} onClick={dismiss}>Cancel</button><button type="submit" className="primary-button" disabled={busy}>{busy ? createdId ? "Opening workstream…" : "Creating…" : createdId ? "Retry opening workstream" : "Create workstream"}</button></div>
    </form>
  </ShellDialog>;
}
