import type { WorkstreamMembership } from "./conversation-filter";

const STORAGE_KEY = "sane.workspace.workstreamMembership";
const MAX_AGE = 30 * 60 * 1000;
const MAX_ENTRIES = 10_000;
const MAX_CHARS = 1_000_000;
type StoredMembership = { version: 1; workspaceId: string; savedAt: number; entries: [string, WorkstreamMembership][] };

export function clearWorkstreamMembership() {
  try { if (typeof window !== "undefined") window.sessionStorage.removeItem(STORAGE_KEY); }
  catch { /* Browser storage is optional. */ }
}

/** Only the last browsing workspace is cached; fresh overview data always wins. */
export function readWorkstreamMembership(workspaceId: string | null): Map<string, WorkstreamMembership> | null {
  try {
    if (!workspaceId || typeof window === "undefined") return null;
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw || raw.length > MAX_CHARS) return null;
    const saved = JSON.parse(raw) as StoredMembership | null;
    if (!saved || saved.version !== 1 || saved.workspaceId !== workspaceId || typeof saved.savedAt !== "number"
      || !Number.isFinite(saved.savedAt) || saved.savedAt > Date.now() || Date.now() - saved.savedAt > MAX_AGE
      || !Array.isArray(saved.entries) || saved.entries.length > MAX_ENTRIES) return null;
    if (!saved.entries.every(entry => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string"
      && entry[1] && typeof entry[1] === "object" && (entry[1].workstreamId === null || typeof entry[1].workstreamId === "string")
      && Array.isArray(entry[1].phases) && entry[1].phases.every(phase => typeof phase === "string"))) return null;
    return new Map(saved.entries);
  } catch { return null; }
}

export function saveWorkstreamMembership(workspaceId: string, membership: Map<string, WorkstreamMembership>) {
  try {
    if (typeof window === "undefined") return;
    // Reject an oversized snapshot rather than truncate membership and silently
    // exclude sessions from a restored filter.
    if (membership.size > MAX_ENTRIES) { clearWorkstreamMembership(); return; }
    const value = JSON.stringify({ version: 1, workspaceId, savedAt: Date.now(), entries: [...membership] } satisfies StoredMembership);
    if (value.length > MAX_CHARS) { clearWorkstreamMembership(); return; }
    window.sessionStorage.setItem(STORAGE_KEY, value);
  } catch { /* Missing, full or unavailable storage must not block refreshes. */ }
}
