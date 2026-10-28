import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { DomainError, normalizeNativeSource } from "sane-core/server";
import type { GrokSourceDescriptor, NativeAuthority, NativeSourceDescriptor } from "sane-core/contracts";
import { DEFAULT_MAX_WORKERS_PER_CHECKOUT } from "./worker-contract";
import type { NativeRuntimeSelection } from "../../sane-cli/src/install-sane-agent-context-packages";

export class AppConfigError extends Error { readonly code = "INVALID_APP_CONFIG"; }
export type AppConfig = {
  format: "sane-app-config"; version: 1 | 2; dataDir: string; defaultExecutionCwd: string;
  server: { host: string; port: number; publicOrigin: string | null; allowRemote: boolean };
  maxConcurrentRuns: number;
  maxWorkersPerCheckout?: number;
  contextDelivery?: "startup" | "canonical";
  agentModelConfig?: string;
  nativeRuntime?: NativeRuntimeSelection;
  native: { claude: { executable: string; profileRoot: string }; opencode: { mode: "managed"; registrationFile: string }; grok?: { homeRoot: string; executable?: string } };
};
export type SourceCapability = { state: "available" | "unavailable"; locator: string; authority?: NativeAuthority };
const invalid = (message: string): never => { throw new AppConfigError(message); };
function object(value: unknown, keys: string[], label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`Expected ${label} object`);
  const obj = value as Record<string, any>;
  if (Object.keys(obj).some(k => !keys.includes(k))) invalid(`Unknown ${label} key`);
  return obj;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) invalid(`Invalid ${label}`);
  return value as string;
}
function integer(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) invalid(`Invalid ${label}`);
  return value as number;
}

/** JSON.parse alone silently accepts duplicate keys, including escaped spellings. */
export function parseConfigJson(input: string): Record<string, any> {
  let i = 0;
  const whitespace = () => { while (/\s/.test(input[i] ?? "") && i < input.length) i++; };
  const string = (): string => {
    const start = i++;
    while (i < input.length) { if (input[i] === "\\") { i += 2; continue; } if (input[i++] === '"') return JSON.parse(input.slice(start, i)); }
    return invalid("Malformed config JSON");
  };
  const value = (): void => {
    whitespace();
    if (input[i] === "{") {
      i++; whitespace(); const keys = new Set<string>();
      if (input[i] === "}") { i++; return; }
      while (i < input.length) {
        whitespace(); if (input[i] !== '"') invalid("Malformed config JSON");
        const key = string(); if (keys.has(key)) invalid("Duplicate config key"); keys.add(key);
        whitespace(); if (input[i++] !== ":") invalid("Malformed config JSON"); value(); whitespace();
        const end = input[i++]; if (end === "}") return; if (end !== ",") invalid("Malformed config JSON");
      }
    } else if (input[i] === "[") {
      i++; whitespace(); if (input[i] === "]") { i++; return; }
      while (i < input.length) { value(); whitespace(); const end = input[i++]; if (end === "]") return; if (end !== ",") invalid("Malformed config JSON"); }
    } else if (input[i] === '"') { string(); return; }
    else { const m = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(input.slice(i)); if (!m) invalid("Malformed config JSON"); i += m![0].length; return; }
    invalid("Malformed config JSON");
  };
   try { value(); whitespace(); if (i !== input.length) invalid("Malformed config JSON"); return object(JSON.parse(input), ["format", "version", "dataDir", "defaultExecutionCwd", "server", "maxConcurrentRuns", "maxWorkersPerCheckout", "native", "contextDelivery", "agentModelConfig", "nativeRuntime"], "config"); }
  catch (e) { if (e instanceof AppConfigError) throw e; return invalid("Malformed config JSON"); }
}

