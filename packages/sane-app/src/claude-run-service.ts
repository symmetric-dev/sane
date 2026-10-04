import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { AgentLaunchConfigurationError, claudeAgentSettings, saneContextText, sha256, snapshotIdentity } from "./agent-launch";
import { projectCompactions } from "./compaction";
import type { Event, Run, Session } from "./history";
import type { RunOwner } from "./run-owner";
import type { ExecutionContext } from "./workstreams";
import { isClaudeRootRecord } from "../shared/conversation/cc-scope";

export const hookEvents = ["SessionStart", "SessionEnd", "UserPromptSubmit", "Stop", "PreToolUse", "PostToolUse", "PermissionRequest", "Notification", "SubagentStart", "SubagentStop", "PreCompact", "PostCompact", "CwdChanged"] as const;

export type ClaudeRunOptions = {
  dataDir: string;
  claudeBin: string;
  claudeRoot: string;
  /** The same package root previously used for hooks/forward.ts in bridge. */
  packageRoot: string;
  /** Resolved at spawn, after the loopback hook listener has started. */
  hookUrl: () => string;
};

/** The bridge remains the sole owner of admission, metadata, and journal writes.
 * All state checks are live: preparation can overlap cancellation/shutdown. */
export type ClaudeRunDependencies = {
  session: (sessionId: string) => Session | undefined;
  run: (runId: unknown) => Run | undefined;
  events: (runId: string) => Event[];
  owns: (owner: RunOwner) => boolean;
  closing: () => boolean;
  storageFailed: () => boolean;
  retained: () => boolean;
  /** Set both retainOwner and metadata.reconciliationRequired, without I/O. */
  requireReconciliation: () => void;
  failClosed: () => void;
  emit: (run: Run, kind: Event["kind"], data: unknown) => Promise<void>;
  persist: () => Promise<void>;
  enqueue: (action: () => Promise<void>) => Promise<void>;
  execution: (sessionId: string) => Promise<string>;
  /** Workstream membership and roots recorded in launch evidence. */
  executionContext: (sessionId: string) => Promise<ExecutionContext>;
  compactExecution: (session: Session) => Promise<string>;
  refreshCompactHistory: (owner: RunOwner) => Promise<void>;
  assertWorkerDeliverySubmission: (owner: RunOwner) => void;
  /** The SANE Session block from current membership, or null. */
  saneSession: (sessionId: string) => Promise<string | null>;
};

type SpawnOptions = {
  cwd: string;
  detached: true;
  stdin: "pipe";
  stdout: "pipe";
  stderr: "pipe";
  env: Record<string, string>;
};

/** Injectable local primitives for deterministic supervision tests; production
 * uses Bun children and signals only the group created by this live owner. */
export type ClaudeRunRuntime = {
  spawn: (args: string[], options: SpawnOptions) => Bun.Subprocess<"pipe", "pipe", "pipe">;
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  sleep: (ms: number) => Promise<unknown>;
  randomUUID: () => string;
  execPath: string;
  env: NodeJS.ProcessEnv;
  writeSettings: (path: string, content: string) => Promise<void>;
  agentSettings: typeof claudeAgentSettings;
};

export type ClaudeHookInput = { runId?: unknown; payload?: unknown };
export type ClaudeHookReply = { status: 200; body: { ok: true } } | { status: 400 | 403; body: { error: string } };
/** failure: the first non-success result record; framework: the SessionStart text this run must deliver. */
type Result = { seen: boolean; error: boolean; indices: Set<number>; diagnostic?: string; failure?: Record<string, unknown>; stderr: string;
  framework?: { text: string; delivered: boolean; rejected: boolean; failures: { outcome: unknown; exitCode: unknown; stderr: unknown }[] } };
