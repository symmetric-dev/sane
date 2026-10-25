import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { catalog } from "./catalog";
import { store, type State } from "./store";
import { harnessName, type Conversation } from "./types";
import { formatTitle } from "./conversation-filter";
import { buildWorkstreamMap } from "./conversation-filter-dialog";
import { Facts } from "./thread";
import { worktreeDisplay } from "./catalog-selector";
import { workerReference as knownWorker, knownWorker as hydratedWorker, openWorkerSession, useWorkerDiscovery, useWorkerPolling } from "./worker-client";
import { WorkerCard, WorkerSection } from "./worker-ui";
import { workerStatusLabel } from "./worker-presentation";
import { BranchLinks } from "./branch-ui";
import { usePreviewRuns, useWorkstreamOverview } from "./conversation-hooks";
import { ConversationSidebarList, useConversationSidebarModel } from "./conversation-sidebar";
import { displayProfile, profileDisplayLabel, savedProfileSnapshot } from "./profile-presentation";
import { assignmentLabel } from "./assignment-semantics";
import { subscribeWorkspace, workspaceEpoch } from "./workspace-store";

// Compatibility for callers that previously imported the neutral data hooks here.
export { useMessageHits, useWorkstreamOverview } from "./conversation-hooks";

const basename = (path?: string | null) => path?.split("/").filter(Boolean).at(-1) || path || "Conversation";

/** Legacy preview-only list. The shell now supplies one shared ConversationSidebar model. */
export function HistoryList({ state, previewId, onPreview }: { state: State; previewId: string | null; onPreview: (id: string) => void }) {
  const model = useConversationSidebarModel(state, "history", previewId ?? state.selected);
  return <ConversationSidebarList state={state} model={model} mode="history" selectedId={previewId} onSelect={onPreview} />;
}

/** Main-panel session metadata for History. Preview-only until an explicit open action. */
export function HistoryDetail({ state, previewId, onOpen }: { state: State; previewId: string | null; onOpen: (id: string) => void }) {
  const auth = useSyncExternalStore(subscribeWorkspace, workspaceEpoch);
  const conversation = state.conversations.find(c => c.id === previewId) ?? null;
  // A new preview, auth scope, or native identity must require a fresh opt-in.
  const scope = JSON.stringify([auth, state.config?.storeId, state.phase, previewId, conversation?.harness, conversation?.authorityId, conversation?.nativeSessionId, conversation?.cwd]);
  return <HistoryPreview key={scope} state={state} previewId={previewId} conversation={conversation} onOpen={onOpen} />;
}

/** Mounted only after explicit opt-in; unmounting cancels both polling hooks. */
function HistoryWorkerDetails({ sessionId, parentId, selected }: { sessionId: string; parentId?: string; selected: string }) {
  useWorkerDiscovery();
  // The store owns selected's tree; the mounted Thread owns its parent tree,
  // including while History is visible. Neither needs a second polling timer.
  const selectedParentId = selected ? knownWorker(selected)?.parent.sessionId : undefined;
  useWorkerPolling(sessionId !== selected && sessionId !== selectedParentId ? sessionId : null);
  useWorkerPolling(parentId && parentId !== selected && parentId !== selectedParentId && parentId !== sessionId ? parentId : null);
  const record = hydratedWorker(sessionId);
  return <>{record && <WorkerCard worker={record} />}<WorkerSection sessionId={sessionId} /></>;
}

