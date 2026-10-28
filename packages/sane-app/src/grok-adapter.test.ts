import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
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
  private exited = false;
  private closed = false;
  constructor(readonly pid: number) { super(); }
  kill(signal?: NodeJS.Signals | number) {
    this.killed = signal ?? "SIGTERM";
    this.emitExit(null, this.killed);
    this.emitClose(null, this.killed);
    return true;
  }
  emitExit(code: number | null, signal: NodeJS.Signals | number | null) {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code, signal);
  }
  emitClose(code: number | null, signal: NodeJS.Signals | number | null) {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", code, signal);
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
    homeRoot: join(root, "grok-home"),
    model: MODEL,
    effort: EFFORT,
    promptDirectory: root,
    spawn,
    stdout,
    stdoutPath: join(root, "stdout.log"),
    executableReady: () => {},
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
      if (child.killed === null) {
        child.emitExit(0, null);
        child.emitClose(0, null);
      }
    });
    return child;
  };
}

function isolationEnv(homeRoot: string): Record<string, string> {
  return {
    GROK_HOME: homeRoot,
    GROK_MEMORY: "0",
    GROK_MANAGED_MCPS_ENABLED: "false",
    GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED: "false",
    SANE_UNQUALIFIED_NATIVE: "1",
    GROK_SESSION_ID: NATIVE_ID,
    GROK_CLAUDE_AGENTS_ENABLED: "false",
    GROK_CLAUDE_RULES_ENABLED: "false",
    GROK_CLAUDE_HOOKS_ENABLED: "false",
    GROK_CLAUDE_MCPS_ENABLED: "false",
    GROK_CLAUDE_SKILLS_ENABLED: "false",
    GROK_CURSOR_AGENTS_ENABLED: "false",
    GROK_CURSOR_RULES_ENABLED: "false",
    GROK_CURSOR_HOOKS_ENABLED: "false",
    GROK_CURSOR_MCPS_ENABLED: "false",
    GROK_CURSOR_SKILLS_ENABLED: "false",
  };
}

