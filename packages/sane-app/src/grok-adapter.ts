import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createWriteStream, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import type {
  AutomationDispatchOrigin, DispatchOrigin, DispatchReadiness, DispatchSource, DispatchSupport, DispatchTerminalGuards, PinnedDispatchReadiness,
} from "../shared/conversation/dispatch-contract";
import type { HarnessDispatchAdapter } from "./harness-dispatch";
import type { RunOwner } from "./run-owner";

/** Caller-allocated Grok session ids match the Claude UUID shape, but they are
 * not Claude rows and they are not message ids. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Resolved Grok authority. A `cc` or `oc` pin is not a fallback target. */
const GROK_AUTHORITY = /^sane-native-v1:gk:[a-f0-9]{64}$/;
const AUTOMATIC_ORIGINS = ["queued-user", "questionnaire-response", "worker-report", "worker-exchange", "handoff"] as const satisfies readonly AutomationDispatchOrigin[];

const unsupported = (reason: string): DispatchSupport => ({ supported: false, reason });

/** Every automatic origin is explicitly unsupported. A missing key would also
 * stay unsupported at the registry; this adapter does not enable any of them. */
const automation: HarnessDispatchAdapter["automation"] = Object.freeze(
  Object.fromEntries(AUTOMATIC_ORIGINS.map(origin => [origin, unsupported(`Grok ${origin} dispatch is not qualified`)])) as Record<AutomationDispatchOrigin, DispatchSupport>,
);

export type GrokNativeAcceptance = "unknown" | "not-accepted";
export type GrokSubmission = "not-submitted" | "submitted" | "unknown";

/** Submission can be known while native acceptance stays unknown. `msg_0`,
 * wrapper exit, `result.subtype === "success"`, and a session UUID are not
 * acceptance. `acceptedMessageId` is null by construction. */
export type GrokTurnObservation = {
  readonly submission: GrokSubmission;
  readonly nativeAcceptance: GrokNativeAcceptance;
  readonly acceptedMessageId: null;
  readonly observedStreamMessageIds: readonly string[];
  readonly toolBoundary: "clean" | "refused";
  readonly exitCode: number | null;
  readonly nativeCancellation: "not-attempted" | "unproven";
  readonly code: string | null;
  readonly reason: string | null;
};

export type GrokStopResult = {
  /** Native cancellation is never claimed. Killing the wrapper is not proof. */
  readonly stopped: false;
  readonly code: "grok-stop-refused" | "grok-cancellation-unproven";
  readonly reason: string;
  readonly killedPid: number | null;
  readonly nativeCancellation: "unproven" | "not-attempted";
};

export class GrokDispatchRefusal extends Error {
  readonly name = "GrokDispatchRefusal";
  constructor(
    readonly code: "grok-eligibility-refused" | "grok-spawn-uncertain" | "grok-tool-boundary",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type GrokSpawnOptions = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdio: readonly ["ignore", "pipe", "pipe"];
};

/** Structural child. Tests inject this; the default wraps `node:child_process`. */
export type GrokSpawnedChild = {
  readonly pid?: number;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "exit" | "error" | "close", listener: (...args: any[]) => void): unknown;
};

export type GrokSpawn = (argv: readonly string[], options: GrokSpawnOptions) => GrokSpawnedChild;

export type GrokDispatchAdapterOptions = {
  /** Absolute executable. Missing or relative is an eligibility refusal. Never resolved from PATH. */
  executable?: string;
  /** Explicit model. Empty refuses before spawn. Not defaulted to a Claude model or grok-4.7. */
  model?: string;
  /** Explicit effort. Empty refuses before spawn. Not validated against the Claude effort enum. */
  effort?: string;
  /** Absolute directory for the prompt file written before spawn. */
  promptDirectory?: string;
  spawn?: GrokSpawn;
  stdout?: Writable;
  stderr?: Writable;
  stdoutPath?: string;
  stderrPath?: string;
  /** Only PATH and HOME are forwarded, and only when present here. */
  env?: NodeJS.ProcessEnv;
};

