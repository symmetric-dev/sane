import { useEffect, useRef, useState } from "react";
import type { WorkstreamDocument, WorkstreamDocumentCatalog, WorkstreamDocumentPhase } from "../src/workstreams-contract";
import { catalog } from "./catalog";
import { store, type SendOutcome, type State } from "./store";
import { refKey, workstreamRequest } from "./workstreams-client";
import { refreshWorkstreamOverview } from "./workstream-overview";
import { assignmentDocumentDefault } from "./assignment-semantics";

export const reviewPhases: WorkstreamDocumentPhase[] = ["design", "engineering", "planning", "execution", "research", "resources"];
export type ReviewPhase = WorkstreamDocumentPhase | "all";
export type DocumentReviewStart = { sessionId: string; workspaceId: string; repositoryId: string; workstreamId: string; phase?: ReviewPhase; mode?: "review" | "search" };
type DocumentScope = ReviewPhase | "none";
type Entry = { feedback: string; savedFeedback: string; decision?: "accepted" | "needs-changes"; revision?: string; content?: string; readRevision?: string; changed?: boolean };
type Flow = { identity: DocumentReviewStart; mode: "review" | "search"; phase: DocumentScope; documents: WorkstreamDocument[]; selected: string[]; entries: Record<string, Entry>; path: string | null; fragment?: string; loading: boolean; reading: boolean; busy: boolean; error: string; confirmCancel: boolean; unknown: boolean };
const emptyEntry = (): Entry => ({ feedback: "", savedFeedback: "" });
const scopeOf = (state: State) => {
  const conversation = state.conversations.find(item => item.id === state.selected);
  const workspace = catalog.state.workspaces.find(item => item.workspaceId === conversation?.workspaceId);
  return JSON.stringify([state.selected, conversation?.workspaceId, conversation?.worktreeId, conversation?.replacedBy, workspace?.commonDir, workspace?.kind, state.phase]);
};
const eligible = (document: WorkstreamDocument, phase: DocumentScope) => document.exists && document.kind !== "resource" && document.phase !== "resources" && (phase === "all" || document.phase === phase);
const initialSelection = (documents: WorkstreamDocument[], phase: DocumentScope) => documents.filter(document => eligible(document, phase)).map(document => document.path);
const reconcileSelection = (value: Flow, documents: WorkstreamDocument[]) => [...new Set([...value.selected.filter(path => documents.some(document => document.path === path && eligible(document, value.phase))), ...documents.filter(document => eligible(document, value.phase) && document.required).map(document => document.path)])];
const failure = (error: unknown) => error instanceof Error ? error.message : "Documents are unavailable. Try again.";

