import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { installSaneAgentContextPackages, proveInstalledExplicitWorkerRuntime, type SelectedNativeRuntime } from "../../sane-cli/src/install-sane-agent-context-packages";
import { resolveAppConfig } from "./app-config";
import { OpenCodeAdapter } from "./opencode";

const roots: string[] = [], originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; for (const root of roots.splice(0)) rmSync(root, { recursive: true }); });
async function fixture() {
  const root = realpathSync(mkdtempSync("/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/preview-runtime-test-")); roots.push(root);
  const selected: SelectedNativeRuntime = { pluginDirectory: join(root, ".config/opencode/plugins/sane"),
    openCodeConfigFile: join(root, ".config/opencode/opencode.json"), claudeMcpConfigFile: join(root, ".claude.json"),
    bindingRoot: join(root, "bindings"), registrationFile: join(root, ".local/state/opencode/service.json"), appConnectionFile: join(root, "app/native-handoff.json") };
  await installSaneAgentContextPackages({ homeDirectory: root, sourceRoot: resolve(import.meta.dir, "../../.."), runtimeOnly: true,
    bindingRoot: selected.bindingRoot, registrationFile: selected.registrationFile, appConnectionFile: selected.appConnectionFile, bunExecutable: process.execPath, write: () => {} });
  return { root, selected, profile: join(root, ".claude"), change: (path: string, update: (value: any) => void) => {
    const value = JSON.parse(readFileSync(path, "utf8")); update(value); writeFileSync(path, JSON.stringify(value));
  } };
}
for (const harness of ["cc", "oc"] as const) test(`${harness}: explicitly selected installed runtime qualifies without consulting the real home`, async () => {
  const f = await fixture();
  expect(await proveInstalledExplicitWorkerRuntime(f.profile, harness, f.selected)).toEqual(["sane_worker_complete", "sane_worker_notify", "sane_worker_message_parent", "sane_worker_message"]);
});
for (const damage of ["missing-config", "wrong-app", "wrong-registration", "duplicate-plugin", "unconfigured-plugin", "missing-runtime"] as const) test(`OC ${damage} refuses instead of using the global runtime`, async () => {
  const f = await fixture();
  if (damage === "missing-config") unlinkSync(f.selected.openCodeConfigFile);
  if (damage === "missing-runtime") unlinkSync(join(f.selected.pluginDirectory, "index.ts"));
  if (damage === "wrong-app") f.change(f.selected.openCodeConfigFile, c => { c.plugins[0].options.appConnectionFile = "/regular/native-handoff.json"; });
  if (damage === "wrong-registration") f.change(f.selected.openCodeConfigFile, c => { c.plugins[0].options.registrationFile = "/regular/service.json"; });
  if (damage === "duplicate-plugin") f.change(f.selected.openCodeConfigFile, c => { c.plugins.push(c.plugins[0]); });
  if (damage === "unconfigured-plugin") f.change(f.selected.openCodeConfigFile, c => { c.plugins = [f.selected.pluginDirectory]; });
  expect(await proveInstalledExplicitWorkerRuntime(f.profile, "oc", f.selected)).toBeUndefined();
});
for (const damage of ["missing-config", "wrong-app", "wrong-profile", "wrong-binding", "wrong-hook-binding"] as const) test(`CC ${damage} refuses without a global MCP fallback`, async () => {
  const f = await fixture();
  if (damage === "missing-config") unlinkSync(f.selected.claudeMcpConfigFile);
  if (damage === "wrong-app") f.change(f.selected.claudeMcpConfigFile, c => { c.mcpServers.sane.args[3] = "/regular/native-handoff.json"; });
  if (damage === "wrong-profile") f.change(f.selected.claudeMcpConfigFile, c => { c.mcpServers.sane.args[1] = "/regular/.claude"; });
  if (damage === "wrong-binding") f.change(f.selected.claudeMcpConfigFile, c => { c.mcpServers.sane.args[2] = "/regular/bindings"; });
  if (damage === "wrong-hook-binding") f.change(join(f.profile, "settings.json"), c => { c.hooks.PreToolUse[0].hooks[0].command += " '/wrong/binding'"; });
  expect(await proveInstalledExplicitWorkerRuntime(f.profile, "cc", f.selected)).toBeUndefined();
});
test("saved deployment paths resolve relative to the selected App config, and survive resolution", async () => {
  const f = await fixture(), path = join(f.root, "app.json");
  writeFileSync(path, JSON.stringify({ format: "sane-app-config", version: 1, nativeRuntime: {
    pluginDirectory: ".config/opencode/plugins/sane", openCodeConfigFile: ".config/opencode/opencode.json", claudeMcpConfigFile: ".claude.json", bindingRoot: "bindings",
  } }));
  const result = resolveAppConfig(["--config", path], { packageDir: f.root, invocationCwd: f.root, env: {}, home: f.root });
  const { registrationFile: _registration, appConnectionFile: _connection, ...expected } = f.selected;
  expect(result.config.nativeRuntime).toEqual(expected);
  f.change(path, c => { delete c.nativeRuntime.bindingRoot; });
  expect(() => resolveAppConfig(["--config", path], { packageDir: f.root, invocationCwd: f.root, env: {}, home: f.root })).toThrow("nativeRuntime.bindingRoot");
});
for (const damage of ["none", "plugin", "registration", "app", "location", "tools"] as const) test(`loaded OC service proof: ${damage}`, async () => {
  const f = await fixture(), directory = "/offline/test-repo";
  const adapter = new OpenCodeAdapter(undefined, undefined, f.selected.registrationFile);
  Object.defineProperty(adapter, "endpoint", { value: async () => ({ base: "http://offline.invalid", headers: {} }) });
  const output = { schema: 1, directory, pluginDirectory: f.selected.pluginDirectory, registrationFile: f.selected.registrationFile,
    appConnectionFile: f.selected.appConnectionFile, tools: ["complete", "notify", "message_parent", "message"].map(op => `sane_worker_${op}`) };
  if (damage === "plugin") output.pluginDirectory = "/regular/plugin";
  if (damage === "registration") output.registrationFile = "/regular/service.json";
  if (damage === "app") output.appConnectionFile = "/regular/native-handoff.json";
  if (damage === "location") output.directory = "/another/repo";
  if (damage === "tools") output.tools.pop();
  let calls = 0;
  globalThis.fetch = Object.assign(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls++; expect(new URL(String(url)).pathname).toBe("/api/rpc/sane-execution/runtime");
    expect(JSON.parse(init!.body as string)).toEqual({ input: {} });
    return Response.json({ output });
  }, { preconnect: originalFetch.preconnect });
  if (damage === "none") await adapter.assertSelectedWorkerRuntime(directory, f.selected);
  else await expect(adapter.assertSelectedWorkerRuntime(directory, f.selected)).rejects.toThrow("differs");
  expect(calls).toBe(1);
});
test("another service registration refuses before even looking up an endpoint", async () => {
  const f = await fixture(), adapter = new OpenCodeAdapter(undefined, undefined, "/regular/service.json");
  Object.defineProperty(adapter, "endpoint", { value: async () => { throw new Error("Must not inspect regular service"); } });
  await expect(adapter.assertSelectedWorkerRuntime("/offline/repo", f.selected)).rejects.toThrow("another managed source");
});
