import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runSetup } from "../setup";
import { resolveAppConfig } from "./app-config";
import { loadAgentProfiles, validateAppStore } from "./app-store";
import { seedAgentProfiles } from "./agent-profiles-contract";
import { acquireData, acquireInstallation, validateOwnershipPaths } from "./installation-ownership";

const TEMP = "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(TEMP, "grok-setup-"))); roots.push(root);
  const pkg = join(root, "package"), cc = join(root, "cc"), home = join(root, "grok-home"), data = join(root, "data");
  for (const dir of [pkg, cc, home]) mkdirSync(dir);
  const config = join(root, "config.json"); // Deliberately outside the selected package.
  const baseArgs = ["--config", config, "--cwd", root, "--data-dir", data, "--claude-profile", cc, "--opencode-registration", join(root, "oc.json")];
  const grokArgs = ["--grok-home", home, "--grok-bin", "/explicit/bin/grok", "--grok-model", "explicit-model", "--grok-effort", "explicit-effort"];
  return { root, pkg, cc, home, data, config, baseArgs, grokArgs };
}
function json(file: string) { return JSON.parse(readFileSync(file, "utf8")); }
function storeBytes(data: string) { return Object.fromEntries(readdirSync(data).sort().map(file => [file, readFileSync(join(data, file), "utf8")])); }
function addAdmission(f: ReturnType<typeof fixture>) {
  const source = json(join(f.data, "sources.json")).gk;
  writeFileSync(join(f.data, "admissions.json"), JSON.stringify({ version: 2, admissions: [{
    version: 1, requestId: crypto.randomUUID(), sessionId: crypto.randomUUID(), operation: "create", state: "identity_known",
    source, nativeId: crypto.randomUUID(), parent: null, error: null, createdAt: new Date().toISOString(),
    binding: { workspaceId: crypto.randomUUID(), worktreeId: crypto.randomUUID(), bindingRevision: crypto.randomUUID(), executionCheckout: f.root, checkoutPin: null, domain: { mode: "app-only" } },
  }] }));
}

