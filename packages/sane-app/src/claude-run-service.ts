import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { AgentLaunchConfigurationError, claudeAgentSettings, saneContextText, sha256, snapshotIdentity } from "./agent-launch";
import { projectCompactions } from "./compaction";
import type { Event, Run, Session } from "./history";
import type { RunOwner } from "./run-owner";
import type { ExecutionContext } from "./workstreams";
import { isClaudeRootRecord } from "../shared/conversation/cc-scope";
import { CLAUDE_RESULT_TEXT_LIMIT, consumeClaudeResultRecord, createClaudeResultSequenceState, rejectUndeliveredClaudeFramework, type ClaudeResultSequenceState } from "../shared/conversation/cc-result";
import type { QueuedSendConfiguration } from "../shared/conversation/queued-followup";

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
export type ClaudeQueuedFollowup = { requestId: string; afterRunId: string; sessionId: string; prompt: string; configuration?: QueuedSendConfiguration };
type QueuedFollowup = { owner: RunOwner; input: ClaudeQueuedFollowup; cancelled?: boolean; persisted: Promise<void>; draining?: Promise<void> };
/** failure: the first non-success result record; framework: the SessionStart text this run must deliver. */
type Result = ClaudeResultSequenceState & { stderr: string };
const resultTextLimit = CLAUDE_RESULT_TEXT_LIMIT;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const compactCommand = (text: string) => /^\s*\/compact(?:\s|$)/i.test(text);
/** Claude replaces larger hook context with a file preview; the framework must arrive whole. */
const hookContextLimit = 10000;
const equal = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export class ClaudeRunService {
  private readonly secrets = new Map<string, string>();
  private readonly stoppedTurns = new Set<string>();
  private readonly turnHooks = new Map<string, symbol | undefined>();
  private readonly followups = new Map<string, QueuedFollowup>();
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

  /** Input admission is not process ownership. The one-shot CLI cannot receive
   * another prompt after stdin EOF; accept at most one journaled follow-up and
   * let bridge admit a fresh run only after this owner's entire lifecycle ends.
   * This capability is for explicit user prompts, never compact/worker/handoff
   * deliveries or any operation that requires an idle conversation. */
  canQueueFollowup(owner: RunOwner): boolean {
    return this.deps.owns(owner) && this.deps.session(owner.run.sessionId)?.harness === "claude-code"
      && !owner.native && !owner.workerDeliveryId && !!owner.child && owner.run.operation !== "compact"
      && owner.run.status === "running" && !owner.settled && !owner.stopRequested && !owner.cancelling && !owner.stopping
      && !this.deps.closing() && !this.deps.storageFailed() && !this.deps.retained()
      && this.stoppedTurns.has(owner.run.runId) && !this.followups.has(owner.run.sessionId);
  }

  hasQueuedFollowup(sessionId: string): boolean { return this.followups.has(sessionId); }
  followupPending(requestId: string): boolean { return [...this.followups.values()].some(queued => queued.input.requestId === requestId && !queued.cancelled); }
  cancelFollowup(sessionId: string): void { const queued = this.followups.get(sessionId); if (queued) queued.cancelled = true; }

  async queueFollowup(owner: RunOwner, prompt: string, configuration?: QueuedSendConfiguration): Promise<ClaudeQueuedFollowup> {
    if (!prompt.trim() || compactCommand(prompt)) throw new Error("Only ordinary nonempty prompts can be queued");
    if (!this.canQueueFollowup(owner)) throw new Error("Claude follow-up admission unavailable");
    const input: ClaudeQueuedFollowup = { requestId: this.runtime.randomUUID(), afterRunId: owner.run.runId, sessionId: owner.run.sessionId, prompt, ...(configuration ? { configuration: structuredClone(configuration) } : {}) };
    const queued: QueuedFollowup = { owner, input, persisted: Promise.resolve() };
    // Reserve synchronously, before journal I/O, so concurrent requests cannot
    // accept a second prompt. Do not project this as a submitted native turn.
    this.followups.set(input.sessionId, queued);
    try {
      queued.persisted = this.deps.emit(owner.run, "context", { source: "claude-followup", state: "queued", ...input });
      await queued.persisted; return { ...input };
    }
    catch (error) { if (this.followups.get(input.sessionId) === queued) this.followups.delete(input.sessionId); throw error; }
  }

  /** Bridge must keep a queued-input admission reservation until this promise
   * settles. `dispatch` must use normal launch/configuration validation, create
   * a NEW Run, and install its owner before native submission. Never call this
   * from execute's finally: owner.done also covers bridge release/cancellation.
   * Queued journal evidence is not a durable auto-retry instruction on restart. */
  drainQueuedFollowup(owner: RunOwner, dispatch: (input: ClaudeQueuedFollowup) => Promise<{ runId: string } | { notSubmitted: true }>): Promise<void> {
    const queued = this.followups.get(owner.run.sessionId);
    if (!queued || queued.owner !== owner) return Promise.resolve();
    if (queued.draining) return queued.draining;
    queued.draining = (async () => {
      await queued.persisted;
      await owner.done;
      // A Stop/result, child exit alone, or a cancelled/unconfirmed owner never
      // permits resume. Do not signal children here to make the queue eligible.
      if (queued.cancelled || !owner.settled || owner.cancelling || owner.stopRequested || owner.stopping || owner.run.status !== "completed"
        || !owner.child || owner.child.exitCode !== 0 || this.groupAlive(owner) || this.deps.owns(owner)
        || this.deps.closing() || this.deps.storageFailed() || this.deps.retained()) {
        if (!this.deps.storageFailed()) await this.deps.emit(owner.run, "context", { source: "claude-followup", state: "not-submitted", requestId: queued.input.requestId });
        return;
      }
      await this.deps.emit(owner.run, "context", { source: "claude-followup", state: "admitting", requestId: queued.input.requestId });
      if (queued.cancelled || this.deps.closing() || this.deps.storageFailed() || this.deps.retained()) {
        if (!this.deps.storageFailed()) await this.deps.emit(owner.run, "context", { source: "claude-followup", state: "not-submitted", requestId: queued.input.requestId });
        return;
      }
      try {
        const run = await dispatch({ ...queued.input });
        await this.deps.emit(owner.run, "context", "notSubmitted" in run
          ? { source: "claude-followup", state: "not-submitted", requestId: queued.input.requestId }
          : { source: "claude-followup", state: "dispatched", requestId: queued.input.requestId, runId: run.runId });
      } catch (error) {
        // Admission may have reached native submission before throwing. Never
        // silently retry this prompt; the normal launch journal is authoritative.
        if (!this.deps.storageFailed()) await this.deps.emit(owner.run, "context", { source: "claude-followup", state: "admission-unconfirmed", requestId: queued.input.requestId, error: message(error) });
        throw error;
      }
    })().finally(() => { if (this.followups.get(owner.run.sessionId) === queued) this.followups.delete(owner.run.sessionId); });
    return queued.draining;
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
    // Publish root hook state in receipt order before starting journal I/O.
    // Stop becomes queueable only after its own durable write finishes; a later
    // activity hook invalidates that publication even while Stop is persisting.
    const root = isClaudeRootRecord(payload);
    if (root && (event === "UserPromptSubmit" || event === "PreToolUse")) this.stoppedTurns.delete(run.runId);
    const stop = root && event === "Stop" ? Symbol() : undefined;
    if (root && (stop || event === "UserPromptSubmit" || event === "PreToolUse")) this.turnHooks.set(run.runId, stop);
    await this.deps.emit(run, "hook", { event, payload });
    if (stop && this.turnHooks.get(run.runId) === stop && run.status === "running") this.stoppedTurns.add(run.runId);
    return { status: 200, body: { ok: true } };
  }

  private async consume(owner: RunOwner, nativeSessionId: string, stream: ReadableStream<Uint8Array>, kind: "stdout" | "stderr", result: Result) {
    const run = owner.run, reader = stream.getReader(); const decoder = new TextDecoder(); let pending = "";
    const line = async (text: string) => {
      if (!text) return;
      let data: any = text;
      if (kind === "stdout") {
        try { data = JSON.parse(text); } catch {}
        // stdout and hook HTTP have independent delivery ordering. An assistant
        // record can be the final reply preceding an already-received Stop, so
        // do not revoke that hook based on stdout text. Root activity hooks do.
        if (isClaudeRootRecord(data) && data?.session_id === nativeSessionId && data?.type === "system" && data.subtype === "task_notification") {
          this.stoppedTurns.delete(run.runId); this.turnHooks.set(run.runId, undefined);
        }
        const observation = consumeClaudeResultRecord(result, data, nativeSessionId);
        // Fail fast: Claude must not proceed without this run's framework.
        if (observation.frameworkRejected) void this.terminate(owner);
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
    const result: Result = { ...createClaudeResultSequenceState(), stderr: "" };
    let streams: Promise<unknown>[] = [];
    try {
      if (run.operation !== "compact" && compactCommand(prompt)) throw new Error("Use the dedicated Compact action; compaction cannot be submitted as an ordinary prompt");
      // Write the first log record before publishing its metadata reference.
      await deps.emit(run, "status", { status: "running" });
      if (run.operation !== "compact") await deps.emit(run, "submission", { messageId: `${run.runId}:user`, text: prompt, ...(run.queuedFollowupId ? { queuedFollowupId: run.queuedFollowupId } : {}) });
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
      rejectUndeliveredClaudeFramework(result);
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
      this.stoppedTurns.delete(run.runId);
      this.turnHooks.delete(run.runId);
    }
  }
}
