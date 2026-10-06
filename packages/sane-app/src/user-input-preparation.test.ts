import { describe, expect, test } from "bun:test";
import { seedAgentProfiles, type AgentProfile } from "./agent-profiles-contract";
import type { Session } from "./history";
import { prepareUserInput, revalidatePreparedUserInput, assertPreparedUserInputCurrent, UserInputPreparationError, type UserInputPreparationDependencies, type UserInputRevalidationDependencies } from "./user-input-preparation";
import { ConversationCoordinator } from "./conversation-coordinator";
import { HarnessDispatchRegistry } from "./harness-dispatch";
import type { RunOwner } from "./run-owner";

const sessionId = "00000000-0000-4000-8000-000000000001";
const newId = "00000000-0000-4000-8000-000000000002";
function fixture(overrides: Partial<Session> = {}, existing = true) {
  const profiles = seedAgentProfiles("2026-10-06T00:00:00.000Z");
  const session: Session = { sessionId, harness: "claude-code", authorityId: "source:claude-code", nativeSessionId: "native-cc", cwd: "/repo", lastStatus: "unknown", lastRunId: null, ...overrides };
  const calls: string[] = [];
  let current: Session | undefined = existing ? session : undefined;
  let source = `source:${session.harness}`;
  const preparation: UserInputPreparationDependencies = {
    profiles, getSession: id => current?.sessionId === id ? current : undefined,
    defaultCwd: "/repo", conversationId: () => newId,
    sourceAuthorityId: harness => existing ? source : `source:${harness}`,
    selectedDirectory: async (workspaceId, worktreeId) => { calls.push(`binding:${workspaceId}:${worktreeId}`); return "/selected"; },
    ensureDirectory: async cwd => { calls.push(`directory:${cwd}`); },
    validateOpenCodeModel: (model, effort) => { calls.push(`model:${model}:${effort}`); if (!model.includes("/")) throw new Error("OpenCode model must be provider/model"); },
    resolveOpenCodeLaunch: async (_cwd, settings) => { calls.push("resolve"); return { agent: settings.agent, model: { providerID: "fixed", id: "model", variant: "native-thinking" } }; },
  };
  const revalidation: UserInputRevalidationDependencies = { ...preparation, validateBinding: () => { calls.push("validate-binding"); } };
  const request = (input: Record<string, unknown> = {}) => ({ prompt: "Hello", ...(existing ? { sessionId } : {}), ...input });
  const assistant = profiles.profiles.find(p => p.id === "template:engineering")!;
  return { profiles, session, calls, preparation, revalidation, request, assistant, setSession: (value: Session | undefined) => { current = value; }, setSource: (value: string) => { source = value; } };
}

