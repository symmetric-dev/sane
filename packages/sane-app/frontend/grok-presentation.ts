import type { Availability, GrokSessionView, Run } from "./types";

export const GROK_CAPTURE_NOTICE = "Grok capture status only. Native acceptance is unknown; no native acceptance receipt is available.";
export const GROK_UNKNOWN_NOTICE = "Grok capture request outcome is unknown. Checking the original session only; nothing will be reposted. Start a new chat if its status cannot be resolved.";

/** Small wire sanity check; transcript projection belongs to the service. */
export function grokSessionView(value: unknown, sessionId: string): GrokSessionView {
  const view = value as GrokSessionView | null;
  if (!view || view.protocol !== "grok-capture" || view.version !== 1 || view.sessionId !== sessionId
    || !["preparing", "running", "idle", "blocked", "not-submitted"].includes(view.phase)
    || typeof view.active !== "boolean" || typeof view.blocked !== "boolean"
    || !Number.isSafeInteger(view.nextTurnIndex) || view.nextTurnIndex < 0
    || typeof view.cwd !== "string" || typeof view.authorityId !== "string"
    || typeof view.model !== "string" || typeof view.effort !== "string"
    || view.nativeAcceptance !== "unknown" || view.acceptedMessageId !== null
    || !Array.isArray(view.messages) || !Array.isArray(view.runs)) throw new Error("Grok capture status is unavailable or belongs to another session.");
  return view;
}

export function grokAvailability(view: GrokSessionView, unresolved = false): Availability {
  if (unresolved) return { canSend: false, reason: GROK_UNKNOWN_NOTICE };
  if (view.blocked || view.phase === "blocked") return { canSend: false, reason: `${view.reason || "Grok continuation is blocked."} Start a new chat.` };
  if (view.active || view.phase === "preparing" || view.phase === "running") return { canSend: false, reason: "Wait for the Grok capture to settle, or use Stop." };
  if (view.phase !== "idle") return { canSend: false, reason: `${view.reason || "Grok turn was not submitted."} Start a new chat.` };
  return { canSend: true };
}

/** Fill UI containers without invoking Claude's event reducer or parsing output. */
export function grokRuns(view: GrokSessionView): Run[] {
  return view.runs.map(metadata => ({ ...metadata, harness: "grok", summaryOnly: true,
    messages: view.messages.filter(message => message.runId === metadata.id), observedEfforts: [],
    events: [], cursor: 0, seen: new Set<number>(), buffer: "", resultCount: 0,
    resultKeys: new Set<string>(), toolResults: new Map() }));
}
