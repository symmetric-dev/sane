import { useEffect, useState } from "react";
import type { ArtifactSelection } from "./workstreams";
import { workstreamRequest } from "./workstreams-client";
import { ReadOnlyDocument } from "./workspace-editor";

export function WorkstreamArtifact({ artifact, close }: { artifact: ArtifactSelection; close: () => void }) {
  const [content, setContent] = useState<string | null>(null), [error, setError] = useState(""), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true; setContent(null); setError("");
    void workstreamRequest<{ content: string }>(artifact.workspaceId, "artifacts/read", { id: artifact.workstreamId, path: artifact.path }).then(result => { if (current) setContent(result.content); }).catch(e => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [artifact, attempt]);
  const filename = artifact.path.split("/").at(-1) ?? artifact.path;
  return <section className="workspace-view" aria-label="Workstream artifact"><div className="artifact-context"><strong>{filename}</strong><span className="muted"> · Read only</span><div><button onClick={close}>Close document</button> <button onClick={() => setAttempt(n => n + 1)}>Reload document</button></div><details><summary>File details</summary><dl><dt>Workstream</dt><dd>{artifact.workstreamId}</dd><dt>File</dt><dd>{artifact.path}</dd><dt>Repository ID</dt><dd>{artifact.repositoryId}</dd></dl></details></div>{error ? <div className="workspace-notice workspace-error"><p role="alert">This document could not be loaded. Try reloading it.</p><details><summary>Error details</summary><p>{error}</p></details></div> : content === null ? <p role="status">Loading document…</p> : <ReadOnlyDocument path={artifact.path} text={content} />}</section>;
}
