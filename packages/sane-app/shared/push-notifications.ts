import { isConversationUpdateSource, type ConversationUpdateSource } from "./conversation/conversation-updates";

export const PUSH_PAYLOAD_MAX_BYTES = 3072;
export const PUSH_SESSION_TITLE_MAX_CHARACTERS = 200;
// Keep the wire limit compatible with queued payloads and notification data.
export const PUSH_DISPLAY_SESSION_TITLE_MAX_CHARACTERS = 20;
export const PUSH_WORKSPACE_NAME_MAX_CHARACTERS = 120;
const PUSH_LABEL_MAX_BYTES = 1024;
const encoder = new TextEncoder();
export type PushPayload = {
  version: 1;
  storeId: string;
  id: string;
  kind: "reply" | "completed" | "failed" | "interrupted" | "test";
  createdAt: number;
  conversationId?: string;
  source?: ConversationUpdateSource;
  sessionTitle?: string;
  workspaceName?: string;
};
export type ChromePushSubscription = { endpoint: string; expirationTime?: number | null; keys: { p256dh: string; auth: string } };
export type PushConfig = { available: boolean; storeId: string; publicKey?: string };

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value);
const label = (value: unknown, maxCharacters: number): value is string => typeof value === "string"
  && value.length > 0 && value.length <= maxCharacters * 2 && value === value.trim()
  && !/[\u0000-\u001f\u007f-\u009f]/.test(value) && Array.from(value).length <= maxCharacters
  && encoder.encode(value).byteLength <= PUSH_LABEL_MAX_BYTES;

/** Presentation only: normalize labels without changing qualified notification identity. */
export function normalizePushNotificationLabel(value: unknown, maxCharacters: number): string | undefined {
  if (typeof value !== "string") return;
  const normalized = value.replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  let result = "", bytes = 0, characters = 0;
  for (const character of normalized) {
    const size = encoder.encode(character).byteLength;
    if (characters >= maxCharacters || bytes + size > PUSH_LABEL_MAX_BYTES) break;
    result += character; bytes += size; characters++;
  }
  return result.trim() || undefined;
}
export function isPushPayload(value: unknown): value is PushPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  if (Object.keys(p).some(key => !["version", "storeId", "id", "kind", "createdAt", "conversationId", "source", "sessionTitle", "workspaceName"].includes(key))
    || p.version !== 1 || !text(p.storeId) || !text(p.id) || !Number.isSafeInteger(p.createdAt) || (p.createdAt as number) <= 0) return false;
  if (p.sessionTitle !== undefined && !label(p.sessionTitle, PUSH_SESSION_TITLE_MAX_CHARACTERS)
    || p.workspaceName !== undefined && !label(p.workspaceName, PUSH_WORKSPACE_NAME_MAX_CHARACTERS)) return false;
  if (p.kind === "test" ? p.conversationId !== undefined || p.source !== undefined
    : !["reply", "completed", "failed", "interrupted"].includes(p.kind as string) || !text(p.conversationId) || !isConversationUpdateSource(p.source)) return false;
  try { return encoder.encode(JSON.stringify(p)).byteLength <= PUSH_PAYLOAD_MAX_BYTES; } catch { return false; }
}

/** Only a same-origin fragment; never a sender-supplied URL or executable content. */
export function pushNotificationFragment(payload: PushPayload): string {
  return `#notification=${encodeURIComponent(JSON.stringify(payload))}`;
}
export function parsePushNotificationFragment(hash: string): PushPayload | null {
  if (!hash.startsWith("#notification=") || hash.length > PUSH_PAYLOAD_MAX_BYTES * 6) return null;
  try { const value: unknown = JSON.parse(decodeURIComponent(hash.slice("#notification=".length))); return isPushPayload(value) ? value : null; }
  catch { return null; }
}

export function pushNotificationTitle(payload: PushPayload): string {
  switch (payload.kind) {
    case "reply":
    case "completed": return "Response";
    case "failed": return "Run failed";
    case "interrupted": return "Run interrupted";
    case "test": return "Test notification";
  }
}

export function pushNotificationBody(kind: PushPayload["kind"], workspaceName?: string, sessionTitle?: string): string {
  if (kind === "test") return "Device notifications are working.";
  const workspace = normalizePushNotificationLabel(workspaceName, PUSH_WORKSPACE_NAME_MAX_CHARACTERS) ?? "Workspace unavailable";
  const session = normalizePushNotificationLabel(sessionTitle, PUSH_DISPLAY_SESSION_TITLE_MAX_CHARACTERS) ?? "Untitled session";
  return `${workspace} · ${session}`;
}
