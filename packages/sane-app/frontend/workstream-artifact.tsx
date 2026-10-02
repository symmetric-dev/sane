import { useEffect, useState } from "react";
import type { ArtifactSelection } from "./workstreams";
import { workstreamRequest } from "./workstreams-client";
import { ReadOnlyDocument } from "./workspace-editor";
import { DocumentMarkdown } from "./document-markdown";
import "./workstream-content.css";

export function WorkstreamArtifact({ artifact, close }: { artifact: ArtifactSelection; close: () => void }) {
  // Local reading navigation never changes the selected conversation or its recipient.
  const selectionScope = JSON.stringify([artifact.workspaceId, artifact.repositoryId, artifact.workstreamId, artifact.path]);
  const [selection, setSelection] = useState<{ scope: string; path: string; fragment?: string }>({ scope: selectionScope, path: artifact.path });
  const path = selection.scope === selectionScope ? selection.path : artifact.path;
  const fragment = selection.scope === selectionScope ? selection.fragment : undefined;
  const scope = JSON.stringify([artifact.workspaceId, artifact.repositoryId, artifact.workstreamId, path]);
  const [result, setResult] = useState<{ scope: string; content: string; revision: string | null } | null>(null);
  const [failure, setFailure] = useState<{ scope: string; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [sourcePaths, setSourcePaths] = useState<Set<string>>(() => new Set());
  const source = sourcePaths.has(scope);
  useEffect(() => {
    let current = true;
    setResult(null); setFailure(null);
    void workstreamRequest<{ content: string; revision: string | null }>(artifact.workspaceId, "artifacts/read", { id: artifact.workstreamId, path, repositoryId: artifact.repositoryId }).then(value => {
      if (current) setResult({ scope, ...value });
    }).catch(error => { if (current) setFailure({ scope, message: error instanceof Error ? error.message : String(error) }); });
    return () => { current = false; };
  }, [artifact.workspaceId, artifact.repositoryId, artifact.workstreamId, path, scope, attempt]);
  const document = result?.scope === scope ? result : null;
  const error = failure?.scope === scope ? failure.message : null;
  const filename = path.split("/").at(-1) ?? path;
  const setSource = (enabled: boolean) => setSourcePaths(previous => {
    const next = new Set(previous);
    if (enabled) next.add(scope); else next.delete(scope);
    return next;
  });
  return <section className="workspace-view workstream-artifact-view" aria-label="Workstream artifact">
    <div className="artifact-context">
      <div className="workstream-artifact-heading"><strong>{filename}</strong><span className="muted">Read only</span></div>
      <div className="workstream-artifact-actions">
        <div className="workstream-artifact-mode" role="group" aria-label="Document view"><button type="button" aria-pressed={!source} onClick={() => setSource(false)}>Render</button><button type="button" aria-pressed={source} onClick={() => setSource(true)}>Source</button></div>
        {path !== artifact.path && <button type="button" className="text-button" onClick={() => setSelection({ scope: selectionScope, path: artifact.path })}>Back to original document</button>}
        <button type="button" className="text-button" onClick={() => setAttempt(value => value + 1)}>Reload document</button>
        <button type="button" className="text-button" onClick={close}>Close document</button>
      </div>
      <details><summary>File details</summary><dl className="workstream-content-facts"><dt>Workstream</dt><dd>{artifact.workstreamId}</dd><dt>File</dt><dd>{path}</dd><dt>Repository ID</dt><dd>{artifact.repositoryId}</dd><dt>Revision</dt><dd>{document?.revision ?? "Not available"}</dd></dl></details>
    </div>
    <div className={`workstream-artifact-body${source ? " is-source" : ""}`} key={scope}>
      {error ? <div className="workspace-notice workspace-error"><p role="alert">This document could not be loaded. Try reloading it.</p><details><summary>Error details</summary><p>{error}</p></details></div>
        : !document ? <p role="status">Loading document…</p>
        : source ? <ReadOnlyDocument path={path} text={document.content} />
        : <DocumentMarkdown path={path} text={document.content} fragment={fragment} onOpenDocument={(next, fragment) => setSelection({ scope: selectionScope, path: next, fragment })} />}
    </div>
  </section>;
}