describe("immutable user prompt preparation", () => {
  test("new profile wins over legacy settings without mutating the request", async () => {
    const f = fixture({}, false);
    f.assistant.model = "claude-opus"; f.assistant.effort = "high";
    const input = f.request({ profileId: f.assistant.id, harness: "opencode", model: "ignored", effort: "ignored", agent: "ignored" });
    const before = JSON.stringify(input);
    const p = await prepareUserInput(input, f.preparation);
    expect(JSON.stringify(input)).toBe(before);
    expect(p.requested).toEqual({ profileId: f.assistant.id, harness: "opencode", model: "ignored", effort: "ignored", agent: "ignored" });
    expect(p.normalized).toEqual({ profileId: f.assistant.id, harness: "claude-code", model: "claude-opus", effort: "high", agent: "engineering" });
    expect(p.configuration).toEqual({ profileId: f.assistant.id, model: "claude-opus", effort: "high", agent: "engineering", agentKind: "assistant", nativeAgentSelected: true });
    expect(p.resume).toBe(false); expect(p.binding.conversationId).toBe(newId);
  });

  test("Base -> assistant stages a complete upgrade and clears parent defaults", async () => {
    const f = fixture({ profileId: "base:cc", model: "old-model", effort: "max" });
    const p = await prepareUserInput(f.request({ profileId: f.assistant.id }), f.preparation);
    expect(p.stagedUpgrade).toEqual(f.assistant);
    expect(p.configuration).toEqual({ profileId: f.assistant.id, agent: "engineering" });
    expect(p.expectedPrior?.configuration).toEqual({ profileId: "base:cc", model: "old-model", effort: "max" });
    expect(p.normalized).toEqual({ profileId: f.assistant.id });
    expect(f.session.agent).toBeUndefined(); expect(f.session.model).toBe("old-model");
    await revalidatePreparedUserInput(p, f.revalidation);
  });

  test("legacy assistant selection uses the same Base upgrade rule", async () => {
    const f = fixture();
    const p = await prepareUserInput(f.request({ agent: "engineering" }), f.preparation);
    expect(p.stagedUpgrade?.id).toBe(f.assistant.id);
    expect(p.requested).toEqual({ agent: "engineering" });
    expect(p.normalized).toEqual({ profileId: f.assistant.id });
  });

  test("assistant changes and Base reselection remain forbidden", async () => {
    const f = fixture({ agent: "design", profileId: "template:design" });
    await expect(prepareUserInput(f.request({ profileId: f.assistant.id }), f.preparation)).rejects.toThrow("Session agent cannot change");
    const base = fixture();
    await expect(prepareUserInput(base.request({ profileId: "base:oc" }), base.preparation)).rejects.toThrow("Session agent cannot change");
  });

  test("cross-harness and hidden upgrades remain forbidden", async () => {
    const f = fixture(); f.assistant.harness = "opencode";
    await expect(prepareUserInput(f.request({ profileId: f.assistant.id }), f.preparation)).rejects.toThrow("Session harness cannot change");
    f.assistant.harness = "claude-code"; f.assistant.hidden = true;
    await expect(prepareUserInput(f.request({ profileId: f.assistant.id }), f.preparation)).rejects.toThrow("Session agent cannot change");
  });

  test("unchanged profile resumes stored selections despite current profile edits", async () => {
    const f = fixture({ agent: "engineering", profileId: "template:engineering", model: "stored-model", effort: "low", agentKind: "assistant", nativeAgentSelected: false });
    f.assistant.model = "new-model"; f.assistant.effort = "max";
    const p = await prepareUserInput(f.request({ profileId: f.assistant.id, model: "ignored", effort: "ignored" }), f.preparation);
    expect(p.configuration.model).toBe("stored-model"); expect(p.configuration.effort).toBe("low");
    expect(p.configuration.nativeAgentSelected).toBe(false); expect(p.stagedUpgrade).toBeUndefined();
    f.assistant.model = "edited-again";
    await revalidatePreparedUserInput(p, f.revalidation);
  });

  test("archived Knowledge profile and legacy agent inherit historical selections", async () => {
    const f = fixture({ agent: "knowledge", model: "archive", effort: "high", nativeAgentSelected: false });
    for (const selection of [{ profileId: "template:knowledge" }, { agent: "knowledge" }]) {
      const p = await prepareUserInput(f.request({ ...selection, model: "ignored" }), f.preparation);
      expect(p.configuration).toEqual({ profileId: "template:knowledge", agent: "knowledge", model: "archive", effort: "high", nativeAgentSelected: false });
      expect(p.normalized).toEqual({ profileId: "template:knowledge" });
      expect(p.selectedProfile).toBeUndefined();
      await revalidatePreparedUserInput(p, f.revalidation);
    }
    const fresh = fixture({}, false);
    await expect(prepareUserInput(fresh.request({ agent: "knowledge" }), fresh.preparation)).rejects.toThrow("Unknown agent");
  });

  test("migrated mutable profile does not rewrite Knowledge identity", async () => {
    const f = fixture({ agent: "knowledge", profileId: "archived-custom", model: "archive" });
    f.profiles.profiles.push({ ...f.assistant, id: "archived-custom", role: "curation", model: "new" });
    const p = await prepareUserInput(f.request({ profileId: "archived-custom" }), f.preparation);
    expect(p.configuration.agent).toBe("knowledge"); expect(p.configuration.model).toBe("archive");
  });

  test("omitted follow-up settings inherit defaults while explicit values remain distinguishable", async () => {
    const f = fixture({ model: "stored", effort: "high" });
    const omitted = await prepareUserInput(f.request(), f.preparation);
    const explicit = await prepareUserInput(f.request({ model: "stored", effort: "high" }), f.preparation);
    expect(omitted.configuration).toEqual(explicit.configuration);
    expect(omitted.normalized).toEqual({}); expect(omitted.requested).toEqual({});
    expect(explicit.normalized).toEqual({ model: "stored", effort: "high" });
    expect(JSON.parse(JSON.stringify(omitted)).normalized).not.toHaveProperty("model");
  });

  test("snapshot is recursively frozen, detached and serializable", async () => {
    const f = fixture({ saneContext: { version: 1, framework: "framework" } });
    f.assistant.workerProfiles = { implementer: "worker:implementer" };
    const p = await prepareUserInput(f.request({ profileId: f.assistant.id, workspaceId: "workspace", worktreeId: "tree" }), f.preparation);
    expect(Object.isFrozen(p)).toBe(true); expect(Object.isFrozen(p.binding)).toBe(true);
    expect(Object.isFrozen(p.stagedUpgrade!.workerProfiles)).toBe(true); expect(Object.isFrozen(p.expectedPrior!.configuration.saneContext)).toBe(true);
    expect(() => { (p.binding as { cwd: string }).cwd = "/changed"; }).toThrow();
    f.session.saneContext!.framework = "edited"; f.assistant.workerProfiles.implementer = "other";
    expect(p.expectedPrior?.configuration.saneContext?.framework).toBe("framework");
    expect(p.stagedUpgrade?.workerProfiles?.implementer).toBe("worker:implementer");
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });

  test("request, profile and session edits during directory I/O cannot alter preparation", async () => {
    const f = fixture({ model: "stored" }); f.assistant.model = "fixed";
    const input = f.request({ prompt: "original", profileId: f.assistant.id, workspaceId: "first" });
    const gate = Promise.withResolvers<void>();
    f.preparation.ensureDirectory = () => gate.promise;
    const result = prepareUserInput(input, f.preparation);
    input.prompt = "changed"; (input as Record<string, unknown>).workspaceId = "changed"; f.assistant.model = "changed"; f.session.model = "changed";
    gate.resolve();
    const p = await result;
    expect(p.prompt).toBe("original"); expect(p.associationSelection.workspaceId).toBe("first");
    expect(p.configuration.model).toBe("fixed"); expect(p.expectedPrior?.configuration.model).toBe("stored");
  });

  test("new OC launch fixes native model defaults once and freezes returned native data", async () => {
    const f = fixture({}, false);
    const native = { agent: "sane-engineering", model: { providerID: "provider", id: "agent-default", variant: "deep-thinking" } };
    f.preparation.resolveOpenCodeLaunch = async () => { f.calls.push("resolve"); return native; };
    f.assistant.harness = "opencode";
    const p = await prepareUserInput(f.request({ profileId: f.assistant.id }), f.preparation);
    native.model.id = "later-default"; f.assistant.model = "later-profile";
    expect(p.configuration.model).toBe("provider/agent-default"); expect(p.configuration.effort).toBe("deep-thinking");
    expect(p.normalized.model).toBe("provider/agent-default"); expect(p.nativeLaunch?.model?.id).toBe("agent-default");
    await revalidatePreparedUserInput(p, f.revalidation);
    expect(f.calls.filter(call => call === "resolve")).toHaveLength(1);
  });

  test("creation source identity is pinned before asynchronous preparation", async () => {
    const f = fixture({}, false);
    let source = "original-source";
    f.preparation.sourceAuthorityId = () => source;
    f.revalidation.sourceAuthorityId = () => source;
    const gate = Promise.withResolvers<void>();
    f.preparation.ensureDirectory = () => gate.promise;
    const result = prepareUserInput(f.request(), f.preparation);
    source = "replaced-source"; gate.resolve();
    const p = await result;
    expect(p.binding.authorityId).toBe("original-source");
    await expect(revalidatePreparedUserInput(p, f.revalidation)).rejects.toThrow("Conversation configuration changed");
  });

  test("OC resumes only shape-check stored models and accept native variants", async () => {
    const f = fixture({ harness: "opencode", authorityId: "source:opencode", nativeSessionId: "ses_old", model: "provider/model", effort: "deep-thinking", nativeAgentSelected: false });
    const p = await prepareUserInput(f.request(), f.preparation);
    expect(p.configuration.effort).toBe("deep-thinking"); expect(f.calls).toContain("model:provider/model:deep-thinking"); expect(f.calls).not.toContain("resolve");
    await revalidatePreparedUserInput(p, f.revalidation);
    const explicit = await prepareUserInput(f.request({ effort: "another-native-variant" }), f.preparation);
    await revalidatePreparedUserInput(explicit, f.revalidation);
    await expect(prepareUserInput(f.request({ effort: "bad\u0000variant" }), f.preparation)).rejects.toThrow("Invalid native variant ID");
  });

  test("CC efforts stay fixed and null/unknown harness cannot hide behind a profile", async () => {
    const f = fixture({}, false);
    await expect(prepareUserInput(f.request({ effort: "deep-thinking" }), f.preparation)).rejects.toThrow("effort must be");
    for (const harness of [null, "future", ""]) await expect(prepareUserInput(f.request({ harness, profileId: f.assistant.id }), f.preparation)).rejects.toThrow("Unknown harness");
  });

  test("nativeStopped acknowledgement restrictions are preserved", async () => {
    const f = fixture({ attachment: { state: "ready", source: "source:claude-code" } });
    for (const nativeStopped of [undefined, false, "true"]) {
      const result = prepareUserInput(f.request({ nativeStopped }), f.preparation);
      await expect(result).rejects.toMatchObject({ status: 409, code: "native-acknowledgement-required" });
    }
    const p = await prepareUserInput(f.request({ nativeStopped: true }), f.preparation);
    expect(p.nativeStopped).toBe(true); await revalidatePreparedUserInput(p, f.revalidation);
    const oc = fixture({ harness: "opencode", authorityId: "source:opencode", attachment: { state: "ready", source: "source:opencode" } });
    await prepareUserInput(oc.request(), oc.preparation);
  });

  test("ordinary compact commands are rejected before launch work", async () => {
    const f = fixture();
    for (const prompt of ["/compact", "  /COMPACT instructions\n", "/compact\nextra"]) await expect(prepareUserInput(f.request({ prompt }), f.preparation)).rejects.toMatchObject({ status: 400, code: "compact-action-required" });
    expect(f.calls).toEqual([]);
    await prepareUserInput(f.request({ prompt: "/compactish is plain text" }), f.preparation);
  });

  test("selected workspace directory is resolved only for new omitted-cwd input", async () => {
    const fresh = fixture({}, false);
    const p = await prepareUserInput(fresh.request({ workspaceId: "w", worktreeId: "t" }), fresh.preparation);
    expect(p.binding.cwd).toBe("/selected"); expect(p.associationSelection).toEqual({ workspaceId: "w", worktreeId: "t" });
    const existing = fixture();
    await prepareUserInput(existing.request({ workspaceId: "w", worktreeId: "t" }), existing.preparation);
    expect(existing.calls.some(call => call.startsWith("binding:"))).toBe(false);
    await expect(prepareUserInput(existing.request({ cwd: "/other" }), existing.preparation)).rejects.toThrow("Session cwd cannot change");
  });

  test("request validation and unavailable directories retain explicit errors", async () => {
    const f = fixture();
    for (const input of [null, [], { prompt: " " }, f.request({ profileId: null }), f.request({ model: "" }), f.request({ sessionId: "unknown" })]) await expect(prepareUserInput(input, f.preparation)).rejects.toBeInstanceOf(Error);
    f.preparation.ensureDirectory = async () => { throw new Error("missing"); };
    await expect(prepareUserInput(f.request(), f.preparation)).rejects.toMatchObject({ status: 400, message: "cwd must be an existing directory" });
  });
});

