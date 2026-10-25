/** Manual native Grok Build behavior probe, not a production adapter. Never retries. */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeLiveGate } from "../../packages/sane-app/tests/native-live-gate.ts";
import { buildProbes } from "./probes.ts";
import { checkContent } from "./checks.ts";

if (process.argv.slice(2).some(arg => arg !== "--live")) throw new Error("Supported flag: --live");
const live = process.argv.includes("--live");
if (live && !nativeLiveGate()) throw new Error("Explicit native live opt-in required");
const output = process.env.NATIVE_EVIDENCE_DIR;
if (!output || !isAbsolute(output) || resolve(output) === "/") throw new Error("Supply bounded absolute NATIVE_EVIDENCE_DIR");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
mkdirSync(output, { recursive: true });
const runDir = join(output, randomUUID());
mkdirSync(runDir, { mode: 0o700 });
const fixture = realpathSync(mkdtempSync(join(tmpdir(), "sane-grok-context-")));
const cwd = join(fixture, "native");
mkdirSync(cwd);
const { assets, activation, probes } = buildProbes(root, fixture);
const binary = process.env.NATIVE_GROK_BIN ?? "grok";
const nativeRoot = resolve(process.env.GROK_HOME ?? join(homedir(), ".grok"));
const sessionId = randomUUID();
const model = "grok-4.7", effort = "low";
const modelSelection = "Authenticated default, supported low effort. Fast variant explicitly costs 2x; no dollar pricing/cap or cheapest-model claim. No fallback.";
const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined &&
  !/^(CC_WEB_|SANE_|OPENCODE_|CLAUDECODE$|CLAUDE_PROJECT_DIR$|NODE_OPTIONS$|BUN_INSPECT|GROK_SESSION_ID$)/i.test(key))) as Record<string, string>;
