/** Offline HTTP regression: isolated installation/assets/store and fake CLI only.
 * No build, real model, native service, or browser is used. Restarts below affect
 * only this ephemeral replica, after its fake CLI processes have finished.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { start, type Options } from "../src/bridge";
import { initializeAppStore } from "../src/app-store";
import { OpenCodeAdapter } from "../src/opencode";
import { OC_REPLY_ACTIVATION_BLOCKED, OpenCodeReplyIntegration } from "../src/opencode-reply-integration";
import { OC_REPLY_QUALIFICATION_CHECKS, type OpenCodeReplyQualification } from "../src/opencode-reply-observer";
import { ConversationUpdateStore } from "../src/conversation-update-store";
import { acquireData, acquireInstallation, validateOwnershipPaths, type OwnershipHandle } from "../src/installation-ownership";
import { isConversationUpdatePage, type ConversationUpdate, type ConversationUpdatePage } from "../shared/conversation/conversation-updates";

const TEMP = "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode";
const TIMEOUT = 30000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const savedEnv = new Map<string, string | undefined>();
let root = "", dataDir = "", repoDir = "", otherRepo = "", log = "", sessionId = "", cookie = "";
let options: Options;
let app: Awaited<ReturnType<typeof start>> | undefined;

// Exact minimal validated asset fixture from compaction-bridge.test.ts. Its
// input closure is local: no actual package lock, build, or frontend generation.
function fixtureAssets(packageDir: string) {
  const files = { "bun.lock": "", "public/index.html": "<!doctype html><html><body>offline fixture</body></html>" };
  mkdirSync(join(packageDir, "public"), { recursive: true });
  for (const [name, value] of Object.entries(files)) writeFileSync(join(packageDir, name), value);
  const recipe = { version: 2, target: "browser", format: "esm", naming: "app.[ext]", minify: true, define: { "process.env.NODE_ENV": '"production"' } };
  const inputs = Object.fromEntries(Object.entries({ ...Object.fromEntries(Object.entries(files).map(([name, value]) => [name, hash(value)])), $recipe: hash(JSON.stringify(recipe)), $bun: hash(Bun.version) }).sort(([a], [b]) => a.localeCompare(b)));
  const generation = crypto.randomUUID(), assets = join(packageDir, "public", "assets"), dir = join(assets, generation), js = "// offline fixture\n";
  mkdirSync(dir, { recursive: true });
  const outputs = { "app.js": js, "push-worker.js": "// offline push worker fixture\n" };
  for (const [name, value] of Object.entries(outputs)) writeFileSync(join(dir, name), value);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ format: "sane-app-assets", version: 1, generation, fingerprint: hash(JSON.stringify(inputs)), inputs, outputs: Object.fromEntries(Object.entries(outputs).map(([name, value]) => [name, hash(value)])) }));
  writeFileSync(join(assets, "current.json"), JSON.stringify({ format: "sane-app-assets-current", version: 1, generation }));
}

async function api(path: string, data?: unknown, method = data === undefined ? "GET" : "POST", authCookie = cookie, headers: Record<string, string> = {}) {
  const res = await fetch(`${app!.origin}${path}`, { method, headers: { "content-type": "application/json", origin: app!.origin, ...(authCookie ? { cookie: authCookie } : {}), ...headers }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}), redirect: "error", signal: AbortSignal.timeout(5000) });
  return { status: res.status, body: await res.json() as any, headers: res.headers };
}
const disk = (name: string) => JSON.parse(readFileSync(join(dataDir, name), "utf8"));
const invocations = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
const release = (name: string) => writeFileSync(join(root, name), "released");
async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 10000;
  do { const value = await read(); if (ready(value)) return value; await Bun.sleep(20); } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}
async function waitIdle(id: string) {
  return eventually(async () => {
    const response = await api("/api/sessions"); expect(response.status).toBe(200);
    return response.body.sessions.find((s: any) => s.sessionId === id);
  }, session => !!session && session.lastStatus !== "running" && session.availability?.canSend === true, "fake CLI idle and owner reaped");
}
async function bootstrap(limit = 100): Promise<ConversationUpdatePage> {
  const response = await api(`/api/conversation-updates/bootstrap?limit=${limit}`);
  expect(response.status).toBe(200); expect(isConversationUpdatePage(response.body, { limit })).toBe(true);
  return response.body;
}
function feedPath(page: ConversationUpdatePage, after = page.nextCursor.after, limit = 100, through?: number) {
  return `/api/conversation-updates?${new URLSearchParams({ epoch: page.epoch, after: String(after), limit: String(limit), ...(through === undefined ? {} : { through: String(through) }) })}`;
}
async function create(prompt: string, cwd = repoDir) {
  const response = await api("/api/sessions", { prompt, cwd, profileId: "template:engineering" });
  expect(response.status).toBe(202);
  expect(typeof response.body.runId).toBe("string"); expect(typeof response.body.sessionId).toBe("string");
  return response.body as { runId: string; sessionId: string };
}
async function restart() {
  // Callers have waited for completed fake-process ownership, not merely result stdout.
  await app!.close(); app = undefined; cookie = ""; app = await start(options);
}

describe.serial("conversation-update bridge (isolated offline App replica)", () => {
  beforeAll(async () => {
    for (const name of Object.keys(process.env).filter(name => /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_API_KEY|CLAUDE_CODE_BASE_URL|CLAUDE_CODE_CUSTOM_MODEL_OPTION|AWS_BEARER_TOKEN_BEDROCK|OPENAI_API_KEY|OPENAI_BASE_URL)/.test(name)).concat(["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_PROJECT_DIR_NAME", "SANE_APP_PASSWORD"])) {
      savedEnv.set(name, process.env[name]); delete process.env[name];
    }
    root = realpathSync(mkdtempSync(join(TEMP, "conversation-update-bridge-")));
    const packageDir = join(root, "installation"), profileRoot = join(root, "claude-profile");
    dataDir = join(root, "appdata"); repoDir = join(root, "repo"); otherRepo = join(root, "other-repo"); log = join(root, "invocations.jsonl");
    fixtureAssets(packageDir);
    mkdirSync(join(profileRoot, "sane-agent-settings"), { recursive: true }); mkdirSync(join(profileRoot, "agents")); mkdirSync(join(root, "oc"));
    process.env.CLAUDE_CONFIG_DIR = profileRoot;
    writeFileSync(join(profileRoot, "sane-agent-settings", "sane-assistant-engineering.settings.json"), JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }));
    writeFileSync(join(profileRoot, "agents", "sane-assistant-engineering.md"), "---\nname: sane-assistant-engineering\n---\n");
    for (const cwd of [repoDir, otherRepo]) {
      mkdirSync(cwd);
      const git = Bun.spawn(["git", "init", cwd], { stdout: "ignore", stderr: "ignore" });
      if (await git.exited !== 0) throw new Error("fixture git init failed");
    }
    const stub = join(root, "claude-stub.mjs");
    writeFileSync(stub, [
      `#!${process.execPath}`,
      `import { appendFileSync, existsSync, readFileSync } from "node:fs";`,
      `const args = process.argv.slice(2), prompt = await Bun.stdin.text();`,
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, prompt, cwd: process.cwd() }) + "\\n");`,
      `const i = args.findIndex(a => a === "--session-id" || a === "--resume"), session_id = args[i + 1];`,
      `const emit = record => console.log(JSON.stringify({ session_id, ...record }));`,
      `const gate = async name => { const deadline = Date.now() + 12000; while (!existsSync(${JSON.stringify(root)} + "/" + name)) { if (Date.now() > deadline) throw new Error("fixture gate timeout"); await Bun.sleep(10); } };`,
      `const start = JSON.parse(readFileSync(args[args.indexOf("--settings") + 1], "utf8")).hooks.SessionStart.flatMap(e => e.hooks).find(h => h.command.includes("session-start.ts"));`,
      `if (start) emit({ type: "system", subtype: "hook_response", hook_name: "SessionStart:startup", hook_event: "SessionStart", stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: readFileSync(start.command.split(" ").at(-1).slice(1, -1), "utf8") } }), exit_code: 0, outcome: "success" });`,
      `emit({ type: "system", subtype: "init" });`,
      `const result = (index, text, patch = {}) => emit({ type: "result", subtype: "success", is_error: false, result_index: index, result: text, ...patch });`,
      `if (prompt.startsWith("/compact")) { emit({ type: "system", subtype: "compact_boundary", uuid: crypto.randomUUID(), compact_metadata: { trigger: "manual", pre_tokens: 90000, post_tokens: 12000 } }); result(0, "compact fixture text"); }`,
      `else if (prompt === "multi-result fixture") { result(0, "same useful reply"); await gate("release-second"); result(1, "same useful reply"); await gate("release-exit"); }`,
      `else if (prompt === "noise-only fixture") { result(0, "child reply", { session_id: "foreign-child", parent_tool_use_id: "child-tool" }); emit({ type: "user", content: [{ type: "tool_result", tool_use_id: "tool", content: "tool output" }] }); emit({ type: "assistant", message: { id: "tool-call", content: [{ type: "tool_use", id: "tool", name: "fixture", input: {} }] } }); result(0, " "); }`,
      `else if (prompt === "hard gate callback fixture") { for (let index = 0; index < 32; index++) emit({ type: "assistant", message: { id: "callback_" + index, content: [{ type: "text", text: "offline journal checkpoint " + index }] } }); result(0, "ordinary fixture reply"); }`,
      `else result(0, "ordinary fixture reply");`,
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ finished: true, session_id, cwd: process.cwd() }) + "\\n");`,
      "",
    ].join("\n")); chmodSync(stub, 0o755);
    options = { host: "127.0.0.1", port: 0, cwd: repoDir, dataDir, claudeBin: stub, packageDir, noBuild: true, allowRemote: false, reconcileInterrupted: false, nativeSources: { cc: { version: 1, harness: "cc", kind: "local-profile", profileRoot }, oc: { version: 1, harness: "oc", kind: "local-registration", registrationFile: join(root, "oc", "missing-service.json") } } };
    const installation = acquireInstallation(validateOwnershipPaths(packageDir, dataDir), { phase: "setup" });
    let data: OwnershipHandle | undefined;
    try { data = acquireData(installation, { phase: "setup", createDataParent: true }); initializeAppStore(dataDir, options.nativeSources); }
    finally { try { data?.release(); } finally { installation.release(); } }
    app = await start(options);
    expect((await api("/api/agents/template:engineering", { model: "opus", effort: "high" }, "PUT")).status).toBe(200);
  }, TIMEOUT);

  afterAll(async () => {
    try {
      if (root) { release("release-second"); release("release-exit"); }
      await app?.close();
    } finally {
      for (const [name, value] of savedEnv) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
      if (root) rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT);

  test("initial active-run seed and two same-process replies have distinct IDs; completion revises only the last alias", async () => {
    const config = await api("/api/config"); expect(config.body.conversationUpdates).toBe(true);
    const empty = await bootstrap(); expect(empty.storeId).toBe(config.body.storeId); expect(empty.updates).toEqual([]); expect(empty.bootstrap?.activeRunIds).toEqual([]);
    const created = await create("multi-result fixture"); sessionId = created.sessionId;
    try {
      const first = await eventually(bootstrap, page => page.updates.length === 1, "first indexed reply before exit");
      expect(first.bootstrap?.activeRunIds).toEqual([created.runId]);
      const reply = first.updates[0]!;
      expect(reply).toMatchObject({ runId: created.runId, conversationId: sessionId, kind: "reply", revision: 1, nativeBoundaryId: `cc-result:${created.runId}:index:0`, messageId: `${created.runId}:result:index:0` });
      expect(reply.legacyRunId).toBeUndefined();
      expect((await api(feedPath(first))).body.updates).toEqual([]);
      release("release-second");
      const second = await eventually(async () => (await api(feedPath(first))).body as ConversationUpdatePage, page => page.updates.length === 1, "second indexed reply while same process is alive");
      expect(isConversationUpdatePage(second)).toBe(true);
      const later = second.updates[0]!;
      expect(later).toMatchObject({ runId: created.runId, kind: "reply", revision: 1, nativeBoundaryId: `cc-result:${created.runId}:index:1`, messageId: `${created.runId}:result:index:1` });
      expect(later.id).not.toBe(reply.id); expect(later.legacyRunId).toBeUndefined();
      expect((await bootstrap()).bootstrap?.activeRunIds).toEqual([created.runId]);
      expect((await api(feedPath(first, first.nextCursor.after, 100, second.through))).body.updates).toEqual(second.updates);
      expect((await api(feedPath(second))).body.updates).toEqual([]);
      release("release-exit");
      const idle = await waitIdle(sessionId); expect(idle.lastRunStatus).toBe("completed");
      const terminal = await eventually(async () => (await api(feedPath(second))).body as ConversationUpdatePage, page => page.updates.length === 1, "terminal alias revision");
      expect(terminal.updates).toEqual([{ ...later, legacyRunId: created.runId, revision: 2, sequence: terminal.updates[0]!.sequence, observedAt: terminal.updates[0]!.observedAt }]);
      const full = await bootstrap(); expect(full.updates.map(row => row.kind)).toEqual(["reply", "reply", "reply"]);
      expect(new Set(full.updates.map(row => row.id)).size).toBe(2); expect(full.bootstrap?.activeRunIds).toEqual([]);
      const listed = (await api("/api/sessions")).body.sessions.find((s: any) => s.sessionId === sessionId);
      expect(listed.authorityId).toBe(reply.source.authorityId); expect(listed.nativeSessionId).toBe(reply.source.nativeSessionId); expect(listed.harness).toBe("claude-code");
      expect(invocations().filter(entry => entry.args)).toHaveLength(1);
      const events = readFileSync(join(dataDir, `${created.runId}.jsonl`), "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(events.filter(e => e.kind === "stdout" && e.data?.type === "result").map(e => e.data.result_index)).toEqual([0, 1]);
    } finally { release("release-second"); release("release-exit"); await waitIdle(sessionId); }
  }, TIMEOUT);

  test("full-store feed observes another workspace while navigation stays on the selected conversation", async () => {
    const selected = (await api("/api/sessions")).body.sessions.find((s: any) => s.sessionId === sessionId);
    const nav = (await api("/api/navigation")).body;
    const navigation = await api("/api/navigation", { expectedRevision: nav.revision, workspaceId: selected.workspaceId, worktreeId: selected.worktreeId, conversationId: sessionId, view: "chat", comparison: null, filePath: null }, "PUT");
    expect(navigation.status).toBe(200);
    const before = await bootstrap(), other = await create("background workspace fixture", otherRepo);
    await waitIdle(other.sessionId);
    const response = await api(feedPath(before)); expect(response.status).toBe(200);
    expect(new Set(response.body.updates.map((row: ConversationUpdate) => row.id)).size).toBe(1);
    expect(response.body.updates.every((row: ConversationUpdate) => row.conversationId === other.sessionId && row.runId === other.runId)).toBe(true);
    const listing = (await api("/api/sessions")).body.sessions;
    expect(listing.find((s: any) => s.sessionId === other.sessionId).workspaceId).not.toBe(selected.workspaceId);
    expect((await api("/api/navigation")).body).toEqual(navigation.body);
  }, TIMEOUT);

  test("compact text, child results, tool output, and empty root success create no attention", async () => {
    const before = await bootstrap();
    const compact = await api(`/api/sessions/${sessionId}/compact`, { requestId: crypto.randomUUID(), instructions: "offline compact fixture" });
    expect(compact.status).toBe(202); await waitIdle(sessionId);
    const noise = await create("noise-only fixture"); const idle = await waitIdle(noise.sessionId);
    expect(idle.lastRunStatus).toBe("completed");
    const after = await bootstrap(); expect(after.through).toBe(before.through); expect(after.updates).toEqual(before.updates);
    expect((await api(feedPath(before))).body.updates).toEqual([]);
    expect(after.bootstrap?.activeRunIds).toEqual([]);
  }, TIMEOUT);

  test("bounded traversal replays exact changes once and rejects invalid, future, and expired cursors", async () => {
    const first = await bootstrap(1); expect(first.updates).toHaveLength(1); expect(first.hasMore).toBe(true);
    const all = await bootstrap(), drained = [...first.updates]; let page = first;
    while (page.hasMore) {
      const path = feedPath(page, page.nextCursor.after, 1, first.through);
      const response = await api(path), repeat = await api(path);
      expect(response.status).toBe(200); expect(repeat.body).toEqual(response.body); expect(response.body.updates).toHaveLength(1);
      expect(isConversationUpdatePage(response.body, { cursor: page.nextCursor, through: first.through, limit: 1 })).toBe(true);
      page = response.body; drained.push(...page.updates);
    }
    expect(drained).toEqual(all.updates); expect(new Set(drained.map(row => row.sequence)).size).toBe(drained.length);
    expect((await api(feedPath(page, page.nextCursor.after, 1, first.through))).body.updates).toEqual([]);
    for (const path of ["/api/conversation-updates", "/api/conversation-updates/bootstrap?limit=0", "/api/conversation-updates/bootstrap?limit=101", "/api/conversation-updates/bootstrap?limit=1&limit=2", `/api/conversation-updates?epoch=${all.epoch}&after=-1`, feedPath(all, all.through + 1), feedPath(all, 0, 1, all.through + 1)]) {
      const response = await api(path); expect(response.status).toBe(400); expect(response.body.code).toBe("invalid-update-cursor");
    }
    const gap = await api(`/api/conversation-updates?epoch=expired-fixture-epoch&after=0`);
    expect(gap.status).toBe(410); expect(gap.body.code).toBe("conversation-update-gap");
    expect((await api("/api/conversation-updates/bootstrap", {}, "POST")).status).toBe(405);
  }, TIMEOUT);

  test("ordinary replica restart preserves epoch, IDs, revisions, and replay checkpoints without relaunching", async () => {
    const before = await bootstrap(), launches = invocations(), record = disk("conversation-updates.json");
    expect(disk("metadata.json").runs.every((run: any) => run.status === "completed")).toBe(true);
    expect(launches.filter(entry => entry.finished)).toHaveLength(launches.filter(entry => entry.args).length);
    await restart();
    const after = await bootstrap(); expect(after).toEqual(before); expect(disk("conversation-updates.json")).toEqual(record);
    expect(invocations()).toEqual(launches);
    const path = feedPath(after, 0, 100, after.through);
    expect((await api(path)).body.updates).toEqual(before.updates); expect((await api(path)).body.updates).toEqual(before.updates);
    expect((await api(feedPath(after))).body.updates).toEqual([]);
    expect(existsSync(join(root, "oc", "missing-service.json"))).toBe(false);
  }, TIMEOUT);

  test("disabled reply hooks do no duplicate metadata parse or catalog refresh while fake CLI metadata and 32 journal checkpoints persist", async () => {
    const marker = "hard gate callback fixture", before = await bootstrap(), parse = JSON.parse, published = OpenCodeReplyIntegration.prototype.metadataPublished;
    let duplicateParses = 0, publicationCallbacks = 0;
    const parsing = spyOn(JSON, "parse").mockImplementation((raw, reviver) => {
      if (raw.startsWith('{"version":1,') && raw.includes('"sessions":[') && raw.includes('"runs":[') && raw.includes(marker)) duplicateParses++;
      return parse(raw, reviver);
    });
    const capture = spyOn(OpenCodeReplyIntegration.prototype, "metadataPublished").mockImplementation(function (this: OpenCodeReplyIntegration, snapshot: string) { if (snapshot.includes(marker)) publicationCallbacks++; return published.call(this, snapshot); });
    const refresh = spyOn(OpenCodeReplyIntegration.prototype, "refresh");
    let created: Awaited<ReturnType<typeof create>> | undefined;
    try {
      created = await create(marker); const completed = await waitIdle(created.sessionId); expect(completed.lastRunStatus).toBe("completed");
      expect(publicationCallbacks).toBeGreaterThan(0); expect(duplicateParses).toBe(0); expect(refresh).not.toHaveBeenCalled();
    } finally { parsing.mockRestore(); capture.mockRestore(); refresh.mockRestore(); }
    expect(disk("metadata.json").runs.find((r: any) => r.runId === created!.runId).status).toBe("completed");
    const journal = readFileSync(join(dataDir, `${created!.runId}.jsonl`), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(journal.filter(e => e.kind === "stdout" && e.data?.type === "assistant" && e.data.message?.id?.startsWith("callback_"))).toHaveLength(32);
    const after = await bootstrap(); expect(after.updates.filter(row => row.runId === created!.runId).some(row => row.legacyRunId === created!.runId)).toBe(true);
    expect(after.through).toBeGreaterThan(before.through); expect(after.bootstrap?.sourceBaselines).toEqual([]);
  }, TIMEOUT);

  test("production hard gate ignores trusted fake descriptor, keeps OC legacy lifecycle/feed semantics and tolerates corrupt optional binding storage", async () => {
    const before = await bootstrap(), launches = invocations();
    await app!.close(); app = undefined;
    const metadata = disk("metadata.json"), source = disk("sources.json").oc, admissions = disk("admissions.json"), catalog = disk("catalog.json");
    const originalAdmission = admissions.admissions.find((a: any) => a.binding.executionCheckout === repoDir && a.state === "ready");
    expect(originalAdmission).toBeDefined();
    expect(typeof source.authorityId).toBe("string");
    const endedAt = "2026-10-01T00:00:00.000Z";
    const seeded = (["completed", "failed"] as const).map((status, index) => {
      const id = crypto.randomUUID(), runId = crypto.randomUUID(), nativeSessionId = `ses_offline_gate_${index}`;
      const session = { sessionId: id, harness: "opencode", authorityId: source.authorityId, nativeSessionId, cwd: repoDir, lastStatus: status, lastRunId: runId, profileId: "base:oc" };
      const run = { runId, sessionId: id, cwd: repoDir, status, createdAt: endedAt, endedAt, nativeCommandId: `msg_offline_command_${index}`, nativePhase: "accepted", nativeAcceptedAt: Date.parse(endedAt) };
      metadata.sessions.push(session); metadata.runs.push(run);
      admissions.admissions.push({ ...structuredClone(originalAdmission), sessionId: id, requestId: crypto.randomUUID(), operation: "enroll", source, nativeId: nativeSessionId });
      catalog.associations[id] = structuredClone(catalog.associations[originalAdmission.sessionId]);
      writeFileSync(join(dataDir, `${runId}.jsonl`), [
        { seq: 1, time: endedAt, runId, sessionId: id, kind: "message", data: { role: "assistant", messageId: `msg_offline_reply_${index}`, createdAt: endedAt, parts: [{ type: "text", text: "Historical fixture reply, not native replay" }] } },
        { seq: 2, time: endedAt, runId, sessionId: id, kind: "status", data: { status } },
      ].map(e => JSON.stringify(e) + "\n").join(""));
      return { session, run };
    });
    writeFileSync(join(dataDir, "metadata.json"), JSON.stringify(metadata));
    writeFileSync(join(dataDir, "admissions.json"), JSON.stringify(admissions));
    writeFileSync(join(dataDir, "catalog.json"), JSON.stringify(catalog));
    const bindingFile = join(dataDir, "opencode-reply-bindings.json"), corrupt = "{offline-optional-binding-corruption";
    writeFileSync(bindingFile, corrupt);
    const descriptor: OpenCodeReplyQualification = { authorityId: source.authorityId, clientVersion: "2.0.18", nativeVersion: "2.0.21", verifiedAt: endedAt, evidenceRef: "fake-only:not-runtime-qualification",
      checks: Object.fromEntries(OC_REPLY_QUALIFICATION_CHECKS.map(k => [k, { passed: true, evidenceRef: `fake-only:${k}` }])) as OpenCodeReplyQualification["checks"] };
    options.openCodeReplyQualifications = [descriptor];
    const transport = spyOn(OpenCodeAdapter.prototype, "replyTransport").mockImplementation(async () => { throw new Error("Production disabled gate must not open native transport"); });
    try {
      app = await start(options);
      const after = await bootstrap(); expect(after.epoch).toBe(before.epoch); expect(after.bootstrap?.sourceBaselines).toEqual([]);
      const ocRows = after.updates.filter(row => row.source.harness === "opencode");
      expect(ocRows).toHaveLength(1); expect(ocRows[0]).toMatchObject({ kind: "failed", conversationId: seeded[1]!.session.sessionId, runId: seeded[1]!.run.runId, legacyRunId: seeded[1]!.run.runId });
      expect(after.updates.filter(row => row.source.harness === "claude-code")).toEqual(before.updates);
      for (const item of seeded) {
        const coverage = after.coverage.find(c => c.sourceKey.includes(item.session.nativeSessionId));
        expect(coverage).toMatchObject({ state: "unavailable" }); expect(coverage?.reason).toContain("Optional OpenCode reply binding storage");
        expect(coverage?.through).toBeUndefined(); expect(coverage?.baselineThrough).toBeUndefined();
      }
      const listed = (await api("/api/sessions")).body.sessions;
      for (const item of seeded) {
        const session = listed.find((s: any) => s.sessionId === item.session.sessionId);
        expect(session.lastRunStatus).toBe(item.run.status); expect(session.updateSource).toBeUndefined();
      }
      expect(disk("conversation-updates.json").checkpoints.every((cp: any) => JSON.parse(cp.key)[0] !== "native")).toBe(true);
      expect(readFileSync(bindingFile, "utf8")).toBe(corrupt); expect(transport).not.toHaveBeenCalled(); expect(invocations()).toEqual(launches);
      // Repair only the test-owned optional file. The gate still reports honest
      // unqualified native coverage with a descriptor and leaves the feed unchanged.
      await app.close(); app = undefined; rmSync(bindingFile); app = await start(options);
      const healthy = await bootstrap(); expect(healthy.updates).toEqual(after.updates);
      for (const item of seeded) expect(healthy.coverage.find(c => c.sourceKey.includes(item.session.nativeSessionId))).toMatchObject({ state: "unqualified", reason: OC_REPLY_ACTIVATION_BLOCKED });
      expect(healthy.bootstrap?.sourceBaselines).toEqual([]); expect(transport).not.toHaveBeenCalled();
    } finally { transport.mockRestore(); }
  }, TIMEOUT);

  test("bridge shutdown joins optional reply coordinator before closing derived store", async () => {
    const lifecycle: string[] = [];
    let release!: () => void; const joined = new Promise<void>(resolve => { release = resolve; });
    const closeIntegration = OpenCodeReplyIntegration.prototype.close, closeStore = ConversationUpdateStore.prototype.close;
    const integration = spyOn(OpenCodeReplyIntegration.prototype, "close").mockImplementation(function (this: OpenCodeReplyIntegration) {
      lifecycle.push("reply-close-called");
      return closeIntegration.call(this).then(async () => { await joined; lifecycle.push("reply-joined"); });
    });
    const store = spyOn(ConversationUpdateStore.prototype, "close").mockImplementation(function (this: ConversationUpdateStore) { lifecycle.push("store-close"); return closeStore.call(this); });
    const closing = app!.close();
    try {
      expect(lifecycle).toEqual(["reply-close-called"]);
      await new Promise<void>(resolve => setImmediate(resolve)); expect(lifecycle).not.toContain("store-close");
      release(); await closing; app = undefined;
      expect(lifecycle.indexOf("reply-joined")).toBeLessThan(lifecycle.indexOf("store-close"));
    } finally { release(); await closing; integration.mockRestore(); store.mockRestore(); }
    app = await start(options);
  }, TIMEOUT);

  test("password boundary hides store and feed capability until cookie login and rejects foreign Host/Origin", async () => {
    const before = await bootstrap(); process.env.SANE_APP_PASSWORD = "isolated-fixture-password";
    await restart();
    const config = await api("/api/config"); expect(config.body).toMatchObject({ authRequired: true, authenticated: false, cwd: null });
    for (const key of ["storeId", "conversationUpdates", "capabilities", "harnesses", "agentProfiles"]) expect(config.body[key]).toBeUndefined();
    expect((await api("/api/conversation-updates/bootstrap")).status).toBe(401); expect((await api(feedPath(before))).status).toBe(401);
    expect((await api("/api/login", { password: "wrong" })).status).toBe(401);
    const login = await api("/api/login", { password: process.env.SANE_APP_PASSWORD }); expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    expect((await api("/api/config")).body).toMatchObject({ authenticated: true, storeId: before.storeId, conversationUpdates: true });
    expect((await bootstrap()).updates).toEqual(before.updates);
    expect((await api(feedPath(before, 0))).status).toBe(200);
    expect((await api("/api/conversation-updates/bootstrap", undefined, "GET", cookie, { host: "foreign.invalid" })).status).toBe(403);
    expect((await api("/api/conversation-updates/bootstrap", {}, "POST", cookie, { origin: "https://foreign.invalid" })).status).toBe(403);
  }, TIMEOUT);

  test("derived write failure and corrupt-feed restart yield 503 without blocking primary run persistence", async () => {
    const before = await bootstrap();
    const feedFile = join(dataDir, "conversation-updates.json"), backup = join(dataDir, "fixture-feed-backup.json");
    // Only test-owned derived storage is replaced. A directory makes atomic
    // publication fail deterministically even when the test runs as root.
    renameSync(feedFile, backup); mkdirSync(feedFile);
    const created = await create("feed write failure fixture"), idle = await waitIdle(created.sessionId);
    expect(idle.lastRunStatus).toBe("completed");
    const unavailable = await api("/api/conversation-updates/bootstrap"); expect(unavailable.status).toBe(503); expect(unavailable.body.code).toBe("conversation-updates-unavailable");
    expect((await api(feedPath(before))).status).toBe(503);
    expect(disk("metadata.json").runs.find((run: any) => run.runId === created.runId).status).toBe("completed");
    expect(readFileSync(join(dataDir, `${created.runId}.jsonl`), "utf8")).toContain("ordinary fixture reply");
    await app!.close(); app = undefined; cookie = "";
    rmSync(feedFile, { recursive: true }); writeFileSync(feedFile, "{fixture-corruption");
    delete process.env.SANE_APP_PASSWORD;
    app = await start(options);
    expect((await api("/api/config")).status).toBe(200); expect((await api("/api/conversation-updates/bootstrap")).status).toBe(503);
    expect((await api(feedPath(before))).status).toBe(503);
    const restarted = await create("corrupt derived feed fixture"), completed = await waitIdle(restarted.sessionId);
    expect(completed.lastRunStatus).toBe("completed"); expect((await api("/api/conversation-updates/bootstrap")).status).toBe(503);
    expect(readFileSync(feedFile, "utf8")).toBe("{fixture-corruption");
    expect(disk("metadata.json").runs.find((run: any) => run.runId === restarted.runId).status).toBe("completed");
    expect(readFileSync(join(dataDir, `${restarted.runId}.jsonl`), "utf8")).toContain("ordinary fixture reply");
    expect(existsSync(join(root, "oc", "missing-service.json"))).toBe(false);
  }, TIMEOUT);
});