type MutableTurn = {
  submission: GrokSubmission;
  nativeAcceptance: GrokNativeAcceptance;
  observedStreamMessageIds: string[];
  toolBoundary: "clean" | "refused";
  exitCode: number | null;
  nativeCancellation: "not-attempted" | "unproven";
  code: string | null;
  reason: string | null;
};

type AdapterState = {
  spawnUncertain: boolean;
  boundaryBlocked: boolean;
  turns: WeakMap<RunOwner, MutableTurn>;
  children: WeakMap<RunOwner, GrokSpawnedChild>;
};

const states = new WeakMap<object, AdapterState>();

function stateFor(adapter: object): AdapterState | undefined {
  return states.get(adapter);
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function explicit(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value;
}

function denied(reason: string, code = "grok-eligibility-refused"): DispatchReadiness {
  return { ready: false, reason, code };
}

function freshTurn(): MutableTurn {
  return {
    submission: "not-submitted",
    nativeAcceptance: "not-accepted",
    observedStreamMessageIds: [],
    toolBoundary: "clean",
    exitCode: null,
    nativeCancellation: "not-attempted",
    code: null,
    reason: null,
  };
}

function publish(turn: MutableTurn): GrokTurnObservation {
  return Object.freeze({
    submission: turn.submission,
    nativeAcceptance: turn.nativeAcceptance,
    acceptedMessageId: null,
    observedStreamMessageIds: Object.freeze([...turn.observedStreamMessageIds]),
    toolBoundary: turn.toolBoundary,
    exitCode: turn.exitCode,
    nativeCancellation: turn.nativeCancellation,
    code: turn.code,
    reason: turn.reason,
  });
}

/** PATH and HOME only. Caller-identity variables are never copied, even if the
 * injected env bag contains them. Absence is what keeps the child from looking
 * like a human/local SANE caller. */
function childEnv(source: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  if (typeof source?.PATH === "string" && source.PATH.length > 0) env.PATH = source.PATH;
  if (typeof source?.HOME === "string" && source.HOME.length > 0) env.HOME = source.HOME;
  return env;
}

function defaultSpawn(argv: readonly string[], options: GrokSpawnOptions): GrokSpawnedChild {
  const [command, ...args] = argv;
  if (!command) throw new GrokDispatchRefusal("grok-eligibility-refused", "Grok executable is missing");
  const child: ChildProcess = nodeSpawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
  });
  return child;
}

function argvFor(executable: string, model: string, effort: string, nativeSessionId: string, resume: boolean, promptPath: string): readonly string[] {
  return Object.freeze([
    executable,
    "--model", model,
    "--reasoning-effort", effort,
    "--output-format", "streaming-messages-json",
    "--verbatim",
    "--no-plan",
    "--no-subagents",
    "--disable-web-search",
    "--permission-mode", "dontAsk",
    "--deny", "*",
    "--max-turns", "1",
    resume ? "--resume" : "--session-id", nativeSessionId,
    "--prompt-file", promptPath,
  ]);
}

function isToolUse(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(isToolUse);
  const record = value as Record<string, unknown>;
  if (record.type === "tool" || record.type === "tool_use" || record.type === "tool_result") return true;
  if (record.subtype === "tool_use" || record.subtype === "tool_result") return true;
  return Object.values(record).some(isToolUse);
}

function collectMessageIds(value: unknown, ids: string[]): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectMessageIds(item, ids);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id === "string" && record.id.startsWith("msg_")) ids.push(record.id);
  for (const nested of Object.values(record)) collectMessageIds(nested, ids);
}

/** Stream facts are evidence, never acceptance. `msg_0` is recorded as observed
 * and then discarded as an id. Success subtype and session UUID are ignored. */
function noteStreamLine(turn: MutableTurn, line: string): boolean {
  let event: unknown;
  try { event = JSON.parse(line); } catch { return false; }
  collectMessageIds(event, turn.observedStreamMessageIds);
  return isToolUse(event);
}

function waitForExit(child: GrokSpawnedChild): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    child.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error ?? new Error("Grok child emitted an error"));
    });
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      resolve({ code: code ?? null, signal: signal ?? null });
    });
  });
}