const overrides: Record<string, string> = { GROK_MEMORY: "0", GROK_MANAGED_MCPS_ENABLED: "false", GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED: "false" };
for (const vendor of ["CLAUDE", "CURSOR"]) for (const surface of ["AGENTS", "RULES", "HOOKS", "MCPS", "SKILLS"]) overrides[`GROK_${vendor}_${surface}_ENABLED`] = "false";
Object.assign(env, overrides);
let chargedTurns = 0, complete = false, nativeSessionPath: string | undefined;
const evidence: Record<string, unknown>[] = [];
const results: { harness: string; turn: string; response: string; format: string; checks: Record<string, boolean> }[] = [];
const save = (name: string, value: unknown) => writeFileSync(join(runDir, name), typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function record(item: Record<string, unknown>) {
  evidence.push({ at: new Date().toISOString(), ...item });
  save("evidence.json", { live, complete, harnesses: ["grok"], modelRequested: model, effortRequested: effort, modelSelection,
    nativeSessionId: sessionId, nativeSessionPath, chargedTurns, turnBudget: 5, fixture, evidence, results });
}
async function command(argv: string[], label: string, timeoutMs = 20_000) {
  // Exact command and raw file destinations are durable before process launch.
  save(`${label}.command.json`, { argv, cwd, stdin: "ignored", timeoutMs, envOverrides: overrides });
  const outPath = join(runDir, `${label}.stdout.jsonl`), errPath = join(runDir, `${label}.stderr.txt`);
  const stdout = openSync(outPath, "wx", 0o600), stderr = openSync(errPath, "wx", 0o600);
  let child: ReturnType<typeof Bun.spawn>;
  try { child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout, stderr }); }
  finally { closeSync(stdout); closeSync(stderr); }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
  try {
    const exit = await child.exited;
    const out = readFileSync(outPath, "utf8"), err = readFileSync(errPath, "utf8");
    record({ stage: "process-exit", label, exit, timedOut, stdoutHash: hash(out), stderrHash: hash(err) });
    if (timedOut || exit !== 0) throw new Error(`${label}: ${timedOut ? "timeout; submission uncertain" : `exit ${exit}`}; inspect raw files, never replay`);
    return out;
  } finally { clearTimeout(timer); }
}
function locateNativeSession() {
  const sessions = join(nativeRoot, "sessions");
  if (!existsSync(sessions)) return undefined;
  const matches = readdirSync(sessions, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .map(entry => join(sessions, entry.name, sessionId)).filter(path => existsSync(path));
  if (matches.length > 1) throw new Error("Ambiguous owned session path; retain state");
  return matches[0];
}
function captureNative(label: string) {
  nativeSessionPath = locateNativeSession();
  if (!nativeSessionPath) return;
  const destination = join(runDir, `${label}.native`);
  mkdirSync(destination, { mode: 0o700 });
  // Only the unique owned conversation, never global config/auth/history.
  for (const name of ["summary.json", "updates.jsonl", "chat_history.jsonl", "system_prompt.txt", "tool_definitions.json", "signals.json"]) {
    const path = join(nativeSessionPath, name);
    if (existsSync(path)) copyFileSync(path, join(destination, name));
  }
  record({ stage: "owned-native-capture", label, nativeSessionPath });
}
save("inputs.json", { assets, probes, models: { grok: { requested: model, effort, selection: modelSelection } } });
for (const [index, probe] of probes.entries()) {
  save(`grok-${index + 1}-${probe.name}.body.txt`, probe.body);
  save(`grok-${index + 1}-${probe.name}.prompt.txt`, probe.text);
}
try {
  record({ stage: "prepared", root, activationBytes: Buffer.byteLength(activation), limits: [
    "Model init/usage are harness reports, not independent backend resolution.",
    "Raw output does not by itself acknowledge exact admitted user bytes; native history must be inspected separately.",
    "Catch-all deny gates execution, but does not remove every tool schema. Native system context remains.",
  ] });
  if (live) {
    if (locateNativeSession()) throw new Error("UUID already exists; refusing reuse");
    await command([binary, "--version"], "discovery-version");
    const help = await command([binary, "--help"], "discovery-help");
    for (const flag of ["--prompt-file", "--verbatim", "--session-id", "--resume", "--deny", "--max-turns", "--no-subagents", "--no-plan", "--reasoning-effort"]) if (!help.includes(flag)) throw new Error(`Required option missing: ${flag}`);
    const models = await command([binary, "models"], "discovery-models");
    if (!models.includes("logged in with grok.com") || !models.includes(`Default model: ${model}`)) throw new Error("Authenticated default changed; no fallback");
    // Allowlist fields from the catalog; never retain account/cache identity or headers.
    const catalog = JSON.parse(readFileSync(join(nativeRoot, "models_cache.json"), "utf8"));
    const rows: any[] = [];
    function findModels(value: any) {
      if (Array.isArray(value)) value.forEach(findModels);
      else if (value && typeof value === "object") {
        if (typeof value.id === "string" && value.id.startsWith("grok-")) rows.push({ id: value.id, name: value.name, description: value.description, reasoning_efforts: value.reasoning_efforts });
        else Object.values(value).forEach(findModels);
      }
    }
    findModels(catalog);
    save("discovery-model-selection.json", { requested: model, effort, rationale: modelSelection, models: rows });
    if (!rows.find(row => row.id === model)?.reasoning_efforts?.some((entry: any) => entry.id === effort)) throw new Error("Selected effort unavailable; stop");
    const inspection = JSON.parse(await command([binary, "inspect", "--json"], "discovery-inspect"));
    // Inspect also lists disabled compatibility discoveries. They are not active.
    const active = (list: any[]) => list.filter(entry => !(entry.disabled === true && entry.compatibilityStatus === "disabled"));
    if ([inspection.projectInstructions, inspection.hooks, inspection.plugins, inspection.mcpServers].some(list => !Array.isArray(list) || active(list).length)) throw new Error("Active ambient instructions/hooks/plugins/MCP detected; no submission");
    record({ stage: "preflight-verified", modelRequested: model, effortRequested: effort, noProjectInstructions: true, noActiveHooks: true, noActivePlugins: true, noActiveMcpServers: true,
      disabledDiscoveries: { hooks: inspection.hooks.length, mcpServers: inspection.mcpServers.length } });
    for (const [index, probe] of probes.entries()) {
      if (chargedTurns >= 5) throw new Error("Five-submission cap exceeded");
      const label = `grok-${index + 1}-${probe.name}`;
      const argv = [binary, "--model", model, "--reasoning-effort", effort, "--output-format", "streaming-messages-json",
        "--verbatim", "--no-plan", "--no-subagents", "--disable-web-search", "--permission-mode", "dontAsk", "--deny", "*", "--max-turns", "1",
        ...(index === 0 ? ["--session-id", sessionId] : ["--resume", sessionId]), "--prompt-file", join(runDir, `${label}.prompt.txt`)];
      chargedTurns++;
      record({ stage: "submission-intent", turn: probe.name, kind: probe.kind, nativeSessionId: sessionId, textHash: hash(probe.text), bodyHash: hash(probe.body), bytes: Buffer.byteLength(probe.text), transport: "ordinary verbatim prompt-file", noAutomaticReplay: true });
      const stdout = await command(argv, label, 180_000);
      captureNative(label);
      const events = stdout.split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
      save(`${label}.events.json`, events);
      const init = events.find(event => event.type === "system" && event.subtype === "init");
      const result = events.findLast(event => event.type === "result");
      if (result?.subtype !== "success" || result.is_error || typeof result.result !== "string") throw new Error("No successful terminal response; inspect saved stream; never replay");
      const toolEvents = events.filter(event => event.type === "tool" || event.type === "tool_use" || event.message?.content?.some((part: any) => part.type === "tool_use" || part.type === "tool_result"));
      const content = checkContent(probe, result.result);
      const checks = { sameSession: init?.session_id === sessionId && result.session_id === sessionId,
        requestedModelReported: init?.model === model, noObservedToolCalls: toolEvents.length === 0, ...content.checks };
      results.push({ harness: "grok", turn: probe.name, response: result.result, format: content.format, checks });
      record({ stage: "response-observed", turn: probe.name, init, resultMetadata: { ...result, result: undefined }, observedToolEvents: toolEvents });
      console.log(`grok ${probe.name}: ${Object.values(checks).every(Boolean) ? "PASS" : "CHECK FAILED"}`);
      if (!checks.sameSession || !checks.requestedModelReported || !checks.noObservedToolCalls) throw new Error("Native session/model/tool boundary mismatch; stop remaining submissions");
    }
    complete = true;
  } else {
    record({ stage: "dry-run", note: "Inputs only: zero native discovery, sessions, or model calls." });
    complete = true;
  }
} catch (error) {
  record({ stage: "failed", error: String(error), noAutomaticReplay: true });
  process.exitCode = 1;
} finally {
  try {
    if (chargedTurns) captureNative("final");
    if (complete && chargedTurns && process.env.NATIVE_CLEANUP === "close-and-remove") {
      if (!nativeSessionPath || !existsSync(join(runDir, "final.native/updates.jsonl"))) throw new Error("Native history not captured; retain state");
      await command([binary, "sessions", "delete", sessionId], "cleanup-owned-session");
      if (existsSync(nativeSessionPath)) throw new Error("Session deletion did not remove owned path");
      record({ stage: "owned-session-removed", nativeSessionPath });
      // Do not delete the cwd group or shared metadata; CLI may maintain references.
    }
    if (!chargedTurns || complete) rmSync(fixture, { recursive: true });
    record({ stage: !chargedTurns || complete ? "fixtures-removed" : "incomplete-state-retained", fixture,
      residual: "Native CLI may retain cwd-group/index/log/cache metadata. No shared metadata, global configuration, or other sessions reset. Incomplete submitted sessions/fixtures retained; no automatic replay." });
  } catch (error) { record({ stage: "cleanup-failed", error: String(error) }); process.exitCode = 1; }
  const failed = results.filter(result => !Object.values(result.checks).every(Boolean));
  if (failed.length) process.exitCode = 1;
  save("responses.md", ["# Grok user-role context probe", "", `Live: ${live}; complete: ${complete}; submissions: ${chargedTurns}/5.`, "",
    ...results.flatMap(result => [`## ${result.turn}`, "", `Envelope: ${result.format}`, "", "~~~~text", result.response, "~~~~", "", ...Object.entries(result.checks).map(([key, pass]) => `- ${pass ? "PASS" : "FAIL"}: ${key}`), ""]),
  ].join("\n"));
  record({ stage: "finished", complete, failedResponses: failed.length });
  console.log(`Evidence: ${runDir}`);
}
