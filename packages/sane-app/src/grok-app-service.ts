import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { GrokCapability, GrokSessionView, GrokStopView, GrokTurnInput } from "../shared/conversation/grok-contract";
import { validGrokChoice } from "../shared/conversation/grok-contract";
import type { Message, RunMetadata, TextPart } from "../shared/conversation/types";
import type { AdmissionService, GrokCreateAdmission } from "./admission";
import type { CatalogService } from "./catalog";
import type { GrokSpawn } from "./grok-adapter";
import { appendGrokCaptureTurn, beginGrokCaptureTurn, finishGrokCaptureTurn, type GrokCaptureTurn } from "./grok-capture";
import { createGrokSendSession, runGrokTurn, type GrokSendSession, type GrokTurnHandle } from "./grok-send";
import { uuid, type Run, type Session } from "./history";
import { WorkstreamAdapterError } from "./workstreams";

type Options = {
  dataDir: string;
  admissions: AdmissionService;
  catalog: CatalogService;
  executable?: string;
  homeRoot?: string;
  assertOpen: () => void;
  admit: <T>(sessionId: string, work: () => Promise<T>) => Promise<T>;
  persistSession: (session: Session) => Promise<void>;
  changed: (sessionId: string) => void;
  /** Pending-only captures have no model/effort; recover those from idle metadata. */
  readSession?: (sessionId: string) => Session | undefined;
  spawn?: GrokSpawn;
};
type Projection = { messages: Message[]; run: RunMetadata };
type Entry = {
  send: GrokSendSession;
  cwd: string;
  model: string;
  effort: string;
  preparing: boolean;
  stopRequested?: boolean;
  reason?: string;
  phase?: "not-submitted";
  current?: GrokTurnInput;
  handle?: GrokTurnHandle;
  live?: OutputProjection;
  completed: Projection[];
};
const RESTART = "Start a new conversation; this Grok turn cannot be retried automatically.";
const TEXT_LIMIT = 48_000;
const TRUNCATED = "\n[Grok display truncated]";
const clip = (text: string, max = TEXT_LIMIT) => text.length > max ? text.slice(0, max) + TRUNCATED : text;
const absolute = (value: unknown): value is string => typeof value === "string" && isAbsolute(value) && !value.includes("\0");
function refuse(status: number, code: string, message: string): never { throw new WorkstreamAdapterError(status, code, message); }
function sessionId(value: unknown): string {
  if (!uuid(value)) refuse(400, "invalid-session", "Grok sessionId must be a UUID");
  return (value as string).toLowerCase();
}

/** These are display events, not Claude reducer input and not native receipts.
 * The experiment emits assistant.message.content and result.result. Stream
 * deltas are also supported without appending the final snapshot a second time. */
