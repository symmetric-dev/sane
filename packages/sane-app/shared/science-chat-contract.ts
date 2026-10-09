/** Durable chat science API. Runtime outputs are observations, never source provenance. */
import type { ScienceCell } from "./science-contract";
export type ScienceTranscriptAnchor = { kind: "start" } | { kind: "after-message"; messageId: string };
export interface ScienceBlock {
  id: string; revision: number; source: string; knownSources: string[];
  anchor: ScienceTranscriptAnchor;
  /** Addition intent is durable before createCell; unknown is never replayed. */
  creation: { requestId: string; initialSource: string; expectedRevision: number; state: "pending" | "unknown" | "created"; generation: string | null } | null;
}
export interface ScienceLocalEntry { id: string; afterBlockId: string | null; text: string }
export interface ScienceOperation {
  id: string; requestId: string; blockId: string; revision: number; source: string;
  state: "unknown" | "succeeded" | "failed"; createdAt: string;
  observation: { provenance: "observed-unverified"; text: string; cell: ScienceCell | null } | null;
}
export interface ScienceShareSnapshot {
  id: string; requestId: string; blockId: string; revision: number; source: string;
  operationId: string | null; representation: "source" | "source-and-observed-text";
  /** Frozen at creation; send integrations must use this, not live notebook state. */
  agentText: string; createdAt: string;
}
export interface ScienceChatState {
  conversationId: string; workspaceId: string; worktreeId: string;
  /** Opaque fingerprint of the exact admitted App/native identity and checkout pins. */
  admissionKey: string;
  notebook: string; notebookKind: "owned" | "existing"; revision: number;
  /** Set before exclusive native file creation. Missing files thereafter fail closed. */
  notebookCreated: boolean;
  blocks: ScienceBlock[]; entries: ScienceLocalEntry[];
  operations: ScienceOperation[]; shares: ScienceShareSnapshot[];
}
export type ScienceChatRequest =
  | { action: "provision" }
  | { action: "associate-existing"; expectedRevision: number; notebook: string }
  | { action: "open" | "close" }
  | { action: "draft"; blockId: string; expectedRevision: number; source: string }
  | { action: "add-block"; requestId: string; expectedRevision: number; source: string; anchor: ScienceTranscriptAnchor }
  | { action: "entry"; expectedRevision: number; afterBlockId: string | null; text: string }
  | { action: "run"; requestId: string; blockId: string; expectedRevision: number }
  | { action: "share"; requestId: string; blockId: string; expectedRevision: number; operationId: string | null; representation: "source" | "source-and-observed-text" };
/** GET/POST /api/workspaces/:workspaceId/worktrees/:worktreeId/science/chats/:conversationId */
export interface ScienceChatResponse { chat: ScienceChatState }

/** Exact, intentionally narrow agent representation. No HTML/JSON/image coercion. */
export function materializeScienceShare(source: string, observation?: string): string {
  return `Science source (immutable; execution provenance not asserted):\n${source}`
    + (observation === undefined ? "" : `\n\nObserved output (unverified; may be stale):\n${observation}`);
}
