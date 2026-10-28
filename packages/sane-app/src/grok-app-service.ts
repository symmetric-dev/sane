import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { GrokCapability, GrokSessionView, GrokStopView, GrokTurnInput } from "../shared/conversation/grok-contract";
import { validGrokChoice } from "../shared/conversation/grok-contract";
import type { Message, RunMetadata } from "../shared/conversation/types";
import type { AdmissionService, GrokCreateAdmission } from "./admission";
import type { CatalogService } from "./catalog";
import type { GrokSpawn } from "./grok-adapter";
import { appendGrokCaptureTurn, beginGrokCaptureTurn, finishGrokCaptureTurn, grokCaptureFilename, type GrokCaptureTurn } from "./grok-capture";
import { createGrokSendSession, runGrokTurn, type GrokSendSession, type GrokTurnHandle } from "./grok-send";
import { uuid, type Run, type Session } from "./history";
import { WorkstreamAdapterError } from "./workstreams";
import type { RunOwner } from "./run-owner";
import { GrokOutputProjection as OutputProjection } from "./grok-output";
import { installGrokNativeRuntime } from "./grok-native-runtime";

export type GrokProfileSnapshot = Pick<Session, "profileId" | "agent" | "agentKind" | "nativeAgentSelected" | "saneExecution" | "saneContext">;

type Options = {
  dataDir: string;
  admissions: AdmissionService;
  catalog: CatalogService;
  executable?: string;
  homeRoot?: string;
  appConnectionFile?: string;
  bindingDirectory?: string;
  assertOpen: () => void;
  admit: <T>(sessionId: string, work: () => Promise<T>) => Promise<T>;
  reserveTurn?: (sessionId: string) => () => void;
  persistSession: (session: Session) => Promise<void>;
  changed: (sessionId: string) => void;
  /** Pending-only captures have no model/effort; recover those from idle metadata. */
  readSession?: (sessionId: string) => Session | undefined;
  resolveProfile?: (input: GrokTurnInput, stored?: Session) => Promise<GrokProfileSnapshot>;
  preparePrompt?: (session: Session, owner: RunOwner, prompt: string, firstTurn: boolean) => Promise<string>;
  managedView?: (sessionId: string) => Promise<GrokSessionView | null>;
  managedSubmit?: (input: GrokServiceTurnInput) => Promise<GrokSessionView>;
  managedStop?: (sessionId: string) => Promise<GrokStopView>;
  spawn?: GrokSpawn;
};
type Projection = { messages: Message[]; run: RunMetadata };
export type GrokServiceTurnInput = GrokTurnInput & { nativeStopped?: boolean };
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
  session?: Session;
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

