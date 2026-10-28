import { spawn as nodeSpawn } from "node:child_process";
import { constants, createWriteStream, openSync, unlinkSync, writeFileSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";
import type {
  AutomationDispatchOrigin, DispatchOrigin, DispatchReadiness, DispatchSource, DispatchSupport, PinnedDispatchReadiness,
} from "../shared/conversation/dispatch-contract";
import type { HarnessDispatchAdapter } from "./harness-dispatch";
import type { RunOwner } from "./run-owner";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GROK_AUTHORITY = /^sane-native-v1:gk:[a-f0-9]{64}$/;
const AUTOMATIC_ORIGINS = ["queued-user", "questionnaire-response", "worker-report", "worker-exchange", "handoff"] as const satisfies readonly AutomationDispatchOrigin[];
const IMPORTED_SURFACES = ["AGENTS", "RULES", "HOOKS", "MCPS", "SKILLS"] as const;
const DEFAULT_TIMEOUT_MS = 180_000;
const TERM_GRACE_MS = 1_000;
const KILL_GRACE_MS = 1_000;
const automation = Object.freeze(Object.fromEntries(AUTOMATIC_ORIGINS.map(origin => [origin, {
  supported: false, reason: `Grok ${origin} dispatch is not qualified`,
}])) as Record<AutomationDispatchOrigin, Extract<DispatchSupport, { supported: false }>>);

export type GrokNativeAcceptance = "unknown" | "not-accepted";
export type GrokSubmission = "not-submitted" | "submitted" | "unknown";

/** Wrapper processing evidence only. Neither close nor a stream id is native acceptance. */
export type GrokTurnObservation = {
  readonly submission: GrokSubmission;
  readonly nativeAcceptance: GrokNativeAcceptance;
  readonly acceptedMessageId: null;
  readonly observedStreamMessageIds: readonly string[];
  readonly toolBoundary: "clean" | "refused";
  readonly exitCode: number | null;
  /** Final close signal when available; exit alone never finishes processing. */
  readonly exitSignal: NodeJS.Signals | null;
  readonly wrapperCompletion: "not-started" | "running" | "closed" | "incomplete";
  readonly nativeCancellation: "not-attempted" | "unproven";
  readonly code: string | null;
  readonly reason: string | null;
};

export type GrokStopResult = {
  readonly stopped: false;
  readonly code: "grok-stop-refused" | "grok-cancelled-before-spawn" | "grok-cancellation-unproven";
  readonly reason: string;
  readonly killedPid: number | null;
  readonly nativeCancellation: "unproven" | "not-attempted";
};

export class GrokDispatchRefusal extends Error {
  readonly name = "GrokDispatchRefusal";
  constructor(
    readonly code: "grok-eligibility-refused" | "grok-spawn-uncertain" | "grok-tool-boundary" | "grok-cancellation-unproven" | "grok-wrapper-close-incomplete",
    message: string,
    options?: ErrorOptions,
  ) { super(message, options); }
}

export type GrokSpawnOptions = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdio: readonly ["ignore", "pipe", "pipe"];
};
export type GrokSpawnedChild = {
  readonly pid?: number;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "exit" | "error" | "close", listener: (...args: any[]) => void): unknown;
};
export type GrokSpawn = (argv: readonly string[], options: GrokSpawnOptions) => GrokSpawnedChild;

export type GrokDispatchAdapterOptions = {
  /** Absolute only; never discovered through PATH. */
  executable?: string;
  homeRoot: string;
  model?: string;
  effort?: string;
  promptDirectory?: string;
  spawn?: GrokSpawn;
  stdout?: Writable;
  stderr?: Writable;
  stdoutPath?: string;
  stderrPath?: string;
  /** Explicit offline fixture seam, not implicitly enabled by injecting spawn. */
  executableReady?: () => void | Promise<void>;
  timeoutMs?: number;
};

