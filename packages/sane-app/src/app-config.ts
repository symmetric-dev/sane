import { readFileSync, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { DomainError, normalizeNativeSource } from "sane-core/server";
import type { NativeAuthority, NativeSourceDescriptor } from "sane-core/contracts";
import { DEFAULT_MAX_WORKERS_PER_CHECKOUT } from "./worker-contract";

export class AppConfigError extends Error { readonly code = "INVALID_APP_CONFIG"; }
export type AppConfig = {
  format: "sane-app-config"; version: 1; dataDir: string; defaultExecutionCwd: string;
  server: { host: string; port: number; publicOrigin: string | null; allowRemote: boolean };
  maxConcurrentRuns: number;
  maxWorkersPerCheckout?: number;
  native: { claude: { executable: string; profileRoot: string }; opencode: { mode: "managed"; registrationFile: string } };
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
  try { value(); whitespace(); if (i !== input.length) invalid("Malformed config JSON"); return object(JSON.parse(input), ["format", "version", "dataDir", "defaultExecutionCwd", "server", "maxConcurrentRuns", "maxWorkersPerCheckout", "native"], "config"); }
  catch (e) { if (e instanceof AppConfigError) throw e; return invalid("Malformed config JSON"); }
}

export type ConfigContext = { packageDir: string; invocationCwd: string; env?: NodeJS.ProcessEnv; home?: string; allowMissingConfig?: boolean };
/** Reads only the selected config and source path metadata; never creates or probes native services. */
export function resolveAppConfig(args: string[], context: ConfigContext) {
  const env = context.env ?? process.env, home = context.home ?? homedir();
  const invocation = resolve(context.invocationCwd), packageDir = resolve(context.packageDir);
  const flags = new Map<string, string | boolean | null>();
  const valued: Record<string, string> = { "--config": "config", "--cwd": "cwd", "--data-dir": "data", "--host": "host", "--port": "port", "--public-origin": "origin", "--claude-bin": "executable", "--claude-profile": "profile", "--opencode-registration": "registration", "--max-concurrent-runs": "concurrency" };
  const switches: Record<string, [string, boolean | null]> = { "--allow-remote": ["remote", true], "--no-allow-remote": ["remote", false], "--clear-public-origin": ["origin", null], "--no-build": ["noBuild", true], "--reconcile-interrupted": ["reconcile", true], "--help": ["help", true] };
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
  if (configExists && (raw.format !== "sane-app-config" || raw.version !== 1)) invalid("Expected sane-app-config version 1");
  const server = raw.server === undefined ? {} : object(raw.server, ["host", "port", "publicOrigin", "allowRemote"], "server");
  const native = raw.native === undefined ? {} : object(raw.native, ["claude", "opencode"], "native");
  const cc = native.claude === undefined ? {} : object(native.claude, ["executable", "profileRoot"], "claude");
  const oc = native.opencode === undefined ? {} : object(native.opencode, ["mode", "registrationFile"], "opencode");
  if (oc.mode !== undefined && oc.mode !== "managed") invalid("Only managed OpenCode is supported");
  const base = dirname(configPath);
  const path = (key: string, saved: unknown, fallback: string) => flags.has(key) ? resolve(invocation, text(flags.get(key), key)) : saved !== undefined ? resolve(base, text(saved, key)) : fallback;
  const choose = (key: string, saved: unknown, fallback: unknown) => flags.has(key) ? flags.get(key) : saved === undefined ? fallback : saved;
  // Validate saved settings even if a flag overrides them.
  for (const [v, label] of [[raw.dataDir,"dataDir"],[raw.defaultExecutionCwd,"cwd"],[cc.executable,"executable"],[cc.profileRoot,"profile"],[oc.registrationFile,"registration"],[server.host,"host"]] as const) if (v !== undefined) text(v, label);
  if (server.port !== undefined) integer(server.port, 0, 65535, "port");
  if (raw.maxConcurrentRuns !== undefined) integer(raw.maxConcurrentRuns, 1, 256, "concurrency");
  if (server.allowRemote !== undefined && typeof server.allowRemote !== "boolean") invalid("Invalid allowRemote");
  if (server.publicOrigin !== undefined && server.publicOrigin !== null) text(server.publicOrigin, "publicOrigin");
  const executable = text(choose("executable", cc.executable, "claude"), "executable");
  const config: AppConfig = {
    format: "sane-app-config", version: 1,
    dataDir: path("data", raw.dataDir, join(packageDir, ".data")),
    defaultExecutionCwd: path("cwd", raw.defaultExecutionCwd, invocation),
    server: { host: text(choose("host", server.host, "127.0.0.1"), "host"), port: integer(flags.has("port") ? Number(flags.get("port")) : server.port ?? 8787, 0, 65535, "port"), publicOrigin: choose("origin", server.publicOrigin, null) as string | null, allowRemote: choose("remote", server.allowRemote, false) as boolean },
    maxConcurrentRuns: integer(flags.has("concurrency") ? Number(flags.get("concurrency")) : raw.maxConcurrentRuns ?? 24, 1, 256, "concurrency"),
    maxWorkersPerCheckout: integer(raw.maxWorkersPerCheckout ?? DEFAULT_MAX_WORKERS_PER_CHECKOUT, 1, 256, "workers per checkout"),
    native: { claude: { executable: executable.includes("/") ? resolve(flags.has("executable") ? invocation : base, executable) : executable, profileRoot: path("profile", cc.profileRoot, resolve(invocation, env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"))) }, opencode: { mode: "managed", registrationFile: path("registration", oc.registrationFile, resolve(invocation, env.XDG_STATE_HOME ?? join(home, ".local/state"), "opencode/service.json")) } },
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
  return { config, configPath, configExists, sources, operational: { noBuild: flags.has("noBuild"), reconcileInterrupted: flags.has("reconcile"), help: flags.has("help") } };
}
export function sourceCapability(descriptor: NativeSourceDescriptor): SourceCapability {
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
