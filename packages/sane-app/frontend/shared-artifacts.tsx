import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { FiBriefcase, FiCode, FiHelpCircle, FiImage, FiLayers, FiSettings, FiUsers } from "react-icons/fi";
import { LuHandshake } from "react-icons/lu";
import { workerProtocolStatus, type WorkerRecord } from "../src/worker-contract";
import type { NativeSubagentSummary } from "../src/native-subagent-contract";
import type { CodeShareProjection } from "./code-share-client";
import type { MediaShareProjection } from "./media-share-client";
import type { UserQuestionsController } from "./user-questions-client";
import { ChatButton, ChatIconButton, ChatNotice } from "./chat-ui";
import { FlowNavigation } from "./flow-navigation";
import { MediaImageCache } from "./media-image-cache";
import { SharedArtifactCard } from "./shared-artifact-card";
import { buildSharedArtifacts, filterSharedArtifacts, type SharedArtifact } from "./shared-artifacts-model";
import { store, useStore } from "./store";
import { openWorker } from "./worker-client";
import { useWorkerPanel, WorkerCard, WorkerPanelNotices } from "./worker-ui";
import { NativeSubagentCard, useNativeSubagents } from "./native-subagent-feature";
import { nativeSubagentId } from "./native-subagent-presentation";
import { useInteractionActions, type InteractionSource } from "./interaction-actions";
import type { useHandoffs } from "./handoff-client";
import { buildHandoffInteractions, HandoffInteractionCard, type HandoffInteraction } from "./handoff-interaction";
import { goToSend } from "./send-navigation";
import { buildInteractionCounts, type InteractionCountKind } from "./interaction-counts";
import type { Run } from "./types";
import "./workstream-status.css";
import "./shared-artifacts.css";

export type ConversationInteractionsOptions = {
  sessionId: string;
  scopeKey: string;
  active: boolean;
  /** Artifact navigation restrictions never disable worker tracking or controls. */
  artifactDisabled?: boolean;
  codeShares?: CodeShareProjection;
  mediaShares?: MediaShareProjection;
  questions?: UserQuestionsController;
  handoffs?: ReturnType<typeof useHandoffs>;
  onSelect?: (artifact: SharedArtifact) => boolean;
  opened: boolean;
  onOpen: () => void;
  onClose: (navigating?: boolean) => void;
};

type InteractionFilter = InteractionCountKind;
type InteractionEntry = { kind: "worker"; id: string; createdAt: string; worker: WorkerRecord }
  | { kind: "subagent"; id: string; createdAt: string; summary: NativeSubagentSummary }
  | { kind: "handoff"; id: string; createdAt: string; handoff: HandoffInteraction }
  | { kind: "artifact"; id: string; createdAt: string; artifact: SharedArtifact };
const filters: readonly { value: InteractionFilter; label: string; icon: ReactNode }[] = [
  { value: "all", label: "All interactions", icon: <FiLayers size={16} aria-hidden="true" /> },
  { value: "worker", label: "Workers", icon: <FiUsers size={16} aria-hidden="true" /> },
  { value: "subagent", label: "Subagents", icon: <FiBriefcase size={16} aria-hidden="true" /> },
  { value: "handoff", label: "Handoffs", icon: <LuHandshake size={16} aria-hidden="true" /> },
  { value: "questions", label: "Questionnaires", icon: <FiHelpCircle size={16} aria-hidden="true" /> },
  { value: "code-share", label: "Code", icon: <FiCode size={16} aria-hidden="true" /> },
  { value: "media-share", label: "Media", icon: <FiImage size={16} aria-hidden="true" /> },
];

const empty = [] as const;
type InteractionView = { scope: string; query: string; filter: InteractionFilter; notice: string; page: "list" | "actions"; actionNotice?: { text: string; error: boolean } };
const emptyView = (scope: string): InteractionView => ({ scope, query: "", filter: "all", notice: "", page: "list" });

