import { Fragment, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { FiBookOpen, FiCompass, FiCopy, FiGlobe, FiGrid, FiHexagon, FiLayers, FiSettings, FiTool } from "react-icons/fi";
import type { LifecyclePhase } from "sane-core/contracts";
import type { WorkstreamAction, WorkstreamActionInput, WorkstreamActionResult, WorkstreamOverview } from "../src/workstreams-contract";
import { catalog } from "./catalog";
import { ShellDialog } from "./shell-dialog";
import { FlowLauncher } from "./flow-launcher";
import type { Conversation } from "./types";
import { refKey, workstreamRequest } from "./workstreams-client";
import { refreshWorkstreamOverview, useWorkstreamOverviewState } from "./workstream-overview";
import type { DocumentReviewStart, ReviewPhase } from "./document-review-model";
import { assignmentClass, assignmentDocumentDefault, assignmentLabel, assignmentStats, supportAssignments } from "./assignment-semantics";
import "./workstream-actions.css";

type Detail = WorkstreamOverview["workstreams"][number];
const tabs = ["root", "support", "design", "engineering", "planning", "execution"] as const;
type Tab = typeof tabs[number];
const icons = { root: FiGlobe, support: FiLayers, design: FiHexagon, engineering: FiSettings, planning: FiCopy, execution: FiTool };
const label = (value: string) => value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, " ");
const isPhase = (tab: Tab): tab is LifecyclePhase => tab !== "root" && tab !== "support";

/** Shared workspace read, with imperative refreshes fenced to the current chat. */
function useActionMembership(workspaceId: string | null, sessionId: string | null, active: boolean) {
  const scope = JSON.stringify([workspaceId, sessionId, active]);
  const fence = useRef({ scope, epoch: 0 });
  if (fence.current.scope !== scope) fence.current = { scope, epoch: fence.current.epoch + 1 };
  const state = useWorkstreamOverviewState(workspaceId, active && !!sessionId);
  useEffect(() => {
    return () => { fence.current.epoch++; };
  }, [scope]);
  async function refresh() {
    if (!workspaceId || !sessionId || !active) throw new Error("Chat is inactive");
    const epoch = ++fence.current.epoch;
    await refreshWorkstreamOverview(workspaceId, { force: true });
    if (fence.current.scope !== scope || fence.current.epoch !== epoch) throw new Error("Chat changed");
  }
  return { overview: state.overview, loading: active && !state.overview && state.loading, failed: active && !!state.error, retry: () => { void refresh().catch(() => {}); }, refresh };
}

