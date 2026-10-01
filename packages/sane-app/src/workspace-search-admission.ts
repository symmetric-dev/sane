// Shared by every WorkspaceService in the process, including both bridge APIs.
// No waiting queue: cancelled callers cannot leave unbounded queued searches.
let active = 0;
export function admitWorkspaceSearch(): (() => void) | undefined {
  if (active >= 2) return undefined;
  active++;
  let released = false;
  return () => { if (!released) { released = true; active--; } };
}