function InteractionCards({ entries, workers, runs, artifactDisabled, handoffError, selectArtifact, selectWorker, selectSubagent, selectHandoff }: {
  entries: readonly InteractionEntry[]; workers: WorkerRecord[]; runs: Run[]; artifactDisabled: boolean;
  handoffError?: string;
  selectArtifact: (artifact: SharedArtifact) => void; selectWorker: (worker: WorkerRecord) => void;
  selectSubagent: (summary: NativeSubagentSummary, trigger: HTMLButtonElement) => void;
  selectHandoff: (entry: HandoffInteraction) => void;
}) {
  const [imageCache] = useState(() => new MediaImageCache());
  useLayoutEffect(() => () => imageCache.clear(), [imageCache]);
  return <ul className="interactions-list">{entries.map(entry => <li key={entry.id} className={entry.kind === "handoff" ? "interaction-handoff-row" : undefined}>
    {entry.kind === "worker" ? <WorkerCard worker={entry.worker} workers={workers} runs={runs} open={selectWorker} />
      : entry.kind === "subagent" ? <NativeSubagentCard summary={entry.summary} onOpen={selectSubagent} />
      : entry.kind === "handoff" ? <HandoffInteractionCard entry={entry.handoff} disabled={artifactDisabled || !entry.handoff.presentation.sender.sessionId} stale={handoffError} onSelect={selectHandoff} />
      : <SharedArtifactCard artifact={entry.artifact} disabled={artifactDisabled} onSelect={selectArtifact} imageCache={imageCache} />}
  </li>)}</ul>;
}

