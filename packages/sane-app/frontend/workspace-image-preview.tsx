import { useEffect, useState } from "react";
import { SnapshotImage } from "./snapshot-image";
import { useWorkspace } from "./workspace-controller";
import { subscribeWorkspaceMutations, workspaceClient } from "./workspace-client";
import { pathFence, requestFence, rootState, workspaceEpoch, workspaceFailure } from "./workspace-store";

type Scope = NonNullable<ReturnType<typeof useWorkspace>["scope"]>;

function WorkspaceImageReader({ scope, path, reload }: { scope: Scope; path: string; reload: () => void }) {
  const [preview, setPreview] = useState<{ src?: string; error?: string }>({});
  useEffect(() => {
    const abort = new AbortController(), root = rootState(scope.workspace), unchanged = pathFence(root, path);
    let active = true, src: string | undefined;
    const current = requestFence(scope.workspace, () => active && unchanged() && scope.auth === workspaceEpoch() && scope.reader.current() && root.selected === path);
    void workspaceClient.image(scope.id, scope.workspace.workspaceId, path, AbortSignal.any([abort.signal, AbortSignal.timeout(30000)])).then(blob => {
      if (!current()) return;
      src = URL.createObjectURL(blob);
      setPreview({ src });
    }).catch(error => {
      if (current()) setPreview({ error: workspaceFailure(error) });
    });
    return () => { active = false; abort.abort(); if (src) URL.revokeObjectURL(src); };
  }, [scope, path]);
  useEffect(() => subscribeWorkspaceMutations(mutation => {
    if (mutation.scopeId === scope.id && mutation.workspaceId === scope.workspace.workspaceId && mutation.paths.includes(path)
      && scope.auth === workspaceEpoch() && scope.reader.current()) reload();
  }), [scope, path, reload]);
  return <section className="workspace-image" aria-label={`Image preview: ${path}`}>
    <header><span>Read-only image preview · Saved disk contents</span><button type="button" onClick={reload}>Reload image</button></header>
    <div className="workspace-image-preview">
      {preview.error ? <p role="alert">{preview.error} <button type="button" onClick={reload}>Retry preview</button></p>
        : preview.src ? <SnapshotImage src={preview.src} name={path.split("/").at(-1)!} retry={reload} />
        : <p role="status">Loading image…</p>}
    </div>
  </section>;
}

/** Scope/content identity retires old object URLs before a new preview is shown. */
export function WorkspaceImagePreview() {
  const controller = useWorkspace();
  const { scope, root, selected, buffer, fileReadVersion, view } = controller;
  if (!scope || !buffer || buffer.missing || buffer.error) return <div className="workspace-empty"><p role="status">The selected image is missing or unavailable.</p></div>;
  if (view !== "code") return <div className="workspace-empty"><p>Image preview paused while Files is inactive.</p></div>;
  if (root?.mutations.has(selected)) return <div className="workspace-empty"><p role="status">A file operation is in progress…</p></div>;
  const identity = JSON.stringify([scope.id, scope.workspace.workspaceId, scope.workspace.root, scope.generation, scope.auth, root?.generation,
    selected, root?.pathVersions.get(selected), buffer.file.revision, fileReadVersion]);
  return <WorkspaceImageReader key={identity} scope={scope} path={selected} reload={controller.retrySelection} />;
}
