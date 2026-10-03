import { describe, expect, test } from "bun:test";
import { capabilitiesFor, FIXED_EFFORT_VALUES, getHarnessDescriptor, HARNESS_DESCRIPTORS, isHarness, type Harness, type HarnessCapabilities, type HarnessOperation } from "../shared/conversation/harness-capabilities";
import { efforts } from "../src/history";
import type { HarnessInfo } from "../frontend/types";

const operations: HarnessOperation[] = ["prompt", "readHistory", "attachHistory", "compact", "branch", "cancelOwnedRun", "listInteractions", "permissionReply", "questionReply", "listModels", "recoverRun"];

describe("static harness descriptors", () => {
  test("registry covers both current harnesses and every operation", () => {
    expect(Object.keys(HARNESS_DESCRIPTORS).sort()).toEqual(["claude-code", "opencode"]);
    for (const harness of Object.keys(HARNESS_DESCRIPTORS) as Harness[]) {
      const descriptor = getHarnessDescriptor(harness)!;
      expect(isHarness(harness)).toBe(true);
      expect(descriptor.id).toBe(harness);
      expect(Object.keys(descriptor.operations).sort()).toEqual([...operations].sort());
      for (const operation of operations) {
        const support = descriptor.operations[operation];
        expect(typeof support.supported).toBe("boolean");
        if (!support.supported) expect(support.reason.length).toBeGreaterThan(0);
      }
      for (const dynamic of ["available", "connected", "state", "client"]) expect(descriptor).not.toHaveProperty(dynamic);
    }
  });

  test("strict unknown lookup never defaults to CC or indexes object properties", () => {
    for (const value of [undefined, null, "", "cc", "oc", "future-harness", "toString", "__proto__", "constructor", 0, false, {}, ["opencode"]]) {
      expect(isHarness(value)).toBe(false);
      expect(getHarnessDescriptor(value)).toBeUndefined();
      expect(capabilitiesFor(value, { permissionReplies: true, cancelRun: true })).toEqual({});
    }
  });

  test("descriptors and all nested support/policy arrays are immutable", () => {
    expect(Object.isFrozen(HARNESS_DESCRIPTORS)).toBe(true);
    for (const descriptor of Object.values(HARNESS_DESCRIPTORS)) {
      for (const value of [descriptor, descriptor.operations, descriptor.policies, descriptor.policies.effortValues, descriptor.capabilities, descriptor.capabilities.effortValues, ...Object.values(descriptor.operations)]) {
        expect(Object.isFrozen(value)).toBe(true);
      }
    }
    // Compile-time tuple inference and runtime identity remain intact in history.
    const tuple: readonly ["low", "medium", "high", "xhigh", "max"] = efforts;
    expect(tuple).toBe(FIXED_EFFORT_VALUES);
  });

  test("CC support and policies match one-shot integration constraints", () => {
    const cc = getHarnessDescriptor("claude-code")!;
    expect([cc.nativeHarness, cc.label, cc.shortLabel]).toEqual(["cc", "Claude Code", "CC"]);
    for (const key of ["prompt", "readHistory", "attachHistory", "compact", "branch", "cancelOwnedRun"] as const) expect(cc.operations[key].supported).toBe(true);
    for (const key of ["listInteractions", "permissionReply", "questionReply", "listModels", "recoverRun"] as const) expect(cc.operations[key].supported).toBe(false);
    expect(cc.policies).toEqual({
      modelInput: "free-text", catalogRequiredForSend: false, effortMode: "fixed", effortValues: ["low", "medium", "high", "xhigh", "max"],
      compactionInstructions: true, branchFromNativeMessage: false, branchAttachedConversation: false,
      branchRequiresPrompt: true, attachedSendRequiresNativeStopped: true,
    });
  });

  test("OC supports native catalog/variants, interaction replies and run monitoring recovery", () => {
    const oc = getHarnessDescriptor("opencode")!;
    expect([oc.nativeHarness, oc.label, oc.shortLabel]).toEqual(["oc", "OpenCode", "OC"]);
    for (const operation of operations) expect(oc.operations[operation].supported).toBe(true);
    expect(oc.policies).toEqual({
      modelInput: "live-catalog", catalogRequiredForSend: true, effortMode: "model-variant", effortValues: [],
      compactionInstructions: false, branchFromNativeMessage: true, branchAttachedConversation: true,
      branchRequiresPrompt: false, attachedSendRequiresNativeStopped: false,
    });
  });
});

