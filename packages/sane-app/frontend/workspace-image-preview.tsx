import { useEffect, useSyncExternalStore } from "react";
import { SnapshotImage } from "./snapshot-image";
import { useWorkspace } from "./workspace-controller";
import { IMAGE_CACHE_LIMITS, workspaceImageCache } from "./workspace-image-cache";

type Scope = NonNullable<ReturnType<typeof useWorkspace>["scope"]>;

function WorkspaceImageReader({ scope, path, reload }: { scope: Scope; path: string; reload: () => void }) {
  useSyncExternalStore(workspaceImageCache.subscribe, workspaceImageCache.snapshot);
  const preview = workspaceImageCache.peek(scope, path) ?? {};
  useEffect(() => workspaceImageCache.acquire(scope, path), [scope, path]);
  useEffect(() => {
    const refresh = () => { if (!document.hidden) workspaceImageCache.revalidate(scope, path); };
    const timer = setInterval(refresh, IMAGE_CACHE_LIMITS.refreshMs);
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [scope, path]);
  return <section className="workspace-image" aria-label={`Image preview: ${path}`} aria-busy={preview.checking}>
    <header><span>{preview.src && preview.checking ? "Cached preview · Checking disk for changes…" : "Read-only image preview · Saved disk contents"}</span><button type="button" onClick={reload}>Reload image</button></header>
    <div className="workspace-image-preview">
      {preview.error ? <p role="alert">{preview.error} <button type="button" onClick={reload}>Retry preview</button></p>
        : preview.src ? <SnapshotImage key={preview.src} src={preview.src} name={path.split("/").at(-1)!} retry={reload} />
        : <p role="status">Loading image…</p>}
    </div>
  </section>;
}

/** Navigation retires the reader, but reusable bytes belong to the bounded cache. */
export function WorkspaceImagePreview() {
  const controller = useWorkspace();
  const { scope, root, selected, buffer, fileReadVersion, view } = controller;
  if (!scope || !buffer || buffer.missing || buffer.error) return <div className="workspace-empty"><p role="status">The selected image is missing or unavailable.</p></div>;
  if (view !== "code") return <div className="workspace-empty"><p>Image preview paused while Files is inactive.</p></div>;
  if (root?.mutations.has(selected)) return <div className="workspace-empty"><p role="status">A file operation is in progress…</p></div>;
  const identity = JSON.stringify([scope.id, scope.workspace.workspaceId, scope.workspace.root, scope.generation, scope.auth, root?.generation,
    selected, root?.pathVersions.get(selected), buffer.file.revision, fileReadVersion]);
  const reload = () => { workspaceImageCache.invalidate(scope.id, scope.workspace.workspaceId, [selected]); controller.retrySelection(); };
  return <WorkspaceImageReader key={identity} scope={scope} path={selected} reload={reload} />;
}
