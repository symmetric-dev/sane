import { expect, test } from "bun:test";
import { decodePreparedUserInput, fingerprint } from "./prepared-input-codec";
import { decodePendingInputPins, decodePendingInputRecords, decodePendingInputSnapshot, pendingInputIntentFingerprint, validateRequestSnapshot } from "./pending-input-codec";
import { PendingInputStore } from "./pending-input-store";
import { PendingInputCodecError } from "./pending-input-contract";
import { at, id, pendingFixture } from "./pending-input-fixtures";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { seedAgentProfiles, type AgentProfiles } from "./agent-profiles-contract";
import { prepareUserInput, type PreparedUserInput } from "./user-input-preparation";
import type { Session } from "./history";

const TEMP = "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode";
test("actual prepared resume roundtrips with omission and immutable nested clones", async () => {
  const f = await pendingFixture("opencode", {}, { model: "provider/model", effort: "native thinking", agent: "engineering", agentKind: "assistant", nativeAgentSelected: true, saneContext: { version: 1, framework: "framework" } });
  const raw = JSON.parse(JSON.stringify(f.snapshot.prepared)), decoded = decodePreparedUserInput(raw);
  expect(decoded.requested).toEqual({}); expect(decoded.normalized).toEqual({}); expect(decoded.configuration.effort).toBe("native thinking");
  raw.configuration.model = "changed"; expect(decoded.configuration.model).toBe("provider/model"); expect(Object.isFrozen(decoded.expectedPrior!.configuration.saneContext)).toBe(true);
  expect(decodePendingInputSnapshot(f.snapshot).prepared).toEqual(decoded); validateRequestSnapshot(f.request, f.snapshot);
});
test("staged upgrades remain generic-codec-valid but cannot enter a waiting chain", async () => {
  const f = await pendingFixture("claude-code", { profileId: "template:engineering" });
  expect(decodePreparedUserInput(JSON.parse(JSON.stringify(f.snapshot.prepared))).stagedUpgrade?.role).toBe("engineering");
  expect(() => decodePendingInputSnapshot(f.snapshot)).toThrow("staged upgrade");
});
for (const harness of ["claude-code", "opencode"] as const) test(`${harness} explicit launch changes remain preparation-valid but not queue-valid`, async () => {
  const f = await pendingFixture(harness, { model: "new-model" }, { model: "old-model" });
  expect(decodePreparedUserInput(f.snapshot.prepared).configuration.model).toBe("new-model");
  expect(f.snapshot.prepared.expectedPrior!.configuration.model).toBe("old-model");
  expect(() => decodePendingInputPins(f.snapshot.pins)).toThrow("preserve the captured prior configuration");
  expect(() => decodePendingInputSnapshot(f.snapshot)).toThrow("preserve the captured prior configuration");
});
test("canonical fingerprints ignore object key insertion order but distinguish optional omission", async () => {
  const f = await pendingFixture();
  const reorder = (v: any): any => Array.isArray(v) ? v.map(reorder) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).reverse().map(([k, child]) => [k, reorder(child)])) : v;
  expect(fingerprint(f)).toBe(fingerprint(reorder(f)));
  expect(fingerprint({ requested: {} })).not.toBe(fingerprint({ requested: { model: "same-effective-model" } }));
  expect(() => fingerprint({ unknown: undefined })).toThrow("Non-JSON");
  const cyclic: any = {}; cyclic.self = cyclic;
  expect(() => fingerprint(cyclic)).toThrow("Cyclic");
  expect(() => fingerprint(new Array(2))).toThrow("Sparse");
  expect(() => fingerprint({ [Symbol("hidden-key")]: true })).toThrow("Non-JSON");
  expect(() => fingerprint(Object.defineProperty({}, "getter", { enumerable: true, get: () => "not ordinary JSON" }))).toThrow("Non-JSON");
});
const malformedPreparation: Record<string, (p: any) => void> = {
  unknown: (p: any) => p.extra = true,
  bindingKey: (p: any) => p.binding.extra = true,
  harness: (p: any) => p.binding.harness = "third-harness",
  nativeAlias: (p: any) => p.binding.harness = "cc",
  authorityUUID: (p: any) => p.binding.authorityId = id(),
  cwdRelative: (p: any) => p.binding.cwd = "repo",
  cwdUncanonical: (p: any) => p.binding.cwd = "/repo/../repo",
  sourceControl: (p: any) => p.binding.nativeSessionId = "bad\nidentity",
  unknownNative: (p: any) => p.binding.nativeSessionId = null,
  priorSource: (p: any) => p.expectedPrior.binding.authorityId = `sane-native-v1:cc:${"c".repeat(64)}`,
  configUnknown: (p: any) => p.configuration.command = "do not execute",
  configCrosslink: (p: any) => p.configuration.model = "forged-model",
  priorConfig: (p: any) => p.expectedPrior.configuration.model = "forged-inherited-model",
  ccVariant: (p: any) => p.configuration.effort = "OC thinking",
  effortControl: (p: any) => p.normalized.effort = "high\n",
  malformedProfile: (p: any) => p.configuration.profileId = "arbitrary-profile",
  agentKind: (p: any) => p.configuration.agentKind = "worker",
  contextUnknown: (p: any) => p.configuration.saneContext = { version: 1, framework: "f", extra: "x" },
  workerAssignment: (p: any) => p.configuration.saneContext = { version: 1, framework: "f", assignment: "worker-only" },
  attachmentUnknown: (p: any) => p.configuration.attachment = { state: "ready", source: "profile", extra: true },
  associationUUID: (p: any) => p.associationSelection.workspaceId = "not-a-real-id",
  requestUnknown: (p: any) => p.requested.extra = true,
  normalizedNull: (p: any) => p.normalized.model = null,
  nativeLaunchOnResume: (p: any) => p.nativeLaunch = { model: { id: "model", providerID: "provider" } },
  unsafeValue: (p: any) => p.requested.model = Infinity,
};
for (const [name, mutate] of Object.entries(malformedPreparation)) test(`strict prepared codec rejects ${name}`, async () => {
  const f = await pendingFixture(), raw = structuredClone(f.snapshot.prepared) as any; mutate(raw);
  expect(() => decodePreparedUserInput(raw)).toThrow(PendingInputCodecError);
});
const malformedPins: Record<string, (p: any) => void> = {
  admissionUnknown: (p: any) => p.admission.extra = true,
  admissionUnready: (p: any) => p.admission.state = "identity_known",
  authorityDescriptor: (p: any) => p.admission.source.descriptor.profileRoot = "/another-profile",
  catalogRevision: (p: any) => p.catalog.bindingRevision = id(),
  catalogUnknown: (p: any) => p.catalog.inode = 1,
  configuration: (p: any) => p.configuration.model = "forged-model",
  launch: (p: any) => p.launch.model = "forged-model",
  missingContext: (p: any) => p.admission.binding.domain = { mode: "repository", repositoryId: id(), primaryCheckout: "/repo" },
  arbitraryContext: (p: any) => p.context = { token: "not a domain pin" },
};
for (const [name, mutate] of Object.entries(malformedPins)) test(`strict chain codec rejects ${name}`, async () => {
  const f = await pendingFixture(), raw = structuredClone(f.snapshot) as any; mutate(raw.pins);
  expect(() => decodePendingInputSnapshot(raw)).toThrow(PendingInputCodecError);
});
test("core repository membership and phase identities are validated and source-crosslinked", async () => {
  const f = await pendingFixture(), pins = structuredClone(f.snapshot.pins), repositoryId = id(), workstreamId = "queue-test";
  // Workstream IDs are slug IDs in the actual domain, not UUIDs. This test will
  // exercise that schema directly after constructing the source-qualified pin.
  const checkout = { path: "/repo", commonDir: "/repo/.git", gitDir: "/repo/.git", device: 1, inode: 2, commonDevice: 1, commonInode: 3, gitDevice: 1, gitInode: 3 };
  const ref = { harness: "cc" as const, authorityId: pins.admission.source.authorityId, nativeId: pins.admission.nativeId! };
  pins.admission.binding.checkoutPin = checkout; pins.admission.binding.domain = { mode: "repository", repositoryId, primaryCheckout: "/repo" };
  pins.context = { conversation: { id: id(), repositoryId, ref, executionCheckout: checkout, parent: null, workstreamId, createdAt: at }, workstream: { id: workstreamId, repositoryId, defaultCheckout: checkout }, primaryCheckout: "/repo", artifactsRoot: "/repo/.sane/workstreams/queue-test", assignments: [{ id: id(), membershipId: id(), ref, workstreamId, phase: "engineering", startedAt: at, endedAt: null }] };
  expect(decodePendingInputPins(pins).context?.conversation.workstreamId).toBe(workstreamId);
  // Legacy pins remain decodable; newly admitted records include the actual
  // current membership even without a phase assignment.
  pins.context.membership = { id: pins.context.assignments[0]!.membershipId, conversationId: pins.context.conversation.id, workstreamId, startedAt: at, endedAt: null };
  expect(decodePendingInputPins(pins).context?.membership).toEqual(pins.context.membership);
  for (const mutate of [(p: any) => p.context.membership = null, (p: any) => p.context.membership.conversationId = id(), (p: any) => p.context.membership.workstreamId = "other", (p: any) => p.context.membership.endedAt = at, (p: any) => p.context.assignments[0].membershipId = id(), (p: any) => p.context.membership.unknown = true]) {
    const changed = structuredClone(pins); mutate(changed); expect(() => decodePendingInputPins(changed)).toThrow();
  }
  pins.context.assignments[0]!.ref = { ...ref, nativeId: id() };
  expect(() => decodePendingInputPins(pins)).toThrow();
});
test("persisted record decoder fails closed on unknown keys, counters and receipt/pin crosslinks", async () => {
  const dir = realpathSync(mkdtempSync(join(TEMP, "pending-codec-"))), storeId = id();
  try {
    const store = new PendingInputStore(dir, storeId, { validateLive: () => {} }); store.enqueue(await pendingFixture());
    const pristine = store.readRecords();
    for (const mutate of [(r: any) => r.extra = true, (r: any) => r.version = 2, (r: any) => r.storeId = id(), (r: any) => r.nextSequence = 1, (r: any) => r.conversations[0].revision = 0, (r: any) => r.conversations[0].items[0].receipt.sequence++, (r: any) => r.conversations[0].items[0].snapshot.prepared.prompt = "forged", (r: any) => r.conversations[0].chain.pins.catalog.extra = true]) {
      const raw = structuredClone(pristine); mutate(raw); expect(() => decodePendingInputRecords(raw, storeId)).toThrow(PendingInputCodecError);
    }
  } finally { rmSync(dir, { recursive: true }); }
});
test("persisted queue rejects coherently forged prior/launch differences, even with matching chain and intent", async () => {
  const dir = realpathSync(mkdtempSync(join(TEMP, "pending-codec-config-"))), storeId = id();
  try {
    const f = await pendingFixture("claude-code", { model: "old-model" }, { model: "old-model" });
    const store = new PendingInputStore(dir, storeId, { validateLive: () => {} }); store.enqueue(f);
    const raw = structuredClone(store.readRecords()), c = raw.conversations[0]!, item = c.items[0]!;
    item.snapshot.prepared = { ...item.snapshot.prepared, configuration: { ...item.snapshot.prepared.configuration, model: "new-model" }, requested: { model: "new-model" }, normalized: { model: "new-model" } };
    item.snapshot.pins.launch = { ...item.snapshot.pins.launch, model: "new-model" };
    item.request = { ...item.request, configuration: { ...item.request.configuration, model: "new-model" } };
    item.fingerprint = pendingInputIntentFingerprint(item.request, item.snapshot.prepared);
    c.chain!.pins = structuredClone(item.snapshot.pins);
    // All generic preparation and queue crosslinks are coherent; the queue-only
    // invariant must still refuse a stored selector masquerading as an assertion.
    expect(decodePreparedUserInput(item.snapshot.prepared).configuration.model).toBe("new-model");
    validateRequestSnapshot(item.request, item.snapshot);
    expect(() => decodePendingInputRecords(raw, storeId)).toThrow("preserve the captured prior configuration");
  } finally { rmSync(dir, { recursive: true }); }
});
test("ordinary preparation preserves a launch profile snapshot without pinning global worker mappings", async () => {
  const f = await pendingFixture("claude-code", { profileId: "base:cc", model: { ignored: "profile-selected resume" }, effort: "also ignored" });
  const raw = structuredClone(f.snapshot.prepared) as any; raw.selectedProfile.workerProfiles = { reviewer: id(), tester: "worker:tester" };
  const decoded = decodePreparedUserInput(raw); expect(decoded.requested.model).toEqual({ ignored: "profile-selected resume" }); expect(decoded.normalized).toEqual({ profileId: "base:cc" });
  expect(decodePendingInputSnapshot({ ...f.snapshot, prepared: decoded }).pins).toEqual(f.snapshot.pins);
  raw.selectedProfile.workerProfiles.reviewer = "template:engineering"; expect(() => decodePreparedUserInput(raw)).toThrow();
});
test("same-profile resume retains session launch selections even if current profile harness/defaults changed", async () => {
  const f = await pendingFixture("claude-code", { profileId: "template:engineering" }, { profileId: "template:engineering", agent: "engineering", agentKind: "assistant", model: "historical-model", effort: "high" });
  const prepared = structuredClone(f.snapshot.prepared) as any;
  prepared.selectedProfile.harness = "opencode"; prepared.selectedProfile.model = "provider/new-model"; prepared.selectedProfile.effort = "OC variant";
  expect(decodePendingInputSnapshot({ ...f.snapshot, prepared }).prepared.configuration).toEqual(f.snapshot.prepared.configuration);
});
test("new OC native launch is codec-valid independently, but cannot authorize an established queue", async () => {
  const f = await pendingFixture("opencode"), p = structuredClone(f.snapshot.prepared) as any;
  delete p.expectedPrior; delete p.binding.nativeSessionId; p.resume = false; p.requested = { harness: "opencode" }; p.normalized = { harness: "opencode", model: "provider/model", effort: "thinking variant" }; p.configuration = { profileId: "base:oc", model: "provider/model", effort: "thinking variant" }; p.nativeLaunch = { model: { providerID: "provider", id: "model", variant: "thinking variant" } };
  expect(decodePreparedUserInput(p).nativeLaunch?.model?.variant).toBe("thinking variant");
  expect(() => decodePendingInputSnapshot({ prepared: p, pins: f.snapshot.pins })).toThrow("established resume");
  p.nativeLaunch.model.extra = "unknown"; expect(() => decodePreparedUserInput(p)).toThrow();
});

