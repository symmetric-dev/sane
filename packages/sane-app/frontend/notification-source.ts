import type { Conversation } from "./types";
import { isConversationUpdateSource, updateSourceKey, type ConversationUpdateSource } from "../shared/conversation/conversation-updates";

/** The App producer's immutable, incarnationless identity, admitted by the catalog. */
export function appNotificationSource(c: Conversation): ConversationUpdateSource | undefined {
  const source = { harness: c.harness, authorityId: c.authorityId, nativeSessionId: c.nativeSessionId };
  return isConversationUpdateSource(source) ? source : undefined;
}

/** Creation identity is backend evidence. Never derive it from a run, date or version. */
export function nativeNotificationSource(c: Conversation): ConversationUpdateSource | undefined {
  const base = appNotificationSource(c), source = c.updateSource;
  return base && isConversationUpdateSource(source) && source.harness === base.harness
    && source.authorityId === base.authorityId && source.nativeSessionId === base.nativeSessionId ? source : undefined;
}

export function notificationSourceKeys(c: Conversation): readonly string[] {
  const base = appNotificationSource(c), native = nativeNotificationSource(c);
  // A supplied but inconsistent canonical identity must fail closed.
  if (!base || c.updateSource !== undefined && !native) return [];
  return [...new Set([updateSourceKey(base), ...(native ? [updateSourceKey(native)] : [])])];
}

export function notificationSourceMatches(c: Conversation, key: string): boolean {
  return notificationSourceKeys(c).includes(key);
}

export function currentNotificationSource(c: Conversation): ConversationUpdateSource | undefined {
  if (c.updateSource !== undefined) return nativeNotificationSource(c);
  return appNotificationSource(c);
}

/** Also binds legacy captures to the current authority/creation, which v1 did not encode. */
export function notificationContextKey(c: Conversation): string {
  const native = nativeNotificationSource(c);
  return JSON.stringify([c.id, c.harness, c.authorityId ?? null, c.nativeSessionId ?? null, c.cwd,
    c.updateSource !== undefined, native ? updateSourceKey(native) : null]);
}