const resultTextLimit = 2000;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const compactCommand = (text: string) => /^\s*\/compact(?:\s|$)/i.test(text);
/** Claude replaces larger hook context with a file preview; the framework must arrive whole. */
const hookContextLimit = 10000;
const equal = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export class ClaudeRunService {
  private readonly secrets = new Map<string, string>();
  private readonly runtime: ClaudeRunRuntime;

  constructor(private readonly options: ClaudeRunOptions, private readonly deps: ClaudeRunDependencies, runtime: Partial<ClaudeRunRuntime> = {}) {
    this.runtime = {
      spawn: (args, options) => Bun.spawn(args, options),
      kill: (pid, signal) => { process.kill(pid, signal); },
      sleep: ms => Bun.sleep(ms),
      randomUUID: () => crypto.randomUUID(),
      execPath: process.execPath,
      env: process.env,
      writeSettings: (path, content) => writeFile(path, content, { mode: 0o600 }),
      agentSettings: claudeAgentSettings,
      ...runtime,
    };
  }

  groupAlive(owner: RunOwner): boolean {
    if (!owner.child) return false;
    try { this.runtime.kill(-owner.child.pid, 0); return true; } catch (e: any) { return e.code !== "ESRCH"; }
  }

  private signal(owner: RunOwner, value: NodeJS.Signals) {
    if (!owner.child) return;
    try { this.runtime.kill(-owner.child.pid, value); } catch { /* It may already have exited. */ }
    try { owner.child.kill(value); } catch { /* Also cover the direct child. */ }
  }

  terminate(owner: RunOwner): Promise<boolean> {
    if (owner.stopping) return owner.stopping;
    const child = owner.child;
    // Preparation can be stopped before spawn; do not cache a no-child result.
    if (!child) return Promise.resolve(true);
    owner.stopping = (async () => {
      let exited = false;
      void child.exited.then(() => { exited = true; }, () => {});
      for (const value of ["SIGTERM", "SIGKILL"] as const) {
        this.signal(owner, value);
        for (let i = 0; i < 50; i++) { if (exited && !this.groupAlive(owner)) return true; await this.runtime.sleep(20); }
      }
      this.deps.requireReconciliation();
      return false;
    })().catch(() => { this.deps.requireReconciliation(); return false; });
    return owner.stopping;
  }

  /** HTTP method, loopback checks, decoding, and body limits stay in bridge.
   * Authentication/association and journal ingestion have one authority here. */
  async ingestHook(event: string, input: ClaudeHookInput, secret: string): Promise<ClaudeHookReply> {
    if (!(hookEvents as readonly string[]).includes(event)) return { status: 400, body: { error: "Unknown hook" } };
    const run = this.deps.run(input.runId), expected = this.secrets.get(input.runId as string);
    if (!run || !expected || !equal(secret, expected)) return { status: 403, body: { error: "Forbidden" } };
    const payload = input.payload;
    const session = this.deps.session(run.sessionId);
    if (!session?.nativeSessionId || session.harness !== "claude-code" || !payload || typeof payload !== "object" || (payload as Record<string, unknown>).hook_event_name !== event || (payload as Record<string, unknown>).session_id !== session.nativeSessionId) return { status: 400, body: { error: "Hook association mismatch" } };
    await this.deps.emit(run, "hook", { event, payload });
    return { status: 200, body: { ok: true } };
  }

  private async consume(owner: RunOwner, nativeSessionId: string, stream: ReadableStream<Uint8Array>, kind: "stdout" | "stderr", result: Result) {
    const run = owner.run, reader = stream.getReader(); const decoder = new TextDecoder(); let pending = "";
    const line = async (text: string) => {
      if (!text) return;
      let data: any = text;
      if (kind === "stdout") {
        try { data = JSON.parse(text); } catch {}
        if (isClaudeRootRecord(data) && ((data?.type === "system" && data.subtype === "init") || data?.type === "result")) {
          if (data.session_id !== nativeSessionId) { result.error = true; result.diagnostic = "CLI session identity mismatch or missing session_id"; }
        }
        // Claude continues without context when a SessionStart hook fails. Ours is the response
        // carrying exactly this run's framework; the forward.ts observer prints nothing.
        const framework = result.framework;
        if (framework && isClaudeRootRecord(data) && data?.type === "system" && data.subtype === "hook_response" && data.hook_event === "SessionStart") {
          let output: any; try { output = JSON.parse(data.stdout); } catch {}
          if (data.outcome === "success" && output?.hookSpecificOutput?.hookEventName === "SessionStart" && output.hookSpecificOutput.additionalContext === framework.text) framework.delivered = true;
          else if (data.outcome !== "success") framework.failures.push({ outcome: data.outcome ?? null, exitCode: data.exit_code ?? null, stderr: data.stderr ?? null });
        }
        if (framework && !framework.delivered && isClaudeRootRecord(data) && data?.type === "system" && data.subtype === "init") {
          result.error = framework.rejected = true; result.diagnostic ??= "SANE framework SessionStart hook did not succeed";
          // Fail fast: the agent must not proceed without its framework.
          void this.terminate(owner);
        }
        if (isClaudeRootRecord(data) && data?.type === "result") {
          // Background task notifications can finish additional turns in the
          // same process. Claude distinguishes their results with result_index.
          const indexed = Number.isSafeInteger(data.result_index) && data.result_index >= 0;
          if (data.result_index !== undefined && !indexed) { result.error = true; result.diagnostic ??= "Invalid CLI result_index"; }
          if (result.seen && (!indexed || !result.indices.size || result.indices.has(data.result_index))) { result.error = true; result.diagnostic = "Duplicate CLI result"; }
          if (indexed) result.indices.add(data.result_index);
          result.seen = true;
          if (data.subtype !== "success" || data.is_error !== false) {
            result.error = true; result.diagnostic ??= "CLI result is not an explicit success";
            result.failure ??= { resultSubtype: data.subtype ?? null, isError: data.is_error ?? null, ...(data.api_error_status !== undefined ? { apiErrorStatus: data.api_error_status } : {}), result: typeof data.result === "string" ? data.result.slice(0, resultTextLimit) : data.result ?? null, ...(data.permission_denials !== undefined ? { permissionDenials: data.permission_denials } : {}) };
          }
        }
      }
      else result.stderr = (result.stderr + text + "\n").slice(-resultTextLimit);
      await this.deps.emit(run, kind, data);
    };
    while (true) { const { value, done } = await reader.read(); if (done) break; pending += decoder.decode(value, { stream: true }); let at: number; while ((at = pending.indexOf("\n")) >= 0) { await line(pending.slice(0, at)); pending = pending.slice(at + 1); } if (pending.length > 1024 * 1024) { await line(pending); pending = ""; } }
    pending += decoder.decode(); await line(pending);
  }

  /** Native causes for a failed run: the non-success result and an undelivered framework. */
  private failure(result: Result): Record<string, unknown> {
    return { ...result.failure, ...(result.framework?.rejected ? { sessionStartFailures: result.framework.failures } : {}) };
  }

  async execute(owner: RunOwner, prompt: string, resume: boolean, ready: (accepted: boolean) => void): Promise<void> {
    const run = owner.run, deps = this.deps, runtime = this.runtime;
    const result: Result = { seen: false, error: false, indices: new Set(), stderr: "" };
    let streams: Promise<unknown>[] = [];
    try {
      if (run.operation !== "compact" && compactCommand(prompt)) throw new Error("Use the dedicated Compact action; compaction cannot be submitted as an ordinary prompt");
      // Write the first log record before publishing its metadata reference.
      await deps.emit(run, "status", { status: "running" });
      if (run.operation !== "compact") await deps.emit(run, "submission", { messageId: `${run.runId}:user`, text: prompt });
      await deps.persist();
      if (deps.closing()) throw new Error("Closing before launch");
      const session = deps.session(run.sessionId)!;
      run.cwd = run.operation === "compact" ? await deps.compactExecution(session) : await deps.execution(session.sessionId);
      const secret = runtime.randomUUID() + runtime.randomUUID(); this.secrets.set(run.runId, secret);
      const hooks: Record<string, { hooks: { type: "command"; command: string; timeout: number }[] }[]> = Object.fromEntries(hookEvents.map(event => [event, [{ hooks: [{ type: "command", command: `${quote(runtime.execPath)} ${quote(join(this.options.packageRoot, "hooks/forward.ts"))} ${quote(event)}`, timeout: 3 }] }]]));
      // The framework enters native history once, from the run that creates the native session.
      const frameworkPath = !resume && session.saneContext ? join(this.options.dataDir, `${run.runId}.session-start.md`) : undefined;
      const framework = frameworkPath ? saneContextText(session.saneContext!) : undefined;
      if (frameworkPath) {
        if (framework!.length > hookContextLimit) throw new AgentLaunchConfigurationError(`SANE framework exceeds the ${hookContextLimit}-character SessionStart context limit`);
        await deps.enqueue(() => runtime.writeSettings(frameworkPath, framework!));
        result.framework = { text: framework!, delivered: false, rejected: false, failures: [] };
        hooks.SessionStart!.push({ hooks: [{ type: "command", command: `${quote(runtime.execPath)} ${quote(join(this.options.packageRoot, "hooks/session-start.ts"))} ${quote(frameworkPath)}`, timeout: 10 }] });
      }
      const identity = snapshotIdentity(run);
      const installed = identity ? await runtime.agentSettings(this.options.claudeRoot, identity) : undefined;
      const ccAgent = installed?.agent, permissions = installed?.permissions;
      const settingsPath = join(this.options.dataDir, `${run.runId}.settings.json`);
      const settings = JSON.stringify({ hooks, ...(permissions ? { permissions } : {}) });
      await deps.enqueue(() => runtime.writeSettings(settingsPath, settings));
      const saneSession = await deps.saneSession(session.sessionId);
      const sessionPath = saneSession === null ? undefined : join(this.options.dataDir, `${run.runId}.sane-session.md`);
      if (sessionPath) await deps.enqueue(() => runtime.writeSettings(sessionPath, saneSession!));
      if (deps.closing() || deps.storageFailed() || owner.stopRequested) throw new Error("Closing before launch");
      const args = [this.options.claudeBin, "-p", "--permission-mode", "bypassPermissions", "--output-format", "stream-json", "--verbose", resume ? "--resume" : "--session-id", session.nativeSessionId!, "--settings", settingsPath];
      if (ccAgent !== undefined) args.push("--agent", ccAgent);
      // The default snapshot freezes the first run's Session block for every resume.
      if (sessionPath) args.push("--append-system-prompt-file", sessionPath, "--system-prompt-snapshot", "off");
      if (run.model !== undefined) args.push("--model", run.model);
      if (run.effort !== undefined) args.push("--effort", run.effort);
      // Native HOME/hooks stay shared, but bridge credentials/context do not.
      const env = Object.fromEntries(Object.entries(runtime.env).filter(([name, value]) => value !== undefined && !/^(CC_WEB_|OPENCODE_SERVER_|OPENCODE_SESSION_ID$|OPENCODE_TOKEN$|SANE_|BUN_INSPECT|NODE_OPTIONS$)/i.test(name))) as Record<string, string>;
      // Exact launch inputs as evidence; the prompt is the submission and the hook secret stays in env.
      const context = await deps.executionContext(session.sessionId);
      await deps.emit(run, "launch", {
        harness: "claude-code", resume, operation: run.operation ?? "prompt", workstreamId: context.workstreamId, workstreamRoot: context.artifactsRoot, implementationRoot: run.cwd,
        agent: run.agent ?? null, saneContextVersion: run.saneContextVersion ?? null, args, claudeVersion: null,
        agentFile: installed?.agentFile ?? null, settings: { path: settingsPath, sha256: sha256(settings) },
        framework: frameworkPath ? { path: frameworkPath, sha256: sha256(framework!) } : null,
        sessionBlock: sessionPath ? { path: sessionPath, sha256: sha256(saneSession!) } : null,
      });
      run.cwd = run.operation === "compact" ? await deps.compactExecution(session) : await deps.execution(session.sessionId);
      deps.assertWorkerDeliverySubmission(owner);
      if (deps.closing() || deps.storageFailed() || owner.stopRequested || !deps.owns(owner)) throw new Error("Execution unavailable before launch");
      const child = runtime.spawn(args, {
        cwd: run.cwd, detached: true, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...env, CLAUDE_CONFIG_DIR: this.options.claudeRoot, CLAUDE_CODE_PROJECT_DIR_NAME: "", CC_WEB_HOOK_URL: this.options.hookUrl(), CC_WEB_RUN_ID: run.runId, CC_WEB_HOOK_SECRET: secret, CC_WEB_HOOK_ERRORS: join(this.options.dataDir, `${run.runId}.hook-errors.jsonl`) },
      });
      owner.child = child;
      ready(true);
      streams = [this.consume(owner, session.nativeSessionId!, child.stdout, "stdout", result), this.consume(owner, session.nativeSessionId!, child.stderr, "stderr", result)];
      // Observe both consumers before a synchronous stdin failure can occur.
      const output = Promise.all([child.exited, ...streams]);
      void output.catch(() => {});
      child.stdin.write(prompt);
      const [exit] = await Promise.all([output.then(values => values[0] as number), child.stdin.end()]);
      if (this.groupAlive(owner) && !(await this.terminate(owner))) throw new Error("Process group termination unconfirmed");
      run.status = deps.closing() || owner.stopRequested ? "interrupted" : !deps.storageFailed() && exit === 0 && result.seen && !result.error ? "completed" : "failed";
      run.endedAt = new Date().toISOString(); deps.session(run.sessionId)!.lastStatus = run.status;
      const compact = run.operation === "compact" ? projectCompactions(session, [run], deps.events(run.runId))[0] : undefined;
      const failure = run.status !== "failed" ? {} : { ...this.failure(result), ...(exit !== 0 ? { error: result.stderr.trim() || `CLI exited with code ${exit}` } : {}) };
      await deps.emit(run, "status", { status: run.status, exitCode: exit, resultSeen: result.seen, ...(compact ? { compactionLifecycle: compact.lifecycle, reason: compact.lifecycle === "unconfirmed" ? "CLI ended without native compaction outcome evidence; do not automatically resend" : "CLI process ended; compaction outcome is reported separately by native evidence" } : result.diagnostic ? { reason: result.diagnostic } : {}), ...failure });
    } catch (error) {
      if (error instanceof AgentLaunchConfigurationError) owner.launchError = error.message;
      const stopped = await this.terminate(owner);
      run.status = stopped && (deps.closing() || owner.stopRequested) ? "interrupted" : "failed";
      run.endedAt = new Date().toISOString(); deps.session(run.sessionId)!.lastStatus = run.status;
      try { await deps.emit(run, "status", { status: run.status, ...(run.operation === "compact" && !owner.child ? { operation: "compact", compactNotSubmitted: true } : {}), reason: !stopped ? "Process termination unconfirmed; operator reconciliation required" : deps.storageFailed() ? "Storage failure; operator reconciliation required" : owner.launchError ?? "CLI launch, stream, or shutdown failure", error: message(error), ...this.failure(result) }); } catch { deps.failClosed(); }
      ready(false);
    } finally {
      ready(false);
      // Retain the sentinel if either consumer cannot finish within the bound.
      const drained = await Promise.race([Promise.allSettled(streams).then(() => true), runtime.sleep(2200).then(() => false)]);
      if (!drained) deps.requireReconciliation();
      if (run.operation === "compact" && owner.child && drained && !deps.retained() && !deps.closing() && !deps.storageFailed()) await deps.refreshCompactHistory(owner);
      run.endedAt = new Date().toISOString(); deps.session(run.sessionId)!.lastStatus = run.status;
      try { if (owner.workerDeliveryId && !owner.child) await deps.emit(run, "status", { status: run.status, workerDeliveryNotSubmitted: owner.workerDeliveryId }); await deps.persist(); } catch { deps.failClosed(); }
      this.secrets.delete(run.runId);
    }
  }
}
