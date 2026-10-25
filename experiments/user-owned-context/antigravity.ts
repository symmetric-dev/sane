/** Manual Antigravity transport probe. No production adapter or automatic replay. */
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeLiveGate } from "../../packages/sane-app/tests/native-live-gate.ts";
import { checkContent } from "./checks.ts";
import { buildProbes } from "./probes.ts";

if (process.argv.slice(2).some(arg => arg !== "--live" && !arg.startsWith("--continue-observed-run="))) throw new Error("Supported flags: --live, --continue-observed-run=<directory>");
const live = process.argv.includes("--live");
if (live && !nativeLiveGate()) throw new Error("Explicit live opt-in required; see README.md");
const recoveryArg = process.argv.find(arg => arg.startsWith("--continue-observed-run="))?.slice("--continue-observed-run=".length);
if (recoveryArg && (!live || !isAbsolute(recoveryArg))) throw new Error("Observed-run continuation requires --live and an absolute evidence directory");
const recovered = recoveryArg ? JSON.parse(readFileSync(join(recoveryArg, "evidence.json"), "utf8")) : undefined;
// Only recover observed post-response parser/classification failures, never an
// uncertain submission. Every prior response is validated offline before sending.
if (recovered && (recovered.complete || recovered.chargedTurns < 1 || recovered.chargedTurns >= 5 ||
  !recovered.evidence.some((e: any) => e.stage === "failed" && [
    "Error: No safe native conversation ID exposed; inspect raw stream; do not replay",
    "Error: Response-only boundary violated; stop remaining submissions",
  ].includes(e.error)) || recovered.evidence.some((e: any) => e.stage === "process-exit" && (e.exit !== 0 || e.timedOut)))) throw new Error("Not a recoverable observed parser failure; no replay permitted");
const output = process.env.NATIVE_EVIDENCE_DIR;
if (!output || !isAbsolute(output) || resolve(output) === "/") throw new Error("Supply a bounded absolute NATIVE_EVIDENCE_DIR");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
mkdirSync(output, { recursive: true });
const runDir = join(output, randomUUID());
mkdirSync(runDir, { mode: 0o700 });
const fixture = recovered ? realpathSync(recovered.fixture) : realpathSync(mkdtempSync(join(tmpdir(), "sane-agy-context-")));
const cwd = join(fixture, "native");
if (!recovered) mkdirSync(cwd);
const { assets, activation, probes } = buildProbes(root, fixture);
const model = "gemini-3.8-flash-high";
const binary = process.env.NATIVE_AGY_BIN ?? "agy";
const home = homedir();
const nativeRoot = join(home, ".gemini/antigravity-cli");
const projectsRoot = join(home, ".gemini/config/projects");
const existingSessions = new Set(live ? readdirSync(join(nativeRoot, "conversations")) : []);
const existingProjects = new Set(live ? readdirSync(projectsRoot) : []);
const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value !== undefined &&
  !/^(CC_WEB_|SANE_|OPENCODE_SESSION_ID$|OPENCODE_TOKEN$|CLAUDECODE$|NODE_OPTIONS$|BUN_INSPECT|ANTIGRAVITY_TRAJECTORY_ID$|ANTIGRAVITY_PROJECT_ID$)/i.test(name))) as Record<string, string>;
