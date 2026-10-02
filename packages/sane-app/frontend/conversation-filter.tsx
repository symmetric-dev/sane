import Fuse from "fuse.js";
import { sameAssignment } from "./assignment-semantics";
import { harnessName, harnessShort, type Conversation, type Harness, type RunStatus } from "./types";

export type ConversationFilterState = {
  query: string;
  workspaceId: string | null | "all" | "unavailable";
  worktreeId: string | null | "all";
  harness: "all" | Harness;
  status: "all" | RunStatus;
  workstreamId: "all" | "unknown" | "unassigned" | string;
  phase: "all" | string;
  showDeleted?: boolean;
};

export type WorkstreamMembership = { workstreamId: string | null; phases: string[] };

export type FilterConversationsOptions = {
  includeReplaced?: boolean;
  workstreamMap?: Map<string, WorkstreamMembership>;
  searchText?: (c: Conversation) => string;
};

export const defaultFilterFor = (
  workspaceId: string | null,
  worktreeId: string | null,
): ConversationFilterState => ({
  query: "",
  workspaceId: workspaceId ?? "all",
  worktreeId: worktreeId ?? "all",
  harness: "all",
  status: "all",
  workstreamId: "all",
  phase: "all",
  showDeleted: false,
});

const defaultSearchText = (c: Conversation): string =>
  `${c.title || ""} ${c.cwd} ${c.id} ${c.harness} ${harnessName(c.harness)} ${harnessShort(c.harness)}`;

const normalizeWorkstreamId = (value: string): string =>
  value.startsWith("workstream:") ? value.slice("workstream:".length) : value;

function matchesQuery(conversations: Conversation[], query: string, searchText: (c: Conversation) => string): Set<string> | null {
  const q = query.trim();
  if (!q) return null;
  try {
    const fuse = new Fuse(conversations, {
      keys: [{ name: "__search", getFn: (c: Conversation) => searchText(c) }],
      threshold: 0.4,
      ignoreLocation: true,
      includeScore: false,
    } as any);
    const hits = fuse.search(q);
    if (hits.length > 0) return new Set(hits.map(h => h.item.id));
    // Fuse found nothing: fall through to substring check so exact ids still match.
  } catch {
    // fuse.js unavailable or misconfigured: fall back to substring matching.
  }
  const lowered = q.toLowerCase();
  const matched = conversations.filter(c => searchText(c).toLowerCase().includes(lowered));
  return new Set(matched.map(c => c.id));
}

export function filterConversations(
  conversations: Conversation[],
  filter: ConversationFilterState,
  opts: FilterConversationsOptions = {},
): Conversation[] {
  const searchText = opts.searchText ?? defaultSearchText;
  const queryHits = matchesQuery(conversations, filter.query, searchText);
  const phaseActive = filter.phase !== "all" && filter.phase !== "";
  const workstreamActive = filter.workstreamId !== "all";

  return conversations.filter(c => {
    if (c.replacedBy && !opts.includeReplaced) return false;
    if (!filter.showDeleted && c.hidden && !(c.replacedBy && opts.includeReplaced)) return false;
    if (queryHits && !queryHits.has(c.id)) return false;
    if (filter.harness !== "all" && c.harness !== filter.harness) return false;
    if (filter.status !== "all" && c.status !== filter.status) return false;

    if (filter.workspaceId === "unavailable") {
      if (c.workspaceId) return false;
    } else if (filter.workspaceId !== null && filter.workspaceId !== "all") {
      if (c.workspaceId !== filter.workspaceId) return false;
    }

    if (filter.worktreeId !== null && filter.worktreeId !== "all") {
      if (c.worktreeId !== filter.worktreeId) return false;
    }

    if (workstreamActive || phaseActive) {
      const entry = opts.workstreamMap?.get(c.id);
      if (workstreamActive) {
        if (filter.workstreamId === "unknown") {
          if (entry !== undefined) return false;
        } else if (filter.workstreamId === "unassigned") {
          if (!entry || entry.workstreamId !== null) return false;
        } else {
          const want = normalizeWorkstreamId(filter.workstreamId);
          const got = entry?.workstreamId ? normalizeWorkstreamId(entry.workstreamId) : null;
          if (got !== want) return false;
        }
      }
      if (phaseActive) {
        const phases = entry?.phases ?? [];
        if (!phases.some(phase => sameAssignment(phase, filter.phase))) return false;
      }
    }

    return true;
  });
}

/** Display-only title shortening: first line, max 60 chars with trailing …. Never persists. */
export function formatTitle(title: string | undefined, fallback: string): string {
  const line = title?.split("\n")[0]?.trim() || fallback.trim() || "Conversation";
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}
