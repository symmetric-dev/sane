/** Deterministic context checks only. `bun scripts/check-context-evidence.ts /absolute/output [--focused]`.
 * Writes JSON evidence and separate stdout/stderr logs; never enables live suites.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const output = process.argv[2];
if (!output || !isAbsolute(output)) throw new Error("Supply an absolute evidence output directory");
if (process.argv.slice(3).some(arg => arg !== "--focused")) throw new Error("Only --focused is supported");
const focused = process.argv.includes("--focused");
const fixtureEnv = { ...process.env };
// OpenCode's shell harness injects native caller qualification. Offline fixtures
// must establish their own identities instead of inheriting the real caller.
delete fixtureEnv.SANE_CALLER_CONTEXT;
delete fixtureEnv.SANE_SESSION_ID;
delete fixtureEnv.OPENCODE_SESSION_ID;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runId = crypto.randomUUID();
mkdirSync(output, { recursive: true });
const capture = join(output, "captures");
const files = [
  "src/claude-run-service.test.ts", "src/opencode-run-service.test.ts", "src/native-context-entry.test.ts",
  "tests/native-live-gate.test.ts", "tests/startup-primitives.test.ts", "tests/agent-profiles.test.ts",
  "tests/compaction.test.ts", "tests/compaction-bridge.test.ts", "tests/bridge-runtime.test.ts",
];
const checks: { file: string; command: string[]; exitCode: number; durationMs: number; stdout: string; stderr: string; passed: number | null; failed: number | null }[] = [];
for (const file of files) {
  const command = [process.execPath, "test", `packages/sane-app/${file}`, "--no-orphans", "--bail=1"];
  if (focused && file === "tests/bridge-runtime.test.ts") command.push("--test-name-pattern", "canonical bridge");
  const started = Date.now();
  const name = file.replaceAll("/", "-");
  // Stream directly to durable files so interrupted long checks retain evidence.
  const child = Bun.spawn(command, { cwd: root, env: { ...fixtureEnv, SANE_RUN_LIVE_NATIVE_TESTS: "", SANE_MOCK_CONTEXT_EVIDENCE_DIR: capture, SANE_MOCK_CONTEXT_EVIDENCE_RUN_ID: runId, SANE_BRIDGE_TEST_PROGRESS: join(output, "bridge-progress.jsonl") }, stdout: Bun.file(join(output, `${name}.stdout.log`)), stderr: Bun.file(join(output, `${name}.stderr.log`)) });
  const exitCode = await child.exited;
  const log = readFileSync(join(output, `${name}.stderr.log`), "utf8");
  const count = (kind: string) => { const match = new RegExp(`(\\d+) ${kind}`).exec(log); return match ? Number(match[1]) : null; };
  const failed = count("fail") ?? (log.match(/^\(fail\)/gm)?.length ?? null);
  const ran = /Ran (\d+) tests?/.exec(log);
  const passed = count("pass") ?? (log.includes("Bailed out after") && ran && failed !== null ? Number(ran[1]) - failed : null);
  checks.push({ file, command, exitCode, durationMs: Date.now() - started, stdout: `${name}.stdout.log`, stderr: `${name}.stderr.log`, passed, failed });
  console.log(`${exitCode === 0 ? "PASS" : "FAIL"} ${file}`);
  writeFileSync(join(output, "checks.json"), JSON.stringify({ schema: 1, runId, evidenceKind: "deterministic-mock", realModelInvoked: false, root, captureDirectory: "captures", checks, complete: checks.length === files.length }, null, 2) + "\n");
}
writeFileSync(join(output, "REPORT.md"), [
  "# Deterministic context verification", "",
  `Run: \`${runId}\``, "",
  "No paid models or real harnesses were invoked. Failed files stop at their first failure; subsequent files still run.", "",
  "| Check | Pass | Fail | Exit | Log |", "| --- | ---: | ---: | ---: | --- |",
  ...checks.map(c => `| ${c.file} | ${c.passed ?? "unknown"} | ${c.failed ?? "unknown"} | ${c.exitCode} | [stderr](${c.stderr}) |`), "",
  `Executed assertions' test outcomes: ${checks.reduce((n, c) => n + (c.passed ?? 0), 0)} passed; ${checks.reduce((n, c) => n + (c.failed ?? 0), 0)} failed.`, "",
  "Machine-readable commands/results: [checks.json](checks.json). Exact mock context, source hashes, bindings, argv/files and receipts: captures/*.json. Match capture runId to this report. Bridge test start/finish trace: bridge-progress.jsonl.", "",
].join("\n"));
process.exitCode = checks.some(check => check.exitCode !== 0) ? 1 : 0;
