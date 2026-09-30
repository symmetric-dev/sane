/**
 * Agent and skill session-loading smoke integration.
 *
 * Confirms the installed SANE roles/skills actually load into a live session:
 * - CC: `claude -p --agent sane-assistant-research` boots a session with the
 *   installed agent (an unknown agent fails immediately at startup).
 * - OC: a disposable native session creates against the installed model
 *   catalog (no prompt is sent, so no agent turn is spent).
 *
 * Rules (shared with the native suites):
 * - Serial only: top-level describe.serial. Never parallel.
 * - Armed explicitly: the live portion runs only with AGENT_LIVE=1 plus a
 *   readable ambient App config (NATIVE_CLAUDE_PROFILE / NATIVE_OPENCODE_REGISTRATION
 *   overrides apply). Otherwise every test skips with a reason, never a
 *   silent pass.
 * - Spend cap: at most 1 real CC agent turn for this file; OC spends none.
 *   chargeTurns() fails explicitly past budget.
 * - Disposable tmp dirs/sessions; evidence flushed to NATIVE_EVIDENCE_DIR.
 *
 * Implementation only: real CC/OC sessions launch when this suite runs with
 * AGENT_LIVE=1, not at authoring time. Verify with typecheck only; do NOT run.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { resolveAppConfig } from "../src/app-config";
import { OpenCodeAdapter } from "../src/opencode";

const LIVE = process.env.AGENT_LIVE === "1";
const TURN_BUDGET = 1;
const CC_TIMEOUT_MS = 180000;
const QUICK_TIMEOUT_MS = 120000;

const PKG_DIR = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));

type Ambient = ReturnType<typeof resolveAppConfig>;
let ambient: Ambient | null = null;
let ambientError = "";
try {
  ambient = resolveAppConfig([], { packageDir: PKG_DIR, invocationCwd: process.cwd() });
} catch (error) {
  ambientError = error instanceof Error ? error.message : String(error);
}
const ARMED_REASON = !LIVE
  ? "AGENT_LIVE!=1: live agent sessions stay unlaunched"
  : ambient === null
    ? `ambient App config unreadable: ${ambientError}`
    : "";
const liveTest: typeof test = ARMED_REASON ? test.skip : test;

type Evidence = Record<string, unknown>;
const evidence: Evidence[] = [];
function record(entry: Evidence): void {
  const clean: Evidence = {};
  for (const [k, v] of Object.entries(entry)) {
    if (/token|secret|password|cookie|auth/i.test(k)) { clean[k] = "<redacted>"; continue; }
    clean[k] = typeof v === "string" && v.length > 2000 ? `${v.slice(0, 2000)}…` : v;
  }
  evidence.push({ at: new Date().toISOString(), ...clean });
}
let chargedTurns = 0;
function chargeTurns(n: number, label: string): void {
  chargedTurns += n;
  record({ kind: "turn-budget", label, charged: n, total: chargedTurns, budget: TURN_BUDGET });
  if (chargedTurns > TURN_BUDGET) throw new Error(`spend cap exceeded: ${chargedTurns}/${TURN_BUDGET} real agent turns (${label})`);
}

const roots: string[] = [];
function disposableRoot(tag: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `agent--`)));
  roots.push(root);
  return root;
}

describe.serial("agent session loading smoke", () => {
  afterAll(async () => {
    try {
      const dir = process.env.NATIVE_EVIDENCE_DIR ?? null;
      if (dir) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "agent-smoke.json"), `${JSON.stringify({ armed: !ARMED_REASON, reason: ARMED_REASON || null, turns: chargedTurns, budget: TURN_BUDGET, evidence }, null, 2)}\n`);
      }
    } finally {
      if (process.env.NATIVE_KEEP_FIXTURES !== "1") {
        for (const root of roots) {
          try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
        }
      }
    }
  }, QUICK_TIMEOUT_MS);

  liveTest("CC boots a session with the installed research agent", async () => {
    const a = ambient!;
    const claudeBin = process.env.NATIVE_CLAUDE_BIN ?? a.config.native.claude.executable;
    const profileRoot = process.env.NATIVE_CLAUDE_PROFILE ?? a.config.native.claude.profileRoot;
    const cwd = disposableRoot("cc");
    const nativeSessionId = randomUUID();
    chargeTurns(1, "cc-agent-boot");
    const child = Bun.spawn(
      [claudeBin, "-p", "--output-format", "stream-json", "--verbose", "--session-id", nativeSessionId, "--agent", "sane-assistant-research"],
      {
        cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe",
        env: { ...process.env, CLAUDE_CONFIG_DIR: profileRoot, CLAUDE_CODE_PROJECT_DIR_NAME: "" },
      },
    );
    child.stdin.write("Reply with exactly OK and stop.");
    await child.stdin.end();
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const lines = stdout.split("\n").filter(Boolean);
    const events: any[] = [];
    for (const line of lines) {
      try { events.push(JSON.parse(line)); } catch { /* non-JSON progress line */ }
    }
    record({ kind: "cc-agent-boot", exit, events: events.length, stderrTail: stderr.slice(-500) });
    expect(stderr.toLowerCase()).not.toContain("unknown agent");
    const init = events.find((e) => e?.type === "system" && e?.subtype === "init");
    expect(init?.session_id).toBe(nativeSessionId);
    const result = events.find((e) => e?.type === "result");
    expect(result?.subtype).toBe("success");
    expect(exit).toBe(0);
  }, CC_TIMEOUT_MS);

  liveTest("OC creates a disposable session against the installed catalog", async () => {
    const a = ambient!;
    const registrationFile = process.env.NATIVE_OPENCODE_REGISTRATION ?? a.config.native.opencode.registrationFile;
    const cwd = disposableRoot("oc");
    const oc = new OpenCodeAdapter(undefined, undefined, registrationFile);
    const models = await oc.models(cwd);
    record({ kind: "oc-catalog", models: models.length });
    expect(models.length).toBeGreaterThan(0);
    const session = await oc.create(cwd);
    record({ kind: "oc-session", id: session.id });
    expect(/^ses[a-zA-Z0-9_-]+$/.test(session.id)).toBe(true);
    expect(session.location?.directory).toBe(cwd);
    await oc.assertIdle(session.id, cwd);
  }, QUICK_TIMEOUT_MS);
});
if (ARMED_REASON) {
  test.skip(`live session smoke (skipped: ${ARMED_REASON})`, () => { });
}