function captured(turn: GrokCaptureTurn, createdAt: string, snapshot?: GrokProfileSnapshot): Projection {
  const projection = new OutputProjection({
    id: turn.runId ?? `grok:${turn.appSessionId}:${turn.turnIndex}`, conversationId: turn.appSessionId,
    cwd: turn.cwd, createdAt: turn.createdAt ?? createdAt, harness: "grok", nativeSessionId: turn.nativeSessionId,
    model: turn.model, effort: turn.effort, profileId: turn.profileId ?? snapshot?.profileId ?? "base:gk",
    ...(snapshot?.agent ? { agent: snapshot.agent, agentKind: snapshot.agentKind, nativeAgentSelected: snapshot.nativeAgentSelected } : {}),
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
  private tools?: string;
  private closing = false;
  constructor(private options: Options) {
    this.directory = join(options.dataDir, "grok-captures");
    if (options.appConnectionFile && options.bindingDirectory) installGrokNativeRuntime({ appConnectionFile: options.appConnectionFile, bindingDirectory: options.bindingDirectory });
  }
  nativeToolPath(): string {
    if (this.tools) return this.tools;
    const directory = join(this.options.dataDir, "native-tools", "grok");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(join(directory, "sane"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve(import.meta.dir, "../../../bin/sane.ts"))} "$@"\n`, { mode: 0o700 });
    return this.tools = directory;
  }

  capability(): GrokCapability {
    const pin = this.options.admissions.getGrokSourcePin();
    const reason = !absolute(this.options.executable) ? "Configure an explicit absolute Grok executable; PATH lookup is not performed."
      : !absolute(this.options.homeRoot) ? "Configure an explicit absolute Grok home."
      : !pin?.authorityId ? "Grok requires an explicitly published, resolved gk source pin."
      : pin.descriptor.homeRoot !== this.options.homeRoot ? "Configured Grok home does not match the saved gk source pin."
      : undefined;
    return { protocol: "grok-capture", version: 1, configured: !reason,
      profileUpgrades: !!this.options.resolveProfile && !!this.options.preparePrompt, ...(reason ? { reason } : {}) };
  }
  has(id: string): boolean { return this.entries.has(id) || !!this.options.admissions.getGrokCreate(id); }
  activeCount(): number { return [...this.entries.values()].filter(entry => entry.preparing || entry.send.owner).length; }
  isActive(id: string): boolean { const entry = this.entries.get(id); return !!entry && (entry.preparing || !!entry.send.owner); }
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
    const entry: Entry = {
      send, cwd: admission?.binding.executionCheckout ?? last?.cwd ?? stored?.cwd ?? "",
      model: last?.model ?? stored?.model ?? "", effort: last?.effort ?? stored?.effort ?? "", preparing: false, session: stored,
      completed: send.journal.turns.slice(-64).map(turn => {
        const projection = captured(turn, admission?.createdAt ?? "1970-01-01T00:00:00.000Z", stored);
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
  private validate(value: GrokTurnInput): GrokServiceTurnInput {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["sessionId", "turnIndex", "prompt", "model", "effort", "profileId", "cwd", "workspaceId", "worktreeId", "requestId", "scienceSnapshots", "nativeStopped"].includes(key))) refuse(400, "invalid-grok-turn", "Invalid Grok turn fields");
    const id = sessionId(value.sessionId);
    if (!Number.isSafeInteger(value.turnIndex) || value.turnIndex < 0) refuse(400, "invalid-grok-turn", "turnIndex must be a non-negative integer");
    const science = Object.hasOwn(value, "scienceSnapshots");
    if (science && (!uuid(value.requestId) || !Array.isArray(value.scienceSnapshots) || value.scienceSnapshots.length < 1 || value.scienceSnapshots.length > 4
      || value.scienceSnapshots.some(ref => !ref || typeof ref !== "object" || Array.isArray(ref) || Object.keys(ref).length !== 2 || typeof ref.snapshotId !== "string" || typeof ref.blockId !== "string")
      || new Set(value.scienceSnapshots.map(ref => ref.snapshotId)).size !== value.scienceSnapshots.length)) refuse(400, "invalid-grok-turn", "Science sends require a request UUID and 1–4 frozen snapshot references");
    if (!science && value.requestId !== undefined) refuse(400, "invalid-grok-turn", "requestId requires frozen science references");
    if (typeof value.prompt !== "string" || value.prompt.includes("\0") || (!value.prompt.trim() && !(science && value.prompt === ""))) refuse(400, "invalid-grok-turn", "Grok prompt must be non-empty text, or exactly empty beside frozen science references");
    if ((value as GrokServiceTurnInput).nativeStopped !== undefined && typeof (value as GrokServiceTurnInput).nativeStopped !== "boolean") refuse(400, "invalid-grok-turn", "nativeStopped must be a boolean acknowledgement");
    if (!validGrokChoice(value.model) || !validGrokChoice(value.effort)) refuse(400, "invalid-grok-turn", "Grok model and effort must be explicit single-line text up to 200 characters");
    if (value.profileId !== undefined && (typeof value.profileId !== "string" || !value.profileId.trim())) refuse(400, "invalid-grok-turn", "Select a saved Grok profile");
    if (value.cwd !== undefined && !absolute(value.cwd)) refuse(400, "invalid-cwd", "Grok cwd must be absolute");
    if ((value.workspaceId != null || value.worktreeId != null) && (!uuid(value.workspaceId) || !uuid(value.worktreeId))) refuse(400, "invalid-grok-turn", "workspaceId and worktreeId must be UUIDs selected together");
    return { ...value, sessionId: id };
  }
  async submit(value: GrokTurnInput): Promise<GrokSessionView> {
    this.open();
    const input = this.validate(value);
    const stored = this.options.readSession?.(input.sessionId);
    let captureExists = this.entries.has(input.sessionId);
    if (!captureExists) {
      try { lstatSync(join(this.directory, grokCaptureFilename(input.sessionId))); captureExists = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (this.options.managedSubmit && (await this.options.managedView?.(input.sessionId)
      || stored?.harness === "grok" && !captureExists
      || !this.has(input.sessionId) && !stored)) return this.options.managedSubmit(input);
    if (Object.hasOwn(input, "scienceSnapshots")) refuse(409, "grok-science-managed-required", "Frozen science snapshots require the managed Grok submission path; legacy capture cannot share them");
    if (input.nativeStopped === true) refuse(409, "grok-native-ack-managed-required", "Attached native-session acknowledgements require the managed Grok submission path");
    const entry = this.entry(input.sessionId, true);
    const { send } = entry;
    const old = send.journal.turns[input.turnIndex];
    const previous = old ?? (entry.phase !== "not-submitted" && entry.current?.turnIndex === input.turnIndex ? entry.current : undefined);
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
    let releaseTurn: (() => void) | undefined;
    try {
      releaseTurn = this.options.reserveTurn?.(input.sessionId);
      const stored = this.options.readSession?.(input.sessionId) ?? entry.session;
      const profile = await this.options.resolveProfile?.(input, stored) ?? { profileId: stored?.profileId ?? input.profileId ?? "base:gk" };
      if (stored && profile.profileId !== stored.profileId) {
        entry.session = { ...stored, ...profile };
        await this.options.persistSession(entry.session);
      }
      const existing = this.options.admissions.getGrokCreate(input.sessionId);
      if (existing && !stored) {
        entry.session = { sessionId: input.sessionId, harness: "grok", nativeSessionId: existing.nativeId,
          authorityId: existing.source.authorityId, cwd: existing.binding.executionCheckout, lastRunId: null, lastStatus: "unknown",
          model: input.model, effort: input.effort, ...profile, title: input.prompt.trim().replace(/\s+/g, " ").slice(0, 100) || "Grok conversation" };
        await this.options.persistSession(entry.session);
      }
      const cwd = input.cwd ?? entry.cwd;
      let binding: GrokCreateAdmission["binding"];
      if (existing) {
        binding = existing.binding;
        if ((input.cwd !== undefined && cwd !== binding.executionCheckout) || (input.workspaceId != null && (input.workspaceId !== binding.workspaceId || input.worktreeId !== binding.worktreeId))) refuse(409, "grok-binding-conflict", "Continue Grok only in its original admitted workspace");
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
      const toolPath = this.nativeToolPath();
      const admissions = this.options.admissions;
      const handle = runGrokTurn(send, {
        kind: send.journal.turns.some(turn => turn.submission === "submitted") ? "continuation" : "new", executable: this.options.executable,
        cwd: entry.cwd, model: input.model, effort: input.effort, prompt: input.prompt,
        workspaceId: binding.workspaceId, worktreeId: binding.worktreeId,
        authority: admissions.getGrokSourcePin(), spawn: this.options.spawn,
        toolPath,
        appConnectionFile: this.options.appConnectionFile,
        bindingDirectory: this.options.bindingDirectory,
        profileId: profile.profileId,
        contextRevision: profile.saneContext?.package?.revision,
        preparePrompt: async (owner, admitted) => {
          const session = this.options.readSession?.(input.sessionId) ?? entry.session;
          if (!session || session.nativeSessionId !== admitted.nativeId) throw new Error("Grok session metadata is unavailable before launch");
          const contextRevision = session.saneContext?.package?.revision;
          const bootstrap = contextRevision !== undefined && !send.journal.turns.some(turn => turn.submission === "submitted" && turn.contextRevision === contextRevision);
          return this.options.preparePrompt?.(session, owner, input.prompt, bootstrap) ?? input.prompt;
        },
        assertBinding: () => {
          this.open();
          const configured = this.capability();
          if (!configured.configured) refuse(409, "grok-unconfigured", configured.reason!);
          this.options.catalog.assertBinding(binding.workspaceId, binding.worktreeId, binding.executionCheckout, binding.bindingRevision);
        },
        admissions: {
          get: id => admissions.get(id), getGrokCreate: id => admissions.getGrokCreate(id), getGrokSourcePin: () => admissions.getGrokSourcePin(),
          beginGrokCreate: request => {
            const create = async () => {
            this.open();
            const admitted = await admissions.beginGrokCreate(request);
            // Persist an idle metadata row before returning to the possible spawn.
            const session: Session = { sessionId: input.sessionId, harness: "grok", nativeSessionId: admitted.nativeId,
              authorityId: admitted.source.authorityId, cwd: admitted.binding.executionCheckout,
              lastRunId: null, lastStatus: "unknown", model: input.model, effort: input.effort,
              ...profile, title: input.prompt.trim().replace(/\s+/g, " ").slice(0, 100) || "Grok conversation" };
            entry.session = session;
            await this.options.persistSession(session);
            return admitted;
            };
            return releaseTurn ? create() : this.options.admit(input.sessionId, create);
          },
        },
      });
      entry.handle = handle;
      entry.preparing = false;
      entry.live = new OutputProjection({
        id: send.owner!.run.runId, conversationId: input.sessionId, cwd: entry.cwd, createdAt: send.owner!.run.createdAt,
        harness: "grok", nativeSessionId: handle.nativeSessionId, status: "running", model: input.model, effort: input.effort,
        profileId: profile.profileId, agent: profile.agent, agentKind: profile.agentKind, nativeAgentSelected: profile.nativeAgentSelected,
        saneContextVersion: profile.saneContext?.version,
      }, input.prompt);
      const onData = (chunk: Buffer | string) => { entry.live?.feed(chunk); this.options.changed(input.sessionId); };
      send.stdout.on("data", onData);
      const settle = (error?: unknown) => {
        send.stdout.off("data", onData);
        entry.live!.finish();
        const turn = send.journal.turns[input.turnIndex];
        const observation = handle.observation();
        const failed = !!error || send.blocked || observation?.submission !== "submitted" || observation.wrapperCompletion !== "closed"
          || observation.exitCode !== 0 || observation.exitSignal !== null;
        const projection = entry.live!.snapshot(failed ? "failed" : "completed", turn?.stderr);
        projection.run.endedAt = new Date().toISOString();
        entry.completed.push(projection);
        entry.completed = entry.completed.slice(-64);
        entry.live = undefined;
        if (failed) {
          entry.phase = observation?.submission === "not-submitted" ? "not-submitted" : undefined;
          entry.reason = `${error instanceof Error ? error.message : observation?.reason ?? "Grok exited before completing the turn."}${send.blocked ? ` ${RESTART}` : ""}`;
        }
        this.options.changed(input.sessionId);
        if (!send.owner) { releaseTurn?.(); releaseTurn = undefined; }
      };
      void handle.done.then(() => settle(), error => settle(error));
      void handle.closed.then(() => { releaseTurn?.(); releaseTurn = undefined; this.options.changed(input.sessionId); });
      this.options.changed(input.sessionId);
      return this.snapshot(entry);
    } catch (error) {
      releaseTurn?.(); releaseTurn = undefined;
      entry.preparing = false;
      entry.phase = "not-submitted";
      entry.reason = `${clip(error instanceof Error ? error.message : "Grok preparation failed.", 2_000)}${entry.send.blocked ? ` ${RESTART}` : ""}`;
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
          finishGrokCaptureTurn(this.directory, send.journal, { blocked: send.blocked });
          send.turnIndex = send.journal.turns.length;
          entry.completed.push(captured(turn, admission.createdAt, entry.session));
          entry.completed = entry.completed.slice(-64);
        } catch { entry.reason += " Capture storage could not finalize the withheld turn; inspect local state before proceeding."; }
      }
      this.options.changed(input.sessionId);
      throw error;
    }
  }
  private snapshot(entry: Entry): GrokSessionView {
    const admission = this.options.admissions.getGrokCreate(entry.send.appSessionId);
    const session = this.options.readSession?.(entry.send.appSessionId) ?? entry.session;
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
      profileId: session?.profileId ?? entry.current?.profileId ?? "base:gk", agent: session?.agent, agentKind: session?.agentKind,
      nativeAgentSelected: session?.nativeAgentSelected, title: session?.title,
      workspaceId: admission?.binding.workspaceId ?? entry.current?.workspaceId ?? undefined,
      worktreeId: admission?.binding.worktreeId ?? entry.current?.worktreeId ?? undefined,
      phase: entry.send.blocked ? entry.phase ?? "blocked" : entry.preparing ? "preparing" : active ? "running" : "idle",
      nextTurnIndex: entry.send.turnIndex, active, blocked: entry.send.blocked,
      ...(entry.reason ? { reason: entry.reason } : {}), nativeAcceptance: "unknown", acceptedMessageId: null,
      messages, runs: projections.map(item => ({ ...item.run })),
    };
  }
  async view(id: string): Promise<GrokSessionView> {
    const selected = sessionId(id);
    return await this.options.managedView?.(selected) ?? this.snapshot(this.entry(selected));
  }
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
    if (this.options.managedStop && await this.options.managedView?.(sessionId(id))) return this.options.managedStop(id);
    const entry = this.entry(sessionId(id));
    const handle = entry.handle;
    if (entry.preparing && !handle) {
      entry.stopRequested = true;
      entry.phase = "not-submitted";
      entry.reason = "Grok was stopped before sending.";
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
