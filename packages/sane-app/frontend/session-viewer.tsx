import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AssistantRuntimeProvider, ThreadPrimitive, useAuiState, useExternalStoreRuntime } from "@assistant-ui/react";
import type { WorkerRecord } from "../src/worker-contract";
import { conversationClient } from "./cc-client";
import { active, type Message, type Run } from "./types";
import { ChatMessage, renderActivityInspectorBody, TranscriptContext, useTranscriptIndex } from "./thread";
import { ActivityInspector, useActivityInspection } from "./activity-inspector";
import { convertTranscriptMessage, projectTranscriptMessages } from "./transcript-runtime";
import { ChatButton, ChatDialog, ChatDialogBody, ChatNotice } from "./chat-ui";
import { WorkerCard, WorkerSection } from "./worker-ui";
import { closeWorker, workerReference, openWorkerSession, publishWorkers, useWorkers, useWorkerViewer, useWorkerOpening, workerClient, workerInFlight, workerProjectionInFlight } from "./worker-client";
import { useActivityPresentation } from "./transcript-activity";
import { CompactionMarkers } from "./compaction-ui";
import type { CompactionRecord } from "../src/oc-contract";
import { useHandoffs } from "./handoff-client";
import { store, useStore } from "./store";
import { useCodeShares } from "./code-share-client";
import { CodeShareStatus } from "./shared-code-card";
import { useMediaShares } from "./media-share-client";
import { MediaShareStatus } from "./shared-media-card";
import { getHarnessDescriptor } from "../shared/conversation/harness-capabilities";
import { claudeReplyPresentation } from "./claude-reply-presentation";
import { pollWhileVisible } from "./visibility";
import { grokRuns, grokSessionView } from "./grok-presentation";
import { workerExchanges } from "./worker-presentation";
import { canonicalCount, pageMessages, type PageRequest, type PagedTranscript } from "./transcript-pages";
import { gapId, withCoverageGaps } from "./transcript-page-ui";
import { WorkerHistoryReader, workerPageKey, type WorkerHistorySnapshot } from "./worker-history";

const WorkerPagingContext = createContext<{ history: WorkerHistorySnapshot; load: (edge: PageRequest) => void } | null>(null);
function WorkerHistoryEdge({ edge, label = "Load earlier" }: { edge: PageRequest; label?: string }) {
  const paging = useContext(WorkerPagingContext);
  if (!paging) return null;
  const island = paging.history.pages?.islands.find(island => island.key === edge.island);
  if (!(edge.direction === "older" ? island?.coverage.olderCursor : island?.coverage.newerCursor)) return null;
  const key = workerPageKey(edge), error = paging.history.pageErrors[key];
  return <div className="transcript-page-control"><ChatButton variant="ghost" disabled={!!paging.history.busy} aria-busy={paging.history.busy === key} onClick={() => paging.load(edge)}>{error ? `Retry: ${label.toLowerCase()}` : label}</ChatButton>{error && <ChatNotice tone="warning" role="alert">{error}</ChatNotice>}</div>;
}
function WorkerChatMessage() {
  const id = useAuiState(state => state.message.id);
  const paging = useContext(WorkerPagingContext);
  const island = paging?.history.pages?.islands.slice(1).find(island => gapId(island) === id);
  if (island) return <section className="transcript-gap" aria-label="Unloaded worker history"><p>Earlier messages are not loaded in this gap.</p><WorkerHistoryEdge edge={{ island: island.key, direction: "older" }} label="Load earlier in gap" /></section>;
  return <ChatMessage />;
}

// Canonical placements may point outside the loaded window. Never move those
// markers to the tail merely because the intervening history is not loaded.
function workerCompactionPositions(pages: PagedTranscript | null | undefined, messages: Message[]) {
  const positions = new Map<string, CompactionRecord[]>();
  if (!pages) return positions;
  const loaded = new Set(messages.map(message => message.id));
  for (const record of pages.compactions) {
    const key = record.placement.kind === "before-message" ? record.placement.messageId
      : record.placement.kind === "tail" && pages.islands.at(-1)?.coverage.lastIndex === canonicalCount(pages) - 1 ? "" : undefined;
    if (key !== undefined && (key === "" || loaded.has(key))) positions.set(key, [...(positions.get(key) ?? []), record]);
  }
  return positions;
}