export function ChatWorkstreamActions({ conversation, active, onDocuments }: { conversation?: Conversation; active: boolean; onDocuments?: (identity: DocumentReviewStart) => void }) {
  const { workspaces } = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  // Chat association, never the workspace currently being browsed in Settings.
  const workspaceId = conversation?.workspaceId ?? null;
  const workspace = workspaces.find(item => item.workspaceId === workspaceId);
  const eligible = active && !!conversation && !conversation.replacedBy && workspace?.kind === "repository";
  const membership = useActionMembership(workspaceId, conversation?.id ?? null, eligible);
  const rows = membership.overview?.conversations.filter(row => row.sessionId === conversation?.id) ?? [];
  const workstreamId = rows.length === 1 ? rows[0].conversation?.workstreamId : null;
  const detail = membership.overview?.workstreams.find(item => item.workstream.id === workstreamId);
  const scope = JSON.stringify([workspaceId, conversation?.id, conversation?.replacedBy, active, eligible]);
  const currentScope = useRef(scope); currentScope.current = scope;
  const trigger = useRef<HTMLButtonElement>(null);
  const [opened, setOpened] = useState<{ scope: string; detail: Detail } | null>(null);
  useEffect(() => { setOpened(null); }, [scope]);
  const reason = !active ? "Open this chat to use Actions" : !conversation ? "Select an existing conversation" : conversation.replacedBy ? "This chat was replaced" : !workspaceId ? "This chat has no workspace" : workspace?.kind === "directory" ? "Actions require a repository" : !workspace ? "Chat workspace is unavailable" : membership.loading ? "Loading workstream membership…" : membership.failed ? "Workstream membership unavailable; retry loading" : !rows.length || !rows[0].conversation ? "This chat is not enrolled" : !workstreamId ? "This chat is unassigned" : !detail ? "Workstream unavailable" : "Workstream actions";
  const assignments = detail?.activePhases.filter(assignment => refKey(assignment.ref) === refKey(rows[0]?.ref ?? null)) ?? [];
  const defaultPhase = assignmentDocumentDefault(assignments);
  const flowsTrigger = useRef<HTMLButtonElement>(null);
  const membershipReady = eligible && !membership.loading && !membership.failed;
  const flowsAvailable = membershipReady && !!detail && !!onDocuments;
  const flowsReason = !active ? "Open this chat to use Flows"
    : conversation && !conversation.replacedBy && workspace?.kind === "directory" ? "Flows require a repository"
    : membershipReady && rows.length > 1 ? "Chat workstream membership is ambiguous"
    : membershipReady && (!rows.length || !rows[0].conversation) ? "Enroll this chat and assign a workstream to use Flows"
    : membershipReady && !workstreamId ? "Assign this chat to a workstream to use Flows"
    : flowsAvailable ? "Flows" : reason;
  const flowsScope = JSON.stringify([scope, conversation?.worktreeId, workspace?.commonDir, detail?.workstream.repositoryId, workstreamId, flowsAvailable]);
  const currentFlowsScope = useRef(flowsScope); currentFlowsScope.current = flowsScope;
  const [flowsOpened, setFlowsOpened] = useState<{ scope: string; identity: DocumentReviewStart; title: string } | null>(null);
  useEffect(() => { setFlowsOpened(null); }, [flowsScope]);
  function openFlows() {
    if (!flowsAvailable || !workspaceId || !conversation || !detail) return;
    // Pin the launch target now; choosing a card must never retarget another chat.
    setFlowsOpened({ scope: flowsScope, identity: { sessionId: conversation.id, workspaceId, repositoryId: detail.workstream.repositoryId, workstreamId: detail.workstream.id, phase: defaultPhase }, title: detail.workstream.title });
  }
  const documents = (phase: ReviewPhase = defaultPhase) => {
    if (!eligible || !workspaceId || !conversation || !detail || !onDocuments) return;
    onDocuments({ sessionId: conversation.id, workspaceId, repositoryId: detail.workstream.repositoryId, workstreamId: detail.workstream.id, phase });
  };
  return <>
    <button ref={trigger} type="button" className="composer-workstream-actions" disabled={!eligible || !detail || membership.loading || membership.failed} title={reason} aria-label={`Actions: ${reason}`} aria-haspopup="dialog" aria-expanded={!!opened && opened.scope === scope} onClick={() => { if (detail && eligible) setOpened({ scope, detail }); }}><FiCompass size={16} aria-hidden="true" /></button>
    {onDocuments && <button ref={flowsTrigger} type="button" className="composer-flows" disabled={!flowsAvailable} title={flowsReason} aria-label={flowsAvailable ? "Flows" : `Flows: ${flowsReason}`} aria-haspopup="dialog" aria-expanded={flowsOpened?.scope === flowsScope} onClick={openFlows}><FiGrid size={14} aria-hidden="true" />Flows</button>}
    {eligible && membership.failed && <button type="button" className="text-button composer-actions-retry" title="Retry workstream membership" aria-label="Retry workstream membership" onClick={membership.retry}>Retry</button>}
    {eligible && workspaceId && conversation && opened?.scope === scope && <WorkstreamActionsDialog key={scope} workspaceId={workspaceId} detail={opened.detail} sessionId={conversation.id} close={() => setOpened(null)} restoreFocus={() => currentScope.current === scope && trigger.current?.isConnected && !trigger.current.disabled ? trigger.current : document.body} isCurrent={() => currentScope.current === scope} onChanged={membership.refresh} onDocuments={onDocuments ? phase => { setOpened(null); documents(phase); } : undefined} />}
    {flowsAvailable && flowsOpened?.scope === flowsScope && <FlowLauncher key={flowsScope} subtitle={flowsOpened.title} close={() => setFlowsOpened(null)} restoreFocus={() => currentFlowsScope.current === flowsScope && flowsTrigger.current?.isConnected && !flowsTrigger.current.disabled ? flowsTrigger.current : document.body} onSelect={flow => {
      if (flow !== "review-documents" || currentFlowsScope.current !== flowsOpened.scope || !flowsAvailable) return;
      setFlowsOpened(null);
      onDocuments?.(flowsOpened.identity);
    }} />}
  </>;
}

