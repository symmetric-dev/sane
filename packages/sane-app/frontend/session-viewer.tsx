import { useEffect, useState } from "react";
import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime } from "@assistant-ui/react";
import type { WorkerRecord } from "../src/worker-contract";
import { conversationClient } from "./cc-client";
import { consume, createRun, messagesForRun } from "./cc-reducer";
import { active, type Message, type Run } from "./types";
import { ChatMessage, convertMessage, TranscriptContext } from "./thread";
import { ShellDialog } from "./shell-dialog";
import { WorkerCard, WorkerSection } from "./worker-ui";
import { closeWorker, workerReference, openWorkerSession, publishWorkers, useWorkers, useWorkerViewer, useWorkerOpening, workerClient } from "./worker-client";

function Viewer({ root }: { root: WorkerRecord }) {
  const [trail, setTrail] = useState([root]);
  const [waiting, setWaiting] = useState(0);
  const selected = trail.at(-1)!;
  const [view, setView] = useState<{ sessionId: string; runs: Run[]; messages: Message[]; error: string; loading: boolean }>({ sessionId: selected.sessionId, runs: [], messages: [], error: "", loading: true });
  const projection = useWorkers(selected.sessionId);
  const parent = useWorkers(selected.parent.sessionId);
  const worker = parent.workers.find(w => w.id === selected.id) ?? selected;
  useEffect(() => {
    let current = true;
    const controller = new AbortController(), map = new Map<string, Run>();
    let timer: ReturnType<typeof setTimeout>;
    setView({ sessionId: selected.sessionId, runs: [], messages: [], error: "", loading: true });
    setWaiting(0);
    const poll = async () => {
      try {
        const [metadata, children, parents, interactions] = await Promise.all([conversationClient.runs(selected.sessionId, controller.signal), workerClient.list(selected.sessionId, controller.signal), workerClient.list(selected.parent.sessionId, controller.signal), selected.launch.harness === "opencode" ? conversationClient.interactions(selected.sessionId, controller.signal) : Promise.resolve([])]);
        if (!current) return;
        setWaiting(interactions.length);
        publishWorkers(selected.sessionId, children); publishWorkers(selected.parent.sessionId, parents);
        for (const meta of metadata.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
          const run = map.get(meta.id) ?? createRun(meta);
          const page = await conversationClient.events(run, controller.signal);
          if (!current) return;
          Object.assign(run, meta, { status: page.status || meta.status }); consume(run, page.events ?? []);
          if (Number.isFinite(page.nextCursor)) run.cursor = Math.max(run.cursor, page.nextCursor);
          map.set(run.id, run);
        }
        const runs = [...map.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        if (current) setView({ sessionId: selected.sessionId, runs, messages: runs.flatMap(messagesForRun), error: "", loading: false });
      } catch (e) { if (current) setView(v => ({ ...v, loading: false, error: e instanceof Error ? e.message : "Worker transcript unavailable" })); }
      finally { if (current) timer = setTimeout(() => void poll(), 1500); }
    };
    void poll();
    return () => { current = false; controller.abort(); clearTimeout(timer); };
  }, [selected.sessionId, selected.parent.sessionId]);
  const messages = view.sessionId === selected.sessionId ? view.messages : [];
  const runs = view.sessionId === selected.sessionId ? view.runs : [];
  const open = (w: WorkerRecord) => setTrail(t => t.at(-1)?.id === w.id ? t : [...t, w]);
  const runtime = useExternalStoreRuntime({ messages, convertMessage, isRunning: runs.some(r => active(r.status)), isSendDisabled: true, onNew: async () => {} });
  return <ShellDialog title="Worker conversation · read-only" close={closeWorker}><nav className="worker-actions" aria-label="Worker breadcrumbs"><button type="button" onClick={closeWorker}>Close worker viewer</button>{trail.map((w, i) => <button key={w.id} type="button" aria-current={i === trail.length - 1 ? "page" : undefined} onClick={() => setTrail(t => t.slice(0, i + 1))}>{w.input.worker}</button>)}{trail.length === 1 && workerReference(root.parent.sessionId) && <button type="button" onClick={() => void openWorkerSession(root.parent.sessionId)}>Show worker parent</button>}</nav>
    <WorkerCard worker={worker} workers={projection.workers} runs={runs} open={open} />
    {waiting > 0 && <p className="notice" role="status">Waiting on {waiting} permission/question request(s). This viewer cannot answer worker prompts.</p>}
    {view.loading && <p role="status">Loading worker transcript…</p>}{view.error && <p className="notice error" role="alert">{view.error}</p>}
    <TranscriptContext.Provider value={{ sessionId: selected.sessionId, harness: worker.launch.harness, messages, runs, workers: projection.workers, openWorker: open }}><AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root className="worker-transcript"><ThreadPrimitive.Messages components={{ Message: ChatMessage }} /></ThreadPrimitive.Root></AssistantRuntimeProvider></TranscriptContext.Provider>
    <WorkerSection sessionId={selected.sessionId} open={open} />
  </ShellDialog>;
}
export function WorkerViewerHost() {
  const worker = useWorkerViewer(), opening = useWorkerOpening();
  if (opening.sessionId) return <ShellDialog title="Open worker · read-only" close={closeWorker}>{opening.loading ? <p role="status">Loading worker from its parent conversation…</p> : <><p className="notice error" role="alert">{opening.error}</p><button type="button" onClick={() => void openWorkerSession(opening.sessionId)}>Retry</button></>}</ShellDialog>;
  return worker ? <Viewer key={worker.id} root={worker} /> : null;
}