type MutableObservation = Omit<{ -readonly [K in keyof GrokTurnObservation]: GrokTurnObservation[K] }, "acceptedMessageId" | "observedStreamMessageIds"> & {
  observedStreamMessageIds: string[];
};
type Capture = { stdout: Writable[]; stderr: Writable[]; owned: Writable[] };
type Turn = {
  phase: "preparing" | "prepared" | "launching" | "finished";
  closed: ReturnType<typeof Promise.withResolvers<void>>;
  observation: MutableObservation;
  prepared?: { argv: readonly string[]; cwd: string; promptPath: string; capture: Capture };
  child?: GrokSpawnedChild;
  terminate?: (code: string, reason: string) => void;
  failure?: unknown;
  cleanup?: Promise<void>;
  captureListeners?: Array<{ target: Writable; listener: (error: Error) => void }>;
};
type AdapterState = { blocked: boolean; turns: WeakMap<RunOwner, Turn> };
const states = new WeakMap<object, AdapterState>();

/** Preparation has no native boundary and may run before admission. Launch is
 * synchronous up to spawn, including the final owner.stopRequested fence. */
export type GrokDispatchAdapter<O extends RunOwner = RunOwner> = HarnessDispatchAdapter<O> & {
  prepare(owner: O, prompt: string, resume: boolean): Promise<boolean>;
  executePrepared(owner: O, homeRoot: string, ready: (admitted: boolean) => void): Promise<void>;
  finish(owner: O): Promise<void>;
  /** Actual original wrapper/sink close, including a close after bounded drain. */
  closed(owner: O): Promise<void>;
};

