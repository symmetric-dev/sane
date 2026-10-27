import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { DispatchSource, DispatchTerminalGuards } from "../shared/conversation/dispatch-contract";
import { createGrokDispatchAdapter, GrokDispatchRefusal, grokDispatchObservation, stopGrokDispatch, type GrokDispatchAdapterOptions, type GrokSpawn } from "./grok-adapter";
import type { RunOwner } from "./run-owner";

const TEMP = "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode";
const EXECUTABLE = "/opt/grok/bin/grok";
const MODEL = "fixture-model";
const EFFORT = "fixture-effort";
const AUTHORITY = `sane-native-v1:gk:${"ab".repeat(32)}`;
const NATIVE_ID = "12345678-1234-4234-8234-123456789abd";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed: NodeJS.Signals | number | null = null;
  constructor(readonly pid: number) { super(); }
  kill(signal?: NodeJS.Signals | number) {
    this.killed = signal ?? "SIGTERM";
    this.emit("exit", null, this.killed);
    return true;
  }
}

function tempRoot() {
  const root = realpathSync(mkdtempSync(join(TEMP, "grok-adapter-")));
  roots.push(root);
  return root;
}

function source(overrides: Partial<DispatchSource> = {}): DispatchSource {
  return {
    harnessId: "grok",
    sessionId: "12345678-1234-4234-9234-123456789abc",
    authorityId: AUTHORITY,
    nativeSessionId: NATIVE_ID,
    cwd: "/tmp/grok-cwd",
    ...overrides,
  };
}

function owner(nativeSessionId = NATIVE_ID, cwd = "/tmp/grok-cwd"): RunOwner {
  return {
    run: { runId: "run-1", sessionId: source().sessionId, cwd, status: "running", createdAt: "2026-10-27T00:00:00.000Z" },
    done: Promise.resolve(),
    settled: false,
    contextIdentity: { source: source({ nativeSessionId, cwd }), runId: "run-1", nativeCommandId: null },
  };
}

function completed(): DispatchTerminalGuards {
  return {
    settled: true, released: true, status: "completed", cancelling: false, stopRequested: false, stopping: false,
    closing: false, storageFailed: false, reconciliationRequired: false,
  };
}

function adapterFor(root: string, spawn: GrokSpawn, overrides: Partial<GrokDispatchAdapterOptions> = {}) {
  const stdout = new PassThrough();
  const chunks: Buffer[] = [];
  stdout.on("data", chunk => chunks.push(Buffer.from(chunk)));
  const adapter = createGrokDispatchAdapter({
    executable: EXECUTABLE,
    model: MODEL,
    effort: EFFORT,
    promptDirectory: root,
    spawn,
    stdout,
    stdoutPath: join(root, "stdout.log"),
    env: {
      PATH: "/usr/bin",
      HOME: "/home/fixture",
      SANE_CALLER_CONTEXT: "{\"actorKind\":\"local\"}",
      SANE_SESSION_ID: "should-not-forward",
      OPENCODE_SESSION_ID: "should-not-forward",
    },
    ...overrides,
  });
  return { adapter, chunks };
}

function exitingSpawn(record: { argv: readonly string[]; env: Readonly<Record<string, string>> }[], write?: (child: FakeChild) => void): GrokSpawn {
  return (argv, options) => {
    record.push({ argv, env: options.env });
    const child = new FakeChild(4200 + record.length);
    queueMicrotask(() => {
      write?.(child);
      if (child.killed === null) child.emit("exit", 0, null);
    });
    return child;
  };
}

