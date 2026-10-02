/** Offline HTTP regression: test-owned installation/assets/store, fake CLI only.
 * No build, managed service, real Claude executable, or model is invoked.
 * The empty fake Claude profile deliberately makes optional transcript refresh
 * fail locally before SDK history reads; stdout boundaries remain authoritative.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { start, type Options } from "../src/bridge";
import { initializeAppStore } from "../src/app-store";
import { acquireData, acquireInstallation, validateOwnershipPaths, type OwnershipHandle } from "../src/installation-ownership";

const TEMP = "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode";
const TIMEOUT = 30000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const savedEnv = new Map<string, string | undefined>();
let root = "", dataDir = "", repoDir = "", log = "", sessionId = "";
let options: Options;
let app: Awaited<ReturnType<typeof start>> | undefined;

/** Supply a tiny validated static generation, not a compiled frontend. Keeping
 * its input closure within this isolated installation avoids live-package locks
 * and avoids depending on a prior build being fresh. */
function fixtureAssets(packageDir: string) {
  const files = { "bun.lock": "", "public/index.html": "<!doctype html><html><body>offline fixture</body></html>" };
  mkdirSync(join(packageDir, "public"), { recursive: true });
  for (const [name, value] of Object.entries(files)) writeFileSync(join(packageDir, name), value);
  const recipe = { version: 1, target: "browser", format: "esm", naming: "app.[ext]", minify: true, define: { "process.env.NODE_ENV": '"production"' } };
  const inputs = Object.fromEntries(Object.entries({ ...Object.fromEntries(Object.entries(files).map(([name, value]) => [name, hash(value)])), $recipe: hash(JSON.stringify(recipe)), $bun: hash(Bun.version) }).sort(([a], [b]) => a.localeCompare(b)));
  const generation = crypto.randomUUID(), assets = join(packageDir, "public", "assets"), dir = join(assets, generation), js = "// offline fixture\n";
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "app.js"), js);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ format: "sane-app-assets", version: 1, generation, fingerprint: hash(JSON.stringify(inputs)), inputs, outputs: { "app.js": hash(js) } }));
  writeFileSync(join(assets, "current.json"), JSON.stringify({ format: "sane-app-assets-current", version: 1, generation }));
}

async function api(path: string, data?: unknown, method = data === undefined ? "GET" : "POST") {
  const res = await fetch(`${app!.origin}${path}`, { method, headers: { "content-type": "application/json", origin: app!.origin }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}), redirect: "error" });
  return { status: res.status, body: await res.json() as any };
}
function invocations(): { args: string[]; prompt: string; cwd: string }[] {
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];
const disk = (name: string) => JSON.parse(readFileSync(join(dataDir, name), "utf8"));
async function waitIdle() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const session = (await api("/api/sessions")).body.sessions.find((s: any) => s.sessionId === sessionId);
    if (session?.lastStatus !== "running" && session?.availability?.canSend) return session;
    await Bun.sleep(25);
  }
  throw new Error("fake CLI session did not become idle");
}