function freshObservation(): MutableObservation {
  return {
    submission: "not-submitted", nativeAcceptance: "not-accepted", observedStreamMessageIds: [],
    toolBoundary: "clean", exitCode: null, exitSignal: null, wrapperCompletion: "not-started",
    nativeCancellation: "not-attempted", code: null, reason: null,
  };
}
function denied(reason: string, code = "grok-eligibility-refused"): DispatchReadiness { return { ready: false, reason, code }; }
function absolute(value: unknown): value is string { return typeof value === "string" && isAbsolute(value) && !value.includes("\0"); }
function explicit(value: unknown): value is string { return typeof value === "string" && value.trim() !== ""; }
function validPid(pid: unknown): pid is number { return typeof pid === "number" && Number.isInteger(pid) && pid > 0; }
function asSignal(value: unknown): NodeJS.Signals | null { return typeof value === "string" && value.length > 0 ? value as NodeJS.Signals : null; }
function availabilityError(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && ["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes(String(error.code));
}
function notSubmitted(turn: Turn, reason: string, cancelled = false): void {
  Object.assign(turn.observation, {
    submission: "not-submitted", nativeAcceptance: "not-accepted",
    nativeCancellation: "not-attempted",
    code: cancelled ? "grok-cancelled-before-spawn" : "grok-eligibility-refused", reason,
  });
}

/** Isolation flags and an explicit env, not a SANE authority sandbox. Without
 * PATH a shell/libc can still use default search directories. No caller envelope
 * or HOME is forwarded; tool denial/detection remain separate boundaries. */
function childEnv(homeRoot: string, nativeSessionId: string): Record<string, string> {
  const env: Record<string, string> = {
    GROK_HOME: homeRoot, GROK_MEMORY: "0", GROK_MANAGED_MCPS_ENABLED: "false", GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED: "false",
    // Locally minted refusal marker, never inherited caller authority. Not a sandbox.
    SANE_UNQUALIFIED_NATIVE: "1", GROK_SESSION_ID: nativeSessionId,
  };
  for (const vendor of ["CLAUDE", "CURSOR"] as const) {
    for (const surface of IMPORTED_SURFACES) env[`GROK_${vendor}_${surface}_ENABLED`] = "false";
  }
  return env;
}

async function assertExecutableFile(path: string): Promise<void> {
  try {
    if (!(await stat(path)).isFile()) throw new Error("not a regular file");
    await access(path, constants.X_OK);
  } catch (error) {
    throw new GrokDispatchRefusal("grok-eligibility-refused", "Grok executable is missing or not executable", { cause: error });
  }
}
function defaultSpawn(argv: readonly string[], options: GrokSpawnOptions): GrokSpawnedChild {
  return nodeSpawn(argv[0]!, argv.slice(1), { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true });
}
function argvFor(executable: string, model: string, effort: string, nativeSessionId: string, resume: boolean, promptPath: string): readonly string[] {
  return Object.freeze([
    executable, "--model", model, "--reasoning-effort", effort, "--output-format", "streaming-messages-json",
    "--verbatim", "--no-plan", "--no-subagents", "--disable-web-search", "--permission-mode", "dontAsk", "--deny", "*", "--max-turns", "1",
    resume ? "--resume" : "--session-id", nativeSessionId, "--prompt-file", promptPath,
  ]);
}

/** Deliberately retains the conservative recursive tool grammar until a narrower
 * protocol grammar is qualified. One traversal also collects raw stream ids. */
function inspectEvent(value: unknown, ids: string[]): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  let tool = record.type === "tool" || record.type === "tool_use" || record.type === "tool_result"
    || record.subtype === "tool_use" || record.subtype === "tool_result";
  if (typeof record.id === "string" && record.id.startsWith("msg_")) ids.push(record.id);
  for (const nested of Object.values(record)) if (inspectEvent(nested, ids)) tool = true;
  return tool;
}
function noteStreamLine(turn: Turn, line: string): void {
  let event: unknown;
  try { event = JSON.parse(line); } catch { return; }
  if (event && typeof event === "object" && (event as any).type === "result" && (event as any).is_error === true) {
    turn.failure ??= new Error("Grok reported an error result; start a new conversation instead of retrying");
  }
  if (!inspectEvent(event, turn.observation.observedStreamMessageIds) || turn.observation.toolBoundary === "refused") return;
  turn.observation.toolBoundary = "refused";
  turn.terminate?.("grok-tool-boundary", "Grok tool-use event is a boundary refusal");
}
function watch(stream: Readable | null, targets: readonly Writable[], turn: Turn, fail: (error: unknown) => void): () => void {
  if (!stream) return () => {};
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const scan = (text: string) => {
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline === -1) { pending += text; return; }
    // Detach complete lines before callbacks: a fake or already-exiting child
    // can close synchronously when a tool-boundary callback sends SIGTERM.
    const complete = pending + text.slice(0, lastNewline + 1);
    pending = text.slice(lastNewline + 1);
    let start = 0;
    for (let newline = complete.indexOf("\n"); newline !== -1; newline = complete.indexOf("\n", start)) {
      noteStreamLine(turn, complete.slice(start, newline).replace(/\r$/, ""));
      start = newline + 1;
    }
  };
  stream.on("error", fail);
  stream.on("data", (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    try {
      for (const target of targets) target.write(bytes);
      scan(decoder.write(bytes));
    } catch (error) { fail(error); }
  });
  return () => { scan(decoder.end()); if (pending.trim()) noteStreamLine(turn, pending); pending = ""; };
}
function captureTargets(options: GrokDispatchAdapterOptions): Capture {
  const capture: Capture = { stdout: options.stdout ? [options.stdout] : [], stderr: options.stderr ? [options.stderr] : [], owned: [] };
  try {
    for (const [path, targets] of [[options.stdoutPath, capture.stdout], [options.stderrPath, capture.stderr]] as const) {
      if (!path) continue;
      // Open synchronously during local preparation, not after a live child exists.
      const stream = createWriteStream(path, { fd: openSync(path, "w", 0o600), autoClose: true });
      capture.owned.push(stream);
      targets.push(stream);
    }
  } catch (error) { for (const stream of capture.owned) stream.destroy(); throw error; }
  return capture;
}
function endOwned(stream: Writable): Promise<void> {
  if (stream.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => { stream.once("finish", resolve); stream.once("error", reject); stream.end(); });
}

