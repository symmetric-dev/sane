import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants, accessSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, normalize } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { grokCompactRequest, parseGrokCompactionEvent, prepareGrokFork, verifyGrokFork } from "./grok-native-history";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => !!value && typeof value === "object" && !Array.isArray(value);
const own = (value: ObjectValue, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const MAX_LINE_BYTES = 8 * 1024 * 1024;

export type GrokAcpCapabilities = {
  readonly loadSession: boolean;
  /** Native initialize metadata, NOT an invented per-method capabilities list. */
  readonly grokShell: boolean;
  readonly metadataField: "meta" | "_meta" | null;
  readonly compactMethod: "x.ai/compact_conversation" | null;
  readonly forkMethod: "x.ai/session/fork" | null;
  readonly methodAdvertisement: "grok-shell-family" | "none";
};

/** Installed 1.0.70 advertises meta.grokShell (the ACP schema also uses _meta
 * across versions), not extensionMethods/supportedMethods. Its own pager reads
 * grokShell at initialize. The two routes below are documented in
 * ~/.grok/docs/user-guide/15-agent-mode.md and present in the installed binary.
 * Family advertisement is not proof that an individual RPC will succeed.
 * Never turn an agentInfo name/version or an arbitrary nested string into a
 * capability. Unknown/missing/conflicting metadata fails closed. */
export function discoverGrokAcpCapabilities(result: unknown): GrokAcpCapabilities {
  const response = object(result) ? result : {};
  const meta = object(response.meta) ? response.meta : undefined;
  const underscoreMeta = object(response._meta) ? response._meta : undefined;
  const conflict = meta && underscoreMeta && meta.grokShell !== underscoreMeta.grokShell;
  const metadata = conflict ? undefined : meta ?? underscoreMeta;
  const grokShell = response.protocolVersion === 1 && metadata?.grokShell === true;
  return Object.freeze({
    loadSession: object(response.agentCapabilities) && response.agentCapabilities.loadSession === true,
    grokShell,
    metadataField: conflict ? null : meta ? "meta" : underscoreMeta ? "_meta" : null,
    compactMethod: grokShell ? "x.ai/compact_conversation" : null,
    forkMethod: grokShell ? "x.ai/session/fork" : null,
    methodAdvertisement: grokShell ? "grok-shell-family" : "none",
  });
}

export type GrokAcpNotification = {
  readonly method: string;
  readonly params: unknown;
  /** Only parsed native auto_compact_* metadata, never an RPC success guess. */
  readonly compaction?: ReturnType<typeof parseGrokCompactionEvent>;
};

export type GrokAcpCloseEvidence = {
  readonly pid: number | null;
  readonly processGroupId: number | null;
  readonly closeObserved: boolean;
  readonly exitObserved: boolean;
  readonly exitCode: number | null;
  readonly exitSignal: NodeJS.Signals | null;
  readonly stdoutEnded: boolean;
  readonly stderrEnded: boolean;
  readonly stdoutClosed: boolean;
  readonly stderrClosed: boolean;
  readonly stdinEnded: boolean;
  readonly processGroupGone: boolean;
  readonly termSent: boolean;
  readonly killSent: boolean;
  readonly operation: "compact" | "fork";
  readonly nativeRequest: "not-written" | "write-attempted" | "written";
  readonly nativeResultReceived: boolean;
  /** Compact-specific compatibility fields; false/not-written for a fork. */
  readonly compactRequest: "not-written" | "write-attempted" | "written";
  readonly compactResultReceived: boolean;
  readonly expectedPostResultTeardown: boolean;
  readonly cancelNotificationWritten: boolean;
  /** session/cancel is best effort; killing a wrapper proves no provider cancel. */
  readonly nativeCancellation: "not-attempted" | "unproven";
};

export type GrokAcpSpawnInfo = {
  readonly pid: number;
  readonly processGroupId: number;
  /** Actual child close, also after bounded drain failed. Inspect processGroupGone
   * separately: direct-child close alone does not prove descendants stopped. */
  readonly closed: Promise<GrokAcpCloseEvidence>;
};

export type GrokAcpOperationOptions = {
  readonly executable: string;
  readonly homeRoot: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  /** Synchronous admission/Stop fence; throwing or returning false refuses RPC.
   * Runs once, immediately before writing the operation, not initialize/load. */
  readonly beforeNative?: () => void | boolean;
  readonly onNotification?: (notification: GrokAcpNotification) => void;
  readonly onStderr?: (text: string) => void;
  readonly onSpawn?: (info: GrokAcpSpawnInfo) => void;
  readonly onClose?: (evidence: GrokAcpCloseEvidence) => void;
  /** Per-handshake request timeouts. Defaults: 30 seconds; zero disables. */
  readonly initializeTimeoutMs?: number;
  readonly loadTimeoutMs?: number;
  /** EOF grace after a result (500ms), then TERM (1000ms), then KILL (1000ms). */
  readonly eofGraceMs?: number;
  readonly termGraceMs?: number;
  readonly killGraceMs?: number;
};

export type CompactGrokSessionOptions = GrokAcpOperationOptions & {
  readonly nativeSessionId: string;
  /** Default zero: compaction can wait indefinitely, until explicitly stopped. */
  readonly compactTimeoutMs?: number;
};

export type ForkGrokSessionOptions = GrokAcpOperationOptions & {
  readonly sourceNativeSessionId: string;
  readonly targetNativeSessionId: string;
  /** Default zero: native fork waits until response or explicit Stop. */
  readonly forkTimeoutMs?: number;
};

export type GrokAcpCompactionResult = {
  readonly nativeSessionId: string;
  readonly result: unknown;
  readonly initializeResult: unknown;
  readonly loadResult: unknown;
  readonly capabilities: GrokAcpCapabilities;
  readonly process: GrokAcpCloseEvidence;
};

export type GrokAcpForkResult = GrokAcpCompactionResult & {
  readonly sourceNativeSessionId: string;
  readonly parentVerified: true;
};

export class GrokAcpOperationError extends Error {
  override readonly name: string = "GrokAcpOperationError";
  constructor(
    readonly code: "grok-acp-failed" | "grok-acp-stopped" | "grok-acp-drain-incomplete",
    message: string,
    readonly evidence: GrokAcpCloseEvidence,
    /** May have succeeded natively even when subsequent drain/observation failed. */
    readonly rpcResult: unknown,
    readonly closed: Promise<GrokAcpCloseEvidence>,
    options?: ErrorOptions,
  ) { super(message, options); }
}

export class GrokAcpCompactionError extends GrokAcpOperationError {
  override readonly name = "GrokAcpCompactionError";
}

export class GrokAcpForkError extends GrokAcpOperationError {
  override readonly name = "GrokAcpForkError";
}

/** Native validation failures remain inspectable and visible, not mistaken for
 * missing support or replaced with a fake successful child identity. */
export class GrokAcpRpcError extends Error {
  override readonly name = "GrokAcpRpcError";
  constructor(readonly method: string, readonly nativeError: unknown) {
    const detail = object(nativeError) && typeof nativeError.message === "string" ? nativeError.message.slice(0, 4096) : "RPC error";
    super(`Grok ACP ${method}: ${detail}`, { cause: nativeError });
  }
}

function exactAbsolute(value: string, label: string): void {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value || /[\x00-\x1f\x7f]/.test(value)) {
    throw new TypeError(`Grok ACP requires an exact absolute ${label}`);
  }
}
function duration(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0 || result > 2_147_483_647) throw new TypeError("Invalid Grok ACP timeout");
  return result;
}
function environment(homeRoot: string): NodeJS.ProcessEnv {
  // Do not inherit SANE/another harness's caller authority or a session UUID.
  const env: NodeJS.ProcessEnv = {
    HOME: process.env.HOME || homedir(), GROK_HOME: homeRoot,
    PATH: process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    SHELL: process.env.SHELL || "/bin/sh", TMPDIR: process.env.TMPDIR || tmpdir(),
    LANG: process.env.LANG || "en_US.UTF-8", TERM: "dumb", SANE_UNQUALIFIED_NATIVE: "1",
    GROK_CLAUDE_HOOKS_ENABLED: "false", GROK_CLAUDE_MCPS_ENABLED: "false",
  };
  for (const key of ["USER", "LOGNAME", "LANGUAGE", "TZ", "XAI_API_KEY", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(process.env)) if (/^LC_[A-Z_]+$/.test(key) && value !== undefined) env[key] = value;
  return env;
}

/** Own a local ACP process for exactly one native operation RPC. No session/new,
 * prompt, prose slash-command, identity reassignment, or shared leader. Tool
 * capabilities are false and every incoming client RPC is explicitly denied.
 * This is a client boundary, not an OS sandbox for native Grok internals.
 *
 * A native RPC result is returned verbatim, NOT promoted to a transcript
 * checkpoint or proof of provider cancellation. Nonzero/signal exit following
 * that result can be our expected teardown; an exit before it is a failure.
 * Callers must keep their session admission lock until this resolves/rejects;
 * on incomplete drain do not retire ownership unless both actual close and
 * process-group disappearance are established. closed alone proves no group drain. */
async function runGrokOperation(
  options: GrokAcpOperationOptions & { nativeSessionId: string },
  operation: { kind: "compact" | "fork"; method: string; params: unknown; timeoutMs?: number; targetNativeSessionId?: string },
): Promise<GrokAcpCompactionResult> {
  exactAbsolute(options.executable, "executable"); exactAbsolute(options.homeRoot, "home root"); exactAbsolute(options.cwd, "cwd");
  grokCompactRequest(options.nativeSessionId); // Validate UUID before spawning.
  const initTimeout = duration(options.initializeTimeoutMs, 30_000), loadTimeout = duration(options.loadTimeoutMs, 30_000);
  const operationTimeout = duration(operation.timeoutMs, 0);
  const eofGrace = duration(options.eofGraceMs, 500), termGrace = duration(options.termGraceMs, 1_000), killGrace = duration(options.killGraceMs, 1_000);
  if (process.platform === "win32") throw new Error("Grok ACP requires POSIX owned process-group termination");
  if (!statSync(options.executable).isFile()) throw new Error("Grok ACP executable is not a regular file");
  accessSync(options.executable, constants.X_OK);
  if (!statSync(options.cwd).isDirectory() || !statSync(options.homeRoot).isDirectory()) throw new Error("Grok ACP home/cwd must exist");

  let child: ChildProcessWithoutNullStreams | undefined;
  let pid: number | null = null, closeObserved = false, exitObserved = false;
  let exitCode: number | null = null, exitSignal: NodeJS.Signals | null = null;
  let stdoutEnded = false, stderrEnded = false, stdoutClosed = false, stderrClosed = false;
  let stdinEnded = false, termSent = false, killSent = false, loadWritten = false;
  let nativeRequest: GrokAcpCloseEvidence["nativeRequest"] = "not-written";
  let nativeResultReceived = false, nativeResult: unknown, cancelNotificationWritten = false;
  let cancellationAttempted = false, stopped = false, failure: unknown;
  let nextId = 1;
  const pending = new Map<number, { method: string; resolve: (value: unknown) => void; reject: (error: unknown) => void; timer?: ReturnType<typeof setTimeout> }>();
  const closed = Promise.withResolvers<GrokAcpCloseEvidence>();

  function groupGone(): boolean {
    if (!pid) return !child || closeObserved;
    try { process.kill(-pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  }
  function evidence(): GrokAcpCloseEvidence {
    return Object.freeze({ pid, processGroupId: pid, closeObserved, exitObserved, exitCode, exitSignal,
      stdoutEnded, stderrEnded, stdoutClosed, stderrClosed, stdinEnded, processGroupGone: groupGone(),
      termSent, killSent, operation: operation.kind, nativeRequest, nativeResultReceived,
      compactRequest: operation.kind === "compact" ? nativeRequest : "not-written",
      compactResultReceived: operation.kind === "compact" && nativeResultReceived, expectedPostResultTeardown: nativeResultReceived,
      cancelNotificationWritten, nativeCancellation: cancellationAttempted ? "unproven" : "not-attempted" });
  }
  function rejectPending(error: unknown): void {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  }
  function fail(error: unknown): void {
    failure ??= error;
    rejectPending(failure);
  }
  function write(message: ObjectValue): void {
    if (!child || closeObserved || child.stdin.destroyed || child.stdin.writableEnded) throw new Error("Grok ACP stdin is closed");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  function cancelSession(): void {
    if (!child || !loadWritten || closeObserved || cancellationAttempted) return;
    cancellationAttempted = true;
    try { write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: options.nativeSessionId } }); cancelNotificationWritten = true; }
    catch { /* Delivery and provider cancellation remain unproven. */ }
  }
  function signalGroup(signal: "SIGTERM" | "SIGKILL"): void {
    if (!pid || groupGone()) return;
    try {
      process.kill(-pid, signal);
      if (signal === "SIGTERM") termSent = true; else killSent = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure ??= error;
    }
  }
  function abort(): void {
    stopped = true;
    cancelSession();
    fail(new Error("Grok ACP stopped locally; provider cancellation is unproven"));
    signalGroup("SIGTERM");
  }
  function request(method: string, params: unknown, timeout: number, native = false): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (failure || options.signal?.aborted) { if (options.signal?.aborted) abort(); reject(failure); return; }
      const id = nextId++;
      const entry = { method, resolve, reject, timer: undefined as ReturnType<typeof setTimeout> | undefined };
      pending.set(id, entry);
      if (timeout) entry.timer = setTimeout(() => {
        if (!pending.has(id)) return;
        cancelSession();
        fail(new Error(`Grok ACP ${method} timed out`));
      }, timeout);
      try {
        // Serialize and check transport BEFORE the synchronous admission fence.
        const line = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
        if (!child || closeObserved || child.stdin.destroyed || child.stdin.writableEnded) throw new Error("Grok ACP stdin is closed");
        if (native) {
          const admitted: unknown = options.beforeNative?.();
          if (object(admitted) && typeof admitted.then === "function") {
            // Async functions are assignable to void callbacks in TypeScript.
            // Refuse them and consume rejection without awaiting their gate.
            void Promise.resolve(admitted).catch(() => {});
            throw new Error("Grok ACP beforeNative must be synchronous");
          }
          if (admitted === false) throw new Error(`Grok ACP ${operation.kind} admission refused`);
          if (options.signal?.aborted) { abort(); throw failure; }
          nativeRequest = "write-attempted";
        }
        child.stdin.write(line);
        if (native) nativeRequest = "written";
        if (method === "session/load") loadWritten = true;
      } catch (error) {
        clearTimeout(entry.timer); pending.delete(id); reject(error);
      }
    });
  }
  function message(line: string): void {
    if (!line.trim()) return;
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error("Grok ACP emitted non-JSON stdout"); }
    if (!object(value) || value.jsonrpc !== "2.0") throw new Error("Invalid Grok ACP JSON-RPC envelope");
    if (typeof value.method === "string") {
      if (own(value, "id")) {
        // No filesystem, terminal, elicitation, auth, sampling or permission
        // callback is allowed, even if the native process requests one.
        if (typeof value.id !== "string" && typeof value.id !== "number" && value.id !== null) throw new Error("Invalid Grok ACP callback ID");
        if (value.method === "session/request_permission") {
          write({ jsonrpc: "2.0", id: value.id, result: { outcome: { outcome: "cancelled" } } });
        } else {
          write({ jsonrpc: "2.0", id: value.id, error: { code: -32000, message: "Client operations are denied during native session maintenance" } });
        }
        throw new Error(`Grok ACP requested a denied client operation: ${value.method}`);
      }
      const params = value.params;
      if (["session/update", "x.ai/session/update", "x.ai/session_notification"].includes(value.method) && object(params)) {
        const expectedTarget = operation.kind === "fork" && nativeRequest !== "not-written" && params.sessionId === operation.targetNativeSessionId;
        if (params.sessionId !== undefined && params.sessionId !== options.nativeSessionId && !expectedTarget) throw new Error("Grok ACP notification session identity mismatch");
      }
      const compaction = object(params) ? parseGrokCompactionEvent(params.notification ?? params.update ?? params) : undefined;
      options.onNotification?.({ method: value.method, params, ...(compaction ? { compaction } : {}) });
      return;
    }
    if (typeof value.id !== "number") return;
    const entry = pending.get(value.id);
    if (!entry) return; // Never let notifications/other responses settle a request.
    if (own(value, "result") === own(value, "error")) throw new Error("Invalid Grok ACP response");
    pending.delete(value.id); clearTimeout(entry.timer);
    if (own(value, "error")) {
      entry.reject(new GrokAcpRpcError(entry.method, value.error));
    } else {
      if (entry.method === operation.method) { nativeResultReceived = true; nativeResult = value.result; }
      entry.resolve(value.result);
    }
  }
  function observe(stream: ChildProcessWithoutNullStreams["stdout"], stdout: boolean): void {
    const decoder = new StringDecoder("utf8");
    let buffer = "", observerFailed = false;
    function consume(text: string, final = false): void {
      if (observerFailed) return; // Continue draining without retaining damaged output.
      if (!stdout) { if (text) options.onStderr?.(text); return; }
      buffer += text;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        if (Buffer.byteLength(buffer.slice(0, newline)) > MAX_LINE_BYTES) throw new Error("Grok ACP stdout line exceeded transport budget");
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        message(line);
      }
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) throw new Error("Grok ACP stdout line exceeded transport budget");
      if (final && buffer.trim()) { const line = buffer; buffer = ""; message(line); }
    }
    function observerFailure(error: unknown): void {
      observerFailed = true; buffer = ""; fail(error);
    }
    stream.on("data", (chunk: Buffer | string) => {
      try { consume(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))); } catch (error) { observerFailure(error); }
    });
    stream.on("end", () => {
      if (stdout) stdoutEnded = true; else stderrEnded = true;
      try { consume(decoder.end(), true); } catch (error) { observerFailure(error); }
      if (stdout && pending.size) fail(new Error("Grok ACP stdout ended before an RPC response"));
    });
    stream.on("close", () => { if (stdout) stdoutClosed = true; else stderrClosed = true; });
    stream.on("error", fail);
  }
  async function waitForDrain(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (true) {
      if (closeObserved && groupGone()) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      // Group descendants can outlive the direct child's close event. Bounded
      // liveness checks ensure Stop also escalates for those descendants.
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(25, remaining)));
    }
  }
  async function finish(): Promise<boolean> {
    if (!child) return true;
    if (!nativeResultReceived || stopped || failure) cancelSession();
    try {
      if (!child.stdin.destroyed && !child.stdin.writableEnded) { child.stdin.end(); stdinEnded = true; }
    } catch (error) { if (!nativeResultReceived) failure ??= error; }
    if (nativeResultReceived && !failure && !stopped && await waitForDrain(eofGrace)) return true;
    signalGroup("SIGTERM");
    if (await waitForDrain(termGrace)) return true;
    signalGroup("SIGKILL");
    return waitForDrain(killGrace);
  }

  let initializeResult: unknown, loadResult: unknown;
  let capabilities: GrokAcpCapabilities | undefined;
  let drained = true;
  try {
    if (options.signal?.aborted) { abort(); throw failure; }
    // --no-leader is essential: Stop must own the actual local agent, not just
      // kill a stdio proxy while a shared leader continues the native operation.
    child = spawn(options.executable, ["agent", "--no-leader", "--always-approve", "stdio"], {
      cwd: options.cwd, env: environment(options.homeRoot), shell: false,
      detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    pid = child.pid ?? null;
    child.on("error", fail);
    child.stdin.on("error", error => {
      // EPIPE following an actual operation result/EOF is ordinary teardown.
      if (!nativeResultReceived) fail(error);
    });
    observe(child.stdout, true); observe(child.stderr, false);
    child.on("exit", (code, signal) => {
      exitObserved = true; exitCode = code; exitSignal = signal;
      // Do not fail here: the matching result may still be buffered on stdout.
    });
    child.on("close", (code, signal) => {
      closeObserved = true; exitCode = code; exitSignal = signal;
      if (pending.size) fail(new Error("Grok ACP closed before an RPC response"));
      const observation = evidence(); closed.resolve(observation);
      try { options.onClose?.(observation); } catch (error) { fail(error); }
    });
    child.on("spawn", () => {
      try { if (pid) options.onSpawn?.({ pid, processGroupId: pid, closed: closed.promise }); }
      catch (error) { fail(error); }
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    initializeResult = await request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: `sane-grok-${operation.kind}`, version: "1" },
    }, initTimeout);
    capabilities = discoverGrokAcpCapabilities(initializeResult);
    const advertisedMethod = operation.kind === "compact" ? capabilities.compactMethod : capabilities.forkMethod;
    if (!capabilities.loadSession || advertisedMethod !== operation.method) throw new Error("Grok ACP initialize did not advertise session loading and Grok extensions");
    loadResult = await request("session/load", { cwd: options.cwd, sessionId: options.nativeSessionId, mcpServers: [] }, loadTimeout);
    if (object(loadResult) && loadResult.sessionId !== undefined && loadResult.sessionId !== options.nativeSessionId) throw new Error("Grok ACP loaded a different native session");
    await request(operation.method, operation.params, operationTimeout, true);
  } catch (error) { failure ??= error; }
  finally {
    drained = await finish();
    options.signal?.removeEventListener("abort", abort);
    rejectPending(failure ?? new Error("Grok ACP connection finished"));
    if (!child) closed.resolve(evidence());
  }
  const observation = evidence();
  if (failure || stopped || !drained || !nativeResultReceived) {
    const OperationError = operation.kind === "compact" ? GrokAcpCompactionError : GrokAcpForkError;
    throw new OperationError(
      !drained ? "grok-acp-drain-incomplete" : stopped ? "grok-acp-stopped" : "grok-acp-failed",
      !drained ? "Grok ACP process-group close/drain is unproven after bounded termination"
        : stopped ? "Grok ACP stopped locally; provider cancellation is unproven"
          : failure instanceof GrokAcpRpcError ? failure.message : `Grok native ${operation.kind} failed`,
      observation, nativeResult, closed.promise, { cause: failure },
    );
  }
  return { nativeSessionId: options.nativeSessionId, result: nativeResult, initializeResult, loadResult, capabilities: capabilities!, process: observation };
}