describe("explicit Grok setup", () => {
  test("fresh setup publishes config v2, source v2 and a selectable base:gk without changing default", () => {
    const f = fixture();
    runSetup([...f.baseArgs, ...f.grokArgs], f.pkg);
    const config = json(f.config), sources = json(join(f.data, "sources.json")), profiles = json(join(f.data, "agents.json"));
    expect(config.version).toBe(2);
    expect(config.native.grok).toEqual({ homeRoot: f.home, executable: "/explicit/bin/grok", model: "explicit-model", effort: "explicit-effort" });
    expect(sources.version).toBe(2);
    expect(sources.gk.descriptor).toEqual({ version: 1, harness: "gk", kind: "local-home", homeRoot: f.home });
    expect(Object.keys(sources.gk.descriptor).sort()).toEqual(["harness", "homeRoot", "kind", "version"]);
    expect(profiles.defaultId).toBe("base:cc");
    expect(profiles.profiles.find((p: any) => p.id === "base:gk")).toMatchObject({ hidden: false, model: "explicit-model", effort: "explicit-effort", harness: "grok" });
    expect(() => validateAppStore(f.data)).not.toThrow();
    expect(readdirSync(f.home)).toEqual([]); // No credentials or native files were created.
  });

  test("existing v1 setup adds Grok only, preserving raw unrelated config, pins and customized profiles", () => {
    const f = fixture(); runSetup(f.baseArgs, f.pkg);
    const config = json(f.config); config.maxConcurrentRuns = 7; config.maxWorkersPerCheckout = 3; config.agentModelConfig = "relative-models.json";
    config.nativeRuntime = { pluginDirectory: "plugin", openCodeConfigFile: "oc-config", claudeMcpConfigFile: "cc-mcp", bindingRoot: "bindings" };
    writeFileSync(f.config, JSON.stringify(config));
    const profiles = seedAgentProfiles(); profiles.profiles = profiles.profiles.filter(p => p.id !== "base:gk");
    profiles.profiles.find(p => p.id === "base:oc")!.label = "My OpenCode";
    writeFileSync(join(f.data, "agents.json"), JSON.stringify(profiles));
    const pins = json(join(f.data, "sources.json"));
    runSetup(["--config", f.config, ...f.grokArgs], f.pkg);
    const { version, native, ...rest } = json(f.config), { version: oldVersion, native: oldNative, ...oldRest } = config;
    expect(rest).toEqual(oldRest); expect(version).toBe(2);
    expect(native.claude).toEqual(oldNative.claude); expect(native.opencode).toEqual(oldNative.opencode);
    const afterProfiles = json(join(f.data, "agents.json"));
    expect(afterProfiles.defaultId).toBe(profiles.defaultId);
    expect(afterProfiles.profiles.filter((p: any) => p.id !== "base:gk")).toEqual(profiles.profiles);
    const afterPins = json(join(f.data, "sources.json"));
    expect(afterPins.cc).toEqual(pins.cc); expect(afterPins.oc).toEqual(pins.oc);
  });

  test("partial explicit updates reuse saved choices and leave an admitted same source pin untouched", () => {
    const f = fixture(); runSetup([...f.baseArgs, ...f.grokArgs], f.pkg); addAdmission(f);
    const pinFile = join(f.data, "sources.json"), pinBytes = readFileSync(pinFile, "utf8"), inode = statSync(pinFile).ino;
    runSetup(["--config", f.config, "--grok-model", "new-model"], f.pkg);
    expect(json(f.config).native.grok).toEqual({ homeRoot: f.home, executable: "/explicit/bin/grok", model: "new-model", effort: "explicit-effort" });
    expect(json(join(f.data, "agents.json")).profiles.find((p: any) => p.id === "base:gk").model).toBe("new-model");
    expect(readFileSync(pinFile, "utf8")).toBe(pinBytes); expect(statSync(pinFile).ino).toBe(inode);
  });

  test("refused repin changes neither config nor profiles nor any store record", () => {
    const f = fixture(); runSetup([...f.baseArgs, ...f.grokArgs], f.pkg); addAdmission(f);
    const other = join(f.root, "other-home"); mkdirSync(other);
    const config = readFileSync(f.config, "utf8"), before = storeBytes(f.data);
    expect(() => runSetup(["--config", f.config, "--grok-home", other, "--grok-model", "new-model"], f.pkg)).toThrow("original pin cannot be replaced");
    expect(readFileSync(f.config, "utf8")).toBe(config); expect(storeBytes(f.data)).toEqual(before);
  });

  test("explicit Grok settings do not weaken conflicting saved App settings refusal", () => {
    const f = fixture(); runSetup(f.baseArgs, f.pkg);
    const config = readFileSync(f.config, "utf8"), before = storeBytes(f.data);
    expect(() => runSetup(["--config", f.config, "--port", "9876", ...f.grokArgs], f.pkg)).toThrow("will not overwrite saved settings");
    expect(readFileSync(f.config, "utf8")).toBe(config); expect(storeBytes(f.data)).toEqual(before);
  });

  test("all incoming choices and profile inputs are validated before publishing", () => {
    const f = fixture(); runSetup(f.baseArgs, f.pkg);
    const config = readFileSync(f.config, "utf8"), before = storeBytes(f.data);
    for (const flags of [
      ["--grok-home", f.home],
      [...f.grokArgs.slice(0, 2), "--grok-bin", "grok", ...f.grokArgs.slice(4)],
      [...f.grokArgs.slice(0, 4), "--grok-model", "invalid\nmodel", ...f.grokArgs.slice(6)],
      [...f.grokArgs, "--grok-model", "duplicate"],
      [...f.grokArgs.slice(0, 6), "--grok-effort", "\n"],
      ["--grok-home", ""],
    ]) {
      expect(() => runSetup(["--config", f.config, ...flags], f.pkg)).toThrow();
      expect(readFileSync(f.config, "utf8")).toBe(config); expect(storeBytes(f.data)).toEqual(before);
    }
    writeFileSync(join(f.data, "agents.json"), "{}");
    expect(() => runSetup(["--config", f.config, ...f.grokArgs], f.pkg)).toThrow();
    expect(readFileSync(f.config, "utf8")).toBe(config);
    expect(json(join(f.data, "sources.json")).version).toBe(1);
    expect(readFileSync(join(f.data, "agents.json"), "utf8")).toBe("{}");
  });

  test("no-Grok setup and normal startup readers never publish or migrate Grok", () => {
    const f = fixture(); runSetup(f.baseArgs, f.pkg);
    expect(existsSync(join(f.data, "agents.json"))).toBe(false);
    const profiles = seedAgentProfiles(); profiles.profiles = profiles.profiles.filter(p => p.id !== "base:gk");
    writeFileSync(join(f.data, "agents.json"), JSON.stringify(profiles));
    const config = readFileSync(f.config, "utf8"), before = storeBytes(f.data);
    runSetup(["--config", f.config], f.pkg);
    const resolved = resolveAppConfig(["--config", f.config], { packageDir: f.pkg, invocationCwd: f.root, env: {}, home: f.root });
    expect(resolved.config.native.grok).toBeUndefined();
    validateAppStore(f.data); loadAgentProfiles(f.data);
    expect(readFileSync(f.config, "utf8")).toBe(config); expect(storeBytes(f.data)).toEqual(before);
    expect(() => resolveAppConfig(["--config", f.config, ...f.grokArgs], { packageDir: f.pkg, invocationCwd: f.root, env: {} })).toThrow("Unknown App option");
  });

  test("Grok-configured startup readers do not re-expose or rewrite an existing profile", () => {
    const f = fixture(); runSetup([...f.baseArgs, ...f.grokArgs], f.pkg);
    const profiles = json(join(f.data, "agents.json")); profiles.profiles.find((p: any) => p.id === "base:gk").hidden = true;
    writeFileSync(join(f.data, "agents.json"), JSON.stringify(profiles));
    const before = storeBytes(f.data), config = readFileSync(f.config, "utf8");
    resolveAppConfig(["--config", f.config], { packageDir: f.pkg, invocationCwd: f.root, env: {} });
    validateAppStore(f.data); loadAgentProfiles(f.data);
    expect(readFileSync(f.config, "utf8")).toBe(config); expect(storeBytes(f.data)).toEqual(before);
  });

  test("active installation or shared-data ownership blocks every publication", () => {
    const f = fixture(); runSetup(f.baseArgs, f.pkg);
    const config = readFileSync(f.config, "utf8"), before = storeBytes(f.data);
    const installation = acquireInstallation(validateOwnershipPaths(f.pkg, f.data), { phase: "serving" });
    try { expect(() => runSetup(["--config", f.config, ...f.grokArgs], f.pkg)).toThrow("Live installation owner"); }
    finally { installation.release(); }
    const otherPkg = join(f.root, "other-package"); mkdirSync(otherPkg);
    const other = acquireInstallation(validateOwnershipPaths(otherPkg, f.data), { phase: "serving" });
    const data = acquireData(other, { phase: "serving" });
    try { expect(() => runSetup(["--config", f.config, ...f.grokArgs], f.pkg)).toThrow("Live data owner"); }
    finally { data.release(); other.release(); }
    expect(readFileSync(f.config, "utf8")).toBe(config); expect(storeBytes(f.data)).toEqual(before);
  });
});