/** Call unconditionally: presentation state outlives the inline panel, not its scope. */
export function useConversationInteractions(options: ConversationInteractionsOptions): { button: ReactNode; panel: ReactNode } {
  const { sessionId, scopeKey, active, artifactDisabled = false, codeShares, mediaShares, questions, handoffs, opened } = options;
  const workerPanel = useWorkerPanel(sessionId);
  const { workers, runs, projection, count, idle, awaiting, uncertain } = workerPanel;
  const workersLoading = useStore(state => state.selected === sessionId && !!state.workerLoading);
  const nativeFeature = useNativeSubagents();
  const native = nativeFeature?.client.sessionId === sessionId && store.harness() !== "grok" ? nativeFeature : null;
  const subagents = useMemo(() => [...(native?.summaries.values() ?? [])].filter(summary => summary.parentSessionId === sessionId), [native?.summaries, sessionId]);
  // Include the native questionnaire identity as well as the caller's full scope.
  // Reset during render so an old query/notice never paints in the next scope.
  const scope = JSON.stringify([scopeKey, sessionId, questions?.scopeKey ?? ""]);
  const [view, setView] = useState(() => emptyView(scope));
  if (view.scope !== scope) setView(emptyView(scope));
  const { query, filter, notice, page, actionNotice } = view.scope === scope ? view : emptyView(scope);
  const search = useRef<HTMLInputElement>(null);
  const listBody = useRef<HTMLDivElement>(null);
  const actionsBody = useRef<HTMLDivElement>(null);
  const actionsTrigger = useRef<HTMLButtonElement>(null);
  const listPosition = useRef({ scope, top: 0 });
  const returningToList = useRef(false);
  if (listPosition.current.scope !== scope) { listPosition.current = { scope, top: 0 }; returningToList.current = false; }
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const id = useId();
  const code = codeShares?.shares ?? empty;
  const media = mediaShares?.shares ?? empty;
  const forms = questions?.forms ?? empty;
  const artifacts = useMemo(() => buildSharedArtifacts(sessionId, code, media, forms), [sessionId, code, media, forms]);
  const presentations = handoffs?.handoffs ?? empty;
  const handoffEntries = useMemo(() => buildHandoffInteractions(sessionId, presentations), [sessionId, presentations]);
  const valid = !!sessionId && !!codeShares && !!mediaShares && !!options.onSelect;
  // A token also fences callbacks from an earlier visit when A -> B -> A.
  const identity = useRef({ scope });
  if (identity.current.scope !== scope) identity.current = { scope };
  const token = identity.current;
  const latest = useRef({ options, artifacts, workers, subagents, handoffEntries, native, valid, token });
  latest.current = { options, artifacts, workers, subagents, handoffEntries, native, valid, token };
  // Deliberately do not require opened: navigation closes synchronously first.
  const available = () => mounted.current && latest.current.token === token && latest.current.valid && latest.current.options.active;
  const updateView = (change: Partial<Omit<InteractionView, "scope">>) => {
    if (available()) setView(previous => ({ ...(previous.scope === scope ? previous : emptyView(scope)), ...change }));
  };
  const isOpen = opened && active && valid;
  useLayoutEffect(() => {
    if (!isOpen) return;
    if (page === "actions") { actionsBody.current?.focus({ preventScroll: true }); return; }
    if (listBody.current) listBody.current.scrollTop = listPosition.current.scope === scope ? listPosition.current.top : 0;
    if (returningToList.current) actionsTrigger.current?.focus({ preventScroll: true });
    else search.current?.focus({ preventScroll: true });
    returningToList.current = false;
  }, [isOpen, scope, page]);
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matchingWorkers = filter === "all" || filter === "worker" ? workers.filter(worker => {
    const text = ["worker", store.profile(worker.launch.profileId)?.label, worker.input.worker, worker.input.subject, ...(worker.input.jobs ?? []), worker.state, workerProtocolStatus(worker)].filter(Boolean).join("\n").toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  }) : [];
  const matchingSubagents = filter === "all" || filter === "subagent" ? subagents.filter(summary => {
    const text = ["subagent", summary.name, summary.toolName, summary.assignment, summary.status, summary.status === "unknown" ? "unconfirmed" : "", summary.returnedReport].filter(Boolean).join("\n").toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  }) : [];
  const matchingArtifacts = filter === "worker" || filter === "subagent" || filter === "handoff" ? [] : filterSharedArtifacts(artifacts, query, filter);
  const matchingHandoffs = filter === "all" || filter === "handoff" ? handoffEntries.filter(entry => {
    const text = entry.searchText.toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  }) : [];
  const subagentTime = (summary: NativeSubagentSummary) => {
    if (summary.createdAt) return summary.createdAt;
    const parent = store.snapshot().messages.find(message => (summary.parentMessageId && (message.id === summary.parentMessageId || message.nativeIds?.includes(summary.parentMessageId)))
      || message.runId === summary.runId && message.parts.some(part => part.type === "tool" && (part.toolCallId ?? part.id) === summary.parentToolUseId));
    // Legacy summaries without a recorded creation time sort last, never by
    // moving status-evidence time or by an unrelated parent run's timestamp.
    return parent?.time ?? "";
  };
  const entries: InteractionEntry[] = [
    ...matchingWorkers.map(worker => ({ kind: "worker" as const, id: `worker:${worker.id}`, createdAt: worker.createdAt, worker })),
    ...matchingSubagents.map(summary => ({ kind: "subagent" as const, id: `subagent:${nativeSubagentId(summary)}`, createdAt: subagentTime(summary), summary })),
    ...matchingHandoffs.map(handoff => ({ kind: "handoff" as const, id: `handoff:${handoff.id}`, createdAt: handoff.createdAt, handoff })),
    ...matchingArtifacts.map(artifact => ({ kind: "artifact" as const, id: `${artifact.kind}:${artifact.id}`, createdAt: artifact.createdAt, artifact })),
  ];
  entries.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) || a.id.localeCompare(b.id));
  const selectArtifact = (selected: SharedArtifact) => {
    if (!available() || latest.current.options.artifactDisabled) return;
    const artifact = latest.current.artifacts.find(row => row.kind === selected.kind && row.id === selected.id && row.sessionId === sessionId);
    if (!artifact) { updateView({ notice: "This artifact is no longer available. Refresh its source or choose another item." }); return; }
    const close = latest.current.options.onClose;
    flushSync(() => close(true));
    if (!available() || latest.current.options.artifactDisabled) return;
    let accepted = false;
    try { accepted = latest.current.options.onSelect?.(artifact) ?? false; } catch { /* Keep the search recoverable after a rejected jump. */ }
    if (!accepted && available()) {
      updateView({ notice: `Could not open “${artifact.title}” in this conversation. Retry it or refresh its source.` });
      latest.current.options.onOpen();
    }
  };
  const selectWorker = (selected: WorkerRecord) => {
    if (!available()) return;
    const worker = latest.current.workers.find(worker => worker.id === selected.id && worker.sessionId === selected.sessionId);
    if (!worker) return;
    const close = latest.current.options.onClose;
    flushSync(() => close(true));
    if (available()) openWorker(worker);
  };
  const selectHandoff = (selected: HandoffInteraction) => {
    if (!available() || latest.current.options.artifactDisabled) return;
    const entry = latest.current.handoffEntries.find(row => row.id === selected.id && row.direction === selected.direction);
    if (!entry) { updateView({ notice: "This handoff is no longer available. Refresh handoffs or choose another item." }); return; }
    // Capture the source before closing: received rows jump to the sender's chat,
    // never the receipt or recipient, and closing can synchronously change scope.
    const senderSessionId = entry.presentation.sender.sessionId;
    if (!senderSessionId) { updateView({ notice: "The original send has no local conversation available. Refresh handoffs or choose another item." }); return; }
    const target = { kind: "handoff" as const, id: entry.id, sessionId: senderSessionId };
    const close = latest.current.options.onClose;
    flushSync(() => close(true));
    if (!available() || latest.current.options.artifactDisabled) return;
    const current = latest.current.handoffEntries.find(row => row.id === entry.id && row.direction === entry.direction && row.presentation.sender.sessionId === senderSessionId);
    let accepted = false;
    try { accepted = !!current && goToSend(target); } catch { /* Restore a recoverable list after a rejected jump. */ }
    if (!accepted && available()) {
      updateView({ page: "list", notice: `Could not open the original send for “${entry.title}”. Retry Go to send or refresh handoffs.` });
      latest.current.options.onOpen();
    }
  };
  const selectSubagent = (selected: NativeSubagentSummary, trigger: HTMLButtonElement) => {
    if (!available()) return;
    const current = latest.current;
    const summary = current.subagents.find(summary => nativeSubagentId(summary) === nativeSubagentId(selected));
    if (!summary || !current.native) return;
    // The native viewer hides the retained Thread itself. Keep this local flow
    // selected so Back restores its exact list, query, filters, and scroll.
    current.native.open(summary, trigger, () => {
      if (!available()) return null;
      const root = document.getElementById(id);
      return [...(root?.querySelectorAll<HTMLButtonElement>("[data-native-subagent-trigger]") ?? [])].find(button => button.dataset.nativeSubagentTrigger === nativeSubagentId(summary)) ?? listBody.current;
    });
  };
  const sources = [
    ...(codeShares ? [{ kind: "code-share", name: "Code", ...codeShares }] : []),
    ...(mediaShares ? [{ kind: "media-share", name: "Media", ...mediaShares }] : []),
    ...(questions ? [{ kind: "questions", name: "Questionnaires", loading: questions.loading, error: questions.error, retry: questions.retry }] : []),
    ...(handoffs ? [{ kind: "handoff", name: "Handoffs", loading: handoffs.loading, error: handoffs.error, retry: handoffs.retry }] : []),
  ].filter(source => filter === "all" || filter === source.kind);
  const showSubagents = filter === "all" || filter === "subagent";
  const showHandoffs = filter === "all" || filter === "handoff";
  const handoffAttention = handoffEntries.some(entry => !!entry.presentation.problem || ["awaiting_approval", "failed", "acceptance_unknown"].includes(entry.presentation.handoff.status));
  const loading = sources.filter(source => source.loading);
  const failed = sources.some(source => source.error) || (filter === "all" || filter === "worker") && !!projection.error || showSubagents && !!native?.state.error;
  const hasItems = !!(workers.length || artifacts.length || subagents.length || handoffEntries.length);
  // Counts describe the whole current conversation, not just search matches.
  // A '+' distinguishes known records from a complete source projection.
  const filterCounts = buildInteractionCounts({
    sessionId, workerActive: count, workerTotal: workers.length,
    subagents, artifacts, questionnaires: forms, handoffs: handoffEntries,
    partial: {
      worker: !!projection.error || workersLoading,
      subagent: !!native && (!native.state.revision || !!native.state.nextCursor || !!native.state.error),
      "code-share": !!codeShares?.error || !!codeShares?.loading && !code.length,
      "media-share": !!mediaShares?.error || !!mediaShares?.loading && !media.length,
      questions: !questions || !!questions.error || questions.loading,
      handoff: !!handoffs?.error || !!handoffs?.loading && !handoffEntries.length,
    },
  });
  const informationSources: InteractionSource[] = [
    ...(codeShares ? [{ id: "code", label: "Code", ...codeShares, disabled: artifactDisabled }] : []),
    ...(mediaShares ? [{ id: "media", label: "Media", ...mediaShares, disabled: artifactDisabled }] : []),
    ...(questions ? [{ id: "questions", label: "Questionnaires", loading: questions.loading, error: questions.error, retry: questions.retry, disabled: artifactDisabled }] : []),
    ...(handoffs ? [{ id: "handoffs", label: "Handoffs", loading: handoffs.loading, error: handoffs.error, retry: handoffs.retry, disabled: artifactDisabled, detail: "Sent and received durable handoffs. Approvals remain in the dedicated request composer." }] : []),
    ...(native ? [{ id: "subagents", label: "Subagents", loading: native.state.loading, error: native.state.error, partial: !!native.state.nextCursor, retry: native.client.retryList, detail: "Recorded native activity only; separate from SANE workers." }] : []),
  ];
  const attention = !!actionNotice?.error || !!projection.error || projection.continuationSuppressed || projection.deliveries.some(delivery => !!delivery.error) || uncertain > 0 || handoffAttention || informationSources.some(source => !!source.error);
  const label = filterCounts.all.label;
  const composerCount = `${filterCounts.all.active ?? 0}/${filterCounts.all.total}${filterCounts.all.partial ? "+" : ""}`;
  const reset = () => { updateView({ query: "", filter: "all", notice: "" }); search.current?.focus({ preventScroll: true }); };
  const close = () => { if (available()) latest.current.options.onClose(); };
  const backToList = () => { returningToList.current = true; updateView({ page: "list" }); };
  // Keep cancellation ownership above the conditional panel mount, so closing
  // or visiting a native subagent cannot drop a pending request or its result.
  const actionsContent = useInteractionActions({
    sessionId, scopeKey: scope, active: isOpen && page === "actions",
    workers: { total: workers.length, active: count, idle, awaiting, uncertain },
    workerProjection: projection, sources: informationSources,
    onFeedback: feedback => {
      if (mounted.current && latest.current.token === token && latest.current.valid) {
        setView(previous => ({ ...(previous.scope === scope ? previous : emptyView(scope)), actionNotice: feedback }));
      }
    },
  });

  return {
    button: valid ? <button type="button" className="composer-workers conversation-interactions-trigger" disabled={!active}
      aria-expanded={isOpen} aria-controls={isOpen ? id : undefined} aria-label={label} title={label}
      onClick={() => { if (available()) latest.current.options.onOpen(); }}>
      <FiLayers size={14} aria-hidden="true" /><span className="workers-count" aria-hidden="true">{composerCount}</span>
    </button> : null,
    panel: isOpen ? <section key={scope} id={id} className="workstream-status-composer conversation-interactions-panel" aria-label={page === "actions" ? "Interactions actions and info" : "Interactions"}>
      <header className="workstream-status-heading"><div><span className="interactions-heading-icon" aria-hidden="true"><FiLayers size={16} /></span><strong>{page === "actions" ? "Actions & Info" : "Interactions"}</strong>
      </div><FlowNavigation exit={close} back={page === "actions" ? backToList : undefined} backLabel="Back to interactions" escape={page === "actions" ? backToList : undefined}>
        {page === "list" && <ChatIconButton ref={actionsTrigger} className="interactions-info-trigger" aria-label={attention ? "Actions and info, attention needed" : "Actions and info"} title="Actions and info" aria-controls={`${id}-actions`} onClick={() => updateView({ page: "actions" })}><FiSettings size={18} aria-hidden="true" />{attention && <span className="interactions-attention-dot" aria-hidden="true" />}</ChatIconButton>}
      </FlowNavigation></header>
      <div ref={listBody} className="conversation-interactions-body" hidden={page !== "list"} tabIndex={0} aria-label="Interaction results" onScroll={event => { if (page === "list" && isOpen && event.currentTarget.getClientRects().length) listPosition.current = { scope, top: event.currentTarget.scrollTop }; }}>
        <div className="interactions-feedback">
          {(filter === "all" || filter === "worker") && <WorkerPanelNotices projection={projection} />}
          {notice && <ChatNotice tone="warning" role="alert" actions={<ChatButton disabled={artifactDisabled} onClick={() => { if (available()) sources.forEach(source => source.retry()); }}>Refresh sources</ChatButton>}>{notice}</ChatNotice>}
          {actionNotice && <ChatNotice tone={actionNotice.error ? "warning" : "neutral"} role={actionNotice.error ? "alert" : "status"}>{actionNotice.text}</ChatNotice>}
          {showHandoffs && handoffAttention && <ChatNotice tone="warning" role="status">Some handoffs need attention. Inspect their recorded status; approvals remain in the dedicated request composer.</ChatNotice>}
          {sources.filter(source => source.error).map(source => <ChatNotice key={source.kind} tone="warning" role="alert" actions={<ChatButton disabled={source.loading || artifactDisabled} onClick={() => { if (available()) source.retry(); }}>Retry {source.name.toLowerCase()}</ChatButton>}>{source.name} could not be refreshed: {source.error} Known items remain available.</ChatNotice>)}
          {!!loading.length && <p role="status">Loading {loading.map(source => source.name.toLowerCase()).join(", ")}…</p>}
          {showSubagents && native?.state.error && <ChatNotice tone="warning" role="alert" actions={<ChatButton disabled={native.state.loading} onClick={() => { if (available()) native.client.retryList(); }}>Retry subagents</ChatButton>}>Subagent summaries unavailable: {native.state.error}. Known recorded activity remains available.</ChatNotice>}
          {showSubagents && native?.state.loading && <p role="status">Loading recorded subagents…</p>}
          {filter === "subagent" && !native && <p role="status">Native subagent activity is unavailable for this conversation.</p>}
          {showSubagents && native?.state.nextCursor && <p className="interactions-coverage">More recorded subagents are available. Search covers loaded summaries only.</p>}
          {artifactDisabled && filter !== "worker" && filter !== "subagent" && <p role="status">Artifact and handoff navigation is temporarily unavailable. Worker controls remain available.</p>}
          <p className="interactions-results" role="status">{entries.length} matching item{entries.length === 1 ? "" : "s"}{failed ? " · partial results" : ""}</p>
        </div>
        {entries.length ? <InteractionCards entries={entries} workers={workers} runs={runs} artifactDisabled={artifactDisabled} handoffError={handoffs?.error} selectArtifact={selectArtifact} selectWorker={selectWorker} selectSubagent={selectSubagent} selectHandoff={selectHandoff} /> : <div className="interactions-empty">
          <h3>{hasItems ? "No matching interactions" : loading.length || showSubagents && native?.state.loading ? "Loading interactions…" : failed ? "Interactions are not fully available" : "No interactions yet"}</h3>
          <p>{hasItems ? "Try another search or interaction kind." : "Workers, subagents, handoffs, shared code, media, and questionnaires from this conversation appear here."}</p>
          {(query.trim() || filter !== "all") && <ChatButton onClick={reset}>Clear search and filters</ChatButton>}
        </div>}
        {showSubagents && native?.state.nextCursor && <ChatButton className="interactions-load-more" disabled={native.state.loading} onClick={() => { if (available()) native.client.loadMoreSummaries(); }}>Load more subagents</ChatButton>}
      </div>
      <div ref={actionsBody} id={`${id}-actions`} className="conversation-interactions-body" hidden={page !== "actions"} tabIndex={-1} aria-label="Actions and info">
        {actionsContent}
      </div>
      <footer className="conversation-interactions-footer" hidden={page !== "list"}><div className="interactions-tools">
        <div className="interactions-filters" role="group" aria-label="Interaction kind">{filters.map(option => {
          const summary = filterCounts[option.value];
          return <button key={option.value} type="button" title={summary.label} aria-label={summary.label} aria-pressed={filter === option.value} onClick={() => updateView({ filter: option.value })}>{option.icon}<span aria-hidden="true">{summary.text}</span></button>;
        })}</div>
        <label className="interactions-search" htmlFor={`${id}-search`}><span className="sr-only">Search interactions</span><input ref={search} id={`${id}-search`} type="search" value={query} placeholder="Search interactions…" autoComplete="off" onChange={event => updateView({ query: event.target.value })} /></label>
      </div></footer>
    </section> : null,
  };
}
