import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { FIXED_EFFORT_VALUES, getHarnessDescriptor, isHarness } from "../shared/conversation/harness-capabilities";
import { BASE_PROFILE_IDS, builtinProfiles, legacyProfileId, seedAgentProfiles } from "./agent-profiles-contract";
import { atomicAppRecord, loadAgentProfiles } from "./app-store";
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

  test("prompt and owned cancel are unsupported until the bridge can perform them; every other Grok operation stays unsupported", () => {
    const operations = getHarnessDescriptor("grok")!.operations;
    expect(operations.prompt).toEqual({ supported: false, reason: "The bridge cannot perform Grok prompts yet" });
    expect(operations.cancelOwnedRun).toEqual({ supported: false, reason: "The bridge cannot perform Grok Stop yet" });
    expect(operations.prompt.reason).not.toMatch(/Claude/);
    expect(operations.cancelOwnedRun.reason).not.toMatch(/Claude/);
    for (const operation of Object.keys(operations) as (keyof typeof operations)[]) {
      expect(operations[operation].supported).toBe(false);
      expect(operations[operation].reason).toEqual(expect.any(String));
      expect(operations[operation].reason).not.toMatch(/Claude/);
    }
    expect(getHarnessDescriptor("claude-code")!.operations.prompt).toEqual({ supported: true });
    expect(getHarnessDescriptor("claude-code")!.operations.cancelOwnedRun).toEqual({ supported: true });
    expect(getHarnessDescriptor("opencode")!.operations.prompt).toEqual({ supported: true });
    expect(getHarnessDescriptor("opencode")!.operations.cancelOwnedRun).toEqual({ supported: true });
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
    expect(grok).toMatchObject({ harness: "grok", model: "", effort: "", label: "Base · Grok", hidden: true });
    expect(grok?.label).not.toBe("Base · Claude Code");
    expect(seedAgentProfiles("2026-10-27T00:00:00.000Z").profiles.find(profile => profile.id === "base:gk")?.hidden).toBe(true);
    expect(profiles.find(profile => profile.id === "base:cc")?.label).toBe("Base · Claude Code");
    expect(profiles.find(profile => profile.id === "base:cc")?.hidden).toBeUndefined();
    expect(profiles.find(profile => profile.id === "base:oc")?.label).toBe("Base · OpenCode");
    expect(profiles.find(profile => profile.id === "base:oc")?.hidden).toBeUndefined();
    expect(profiles.find(profile => profile.harness === "claude-code" && profile.model === "grok-4.7")).toBeUndefined();
    expect(legacyProfileId("grok", undefined)).toBe("base:gk");
  });

  test("existing agents.json is not rewritten to add or hide base:gk; other missing builtins still merge", () => {
    const root = realpathSync(mkdtempSync("/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/grok-profiles-"));
    const read = () => readFileSync(join(root, "agents.json"), "utf8");
    try {
      const withoutGrok = seedAgentProfiles("2026-10-27T00:00:00.000Z");
      withoutGrok.profiles = withoutGrok.profiles.filter(profile => profile.id !== "base:gk");
      atomicAppRecord(root, "agents.json", withoutGrok);
      const before = read();
      const loaded = loadAgentProfiles(root);
      expect(read()).toBe(before);
      expect(loaded.defaultId).toBe("base:cc");
      expect(loaded.profiles.some(profile => profile.id === "base:gk")).toBe(false);
      expect(loaded.profiles.some(profile => profile.id === "base:cc")).toBe(true);
      expect(loaded.profiles.some(profile => profile.id === "base:oc")).toBe(true);

      const visible = seedAgentProfiles("2026-10-27T00:00:00.000Z");
      const row = visible.profiles.find(profile => profile.id === "base:gk")!;
      delete row.hidden;
      atomicAppRecord(root, "agents.json", visible);
      const visibleBefore = read();
      const kept = loadAgentProfiles(root);
      expect(read()).toBe(visibleBefore);
      expect(kept.profiles.find(profile => profile.id === "base:gk")?.hidden).toBeUndefined();
      expect(kept.profiles.find(profile => profile.id === "base:cc")?.label).toBe("Base · Claude Code");
      expect(kept.profiles.find(profile => profile.id === "base:oc")?.label).toBe("Base · OpenCode");

      const missingOpenCode = seedAgentProfiles("2026-10-27T00:00:00.000Z");
      missingOpenCode.profiles = missingOpenCode.profiles.filter(profile => profile.id !== "base:gk" && profile.id !== "base:oc");
      atomicAppRecord(root, "agents.json", missingOpenCode);
      const merged = loadAgentProfiles(root);
      const written = JSON.parse(read());
      expect(merged.profiles.some(profile => profile.id === "base:oc")).toBe(true);
      expect(merged.profiles.some(profile => profile.id === "base:gk")).toBe(false);
      expect(written.profiles.some((profile: { id: string }) => profile.id === "base:oc")).toBe(true);
      expect(written.profiles.some((profile: { id: string }) => profile.id === "base:gk")).toBe(false);
      expect(written.defaultId).toBe("base:cc");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