describe("delayed prepared-input revalidation", () => {
  for (const phase of ["validateBinding", "ensureDirectory"] as const) {
    for (const change of ["identity", "configuration", "source", "staged-profile"] as const) {
      test(`rejects ${change} changes DURING ${phase} await without rewriting prepared pins`, async () => {
        const f = fixture({ profileId: "base:cc", model: "stored", effort: "low" });
        f.assistant.model = "selected-model";
        const prepared = await prepareUserInput(f.request({ profileId: f.assistant.id }), f.preparation);
        const snapshot = JSON.stringify(prepared), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
        f.revalidation[phase] = async () => { entered.resolve(); await gate.promise; };
        const revalidation = revalidatePreparedUserInput(prepared, f.revalidation);
        // Observe rejection before resuming the gate, avoiding an orphan promise.
        const outcome = revalidation.then(() => undefined, (error: unknown) => error);
        await entered.promise;
        if (change === "identity") f.session.nativeSessionId = "changed-during-await";
        if (change === "configuration") f.session.effort = "max";
        if (change === "source") f.setSource("changed-source-during-await");
        if (change === "staged-profile") f.assistant.workerProfiles = { implementer: "changed-during-await" };
        gate.resolve(); expect(await outcome).toMatchObject({ status: 409 });
        expect(JSON.stringify(prepared)).toBe(snapshot);
      });
    }
  }

  test("final synchronous prepared validation prevents coordinator owner publication and dispatch after preflight", async () => {
    for (const change of ["identity", "configuration", "source", "staged-profile"] as const) {
      const f = fixture({ profileId: "base:cc", model: "stored" });
      const prepared = await prepareUserInput(f.request({ profileId: f.assistant.id }), f.preparation);
      await revalidatePreparedUserInput(prepared, f.revalidation);
      const coordinator = new ConversationCoordinator({ maxConcurrentRuns: 1 }), registry = new HarnessDispatchRegistry();
      const reservation = coordinator.reserveAdmission({ conversationIds: [sessionId], intent: { kind: "user-prompt" } });
      if (!reservation.ready) throw new Error(reservation.reason);
      let publications = 0, executions = 0;
      registry.register({ id: prepared.binding.harness,
        automation: { "queued-user": { supported: true }, "worker-report": { supported: true }, handoff: { supported: true } },
        readiness: async source => ({ source, readiness: { ready: true } }),
        execute: async () => { executions++; }, successfulSettlement: async () => ({ ready: true }),
      });
      if (change === "identity") f.session.nativeSessionId = "changed-before-install";
      if (change === "configuration") f.session.model = "changed-before-install";
      if (change === "source") f.setSource("changed-before-install");
      if (change === "staged-profile") f.assistant.hidden = true;
      expect(() => registry.start({ source: { harnessId: prepared.binding.harness, sessionId, cwd: prepared.binding.cwd,
        nativeSessionId: prepared.binding.nativeSessionId ?? null, authorityId: prepared.binding.authorityId },
        origin: "user", prompt: prepared.prompt, resume: prepared.resume }, {
        install: done => {
          assertPreparedUserInputCurrent(prepared, f.revalidation);
          const owner: RunOwner = { run: { runId: "must-not-publish", sessionId, cwd: prepared.binding.cwd, status: "running", createdAt: "now" }, done, settled: false };
          const installation = coordinator.installOwner(reservation.lease, owner);
          if (!installation.ready) throw new Error(installation.reason);
          publications++; return owner;
        },
        owns: owner => coordinator.owns(owner), settle: owner => { owner.settled = true; }, release: owner => { coordinator.releaseOwner(owner); },
        failClosed: error => { expect(error).toBeInstanceOf(UserInputPreparationError); }, terminate: async () => {},
        guards: () => { throw new Error("unpublished lifecycle cannot query guards"); },
      })).toThrow();
      await Promise.resolve();
      expect(publications).toBe(0); expect(executions).toBe(0); expect(coordinator.hasOwner(sessionId)).toBe(false);
      expect(coordinator.holdsAdmission(reservation.lease, sessionId)).toBe(true); coordinator.releaseAdmission(reservation.lease);
    }
  });

  test("rechecks the source snapshot after directory I/O, not only before the await", async () => {
    const f = fixture({ model: "stored" });
    const prepared = await prepareUserInput(f.request(), f.preparation);
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    f.revalidation.ensureDirectory = async () => { entered.resolve(); await gate.promise; };
    const pending = revalidatePreparedUserInput(prepared, f.revalidation);
    await entered.promise; f.session.model = "changed-after-first-guard"; gate.resolve();
    await expect(pending).rejects.toMatchObject({ status: 409 });
    expect(prepared.configuration.model).toBe("stored");
  });

  test("delayed effort checks follow the prepared harness, including serialized input", async () => {
    const cc = fixture(); const original = await prepareUserInput(cc.request(), cc.preparation);
    const invalid = JSON.parse(JSON.stringify(original));
    invalid.configuration.effort = "native-thinking";
    await expect(revalidatePreparedUserInput(invalid, cc.revalidation)).rejects.toThrow("Queued launch configuration is invalid");
    const oc = fixture({ harness: "opencode", authorityId: "source:opencode" });
    const variant = JSON.parse(JSON.stringify(await prepareUserInput(oc.request(), oc.preparation)));
    variant.configuration.effort = "native-thinking";
    await revalidatePreparedUserInput(variant, oc.revalidation);
    variant.configuration.effort = "bad\u0000variant";
    await expect(revalidatePreparedUserInput(variant, oc.revalidation)).rejects.toThrow("Queued launch configuration is invalid");
  });

  test("rejects source and complete configuration identity drift", async () => {
    const changes: Partial<Session>[] = [
      { nativeSessionId: "other" }, { authorityId: "other" }, { harness: "opencode" }, { cwd: "/other" },
      { agent: "design" }, { agentKind: "worker" }, { nativeAgentSelected: true }, { profileId: "other" },
      { model: "other" }, { effort: "max" }, { saneContext: { version: 2, framework: "other" } },
      { attachment: { state: "ready", source: "other" } },
    ];
    for (const change of changes) {
      const f = fixture({ model: "stored", effort: "low" });
      const p = await prepareUserInput(f.request(), f.preparation);
      Object.assign(f.session, change);
      await expect(revalidatePreparedUserInput(p, f.revalidation)).rejects.toThrow("Conversation configuration changed before queued admission");
    }
    const f = fixture(); const p = await prepareUserInput(f.request(), f.preparation);
    f.setSource("changed-source");
    await expect(revalidatePreparedUserInput(p, f.revalidation)).rejects.toThrow("Conversation configuration changed");
  });

  test("rejects missing conversation and collision on prepared creation ID", async () => {
    const f = fixture(); const p = await prepareUserInput(f.request(), f.preparation);
    f.setSession(undefined);
    await expect(revalidatePreparedUserInput(p, f.revalidation)).rejects.toThrow("Conversation configuration changed");
    const fresh = fixture({}, false); const creation = await prepareUserInput(fresh.request(), fresh.preparation);
    fresh.setSession({ ...fresh.session, sessionId: newId });
    await expect(revalidatePreparedUserInput(creation, fresh.revalidation)).rejects.toThrow("Conversation configuration changed");
  });

  test("rejects staged profile edits or deletion, including worker mappings", async () => {
    const mutations: ((profile: AgentProfile) => void)[] = [p => { p.model = "edited"; }, p => { p.role = "design"; }, p => { p.hidden = true; }, p => { p.workerProfiles = { implementer: "changed" }; }];
    for (const mutate of mutations) {
      const f = fixture(); const p = await prepareUserInput(f.request({ profileId: f.assistant.id }), f.preparation);
      mutate(f.assistant);
      await expect(revalidatePreparedUserInput(p, f.revalidation)).rejects.toThrow("Selected profile changed before queued admission");
    }
    const f = fixture(); const p = await prepareUserInput(f.request({ profileId: f.assistant.id }), f.preparation);
    f.profiles.profiles = f.profiles.profiles.filter(profile => profile.id !== f.assistant.id);
    await expect(revalidatePreparedUserInput(p, f.revalidation)).rejects.toThrow("Selected profile changed");
  });

  test("round-tripped snapshots revalidate without object-identity launch authority", async () => {
    const f = fixture({ saneContext: { version: 1, framework: "framework" }, model: "stored" });
    const p = await prepareUserInput(f.request(), f.preparation);
    f.setSession(JSON.parse(JSON.stringify(f.session)));
    await revalidatePreparedUserInput(JSON.parse(JSON.stringify(p)), f.revalidation);
    f.session.lastStatus = "completed"; f.session.title = "new title";
    f.setSession(f.session);
    await revalidatePreparedUserInput(p, f.revalidation);
  });

  test("injected admission/execution binding validation and directory failures fail closed", async () => {
    const f = fixture(); const p = await prepareUserInput(f.request(), f.preparation);
    f.calls.length = 0;
    f.revalidation.validateBinding = () => { throw new Error("Reservation lost"); };
    await expect(revalidatePreparedUserInput(p, f.revalidation)).rejects.toThrow("Reservation lost");
    expect(f.calls).toEqual([]);
    f.revalidation.validateBinding = undefined;
    f.revalidation.ensureDirectory = async () => { throw new Error("gone"); };
    await expect(revalidatePreparedUserInput(p, f.revalidation)).rejects.toBeInstanceOf(UserInputPreparationError);
    await expect(revalidatePreparedUserInput(p, f.revalidation)).rejects.toThrow("Queued execution directory unavailable");
  });
});
