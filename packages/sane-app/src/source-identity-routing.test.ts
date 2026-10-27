import { describe, expect, test } from "bun:test";
import type { Admission } from "./app-store";
import { ScienceChatService } from "./science-chat-service";
import { WorkspaceError } from "./workspace";
import { WorkstreamAdapter, WorkstreamAdapterError, type AppConversation } from "./workstreams";

const sessionId = "10000000-0000-4000-8000-000000000001";
const workspaceId = "10000000-0000-4000-8000-000000000002";
const worktreeId = "10000000-0000-4000-8000-000000000003";
const bindingRevision = "10000000-0000-4000-8000-000000000004";
const cwd = "/offline/identity-routing";

function identity(harness: "cc" | "oc") {
  const authorityId = `sane-native-v1:${harness}:${"a".repeat(64)}`;
  const session: AppConversation = { sessionId, harness: harness === "cc" ? "claude-code" : "opencode", nativeSessionId: harness === "cc" ? sessionId : "ses_routing", authorityId, cwd };
  const admission: Admission = {
    version: 1, requestId: sessionId, sessionId, operation: "create", state: "ready",
    source: { authorityId, descriptor: harness === "cc"
      ? { version: 1, harness: "cc", kind: "local-profile", profileRoot: "/offline/profile" }
      : { version: 1, harness: "oc", kind: "local-registration", registrationFile: "/offline/service.json" } },
    binding: { workspaceId, worktreeId, bindingRevision, executionCheckout: cwd, checkoutPin: null, domain: { mode: "app-only" } },
    parent: null, nativeId: session.nativeSessionId!, createdAt: "2026-10-27T00:00:00.000Z", error: null,
  };
  return { session, admission };
}

describe("source identity conversion at App consumers", () => {
  const unexpected = () => { throw new Error("Identity-only checks must not reach native or repository execution"); };
  const adapter = new WorkstreamAdapter(
    new Proxy({} as ConstructorParameters<typeof WorkstreamAdapter>[0], { get: unexpected }),
    {} as ConstructorParameters<typeof WorkstreamAdapter>[1],
  );

  for (const harness of ["cc", "oc"] as const) test(`${harness}: workstream references preserve the exact qualified identity`, () => {
    const { session } = identity(harness);
    expect(adapter.reference(session)).toEqual({ harness, authorityId: session.authorityId!, nativeId: session.nativeSessionId! });
  });

  test("workstream reference refusals retain their public 409 classification", () => {
    const { session } = identity("cc");
    const invalid = [
      ...[undefined, null, "grok", "cc", "oc", "constructor"].map(harness => ({ ...session, harness })),
      { ...session, nativeSessionId: undefined }, { ...session, nativeSessionId: "" },
      { ...session, authorityId: undefined }, { ...session, authorityId: "" },
    ];
    for (const value of invalid) {
      let caught: unknown;
      try { adapter.reference(value as AppConversation); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(WorkstreamAdapterError);
      expect(caught).toMatchObject({ status: 409, code: "invalid-app-reference", message: "Qualified native identity is required" });
    }
  });

  function science(admission: Admission, session: AppConversation) {
    return new ScienceChatService(
      { associations: () => [], get: () => undefined } as unknown as ConstructorParameters<typeof ScienceChatService>[0],
      { claimChatNotebook: unexpected } as unknown as ConstructorParameters<typeof ScienceChatService>[1],
      { association: () => ({ workspaceId, worktreeId }) } as unknown as ConstructorParameters<typeof ScienceChatService>[2],
      { get: () => admission } as unknown as ConstructorParameters<typeof ScienceChatService>[3],
      () => session,
    );
  }

  for (const harness of ["cc", "oc"] as const) test(`${harness}: science admission accepts the matching session without native execution`, async () => {
    const { session, admission } = identity(harness);
    expect(await science(admission, session).handle(workspaceId, worktreeId, sessionId, undefined, () => true)).toEqual({ chat: null });
  });

  test("science unknown source namespaces cannot fall through to OpenCode", async () => {
    const { session, admission } = identity("oc");
    for (const harness of [undefined, null, "grok", "opencode", "constructor"]) {
      const invalid = structuredClone(admission);
      Object.assign(invalid.source.descriptor, { harness });
      let caught: unknown;
      try { await science(invalid, session).handle(workspaceId, worktreeId, sessionId, undefined, () => true); }
      catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(WorkspaceError);
      expect(caught).toMatchObject({ status: 409, code: "science-chat", message: "Conversation admission and selected workspace identity differ" });
    }
  });

  test("science mismatched known harnesses keep the same identity refusal", async () => {
    for (const harness of ["cc", "oc"] as const) {
      const { session } = identity(harness), { admission } = identity(harness === "cc" ? "oc" : "cc");
      // Isolate the harness mismatch from the other exact identity fields.
      admission.nativeId = session.nativeSessionId!;
      admission.source.authorityId = session.authorityId!;
      const result = science(admission, session).handle(workspaceId, worktreeId, sessionId, undefined, () => true);
      await expect(result).rejects.toBeInstanceOf(WorkspaceError);
      await expect(result).rejects.toMatchObject({ status: 409, code: "science-chat", message: "Conversation admission and selected workspace identity differ" });
    }
  });
});
