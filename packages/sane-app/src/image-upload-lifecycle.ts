import { WorkspaceError } from "./workspace";

/** Upload ownership includes request cleanup and any in-flight repository
 * publication. Shutdown aborts intake before waiting for these writers. */
export function createImageUploadLifecycle() {
  const shutdown = new AbortController();
  const active = new Set<Promise<void>>();
  let drain: Promise<void> | undefined;
  const assertOpen = () => {
    if (shutdown.signal.aborted) throw new WorkspaceError(503, "image-upload-shutdown", "Image uploads are shutting down");
  };
  return {
    assertOpen,
    async run<T>(requestSignal: AbortSignal, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
      assertOpen();
      if (requestSignal.aborted) throw new WorkspaceError(499, "image-upload-aborted", "Image upload cancelled");
      const done = Promise.withResolvers<void>();
      active.add(done.promise);
      try { return await action(AbortSignal.any([requestSignal, shutdown.signal])); }
      finally { done.resolve(); active.delete(done.promise); }
    },
    close(): Promise<void> {
      if (drain) return drain;
      shutdown.abort();
      return drain = Promise.all([...active]).then(() => {});
    },
  };
}
