/** Focused OFFLINE shared-context/receipt checks. No dependency installation or native discovery.
 * bun reports/context-message-cutover-2026-10-26/verify.ts
 *   --dependency-root /checkout/with/installed/dependencies --output /absolute/new-directory
 * Omitting dependency-root uses this checkout. Outputs must be a new directory.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { childEnvironment } from "../../scripts/check-offline";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
function option(name: string, fallback: string) { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1] ?? (() => { throw new Error(`Missing ${name}`); })(); }
if (args.some((arg, i) => i % 2 === 0 && !["--dependency-root", "--output"].includes(arg))) throw new Error("Unknown verification option");
const dependencies = resolve(option("--dependency-root", root));
const output = option("--output", join(import.meta.dir, "verification"));
if (!isAbsolute(output) || existsSync(output)) throw new Error("Verification output must be an absolute new directory");
const compiler = join(dependencies, "node_modules/typescript/lib/typescript.js");
if (!existsSync(compiler)) throw new Error("Install repository dependencies separately, or supply --dependency-root pointing at an already-installed checkout; no installation was attempted");
const ts = (await import(pathToFileURL(compiler).href)).default;
function clientExport(name: "." | "./service") {
  for (const directory of [join(dependencies, "packages/sane-app/node_modules/@opencode/client"), join(dependencies, "node_modules/@opencode/client")]) {
    if (!existsSync(join(directory, "package.json"))) continue;
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")), entry = manifest.exports?.[name];
    const imported = typeof entry === "string" ? entry : entry?.import;
    if (typeof imported !== "string") throw new Error(`Unsupported installed client import export: ${name}`);
    return resolve(directory, imported);
  }
  throw new Error("The supplied dependency checkout has no installed @opencode/client package");
}
const client = clientExport("."), service = clientExport("./service");
mkdirSync(output, { mode: 0o700 });
const tsconfig = join(output, "test-tsconfig.json");
writeFileSync(tsconfig, JSON.stringify({ compilerOptions: { baseUrl: root, paths: {
  "sane-core/*": ["packages/sane-core/src/*"], "sane-science": ["packages/sane-science/src/index.ts"],
  "@opencode/client": [client], "@opencode/client/service": [service],
} } }, null, 2) + "\n", { flag: "wx" });
const prior = JSON.parse(readFileSync(join(root, "reports/context-activation-durability-2026-10-25/checks.json"), "utf8"));
const names = ["agent-launch.ts", "agent-launch-assignment.test.ts", "claude-run-service.ts", "claude-run-service-context.test.ts", "opencode.ts", "opencode-run-service.ts", "opencode-context-transport.test.ts",
  "context-message-transport.ts", "context-message-owner.ts", "context-message-owner.test.ts", "context-message-activation.ts", "context-message-activation.test.ts", "context-message-reader.ts", "context-message-reader.test.ts",
  "context-message-source.ts", "context-message-source.test.ts", "context-message-native.ts", "context-message-native.test.ts", "context-message-integration.test.ts", "harness-dispatch.ts", "harness-dispatch-context.test.ts",
  "science-submission-store.ts", "science-submission-context.test.ts", "dispatch-run.test.ts",
  "owned-message-preparation.ts", "owned-message-preparation.test.ts", "execution-preparation-service.ts", "session-context-source.ts", "dispatch-source.ts", "dispatch-context-binding.ts",
  "run-submission-preparation.ts", "run-submission-timing.ts", "submission-timing-archive.ts", "app-admission-feature.ts", "app-admission-service.ts", "app-admission-service.test.ts", "app-admission-store.ts", "native-runtime-selection.test.ts",
  "agent-profile-routes.ts", "asset-routes.ts", "browser-pair-routes.ts", "conversation-evidence-routes.ts", "session-catalog-routes.ts", "terminal-routes.ts", "workspace-routes.ts", "workstream-routes.ts"];
const frontend = ["app.tsx", "browser-pair-dialog.tsx", "cc-client.ts", "chat-composer.tsx", "chat-status.ts", "composer-status.tsx", "document-review-model.ts", "store.ts", "transcript.ts", "types.ts",
  "app-admission-ledger.ts", "app-admission-recovery.ts", "app-admission-recovery-panel.tsx", "composer-lineage.ts", "sane-context-client.ts", "sane-context.tsx"];
const entries: string[] = [...new Set([...Object.keys(prior.sourceSha256).filter(path => path !== "packages/sane-app/src/bridge.ts"), ...names.map(name => `packages/sane-app/src/${name}`),
  ...frontend.map(name => `packages/sane-app/frontend/${name}`), "packages/sane-app/shared/conversation/app-admission-contract.ts",
  "opencode/plugins/sane/execution.ts", "opencode/plugins/sane/execution-rpc.ts", "packages/sane-cli/src/install-sane-agent-context-packages.ts"])];
const tests = entries.filter(path => path.endsWith(".test.ts"));
function command(label: string, command: string[]) {
  const result = spawnSync(command[0]!, command.slice(1), { cwd: root, env: childEnvironment(process.env), encoding: "utf8", timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  writeFileSync(join(output, `${label}.stdout.log`), result.stdout ?? "", { flag: "wx" });
  writeFileSync(join(output, `${label}.stderr.log`), result.stderr ?? "", { flag: "wx" });
  return { command, exitCode: result.status, signal: result.signal, error: result.error?.message ?? null, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
const test = command("tests", [process.execPath, "test", "--tsconfig-override", tsconfig, ...tests.map(path => `./${path}`), "--timeout", "10000", "--reporter=junit", "--reporter-outfile", join(output, "tests.junit.xml")]);
console.log(test.stdout); console.error(test.stderr);
const options = { noEmit: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, skipLibCheck: true, allowImportingTsExtensions: true,
  jsx: ts.JsxEmit.ReactJSX, baseUrl: root, paths: { "sane-core/*": ["packages/sane-core/src/*"], "sane-science": ["packages/sane-science/src/index.ts"] },
  types: ["bun"], typeRoots: [join(dependencies, "node_modules/@types"), join(dependencies, "packages/sane-app/node_modules/@types")] };
function check(paths: string[], overlay = new Map<string, string>()) {
  const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
  host.getSourceFile = (file: string, language: any, onError: any, fresh: any) => overlay.has(file)
    ? ts.createSourceFile(file, overlay.get(file)!, language, true) : original(file, language, onError, fresh);
  host.resolveModuleNames = (names: string[], file: string) => names.map(name => {
    // JSX and cached UI declarations must share the selected dependency tree's
    // React identity, rather than mixing branded Ref types from two installs.
    if (/^(react|react-dom)(\/|$)/.test(name)) {
      const selected = ts.resolveModuleName(name, join(dependencies, "packages/sane-app/typecheck.ts"), options, host).resolvedModule;
      if (selected) return selected;
    }
    return ts.resolveModuleName(name, file, options, host).resolvedModule ??
      (!name.startsWith(".") && file.startsWith(root + "/") ? ts.resolveModuleName(name, dependencies + file.slice(root.length), options, host).resolvedModule : undefined);
  });
  const program = ts.createProgram(paths.map(path => resolve(root, path)), options, host);
  return ts.getPreEmitDiagnostics(program).map((diagnostic: any) => ({ file: diagnostic.file?.fileName.replace(root + "/", ""), start: diagnostic.start,
    code: diagnostic.code, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n") }));
}
const scoped = check(entries);
const changed = command("tracked-changes", ["git", "diff", "--name-only", "HEAD", "--", "packages/sane-app/src"]);
if (changed.exitCode !== 0) throw new Error("Could not inspect committed baseline paths");
const overlay = new Map<string, string>();
for (const path of changed.stdout.trim().split("\n").filter(path => path.endsWith(".ts"))) {
  const result = spawnSync("git", ["show", `HEAD:${path}`], { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Could not read committed baseline: ${path}`);
  overlay.set(resolve(root, path), result.stdout);
}
const baseline = check(["packages/sane-app/src/bridge.ts"], overlay), current = check(["packages/sane-app/src/bridge.ts"]);
const unchangedDiagnostics = JSON.stringify(baseline) === JSON.stringify(current);
writeFileSync(join(output, "bridge-typecheck.json"), JSON.stringify({ method: "All changed tracked App source files substituted from committed HEAD through compiler host; no working files changed.", substituted: [...overlay.keys()].map(path => path.replace(root + "/", "")), baseline, current, unchangedDiagnostics }, null, 2) + "\n", { flag: "wx" });
const sha = (path: string) => createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
const junit = existsSync(join(output, "tests.junit.xml")) ? readFileSync(join(output, "tests.junit.xml"), "utf8") : "";
const checks = { scope: "shared user-context, submission coordination and receipt modules; selected offline regressions and scoped static checks only; native effects and history simulated", dependencyRoot: dependencies,
  test: { command: test.command, exitCode: test.exitCode, signal: test.signal, error: test.error }, testFiles: tests.length, testSummary: /<testsuites\s[^>]*>/.exec(junit)?.[0] ?? null,
  scopedTypecheck: { entries: entries.length, diagnostics: scoped }, extendedBridgeTypecheck: { unchangedDiagnostics, baselineCount: baseline.length, currentCount: current.length },
  sourceSha256: Object.fromEntries([...entries, "packages/sane-app/src/bridge.ts"].map(path => [path, sha(path)])),
  passed: test.exitCode === 0 && !test.error && !test.signal && scoped.length === 0 && unchangedDiagnostics };
writeFileSync(join(output, "checks.json"), JSON.stringify(checks, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ passed: checks.passed, testFiles: tests.length, typecheckEntries: entries.length, scopedDiagnostics: scoped, extendedBridgeTypecheck: checks.extendedBridgeTypecheck, testSummary: checks.testSummary }, null, 2));
process.exitCode = checks.passed ? 0 : 1;
