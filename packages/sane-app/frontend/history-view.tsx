import { useMemo, useSyncExternalStore } from "react";
import { catalog } from "./catalog";
import { store, type State } from "./store";
import { harnessName } from "./types";
import { formatTitle } from "./conversation-filter";
import { buildWorkstreamMap } from "./conversation-filter-dialog";
import { Facts } from "./thread";
import { worktreeDisplay } from "./catalog-selector";
import { workerReference as knownWorker, knownWorker as hydratedWorker, openWorkerSession, useWorkerDiscovery, useWorkerPolling } from "./worker-client";
import { WorkerCard, WorkerSection } from "./worker-ui";
import { BranchLinks } from "./branch-ui";
import { usePreviewRuns, useWorkstreamOverview } from "./conversation-hooks";
import { ConversationSidebarList, useConversationSidebarModel } from "./conversation-sidebar";
import { displayProfile, profileDisplayLabel, savedProfileSnapshot } from "./profile-presentation";
import { assignmentLabel } from "./assignment-semantics";

// Compatibility for callers that previously imported the neutral data hooks here.
export { useMessageHits, useWorkstreamOverview } from "./conversation-hooks";

const basename = (path?: string | null) => path?.split("/").filter(Boolean).at(-1) || path || "Conversation";

/** Legacy preview-only list. The shell now supplies one shared ConversationSidebar model. */
export function HistoryList({ state, previewId, onPreview }: { state: State; previewId: string | null; onPreview: (id: string) => void }) {
  const model = useConversationSidebarModel(state, "history");
  return <ConversationSidebarList state={state} model={model} mode="history" selectedId={previewId} onSelect={onPreview} />;
}

/** Main-panel session metadata for History. Preview-only until an explicit open action. */
export function HistoryDetail({ state, previewId, onOpen }: { state: State; previewId: string | null; onOpen: (id: string) => void }) {
  useWorkerPolling(previewId !== state.selected ? previewId : null);
  useWorkerDiscovery();
  const worker = previewId ? knownWorker(previewId) : undefined;
  useWorkerPolling(worker?.parent.sessionId && worker.parent.sessionId !== state.selected ? worker.parent.sessionId : null);
  const record = previewId ? hydratedWorker(previewId) : undefined;
  const repository = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const conversation = state.conversations.find(c => c.id === previewId) ?? null;
  const overview = useWorkstreamOverview(conversation?.workspaceId ?? null);
  const membershipMap = useMemo(() => buildWorkstreamMap(overview, []), [overview]);
  const membership = conversation ? membershipMap.get(conversation.id) : undefined;
  const { runs, loading, error } = usePreviewRuns(previewId);
  if (!conversation) return <section className="history-detail" aria-label="Session preview"><p className="eyebrow">SESSION PREVIEW</p><h2>No session selected</h2><p className="muted">Choose a session on the left to preview its metadata. Opening chat only happens via Open in Chat.</p></section>;
  const workspace = repository.workspaces.find(w => w.workspaceId === conversation.workspaceId);
  const worktree = workspace?.worktrees.find(t => t.worktreeId === conversation.worktreeId);
  const lastActivity = runs[0]?.endedAt || runs[0]?.createdAt || "";
  // Only this preview's fenced runs may provide legacy identity evidence.
  const snapshot = savedProfileSnapshot(conversation, runs[0]);
  const profile = displayProfile(store.profileSet(), snapshot);
  return <section className="history-detail" aria-label="Session preview">
    <p className="eyebrow">{worker ? "WORKER SESSION · READ-ONLY" : "SESSION PREVIEW"}</p>
    {worker && <p><button type="button" onClick={() => { if (knownWorker(worker.parent.sessionId)) void openWorkerSession(worker.parent.sessionId); else onOpen(worker.parent.sessionId); }}>Parent conversation</button> · Parent run {worker.parent.runId}</p>}
    <div className="history-detail-header"><h2 title={conversation.title || undefined}>{formatTitle(conversation.title, basename(conversation.cwd))}</h2><span className={`status ${conversation.status}`}>{conversation.status}</span>{conversation.hidden && <span className="harness-badge">Hidden</span>}</div>
    <BranchLinks key={conversation.id} conversation={conversation} />
    <div className="history-detail-actions"><button type="button" className="primary-button" disabled={state.sending} onClick={() => worker ? void openWorkerSession(conversation.id) : onOpen(conversation.id)}>{worker ? "Open worker" : conversation.replacedBy ? "Open read-only transcript" : "Open in Chat"}</button>{!conversation.replacedBy && <button type="button" className="text-button" disabled={state.actionBusy} onClick={() => void (conversation.hidden ? store.unhide(conversation.id) : store.hide(conversation.id))}>{conversation.hidden ? "Unhide" : "Hide"}</button>}</div>
    {record && <WorkerCard worker={record} />}
    <WorkerSection sessionId={conversation.id} />
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
    <h3>Runs · {loading ? "loading…" : runs.length}</h3>
    {lastActivity && <p className="muted">Last activity: {lastActivity ? new Date(lastActivity).toLocaleString() : "Unknown"}</p>}
    {loading && <p className="muted" role="status">Loading runs…</p>}
    {error && <p className="notice error" role="alert">{error}</p>}
    {!loading && !error && !runs.length && <p className="muted">No runs recorded for this session.</p>}
    {!!runs.length && <ul className="history-run-list">{runs.map(run => <li key={run.id}><span title={run.id}>{run.createdAt ? new Date(run.createdAt).toLocaleString() : run.id}</span><span className={`status ${run.status}`}>{run.status}</span>{run.model && <span className="muted">{run.model}</span>}{run.effort && <span className="muted">{run.effort}</span>}</li>)}</ul>}
  </section>;
}
