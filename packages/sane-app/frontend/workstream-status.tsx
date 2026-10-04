import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { FiArrowLeft, FiGrid, FiRefreshCw, FiX } from "react-icons/fi";
import type { LifecyclePhase } from "sane-core/contracts";
import type { WorkstreamAction, WorkstreamActionInput, WorkstreamActionResult, WorkstreamOverview } from "../src/workstreams-contract";
import { assignmentClass, assignmentLabel, assignmentSemantics, supportAssignments } from "./assignment-semantics";
import { refreshWorkstreamOverview } from "./workstream-overview";
import { refKey, workstreamRequest } from "./workstreams-client";
import "./workstream-status.css";

export type WorkstreamStatusStart = { sessionId: string; workspaceId: string; repositoryId: string; workstreamId: string };

type Detail = WorkstreamOverview["workstreams"][number];
type Track = LifecyclePhase | typeof supportAssignments[number]["name"];
const phases = ["design", "engineering", "planning", "execution"] as const;
const isPhase = (track: Track): track is LifecyclePhase => (phases as readonly string[]).includes(track);
const label = (value: string) => value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, " ");
const identityKey = (identity: WorkstreamStatusStart) => JSON.stringify([identity.sessionId, identity.workspaceId, identity.repositoryId, identity.workstreamId]);
const assignmentsFor = (detail: Detail, track: Track) => detail.activePhases.filter(row => row.endedAt === null && assignmentSemantics(row.phase)?.track === track);
const sessionsFor = (detail: Detail, track: Track) => [...new Map(assignmentsFor(detail, track).map(row => [refKey(row.ref), row.ref])).values()];
const jobsFor = (detail: Detail, track: Track) => track === "planning" || track === "execution" ? detail.workstream.lifecycle.jobs : [];
const statusFor = (detail: Detail, track: Track) => isPhase(track) ? label(detail.workstream.lifecycle.phases.find(row => row.phase === track)?.status ?? "unavailable") : assignmentsFor(detail, track).length ? "Active" : "Inactive";

