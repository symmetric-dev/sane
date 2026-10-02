import { useEffect, useMemo, useState } from "react";
import type { WorkspaceRecord } from "../src/catalog-contract";
import type { WorkstreamOverview } from "../src/workstreams-contract";
import { ShellDialog } from "./shell-dialog";
import { defaultFilterFor, type ConversationFilterState, type WorkstreamMembership } from "./conversation-filter";
import { refKey } from "./workstreams-client";
import type { Conversation } from "./types";
import { assignmentFilterChoices, assignmentLabel, assignmentValue } from "./assignment-semantics";

/** Join App conversations to repository workstream membership via native refs. */
export function buildWorkstreamMap(
  overview: WorkstreamOverview | null,
  conversations: Conversation[],
): Map<string, WorkstreamMembership> {
  const map = new Map<string, WorkstreamMembership>();
  if (!overview) return map;
  const assignments = overview.workstreams.flatMap(w => w.activePhases);
  for (const row of overview.conversations) {
    if (!row.sessionId) continue;
    const phases = assignments.filter(p => refKey(p.ref) === refKey(row.ref)).map(p => p.phase);
    map.set(row.sessionId, { workstreamId: row.conversation?.workstreamId ?? null, phases });
  }
  void conversations;
  return map;
}

export function workstreamOptions(overview: WorkstreamOverview | null): { value: string; label: string }[] {
  const options = [
    { value: "all", label: "All memberships" },
    { value: "unknown", label: "Unknown association" },
    { value: "unassigned", label: "Confirmed unassigned" },
  ];
  for (const w of overview?.workstreams ?? []) options.push({ value: `workstream:${w.workstream.id}`, label: w.workstream.title || w.workstream.id });
  return options;
}

export function phaseOptions(overview: WorkstreamOverview | null): string[] {
  return assignmentFilterChoices((overview?.workstreams ?? []).flatMap(w => w.activePhases.map(p => p.phase)));
}

type Props = {
  value: ConversationFilterState;
  onChange: (next: ConversationFilterState) => void;
  workspaces: WorkspaceRecord[];
  navigation: { workspaceId: string | null; worktreeId: string | null };
  overview: WorkstreamOverview | null;
  resultCount?: number;
  onClose: () => void;
};

export function ConversationFilterDialog({ value, onChange, workspaces, navigation, overview, resultCount, onClose }: Props) {
  const [draftQuery, setDraftQuery] = useState(value.query);
  useEffect(() => setDraftQuery(value.query), [value.query]);
  useEffect(() => {
    if (draftQuery === value.query) return;
    const timer = setTimeout(() => onChange({ ...value, query: draftQuery }), 160);
    return () => clearTimeout(timer);
    // onChange identity changes per render; depend on value fields instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftQuery]);

  const selectedWorkspace = useMemo(
    () => workspaces.find(w => w.workspaceId === (value.workspaceId !== "all" && value.workspaceId !== "unavailable" ? value.workspaceId : navigation.workspaceId)),
    [workspaces, value.workspaceId, navigation.workspaceId],
  );
  const worktreeChoices = useMemo(() => {
    if (value.workspaceId === "all" || value.workspaceId === "unavailable") return [];
    const ws = workspaces.find(w => w.workspaceId === value.workspaceId);
    return ws?.worktrees ?? [];
  }, [workspaces, value.workspaceId]);

  const set = (patch: Partial<ConversationFilterState>) => onChange({ ...value, ...patch });
  const reset = () => onChange(defaultFilterFor(navigation.workspaceId, navigation.worktreeId));

  return <ShellDialog title="Filter conversations" close={onClose}>
    <div className="filter-dialog" aria-label="Conversation filters">
      <label>Search<input value={draftQuery} onChange={e => setDraftQuery(e.target.value)} placeholder="Fuzzy title, path, harness, ID…" maxLength={200} /></label>
      <label>Workspace<select value={value.workspaceId ?? "all"} onChange={e => {
        const next = e.target.value as ConversationFilterState["workspaceId"];
        set({ workspaceId: next, worktreeId: next === "all" || next === "unavailable" ? "all" : value.worktreeId });
      }}>
        <option value="all">All recorded history</option>
        {workspaces.map(w => <option key={w.workspaceId} value={w.workspaceId}>{w.name}</option>)}
        <option value="unavailable">Unavailable workspace history</option>
      </select></label>
      <label>Worktree<select value={value.worktreeId ?? "all"} disabled={!worktreeChoices.length} onChange={e => set({ worktreeId: e.target.value })}>
        <option value="all">{selectedWorkspace ? "All worktrees in workspace" : "All worktrees"}</option>
        {worktreeChoices.map(t => <option key={t.worktreeId} value={t.worktreeId}>{t.alias || t.branch || t.root}</option>)}
      </select></label>
      <label>Harness<select value={value.harness} onChange={e => set({ harness: e.target.value as ConversationFilterState["harness"] })}>
        <option value="all">All harnesses</option><option value="claude-code">Claude Code</option><option value="opencode">OpenCode</option>
      </select></label>
      <label>Status<select value={value.status} onChange={e => set({ status: e.target.value as ConversationFilterState["status"] })}>
        <option value="all">All statuses</option>
        <option value="starting">starting</option><option value="running">running</option><option value="completed">completed</option>
        <option value="failed">failed</option><option value="interrupted">interrupted</option><option value="unknown">unknown</option>
      </select></label>
      <label>Workstream<select value={value.workstreamId} onChange={e => set({ workstreamId: e.target.value as ConversationFilterState["workstreamId"] })}>
        {workstreamOptions(overview).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select></label>
      <label>Assignment<select value={assignmentValue(value.phase)} onChange={e => set({ phase: e.target.value })}>
        <option value="all">All assignments</option>
        {phaseOptions(overview).map(p => <option key={p} value={p}>{assignmentLabel(p)}</option>)}
      </select></label>
      <button type="button" role="switch" aria-checked={!!value.showDeleted} className="filter-switch" onClick={() => set({ showDeleted: !value.showDeleted })}><span className="filter-switch-track" aria-hidden="true"><span className="filter-switch-thumb" /></span>Show hidden</button>
      {typeof resultCount === "number" && <p className="muted" role="status">{resultCount} match{resultCount === 1 ? "" : "es"}</p>}
      {!overview && <p className="muted">Workstream membership needs a repository workspace; unknown rows stay grouped as unknown.</p>}
      <div className="dialog-actions"><button type="button" onClick={reset}>Reset to current</button><button type="button" onClick={onClose}>Done</button></div>
    </div>
  </ShellDialog>;
}
