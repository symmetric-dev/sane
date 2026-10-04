import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { WorkstreamOverview } from "../src/workstreams-contract";
import { workstreamRequest } from "./workstreams-client";
import { refreshWorkstreamOverview, useWorkstreamOverviewState } from "./workstream-overview";
import { subscribeWorkspace, workspaceEpoch } from "./workspace-store";
import { catalog } from "./catalog";
import { WorkstreamConversations } from "./workstream-conversations";
import { CreateWorkstreamDialog, WorkstreamDetails, WorkstreamDocuments } from "./workstream-content";
import { WorkstreamActionsDialog } from "./workstream-actions";
import { WorkstreamReviewEntry } from "./workstream-review-entry";
import type { DocumentReviewLaunch } from "./document-review-launch";
import "./workstreams.css";

export type ArtifactSelection = { workspaceId: string; workstreamId: string; path: string; repositoryId: string };
type WorkstreamsProps = {
  workspaceId: string | null;
  openArtifact?: (artifact: ArtifactSelection) => void;
  openConversation?: (id: string) => void;
  startDocumentReview?: (launch: DocumentReviewLaunch) => void;
  disabled?: boolean;
};
export function WorkstreamsView({ workspaceId, openArtifact, openConversation, startDocumentReview, disabled = false }: WorkstreamsProps) {
  const { workspaces } = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const workspace = workspaces.find(item => item.workspaceId === workspaceId);
  if (!workspaceId) return <section className="workspace-empty"><h2>Select a repository workspace</h2><p>Each repository owns its workstreams.</p></section>;
  if (workspace?.kind === "directory") return <section className="workspace-empty"><h2>Workstreams require a repository</h2><p>This workspace is a plain directory. Select a repository workspace to manage workstreams.</p></section>;
  return <RepositoryWorkstreams key={workspaceId} workspaceId={workspaceId} workspaceName={workspace?.name ?? "Repository workspace"} openArtifact={openArtifact} openConversation={openConversation} startDocumentReview={startDocumentReview} disabled={disabled} />;
}

