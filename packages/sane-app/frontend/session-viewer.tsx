import { useEffect, useMemo, useState } from "react";
import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime } from "@assistant-ui/react";
import type { WorkerRecord } from "../src/worker-contract";
import { conversationClient } from "./cc-client";
import { consume, createRun, messagesForRun } from "./cc-reducer";
import { active, type Message, type Run } from "./types";
import { ChatMessage, renderActivityInspectorBody, TranscriptContext, useTranscriptIndex } from "./thread";
import { ActivityInspector, useActivityInspection } from "./activity-inspector";
import { convertTranscriptMessage, projectTranscriptMessages } from "./transcript-runtime";
import { ShellDialog } from "./shell-dialog";
import { WorkerCard, WorkerSection } from "./worker-ui";
import { closeWorker, workerReference, openWorkerSession, publishWorkers, useWorkers, useWorkerViewer, useWorkerOpening, workerClient, workerInFlight, workerProjectionInFlight } from "./worker-client";
import { useActivityPresentation } from "./transcript-activity";
import { compactionsFor, compactionPositions } from "./compaction";
import { CompactionMarkers } from "./compaction-ui";
import type { CompactionRecord } from "../src/oc-contract";
import { useHandoffs } from "./handoff-client";
import { store, useStore } from "./store";
import { useCodeShares } from "./code-share-client";
import { CodeShareStatus } from "./shared-code-card";
import { getHarnessDescriptor } from "../shared/conversation/harness-capabilities";
import { claudeReplyPresentation } from "./claude-reply-presentation";
import { pollWhileVisible } from "./visibility";
import { grokRuns, grokSessionView } from "./grok-presentation";

