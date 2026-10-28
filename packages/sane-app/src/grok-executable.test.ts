import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppConfigError, explicitGrokExecutable, publishGrokConfig, publishGrokExecutable, resolveAppConfig, type AppConfig } from "./app-config";

const TEMP = "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot() {
  const root = realpathSync(mkdtempSync(join(TEMP, "grok-executable-")));
  roots.push(root);
  return root;
}
function context(root: string) {
  return { packageDir: root, invocationCwd: root, env: {}, home: root };
}
function save(root: string, name: string, value: unknown) {
  const configPath = join(root, name);
  const text = JSON.stringify(value);
  writeFileSync(configPath, text);
  return { configPath, text };
}
function claudeAndOpenCode() {
  return {
    claude: { executable: "grok", profileRoot: "/profiles/claude" },
    opencode: { mode: "managed" as const, registrationFile: "/state/opencode/service.json" },
  };
}
function refused(configPath: string, before: string, work: () => void) {
  let error: unknown;
  try { work(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(AppConfigError);
  expect(readFileSync(configPath, "utf8")).toBe(before);
  expect(readdirSync(join(configPath, "..")).some(name => String(name).includes(".tmp"))).toBe(false);
}
function withExecutable(config: AppConfig, executable?: string): AppConfig {
  return { ...config, native: { ...config.native, grok: executable === undefined ? { homeRoot: "/opt/grok/home" } : { homeRoot: "/opt/grok/home", executable } } };
}

describe("explicit grok executable", () => {
  test("resolving a v1 config does not rewrite it and leaves grok undefined", () => {
    const root = tempRoot();
    const { configPath, text } = save(root, "config.json", { format: "sane-app-config", version: 1 });
    const resolved = resolveAppConfig(["--config", configPath], context(root));
    expect(readFileSync(configPath, "utf8")).toBe(text);
    expect(resolved.config.version).toBe(1);
    expect(resolved.config.native.grok).toBeUndefined();
    expect(Object.hasOwn(resolved.config.native, "grok")).toBe(false);
    expect(explicitGrokExecutable(resolved.config)).toBeUndefined();
    expect(explicitGrokExecutable(resolved.config)).not.toBe("grok");
  });

  test("resolving a v2 home-only config does not rewrite it and explicitGrokExecutable is undefined", () => {
    const root = tempRoot();
    const homeRoot = join(root, "grok-home");
    writeFileSync(join(root, "grok"), "");
    const { configPath, text } = save(root, "config.json", { format: "sane-app-config", version: 2, native: { grok: { homeRoot } } });
    const resolved = resolveAppConfig(["--config", configPath], context(root));
    expect(readFileSync(configPath, "utf8")).toBe(text);
    expect(resolved.config.version).toBe(2);
    expect(resolved.config.native.grok).toEqual({ homeRoot });
    expect(Object.hasOwn(resolved.config.native.grok ?? {}, "executable")).toBe(false);
    expect(explicitGrokExecutable(resolved.config)).toBeUndefined();
    expect(explicitGrokExecutable(withExecutable(resolved.config, "grok"))).toBeUndefined();
    expect(explicitGrokExecutable(withExecutable(resolved.config, "bin/grok"))).toBeUndefined();
    expect(explicitGrokExecutable(withExecutable(resolved.config))).toBeUndefined();
    expect(resolved.config.native.grok?.executable).not.toBe(join(root, "grok"));
  });

  test("a relative executable and a bare grok executable are refused and not published", () => {
    const root = tempRoot();
    const homeRoot = "/opt/grok/home";
    const { configPath, text } = save(root, "config.json", {
      format: "sane-app-config", version: 2, native: { ...claudeAndOpenCode(), grok: { homeRoot } },
    });
    writeFileSync(join(root, "grok"), "");
    for (const executable of ["grok", "bin/grok", "./grok"]) {
      refused(configPath, text, () => publishGrokExecutable(configPath, executable));
    }
    refused(configPath, text, () => publishGrokExecutable(configPath, "/usr/bin/grok\0"));
    expect(readFileSync(configPath, "utf8")).toBe(text);
    expect(readFileSync(configPath, "utf8")).not.toContain(join(root, "grok"));

    const v1 = save(root, "v1.json", { format: "sane-app-config", version: 1, native: claudeAndOpenCode() });
    refused(v1.configPath, v1.text, () => publishGrokExecutable(v1.configPath, "/opt/grok/bin/grok"));
    const v1Grok = save(root, "v1-grok.json", { format: "sane-app-config", version: 1, native: { grok: { homeRoot } } });
    refused(v1Grok.configPath, v1Grok.text, () => resolveAppConfig(["--config", v1Grok.configPath], context(root)));

    const noHome = save(root, "no-home.json", { format: "sane-app-config", version: 2, native: claudeAndOpenCode() });
    refused(noHome.configPath, noHome.text, () => publishGrokExecutable(noHome.configPath, "/opt/grok/bin/grok"));

    for (const executable of ["grok", "bin/grok"]) {
      const saved = save(root, `bad-${executable.replaceAll("/", "_")}.json`, {
        format: "sane-app-config", version: 2, native: { grok: { homeRoot, executable } },
      });
      refused(saved.configPath, saved.text, () => resolveAppConfig(["--config", saved.configPath], context(root)));
    }
  });

  test("publishGrokExecutable writes version 2, keeps homeRoot, and does not change claude or opencode fields", () => {
    const root = tempRoot();
    const homeRoot = "/opt/grok/home";
    const executable = "/opt/grok/bin/grok";
    const before = {
      format: "sane-app-config", version: 2, dataDir: "/data",
      native: { ...claudeAndOpenCode(), grok: { homeRoot } },
    };
    const { configPath } = save(root, "config.json", before);
    publishGrokExecutable(configPath, executable);
    const after = JSON.parse(readFileSync(configPath, "utf8"));
    expect(after.version).toBe(2);
    expect(after.format).toBe("sane-app-config");
    expect(after.dataDir).toBe("/data");
    expect(after.native.grok).toEqual({ homeRoot, executable });
    expect(after.native.claude).toEqual(before.native.claude);
    expect(after.native.opencode).toEqual(before.native.opencode);
    expect(JSON.stringify(after.native.claude)).toBe(JSON.stringify(before.native.claude));
    expect(JSON.stringify(after.native.opencode)).toBe(JSON.stringify(before.native.opencode));
    expect(after.native.claude.executable).toBe("grok");
    expect(explicitGrokExecutable(after as AppConfig)).toBe(executable);
    expect(readdirSync(root).some(name => name.includes(".tmp"))).toBe(false);
  });

  test("publishGrokConfig does not add an executable and does not remove an existing one", () => {
    const root = tempRoot();
    const native = claudeAndOpenCode();
    const homeOnly = save(root, "home.json", {
      format: "sane-app-config", version: 2, dataDir: "/data", native: { ...native, grok: { homeRoot: "/opt/grok/old-home" } },
    });
    publishGrokConfig(homeOnly.configPath, "/opt/grok/new-home");
    const added = JSON.parse(readFileSync(homeOnly.configPath, "utf8"));
    expect(added.version).toBe(2);
    expect(added.native.grok).toEqual({ homeRoot: "/opt/grok/new-home" });
    expect(Object.hasOwn(added.native.grok, "executable")).toBe(false);
    expect(added.native.claude).toEqual(native.claude);
    expect(added.native.opencode).toEqual(native.opencode);

    const fromV1 = save(root, "v1.json", { format: "sane-app-config", version: 1, native });
    publishGrokConfig(fromV1.configPath, "/opt/grok/from-v1");
    const upgraded = JSON.parse(readFileSync(fromV1.configPath, "utf8"));
    expect(upgraded.version).toBe(2);
    expect(upgraded.native.grok).toEqual({ homeRoot: "/opt/grok/from-v1" });
    expect(Object.hasOwn(upgraded.native.grok, "executable")).toBe(false);
    expect(upgraded.native.claude).toEqual(native.claude);
    expect(upgraded.native.opencode).toEqual(native.opencode);

    const executable = "/opt/grok/bin/grok";
    const keptNative = { ...native, grok: { homeRoot: "/opt/grok/old-home", executable } };
    const keptFile = save(root, "kept.json", { format: "sane-app-config", version: 2, native: keptNative });
    publishGrokConfig(keptFile.configPath, "/opt/grok/moved-home");
    const kept = JSON.parse(readFileSync(keptFile.configPath, "utf8"));
    expect(kept.version).toBe(2);
    expect(kept.native.grok).toEqual({ homeRoot: "/opt/grok/moved-home", executable });
    expect(kept.native.claude).toEqual(keptNative.claude);
    expect(kept.native.opencode).toEqual(keptNative.opencode);
    expect(JSON.stringify(kept.native.claude)).toBe(JSON.stringify(keptNative.claude));
    expect(JSON.stringify(kept.native.opencode)).toBe(JSON.stringify(keptNative.opencode));
  });

  test("resolve never calls a publisher and never rewrites the file", () => {
    const source = readFileSync(fileURLToPath(new URL("./app-config.ts", import.meta.url)), "utf8");
    const start = source.indexOf("export function resolveAppConfig");
    const end = source.indexOf("export function sourceCapability");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    expect(body).not.toContain("publishGrokConfig");
    expect(body).not.toContain("publishGrokExecutable");
    expect(body).not.toContain("lookPath");
    expect(body).not.toContain("resolve(base, grokExecutable)");
    expect(body).not.toContain("resolve(base, gk.executable)");

    const root = tempRoot();
    const v1 = save(root, "v1.json", { format: "sane-app-config", version: 1 });
    const home = save(root, "home.json", { format: "sane-app-config", version: 2, native: { grok: { homeRoot: "/opt/grok/home" } } });
    const executable = "/opt/grok/bin/grok";
    const absolute = save(root, "absolute.json", {
      format: "sane-app-config", version: 2,
      native: { ...claudeAndOpenCode(), grok: { homeRoot: "/opt/grok/home", executable } },
    });
    const before = readdirSync(root).sort();

    const resolvedV1 = resolveAppConfig(["--config", v1.configPath], context(root));
    const resolvedHome = resolveAppConfig(["--config", home.configPath], context(root));
    const resolvedAbsolute = resolveAppConfig(["--config", absolute.configPath], context(root));
    expect(readFileSync(v1.configPath, "utf8")).toBe(v1.text);
    expect(readFileSync(home.configPath, "utf8")).toBe(home.text);
    expect(readFileSync(absolute.configPath, "utf8")).toBe(absolute.text);
    expect(readdirSync(root).sort()).toEqual(before);
    expect(resolvedV1.config.native.grok).toBeUndefined();
    expect(explicitGrokExecutable(resolvedHome.config)).toBeUndefined();
    expect(resolvedAbsolute.config.native.grok).toEqual({ homeRoot: "/opt/grok/home", executable });
    expect(explicitGrokExecutable(resolvedAbsolute.config)).toBe(executable);
    expect(explicitGrokExecutable(resolvedAbsolute.config)).not.toBe("grok");
  });
});