test("new turn uses --session-id and the exact prompt bytes; continuation uses --resume and does not allocate a new id", async () => {
  const root = tempRoot();
  const calls: { argv: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
  const prompt = "exact bytes \n café";
  const { adapter } = adapterFor(root, exitingSpawn(calls));
  const current = owner();
  await adapter.execute(current, prompt, false, () => {});
  await adapter.execute(owner(), `${prompt} continued`, true, () => {});
  expect(calls).toHaveLength(2);
  const [created, continued] = calls;
  expect(created!.argv).toContain("--session-id");
  expect(created!.argv).not.toContain("--resume");
  expect(created!.argv[created!.argv.indexOf("--session-id") + 1]).toBe(NATIVE_ID);
  const promptPath = created!.argv[created!.argv.indexOf("--prompt-file") + 1]!;
  expect(basename(promptPath)).toBe(`run-1.${NATIVE_ID}.0.prompt.txt`);
  expect(basename(promptPath)).not.toBe("run-1.0.prompt.txt");
  expect(readFileSync(promptPath)).toEqual(Buffer.from(prompt, "utf8"));
  expect(continued!.argv).toContain("--resume");
  expect(continued!.argv).not.toContain("--session-id");
  expect(continued!.argv[continued!.argv.indexOf("--resume") + 1]).toBe(NATIVE_ID);
  expect(basename(continued!.argv[continued!.argv.indexOf("--prompt-file") + 1]!)).toBe(`run-1.${NATIVE_ID}.1.prompt.txt`);
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
    "--prompt-file", argv.at(-1)!,
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

test("child env is the isolation set and the pinned home, with no PATH, HOME, or caller envelope", async () => {
  const root = tempRoot();
  const homeRoot = join(root, "pinned-home");
  const calls: { argv: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
  const previous = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GROK_HOME: process.env.GROK_HOME,
    SANE_CALLER_CONTEXT: process.env.SANE_CALLER_CONTEXT,
  };
  process.env.PATH = "/injected/bin";
  process.env.HOME = "/injected/home";
  process.env.GROK_HOME = "/injected/grok-home";
  process.env.SANE_CALLER_CONTEXT = "{\"actorKind\":\"local\"}";
  try {
    const options = {
      executable: EXECUTABLE,
      homeRoot,
      model: MODEL,
      effort: EFFORT,
      promptDirectory: root,
      spawn: exitingSpawn(calls),
      executableReady: () => {},
      env: {
        PATH: "/usr/bin",
        HOME: "/home/fixture",
        GROK_HOME: "/injected/override",
        SANE_CALLER_CONTEXT: "{\"actorKind\":\"local\"}",
        SANE_SESSION_ID: "should-not-forward",
        OPENCODE_SESSION_ID: "should-not-forward",
      },
    };
    const adapter = createGrokDispatchAdapter(options);
    await adapter.execute(owner(), "env", false, () => {});
    const env = calls[0]!.env;
    expect(env).toEqual(isolationEnv(homeRoot));
    expect(env.GROK_HOME).toBe(homeRoot);
    expect(env).not.toHaveProperty("PATH");
    expect(env).not.toHaveProperty("HOME");
    expect(env).not.toHaveProperty("SANE_CALLER_CONTEXT");
    expect(Object.keys(env).filter(key => key.startsWith("SANE_") || key.startsWith("OPENCODE_"))).toEqual(["SANE_UNQUALIFIED_NATIVE"]);
    expect(Object.keys(env)).toEqual(Object.keys(isolationEnv(homeRoot)));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a relative or missing homeRoot does not spawn", async () => {
  const root = tempRoot();
  let calls = 0;
  const spawn: GrokSpawn = () => { calls += 1; throw new Error("invalid home must not spawn"); };
  const relative = createGrokDispatchAdapter({
    executable: EXECUTABLE,
    homeRoot: "relative/grok-home",
    executableReady: () => {},
    model: MODEL,
    effort: EFFORT,
    promptDirectory: root,
    spawn,
  });
  const current = owner();
  await relative.execute(current, "home", false, () => {});
  expect(calls).toBe(0);
  expect(grokDispatchObservation(relative, current)?.code).toBe("grok-eligibility-refused");
  expect(grokDispatchObservation(relative, current)?.submission).toBe("not-submitted");

  const missing = createGrokDispatchAdapter({
    executable: EXECUTABLE,
    homeRoot: undefined as unknown as string,
    executableReady: () => {},
    model: MODEL,
    effort: EFFORT,
    promptDirectory: root,
    spawn,
  });
  const missingOwner = owner();
  await missing.execute(missingOwner, "no home", false, () => {});
  expect(calls).toBe(0);
  expect(grokDispatchObservation(missing, missingOwner)?.code).toBe("grok-eligibility-refused");

  const nulled = createGrokDispatchAdapter({
    executable: EXECUTABLE,
    homeRoot: "/opt/grok/home\0injected",
    executableReady: () => {},
    model: MODEL,
    effort: EFFORT,
    promptDirectory: root,
    spawn,
  });
  const nulledOwner = owner();
  await nulled.execute(nulledOwner, "nul", false, () => {});
  expect(calls).toBe(0);
  expect(grokDispatchObservation(nulled, nulledOwner)?.code).toBe("grok-eligibility-refused");
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
  const homeRoot = join(root, "grok-home");
  const missing = createGrokDispatchAdapter({ spawn, promptDirectory: root, model: MODEL, effort: EFFORT, homeRoot });
  const missingResult = await missing.readiness(source(), "user");
  expect(missingResult.readiness.ready).toBe(false);
  if (missingResult.readiness.ready) throw new Error("missing executable must refuse");
  expect(missingResult.readiness.code).toBe("grok-eligibility-refused");
  expect(missingResult.readiness.reason.toLowerCase()).not.toContain("claude");
  expect(missingResult.readiness.code).not.toMatch(/storage/i);

  const relative = createGrokDispatchAdapter({ executable: "grok", spawn, promptDirectory: root, model: MODEL, effort: EFFORT, homeRoot });
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

test("a missing executable does not spawn and is an eligibility refusal, not spawn-uncertain", async () => {
  const root = tempRoot();
  let calls = 0;
  const spawn: GrokSpawn = () => { calls += 1; throw new Error("missing executable must not spawn"); };
  const adapter = createGrokDispatchAdapter({
    executable: join(root, "missing-grok"),
    homeRoot: join(root, "grok-home"),
    model: MODEL,
    effort: EFFORT,
    promptDirectory: root,
    spawn,
  });
  const current = owner();
  await adapter.execute(current, "missing", false, () => {});
  expect(calls).toBe(0);
  const observation = grokDispatchObservation(adapter, current);
  expect(observation?.code).toBe("grok-eligibility-refused");
  expect(observation?.code).not.toBe("grok-spawn-uncertain");
  expect(observation?.submission).toBe("not-submitted");
  expect(observation?.nativeAcceptance).toBe("not-accepted");
  await adapter.execute(owner(), "missing again", false, () => {});
  expect(calls).toBe(0);
  expect(grokDispatchObservation(adapter, current)?.code).toBe("grok-eligibility-refused");

  const blocked = join(root, "not-executable");
  writeFileSync(blocked, "nope\n", { mode: 0o644 });
  chmodSync(blocked, 0o644);
  const denied = createGrokDispatchAdapter({
    executable: blocked,
    homeRoot: join(root, "grok-home"),
    model: MODEL,
    effort: EFFORT,
    promptDirectory: root,
    spawn,
  });
  const blockedOwner = owner();
  await denied.execute(blockedOwner, "blocked", false, () => {});
  expect(calls).toBe(0);
  expect(grokDispatchObservation(denied, blockedOwner)?.code).toBe("grok-eligibility-refused");
});

test("default executable check accepts a temp regular file and is not a PATH lookup", async () => {
  const root = tempRoot();
  const executable = join(root, "grok");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(executable, 0o755);
  const homeRoot = join(root, "pinned-home");
  const calls: { argv: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
  const adapter = createGrokDispatchAdapter({
    executable,
    homeRoot,
    model: MODEL,
    effort: EFFORT,
    promptDirectory: root,
    spawn: exitingSpawn(calls),
  });
  await adapter.execute(owner(), "check", false, () => {});
  expect(calls).toHaveLength(1);
  expect(calls[0]!.argv[0]).toBe(executable);
  expect(calls[0]!.env).toEqual(isolationEnv(homeRoot));
  expect(calls[0]!.env).not.toHaveProperty("PATH");
  expect(executable.startsWith(TEMP)).toBe(true);
});

test("an injected error with no pid stays uncertain, consumes the error, and waits for close", async () => {
  const root = tempRoot();
  let calls = 0;
  const spawn: GrokSpawn = () => {
    calls += 1;
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
    queueMicrotask(() => {
      child.emit("error", Object.assign(new Error("spawn EACCES"), { code: "EACCES" }));
      child.emit("close", null, null);
    });
    return child;
  };
  const { adapter } = adapterFor(root, spawn);
  const current = owner();
  await expect(adapter.execute(current, "eacces", false, () => {})).rejects.toMatchObject({ code: "EACCES" });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(calls).toBe(1);
  expect(grokDispatchObservation(adapter, current)).toMatchObject({ code: "grok-spawn-uncertain", submission: "unknown", wrapperCompletion: "closed" });
  await adapter.execute(owner(), "again", false, () => {});
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(calls).toBe(1);
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
  const unknown = await adapter.readiness(source(), "not-an-origin" as never);
  expect(unknown.readiness).toMatchObject({ ready: false, code: "grok-automation-unsupported" });
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
  expect(current.stopRequested).toBeUndefined();
  const spawned = Promise.withResolvers<void>();
  const pending = adapter.execute(current, "stop me", false, () => spawned.resolve());
  await spawned.promise;
  const refused = stopGrokDispatch(adapter, other);
  expect(refused.code).toBe("grok-stop-refused");
  expect(other.stopRequested).toBeUndefined();
  expect(child.killed).toBeNull();
  expect(unrelated.killed).toBeNull();
  const stopped = stopGrokDispatch(adapter, current);
  expect(stopped).toMatchObject({
    stopped: false,
    code: "grok-cancellation-unproven",
    killedPid: 5151,
    nativeCancellation: "unproven",
  });
  expect(child.killed).toBe("SIGTERM");
  expect(unrelated.killed).toBeNull();
  expect(calls).toBe(1);
  await pending;
  expect(grokDispatchObservation(adapter, current)?.nativeCancellation).toBe("unproven");
});

test("timeout kills only the spawned pid and reports cancellation unproven", async () => {
  const root = tempRoot();
  const child = new FakeChild(7373);
  const unrelated = new FakeChild(8484);
  let calls = 0;
  const spawn: GrokSpawn = () => { calls += 1; return child; };
  const { adapter } = adapterFor(root, spawn, { timeoutMs: 0 });
  const current = owner();
  await adapter.execute(current, "slow", false, () => {});
  expect(child.killed).toBe("SIGTERM");
  expect(child.pid).toBe(7373);
  expect(unrelated.killed).toBeNull();
  const observation = grokDispatchObservation(adapter, current);
  expect(observation?.nativeCancellation).toBe("unproven");
  expect(observation?.acceptedMessageId).toBeNull();
  expect(observation?.nativeAcceptance).toBe("unknown");
  expect((await adapter.successfulSettlement(current, source(), completed)).ready).toBe(false);
  await adapter.execute(owner(), "retry", true, () => {});
  expect(calls).toBe(1);
  expect(unrelated.killed).toBeNull();
});

test("close, not a premature exit, finishes the turn and keeps a stdout chunk that arrives after exit", async () => {
  const root = tempRoot();
  const child = new FakeChild(8181);
  const line = JSON.stringify({ type: "assistant", message: { id: "msg_0", content: [{ type: "text", text: "late-before-close" }] } });
  const spawn: GrokSpawn = () => {
    setTimeout(() => {
      child.emit("exit", 0, null);
      setTimeout(() => {
        child.stdout.write(`${line}\n`);
        child.emit("close", 0, null);
      }, 25);
    }, 0);
    return child;
  };
  const { adapter, chunks } = adapterFor(root, spawn);
  const current = owner();
  await adapter.execute(current, "late", false, () => {});
  expect(Buffer.concat(chunks).toString("utf8")).toContain("late-before-close");
  expect(readFileSync(join(root, "stdout.log"), "utf8")).toContain("late-before-close");
  expect(grokDispatchObservation(adapter, current)?.observedStreamMessageIds).toContain("msg_0");
  expect(grokDispatchObservation(adapter, current)?.exitCode).toBe(0);
});

test("exit signal is visible on the observation", async () => {
  const root = tempRoot();
  const child = new FakeChild(9191);
  const spawn: GrokSpawn = () => {
    queueMicrotask(() => {
      child.emit("exit", null, "SIGTERM");
      child.emit("close", null, "SIGTERM");
    });
    return child;
  };
  const { adapter } = adapterFor(root, spawn);
  const current = owner();
  await adapter.execute(current, "signal", false, () => {});
  const observation = grokDispatchObservation(adapter, current);
  expect(observation?.exitSignal).toBe("SIGTERM");
  expect(observation?.exitCode).toBeNull();
  expect(observation?.nativeAcceptance).toBe("unknown");
  expect(observation?.acceptedMessageId).toBeNull();
});

test("a prompt file collision refuses before spawn", async () => {
  const root = tempRoot();
  writeFileSync(join(root, `run-1.${NATIVE_ID}.0.prompt.txt`), "occupied", { flag: "wx", mode: 0o600 });
  let calls = 0;
  const spawn: GrokSpawn = () => { calls += 1; throw new Error("collision must not spawn"); };
  const { adapter } = adapterFor(root, spawn);
  const current = owner();
  await adapter.execute(current, "collide", false, () => {});
  expect(calls).toBe(0);
  expect(grokDispatchObservation(adapter, current)?.code).toBe("grok-eligibility-refused");
  expect(grokDispatchObservation(adapter, current)?.submission).toBe("not-submitted");
});

test("a second execute after an uncertain spawn does not spawn again", async () => {
  const root = tempRoot();
  let calls = 0;
  const spawn: GrokSpawn = () => { calls += 1; throw new Error("spawn failed after possible start"); };
  const { adapter } = adapterFor(root, spawn);
  const current = owner();
  await expect(adapter.execute(current, "once", false, () => {})).rejects.toBeInstanceOf(GrokDispatchRefusal);
  await adapter.execute(owner(), "again", true, () => {});
  expect(calls).toBe(1);
  expect(grokDispatchObservation(adapter, current)?.nativeAcceptance).not.toBe("accepted");
});

test("an error after a real pid stays spawn-uncertain and does not spawn again", async () => {
  const root = tempRoot();
  let calls = 0;
  const spawn: GrokSpawn = () => {
    calls += 1;
    const child = new FakeChild(4400 + calls);
    queueMicrotask(() => child.emit("error", new Error("died after start")));
    return child;
  };
  const { adapter } = adapterFor(root, spawn);
  const current = owner();
  await expect(adapter.execute(current, "once", false, () => {})).rejects.toThrow("died after start");
  expect(grokDispatchObservation(adapter, current)).toMatchObject({ code: "grok-spawn-uncertain", submission: "submitted", wrapperCompletion: "closed" });
  await adapter.execute(owner(), "again", true, () => {});
  expect(calls).toBe(1);
});

test("empty model or effort refuses before spawn", async () => {
  const root = tempRoot();
  let calls = 0;
  const spawn: GrokSpawn = () => { calls += 1; throw new Error("empty model must not spawn"); };
  const current = owner();
  const homeRoot = join(root, "grok-home");
  const missingModel = createGrokDispatchAdapter({
    executable: EXECUTABLE, homeRoot, effort: EFFORT, model: "", promptDirectory: root, spawn, executableReady: () => {},
  });
  await missingModel.execute(current, "no model", false, () => {});
  expect(grokDispatchObservation(missingModel, current)?.code).toBe("grok-eligibility-refused");
  expect(grokDispatchObservation(missingModel, current)?.submission).toBe("not-submitted");
  expect(grokDispatchObservation(missingModel, current)?.reason).toContain("model");
  const missingEffort = createGrokDispatchAdapter({
    executable: EXECUTABLE, homeRoot, model: MODEL, promptDirectory: root, spawn, executableReady: () => {},
  });
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
      if (child.killed === null) {
        child.emitExit(0, null);
        child.emitClose(0, null);
      }
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
  await adapter.execute(owner(), "continue", true, () => {});
  expect(calls).toBe(1);
  expect(child.killed).toBe("SIGTERM");
});

test("default spawn is fenced when Stop arrives during real async executable preparation", async () => {
  const root = tempRoot();
  const executable = join(root, "inert");
  const marker = join(root, "must-not-exist");
  writeFileSync(executable, `#!/bin/sh\n: > '${marker}'\n`, { mode: 0o755 });
  const adapter = createGrokDispatchAdapter({ executable, homeRoot: root, model: MODEL, effort: EFFORT, promptDirectory: root });
  const current = owner(NATIVE_ID, root);
  const processing = adapter.execute(current, "cancel during stat/access", false, () => {});
  expect(stopGrokDispatch(adapter, current)).toMatchObject({ code: "grok-cancelled-before-spawn", nativeCancellation: "not-attempted" });
  await processing;
  expect(existsSync(marker)).toBe(false);
  expect(grokDispatchObservation(adapter, current)).toMatchObject({ submission: "not-submitted", wrapperCompletion: "not-started", nativeAcceptance: "not-accepted" });
});

test("default spawn ENOENT after preparation is a proven local non-submission", async () => {
  const root = tempRoot();
  const executable = join(root, "inert");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const adapter = createGrokDispatchAdapter({ executable, homeRoot: root, model: MODEL, effort: EFFORT, promptDirectory: root });
  const current = owner(NATIVE_ID, root);
  expect(await adapter.prepare(current, "prepared before disappearance", false)).toBe(true);
  rmSync(executable);
  await adapter.executePrepared(current, root, () => {});
  expect(grokDispatchObservation(adapter, current)).toMatchObject({ code: "grok-eligibility-refused", submission: "not-submitted", nativeAcceptance: "not-accepted", wrapperCompletion: "closed" });
});

test("a turn owner cannot be prepared or executed twice", async () => {
  const root = tempRoot();
  const calls: { argv: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
  const { adapter } = adapterFor(root, exitingSpawn(calls));
  const current = owner();
  await adapter.execute(current, "once", false, () => {});
  await expect(adapter.execute(current, "not another turn", true, () => {})).rejects.toMatchObject({ code: "grok-eligibility-refused" });
  expect(calls).toHaveLength(1);
});

for (const trigger of ["stop", "timeout"] as const) {
  test(`${trigger} waits for delayed close and retains late stdout/stderr plus the final close signal`, async () => {
    const root = tempRoot();
    const child = new FakeChild(9301);
    const unrelated = new FakeChild(9302);
    child.kill = signal => {
      child.killed = signal ?? "SIGTERM";
      child.emitExit(null, "SIGTERM");
      setTimeout(() => {
        child.stdout.write('{"type":"assistant","id":"msg_late"}\n');
        child.stderr.write("late stderr\n");
        child.emitClose(null, "SIGKILL");
      }, 15);
      return true;
    };
    const { adapter, chunks } = adapterFor(root, () => child, { timeoutMs: trigger === "timeout" ? 0 : 1_000, stderrPath: join(root, "stderr.log") });
    const current = owner();
    const started = Promise.withResolvers<void>();
    const processing = adapter.execute(current, "drain", false, () => started.resolve());
    await started.promise;
    if (trigger === "stop") stopGrokDispatch(adapter, current);
    await processing;
    expect(Buffer.concat(chunks).toString()).toContain("msg_late");
    expect(readFileSync(join(root, "stdout.log"), "utf8")).toContain("msg_late");
    expect(readFileSync(join(root, "stderr.log"), "utf8")).toBe("late stderr\n");
    expect(grokDispatchObservation(adapter, current)).toMatchObject({ wrapperCompletion: "closed", exitSignal: "SIGKILL", nativeAcceptance: "unknown", nativeCancellation: "unproven", acceptedMessageId: null });
    expect(unrelated.killed).toBeNull();
  });
}

test("SIGTERM grace escalates SIGKILL only on the owned child and still waits for close", async () => {
  const root = tempRoot();
  const child = new FakeChild(9401);
  const unrelated = new FakeChild(9402);
  const signals: Array<NodeJS.Signals | number> = [];
  child.kill = signal => {
    signals.push(signal ?? "SIGTERM");
    if (signal === "SIGKILL") setTimeout(() => { child.stdout.write("after escalation\n"); child.emitClose(null, "SIGKILL"); }, 5);
    return true;
  };
  const { adapter, chunks } = adapterFor(root, () => child, { timeoutMs: 0 });
  const current = owner();
  await adapter.execute(current, "escalate", false, () => {});
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(unrelated.killed).toBeNull();
  expect(Buffer.concat(chunks).toString()).toContain("after escalation");
  expect(grokDispatchObservation(adapter, current)).toMatchObject({ wrapperCompletion: "closed", exitSignal: "SIGKILL", nativeCancellation: "unproven" });
});

test("a callback failure after PID creation terminates and drains without losing the original error", async () => {
  const root = tempRoot();
  const child = new FakeChild(9501);
  const failure = new Error("ready callback failed");
  child.kill = signal => {
    child.killed = signal ?? "SIGTERM";
    setTimeout(() => { child.stdout.write("callback-failure tail\n"); child.emitClose(null, "SIGTERM"); }, 5);
    return true;
  };
  const { adapter, chunks } = adapterFor(root, () => child);
  const current = owner();
  await expect(adapter.execute(current, "callback", false, () => { throw failure; })).rejects.toBe(failure);
  expect(child.killed).toBe("SIGTERM");
  expect(Buffer.concat(chunks).toString()).toContain("callback-failure tail");
  expect(grokDispatchObservation(adapter, current)).toMatchObject({ submission: "submitted", wrapperCompletion: "closed", code: "grok-spawn-uncertain" });
});

test("incremental lines preserve split UTF-8 bytes and a long newline-free prefix", async () => {
  const root = tempRoot();
  const calls: { argv: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
  const raw = JSON.stringify({ type: "assistant", id: "msg_é", content: [{ type: "text", text: `${"x".repeat(20_000)} café ☕` }] });
  const { adapter, chunks } = adapterFor(root, exitingSpawn(calls, child => {
    const bytes = Buffer.from(raw);
    for (let index = 0; index < bytes.length; index += 1) child.stdout.write(bytes.subarray(index, index + 1));
    // Deliberately no final newline: close must flush the remaining full line.
  }));
  const current = owner();
  await adapter.execute(current, "bytes", false, () => {});
  expect(Buffer.concat(chunks).toString()).toBe(raw);
  expect(grokDispatchObservation(adapter, current)).toMatchObject({ observedStreamMessageIds: ["msg_é"], toolBoundary: "clean", acceptedMessageId: null, nativeAcceptance: "unknown" });
});