describe("capability compatibility projection", () => {
  test("known defaults are derived from support, without any advertisement", () => {
    const mapping = {
      prompt: "prompt", readHistory: "nativeHistoryRefresh", attachHistory: "attachHistory", compact: "compaction", branch: "branch",
      cancelOwnedRun: "cancelRun", listInteractions: "listInteractions", permissionReply: "permissionReplies", questionReply: "questionReplies",
      listModels: "listModels", recoverRun: "recoverRun",
    } as const;
    for (const harness of ["claude-code", "opencode"] as const) {
      const defaults = HARNESS_DESCRIPTORS[harness].capabilities;
      expect(capabilitiesFor(harness)).toEqual({ ...defaults, effortValues: [...defaults.effortValues] });
      expect(capabilitiesFor(harness, {})).toEqual(capabilitiesFor(harness));
      expect(capabilitiesFor(harness, { cancelRun: undefined, modelInput: undefined, effortValues: undefined })).toEqual(capabilitiesFor(harness));
      for (const operation of operations) expect(defaults[mapping[operation]]).toBe(HARNESS_DESCRIPTORS[harness].operations[operation].supported);
    }
    expect(capabilitiesFor("claude-code").modelSelection).toBe(true);
    expect(capabilitiesFor("claude-code").listModels).toBe(false);
  });

  test("false feature overrides are preserved, including legacy fields", () => {
    const advertised: Partial<HarnessCapabilities> = {
      cancelRun: false, permissionReplies: false, questionReplies: false, modelSelection: false,
      compaction: false, nativeHistoryRefresh: false, branch: false, prompt: false,
      attachHistory: false, listInteractions: false, listModels: false, recoverRun: false,
    };
    const actual = capabilitiesFor("opencode", advertised);
    for (const key of Object.keys(advertised) as (keyof HarnessCapabilities)[]) expect(actual[key]).toBe(false);
    expect(actual.branchFromNativeMessage).toBe(false);
    expect(actual.branchAttachedConversation).toBe(false);
    expect(capabilitiesFor("claude-code", { compaction: false }).compactionInstructions).toBe(false);
  });

  test("malformed or aggregate advertisements cannot enable unsupported native features", () => {
    const cc = capabilitiesFor("claude-code", {
      permissionReplies: true, questionReplies: true, listInteractions: true, listModels: true, recoverRun: true,
      branchFromNativeMessage: true, branchAttachedConversation: true,
    });
    for (const key of ["permissionReplies", "questionReplies", "listInteractions", "listModels", "recoverRun", "branchFromNativeMessage", "branchAttachedConversation"] as const) expect(cc[key]).toBe(false);
    expect(capabilitiesFor("opencode", { compactionInstructions: true }).compactionInstructions).toBe(false);
    expect(capabilitiesFor("opencode", { cancelRun: null, questionReplies: "yes" } as unknown as Partial<HarnessCapabilities>)).toEqual(capabilitiesFor("opencode"));
  });

  test("advertisements cannot weaken safety requirements or change native input semantics", () => {
    const cc = capabilitiesFor("claude-code", { branchRequiresPrompt: false, attachedSendRequiresNativeStopped: false, modelInput: "live-catalog", effortMode: "model-variant" });
    expect(cc.branchRequiresPrompt).toBe(true);
    expect(cc.attachedSendRequiresNativeStopped).toBe(true);
    expect(cc.modelInput).toBe("free-text");
    expect(cc.effortMode).toBe("fixed");
    const oc = capabilitiesFor("opencode", { catalogRequiredForSend: false, modelInput: "free-text", effortMode: "fixed" });
    expect(oc.catalogRequiredForSend).toBe(true);
    expect(oc.modelInput).toBe("live-catalog");
    expect(oc.effortMode).toBe("model-variant");
    expect(capabilitiesFor("claude-code", { catalogRequiredForSend: true }).catalogRequiredForSend).toBe(true);
    expect(capabilitiesFor("opencode", { branchRequiresPrompt: true, attachedSendRequiresNativeStopped: true })).toMatchObject({ branchRequiresPrompt: true, attachedSendRequiresNativeStopped: true });
  });

  test("effort advertisements are copied, with fixed efforts bounded to native support", () => {
    const advertised = { effortValues: ["high", "invalid"] };
    const cc = capabilitiesFor("claude-code", advertised);
    expect(cc.effortValues).toEqual(["high"]);
    expect(capabilitiesFor("opencode", advertised).effortValues).toEqual(["high", "invalid"]);
    expect(capabilitiesFor("claude-code", { effortValues: [] }).effortValues).toEqual([]);
    expect(capabilitiesFor("claude-code", { effortValues: [false] } as unknown as Partial<HarnessCapabilities>).effortValues).toEqual([...FIXED_EFFORT_VALUES]);
    cc.effortValues!.push("mutated");
    expect(advertised.effortValues).toEqual(["high", "invalid"]);
    expect(FIXED_EFFORT_VALUES).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("legacy partial HarnessInfo mocks still accept mutable effort arrays", () => {
    const info: HarnessInfo = { id: "claude-code", available: true, connected: true, state: "available", capabilities: { cancelRun: true, effortValues: ["low"] } };
    info.capabilities.effortValues!.push("high");
    expect(info.capabilities.effortValues).toEqual(["low", "high"]);
  });
});
