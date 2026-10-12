/** Offline Bun checks, isolated per file.
 * bun scripts/check-offline.ts [--output /absolute/new-directory] [--filter substring]
 * [--file-timeout-ms 1200000] [--capture]
 * Exit: 0 passed, 1 completed with failures, 2 incomplete. No parallel children.
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testPattern = /\.(test|spec)\.(ts|tsx|js)$/;
const livePattern = /(?:^|\/)(?:native-handoff|native-recovery|agent-session-smoke)\.(?:test|spec)\.(?:ts|tsx|js)$|\.integration\.test\.(?:ts|tsx|js)$/;

export function selectTests(listing: string, filter = "") {
  const files = [...new Set(listing.split("\0").filter(file => testPattern.test(file)))].sort();
  return {
    selected: files.filter(file => !livePattern.test(file) && file.includes(filter)),
    excluded: files.filter(file => livePattern.test(file)),
    filtered: files.filter(file => !livePattern.test(file) && !file.includes(filter)),
  };
}

export function childEnvironment(source: NodeJS.ProcessEnv, capture?: { directory: string; runId: string }) {
  const env = { ...source };
  for (const name of Object.keys(env)) {
    if (/^(SANE_CALLER_CONTEXT|SANE_SESSION_ID|OPENCODE_SESSION_ID|AGENT_LIVE)$/.test(name)
      || /^(CC_WEB_|SANE_RUN_LIVE|SANE_ARM_|SANE_NATIVE_CAPTURE|SANE_MOCK_CONTEXT_EVIDENCE|SANE_BRIDGE_TEST_PROGRESS|NATIVE_)/.test(name)
      || /(?:^|_)(?:LIVE|ARMED|ARMING)(?:_|$)/.test(name)) delete env[name];
  }
  env.NO_COLOR = "1";
  env.FORCE_COLOR = "0";
  if (capture) {
    env.SANE_MOCK_CONTEXT_EVIDENCE_DIR = capture.directory;
    env.SANE_MOCK_CONTEXT_EVIDENCE_RUN_ID = capture.runId;
  }
  return env;
}

/** Bun prints its summary to stderr, including a shortened summary on --bail. */
export function parseSummary(text: string, junit?: string) {
  const clean = text.replace(/\u001b\[[0-9;]*m/g, "");
  const ranMatches = [...clean.matchAll(/^Ran (\d+) tests? across (\d+) files?\b/gm)];
  const ranMatch = ranMatches.at(-1);
  const count = (label: string) => {
    const matches = [...clean.matchAll(new RegExp(`^\\s*(\\d+) ${label}\\s*$`, "gm"))];
    return matches.length ? Number(matches.at(-1)![1]) : null;
  };
  const ran = ranMatch ? Number(ranMatch[1]) : null;
  if (junit) {
    const header = /<testsuites\s[^>]*>/.exec(junit)?.[0] ?? "";
    const attr = (name: string) => {
      const match = new RegExp(`\\b${name}="(\\d+)"`).exec(header);
      return match ? Number(match[1]) : null;
    };
    const total = attr("tests");
    const failed = attr("failures");
    const allSkipped = attr("skipped");
    const todo = [...junit.matchAll(/<skipped\s+message="TODO"\s*\/>/g)].length;
    const skipped = allSkipped === null ? 0 : allSkipped - todo;
    const passed = total !== null && failed !== null && allSkipped !== null ? total - failed - allSkipped : null;
    const valid = ran !== null && ran > 0 && ran === total && Number(ranMatch?.[2]) === 1
      && passed !== null && passed >= 0 && skipped >= 0 && /<\/testsuites>\s*$/.test(junit);
    return { passed, failed, skipped, todo, ran, valid };
  }
  const bailed = /^Bailed out after \d+ failures?\s*$/m.test(clean);
  const eventCount = (label: string) => [...clean.matchAll(new RegExp(`^\\(${label}\\) `, "gm"))].length;
  const failed = count("fail") ?? (bailed ? eventCount("fail") : null);
  const skipped = count("skip") ?? (bailed ? eventCount("skip") : 0);
  const todo = count("todo") ?? (bailed ? eventCount("todo") : 0);
  let passed = count("pass");
  // Bun's bail summary can omit the pass line. Only infer with an actual footer.
  if (passed === null && ran !== null && failed !== null
    && eventCount("pass") + eventCount("fail") + eventCount("skip") + eventCount("todo") === ran) passed = ran - failed - skipped - todo;
  const valid = ran !== null && ran > 0 && passed !== null && passed >= 0 && failed !== null
    && passed + failed + skipped + todo === ran && Number(ranMatch?.[2]) === 1;
  return { passed, failed, skipped, todo, ran, valid };
}

function git(args: string[], cwd = root): Buffer {
  const result = spawnSync("git", args, { cwd, maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr?.toString()}`);
  return result.stdout;
}

export function discoverTests(cwd = root, filter = "") {
  return selectTests(git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd).toString(), filter);
}

function fingerprint(output: string) {
  const listing = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).toString();
  const files = [...new Set(listing.split("\0").filter(Boolean))].sort().filter(file => {
    const rel = relative(output, join(root, file));
    return rel === ".." || rel.startsWith("../") || isAbsolute(rel);
  });
  const hash = createHash("sha256");
  for (const file of files) {
    const path = join(root, file);
    hash.update(`${file}\0`);
    if (!existsSync(path)) { hash.update("deleted\0"); continue; }
    const stat = lstatSync(path);
    hash.update(`${stat.mode}\0`);
    if (stat.isSymbolicLink()) hash.update(readlinkSync(path));
    else if (stat.isFile()) hash.update(readFileSync(path));
    else hash.update("directory");
    hash.update("\0");
  }
  return {
    revision: git(["rev-parse", "HEAD"]).toString().trim(),
    diffSha256: createHash("sha256").update(git(["diff", "HEAD", "--binary", "--no-ext-diff"])).digest("hex"),
    sourceSha256: hash.digest("hex"), fileCount: files.length,
  };
}

export async function main(args = process.argv.slice(2)) {
  const runId = randomUUID();
  let output = join(root, ".verification", "offline", `${new Date().toISOString().replaceAll(":", "-")}-${runId}`);
  let filter = "";
  let timeoutMs = 20 * 60 * 1000;
  let capture = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--capture") { capture = true; continue; }
    if (!["--output", "--filter", "--file-timeout-ms"].includes(arg!)) throw new Error(`Unknown option: ${arg}`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    if (arg === "--output") { if (!isAbsolute(value)) throw new Error("--output must be absolute"); output = resolve(value); }
    if (arg === "--filter") filter = value;
    if (arg === "--file-timeout-ms") {
      timeoutMs = Number(value);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new Error("Invalid file timeout");
    }
  }
  if (existsSync(output)) throw new Error(`Output must be a new directory: ${output}`);
  mkdirSync(output, { recursive: true });
  if (capture) mkdirSync(join(output, "captures"));
  const discovery = discoverTests(root, filter);
  const startSource = fingerprint(output);
  type Check = {
    file: string; command: string[]; startedAt: string; durationMs?: number;
    stdout: string; stderr: string; junit: string; exitCode?: number | null; signal?: string | null;
    status: "running" | "passed" | "failed" | "incomplete"; reason?: string;
    counts?: ReturnType<typeof parseSummary>;
  };
  const checks: Check[] = [];
  const evidence = {
    schema: 1, runId, kind: "offline-per-file", root, output, filter, timeoutMs,
    startedAt: new Date().toISOString(), finishedAt: null as string | null,
    complete: false, status: "running", reasons: [] as string[],
    source: { start: startSource, end: null as ReturnType<typeof fingerprint> | null, unchanged: false },
    captureDirectory: capture ? "captures" : null,
    discovery, checks,
    totals: { filesPassed: 0, filesFailed: 0, filesIncomplete: 0, filesPending: discovery.selected.length, passed: 0, failed: 0, skipped: 0, todo: 0 },
  };
  const save = () => {
    evidence.totals = {
      filesPassed: checks.filter(c => c.status === "passed").length,
      filesFailed: checks.filter(c => c.status === "failed").length,
      filesIncomplete: checks.filter(c => c.status === "incomplete").length,
      filesPending: discovery.selected.length - checks.filter(c => c.status !== "running").length,
      passed: checks.reduce((n, c) => n + (c.counts?.passed ?? 0), 0),
      failed: checks.reduce((n, c) => n + (c.counts?.failed ?? 0), 0),
      skipped: checks.reduce((n, c) => n + (c.counts?.skipped ?? 0), 0),
      todo: checks.reduce((n, c) => n + (c.counts?.todo ?? 0), 0),
    };
    writeFileSync(join(output, "checks.json.tmp"), JSON.stringify(evidence, null, 2) + "\n");
    renameSync(join(output, "checks.json.tmp"), join(output, "checks.json"));
  };
  let interrupted: string | null = null;
  let terminate: (() => void) | undefined;
  const onSignal = (signal: string) => {
    interrupted = signal;
    evidence.reasons.push(`Interrupted by ${signal}`);
    save();
    terminate?.();
  };
  const onInt = () => onSignal("SIGINT");
  const onTerm = () => onSignal("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  save();
  console.log(`Offline evidence: ${output} (${discovery.selected.length} files)`);
  try {
    for (const file of discovery.selected) {
      if (interrupted) break;
      const logName = `${String(checks.length + 1).padStart(4, "0")}-${file.replaceAll(/[^a-zA-Z0-9._-]/g, "_")}`;
      const junit = `${logName}.junit.xml`;
      const command = [process.execPath, "test", `./${file}`, "--no-orphans", "--bail=1", "--timeout", "20000", "--reporter=junit", "--reporter-outfile", join(output, junit)];
      const check: Check = { file, command, startedAt: new Date().toISOString(), stdout: `${logName}.stdout.log`, stderr: `${logName}.stderr.log`, junit, status: "running" };
      checks.push(check);
      save();
      const started = Date.now();
      const stdout = openSync(join(output, check.stdout), "w");
      const stderr = openSync(join(output, check.stderr), "w");
      let timedOut = false;
      let spawnError: string | undefined;
      try {
        const child = spawn(command[0]!, command.slice(1), {
          cwd: root, env: childEnvironment(process.env, capture ? { directory: join(output, "captures"), runId } : undefined),
          detached: true, stdio: ["ignore", stdout, stderr],
        });
        let escalation: ReturnType<typeof setTimeout> | undefined;
        const killGroup = (signal: NodeJS.Signals) => {
          if (!child.pid) return;
          try { process.kill(-child.pid, signal); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") spawnError = String(error);
          }
        };
        terminate = () => { killGroup("SIGTERM"); escalation ??= setTimeout(() => killGroup("SIGKILL"), 2000); };
        const timer = setTimeout(() => { timedOut = true; terminate?.(); }, timeoutMs);
        await new Promise<void>(done => {
          child.once("error", error => { spawnError = String(error); done(); });
          child.once("close", (code, signal) => { check.exitCode = code; check.signal = signal; done(); });
        });
        clearTimeout(timer);
        if (escalation) clearTimeout(escalation);
        // Only this runner's dedicated process group; never kill by process name.
        killGroup("SIGKILL");
      } finally { terminate = undefined; closeSync(stdout); closeSync(stderr); }
      check.durationMs = Date.now() - started;
      check.counts = parseSummary(readFileSync(join(output, check.stderr), "utf8"), existsSync(join(output, junit)) ? readFileSync(join(output, junit), "utf8") : undefined);
      if (interrupted || timedOut || spawnError || check.signal) {
        check.status = "incomplete";
        check.reason = interrupted ? `Interrupted: ${interrupted}` : timedOut ? `File timeout (${timeoutMs}ms)` : spawnError ?? `Signal: ${check.signal}`;
      } else if (check.exitCode !== 0 || (check.counts.failed ?? 0) > 0) check.status = "failed";
      else if (!check.counts.valid || !check.counts.passed) {
        check.status = "incomplete";
        check.reason = "No trustworthy nonzero passing test summary";
      } else check.status = "passed";
      save();
      console.log(`${check.status.toUpperCase()} ${file} (${check.durationMs}ms)`);
    }
  } catch (error) {
    evidence.reasons.push(String(error));
  } finally {
    try {
      evidence.source.end = fingerprint(output);
      evidence.source.unchanged = JSON.stringify(startSource) === JSON.stringify(evidence.source.end);
      if (!evidence.source.unchanged) evidence.reasons.push("Source changed during checks; rerun on stable source");
    } catch (error) { evidence.reasons.push(`Final fingerprint failed: ${error}`); }
    if (!discovery.selected.length) evidence.reasons.push("No test files selected");
    if (checks.some(c => c.status === "incomplete" || c.status === "running")) evidence.reasons.push("One or more checks incomplete");
    if (checks.length !== discovery.selected.length) evidence.reasons.push("Not all selected files executed");
    evidence.complete = evidence.reasons.length === 0;
    evidence.status = !evidence.complete ? "incomplete" : checks.some(c => c.status === "failed") ? "failed" : "passed";
    evidence.finishedAt = new Date().toISOString();
    save();
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
  }
  console.log(`${evidence.status.toUpperCase()}: ${JSON.stringify(evidence.totals)}\n${join(output, "checks.json")}`);
  return evidence.status === "passed" ? 0 : evidence.status === "failed" ? 1 : 2;
}

if (import.meta.main) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(error); process.exitCode = 2; });
}