/** Native compact only: no prompt or slash-command prose. */
export async function compactGrokSession(options: CompactGrokSessionOptions): Promise<GrokAcpCompactionResult> {
  const request = grokCompactRequest(options.nativeSessionId);
  return runGrokOperation(options, { kind: "compact", ...request, timeoutMs: options.compactTimeoutMs });
}

/** Create a latest-history native child BEFORE any first-prompt dispatch.
 * The route/field names are present in installed 1.0.70 docs/binary; the native
 * agent validates this deliberately minimal payload on invocation. Unknown
 * model/kind/index/workspace options are omitted, not guessed. No prompt is
 * submitted and no source history is written by this adapter.
 *
 * Preflight is not an atomic reservation. The caller owns the source lease and
 * fingerprint, must not retry an uncertain native outcome, and must register a
 * child only after this returns. Never synthesize/import a child on failure.
 * Success requires root result.newSessionId to match the supplied UUID AND
 * persisted native summary.parent_session_id provenance after process drain.
 * This implementation has not been qualified with a live native invocation. */
export async function forkGrokSession(options: ForkGrokSessionOptions): Promise<GrokAcpForkResult> {
  // This helper validates UUIDs, distinct identities, native source existence
  // and target absence. Its CLI argv are intentionally not used on the ACP route.
  await prepareGrokFork(options.homeRoot, options.cwd, options.sourceNativeSessionId, options.targetNativeSessionId);
  const outcome = await runGrokOperation({ ...options, nativeSessionId: options.sourceNativeSessionId }, {
    kind: "fork", method: "x.ai/session/fork", timeoutMs: options.forkTimeoutMs,
    targetNativeSessionId: options.targetNativeSessionId,
    params: {
      sourceSessionId: options.sourceNativeSessionId,
      sourceCwd: options.cwd,
      newCwd: options.cwd,
      newSessionId: options.targetNativeSessionId,
    },
  });
  try {
    if (options.signal?.aborted) throw new Error("Grok fork stopped after RPC response; child creation remains an observed native outcome, not a ready App branch");
    if (!object(outcome.result) || outcome.result.newSessionId !== options.targetNativeSessionId) {
      throw new Error("Grok fork response did not confirm the requested newSessionId; native outcome is unconfirmed and must not be retried automatically");
    }
    await verifyGrokFork(options.targetNativeSessionId, options.cwd, options.sourceNativeSessionId, options.homeRoot);
    if (options.signal?.aborted) throw new Error("Grok fork stopped during native provenance verification");
  } catch (error) {
    throw new GrokAcpForkError(options.signal?.aborted ? "grok-acp-stopped" : "grok-acp-failed",
      error instanceof Error ? error.message : "Grok fork native provenance is unconfirmed",
      outcome.process, outcome.result, Promise.resolve(outcome.process), { cause: error });
  }
  return { ...outcome, nativeSessionId: options.targetNativeSessionId, sourceNativeSessionId: options.sourceNativeSessionId, parentVerified: true };
}