/** Differential fixtures use actual preparation, including saved Knowledge and
 * mutable selected profiles; no decoder-authored normalization as an oracle. */
async function actualPreparation(raw: Record<string, unknown>, options: { harness?: "claude-code" | "opencode"; existing?: boolean; session?: Partial<Session>; configure?: (profiles: AgentProfiles) => void } = {}): Promise<PreparedUserInput> {
  const harness = options.harness ?? "claude-code", f = await pendingFixture(harness), b = f.snapshot.prepared.binding;
  const session: Session = { sessionId: b.conversationId, harness, authorityId: b.authorityId, nativeSessionId: b.nativeSessionId, cwd: b.cwd, lastStatus: "unknown", lastRunId: null, profileId: harness === "opencode" ? "base:oc" : "base:cc", ...options.session };
  const profiles = seedAgentProfiles(at); options.configure?.(profiles);
  return prepareUserInput({ prompt: "codec differential", ...(options.existing === false ? { harness } : { sessionId: session.sessionId }), ...raw }, {
    profiles, getSession: () => session, defaultCwd: b.cwd, conversationId: id, sourceAuthorityId: () => b.authorityId,
    selectedDirectory: async () => b.cwd, ensureDirectory: async () => {}, validateOpenCodeModel: () => {},
    resolveOpenCodeLaunch: async (_cwd, settings) => ({ ...(settings.agent ? { agent: settings.agent } : {}), model: { providerID: "provider", id: "resolved-model", variant: "native default variant" } }),
  });
}
const queueResumeCases: Array<{ name: string; options?: Parameters<typeof actualPreparation>[1] }> = [
  { name: "ordinary saved selections", options: { session: { model: "saved-model", effort: "medium" } } },
  { name: "saved assistant profile", options: { session: { profileId: "template:engineering", agent: "engineering", agentKind: "assistant", model: "saved-model", nativeAgentSelected: true } } },
  { name: "saved historical Knowledge", options: { session: { profileId: "template:knowledge", agent: "knowledge", agentKind: "assistant", model: "saved-model", nativeAgentSelected: false } } },
  { name: "saved historical profile ID", options: { session: { profileId: id(), agent: "knowledge", model: "saved-model" } } },
  { name: "OC native agent metadata", options: { harness: "opencode", session: { agent: "engineering", agentKind: "assistant", nativeAgentSelected: false, model: "provider/model", effort: " native thinking " } } },
  { name: "saved context snapshot", options: { session: { saneContext: { version: 1, framework: "saved framework" } } } },
];
for (const c of queueResumeCases) test(`server queue preparation preserves prior configuration: ${c.name}`, async () => {
  const prepared = await actualPreparation({}, c.options);
  expect(prepared.requested).toEqual({});
  expect(prepared.configuration).toEqual(prepared.expectedPrior!.configuration);
  const f = await pendingFixture(c.options?.harness, {}, c.options?.session);
  expect(decodePendingInputSnapshot(f.snapshot).prepared.configuration).toEqual(f.snapshot.prepared.expectedPrior!.configuration);
});
const selectionCases: Array<{ name: string; raw: Record<string, unknown>; options?: Parameters<typeof actualPreparation>[1] }> = [
  { name: "ordinary omitted resume", raw: {}, options: { session: { model: "saved-model", effort: "medium" } } },
  { name: "ordinary explicit model effort harness", raw: { harness: "claude-code", model: "selected-model", effort: "high" } },
  { name: "OC native variant resume", raw: { harness: "opencode", model: "provider/model", effort: "thinking variant" }, options: { harness: "opencode" } },
  { name: "inferred assistant upgrade", raw: { agent: "engineering", model: { ignored: true }, effort: false } },
  { name: "explicit same-profile ignored JSON", raw: { profileId: "base:cc", harness: "opencode", model: { ignored: true }, effort: ["ignored"], agent: null } },
  { name: "explicit upgrade ignores selections", raw: { profileId: "template:engineering", harness: "opencode", model: false, effort: null, agent: { ignored: true } } },
  { name: "same assistant inferred profile", raw: { agent: "engineering", model: null }, options: { session: { agent: "engineering", profileId: "template:engineering" } } },
  { name: "saved Knowledge explicit profile", raw: { profileId: "template:knowledge", harness: "opencode", model: { ignored: true }, effort: null, agent: ["ignored"] }, options: { session: { agent: "knowledge", profileId: "template:knowledge", model: "historical-model" } } },
  { name: "saved Knowledge inferred profile", raw: { agent: "knowledge", model: { ignored: true }, effort: false }, options: { session: { agent: "knowledge", profileId: "template:knowledge", effort: "medium" } } },
  { name: "ordinary saved Knowledge omission", raw: {}, options: { session: { agent: "knowledge", profileId: "template:knowledge", model: "historical-model" } } },
  { name: "profile-selected creation override", raw: { profileId: "template:engineering", harness: "opencode", model: { ignored: true }, effort: false, agent: null }, options: { existing: false } },
  { name: "ordinary CC creation settings", raw: { model: "new-model", effort: "max", agent: "engineering" }, options: { existing: false } },
  { name: "OC creation native-resolved defaults", raw: {}, options: { existing: false, harness: "opencode" } },
  { name: "OC creation native-resolved explicit settings", raw: { model: "provider/requested-model", effort: "requested variant", agent: "engineering" }, options: { existing: false, harness: "opencode" } },
];
for (const c of selectionCases) test(`actual preparation roundtrips requested/normalized semantics: ${c.name}`, async () => {
  const prepared = await actualPreparation(c.raw, c.options);
  expect(decodePreparedUserInput(JSON.parse(JSON.stringify(prepared)))).toEqual(prepared);
});
for (const [key, value] of Object.entries({ model: { invalid: true }, effort: { invalid: true }, agent: { invalid: true }, harness: "opencode", profileId: { invalid: true } })) test(`ordinary resume cannot launder invalid/unapplied requested ${key}`, async () => {
  await expect(actualPreparation({ [key]: value })).rejects.toThrow();
  const prepared = await actualPreparation({}), mutated = structuredClone(prepared) as any;
  mutated.requested[key] = value;
  expect(() => decodePreparedUserInput(mutated)).toThrow(PendingInputCodecError);
});
for (const key of ["model", "effort", "harness", "profileId", "agent"] as const) test(`requested/normalized ${key} relationship cannot be forged`, async () => {
  const raw = key === "model" ? { model: "selected-model" } : key === "effort" ? { effort: "high" } : key === "harness" ? { harness: "claude-code" } : key === "profileId" ? { profileId: "base:cc" } : { agent: "engineering" };
  const prepared = await actualPreparation(raw), mutated = structuredClone(prepared) as any;
  mutated.requested[key] = key === "model" ? "another-model" : key === "effort" ? "low" : key === "harness" ? "opencode" : key === "profileId" ? "base:oc" : "research";
  expect(() => decodePreparedUserInput(mutated)).toThrow(PendingInputCodecError);
});
test("omitted normalization cannot manufacture explicit model/effort/harness selections", async () => {
  const prepared = await actualPreparation({}, { session: { model: "saved-model", effort: "high" } });
  for (const [key, value] of Object.entries({ model: "saved-model", effort: "high", harness: "claude-code" })) {
    const mutated = structuredClone(prepared) as any; mutated.normalized[key] = value;
    expect(() => decodePreparedUserInput(mutated)).toThrow(PendingInputCodecError);
  }
});
test("only genuine saved historical fallback may ignore raw settings without selectedProfile", async () => {
  const session = { profileId: id(), model: "saved-model" };
  await expect(actualPreparation({ profileId: session.profileId, model: { invalid: true } }, { session })).rejects.toThrow();
  const prepared = await actualPreparation({}, { session }), mutated = structuredClone(prepared) as any;
  mutated.requested = { profileId: session.profileId, model: { invalid: true } }; mutated.normalized = { profileId: session.profileId };
  expect(() => decodePreparedUserInput(mutated)).toThrow(PendingInputCodecError);
  const historical = await actualPreparation({ profileId: session.profileId, model: { ignored: true }, effort: null, agent: false }, { session: { ...session, agent: "knowledge" } });
  expect(historical.selectedProfile).toBeUndefined(); expect(decodePreparedUserInput(JSON.parse(JSON.stringify(historical)))).toEqual(historical);
});
test("saved historical requested/normalized relationships retain the exact fallback selection", async () => {
  const prepared = await actualPreparation({ profileId: "template:knowledge", model: { ignored: true } }, { session: { profileId: "template:knowledge", agent: "knowledge", model: "saved-model" } });
  for (const mutate of [
    (p: any) => { delete p.requested.profileId; },
    (p: any) => { p.requested.profileId = "template:engineering"; },
    (p: any) => { p.normalized.model = "saved-model"; },
    (p: any) => { delete p.normalized.profileId; },
  ]) { const p = structuredClone(prepared); mutate(p); expect(() => decodePreparedUserInput(p)).toThrow(PendingInputCodecError); }
});
test("profile selection never ignores invalid harness or invalid profile ID shapes", async () => {
  const prepared = await actualPreparation({ profileId: "base:cc", model: { legitimatelyIgnored: true } });
  for (const raw of [{ profileId: "base:cc", harness: { invalid: true } }, { profileId: { invalid: true }, model: { ignored: true } }]) {
    await expect(actualPreparation(raw)).rejects.toThrow();
    const p = structuredClone(prepared) as any; p.requested = raw; expect(() => decodePreparedUserInput(p)).toThrow(PendingInputCodecError);
  }
});
