import { describe, expect, test } from "bun:test";
import { FIXED_EFFORT_VALUES, getHarnessDescriptor, isHarness } from "../shared/conversation/harness-capabilities";
import { BASE_PROFILE_IDS, builtinProfiles, legacyProfileId, seedAgentProfiles } from "./agent-profiles-contract";
import { dispatchHarness } from "./harness-operations";
import { toNativeHarness } from "./harness-names";

const callbacks = () => {
  const calls: string[] = [];
  return {
    calls,
    arms: {
      "claude-code": () => { calls.push("claude-code"); return "cc"; },
      opencode: () => { calls.push("opencode"); return "oc"; },
      grok: () => { calls.push("grok"); return "gk"; },
    },
  };
};

describe("grok harness registry", () => {
  test("descriptor is Grok, not Claude Code or OpenCode", () => {
    const descriptor = getHarnessDescriptor("grok");
    expect(descriptor?.id).toBe("grok");
    expect(descriptor?.nativeHarness).toBe("gk");
    expect(descriptor?.label).toBe("Grok");
    expect(descriptor?.shortLabel).not.toBe("CC");
    expect(descriptor?.shortLabel).not.toBe("OC");
    expect(isHarness("grok")).toBe(true);
    expect(isHarness(undefined)).toBe(false);
    expect(isHarness("gemini")).toBe(false);
  });

  test("prompt and owned cancel are supported; history, compact, branch and recovery are not", () => {
    const operations = getHarnessDescriptor("grok")!.operations;
    expect(operations.prompt).toEqual({ supported: true });
    expect(operations.cancelOwnedRun.supported).toBe(true);
    for (const operation of ["readHistory", "compact", "branch", "recoverRun"] as const) {
      expect(operations[operation].supported).toBe(false);
      expect(operations[operation].reason).toEqual(expect.any(String));
      expect(operations[operation].reason).not.toMatch(/Claude/);
    }
    const policies = getHarnessDescriptor("grok")!.policies;
    expect(policies.modelInput).toBe("free-text");
    expect(policies.catalogRequiredForSend).toBe(false);
    expect(policies.effortMode).toBe("model-variant");
    expect(policies.effortValues).toEqual([]);
    expect(policies.effortValues).not.toBe(FIXED_EFFORT_VALUES);
    expect(policies.compactionInstructions).toBe(false);
    expect(policies.branchFromNativeMessage).toBe(false);
    expect(policies.branchAttachedConversation).toBe(false);
    expect(policies.branchRequiresPrompt).toBe(false);
    expect(policies.attachedSendRequiresNativeStopped).toBe(false);
  });

  test("dispatchHarness grok invokes only the grok callback", () => {
    const { calls, arms } = callbacks();
    expect(dispatchHarness("grok", arms)).toBe("gk");
    expect(calls).toEqual(["grok"]);
  });

  test("dispatchHarness claude-code does not invoke grok", () => {
    const { calls, arms } = callbacks();
    expect(dispatchHarness("claude-code", arms)).toBe("cc");
    expect(calls).toEqual(["claude-code"]);
    expect(calls).not.toContain("grok");
  });

  test("toNativeHarness refuses Grok and does not return cc", () => {
    let mapped: string | undefined;
    expect(() => { mapped = toNativeHarness("grok"); }).toThrow(TypeError);
    expect(() => toNativeHarness("grok")).toThrow("Grok is not a repository harness");
    expect(String((() => { try { return toNativeHarness("grok"); } catch (error) { return error; } })())).not.toMatch(/Claude/);
    expect(mapped).not.toBe("cc");
    expect(mapped).not.toBe("oc");
  });

  test("default profile stays base:cc and Grok base is base:gk", () => {
    expect(seedAgentProfiles("2026-10-27T00:00:00.000Z").defaultId).toBe("base:cc");
    expect(BASE_PROFILE_IDS["claude-code"]).toBe("base:cc");
    expect(BASE_PROFILE_IDS.opencode).toBe("base:oc");
    expect(BASE_PROFILE_IDS.grok).toBe("base:gk");
    const profiles = builtinProfiles("2026-10-27T00:00:00.000Z");
    const grok = profiles.find(profile => profile.id === "base:gk");
    expect(grok).toMatchObject({ harness: "grok", model: "", effort: "", label: "Base · Grok" });
    expect(grok?.label).not.toBe("Base · Claude Code");
    expect(profiles.find(profile => profile.id === "base:cc")?.label).toBe("Base · Claude Code");
    expect(profiles.find(profile => profile.id === "base:oc")?.label).toBe("Base · OpenCode");
    expect(profiles.find(profile => profile.harness === "claude-code" && profile.model === "grok-4.7")).toBeUndefined();
    expect(legacyProfileId("grok", undefined)).toBe("base:gk");
  });
});