class OutputProjection {
  private decoder = new StringDecoder("utf8");
  private pending = "";
  private bytes = 0;
  private text = "";
  private thought = "";
  private diagnostic = "";
  private result = "";
  private clipped = false;
  constructor(readonly run: RunMetadata, private prompt: string) {}
  feed(chunk: Buffer | string): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.bytes += buffer.length;
    if (this.bytes > 2_000_000) { this.clipped = true; return; }
    this.scan(this.decoder.write(buffer));
  }
  finish(): void { this.scan(this.decoder.end()); if (this.pending.trim()) this.line(this.pending); this.pending = ""; }
  private scan(text: string): void {
    const lines = (this.pending + text).split("\n");
    this.pending = lines.pop()!;
    for (const line of lines) this.line(line);
    if (this.pending.length > 256_000) { this.note(this.pending); this.pending = ""; this.clipped = true; }
  }
  private note(line: string): void { if (!this.diagnostic) this.diagnostic = clip(line, 2_000); }
  private line(line: string): void {
    if (!line.trim()) return;
    let event: any;
    try { event = JSON.parse(line); } catch { this.note(line); return; }
    if (event?.type === "assistant" && event.message) {
      const content = event.message.content;
      if (typeof content === "string") this.text = clip(content);
      else if (Array.isArray(content)) {
        const text = content.filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("");
        const thought = content.filter(part => ["thinking", "reasoning"].includes(part?.type)).map(part => part.thinking ?? part.text ?? "").filter(value => typeof value === "string").join("");
        if (text) this.text = clip(text);
        if (thought) this.thought = clip(thought);
        if (!text && !thought) this.note(line);
      } else this.note(line);
      return;
    }
    if (event?.type === "stream_event") {
      const delta = event.event?.type === "content_block_delta" ? event.event.delta : null;
      if (delta?.type === "text_delta" && typeof delta.text === "string") this.text = clip(this.text + delta.text);
      else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") this.thought = clip(this.thought + delta.thinking);
      else if (!["message_start", "message_delta", "message_stop", "content_block_start", "content_block_stop"].includes(event.event?.type)) this.note(line);
      return;
    }
    if (event?.type === "result") {
      if (event.is_error === true) this.note(typeof event.result === "string" ? event.result : line);
      else if (typeof event.result === "string") this.result = clip(event.result);
      return;
    }
    if (event?.type !== "system" && event?.type !== "user") this.note(line);
  }
  snapshot(status = this.run.status, stderr = ""): Projection {
    const run = { ...this.run, status };
    const base = { runId: run.id, time: run.createdAt, status, normalized: true };
    const messages: Message[] = [{ ...base, id: `${run.id}:user`, role: "user", parts: [{ type: "text", text: clip(this.prompt, 16_000) }] }];
    const parts: TextPart[] = [];
    if (this.thought) parts.push({ type: "reasoning", text: this.thought });
    const text = this.text || this.result;
    if (text) parts.push({ type: "text", text: text + (this.clipped ? TRUNCATED : "") });
    if (parts.length) messages.push({ ...base, id: `${run.id}:assistant`, role: "assistant", parts });
    if (this.diagnostic || (!parts.length && status !== "running" && status !== "starting")) {
      const detail = (this.diagnostic || clip(stderr, 2_000) || "No recognized Grok text output was captured.") + (this.clipped ? TRUNCATED : "");
      messages.push({ ...base, id: `${run.id}:diagnostic`, role: "system", parts: [{ type: "text", text: `Grok output diagnostic (native acceptance remains unknown):\n${detail}` }] });
    }
    return { run, messages };
  }
}

function captured(turn: GrokCaptureTurn, createdAt: string): Projection {
  const projection = new OutputProjection({
    id: turn.runId ?? `grok:${turn.appSessionId}:${turn.turnIndex}`, conversationId: turn.appSessionId,
    cwd: turn.cwd, createdAt: turn.createdAt ?? createdAt, harness: "grok", nativeSessionId: turn.nativeSessionId,
    model: turn.model, effort: turn.effort, profileId: "base:gk",
    status: turn.exitCode === 0 && !turn.exitSignal && turn.nativeCancellation !== "unproven" ? "completed" : "failed",
  }, turn.prompt);
  projection.feed(turn.stdout);
  projection.finish();
  return projection.snapshot(undefined, turn.stderr);
}

/** App-only normal-composer path. Capture owns durable execution identity;
 * this cache owns display projections and original live handles, never receipts. */
export class GrokAppService {
  private entries = new Map<string, Entry>();
  private directory: string;
  private closing = false;
  constructor(private options: Options) { this.directory = join(options.dataDir, "grok-captures"); }

