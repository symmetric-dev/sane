import { describe, expect, test } from "bun:test";
import { appNotificationSource, currentNotificationSource, nativeNotificationSource, notificationContextKey, notificationSourceKeys, notificationSourceMatches } from "./notification-source";
import { updateSourceKey, type ConversationUpdateSource } from "../shared/conversation/conversation-updates";
import type { Conversation } from "./types";

const base: ConversationUpdateSource = { harness: "opencode", authorityId: "authority", nativeSessionId: "native" };
const native = { ...base, incarnation: "creation-1" };
const conversation = (patch: Partial<Conversation> = {}): Conversation => ({ id: "app-session", ...base, updateSource: native, cwd: "/fixture", lastRunId: "run", status: "completed", ...patch });

describe("catalog-qualified notification sources", () => {
  test("admits immutable App and native identities without rewriting canonical conversation ID", () => {
    const c = conversation();
    expect(appNotificationSource(c)).toEqual(base);
    expect(nativeNotificationSource(c)).toEqual(native);
    expect(currentNotificationSource(c)).toEqual(native);
    expect(notificationSourceKeys(c)).toEqual([updateSourceKey(base), updateSourceKey(native)]);
    expect(notificationSourceMatches(c, updateSourceKey(base))).toBe(true);
    expect(notificationSourceMatches(c, updateSourceKey(native))).toBe(true);
    expect(c.id).toBe("app-session");
    expect(notificationContextKey(c)).not.toBe(notificationContextKey(conversation({ id: "other-app-session" })));
  });

  test("optional source falls back only to evidenced base, never run/date/version-derived creation", () => {
    const c = conversation({ updateSource: undefined, updatedAt: "2026-10-05T00:00:00Z", lastRunId: "creation-looking-run" });
    expect(nativeNotificationSource(c)).toBeUndefined();
    expect(currentNotificationSource(c)).toEqual(base);
    expect(notificationSourceKeys(c)).toEqual([updateSourceKey(base)]);
    expect(currentNotificationSource(conversation({ authorityId: undefined, updateSource: undefined }))).toBeUndefined();
    expect(currentNotificationSource(conversation({ nativeSessionId: undefined, updateSource: undefined }))).toBeUndefined();
  });

  test("incarnationless historical identity stays separate from current native creation", () => {
    const historical = conversation({ updateSource: base });
    expect(nativeNotificationSource(historical)).toEqual(base);
    expect(notificationSourceKeys(historical)).toEqual([updateSourceKey(base)]);
    expect(notificationSourceMatches(historical, updateSourceKey(native))).toBe(false);
    expect(notificationContextKey(historical)).not.toBe(notificationContextKey(conversation()));
  });

  const invalid: [string, unknown][] = [
    ["null", null], ["array", []], ["empty incarnation", { ...native, incarnation: "" }],
    ["numeric incarnation", { ...native, incarnation: 1 }], ["control incarnation", { ...native, incarnation: "bad\ncreation" }],
    ["unknown field", { ...native, conversationId: "app-session" }],
    ["wrong authority", { ...native, authorityId: "other" }], ["wrong native session", { ...native, nativeSessionId: "other" }],
    ["wrong harness", { ...native, harness: "claude-code" }], ["missing authority", { harness: "opencode", nativeSessionId: "native", incarnation: "creation-1" }],
  ];
  for (const [label, source] of invalid) test(`fails closed for ${label}, including the otherwise-valid base`, () => {
    const c = conversation({ updateSource: source as ConversationUpdateSource });
    expect(nativeNotificationSource(c)).toBeUndefined();
    expect(currentNotificationSource(c)).toBeUndefined();
    expect(notificationSourceKeys(c)).toEqual([]);
    expect(notificationSourceMatches(c, updateSourceKey(base))).toBe(false);
  });

  test("metadata changes do not change context, but every identity rebind does", () => {
    const key = notificationContextKey(conversation());
    expect(notificationContextKey(conversation({ title: "Revised", lastRunId: "new-run", updatedAt: "2026-10-06T00:00:00Z", workspaceId: "workspace" }))).toBe(key);
    for (const patch of [{ updateSource: { ...native, incarnation: "creation-2" } }, { authorityId: "other" }, { nativeSessionId: "other" }, { cwd: "/other" }, { updateSource: undefined }]) {
      expect(notificationContextKey(conversation(patch))).not.toBe(key);
    }
  });
});
