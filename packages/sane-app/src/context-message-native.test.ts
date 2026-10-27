import { expect, test } from "bun:test";
import { composeContextMessage, type ContextMessageBinding } from "./context-message";
import { recordContextMessageSubmission } from "./context-message-evidence";
import { assertContextMessageNativeContinuity } from "./context-message-native";
import type { MessageSnapshot } from "./oc-contract";

function fixture(harnessId: "claude-code" | "opencode", liveInput = false) {
  const runId = crypto.randomUUID(), uuid = crypto.randomUUID();
  const binding: ContextMessageBinding = { harnessId, sessionId: crypto.randomUUID(), authorityId: "fixture", nativeSessionId: harnessId === "opencode" ? "ses_fixture" : crypto.randomUUID(), cwd: "/fixture" };
  const messageId = harnessId === "opencode" ? "msg_fixture" : `${runId}:user${liveInput ? `:${uuid}` : ""}`;
  const message = composeContextMessage({ binding, body: "\uFEFF exact 😀\r\n", origin: "user", placement: { kind: "selected", purpose: "sharing" },
    selections: [{ kind: "fragment", fragment: { id: "shared.fixture", category: "shared", text: "Frozen fixture", source: "fixture/snapshot", revision: "one", reason: "Explicit fixture sharing" } }] });
  const standard = recordContextMessageSubmission(message, { messageId, text: message.transport.text, ...(liveInput ? { liveInput: true } : {}) }, { source: binding, runId, nativeCommandId: harnessId === "opencode" ? messageId : null });
  const native: MessageSnapshot = { messageId: harnessId === "opencode" ? messageId : liveInput ? uuid : runId, role: "user", parts: [{ id: "text", type: "text", text: standard.text }], createdAt: "", status: "unknown" };
  return { binding, standard, native };
}
for (const harness of ["claude-code", "opencode"] as const) test(`${harness}: independent exact native ID and bytes establish content continuity, not model consumption`, () => {
  const f = fixture(harness);
  assertContextMessageNativeContinuity(f.binding, f.standard, [f.native]);
});
test("CC live UUID is distinct from initial run and logical App message identities", () => {
  const f = fixture("claude-code", true);
  assertContextMessageNativeContinuity(f.binding, f.standard, [f.native]);
  expect(() => assertContextMessageNativeContinuity(f.binding, f.standard, [{ ...f.native, messageId: f.standard.messageId }])).toThrow("uniquely present");
});
for (const damage of ["missing", "different-id", "bytes", "role", "duplicate", "reset", "compact", "summary"] as const) test(`native ${damage} cannot borrow an activation retention proof`, () => {
  const f = fixture("claude-code"), native = structuredClone(f.native);
  if (damage === "different-id") native.messageId = crypto.randomUUID();
  if (damage === "bytes") (native.parts[0] as { text: string }).text += " ";
  if (damage === "role") native.role = "assistant";
  const history = damage === "missing" ? [] : [native];
  if (damage === "duplicate") history.push(structuredClone(native));
  if (damage === "reset") history.push({ ...native, messageId: "reset", contextReset: true });
  if (damage === "compact") history.push({ ...native, messageId: "compact", compaction: {} as never });
  if (damage === "summary") history.push({ ...native, messageId: "summary", compactionSummary: true });
  expect(() => assertContextMessageNativeContinuity(f.binding, f.standard, history)).toThrow();
});
test("a reset before an explicit later activation is not a post-activation retention claim", () => {
  const f = fixture("opencode");
  assertContextMessageNativeContinuity(f.binding, f.standard, [{ ...f.native, messageId: "prior_reset", contextReset: true }, f.native]);
});