export function createGrokDispatchAdapter<O extends RunOwner = RunOwner>(options: GrokDispatchAdapterOptions): GrokDispatchAdapter<O> {
  const state: AdapterState = { blocked: false, turns: new WeakMap() };
  const spawn = options.spawn ?? defaultSpawn;
  let promptSerial = 0;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const readiness = async (source: DispatchSource, origin: DispatchOrigin): Promise<PinnedDispatchReadiness> => {
    let reason: string | undefined;
    if (origin !== "user") return { source, readiness: denied(automation[origin]?.reason ?? "Grok automatic dispatch is unsupported", "grok-automation-unsupported") };
    if (!absolute(options.executable)) reason = "Grok executable is missing or not absolute; PATH lookup is not performed";
    else if (!absolute(options.homeRoot)) reason = "Grok homeRoot is missing or not absolute";
    else if (source.harnessId !== "grok" || !source.authorityId || !GROK_AUTHORITY.test(source.authorityId)) reason = "Grok authority is unresolved or not a sane-native-v1:gk identity";
    else if (!source.nativeSessionId || !UUID.test(source.nativeSessionId)) reason = "Grok native session id is not a caller-allocated UUID";
    else if (!absolute(source.cwd)) reason = "Grok cwd is not absolute";
    return { source, readiness: reason ? denied(reason) : { ready: true } };
  };

  const finish = (owner: O): Promise<void> => {
    const turn = state.turns.get(owner);
    if (!turn) return Promise.resolve();
    if (!turn.prepared) { turn.phase = "finished"; turn.closed.resolve(); return Promise.resolve(); }
    // An incomplete child remains owned and keeps its sinks until actual close.
    if (turn.child && turn.observation.wrapperCompletion !== "closed") return Promise.resolve();
    turn.phase = "finished";
    return turn.cleanup ??= (async () => {
      const prepared = turn.prepared!;
      try { await Promise.all(prepared.capture.owned.map(endOwned)); }
      finally {
        for (const { target, listener } of turn.captureListeners ?? []) target.off("error", listener);
        // Retain possible-execution prompt evidence; it must never be replayed.
        if (turn.observation.submission === "not-submitted") {
          try { unlinkSync(prepared.promptPath); } catch { /* Best-effort local-only cleanup. */ }
        }
        turn.closed.resolve();
      }
    })();
  };

  const prepare = async (owner: O, prompt: string, resume: boolean): Promise<boolean> => {
    if (state.turns.has(owner)) throw new GrokDispatchRefusal("grok-eligibility-refused", "A Grok turn may only be prepared once");
    const turn: Turn = { phase: "preparing", observation: freshObservation(), closed: Promise.withResolvers<void>() };
    state.turns.set(owner, turn);
    const source = owner.contextIdentity?.source;
    const model = options.model ?? owner.run.model, effort = options.effort ?? owner.run.effort;
    const refuse = (reason: string) => { notSubmitted(turn, reason); owner.dispatchEvidence?.withheld(); return false; };
    if (state.blocked) return refuse("Refusing to spawn again after an uncertain or interrupted Grok turn");
    if (owner.stopRequested) { notSubmitted(turn, "Grok stop was requested before spawn", true); return false; }
    if (!source || source.harnessId !== "grok" || !source.authorityId || !GROK_AUTHORITY.test(source.authorityId)
      || !source.nativeSessionId || !UUID.test(source.nativeSessionId) || !absolute(source.cwd)) return refuse("Grok source identity or cwd is invalid");
    if (!absolute(options.executable) || !absolute(options.homeRoot) || !absolute(options.promptDirectory)) return refuse("Grok executable, homeRoot, and prompt directory must be absolute");
    if (!explicit(model) || !explicit(effort)) return refuse("Grok model and effort must be explicit non-empty strings");
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return refuse("Grok timeoutMs must be a finite non-negative number");
    try {
      if (options.executableReady) await options.executableReady();
      else await assertExecutableFile(options.executable);
      if (owner.stopRequested) { notSubmitted(turn, "Grok stop was requested during executable preparation", true); return false; }
      const runToken = /^[A-Za-z0-9._-]{1,80}$/.test(owner.run.runId) ? owner.run.runId : "prompt";
      const promptPath = join(options.promptDirectory, `${runToken}.${source.nativeSessionId}.${promptSerial++}.prompt.txt`);
      writeFileSync(promptPath, Buffer.from(prompt, "utf8"), { flag: "wx", mode: 0o600 });
      let capture: Capture;
      try { capture = captureTargets(options); } catch (error) { try { unlinkSync(promptPath); } catch {} throw error; }
      turn.prepared = { argv: argvFor(options.executable, model, effort, source.nativeSessionId, resume, promptPath), cwd: source.cwd, promptPath, capture };
      turn.captureListeners = [];
      for (const target of new Set([...capture.stdout, ...capture.stderr])) {
        const listener = (error: Error) => { turn.failure ??= error; turn.terminate?.("grok-spawn-uncertain", "Grok output capture failed"); };
        target.on("error", listener);
        turn.captureListeners.push({ target, listener });
      }
      turn.phase = "prepared";
      return true;
    } catch (error) {
      if (owner.stopRequested) { notSubmitted(turn, "Grok stop was requested during local preparation", true); return false; }
      return refuse(error instanceof Error ? error.message : "Grok local preparation failed");
    }
  };

  const executePrepared = async (owner: O, homeRoot: string, ready: (admitted: boolean) => void): Promise<void> => {
    const turn = state.turns.get(owner);
    if (!turn?.prepared) { ready(false); return; }
    const observation = turn.observation;
    if (turn.phase !== "prepared") throw new GrokDispatchRefusal("grok-spawn-uncertain", "A Grok turn cannot be launched twice");
    turn.phase = "launching";
    if (!absolute(homeRoot)) { notSubmitted(turn, "Grok launch homeRoot is not absolute"); ready(false); return; }
    if (turn.failure) throw turn.failure;
    if (owner.stopRequested) { notSubmitted(turn, "Grok stop was requested before spawn", true); ready(false); return; }
    owner.dispatchEvidence?.beforeNative();
    // This is the final synchronous fence for BOTH default and injected spawn.
    if (owner.stopRequested) { notSubmitted(turn, "Grok stop was requested before spawn", true); ready(false); return; }
    if (state.blocked) { notSubmitted(turn, "Refusing to spawn after an interrupted or uncertain Grok turn"); ready(false); return; }
    // A re-entrant injected spawn may call stop after creating a PID but before
    // returning its handle. From this point, withholding is no longer proven.
    observation.submission = "unknown";
    observation.nativeAcceptance = "unknown";
    let child: GrokSpawnedChild;
    try { child = spawn(turn.prepared.argv, { cwd: turn.prepared.cwd, env: childEnv(homeRoot, owner.contextIdentity!.source.nativeSessionId!), stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) {
      // Only nodeSpawn's local availability error proves withholding. An
      // injected callback can throw after side effects, whatever its error code.
      if (!options.spawn && availabilityError(error)) { notSubmitted(turn, "Grok executable is missing or not executable"); ready(false); return; }
      state.blocked = true;
      Object.assign(observation, { submission: "unknown", nativeAcceptance: "unknown", code: "grok-spawn-uncertain", reason: "Grok spawn may have executed; no retry is permitted" });
      throw new GrokDispatchRefusal("grok-spawn-uncertain", observation.reason!, { cause: error });
    }
    if (!child || typeof child.on !== "function") {
      state.blocked = true;
      Object.assign(observation, { submission: "unknown", nativeAcceptance: "unknown", code: "grok-spawn-uncertain", reason: "Grok spawn returned no observable child; execution is unknown" });
      throw new GrokDispatchRefusal("grok-spawn-uncertain", observation.reason!);
    }
    turn.child = child;
    observation.submission = validPid(child.pid) ? "submitted" : "unknown";
    observation.nativeAcceptance = "unknown";
    observation.wrapperCompletion = "running";
    let closed = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const drained = Promise.withResolvers<"closed" | "incomplete">();
    const clearTimers = () => { clearTimeout(timeout); clearTimeout(escalation); };
    const signal = (value: NodeJS.Signals) => {
      if (!closed && validPid(child.pid)) { try { child.kill(value); } catch (error) { turn.failure ??= error; } }
    };
    turn.terminate = (code, reason) => {
      state.blocked = true;
      if (observation.nativeCancellation !== "unproven") Object.assign(observation, { nativeCancellation: "unproven", code, reason });
      if (!closed && observation.wrapperCompletion === "incomplete") { signal("SIGKILL"); return; }
      if (closed || escalation !== undefined) return;
      clearTimeout(timeout);
      // Schedule before kill: injected children may emit close synchronously.
      escalation = setTimeout(() => {
        escalation = setTimeout(() => {
          observation.wrapperCompletion = "incomplete";
          observation.code = "grok-wrapper-close-incomplete";
          observation.reason = "Owned Grok child did not close after SIGTERM and SIGKILL grace; wrapper drain is incomplete and native cancellation is unproven";
          drained.resolve("incomplete");
        }, KILL_GRACE_MS);
        signal("SIGKILL");
      }, TERM_GRACE_MS);
      signal("SIGTERM");
    };
    const fail = (error: unknown) => { turn.failure ??= error; turn.terminate!("grok-spawn-uncertain", "Grok child or output capture failed; native outcome is unknown"); };
    // All process handlers precede evidence/ready callbacks and stream consumers.
    let flushStdout = () => {}, flushStderr = () => {};
    try {
      child.on("error", (error: unknown) => {
        if (!options.spawn && !validPid(child.pid) && availabilityError(error)) notSubmitted(turn, "Grok executable is missing or not executable");
        else fail(error);
      });
      child.on("exit", (code: number | null, exitSignal: unknown) => {
        if (closed) return;
        observation.exitCode = typeof code === "number" ? code : null;
        observation.exitSignal = asSignal(exitSignal);
      });
      child.on("close", (code: number | null, closeSignal: unknown) => {
        closed = true;
        clearTimers();
        observation.exitCode = typeof code === "number" ? code : null;
        observation.exitSignal = asSignal(closeSignal);
        observation.wrapperCompletion = "closed";
        try { flushStdout(); flushStderr(); } catch (error) { fail(error); }
        drained.resolve("closed");
        // A late close after the bounded handle finishes still owns its sinks.
        void finish(owner).catch(error => { turn.failure ??= error; state.blocked = true; });
      });
    } catch (error) { fail(error); }
    try {
      flushStdout = watch(child.stdout, turn.prepared.capture.stdout, turn, fail);
      flushStderr = watch(child.stderr, turn.prepared.capture.stderr, turn, fail);
      if (!closed && escalation === undefined) timeout = setTimeout(() => turn.terminate!("grok-cancellation-unproven", "Grok child exceeded the bounded timeout; native cancellation is unproven"), timeoutMs);
      owner.dispatchEvidence?.outcome(observation.submission, "unknown");
      ready(observation.submission === "submitted");
      if (owner.stopRequested) turn.terminate("grok-cancellation-unproven", "Grok stop requested; only the owned wrapper is terminated and native cancellation is unproven");
    } catch (error) { fail(error); }
    const completion = await drained.promise;
    try { await finish(owner); } catch (error) { turn.failure ??= error; }
    if (completion === "incomplete") throw new GrokDispatchRefusal("grok-wrapper-close-incomplete", observation.reason!, { cause: turn.failure });
    if (turn.failure) throw turn.failure;
    if (observation.submission === "unknown") {
      state.blocked = true;
      observation.code = "grok-spawn-uncertain";
      observation.reason = "Grok execution could not be proven submitted or withheld";
      throw new GrokDispatchRefusal("grok-spawn-uncertain", observation.reason);
    }
    if (observation.toolBoundary === "refused") throw new GrokDispatchRefusal("grok-tool-boundary", observation.reason ?? "Grok tool-use boundary refused");
  };

  const adapter: GrokDispatchAdapter<O> = Object.freeze({
    id: "grok", automation, readiness, prepare, executePrepared, finish,
    closed(owner: O) { return state.turns.get(owner)?.closed.promise ?? Promise.resolve(); },
    async execute(owner: O, prompt: string, resume: boolean, ready: (admitted: boolean) => void) {
      let failure: { error: unknown } | undefined;
      try {
        if (await prepare(owner, prompt, resume)) await executePrepared(owner, options.homeRoot, ready);
        else ready(false);
      } catch (error) { failure = { error }; }
      try { await finish(owner); } catch (error) { failure ??= { error }; }
      if (failure) throw failure.error;
    },
    async successfulSettlement(owner: O) {
      const exitCode = state.turns.get(owner)?.observation.exitCode;
      return denied(`Grok wrapper exit ${exitCode ?? "unknown"} does not prove native completion or cancellation`, "grok-native-completion-unproven");
    },
  });
  states.set(adapter, state);
  return adapter;
}

/** Stop never claims native cancellation. The owner fence also covers preparation. */
export function stopGrokDispatch(adapter: HarnessDispatchAdapter, owner: RunOwner): GrokStopResult {
  const turn = states.get(adapter)?.turns.get(owner);
  if (!turn) return { stopped: false, code: "grok-stop-refused", reason: "This adapter has no Grok turn for the original owner", killedPid: null, nativeCancellation: "not-attempted" };
  owner.stopRequested = true;
  const pid = turn?.child?.pid;
  if (!turn?.child) {
    if (turn && turn.observation.submission !== "not-submitted") {
      turn.observation.nativeCancellation = "unproven";
      turn.observation.code ??= "grok-cancellation-unproven";
      turn.observation.reason ??= "Grok stop requested while execution is unknown and no owned child handle is available";
      return { stopped: false, code: "grok-cancellation-unproven", reason: "Grok execution is unknown and no child handle is available; native cancellation is unproven", killedPid: null, nativeCancellation: "unproven" };
    }
    if (turn) notSubmitted(turn, "Grok stop was requested before spawn", true);
    return { stopped: false, code: "grok-cancelled-before-spawn", reason: "Grok stop requested before spawn; no native submission occurred", killedPid: null, nativeCancellation: "not-attempted" };
  }
  if (turn.observation.wrapperCompletion === "closed") {
    return { stopped: false, code: "grok-stop-refused", reason: "The Grok wrapper already closed; native cancellation is not attempted", killedPid: null, nativeCancellation: "not-attempted" };
  }
  turn.terminate?.("grok-cancellation-unproven", "Grok stop requested; only the owned wrapper is terminated and native cancellation is unproven");
  return { stopped: false, code: "grok-cancellation-unproven", reason: "Terminating only the owned Grok wrapper; native cancellation is unproven", killedPid: validPid(pid) ? pid : null, nativeCancellation: "unproven" };
}

export function grokDispatchObservation(adapter: HarnessDispatchAdapter, owner: RunOwner): GrokTurnObservation | undefined {
  const observation = states.get(adapter)?.turns.get(owner)?.observation;
  return observation ? Object.freeze({ ...observation, acceptedMessageId: null, observedStreamMessageIds: Object.freeze([...observation.observedStreamMessageIds]) }) : undefined;
}
