import { useEffect, useId, useState } from "react";
import type { SystemPromptSnapshot } from "../shared/conversation/system-prompt";
import { loadSystemPrompt } from "./system-prompt-client";
import type { Config, RunMetadata } from "./types";
import "./system-prompt.css";

type PromptState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; snapshot: SystemPromptSnapshot };

function PromptContent({ config, run }: { config: Config; run: RunMetadata }) {
  const [state, setState] = useState<PromptState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    void loadSystemPrompt(config, run, controller.signal).then(snapshot => {
      if (!controller.signal.aborted) setState({ kind: "ready", snapshot });
    }).catch(error => {
      if (!controller.signal.aborted) setState({ kind: "error", message: error instanceof Error ? error.message : "System prompt unavailable." });
    });
    return () => controller.abort();
  }, [config, run.id, run.conversationId, run.status, attempt]);

  if (state.kind === "loading") return <p className="muted" role="status">Loading recorded context…</p>;
  if (state.kind === "error") return <div role="alert"><p className="notice error">{state.message}</p><button type="button" className="text-button" onClick={() => setAttempt(value => value + 1)}>Retry</button></div>;
  const { snapshot } = state;
  if (snapshot.state !== "recorded") return <div><p className="muted" role="status">{snapshot.state === "pending" ? "Context preparation has not been recorded yet." : "No SANE context snapshot was recorded for this run. Older or imported history may not include one."}</p>{snapshot.state === "pending" && <button type="button" className="text-button" onClick={() => setAttempt(value => value + 1)}>Refresh</button>}</div>;
  return <div className="system-prompt-content">
    <p className="muted">Recorded prepared text, not confirmation that the model received it.</p>
    <section><h4>Standing instructions</h4>{snapshot.standing ? <pre>{snapshot.standing}</pre> : <p className="muted">No standing instructions in this snapshot.</p>}</section>
    <section><h4>Injected context</h4>{snapshot.injected ? <pre>{snapshot.injected}</pre> : <p className="muted">No injected context in this snapshot.</p>}</section>
    {snapshot.nativeRoleReference !== null && <section><h4>Native role reference</h4><p className="muted">Authored role reference, not text injected again by SANE.</p><pre>{snapshot.nativeRoleReference}</pre></section>}
  </div>;
}

/** Inspection only: no synthetic transcript entries or compaction placement. */
export function SystemPromptDetails({ config, sessionId, runs }: { config: Config; sessionId: string; runs: RunMetadata[] }) {
  const [open, setOpen] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState("");
  const selectId = useId();
  const ordered = runs.filter(run => run.conversationId === sessionId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const selected = ordered.find(run => run.id === selectedRunId) ?? ordered[0];
  return <section className="detail-section system-prompt-details">
    <details onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open); }}>
      <summary>System prompt</summary>
      {open && <div className="system-prompt-inspection">
        <p className="muted">Recorded SANE context. This is not the native harness’s complete system prompt.</p>
        {selected ? <>
          <label htmlFor={selectId}>Run</label>
          <select id={selectId} value={selectedRunId && ordered.some(run => run.id === selectedRunId) ? selectedRunId : ""} onChange={event => setSelectedRunId(event.target.value)}>
            <option value="">Latest recorded run</option>
            {ordered.map((run, index) => <option key={run.id} value={run.id}>Run {ordered.length - index} · {new Date(run.createdAt).toLocaleString()}{run.operation === "compact" ? " · Compaction" : ""}</option>)}
          </select>
          <PromptContent key={selected.id} config={config} run={selected} />
        </> : <p className="muted">No recorded runs. Imported conversations may not include SANE context snapshots.</p>}
      </div>}
    </details>
  </section>;
}