function openFile(path: string | undefined): Writable | undefined {
  if (!path) return undefined;
  return createWriteStream(path, { flags: "w", mode: 0o600 });
}

function endOwned(stream: Writable | undefined): Promise<void> {
  if (!stream) return Promise.resolve();
  return new Promise((resolve, reject) => {
    stream.once("finish", () => resolve());
    stream.once("error", reject);
    stream.end();
  });
}

type Capture = {
  readonly stdout: Writable[];
  readonly stderr: Writable[];
  readonly owned: Writable[];
};

function captureTargets(options: GrokDispatchAdapterOptions): Capture {
  const stdout = [options.stdout, openFile(options.stdoutPath)].filter((stream): stream is Writable => !!stream);
  const stderr = [options.stderr, openFile(options.stderrPath)].filter((stream): stream is Writable => !!stream);
  const owned = [options.stdoutPath ? stdout.at(-1) : undefined, options.stderrPath ? stderr.at(-1) : undefined].filter((stream): stream is Writable => !!stream);
  return { stdout, stderr, owned };
}

function forward(chunk: Buffer, targets: readonly Writable[]): void {
  for (const target of targets) target.write(chunk);
}

function killSpawned(child: GrokSpawnedChild): void {
  child.kill("SIGTERM");
}

/**
 * Offline Grok process boundary. This is not a receipt writer and it does not
 * register itself. Native acceptance stays unknown: wrapper exit, `msg_0`, and
 * a caller-allocated session UUID do not admit a message.
 */
