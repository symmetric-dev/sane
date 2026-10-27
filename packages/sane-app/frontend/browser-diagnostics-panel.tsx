import { useEffect, useRef, useState } from "react";
import type { BrowserConsoleLogsResult, BrowserConsoleSeverity, BrowserNetworkRequestsResult, BrowserScreenshotResult } from "../shared/browser-host-contract";
import { captureHostBrowserScreenshot, deleteHostBrowserArtifact, listHostBrowserArtifacts, queryHostBrowserConsole, queryHostBrowserNetwork, type BrowserArtifact } from "./browser-host-client";

type Props = { workspaceId: string; tabId: string; generation: number; running: boolean; close: () => void };
export function BrowserDiagnosticsPanel({ workspaceId, tabId, generation, running, close }: Props) {
  const [section, setSection] = useState<"console" | "network" | "captures">("console");
  const [severity, setSeverity] = useState<"all" | BrowserConsoleSeverity>("all"), [onlyFailed, setOnlyFailed] = useState(false);
  const [consolePage, setConsolePage] = useState<BrowserConsoleLogsResult | null>(null), [networkPage, setNetworkPage] = useState<BrowserNetworkRequestsResult | null>(null);
  const [artifacts, setArtifacts] = useState<BrowserArtifact[]>([]), [capture, setCapture] = useState<BrowserScreenshotResult | null>(null);
  const [refresh, setRefresh] = useState(0), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const operation = useRef<AbortController | null>(null);
  const pending = useRef(false);
  useEffect(() => {
    setCapture(null); setConsolePage(null); setNetworkPage(null); setError(""); setBusy(false); pending.current = false;
    return () => { operation.current?.abort(); };
  }, [workspaceId, tabId, generation]);
  useEffect(() => {
    const controller = new AbortController(), signal = controller.signal;
    setLoading(true); setError(""); setConsolePage(null); setNetworkPage(null);
    void (async () => {
      try {
        if (section === "captures") {
          const result = await listHostBrowserArtifacts(workspaceId, signal);
          if (!signal.aborted) setArtifacts(result.artifacts);
        } else if (running && section === "console") {
          const result = await queryHostBrowserConsole(workspaceId, tabId, { limit: 500, severity: severity === "all" ? undefined : severity }, signal);
          if (!signal.aborted && result.generation === generation) setConsolePage(result);
        } else if (running) {
          const result = await queryHostBrowserNetwork(workspaceId, tabId, { limit: 500, onlyFailed }, signal);
          if (!signal.aborted && result.generation === generation) setNetworkPage(result);
        }
      } catch (failure) { if (!signal.aborted) setError(failure instanceof Error ? failure.message : "Could not load diagnostics."); }
      finally { if (!signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [workspaceId, tabId, generation, running, section, severity, onlyFailed, refresh]);
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (pending.current) return;
    const controller = new AbortController(); operation.current = controller; pending.current = true; setBusy(true); setError("");
    try { await action(controller.signal); }
    catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Capture or artifact change failed. Refresh before retrying."); }
    finally { if (!controller.signal.aborted) { pending.current = false; setBusy(false); } }
  }
  const takeCapture = (fullPage: boolean, saveArtifact = false) => void run(async signal => {
    const result = await captureHostBrowserScreenshot(workspaceId, tabId, { fullPage, format: "png", saveArtifact }, signal);
    if (!signal.aborted && result.generation === generation) { setCapture(result); if (saveArtifact) setRefresh(value => value + 1); }
  });
  const page = section === "console" ? consolePage : networkPage;
  const dataUrl = capture ? `data:${capture.mimeType};base64,${capture.data}` : "";
  return <aside className="browser-diagnostics" aria-label="Host browser diagnostics">
    <header><strong>Diagnostics</strong><span>Tab {tabId} · generation {generation}</span><button type="button" onClick={close} aria-label="Close diagnostics">Close</button></header>
    <div className="browser-diagnostics-tabs" role="tablist" aria-label="Diagnostics sections">
      {([["console", "Console & Exceptions"], ["network", "Network"], ["captures", "Captures & Artifacts"]] as const).map(([id, label]) => <button type="button" key={id} role="tab" id={`browser-diagnostics-${tabId}-${id}`} aria-selected={section === id} aria-controls={`browser-diagnostics-body-${tabId}`} onClick={() => setSection(id)}>{label}</button>)}
    </div>
    <div className="browser-diagnostics-body" role="tabpanel" id={`browser-diagnostics-body-${tabId}`} aria-labelledby={`browser-diagnostics-${tabId}-${section}`}>
      <div className="browser-diagnostics-actions">
        {section === "console" && <label>Severity <select value={severity} onChange={event => setSeverity(event.target.value as typeof severity)}>{["all", "log", "info", "warn", "error", "exception"].map(value => <option key={value} value={value}>{value}</option>)}</select></label>}
        {section === "network" && <label><input type="checkbox" checked={onlyFailed} onChange={event => setOnlyFailed(event.target.checked)} />Only failed</label>}
        <button type="button" disabled={loading || busy} onClick={() => setRefresh(value => value + 1)}>Refresh</button>
      </div>
      {loading && <p role="status">Loading diagnostics…</p>}
      {error && <p className="browser-host-banner" role="alert">{error}</p>}
      {page && <p className="muted">Collection started: {page.collectionStartedAt ?? "Not started"} · target {page.targetId ?? "none"} · generation {page.generation}</p>}
      {!!page?.truncatedCount && <p className="browser-host-banner" role="status">{page.truncatedCount} earlier records were truncated. Earliest available sequence: {page.earliestAvailableSeq}.</p>}
      {!running && section !== "captures" && <p>Start the host tab to collect diagnostics.</p>}
      {section === "console" && consolePage && <ul className="browser-console-entries">{consolePage.entries.map(entry => <li key={entry.seq}>
        <span className={`browser-severity browser-severity-${entry.severity}`}>{entry.severity}</span><time dateTime={entry.timestamp}>{entry.timestamp}</time>
        <pre>{entry.text}{entry.truncated ? " [truncated]" : ""}</pre>
        {entry.url && <small>{entry.url}{entry.lineNumber !== undefined ? `:${entry.lineNumber}` : ""}{entry.columnNumber !== undefined ? `:${entry.columnNumber}` : ""}</small>}
      </li>)}{!consolePage.entries.length && <li>No console entries for this filter.</li>}</ul>}
      {section === "network" && networkPage && <div className="browser-network-table"><table><thead><tr><th>Method</th><th>Status</th><th>Duration</th><th>Type</th><th>Sanitized URL / Failure</th></tr></thead><tbody>{networkPage.entries.map(entry => <tr key={entry.seq}>
        <td>{entry.method}</td><td>{entry.status ?? (entry.failed ? "Failed" : "Pending")}</td><td>{entry.durationMs === undefined ? "—" : `${Math.round(entry.durationMs)} ms`}</td><td>{entry.resourceType ?? "—"}</td><td>{entry.url}{entry.failureText && <strong>{entry.failureText}</strong>}</td>
      </tr>)}</tbody></table>{!networkPage.entries.length && <p>No network requests for this filter.</p>}</div>}
      {section === "captures" && <>
        <div className="browser-diagnostics-actions"><button type="button" disabled={!running || busy} onClick={() => takeCapture(false)}>Capture Viewport PNG</button><button type="button" disabled={!running || busy} onClick={() => takeCapture(true)}>Capture Full Page PNG</button><button type="button" disabled={!running || busy} onClick={() => takeCapture(capture?.fullPage ?? false, true)}>Save Artifact to Host</button></div>
        <p className="muted">Save captures a new PNG on the SANE host. Files are stored under &lt;dataDir&gt;/browser-artifacts/.</p>
        {busy && <p role="status">Updating capture or artifact…</p>}
        {capture && <figure className="browser-capture"><img src={dataUrl} alt={`Host tab capture at ${capture.capturedAt}`} /><figcaption>Generation {capture.generation} · document {capture.documentId} · {capture.capturedAt}<a href={dataUrl} download={`browser-${tabId}-${capture.capturedAt.replace(/[:.]/g, "-")}.png`}>Download PNG</a>{capture.savedArtifactPath && <span>Saved on host: {capture.savedArtifactPath}</span>}</figcaption></figure>}
        <h3>Saved host artifacts</h3><ul className="browser-artifacts">{artifacts.map(artifact => <li key={artifact.artifactId}><span>{artifact.path}<small>{artifact.capturedAt} · {Math.ceil(artifact.bytes / 1024)} KB · tab {artifact.tabId}</small></span><button type="button" disabled={busy} aria-label={`Delete artifact ${artifact.artifactId}`} onClick={() => void run(async signal => {
          const result = await deleteHostBrowserArtifact(workspaceId, artifact.artifactId, signal);
          if (!signal.aborted) { if (!result.deleted) throw new Error("Artifact deletion was not confirmed."); setRefresh(value => value + 1); }
        })}>Delete</button></li>)}</ul>{!loading && !artifacts.length && <p>No saved artifacts in this workspace.</p>}
      </>}
    </div>
  </aside>;
}
