import { afterEach, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveAppConfig, parseConfigJson } from "../src/app-config";
import { acquireInstallation, acquireData, validateOwnershipPaths, processEvidence } from "../src/installation-ownership";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sane-startup-primitives-"))); roots.push(root);
  const pkg = join(root, "package"), cwd = join(root, "invocation"), home = join(root, "home");
  for (const path of [pkg, cwd, home]) mkdirSync(path);
  return { root, pkg, cwd, home, context: { packageDir: pkg, invocationCwd: cwd, home, env: {} } };
}
const config = (extra = {}) => ({ format: "sane-app-config", version: 1, ...extra });
test("package default, selected config and CLI paths have separate bases; resolution is noncreating", () => {
  const f = fixture(); writeFileSync(join(f.pkg, ".config.json"), JSON.stringify(config({ dataDir: "saved", defaultExecutionCwd: "checkout", native: { claude: { executable: "./bin/claude" } } })));
  const saved = resolveAppConfig([], f.context);
  expect(saved.config.dataDir).toBe(join(f.pkg, "saved"));
  expect(saved.config.defaultExecutionCwd).toBe(join(f.pkg, "checkout"));
  expect(saved.config.native.claude.executable).toBe(join(f.pkg, "bin/claude"));
  expect(saved.sources.claude.state).toBe("unavailable"); expect(saved.sources.claude.authority).toBeUndefined();
  expect(existsSync(join(f.home, ".claude"))).toBe(false);
  writeFileSync(join(f.cwd, "chosen.json"), JSON.stringify(config({ dataDir: "chosen" })));
  const selected = resolveAppConfig(["--config", "chosen.json", "--cwd", "project", "--data-dir", "override"], f.context);
  expect(selected.configPath).toBe(join(f.cwd, "chosen.json")); expect(selected.config.dataDir).toBe(join(f.cwd, "override"));
  expect(selected.config.defaultExecutionCwd).toBe(join(f.cwd, "project"));
  expect(readdirSync(f.pkg)).toEqual([".config.json"]);
});
test("strict JSON shape/version and duplicate keys including escapes", () => {
  expect(() => parseConfigJson('{"version":1,"vers\\u0069on":1}')).toThrow("Duplicate");
  for (const raw of [config({ version: 2 }), config({ password: "secret" }), config({ native: { opencode: { mode: "endpoint" } } }), config({ server: { port: "8787" } }), config({ native: { claude: { token: "secret" } } })]) {
    const f = fixture(); writeFileSync(join(f.pkg, ".config.json"), JSON.stringify(raw));
    expect(() => resolveAppConfig([], f.context)).toThrow();
  }
  for (const malformed of ['{"a":}', '{"a":1,}', '[1,]', 'null', '{} garbage']) expect(() => parseConfigJson(malformed)).toThrow();
});
test("negative/clear flags override saved options; operational switches never enter config", () => {
  const f = fixture(); writeFileSync(join(f.pkg, ".config.json"), JSON.stringify(config({ server: { allowRemote: true, publicOrigin: "https://example.test" } })));
  const result = resolveAppConfig(["--no-allow-remote", "--clear-public-origin", "--no-build", "--reconcile-interrupted"], f.context);
  expect(result.config.server.allowRemote).toBe(false); expect(result.config.server.publicOrigin).toBeNull();
  expect(result.operational.noBuild).toBe(true); expect(JSON.stringify(result.config)).not.toContain("reconcile");
  for (const args of [["--port", "1", "--port", "2"], ["--allow-remote", "--no-allow-remote"], ["--public-origin", "https://x.test", "--clear-public-origin"], ["--opencode-url", "secret"], ["--port"], ["--port", "NaN"]]) expect(() => resolveAppConfig(args, f.context)).toThrow();
});
test("native absence is capability; shared canonical namespaces and symlink errors", () => {
  const f = fixture(), profile = join(f.home, "profile"), registration = join(f.home, "service.json"); mkdirSync(profile);
  const args = ["--claude-profile", profile, "--opencode-registration", registration];
  const a = resolveAppConfig(args, f.context);
  expect(a.sources.claude.state).toBe("available"); expect(a.sources.claude.authority?.authorityId).toMatch(/^sane-native-v1:cc:/);
  expect(a.sources.opencode.state).toBe("unavailable"); expect(a.sources.opencode.authority?.authorityId).toMatch(/^sane-native-v1:oc:/);
  writeFileSync(registration, "not read or health-probed");
  expect(resolveAppConfig(args, f.context).sources.opencode.authority).toEqual(a.sources.opencode.authority);
  const alias = join(f.home, "alias"); symlinkSync(profile, alias);
  expect(() => resolveAppConfig(["--claude-profile", alias], f.context)).toThrow();
});
test("environment contradictions redact values; proxied remote origin requires password", () => {
  const f = fixture(); const secret = "do-not-print-this";
  try { resolveAppConfig([], { ...f.context, env: { OPENCODE_URL: secret } }); throw new Error("Expected refusal"); }
  catch (e) { expect((e as Error).message).toContain("OPENCODE_URL"); expect((e as Error).message).not.toContain(secret); }
  expect(() => resolveAppConfig(["--public-origin", "https://example.test"], f.context)).toThrow("SANE_APP_PASSWORD");
  const result = resolveAppConfig(["--public-origin", "https://example.test"], { ...f.context, env: { SANE_APP_PASSWORD: secret } });
  expect(JSON.stringify(result)).not.toContain(secret);
});
test("validation is pure, installation excludes another data path, release and lifecycle evidence", () => {
  const f = fixture(), data = join(f.root, "missing-parent", "data");
  const paths = validateOwnershipPaths(f.pkg, data); expect(readdirSync(f.pkg)).toEqual([]); expect(existsSync(data)).toBe(false);
  const owner = acquireInstallation(paths, { phase: "setup" });
  expect(() => acquireInstallation(validateOwnershipPaths(f.pkg, join(f.root, "other")), { phase: "build" })).toThrow("Live installation");
  const dataOwner = acquireData(owner, { phase: "setup", createDataParent: true });
  expect(existsSync(data)).toBe(false); expect(dataOwner.lock).toBe(join(f.root, "missing-parent", ".data.sane-app.lock"));
  owner.update("serving", { host: "127.0.0.1", port: 8787 }); expect(owner.owner.listener?.port).toBe(8787);
  dataOwner.release(); owner.release(); owner.release(); expect(existsSync(paths.installationLock)).toBe(false);
});
test("cross-installation shared-data exclusion; retained owners survive cleanup", () => {
  const f = fixture(), other = join(f.root, "other-package"); mkdirSync(other);
  const data = join(f.root, "data"), a = acquireInstallation(validateOwnershipPaths(f.pkg, data), { phase: "starting" }), b = acquireInstallation(validateOwnershipPaths(other, data), { phase: "starting" });
  const d = acquireData(a, { phase: "starting" });
  expect(() => acquireData(b, { phase: "starting", reconcileInterrupted: true })).toThrow("Live data");
  d.retain(); d.release(); expect(existsSync(d.lock)).toBe(true); expect(d.owner.phase).toBe("retained");
  a.release(); b.release();
});
test("dead instance requires explicit gated token-checked reconciliation, malformed and abandoned gates block", () => {
  const f = fixture(), paths = validateOwnershipPaths(f.pkg);
  const owner = acquireInstallation(paths, { phase: "build" });
  // Model PID reuse without touching another process: current PID, provably different start.
  const record = { ...owner.owner, processStart: "prior process instance" };
  writeFileSync(join(owner.lock, "owner.json"), JSON.stringify(record));
  expect(() => acquireInstallation(paths, { phase: "build" })).toThrow("Stale");
  const replacement = acquireInstallation(paths, { phase: "build", reconcileInterrupted: true });
  expect(replacement.owner.token).not.toBe(owner.owner.token); expect(() => owner.release()).toThrow("Ownership no longer held");
  replacement.release();
  mkdirSync(paths.installationLock); writeFileSync(join(paths.installationLock, "owner.json"), "{}");
  expect(() => acquireInstallation(paths, { phase: "build", reconcileInterrupted: true })).toThrow("Malformed");
  mkdirSync(`${paths.installationLock}.reconcile-gate`);
  expect(() => acquireInstallation(paths, { phase: "build", reconcileInterrupted: true })).toThrow("gate");
});
test("state/runtime symlinks reject while canonical parent aliases share lock identity", () => {
  const f = fixture(), actual = join(f.root, "actual"), alias = join(f.root, "alias"); mkdirSync(actual); symlinkSync(actual, alias);
  expect(() => validateOwnershipPaths(f.pkg, alias)).toThrow("non-symlink");
  expect(validateOwnershipPaths(f.pkg, join(alias, "data")).dataLock).toBe(validateOwnershipPaths(f.pkg, join(actual, "data")).dataLock);
  symlinkSync(actual, join(f.pkg, ".runtime")); expect(() => validateOwnershipPaths(f.pkg)).toThrow("non-symlink");
  expect(processEvidence(process.pid).state).toBe("live");
});