function HistoryPreview({ state, previewId, conversation, onOpen }: { state: State; previewId: string | null; conversation: Conversation | null; onOpen: (id: string) => void }) {
  useWorkerDiscovery();
  const worker = conversation ? knownWorker(conversation.id) : undefined;
  const repository = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const [lookup, setLookup] = useState({ loading: false, complete: false, error: "" });
  const [retry, setRetry] = useState(0);
  const [workerDetails, setWorkerDetails] = useState(false);
  const hasConversation = !!conversation;
  const canLookup = state.phase === "ready" && !!state.config && !!state.conversationPage;
  useEffect(() => {
    // Sidebar/store summaries already carry preview metadata. Do not refresh on
    // row mutations, and do not retry a failed or missing lookup automatically.
    if (!previewId || hasConversation || !canLookup) return;
    const controller = new AbortController();
    setLookup({ loading: true, complete: false, error: "" });
    void store.ensureConversations([previewId], controller.signal).then(() => {
      if (!controller.signal.aborted) setLookup({ loading: false, complete: true, error: "" });
    }).catch(() => {
      if (!controller.signal.aborted) setLookup({ loading: false, complete: true, error: "Session summary could not be loaded." });
    });
    return () => controller.abort();
  }, [previewId, hasConversation, canLookup, retry]);
  const overview = useWorkstreamOverview(conversation?.workspaceId ?? null);
  const membershipMap = useMemo(() => buildWorkstreamMap(overview, []), [overview]);
  const membership = conversation ? membershipMap.get(conversation.id) : undefined;
  const { runs, loading, loadingMore, error, total, hasMore, loadMore, retry: retryRuns, refresh } = usePreviewRuns(conversation && state.phase === "ready" && state.config ? previewId : null, conversation ?? undefined);
  const summaryLoading = canLookup && (!lookup.complete || lookup.loading);
  if (!conversation) return <section className="history-detail" aria-label="Session preview"><p className="eyebrow">SESSION PREVIEW</p><h2>{previewId ? "Session preview" : "No session selected"}</h2>{previewId
    ? <p className="muted" role="status">{state.phase === "login" || !state.config ? "Sign in to load this session." : state.phase !== "ready" ? "Connecting…" : summaryLoading ? "Loading session…" : lookup.error || "This session is no longer in the active catalog."} {canLookup && !summaryLoading && <button type="button" onClick={() => setRetry(value => value + 1)}>Retry</button>}</p>
    : <p className="muted">Choose a session on the left to preview its metadata. Opening chat only happens via Open in Chat.</p>}</section>;
  const workspace = repository.workspaces.find(w => w.workspaceId === conversation.workspaceId);
  const worktree = workspace?.worktrees.find(t => t.worktreeId === conversation.worktreeId);
  const lastActivity = runs[0]?.endedAt || runs[0]?.createdAt || "";
  // Only this preview's fenced runs may provide legacy identity evidence.
  const snapshot = savedProfileSnapshot(conversation, runs[0]);
  const profile = displayProfile(store.profileSet(), snapshot);
  return <section className="history-detail" aria-label="Session preview">
    <p className="eyebrow">{worker ? "WORKER SESSION · PREVIEW" : "SESSION PREVIEW"}</p>
    {worker && <p><button type="button" onClick={() => { if (knownWorker(worker.parent.sessionId)) void openWorkerSession(worker.parent.sessionId); else onOpen(worker.parent.sessionId); }}>Parent conversation</button> · Parent run {worker.parent.runId}</p>}
    <div className="history-detail-header"><h2 title={conversation.title || undefined}>{formatTitle(conversation.title, basename(conversation.cwd))}</h2><span className={`status ${conversation.workerProtocol ?? conversation.status}`}>{conversation.workerProtocol ? workerStatusLabel(conversation.workerProtocol, conversation.status) : conversation.status}</span>{conversation.hidden && <span className="harness-badge">Hidden</span>}</div>
    <BranchLinks key={conversation.id} conversation={conversation} />
    <div className="history-detail-actions"><button type="button" className="primary-button" disabled={state.sending} onClick={() => worker ? void openWorkerSession(conversation.id) : onOpen(conversation.id)}>{worker ? "Open worker" : conversation.replacedBy ? "Open read-only transcript" : "Open in Chat"}</button>{!conversation.replacedBy && <button type="button" className="text-button" disabled={state.actionBusy} onClick={() => void (conversation.hidden ? store.unhide(conversation.id) : store.hide(conversation.id))}>{conversation.hidden ? "Unhide" : "Hide"}</button>}</div>
    <div className="history-detail-actions"><button type="button" aria-expanded={workerDetails} disabled={state.phase !== "ready" || !state.config} onClick={() => setWorkerDetails(value => !value)}>{workerDetails ? "Hide worker details" : "Load worker details"}</button></div>
    {conversation.directWorkerCount !== undefined && <p className="muted">Direct workers: {conversation.directWorkerCount.toLocaleString()} · Includes completed workers; excludes deeper descendants.</p>}
    {!workerDetails && <p className="muted">Worker details are closed. Load them to view worker status, results, and messages.</p>}
    {workerDetails && state.phase === "ready" && state.config && <HistoryWorkerDetails sessionId={conversation.id} parentId={worker?.parent.sessionId} selected={state.selected} />}
    <Facts values={[
      ["Conversation ID", conversation.id],
      ["Harness", harnessName(conversation.harness)],
      ["Native session ID", conversation.nativeSessionId],
      ["Launch directory", conversation.cwd],
      ["Workspace", workspace ? workspace.name : conversation.workspaceId || "Unavailable"],
      ["Worktree", worktree ? `${worktreeDisplay(worktree)} · ${worktree.root}` : conversation.worktreeId || "Unavailable"],
      ["Worktree state", worktree?.state],
      ["Saved model", conversation.model || runs[0]?.model || "No override saved"],
      ["Saved effort / variant", conversation.effort || runs[0]?.effort || "No override saved"],
      ["Agent", profileDisplayLabel(profile, snapshot)],
      ["Saved conversation role", snapshot.agent || "Base"],
      ["Saved profile ID", snapshot.profileId],
      ["Native agent selected", snapshot.nativeAgentSelected === undefined ? undefined : String(snapshot.nativeAgentSelected)],
      ["Workstream", membership?.workstreamId ? `${membership.workstreamId}${membership.phases.length ? ` · ${membership.phases.map(assignmentLabel).join(", ")}` : ""}` : "Unassigned"],
      ["Stored assignments", membership?.phases.join(", ")],
      ["Association", conversation.association ?? "Unavailable"],
      ["Last run ID", conversation.lastRunId],
      ["Attachment", conversation.attachment ? `${conversation.attachment.state}${conversation.attachment.error ? ` · ${conversation.attachment.error}` : ""}` : "None"],
      ["Availability", conversation.availability?.canSend ? "Can send" : conversation.availability?.reason || "Unavailable"],
    ]} />
    <p className="muted">Saved conversation configuration is independent of current profile defaults. Model and effort fall back to the latest recorded run for older sessions; these are saved settings, not live native observations.</p>
    <h3>Runs · {loading && !runs.length ? "loading…" : total === null ? `${runs.length.toLocaleString()} loaded` : `${runs.length.toLocaleString()} of ${total.toLocaleString()} loaded`}</h3>
    <div className="history-detail-actions"><button type="button" disabled={loading || loadingMore || state.phase !== "ready" || !state.config} onClick={refresh}>Refresh runs</button></div>
    {lastActivity && <p className="muted">Last activity: {lastActivity ? new Date(lastActivity).toLocaleString() : "Unknown"}</p>}
    {loading && <p className="muted" role="status">Loading runs…</p>}
    {error && <p className="notice error" role="alert">{error} <button type="button" disabled={loading || loadingMore} onClick={retryRuns}>Retry runs</button></p>}
    {!loading && !error && !runs.length && <p className="muted">No runs recorded for this session.</p>}
    {!!runs.length && <ul className="history-run-list">{runs.map(run => <li key={run.id}><span title={run.id}>{run.createdAt ? new Date(run.createdAt).toLocaleString() : run.id}</span><span className={`status ${run.status}`}>{run.status}</span>{run.model && <span className="muted">{run.model}</span>}{run.effort && <span className="muted">{run.effort}</span>}</li>)}</ul>}
    {hasMore && <button type="button" disabled={loading || loadingMore} onClick={loadMore}>{loadingMore ? "Loading more runs…" : "Show 20 more runs"}</button>}
    {loadingMore && <p className="muted" role="status">Loading more runs…</p>}
  </section>;
}
