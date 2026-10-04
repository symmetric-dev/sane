import { defaultFilterFor, type ConversationFilterState } from "./conversation-filter";

const STORAGE_KEY = "sane.workspace.workstreamSelection";
type StoredSelection = { version: 2; workspaceId: string | null; workstreamId: string | null; filter: ConversationFilterState };
const scope = (value: unknown): value is string | null => value === null || (typeof value === "string" && !!value.trim());
function isFilter(value: unknown): value is ConversationFilterState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const filter = value as Partial<ConversationFilterState>;
  return typeof filter.query === "string" && filter.query.length <= 200 && scope(filter.workspaceId) && scope(filter.worktreeId)
    && ["all", "claude-code", "opencode"].includes(filter.harness ?? "")
    && ["all", "starting", "running", "completed", "failed", "interrupted", "unknown"].includes(filter.status ?? "")
    && typeof filter.workstreamId === "string" && !!filter.workstreamId.trim()
    && typeof filter.phase === "string" && (filter.showDeleted === undefined || typeof filter.showDeleted === "boolean");
}

export function clearWorkstreamSelection() {
  try { if (typeof window !== "undefined") window.sessionStorage.removeItem(STORAGE_KEY); }
  catch { /* Browser storage is optional; in-memory selection still works. */ }
}

export function readWorkstreamSelection(): StoredSelection | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved: unknown = JSON.parse(raw);
    if (saved && typeof saved === "object" && !Array.isArray(saved) && "version" in saved
      && "workspaceId" in saved && scope(saved.workspaceId) && "workstreamId" in saved && scope(saved.workstreamId)) {
      if (saved.version === 2 && "filter" in saved && isFilter(saved.filter)) {
        return { version: 2, workspaceId: saved.workspaceId, workstreamId: saved.workstreamId, filter: saved.filter };
      }
      // Preserve selections made before full filter persistence was added.
      if (saved.version === 1 && saved.workspaceId && saved.workstreamId) {
        return { version: 2, workspaceId: saved.workspaceId, workstreamId: saved.workstreamId,
          filter: { ...defaultFilterFor(saved.workspaceId, null), workstreamId: `workstream:${saved.workstreamId}` } };
      }
    }
  } catch { /* Corrupt or unavailable storage must not block startup. */ }
  clearWorkstreamSelection();
  return null;
}

export function saveWorkstreamSelection(workspaceId: string | null, workstreamId: string | null, filter: ConversationFilterState) {
  try {
    if (typeof window === "undefined") return;
    const value = JSON.stringify({ version: 2, workspaceId, workstreamId, filter } satisfies StoredSelection);
    if (window.sessionStorage.getItem(STORAGE_KEY) !== value) window.sessionStorage.setItem(STORAGE_KEY, value);
  } catch { /* Browser storage is optional; in-memory selection still works. */ }
}