  capability(): GrokCapability {
    const pin = this.options.admissions.getGrokSourcePin();
    const reason = !absolute(this.options.executable) ? "Configure an explicit absolute Grok executable; PATH lookup is not performed."
      : !absolute(this.options.homeRoot) ? "Configure an explicit absolute Grok home."
      : !pin?.authorityId ? "Grok requires an explicitly published, resolved gk source pin."
      : pin.descriptor.homeRoot !== this.options.homeRoot ? "Configured Grok home does not match the saved gk source pin."
      : undefined;
    return { protocol: "grok-capture", version: 1, configured: !reason, ...(reason ? { reason } : {}) };
  }
  has(id: string): boolean { return this.entries.has(id) || !!this.options.admissions.getGrokCreate(id); }
  activeCount(): number { return [...this.entries.values()].filter(entry => entry.preparing || entry.send.owner).length; }
  private open(): void {
    this.options.assertOpen();
    if (this.closing) refuse(503, "grok-closing", "Grok service is closing");
  }
  private entry(id: string, create = false): Entry {
    const cached = this.entries.get(id);
    if (cached) return cached;
    const admission = this.options.admissions.getGrokCreate(id);
    if (!admission && this.options.admissions.get(id)) refuse(409, "grok-session-conflict", "This App session belongs to another harness");
    const send = createGrokSendSession({ appSessionId: id, captureDirectory: this.directory });
    if (!create && !admission && !send.journal.execution && !send.journal.turns.length) refuse(404, "grok-session-missing", "Unknown Grok App session");
    const stored = this.options.readSession?.(id);
    if (stored && stored.harness !== "grok") refuse(409, "grok-session-conflict", "This App session belongs to another harness");
    const last = send.journal.turns.at(-1);
    // An admission without capture cannot establish a definitely unsubmitted turn.
    send.blocked ||= !!admission && !send.journal.execution && !last;
    const entry: Entry = {
      send, cwd: admission?.binding.executionCheckout ?? last?.cwd ?? stored?.cwd ?? "",
      model: last?.model ?? stored?.model ?? "", effort: last?.effort ?? stored?.effort ?? "", preparing: false,
      completed: send.journal.turns.slice(-64).map(turn => {
        const projection = captured(turn, admission?.createdAt ?? "1970-01-01T00:00:00.000Z");
        if (send.blocked && send.journal.execution?.turnIndex === turn.turnIndex) {
          projection.run.status = "failed";
          projection.messages.forEach(message => { message.status = "failed"; });
        }
        return projection;
      }),
      ...(send.blocked && last?.submission === "not-submitted" ? { phase: "not-submitted" as const } : {}),
      ...(send.blocked ? { reason: `A pending or blocked Grok execution was recovered. ${RESTART}` } : {}),
    };
    this.entries.set(id, entry);
    return entry;
  }
  private validate(value: GrokTurnInput): GrokTurnInput {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["sessionId", "turnIndex", "prompt", "model", "effort", "cwd", "workspaceId", "worktreeId"].includes(key))) refuse(400, "invalid-grok-turn", "Invalid Grok turn fields");
    const id = sessionId(value.sessionId);
    if (!Number.isSafeInteger(value.turnIndex) || value.turnIndex < 0) refuse(400, "invalid-grok-turn", "turnIndex must be a non-negative integer");
    if (typeof value.prompt !== "string" || !value.prompt.trim() || value.prompt.includes("\0")) refuse(400, "invalid-grok-turn", "Grok prompt must be non-empty text without NUL");
    if (!validGrokChoice(value.model) || !validGrokChoice(value.effort)) refuse(400, "invalid-grok-turn", "Grok model and effort must be explicit single-line text up to 200 characters");
    if (value.cwd !== undefined && !absolute(value.cwd)) refuse(400, "invalid-cwd", "Grok cwd must be absolute");
    if ((value.workspaceId != null || value.worktreeId != null) && (!uuid(value.workspaceId) || !uuid(value.worktreeId))) refuse(400, "invalid-grok-turn", "workspaceId and worktreeId must be UUIDs selected together");
    return { ...value, sessionId: id };
  }
  async submit(value: GrokTurnInput): Promise<GrokSessionView> {
    this.open();
    const input = this.validate(value);
    const entry = this.entry(input.sessionId, true);
    const { send } = entry;
    const old = send.journal.turns[input.turnIndex];
    const previous = old ?? (entry.current?.turnIndex === input.turnIndex ? entry.current : undefined);
    if (previous) {
      if (previous.prompt !== input.prompt || previous.model !== input.model || previous.effort !== input.effort
        || (input.cwd !== undefined && input.cwd !== (old?.cwd ?? previous.cwd ?? entry.cwd))) refuse(409, "grok-turn-conflict", "This turn index already identifies different prompt or settings");
      const admitted = this.options.admissions.getGrokCreate(input.sessionId);
      if (admitted && input.workspaceId != null && (input.workspaceId !== admitted.binding.workspaceId || input.worktreeId !== admitted.binding.worktreeId)) refuse(409, "grok-turn-conflict", "This turn index already identifies a different workspace");
      if (!admitted && entry.current && (input.workspaceId ?? null) !== (entry.current.workspaceId ?? null)) refuse(409, "grok-turn-conflict", "This pending turn index already identifies a different workspace");
      if (!admitted && entry.current && (input.worktreeId ?? null) !== (entry.current.worktreeId ?? null)) refuse(409, "grok-turn-conflict", "This pending turn index already identifies a different worktree");
      return this.snapshot(entry);
    }
    if (send.blocked) refuse(409, "grok-blocked", entry.reason ?? RESTART);
    if (entry.preparing || send.owner) refuse(409, "grok-active", "A Grok turn already owns this App session");
    if (input.turnIndex !== send.turnIndex) refuse(409, "grok-turn-conflict", "Grok turn index is not the next explicit turn");
    const capability = this.capability();
    if (!capability.configured) refuse(409, "grok-unconfigured", capability.reason!);
    entry.current = input;
    entry.handle = undefined;
    entry.stopRequested = false;
    entry.preparing = true;
    entry.phase = undefined;
    entry.reason = undefined;
    try {
      const existing = this.options.admissions.getGrokCreate(input.sessionId);
      const cwd = input.cwd ?? entry.cwd;
      let binding: GrokCreateAdmission["binding"];
      if (existing) {
        binding = existing.binding;
        if ((input.cwd !== undefined && cwd !== binding.executionCheckout) || (input.workspaceId != null && (input.workspaceId !== binding.workspaceId || input.worktreeId !== binding.worktreeId))) refuse(409, "grok-binding-conflict", "Continue Grok only in its original admitted workspace");
        const workspace = await this.options.catalog.registered(binding.workspaceId);
        if (workspace.kind === "repository") refuse(409, "grok-repository-refused", "Grok normal chat does not support repository workspaces");
        const fresh = await this.options.catalog.binding(binding.workspaceId, binding.worktreeId);
        if (fresh.cwd !== binding.executionCheckout || fresh.bindingRevision !== binding.bindingRevision) refuse(409, "binding-invalid", "Grok's original catalog binding changed");
      } else {
        let selectedCwd = cwd;
        if (!selectedCwd && input.workspaceId && input.worktreeId) {
          const workspace = await this.options.catalog.registered(input.workspaceId);
          selectedCwd = workspace.worktrees.find(tree => tree.worktreeId === input.worktreeId)?.root ?? "";
        }
        if (!absolute(selectedCwd)) refuse(400, "invalid-cwd", "Select a directory for a new Grok conversation");
        const associated = await this.options.catalog.associate(input.sessionId, selectedCwd, input.workspaceId ?? undefined, input.worktreeId ?? undefined);
        if (associated.association !== "resolved") refuse(409, "grok-binding-conflict", "Grok workspace association is unresolved");
        const workspace = await this.options.catalog.registered(associated.workspaceId);
        if (workspace.kind === "repository") refuse(409, "grok-repository-refused", "Grok normal chat does not support repository workspaces");
        const tree = workspace.worktrees.find(tree => tree.worktreeId === associated.worktreeId)!;
        binding = { workspaceId: associated.workspaceId, worktreeId: associated.worktreeId, executionCheckout: tree.root, bindingRevision: tree.bindingRevision, checkoutPin: null, domain: { mode: "app-only" } };
      }
      this.open();
      if (entry.stopRequested) refuse(409, "grok-stopped", "Grok was stopped before wrapper creation");
      if (input.cwd !== undefined && input.cwd !== binding.executionCheckout) refuse(409, "grok-binding-conflict", "Use the canonical selected directory for Grok chat");
      entry.cwd = binding.executionCheckout;
      entry.model = input.model;
      entry.effort = input.effort;
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const admissions = this.options.admissions;
      const handle = runGrokTurn(send, {
        kind: send.journal.turns.length ? "continuation" : "new", executable: this.options.executable,
        cwd: entry.cwd, model: input.model, effort: input.effort, prompt: input.prompt,
        workspaceId: binding.workspaceId, worktreeId: binding.worktreeId,
        authority: admissions.getGrokSourcePin(), spawn: this.options.spawn,
        blockOnFailure: true,
        assertBinding: () => {
          this.open();
          const configured = this.capability();
          if (!configured.configured) refuse(409, "grok-unconfigured", configured.reason!);
          this.options.catalog.assertBinding(binding.workspaceId, binding.worktreeId, binding.executionCheckout, binding.bindingRevision);
        },
        admissions: {
          get: id => admissions.get(id), getGrokCreate: id => admissions.getGrokCreate(id), getGrokSourcePin: () => admissions.getGrokSourcePin(),
          beginGrokCreate: request => this.options.admit(input.sessionId, async () => {
            this.open();
            const admitted = await admissions.beginGrokCreate(request);
            // Persist an idle metadata row before returning to the possible spawn.
            await this.options.persistSession({ sessionId: input.sessionId, harness: "grok", nativeSessionId: admitted.nativeId,
              authorityId: admitted.source.authorityId, cwd: admitted.binding.executionCheckout,
              lastRunId: null, lastStatus: "unknown", model: input.model, effort: input.effort,
              profileId: "base:gk", title: input.prompt.trim().replace(/\s+/g, " ").slice(0, 100) || "Grok conversation" });
            return admitted;
          }),
        },
      });
      entry.handle = handle;
      entry.preparing = false;
      entry.live = new OutputProjection({
        id: send.owner!.run.runId, conversationId: input.sessionId, cwd: entry.cwd, createdAt: send.owner!.run.createdAt,
        harness: "grok", nativeSessionId: handle.nativeSessionId, status: "running", model: input.model, effort: input.effort, profileId: "base:gk",
      }, input.prompt);
      const onData = (chunk: Buffer | string) => { entry.live?.feed(chunk); this.options.changed(input.sessionId); };
      send.stdout.on("data", onData);
      const settle = (error?: unknown) => {
        send.stdout.off("data", onData);
        entry.live!.finish();
        const turn = send.journal.turns[input.turnIndex];
        const observation = handle.observation();
        const failed = !!error || send.blocked || observation?.submission !== "submitted";
        const projection = entry.live!.snapshot(failed ? "failed" : "completed", turn?.stderr);
        projection.run.endedAt = new Date().toISOString();
        entry.completed.push(projection);
        entry.completed = entry.completed.slice(-64);
        entry.live = undefined;
        if (failed) {
          send.blocked = true;
          entry.phase = observation?.submission === "not-submitted" ? "not-submitted" : undefined;
          entry.reason = `${error instanceof Error ? error.message : observation?.reason ?? "Grok wrapper failed or its native outcome is unknown."} ${RESTART}`;
        }
        this.options.changed(input.sessionId);
      };
      void handle.done.then(() => settle(), error => settle(error));
      void handle.closed.then(() => this.options.changed(input.sessionId));
      this.options.changed(input.sessionId);
      return this.snapshot(entry);
    } catch (error) {
      entry.preparing = false;
      entry.send.blocked = true;
      entry.phase = "not-submitted";
      entry.reason = `${clip(error instanceof Error ? error.message : "Grok preparation failed.", 2_000)} ${RESTART}`;
      // A withheld continuation still owns this explicit turn index. Record it
      // in the existing capture, not a second retry ledger. No child exists here.
      const admission = this.options.admissions.getGrokCreate(input.sessionId);
      if (!entry.handle && admission && send.journal.execution?.disposition === "idle" && send.turnIndex === input.turnIndex) {
        try {
          beginGrokCaptureTurn(this.directory, send.journal, { appSessionId: input.sessionId, nativeSessionId: admission.nativeId, authorityId: admission.source.authorityId, turnIndex: input.turnIndex });
          const turn = appendGrokCaptureTurn(send.journal, {
            appSessionId: input.sessionId, nativeSessionId: admission.nativeId, authorityId: admission.source.authorityId,
            cwd: admission.binding.executionCheckout, model: input.model, effort: input.effort, prompt: input.prompt, turnIndex: input.turnIndex,
            runId: crypto.randomUUID(), createdAt: new Date().toISOString(), submission: "not-submitted", stdout: "", stderr: entry.reason,
            exitCode: null, nativeCancellation: "not-requested",
          });
          finishGrokCaptureTurn(this.directory, send.journal, { blocked: true });
          send.turnIndex = send.journal.turns.length;
          entry.completed.push(captured(turn, admission.createdAt));
          entry.completed = entry.completed.slice(-64);
        } catch { entry.reason += " Capture storage could not finalize the withheld turn; inspect local state before proceeding."; }
      }
      this.options.changed(input.sessionId);
      throw error;
    }
  }
  private snapshot(entry: Entry): GrokSessionView {
    const admission = this.options.admissions.getGrokCreate(entry.send.appSessionId);
    const active = entry.preparing || !!entry.send.owner;
    const projections = [...entry.completed, ...(entry.live ? [entry.live.snapshot()] : [])].slice(-64);
    const allMessages = projections.flatMap(item => item.messages);
    let budget = 256_000;
    const messages: Message[] = [];
    for (const message of [...allMessages].reverse()) {
      const size = message.parts.reduce((sum, part) => sum + (part.type === "tool" ? 0 : part.text.length), 0);
      if (size > budget) break;
      budget -= size;
      messages.unshift(message);
    }
    if (messages.length < allMessages.length || entry.send.journal.turns.length > 64) {
      const first = messages[0];
      messages.unshift({ id: `grok:${entry.send.appSessionId}:display-limit`, runId: first?.runId ?? "grok-display", time: first?.time ?? "1970-01-01T00:00:00.000Z", status: "unknown", role: "system", parts: [{ type: "text", text: "[Earlier Grok messages omitted from this bounded display]" }] });
    }
    return {
      protocol: "grok-capture", version: 1, sessionId: entry.send.appSessionId,
      nativeSessionId: entry.send.nativeSessionId ?? admission?.nativeId ?? entry.handle?.nativeSessionId ?? null,
      authorityId: admission?.source.authorityId ?? entry.send.journal.execution?.authorityId ?? this.options.admissions.getGrokSourcePin()?.authorityId ?? "",
      cwd: entry.cwd, model: entry.model, effort: entry.effort,
      phase: entry.send.blocked ? entry.phase ?? "blocked" : entry.preparing ? "preparing" : active ? "running" : "idle",
      nextTurnIndex: entry.send.turnIndex, active, blocked: entry.send.blocked,
      ...(entry.reason ? { reason: entry.reason } : {}), nativeAcceptance: "unknown", acceptedMessageId: null,
      messages, runs: projections.map(item => ({ ...item.run })),
    };
  }
  async view(id: string): Promise<GrokSessionView> { return this.snapshot(this.entry(sessionId(id))); }
  /** Latest local wrapper per loaded session, for sidebar recency only. These
   * are never inserted into metadata.runs or used as native admission evidence. */
  presentationRuns(): Run[] {
    return [...this.entries.values()].flatMap(entry => {
      const run = entry.live?.run ?? entry.completed.at(-1)?.run;
      if (!run) return [];
      return [{ runId: run.id, sessionId: entry.send.appSessionId, cwd: entry.cwd,
        status: run.status === "running" || run.status === "starting" ? "running" as const
          : run.status === "completed" ? "completed" as const : "failed" as const,
        createdAt: run.createdAt, ...(run.endedAt ? { endedAt: run.endedAt } : {}) }];
    });
  }
  overlay(session: Session): Session {
    if (session.harness !== "grok") return session;
    const entry = this.entries.get(session.sessionId);
    if (!entry) return session;
    const run = entry.live?.run ?? entry.completed.at(-1)?.run;
    return { ...session, lastRunId: run?.id ?? null, lastStatus: entry.send.blocked ? "failed" : run?.status === "running" || run?.status === "starting" ? "running" : run?.status === "completed" ? "completed" : run ? "failed" : "unknown" };
  }
  async stop(id: string): Promise<GrokStopView> {
    const entry = this.entry(sessionId(id));
    const handle = entry.handle;
    if (entry.preparing && !handle) {
      entry.stopRequested = true;
      entry.send.blocked = true;
      entry.phase = "not-submitted";
      entry.reason = `Grok was stopped before wrapper creation. ${RESTART}`;
      this.options.changed(entry.send.appSessionId);
    }
    if (!handle || !entry.send.owner) return { interrupted: false, nativeCancellation: "not-attempted", wrapperClosed: !entry.send.owner, reason: "No live Grok wrapper is owned here; native cancellation is not attempted." };
    const result = handle.stop();
    await handle.done.catch(() => {});
    this.options.changed(entry.send.appSessionId);
    return { interrupted: false, nativeCancellation: result.nativeCancellation, wrapperClosed: handle.observation()?.wrapperCompletion !== "incomplete" && !entry.send.owner, reason: result.reason };
  }
  async close(): Promise<{ drained: boolean }> {
    this.closing = true;
    const handles = [...this.entries.values()].filter(entry => entry.send.owner && entry.handle).map(entry => entry.handle!);
    for (const handle of handles) handle.stop();
    await Promise.all(handles.map(handle => handle.done.catch(() => {})));
    return { drained: ![...this.entries.values()].some(entry => entry.send.owner) };
  }
}
