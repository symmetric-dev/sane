import { useEffect, useMemo, useState } from "react";
import type { WorkspaceRecord } from "../src/catalog-contract";
import type { WorkstreamOverview } from "../src/workstreams-contract";
import { ShellDialog } from "./shell-dialog";
import { defaultFilterFor, type ConversationFilterState, type WorkstreamMembership } from "./conversation-filter";
import { refKey } from "./workstreams-client";
import type { Conversation } from "./types";
import { assignmentFilterChoices, assignmentLabel, assignmentValue } from "./assignment-semantics";
import { FilterDropdown } from "./filter-dropdown";

/** Join App conversations to repository workstream membership via native refs. */
export function buildWorkstreamMap(
  overview: WorkstreamOverview | null,
  conversations: Conversation[],
): Map<string, WorkstreamMembership> {
  const map = new Map<string, WorkstreamMembership>();
  if (!overview) return map;
  const assignments = overview.workstreams.flatMap(w => w.activePhases);
  const phasesByRef = new Map<string, string[]>();
  for (const assignment of assignments) {
    const key = refKey(assignment.ref);
    const phases = phasesByRef.get(key) ?? [];
    phases.push(assignment.phase);
    phasesByRef.set(key, phases);
  }
  for (const row of overview.conversations) {
    if (!row.sessionId) continue;
    const phases = phasesByRef.get(refKey(row.ref)) ?? [];
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
  defaults?: ConversationFilterState;
  resultCount?: number;
  onClose: () => void;
};

export function ConversationFilterDialog({ value, onChange, workspaces, navigation, overview, defaults, resultCount, onClose }: Props) {
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
  const reset = () => onChange(defaults ?? defaultFilterFor(navigation.workspaceId, navigation.worktreeId));

  return <ShellDialog title="Filter conversations" close={onClose}>
    <div className="filter-dialog" aria-label="Conversation filters">
      <label>Search<input value={draftQuery} onChange={e => setDraftQuery(e.target.value)} placeholder="Fuzzy title, path, harness, ID…" maxLength={200} /></label>
      <FilterDropdown label="Workspace" value={value.workspaceId ?? "all"} onChange={next => {
        set({ workspaceId: next, worktreeId: next === "all" || next === "unavailable" ? "all" : value.worktreeId });
      }} options={[
        { value: "all", label: "All recorded history" },
        ...workspaces.map(w => ({ value: w.workspaceId, label: w.name })),
        { value: "unavailable", label: "Unavailable workspace history" },
      ]} />
      <FilterDropdown label="Workstream" value={value.workstreamId} onChange={next => set({ workstreamId: next })} options={workstreamOptions(overview)} />
      <FilterDropdown label="Worktree" value={value.worktreeId ?? "all"} disabled={!worktreeChoices.length} onChange={next => set({ worktreeId: next })} options={[
        { value: "all", label: selectedWorkspace ? "All worktrees in workspace" : "All worktrees" },
        ...worktreeChoices.map(t => ({ value: t.worktreeId, label: t.alias || t.branch || t.root })),
      ]} />
      <FilterDropdown label="Harness" value={value.harness} onChange={next => set({ harness: next as ConversationFilterState["harness"] })} options={[
        { value: "all", label: "All harnesses" }, { value: "claude-code", label: "Claude Code" }, { value: "opencode", label: "OpenCode" },
      ]} />
      <FilterDropdown label="Phase" value={assignmentValue(value.phase)} onChange={next => set({ phase: next })} options={[
        { value: "all", label: "All phases" },
        ...phaseOptions(overview).map(p => ({ value: p, label: assignmentLabel(p) })),
      ]} />
      <FilterDropdown label="Status" value={value.status} onChange={next => set({ status: next as ConversationFilterState["status"] })} options={[
        { value: "all", label: "All statuses" },
        ...["starting", "running", "completed", "failed", "interrupted", "unknown"].map(status => ({ value: status, label: status })),
      ]} />
      <button type="button" role="switch" aria-checked={!!value.showDeleted} className="filter-switch" onClick={() => set({ showDeleted: !value.showDeleted })}><span className="filter-switch-track" aria-hidden="true"><span className="filter-switch-thumb" /></span>Show hidden</button>
      {typeof resultCount === "number" && <p className="muted" role="status">{resultCount} match{resultCount === 1 ? "" : "es"}</p>}
      {!overview && <p className="muted">Workstream membership needs a repository workspace; unknown rows stay grouped as unknown.</p>}
      <div className="dialog-actions"><button type="button" onClick={reset}>Reset to current</button><button type="button" onClick={onClose}>Done</button></div>
    </div>
  </ShellDialog>;
}