export function WorkstreamActionsDialog({ workspaceId, detail: initialDetail, sessionId, close, restoreFocus, onChanged, isCurrent = () => true, onDocuments }: {
  workspaceId: string;
  detail: Detail;
  sessionId?: string;
  close: () => void;
  restoreFocus?: () => HTMLElement | null;
  onChanged: () => Promise<void>;
  isCurrent?: () => boolean;
  onDocuments?: (phase: ReviewPhase) => void;
}) {
  const id = useId();
  const [tab, setTab] = useState<Tab>("root");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [readFailed, setReadFailed] = useState(false), [refreshFailed, setRefreshFailed] = useState(false);
  const [outcome, setOutcome] = useState("");
  const [confirm, setConfirm] = useState(false), [approvalRef, setApprovalRef] = useState("");
  const guard = useRef({ mounted: true, epoch: 0, locked: false });
  const callbacks = useRef({ onChanged, isCurrent }); callbacks.current = { onChanged, isCurrent };
  // Keep identity captured at opening. A changed binding must not retarget a write.
  const identity = useRef({ workspaceId, repositoryId: initialDetail.workstream.repositoryId, id: initialDetail.workstream.id, sessionId }).current;
  const current = (epoch: number) => guard.current.mounted && guard.current.epoch === epoch && callbacks.current.isCurrent();

  async function read(epoch: number) {
    const overview = await refreshWorkstreamOverview(identity.workspaceId, { force: true });
    if (!current(epoch)) throw new Error("Scope changed");
    if (overview.repositoryId !== identity.repositoryId) throw new Error("Repository changed");
    const fresh = overview.workstreams.find(item => item.workstream.id === identity.id);
    if (!fresh || fresh.workstream.repositoryId !== identity.repositoryId) throw new Error("Workstream unavailable");
    if (identity.sessionId) {
      const rows = overview.conversations.filter(row => row.sessionId === identity.sessionId);
      if (rows.length !== 1 || rows[0].conversation?.workstreamId !== identity.id) throw new Error("Membership changed");
    }
    setDetail(fresh);
    return fresh;
  }

  useEffect(() => {
    guard.current.mounted = true;
    const epoch = ++guard.current.epoch;
    void read(epoch).then(() => { if (current(epoch)) { setLoading(false); setReadFailed(false); } }).catch(() => { if (current(epoch)) { setLoading(false); setReadFailed(true); } });
    return () => { guard.current.mounted = false; guard.current.epoch++; };
  }, []);

  async function refresh() {
    if (guard.current.locked || !callbacks.current.isCurrent()) return;
    guard.current.locked = true;
    const epoch = ++guard.current.epoch;
    setBusy(true); setLoading(true);
    try {
      await read(epoch);
      if (!current(epoch)) return;
      await callbacks.current.onChanged();
      if (current(epoch)) { setReadFailed(false); setRefreshFailed(false); }
    } catch {
      if (current(epoch)) setReadFailed(true);
    } finally {
      if (current(epoch)) { guard.current.locked = false; setBusy(false); setLoading(false); }
    }
  }

  async function act(action: WorkstreamAction) {
    if (!isPhase(tab) || !detail || loading || readFailed || refreshFailed || guard.current.locked || !callbacks.current.isCurrent() || action === "approve" && (!confirm || !approvalRef.trim())) return;
    guard.current.locked = true;
    const epoch = ++guard.current.epoch, phase = tab;
    setBusy(true); setOutcome("");
    // Fresh revision + membership immediately before each explicit operation.
    try {
      const fresh = await read(epoch);
      if (!current(epoch)) return;
      const input: WorkstreamActionInput = { id: identity.id, phase, repositoryId: identity.repositoryId, expectedRevision: fresh.workstream.revision, ...(identity.sessionId ? { sessionId: identity.sessionId } : {}), ...(action === "approve" ? { approvalRef: approvalRef.trim() } : {}) };
      const result = await workstreamRequest<WorkstreamActionResult>(identity.workspaceId, action, input);
      if (!current(epoch)) return;
      setOutcome(result.ok ? action === "validate" ? "Valid" : action === "approve" ? "Approved" : "Provided" : action === "validate" ? "Validation failed" : "Action failed");
      setConfirm(false); setApprovalRef("");
      // The operation has returned: a subsequent read error must never replay it.
      try {
        await read(epoch);
        if (!current(epoch)) return;
        await callbacks.current.onChanged();
        if (current(epoch)) { setReadFailed(false); setRefreshFailed(false); }
      } catch { if (current(epoch)) setRefreshFailed(true); }
    } catch {
      if (current(epoch)) { setOutcome("Action failed"); setReadFailed(true); setConfirm(false); setApprovalRef(""); }
    } finally {
      if (current(epoch)) { guard.current.locked = false; setBusy(false); }
    }
  }

  function select(next: Tab) {
    if (guard.current.locked) return;
    setTab(next); setConfirm(false); setApprovalRef(""); setOutcome("");
  }
  const blocked = loading || busy || readFailed || refreshFailed || !detail;
  const phaseStatus = (phase: LifecyclePhase) => detail?.workstream.lifecycle.phases.find(row => row.phase === phase)?.status;
  const conversations = (phase: LifecyclePhase) => detail?.activePhases.filter(row => row.phase === phase).length ?? 0;
  const confirmLabel = tab === "planning" ? "Approve & register jobs" : tab === "execution" ? "Approve & complete jobs" : "Confirm approval";

  return <ShellDialog title="Workstream" subtitle={detail?.workstream.title ?? initialDetail.workstream.title} close={() => { if (!guard.current.locked) close(); }} closeDisabled={busy} restoreFocus={restoreFocus} className="workstream-actions-dialog">
    <div className="workstream-actions-layout">
      <div className="workstream-actions-binder" role="tablist" aria-label="Workstream actions" aria-orientation="vertical">
        {tabs.map((value, index) => {
          const Icon = icons[value];
          return <Fragment key={value}>{value === "design" && <span className="workstream-actions-divider" role="presentation" />}<button type="button" role="tab" className={`workstream-action-tab ${isPhase(value) ? `phase-${value}` : "is-overview"}`} id={`${id}-tab-${value}`} aria-label={label(value)} title={label(value)} aria-selected={tab === value} aria-controls={`${id}-panel`} tabIndex={tab === value ? 0 : -1} disabled={busy} onClick={() => select(value)} onKeyDown={event => {
            if (busy || !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[tabs.length - 1] : tabs[(index + (event.key === "ArrowDown" ? 1 : tabs.length - 1)) % tabs.length];
            select(next); document.getElementById(`${id}-tab-${next}`)?.focus();
          }}><Icon size={18} aria-hidden="true" /></button></Fragment>;
        })}
      </div>
      <section className="workstream-actions-panel" role="tabpanel" tabIndex={0} id={`${id}-panel`} aria-labelledby={`${id}-tab-${tab}`}>
        {loading && <p className="muted" role="status">Loading…</p>}
        {detail && !loading && <>
          {tab === "root" ? <>
            <div className="workstream-actions-summary"><strong>{label(detail.workstream.type)}</strong><span>{label(detail.workstream.lifecycle.status)}</span></div>
            <div className="workstream-actions-phase-summary">{tabs.filter(isPhase).map(phase => <div key={phase}><span className={`workstream-actions-phase-label phase-${phase}`}>{label(phase)}</span><span>{phaseStatus(phase) ? label(phaseStatus(phase)!) : "Unavailable"}</span></div>)}</div>
            <p className="muted workstream-actions-counts">{detail.workstream.lifecycle.jobs.length} jobs · {detail.conversations.length} conversations</p>
          </> : tab === "support" ? <>
            {supportAssignments.map(track => {
              const stats = assignmentStats(detail.activePhases, track.name);
              return <div key={track.name} className="workstream-actions-track"><strong className={assignmentClass(track.name)}>{assignmentLabel(track.name)}</strong><span>{stats.assignments} active assignments · {stats.conversations} distinct conversations{track.name === "research" && ` · ${detail.research.registered.length} registered reports`}</span></div>;
            })}
          </> : <>
            <div className="workstream-actions-summary"><strong className={`workstream-actions-phase-label phase-${tab}`}>{label(tab)}</strong><span>{phaseStatus(tab) ? label(phaseStatus(tab)!) : "Unavailable"}</span></div>
            <p className="muted workstream-actions-counts">{conversations(tab)} active conversations{(tab === "planning" || tab === "execution") && ` · ${detail.workstream.lifecycle.jobs.length} jobs`}</p>
          </>}
        </>}
        {outcome && <p className="workstream-actions-outcome" role="status">{outcome}</p>}
        {(readFailed || refreshFailed) && <div className="workstream-actions-read-error"><span role="status">{refreshFailed ? "Refresh failed; action was not retried." : outcome === "Action failed" ? "Refresh before trying another action." : "Couldn't load current state."}</span><button type="button" className="text-button" disabled={busy} onClick={() => void refresh()}>Refresh</button></div>}
        {/* Overview tabs select workstream-wide scope, not the conversation's assignment default. */}
        {onDocuments && <button type="button" className="text-button" disabled={blocked || confirm} onClick={() => onDocuments(isPhase(tab) ? tab : "all")}><FiBookOpen size={14} aria-hidden="true" />{isPhase(tab) ? "Read documents" : "Read all documents"}</button>}
        {isPhase(tab) && <footer className="workstream-actions-footer">
          {confirm && <div role="group" aria-label="Approval confirmation" className="workstream-actions-confirm">
            <label htmlFor={`${id}-approval`}>Approval reference</label><input autoFocus id={`${id}-approval`} value={approvalRef} required disabled={busy} placeholder="Approval reference" onChange={event => setApprovalRef(event.target.value)} onKeyDown={event => {
              if (event.key !== "Enter") return;
              event.preventDefault(); event.stopPropagation();
              void act("approve");
            }} />
            <div><button type="button" disabled={blocked || !approvalRef.trim()} onClick={() => void act("approve")}>{confirmLabel}</button><button type="button" disabled={busy} onClick={() => { setConfirm(false); setApprovalRef(""); }}>Cancel</button></div>
          </div>}
          <div className="workstream-actions-buttons"><button type="button" disabled={blocked || confirm} onClick={() => void act("validate")}>Validate</button><button type="button" disabled={blocked || confirm} onClick={() => setConfirm(true)}>Approve</button><button type="button" disabled={blocked || confirm} onClick={() => void act("provide")}>Provide</button></div>
        </footer>}
      </section>
    </div>
  </ShellDialog>;
}
