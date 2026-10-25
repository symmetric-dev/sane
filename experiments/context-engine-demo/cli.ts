import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { childEnvironment } from "../../scripts/check-offline";
import type { DemoReplayResult, DemoRunResult } from "./contract";
import { externalFixtureRoot } from "./paths";

const approvedTemp = "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode";
const help = `Mock context-engine demonstrator — no App or native/model calls.

  run [--output /absolute/new-directory]
  replay --manifest /absolute/demo-root/run.json [--json | --html]

run creates an isolated fixture, exercises the engine, and launches a fresh
read-only replay process. replay prints a report or JSON without writing files.
All acceptance in this experiment is SIMULATED HARNESS ACCEPTANCE.
`;

function durableJson(path: string, value: unknown): void {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd); }
  finally { closeSync(fd); }
}

function inventory(root: string): { sha256: string; fileCount: number } {
  const hash = createHash("sha256"); let fileCount = 0;
  const visit = (directory: string, prefix = "") => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry), relative = prefix + entry, stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Unexpected symlink in fixture inventory: ${relative}`);
      if (stat.isDirectory()) visit(path, relative + "/");
      else if (stat.isFile()) {
        hash.update(relative + "\0" + stat.mode + "\0");
        hash.update(readFileSync(path)); hash.update("\0"); fileCount++;
      } else throw new Error(`Unexpected non-file fixture entry: ${relative}`);
    }
  };
  visit(root);
  return { sha256: hash.digest("hex"), fileCount };
}

function options(args: string[]): Map<string, string | true> {
  const result = new Map<string, string | true>();
  for (let at = 0; at < args.length; at++) {
    const key = args[at]!;
    if (!["--output", "--manifest", "--json", "--html"].includes(key) || result.has(key)) throw new Error(`Unknown or repeated option: ${key}`);
    if (key === "--json" || key === "--html") result.set(key, true);
    else {
      const value = args[++at];
      if (!value || value.startsWith("--") || !isAbsolute(value)) throw new Error(`${key} requires an absolute path`);
      result.set(key, value);
    }
  }
  return result;
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "help") { console.log(help); return 0; }
  const flags = options(rest);
  if (command === "replay") {
    if (!flags.has("--manifest") || flags.has("--output") || flags.has("--json") && flags.has("--html")) throw new Error("replay requires --manifest and at most one output format");
    // No fixture/scenario imports on the read-only replay path.
    const { readDemoRun, replayDemoRun } = await import("./replay");
    const result = replayDemoRun(readDemoRun(flags.get("--manifest") as string));
    if (flags.has("--json")) console.log(JSON.stringify(result));
    else {
      const report = await import("./report");
      console.log(flags.has("--html") ? report.renderDemoHtml(result) : report.renderDemoMarkdown(result));
    }
    return result.passed ? 0 : 1;
  }
  if (command !== "run" || [...flags.keys()].some(key => key !== "--output")) throw new Error("Use run [--output /absolute/new-directory] or replay --manifest /absolute/run.json");
  let root: string;
  if (flags.has("--output")) {
    root = externalFixtureRoot(resolve(flags.get("--output") as string), resolve(import.meta.dir, "../.."));
    mkdirSync(root, { mode: 0o700 }); // Never overwrite or reuse an earlier run.
    root = realpathSync(root);
  } else root = realpathSync(mkdtempSync(join(approvedTemp, "context-engine-demo-")));
  console.log(`MOCK ONLY — isolated engine-path demonstration\nFixture root: ${root}`);

  const { createDemoFixture } = await import("./fixture");
  const { runDemoScenarios } = await import("./scenarios");
  const { createDemoReplayVariant } = await import("./journal");
  const fixture = await createDemoFixture(root);
  const original = await runDemoScenarios(fixture);
  const activation = original.scenarios.find(scenario => scenario.id === "activation");
  if (!activation) throw new Error("Missing activation scenario");
  mkdirSync(join(root, "replay-variants"), { mode: 0o700 });
  const replayVariants = (["torn", "missing"] as const).map(id => {
    const directory = join(root, "replay-variants", id);
    createDemoReplayVariant(activation.journalDirectory, directory, id);
    return { id, directory, identity: activation.identity, messageId: activation.messageId, expectedFact: "unknown" as const };
  });
  const run: DemoRunResult = { ...original, replayVariants };
  durableJson(join(root, "run.json"), run);
  const directoryFd = openSync(root, "r");
  try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }

  const before = inventory(root);
  const childCommand = ["--tsconfig-override", join(import.meta.dir, "tsconfig.json"), import.meta.path, "replay", "--manifest", join(root, "run.json"), "--json"];
  const replay = spawnSync(process.execPath, childCommand, {
    cwd: root, env: childEnvironment(process.env), encoding: "utf8", timeout: 120000, maxBuffer: 32 * 1024 * 1024,
  });
  const after = inventory(root);
  const unchanged = before.sha256 === after.sha256 && before.fileCount === after.fileCount;
  writeFileSync(join(root, "replay.stderr.log"), replay.stderr ?? "", { flag: "wx", mode: 0o600 });
  if (replay.error || replay.signal) throw new Error(`Fresh replay did not complete: ${replay.error?.message ?? replay.signal}`);
  const result: DemoReplayResult = JSON.parse(replay.stdout);
  if (result.schema !== 1 || result.type !== "mock-context-demo-replay" || result.simulation !== true || result.root !== root) throw new Error("Fresh replay returned a foreign or unsupported result");
  durableJson(join(root, "replay.json"), result);
  durableJson(join(root, "verification.json"), { schema: 1, simulation: true, replayProcess: "fresh-child", command: [process.execPath, ...childCommand],
    exitCode: replay.status, fixtureBeforeReplay: before, fixtureAfterReplay: after, readOnlyReplay: unchanged, passed: result.passed && replay.status === 0 && unchanged });
  const report = await import("./report");
  writeFileSync(join(root, "REPORT.md"), report.renderDemoMarkdown(result), { flag: "wx", mode: 0o600 });
  writeFileSync(join(root, "REPORT.html"), report.renderDemoHtml(result), { flag: "wx", mode: 0o600 });
  for (const scenario of result.scenarios) console.log(`${scenario.checks.every(check => check.passed) ? "PASS" : "FAIL"} ${scenario.scenario.id}: ${scenario.projection.fact}; mock sends=${scenario.scenario.mockSends}; context loads=${scenario.scenario.contextLoads}`);
  for (const variant of result.variants) console.log(`${variant.checks.every(check => check.passed) ? "PASS" : "FAIL"} replay-${variant.id}: ${variant.projection.fact} (${variant.projection.coverage.state})`);
  console.log(`Fresh replay left fixture files unchanged: ${unchanged}\nReport: ${join(root, "REPORT.md")}\nHTML: ${join(root, "REPORT.html")}\nNo App, native harness, or model provider was invoked.`);
  return result.passed && replay.status === 0 && unchanged ? 0 : 1;
}

if (import.meta.main) main().then(code => { process.exitCode = code; }).catch(error => { console.error(error); process.exitCode = 1; });
