import { useEffect, useId, useRef, useState } from "react";
import type { WorkstreamConversation, WorkstreamOverview } from "../src/workstreams-contract";
import { refKey, workstreamRequest } from "./workstreams-client";
import { ShellDialog } from "./shell-dialog";
import "./workstream-conversations.css";

type Props = {
  overview: WorkstreamOverview;
  workstreamId: string | null;
  workspaceId: string;
  openConversation?: (id: string) => void;
  onChanged: () => Promise<void>;
  disabled?: boolean;
};
type NativeRef = NonNullable<WorkstreamConversation["ref"]>;
type Assignment = WorkstreamOverview["workstreams"][number]["activePhases"][number];
type Admission = {
  sessionId: string; state: string; nativeId: string | null; operation: string;
  source: { authorityId: string; descriptor: { harness: NativeRef["harness"] } };
  binding: { workspaceId: string; domain: { mode: string; repositoryId?: string }; executionCheckout: string };
  createdAt: string; error: string | null;
};
type SessionMetadata = { sessionId: string; harness?: string; admission?: Admission };
type Modal = { kind: "picker"; target: string } | { kind: "destination" | "remove" | "phase" | "details"; row: WorkstreamConversation };
type Issue = { message: string; details: string; recovery?: "retry-admission" | "check" | "inspect" };
class ActionError extends Error {
  constructor(readonly issue: Issue) { super(issue.message); }
}
const phaseChoices = ["design", "engineering", "planning", "execution", "research"];
const rowKey = (row: WorkstreamConversation) => row.sessionId ?? refKey(row.ref);
const rawError = (error: unknown) => error instanceof Error ? error.message : String(error);
const phaseLabel = (phase: string) => phase.startsWith("research:") ? `Research · ${phase.slice(9)}` : phase.charAt(0).toUpperCase() + phase.slice(1);
function harnessLabel(row: WorkstreamConversation, metadata?: SessionMetadata) {
  const harness = row.ref?.harness ?? row.conversation?.ref.harness ?? metadata?.admission?.source.descriptor.harness ?? metadata?.harness;
  return harness === "cc" || harness === "claude-code" ? "Claude Code" : harness === "oc" || harness === "opencode" ? "OpenCode" : "Harness unavailable";
}
function friendlyTitle(row: WorkstreamConversation, metadata?: SessionMetadata) {
  const title = row.title.trim();
  const identity = row.ref ?? row.conversation?.ref;
  const isIdentity = title === identity?.nativeId || title === identity?.authorityId || title === row.sessionId
    || /^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(title) || /^ses[a-zA-Z0-9_-]{12,200}$/.test(title)
    || title.startsWith("sane-native-v1:") || title.startsWith("/") || /^[a-z]:\\/i.test(title);
  return !title || isIdentity ? `Untitled conversation (${harnessLabel(row, metadata)})` : title;
}
async function sessionRequest<T>(path: string, method = "GET"): Promise<T> {
  const response = await fetch(path, { method, credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(25000) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `Request failed (${response.status})`);
  return value;
}

/** A new workspace gets an isolated mutation lock and enrollment recovery cache. */
export function WorkstreamConversations(props: Props) {
  return <ConversationOrganizer key={props.workspaceId} {...props} />;
}

function ConversationOrganizer({ overview, workstreamId, workspaceId, openConversation, onChanged, disabled = false }: Props) {
  const [search, setSearch] = useState(""), [phaseFilter, setPhaseFilter] = useState("");
  const [modal, setModal] = useState<Modal | null>(null), [chosen, setChosen] = useState<WorkstreamConversation | null>(null);
  const [pickerSearch, setPickerSearch] = useState(""), [destination, setDestination] = useState("");
  const [phase, setPhase] = useState("design"), [topic, setTopic] = useState(""), [ending, setEnding] = useState<Assignment | null>(null);
  const [busy, setBusy] = useState(false), [issue, setIssue] = useState<Issue | null>(null), [notice, setNotice] = useState("");
  const [metadata, setMetadata] = useState<Record<string, SessionMetadata>>({});
  const [metadataLoading, setMetadataLoading] = useState(false), [metadataError, setMetadataError] = useState("");
  const mounted = useRef(true), lock = useRef<symbol | null>(null), metadataRequest = useRef(0);
  const connected = useRef(new Map<string, NativeRef>());
  const pickerName = useId();
  const scope = useRef({ workspaceId, workstreamId, epoch: 0 });
  if (scope.current.workspaceId !== workspaceId || scope.current.workstreamId !== workstreamId) {
    // Invalidate immediately, including a switch away and back to the same ID.
    scope.current = { workspaceId, workstreamId, epoch: scope.current.epoch + 1 };
    metadataRequest.current++;
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      scope.current.epoch++;
      metadataRequest.current++;
    };
  }, []);
  useEffect(() => {
    setModal(null); setChosen(null); setIssue(null); setNotice(""); setPhaseFilter("");
  }, [workspaceId, workstreamId]);

  async function readMetadata() {
    const generation = ++metadataRequest.current;
    const epoch = scope.current.epoch;
    const data = await sessionRequest<{ sessions: SessionMetadata[] }>("/api/sessions");
    const next = Object.fromEntries(data.sessions.map(session => [session.sessionId, session]));
    if (mounted.current && scope.current.epoch === epoch && generation === metadataRequest.current) setMetadata(next);
    return next;
  }
  useEffect(() => {
    if (!modal) return;
    let current = true;
    const epoch = scope.current.epoch;
    const active = () => mounted.current && current && scope.current.epoch === epoch;
    setMetadataLoading(true); setMetadataError("");
    void readMetadata().catch(error => { if (active()) setMetadataError(rawError(error)); })
      .finally(() => { if (active()) setMetadataLoading(false); });
    return () => { current = false; };
  }, [modal?.kind, workspaceId, workstreamId]);

  const assignments = overview.workstreams.flatMap(workstream => workstream.activePhases);
  const phasesFor = (row: WorkstreamConversation) => row.ref ? assignments.filter(assignment => refKey(assignment.ref) === refKey(row.ref)) : [];
  const titleFor = (row: WorkstreamConversation) => friendlyTitle(row, row.sessionId ? metadata[row.sessionId] : undefined);
  const harnessFor = (row: WorkstreamConversation) => harnessLabel(row, row.sessionId ? metadata[row.sessionId] : undefined);
  const workstreamTitle = (id: string) => overview.workstreams.find(item => item.workstream.id === id)?.workstream.title || "another workstream";
  const membershipLabel = (row: WorkstreamConversation) => !row.conversation ? "Not connected" : row.conversation.workstreamId ? `Assigned to ${workstreamTitle(row.conversation.workstreamId)}` : "Unassigned";
  const members = overview.conversations.filter(row => workstreamId === null ? !row.conversation?.workstreamId : row.conversation?.workstreamId === workstreamId);
  const availablePhases = [...new Set(members.flatMap(row => phasesFor(row).map(assignment => assignment.phase)))];
  const visible = members.filter(row => titleFor(row).toLowerCase().includes(search.trim().toLowerCase()) && (!phaseFilter || phasesFor(row).some(assignment => assignment.phase === phaseFilter)));
  const candidates = modal?.kind === "picker" ? overview.conversations.filter(row => row.conversation?.workstreamId !== modal.target) : [];
  const pickerRows = candidates.filter(row => titleFor(row).toLowerCase().includes(pickerSearch.trim().toLowerCase()));
  const snapshotRow = modal?.kind === "picker" ? chosen : modal?.row;
  const selectedRow = snapshotRow ? overview.conversations.find(row => rowKey(row) === rowKey(snapshotRow)) ?? snapshotRow : null;
  const target = modal?.kind === "picker" ? modal.target : destination;
  const moving = !!target && !!selectedRow?.conversation?.workstreamId && selectedRow.conversation.workstreamId !== target;
  const needsEnrollment = !!selectedRow && !selectedRow.conversation && !(selectedRow.sessionId && connected.current.has(selectedRow.sessionId));
  const requestedPhase = phase === "research" && topic.trim() ? `research:${topic.trim()}` : phase;
  const validTopic = !topic.trim() || /^[a-z0-9][a-z0-9_-]{0,95}$/.test(topic.trim());
  const alreadyHasPhase = !!selectedRow && phasesFor(selectedRow).some(assignment => assignment.phase === requestedPhase);
  const admission = selectedRow?.sessionId ? metadata[selectedRow.sessionId]?.admission : undefined;

  function openModal(next: Modal) {
    if (lock.current) return;
    setIssue(null); setNotice(""); setChosen(null); setPickerSearch(""); setDestination("");
    setPhase("design"); setTopic(""); setEnding(null); setModal(next);
  }
  function closeModal() { if (!lock.current) { setModal(null); setIssue(null); setNotice(""); } }
  function selectionChanged() { setIssue(null); setNotice(""); }
  async function mutate(action: (current: () => boolean) => Promise<boolean>, failureMessage: string) {
    if (lock.current || !mounted.current) return;
    const owner = Symbol();
    lock.current = owner; setBusy(true); setIssue(null); setNotice("");
    const epoch = scope.current.epoch;
    const current = () => mounted.current && scope.current.epoch === epoch && lock.current === owner;
    try {
      const close = await action(current);
      if (current() && close) setModal(null);
    } catch (error) {
      if (current()) setIssue(error instanceof ActionError ? error.issue : { message: failureMessage, details: rawError(error) });
    } finally {
      // Keep the lock through scope changes until the in-flight write settles.
      // Only its owner may unlock or clear busy state, never a newer action.
      if (lock.current === owner) {
        lock.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  }
  async function refresh(current: () => boolean) {
    if (!current()) return;
    try { await onChanged(); }
    catch (error) { throw new ActionError({ message: "The change was saved, but the list could not refresh. Close this dialog and refresh the workstream list.", details: rawError(error) }); }
  }
  function recoveryFor(a?: Admission): Issue["recovery"] {
    if (!a) return "inspect";
    if (a.state === "ready") return undefined;
    return a.nativeId && a.state === "identity_known" ? "retry-admission" : "inspect";
  }
  function checkBinding(a: Admission) {
    if (a.binding.workspaceId !== workspaceId || a.binding.domain.mode === "repository" && a.binding.domain.repositoryId !== overview.repositoryId)
      throw new ActionError({ message: "This conversation is connected to a different repository. Choose a conversation from this repository.", details: "Admission repository binding does not match the selected workspace.", recovery: "inspect" });
  }
  async function enrolledRef(row: WorkstreamConversation, current: () => boolean, retryAdmission: boolean): Promise<NativeRef | null> {
    if (row.conversation && !retryAdmission) {
      const pending = row.sessionId ? metadata[row.sessionId]?.admission : undefined;
      if (pending && pending.state !== "ready") throw new ActionError({ message: "Connection is pending. Finish any native activity, then explicitly retry the connection below.", details: pending.error || `Admission state: ${pending.state}`, recovery: recoveryFor(pending) });
      return row.ref ?? row.conversation.ref;
    }
    if (!row.sessionId) throw new ActionError({ message: "This conversation cannot be connected from the App. Open it in its native harness and connect it there.", details: "No App session is available." });
    if (connected.current.has(row.sessionId)) return connected.current.get(row.sessionId)!;
    let a: Admission | undefined;
    try { a = (await readMetadata())[row.sessionId]?.admission; }
    catch (error) { throw new ActionError({ message: "Could not check the connection. Retry after the App reconnects; no enrollment was started.", details: rawError(error), recovery: "check" }); }
    if (!current()) return null;
    if (!a) throw new ActionError({ message: "The App cannot find this conversation’s connection record. Inspect it in the native harness before trying again.", details: "Admission record missing.", recovery: "inspect" });
    checkBinding(a);
    const ref: NativeRef | null = row.ref ?? (a.nativeId ? { harness: a.source.descriptor.harness, authorityId: a.source.authorityId, nativeId: a.nativeId } : null);
    if (!ref) throw new ActionError({ message: "The native conversation identity is not confirmed. Inspect it in the native harness; do not create it again.", details: "Native identity is unavailable.", recovery: "inspect" });
    if (a.state !== "ready" && !retryAdmission) throw new ActionError({ message: "Connection is pending. Finish any native activity, then explicitly retry the connection below.", details: a.error || `Admission state: ${a.state}`, recovery: recoveryFor(a) });
    if (a.state !== "ready" && recoveryFor(a) !== "retry-admission") throw new ActionError({ message: "The connection needs operator inspection in the native harness before it can be retried safely.", details: a.error || `Admission state: ${a.state}`, recovery: "inspect" });
    if (a.state === "ready" && a.binding.domain.mode === "repository") { connected.current.set(row.sessionId, ref); return ref; }
    try {
      if (a.state !== "ready") {
        a = (await sessionRequest<{ admission: Admission }>(`/api/sessions/${encodeURIComponent(row.sessionId)}/retry-admission`, "POST")).admission;
        if (!current()) return null;
        if (a.binding.domain.mode === "repository") { connected.current.set(row.sessionId, ref); return ref; }
      }
      await sessionRequest(`/api/sessions/${encodeURIComponent(row.sessionId)}/enroll`, "POST");
      // Keep this independently of overview: association may fail after enrollment succeeds.
      // A scope switch cancels association, not enrollment already saved by the server.
      connected.current.set(row.sessionId, ref);
      if (!current()) return null;
      return ref;
    } catch (error) {
      if (!current()) return null;
      let recovery: Issue["recovery"] = "check";
      try {
        const next = (await readMetadata())[row.sessionId]?.admission;
        if (!current()) return null;
        recovery = recoveryFor(next);
        if (next?.state === "ready" && next.binding.domain.mode === "repository") { checkBinding(next); connected.current.set(row.sessionId, ref); }
      } catch { /* Unknown outcome: require a status check before another enrollment. */ }
      try { await refresh(current); } catch { /* Preserve the original connection failure and recovery. */ }
      throw new ActionError({ message: recovery === "retry-admission" ? "Connection is pending. Finish native activity, then use Retry connection and add below." : recovery === "inspect" ? "The connection needs inspection in the native harness before you retry." : connected.current.has(row.sessionId) ? "Connected to repository, but not added to workstream. Retry adding it." : recovery === "check" ? "Could not connect this conversation. Check its connection status before retrying." : "Could not connect this conversation. Finish any native activity, then retry adding it.", details: rawError(error), recovery });
    }
  }
  function addToWorkstream(retryAdmission = false) {
    if (!selectedRow || !target) return;
    const row = selectedRow, workstream = target;
    void mutate(async current => {
      const ref = await enrolledRef(row, current, retryAdmission);
      if (!current()) return false;
      if (!ref) throw new ActionError({ message: "The conversation’s identity is unavailable. Inspect its connection details before adding it.", details: "No qualified native reference.", recovery: "inspect" });
      try { await workstreamRequest(workspaceId, "manage", { operation: "associate", ref, workstreamId: workstream }); }
      catch (error) {
        if (!current()) return false;
        if (row.sessionId && connected.current.has(row.sessionId)) {
          try { await refresh(current); } catch { /* Preserve partial success and the selected conversation. */ }
          throw new ActionError({ message: "Connected to repository, but not added to workstream. Retry adding it.", details: rawError(error) });
        }
        throw error;
      }
      await refresh(current);
      return true;
    }, "Could not add this conversation. Check that the workstream is available, then retry.");
  }
  function checkConnection() {
    if (!selectedRow?.sessionId) return;
    const sessionId = selectedRow.sessionId;
    void mutate(async current => {
      const a = (await readMetadata())[sessionId]?.admission;
      if (!current()) return false;
      if (a) checkBinding(a);
      const recovery = recoveryFor(a);
      if (a?.state === "ready" && a.binding.domain.mode === "repository" && a.nativeId) connected.current.set(sessionId, { harness: a.source.descriptor.harness, authorityId: a.source.authorityId, nativeId: a.nativeId });
      if (recovery) throw new ActionError({ message: recovery === "retry-admission" ? "Connection is pending. Finish native activity, then retry the connection below." : "Inspect this conversation’s connection in the native harness before retrying.", details: a?.error || `Admission state: ${a?.state ?? "missing"}`, recovery });
      setNotice(connected.current.has(sessionId) ? "Connected to repository. Retry adding it to the workstream." : "Ready to connect. You can retry adding this conversation.");
      await refresh(current);
      return false;
    }, "Could not check connection status. Restore the App connection and try again.");
  }
  function manage(operation: string, fields: object, close: boolean) {
    if (!selectedRow?.ref) return;
    const ref = selectedRow.ref;
    void mutate(async current => {
      await workstreamRequest(workspaceId, "manage", { operation, ref, ...fields });
      await refresh(current);
      if (current()) { setEnding(null); if (!close) setNotice("Phase assignments updated."); }
      return close;
    }, "Could not save this change. Check the conversation’s availability, then retry.");
  }

  const modalTitle = modal?.kind === "picker" ? "Add existing conversation" : modal?.kind === "destination" ? selectedRow?.conversation?.workstreamId ? "Move to workstream" : "Add to workstream" : modal?.kind === "remove" ? "Remove from workstream" : modal?.kind === "phase" ? "Change phase" : "Conversation details";
  return <section className="workstream-conversations" aria-label="Workstream conversations">
    <header className="workstream-conversations-header"><h3>Conversations <span className="workstream-conversations-count">{members.length}</span></h3>{workstreamId && <button type="button" disabled={busy} onClick={() => openModal({ kind: "picker", target: workstreamId })}>Add existing conversation</button>}</header>
    <div className="workstream-conversations-filters">
      <label>Search conversations<input type="search" value={search} placeholder="Search by title" onChange={event => setSearch(event.target.value)} /></label>
      <label>Active phase<select value={phaseFilter} onChange={event => setPhaseFilter(event.target.value)}><option value="">All phases</option>{availablePhases.map(item => <option key={item} value={item}>{phaseLabel(item)}</option>)}</select></label>
    </div>
    {!visible.length && <p className="workstream-conversations-empty">{members.length ? "No conversations match these filters." : workstreamId ? "No conversations yet. Add an existing conversation to this workstream." : "No unassigned conversations."}</p>}
    <ul className="workstream-conversations-list">{visible.map(row => <li key={rowKey(row)} className="workstream-conversations-row">
      <div className="workstream-conversations-summary"><h4>{titleFor(row)}</h4><p>{harnessFor(row)}{!row.conversation && " · Not connected"}{!row.sessionId && " · Native conversation"}</p>
        <div className="workstream-conversations-phases" aria-label="Active phase assignments">{phasesFor(row).length ? phasesFor(row).map(assignment => <span key={assignment.id}>{phaseLabel(assignment.phase)}</span>) : <span className="workstream-conversations-no-phase">No active phase</span>}</div>
      </div>
      <div className="workstream-conversations-row-actions">
        <button type="button" disabled={disabled || !row.sessionId || !openConversation} title={!row.sessionId ? "This conversation has no App session to open" : !openConversation ? "Conversation navigation is unavailable" : disabled ? "Finish sending before opening another conversation" : undefined} onClick={() => { if (!disabled && row.sessionId) openConversation?.(row.sessionId); }}>Open</button>
        {!row.conversation?.workstreamId && <button type="button" disabled={busy || !overview.workstreams.length || (!row.conversation && !row.sessionId)} onClick={() => openModal({ kind: "destination", row })}>{row.conversation ? "Add to workstream" : "Connect and add"}</button>}
        <details className="workstream-conversations-actions"><summary>Actions<span className="workstream-conversations-sr-only"> for {titleFor(row)}</span></summary><div>
          {row.conversation?.workstreamId && <><button type="button" disabled={busy || !row.ref} onClick={() => openModal({ kind: "phase", row })}>Change phase</button><button type="button" disabled={busy || overview.workstreams.length < 2} onClick={() => openModal({ kind: "destination", row })}>Move to workstream</button><button type="button" disabled={busy || !row.ref} onClick={() => openModal({ kind: "remove", row })}>Remove from workstream</button></>}
          <button type="button" disabled={busy} onClick={() => openModal({ kind: "details", row })}>Details</button>
        </div></details>
      </div>
    </li>)}</ul>
    {modal && <ShellDialog title={modalTitle} className="workstream-conversation-dialog" close={closeModal} closeDisabled={busy}>
      {modal.kind !== "picker" && selectedRow && <p className="workstream-conversation-dialog-subtitle">{titleFor(selectedRow)} · {harnessFor(selectedRow)}</p>}
      {modal.kind === "picker" && <>
        <p>Choose a conversation to add to {workstreamTitle(modal.target)}.</p>
        <label>Search existing conversations<input type="search" value={pickerSearch} disabled={busy} onChange={event => setPickerSearch(event.target.value)} placeholder="Search by title" /></label>
        <fieldset className="workstream-conversation-picker" disabled={busy}><legend>Existing conversations</legend>{pickerRows.map(row => <label key={rowKey(row)} className="workstream-conversation-picker-row"><input type="radio" name={pickerName} checked={!!chosen && rowKey(chosen) === rowKey(row)} onChange={() => { setChosen(row); selectionChanged(); }} /><span><strong>{titleFor(row)}</strong><small>{harnessFor(row)} · {membershipLabel(row)}</small></span></label>)}</fieldset>
        {!pickerRows.length && <p>{candidates.length ? "No conversations match your search." : "All existing conversations already belong to this workstream."}</p>}
        {selectedRow && <p>Selected: {titleFor(selectedRow)}</p>}
      </>}
      {modal.kind === "destination" && <label>Destination workstream<select value={destination} disabled={busy} onChange={event => { setDestination(event.target.value); selectionChanged(); }}><option value="">Choose a workstream</option>{overview.workstreams.filter(item => item.workstream.id !== selectedRow?.conversation?.workstreamId).map(item => <option key={item.workstream.id} value={item.workstream.id}>{item.workstream.title}</option>)}</select></label>}
      {(modal.kind === "picker" || modal.kind === "destination") && selectedRow && <>
        {needsEnrollment && <p className="workstream-conversation-warning">Adding connects this conversation to the repository first. Connection and workstream assignment are separate steps: if adding fails, it may remain connected. Its execution checkout will not change.</p>}
        {moving && <p className="workstream-conversation-warning">Move from {workstreamTitle(selectedRow.conversation!.workstreamId!)} to {workstreamTitle(target)}? This ends its current phase assignments and preserves its execution checkout. It does not complete or approve lifecycle phases.</p>}
        {issue?.recovery === "retry-admission" && <button type="button" disabled={busy || !target} onClick={() => addToWorkstream(true)}>Retry connection and add</button>}
        {issue?.recovery === "check" && <button type="button" disabled={busy} onClick={checkConnection}>Check connection status</button>}
        {issue?.recovery === "inspect" && <p>Open the native harness to inspect the conversation and its connection. After resolving it, <button type="button" disabled={busy} onClick={checkConnection}>Check connection status</button>.</p>}
      </>}
      {modal.kind === "remove" && <p className="workstream-conversation-warning">Remove this conversation from {selectedRow?.conversation?.workstreamId ? workstreamTitle(selectedRow.conversation.workstreamId) : "the workstream"}? This does not delete the conversation. It ends current phase assignments and preserves its execution checkout. It does not complete or approve lifecycle phases.</p>}
      {modal.kind === "phase" && selectedRow && <>
        <h3>Current phase assignments</h3><ul className="workstream-conversation-phase-list">{phasesFor(selectedRow).map(assignment => <li key={assignment.id}><span>{phaseLabel(assignment.phase)}</span><button type="button" disabled={busy} onClick={() => { setEnding(assignment); selectionChanged(); }}>End assignment<span className="workstream-conversations-sr-only"> for {phaseLabel(assignment.phase)}</span></button></li>)}</ul>
        {!phasesFor(selectedRow).length && <p>No active phase assignments.</p>}
        {ending && <div className="workstream-conversation-warning"><p>End the {phaseLabel(ending.phase)} assignment? Other assignments remain active. This does not complete or approve the lifecycle phase.</p><button type="button" disabled={busy} onClick={() => manage("phase/end", { assignmentId: ending.id }, false)}>Confirm end assignment</button><button type="button" disabled={busy} onClick={() => setEnding(null)}>Keep assignment</button></div>}
        <form onSubmit={event => { event.preventDefault(); if ((phase !== "research" || validTopic) && !alreadyHasPhase && !ending) manage("phase/assign", { phase: requestedPhase }, false); }}>
          <h3>Add phase</h3><p>A conversation can have multiple active phase assignments. Adding one does not complete or approve a lifecycle phase.</p>
          <label>Phase<select value={phase} disabled={busy} onChange={event => { setPhase(event.target.value); selectionChanged(); }}>{phaseChoices.map(item => <option key={item} value={item}>{phaseLabel(item)}</option>)}</select></label>
          {phase === "research" && <label>Research topic (optional)<input value={topic} disabled={busy} maxLength={96} pattern="[a-z0-9][a-z0-9_\-]{0,95}" placeholder="e.g. deployment-options" onChange={event => { setTopic(event.target.value); selectionChanged(); }} /><small>Use 1–96 lowercase letters, numbers, hyphens or underscores; start with a letter or number. Leave empty for general Research.</small></label>}
          {!validTopic && phase === "research" && <p role="alert">Use a valid topic slug, such as deployment-options.</p>}
          {alreadyHasPhase && <p>This phase is already assigned to this conversation.</p>}
          <button disabled={busy || ending !== null || (phase === "research" && !validTopic) || alreadyHasPhase}>Add phase</button>
        </form>
      </>}
      {modal.kind === "details" && selectedRow && <>
        <h3>Identities</h3><dl><dt>App conversation</dt><dd>{selectedRow.sessionId || "No App session"}</dd><dt>Native conversation</dt><dd>{selectedRow.ref?.nativeId || selectedRow.conversation?.ref.nativeId || "Unavailable"}</dd><dt>Native authority</dt><dd>{selectedRow.ref?.authorityId || selectedRow.conversation?.ref.authorityId || "Unavailable"}</dd><dt>Repository</dt><dd>{overview.repositoryId}</dd><dt>Enrollment</dt><dd>{membershipLabel(selectedRow)}</dd><dt>Registered</dt><dd>{selectedRow.conversation?.createdAt || "Not registered in this repository"}</dd></dl>
        <h3>Pinned execution checkout</h3><p className="workstream-conversation-identity">{selectedRow.conversation?.executionCheckout.path || admission?.binding.executionCheckout || "Unavailable"}</p>
        {selectedRow.conversation && <details><summary>Checkout pin details</summary><pre>{JSON.stringify(selectedRow.conversation.executionCheckout, null, 2)}</pre></details>}
        <h3>Assignment history</h3><ul className="workstream-conversation-history">{overview.workstreams.flatMap(item => item.phaseHistory).filter(item => selectedRow.ref && refKey(item.ref) === refKey(selectedRow.ref)).map(item => <li key={item.id}><strong>{phaseLabel(item.phase)}</strong> · {workstreamTitle(item.workstreamId)}<small>{item.startedAt} → {item.endedAt || "Active"}</small></li>)}</ul>
        {!overview.workstreams.some(item => item.phaseHistory.some(assignment => selectedRow.ref && refKey(assignment.ref) === refKey(selectedRow.ref))) && <p>No phase assignment history.</p>}
        <h3>Enrollment metadata</h3>{metadataLoading ? <p role="status">Loading connection metadata…</p> : admission ? <pre>{JSON.stringify(admission, null, 2)}</pre> : <p>{selectedRow.sessionId ? "No App admission metadata available." : "Connected through the native harness; no App admission record."}</p>}
        {metadataError && <details><summary>Connection metadata unavailable · Details</summary><pre>{metadataError}</pre></details>}
      </>}
      {issue && <div className="workstream-conversation-error"><p role="alert">{issue.message}</p><details><summary>Details</summary><pre>{issue.details}</pre></details></div>}
      {notice && <p role="status">{notice}</p>}
      {busy && <p role="status">Saving changes…</p>}
      <footer><button type="button" disabled={busy} onClick={closeModal}>{modal.kind === "details" || modal.kind === "phase" ? "Done" : "Cancel"}</button>
        {(modal.kind === "picker" || modal.kind === "destination") && <button type="button" disabled={busy || !selectedRow || !target || !!issue?.recovery || (!selectedRow.conversation && !selectedRow.sessionId)} onClick={() => addToWorkstream()}>{moving ? "Move conversation" : needsEnrollment ? "Connect and add" : "Add to workstream"}</button>}
        {modal.kind === "remove" && <button type="button" disabled={busy || !selectedRow?.ref} onClick={() => manage("associate", { workstreamId: null }, true)}>Remove from workstream</button>}
      </footer>
    </ShellDialog>}
  </section>;
}
