/** Manual, opt-in live behavior probe. Not imported by the application or bun test. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProbes, type Probe } from "./probes.ts";
import { nativeLiveGate } from "../../packages/sane-app/tests/native-live-gate.ts";
import { checkContent } from "./checks.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const live = process.argv.includes("--live");
if (process.argv.slice(2).some(arg => arg !== "--live" && !/^--harness=(cc|oc)$/.test(arg))) throw new Error("Supported flags: --live, --harness=cc|oc");
const harnessArg = process.argv.find(arg => arg.startsWith("--harness="))?.split("=")[1];
const harnesses = harnessArg ? [harnessArg] : ["cc", "oc"];
if (live && !nativeLiveGate()) throw new Error("Set the explicit native live gate; see README.md");
const output = process.env.NATIVE_EVIDENCE_DIR;
if (!output || !isAbsolute(output) || resolve(output) === "/") throw new Error("Supply a bounded absolute NATIVE_EVIDENCE_DIR");
mkdirSync(output, { recursive: true });
const runDir = join(output, randomUUID());
mkdirSync(runDir);
const fixture = realpathSync(mkdtempSync(join(tmpdir(), "sane-user-context-")));
const cwd = join(fixture, "native");
mkdirSync(cwd);
const ccProfile = resolve(process.env.NATIVE_CLAUDE_PROFILE ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"));
const ccProject = join(ccProfile, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
// Only remove this project's native files if it did not exist before the experiment.
if (existsSync(ccProject)) throw new Error("Disposable CC project already exists");
const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value !== undefined &&
  !/^(CC_WEB_|SANE_|OPENCODE_SESSION_ID$|OPENCODE_TOKEN$|CLAUDECODE$|NODE_OPTIONS$|BUN_INSPECT)/i.test(name))) as Record<string, string>;
env.CLAUDE_CONFIG_DIR = ccProfile;
env.CLAUDE_CODE_PROJECT_DIR_NAME = "";
const ccModel = "sonnet", ccEffort = "medium";
const ocModel = { providerID: "opencode-go", id: "deepseek-v4.1-flash", variant: "high" };
const TURN_BUDGET = harnesses.length * 5;
let chargedTurns = 0;
let ocId: string | undefined;
let complete = false;
const evidence: Record<string, unknown>[] = [];
const results: { harness: string; turn: string; response: string; format: string; checks: Record<string, boolean> }[] = [];
const save = (name: string, value: unknown) => writeFileSync(join(runDir, name), typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
function record(item: Record<string, unknown>) {
  evidence.push({ at: new Date().toISOString(), ...item });
  save("evidence.json", { live, complete, harnesses, chargedTurns, turnBudget: TURN_BUDGET, fixture, evidence, results });
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const { assets, activation, probes } = buildProbes(root, fixture);
save("inputs.json", { assets, probes, models: { cc: { model: ccModel, effort: ccEffort }, oc: ocModel } });

async function command(argv: string[], input?: string, label?: string, timeout = 180_000) {
  const child = Bun.spawn(argv, { cwd, env, stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
  const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
  try {
    if (input !== undefined && child.stdin) { child.stdin.write(input); await child.stdin.end(); }
    const [exit, out, err] = await Promise.all([child.exited, stdout, stderr]);
    if (label) { save(`${label}.stdout.jsonl`, out); save(`${label}.stderr.txt`, err); }
    if (timedOut || exit !== 0) throw new Error(`${argv[0]} failed (${timedOut ? "timeout; do not replay" : exit}): ${err.slice(-1500)} ${out.slice(-500)}`);
    return out;
  } finally { clearTimeout(timer); }
}
async function api(method: string, path: string, body?: unknown, label?: string) {
  const out = await command(["opencode", "api", method, path, ...(body === undefined ? [] : ["--data", JSON.stringify(body)])], undefined, label);
  return out.trim() ? JSON.parse(out) : null;
}
function charge(harness: string, probe: Probe) {
  if (chargedTurns >= TURN_BUDGET) throw new Error("Real model turn cap exceeded");
  chargedTurns++;
  // Durable intent precedes native submission. No automatic retries on any failure.
  record({ stage: "submission-intent", harness, turn: probe.name, kind: probe.kind, textHash: hash(probe.text), bodyHash: hash(probe.body), bytes: Buffer.byteLength(probe.text) });
}
function assess(harness: string, probe: Probe, response: string, transportChecks: Record<string, boolean>) {
  const { format, checks: contentChecks } = checkContent(probe, response);
  const checks = { ...transportChecks, ...contentChecks };
  results.push({ harness, turn: probe.name, response, format, checks });
  record({ stage: "response-observed", harness, turn: probe.name });
  console.log(`${harness} ${probe.name}: ${Object.values(checks).every(Boolean) ? "PASS" : "CHECK FAILED"}\n${response}\n`);
}

try {
  record({ stage: "prepared", root, models: { cc: { model: ccModel, effort: ccEffort }, oc: ocModel }, activationBytes: Buffer.byteLength(activation) });
  if (live) {
    const versions = { cc: (await command(["claude", "--version"])).trim(), oc: (await command(["opencode", "--version"])).trim() };
    record({ stage: "versions", versions });
    // The catalog includes provider configuration; retain only the selected safe fields.
    const catalog = await api("get", "/api/model");
    const selected = catalog.data.find((m: any) => m.providerID === ocModel.providerID && m.id === ocModel.id && m.enabled);
    if (!selected?.variants.some((v: any) => v.id === ocModel.variant)) throw new Error("Requested OC model/variant is unavailable; no fallback");
    record({ stage: "oc-model-verified", model: ocModel, name: selected.name });
    if (harnesses.includes("cc")) {
      const ccId = randomUUID();
      for (const [index, probe] of probes.entries()) {
        charge("cc", probe);
        const label = `cc-${index + 1}-${probe.name}`;
        const argv = [process.env.NATIVE_CLAUDE_BIN ?? "claude", "-p", "--safe-mode", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
          "--model", ccModel, "--effort", ccEffort, "--max-budget-usd", "0.50", "--output-format", "stream-json", "--verbose",
          ...(index === 0 ? ["--session-id", ccId] : ["--resume", ccId])];
        const out = await command(argv, probe.text, label);
        const events = out.split("\n").filter(Boolean).map(line => JSON.parse(line));
        const init = events.find(e => e.type === "system" && e.subtype === "init");
        const result = events.find(e => e.type === "result");
        if (result?.subtype !== "success" || result.is_error || result.session_id !== ccId) throw new Error(`CC result unsuccessful; inspect ${label}`);
        const transcript = readFileSync(join(ccProject, `${ccId}.jsonl`), "utf8");
        save(`${label}.native.jsonl`, transcript);
        const history = transcript.split("\n").filter(Boolean).map(line => JSON.parse(line));
        const userTexts = history.filter(e => e.type === "user").map(e => typeof e.message?.content === "string" ? e.message.content : e.message?.content?.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n"));
        assess("cc", probe, result.result ?? "", {
          sameSession: init?.session_id === ccId,
          sonnetResolved: /sonnet/i.test(init?.model ?? ""),
          noTools: !events.some(e => e.type === "assistant" && e.message?.content?.some((p: any) => p.type === "tool_use")),
          exactUserMessage: userTexts.includes(probe.text),
          activationOnce: userTexts.filter((t: string) => t?.includes('<sane-context kind="activation">')).length === 1,
        });
        record({ stage: "cc-result", turn: probe.name, nativeSessionId: ccId, resolvedModel: init?.model, requestedEffort: ccEffort, costUsd: result.total_cost_usd, usage: result.usage });
      }
    }
    if (harnesses.includes("oc")) {
      const created = await api("post", "/api/session", { title: "Disposable user-context behavior experiment", location: { directory: cwd }, agent: "build", model: ocModel, permissions: [{ action: "*", resource: "*", effect: "deny" }] }, "oc-create");
      ocId = created.data.id;
      record({ stage: "oc-created", nativeSessionId: ocId });
      for (const [index, probe] of probes.entries()) {
        charge("oc", probe);
        const label = `oc-${index + 1}-${probe.name}`, messageId = `msg_${randomUUID().replaceAll("-", "")}`;
        const admission = await api("post", `/api/session/${ocId}/prompt`, { id: messageId, text: probe.text }, `${label}.admission`);
        if (admission.data.id !== messageId || admission.data.payload.text !== probe.text) throw new Error("OC exact admission mismatch; do not replay");
        record({ stage: "oc-admitted", turn: probe.name, messageId });
        await api("post", `/api/experimental/session/${ocId}/wait`);
        const history = { data: [] as any[] };
        const seenCursors = new Set<string>();
        let cursor: string | undefined;
        // Cursors denote boundaries even on the last nonempty page. Follow until
        // an empty page, not merely until a cursor is absent; never resend prompts.
        for (let page = 0; ; page++) {
          if (page >= 10) throw new Error("Unexpectedly large experiment history");
          const query = new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : { order: "asc" }) });
          const batch = await api("get", `/api/session/${ocId}/message?${query}`, undefined, `${label}.history-${page}`);
          history.data.push(...batch.data);
          if (!batch.data.length || !batch.cursor.next) break;
          if (seenCursors.has(batch.cursor.next)) throw new Error("Repeated native history cursor");
          cursor = batch.cursor.next;
          seenCursors.add(cursor!);
        }
        save(`${label}.history.json`, history);
        const admittedIndex = history.data.findIndex((m: any) => m.id === messageId && m.type === "user");
        if (admittedIndex < 0) throw new Error("Admitted OC message missing from native history");
        const turn = history.data.slice(admittedIndex + 1);
        if (!turn.some((m: any) => m.type === "idle" && m.outcome === "succeeded")) throw new Error(`OC did not succeed; inspect ${label}`);
        const assistants = turn.filter((m: any) => m.type === "assistant");
        const response = assistants.flatMap((m: any) => m.content.filter((p: any) => p.type === "text").map((p: any) => p.text)).join("\n");
        const entries = await api("get", `/api/experimental/session/${ocId}/instructions/entries`);
        save(`${label}.entries.json`, entries);
        assess("oc", probe, response, {
          exactUserMessage: history.data[admittedIndex].text === probe.text,
          selectedModel: assistants.length > 0 && assistants.every((m: any) => m.model.id === ocModel.id && m.model.providerID === ocModel.providerID && m.model.variant === ocModel.variant),
          noTools: assistants.every((m: any) => !m.content.some((p: any) => p.type === "tool")),
          noSyntheticContext: !history.data.some((m: any) => m.type === "synthetic"),
          noInstructionEntries: Array.isArray(entries.data) && entries.data.length === 0,
          activationOnce: history.data.filter((m: any) => m.type === "user" && m.text.includes('<sane-context kind="activation">')).length === 1,
        });
      }
    }
    complete = true;
  } else {
    record({ stage: "dry-run", note: "No native commands, sessions, or model calls. Inputs only." });
    complete = true;
  }
} catch (error) {
  record({ stage: "failed", error: String(error), noAutomaticReplay: true });
  process.exitCode = 1;
} finally {
  let cleanupFailed = false;
  if (ocId) {
    try {
      await api("post", `/api/session/${ocId}/interrupt`);
      await api("delete", `/api/session/${ocId}`);
      record({ stage: "oc-removed", nativeSessionId: ocId });
    } catch (error) { cleanupFailed = true; record({ stage: "cleanup-failed", error: String(error), nativeSessionId: ocId }); }
  }
  if (!cleanupFailed) {
    rmSync(ccProject, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
    record({ stage: "fixtures-removed", ccProject, fixture });
  } else process.exitCode = 1;
  const failed = results.filter(r => !Object.values(r.checks).every(Boolean));
  if (failed.length) process.exitCode = 1;
  save("responses.md", ["# User-role context behavior experiment", "", `Live: ${live}; complete: ${complete}; submitted turns: ${chargedTurns}/${TURN_BUDGET}.`, "",
    "Response checks are narrow observations, not proof of model consumption, general reliability, workflow execution, or production readiness.", "",
    ...results.flatMap(r => [`## ${r.harness}: ${r.turn}`, "", `Response envelope: ${r.format}.`, "", "~~~~text", r.response, "~~~~", "", ...Object.entries(r.checks).map(([name, passed]) => `- ${passed ? "PASS" : "FAIL"}: ${name}`), ""]),
  ].join("\n"));
  record({ stage: "finished", complete, failedResponses: failed.length });
  console.log(`Evidence: ${runDir}`);
}