export function createGrokDispatchAdapter<O extends RunOwner = RunOwner>(options: GrokDispatchAdapterOptions): HarnessDispatchAdapter<O> {
  const state: AdapterState = {
    spawnUncertain: false,
    boundaryBlocked: false,
    turns: new WeakMap(),
    children: new WeakMap(),
  };
  const spawn = options.spawn ?? defaultSpawn;
  let promptSerial = 0;

  const readiness = async (source: DispatchSource, origin: DispatchOrigin): Promise<PinnedDispatchReadiness> => {
    if (origin !== "user") {
      return { source, readiness: denied(automation[origin]?.reason ?? "Grok automatic dispatch is unsupported", "grok-automation-unsupported") };
    }
    if (typeof options.executable !== "string" || options.executable.length === 0) {
      return { source, readiness: denied("Grok executable is missing") };
    }
    if (!isAbsolute(options.executable)) {
      return { source, readiness: denied("Grok executable is not absolute; PATH lookup is not performed") };
    }
    if (source.authorityId === null) return { source, readiness: denied("Grok authority is unresolved") };
    if (!GROK_AUTHORITY.test(source.authorityId)) {
      return { source, readiness: denied("Grok authority is not a resolved sane-native-v1:gk identity") };
    }
    if (!uuid(source.nativeSessionId)) {
      return { source, readiness: denied("Grok native session id is not a caller-allocated UUID") };
    }
    if (typeof source.cwd !== "string" || !isAbsolute(source.cwd) || source.cwd.includes("\0")) {
      return { source, readiness: denied("Grok cwd is not an absolute path") };
    }
    return { source, readiness: { ready: true } };
  };

  const refuseBeforeSpawn = (owner: O, ready: (admitted: boolean) => void, reason: string) => {
    const turn = state.turns.get(owner) ?? freshTurn();
    turn.submission = "not-submitted";
    turn.nativeAcceptance = "not-accepted";
    turn.code = "grok-eligibility-refused";
    turn.reason = reason;
    state.turns.set(owner, turn);
    ready(false);
    owner.dispatchEvidence?.withheld();
  };

  const execute = async (owner: O, prompt: string, resume: boolean, ready: (admitted: boolean) => void): Promise<void> => {
    if (state.spawnUncertain) {
      ready(false);
      throw new GrokDispatchRefusal("grok-spawn-uncertain", "Refusing to spawn again after an uncertain Grok spawn");
    }
    if (state.boundaryBlocked) {
      ready(false);
      throw new GrokDispatchRefusal("grok-tool-boundary", "Refusing to continue after a Grok tool-use boundary");
    }
    const turn = freshTurn();
    state.turns.set(owner, turn);
    const source = owner.contextIdentity?.source;
    const nativeSessionId = source?.nativeSessionId;
    const cwd = source?.cwd ?? owner.run.cwd;
    const model = explicit(options.model) ?? explicit(owner.run.model);
    const effort = explicit(options.effort) ?? explicit(owner.run.effort);
    const executable = options.executable;
    if (source && source.harnessId !== "grok") {
      refuseBeforeSpawn(owner, ready, "Grok execute refuses a non-grok source; there is no Claude fallback");
      return;
    }
    if (typeof executable !== "string" || executable.length === 0 || !isAbsolute(executable)) {
      refuseBeforeSpawn(owner, ready, "Grok executable is missing or not absolute");
      return;
    }
    if (!model || !effort) {
      refuseBeforeSpawn(owner, ready, "Grok model and effort must be explicit non-empty strings");
      return;
    }
    if (!uuid(nativeSessionId)) {
      refuseBeforeSpawn(owner, ready, "Grok native session id is not a caller-allocated UUID");
      return;
    }
    if (typeof cwd !== "string" || !isAbsolute(cwd) || cwd.includes("\0")) {
      refuseBeforeSpawn(owner, ready, "Grok cwd is not an absolute path");
      return;
    }
    if (typeof options.promptDirectory !== "string" || !isAbsolute(options.promptDirectory)) {
      refuseBeforeSpawn(owner, ready, "Grok prompt directory is missing or not absolute");
      return;
    }
    const runToken = /^[A-Za-z0-9._-]{1,80}$/.test(owner.run.runId) ? owner.run.runId : "prompt";
    const promptPath = join(options.promptDirectory, `${runToken}.${promptSerial++}.prompt.txt`);
    try {
      writeFileSync(promptPath, Buffer.from(prompt, "utf8"), { flag: "wx", mode: 0o600 });
    } catch {
      refuseBeforeSpawn(owner, ready, "Grok prompt file was not written");
      return;
    }
    const argv = argvFor(executable, model, effort, nativeSessionId, resume, promptPath);
    const env = childEnv(options.env);
    try { owner.dispatchEvidence?.beforeNative(); } catch (error) {
      ready(false);
      throw error;
    }
    let child: GrokSpawnedChild;
    try {
      child = spawn(argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      state.spawnUncertain = true;
      turn.submission = "unknown";
      turn.nativeAcceptance = "unknown";
      turn.code = "grok-spawn-uncertain";
      try { owner.dispatchEvidence?.outcome("unknown"); } catch { /* latch already forbids a retry */ }
      ready(false);
      throw new GrokDispatchRefusal("grok-spawn-uncertain", "Grok spawn was uncertain; refusing to retry", { cause: error });
    }
    if (!child || typeof child.pid !== "number" || !Number.isInteger(child.pid) || child.pid <= 0) {
      state.spawnUncertain = true;
      turn.submission = "unknown";
      turn.nativeAcceptance = "unknown";
      turn.code = "grok-spawn-uncertain";
      try { owner.dispatchEvidence?.outcome("unknown"); } catch { /* no second spawn */ }
      ready(false);
      throw new GrokDispatchRefusal("grok-spawn-uncertain", "Grok spawn did not return a child pid; refusing to guess or retry");
    }
    state.children.set(owner, child);
    turn.submission = "submitted";
    turn.nativeAcceptance = "unknown";
    turn.code = null;
    try { owner.dispatchEvidence?.outcome("submitted", "unknown"); } catch (error) {
      state.spawnUncertain = true;
      ready(false);
      throw error;
    }
    // Launch admission only. This is not native acceptance.
    ready(true);
    const capture = captureTargets(options);
    let toolUse = false;
    const watch = (stream: Readable | null, targets: readonly Writable[]) => {
      if (!stream) return () => {};
      let pending = "";
      const onLine = (line: string) => {
        if (!line.trim() || toolUse) return;
        if (!noteStreamLine(turn, line)) return;
        toolUse = true;
        turn.toolBoundary = "refused";
        turn.code = "grok-tool-boundary";
        turn.reason = "Grok tool-use event is a boundary refusal";
        turn.nativeCancellation = "unproven";
        state.boundaryBlocked = true;
        killSpawned(child);
      };
      stream.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        forward(bytes, targets);
        pending += bytes.toString("utf8");
        let newline = pending.indexOf("\n");
        while (newline !== -1) {
          const line = pending.slice(0, newline).replace(/\r$/, "");
          pending = pending.slice(newline + 1);
          onLine(line);
          newline = pending.indexOf("\n");
        }
      });
      return () => {
        if (pending.trim()) onLine(pending);
        pending = "";
      };
    };
    const flushStdout = watch(child.stdout, capture.stdout);
    const flushStderr = watch(child.stderr, capture.stderr);
    try {
      const exit = await waitForExit(child);
      turn.exitCode = exit.code;
      flushStdout();
      flushStderr();
    } catch (error) {
      state.spawnUncertain = true;
      turn.submission = turn.submission === "submitted" ? "submitted" : "unknown";
      turn.nativeAcceptance = "unknown";
      turn.code = "grok-spawn-uncertain";
      try { owner.dispatchEvidence?.outcome("unknown"); } catch { /* still no retry */ }
      ready(false);
      throw new GrokDispatchRefusal("grok-spawn-uncertain", "Grok child failed without a proven outcome; refusing to spawn again", { cause: error });
    } finally {
      await Promise.all(capture.owned.map(endOwned));
    }
    if (toolUse || turn.toolBoundary === "refused") {
      state.boundaryBlocked = true;
      turn.toolBoundary = "refused";
      turn.nativeAcceptance = "unknown";
      turn.code = "grok-tool-boundary";
      turn.reason = "Grok tool-use event is a boundary refusal";
      if (turn.nativeCancellation !== "unproven") turn.nativeCancellation = "unproven";
      throw new GrokDispatchRefusal("grok-tool-boundary", "Grok tool-use event is a boundary refusal; the turn is not success and native cancellation is unproven");
    }
  };

  const successfulSettlement = async (owner: O, _source: DispatchSource, guards: () => DispatchTerminalGuards): Promise<DispatchReadiness> => {
    let exitCode: number | null = null;
    try {
      guards();
      exitCode = state.turns.get(owner)?.exitCode ?? null;
    } catch {
      exitCode = state.turns.get(owner)?.exitCode ?? null;
    }
    return denied(
      `Grok wrapper exit ${exitCode === null ? "unknown" : String(exitCode)} does not prove native completion or cancellation`,
      "grok-native-completion-unproven",
    );
  };

  const adapter: HarnessDispatchAdapter<O> = Object.freeze({
    id: "grok",
    automation,
    readiness,
    execute,
    successfulSettlement,
  });
  states.set(adapter, state);
  return adapter;
}

/** Kills only the child this adapter spawned for `owner`. No process-group
 * guess, no unrelated pid, and no claim that native work stopped. */
export function stopGrokDispatch(adapter: HarnessDispatchAdapter, owner: RunOwner): GrokStopResult {
  const state = stateFor(adapter);
  const child = state?.children.get(owner);
  const pid = child?.pid;
  if (!state || !child || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return {
      stopped: false,
      code: "grok-stop-refused",
      reason: "No Grok child was spawned for this owner; refusing to guess a pid",
      killedPid: null,
      nativeCancellation: "not-attempted",
    };
  }
  killSpawned(child);
  const turn = state.turns.get(owner);
  if (turn) turn.nativeCancellation = "unproven";
  return {
    stopped: false,
    code: "grok-cancellation-unproven",
    reason: "Killed only the spawned Grok child; native cancellation is unproven",
    killedPid: pid,
    nativeCancellation: "unproven",
  };
}

export function grokDispatchObservation(adapter: HarnessDispatchAdapter, owner: RunOwner): GrokTurnObservation | undefined {
  const turn = stateFor(adapter)?.turns.get(owner);
  return turn ? publish(turn) : undefined;
}