const TABS = ["conversations", "documents"] as const;
function RepositoryWorkstreams({ workspaceId, workspaceName, openArtifact, openConversation, startDocumentReview, disabled }: WorkstreamsProps & { workspaceId: string; workspaceName: string }) {
  const auth = useSyncExternalStore(subscribeWorkspace, workspaceEpoch);
  const [readError, setError] = useState(""), [refreshing, setRefreshing] = useState(true);
  const [inspection, setInspection] = useState<{ auth: number; availability: { state: string; message?: string } } | null>(null);
  const availability = inspection?.auth === auth ? inspection.availability : null;
  const overview = useWorkstreamOverviewState(workspaceId, availability?.state === "ready");
  const data = availability?.state === "ready" ? overview.overview : null;
  const loading = refreshing || overview.loading, error = readError || overview.error;
  const [enableError, setEnableError] = useState(""), [enabling, setEnabling] = useState(false);
  // Undefined is the initial selection; null is an intentional Unassigned selection.
  const [selected, setSelected] = useState<string | null | undefined>(undefined);
  const [search, setSearch] = useState(""), [tab, setTab] = useState<typeof TABS[number]>("conversations");
  const [creating, setCreating] = useState(false), [detailsId, setDetailsId] = useState<string | null>(null);
  const [actionsId, setActionsId] = useState<string | null>(null);
  const alive = useRef(true), request = useRef(0), enablePending = useRef(false);
  const viewId = useId();
  useEffect(() => {
    alive.current = true;
    setError(""); setEnableError(""); setEnabling(false); setRefreshing(false);
    void refresh();
    return () => { alive.current = false; request.current++; };
  }, [auth]);
  useEffect(() => {
    if (!data) return;
    reconcile(data);
  }, [data]);

  function reconcile(next: WorkstreamOverview) {
    setSelected(current => current === null || next.workstreams.some(item => item.workstream.id === current) ? current : next.workstreams[0]?.workstream.id ?? null);
    setDetailsId(current => next.workstreams.some(item => item.workstream.id === current) ? current : null);
    setActionsId(current => next.workstreams.some(item => item.workstream.id === current) ? current : null);
  }

  async function refresh({ strict = false, selectId }: { strict?: boolean; selectId?: string } = {}): Promise<void> {
    if (!alive.current) return;
    const generation = ++request.current;
    const epoch = workspaceEpoch();
    const current = () => {
      if (!alive.current) return false;
      if (epoch !== workspaceEpoch()) {
        if (strict) throw new Error("Sign-in changed during refresh. Retry refresh after signing in.");
        return false;
      }
      if (generation === request.current) return true;
      if (strict) throw new Error("A newer refresh replaced this read. Retry refresh.");
      return false;
    };
    setRefreshing(true); setError("");
    try {
      const nextAvailability = await workstreamRequest<{ state: string; message?: string }>(workspaceId, "inspect");
      if (!current()) return;
      if ((strict || data) && nextAvailability.state !== "ready") throw new Error(nextAvailability.message ?? `Workstreams are not available (${nextAvailability.state}).`);
      setInspection({ auth: epoch, availability: nextAvailability });
      if (nextAvailability.state !== "ready") return;
      // Keep the existing organizer and child mutation state mounted during reads.
      const next = await refreshWorkstreamOverview(workspaceId, { force: true });
      if (!current()) return;
      if (selectId && !next.workstreams.some(item => item.workstream.id === selectId)) throw new Error("The created workstream is not available in the refreshed view yet. Retry opening it.");
      if (selectId) { setSelected(selectId); setSearch(""); setTab("conversations"); setDetailsId(null); setActionsId(null); }
    }
    catch (e) {
      if (alive.current && epoch === workspaceEpoch() && generation === request.current) {
        setError(e instanceof Error ? e.message : String(e));
      }
      // Mutation dialogs must distinguish a committed write from a failed read.
      // Initial, manual and post-enable reads still consume their own failures.
      if (strict && alive.current) throw e;
    }
    finally { if (alive.current && epoch === workspaceEpoch() && generation === request.current) setRefreshing(false); }
  }
  async function enable() {
    if (enablePending.current) return;
    enablePending.current = true;
    const epoch = workspaceEpoch(), current = () => alive.current && epoch === workspaceEpoch();
    request.current++; // A pre-enable read cannot overwrite this mutation's outcome.
    setRefreshing(false); setEnabling(true); setEnableError("");
    try {
      await workstreamRequest(workspaceId, "init", {});
      if (current()) await refresh();
    }
    catch (e) { if (current()) setEnableError(e instanceof Error ? e.message : String(e)); }
    finally { enablePending.current = false; if (current()) setEnabling(false); }
  }
  function select(id: string | null) {
    if (id !== selected) { setDetailsId(null); setActionsId(null); }
    setSelected(id);
    if (id === null) setTab("conversations");
  }
  async function created(id: string): Promise<void> {
    if (!alive.current) return;
    await refresh({ strict: true, selectId: id });
  }

  const detail = data?.workstreams.find(item => item.workstream.id === selected);
  const visible = data?.workstreams.filter(item => `${item.workstream.title} ${item.workstream.id} ${item.workstream.type ?? ""}`.toLowerCase().includes(search.trim().toLowerCase())) ?? [];
  const unassignedCount = data?.conversations.filter(row => !row.conversation || row.conversation.workstreamId === null).length ?? 0;
  const count = detail ? data?.conversations.filter(row => row.conversation?.workstreamId === detail.workstream.id).length ?? 0 : unassignedCount;
  const activeTab = detail ? tab : "conversations";
  return <section className="workstreams-view" aria-label="Repository workstreams">
    <header className="workstreams-header">
      <div><h2>Workstreams</h2><p className="muted workstreams-repository">{workspaceName}</p></div>
      <div className="workstreams-actions">
        <button type="button" className="primary-button" disabled={!data || enabling} onClick={() => setCreating(true)} aria-haspopup="dialog">New workstream</button>
        <button type="button" disabled={loading || enabling} onClick={() => void refresh()}>{loading && data ? "Refreshing…" : "Refresh"}</button>
      </div>
    </header>
    {error && <div className="notice error workstreams-notice"><p role="alert">{data ? "Couldn't refresh workstreams. Your previous view is still available." : "Couldn't load workstreams. Try refreshing."}</p><details><summary>Details</summary><p>{error}</p></details></div>}
    {enableError && <div className="notice error workstreams-notice"><p role="alert">Couldn't enable workstreams. Try again when the repository is available.</p><details><summary>Details</summary><p>{enableError}</p></details></div>}
    {!data && (loading ? <div className="workstreams-empty" role="status"><p>Loading workstreams…</p></div> : !error && availability && availability.state !== "ready" && <div className="workstreams-empty">
      <h3>{availability.state === "uninitialized" ? "Organize your repository work" : availability.state === "not-repository" ? "Workstreams require a repository" : "Workstreams aren't available right now"}</h3>
      <p className="muted">{availability.state === "uninitialized" ? "Enable workstreams to group conversations and documents for this repository." : availability.state === "not-repository" ? "Select a repository workspace to manage workstreams." : "Check that the repository is accessible, then refresh to try again."}</p>
      {availability.state === "uninitialized" && <button type="button" className="primary-button" disabled={enabling} onClick={() => void enable()}>{enabling ? "Enabling…" : "Enable workstreams"}</button>}
      <details className="workstreams-technical"><summary>Details</summary><p>{availability.message ?? `Repository state: ${availability.state}`}</p></details>
    </div>)}
    {data && <div className="workstreams-organizer">
      <aside className="workstreams-sidebar">
        <label className="workstreams-search" htmlFor={`${viewId}-search`}>Search workstreams<input id={`${viewId}-search`} type="search" placeholder="Search by name" value={search} onChange={event => setSearch(event.target.value)} /></label>
        <nav className="workstreams-list" aria-label="Workstreams">
          {visible.map(item => {
            const conversations = data.conversations.filter(row => row.conversation?.workstreamId === item.workstream.id).length;
            return <button type="button" key={item.workstream.id} aria-current={selected === item.workstream.id ? "true" : undefined} aria-controls={`${viewId}-content`} onClick={() => select(item.workstream.id)}>
              <span className="workstreams-list-title">{item.workstream.title}</span><span className="workstreams-count" aria-label={`${conversations} conversations`}>{conversations}</span>
              <small className="workstreams-list-meta">{item.workstream.type ?? "Type not set"} · {item.workstream.lifecycle.status}</small>
            </button>;
          })}
          {!visible.length && <p className="muted workstreams-list-empty">{data.workstreams.length ? "No workstreams match your search." : "No workstreams yet. Create one to get started."}</p>}
          <button type="button" className="workstreams-unassigned" aria-current={selected === null ? "true" : undefined} aria-controls={`${viewId}-content`} onClick={() => select(null)}><span className="workstreams-list-title">Unassigned</span><span className="workstreams-count" aria-label={`${unassignedCount} conversations`}>{unassignedCount}</span><small className="workstreams-list-meta">Conversations without a workstream</small></button>
        </nav>
      </aside>
      <section className="workstreams-content" id={`${viewId}-content`} aria-label={detail?.workstream.title ?? "Unassigned conversations"}>
        <header className="workstreams-content-header">
          <div><h3>{detail?.workstream.title ?? "Unassigned"}</h3><p className="muted">{detail ? `${detail.workstream.type ?? "Type not set"} · Lifecycle: ${detail.workstream.lifecycle.status} · ` : "Without a workstream · "}{count} {count === 1 ? "conversation" : "conversations"}</p></div>
          {detail && <div className="workstreams-actions"><button type="button" disabled={disabled} onClick={() => setActionsId(detail.workstream.id)} aria-haspopup="dialog">Actions</button><button type="button" onClick={() => setDetailsId(detail.workstream.id)} aria-haspopup="dialog">Details</button></div>}
        </header>
        <div className="workstreams-tabs" role="tablist" aria-label="Workstream content">{TABS.map(value => <button type="button" key={value} role="tab" id={`${viewId}-tab-${value}`} aria-selected={activeTab === value} aria-controls={`${viewId}-panel-${value}`} tabIndex={activeTab === value ? 0 : -1} disabled={value === "documents" && !detail} title={value === "documents" && !detail ? "Select a workstream to browse its documents" : undefined} onClick={() => setTab(value)} onKeyDown={event => {
          if (!detail || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? "conversations" : event.key === "End" ? "documents" : value === "conversations" ? "documents" : "conversations";
          setTab(next); document.getElementById(`${viewId}-tab-${next}`)?.focus();
        }}>{value === "conversations" ? "Conversations" : "Documents"}</button>)}</div>
        <div role="tabpanel" id={`${viewId}-panel-conversations`} aria-labelledby={`${viewId}-tab-conversations`} hidden={activeTab !== "conversations"}>
          <WorkstreamConversations overview={data} workstreamId={detail?.workstream.id ?? null} workspaceId={workspaceId} openConversation={openConversation} onChanged={() => refresh({ strict: true })} disabled={disabled} />
        </div>
        <div role="tabpanel" id={`${viewId}-panel-documents`} aria-labelledby={`${viewId}-tab-documents`} hidden={activeTab !== "documents"}>
          {detail && activeTab === "documents" && startDocumentReview && <WorkstreamReviewEntry key={detail.workstream.id} overview={data} workspaceId={workspaceId} workstreamId={detail.workstream.id} onReview={startDocumentReview} disabled={disabled} />}
          {detail && activeTab === "documents" && <WorkstreamDocuments workspaceId={workspaceId} detail={detail} openArtifact={openArtifact} />}
        </div>
      </section>
    </div>}
    {creating && <CreateWorkstreamDialog key={auth} workspaceId={workspaceId} close={() => setCreating(false)} onCreated={created} />}
    {detail && detailsId === detail.workstream.id && <WorkstreamDetails key={detail.workstream.id} workspaceId={workspaceId} detail={detail} close={() => setDetailsId(null)} onChanged={() => refresh({ strict: true })} />}
    {detail && actionsId === detail.workstream.id && <WorkstreamActionsDialog key={detail.workstream.id} workspaceId={workspaceId} detail={detail} close={() => setActionsId(null)} onChanged={() => refresh({ strict: true })} />}
  </section>;
}