function Viewer({ root }: { root: WorkerRecord }) {
  const [trail, setTrail] = useState([root]);
  const [waiting, setWaiting] = useState(0);
  const selected = trail.at(-1)!;
  const [view, setView] = useState<{ sessionId: string; runs: Run[]; messages: Message[]; compactions: CompactionRecord[]; error: string; loading: boolean; history?: WorkerHistorySnapshot }>({ sessionId: selected.sessionId, runs: [], messages: [], compactions: [], error: "", loading: true });
  const historyReader = useRef<WorkerHistoryReader | null>(null);
  const retryHistory = useRef<() => void>(() => {});
  const projection = useWorkers(selected.sessionId);
  const handoffs = useHandoffs(selected.sessionId);
  const parent = useWorkers(selected.parent.sessionId);
  const worker = parent.workers.find(w => w.id === selected.id) ?? selected;
  const exchanges = useMemo(() => workerExchanges([...projection.workers, worker]), [projection.workers, worker]);
  useEffect(() => {
    let inFlight = workerInFlight(selected);
    let statusError = "";
    const childHarness = getHarnessDescriptor(selected.launch.harness)?.nativeHarness;
    const identity = (record: WorkerRecord) => childHarness && record.child?.harness === childHarness ? record.child.nativeId : undefined;
    let nativeSessionId = identity(selected);
    const history = selected.launch.harness === "grok" ? null : new WorkerHistoryReader(conversationClient, selected.sessionId, selected.launch.harness, snapshot => {
      setView(previous => ({ sessionId: selected.sessionId, runs: snapshot.runs,
        messages: previous.sessionId === selected.sessionId && previous.history?.pages?.islands === snapshot.pages?.islands ? previous.messages : pageMessages(snapshot.pages),
        compactions: snapshot.pages?.compactions ?? [], error: [statusError, snapshot.error, snapshot.metadataError].filter(Boolean).join(" "), loading: snapshot.loading, history: snapshot }));
    });
    historyReader.current = history;
    const retryController = new AbortController();
    retryHistory.current = () => {
      if (history) void Promise.all([history.refresh(nativeSessionId, retryController.signal), history.refreshMetadata(nativeSessionId, retryController.signal)]).catch(() => {});
    };
    setView({ sessionId: selected.sessionId, runs: [], messages: [], compactions: [], error: "", loading: true });
    setWaiting(0);
    const stop = pollWhileVisible(async signal => {
      try {
        if (selected.launch.harness === "grok") {
          if (!conversationClient.grokSession) throw new Error("Grok session status is unavailable on this bridge.");
          const [capture, children, parents] = await Promise.all([conversationClient.grokSession(selected.sessionId, signal), workerClient.list(selected.sessionId, signal), workerClient.list(selected.parent.sessionId, signal)]);
          if (signal.aborted) return 60_000;
          const session = grokSessionView(capture, selected.sessionId);
          const currentWorker = parents.workers.find(record => record.id === selected.id) ?? selected;
          publishWorkers(selected.sessionId, children); publishWorkers(selected.parent.sessionId, parents);
          inFlight = session.active || workerInFlight(currentWorker) || workerProjectionInFlight(children);
          setView({ sessionId: selected.sessionId, runs: grokRuns(session), messages: session.messages, compactions: [], error: "", loading: false });
          return inFlight ? 3000 : 60_000;
        }
        // Status has its own cadence: a large *loaded* version-refresh pass
        // must not delay permission/status polling or fetch descendant details.
        const [children, parents, interactions] = await Promise.all([workerClient.list(selected.sessionId, signal), workerClient.list(selected.parent.sessionId, signal), store.capabilities(selected.launch.harness).listInteractions && conversationClient.interactions ? conversationClient.interactions(selected.sessionId, signal) : Promise.resolve([])]);
        signal.throwIfAborted();
        setWaiting(interactions.length);
        publishWorkers(selected.sessionId, children); publishWorkers(selected.parent.sessionId, parents);
        const currentWorker = parents.workers.find(record => record.id === selected.id) ?? selected;
        const nextIdentity = identity(currentWorker);
        statusError = "";
        if (nativeSessionId !== nextIdentity) {
          nativeSessionId = nextIdentity;
          void history!.refresh(nativeSessionId, retryController.signal).catch(() => {});
        }
        const snapshot = history!.snapshot;
        inFlight = workerInFlight(currentWorker) || workerProjectionInFlight(children) || interactions.length > 0 || snapshot.runs.some(run => active(run.status)) || !!snapshot.error;
        setView(previous => ({ ...previous, error: [statusError, snapshot.error, snapshot.metadataError].filter(Boolean).join(" ") }));
      } catch (e) {
        if (!signal.aborted) {
          inFlight = true;
          statusError = e instanceof Error ? e.message : "Worker status unavailable";
          setView(v => ({ ...v, loading: history ? v.loading : false, error: [statusError, history?.snapshot.error, history?.snapshot.metadataError].filter(Boolean).join(" ") }));
        }
      }
      // Run/compaction metadata has its own coalesced flight, outside the message
      // queue. Poll it even when worker/interactions status above failed.
      if (history && !signal.aborted) {
        await history.refreshMetadata(nativeSessionId, signal);
        if (!signal.aborted) inFlight ||= history.snapshot.runs.some(run => active(run.status)) || !!history.snapshot.error || !!history.snapshot.metadataError;
      }
      return inFlight ? 3000 : 60_000;
    }, { sessionIds: [selected.sessionId, selected.parent.sessionId], onWake: () => { inFlight = true; } });
    const stopHistory = history ? pollWhileVisible(async signal => {
      await history.refresh(nativeSessionId, signal);
      return inFlight || history.snapshot.runs.some(run => active(run.status)) || !!history.snapshot.error || !!history.snapshot.metadataError ? 3000 : 60_000;
    }, { sessionIds: [selected.sessionId, selected.parent.sessionId], onWake: () => { inFlight = true; } }) : () => {};
    return () => { stop(); stopHistory(); retryController.abort(); history?.dispose(); historyReader.current = null; retryHistory.current = () => {}; };
  }, [selected.id, selected.sessionId, selected.parent.sessionId, selected.launch.harness]);
  const history = view.sessionId === selected.sessionId ? view.history : undefined;
  const pages = history?.pages;
  const messages = useMemo(() => claudeReplyPresentation(withCoverageGaps(view.sessionId === selected.sessionId ? view.messages : [], pages), selected.launch.harness), [view.sessionId, view.messages, selected.sessionId, selected.launch.harness, pages]);
  const transcriptIndex = useTranscriptIndex(messages);
  const runtimeMessages = useMemo(() => projectTranscriptMessages(messages), [messages]);
  const runs = view.sessionId === selected.sessionId ? view.runs : [];
  const authenticated = useStore(state => state.config?.authenticated === true && state.connected);
  const codeShares = useCodeShares(selected.sessionId, { enabled: authenticated, refreshKey: messages, running: runs.some(run => active(run.status)) });
  const mediaShares = useMediaShares(selected.sessionId, { enabled: authenticated, refreshKey: messages, running: runs.some(run => active(run.status)) });
  const compactions = view.sessionId === selected.sessionId ? view.compactions : [];
  const positions = useMemo(() => workerCompactionPositions(pages, messages), [pages, messages]);
  const activities = useActivityPresentation({ sessionId: selected.sessionId, messages, workers: projection.workers, deliveries: projection.deliveries, exchanges, handoffs: handoffs.handoffs, loading: view.loading || view.sessionId !== selected.sessionId, animate: !view.error, nativeRuns: runs, nativeHarness: selected.launch.harness, compactionPositions: positions, codeShares: codeShares.shares, mediaShares: mediaShares.shares });
  const inspection = useActivityInspection({ scope: JSON.stringify(["worker-viewer", root.id, selected.sessionId, selected.launch.harness]), active: view.sessionId === selected.sessionId, plan: activities.plan });
  const open = (w: WorkerRecord) => setTrail(t => t.at(-1)?.id === w.id ? t : [...t, w]);
  const runtime = useExternalStoreRuntime({ messages: runtimeMessages, convertMessage: convertTranscriptMessage, isRunning: runs.some(r => active(r.status)), isSendDisabled: true, onNew: async () => {} });
  return <ChatDialog title="Worker conversation · read-only" size="wide" close={closeWorker}><ChatDialogBody><nav className="worker-actions" aria-label="Worker breadcrumbs"><ChatButton variant="ghost" onClick={closeWorker}>Close worker viewer</ChatButton>{trail.map((w, i) => <ChatButton key={w.id} variant="ghost" aria-current={i === trail.length - 1 ? "page" : undefined} onClick={() => setTrail(t => t.slice(0, i + 1))}>{w.input.worker}</ChatButton>)}{trail.length === 1 && workerReference(root.parent.sessionId) && <ChatButton variant="ghost" onClick={() => void openWorkerSession(root.parent.sessionId)}>Show worker parent</ChatButton>}</nav>
    <WorkerCard worker={worker} workers={projection.workers} runs={runs} open={open} />
    {waiting > 0 && <ChatNotice role="status">Waiting on {waiting} permission/question request(s). This viewer cannot answer worker prompts.</ChatNotice>}
    {view.loading && <p role="status">Loading worker transcript…</p>}{view.error && <ChatNotice tone="warning" role="alert" actions={selected.launch.harness !== "grok" ? <ChatButton onClick={() => retryHistory.current()}>Retry worker history</ChatButton> : undefined}>{view.error}</ChatNotice>}
    <CodeShareStatus projection={codeShares} />
    <MediaShareStatus projection={mediaShares} />
    <WorkerPagingContext.Provider value={history ? { history, load: edge => { void historyReader.current?.load(edge); } } : null}><TranscriptContext.Provider value={{ sessionId: selected.sessionId, harness: worker.launch.harness, messages, ...transcriptIndex, runs, workers: projection.workers, deliveries: projection.deliveries, exchanges, handoffs, activities, activityScope: inspection.scope, inspectActivity: inspection.open, compactionPositions: positions, openWorker: open, codeShares, mediaShares }}><AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root className="worker-transcript">{pages?.islands[0] && <WorkerHistoryEdge edge={{ island: pages.islands[0].key, direction: "older" }} />}<ThreadPrimitive.Messages components={{ Message: WorkerChatMessage }} /><CompactionMarkers records={positions.get("")} />{pages?.compactions.some(record => record.placement.kind === "unplaced") && <section aria-label="Compaction lifecycle without a transcript position"><CompactionMarkers records={pages.compactions.filter(record => record.placement.kind === "unplaced")} /></section>}{compactions.some(record => record.lifecycle === "running") && <p className="working" role="status">{view.error ? "Compaction state unavailable; waiting for worker evidence to reconnect." : "Compacting context…"}</p>}</ThreadPrimitive.Root></AssistantRuntimeProvider><ActivityInspector inspection={inspection} renderBody={renderActivityInspectorBody} /></TranscriptContext.Provider></WorkerPagingContext.Provider>
    <WorkerSection sessionId={selected.sessionId} open={open} />
  </ChatDialogBody></ChatDialog>;
}
export function WorkerViewerHost() {
  const worker = useWorkerViewer(), opening = useWorkerOpening();
  if (opening.sessionId) return <ChatDialog title="Open worker · read-only" close={closeWorker}><ChatDialogBody>{opening.loading ? <p role="status">Loading worker from its parent conversation…</p> : <ChatNotice tone="warning" role="alert" actions={<ChatButton onClick={() => void openWorkerSession(opening.sessionId)}>Retry</ChatButton>}>{opening.error}</ChatNotice>}</ChatDialogBody></ChatDialog>;
  return worker ? <Viewer key={worker.id} root={worker} /> : null;
}
