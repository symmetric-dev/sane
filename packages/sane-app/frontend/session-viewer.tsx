import { useEffect, useMemo, useState } from "react";
import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime } from "@assistant-ui/react";
import type { WorkerRecord } from "../src/worker-contract";
import { conversationClient } from "./cc-client";
import { consume, createRun, messagesForRun } from "./cc-reducer";
import { active, type Message, type Run } from "./types";
import { ChatMessage, convertMessage, TranscriptContext } from "./thread";
import { ShellDialog } from "./shell-dialog";
import { WorkerCard, WorkerSection } from "./worker-ui";
import { closeWorker, workerReference, openWorkerSession, publishWorkers, useWorkers, useWorkerViewer, useWorkerOpening, workerClient } from "./worker-client";
import { useActivityPresentation } from "./transcript-activity";
import { compactionsFor, compactionPositions } from "./compaction";
import { CompactionMarkers } from "./compaction-ui";
import type { CompactionRecord } from "../src/oc-contract";
import { useHandoffs } from "./handoff-client";
import { store } from "./store";
import { getHarnessDescriptor } from "../shared/conversation/harness-capabilities";

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
    let current = true;
    const controller = new AbortController(), map = new Map<string, Run>();
    let timer: ReturnType<typeof setTimeout>;
    setView({ sessionId: selected.sessionId, runs: [], messages: [], compactions: [], error: "", loading: true });
    setWaiting(0);
    const poll = async () => {
      try {
        const [metadata, children, parents, interactions] = await Promise.all([conversationClient.runs(selected.sessionId, controller.signal), workerClient.list(selected.sessionId, controller.signal), workerClient.list(selected.parent.sessionId, controller.signal), store.capabilities(selected.launch.harness).listInteractions && conversationClient.interactions ? conversationClient.interactions(selected.sessionId, controller.signal) : Promise.resolve([])]);
        if (!current) return;
        setWaiting(interactions.length);
        publishWorkers(selected.sessionId, children); publishWorkers(selected.parent.sessionId, parents);
        const currentWorker = parents.workers.find(record => record.id === selected.id) ?? selected;
        const childHarness = getHarnessDescriptor(selected.launch.harness)?.nativeHarness;
        const nativeSessionId = childHarness && currentWorker.child?.harness === childHarness ? currentWorker.child.nativeId : undefined;
        for (const meta of metadata.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
          meta.harness = selected.launch.harness;
          // Only the admitted child's identity (or explicit run metadata) scopes
          // CLI evidence. Never substitute the parent's native conversation.
          if (nativeSessionId) meta.nativeSessionId = nativeSessionId;
          const previous = map.get(meta.id);
          const identityChanged = previous && nativeSessionId && previous.nativeSessionId !== nativeSessionId;
          const run = !previous || identityChanged ? createRun(meta) : previous;
          if (previous && identityChanged) {
            // If admission identity arrived after the first read, replay the
            // retained diagnostics under that proven identity, without refetching
            // or treating the history as a newly observed compaction.
            consume(run, previous.events);
            run.cursor = previous.cursor;
          }
          const page = await conversationClient.events(run, controller.signal);
          if (!current) return;
          Object.assign(run, meta, { status: page.status || meta.status }); consume(run, page.events ?? []);
          if (Number.isFinite(page.nextCursor)) run.cursor = Math.max(run.cursor, page.nextCursor);
          map.set(run.id, run);
        }
        const runs = [...map.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const compactions = nativeSessionId ? compactionsFor({ id: selected.sessionId, harness: selected.launch.harness, nativeSessionId }, runs) : [];
        if (current) setView({ sessionId: selected.sessionId, runs, messages: runs.flatMap(messagesForRun), compactions, error: "", loading: false });
      } catch (e) { if (current) setView(v => ({ ...v, loading: false, error: e instanceof Error ? e.message : "Worker transcript unavailable" })); }
      finally { if (current) timer = setTimeout(() => void poll(), 1500); }
    };
    void poll();
    return () => { current = false; controller.abort(); clearTimeout(timer); };
  }, [selected.sessionId, selected.parent.sessionId, selected.launch.harness]);
  const messages = view.sessionId === selected.sessionId ? view.messages : [];
  const runs = view.sessionId === selected.sessionId ? view.runs : [];
  const compactions = view.sessionId === selected.sessionId ? view.compactions : [];
  const positions = useMemo(() => compactionPositions(compactions, messages), [compactions, messages]);
  const activities = useActivityPresentation({ sessionId: selected.sessionId, messages, workers: projection.workers, deliveries: projection.deliveries, handoffs: handoffs.handoffs, loading: view.loading || view.sessionId !== selected.sessionId, animate: !view.error });
  const open = (w: WorkerRecord) => setTrail(t => t.at(-1)?.id === w.id ? t : [...t, w]);
  const runtime = useExternalStoreRuntime({ messages, convertMessage, isRunning: runs.some(r => active(r.status)), isSendDisabled: true, onNew: async () => {} });
  return <ShellDialog title="Worker conversation · read-only" close={closeWorker}><nav className="worker-actions" aria-label="Worker breadcrumbs"><button type="button" onClick={closeWorker}>Close worker viewer</button>{trail.map((w, i) => <button key={w.id} type="button" aria-current={i === trail.length - 1 ? "page" : undefined} onClick={() => setTrail(t => t.slice(0, i + 1))}>{w.input.worker}</button>)}{trail.length === 1 && workerReference(root.parent.sessionId) && <button type="button" onClick={() => void openWorkerSession(root.parent.sessionId)}>Show worker parent</button>}</nav>
    <WorkerCard worker={worker} workers={projection.workers} runs={runs} open={open} />
    {waiting > 0 && <p className="notice" role="status">Waiting on {waiting} permission/question request(s). This viewer cannot answer worker prompts.</p>}
    {view.loading && <p role="status">Loading worker transcript…</p>}{view.error && <p className="notice error" role="alert">{view.error}</p>}
    <TranscriptContext.Provider value={{ sessionId: selected.sessionId, harness: worker.launch.harness, messages, runs, workers: projection.workers, deliveries: projection.deliveries, handoffs, activities, compactionPositions: positions, openWorker: open }}><AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root className="worker-transcript"><ThreadPrimitive.Messages components={{ Message: ChatMessage }} /><CompactionMarkers records={positions.get("")} />{compactions.some(record => record.lifecycle === "running") && <p className="working" role="status">{view.error ? "Compaction state unavailable; waiting for worker evidence to reconnect." : "Compacting context…"}</p>}</ThreadPrimitive.Root></AssistantRuntimeProvider></TranscriptContext.Provider>
    <WorkerSection sessionId={selected.sessionId} open={open} />
  </ShellDialog>;
}
export function WorkerViewerHost() {
  const worker = useWorkerViewer(), opening = useWorkerOpening();
  if (opening.sessionId) return <ShellDialog title="Open worker · read-only" close={closeWorker}>{opening.loading ? <p role="status">Loading worker from its parent conversation…</p> : <><p className="notice error" role="alert">{opening.error}</p><button type="button" onClick={() => void openWorkerSession(opening.sessionId)}>Retry</button></>}</ShellDialog>;
  return worker ? <Viewer key={worker.id} root={worker} /> : null;
}
