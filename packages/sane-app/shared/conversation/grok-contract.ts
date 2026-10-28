import type { Message, RunMetadata } from "./types";

/** Runtime choices are native free text, not Claude models or catalog variants. */
export const validGrokChoice = (value: unknown): value is string => typeof value === "string"
  && value.trim().length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);

/** App capture protocol, not a native-acceptance receipt or a core conversation. */
export type GrokTurnInput = {
  sessionId: string;
  turnIndex: number;
  prompt: string;
  model: string;
  effort: string;
  cwd?: string;
  workspaceId?: string | null;
  worktreeId?: string | null;
};

export type GrokCapability = {
  protocol: "grok-capture";
  version: 1;
  configured: boolean;
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
  phase: "preparing" | "running" | "idle" | "blocked" | "not-submitted";
  nextTurnIndex: number;
  active: boolean;
  blocked: boolean;
  reason?: string;
  nativeAcceptance: "unknown";
  acceptedMessageId: null;
  messages: Message[];
  runs: RunMetadata[];
};

export type GrokStopView = {
  interrupted: false;
  nativeCancellation: "not-attempted" | "unproven";
  wrapperClosed: boolean;
  reason: string;
};