export type ConfigContext = { packageDir: string; invocationCwd: string; env?: NodeJS.ProcessEnv; home?: string; allowMissingConfig?: boolean };
/** Reads only the selected config and source path metadata; never creates or probes native services. */
export function resolveAppConfig(args: string[], context: ConfigContext) {
  const env = context.env ?? process.env, home = context.home ?? homedir();
  const invocation = resolve(context.invocationCwd), packageDir = resolve(context.packageDir);
  const flags = new Map<string, string | boolean | null>();
  const valued: Record<string, string> = { "--config": "config", "--cwd": "cwd", "--data-dir": "data", "--host": "host", "--port": "port", "--public-origin": "origin", "--claude-bin": "executable", "--claude-profile": "profile", "--opencode-registration": "registration", "--max-concurrent-runs": "concurrency", "--context-delivery": "contextDelivery" };
   const switches: Record<string, [string, boolean | null]> = { "--allow-remote": ["remote", true], "--no-allow-remote": ["remote", false], "--clear-public-origin": ["origin", null], "--no-build": ["noBuild", true], "--reconcile-interrupted": ["reconcile", true], "--initialize-app-admissions": ["initializeAppAdmissions", true], "--help": ["help", true] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!; let key: string, value: string | boolean | null;
    if (Object.hasOwn(switches, flag)) [key, value] = switches[flag]!;
    else if (Object.hasOwn(valued, flag)) { key = valued[flag]!; value = args[++i] ?? ""; if (!value || value.startsWith("--")) invalid(`Missing value for ${flag}`); }
    else invalid("Unknown App option");
    if (flags.has(key!)) invalid(`Duplicate or conflicting option: ${flag}`);
    if (["port", "concurrency"].includes(key!) && !/^\d+$/.test(String(value!))) invalid(`Invalid ${flag}`);
    flags.set(key!, value!);
  }
  const configPath = flags.has("config") ? resolve(invocation, flags.get("config") as string) : join(packageDir, ".config.json");
  let raw: Record<string, any> = {}, configExists = false;
  try { raw = parseConfigJson(readFileSync(configPath, "utf8")); configExists = true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT" || flags.has("config") && !context.allowMissingConfig) throw e; }
  if (configExists && (raw.format !== "sane-app-config" || (raw.version !== 1 && raw.version !== 2))) invalid("Expected sane-app-config version 1 or 2");
  const server = raw.server === undefined ? {} : object(raw.server, ["host", "port", "publicOrigin", "allowRemote"], "server");
  const native = raw.native === undefined ? {} : object(raw.native, raw.version === 2 ? ["claude", "opencode", "grok"] : ["claude", "opencode"], "native");
  const gk = raw.version === 2 && native.grok !== undefined ? object(native.grok, ["homeRoot", "executable"], "grok") : undefined;
  if (gk && !isAbsolute(text(gk.homeRoot, "grok.homeRoot"))) invalid("Grok home must be an absolute path");
  // Saved absolute path only. Never resolve a relative name against the config directory or PATH.
  const grokExecutable = gk?.executable === undefined ? undefined : absoluteGrokExecutable(text(gk.executable, "grok.executable"));
  const cc = native.claude === undefined ? {} : object(native.claude, ["executable", "profileRoot"], "claude");
  const oc = native.opencode === undefined ? {} : object(native.opencode, ["mode", "registrationFile"], "opencode");
  if (oc.mode !== undefined && oc.mode !== "managed") invalid("Only managed OpenCode is supported");
  const base = dirname(configPath);
  const runtimeKeys = ["pluginDirectory", "openCodeConfigFile", "claudeMcpConfigFile", "bindingRoot"] as const;
  const runtime = raw.nativeRuntime === undefined ? undefined : object(raw.nativeRuntime, [...runtimeKeys], "nativeRuntime");
  const nativeRuntime = runtime && Object.fromEntries(runtimeKeys.map(key => [key, resolve(base, text(runtime[key], `nativeRuntime.${key}`))])) as NativeRuntimeSelection | undefined;
  const path = (key: string, saved: unknown, fallback: string) => flags.has(key) ? resolve(invocation, text(flags.get(key), key)) : saved !== undefined ? resolve(base, text(saved, key)) : fallback;
  const choose = (key: string, saved: unknown, fallback: unknown) => flags.has(key) ? flags.get(key) : saved === undefined ? fallback : saved;
  // Validate saved settings even if a flag overrides them.
  for (const [v, label] of [[raw.dataDir,"dataDir"],[raw.defaultExecutionCwd,"cwd"],[cc.executable,"executable"],[cc.profileRoot,"profile"],[oc.registrationFile,"registration"],[server.host,"host"]] as const) if (v !== undefined) text(v, label);
  if (server.port !== undefined) integer(server.port, 0, 65535, "port");
  if (raw.maxConcurrentRuns !== undefined) integer(raw.maxConcurrentRuns, 1, 256, "concurrency");
  if (raw.contextDelivery !== undefined && raw.contextDelivery !== "startup" && raw.contextDelivery !== "canonical") invalid("Invalid contextDelivery");
  const contextDelivery = choose("contextDelivery", raw.contextDelivery, "canonical");
  if (contextDelivery !== "startup" && contextDelivery !== "canonical") invalid("Invalid contextDelivery");
  if (server.allowRemote !== undefined && typeof server.allowRemote !== "boolean") invalid("Invalid allowRemote");
  if (server.publicOrigin !== undefined && server.publicOrigin !== null) text(server.publicOrigin, "publicOrigin");
  const executable = text(choose("executable", cc.executable, "claude"), "executable");
  const config: AppConfig = {
    format: "sane-app-config", version: raw.version === 2 ? 2 : 1,
    dataDir: path("data", raw.dataDir, join(packageDir, ".data")),
    defaultExecutionCwd: path("cwd", raw.defaultExecutionCwd, invocation),
    server: { host: text(choose("host", server.host, "127.0.0.1"), "host"), port: integer(flags.has("port") ? Number(flags.get("port")) : server.port ?? 8787, 0, 65535, "port"), publicOrigin: choose("origin", server.publicOrigin, null) as string | null, allowRemote: choose("remote", server.allowRemote, false) as boolean },
    maxConcurrentRuns: integer(flags.has("concurrency") ? Number(flags.get("concurrency")) : raw.maxConcurrentRuns ?? 24, 1, 256, "concurrency"),
    maxWorkersPerCheckout: integer(raw.maxWorkersPerCheckout ?? DEFAULT_MAX_WORKERS_PER_CHECKOUT, 1, 256, "workers per checkout"),
    contextDelivery: contextDelivery as "startup" | "canonical",
    ...(raw.agentModelConfig !== undefined ? { agentModelConfig: resolve(base, text(raw.agentModelConfig, "agentModelConfig")) } : {}),
    ...(nativeRuntime ? { nativeRuntime } : {}),
    native: { claude: { executable: executable.includes("/") ? resolve(flags.has("executable") ? invocation : base, executable) : executable, profileRoot: path("profile", cc.profileRoot, resolve(invocation, env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"))) }, opencode: { mode: "managed", registrationFile: path("registration", oc.registrationFile, resolve(invocation, env.XDG_STATE_HOME ?? join(home, ".local/state"), "opencode/service.json")) }, ...(gk ? { grok: { homeRoot: resolve(base, gk.homeRoot), ...(grokExecutable !== undefined ? { executable: grokExecutable } : {}) } } : {}) },
  };
  const contradiction = (name: string) => invalid(`Native selector contradicts configuration: ${name}`);
  const sameSource = (harness: "cc" | "oc", a: string, b: string) => {
    if (a === b) return true;
    const descriptor = (path: string): NativeSourceDescriptor => harness === "cc" ? { version: 1, harness, kind: "local-profile", profileRoot: path } : { version: 1, harness, kind: "local-registration", registrationFile: path };
    try { return normalizeNativeSource(descriptor(a)).authorityId === normalizeNativeSource(descriptor(b)).authorityId; }
    catch { return false; } // Never include selector values in contradiction diagnostics.
  };
  if (env.CLAUDE_CONFIG_DIR && !sameSource("cc", resolve(invocation, env.CLAUDE_CONFIG_DIR), config.native.claude.profileRoot)) contradiction("CLAUDE_CONFIG_DIR");
  if (env.XDG_STATE_HOME && !sameSource("oc", resolve(invocation, env.XDG_STATE_HOME, "opencode/service.json"), config.native.opencode.registrationFile)) contradiction("XDG_STATE_HOME");
  for (const name of ["OPENCODE_URL", "OPENCODE_SERVER_URL"]) if (env[name]) contradiction(name);
  validateAppOrigin(config, env.SANE_APP_PASSWORD);
  const sources = { claude: sourceCapability({ version: 1, harness: "cc", kind: "local-profile", profileRoot: config.native.claude.profileRoot }), opencode: sourceCapability({ version: 1, harness: "oc", kind: "local-registration", registrationFile: config.native.opencode.registrationFile }) };
  if (sources.claude.authority?.descriptor.harness === "cc") config.native.claude.profileRoot = sources.claude.authority.descriptor.profileRoot;
  if (sources.opencode.authority?.descriptor.harness === "oc") config.native.opencode.registrationFile = sources.opencode.authority.descriptor.registrationFile;
  return { config, configPath, configExists, sources, operational: { noBuild: flags.has("noBuild"), reconcileInterrupted: flags.has("reconcile"), initializeAppAdmissions: flags.has("initializeAppAdmissions"), help: flags.has("help") } };
}
export function sourceCapability(descriptor: NativeSourceDescriptor | GrokSourceDescriptor): SourceCapability {
  if (descriptor.harness === "gk") {
    try {
      const authority = normalizeNativeSource(descriptor);
      return { state: "available", locator: authority.descriptor.homeRoot };
    } catch (e) { if (e instanceof DomainError && e.code === "SOURCE_UNAVAILABLE") return { state: "unavailable", locator: descriptor.homeRoot }; throw e; }
  }
  const locator = descriptor.harness === "cc" ? descriptor.profileRoot : descriptor.registrationFile;
  try {
    const authority = normalizeNativeSource(descriptor);
    if (descriptor.harness === "oc") { try { lstatSync(locator); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return { state: "unavailable", locator, authority }; throw e; } }
    return { state: "available", locator, authority };
  } catch (e) { if (e instanceof DomainError && e.code === "SOURCE_UNAVAILABLE") return { state: "unavailable", locator }; throw e; }
}
const loopback = (host: string) => ["localhost", "127.0.0.1", "::1", "[::1]", "::ffff:127.0.0.1"].includes(host);
export function validateAppOrigin(config: AppConfig, password?: string): void {
  const remote = !loopback(config.server.host);
  if (remote && (!config.server.allowRemote || !password || !config.server.publicOrigin)) invalid("Remote listener requires allowRemote, SANE_APP_PASSWORD and publicOrigin");
  if (config.server.publicOrigin !== null) {
    let u: URL; try { u = new URL(config.server.publicOrigin); } catch { return invalid("Invalid publicOrigin"); }
    if (u.origin !== config.server.publicOrigin || u.username || u.password || (u.protocol !== "https:" && !(u.protocol === "http:" && loopback(u.hostname) && !remote))) invalid("publicOrigin must be an exact HTTPS origin or local HTTP origin");
    if (!loopback(u.hostname) && !password) invalid("Remote publicOrigin requires SANE_APP_PASSWORD");
  }
}
/** Saved absolute executable, or undefined. Never a PATH name such as "grok". */
export function explicitGrokExecutable(config: AppConfig): string | undefined {
  const executable = config.native.grok?.executable;
  if (typeof executable !== "string" || !executable.trim() || executable.includes("\0") || !isAbsolute(executable)) return undefined;
  return executable;
}
function absoluteGrokExecutable(value: string): string {
  if (!isAbsolute(value) || value.includes("\0")) invalid("Grok executable must be an absolute path");
  return value;
}
function savedAbsoluteGrokExecutable(grok: unknown): string | undefined {
  if (!grok || typeof grok !== "object" || Array.isArray(grok) || !Object.hasOwn(grok, "executable")) return undefined;
  const executable = (grok as { executable: unknown }).executable;
  if (typeof executable !== "string" || !executable.trim() || executable.includes("\0") || !isAbsolute(executable)) return invalid("Grok executable must be an absolute path");
  return executable;
}
function writeConfigAtomically(configPath: string, next: unknown): void {
  const temporary = `${configPath}.${crypto.randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(next, null, 2) + "\n"); fsyncSync(fd); }
  catch (error) { try { unlinkSync(temporary); } catch { /* The failed temp is left if unlink also fails. */ } throw error; }
  finally { closeSync(fd); }
  renameSync(temporary, configPath);
  const directory = openSync(dirname(configPath), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
/** Explicit config publication. Does not run from startup and does not rewrite Claude or OpenCode fields. */
export function publishGrokConfig(configPath: string, homeRoot: string): void {
  if (!isAbsolute(homeRoot) || homeRoot.includes("\0")) invalid("Grok home must be an absolute path");
  const raw = parseConfigJson(readFileSync(configPath, "utf8"));
  if (raw.format !== "sane-app-config" || (raw.version !== 1 && raw.version !== 2)) invalid("Expected sane-app-config version 1 or 2");
  const native = raw.native && typeof raw.native === "object" && !Array.isArray(raw.native) ? { ...raw.native } : {};
  if (raw.version === 1 && Object.keys(native).some(key => key !== "claude" && key !== "opencode")) invalid("Unknown native key");
  const executable = savedAbsoluteGrokExecutable(native.grok);
  const next = { ...raw, version: 2, native: { ...native, grok: executable === undefined ? { homeRoot } : { homeRoot, executable } } };
  writeConfigAtomically(configPath, next);
}
/** Explicit executable publication. Requires a v2 home. Does not run from startup and does not rewrite Claude, OpenCode, or homeRoot. */
export function publishGrokExecutable(configPath: string, executable: string): void {
  if (typeof executable !== "string" || !executable.trim() || executable.includes("\0") || !isAbsolute(executable)) invalid("Grok executable must be an absolute path");
  const raw = parseConfigJson(readFileSync(configPath, "utf8"));
  if (raw.format !== "sane-app-config" || raw.version !== 2) invalid("Grok executable requires an existing home");
  const native = raw.native && typeof raw.native === "object" && !Array.isArray(raw.native) ? { ...raw.native } : {};
  const grok = native.grok;
  if (!grok || typeof grok !== "object" || Array.isArray(grok) || typeof grok.homeRoot !== "string" || !grok.homeRoot.trim() || grok.homeRoot.includes("\0") || !isAbsolute(grok.homeRoot)) invalid("Grok executable requires an existing home");
  const next = { ...raw, version: 2, native: { ...native, grok: { homeRoot: grok.homeRoot, executable } } };
  writeConfigAtomically(configPath, next);
}
