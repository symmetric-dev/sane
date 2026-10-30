import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createGrokRuntimeBinding, type GrokRuntimeBindingInput } from "../../sane-cli/src/native-grok-binding";

export type GrokNativeRuntime = { readonly agentFile: string; readonly bindingId: string; close: () => void };
export type GrokNativeRuntimeOptions = GrokRuntimeBindingInput & { bindingDirectory: string; appConnectionFile: string };
export type GrokNativeRuntimeInstallation = Pick<GrokNativeRuntimeOptions, "bindingDirectory" | "appConnectionFile">;
const cli = resolve(import.meta.dir, "../../sane-cli/src");
const runtimeFiles = ["native-grok-mcp.ts", "native-grok-hook.ts", "native-grok-binding.ts", "native-worker.ts", "native-worker-contract.ts",
  "native-caller.ts", "native-handoff.ts", "native-share-code.ts", "native-share-code-contract.ts", "native-share-media.ts", "native-share-media-contract.ts", "native-user-questions.ts", "native-user-questions-contract.ts", "native-browser.ts"];
const explicitTools = ["sane_worker_complete", "sane_worker_notify", "sane_worker_message_parent", "sane_worker_message"] as const;

function agentDefinition(options: GrokNativeRuntimeInstallation, bindingId: string) {
  return {
    name: "sane-grok-runtime", description: "Full native Grok coding agent with the current App run's SANE tools",
    promptMode: "extend", model: "inherit", permissionMode: "bypassPermissions", capabilityMode: "all", injectDefaultTools: true, agents_md: true,
    mcpServers: [{ sane: { command: process.execPath, args: [join(cli, "native-grok-mcp.ts"), options.bindingDirectory, bindingId, options.appConnectionFile] } }],
    hooks: { PreToolUse: [{ matcher: "^sane__|^run_terminal_command$|^run_terminal_cmd$|^Shell$",
      hooks: [{ type: "command", command: process.execPath, args: [join(cli, "native-grok-hook.ts"), options.bindingDirectory, bindingId] }] }] },
  };
}

function privateFile(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Grok runtime artifact must be a direct regular file");
  return readFileSync(path, "utf8");
}
function installationArtifact(options: GrokNativeRuntimeInstallation) {
  return { version: 1, appConnectionFile: options.appConnectionFile,
    // This is a deployment template, never a fake session or authority binding.
    agent: agentDefinition(options, "${SANE_GROK_BINDING_ID}"),
    tools: [...explicitTools],
    files: Object.fromEntries(runtimeFiles.map(name => [name, createHash("sha256").update(privateFile(join(cli, name))).digest("hex")])),
  };
}

/** Materialize the selected deployment's actual MCP/hook template. No native
 * session, caller authority, fake model turn or global configuration is created. */
export function installGrokNativeRuntime(options: GrokNativeRuntimeInstallation): void {
  if (!isAbsolute(options.bindingDirectory) || !isAbsolute(options.appConnectionFile)) throw new Error("Explicit absolute Grok runtime installation paths required");
  mkdirSync(options.bindingDirectory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(options.bindingDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error("Private Grok runtime installation directory required");
  const path = join(options.bindingDirectory, "runtime-installation.json");
  try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  writeFileSync(path, JSON.stringify(installationArtifact(options)), { flag: "wx", mode: 0o600 });
}

/** Read-only deployment proof for explicit worker admission. The selected
 * generated agent artifact, MCP entrypoint, hook, contracts and operation code
 * must all still match. Live request authorization remains the bridge's job. */
export function proveInstalledGrokWorkerRuntime(options: GrokNativeRuntimeInstallation): readonly string[] | undefined {
  try {
    const directory = lstatSync(options.bindingDirectory), endpoint = lstatSync(options.appConnectionFile);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0
      || endpoint.uid !== process.getuid?.() || (endpoint.mode & 0o077) !== 0) return;
    const connection = JSON.parse(privateFile(options.appConnectionFile));
    if (connection.version !== 1 || typeof connection.url !== "string" || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]*\/native\/handoffs$/.test(connection.url)
      || typeof connection.token !== "string" || !connection.token || !Number.isSafeInteger(connection.pid) || connection.pid < 1) return;
    process.kill(connection.pid, 0);
    const path = join(options.bindingDirectory, "runtime-installation.json"), stat = lstatSync(path);
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || !isDeepStrictEqual(JSON.parse(privateFile(path)), installationArtifact(options))) return;
    return [...explicitTools];
  } catch { return; }
}

/** A private per-run agent overlays only SANE's MCP server and identity hooks.
 * No global configuration, context, skill, coding-tool or web-tool mutations.
 * GROK_CONFIG intentionally cannot inject MCP or hooks (documented allowlist).
 * `tools` is omitted: Grok keeps its complete normal native toolset. */
export function createGrokNativeRuntime(options: GrokNativeRuntimeOptions): GrokNativeRuntime {
  if (!isAbsolute(options.appConnectionFile)) throw new Error("Grok runtime requires an absolute App connection file");
  const { bindingDirectory, appConnectionFile, ...input } = options;
  const issued = createGrokRuntimeBinding(bindingDirectory, input);
  const bindingId = issued.binding.bindingId;
  const agentFile = join(bindingDirectory, `${bindingId}.agent.md`);
  const frontmatter = agentDefinition({ bindingDirectory, appConnectionFile }, bindingId);
  try {
    // JSON is a YAML subset. Avoid hand-quoting user paths inside frontmatter.
    writeFileSync(agentFile, `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n`, { flag: "wx", mode: 0o600 });
  } catch (error) { issued.remove(); throw error; }
  let closed = false;
  return Object.freeze({ agentFile, bindingId, close: () => {
    if (closed) return;
    // Revoke before removing ancillary files. Called only after actual process
    // close and capture drain (or proven pre-spawn non-submission).
    issued.remove();
    for (const file of readdirSync(bindingDirectory)) if (file === `${bindingId}.agent.md` || file.startsWith(`${bindingId}.`) && file.endsWith(".used")) {
      try { unlinkSync(join(bindingDirectory, file)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    closed = true;
  } });
}