export function WorkstreamStatusComposer({ identity: start, active, close, navigation }: { identity: WorkstreamStatusStart; active: boolean; close: () => void; navigation?: ReactNode }) {
  const id = useId();
  const identity = useRef({ ...start }).current;
  const scope = JSON.stringify([identityKey(start), active]);
  const guard = useRef({ mounted: true, scope, epoch: 0, locked: false });
  if (guard.current.scope !== scope) { guard.current.scope = scope; guard.current.epoch++; }
  const available = useRef(false);
  available.current = active && identityKey(start) === identityKey(identity);
  const [selection, setSelection] = useState<Track | null>(null);
  const [data, setData] = useState<{ overview: WorkstreamOverview; detail: Detail } | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [readFailed, setReadFailed] = useState(false), [refreshFailed, setRefreshFailed] = useState(false);
  const [outcome, setOutcome] = useState("");
  const [confirm, setConfirm] = useState(false), [approvalRef, setApprovalRef] = useState("");
  const closeButton = useRef<HTMLButtonElement>(null), backButton = useRef<HTMLButtonElement>(null);
  const tileButtons = useRef(new Map<Track, HTMLButtonElement>());
  const originatingTrack = useRef<Track | null>(null);
  const current = (epoch: number) => guard.current.mounted && available.current && guard.current.epoch === epoch;

  // Passive focus runs after launcher dialog cleanup, only on entry or navigation.
  useEffect(() => {
    if (!available.current) return;
    const target = selection !== null ? backButton.current : originatingTrack.current !== null ? tileButtons.current.get(originatingTrack.current) : null;
    [target, closeButton.current].find(button => button && !button.disabled && button.getClientRects().length)?.focus({ preventScroll: true });
  }, [active, selection]);

  async function read(epoch: number) {
    const overview = await refreshWorkstreamOverview(identity.workspaceId, { force: true });
    if (!current(epoch)) throw new Error("Scope changed");
    if (overview.repositoryId !== identity.repositoryId) throw new Error("Repository changed");
    const detail = overview.workstreams.find(row => row.workstream.id === identity.workstreamId);
    if (!detail || detail.workstream.repositoryId !== identity.repositoryId) throw new Error("Workstream unavailable");
    const rows = overview.conversations.filter(row => row.sessionId === identity.sessionId);
    if (rows.length !== 1 || rows[0].conversation?.repositoryId !== identity.repositoryId || rows[0].conversation?.workstreamId !== identity.workstreamId) throw new Error("Membership changed");
    setData({ overview, detail });
    return detail;
  }

  useEffect(() => {
    guard.current.mounted = true;
    guard.current.locked = false;
    const epoch = ++guard.current.epoch;
    setBusy(false); setConfirm(false); setApprovalRef("");
    if (available.current) {
      setLoading(true);
      void read(epoch).then(() => {
        if (current(epoch)) { setLoading(false); setReadFailed(false); setRefreshFailed(false); }
      }).catch(() => {
        if (current(epoch)) { setLoading(false); setReadFailed(true); }
      });
    }
    return () => { guard.current.mounted = false; guard.current.epoch++; };
  }, [scope]);

  async function refresh() {
    if (!guard.current.mounted || !available.current || guard.current.locked) return;
    guard.current.locked = true;
    const epoch = ++guard.current.epoch;
    setBusy(true); setLoading(true); setConfirm(false); setApprovalRef("");
    try {
      await read(epoch);
      if (current(epoch)) { setReadFailed(false); setRefreshFailed(false); }
    } catch {
      if (current(epoch)) setReadFailed(true);
    } finally {
      if (current(epoch)) { guard.current.locked = false; setBusy(false); setLoading(false); }
    }
  }

  async function act(action: WorkstreamAction) {
    if (!selection || !isPhase(selection) || !data || loading || readFailed || refreshFailed || guard.current.locked || !guard.current.mounted || !available.current || action === "approve" && (!confirm || !approvalRef.trim())) return;
    guard.current.locked = true;
    const epoch = ++guard.current.epoch, phase = selection;
    const reference = approvalRef.trim();
    setBusy(true); setOutcome("");
    try {
      const fresh = await read(epoch);
      if (!current(epoch)) return;
      const input: WorkstreamActionInput = { id: identity.workstreamId, phase, repositoryId: identity.repositoryId, sessionId: identity.sessionId, expectedRevision: fresh.workstream.revision, ...(action === "approve" ? { approvalRef: reference } : {}) };
      const result = await workstreamRequest<WorkstreamActionResult>(identity.workspaceId, action, input);
      if (!current(epoch)) return;
      setOutcome(result.ok ? action === "validate" ? "Valid" : action === "approve" ? "Approved" : "Provided" : action === "validate" ? "Validation failed" : "Action failed");
      setConfirm(false); setApprovalRef("");
      try {
        await read(epoch);
        if (current(epoch)) { setReadFailed(false); setRefreshFailed(false); }
      } catch { if (current(epoch)) setRefreshFailed(true); }
    } catch {
      if (current(epoch)) { setOutcome("Action failed"); setReadFailed(true); setConfirm(false); setApprovalRef(""); }
    } finally {
      if (current(epoch)) { guard.current.locked = false; setBusy(false); }
    }
  }

  function select(track: Track | null) {
    if (!available.current || guard.current.locked) return;
    if (track !== null) originatingTrack.current = track;
    setSelection(track); setConfirm(false); setApprovalRef(""); setOutcome("");
  }

  const detail = data?.detail;
  const blocked = !available.current || loading || busy || readFailed || refreshFailed || !detail;
  const lifecycle = selection !== null && isPhase(selection);
  const confirmLabel = selection === "planning" ? "Approve & register jobs" : selection === "execution" ? "Approve & complete jobs" : "Confirm approval";
  const counts = (track: Track) => detail ? `${sessionsFor(detail, track).length} sessions · ${jobsFor(detail, track).length} jobs` : "";
  const tile = (track: Track) => detail && <button type="button" key={track} ref={button => { if (button) tileButtons.current.set(track, button); else tileButtons.current.delete(track); }} className={`workstream-status-tile ${assignmentClass(track)}`} disabled={blocked} onClick={() => select(track)}><strong>{assignmentLabel(track)}</strong><span>{statusFor(detail, track)}</span><small>{counts(track)}</small></button>;

  return <section className="workstream-status-composer" aria-label="View Status">
    <header className="workstream-status-heading"><div><FiGrid size={16} aria-hidden="true" /><strong>View Status</strong><span>{detail?.workstream.title ?? identity.workstreamId}</span></div><button ref={closeButton} type="button" className="text-button" disabled={busy} onClick={() => { if (!guard.current.locked) close(); }} aria-label="Close View Status"><FiX aria-hidden="true" />Close</button></header>
    <div className="workstream-status-body" aria-busy={loading || busy}>
      {loading && <p className="muted" role="status">Loading workstream status…</p>}
      {(readFailed || refreshFailed) && <div className="workstream-status-notice" role="status"><span>{refreshFailed ? "Refresh failed; action was not retried." : outcome === "Action failed" ? "Refresh before trying another action." : "Couldn't load current state. Refresh to verify membership."}</span><button type="button" className="text-button" disabled={!available.current || busy} onClick={() => void refresh()}>Refresh</button></div>}
      {outcome && <p className="workstream-status-notice" role="status">{outcome}</p>}
      {detail && !loading && (selection === null ? <>
        <div className="workstream-status-grid" aria-label="Lifecycle phases">{phases.map(tile)}</div>
        <hr className="workstream-status-divider" />
        <div className="workstream-status-grid" aria-label="Support tracks">{supportAssignments.map(track => tile(track.name))}</div>
      </> : <>
        <div className="workstream-status-summary"><strong className={assignmentClass(selection)}>{assignmentLabel(selection)}</strong><span>{statusFor(detail, selection)}</span><small>{counts(selection)}</small></div>
        {!lifecycle && <p className="workstream-status-notice">Support track · read-only. No lifecycle actions are available.</p>}
        {selection === "research" && <>
          <section className="workstream-status-section" aria-label="Active research topics"><h3>Active topics</h3>{[...new Set(assignmentsFor(detail, selection).map(row => assignmentSemantics(row.phase)?.topic ?? ""))].map(topic => {
            const rows = assignmentsFor(detail, selection).filter(row => (assignmentSemantics(row.phase)?.topic ?? "") === topic);
            return <div className="workstream-status-entry" key={topic}><strong>{topic || "General research"}</strong><small>{new Set(rows.map(row => refKey(row.ref))).size} sessions</small></div>;
          })}{!assignmentsFor(detail, selection).length && <p className="muted">No active topics.</p>}</section>
          <section className="workstream-status-section" aria-label="Registered research reports"><h3>Registered reports</h3>{detail.research.registered.map(report => <div className="workstream-status-entry" key={`${report.topic}:${report.reportPath}`}><div><strong>{report.topic}</strong><span>{[report.missing && "Missing", report.modified && "Modified"].filter(Boolean).join(" · ") || "Registered"}</span></div><small>{report.reportPath}</small></div>)}{!detail.research.registered.length && <p className="muted">No registered reports.</p>}</section>
          {!!detail.research.unregistered.length && <section className="workstream-status-section" aria-label="Unregistered research reports"><h3>Unregistered reports</h3>{detail.research.unregistered.map(path => <div className="workstream-status-entry" key={path}><small>{path}</small></div>)}</section>}
          {!!detail.research.warnings.length && <section className="workstream-status-section" aria-label="Research warnings"><h3>Warnings</h3>{detail.research.warnings.map((warning, index) => <p className="workstream-status-notice" key={index}>{warning}</p>)}</section>}
        </>}
        {(selection === "planning" || selection === "execution") && <section className="workstream-status-section" aria-label={`${assignmentLabel(selection)} jobs`}><h3>Jobs</h3>{jobsFor(detail, selection).map(job => <div className="workstream-status-entry" key={job.job_id}><div><strong>{job.job_id}</strong><span>{label(job.status)}</span></div><small>Spec: {job.spec_path}</small><small>Report: {job.report_path ?? "Not registered"}</small><small>Updated: {job.updated_at}</small></div>)}{!jobsFor(detail, selection).length && <p className="muted">No registered jobs.</p>}</section>}
        <section className="workstream-status-section" aria-label="Active sessions"><h3>Active sessions</h3>{sessionsFor(detail, selection).map(ref => {
          const key = refKey(ref);
          const row = data?.overview.conversations.find(row => refKey(row.ref) === key && row.conversation?.repositoryId === identity.repositoryId && row.conversation?.workstreamId === identity.workstreamId);
          const assignments = [...new Set(assignmentsFor(detail, selection).filter(row => refKey(row.ref) === key).map(row => assignmentLabel(row.phase)))];
          return <div className="workstream-status-entry" key={key}><strong>{row?.title || row?.sessionId || ref.nativeId}</strong><small>{assignments.join(" · ")}</small><small>{ref.harness} · {row?.sessionId ?? ref.nativeId}</small></div>;
        })}{!sessionsFor(detail, selection).length && <p className="muted">No active sessions.</p>}</section>
      </>)}
      {lifecycle && confirm && <div role="group" aria-label="Approval confirmation" className="workstream-status-confirm"><label htmlFor={`${id}-approval`}>Approval reference</label><input autoFocus id={`${id}-approval`} value={approvalRef} required disabled={blocked} placeholder="Approval reference" onChange={event => setApprovalRef(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); void act("approve"); } }} /><div><button type="button" disabled={blocked || !approvalRef.trim()} onClick={() => void act("approve")}>{confirmLabel}</button><button type="button" disabled={busy} onClick={() => { setConfirm(false); setApprovalRef(""); }}>Cancel</button></div></div>}
    </div>
    <footer className="workstream-status-toolbar"><div>{selection !== null && <button ref={backButton} type="button" className="text-button" disabled={!available.current || busy} onClick={() => select(null)}><FiArrowLeft aria-hidden="true" />Back</button>}<button type="button" className="text-button" disabled={!available.current || loading || busy} aria-label="Refresh workstream status" title="Refresh workstream status" onClick={() => void refresh()}><FiRefreshCw aria-hidden="true" /></button></div><div>{lifecycle && <><button type="button" disabled={blocked || confirm} onClick={() => void act("validate")}>Validate</button><button type="button" disabled={blocked || confirm} onClick={() => setConfirm(true)}>Approve</button><button type="button" disabled={blocked || confirm} onClick={() => void act("provide")}>Provide</button></>}{navigation}</div></footer>
  </section>;
}
