/**
 * Agent Profiles integration: real in-process bridge (`start`), real App store,
 * real HTTP. Claude Code is replaced at the process boundary by a stub
 * executable that records its argv and emits a minimal successful stream-json
 * turn, so the suite runs offline with no real agent turns. OpenCode coverage
 * is limited to rejections that happen before any native contact.
 *
 * Prerequisites: no other SANE App instance holding this package's
 * installation lock; no ANTHROPIC_ or other provider override env vars (the bridge
 * refuses to start with them). CLAUDE_CONFIG_DIR / CLAUDE_CODE_PROJECT_DIR_NAME
 * are unset for the duration of this file and restored afterwards.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { start, type Options } from "../src/bridge";
import { validateOwnershipPaths, acquireInstallation, acquireData, type OwnershipHandle } from "../src/installation-ownership";
import { initializeAppStore, loadAgentProfiles, AppStoreError } from "../src/app-store";
import { builtinProfiles, seedAgentProfiles, type AgentProfile, type AgentProfiles } from "../src/agent-profiles-contract";

const PKG_DIR = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const TIMEOUT_MS = 120000;

const savedEnv: Record<string, string | undefined> = {};
const roots: string[] = [];
let root = "", dataDir = "", repoDir = "", argvLog = "", stubPath = "";
let options: Options;
let app: { origin: string; close: () => Promise<void> } | undefined;

function tmpRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-profiles-")));
  roots.push(dir);
  return dir;
}

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${app!.origin}${path}`, { ...init, headers: { "content-type": "application/json", origin: app!.origin, ...(init.headers ?? {}) }, redirect: "error" });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 2000) }; }
  return { status: res.status, body };
}
const post = (path: string, data: unknown) => api(path, { method: "POST", body: JSON.stringify(data) });
const put = (path: string, data: unknown) => api(path, { method: "PUT", body: JSON.stringify(data) });
const del = (path: string) => api(path, { method: "DELETE" });

async function createProfile(fromId: string, fields: Record<string, unknown>): Promise<AgentProfile> {
  const res = await post("/api/agents", { fromId, ...fields });
  if (res.status !== 200) throw new Error(`profile create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.profile as AgentProfile;
}

async function sessionOf(sessionId: string): Promise<any> {
  const res = await api("/api/sessions");
  return (res.body?.sessions as any[]).find(s => s.sessionId === sessionId);
}
async function waitIdle(sessionId: string): Promise<any> {
  for (let i = 0; i < 400; i++) {
    const s = await sessionOf(sessionId);
    if (s && s.lastStatus !== "running" && s.availability?.canSend) return s;
    await Bun.sleep(50);
  }
  throw new Error(`session ${sessionId} did not become idle`);
}
/** Submits a prompt and waits for the stubbed run to finish; returns the session row. */
async function send(data: Record<string, unknown>): Promise<{ sessionId: string; runId: string; session: any }> {
  const res = await post("/api/sessions", { prompt: "agent profile test", cwd: repoDir, ...data });
  if (res.status !== 202) throw new Error(`submit refused: ${res.status} ${JSON.stringify(res.body)}`);
  const session = await waitIdle(res.body.sessionId);
  const runs = (await api(`/api/sessions/${res.body.sessionId}/runs`)).body.runs as any[];
  expect(runs.find(r => r.runId === res.body.runId)?.status).toBe("completed");
  return { sessionId: res.body.sessionId, runId: res.body.runId, session };
}

function invocations(): string[][] {
  if (!existsSync(argvLog)) return [];
  return readFileSync(argvLog, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]);
}
/** argv of the latest CLI launch for a native session (new or resumed). */
function lastArgv(nativeSessionId: string): string[] {
  const found = invocations().filter(args => args.includes(nativeSessionId)).at(-1);
  if (!found) throw new Error(`no CLI launch recorded for ${nativeSessionId}`);
  return found;
}
const flag = (args: string[], name: string): string | undefined => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const runSettings = (args: string[]) => JSON.parse(readFileSync(flag(args, "--settings")!, "utf8")) as { hooks?: unknown; permissions?: unknown };
const diskAgents = () => JSON.parse(readFileSync(join(dataDir, "agents.json"), "utf8")) as AgentProfiles;
const diskSession = (sessionId: string) => (JSON.parse(readFileSync(join(dataDir, "metadata.json"), "utf8")).sessions as any[]).find(s => s.sessionId === sessionId);

