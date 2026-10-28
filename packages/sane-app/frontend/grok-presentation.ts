import type { Availability, GrokSessionView, Message, Run } from "./types";
import type { ReconciledHistory } from "../shared/conversation/native-history-contract";

export const GROK_CAPTURE_NOTICE = "Grok capture status only. Native acceptance is unknown; no native acceptance receipt is available.";
export const GROK_UNKNOWN_NOTICE = "Grok capture request outcome is unknown. Checking the original session only; nothing will be reposted. Start a new chat if its status cannot be resolved.";

type GrokChoices = { model: string; effort: string };
/** Inherit only Grok's configured Base values, never another harness's defaults. */
export const grokProfileChoices = (profile: GrokChoices, base?: GrokChoices): GrokChoices => ({
  model: profile.model || base?.model || "", effort: profile.effort || base?.effort || "",
});

/** Small wire sanity check; transcript projection belongs to the service. */
export function grokSessionView(value: unknown, sessionId: string): GrokSessionView {
  const view = value as GrokSessionView | null;
  if (!view || view.protocol !== "grok-capture" || view.version !== 1 || view.sessionId !== sessionId
    || !["preparing", "running", "idle", "blocked", "not-submitted"].includes(view.phase)
    || typeof view.active !== "boolean" || typeof view.blocked !== "boolean"
    || !Number.isSafeInteger(view.nextTurnIndex) || view.nextTurnIndex < 0
    || typeof view.cwd !== "string" || typeof view.authorityId !== "string"
    || typeof view.model !== "string" || typeof view.effort !== "string"
    || [view.profileId, view.agent, view.workspaceId, view.worktreeId, view.title].some(value => value !== undefined && typeof value !== "string")
    || view.agentKind !== undefined && view.agentKind !== "assistant" && view.agentKind !== "worker"
    || view.nativeAgentSelected !== undefined && typeof view.nativeAgentSelected !== "boolean"
    || view.availability !== undefined && (!view.availability || typeof view.availability.canSend !== "boolean"
      || [view.availability.reason, view.availability.code, view.availability.queueAfterRunId, view.availability.liveInputRunId].some(value => value !== undefined && typeof value !== "string")
      || view.availability.nativeQueue !== undefined && typeof view.availability.nativeQueue !== "boolean")
    || view.nativeAcceptance !== "unknown" || view.acceptedMessageId !== null
    || view.scienceSubmission !== undefined && (!view.scienceSubmission || view.scienceSubmission.conversationId !== sessionId
      || typeof view.scienceSubmission.requestId !== "string" || !view.scienceSubmission.requestId
      || !["prepared", "unknown", "submitted", "not-submitted"].includes(view.scienceSubmission.state)
      || !(view.scienceSubmission.runId === null || typeof view.scienceSubmission.runId === "string" && !!view.scienceSubmission.runId)
      || !Array.isArray(view.scienceSubmission.snapshots) || view.scienceSubmission.snapshots.some(reference => !reference || typeof reference.snapshotId !== "string" || typeof reference.blockId !== "string"))
    || !Array.isArray(view.messages) || !Array.isArray(view.runs)) throw new Error("Grok capture status is unavailable or belongs to another session.");
  return view;
}

export function grokAvailability(view: GrokSessionView, unresolved = false): Availability {
  if (unresolved) return { canSend: false, reason: GROK_UNKNOWN_NOTICE };
  if (view.blocked || view.phase === "blocked") return { canSend: false, reason: `${view.reason || "Grok continuation is blocked."} Start a new chat.` };
  if (view.availability) return view.availability;
  if (view.active || view.phase === "preparing" || view.phase === "running") return { canSend: false, reason: "Wait for the Grok capture to settle, or use Stop." };
  // Only a producer-confirmed, unblocked withholding is safe for an explicit retry.
  // Unknown native outcomes remain blocked above; this never reposts anything.
  if (view.phase === "not-submitted") return { canSend: true };
  if (view.phase !== "idle") return { canSend: false, reason: view.reason || "Grok turn was not submitted." };
  return { canSend: true };
}

/** Fill UI containers without invoking Claude's event reducer or parsing output. */
export function grokRuns(view: GrokSessionView): Run[] {
  return view.runs.map(metadata => ({ ...metadata, harness: "grok", summaryOnly: true,
    messages: view.messages.filter(message => message.runId === metadata.id), observedEfforts: [],
    events: [], cursor: 0, seen: new Set<number>(), buffer: "", resultCount: 0,
    resultKeys: new Set<string>(), toolResults: new Map() }));
}

/** Preserve native order and live Grok output. Only exact IDs establish an App
 * run association; repeated text or neighboring turns never establish one. */
export function grokMessages(view?: Pick<GrokSessionView, "messages"> | null, history?: ReconciledHistory | null): Message[] {
  const live = view?.messages ?? [];
  const byNativeId = new Map<string, Message>();
  for (const message of live) for (const id of [message.id, ...(message.nativeIds ?? [])]) byNativeId.set(id, message);
  const result: Message[] = [], emitted = new Set<string>();
  const append = (message: Message) => { if (!emitted.has(message.id)) { emitted.add(message.id); result.push(message); } };
  for (const source of history?.messages ?? []) {
    if (source.compaction || source.role === "system" && !source.parts.length) continue;
    const observed = byNativeId.get(source.messageId);
    if (observed) { append(observed); continue; }
    append({ id: source.messageId, runId: "native-import", role: source.role, time: source.createdAt,
      status: source.status, normalized: true, error: source.error, retry: source.retry,
      parts: source.parts.map(part => part.type === "tool" ? { type: "tool", id: part.id, toolCallId: part.id,
        name: part.name, input: part.input, toolStatus: part.status, output: part.output ?? part.error, error: part.error !== undefined }
        : { type: part.type, text: part.text, ...(part.type === "reasoning" ? { id: part.id } : {}) }) });
  }
  for (const message of live) append(message);
  return result;
}