env.AGY_CLI_HIDE_ACCOUNT_INFO = "1";
let chargedTurns = recovered?.chargedTurns ?? 0, complete = false;
let sessionId: string | undefined, projectId: string | undefined;
const evidence: Record<string, unknown>[] = [];
const results: { harness: string; turn: string; response: string; format: string; checks: Record<string, boolean> }[] = [];
const save = (name: string, value: unknown) => writeFileSync(join(runDir, name), typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
if (recovered) {
  const previousInputs = JSON.parse(readFileSync(join(recoveryArg!, "inputs.json"), "utf8"));
  if (JSON.stringify(previousInputs.probes) !== JSON.stringify(probes) || JSON.stringify(previousInputs.assets) !== JSON.stringify(assets)) throw new Error("Recovery inputs differ; stop");
  for (const [i, probe] of probes.slice(0, recovered.chargedTurns).entries()) {
    const label = `agy-${i + 1}-${probe.name}`;
    const stdout = readFileSync(join(recoveryArg!, `${label}.stdout.jsonl`), "utf8");
    const proof = recovered.evidence.find((e: any) => e.stage === "process-exit" && e.label === label) ?? recovered.evidence.find((e: any) => e.stage === "observed-response-recovered-offline" && e.turn === probe.name);
    if (!proof || hash(stdout) !== proof.stdoutHash) throw new Error("Saved response hash mismatch; stop");
    const events = stdout.split("\n").filter(Boolean).map(line => JSON.parse(line));
    if (events.findLast(e => e.event === "result")?.result?.status !== "SUCCESS") throw new Error("Prior response not successful; cannot recover");
    if (events.some(e => e.event === "step_update" && (e.step_update.tool_info || e.step_update.subagent_info || !["user_input", "agent_response", "system_message"].includes(e.step_update.step_type)))) throw new Error("Prior stream has tool/unknown steps; cannot continue");
  }
}
function record(item: Record<string, unknown>) {
  evidence.push({ at: new Date().toISOString(), ...item });
  save("evidence.json", { live, complete, harnesses: ["agy"], modelRequested: model, chargedTurns, turnBudget: 5, fixture, nativeSessionId: sessionId, nativeProjectId: projectId, evidence, results });
}

async function command(argv: string[], label: string, timeout = 180_000) {
  save(`${label}.command.json`, { argv, cwd, stdin: "ignored", timeoutMs: timeout });
  const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
  try {
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    save(`${label}.stdout.jsonl`, stdout);
    save(`${label}.stderr.txt`, stderr);
    record({ stage: "process-exit", label, exit, timedOut, stdoutHash: hash(stdout), stderrHash: hash(stderr) });
    if (timedOut || exit !== 0) throw new Error(`${label}: ${timedOut ? "timeout; submission uncertain" : `exit ${exit}`}; inspect saved output; do not replay`);
    return stdout;
  } finally { clearTimeout(timer); }
}

function captureSession(label: string) {
  if (!sessionId) return;
  for (const suffix of [".db", ".db-wal", ".db-shm"]) {
    const name = `${sessionId}${suffix}`, source = join(nativeRoot, "conversations", name);
    if (existingSessions.has(name)) throw new Error("Refusing to capture/remove a pre-existing native session");
    if (existsSync(source)) copyFileSync(source, join(runDir, `${label}.native${suffix}`));
  }
}

save("inputs.json", { assets, probes, models: { agy: { requested: model } } });
for (const [i, probe] of probes.entries()) {
  save(`agy-${i + 1}-${probe.name}.body.txt`, probe.body);
  save(`agy-${i + 1}-${probe.name}.prompt.txt`, probe.text);
}
try {
  record({ stage: "prepared", root, activationBytes: Buffer.byteLength(activation), limits: [
    "No disable-all-tools CLI option found. Response-only instructions; emitted calls checked, not a hard tool deny.",
    "Requested model slug is not proof of actual backend model resolution.",
    "CLI stream output is not assumed to acknowledge exact admitted user bytes.",
    "Native system instructions/ambient harness customization differ from CC and OC.",
  ] });
  if (live) {
    const help = await command([binary, "--help"], "discovery-help", 20_000) + readFileSync(join(runDir, "discovery-help.stderr.txt"), "utf8");
    for (const flag of ["--conversation", "--new-project", "--output-format", "--disable-slash-commands", "--print-timeout", "--model"]) {
      if (!help.includes(flag)) throw new Error(`Required CLI option absent: ${flag}`);
    }
    // Keep only relevant static documentation, never ambient settings or credentials.
    const changelog = join(nativeRoot, "cache/CHANGELOG.md");
    if (existsSync(changelog)) save("discovery-changelog-excerpts.txt", readFileSync(changelog, "utf8").split("\n").filter(line => /^## /.test(line) || /stream-json|headless|--conversation|silently.*model|--model.*ignored/.test(line)).join("\n"));
    for (const [index, probe] of probes.entries()) {
      if (chargedTurns >= 5) throw new Error("Five-submission cap exceeded");
      if (index > 0 && !sessionId) throw new Error("No explicit native continuation ID; stop, do not resend history");
      const label = `agy-${index + 1}-${probe.name}`;
      const argv = [binary, "--model", model, "--output-format", "stream-json", "--disable-slash-commands", "--print-timeout", "150s",
        "--log-file", join(runDir, `${label}.cli.log`),
        ...(index === 0 ? ["--new-project"] : ["--conversation", sessionId!]), "-p", probe.text];
      let stdout: string;
      if (recovered && index < recovered.chargedTurns) {
        stdout = readFileSync(join(recoveryArg!, `${label}.stdout.jsonl`), "utf8");
        save(`${label}.stdout.jsonl`, stdout);
        record({ stage: "observed-response-recovered-offline", sourceRun: recoveryArg, turn: probe.name, newModelSubmissions: 0, priorSubmissions: recovered.chargedTurns, stdoutHash: hash(stdout) });
      } else {
        chargedTurns++;
        record({ stage: "submission-intent", turn: probe.name, kind: probe.kind, modelRequested: model, nativeSessionId: sessionId ?? null,
          textHash: hash(probe.text), bodyHash: hash(probe.body), bytes: Buffer.byteLength(probe.text), transport: "ordinary print prompt argv", noAutomaticReplay: true });
        stdout = await command(argv, label);
      }
      const events = stdout.split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
      save(`${label}.events.json`, events);
      const initEvent = events.find(e => e.event === "init");
      const init = initEvent?.init;
      const result = events.findLast(e => e.event === "result")?.result;
      const observedId = initEvent?.conversation_id ?? result?.conversation_id;
      if (typeof observedId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(observedId)) throw new Error("No safe native conversation ID exposed; inspect raw stream; do not replay");
      if (sessionId && observedId !== sessionId) throw new Error("Native continuation changed conversation ID; stop");
      if (result?.conversation_id !== observedId) throw new Error("Init/result conversation mismatch; stop");
      sessionId = observedId;
      if (recovered && index === 0) for (const suffix of [".db", ".db-wal", ".db-shm"]) existingSessions.delete(`${sessionId}${suffix}`);
      projectId = init?.project_id ?? projectId;
      captureSession(label);
      if (!result || result.status !== "SUCCESS" || result.is_error || result.error) throw new Error("No successful terminal result; inspect raw stream; do not replay");
      const response = typeof result.result === "string" ? result.result : typeof result.response === "string" ? result.response : typeof result.text === "string" ? result.text : undefined;
      if (response === undefined) throw new Error("Unknown result response schema; retained stream; do not replay");
      const content = checkContent(probe, response);
      const steps = events.filter(e => e.event === "step_update").map(e => e.step_update);
      // Closed-vocabulary response-only allowlist: every other step needs inspection.
      const toolEvents = steps.filter(e => e.tool_info || e.subagent_info || !["user_input", "agent_response", "system_message"].includes(e.step_type));
      const checks = { sameSession: observedId === sessionId && steps.every(e => e.conversation_id === sessionId), requestedModelReported: init?.model === model, noObservedToolCalls: toolEvents.length === 0, ...content.checks };
      results.push({ harness: "agy", turn: probe.name, response, format: content.format, checks });
      record({ stage: "response-observed", turn: probe.name, nativeSessionId: sessionId, init, resultMetadata: { ...result, result: undefined, response: undefined, text: undefined }, observedSystemSteps: steps.filter(e => e.step_type === "system_message"), observedToolEvents: toolEvents });
      console.log(`agy ${probe.name}: ${Object.values(checks).every(Boolean) ? "PASS" : "CHECK FAILED"}\n${response}\n`);
      if (init?.model !== model) throw new Error("Native init did not report the requested model; stop, no fallback");
      if (toolEvents.length) throw new Error("Response-only boundary violated; stop remaining submissions");
    }
    complete = true;
  } else {
    record({ stage: "dry-run", note: "Inputs only; no native discovery, sessions, or model calls." });
    complete = true;
  }
} catch (error) {
  record({ stage: "failed", error: String(error), noAutomaticReplay: true });
  process.exitCode = 1;
} finally {
  // Preserve the owned native conversation before removing exactly its files.
  // No global cache/history/database resets or edits to existing project configs.
  try {
    captureSession("final");
    if (sessionId && complete) {
      if (!existsSync(join(runDir, "final.native.db"))) throw new Error("Native database not captured; retain state rather than claiming cleanup");
      for (const suffix of [".db", ".db-wal", ".db-shm"]) {
        const name = `${sessionId}${suffix}`;
        if (existingSessions.has(name)) throw new Error("Cleanup guard: pre-existing session");
        rmSync(join(nativeRoot, "conversations", name), { force: true });
      }
      const brain = join(nativeRoot, "brain", sessionId);
      if (existsSync(brain)) { cpSync(brain, join(runDir, "native-brain"), { recursive: true }); rmSync(brain, { recursive: true }); }
      for (const [directory, suffix] of [["presence", ".lock"], ["annotations", ".pbtxt"]]) {
        const source = join(nativeRoot, directory!, `${sessionId}${suffix}`);
        if (existsSync(source)) { copyFileSync(source, join(runDir, `native-${directory}${suffix}`)); rmSync(source); }
      }
      record({ stage: "owned-conversation-files-removed", nativeSessionId: sessionId });
    }
    // The stream currently exposes no project ID. Identify only a new project
    // whose sole workspace is this exact disposable cwd; never use active defaults.
    if (complete && live && !projectId) {
      const owned = readdirSync(projectsRoot).filter(name => name.endsWith(".json") && (!existingProjects.has(name) || recovered)).filter(name => {
        const project = JSON.parse(readFileSync(join(projectsRoot, name), "utf8"));
        const resources = project.projectResources?.resources;
        return Array.isArray(resources) && resources.length === 1 && resources[0].folderUri === `file://${cwd}` && name === `${project.id}.json`;
      });
      if (owned.length === 1) projectId = owned[0]!.slice(0, -5);
    }
    if (complete && projectId && /^[a-zA-Z0-9_-]+$/.test(projectId) && (!existingProjects.has(`${projectId}.json`) || recovered)) {
      const path = join(projectsRoot, `${projectId}.json`);
      if (existsSync(path)) { copyFileSync(path, join(runDir, "native-project.json")); rmSync(path); record({ stage: "owned-project-file-removed", projectId }); }
    }
    if (!chargedTurns || complete) rmSync(fixture, { recursive: true });
    record({ stage: !chargedTurns || complete ? "fixtures-removed" : "incomplete-state-retained", fixture, remainingState: "CLI-maintained cache/history/summary references may remain. No shared metadata rewritten. Unknown/unexposed native artifacts are not deleted. Incomplete submitted runs retain their fixture/session for inspection, never automatic replay." });
  } catch (error) { record({ stage: "cleanup-failed", error: String(error) }); process.exitCode = 1; }
  const failed = results.filter(r => !Object.values(r.checks).every(Boolean));
  if (failed.length) process.exitCode = 1;
  save("responses.md", ["# Antigravity user-role context probe", "", `Live: ${live}; complete: ${complete}; submissions: ${chargedTurns}/5.`, "",
    ...results.flatMap(r => [`## ${r.turn}`, "", `Envelope: ${r.format}`, "", "~~~~text", r.response, "~~~~", "", ...Object.entries(r.checks).map(([k, v]) => `- ${v ? "PASS" : "FAIL"}: ${k}`), ""]),
  ].join("\n"));
  record({ stage: "finished", complete, failedResponses: failed.length });
  console.log(`Evidence: ${runDir}`);
}