async function boot(noBuild: boolean): Promise<void> {
  const handle = await start({ ...options, noBuild });
  app = { origin: handle.origin, close: () => handle.close() };
}

describe.serial("agent profiles (in-process bridge, stubbed Claude CLI)", () => {
  beforeAll(async () => {
    for (const name of ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_PROJECT_DIR_NAME"]) { savedEnv[name] = process.env[name]; delete process.env[name]; }
    root = tmpRoot();
    dataDir = join(root, "appdata");
    repoDir = join(root, "repo");
    const profileRoot = join(root, "claude-profile");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(join(profileRoot, "sane-agent-settings"), { recursive: true });
    mkdirSync(join(root, "oc"), { recursive: true });
    const git = Bun.spawn(["git", "init", repoDir], { stdout: "ignore", stderr: "ignore" });
    if ((await git.exited) !== 0) throw new Error("git init failed");
    // Installed permission profiles for the assistants this suite launches.
    for (const role of ["research", "engineering", "design"]) {
      writeFileSync(join(profileRoot, "sane-agent-settings", `sane-assistant-${role}.settings.json`), JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }));
    }
    argvLog = join(root, "claude-argv.jsonl");
    stubPath = join(root, "claude-stub.mjs");
    writeFileSync(stubPath, [
      `#!${process.execPath}`,
      `import { appendFileSync } from "node:fs";`,
      `const args = process.argv.slice(2);`,
      `appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + "\\n");`,
      `await Bun.stdin.text();`,
      `const i = args.findIndex(a => a === "--session-id" || a === "--resume");`,
      `const session_id = args[i + 1];`,
      `console.log(JSON.stringify({ type: "system", subtype: "init", session_id }));`,
      `console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id, result: "OK" }));`,
      "",
    ].join("\n"));
    chmodSync(stubPath, 0o755);
    options = {
      host: "127.0.0.1", port: 0, cwd: repoDir, dataDir, claudeBin: stubPath, allowRemote: false, reconcileInterrupted: false,
      maxConcurrentRuns: 4, packageDir: PKG_DIR,
      nativeSources: {
        cc: { version: 1, harness: "cc", kind: "local-profile", profileRoot: realpathSync(profileRoot) },
        oc: { version: 1, harness: "oc", kind: "local-registration", registrationFile: join(root, "oc", "service.json") },
      },
    };
    const paths = validateOwnershipPaths(PKG_DIR, dataDir);
    const installation = acquireInstallation(paths, { phase: "setup" });
    let dataHandle: OwnershipHandle | undefined;
    try {
      dataHandle = acquireData(installation, { phase: "setup", createDataParent: true });
      initializeAppStore(paths.dataDir!, options.nativeSources);
    } finally { try { dataHandle?.release(); } finally { installation.release(); } }
    await boot(false);
  }, TIMEOUT_MS);

  afterAll(async () => {
    try { await app?.close(); } finally {
      for (const [name, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
      for (const dir of roots) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
    }
  }, TIMEOUT_MS);

  test("fresh store seeds agents.json with unlocked Base profiles and the six templates", async () => {
    const res = await api("/api/agents");
    expect(res.status).toBe(200);
    const served = res.body as AgentProfiles;
    expect(served.defaultId).toBe("base:cc");
    expect(served.profiles.map(p => p.id).sort()).toEqual(builtinProfiles().map(p => p.id).sort());
    for (const p of served.profiles) expect(p.locked).toBe(false);
    expect(diskAgents()).toEqual(served);
  }, TIMEOUT_MS);

  test("loadAgentProfiles merges a missing builtin back but rejects a corrupt custom profile", () => {
    const dir = tmpRoot();
    const seeded = seedAgentProfiles();
    const withoutResearch = { ...seeded, profiles: seeded.profiles.filter(p => p.id !== "template:research") };
    writeFileSync(join(dir, "agents.json"), JSON.stringify(withoutResearch));
    const merged = loadAgentProfiles(dir);
    expect(merged.profiles.some(p => p.id === "template:research")).toBe(true);
    expect((JSON.parse(readFileSync(join(dir, "agents.json"), "utf8")) as AgentProfiles).profiles.some(p => p.id === "template:research")).toBe(true);

    // Legacy files with locked Base builtins load and are rewritten unlocked.
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ ...seeded, profiles: seeded.profiles.map(p => p.kind === "base" ? { ...p, locked: true } : p) }));
    expect(loadAgentProfiles(dir).profiles.every(p => !p.locked)).toBe(true);
    expect((JSON.parse(readFileSync(join(dir, "agents.json"), "utf8")) as AgentProfiles).profiles.every(p => !p.locked)).toBe(true);

    // A custom copy claiming builtin status is corrupt, never silently repaired.
    const custom: AgentProfile = { ...seeded.profiles.find(p => p.id === "template:planning")!, id: crypto.randomUUID(), builtin: true };
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ ...seeded, profiles: [...seeded.profiles, custom] }));
    let error: unknown;
    try { loadAgentProfiles(dir); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(AppStoreError);
    expect((error as AppStoreError).code).toBe("APP_STORE_CORRUPT");
  });

  test("profile CRUD rules: Base harness fixed, builtins undeletable, strict validation, no partial persistence", async () => {
    const baseEdit = await put("/api/agents/base:cc", { model: "opus", effort: "high" });
    expect(baseEdit.status).toBe(200);
    expect(diskAgents().profiles.find(p => p.id === "base:cc")).toMatchObject({ model: "opus", effort: "high" });
    expect((await put("/api/agents/base:cc", { harness: "opencode" })).body.error).toBe("Base profile harness cannot change");
    expect((await post("/api/agents/base:cc/reset", {})).body.profile).toMatchObject({ model: "", effort: "", harness: "claude-code" });
    expect(diskAgents().profiles.find(p => p.id === "base:cc")).toMatchObject({ model: "", effort: "" });
    const builtinDelete = await del("/api/agents/template:research");
    expect(builtinDelete.body.error).toBe("Builtin profiles cannot be deleted");

    // Assistant variants may resolve against the installed agent's model.
    const agentDefault = await put("/api/agents/template:knowledge", { harness: "opencode", effort: "high" });
    expect(agentDefault.status).toBe(200);
    expect(agentDefault.body.profile).toMatchObject({ model: "", effort: "high" });
    const before = diskAgents();
    const invalid = await put("/api/agents/base:oc", { effort: "high" });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toContain("Select a model");
    expect(diskAgents()).toEqual(before);
    expect((await api("/api/agents")).body).toEqual(before);

    // Template reset restores builtin values but keeps its position.
    const edited = await put("/api/agents/template:planning", { label: "My Planner", model: "opus", effort: "max" });
    expect(edited.status).toBe(200);
    const reset = await post("/api/agents/template:planning/reset", {});
    expect(reset.status).toBe(200);
    const builtin = builtinProfiles().find(p => p.id === "template:planning")!;
    expect(reset.body.profile).toMatchObject({ label: builtin.label, model: "", effort: "", order: edited.body.profile.order });
    expect(diskAgents().profiles.find(p => p.id === "template:planning")!.label).toBe(builtin.label);
    const custom = await createProfile("template:planning", { label: "Custom Planner" });
    expect((await post(`/api/agents/${custom.id}/reset`, {})).status).toBe(400);
  }, TIMEOUT_MS);

  test("the default agent cannot be hidden; deleting it resets the default to base:cc", async () => {
    const custom = await createProfile("template:design", { label: "Default Designer" });
    expect(custom.builtin).toBe(false);
    expect((await put("/api/agents/order", { defaultId: custom.id })).status).toBe(200);
    const hide = await put(`/api/agents/${custom.id}`, { hidden: true });
    expect(hide.body.error).toBe("The default agent cannot be hidden");
    expect(diskAgents().profiles.find(p => p.id === custom.id)!.hidden).toBeUndefined();

    expect((await del(`/api/agents/${custom.id}`)).body).toEqual({ ok: true });
    expect((await api("/api/agents")).body.defaultId).toBe("base:cc");
    expect(diskAgents().defaultId).toBe("base:cc");
    expect(diskAgents().profiles.some(p => p.id === custom.id)).toBe(false);
  }, TIMEOUT_MS);

  test("Base profile runs launch Claude without --agent or permission merge; custom Base model/effort still apply", async () => {
    const { session } = await send({ profileId: "base:cc", harness: "opencode", agent: "research", model: "ignored-model" });
    expect(session.profileId).toBe("base:cc");
    expect(session.harness).toBe("claude-code");
    expect(session.agent).toBeUndefined();
    const args = lastArgv(session.nativeSessionId);
    expect(args).not.toContain("--agent");
    expect(args).not.toContain("--model");
    expect(runSettings(args).permissions).toBeUndefined();

    expect((await put("/api/agents/base:cc", { model: "opus" })).status).toBe(200);
    const edited = await send({ profileId: "base:cc" });
    const editedArgs = lastArgv(edited.session.nativeSessionId);
    expect(flag(editedArgs, "--model")).toBe("opus");
    expect(editedArgs).not.toContain("--agent");
    expect((await post("/api/agents/base:cc/reset", {})).status).toBe(200);

    const customBase = await createProfile("base:cc", { label: "Base Sonnet", model: "sonnet", effort: "low" });
    const second = await send({ profileId: customBase.id });
    const args2 = lastArgv(second.session.nativeSessionId);
    expect(args2).not.toContain("--agent");
    expect(flag(args2, "--model")).toBe("sonnet");
    expect(flag(args2, "--effort")).toBe("low");
    expect(runSettings(args2).permissions).toBeUndefined();
  }, TIMEOUT_MS);

  test("assistant profile snapshots role/model/effort at creation; later profile edits do not change follow-ups", async () => {
    const profile = await createProfile("template:engineering", { label: "Eng Opus", model: "opus", effort: "high" });
    const first = await send({ profileId: profile.id });
    expect(first.session).toMatchObject({ profileId: profile.id, agent: "engineering", model: "opus", effort: "high" });
    const args = lastArgv(first.session.nativeSessionId);
    expect(flag(args, "--agent")).toBe("sane-assistant-engineering");
    expect(flag(args, "--model")).toBe("opus");
    expect(flag(args, "--effort")).toBe("high");
    expect(runSettings(args).permissions).toEqual({ allow: ["Bash(ls:*)"] });

    expect((await put(`/api/agents/${profile.id}`, { model: "sonnet", effort: "low" })).status).toBe(200);
    const follow = await send({ sessionId: first.sessionId, profileId: profile.id });
    const followArgs = lastArgv(first.session.nativeSessionId);
    expect(followArgs).toContain("--resume");
    expect(flag(followArgs, "--agent")).toBe("sane-assistant-engineering");
    expect(flag(followArgs, "--model")).toBe("opus");
    expect(flag(followArgs, "--effort")).toBe("high");
    const runs = (await api(`/api/sessions/${first.sessionId}/runs`)).body.runs as any[];
    expect(runs.find(r => r.runId === follow.runId)).toMatchObject({ profileId: profile.id, model: "opus", effort: "high", agent: "engineering" });
  }, TIMEOUT_MS);

  test("Base session upgrades to an assistant on the same harness exactly once", async () => {
    const research = await createProfile("template:research", { label: "Research Sonnet", model: "sonnet" });
    const base = await send({ profileId: "base:cc" });
    expect(lastArgv(base.session.nativeSessionId)).not.toContain("--agent");

    const upgraded = await send({ sessionId: base.sessionId, profileId: research.id });
    const args = lastArgv(base.session.nativeSessionId);
    expect(flag(args, "--agent")).toBe("sane-assistant-research");
    expect(flag(args, "--model")).toBe("sonnet");
    expect(upgraded.session).toMatchObject({ profileId: research.id, agent: "research", model: "sonnet" });
    expect(diskSession(base.sessionId)).toMatchObject({ profileId: research.id, agent: "research", model: "sonnet" });

    const launches = invocations().length;
    for (const next of ["template:planning", "base:cc"]) {
      const res = await post("/api/sessions", { prompt: "change again", sessionId: base.sessionId, profileId: next });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Session agent cannot change");
    }
    expect(invocations().length).toBe(launches);
    expect(await sessionOf(base.sessionId)).toMatchObject({ profileId: research.id, agent: "research" });
  }, TIMEOUT_MS);

  test("cross-harness, hidden and unknown profiles are rejected before any launch", async () => {
    const ocResearch = await createProfile("template:research", { label: "OC Research", harness: "opencode" });
    const hidden = await createProfile("template:execution", { label: "Hidden Exec", hidden: true });
    const base = await send({ profileId: "base:cc" });
    const launches = invocations().length;

    const cross = await post("/api/sessions", { prompt: "switch", sessionId: base.sessionId, profileId: ocResearch.id });
    expect(cross.status).toBe(400);
    expect(cross.body.error).toBe("Session harness cannot change");
    const hiddenUpgrade = await post("/api/sessions", { prompt: "switch", sessionId: base.sessionId, profileId: hidden.id });
    expect(hiddenUpgrade.status).toBe(400);

    const sessionsBefore = (await api("/api/sessions")).body.sessions.length;
    const hiddenNew = await post("/api/sessions", { prompt: "new", cwd: repoDir, profileId: hidden.id });
    expect(hiddenNew.body.error).toBe("Hidden agent");
    const unknown = await post("/api/sessions", { prompt: "new", cwd: repoDir, profileId: crypto.randomUUID() });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe("Unknown agent profile");
    expect((await api("/api/sessions")).body.sessions.length).toBe(sessionsBefore);
    expect(invocations().length).toBe(launches);
    expect(await sessionOf(base.sessionId)).toMatchObject({ profileId: "base:cc" });
  }, TIMEOUT_MS);

  test("legacy sessions without profileId surface their mapped profile and keep the legacy agent lock", async () => {
    const legacy = await send({ harness: "claude-code", agent: "research" });
    expect(diskSession(legacy.sessionId).profileId).toBeUndefined();
    expect(legacy.session.profileId).toBe("template:research");
    expect(flag(lastArgv(legacy.session.nativeSessionId), "--agent")).toBe("sane-assistant-research");

    const plain = await send({ harness: "claude-code" });
    expect(plain.session.profileId).toBe("base:cc");

    const change = await post("/api/sessions", { prompt: "switch", sessionId: legacy.sessionId, profileId: "template:design" });
    expect(change.body.error).toBe("Session agent cannot change");
    // Re-selecting the mapped profile is a no-op follow-up, not a transition.
    await send({ sessionId: legacy.sessionId, profileId: "template:research" });
    expect(flag(lastArgv(legacy.session.nativeSessionId), "--agent")).toBe("sane-assistant-research");
  }, TIMEOUT_MS);

  test("profile edits, custom profiles and session profileIds survive a bridge restart", async () => {
    expect((await put("/api/agents/template:design", { label: "My Design", model: "opus" })).status).toBe(200);
    const custom = await createProfile("base:oc", { label: "OC Base Copy" });
    const { sessionId } = await send({ profileId: "template:design" });
    const before = (await api("/api/agents")).body as AgentProfiles;

    await app!.close();
    app = undefined;
    await boot(true);

    const after = (await api("/api/agents")).body as AgentProfiles;
    expect(after).toEqual(before);
    expect(after.profiles.find(p => p.id === "template:design")).toMatchObject({ label: "My Design", model: "opus" });
    expect(after.profiles.find(p => p.id === custom.id)).toMatchObject({ label: "OC Base Copy", kind: "base", harness: "opencode", builtin: false, locked: false });
    expect(await sessionOf(sessionId)).toMatchObject({ profileId: "template:design", agent: "design", model: "opus" });
  }, TIMEOUT_MS);
});