function Viewer({ root }: { root: WorkerRecord }) {
  const [trail, setTrail] = useState([root]);
  const [waiting, setWaiting] = useState(0);
  const selected = trail.at(-1)!;
  const [view, setView] = useState<{ sessionId: string; runs: Run[]; messages: Message[]; compactions: CompactionRecord[]; error: string; loading: boolean }>({ sessionId: selected.sessionId, runs: [], messages: [], compactions: [], error: "", loading: true });
  const projection = useWorkers(selected.sessionId);
  const handoffs = useHandoffs(selected.sessionId);
  const parent = useWorkers(selected.parent.sessionId);
  const worker = parent.workers.find(w => w.id === selected.id) ?? selected;
  useEffect(() => {
    const map = new Map<string, Run>();
    let inFlight = workerInFlight(selected);
    setView({ sessionId: selected.sessionId, runs: [], messages: [], compactions: [], error: "", loading: true });
    setWaiting(0);
    return pollWhileVisible(async signal => {
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
        const [metadata, children, parents, interactions] = await Promise.all([conversationClient.runs(selected.sessionId, signal), workerClient.list(selected.sessionId, signal), workerClient.list(selected.parent.sessionId, signal), store.capabilities(selected.launch.harness).listInteractions && conversationClient.interactions ? conversationClient.interactions(selected.sessionId, signal) : Promise.resolve([])]);
        if (signal.aborted) return 60_000;
        setWaiting(interactions.length);
        publishWorkers(selected.sessionId, children); publishWorkers(selected.parent.sessionId, parents);
        const currentWorker = parents.workers.find(record => record.id === selected.id) ?? selected;
        inFlight = workerInFlight(currentWorker) || workerProjectionInFlight(children) || interactions.length > 0 || metadata.some(run => active(run.status));
        const childHarness = getHarnessDescriptor(selected.launch.harness)?.nativeHarness;
        const nativeSessionId = childHarness && currentWorker.child?.harness === childHarness ? currentWorker.child.nativeId : undefined;
        const ordered = metadata.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const latestId = ordered.at(-1)?.id;
        for (const meta of ordered) {
          meta.harness = selected.launch.harness;
          // Only the admitted child's identity (or explicit run metadata) scopes
          // CLI evidence. Never substitute the parent's native conversation.
          if (nativeSessionId) meta.nativeSessionId = nativeSessionId;
          const previous = map.get(meta.id);
          const identityChanged = previous && nativeSessionId && previous.nativeSessionId !== nativeSessionId;
          // Settled runs (terminal, metadata-identical, not the latest) can
          // never grow events; the map already holds them, so skip the read.
          const settled = !identityChanged && !!previous && meta.id !== latestId
            && (previous.status === "completed" || previous.status === "failed" || previous.status === "interrupted")
            && meta.status === previous.status
            && meta.harness === previous.harness && (meta.nativeSessionId ?? undefined) === (previous.nativeSessionId ?? undefined)
            && (Object.keys(meta) as (keyof typeof meta)[]).every(key => key === "status" || key === "harness" || key === "nativeSessionId"
              || (key === "compact" ? JSON.stringify(meta[key]) === JSON.stringify(previous[key]) : meta[key] === previous[key]));
          if (settled) continue;
          const run = !previous || identityChanged ? createRun(meta) : previous;
          if (previous && identityChanged) {
            // If admission identity arrived after the first read, replay the
            // retained diagnostics under that proven identity, without refetching
            // or treating the history as a newly observed compaction.
            consume(run, previous.events);
            run.cursor = previous.cursor;
          }
          const page = await conversationClient.events(run, signal);
          if (signal.aborted) return 60_000;
          Object.assign(run, meta, { status: page.status || meta.status }); consume(run, page.events ?? []);
          if (Number.isFinite(page.nextCursor)) run.cursor = Math.max(run.cursor, page.nextCursor);
          map.set(run.id, run);
        }
        const runs = [...map.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const compactions = nativeSessionId ? compactionsFor({ id: selected.sessionId, harness: selected.launch.harness, nativeSessionId }, runs) : [];
        inFlight = workerInFlight(currentWorker) || workerProjectionInFlight(children) || interactions.length > 0 || runs.some(run => active(run.status));
        if (!signal.aborted) setView({ sessionId: selected.sessionId, runs, messages: runs.flatMap(messagesForRun), compactions, error: "", loading: false });
      } catch (e) { if (!signal.aborted) setView(v => ({ ...v, loading: false, error: e instanceof Error ? e.message : "Worker transcript unavailable" })); }
      return inFlight ? 3000 : 60_000;
    }, { sessionIds: [selected.sessionId, selected.parent.sessionId], onWake: () => { inFlight = true; } });
  }, [selected.sessionId, selected.parent.sessionId, selected.launch.harness]);
  const messages = useMemo(() => claudeReplyPresentation(view.sessionId === selected.sessionId ? view.messages : [], selected.launch.harness), [view.sessionId, view.messages, selected.sessionId, selected.launch.harness]);
  const transcriptIndex = useTranscriptIndex(messages);
  const runtimeMessages = useMemo(() => projectTranscriptMessages(messages), [messages]);
  const runs = view.sessionId === selected.sessionId ? view.runs : [];
  const authenticated = useStore(state => state.config?.authenticated === true && state.connected);
  const codeShares = useCodeShares(selected.sessionId, { enabled: authenticated, refreshKey: messages, running: runs.some(run => active(run.status)) });
  const compactions = view.sessionId === selected.sessionId ? view.compactions : [];
  const positions = useMemo(() => compactionPositions(compactions, messages), [compactions, messages]);
  const activities = useActivityPresentation({ sessionId: selected.sessionId, messages, workers: projection.workers, deliveries: projection.deliveries, handoffs: handoffs.handoffs, loading: view.loading || view.sessionId !== selected.sessionId, animate: !view.error, nativeRuns: runs, nativeHarness: selected.launch.harness, compactionPositions: positions, codeShares: codeShares.shares });
  const inspection = useActivityInspection({ scope: JSON.stringify(["worker-viewer", root.id, selected.sessionId, selected.launch.harness]), active: view.sessionId === selected.sessionId, plan: activities.plan });
  const open = (w: WorkerRecord) => setTrail(t => t.at(-1)?.id === w.id ? t : [...t, w]);
  const runtime = useExternalStoreRuntime({ messages: runtimeMessages, convertMessage: convertTranscriptMessage, isRunning: runs.some(r => active(r.status)), isSendDisabled: true, onNew: async () => {} });
  return <ShellDialog title="Worker conversation · read-only" close={closeWorker}><nav className="worker-actions" aria-label="Worker breadcrumbs"><button type="button" onClick={closeWorker}>Close worker viewer</button>{trail.map((w, i) => <button key={w.id} type="button" aria-current={i === trail.length - 1 ? "page" : undefined} onClick={() => setTrail(t => t.slice(0, i + 1))}>{w.input.worker}</button>)}{trail.length === 1 && workerReference(root.parent.sessionId) && <button type="button" onClick={() => void openWorkerSession(root.parent.sessionId)}>Show worker parent</button>}</nav>
    <WorkerCard worker={worker} workers={projection.workers} runs={runs} open={open} />
    {waiting > 0 && <p className="notice" role="status">Waiting on {waiting} permission/question request(s). This viewer cannot answer worker prompts.</p>}
    {view.loading && <p role="status">Loading worker transcript…</p>}{view.error && <p className="notice error" role="alert">{view.error}</p>}
    <CodeShareStatus projection={codeShares} />
    <TranscriptContext.Provider value={{ sessionId: selected.sessionId, harness: worker.launch.harness, messages, ...transcriptIndex, runs, workers: projection.workers, deliveries: projection.deliveries, handoffs, activities, activityScope: inspection.scope, inspectActivity: inspection.open, compactionPositions: positions, openWorker: open, codeShares }}><AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root className="worker-transcript"><ThreadPrimitive.Messages components={{ Message: ChatMessage }} /><CompactionMarkers records={positions.get("")} />{compactions.some(record => record.lifecycle === "running") && <p className="working" role="status">{view.error ? "Compaction state unavailable; waiting for worker evidence to reconnect." : "Compacting context…"}</p>}</ThreadPrimitive.Root></AssistantRuntimeProvider><ActivityInspector inspection={inspection} renderBody={renderActivityInspectorBody} /></TranscriptContext.Provider>
    <WorkerSection sessionId={selected.sessionId} open={open} />
  </ShellDialog>;
}
export function WorkerViewerHost() {
  const worker = useWorkerViewer(), opening = useWorkerOpening();
  if (opening.sessionId) return <ShellDialog title="Open worker · read-only" close={closeWorker}>{opening.loading ? <p role="status">Loading worker from its parent conversation…</p> : <><p className="notice error" role="alert">{opening.error}</p><button type="button" onClick={() => void openWorkerSession(opening.sessionId)}>Retry</button></>}</ShellDialog>;
  return worker ? <Viewer key={worker.id} root={worker} /> : null;
}
