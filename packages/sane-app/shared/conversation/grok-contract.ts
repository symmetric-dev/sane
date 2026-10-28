import type { Message, RunMetadata, ScienceSnapshotReference, ScienceSubmissionView } from "./types";

/** Runtime choices are native free text, not Claude models or catalog variants. */
export const validGrokChoice = (value: unknown): value is string => typeof value === "string"
  && value.trim().length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);

/** App capture protocol, not a native-acceptance receipt or a core conversation. */
export type GrokTurnInput = {
  sessionId: string;
  turnIndex: number;
  prompt: string;
  /** Original science-domain request identity and immutable references. The
   * managed route validates/resolves payloads; legacy capture cannot share. */
  requestId?: string;
  scienceSnapshots?: ScienceSnapshotReference[];
  /** Required acknowledgment for sending into an attached native conversation. */
  nativeStopped?: boolean;
  model: string;
  effort: string;
  /** Saved profile selector; the service resolves role/instructions authoritatively. */
  profileId?: string;
  cwd?: string;
  workspaceId?: string | null;
  worktreeId?: string | null;
};

export type GrokCapability = {
  protocol: "grok-capture";
  version: 1;
  configured: boolean;
  /** Advertise only when Base -> assistant switches deliver the new bootstrap. */
  profileUpgrades?: boolean;
  reason?: string;
};

export type GrokSessionView = {
  protocol: "grok-capture";
  version: 1;
  sessionId: string;
  nativeSessionId: string | null;
  authorityId: string;
  cwd: string;
  model: string;
  effort: string;
  /** Saved execution metadata, not client assertions or native receipts. */
  profileId?: string;
  agent?: string;
  agentKind?: "assistant" | "worker";
  nativeAgentSelected?: boolean;
  workspaceId?: string;
  worktreeId?: string;
  title?: string;
  phase: "preparing" | "running" | "idle" | "blocked" | "not-submitted";
  nextTurnIndex: number;
  active: boolean;
  blocked: boolean;
  /** App/native readiness, including queue fences. Not a native acceptance receipt. */
  availability?: { canSend: boolean; reason?: string; code?: string; queueAfterRunId?: string; nativeQueue?: boolean; liveInputRunId?: string };
  reason?: string;
  nativeAcceptance: "unknown";
  acceptedMessageId: null;
  /** Science-domain evidence only; never a native-acceptance receipt. */
  scienceSubmission?: ScienceSubmissionView;
  messages: Message[];
  runs: RunMetadata[];
};

export type GrokStopView = {
  /** Whether the App interrupted its owned execution, not provider cancellation. */
  interrupted: boolean;
  nativeCancellation: "not-attempted" | "unproven";
  wrapperClosed: boolean;
  reason: string;
};
