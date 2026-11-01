import type { Harness } from "./conversation/types";
import type { Message } from "./conversation/types";
import { ASIDE_LIMITS, parseAsideDraftRequest, parseAsideTranscriptMessage } from "./aside-contract";
import type { AsideLifecycle } from "./aside-contract";

/** Lightweight regular-conversation metadata. Never includes captured text or drafts. */
export type AsideConversationSummary = {
  id: string; parentSessionId: string; sourceFingerprint: string; lifecycle: AsideLifecycle;
};

/** No-send navigation identity; child history is read through regular transcripts. */
export type AsideConversationOpenResponse = {
  asideId: string; conversationId: string; parentSessionId: string; sourceFingerprint: string;
};

/** Compatibility response for child opening/legacy readers. New chat renders the
 * sessionId through the regular conversation store, transcript and composer. */
export type AsideChatState = {
  asideId: string; sessionId: string; harness: Harness; sourceFingerprint: string;
  messages: Message[]; running: boolean; canSend: boolean; unavailableReason?: string;
};
/** Legacy /messages identity only; ordinary sends use /api/submissions. */
export type AsideChatSendRequest = { requestId: string; expectedRevision: number; text: string };
/** Legacy reply after the existing native admission boundary accepts the turn. */
export type AsideChatSendResponse = { asideId: string; sessionId: string; runId: string };

export function parseAsideChatSendRequest(value: unknown): AsideChatSendRequest {
  const request = parseAsideDraftRequest(value);
  if (!request.text.trim() || BufferFreeUTF8(request.text) !== request.text)
    throw new Error("Provide nonempty, lossless UTF-8 text");
  if (/^\s*\/compact(?:\s|$)/i.test(request.text))
    throw new Error("Use the dedicated Compact action; aside messages cannot submit /compact");
  return request;
}
function BufferFreeUTF8(text: string): string { return new TextDecoder("utf-8", { ignoreBOM: true }).decode(new TextEncoder().encode(text)); }

function shape(value: unknown, keys: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== "string")
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !d.enumerable || !("value" in d))
    || keys.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => !keys.includes(k) && !optional.includes(k))) throw new Error("Invalid aside chat response fields");
}
const isId = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
export function parseAsideConversationOpenResponse(value: unknown): AsideConversationOpenResponse {
  shape(value, ["asideId", "conversationId", "parentSessionId", "sourceFingerprint"]);
  if (!isId(value.asideId) || !isId(value.conversationId) || !isId(value.parentSessionId)
    || typeof value.sourceFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceFingerprint)) throw new Error("Invalid aside conversation identity");
  return { asideId: value.asideId, conversationId: value.conversationId, parentSessionId: value.parentSessionId, sourceFingerprint: value.sourceFingerprint };
}
export function parseAsideChatState(value: unknown): AsideChatState {
  shape(value, ["asideId", "sessionId", "harness", "sourceFingerprint", "messages", "running", "canSend"], ["unavailableReason"]);
  if (!isId(value.asideId) || !isId(value.sessionId) || !["claude-code", "opencode", "grok"].includes(value.harness as string)
    || typeof value.sourceFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceFingerprint)
    || typeof value.running !== "boolean" || typeof value.canSend !== "boolean"
    || Object.hasOwn(value, "unavailableReason") && (typeof value.unavailableReason !== "string" || !value.unavailableReason || value.unavailableReason.length > 4096)
    || !Array.isArray(value.messages) || value.messages.length > ASIDE_LIMITS.messages
    || Object.getPrototypeOf(value.messages) !== Array.prototype || Object.getOwnPropertySymbols(value.messages).length
    || Object.getOwnPropertyNames(value.messages).length !== value.messages.length + 1
    || Object.keys(value.messages).length !== value.messages.length
    || Array.from({ length: value.messages.length }, (_, i) => Object.getOwnPropertyDescriptor(value.messages, String(i))).some(d => !d || !d.enumerable || !("value" in d))) throw new Error("Invalid aside chat state");
  const messages = value.messages.map(parseAsideTranscriptMessage);
  if (new Set(messages.map(m => m.id)).size !== messages.length) throw new Error("Duplicate aside chat message");
  return { asideId: value.asideId, sessionId: value.sessionId, harness: value.harness as Harness, sourceFingerprint: value.sourceFingerprint,
    messages, running: value.running, canSend: value.canSend, ...(value.unavailableReason !== undefined ? { unavailableReason: value.unavailableReason as string } : {}) };
}
export function parseAsideChatSendResponse(value: unknown): AsideChatSendResponse {
  shape(value, ["asideId", "sessionId", "runId"]);
  if (!isId(value.asideId) || !isId(value.sessionId) || !isId(value.runId)) throw new Error("Invalid aside chat dispatch response");
  return { asideId: value.asideId, sessionId: value.sessionId, runId: value.runId };
}
