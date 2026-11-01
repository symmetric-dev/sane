import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AsideCreateRequest, AsideSourceSnapshot, AsideTranscriptSnapshot } from "../shared/aside-contract";
import type { UserQuestionsRecord } from "../shared/user-questions-contract";
import type { Session } from "./history";
import { canonicalJSON } from "./prepared-input-codec";
import { AsideStore } from "./aside-store";

// Synthetic identities and isolated App files only; no bridge/native startup.
export const ids = {
  store: "10000000-0000-4000-8000-000000000001",
  session: "10000000-0000-4000-8000-000000000002",
  other: "10000000-0000-4000-8000-000000000003",
  workspace: "10000000-0000-4000-8000-000000000004",
  worktree: "10000000-0000-4000-8000-000000000005",
};
export const capturedAt = "2026-10-01T00:00:00.000Z";
export const digest = (value: unknown) => createHash("sha256").update(canonicalJSON(value)).digest("hex");
export const createRequest = (requestId = "create-1"): AsideCreateRequest => ({ requestId, target: { kind: "conversation" }, draft: "Explain this observation" });
export function sourceFixture(): AsideSourceSnapshot {
  const observedMessages: AsideTranscriptSnapshot["messages"] = [{
    id: "message-1", runId: "native-import", role: "assistant", version: "message-v1",
    time: "", status: "running", parts: [{ type: "text", text: "Observed answer" }, { type: "tool", id: "tool-1", name: "Read", input: undefined }],
  }];
  // Match transcript materialization: JSON omits an undefined streaming input.
  const messages = JSON.parse(JSON.stringify(observedMessages)) as AsideTranscriptSnapshot["messages"];
  return {
    storeId: ids.store, sessionId: ids.session, rootSessionId: ids.session,
    native: { harness: "cc", authorityId: `sane-native-v1:cc:${"a".repeat(64)}`, nativeId: ids.session },
    binding: { workspaceId: ids.workspace, worktreeId: ids.worktree, bindingRevision: "binding-v1", cwd: "/offline/aside-fixture" },
    capturedAt,
    transcript: { kind: "app-transcript", epoch: "epoch-1", revision: "transcript-v1", messages, totalMessages: messages.length, boundaryMessageId: "message-1", fingerprint: digest(messages) },
  };
}
export function sessionFixture(): Session {
  const source = sourceFixture();
  return { sessionId: ids.session, harness: "claude-code", authorityId: source.native.authorityId, nativeSessionId: source.native.nativeId,
    cwd: source.binding.cwd, lastStatus: "running", lastRunId: "run-1", attachment: { state: "ready", source: "fixture" } };
}
export function questionFixture(): UserQuestionsRecord {
  const source = sourceFixture();
  return { version: 1, id: "form-1", sessionId: ids.session, native: source.native, ...source.binding,
    anchor: { runId: "run-1", toolCallId: "tool-1", messageId: null, invocationId: "tool-1", wrapper: null },
    createdAt: capturedAt, input: { title: "Decision", pages: [{ question: "Which approach?", context: "Compare the tradeoffs", options: ["A", "B"] }] },
    revision: 2, answers: [{ selected: ["B"] }], status: "presented", submission: null, delivery: null, dismissal: null };
}
export function storeFixture(ownedDirectories: string[]) {
  const preferredTemp = "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode";
  const dir = realpathSync(mkdtempSync(join(existsSync(preferredTemp) ? preferredTemp : tmpdir(), "aside-tests-")));
  ownedDirectories.push(dir);
  const failures: unknown[] = [];
  const open = () => new AsideStore(dir, ids.store, error => { failures.push(error); });
  return { dir, failures, open, store: open() };
}