describe.serial("compaction bridge (isolated installation, offline fake Claude CLI)", () => {
  beforeAll(async () => {
    for (const name of Object.keys(process.env).filter(name => /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_API_KEY|CLAUDE_CODE_BASE_URL|CLAUDE_CODE_CUSTOM_MODEL_OPTION|AWS_BEARER_TOKEN_BEDROCK|OPENAI_API_KEY|OPENAI_BASE_URL)/.test(name)).concat(["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_PROJECT_DIR_NAME", "SANE_APP_PASSWORD"])) {
      savedEnv.set(name, process.env[name]); delete process.env[name];
    }
    root = realpathSync(mkdtempSync(join(TEMP, "compaction-bridge-")));
    const packageDir = join(root, "installation"), profileRoot = join(root, "claude-profile");
    dataDir = join(root, "appdata"); repoDir = join(root, "repo"); log = join(root, "invocations.jsonl");
    fixtureAssets(packageDir);
    mkdirSync(repoDir); mkdirSync(join(profileRoot, "sane-agent-settings"), { recursive: true }); mkdirSync(join(root, "oc"));
    process.env.CLAUDE_CONFIG_DIR = profileRoot;
    writeFileSync(join(profileRoot, "sane-agent-settings", "sane-assistant-engineering.settings.json"), JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }));
    const git = Bun.spawn(["git", "init", repoDir], { stdout: "ignore", stderr: "ignore" });
    if (await git.exited !== 0) throw new Error("fixture git init failed");
    const stub = join(root, "claude-stub.mjs");
    writeFileSync(stub, [
      `#!${process.execPath}`,
      `import { appendFileSync } from "node:fs";`,
      `const args = process.argv.slice(2), prompt = await Bun.stdin.text();`,
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, prompt, cwd: process.cwd() }) + "\\n");`,
      `const i = args.findIndex(a => a === "--session-id" || a === "--resume"), session_id = args[i + 1];`,
      `console.log(JSON.stringify({ type: "system", subtype: "init", session_id }));`,
      `if (prompt.startsWith("/compact")) console.log(JSON.stringify({ type: "system", subtype: "compact_boundary", session_id, uuid: crypto.randomUUID(), compact_metadata: { trigger: "manual", pre_tokens: 90000, post_tokens: 12000 } }));`,
      `console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id, result: "fixture OK" }));`,
      "",
    ].join("\n")); chmodSync(stub, 0o755);
    options = { host: "127.0.0.1", port: 0, cwd: repoDir, dataDir, claudeBin: stub, packageDir, noBuild: true, allowRemote: false, reconcileInterrupted: false, nativeSources: { cc: { version: 1, harness: "cc", kind: "local-profile", profileRoot }, oc: { version: 1, harness: "oc", kind: "local-registration", registrationFile: join(root, "oc", "missing-service.json") } } };
    const installation = acquireInstallation(validateOwnershipPaths(packageDir, dataDir), { phase: "setup" });
    let data: OwnershipHandle | undefined;
    try { data = acquireData(installation, { phase: "setup", createDataParent: true }); initializeAppStore(dataDir, options.nativeSources); }
    finally { try { data?.release(); } finally { installation.release(); } }
    app = await start(options);
    expect((await api("/api/agents/template:engineering", { model: "opus", effort: "high" }, "PUT")).status).toBe(200);
    const created = await api("/api/sessions", { prompt: "offline seed turn", cwd: repoDir, profileId: "template:engineering" });
    expect(created.status).toBe(202); sessionId = created.body.sessionId; await waitIdle();
  }, TIMEOUT);

  afterAll(async () => {
    try { await app?.close(); } finally {
      for (const [name, value] of savedEnv) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
      if (root) rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT);

  test("GET observes eligibility without launching native execution or creating a run", async () => {
    const before = disk("metadata.json"), launches = invocations().length;
    for (let i = 0; i < 2; i++) {
      const state = await api(`/api/sessions/${sessionId}/compact`);
      expect(state.status).toBe(200); expect(state.body).toMatchObject({ sessionId, eligibility: { eligible: true, supportsInstructions: true }, operations: [] });
    }
    expect(invocations()).toHaveLength(launches); expect(disk("metadata.json")).toEqual(before);
  }, TIMEOUT);

  test("POST resumes the same native identity and pins as a compact-only operation; repeated UUID/conflict never redispatch", async () => {
    const before = disk("metadata.json").sessions.find((s: any) => s.sessionId === sessionId), admissions = disk("admissions.json"), launches = invocations().length;
    // Profile edits and supplied acknowledgement cannot upgrade the conversation.
    expect((await api("/api/agents/template:engineering", { model: "sonnet", effort: "low" }, "PUT")).status).toBe(200);
    const input = { requestId: crypto.randomUUID(), instructions: "retain architecture\nand open TODOs", nativeStopped: true };
    const accepted = await api(`/api/sessions/${sessionId}/compact`, input);
    expect(accepted.status).toBe(202);
    const repeat = await api(`/api/sessions/${sessionId}/compact`, input);
    expect([200, 202]).toContain(repeat.status); expect(repeat.body.runId).toBe(accepted.body.runId);
    expect((await api(`/api/sessions/${sessionId}/compact`, { ...input, instructions: "different" })).status).toBe(409);
    await waitIdle();
    const recovered = await api(`/api/sessions/${sessionId}/compact`, input);
    expect(recovered.body).toMatchObject({ runId: accepted.body.runId, operation: { requestId: input.requestId, lifecycle: "completed", contextReset: true } });
    expect(invocations()).toHaveLength(launches + 1);
    const invocation = invocations().at(-1)!;
    expect(invocation.prompt).toBe(`/compact ${input.instructions}`); expect(invocation.cwd).toBe(repoDir);
    expect(flag(invocation.args, "--resume")).toBe(before.nativeSessionId); expect(invocation.args).not.toContain("--session-id");
    expect(flag(invocation.args, "--agent")).toBe("sane-assistant-engineering"); expect(flag(invocation.args, "--model")).toBe("opus"); expect(flag(invocation.args, "--effort")).toBe("high");
    const metadata = disk("metadata.json"), compact = metadata.runs.find((r: any) => r.runId === accepted.body.runId);
    expect(compact).toMatchObject({ operation: "compact", cwd: repoDir, profileId: before.profileId, agent: before.agent, model: before.model, effort: before.effort, compact: { requestId: input.requestId, instructions: input.instructions } });
    expect(metadata.sessions.find((s: any) => s.sessionId === sessionId)).toMatchObject({ nativeSessionId: before.nativeSessionId, authorityId: before.authorityId, cwd: before.cwd, agent: before.agent, model: before.model, effort: before.effort, profileId: before.profileId });
    expect(disk("admissions.json")).toEqual(admissions);
    const events = readFileSync(join(dataDir, `${compact.runId}.jsonl`), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(events.some((e: any) => e.kind === "submission")).toBe(false);
    const ordinary = await api("/api/sessions", { sessionId, prompt: "/compact", cwd: repoDir });
    expect(ordinary.status).toBe(400); expect(ordinary.body.code).toBe("compact-action-required"); expect(invocations()).toHaveLength(launches + 1);
  }, TIMEOUT);

  test("attached Claude without per-request acknowledgement is rejected before any native launch", async () => {
    await app!.close(); app = undefined;
    // Seed the external-ownership discriminator offline rather than asking a
    // native SDK to import or execute a real attached conversation.
    const metadata = disk("metadata.json"), session = metadata.sessions.find((s: any) => s.sessionId === sessionId);
    session.attachment = { state: "ready", source: session.authorityId };
    const installation = acquireInstallation(validateOwnershipPaths(options.packageDir!, dataDir), { phase: "setup" });
    let data: OwnershipHandle | undefined;
    try { data = acquireData(installation, { phase: "setup" }); writeFileSync(join(dataDir, "metadata.json"), JSON.stringify(metadata)); }
    finally { try { data?.release(); } finally { installation.release(); } }
    app = await start(options);
    const before = disk("metadata.json"), launches = invocations().length;
    expect((await api(`/api/sessions/${sessionId}/compact`)).body.eligibility.requiresNativeStopped).toBe(true);
    const refused = await api(`/api/sessions/${sessionId}/compact`, { requestId: crypto.randomUUID() });
    expect(refused.status).toBe(409); expect(refused.body.code).toBe("native-acknowledgement-required");
    expect(invocations()).toHaveLength(launches); expect(disk("metadata.json")).toEqual(before);
  }, TIMEOUT);
});
