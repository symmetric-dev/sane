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
  return <section className="workspace-view" aria-label="Workstream artifact"><div className="artifact-context"><strong>Read only · {artifact.workstreamId} / {artifact.path}</strong><p>Repository: {artifact.repositoryId}</p><button onClick={close}>Close artifact</button> <button onClick={() => setAttempt(n => n + 1)}>Reload artifact</button></div>{error ? <p className="workspace-notice workspace-error" role="alert">Artifact unavailable: {error}</p> : content === null ? <p role="status">Loading artifact…</p> : <ReadOnlyDocument path={artifact.path} text={content} />}</section>;
}
