/** Shared bridge contract. Message events are full UPSERT snapshots, never deltas.
 * Replace by messageId across all runs of a session; preserve parts array order.
 * POST /api/sessions: harness defaults to claude-code; OC model is provider/model,
 * effort is the exact native variant ID, omitted means native default.
 */
export type Harness = "claude-code" | "opencode";
export type CompactionTrigger = "auto" | "manual" | "unknown";
export type CompactionLifecycle = "requested" | "running" | "completed" | "failed" | "skipped" | "unconfirmed";
/** Native evidence only. A completed run, idle session, or disappearing inbox
 * item is not compaction completion. Times are absent when native lacks them. */
export type CompactionMetadata = {
  trigger: CompactionTrigger; lifecycle: CompactionLifecycle;
  nativeId?: string; startedAt?: string; endedAt?: string;
  preTokens?: number; postTokens?: number; durationMs?: number;
  instructions?: string; summary?: string; error?: unknown;
  /** Summarizer usage is evidence, never conversational context usage. */
  summaryUsage?: { cost?: number; tokens?: unknown };
  /** Original native boundary metadata, including unmodeled native fields. */
  nativeMetadata?: Record<string, unknown>;
};
/** One attempt, not a conversation turn. id is stable during replay; nativeId
 * is retained separately so imported boundaries can merge with live evidence. */
export type CompactionRecord = CompactionMetadata & {
  id: string; sessionId: string; harness: Harness; runId?: string;
  requestId?: string; nativeRequestId?: string; nativeAdmittedId?: string;
  requestedAt?: string; observedAt?: string; contextReset: boolean;
};
/** POST /api/sessions/:id/compact. Request ID is a client-generated UUID and
 * MUST be persisted before native submission. Retries return the existing run;
 * they never resend an uncertain native mutation. Instructions are CC-only.
 * nativeStopped is operator confirmation for CC, not permission to interrupt. */
export type CompactRequest = { requestId: string; instructions?: string; nativeStopped?: boolean };
export type CompactEligibility = {
  eligible: boolean; reason?: string; supportsInstructions: boolean;
  nativeActivity: "active" | "idle" | "unknown"; requiresNativeStopped?: boolean;
};
/** GET /api/sessions/:id/compact observes only; it never initiates compaction. */
export type CompactState = {
  sessionId: string; eligibility: CompactEligibility; operations: CompactionRecord[];
  /** Atomic native-history snapshot revision for UI invalidation, not outcome evidence. */
  nativeHistoryImportedAt?: string;
};
/** HTTP acceptance describes admission, NOT completion. */
export type CompactResponse = { sessionId: string; runId: string; operation: CompactionRecord };
export type MessagePart =
  | { id: string; type: "text" | "reasoning"; text: string }
  | { id: string; type: "tool"; name: string; status: string; input?: unknown; output?: unknown; error?: unknown };
export type MessageSnapshot = {
  messageId: string; role: "user" | "assistant" | "system"; parts: MessagePart[];
  status: "running" | "completed" | "failed" | "unknown"; createdAt: string;
  model?: string; contextReset?: boolean;
  usage?: { cost?: number; tokens?: unknown }; error?: unknown;
  compaction?: CompactionMetadata;
};
export type HarnessModel = { id: string; name: string; efforts: { id: string; name: string }[]; contextWindow?: number };
export type FormOption = { value: string; label: string; description?: string };
type FormBase = { key: string; title?: string; description?: string; required?: boolean; hidden?: boolean; when?: { key: string; op: "eq" | "neq"; value: string | number | boolean }[] };
export type FormField =
  | (FormBase & { type: "string"; format?: "email" | "uri" | "date" | "date-time"; minLength?: number; maxLength?: number; pattern?: string; placeholder?: string; default?: string; options?: FormOption[]; custom?: boolean })
  | (FormBase & { type: "boolean"; default?: boolean })
  | (FormBase & { type: "number" | "integer"; minimum?: number | string; maximum?: number | string; default?: number | string })
  | (FormBase & { type: "multiselect"; options: FormOption[]; minItems?: number; maxItems?: number; custom?: boolean; default?: string[] })
  | { key: string; type: "external"; url: string; title?: string; description?: string };
/** GET /api/sessions/:id/interactions -> { interactions: Interaction[] }.
 * Native form fields retain their V2 types/options/when constraints.
 */
export type Interaction = {
  id: string; type: "permission" | "question"; title: string; description?: string;
  options?: { id: string; name: string }[]; fields?: FormField[];
};
/** POST /api/sessions/:id/interactions/:interactionId/reply -> { ok: true } */
export type InteractionReply =
  | { type: "permission"; decision: "once" | "always" | "reject"; message?: string }
  | { type: "question"; answer: Record<string, string | number | boolean | string[]> };
/** POST /api/sessions/:id/cancel with {} -> { interrupted: boolean }.
 * Only the selected App-owned run may be cancelled. OC status settles by native
 * observation, not HTTP acceptance; CC status settles after its process group exits.
 * Repeated stops with no App owner are safe no-ops, never external interrupts.
 */
export type CancelResponse = { interrupted: boolean };
