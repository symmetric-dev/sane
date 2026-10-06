/** Offline test DTOs. No native discovery, managed service, models or bridge. */
import { createHash } from "node:crypto";
import { seedAgentProfiles } from "./agent-profiles-contract";
import { prepareUserInput } from "./user-input-preparation";
import type { Session } from "./history";
import type { PendingInputEnqueue, PendingInputPins } from "./pending-input-contract";

export const id = () => crypto.randomUUID();
export const at = "2026-10-06T00:00:00.000Z";
export async function pendingFixture(harness: "claude-code" | "opencode" = "claude-code", raw: Record<string, unknown> = {}, overrides: Partial<Session> = {}): Promise<PendingInputEnqueue> {
  const descriptor = harness === "claude-code" ? { version: 1 as const, harness: "cc" as const, kind: "local-profile" as const, profileRoot: "/native/claude" } : { version: 1 as const, harness: "oc" as const, kind: "local-registration" as const, registrationFile: "/native/opencode.json" };
  const authorityId = `sane-native-v1:${descriptor.harness}:${createHash("sha256").update(JSON.stringify(descriptor)).digest("hex")}`;
  const session: Session = { sessionId: id(), harness, authorityId, nativeSessionId: harness === "claude-code" ? id() : `ses_${id()}`, cwd: "/repo", profileId: harness === "claude-code" ? "base:cc" : "base:oc", lastRunId: null, lastStatus: "unknown", ...overrides };
  const profiles = seedAgentProfiles(at);
  const prepared = await prepareUserInput({ sessionId: session.sessionId, prompt: "first\nwaiting text", ...raw }, {
    profiles, getSession: () => session, defaultCwd: "/repo", conversationId: id, sourceAuthorityId: () => authorityId,
    selectedDirectory: async () => "/repo", ensureDirectory: async () => {}, validateOpenCodeModel: () => {},
    resolveOpenCodeLaunch: async () => { throw new Error("Established resume must not resolve current launch"); },
  });
  const catalog = { workspaceId: id(), worktreeId: id(), bindingRevision: id(), cwd: "/repo" };
  const pins: PendingInputPins = { admission: { version: 1, requestId: id(), sessionId: session.sessionId, operation: "create", state: "ready", source: { descriptor, authorityId }, binding: { workspaceId: catalog.workspaceId, worktreeId: catalog.worktreeId, bindingRevision: catalog.bindingRevision, executionCheckout: catalog.cwd, checkoutPin: null, domain: { mode: "app-only" } }, nativeId: session.nativeSessionId!, parent: null, createdAt: at, error: null }, catalog, configuration: prepared.expectedPrior!.configuration, launch: prepared.configuration, context: null };
  const request = { version: 1 as const, requestId: id(), conversationId: session.sessionId, text: prepared.prompt,
    source: { harnessId: harness, conversationId: session.sessionId, authorityId, nativeSessionId: session.nativeSessionId!, cwd: session.cwd },
    configuration: { cwd: session.cwd, profileId: prepared.configuration.profileId, ...(prepared.configuration.model ? { model: prepared.configuration.model } : {}), ...(prepared.configuration.effort ? { effort: prepared.configuration.effort } : {}), ...(prepared.configuration.agent ? { agent: prepared.configuration.agent } : {}) } };
  return { request, snapshot: { prepared, pins } };
}
export function sibling(input: PendingInputEnqueue, text = input.request.text): PendingInputEnqueue {
  const next = structuredClone(input); next.request = { ...next.request, requestId: id(), text }; next.snapshot.prepared = { ...next.snapshot.prepared, prompt: text }; return next;
}