/** Local review state is isolated from the ordinary conversation draft and phase approval. */
export function useDocumentReview(state: State, active: boolean, sendDisabled: boolean, send: (text: string) => Promise<SendOutcome>) {
  const scope = scopeOf(state);
  const [flow, setFlow] = useState<Flow | null>(null);
  const currentFlow = useRef(flow); currentFlow.current = flow;
  const current = useRef({ scope, active, sendDisabled, send }); current.current = { scope, active, sendDisabled, send };
  const guard = useRef({ scope, epoch: 0, locked: false });
  if (guard.current.scope !== scope) guard.current = { scope, epoch: guard.current.epoch + 1, locked: false };
  const openedScope = useRef("");
  const submitting = useRef(false);
  const readerPositions = useRef(new Map<string, number>());
  useEffect(() => { if (openedScope.current !== scope) setFlow(null); }, [scope]);
  useEffect(() => () => { guard.current.epoch++; }, []);
  // Suspended flows retain edits, but any in-flight read must be retried on return.
  useEffect(() => {
    if (!active) {
      if (!submitting.current) { guard.current.epoch++; guard.current.locked = false; }
      setFlow(value => value ? { ...value, busy: submitting.current, reading: false, loading: false, error: value.loading || value.reading ? "Document loading was paused. Retry to continue." : value.error } : value);
    }
  }, [active]);
  const visible = openedScope.current === scope ? flow : null;
  const valid = (epoch: number) => guard.current.epoch === epoch && current.current.active && current.current.scope === openedScope.current && scopeOf(store.state) === openedScope.current;
  const update = (patch: Partial<Flow>) => {
    const scope = openedScope.current, epoch = guard.current.epoch, identity = currentFlow.current?.identity;
    setFlow(value => value && value.identity === identity && guard.current.epoch === epoch && openedScope.current === scope && current.current.scope === scope ? { ...value, ...patch } : value);
  };

  async function readCatalog(identity: DocumentReviewStart, epoch: number) {
    const overview = await refreshWorkstreamOverview(identity.workspaceId, { force: true });
    if (!valid(epoch)) throw new Error("Conversation changed; reopen Documents.");
    const members = overview.conversations.filter(row => row.sessionId === identity.sessionId);
    if (overview.repositoryId !== identity.repositoryId || members.length !== 1 || members[0].conversation?.repositoryId !== identity.repositoryId || members[0].conversation.workstreamId !== identity.workstreamId || !overview.workstreams.some(row => row.workstream.id === identity.workstreamId && row.workstream.repositoryId === identity.repositoryId)) throw new Error("Repository or workstream membership changed. Cancel and reopen Documents.");
    const result = await workstreamRequest<WorkstreamDocumentCatalog>(identity.workspaceId, "artifacts/catalog", { id: identity.workstreamId, repositoryId: identity.repositoryId });
    if (!valid(epoch)) throw new Error("Conversation changed; reopen Documents.");
    if (result.repositoryId !== identity.repositoryId || result.workstreamId !== identity.workstreamId) throw new Error("Document catalog belongs to another workstream.");
    const assignments = overview.workstreams.find(row => row.workstream.id === identity.workstreamId)!.activePhases.filter(assignment => refKey(assignment.ref) === refKey(members[0].conversation!.ref));
    const assignedPhase = assignmentDocumentDefault(assignments);
    const phase: DocumentScope = identity.mode === "search" ? "all" : assignedPhase === "all" ? "none" : assignedPhase;
    const documents = identity.mode === "search" ? result.documents : result.documents.filter(document => document.phase === phase);
    return { documents, phase };
  }

  async function start(identity: DocumentReviewStart) {
    if (!active || !state.selected || identity.sessionId !== state.selected || guard.current.locked) return;
    const conversation = store.state.conversations.find(item => item.id === identity.sessionId);
    if (conversation?.workspaceId !== identity.workspaceId || conversation.replacedBy) return;
    openedScope.current = scope;
    const epoch = ++guard.current.epoch, mode = identity.mode ?? "review", phase = mode === "search" ? "all" : "none";
    const next: Flow = { identity, mode, phase, documents: [], selected: [], entries: {}, path: null, loading: true, reading: false, busy: false, error: "", confirmCancel: false, unknown: false };
    currentFlow.current = next; setFlow(next);
    try {
      const result = await readCatalog(identity, epoch), resolvedPhase = result.phase;
      if (valid(epoch)) update({ documents: result.documents, phase: resolvedPhase, selected: initialSelection(result.documents, resolvedPhase), loading: false });
    } catch (error) { if (valid(epoch)) update({ error: failure(error), loading: false }); }
  }

  function reconciledEntries(value: Flow, documents: WorkstreamDocument[]) {
    return Object.fromEntries(Object.entries(value.entries).map(([path, entry]) => {
      const fresh = documents.find(document => document.path === path);
      const changed = !fresh?.exists || entry.revision && fresh.revision !== entry.revision || entry.readRevision && fresh.revision !== entry.readRevision;
      return [path, changed ? { ...entry, decision: undefined, revision: undefined, content: undefined, readRevision: undefined, changed: true } : entry];
    }));
  }

  function resetPhase(value: Flow, documents: WorkstreamDocument[], phase: DocumentScope) {
    const entries = Object.fromEntries(Object.entries(value.entries).map(([path, entry]) => [path, { ...entry, decision: undefined, revision: undefined, content: undefined, readRevision: undefined, changed: false }]));
    update({ phase, documents, entries, selected: initialSelection(documents, phase), path: null, fragment: undefined, loading: false, reading: false, confirmCancel: false, error: "Your assignment changed. Decisions were reset; your feedback is preserved." });
  }

  async function refresh() {
    const value = currentFlow.current;
    if (!value || guard.current.locked || !active) return;
    const epoch = ++guard.current.epoch; update({ loading: true, error: "" });
    try {
      const { documents, phase } = await readCatalog(value.identity, epoch);
      if (!valid(epoch)) return;
      if (value.mode === "review" && phase !== value.phase) { resetPhase(value, documents, phase); return; }
      update({ documents, entries: reconciledEntries(value, documents), selected: value.documents.length ? reconcileSelection(value, documents) : initialSelection(documents, value.phase), loading: false, ...(value.path && !documents.some(document => document.path === value.path && document.exists) ? { path: null, fragment: undefined, reading: false } : {}) });
    } catch (error) { if (valid(epoch)) update({ loading: false, error: failure(error) }); }
  }

  async function open(path: string, fragment?: string) {
    const value = currentFlow.current;
    const document = value?.documents.find(item => item.path === path);
    if (!value || !document?.exists || value.loading || guard.current.locked || !active || value.mode === "review" && document.phase !== value.phase) return;
    const epoch = ++guard.current.epoch;
    update({ path, fragment, reading: true, error: "", confirmCancel: false });
    try {
      const result = await workstreamRequest<{ content: string; revision: string }>(value.identity.workspaceId, "artifacts/read", { id: value.identity.workstreamId, path, repositoryId: value.identity.repositoryId });
      if (!valid(epoch)) return;
      setFlow(latest => {
        if (!latest || !valid(epoch) || latest.identity !== value.identity) return latest;
        const entry = latest.entries[path] ?? emptyEntry();
        const changed = !!entry.revision && entry.revision !== result.revision;
        return { ...latest, reading: false, documents: latest.documents.map(item => item.path === path ? { ...item, revision: result.revision } : item), entries: { ...latest.entries, [path]: { ...entry, content: result.content, readRevision: result.revision, ...(changed ? { decision: undefined, revision: undefined, changed: true } : {}) } } };
      });
    } catch (error) { if (valid(epoch)) update({ reading: false, error: failure(error) }); }
  }

  function edit(feedback: string) {
    if (guard.current.locked || !current.current.active || current.current.scope !== openedScope.current) return;
    setFlow(value => {
      if (!value?.path) return value;
      const entry = value.entries[value.path] ?? emptyEntry();
      return { ...value, entries: { ...value.entries, [value.path]: { ...entry, feedback, ...(feedback !== entry.savedFeedback ? { decision: undefined } : {}) } }, confirmCancel: false };
    });
  }
  function decide(decision: "accepted" | "needs-changes") {
    const value = currentFlow.current;
    const document = value?.documents.find(item => item.path === value.path);
    const entry = value?.path ? value.entries[value.path] : undefined;
    if (!active || !value?.path || value.reading || value.loading || guard.current.locked || value.error || !document || !eligible(document, value.mode === "review" ? value.phase : "all") || !entry?.readRevision || decision === "needs-changes" && !entry.feedback.trim()) return;
    update({ entries: { ...value.entries, [value.path]: { ...entry, decision, savedFeedback: entry.feedback, revision: entry.readRevision, changed: false } }, path: null, fragment: undefined });
  }
  function picker() {
    if (guard.current.locked) return;
    guard.current.epoch++; update({ path: null, fragment: undefined, reading: false, loading: false, error: "", confirmCancel: false });
  }
  function phase(phase: ReviewPhase) {
    const value = currentFlow.current;
    if (!value || value.mode !== "search" || value.loading || guard.current.locked) return;
    update({ phase, selected: initialSelection(value.documents, phase), confirmCancel: false });
  }
  function select(path: string, checked: boolean) {
    const value = currentFlow.current;
    const document = value?.documents.find(item => item.path === path);
    if (!value || value.loading || guard.current.locked || !document || !eligible(document, value.phase) || !checked && document.required) return;
    update({ selected: checked ? [...new Set([...value.selected, path])] : value.selected.filter(item => item !== path) });
  }
  function cancel(force = false) {
    if (guard.current.locked) return;
    const meaningful = Object.values(currentFlow.current?.entries ?? {}).some(entry => !!entry.feedback.trim() || !!entry.decision);
    if (meaningful && !force) { update({ confirmCancel: true }); return; }
    guard.current.epoch++; setFlow(null); currentFlow.current = null;
  }
  const ready = !!visible?.selected.length && !visible.loading && !visible.reading && !visible.busy && !visible.error && !visible.unknown && visible.selected.every(path => {
    const document = visible.documents.find(item => item.path === path), entry = visible.entries[path];
    return !!document && eligible(document, visible.phase) && !!entry?.decision && entry.revision === document.revision && entry.feedback === entry.savedFeedback;
  });

  async function submit() {
    const value = currentFlow.current;
    if (!value || !ready || current.current.sendDisabled || guard.current.locked || !active) return;
    guard.current.locked = true;
    const epoch = ++guard.current.epoch;
    let sendAttempted = false;
    update({ busy: true, error: "" });
    try {
      const { documents, phase } = await readCatalog(value.identity, epoch);
      if (!valid(epoch)) return;
      if (value.mode === "review" && phase !== value.phase) { resetPhase(value, documents, phase); return; }
      const entries = reconciledEntries(value, documents);
      // Recheck both catalog hashes and actual read hashes. No changed document is accepted implicitly.
      let changed = false;
      for (const path of value.selected) {
        const document = documents.find(item => item.path === path), entry = entries[path];
        if (!document || !eligible(document, value.phase) || !entry?.decision || entry.revision !== document.revision) { changed = true; continue; }
        const read = await workstreamRequest<{ content: string; revision: string }>(value.identity.workspaceId, "artifacts/read", { id: value.identity.workstreamId, path, repositoryId: value.identity.repositoryId });
        if (!valid(epoch)) return;
        if (read.revision !== entry.revision) {
          changed = true;
          entries[path] = { ...entry, decision: undefined, revision: undefined, content: read.content, readRevision: read.revision, changed: true };
          document.revision = read.revision;
        }
      }
      // Newly eligible required documents cannot silently disappear from the review set.
      const added = documents.filter(document => eligible(document, value.phase) && document.required && !value.selected.includes(document.path));
      if (changed || added.length) {
        update({ documents, entries, selected: reconcileSelection(value, documents), path: null, error: "Documents changed. Review the updated documents before sending; your feedback is preserved." });
        return;
      }
      // Membership can change during individual reads; validate again immediately before send.
      const { documents: finalDocuments, phase: finalPhase } = await readCatalog(value.identity, epoch);
      if (!valid(epoch) || current.current.sendDisabled || scopeOf(store.state) !== openedScope.current) return;
      if (value.mode === "review" && finalPhase !== value.phase) { resetPhase(value, finalDocuments, finalPhase); return; }
      const finalAdded = finalDocuments.filter(document => eligible(document, value.phase) && document.required && !value.selected.includes(document.path));
      if (finalAdded.length || value.selected.some(path => {
        const document = finalDocuments.find(document => document.path === path);
        return !document || !eligible(document, value.phase) || document.revision !== entries[path].revision;
      })) {
        update({ documents: finalDocuments, entries: reconciledEntries({ ...value, entries }, finalDocuments), selected: reconcileSelection(value, finalDocuments), path: null, error: "Documents changed during validation. Review them again before sending." });
        return;
      }
      const summary = ["Document review", `Workstream: ${value.identity.workstreamId}`, `Repository: ${value.identity.repositoryId}`, "These are document review decisions, not lifecycle phase approvals.", "", ...value.selected.flatMap(path => {
        const document = documents.find(item => item.path === path)!, entry = entries[path];
        return [`## ${document.title}`, `Path: ${document.path}`, `Phase: ${document.phase}`, `Content revision: ${entry.revision}`, `Decision: ${entry.decision === "accepted" ? "Accepted" : "Needs changes"}`, `Feedback:\n${entry.savedFeedback.trim() || "(none)"}`, ""];
      })].join("\n");
      let result: SendOutcome;
      try {
        submitting.current = true;
        sendAttempted = true;
        result = await current.current.send(summary);
      } finally {
        submitting.current = false;
      }
      // A send already admitted to this captured conversation may finish while
      // another app view is open. Apply its result only to that same review.
      if (guard.current.epoch !== epoch || current.current.scope !== openedScope.current || scopeOf(store.state) !== openedScope.current) return;
      if ((result.status === "accepted" || result.status === "queued") && result.conversationId === value.identity.sessionId) { setFlow(null); currentFlow.current = null; }
      else update({ error: store.state.submissionError || (result.status === "blocked" ? "Sending is currently unavailable. Your review is preserved." : "Review was not confirmed as sent. Check conversation history before trying again."), unknown: result.status === "unknown" || result.status === "accepted" });
    } catch (error) {
      if (valid(epoch) || sendAttempted && guard.current.epoch === epoch && current.current.scope === openedScope.current) update({ error: failure(error), unknown: sendAttempted });
    }
    finally { if (guard.current.epoch === epoch && current.current.scope === openedScope.current) { guard.current.locked = false; update({ busy: false }); } }
  }
  return { flow: visible, active, ready, readerPositions, start, refresh, open, edit, decide, picker, phase, select, cancel, submit, dismissCancel: () => update({ confirmCancel: false }), allowRetry: () => update({ unknown: false, error: "" }) };
}
export type DocumentReviewController = ReturnType<typeof useDocumentReview>;