test("new turn uses --session-id and the exact prompt bytes; continuation uses --resume and does not allocate a new id", async () => {
  const root = tempRoot();
  const calls: { argv: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
  const prompt = "exact bytes \n café";
  const { adapter } = adapterFor(root, exitingSpawn(calls));
  const current = owner();
  await adapter.execute(current, prompt, false, () => {});
  await adapter.execute(current, `${prompt} continued`, true, () => {});
  expect(calls).toHaveLength(2);
  const [created, continued] = calls;
  expect(created!.argv).toContain("--session-id");
  expect(created!.argv).not.toContain("--resume");
  expect(created!.argv[created!.argv.indexOf("--session-id") + 1]).toBe(NATIVE_ID);
  const promptPath = created!.argv[created!.argv.indexOf("--prompt-file") + 1]!;
  expect(readFileSync(promptPath)).toEqual(Buffer.from(prompt, "utf8"));
  expect(continued!.argv).toContain("--resume");
  expect(continued!.argv).not.toContain("--session-id");
  expect(continued!.argv[continued!.argv.indexOf("--resume") + 1]).toBe(NATIVE_ID);
  expect(continued!.argv).not.toContain("--session-id");
  expect(new Set([created!.argv[created!.argv.indexOf("--session-id") + 1], continued!.argv[continued!.argv.indexOf("--resume") + 1]])).toEqual(new Set([NATIVE_ID]));
});

test("argv contains the fixed Grok flags and not a SANE subcommand", async () => {
  const root = tempRoot();
  const calls: { argv: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
  const { adapter } = adapterFor(root, exitingSpawn(calls));
  await adapter.execute(owner(), "flags", false, () => {});
  const argv = calls[0]!.argv;
  expect(Array.isArray(argv)).toBe(true);
  expect(argv).toEqual([
    EXECUTABLE,
    "--model", MODEL,
    "--reasoning-effort", EFFORT,
    "--output-format", "streaming-messages-json",
    "--verbatim",
    "--no-plan",
    "--no-subagents",
    "--disable-web-search",
    "--permission-mode", "dontAsk",
    "--deny", "*",
    "--max-turns", "1",
    "--session-id", NATIVE_ID,
    "--prompt-file", argv.at(-1),
  ]);
  expect(argv).toContain("--deny");
  expect(argv).toContain("*");
  expect(argv).toContain("--verbatim");
  expect(argv).toContain("--prompt-file");
  expect(argv).not.toContain("sane");
  expect(argv.some(arg => arg === "sane" || arg.startsWith("sane ") || arg.includes(" --"))).toBe(false);
  expect(argv).not.toContain("grok-4.7");
  expect(argv.some(arg => arg.toLowerCase().includes("claude"))).toBe(false);
});

test("child env has no SANE caller variables", async () => {
  const root = tempRoot();
  const calls: { argv: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
  const { adapter } = adapterFor(root, exitingSpawn(calls));
  await adapter.execute(owner(), "env", false, () => {});
  const env = calls[0]!.env;
  expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/fixture" });
  expect(env).not.toHaveProperty("SANE_CALLER_CONTEXT");
  expect(env).not.toHaveProperty("SANE_SESSION_ID");
  expect(env).not.toHaveProperty("OPENCODE_SESSION_ID");
  expect(Object.keys(env).some(key => key.startsWith("SANE_"))).toBe(false);
});

test("a stdout line containing msg_0 does not produce an accepted message id", async () => {
  const root = tempRoot();
  const calls: { argv: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
  const line = JSON.stringify({ type: "assistant", message: { id: "msg_0", content: [{ type: "text", text: "not a tool_use event" }] } });
  const result = JSON.stringify({ type: "result", subtype: "success", session_id: NATIVE_ID, result: "ok" });
  const { adapter, chunks } = adapterFor(root, exitingSpawn(calls, child => {
    child.stdout.write(`${line}\n${result}\n`);
  }));
  const current = owner();
  await adapter.execute(current, "hello", false, () => {});
  const observation = grokDispatchObservation(adapter, current);
  expect(observation?.submission).toBe("submitted");
  expect(observation?.nativeAcceptance).toBe("unknown");
  expect(observation?.acceptedMessageId).toBeNull();
  expect(observation?.observedStreamMessageIds).toContain("msg_0");
  expect(current.run.nativeCommandId).toBeUndefined();
  expect(Buffer.concat(chunks).toString("utf8")).toContain(`"id":"msg_0"`);
  expect(readFileSync(join(root, "stdout.log"), "utf8")).toContain(`"id":"msg_0"`);
  expect(JSON.stringify(observation)).not.toContain("\"accepted\"");
});

test("exit 0 does not make successfulSettlement ready", async () => {
  const root = tempRoot();
  const calls: { argv: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
  const { adapter } = adapterFor(root, exitingSpawn(calls));
  const current = owner();
  await adapter.execute(current, "settle", false, () => {});
  expect(grokDispatchObservation(adapter, current)?.exitCode).toBe(0);
  const settlement = await adapter.successfulSettlement(current, source(), completed);
  expect(settlement.ready).toBe(false);
  if (settlement.ready) throw new Error("wrapper exit must not prove native completion");
  expect(settlement.code).toBe("grok-native-completion-unproven");
  expect(settlement.reason).toContain("0");
  expect(settlement.reason.toLowerCase()).not.toContain("claude");
});

test("missing executable, null authority, and a non-UUID session id are readiness refusals and do not spawn", async () => {
  const root = tempRoot();
  let calls = 0;
  const spawn: GrokSpawn = () => { calls += 1; throw new Error("readiness must not spawn"); };
  const missing = createGrokDispatchAdapter({ spawn, promptDirectory: root, model: MODEL, effort: EFFORT });
  const missingResult = await missing.readiness(source(), "user");
  expect(missingResult.readiness.ready).toBe(false);
  if (missingResult.readiness.ready) throw new Error("missing executable must refuse");
  expect(missingResult.readiness.code).toBe("grok-eligibility-refused");
  expect(missingResult.readiness.reason.toLowerCase()).not.toContain("claude");
  expect(missingResult.readiness.code).not.toMatch(/storage/i);

  const relative = createGrokDispatchAdapter({ executable: "grok", spawn, promptDirectory: root, model: MODEL, effort: EFFORT });
  expect((await relative.readiness(source(), "user")).readiness.ready).toBe(false);

  const { adapter } = adapterFor(root, spawn);
  const nullAuthority = await adapter.readiness(source({ authorityId: null }), "user");
  expect(nullAuthority.readiness.ready).toBe(false);
  if (!nullAuthority.readiness.ready) expect(nullAuthority.readiness.code).toBe("grok-eligibility-refused");
  const badId = await adapter.readiness(source({ nativeSessionId: "ses_not_a_uuid" }), "user");
  expect(badId.readiness.ready).toBe(false);
  expect((await adapter.readiness(source({ cwd: "relative/cwd" }), "user")).readiness.ready).toBe(false);
  expect((await adapter.readiness(source({ authorityId: `sane-native-v1:cc:${"ab".repeat(32)}` }), "user")).readiness.ready).toBe(false);

  const ready = await adapter.readiness(source(), "user");
  expect(ready.readiness).toEqual({ ready: true });
  expect(ready.source).toEqual(source());
  expect(calls).toBe(0);
});

test("automatic origins are unsupported", async () => {
  const root = tempRoot();
  let calls = 0;
  const spawn: GrokSpawn = () => { calls += 1; throw new Error("automatic origin must not spawn"); };
  const { adapter } = adapterFor(root, spawn);
  expect(adapter.id).toBe("grok");
  const origins = ["queued-user", "questionnaire-response", "worker-report", "worker-exchange", "handoff"] as const;
  for (const origin of origins) {
    expect(adapter.automation[origin]?.supported).toBe(false);
    const result = await adapter.readiness(source(), origin);
    expect(result.readiness.ready).toBe(false);
    if (result.readiness.ready) throw new Error(`${origin} must stay unsupported`);
    expect(result.readiness.code).toBe("grok-automation-unsupported");
  }
  expect(calls).toBe(0);
});

test("stop kills only the spawned pid and reports cancellation unproven", async () => {
  const root = tempRoot();
  const child = new FakeChild(5151);
  const unrelated = new FakeChild(6262);
  let calls = 0;
  const spawn: GrokSpawn = () => { calls += 1; return child; };
  const { adapter } = adapterFor(root, spawn);
  const current = owner();
  const other = owner();
  expect(stopGrokDispatch(adapter, current)).toMatchObject({ code: "grok-stop-refused", nativeCancellation: "not-attempted", killedPid: null, stopped: false });
  const pending = adapter.execute(current, "stop me", false, () => {});
  const refused = stopGrokDispatch(adapter, other);
  expect(refused.code).toBe("grok-stop-refused");
  expect(child.killed).toBeNull();
  expect(unrelated.killed).toBeNull();
  const stopped = stopGrokDispatch(adapter, current);
  expect(stopped).toEqual({
    stopped: false,
    code: "grok-cancellation-unproven",
    reason: "Killed only the spawned Grok child; native cancellation is unproven",
    killedPid: 5151,
    nativeCancellation: "unproven",
  });
  expect(child.killed).toBe("SIGTERM");
  expect(unrelated.killed).toBeNull();
  expect(calls).toBe(1);
  await pending;
  expect(grokDispatchObservation(adapter, current)?.nativeCancellation).toBe("unproven");
});

test("a second execute after an uncertain spawn does not spawn again", async () => {
  const root = tempRoot();
  let calls = 0;
  const spawn: GrokSpawn = () => { calls += 1; throw new Error("spawn failed after possible start"); };
  const { adapter } = adapterFor(root, spawn);
  const current = owner();
  await expect(adapter.execute(current, "once", false, () => {})).rejects.toBeInstanceOf(GrokDispatchRefusal);
  await expect(adapter.execute(current, "again", true, () => {})).rejects.toMatchObject({ code: "grok-spawn-uncertain" });
  expect(calls).toBe(1);
  expect(grokDispatchObservation(adapter, current)?.nativeAcceptance).not.toBe("accepted");
});

test("empty model or effort refuses before spawn", async () => {
  const root = tempRoot();
  let calls = 0;
  const spawn: GrokSpawn = () => { calls += 1; throw new Error("empty model must not spawn"); };
  const current = owner();
  const missingModel = createGrokDispatchAdapter({ executable: EXECUTABLE, effort: EFFORT, model: "", promptDirectory: root, spawn });
  await missingModel.execute(current, "no model", false, () => {});
  expect(grokDispatchObservation(missingModel, current)?.code).toBe("grok-eligibility-refused");
  expect(grokDispatchObservation(missingModel, current)?.submission).toBe("not-submitted");
  const missingEffort = createGrokDispatchAdapter({ executable: EXECUTABLE, model: MODEL, promptDirectory: root, spawn });
  await missingEffort.execute(current, "no effort", false, () => {});
  expect(calls).toBe(0);
  expect(grokDispatchObservation(missingEffort, current)?.nativeAcceptance).toBe("not-accepted");
});

test("a tool-use event is a boundary refusal and does not continue", async () => {
  const root = tempRoot();
  const child = new FakeChild(7171);
  let calls = 0;
  const spawn: GrokSpawn = () => {
    calls += 1;
    queueMicrotask(() => {
      child.stdout.write(`${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "bash", input: {} }] } })}\n`);
      if (child.killed === null) child.emit("exit", 0, null);
    });
    return child;
  };
  const { adapter } = adapterFor(root, spawn);
  const current = owner();
  await expect(adapter.execute(current, "tools", false, () => {})).rejects.toMatchObject({ code: "grok-tool-boundary" });
  const observation = grokDispatchObservation(adapter, current);
  expect(observation?.toolBoundary).toBe("refused");
  expect(observation?.acceptedMessageId).toBeNull();
  expect(observation?.nativeAcceptance).toBe("unknown");
  expect((await adapter.successfulSettlement(current, source(), completed)).ready).toBe(false);
  await expect(adapter.execute(current, "continue", true, () => {})).rejects.toMatchObject({ code: "grok-tool-boundary" });
  expect(calls).toBe(1);
  expect(child.killed).toBe("SIGTERM");
});
