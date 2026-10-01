import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { SUPPORTED_WORKSTREAM_TYPES } from "sane-core/contracts";
import type { WorkstreamOverview, WorkstreamConversation } from "../src/workstreams-contract";
import { filterWorkstreamConversations, loadWorkstreams, refKey, workstreamRequest } from "./workstreams-client";
import { catalog } from "./catalog";
import "./workstreams.css";

export type ArtifactSelection = { workspaceId: string; workstreamId: string; path: string; repositoryId: string };
type WorkstreamsProps = { workspaceId: string | null; openArtifact?: (artifact: ArtifactSelection) => void };
export function WorkstreamsView({ workspaceId, openArtifact }: WorkstreamsProps) {
  const { workspaces } = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  if (!workspaceId) return <section className="workspace-empty"><h2>Select a repository workspace</h2><p>Each repository owns its workstreams.</p></section>;
  if (workspaces.find(workspace => workspace.workspaceId === workspaceId)?.kind === "directory") return <section className="workspace-empty"><h2>Workstreams require a repository</h2><p>This workspace is a plain directory. Select a repository workspace to manage workstreams.</p></section>;
  return <RepositoryWorkstreams key={workspaceId} workspaceId={workspaceId} openArtifact={openArtifact} />;
}
function RepositoryWorkstreams({ workspaceId, openArtifact }: WorkstreamsProps & { workspaceId: string }) {
  const [data, setData] = useState<WorkstreamOverview | null>(null), [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [store, setStore] = useState<{ state: string; message?: string } | null>(null);
  const [mutationError, setMutationError] = useState("");
  const [busy, setBusy] = useState(false), [selected, setSelected] = useState("");
  const [search, setSearch] = useState(""), [membership, setMembership] = useState("all"), [phase, setPhase] = useState("");
  const [artifacts, setArtifacts] = useState<string[]>([]), [artifactError, setArtifactError] = useState("");
  const alive = useRef(true), request = useRef(0);
  useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; request.current++; }; }, []);
  async function refresh() {
    const generation = ++request.current;
    setLoading(true); setError("");
    try {
      const availability = await workstreamRequest<{ state: string; message?: string }>(workspaceId, "inspect");
      if (!alive.current || generation !== request.current) return;
      setStore(availability); setData(null); setError("");
      if (availability.state !== "ready") return;
      const next = await loadWorkstreams(workspaceId); if (alive.current && generation === request.current) { setData(next); setError(""); }
    }
    catch (e) { if (alive.current && generation === request.current) setError(String(e instanceof Error ? e.message : e)); }
    finally { if (alive.current && generation === request.current) setLoading(false); }
  }
  async function mutate(operation: string, input: unknown) {
    if (busy) return;
    setBusy(true); setMutationError("");
    try {
      if (operation === "enroll") {
        const response = await fetch(`/api/sessions/${encodeURIComponent((input as { sessionId: string }).sessionId)}/enroll`, { method: "POST", credentials: "same-origin" });
        if (!response.ok) throw new Error((await response.json()).error ?? "Enrollment failed");
      } else await workstreamRequest(workspaceId, operation, input);
      if (alive.current) await refresh();
    }
    catch (e) { if (alive.current) setMutationError(e instanceof Error ? e.message : String(e)); }
    finally { if (alive.current) setBusy(false); }
  }
  useEffect(() => {
    let current = true; setArtifacts([]); setArtifactError("");
    if (selected) void workstreamRequest<string[]>(workspaceId, "artifacts/list", { id: selected }).then(paths => { if (current) setArtifacts(paths); }).catch(e => { if (current) setArtifactError(e.message); });
    return () => { current = false; };
  }, [selected, data]);
  const detail = data?.workstreams.find(w => w.workstream.id === selected);
  const assignments = data?.workstreams.flatMap(w => w.activePhases) ?? [];
  const phases = [...new Set(assignments.map(p => p.phase))];
  const visible = data ? filterWorkstreamConversations(data, { membership, phase, search }) : [];
  return <section className="workstreams-view" aria-label="Repository workstreams">
    <header><h2>Workstreams</h2><button disabled={busy} onClick={() => void refresh()}>Refresh</button></header>
    <p className="muted">Shared repository state. Lifecycle, jobs and Research are read only here; use the CLI for those mutations. Native handoff integration is deferred to C8.</p>
    {!loading && !error && store && store.state !== "ready" && <div role="status"><p>{store.state === "uninitialized" ? "Repository workstreams are not initialized." : store.state === "not-repository" ? "Workstreams require a repository workspace." : `Repository workstreams unavailable: ${store.state}.`}</p>{store.message && <p>{store.message}</p>}{store.state === "uninitialized" && <button disabled={busy} onClick={() => void mutate("init", {})}>Initialize repository domain</button>}</div>}
    {error && <p className="notice error" role="alert">{error}</p>}
    {mutationError && <p className="notice error" role="alert">{mutationError}</p>}
    {!data ? (loading || error) && <p role="status">{error ? "Workstreams unavailable for this workspace." : "Loading workstreams…"}</p> : <>
      <p className="context-path">Repository: {data.repositoryId}</p>
      <details><summary>Create workstream</summary><form onSubmit={e => { e.preventDefault(); const values = new FormData(e.currentTarget); void mutate("", { id: values.get("id"), title: values.get("title"), type: values.get("type"), ...(values.get("checkout") ? { defaultCheckout: values.get("checkout") } : {}) }); }}>
        <label>ID<input name="id" required /></label><label>Title<input name="title" required /></label><label>Type<select name="type" required defaultValue=""><option value="" disabled>Select type</option>{SUPPORTED_WORKSTREAM_TYPES.map(type => <option key={type} value={type}>{type}</option>)}</select></label><label>Default checkout (optional absolute path)<input name="checkout" /></label><button disabled={busy}>Create workstream</button>
      </form></details>
      <label>Workstream details<select value={selected} onChange={e => setSelected(e.target.value)}><option value="">Select workstream</option>{data.workstreams.map(w => <option key={w.workstream.id} value={w.workstream.id}>{w.workstream.title} · {w.workstream.id} · {w.workstream.type ?? "Incomplete: type not set"} · {w.conversations.length} conversations</option>)}</select></label>
      {!data.workstreams.length && <p>No workstreams yet.</p>}
      {detail && <section className="detail-section"><h3>{detail.workstream.title}</h3><p>Default checkout: {detail.workstream.defaultCheckout?.path ?? "Not set"}</p>
        <p>Type: {detail.workstream.type}</p>
        <h4>Lifecycle · read only</h4><p>Outcome: {detail.workstream.lifecycle.status}</p><ul>{detail.workstream.lifecycle.phases.map(p => <li key={p.phase}>{p.phase}: {p.status} · Approval: {p.approval_ref ?? "None"}</li>)}</ul>
        <h4>Jobs · read only</h4><ul>{detail.workstream.lifecycle.jobs.map(j => <li key={j.job_id}>{j.job_id}: {j.status}</li>)}</ul>
        <h4>Research · read only</h4><ul>{detail.research.registered.map(r => <li key={r.topic}>{r.topic}: {r.reportPath}{r.missing ? " · Missing" : r.modified ? " · Modified" : " · Current"}</li>)}</ul>{detail.research.warnings.map(w => <p key={w}>{w}</p>)}
        <form key={`${selected}:${detail.workstream.defaultCheckout?.path}`} onSubmit={e => { e.preventDefault(); const checkout = new FormData(e.currentTarget).get("checkout"); void mutate("default-checkout", { id: selected, checkout: checkout || null }); }}><label>Default checkout<input name="checkout" defaultValue={detail.workstream.defaultCheckout?.path ?? ""} placeholder="Absolute checkout path; empty clears default" /></label><button disabled={busy}>Set default checkout</button></form>
        <p className="muted">Defaults are suggestions for new conversations. Existing execution pins never move.</p>
        <p>Active phases: {detail.activePhases.map(p => `${p.phase} (${p.ref.harness}:${p.ref.nativeId})`).join(", ") || "None"}</p>
        <button onClick={() => setMembership(`workstream:${selected}`)}>Show member conversations</button>
        <h4>Artifacts · read only</h4>{artifactError ? <p role="alert">{artifactError}</p> : artifacts.length ? <ul>{artifacts.map(path => <li key={path}><button disabled={!openArtifact} title={!openArtifact ? "Artifact navigation is unavailable" : undefined} onClick={() => openArtifact?.({ workspaceId, workstreamId: selected, path, repositoryId: data.repositoryId })}>{path} · Open in Files</button></li>)}</ul> : <p>No Markdown artifacts found.</p>}
        <details><summary>Phase history · {detail.phaseHistory.length}</summary><ul>{detail.phaseHistory.map(p => <li key={p.id}>{p.phase} · {p.ref.harness}:{p.ref.nativeId} · {p.startedAt} → {p.endedAt ?? "Active"}</li>)}</ul></details>
      </section>}
      <h3>Conversations</h3><div className="workstream-filters"><label>Search<input value={search} onChange={e => setSearch(e.target.value)} /></label><label>Membership<select value={membership} onChange={e => setMembership(e.target.value)}><option value="all">All conversations</option><option value="unknown">Unknown association</option><option value="unassigned">Confirmed unassigned</option>{data.workstreams.map(w => <option key={w.workstream.id} value={`workstream:${w.workstream.id}`}>{w.workstream.title}</option>)}</select></label><label>Phase<select value={phase} onChange={e => setPhase(e.target.value)}><option value="">All phases</option>{phases.map(p => <option key={p}>{p}</option>)}</select></label></div>
      {!visible.length && <p>No conversations match these filters.</p>}
      {visible.map(row => <ConversationCard key={row.sessionId ?? refKey(row.ref)} row={row} data={data} busy={busy} mutate={mutate} />)}
    </>}
  </section>;
}
function ConversationCard({ row, data, busy, mutate }: { row: WorkstreamConversation; data: WorkstreamOverview; busy: boolean; mutate: (operation: string, input: unknown) => Promise<void> }) {
  const conversation = row.conversation;
  const phaseListId = useId();
  const phases = data.workstreams.flatMap(w => w.activePhases).filter(p => refKey(p.ref) === refKey(row.ref));
  const manage = (operation: string, fields: object) => void mutate("manage", { operation, ref: row.ref, ...fields });
  return <article className="workstream-conversation"><h4>{row.title}</h4><p className="context-path">{row.ref ? `${row.ref.harness} · ${row.ref.authorityId} · ${row.ref.nativeId}` : "Native identity unavailable"}{!row.sessionId && " · No App history"}</p>
    <p>Membership: {conversation ? conversation.workstreamId ?? "Confirmed unassigned" : "App-only — not enrolled in this repository domain"}</p>
    {!conversation && row.sessionId && <button disabled={busy} onClick={() => void mutate("enroll", { sessionId: row.sessionId })}>Enroll conversation</button>}
    <p className="context-path">Execution checkout: {conversation?.executionCheckout.path ?? "Not enrolled"}</p>
    {conversation && <><form key={conversation.workstreamId ?? "unassigned"} onSubmit={e => { e.preventDefault(); manage("associate", { workstreamId: new FormData(e.currentTarget).get("membership") || null }); }}><label>Assign / reassign / unassign<select name="membership" defaultValue={conversation.workstreamId ?? ""}><option value="">Unassigned</option>{data.workstreams.map(w => <option key={w.workstream.id} value={w.workstream.id}>{w.workstream.title}</option>)}</select></label><button disabled={busy}>Save membership</button></form>
      <p className="muted">Changing membership ends current phases; execution checkout stays pinned.</p>
      <ul>{phases.map(p => <li key={p.id}>{p.phase} <button disabled={busy} onClick={() => manage("phase/end", { assignmentId: p.id })}>Remove phase</button></li>)}</ul>
      {conversation.workstreamId && <form onSubmit={e => { e.preventDefault(); manage("phase/assign", { phase: new FormData(e.currentTarget).get("phase") }); }}><label>Add phase<input name="phase" list={phaseListId} required placeholder="research:topic" /></label><datalist id={phaseListId}>{["design", "engineering", "planning", "execution", "research"].map(p => <option key={p} value={p} />)}</datalist><button disabled={busy}>Add phase</button></form>}
    </>}
  </article>;
}
