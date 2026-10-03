import { readFile, writeFile, rename, appendFile, stat, readdir, realpath } from "node:fs/promises";
import { resolve, dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { BridgeAuth, validateBridgeAuthOptions } from "./bridge-auth";
import { body, equal, json, loopback } from "./bridge-http";
import { ClaudeRunService, hookEvents } from "./claude-run-service";
import { resolveAppConfig } from "./app-config";
import { buildAssets, validateAssets } from "./asset-build";
import { acquireInstallation, acquireData, validateOwnershipPaths, type OwnershipHandle } from "./installation-ownership";
import { claudeSourceRoot } from "./claude-source";
import { decodeLog, validModel, validEffort, validVariant, validCompactRequest, uuid, efforts, type Session, type Run, type Event, type Metadata } from "./history";
import { projectCompactions } from "./compaction";
import type { CompactEligibility, CompactRequest, CompactResponse } from "./oc-contract";
import { OpenCodeAdapter, OpenCodeError } from "./opencode";
import { OpenCodeRunService } from "./opencode-run-service";
import type { RunOwner as Owner } from "./run-owner";
import { WorkspaceService, WorkspaceError, workspaceError } from "./workspace";
import { CatalogService } from "./catalog";
import { TerminalService, type TerminalSocketData } from "./terminal";
import { RepositoryRouter, WorkstreamAdapterError, authenticatedWorkstreamRoute, validateWorkstreamInput, flushAndCloseWorkstreams } from "./workstreams";
import type { WorkstreamAction, WorkstreamActionInput, WorkstreamActionResult } from "./workstreams-contract";
import { validateAppStore, assertSourceConfiguration, atomicAppRecord, atomicNativeHistory, loadAgentProfiles, validateAgentProfiles, AppStoreError, type SourceConfiguration } from "./app-store";
import { builtinProfiles, canAssign, historicalAgentProfile, legacyProfileId, storedAssistantLabel, templateProfileId, resolveAgentLaunch, resolveAssistantProfile, BASE_PROFILE_IDS, type AgentProfile, type AgentProfiles } from "./agent-profiles-contract";
import { AdmissionService } from "./admission";
import { HandoffService, handoffRecipientTitle, projectHandoffEnqueue, projectHandoffStatus, slotSessionIndex } from "./handoff";
import { DomainError, canonicalSlot, equivalentSlots, normalizeNativeSource, revalidateCheckout } from "sane-core/server";
import { classifyCaller } from "../../sane-cli/src/cli-arguments";
import { WorkerStore } from "./worker-store";
import { WorkerService } from "./workers";
import { createNativeWorkerHandler, NativeWorkerRequestError, type NativeWorkerCallerResolver } from "./native-workers";
import { matchesOpenCodeWorkerPart, nativeWorkerInput, projectNativeWorkerReply } from "../../sane-cli/src/native-worker-contract";
import { workerTerminationUncertainty } from "./worker-recovery";
import { workerDeliveryEvidence, workerReportPrompt } from "./worker-outbox";
import { restoreWorkerOutput, workerOutput } from "./worker-output";
import { DEFAULT_MAX_WORKERS_PER_CHECKOUT, workerResults, type WorkerDelivery } from "./worker-contract";
import { ASSISTANT_AGENT_DESCRIPTIONS, ASSISTANT_AGENT_IDS, ASSISTANT_AGENT_LABELS, isAssistantAgentId, isStoredAssistantAgentId, nativeAgentId } from "sane-core/agent-catalog";
import { agentLaunchSnapshot, claudeAgentSettings, saneContextSnapshot, saneContextText, saneSessionContext, workerAssignment } from "./agent-launch";
import { readClaudeHistory, forkClaudeHistory, verifyClaudeFork, coveredNativeRuns, type ReconciledHistory } from "./reconcile";
import { BranchStore, type BranchOperation } from "./branches";
import { NativeHistoryCache, TranscriptError, TranscriptService } from "./transcript-service";
import { capabilitiesFor, getHarnessDescriptor, isHarness } from "../shared/conversation/harness-capabilities";
import { HarnessOperationError, dispatchHarness, dispatchOwnedOperation, requireOperation, requireOwnedOperation, validateHarness } from "./harness-operations";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export { hookEvents };
export type Options = { host: string; port: number; cwd: string; dataDir: string; claudeBin: string; nativeSources: SourceConfiguration; allowRemote: boolean; publicOrigin?: string; reconcileInterrupted: boolean; maxConcurrentRuns?: number; maxWorkersPerCheckout?: number; packageDir?: string; noBuild?: boolean };
export function parseOptions(args: string[]): Options {
  return runtimeOptions(resolveAppConfig(args, { packageDir: root, invocationCwd: process.cwd() }));
}
export function runtimeOptions(resolved: ReturnType<typeof resolveAppConfig>): Options {
  const { config: c, operational } = resolved;
  return { host: c.server.host, port: c.server.port, cwd: c.defaultExecutionCwd, dataDir: c.dataDir,
    claudeBin: c.native.claude.executable, allowRemote: c.server.allowRemote, publicOrigin: c.server.publicOrigin ?? undefined,
    maxConcurrentRuns: c.maxConcurrentRuns, maxWorkersPerCheckout: c.maxWorkersPerCheckout, reconcileInterrupted: operational.reconcileInterrupted, noBuild: operational.noBuild,
    nativeSources: { cc: { version: 1, harness: "cc", kind: "local-profile", profileRoot: c.native.claude.profileRoot },
      oc: { version: 1, harness: "oc", kind: "local-registration", registrationFile: c.native.opencode.registrationFile } } };
}
export function startupSummary(o: Options): string {
  return ["SANE App startup configuration:", `  Invocation cwd: ${process.cwd()}`, `  Default execution cwd: ${o.cwd}`, `  App data: ${o.dataDir}`,
    `  Native mode: Claude executable ${o.claudeBin}; configured managed OpenCode registration`,
    `  Listener: ${o.host}:${o.port}; public origin: ${o.publicOrigin ?? "listener origin"}`,
    "  Workstreams: explicit per-workspace inspect/init; no implicit project initialization",
  ].join("\n");
}
const compactCommand = (text: string) => /^\s*\/compact(?:\s|$)/i.test(text);
/** Both Code search routes share the host's read-only request lifetime. A
 * completion enters the registry before action starts and leaves only after
 * WorkspaceService.search has awaited its descriptor/evaluator cleanup. */
export function createWorkspaceSearchLifecycle() {
  const shutdown = new AbortController();
  const active = new Set<Promise<void>>();
  let drain: Promise<void> | undefined;
  const assertOpen = () => { if (shutdown.signal.aborted) throw new WorkspaceError(503, "search-shutdown", "Bridge is shutting down"); };
  return {
    assertOpen,
    async run<T>(requestSignal: AbortSignal, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
      assertOpen();
      if (requestSignal.aborted) throw new WorkspaceError(499, "search-aborted", "Search cancelled");
      const signal = AbortSignal.any([requestSignal, shutdown.signal]);
      const done = Promise.withResolvers<void>();
      active.add(done.promise);
      try { return await action(signal); }
      finally { done.resolve(); active.delete(done.promise); }
    },
    close(): Promise<void> {
      if (drain) return drain;
      shutdown.abort();
      // Abort rejection is an ordinary read-only outcome, not storage failure.
      return drain = Promise.all([...active]).then(() => {});
    },
  };
}
async function drainWorkspaceSearches(drain: Promise<void>): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([drain.then(() => true), new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), 12000); })]);
  } finally { if (timeout !== undefined) clearTimeout(timeout); }
}
export async function start(options: Options) {
  const paths = validateOwnershipPaths(options.packageDir ?? root, options.dataDir);
  const installation = acquireInstallation(paths, { phase: "starting", reconcileInterrupted: options.reconcileInterrupted });
  let data: OwnershipHandle | undefined;
  let bridge: Awaited<ReturnType<typeof startOwned>> | undefined;
  const retain = () => { try { data?.retain(); } finally { installation.retain(); } };
  const release = () => { data?.release(); installation.release(); };
  try {
    data = acquireData(installation, { phase: "starting", reconcileInterrupted: options.reconcileInterrupted });
    options = { ...options, dataDir: paths.dataDir! };
    assertSourceConfiguration(validateAppStore(options.dataDir).sources, options.nativeSources);
    installation.update("build");
    const assets = options.noBuild ? validateAssets({ packageDir: paths.packageDir }) : await buildAssets({ packageDir: paths.packageDir, ownership: installation });
    installation.update("starting");
    bridge = await startOwned(options, assets.assetsDir, paths.packageDir, retain);
    const listener = { host: options.host, port: bridge.port! };
    installation.update("serving", listener); data.update("serving", listener);
    const running = bridge;
    let closing: Promise<void> | undefined;
    return { origin: running.origin, port: running.port, workers: running.workers, workerOutbox: running.workerOutbox, close() {
      return closing ??= (async () => {
        try { installation.update("draining"); data!.update("draining"); await running.close(); }
        catch (error) { retain(); throw error; }
        release();
      })();
    } };
  } catch (error) {
    if (bridge) { try { await bridge.close(); } catch { retain(); } }
    release(); throw error;
  }
}
async function startOwned(options: Options, assetsDir: string, packageDir: string, retainOwnership: () => void) {
  const indexHtml = await readFile(join(packageDir, "public", "index.html"), "utf8");
  const maxConcurrentRuns = options.maxConcurrentRuns ?? 24;
  if (!Number.isSafeInteger(maxConcurrentRuns) || maxConcurrentRuns < 1 || maxConcurrentRuns > 256) throw new Error("max-concurrent-runs must be an integer from 1 to 256");
  const maxWorkersPerCheckout = options.maxWorkersPerCheckout ?? DEFAULT_MAX_WORKERS_PER_CHECKOUT;
  if (!Number.isSafeInteger(maxWorkersPerCheckout) || maxWorkersPerCheckout < 1 || maxWorkersPerCheckout > 256) throw new Error("maxWorkersPerCheckout must be an integer from 1 to 256");
  const store = validateAppStore(options.dataDir);
  assertSourceConfiguration(store.sources, options.nativeSources);
  if (options.nativeSources.cc.harness !== "cc" || options.nativeSources.oc.harness !== "oc") throw new Error("Invalid configured native harnesses");
  const claudeRoot = options.nativeSources.cc.profileRoot;
  if (process.env.CLAUDE_CONFIG_DIR !== undefined && claudeSourceRoot() !== claudeRoot) throw new Error("Contradictory native selector: CLAUDE_CONFIG_DIR");
  if (process.env.CLAUDE_CODE_PROJECT_DIR_NAME) throw new Error("Unsupported native selector: CLAUDE_CODE_PROJECT_DIR_NAME");
  const oc = new OpenCodeAdapter(undefined, undefined, options.nativeSources.oc.registrationFile);
  // Historical App sessions may omit the harness; no unknown value defaults.
  const sessionHarness = (session: Session) => validateHarness(session.harness, { defaultHarness: "claude-code" });
  const nativeSource = (harness?: string) => store.sources[getHarnessDescriptor(validateHarness(harness, { defaultHarness: "claude-code" }))!.nativeHarness].authorityId ?? "unavailable";
  function readNativeHistory(harness: unknown, nativeId: string, cwd: string) {
    const descriptor = requireOperation(harness, "readHistory");
    return dispatchHarness(descriptor.id, {
      "claude-code": async () => ({ messages: await readClaudeHistory(nativeId, cwd, claudeRoot), activity: "unknown" as const }),
      opencode: () => oc.history(nativeId, cwd),
    });
  }
  const forbidden = Object.keys(process.env).filter(k => /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_API_KEY|CLAUDE_CODE_BASE_URL|CLAUDE_CODE_CUSTOM_MODEL_OPTION|AWS_BEARER_TOKEN_BEDROCK|OPENAI_API_KEY|OPENAI_BASE_URL)/.test(k));
  if (forbidden.length) throw new Error(`Remove API/provider overrides: ${forbidden.join(", ")}`);
  try { if (!(await stat(options.cwd)).isDirectory()) throw new Error(); }
  catch { throw new Error(`Execution cwd must be an existing directory: ${options.cwd}. Set --cwd to the intended checkout.`); }
  const password = process.env.SANE_APP_PASSWORD;
  const authOptions = { ...options, password };
  validateBridgeAuthOptions(authOptions);
  let retainOwner = false;
  let router: RepositoryRouter | undefined;
  const searches = createWorkspaceSearchLifecycle();
  try {
  const metadataPath = join(options.dataDir, "metadata.json");
  const meta: Metadata = store.metadata;
  let agentProfiles: AgentProfiles = loadAgentProfiles(options.dataDir);
  const catalog = new CatalogService(options.dataDir, () => meta.sessions);
  for (const session of meta.sessions) if (session.attachment && session.attachment.source !== nativeSource(session.harness)) throw new Error("Attached native authority source changed; restore the original native store/service configuration");
  await catalog.load();
  // Artifacts are readable only through the domain API, even when its state is
  // outside App data. Use a canonical root for both ordinary Code entry points.
  router = new RepositoryRouter(catalog, store.sources);
  const admissions = new AdmissionService(options.dataDir, store.admissions, store.sources, catalog, router);
  const workerStore = new WorkerStore(options.dataDir);
  const branches = new BranchStore(options.dataDir);
  const branchRequests = new Set<string>();
  const execution = async (sessionId: string) => { const a = admissions.get(sessionId); if (!a) throw new WorkstreamAdapterError(409, "admission-missing", "Conversation has no durable admission"); return router!.execution(a); };
  const domainProtectedPaths: string[] = [];
  const workspace = new WorkspaceService(async (id, operation) => {
    const session = meta.sessions.find(session => session.sessionId === id);
    if (!session) return undefined;
    const a = catalog.association(id);
    if (a.association === "unresolved") throw new WorkspaceError(409, "association-unresolved", "Conversation workspace is unresolved; historical logs remain available");
    const binding = await catalog.binding(a.workspaceId, a.worktreeId, operation);
    if ((await catalog.discover(session.cwd, operation)).root !== binding.cwd) throw new WorkspaceError(409, "cwd-worktree-mismatch", "Conversation cwd binding changed");
    return { cwd: session.cwd, protectedPaths: [...binding.protectedPaths, ...domainProtectedPaths] };
  }, options.dataDir);
  const worktrees = new WorkspaceService(async (key, operation) => {
    const [workspaceId, worktreeId] = key.split("/");
    const binding = await catalog.binding(workspaceId!, worktreeId!, operation);
    return { ...binding, protectedPaths: [...binding.protectedPaths, ...domainProtectedPaths] };
  }, options.dataDir, async (key, operation) => {
    const [workspaceId, worktreeId] = key.split("/");
    const protection = [...domainProtectedPaths];
    const lease = await catalog.searchLease(workspaceId!, worktreeId!, operation);
    if (!lease) return undefined;
    let protectionInvalid = false;
    const checkProtection = () => {
      if (protectionInvalid || domainProtectedPaths.length !== protection.length || domainProtectedPaths.some((path, index) => path !== protection[index])) {
        protectionInvalid = true;
        throw new WorkspaceError(409, "binding-invalid", "Search protection changed");
      }
    };
    const validate = async (next: typeof operation) => {
      checkProtection();
      await lease.validate(next);
      checkProtection();
    };
    await validate(operation);
    const binding = { ...lease.binding, protectedPaths: [...(lease.binding.protectedPaths ?? []), ...protection] };
    Object.freeze(binding.protectedPaths); Object.freeze(binding);
    return { binding, validate, dispose: lease.dispose };
  });
  const events = new Map<string, Event[]>();
  const nativeHistories = new NativeHistoryCache(options.dataDir);
  const transcripts = new TranscriptService(() => meta.sessions, () => meta.runs, nativeHistories, async (session, kind, id) => {
    if (kind === "worker") {
      const worker = workerStore.get(id);
      return worker?.parent.sessionId === session.sessionId ? { kind, runId: worker.parent.runId, toolCallId: worker.parent.toolCallId } : undefined;
    }
    const presentation = (await handoffs.forSession(session.sessionId)).find(p => p.handoff.id === id && p.sender.sessionId === session.sessionId);
    return presentation ? { kind, presentation } : undefined;
  });
  function saveNativeHistory(history: ReconciledHistory) {
    atomicNativeHistory(options.dataDir, history);
    nativeHistories.invalidate(history.sessionId);
  }
  // Durable validation forbids aliases for a qualified native ID. New IDs are
  // reserved before awaits, then retained until the selected owner's lifecycle ends.
  const owners = new Map<string, Owner>();
  const admitting = new Set<string>();
  const attaching = new Set<string>();
  const attachmentTasks = new Set<Promise<void>>();
  const handoffReservations = new Set<string>();
  const handoffAcknowledgements = new Set<string>();
  const handoffDispatches = new Map<string, Promise<void>>();
  const lifecycleReservations = new Map<string, string>(); // repository UUID -> workspace
  function lifecycleReserved(sessionId: string) {
    const admission = admissions.get(sessionId), workspaceId = catalog.association(sessionId).workspaceId;
    if (admission?.binding.domain.mode === "repository" && lifecycleReservations.has(admission.binding.domain.repositoryId)) return true;
    if (workspaceId && [...lifecycleReservations.values()].includes(workspaceId)) return true;
    // A new/unresolved admission cannot yet prove it belongs to an unrelated repo.
    return !admission && !workspaceId && lifecycleReservations.size > 0;
  }
  function assertLifecycleIdle(workspaceId: string, repositoryId: string) {
    const available = availability(undefined, false);
    if (!available.canSend || retainOwner) throw new WorkstreamAdapterError(409, "bridge-busy", available.reason ?? "App execution ownership is unconfirmed");
    if (lifecycleReservations.has(repositoryId)) throw new WorkstreamAdapterError(409, "bridge-busy", "A repository phase action is already in progress");
    const relevant = (sessionId: string, unknownIsBusy = true) => {
      const admission = admissions.get(sessionId), association = catalog.association(sessionId);
      return admission?.binding.workspaceId === workspaceId || admission?.binding.domain.mode === "repository" && admission.binding.domain.repositoryId === repositoryId || association.workspaceId === workspaceId || unknownIsBusy && !admission && !association.workspaceId;
    };
    const busy = new Set([
      ...owners.keys(), ...admitting, ...handoffReservations, ...handoffDispatches.keys(),
      ...meta.runs.filter(run => run.status === "running").map(run => run.sessionId),
      ...workerStore.deliveries().filter(delivery => ["claimed", "acceptance-unknown"].includes(delivery.state)).map(delivery => delivery.parentSessionId),
      ...branches.list().filter(branch => !["completed", "failed"].includes(branch.state)).map(branch => branch.sourceId),
    ]);
    // Workers inherit their parent's repository even before child admission exists.
    if ([...busy].some(sessionId => relevant(sessionId)) || workers.active().some(worker => relevant(worker.parent.sessionId) || relevant(worker.sessionId, false))) throw new WorkstreamAdapterError(409, "bridge-busy", "Repository has active or unconfirmed App execution; wait for runs and workers to finish");
  }
  function releaseOwner(owner: Owner) {
    // A delayed native interrupt must finish before a replacement can acquire
    // this conversation, even if terminal observation arrived first.
    if (!retainOwner && owner.settled && !owner.cancelling && owners.get(owner.run.sessionId) === owner) owners.delete(owner.run.sessionId);
  }
  let closing = false, storageFailed = false;
  const claudeRuns = new ClaudeRunService({
    dataDir: options.dataDir, claudeBin: options.claudeBin, claudeRoot,
    packageRoot: root, hookUrl: () => `http://127.0.0.1:${hookServer.port}`,
  }, {
    session: id => meta.sessions.find(s => s.sessionId === id),
    run: id => meta.runs.find(r => r.runId === id),
    events: id => events.get(id) ?? [],
    owns: owner => owners.get(owner.run.sessionId) === owner,
    closing: () => closing, storageFailed: () => storageFailed, retained: () => retainOwner,
    requireReconciliation: () => { retainOwner = true; meta.reconciliationRequired = true; },
    failClosed, emit, persist, enqueue, execution, compactExecution,
    refreshCompactHistory, assertWorkerDeliverySubmission,
  });
  const handoffs = new HandoffService(admissions, catalog, router, store.sources, () => meta.sessions, () => {
    if (closing || storageFailed || meta.reconciliationRequired) throw new WorkstreamAdapterError(503, "handoff-owner-unavailable", "App execution owner is unavailable");
  }, store.manifest.storeId, async (to, cwd) => {
    const launch = resolveAssistantProfile(agentProfiles, to);
    const descriptor = requireOperation(launch.harness, "prompt");
    const native = launch.harness === "opencode" ? await oc.resolveLaunch(cwd, launch) : undefined;
    const model = native ? native.model ? `${native.model.providerID}/${native.model.id}` : undefined : launch.model;
    const effort = native ? native.model?.variant : launch.effort;
    return {
      harness: descriptor.nativeHarness,
      executionConfig: { profileId: launch.profileId, agent: launch.agent!, ...(model ? { model } : {}), ...(effort ? { effort } : {}) },
    };
  });
  const handoffToken = crypto.randomUUID();
  async function nativeHandoff(req: Request) {
    if (req.method !== "POST" || req.headers.has("origin") || !equal(req.headers.get("authorization") ?? "", `Bearer ${handoffToken}`)) return json({ error: "Native authorization required" }, 401);
    try {
      if (closing || storageFailed || meta.reconciliationRequired) return json({ error: "App execution owner unavailable" }, 503);
      const input = await body(req);
      if (input?.operation === "enqueue") return json({ handoff: projectHandoffEnqueue(await handoffs.enqueue(input.caller, input.input)) }, 202);
      if (input?.operation === "status") { const handoff = await handoffs.status(input.caller, input.requestId); return json({ handoff: handoff ? projectHandoffStatus(handoff) : handoff, ...(handoff && handoffProblems.has(handoff.id) ? { problem: handoffProblems.get(handoff.id) } : {}) }); }
      return json({ error: "Unknown handoff operation" }, 400);
    } catch (error) { return error instanceof DomainError || error instanceof WorkstreamAdapterError ? json({ error: error.message, code: error.code }, error instanceof WorkstreamAdapterError ? error.status : error.code === "INVALID_INPUT" ? 400 : 409) : json({ error: "Handoff admission unavailable" }, 503); }
  }
  async function prepareHandoffRecipient(workspaceId: string, handoffId: string) {
    // Only the createNew path below runs `create`; reply/attach deliveries
    // (already-bound recipients) never reach it, so only handoff-created
    // sessions get auto-titles and existing sessions are never renamed.
    let created = false;
    const handoff = await handoffs.prepareRecipient(workspaceId, handoffId, async h => {
      created = true;
      const sessionId = h.recipient.sessionId, cwd = h.recipient.checkout.path, harness = h.recipient.harness === "oc" ? "opencode" : "claude-code";
      if (closing || storageFailed || admitting.has(sessionId) || owners.has(sessionId)) throw new WorkstreamAdapterError(409, "recipient-unavailable", "Recipient admission unavailable");
      admitting.add(sessionId);
      try {
        let a = admissions.get(sessionId);
        if (!a) {
          const association = await catalog.register(cwd);
          a = await admissions.begin({ sessionId, operation: "create", harness: h.recipient.harness, cwd, nativeId: harness === "opencode" ? null : crypto.randomUUID(), workspaceId: association.workspaceId, worktreeId: association.worktreeId });
        }
        if (a.source.authorityId !== h.recipient.authorityId || a.binding.executionCheckout !== cwd || a.binding.domain.mode !== "repository" || a.binding.domain.repositoryId !== h.repositoryId) throw new WorkstreamAdapterError(409, "recipient-mismatch", "Reserved recipient binding changed");
        if (closing || storageFailed) throw new WorkstreamAdapterError(503, "recipient-unavailable", "App execution owner unavailable");
        // New admissions snapshot destination configuration before queueing. Legacy
        // rows keep their exact reserved agent/profile, not the assignment alias.
        const config = h.recipient.executionConfig;
        const requestedRole = h.input.to.split(":")[0];
        const role = config ? config.agent.replace(harness === "opencode" ? /^sane\/assistant\// : /^sane-assistant-/, "")
          : isStoredAssistantAgentId(requestedRole) ? requestedRole : canonicalSlot(h.input.to).split(":")[0];
        if (!isStoredAssistantAgentId(role) || config && config.agent !== nativeAgentId({ kind: "assistant", role }, harness)) throw new DomainError("CONFLICT", "Reserved handoff assistant identity is invalid; reconcile its original configuration.");
        let launch = a.state === "intent" && harness === "opencode"
          ? config ? { agent: config.agent, ...(config.model ? { model: oc.model(config.model, config.effort) } : {}) }
            : await oc.resolveLaunch(cwd, { agent: nativeAgentId({ kind: "assistant", role }, harness) })
          : undefined;
        if (a.state === "intent") a = await admissions.createNative(sessionId, async () => (await oc.createResolved(cwd, launch!)).id);
        if (!a.nativeId || a.state === "native_creation_unknown") throw new WorkstreamAdapterError(409, "native_creation_unknown", "Reconcile recipient creation before retry");
        if (!meta.sessions.some(s => s.sessionId === sessionId)) {
          if (harness === "opencode" && !launch) launch = await oc.recoverLaunch(a.nativeId, cwd, config?.agent ?? nativeAgentId({ kind: "assistant", role }, harness));
          const sane = harness === "claude-code" || launch ? saneSessionContext({ kind: "assistant", role }) : {};
          if (harness === "opencode" && sane.saneContext) await oc.bindSaneContext(a.nativeId, sane.saneContext.version, saneContextText(sane.saneContext));
          meta.sessions.push({ sessionId, nativeSessionId: a.nativeId, harness, authorityId: a.source.authorityId, cwd, lastStatus: "unknown", lastRunId: null,
            ...(config ? { profileId: config.profileId, ...(harness === "claude-code" ? { ...(config.model ? { model: config.model } : {}), ...(config.effort ? { effort: config.effort } : {}) } : {}) } : {}),
            ...(harness === "claude-code" || launch ? { agent: role, agentKind: "assistant", nativeAgentSelected: true, ...sane } : {}),
            ...(launch?.model ? { model: `${launch.model.providerID}/${launch.model.id}`, ...(launch.model.variant ? { effort: launch.model.variant } : {}) } : {}),
          });
          await persist();
        }
        await catalog.associate(sessionId, cwd, a.binding.workspaceId, a.binding.worktreeId);
        await admissions.register(sessionId);
        if (a.state !== "ready") admissions.ready(sessionId);
      } finally { admitting.delete(sessionId); }
    });
    if (created) {
      // Title the new recipient `<Role> #<n>` (legacy counting, minus the
      // `[workstream]` prefix): n is the 1-based position among this
      // workstream's assignments for the same phase, oldest first, counting
      // ended assignments. Untitled-only: a retried preparation never renames.
      const session = meta.sessions.find(s => s.sessionId === handoff.recipient.sessionId);
      if (session && !session.title && handoff.recipient.ref) {
        const ref = handoff.recipient.ref;
        const status = (await router!.forWorkspace(workspaceId)).domain.getWorkstreamStatus(handoff.workstreamId);
        const assignment = status.activePhases.find(a => equivalentSlots(a.phase, handoff.input.to) && a.ref.harness === ref.harness && a.ref.authorityId === ref.authorityId && a.ref.nativeId === ref.nativeId);
        session.title = handoffRecipientTitle(handoff.input.to, slotSessionIndex([...status.phaseHistory, ...status.activePhases], handoff.input.to, assignment?.id ?? ""));
        // Legacy/recovered recipients may only have this display/lock profile.
        if (!session.profileId && isStoredAssistantAgentId(session.agent)) session.profileId = legacyProfileId(session.harness ?? "claude-code", session.agent);
        await persist();
      }
    }
    return handoff;
  }
  function availability(sessionId?: string, capacity = true, delivery = false, preparation = false): { canSend: boolean; reason?: string; code?: string } {
    if (sessionId && lifecycleReserved(sessionId)) return { canSend: false, reason: "A repository phase action is in progress", code: "workstream-action-pending" };
    if (sessionId && branches.list().some(op => op.state !== "failed" && (op.state !== "completed" || op.replace) && workers.tree(op.sourceId).some(w => w.sessionId === sessionId))) return { canSend: false, reason: "Ancestor conversation has a pending branch or was replaced", code: "branch-parent" };
    if (sessionId && branches.replaced(sessionId)) return { canSend: false, reason: "Replaced conversation · read-only. Open its replacement to continue.", code: "replaced" };
    if (sessionId && branches.pending(sessionId)) {
      const pending = branches.pending(sessionId)!;
      return { canSend: false, reason: pending.state === "creation_unknown" && !pending.nativeId
        ? "The branch destination could not be confirmed. Sending is paused until its native history can be checked."
        : pending.error ? "The branch could not be finished. Sending is paused to protect the conversation; restart the App to recheck it."
        : "Finishing branch… Sending will be available when it is ready.", code: "branch-pending" };
    }
    if (storageFailed) return { canSend: false, reason: "Storage unavailable; operator reconciliation required" };
    if (meta.reconciliationRequired) return { canSend: false, reason: "Operator reconciliation required: restart with --reconcile-interrupted after verifying previous CLI processes are stopped" };
    if (closing) return { canSend: false, reason: "Bridge is shutting down" };
    if (sessionId && workerStore.deliveries().some(d => d.parentSessionId === sessionId && ["claimed", "acceptance-unknown"].includes(d.state))) return { canSend: false, reason: "Worker report continuation is reserved or acceptance is unconfirmed; inspect worker delivery evidence", code: "worker-delivery-pending" };
    if (sessionId && !delivery && (handoffReservations.has(sessionId) || handoffDispatches.has(sessionId))) return { canSend: false, reason: "Recipient has an active or uncertain handoff", code: "handoff-pending" };
    const admission = sessionId ? admissions.get(sessionId) : undefined;
    if (admission && admission.state !== "ready" && !(preparation && admission.state === "identity_known" && admission.nativeId)) return { canSend: false, reason: "Admission pending; explicit known-identity retry is required", code: "admission-pending" };
    if (sessionId && meta.sessions.find(s => s.sessionId === sessionId)?.attachment?.state === "pending") return { canSend: false, reason: "Attachment incomplete. Retry Attach with the same harness, native ID and execution directory; no run is permitted.", code: "attachment-pending" };
    if (sessionId && (owners.has(sessionId) || admitting.has(sessionId))) return { canSend: false, reason: "This conversation already has an active run or reconciliation", code: "conversation-busy" };
    const occupied = new Set([...owners.keys(), ...admitting, ...handoffDispatches.keys(), ...workerStore.list().filter(w => !w.outcome).map(w => w.sessionId), ...workerStore.deliveries().filter(d => ["claimed", "acceptance-unknown"].includes(d.state)).map(d => d.parentSessionId)]);
    if (capacity && !(delivery && sessionId && handoffDispatches.has(sessionId)) && occupied.size >= maxConcurrentRuns) return { canSend: false, reason: `Bridge capacity reached (${maxConcurrentRuns} concurrent runs/requests); retry when a slot is free`, code: "capacity" };
    return { canSend: true };
  }
  let serial = Promise.resolve();
  function persist() {
    // Capture at enqueue time. A later concurrent admission must not leak into
    // an earlier metadata write before its first log record reaches the queue.
    const snapshot = JSON.stringify(meta);
    return enqueue(async () => { await writeFile(`${metadataPath}.tmp`, snapshot, { mode: 0o600 }); await rename(`${metadataPath}.tmp`, metadataPath); });
  }
  // Validate a candidate profile set, then publish and persist it through the store queue.
  function commitAgents(next: AgentProfiles) {
    next.profiles.sort((a, b) => a.order - b.order);
    agentProfiles = validateAgentProfiles(next);
    const snapshot = structuredClone(next);
    return enqueue(async () => atomicAppRecord(options.dataDir, "agents.json", snapshot));
  }
  const profileInputKeys = ["label", "description", "harness", "model", "effort", "icon", "color", "hidden", "workerProfiles"];
  function applyProfileInput(profile: AgentProfile, input: Record<string, unknown>): AgentProfile {
    const bad = Object.keys(input).find(k => !profileInputKeys.includes(k));
    if (bad) throw new AppStoreError("APP_STORE_CORRUPT", `Unknown agent profile field: ${bad}`);
    const next = { ...profile, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)), updatedAt: new Date().toISOString() } as AgentProfile;
    if (typeof next.label === "string") next.label = next.label.trim();
    if (next.hidden === false) delete next.hidden;
    return next;
  }
  const sessionProfileId = (s: Session) => s.profileId ?? legacyProfileId(s.harness ?? "claude-code", s.agent);
  function failClosed() {
    storageFailed = true; retainOwner = true; meta.reconciliationRequired = true;
    // Ownership records are the durable sentinel even if every later disk
    // write fails. Reopening requires process exit and explicit reconciliation.
    for (const owner of owners.values()) if (owner.child) void terminate(owner);
  }
  function enqueue(fn: () => Promise<void>) {
    const next = serial.then(async () => { if (storageFailed) throw new Error("Storage unavailable; operator reconciliation required"); await fn(); });
    serial = next.catch(() => { failClosed(); });
    return next;
  }
  function groupAlive(owner: Owner): boolean {
    return claudeRuns.groupAlive(owner);
  }
  function terminate(owner: Owner): Promise<boolean> {
    return claudeRuns.terminate(owner);
  }
  function emit(run: Run, kind: Event["kind"], data: unknown) {
    const list = events.get(run.runId)!;
    const event: Event = { seq: (list.at(-1)?.seq ?? 0) + 1, time: new Date().toISOString(), runId: run.runId, sessionId: run.sessionId, kind, data };
    list.push(event);
    transcripts.ingest(run, [event]);
    return enqueue(() => appendFile(join(options.dataDir, `${run.runId}.jsonl`), JSON.stringify(event) + "\n", { mode: 0o600 }));
  }
  // Display title for list responses: stored title wins (handoff `<Role> #<n>`
  // or a previously persisted first prompt). Otherwise derive from the
  // earliest submission event so a refresh shows names without opening each
  // conversation. Never persists here; POST persists for new prompts.
  const titleFromPrompt = (prompt: unknown): string | undefined => {
    if (typeof prompt !== "string") return undefined;
    const line = prompt.split("\n")[0]!.trim().slice(0, 200);
    return line ? line : undefined;
  };
  const displayTitle = (session: Session): string | undefined => {
    if (session.title) return session.title;
    const runs = meta.runs.filter(r => r.sessionId === session.sessionId && r.operation !== "compact").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const run of runs) {
      for (const event of events.get(run.runId) ?? []) {
        if (event.kind !== "submission") continue;
        const title = titleFromPrompt((event.data as { text?: unknown })?.text);
        if (title) return title;
      }
    }
    return undefined;
  };
  for (const run of meta.runs) {
    const logPath = join(options.dataDir, `${run.runId}.jsonl`);
    let raw: string;
    try { raw = await readFile(logPath, "utf8"); } catch (e: any) { throw new Error(`Cannot load historical event log for ${run.runId}: ${e.code === "ENOENT" ? "missing file" : "read failed"}`); }
    const decoded = decodeLog(raw, run); const list = decoded.events;
    if (decoded.repaired !== undefined) await enqueue(() => writeFile(logPath, decoded.repaired!, { mode: 0o600 }));
    events.set(run.runId, list);
    transcripts.ingest(run, list);
    if (run.status === "running" && !getHarnessDescriptor(sessionHarness(meta.sessions.find(s => s.sessionId === run.sessionId)!))!.operations.recoverRun.supported) {
      run.status = "interrupted"; run.endedAt = new Date().toISOString(); meta.reconciliationRequired = true;
      const session = meta.sessions.find(s => s.sessionId === run.sessionId)!; session.lastStatus = "interrupted";
      await emit(run, "status", { status: "interrupted", reason: "server restarted; verify old CLI process has stopped" });
    }
    if (options.reconcileInterrupted && meta.sessions.find(s => s.sessionId === run.sessionId)?.harness === "claude-code") {
      const uncertainty = workerTerminationUncertainty(events.get(run.runId) ?? []);
      if (uncertainty) await emit(run, "status", { status: run.status, reason: "Operator confirmed previous CLI termination with --reconcile-interrupted", reconciliation: { kind: "termination-confirmed", throughSeq: uncertainty.seq } });
    }
  }
  if (options.reconcileInterrupted) meta.reconciliationRequired = false;
  await persist();
  let origin = "";
  const auth = new BridgeAuth(authOptions, {
    getOrigin: () => origin, revokeTerminal: token => terminals.revoke(token),
  });
  const terminals = new TerminalService(catalog, token => auth.validTerminalToken(token));
  const branchContext = (id: string) => ({ actor: { kind: "system" as const }, correlationId: id });
  const branchFingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  async function branchDomain(source: Session, enroll = false) {
    const admission = admissions.get(source.sessionId);
    if (!admission || admission.state !== "ready") throw new Error("Source admission is not ready");
    if (source.nativeSessionId !== admission.nativeId || source.authorityId !== admission.source.authorityId || source.harness !== (admission.source.descriptor.harness === "cc" ? "claude-code" : "opencode") || source.cwd !== admission.binding.executionCheckout) throw new Error("Source identity or execution checkout differs from its admission");
    await router!.execution(admission);
    if (admission.binding.domain.mode === "app-only" && (await catalog.get(admission.binding.workspaceId)).kind === "repository") {
      const inspected = await router!.inspect(admission.binding.workspaceId);
      if (inspected.state !== "ready" && inspected.state !== "uninitialized") throw new WorkstreamAdapterError(409, inspected.code, inspected.message);
      if (inspected.state === "ready") {
        const adapter = await router!.forWorkspace(admission.binding.workspaceId, inspected.context.repositoryId);
        if (!admission.binding.checkoutPin) throw new Error("Source repository checkout pin is missing");
        revalidateCheckout(adapter.domain.context, admission.binding.checkoutPin);
        // Native enrollment can precede App admission promotion. Read the qualified
        // registration so eligibility cannot overlook an existing phase assignment.
        if (adapter.conversation(source)) adapter.invocation(source);
        if (enroll) {
          await admissions.enroll(source.sessionId);
          const promoted = await router!.forAdmission(admissions.get(source.sessionId)!);
          if (!promoted || promoted.repositoryId !== adapter.repositoryId || promoted.domain.primaryCheckout !== adapter.domain.primaryCheckout) throw new Error("Source repository changed during branch enrollment");
          revalidateCheckout(promoted.domain.context, admission.binding.checkoutPin);
          await admissions.register(source.sessionId);
          admissions.ready(source.sessionId);
          return router!.forAdmission(admissions.get(source.sessionId)!);
        }
        return adapter;
      }
    }
    return router!.forAdmission(admission);
  }
  function assertBranchIdle(source: Session) {
    const descriptor = requireOperation(sessionHarness(source), "branch");
    if (closing || storageFailed || meta.reconciliationRequired || owners.has(source.sessionId) || admitting.has(source.sessionId) || handoffReservations.has(source.sessionId) || handoffDispatches.has(source.sessionId)) throw new Error("Source must be idle, with no pending admission or handoff");
    if (source.agentKind === "worker" || workerStore.hasSession(source.sessionId)) throw new Error("Worker conversations cannot be branched");
    if (workers.tree(source.sessionId).some(w => !w.outcome || w.continuation && !["completed", "failed", "interrupted"].includes(w.continuation.state) || workerResults(w).some(r => ["pending", "claimed", "acceptance-unknown"].includes(r.notification.state))) || workerStore.deliveries().some(d => d.parentSessionId === source.sessionId && ["claimed", "acceptance-unknown"].includes(d.state))) throw new Error("Finish outstanding workers and worker report deliveries before branching");
    if (branches.replaced(source.sessionId)) throw new Error("Replaced conversations are read-only");
    if (!descriptor.policies.branchAttachedConversation && source.attachment) throw new Error("This imported conversation lacks trustworthy complete-turn and idle evidence; branching is unavailable");
  }
  async function branchBoundary(source: Session, runId?: string, messageId?: string) {
    const descriptor = requireOperation(sessionHarness(source), "branch");
    if (messageId !== undefined && !descriptor.policies.branchFromNativeMessage) throw new Error("Branching on this harness requires a SANE-recorded completed run");
    const run = runId ? meta.runs.find(r => r.runId === runId && r.sessionId === source.sessionId && r.status === "completed" && r.operation !== "compact") : undefined;
    if (runId && !run) throw new Error("Select a completed turn from this conversation");
    requireOperation(descriptor.id, "readHistory");
    return dispatchHarness(descriptor.id, {
      opencode: async () => {
        const history = await oc.history(source.nativeSessionId!, source.cwd);
        if (history.activity !== "idle") throw new Error("Native OpenCode conversation is active or has pending input");
        const raw = history.rawMessages;
        const start = raw.findIndex(m => m.id === (run?.nativeCommandId ?? messageId));
        if (start < 0) throw new Error("Selected native turn is unavailable");
        if (!run && raw[start]!.type !== "assistant") throw new Error("Select the final assistant response of a complete turn");
        let boundary = -1;
        for (let i = start + 1; i < raw.length; i++) {
          const m = raw[i]!;
          if (m.type === "user" || m.type === "synthetic") break;
          if (!run && m.type === "assistant") throw new Error("This response is a tool fragment, not the complete turn boundary");
          if (m.type === "idle") { if (m.outcome === "succeeded") boundary = i; break; }
        }
        if (boundary < 0) throw new Error("No successful native complete-turn boundary was found");
        return { boundary: raw[boundary]!.id, before: raw[boundary + 1]?.id, sourceFingerprint: branchFingerprint(raw) };
      },
      "claude-code": async () => {
        if (!run) throw new Error("Branching on this harness requires a SANE-recorded completed run");
        const assistant = (id: string) => (events.get(id) ?? []).filter(e => e.kind === "stdout" && (e.data as any)?.type === "assistant" && !(e.data as any)?.parent_tool_use_id).at(-1)?.data as any;
        const selected = assistant(run.runId), latest = source.lastRunId && assistant(source.lastRunId);
        if (source.lastStatus !== "completed" || !uuid(selected?.uuid) || !uuid(latest?.uuid) || selected.message?.content?.some((p: any) => p.type === "tool_use")) throw new Error("Complete-turn/idle evidence is unavailable for this harness");
        const native = await readClaudeHistory(source.nativeSessionId!, source.cwd, claudeRoot);
        if (native.at(-1)?.messageId !== latest.uuid || !native.some(m => m.messageId === selected.uuid)) throw new Error("Native history differs from SANE's completed run evidence; external activity must be reconciled");
        return { boundary: selected.uuid as string, before: undefined, sourceFingerprint: branchFingerprint(native) };
      },
    });
  }
  async function enrollBranch(op: BranchOperation, source: Session) {
    if (!op.nativeId) throw new Error("Native destination identity is unknown; no creation retry is permitted");
    if (meta.sessions.some(s => s.sessionId !== op.destinationId && s.authorityId === source.authorityId && s.nativeSessionId === op.nativeId)) throw new Error("Native fork identity is already associated with another App conversation");
    const original = admissions.get(source.sessionId)!;
    if (!admissions.get(op.destinationId)) await admissions.begin({ sessionId: op.destinationId, operation: "create", harness: source.harness === "opencode" ? "oc" : "cc", cwd: source.cwd, nativeId: op.nativeId, workspaceId: original.binding.workspaceId, worktreeId: original.binding.worktreeId, parent: original.binding.domain.mode === "repository" ? { harness: original.source.descriptor.harness, authorityId: original.source.authorityId, nativeId: source.nativeSessionId! } : null });
    const admission = admissions.get(op.destinationId)!;
    if (admission.nativeId !== op.nativeId || !["identity_known", "ready"].includes(admission.state)) throw new Error("Destination admission differs from the confirmed branch identity");
    const sourceDomain = original.binding.domain, destinationDomain = admission.binding.domain;
    if (sourceDomain.mode !== destinationDomain.mode || sourceDomain.mode === "repository" && (destinationDomain.mode !== "repository" || sourceDomain.repositoryId !== destinationDomain.repositoryId || sourceDomain.primaryCheckout !== destinationDomain.primaryCheckout) || admission.source.authorityId !== original.source.authorityId || admission.source.descriptor.harness !== original.source.descriptor.harness || admission.binding.executionCheckout !== original.binding.executionCheckout || admission.binding.workspaceId !== original.binding.workspaceId || admission.binding.worktreeId !== original.binding.worktreeId) throw new Error("Branch source and destination admission domains or execution bindings differ");
    let destination = meta.sessions.find(s => s.sessionId === op.destinationId);
    if (!destination) {
      // Forks inherit the source's bound metadata; rebind it to the fork's own native ID.
      if (source.harness === "opencode" && source.saneContext) await oc.bindSaneContext(op.nativeId, source.saneContext.version, saneContextText(source.saneContext));
      destination = { ...source, sessionId: op.destinationId, nativeSessionId: op.nativeId, lastStatus: "unknown", lastRunId: null, title: `${(displayTitle(source) ?? "Conversation").slice(0, 185)} · Branch` };
      delete destination.attachment; delete destination.hidden;
      meta.sessions.push(destination);
    }
    await catalog.associate(destination.sessionId, source.cwd, original.binding.workspaceId, original.binding.worktreeId);
    await persist(); await admissions.register(destination.sessionId);
    if (admissions.get(destination.sessionId)!.state !== "ready") admissions.ready(destination.sessionId);
    return destination;
  }
  const branchFinishing = new Map<string, Promise<void>>();
  async function reconcileBranch(op: BranchOperation) {
    if (["completed", "failed"].includes(op.state)) return;
    if (op.state !== "reserved" && !op.nativeId) return;
    if (closing || storageFailed || meta.reconciliationRequired || owners.has(op.sourceId) || owners.has(op.destinationId) || admitting.has(op.sourceId) || admitting.has(op.destinationId)) return;
    const source = meta.sessions.find(s => s.sessionId === op.sourceId);
    if (!source || handoffReservations.has(op.destinationId) || handoffDispatches.has(op.destinationId)) return;
    try { assertBranchIdle(source); } catch { return; }
    admitting.add(op.sourceId); admitting.add(op.destinationId);
    const done = Promise.withResolvers<void>(); attachmentTasks.add(done.promise);
    try {
      // Only release an unstarted reservation or finish an already identified fork.
      // Never replay native creation or the saved initial prompt.
      if (op.state === "reserved") await releaseBranch(op, "Interrupted before native creation. Original unchanged.");
      else await finishBranch(op.id);
    } catch (error) {
      branches.save({ ...branches.get(op.id)!, error: error instanceof Error ? error.message : "Branch could not be finished" });
    } finally {
      admitting.delete(op.sourceId); admitting.delete(op.destinationId);
      done.resolve(); attachmentTasks.delete(done.promise);
    }
  }
  async function releaseBranch(op: BranchOperation, error: string) {
    const source = meta.sessions.find(s => s.sessionId === op.sourceId)!, adapter = await branchDomain(source);
    adapter?.domain.finishBranch(adapter.reference(source), null, op.id, branchContext(op.id));
    const destination = meta.sessions.find(s => s.sessionId === op.destinationId);
    if (destination) { if (adapter) adapter.domain.associateConversation(adapter.reference(destination), null, branchContext(op.id)); destination.hidden = true; await persist(); }
    branches.save({ ...op, state: "failed", error });
  }
  async function finishBranch(opId: string) {
    const inFlight = branchFinishing.get(opId); if (inFlight) return inFlight;
    const task = (async () => {
      let op = branches.get(opId)!;
      if (op.state === "completed") return;
      const source = meta.sessions.find(s => s.sessionId === op.sourceId)!;
      if (!op.nativeId) throw new Error("Fork creation is uncertain. Destination is unknown; creation will not be retried. Original memberships are unchanged.");
      const adapter = await branchDomain(source);
      if (!adapter?.domain.branchCompleted(adapter.reference(source), op.id)) {
        const sourceHistory = await dispatchHarness(sessionHarness(source), { opencode: () => oc.history(source.nativeSessionId!, source.cwd), "claude-code": async () => ({ messages: await readClaudeHistory(source.nativeSessionId!, source.cwd, claudeRoot) }) });
        if ("activity" in sourceHistory && sourceHistory.activity !== "idle" || branchFingerprint("rawMessages" in sourceHistory ? sourceHistory.rawMessages : sourceHistory.messages) !== op.sourceFingerprint) throw new Error("Source native history changed or became active during branching. Transfer is blocked; the confirmed native destination is retained for inspection.");
      }
      if (source.harness === "claude-code") await verifyClaudeFork(op.nativeId, source.cwd, source.nativeSessionId!, op.boundary, claudeRoot);
      const native = await readNativeHistory(sessionHarness(source), op.nativeId, source.cwd);
      if (source.harness === "opencode" && native.activity !== "idle") throw new Error("The branch destination is active or has pending input. Wait for it to finish before restarting the App.");
      if (closing || storageFailed) throw new Error("Branch completion paused while the App shuts down");
      op = { ...op, state: "confirmed", error: undefined }; branches.save(op);
      const destination = await enrollBranch(op, source);
      const history: ReconciledHistory = { sessionId: destination.sessionId, nativeSessionId: destination.nativeSessionId!, importedAt: new Date().toISOString(), messages: native.messages, activity: native.activity, coveredRunIds: [], reason: "Genuine native branch history. Branching did not rewind or restore files." };
      // Prepare the durable snapshot before committing the membership transfer.
      // A previously committed domain transfer is still idempotently recoverable.
      saveNativeHistory(history);
      if (adapter) adapter.domain.finishBranch(adapter.reference(source), adapter.reference(destination), op.id, branchContext(op.id));
      if (op.replace) source.hidden = true;
      await persist(); branches.save({ ...op, state: "completed", error: undefined });
    })();
    branchFinishing.set(opId, task);
    try { await task; } finally { branchFinishing.delete(opId); }
  }
  function compactBlocked(session: Session): string | undefined {
    const descriptor = getHarnessDescriptor(session.harness);
    if (!descriptor) return "Compaction requires a known native harness";
    if (!descriptor.operations.compact.supported) return descriptor.operations.compact.reason;
    if (session.agentKind === "worker" || workerStore.hasSession(session.sessionId)) return "Worker conversations cannot be compacted manually";
    if (workers.tree(session.sessionId).some(w => !w.outcome || w.continuation && !["completed", "failed", "interrupted"].includes(w.continuation.state) || workerResults(w).some(r => ["pending", "claimed", "acceptance-unknown"].includes(r.notification.state))) || workerStore.deliveries().some(d => d.parentSessionId === session.sessionId && ["claimed", "acceptance-unknown"].includes(d.state))) return "Finish outstanding workers and worker report deliveries before compacting";
    if (!session.nativeSessionId || !session.harness) return "Compaction requires an existing native conversation";
    if (session.harness === "claude-code" && !session.lastRunId && !session.attachment && !branches.list().some(op => op.destinationId === session.sessionId && op.state === "completed")) return "Start the native conversation before compacting";
    return undefined;
  }
  async function compactExecution(session: Session) {
    const descriptor = requireOperation(session.harness, "compact");
    const a = admissions.get(session.sessionId);
    if (!a || a.state !== "ready" || a.nativeId !== session.nativeSessionId || a.source.authorityId !== session.authorityId || session.authorityId !== nativeSource(session.harness) || a.source.descriptor.harness !== descriptor.nativeHarness || a.binding.executionCheckout !== session.cwd) throw new WorkstreamAdapterError(409, "compact-identity", "Native identity, authority or execution pin differs from the admitted conversation");
    const cwd = await execution(session.sessionId);
    if (cwd !== session.cwd) throw new WorkstreamAdapterError(409, "compact-identity", "Compaction cannot change the execution checkout");
    return cwd;
  }
  async function compactEligibility(session: Session): Promise<CompactEligibility> {
    const policies = getHarnessDescriptor(session.harness)?.policies;
    const eligibility: CompactEligibility = { eligible: false, supportsInstructions: policies?.compactionInstructions ?? false, nativeActivity: owners.has(session.sessionId) ? "active" : "unknown", ...(policies?.attachedSendRequiresNativeStopped && session.attachment ? { requiresNativeStopped: true } : {}) };
    const available = availability(session.sessionId), blocked = compactBlocked(session);
    if (!available.canSend || blocked) return { ...eligibility, reason: available.reason ?? blocked };
    try {
      await compactExecution(session);
      if (session.harness === "opencode") {
        const state = await oc.activity(session.nativeSessionId!, session.cwd);
        eligibility.nativeActivity = state.active || state.pending ? "active" : "idle";
        if (eligibility.nativeActivity === "active") return { ...eligibility, reason: "Native conversation is active or has pending input" };
      }
      const current = availability(session.sessionId), reason = compactBlocked(session);
      return current.canSend && !reason ? { ...eligibility, eligible: true } : { ...eligibility, reason: current.reason ?? reason };
    } catch (error) { return { ...eligibility, reason: error instanceof Error ? error.message : "Compaction eligibility is unavailable" }; }
  }
  async function storedNativeHistory(session: Session): Promise<ReconciledHistory | undefined> {
    return nativeHistories.get(session);
  }
  async function compactOperations(session: Session) {
    const history = await storedNativeHistory(session);
    const logs = meta.runs.filter(r => r.sessionId === session.sessionId).flatMap(r => events.get(r.runId) ?? []);
    // A cached pre-compaction snapshot must not regress newer live evidence if
    // the optional history refresh fails. A newer explicit reconciliation can
    // still improve an older live snapshot; importedAt is App observation time.
    const observedAt = new Map<string, string>();
    for (const event of logs) if (event.kind === "message" && (event.data as any)?.compaction) {
      const id = (event.data as any).messageId as string;
      if (!observedAt.has(id) || event.time > observedAt.get(id)!) observedAt.set(id, event.time);
    }
    const importedAt = history?.importedAt ?? "";
    const messages = history?.messages.filter(message => !message.compaction || !observedAt.has(message.messageId) || importedAt > observedAt.get(message.messageId)!);
    return { operations: projectCompactions(session, meta.runs, logs, messages), ...(history ? { nativeHistoryImportedAt: history.importedAt } : {}) };
  }
  async function refreshCompactHistory(owner: Owner) {
    const run = owner.run, session = meta.sessions.find(s => s.sessionId === run.sessionId)!;
    try {
      if (owners.get(session.sessionId) !== owner || closing || storageFailed) return;
      await compactExecution(session);
      const native = await readNativeHistory(sessionHarness(session), session.nativeSessionId!, session.cwd);
      if (closing || storageFailed) return;
      if (session.harness === "opencode" && native.activity !== "idle") throw new Error("Native history became active; previous snapshot preserved");
      // Only newly timed main-thread CC boundaries can belong to this run. Old
      // imported boundaries remain history, never confirmation of a new request.
      if (session.harness === "claude-code") for (const message of native.messages) {
        if (message.compaction && message.createdAt && Date.parse(message.createdAt) >= Date.parse(run.createdAt) && (!run.endedAt || Date.parse(message.createdAt) <= Date.parse(run.endedAt))) await emit(run, "message", message);
      }
      const history: ReconciledHistory = { sessionId: session.sessionId, nativeSessionId: session.nativeSessionId!, importedAt: new Date().toISOString(), messages: native.messages, activity: native.activity, coveredRunIds: coveredNativeRuns(session, meta.runs, native.messages), reason: "Read-only history refresh after the owned compaction process settled; native compaction evidence is separate from process outcome" };
      await enqueue(async () => saveNativeHistory(history));
      await emit(run, "status", { status: run.status, nativeHistoryImportedAt: history.importedAt });
    } catch (error) {
      if (storageFailed) return;
      await emit(run, "status", { status: run.status, historyRefreshFailed: true, reason: error instanceof Error ? error.message : "Read-only history refresh failed; previous snapshot and confirmed compaction evidence preserved" });
    }
  }
  const compactAdmissions = new Map<string, { instructions?: string; promise: Promise<CompactResponse> }>();
  async function admitCompact(session: Session, input: CompactRequest): Promise<CompactResponse> {
    const descriptor = requireOperation(session.harness, "compact");
    const available = availability(session.sessionId), blocked = compactBlocked(session);
    if (!available.canSend || blocked) throw new WorkstreamAdapterError(available.code === "capacity" ? 429 : 409, available.code ?? "compact-unavailable", available.reason ?? blocked!);
    if (!descriptor.policies.compactionInstructions && input.instructions !== undefined) throw new WorkstreamAdapterError(400, "compact-instructions", "OpenCode compaction does not support custom instructions");
    if (descriptor.policies.attachedSendRequiresNativeStopped && session.attachment && input.nativeStopped !== true) throw new WorkstreamAdapterError(409, "native-acknowledgement-required", "Explicitly acknowledge external Claude execution is stopped before each new compaction request");
    // Acquire App arbitration before any awaited preflight. Other prompt,
    // handoff, branch and worker-report admissions use the same reservation.
    admitting.add(session.sessionId);
    try {
      const cwd = await compactExecution(session);
      if (session.harness === "opencode") await oc.assertIdle(session.nativeSessionId!, cwd);
      // Recheck synchronously without counting our own preflight reservation.
      admitting.delete(session.sessionId);
      const current = availability(session.sessionId, false), reason = compactBlocked(session);
      admitting.add(session.sessionId);
      if (!current.canSend || reason) throw new WorkstreamAdapterError(409, current.code ?? "compact-unavailable", current.reason ?? reason!);
      const run: Run = { runId: crypto.randomUUID(), sessionId: session.sessionId, cwd, status: "running", createdAt: new Date().toISOString(), operation: "compact", compact: { requestId: input.requestId, ...(input.instructions !== undefined ? { instructions: input.instructions } : {}) }, model: session.model, effort: session.effort, agent: session.agent, agentKind: session.agentKind, nativeAgentSelected: session.nativeAgentSelected, profileId: session.profileId, ...saneContextSnapshot(session) };
      if (session.harness === "opencode") {
        run.nativeCommandId = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
        run.nativePhase = "preparing"; run.compact!.nativeRequestId = run.nativeCommandId;
      }
      const finished = Promise.withResolvers<void>();
      const owner: Owner = { run, native: session.harness === "opencode", nativeDispatched: false, done: finished.promise, settled: false };
      owners.set(session.sessionId, owner); session.lastRunId = run.runId; session.lastStatus = "running"; meta.runs.push(run); events.set(run.runId, []);
      // Stable App and native request IDs reach disk before any native mutation.
      try {
        await emit(run, "status", { status: "running", operation: "compact", compactionLifecycle: "requested" });
        await persist();
      } catch (error) { owner.settled = true; finished.resolve(); throw error; }
      void executeCompact(owner, input.instructions).catch(async () => { failClosed(); await terminate(owner); }).finally(() => { owner.settled = true; releaseOwner(owner); finished.resolve(); });
      return { sessionId: session.sessionId, runId: run.runId, operation: projectCompactions(session, [run], events.get(run.runId) ?? [])[0]! };
    } finally { admitting.delete(session.sessionId); }
  }
  function ownedSession(owner: Owner) {
    const session = meta.sessions.find(s => s.sessionId === owner.run.sessionId);
    if (!session) throw new HarnessOperationError("Run owner conversation is unavailable", 409, "owner-harness-mismatch");
    return { sessionId: session.sessionId, harness: sessionHarness(session) };
  }
  async function executePrompt(owner: Owner, prompt: string, resume: boolean, ready: (accepted: boolean) => void) {
    return dispatchOwnedOperation(ownedSession(owner), owner, "prompt", {
      "claude-code": () => claudeRuns.execute(owner, prompt, resume, ready),
      opencode: () => ocRuns.executeNative(owner, prompt, resume, ready),
    });
  }
  async function executeCompact(owner: Owner, instructions?: string) {
    return dispatchOwnedOperation(ownedSession(owner), owner, "compact", {
      "claude-code": () => claudeRuns.execute(owner, `/compact${instructions ? ` ${instructions}` : ""}`, true, () => {}),
      opencode: () => ocRuns.executeNativeCompact(owner),
    });
  }
  const ocRuns = new OpenCodeRunService({
    oc, closing: () => closing, storageFailed: () => storageFailed,
    currentOwner: sessionId => owners.get(sessionId),
    session: sessionId => meta.sessions.find(s => s.sessionId === sessionId)!,
    events: runId => events.get(runId) ?? [], emit, persist, execution,
    compactExecution, refreshCompactHistory, assertWorkerDeliverySubmission,
    workerHasRun: runId => workerStore.hasRun(runId), sleep: ms => Bun.sleep(ms),
  });
  const resolveTrustedWorkerInvocation: NativeWorkerCallerResolver = async (request, context) => {
    const reject = (): never => { throw new NativeWorkerRequestError(409, "worker-identity", "Worker invocation is not evidenced in its App-owned run. Ensure this conversation is repository-enrolled and retry only the same native tool invocation after its tool evidence is persisted."); };
    context.assertActive();
    const e = request.caller, source = normalizeNativeSource(e.source);
    if (source.authorityId !== e.authorityId) reject();
    const candidates = admissions.list().filter(a => a.state === "ready" && a.source.authorityId === source.authorityId && a.source.descriptor.harness === e.source.harness && a.nativeId === e.nativeId && a.binding.domain.mode === "repository" && a.binding.domain.primaryCheckout === e.repository && meta.sessions.some(s => s.sessionId === a.sessionId && !s.attachment));
    if (candidates.length !== 1) return reject();
    const admission = candidates[0]!;
    const session = meta.sessions.find(s => s.sessionId === admission.sessionId)!;
    if (branches.pending(session.sessionId) || branches.replaced(session.sessionId)) return reject();
    const owner = owners.get(session.sessionId);
    const old = request.operation === "start" ? workerStore.getByRequest(session.sessionId, request.input.requestId) : undefined;
    // A durable reservation is the original binding, even after parent completion.
    if (old && request.operation === "start") {
      if (old.parent.native.harness !== e.source.harness || old.parent.native.authorityId !== e.authorityId || old.parent.native.nativeId !== e.nativeId || old.parent.toolCallId !== request.invocation.toolCallId || old.input.worker !== request.input.worker || old.input.prompt !== request.input.prompt || old.input.context !== request.input.context || JSON.stringify(old.input.jobs) !== JSON.stringify(request.input.jobs)) return reject();
      if (JSON.stringify(old.parent.invocation?.opencode) !== JSON.stringify(request.invocation.opencode)) return reject();
      return { sessionId: session.sessionId, caller: { envelope: e, runId: old.parent.runId, toolCallId: old.parent.toolCallId, invocation: old.parent.invocation } };
    }
    const current = () => {
      context.assertActive();
      if (!owner || owners.get(session.sessionId) !== owner || owner.settled || owner.stopRequested || owner.cancelling || owner.run.status !== "running" || owner.run.operation === "compact" || closing || storageFailed) reject();
    };
    current();
    const run = owner!.run;
    const name = `sane_worker_${request.operation}`;
    const matchesName = (value: unknown) => value === name || e.source.harness === "cc" && value === `mcp__sane__${name}`;
    await execution(session.sessionId);
    (await router!.forAdmission(admission))!.domain.resolveContext({ harness: e.source.harness, authorityId: e.authorityId, nativeId: e.nativeId });
    current();
    let evidenced = false;
    for (let attempt = 0; attempt < 3 && !evidenced; attempt++) {
      current();
      if (e.source.harness === "cc") {
        evidenced = (events.get(run.runId) ?? []).some(event => {
          const data = event.data as any;
          if (event.kind === "hook") return data?.event === "PreToolUse" && data.payload?.session_id === e.nativeId && data.payload?.tool_use_id === request.invocation.toolCallId && matchesName(data.payload?.tool_name);
          return event.kind === "stdout" && data?.type === "assistant" && !data.parent_tool_use_id && data.session_id === e.nativeId && Array.isArray(data.message?.content) && data.message.content.some((part: any) => part.type === "tool_use" && part.id === request.invocation.toolCallId && matchesName(part.name));
        });
      } else {
        if (!run.nativeCommandId) return reject();
        // Read actual persisted part IDs; callback callID is never converted.
        const snapshot = await oc.snapshot(e.nativeId, run.nativeCommandId, session.cwd);
        current();
        evidenced = snapshot.messages.some(message => message.type === "assistant" && message.content?.some(part => matchesOpenCodeWorkerPart(request.operation, request.invocation, message.id, part)));
      }
      if (!evidenced && attempt < 2) await Bun.sleep(150);
    }
    current();
    if (!evidenced) return reject();
    return { sessionId: session.sessionId, caller: { envelope: e, runId: run.runId, toolCallId: request.invocation.toolCallId, invocation: request.invocation } };
  };
  const workerHandler = createNativeWorkerHandler({
    resolveCaller: resolveTrustedWorkerInvocation,
    operations: {
      start: (caller, input, context) => workers.start(caller, input, () => context.assertActive()),
      status: (caller, ids, context) => { context.assertActive(); return workers.status(caller, ids); },
      acknowledge: (caller, refs, context) => { context.assertActive(); return workers.acknowledgeWait(caller, refs); },
      cancel: (caller, ids, descendants, context) => { context.assertActive(); return workers.cancel(caller, ids, descendants); },
      cancelAll: (caller, scope, context) => { context.assertActive(); return workers.cancelAll(caller, scope); },
    },
  });
  async function nativeWorker(req: Request) {
    if (req.method !== "POST" || req.headers.has("origin") || !equal(req.headers.get("authorization") ?? "", `Bearer ${handoffToken}`)) return json({ error: "Native authorization required" }, 401);
    return workerHandler(req);
  }
  function assertWorkerDeliverySubmission(owner: Owner) {
    if (!owner.workerDeliveryId) return;
    const session = meta.sessions.find(s => s.sessionId === owner.run.sessionId);
    if (closing || storageFailed || meta.reconciliationRequired || owner.stopRequested || owners.get(owner.run.sessionId) !== owner || workerStore.suppressed(owner.run.sessionId) || !session || session.hidden) throw new Error("Worker continuation withheld: parent stopped, hidden, or execution unavailable");
  }
  const workers = new WorkerService(workerStore, {
    async parent(caller, starting) {
      const classified = classifyCaller({ SANE_CALLER_CONTEXT: JSON.stringify(caller.envelope) });
      if (classified.actorKind !== "native") throw new WorkstreamAdapterError(409, "worker-parent", "Qualified App-owned native caller required");
      const e = classified.envelope, source = normalizeNativeSource(e.source);
      if (source.authorityId !== e.authorityId) throw new WorkstreamAdapterError(409, "worker-parent", "Caller authority changed");
      // Enrollment changes admission.operation; attachment metadata is the durable external-ownership discriminator.
       const candidates = admissions.list().filter(a => a.state === "ready" && a.source.authorityId === e.authorityId && a.source.descriptor.harness === e.source.harness && a.nativeId === e.nativeId && a.binding.domain.mode === "repository" && a.binding.domain.primaryCheckout === e.repository && meta.sessions.some(s => s.sessionId === a.sessionId && !s.attachment));
      const a = candidates.length === 1 ? candidates[0] : undefined;
      const session = a && meta.sessions.find(s => s.sessionId === a.sessionId && !s.attachment);
      const run = session && meta.runs.find(r => r.sessionId === session.sessionId && r.runId === caller.runId);
      if (!a || !session || !run || run.operation === "compact" || typeof caller.toolCallId !== "string" || !caller.toolCallId || caller.toolCallId.length > 300 || starting && owners.get(session.sessionId)?.run !== run) throw new WorkstreamAdapterError(409, "worker-parent", "Worker operations require an App-owned repository parent and a known prompt run; starts require its current owned run");
      const checkout = await execution(session.sessionId);
      const native = { harness: e.source.harness, authorityId: e.authorityId, nativeId: e.nativeId };
      (await router!.forAdmission(a))!.domain.resolveContext(native);
      return { sessionId: session.sessionId, runId: run.runId, native, checkout, profileId: sessionProfileId(session) };
    },
    assertCurrentParent(parent) {
      const owner = owners.get(parent.sessionId);
      if (!owner || owner.run.runId !== parent.runId || owner.run.status !== "running" || owner.run.operation === "compact" || owner.settled || owner.stopRequested || owner.cancelling) throw new WorkstreamAdapterError(409, "worker-parent", "Parent prompt run ended or stopped during worker qualification; no worker was reserved");
    },
    hasActiveExecution(w) { return owners.has(w.sessionId) || workerStore.deliveries().some(d => d.parentSessionId === w.sessionId && ["claimed", "acceptance-unknown"].includes(d.state)); },
    assertCapacity() {
      const a = availability();
      if (!a.canSend) {
        const code = a.code ?? (storageFailed ? "worker-storage-unavailable" : meta.reconciliationRequired ? "worker-reconciliation-required" : closing ? "worker-app-closing" : "worker-unavailable");
        throw new NativeWorkerRequestError(a.code ? 409 : 503, code, `${a.reason} No worker was admitted by this request; other starts in the same batch may have succeeded. Inspect sane_worker_status before retrying only missing assignments once the App is available. Do not bypass this rejection by launching native subagents.`);
      }
    },
    async launch(w) {
      const harness = validateHarness(w.launch.harness);
      requireOperation(harness, "prompt");
      workerStore.update(w.id, { state: "launching" });
      const parentAdmission = admissions.get(w.parent.sessionId)!;
      admitting.add(w.sessionId);
      try {
        if (closing || storageFailed) throw new Error("App unavailable before worker creation");
        let nativeLaunch = harness === "opencode" ? await oc.resolveLaunch(w.checkout, { agent: w.launch.agent, model: w.launch.model, effort: w.launch.effort }) : undefined;
        if (harness === "claude-code") await claudeAgentSettings(claudeRoot, w.launch.identity!);
        let a = await admissions.begin({ sessionId: w.sessionId, operation: "create", harness: harness === "opencode" ? "oc" : "cc", cwd: w.checkout, nativeId: harness === "opencode" ? null : crypto.randomUUID(), workspaceId: parentAdmission.binding.workspaceId, worktreeId: parentAdmission.binding.worktreeId, parent: w.parent.native });
        if (harness === "opencode") a = await admissions.createNative(w.sessionId, async () => (await oc.createResolved(w.checkout, nativeLaunch!)).id);
        const launch = { ...w.launch, ...(nativeLaunch?.model ? { model: `${nativeLaunch.model.providerID}/${nativeLaunch.model.id}`, effort: nativeLaunch.model.variant } : {}) };
        const session: Session = { sessionId: w.sessionId, nativeSessionId: a.nativeId!, harness, authorityId: a.source.authorityId, cwd: w.checkout, lastStatus: "unknown", lastRunId: null, ...agentLaunchSnapshot(launch) };
        workerStore.update(w.id, { launch, child: { harness: a.source.descriptor.harness, authorityId: a.source.authorityId, nativeId: a.nativeId! } });
        meta.sessions.push(session); await persist();
        await catalog.associate(w.sessionId, w.checkout, a.binding.workspaceId, a.binding.worktreeId);
        await admissions.register(w.sessionId); admissions.ready(w.sessionId);
        if (closing || storageFailed || meta.reconciliationRequired) throw new Error("App unavailable before worker submission; launch remains reserved");
        if (workerStore.get(w.id)!.cancelRequestedAt) {
          const at = new Date().toISOString(); workerStore.update(w.id, { state: "interrupted", outcome: { status: "interrupted", at, summary: "Cancelled before submission", log: null }, notification: { id: `worker-outcome:${w.id}`, state: "pending" } }); return;
        }
        try {
          const child = { harness: a.source.descriptor.harness, authorityId: a.source.authorityId, nativeId: a.nativeId! };
          const { saneContext } = saneSessionContext(w.launch.identity, workerAssignment((await router!.forAdmission(a))!.domain, child, w.parent.native, w.input.worker, w.input.jobs ?? [], w.id));
          if (!saneContext) throw new Error("Worker launch has no SANE worker identity");
          if (harness === "opencode") await oc.bindSaneContext(a.nativeId!, saneContext.version, saneContextText(saneContext));
          session.saneContext = saneContext;
        } catch (e) {
          const summary = `Worker assignment unavailable: ${e instanceof Error ? e.message : "context resolution failed"}`;
          workerStore.update(w.id, { state: "failed", error: summary, outcome: { status: "failed", at: new Date().toISOString(), summary, log: null }, notification: { id: `worker-outcome:${w.id}`, state: "pending" } });
          throw e;
        }
        await persist();
        const run: Run = { runId: crypto.randomUUID(), sessionId: w.sessionId, cwd: w.checkout, status: "running", createdAt: new Date().toISOString(), ...agentLaunchSnapshot(launch), ...saneContextSnapshot(session), ...(harness === "opencode" ? { nativeCommandId: `msg_${crypto.randomUUID().replaceAll("-", "")}`, nativePhase: "preparing" as const } : {}) };
        workerStore.update(w.id, { runId: run.runId, state: "running" });
        const finished = Promise.withResolvers<void>();
        const owner: Owner = { run, native: harness === "opencode", done: finished.promise, settled: false };
        owners.set(w.sessionId, owner); session.lastRunId = run.runId; session.lastStatus = "running"; meta.runs.push(run); events.set(run.runId, []);
        const prompt = w.input.context === undefined ? w.input.prompt : `${w.input.prompt}\n\nSupplied context:\n${w.input.context}`;
        void executePrompt(owner, prompt, false, () => {}).catch(async () => { failClosed(); await terminate(owner); }).finally(async () => {
          owner.settled = true; releaseOwner(owner); finished.resolve();
          try { if (!storageFailed) await workers.refresh(workerStore.get(w.id)!); } catch { failClosed(); }
        });
      } catch (e) {
        const a = admissions.get(w.sessionId);
        if (!a || a.state === "intent") {
          const summary = e instanceof Error ? e.message : "Worker preparation failed";
          workerStore.update(w.id, { state: "failed", error: summary, outcome: { status: "failed", at: new Date().toISOString(), summary, log: null }, notification: { id: `worker-outcome:${w.id}`, state: "pending" } });
        }
        throw e;
      } finally { admitting.delete(w.sessionId); }
    },
    async observe(w) {
      const restored = restoreWorkerOutput(w, runId => events.get(runId) ?? []);
      if (restored) w = workerStore.update(w.id, restored);
      const results = workerResults(w);
      // Durable delivery run identity recovers continuations after restart without replay.
      const continuationDeliveries = workerStore.deliveries().filter(d => d.parentSessionId === w.sessionId);
      const continuationIds = new Set(continuationDeliveries.filter(d => d.state !== "not-submitted" && workerDeliveryEvidence(d, meta.runs.find(r => r.runId === d.run.runId), events.get(d.run.runId) ?? []) !== "not-submitted").map(d => d.run.runId));
      const candidates = meta.runs.filter(r => r.sessionId === w.sessionId && r.operation !== "compact" && (!continuationDeliveries.some(d => d.run.runId === r.runId) || continuationIds.has(r.runId)));
      const run = candidates.find(r => !results.some(result => result.runId === r.runId)) ?? candidates.at(-1);
      if (run && results.some(result => result.runId === run.runId)) {
        const skipped = continuationDeliveries.find(d => d.run.runId === w.continuation?.runId && !continuationIds.has(d.run.runId));
        return skipped && w.state !== results.at(-1)!.outcome.status ? { state: results.at(-1)!.outcome.status, continuation: { runId: skipped.run.runId, state: "failed", error: "Continuation was not submitted; child notifications remain pending" } } : {};
      }
      if (!run && w.outcome) return {};
      const continuation = run && run.runId !== w.runId ? { runId: run.runId, state: run.status } : undefined;
      if (!run) {
        if (admitting.has(w.sessionId) || owners.has(w.sessionId)) return {};
        const uncertain = (reason: string) => ({ state: "uncertain" as const, error: `${reason}; reservation retained. Inspect admission ${w.sessionId}${w.runId ? ` and log ${w.runId}.jsonl` : ""}; reconcile native identity/termination explicitly before releasing capacity. Do not resend this start request.` });
        if (storageFailed || retainOwner) return uncertain("App storage or execution ownership is unconfirmed");
        if (meta.runs.some(r => r.sessionId === w.sessionId)) return uncertain("Worker run reference disagrees with session run metadata");
        const a = admissions.get(w.sessionId);
        if (a?.state === "native_creation_unknown") return uncertain("Native session creation acknowledgement was lost");
        if (!a && (w.child || meta.sessions.some(s => s.sessionId === w.sessionId)) || a && (a.operation !== "create" || a.binding.executionCheckout !== w.checkout || w.child && (w.child.nativeId !== a.nativeId || w.child.authorityId !== a.source.authorityId))) return uncertain("Worker and admission identity evidence disagree");
        if (w.runId) {
          try {
            const raw = await readFile(join(options.dataDir, `${w.runId}.jsonl`), "utf8");
            const orphan = raw.length ? decodeLog(raw, { runId: w.runId, sessionId: w.sessionId } as Run).events : [];
            // The executors persist run metadata before native launch/submission. Only their
            // initial status and captured user prompt may precede that publication boundary.
            if (orphan.some(e => e.kind !== "submission" && !(e.kind === "status" && (e.data as any)?.status === "running" && Object.keys((e.data ?? {}) as object).length === 1))) return uncertain("Orphan log contains evidence beyond the pre-submission publication boundary");
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") return uncertain("Orphan run log is unreadable or cannot prove non-submission");
          }
        }
        if (admitting.has(w.sessionId) || owners.has(w.sessionId)) return {};
        const status = w.cancelRequestedAt ? "interrupted" as const : "failed" as const;
        const summary = "Worker preparation ended before durable run publication; native work was not submitted. Original request is closed and will not be replayed.";
        return { state: status, error: undefined, outcome: { status, at: new Date().toISOString(), summary, log: null } };
      }
      const records = events.get(run.runId) ?? [];
      const uncertain = workerTerminationUncertainty(records);
      if (uncertain || retainOwner) return { ...(continuation ? { continuation: { ...continuation, state: "uncertain" as const, error: "Execution ownership or termination unconfirmed" } } : {}), state: "uncertain", error: uncertain && w.launch.harness === "claude-code" ? "CLI termination is unconfirmed. Verify the previous CLI process has stopped, then restart with --reconcile-interrupted to persist confirmation and release this reservation." : "Execution ownership or termination remains unconfirmed; reconcile the original native run without resubmitting." };
      if (run.status !== "running") {
        if (owners.get(w.sessionId)?.settled === false) return {}; // Finish log/metadata publication before recording an outcome.
        // The log is authoritative; transport the full final response, not a UI preview.
        return { ...(continuation ? { continuation } : {}), state: run.status, error: undefined, outcome: { status: run.status, at: run.endedAt!, summary: workerOutput(records) ?? String((records.filter(e => e.kind === "status").at(-1)?.data as any)?.reason ?? run.status), log: { sessionId: w.sessionId, runId: run.runId } } };
      }
      if (continuation) return { continuation: { ...continuation, state: w.continuationCancellation ? "cancelling" : "running" }, state: w.continuationCancellation ? "cancelling" : "running" };
      if (w.cancelRequestedAt) return { state: "cancelling" };
      const observed = records.filter(e => e.kind === "status" && typeof (e.data as any)?.workerWaiting === "boolean").at(-1);
      if (observed) return { state: (observed.data as any).workerWaiting ? "waiting" : "running" };
      const hook = records.filter(e => e.kind === "hook" && ["PermissionRequest", "PostToolUse"].includes((e.data as any)?.event)).at(-1);
      if (hook) return { state: (hook.data as any).event === "PermissionRequest" ? "waiting" : "running" };
      return {};
    },
    async cancel(w) {
      const owner = owners.get(w.sessionId);
      if (!owner) { if (!w.runId && admitting.has(w.sessionId)) return; throw new Error("No active App owner; termination requires native reconciliation"); }
      await cancelOwner(owner);
    },
  }, () => agentProfiles, maxWorkersPerCheckout);

  async function reconcileWorkerDelivery(d: WorkerDelivery) {
    if (!["claimed", "acceptance-unknown"].includes(d.state)) return d;
    const run = meta.runs.find(r => r.runId === d.run.runId && r.sessionId === d.parentSessionId);
    if (!run) {
      if (owners.has(d.parentSessionId) || admitting.has(d.parentSessionId) || storageFailed) return d;
      // Both executors publish metadata before native submission. An absent run with
      // only pre-publication log records proves this claim was never dispatched.
      try {
        const raw = await readFile(join(options.dataDir, `${d.run.runId}.jsonl`), "utf8");
        const records = raw ? decodeLog(raw, d.run).events : [];
        if (records.some(e => e.kind !== "submission" && !(e.kind === "status" && (e.data as any)?.status === "running" && Object.keys((e.data ?? {}) as object).length === 1))) return workerStore.advanceDelivery(d.id, "acceptance-unknown", "Orphan delivery log exceeds pre-submission boundary; inspect original run and native command. No automatic resend.");
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") return workerStore.advanceDelivery(d.id, "acceptance-unknown", "Delivery log unreadable; repair/reconcile original run before retry. No automatic resend."); }
      return workerStore.advanceDelivery(d.id, "not-submitted", "Bridge stopped before continuation run publication; outcomes remain pending");
    }
    const evidence = workerDeliveryEvidence(d, run, events.get(run.runId) ?? []);
    if (evidence === "accepted") {
      // Native evidence may arrive while execution continues. The run owner still
      // holds capacity; delivered means accepted, not finished or comprehended.
      await serial;
      if (storageFailed) return d;
      return workerStore.advanceDelivery(d.id, "delivered");
    }
    if (evidence === "not-submitted" && owners.get(d.parentSessionId)?.settled !== false) return workerStore.advanceDelivery(d.id, "not-submitted", "Continuation did not submit; check parent suppression, visibility and executor configuration before retry");
    const problem = run.status === "running" ? "Waiting for correlated native acceptance; continuation will not be resent" : "Run ended without proof of acceptance or non-submission. Inspect the original native command; no automatic resend, even after termination acknowledgement.";
    return d.error === problem && d.state === "acceptance-unknown" ? d : workerStore.advanceDelivery(d.id, "acceptance-unknown", problem);
  }

  async function dispatchWorkerReport(parentSessionId: string) {
    const problem = (message: string) => workerStore.pendingProblem(parentSessionId, message);
    const session = meta.sessions.find(s => s.sessionId === parentSessionId);
    if (!session) return problem("Parent session unavailable; outcomes retained for inspection");
    requireOperation(sessionHarness(session), "prompt");
    // Hidden is a reversible soft-hide: retain outcomes and pause automatic turns.
    if (session.hidden) return problem("Parent is soft-hidden; unhide to restore report eligibility. Explicit stop suppression still requires user submission.");
    if (workerStore.suppressed(parentSessionId)) return problem("Automatic continuation stopped; explicit user submission resumes report eligibility");
    let available = availability(parentSessionId);
    if (!available.canSend) return problem(available.reason ?? "Parent unavailable");
    const a = admissions.get(parentSessionId);
    if (!a || a.state !== "ready" || a.binding.domain.mode !== "repository" || session.attachment || !session.nativeSessionId || !session.lastRunId) return problem("Report recipient must remain an enrolled App-owned conversation with a known native run");
    const pending = workerStore.list().filter(w => w.parent.sessionId === parentSessionId && workerResults(w).some(r => r.notification.state === "pending"));
    if (pending.some(w => w.parent.native.nativeId !== a.nativeId || w.parent.native.authorityId !== a.source.authorityId || w.parent.native.harness !== a.source.descriptor.harness)) return problem("Report recipient native identity changed; reconcile the original parent binding");
    const cwd = await execution(parentSessionId);
    if (session.harness === "opencode") await oc.assertIdle(session.nativeSessionId, cwd);
    // Recheck after all asynchronous preparation. Claim and owner acquisition below
    // are synchronous, sharing arbitration with explicit wait acknowledgement.
    available = availability(parentSessionId);
    if (!available.canSend) return problem(available.reason ?? "Parent became unavailable");
    if (session.hidden || workerStore.suppressed(parentSessionId)) return problem("Parent hidden or stopped during preparation; outcomes remain pending");
    const workerParent = workerStore.getBySession(parentSessionId);
    if (workerParent && workers.active().filter(w => w.checkout === cwd && w.sessionId !== parentSessionId).length >= maxWorkersPerCheckout) return problem(`Checkout worker capacity reached (${maxWorkersPerCheckout}); continuation remains pending`);
    const now = new Date().toISOString();
    const run: Run = { runId: crypto.randomUUID(), sessionId: parentSessionId, cwd, status: "running", createdAt: now, agent: session.agent, agentKind: session.agentKind, nativeAgentSelected: session.nativeAgentSelected, profileId: session.profileId, model: session.model, effort: session.effort, ...saneContextSnapshot(session) };
    const commandId = session.harness === "opencode" ? `msg_${crypto.randomUUID().replaceAll("-", "")}` : `${run.runId}:user`;
    if (session.harness === "opencode") { run.nativeCommandId = commandId; run.nativePhase = "preparing"; }
    const d = workerStore.claimDelivery({ id: crypto.randomUUID(), parentSessionId, native: { harness: a.source.descriptor.harness, authorityId: a.source.authorityId, nativeId: session.nativeSessionId }, run, commandId, createdAt: now, updatedAt: now });
    if (!d) return;
    workerStore.advanceDelivery(d.id, "acceptance-unknown");
    const finished = Promise.withResolvers<void>();
    const owner: Owner = { run, native: session.harness === "opencode", workerDeliveryId: d.id, done: finished.promise, settled: false };
    owners.set(parentSessionId, owner); session.lastRunId = run.runId; session.lastStatus = "running"; meta.runs.push(run); events.set(run.runId, []);
    if (workerParent) workerStore.update(workerParent.id, { state: "running", continuation: { runId: run.runId, state: "running" }, continuationCancellation: undefined });
    const prompt = workerReportPrompt(d, workerStore.listForDelivery(d));
    void executePrompt(owner, prompt, true, () => {}).catch(async () => { failClosed(); await terminate(owner); }).finally(async () => {
      owner.settled = true; releaseOwner(owner); finished.resolve();
      try { if (!storageFailed) { await reconcileWorkerDelivery(d); if (workerParent) await workers.refresh(workerStore.get(workerParent.id)!); } } catch { failClosed(); }
    });
  }

  let workerOutboxTask: Promise<void> | undefined;
  async function consumeWorkerReports() {
    for (const w of workerStore.list()) { if (closing || storageFailed) return; await workers.refresh(w); }
    for (const d of workerStore.deliveries()) { if (closing || storageFailed) return; await reconcileWorkerDelivery(d); }
    for (const parent of new Set(workerStore.list().filter(w => workerResults(w).some(r => r.notification.state === "pending" && (!r.notification.retryAfter || Date.parse(r.notification.retryAfter) <= Date.now()))).map(w => w.parent.sessionId))) {
      if (closing || storageFailed) return;
      try { await dispatchWorkerReport(parent); } catch (e) { workerStore.pendingProblem(parent, e instanceof Error ? e.message : "Worker report preparation unavailable"); }
    }
  }
  const workerOutbox = { list: () => workerStore.deliveries(), reconcile: async (id: string) => { const d = workerStore.deliveries().find(d => d.id === id); if (!d) throw new WorkstreamAdapterError(404, "worker-delivery-missing", "Unknown worker delivery"); return reconcileWorkerDelivery(d); } };

  async function cancelOwner(owner: Owner) {
    requireOwnedOperation(ownedSession(owner), owner, "cancelOwnedRun");
    if (!owner.cancel) {
      owner.cancelling = true; owner.stopRequested = true;
      owner.cancel = (async () => {
        if (owner.run.status !== "running") return { interrupted: false };
        await emit(owner.run, "status", { status: "running", connection: "stopping", reason: "Stop requested; waiting for terminal evidence" });
        if (owner.native) return ocRuns.interrupt(owner);
        return { interrupted: await terminate(owner) };
      })().finally(() => { owner.cancelling = false; releaseOwner(owner); });
    }
    const attempt = owner.cancel;
    try { return await attempt; } catch (e) { if (owner.cancel === attempt) owner.cancel = undefined; throw e; }
  }
  const handoffProblems = new Map<string, string>();
  async function reconcileHandoff(workspaceId: string, id: string) {
    const domain = (await router!.forWorkspace(workspaceId)).domain;
    let h = domain.getHandoff(id);
    if (h.recipient.ownerId !== store.manifest.storeId || !h.runId || ["queued", "completed", "failed"].includes(h.status)) return h;
    const run = meta.runs.find(r => r.runId === h.runId && r.sessionId === h.recipient.sessionId);
    if (!run || run.operation === "compact") return h;
    const records = events.get(run.runId) ?? [];
    const accepted = h.recipient.harness === "oc" ? run.nativeCommandId === h.nativeCommandId && run.nativePhase === "accepted" : records.some(e => e.kind === "stdout" && (e.data as any)?.session_id === h.recipient.ref?.nativeId && ((e.data as any)?.type === "result" || (e.data as any)?.type === "system" && (e.data as any)?.subtype === "init"));
    const advance = (status: typeof h.status, evidence: string) => { h = domain.advanceHandoff(h.id, h.revision, { status, evidence }, { actor: { kind: "system" }, correlationId: h.id }); };
    if (h.status === "acceptance_unknown" && accepted) advance("accepted", `Native acceptance recorded in App run ${run.runId}`);
    const executing = h.recipient.harness === "cc" ? accepted : records.some(e => e.kind === "message" && (e.data as any)?.role === "assistant");
    if (h.status === "accepted" && run.status === "running" && executing) advance("running", `Native execution observed in App run ${run.runId}`);
    if (run.status === "completed" && accepted) advance("completed", `Correlated native delivery-run success in App run ${run.runId}; not task completion or user approval`);
    else if (run.status === "failed") advance("failed", `Terminal failure recorded in App run ${run.runId}`);
    else if (run.status === "interrupted" && h.recipient.harness === "oc") advance("failed", `Native interruption recorded in App run ${run.runId}`);
    else if (run.status === "interrupted") handoffProblems.set(h.id, "Execution interrupted; inspect native state and acknowledge termination with the handoff reconcile endpoint");
    if (["completed", "failed"].includes(h.status)) handoffReservations.delete(h.recipient.sessionId);
    return h;
  }
  async function dispatchHandoff(workspaceId: string, id: string) {
    let h = (await router!.forWorkspace(workspaceId)).domain.getHandoff(id);
    if (!availability(h.recipient.sessionId, true, true, true).canSend || handoffReservations.has(h.recipient.sessionId)) return;
    h = await prepareHandoffRecipient(workspaceId, id);
    const session = meta.sessions.find(s => s.sessionId === h.recipient.sessionId)!;
    const descriptor = requireOperation(sessionHarness(session), "prompt");
    if (session.attachment && descriptor.policies.attachedSendRequiresNativeStopped && !handoffAcknowledgements.has(h.id)) throw new WorkstreamAdapterError(409, "native-acknowledgement-required", "Confirm external assistant execution is stopped with the handoff acknowledge endpoint before delivery");
    if (!availability(session.sessionId, true, true).canSend || handoffReservations.has(session.sessionId)) return;
    admitting.add(session.sessionId);
    try {
      const cwd = await execution(session.sessionId);
      if (session.harness === "opencode") await oc.assertIdle(session.nativeSessionId!, cwd);
      if (closing || storageFailed || meta.reconciliationRequired) return;
      const domain = (await router!.forWorkspace(workspaceId)).domain;
      const recipientContext = domain.resolveContext(h.recipient.ref!);
      const status = domain.getWorkstreamStatus(h.workstreamId);
      const fromSender = (a: (typeof status.activePhases)[number]) => a.ref.harness === h.sender.harness && a.ref.authorityId === h.sender.authorityId && a.ref.nativeId === h.sender.nativeId;
      const senderSlots = [...new Set(status.activePhases.filter(fromSender).map(a => a.phase))];
      const originalSenderSlots = [...new Set([...status.phaseHistory, ...status.activePhases].filter(a => fromSender(a) && a.startedAt <= h.createdAt && (!a.endedAt || a.endedAt >= h.createdAt)).map(a => a.phase))];
      const replySlots = domain.getConversation(h.sender)?.workstreamId === h.workstreamId ? originalSenderSlots.filter(slot => senderSlots.some(current => equivalentSlots(slot, current))) : [];
      const run: Run = { runId: crypto.randomUUID(), sessionId: session.sessionId, cwd, status: "running", createdAt: new Date().toISOString(), agent: session.agent, agentKind: session.agentKind, nativeAgentSelected: session.nativeAgentSelected, model: session.model, effort: session.effort, profileId: session.profileId, ...saneContextSnapshot(session) };
      const commandId = session.harness === "opencode" ? `msg_${crypto.randomUUID().replaceAll("-", "")}` : `${run.runId}:user`;
      h = domain.advanceHandoff(h.id, h.revision, { status: "acceptance_unknown", attemptId: crypto.randomUUID(), nativeCommandId: commandId, runId: run.runId }, { actor: { kind: "system" }, correlationId: h.id }, current => { handoffs.assertRecipientReady(current); });
      handoffReservations.add(session.sessionId);
      if (process.env.SANE_TEST_FAULT === "handoff-drop-run") {
        // Test-only crash simulation (C9): the handoff row above is persisted
        // as acceptance_unknown, but the App run below is never persisted or
        // submitted — matching a crash on the persistence/submission boundary.
        // The explicit retry endpoint then proves nonacceptance without
        // resending. Never active unless explicitly gated.
        return;
      }
      handoffAcknowledgements.delete(h.id);
      const resume = !!session.lastRunId || !!session.attachment;
      if (session.harness === "opencode") { run.nativeCommandId = commandId; run.nativePhase = "preparing"; }
      const finished = Promise.withResolvers<void>();
      const owner: Owner = { run, native: session.harness === "opencode", done: finished.promise, settled: false };
      owners.set(session.sessionId, owner);
      session.lastRunId = run.runId; session.lastStatus = "running"; meta.runs.push(run); events.set(run.runId, []);
      const prompt = [
        `SANE handoff ${h.id}`, `Request ID: ${h.input.requestId}`, `Repository: ${domain.primaryCheckout}`, `Workstream: ${h.workstreamId}`,
        `Artifacts: ${recipientContext.artifactsRoot}`, `Destination: ${h.input.to}`, `From: ${JSON.stringify(h.sender)}`,
        `Sender slots at request: ${originalSenderSlots.length ? JSON.stringify(originalSenderSlots) : "(none recorded)"}`,
        `Sender slots now: ${senderSlots.length ? JSON.stringify(senderSlots) : "(none)"}`,
        ...(h.input.kickoff ? ["Origin: kickoff; the sender created this workstream and is not a member."] : []),
        `Recipient: ${JSON.stringify(h.recipient.ref)}`, `Execution checkout: ${cwd}`,
        h.input.createNew ? "Perform the assigned assistant's mandatory Pickup and ask the user to confirm scope before proceeding."
          : "Continue within this conversation's confirmed scope and user decisions; confirm any scope change with the user.",
        "A successful delivery run may only establish Pickup readiness; it does not mean request/task completion, user acceptance, or approval.",
        "For a reply, use a separate sane_handoff with a new requestId and target exactly the qualified From identity above. Include this handoff ID, request ID, workstream, and original request scope in its message.",
        replySlots.length ? `Reply destination slots from the original scope still assigned now: ${JSON.stringify(replySlots)}. Select the relevant exact slot and recheck eligibility when sending.`
          : "The sender has no eligible original reply slot in this workstream now. Report this membership/assignment authority restriction; an exact reply cannot bypass it or be redirected to another conversation.",
        "", h.input.message,
      ].join("\n");
      void executePrompt(owner, prompt, resume, () => {}).catch(async () => { failClosed(); await terminate(owner); }).finally(async () => {
        try { if (!storageFailed) await reconcileHandoff(workspaceId, h.id); } catch { failClosed(); }
        owner.settled = true; releaseOwner(owner); finished.resolve();
      });
      handoffProblems.delete(h.id);
    } finally { admitting.delete(session.sessionId); }
  }
  let handoffTask: Promise<void> | undefined;
  async function consumeHandoffs() {
    for (const w of (await catalog.list()).workspaces.filter(w => w.kind === "repository")) {
      if (closing || storageFailed) return;
      let deliveries;
      try { deliveries = await handoffs.listForPolling(w.workspaceId); } catch { continue; }
      for (const h of deliveries.filter(h => h.recipient.ownerId === store.manifest.storeId && !["queued", "completed", "failed"].includes(h.status))) handoffReservations.add(h.recipient.sessionId);
      for (const h of deliveries.filter(h => h.recipient.ownerId === store.manifest.storeId && !["completed", "failed"].includes(h.status))) {
        if (closing || storageFailed) return;
        try {
          if (h.status === "queued") {
            const sessionId = h.recipient.sessionId;
            if (handoffDispatches.has(sessionId) || handoffReservations.has(sessionId) || !availability(sessionId, true, true, true).canSend) continue;
            const task = Promise.resolve().then(() => dispatchHandoff(w.workspaceId, h.id))
              .catch(error => { handoffProblems.set(h.id, error instanceof Error ? error.message : "Handoff execution unavailable"); })
              .finally(() => { handoffDispatches.delete(sessionId); });
            handoffDispatches.set(sessionId, task);
          } else await reconcileHandoff(w.workspaceId, h.id);
        }
        catch (error) { handoffProblems.set(h.id, error instanceof Error ? error.message : "Handoff execution unavailable"); }
      }
    }
  }
  async function handle(req: Request, srv: Pick<Bun.Server<undefined>, "requestIP" | "port">, upgrade?: (req: Request, data: TerminalSocketData) => boolean): Promise<Response | undefined> {
    try {
      const url = new URL(req.url); const path = url.pathname;
      if (path.startsWith("/hooks/")) {
        if (req.method !== "POST" || !loopback(srv.requestIP(req)?.address ?? "")) return json({ error: "Forbidden" }, 403);
        const event = decodeURIComponent(path.slice(7)); if (!(hookEvents as readonly string[]).includes(event)) return json({ error: "Unknown hook" }, 400);
        const reply = await claudeRuns.ingestHook(event, await body(req), req.headers.get("x-cc-web-secret") ?? "");
        return json(reply.body, reply.status);
      }
      const expected = auth.browserBoundary(req, srv);
      if (expected instanceof Response) return expected;
      if (path === "/api/config" && req.method === "GET") {
        const signedIn = auth.authenticated(req);
        return json({ authRequired: !!password, authenticated: signedIn, cwd: signedIn ? options.cwd : null, oneShot: true, ...(signedIn ? { capabilities: { concurrency: { scope: "conversation", limit: maxConcurrentRuns, perConversation: 1, sharedCheckoutWrites: true }, cancelRun: true, midRunInput: false, permissionReplies: true, attachments: false, modelSelection: true, effortValues: efforts, terminal: terminals.capability }, agents: ASSISTANT_AGENT_IDS.map(id => ({ id, label: ASSISTANT_AGENT_LABELS[id], description: ASSISTANT_AGENT_DESCRIPTIONS[id] })), agentProfiles, harnesses: [
          { id: "claude-code", name: getHarnessDescriptor("claude-code")!.label, available: true, connected: true, state: "available", capabilities: capabilitiesFor("claude-code") },
          { id: "opencode", name: getHarnessDescriptor("opencode")!.label, ...await oc.connection(options.cwd), capabilities: capabilitiesFor("opencode") },
        ] } : {}) });
      }
      if (path === "/api/login" && req.method === "POST") return await auth.login(req, expected);
      if (path === "/api/logout" && req.method === "POST") return auth.logout(req);
      if (path.startsWith("/api/") && !auth.authenticated(req)) return json({ error: "Authentication required" }, 401);
      const mutatingSession = /^\/api\/sessions\/([^/]+)(?:\/|$)/.exec(path)?.[1];
      const readOnlyTranscriptRefresh = req.method === "POST" && /^\/api\/sessions\/[^/]+\/transcript\/refresh$/.test(path);
      if (!["GET", "HEAD"].includes(req.method) && !readOnlyTranscriptRefresh && mutatingSession && !path.endsWith("/branch") && (branches.replaced(mutatingSession) || branches.pending(mutatingSession) && !path.endsWith("/cancel"))) return json({ error: branches.replaced(mutatingSession) ? "Replaced conversation is read-only; open its replacement" : "The branch is not ready yet. Changes are paused to protect this conversation." }, 409);
      if (path === "/api/agents" || path.startsWith("/api/agents/")) {
        try {
          if (path === "/api/agents" && req.method === "GET") return json(agentProfiles);
          // Read the body before cloning so concurrent edits never overwrite each other.
          const input = req.method === "PUT" || req.method === "POST" && !path.endsWith("/reset") ? await body(req) : undefined;
          const next = structuredClone(agentProfiles);
          if (path === "/api/agents" && req.method === "POST") {
            const { fromId, ...fields } = input ?? {};
            const from = next.profiles.find(p => p.id === fromId);
            if (!from) return json({ error: "Unknown agent profile" }, 404);
            const profile = applyProfileInput({ ...from, id: crypto.randomUUID(), builtin: false, locked: false, order: Math.max(...next.profiles.map(p => p.order)) + 1 }, fields);
            next.profiles.push(profile); await commitAgents(next);
            return json({ profile });
          }
          if (path === "/api/agents/order" && req.method === "PUT") {
            if (input?.order !== undefined) {
              if (!Array.isArray(input.order) || input.order.length !== next.profiles.length || new Set(input.order).size !== input.order.length || next.profiles.some(p => !input.order.includes(p.id))) return json({ error: "order must list every agent profile id exactly once" }, 400);
              for (const p of next.profiles) p.order = input.order.indexOf(p.id);
            }
            if (input?.defaultId !== undefined) next.defaultId = input.defaultId;
            if (input?.workerDefaults !== undefined) next.workerDefaults = input.workerDefaults;
            await commitAgents(next);
            return json(agentProfiles);
          }
          const match = /^\/api\/agents\/([^/]+)(\/reset)?$/.exec(path);
          const index = match ? next.profiles.findIndex(p => p.id === decodeURIComponent(match[1]!)) : -1;
          if (!match || index < 0) return json({ error: "Unknown agent profile" }, 404);
          const current = next.profiles[index]!;
          if (match[2] && req.method === "POST") {
            if (!current.builtin) return json({ error: "Only builtin profiles can be reset" }, 400);
            const profile = { ...builtinProfiles().find(p => p.id === current.id)!, order: current.order };
            next.profiles[index] = profile; await commitAgents(next);
            return json({ profile });
          }
          if (!match[2] && req.method === "PUT") {
            if (current.builtin && current.kind === "base" && input?.harness !== undefined && input.harness !== current.harness) return json({ error: "Base profile harness cannot change" }, 400);
            const profile = applyProfileInput(current, input ?? {});
            if (profile.hidden && next.defaultId === profile.id) return json({ error: "The default agent cannot be hidden" }, 400);
            next.profiles[index] = profile; await commitAgents(next);
            return json({ profile });
          }
          if (!match[2] && req.method === "DELETE") {
            if (current.builtin) return json({ error: "Builtin profiles cannot be deleted" }, 400);
            next.profiles.splice(index, 1);
            if (next.defaultId === current.id) next.defaultId = BASE_PROFILE_IDS["claude-code"];
            await commitAgents(next);
            return json({ ok: true });
          }
          return json({ error: "Method not allowed" }, 405);
        } catch (error) { if (error instanceof AppStoreError) return json({ error: error.message }, 400); throw error; }
      }
      if (path === "/api/handoffs" && req.method === "GET") { const listed = await handoffs.list(url.searchParams.get("workspaceId") ?? ""); return json({ handoffs: listed, problems: Object.fromEntries(listed.filter(h => handoffProblems.has(h.id)).map(h => [h.id, handoffProblems.get(h.id)])) }); }
      const handoffAction = /^\/api\/handoffs\/([^/]+)\/(retry|acknowledge|reconcile)$/.exec(path);
      if (handoffAction && req.method === "POST") {
        const input = await body(req), domain = (await router!.forWorkspace(input.workspaceId)).domain;
        const h = await reconcileHandoff(input.workspaceId, handoffAction[1]!);
        if (h.recipient.ownerId !== store.manifest.storeId) return json({ error: "Handoff belongs to another App store" }, 409);
        if (handoffAction[2] === "reconcile") {
          const run = meta.runs.find(r => r.runId === h.runId && r.sessionId === h.recipient.sessionId);
          if (h.recipient.harness !== "cc" || !run || run.operation === "compact" || run.status !== "interrupted" || !["acceptance_unknown", "accepted", "running"].includes(h.status) || input.nativeStopped !== true || owners.has(h.recipient.sessionId) || !availability(undefined, false).canSend) return json({ error: "Interrupted assistant prompt run, reconciled SANE ownership, and explicit nativeStopped acknowledgement required" }, 409);
          const result = domain.advanceHandoff(h.id, h.revision, { status: "failed", evidence: `Operator confirmed interrupted assistant run ${run.runId} stopped; delivery outcome not claimed successful` }, { actor: { kind: "system" }, correlationId: h.id });
          handoffReservations.delete(h.recipient.sessionId); handoffProblems.delete(h.id);
          return json({ handoff: result });
        }
        if (handoffAction[2] === "acknowledge") {
          if (h.status !== "queued" || input.nativeStopped !== true) return json({ error: "Queued delivery and explicit nativeStopped acknowledgement required" }, 409);
          handoffAcknowledgements.add(h.id);
          return json({ handoff: h }, 202);
        }
        if (h.status !== "acceptance_unknown" || !h.runId || meta.runs.some(r => r.runId === h.runId) || owners.has(h.recipient.sessionId) || admitting.has(h.recipient.sessionId) || !availability(undefined, false).canSend) return json({ error: "Nonacceptance is not proven; reconcile the original native run without resending" }, 409);
        const retried = domain.advanceHandoff(h.id, h.revision, { status: "queued", retry: true, evidence: `App ${store.manifest.storeId} has no persisted run ${h.runId}; execution requires persisted run metadata before native submission` }, { actor: { kind: "system" }, correlationId: h.id });
        handoffReservations.delete(h.recipient.sessionId);
        return json({ handoff: retried }, 202);
      }
      if (path === "/api/workstreams" || path.startsWith("/api/workstreams/")) {
        // Host/Origin checks above have already accepted this exact request.
        return await authenticatedWorkstreamRoute(req, request => auth.authenticated(request) ? null : json({ error: "Authentication required" }, 401), async () => {
          const workspaceId = url.searchParams.get("workspaceId");
          if (!workspaceId) throw new WorkstreamAdapterError(400, "workspace-required", "Select a repository workspace");
          if (path === "/api/workstreams/inspect" && req.method === "GET") return router!.inspect(workspaceId);
          if (path === "/api/workstreams/init" && req.method === "POST") return router!.initialize(workspaceId);
          const operation = path.slice("/api/workstreams/".length);
          if (operation === "artifacts/catalog" || operation === "artifacts/list" || operation === "artifacts/read") {
            if (req.method !== "POST") throw new WorkstreamAdapterError(405, "method-not-allowed", "Method not allowed");
            const input = await body(req);
            validateWorkstreamInput(operation, input);
            const adapter = await router!.forWorkspace(workspaceId, input.repositoryId);
            if (operation === "artifacts/catalog") return adapter.documentCatalog(input.id);
            if (operation === "artifacts/list") return adapter.listArtifacts(input.id);
            return adapter.readArtifactSnapshot(input.id, input.path);
          }
          const workstreams = await router!.forWorkspace(workspaceId);
          if (path === "/api/workstreams/overview" && req.method === "GET") {
            if (!workspaceId) throw new WorkstreamAdapterError(400, "workspace-required", "Select a repository workspace");
            return workstreams.overview(meta.sessions.filter(s => catalog.association(s.sessionId).workspaceId === workspaceId));
          }
          if (path === "/api/workstreams" && req.method === "GET") return workstreams.list();
          if (req.method === "GET" && operation === "status") return workstreams.status(url.searchParams.get("id") ?? "");
          if (req.method !== "POST") throw new WorkstreamAdapterError(405, "method-not-allowed", "Method not allowed");
          const input = await body(req);
          if (operation === "artifacts/write") throw new WorkstreamAdapterError(405, "read-only-artifacts", "App workstream artifacts are read-only");
          if (operation === "manage") {
            if (!workspaceId) throw new WorkstreamAdapterError(400, "workspace-required", "Select a repository workspace");
            if (!input || !["associate", "phase/assign", "phase/end"].includes(input.operation)) throw new WorkstreamAdapterError(400, "invalid-request", "Unknown management action");
            validateWorkstreamInput(input.operation, { ...input, sessionId: "qualified-native-reference" });
            const target = input.ref && workstreams.appSessionId(input.ref, meta.sessions);
            const available = availability(target || undefined, false);
            if (!available.canSend) throw new WorkstreamAdapterError(409, "bridge-busy", available.reason!);
            return workstreams.manage(input.ref, input.operation, input);
          }
          validateWorkstreamInput(path === "/api/workstreams" ? "create" : operation, input);
          if (operation === "validate" || operation === "approve" || operation === "provide") {
            const action: WorkstreamAction = operation, actionInput = input as WorkstreamActionInput;
            let adapter = await router!.forWorkspace(workspaceId, actionInput.repositoryId);
            if (actionInput.sessionId !== undefined) {
              const session = meta.sessions.find(candidate => candidate.sessionId === actionInput.sessionId);
              if (!session) throw new WorkstreamAdapterError(404, "not-found", "Unknown App conversation");
              const admission = admissions.get(session.sessionId);
              if (!admission || admission.binding.workspaceId !== workspaceId || admission.binding.domain.mode !== "repository" || admission.binding.domain.repositoryId !== actionInput.repositoryId) throw new WorkstreamAdapterError(409, "repository-mismatch", "Conversation and requested repository differ");
              if (session.nativeSessionId !== admission.nativeId || session.authorityId !== admission.source.authorityId || adapter.reference(session).harness !== admission.source.descriptor.harness) throw new WorkstreamAdapterError(409, "invalid-app-reference", "Conversation native identity differs from its admission");
              await router!.execution(admission);
              adapter = await router!.forWorkspace(workspaceId, actionInput.repositoryId);
              if (adapter.invocation(session).workstream?.id !== actionInput.id) throw new WorkstreamAdapterError(409, "workstream-mismatch", "Conversation belongs to another workstream");
            }
            if (adapter.status(actionInput.id).workstream.revision !== actionInput.expectedRevision) throw new DomainError("CONFLICT", "Workstream changed; refresh its current state before retrying");
            if (action === "validate") {
              const result = await adapter.validate(actionInput.id, actionInput.phase);
              return { action, phase: actionInput.phase, ok: result.ok } satisfies WorkstreamActionResult;
            }
            // Gate and reserve synchronously: no run may start in this repository
            // while the existing core operation awaits validation/provisioning.
            assertLifecycleIdle(workspaceId, actionInput.repositoryId);
            lifecycleReservations.set(actionInput.repositoryId, workspaceId);
            try {
              if (action === "approve") await adapter.approve(actionInput.id, actionInput.phase, actionInput.approvalRef!, actionInput.expectedRevision);
              else await adapter.provide(actionInput.id, actionInput.phase, false, actionInput.expectedRevision);
              return { action, phase: actionInput.phase, ok: true } satisfies WorkstreamActionResult;
            } finally { lifecycleReservations.delete(actionInput.repositoryId); }
          }
           if (path === "/api/workstreams") return workstreams.create({ id: input.id, title: input.title, type: input.type, defaultCheckout: input.defaultCheckout });
          if (operation === "default-checkout") return workstreams.setDefaultCheckout(input.id, input.checkout);
          if (operation === "target") return workstreams.resolveTarget(input.id, input.phase, input.target);
          if (!["conversation", "associate", "phase/assign", "phase/end", "context"].includes(operation)) throw new WorkstreamAdapterError(404, "not-found", "Unknown workstream operation");
          const session = meta.sessions.find(s => s.sessionId === input.sessionId);
          if (!session) throw new WorkstreamAdapterError(404, "not-found", "Unknown App conversation");
          const admission = admissions.get(session.sessionId);
          if (!admission || admission.binding.workspaceId !== workspaceId) throw new WorkstreamAdapterError(409, "repository-mismatch", "Conversation belongs to another workspace");
          await router!.forAdmission(admission, workspaceId);
          if (operation === "conversation") return workstreams.conversation(session);
          if (operation === "context") return workstreams.invocation(session);
          const available = availability(session.sessionId, false);
          if (!available.canSend) throw new WorkstreamAdapterError(409, "bridge-busy", available.reason!);
          if (operation === "associate") return workstreams.associate(session, input.workstreamId);
          if (operation === "phase/assign") return workstreams.assignPhase(session, input.phase);
          return workstreams.endPhase(session, input.assignmentId);
        });
      }
      const terminalMatch = /^\/api\/workspaces\/([^/]+)\/worktrees\/([^/]+)\/terminal(?:\/(socket|close|restart))?$/.exec(path);
      if (terminalMatch) {
        const workspaceId = decodeURIComponent(terminalMatch[1]!), worktreeId = decodeURIComponent(terminalMatch[2]!), operation = terminalMatch[3];
        // No query-string credentials or mutable cwd/directory overrides.
        if (url.search) return json({ error: "Terminal routes do not accept query parameters", code: "terminal-query" }, 400);
        if (operation === "socket") {
          if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
          if (req.headers.get("origin") !== origin) return json({ error: "Origin rejected" }, 403);
          if (!upgrade || req.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "WebSocket upgrade required" }, 426);
          const token = auth.terminalToken(req);
          if (!token) return json({ error: "Authentication required" }, 401);
          const data = await terminals.prepare(workspaceId, worktreeId, token);
          if (closing || auth.terminalToken(req) !== token) { terminals.cancelUpgrade(data); return json({ error: "Attachment authorization changed" }, 401); }
          try { if (upgrade(req, data)) return undefined; } catch { terminals.cancelUpgrade(data); return json({ error: "WebSocket upgrade failed" }, 400); }
          terminals.cancelUpgrade(data); return json({ error: "WebSocket upgrade failed" }, 400);
        }
        if (!operation && req.method === "GET") {
          const token = auth.terminalToken(req), state = await terminals.get(workspaceId, worktreeId);
          if (!token || auth.terminalToken(req) !== token) return json({ error: "Authentication revoked" }, 401);
          return json(state);
        }
        if (req.method === "POST") {
          const token = auth.terminalToken(req), input = await body(req);
          return json(await terminals.change(workspaceId, worktreeId, operation === "close" ? "close" : operation === "restart" ? "restart" : "start", input, () => !closing && !!token && auth.terminalToken(req) === token));
        }
        return json({ error: "Method not allowed" }, 405);
      }
      if (path === "/api/navigation") {
        if (req.method === "GET") return json(catalog.getNavigation());
        if (req.method === "PUT") return json(await catalog.putNavigation(await body(req)));
        return json({ error: "Method not allowed" }, 405);
      }
      if (path === "/api/workspaces") {
        if (req.method === "GET") return json(await catalog.list());
        if (req.method === "POST") { const input = await body(req); return json(await catalog.register(input?.cwd), 201); }
        return json({ error: "Method not allowed" }, 405);
      }
      const aliasMatch = /^\/api\/workspaces\/([^/]+)\/worktrees\/([^/]+)\/alias$/.exec(path);
      if (aliasMatch) {
        try {
          if (req.method !== "PUT") return json({ error: "Method not allowed" }, 405);
          const workspaceId = decodeURIComponent(aliasMatch[1]!), worktreeId = decodeURIComponent(aliasMatch[2]!);
          const input = await body(req);
          return json({ workspace: await catalog.setAlias(workspaceId, worktreeId, input?.alias ?? null) });
        } catch (error) { const failure = workspaceError(error); return json({ error: failure.message, code: failure.code }, failure.status); }
      }
      const catalogMatch = /^\/api\/workspaces\/([^/]+)(?:\/worktrees\/([^/]+)(?:\/(list|file|copy|rename|git|diff|search|paths))?)?$/.exec(path);
      if (catalogMatch) {
        try {
          const workspaceId = decodeURIComponent(catalogMatch[1]!), worktreeId = catalogMatch[2] && decodeURIComponent(catalogMatch[2]), operation = catalogMatch[3];
          if (!worktreeId && req.method === "GET") return json(await catalog.get(workspaceId));
          const key = `${workspaceId}/${worktreeId}`, revision = url.searchParams.get("workspaceId") ?? url.searchParams.get("bindingRevision"), filePath = url.searchParams.get("path") ?? "";
          if (!operation && worktreeId && req.method === "GET") { const resolved = await worktrees.resolve(key); return json({ ...resolved, catalogWorkspaceId: workspaceId, worktreeId, bindingRevision: resolved.workspaceId }); }
          if (operation === "list" && req.method === "GET") return json(await worktrees.list(key, revision, filePath));
          if (operation === "file" && req.method === "GET") return json(await worktrees.file(key, revision, filePath));
          if (operation === "file" && req.method === "PUT") { const input = await body(req); return json(await worktrees.write(key, { ...input, workspaceId: input?.bindingRevision ?? input?.workspaceId })); }
          if (operation === "search" && req.method === "POST") {
            searches.assertOpen();
            const input = await body(req);
            return json(await searches.run(req.signal, signal => worktrees.search(key, { ...input, workspaceId: input?.bindingRevision ?? input?.workspaceId }, signal)));
          }
          if (operation === "paths" && req.method === "POST") {
            searches.assertOpen();
            const input = await body(req);
            const result = await searches.run(req.signal, signal => worktrees.paths(key, { ...input, workspaceId: input?.bindingRevision ?? input?.workspaceId }, signal));
            if (!auth.authenticated(req)) return json({ error: "Authentication revoked" }, 401);
            return json(result);
          }
          if ((operation === "file" && ["POST", "DELETE"].includes(req.method)) || (["copy", "rename"].includes(operation ?? "") && req.method === "POST")) {
            const input = await body(req), boundInput = { ...input, workspaceId: input?.bindingRevision ?? input?.workspaceId };
            if (operation === "copy") return json(await worktrees.copy(key, boundInput), 201);
            if (operation === "rename") return json(await worktrees.rename(key, boundInput));
            if (req.method === "POST") return json(await worktrees.create(key, boundInput), 201);
            return json(await worktrees.delete(key, boundInput));
          }
          if (operation === "git" && req.method === "GET") return json(await worktrees.status(key, revision));
          if (operation === "diff" && req.method === "GET") return json(await worktrees.diff(key, revision, filePath, url.searchParams.get("comparison") ?? ""));
          return json({ error: "Method not allowed" }, 405);
        } catch (error) { const failure = workspaceError(error); return json({ error: failure.message, code: failure.code }, failure.status); }
      }
      const workspaceMatch = /^\/api\/sessions\/([^/]+)\/workspace(?:\/(list|file|copy|rename|git|diff|search|paths))?$/.exec(path);
      if (workspaceMatch) {
        try {
          const sessionId = decodeURIComponent(workspaceMatch[1]!);
          const operation = workspaceMatch[2], workspaceId = url.searchParams.get("workspaceId"), filePath = url.searchParams.get("path") ?? "";
          if (!operation && req.method === "GET") return json(await workspace.resolve(sessionId));
          if (operation === "list" && req.method === "GET") return json(await workspace.list(sessionId, workspaceId, filePath));
          if (operation === "file" && req.method === "GET") return json(await workspace.file(sessionId, workspaceId, filePath));
          if (operation === "file" && req.method === "PUT") return json(await workspace.write(sessionId, await body(req)));
          if (operation === "search" && req.method === "POST") {
            searches.assertOpen();
            const input = await body(req);
            return json(await searches.run(req.signal, signal => workspace.search(sessionId, { ...input, workspaceId: input?.bindingRevision ?? input?.workspaceId }, signal)));
          }
          if (operation === "paths" && req.method === "POST") {
            searches.assertOpen();
            const input = await body(req);
            const result = await searches.run(req.signal, signal => workspace.paths(sessionId, { ...input, workspaceId: input?.bindingRevision ?? input?.workspaceId }, signal));
            if (!auth.authenticated(req)) return json({ error: "Authentication revoked" }, 401);
            return json(result);
          }
          if (operation === "file" && req.method === "POST") return json(await workspace.create(sessionId, await body(req)), 201);
          if (operation === "file" && req.method === "DELETE") return json(await workspace.delete(sessionId, await body(req)));
          if (operation === "copy" && req.method === "POST") return json(await workspace.copy(sessionId, await body(req)), 201);
          if (operation === "rename" && req.method === "POST") return json(await workspace.rename(sessionId, await body(req)));
          if (operation === "git" && req.method === "GET") return json(await workspace.status(sessionId, workspaceId));
          if (operation === "diff" && req.method === "GET") return json(await workspace.diff(sessionId, workspaceId, filePath, url.searchParams.get("comparison") ?? ""));
          return json({ error: "Method not allowed", code: "method-not-allowed" }, 405);
        } catch (error) { const failure = workspaceError(error); return json({ error: failure.message, code: failure.code }, failure.status); }
      }
      const modelsRoute = /^\/api\/harnesses\/([^/]+)\/models$/.exec(path);
      if (modelsRoute && req.method === "GET") {
        const descriptor = requireOperation(modelsRoute[1], "listModels");
        const cwd = resolve(url.searchParams.get("cwd") ?? options.cwd);
        return await dispatchHarness(descriptor.id, {
          "claude-code": () => { throw new HarnessOperationError("This harness has no live model catalog", 501, "unsupported-harness-operation"); },
          opencode: async () => json({ models: await oc.models(cwd) }),
        });
      }
      const workerCancel = /^\/api\/sessions\/([^/]+)\/workers\/cancel$/.exec(path);
      if (workerCancel && req.method === "POST") {
        const parentSessionId = workerCancel[1]!;
        if (!meta.sessions.some(s => s.sessionId === parentSessionId && !s.attachment)) return json({ error: "App parent session not found" }, 404);
        const input = await body(req);
        try {
          if (input.all === true && Object.keys(input).length === 1) return json(projectNativeWorkerReply({ workers: await workers.cancelForSession(parentSessionId, "all") }));
          const args = nativeWorkerInput("cancel", input);
          return json(projectNativeWorkerReply({ workers: await workers.cancelForSession(parentSessionId, args.ids, args.includeDescendants) }));
        } catch { return json({ error: "Cancellation requires {ids, includeDescendants?} within this parent's worker tree, or {all:true}. Inspect worker status before retrying.", code: "worker-cancel" }, 409); }
      }
      const handoffList = /^\/api\/sessions\/([^/]+)\/handoffs$/.exec(path);
      if (handoffList && req.method === "GET") {
        const listed = await handoffs.forSession(decodeURIComponent(handoffList[1]!));
        return json({ handoffs: listed.map(presentation => ({ ...presentation, ...(handoffProblems.has(presentation.handoff.id) ? { problem: handoffProblems.get(presentation.handoff.id) } : {}) })) });
      }
      const workerList = /^\/api\/sessions\/([^/]+)\/workers$/.exec(path);
      if (workerList && req.method === "GET") {
        if (!meta.sessions.some(s => s.sessionId === workerList[1])) return json({ error: "Unknown parent session" }, 404);
        return json({ workers: await Promise.all(workers.tree(workerList[1]!).map(w => workers.refresh(w))), deliveries: workerStore.deliveries().filter(d => d.parentSessionId === workerList[1]), continuationSuppressed: workerStore.suppressed(workerList[1]!) });
      }
      if (path === "/api/sessions" && req.method === "GET") {
        const workerSessions = new Map(workerStore.list().map(w => [w.sessionId, { id: w.id, parent: { sessionId: w.parent.sessionId, runId: w.parent.runId, toolCallId: w.parent.toolCallId } }]));
        const workerCounts = new Map<string, number>();
        for (const worker of workerStore.list()) workerCounts.set(worker.parent.sessionId, (workerCounts.get(worker.parent.sessionId) ?? 0) + 1);
        // Recovery never auto-sends a reserved prompt. Offer it as a composer
        // draft only while no first prompt run (including failed submissions) exists.
        const branchDrafts = new Map(branches.list().filter(op => op.state === "completed" && op.firstMessage && !op.firstRunId && !meta.runs.some(run => run.sessionId === op.destinationId && run.operation !== "compact")).map(op => [op.destinationId, op.firstMessage]));
        return json({ sessions: meta.sessions.map(s => ({ ...s, branchDraft: branchDrafts.get(s.sessionId), branchOrigin: branches.list().find(op => op.destinationId === s.sessionId && op.state !== "failed")?.sourceId, replacedBy: branches.replaced(s.sessionId)?.destinationId, ...(branches.replaced(s.sessionId) ? { hidden: true } : {}), ...(workerSessions.has(s.sessionId) ? { worker: workerSessions.get(s.sessionId) } : {}), directWorkerCount: workerCounts.get(s.sessionId) ?? 0, profileId: sessionProfileId(s), title: displayTitle(s), admission: admissions.get(s.sessionId), ...catalog.association(s.sessionId), availability: availability(s.sessionId) })), admissions: admissions.list(), availability: availability() });
      }
      const branchRoute = /^\/api\/sessions\/([^/]+)\/branch$/.exec(path);
      if (branchRoute) {
        const source = meta.sessions.find(s => s.sessionId === branchRoute[1]);
        if (!source) return json({ error: "Unknown source conversation" }, 404);
        if (req.method === "GET") {
          try {
            assertBranchIdle(source);
            const available = availability(source.sessionId); if (!available.canSend) throw new Error(available.reason);
            if (branches.pending(source.sessionId)) throw new Error("A branch is already being prepared for this conversation");
            const boundary = await branchBoundary(source, url.searchParams.get("runId") ?? undefined, url.searchParams.get("messageId") ?? undefined);
            const adapter = await branchDomain(source), state = adapter?.conversation(source) ? adapter.domain.branchState(adapter.reference(source)) : undefined;
            return json({ eligible: true, replaceRequired: !!state?.phases.length, ...boundary });
          } catch (error) { return json({ eligible: false, reason: error instanceof Error ? error.message : "Branch unavailable" }); }
        }
        if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
        const input = await body(req);
        if (!input || !uuid(input.requestId)) return json({ error: "A durable branch request ID is required" }, 400);
        if (input.runId !== undefined && !uuid(input.runId) || input.messageId !== undefined && (typeof input.messageId !== "string" || !/^msg_[a-zA-Z0-9_-]+$/.test(input.messageId))) return json({ error: "Invalid complete-turn selector" }, 400);
        const descriptor = requireOperation(sessionHarness(source), "branch");
        if (typeof input.prompt !== "string" || input.prompt.length > 100000 || typeof input.replace !== "boolean" || descriptor.policies.branchRequiresPrompt && !input.prompt.trim()) return json({ error: "Provide Replace original and a first message (required for this harness)" }, 400);
        const selector = input.runId ? `run:${input.runId}` : `message:${input.messageId ?? ""}`;
        const previous = branches.get(input.requestId);
        if (previous) {
          if (previous.sourceId !== source.sessionId || previous.selector !== selector || previous.replace !== input.replace || previous.firstMessage !== (input.prompt.trim() ? input.prompt : undefined)) return json({ error: "This branch request ID is already bound to a different request" }, 409);
          if (previous.state !== "failed" && meta.sessions.some(s => s.sessionId === previous.destinationId)) return json({ sessionId: previous.destinationId, operation: previous });
          return json({ error: previous.error ?? "This branch is still being prepared. Close this dialog and check your conversations.", operation: previous }, 409);
        }
        const available = availability(source.sessionId);
        if (!available.canSend) return json({ error: available.reason }, 409);
        assertBranchIdle(source);
        if (branchRequests.has(input.requestId)) return json({ error: "This branch request is already in progress. Please wait." }, 409);
        branchRequests.add(input.requestId);
        admitting.add(source.sessionId);
        const branchDone = Promise.withResolvers<void>(); attachmentTasks.add(branchDone.promise);
        let op: BranchOperation | undefined;
        try {
          const boundary = await branchBoundary(source, input.runId, input.messageId);
          const adapter = await branchDomain(source, true), state = adapter?.domain.branchState(adapter.reference(source));
          if (state?.phases.length && !input.replace) throw new Error("Active phase assignments require Replace original");
          op = { id: input.requestId, sourceId: source.sessionId, destinationId: crypto.randomUUID(), ...boundary, selector, replace: input.replace, state: "reserved", createdAt: new Date().toISOString(), ...(input.prompt.trim() ? { firstMessage: input.prompt } : {}) };
          branches.save(op);
          admitting.add(op.destinationId);
          if (adapter) adapter.domain.reserveBranch(adapter.reference(source), op.id, op.replace, branchContext(op.id));
          if (closing || storageFailed) throw new Error("Bridge is closing");
          // Recheck the exact native cutoff after the durable domain reservation.
          if (JSON.stringify(await branchBoundary(source, input.runId, input.messageId)) !== JSON.stringify(boundary)) throw new Error("Native history changed while reserving the branch");
          const beforeFork = () => { if (closing || storageFailed) throw new Error("Bridge unavailable before native fork"); op = { ...op!, state: "creation_unknown" }; branches.save(op); };
          const nativeId = await dispatchHarness(descriptor.id, {
            opencode: async () => (await oc.fork(source.nativeSessionId!, source.cwd, op!.boundary, op!.before, beforeFork)).id,
            "claude-code": async () => (await forkClaudeHistory(source.nativeSessionId!, source.cwd, op!.boundary, claudeRoot, beforeFork)).sessionId,
          });
          op = { ...op, nativeId, state: "confirmed" }; branches.save(op);
          const destination = await enrollBranch(op, source);
          await finishBranch(op.id);
          if (input.prompt.trim()) {
            const run: Run = { runId: crypto.randomUUID(), sessionId: destination.sessionId, cwd: destination.cwd, status: "running", createdAt: new Date().toISOString(), model: destination.model, effort: destination.effort, agent: destination.agent, agentKind: destination.agentKind, nativeAgentSelected: destination.nativeAgentSelected, profileId: sessionProfileId(destination), ...saneContextSnapshot(destination) };
            branches.save({ ...branches.get(op.id)!, firstRunId: run.runId });
            const done = Promise.withResolvers<void>(), accepted = Promise.withResolvers<boolean>();
            const owner: Owner = { run, native: sessionHarness(destination) === "opencode", done: done.promise, settled: false };
            owners.set(destination.sessionId, owner);
            if (owner.native) { run.nativeCommandId = `msg_${crypto.randomUUID().replaceAll("-", "")}`; run.nativePhase = "preparing"; }
            destination.lastRunId = run.runId; destination.lastStatus = "running"; meta.runs.push(run); events.set(run.runId, []);
            const effectivePrompt = owner.native && isStoredAssistantAgentId(destination.agent) && !destination.nativeAgentSelected ? `[SANE role: ${storedAssistantLabel(destination.agent)} assistant. Follow the SANE ${storedAssistantLabel(destination.agent)} assistant procedures for this conversation.]\n\n${input.prompt}` : input.prompt;
            void executePrompt(owner, effectivePrompt, true, accepted.resolve).catch(() => { failClosed(); accepted.resolve(false); }).finally(() => { owner.settled = true; releaseOwner(owner); done.resolve(); });
            await accepted.promise;
          }
          return json({ sessionId: destination.sessionId, operation: branches.get(op.id) }, 201);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Branch failed";
          if (op) {
            const current = branches.get(op.id)!;
            if (current.state === "reserved") {
              const adapter = await branchDomain(source);
              try { adapter?.domain.finishBranch(adapter.reference(source), null, op.id, branchContext(op.id)); branches.save({ ...current, state: "failed", error: message }); }
              catch { branches.save({ ...current, error: `${message}. The original remains locked until the branch can be checked.` }); }
            } else branches.save({ ...current, error: message });
          }
          return json({ error: message, operation: op && branches.get(op.id), sessionId: op?.nativeId ? op.destinationId : undefined }, 409);
        } finally { admitting.delete(source.sessionId); if (op) admitting.delete(op.destinationId); branchRequests.delete(input.requestId); branchDone.resolve(); attachmentTasks.delete(branchDone.promise); }
      }
      const branchRecovery = /^\/api\/branches\/([^/]+)\/recover$/.exec(path);
      if (branchRecovery && req.method === "POST") {
        const op = branches.get(branchRecovery[1]!);
        if (!op) return json({ error: "Unknown branch operation" }, 404);
        if (closing || storageFailed || meta.reconciliationRequired || owners.has(op.sourceId) || owners.has(op.destinationId) || admitting.has(op.sourceId) || admitting.has(op.destinationId)) return json({ error: "Branch recovery requires an available bridge and settled source/destination runs" }, 409);
        admitting.add(op.sourceId);
        admitting.add(op.destinationId);
        const recoveryDone = Promise.withResolvers<void>(); attachmentTasks.add(recoveryDone.promise);
        try {
          if (op.state === "reserved") {
            await releaseBranch(op, "Interrupted before native creation. Reservation released; original unchanged.");
          } else if (op.state !== "failed") await finishBranch(op.id);
          return json({ operation: branches.get(op.id), sessionId: branches.get(op.id)?.state === "completed" ? op.destinationId : undefined });
        } catch (error) {
          const current = branches.get(op.id)!, message = error instanceof Error ? error.message : "Recovery unavailable";
          branches.save({ ...current, error: message }); return json({ error: message, operation: branches.get(op.id) }, 409);
        } finally { admitting.delete(op.sourceId); admitting.delete(op.destinationId); recoveryDone.resolve(); attachmentTasks.delete(recoveryDone.promise); }
      }
      const admissionRoute = /^\/api\/sessions\/([^/]+)\/(enroll|retry-admission)$/.exec(path);
      if (admissionRoute && req.method === "POST") {
        const sessionId = admissionRoute[1]!, session = meta.sessions.find(s => s.sessionId === sessionId);
        if (!session) return json({ error: "Unknown conversation" }, 404);
        if (closing || storageFailed || owners.has(sessionId) || admitting.has(sessionId)) return json({ error: "Conversation unavailable" }, 409);
        admitting.add(sessionId);
        try {
          if (admissionRoute[2] === "enroll") await admissions.enroll(sessionId);
          const pending = admissions.get(sessionId)!;
          // Do not confuse uncertain creation with same-known-identity retry.
          if (!pending.nativeId) return json({ error: "Native creation identity is unknown; operator inspection required", code: "native_creation_unknown" }, 409);
          if (session.harness === "opencode") await oc.assertIdle(pending.nativeId, pending.binding.executionCheckout);
          else if (!(await readClaudeHistory(pending.nativeId, pending.binding.executionCheckout, claudeRoot)).length && pending.operation !== "create") return json({ error: "Native history unavailable" }, 409);
          await admissions.register(sessionId); await persist(); admissions.ready(sessionId);
          return json({ admission: admissions.get(sessionId) });
        } finally { admitting.delete(sessionId); }
      }
      if (path === "/api/sessions/attach" && req.method === "POST") {
        const input = await body(req);
        const harness = input?.harness, nativeSessionId = input?.nativeSessionId, cwd = input?.cwd;
        if (!isHarness(harness) || (harness === "claude-code" ? !uuid(nativeSessionId) : typeof nativeSessionId !== "string" || !/^ses[a-zA-Z0-9_-]{1,200}$/.test(nativeSessionId)) || typeof cwd !== "string" || !isAbsolute(cwd) || cwd.includes("\0")) return json({ error: "Provide harness, valid native session ID and absolute execution directory" }, 400);
        requireOperation(harness, "attachHistory");
        const key = `${harness}:${nativeSessionId}`;
        let session = meta.sessions.find(s => (s.harness ?? "claude-code") === harness && (s.nativeSessionId ?? s.sessionId) === nativeSessionId);
        if (session && session.attachment?.state !== "pending") return json({ error: "Native conversation is already attached", sessionId: session.sessionId }, 409);
        if (session && session.cwd !== cwd) return json({ error: "Attachment execution directory cannot change" }, 409);
        if (attaching.has(key)) return json({ error: "Attachment is already in progress" }, 409);
        const available = availability();
        if (!available.canSend) return json({ error: available.reason }, available.code === "capacity" ? 429 : 409);
        const sessionId = session?.sessionId ?? crypto.randomUUID();
        if (meta.sessions.some(s => s.sessionId === sessionId && s !== session)) return json({ error: "App session identity collision" }, 409);
        attaching.add(key); admitting.add(sessionId);
        const attachmentDone = Promise.withResolvers<void>(); attachmentTasks.add(attachmentDone.promise);
        try {
          if (await realpath(cwd) !== cwd) throw new OpenCodeError("Use the canonical native execution directory", 409);
          const discovered = await catalog.discover(cwd);
          if (discovered.root !== cwd || !discovered.commonDir) throw new OpenCodeError("Attachment requires the actual repository checkout root", 409);
          if (input.workspaceId !== undefined || input.worktreeId !== undefined) {
            if (typeof input.workspaceId !== "string" || typeof input.worktreeId !== "string" || (await catalog.binding(input.workspaceId, input.worktreeId)).cwd !== cwd) throw new OpenCodeError("Selected worktree differs from native execution directory", 409);
          }
          const catalogSelection = await catalog.register(cwd);
          if (!admissions.get(sessionId)) await admissions.begin({ sessionId, operation: "attach", harness: harness === "opencode" ? "oc" : "cc", nativeId: nativeSessionId, cwd, workspaceId: catalogSelection.workspaceId, worktreeId: catalogSelection.worktreeId });
          const candidate: Session = session ?? { sessionId, nativeSessionId, authorityId: nativeSource(harness), harness, cwd, lastStatus: "unknown", lastRunId: null, attachment: { state: "pending", source: nativeSource(harness) } };
          const native = await readNativeHistory(harness, nativeSessionId, cwd);
          if (!native.messages.length) throw new OpenCodeError("Native transcript is empty; nothing attached", 409);
          if (native.activity === "active") throw new OpenCodeError("Native conversation is active or has pending input; finish it in OpenCode before attaching", 409);
          if (closing || storageFailed) throw new OpenCodeError("Bridge unavailable", 503);
          // Durable intent precedes cross-store registration. A crash/failure leaves
          // a visible, non-executable pending row; explicit same-identity retry only.
          if (!session) { session = candidate; meta.sessions.push(session); }
          session.attachment = { state: "pending", source: nativeSource(harness) }; await persist();
          const history: ReconciledHistory = { sessionId, nativeSessionId, importedAt: new Date().toISOString(), ...native, coveredRunIds: [], reason: harness === "opencode" ? "Attached read-only native snapshot; activity is a point-in-time observation. Reconcile after external work." : "Attached read-only native transcript; active execution and run outcome are unknown. Confirm external assistant execution is stopped before each SANE submission." };
          await enqueue(async () => saveNativeHistory(history));
          const association = await catalog.associate(sessionId, cwd, input.workspaceId, input.worktreeId);
          if (closing || storageFailed) throw new OpenCodeError("Attachment interrupted by shutdown; retry explicitly", 503);
          await admissions.register(sessionId);
          session.attachment = { state: "ready", source: nativeSource(harness) }; await persist();
          admissions.ready(sessionId);
          return json({ sessionId, nativeSessionId, harness, ...association, history }, 201);
        } catch (error) {
          if (session?.attachment) { session.attachment = { ...session.attachment, state: "pending", error: error instanceof Error ? error.message : "Attachment failed" }; if (!storageFailed) await persist().catch(() => {}); }
          return json({ error: error instanceof Error ? error.message : "Attachment unavailable", ...(session ? { sessionId, attachment: "pending", recovery: "Retry Attach with the same identity and cwd after resolving the error. No prompt was sent." } : {}) }, error instanceof OpenCodeError || error instanceof WorkstreamAdapterError || error instanceof WorkspaceError ? error.status : error instanceof DomainError && error.code !== "STORAGE_ERROR" ? 409 : 503);
        } finally { attaching.delete(key); admitting.delete(sessionId); attachmentDone.resolve(); attachmentTasks.delete(attachmentDone.promise); }
      }
      const compactRoute = /^\/api\/sessions\/([^/]+)\/compact$/.exec(path);
      if (compactRoute) {
        const session = meta.sessions.find(s => s.sessionId === compactRoute[1]);
        if (!session) return json({ error: "Unknown session" }, 404);
        if (req.method === "GET") return json({ sessionId: session.sessionId, eligibility: await compactEligibility(session), ...await compactOperations(session) });
        if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
        const input = await body(req);
        if (!validCompactRequest(input)) return json({ error: "Provide a UUID requestId and optional compaction instructions/nativeStopped acknowledgement only" }, 400);
        const previous = meta.runs.find(r => r.sessionId === session.sessionId && r.operation === "compact" && r.compact?.requestId === input.requestId);
        if (previous) {
          if (previous.compact!.instructions !== input.instructions) return json({ error: "This compaction request ID is already bound to different instructions" }, 409);
          // Repeated requests do not recheck idle/acknowledgement or dispatch.
          // This also closes the publication window of an in-flight admission.
          await serial;
          if (storageFailed) return json({ error: "Storage unavailable; original request must be reconciled without resending" }, 503);
          const state = await compactOperations(session);
          return json({ sessionId: session.sessionId, runId: previous.runId, operation: state.operations.find(op => op.runId === previous.runId && op.requestId === input.requestId)! } satisfies CompactResponse);
        }
        const key = `${session.sessionId}:${input.requestId}`, pending = compactAdmissions.get(key);
        if (pending) {
          if (pending.instructions !== input.instructions) return json({ error: "This compaction request ID is already bound to different instructions" }, 409);
          return json(await pending.promise, 202);
        }
        const promise = admitCompact(session, input);
        compactAdmissions.set(key, { instructions: input.instructions, promise });
        try { return json(await promise, 202); }
        finally { if (compactAdmissions.get(key)?.promise === promise) compactAdmissions.delete(key); }
      }
      if (path === "/api/sessions" && req.method === "POST") {
        const input = await body(req);
        if (!input || typeof input.prompt !== "string" || !input.prompt.trim() || (input.cwd !== undefined && typeof input.cwd !== "string") || (input.sessionId !== undefined && typeof input.sessionId !== "string")) return json({ error: "Invalid request" }, 400);
        if (compactCommand(input.prompt)) return json({ error: "Use the dedicated Compact action for /compact; it requires an existing idle conversation and a durable request ID", code: "compact-action-required" }, 400);
        // Reject a supplied unknown/null harness even when a profile subsequently
        // overrides legacy selection fields. Only actual omission is compatible.
        if (input.harness !== undefined) validateHarness(input.harness);
        let session = input.sessionId ? meta.sessions.find(s => s.sessionId === input.sessionId) : undefined;
        if (input.sessionId !== undefined && !session) return json({ error: "Unknown session" }, 404);
        // Agent profile selection: resolves harness/model/effort/agent and wins
        // over the legacy fields. Existing sessions only accept a Base -> assistant upgrade.
        // Legacy `agent` on a follow-up goes through the same transition rules as its template.
        if (session && input.profileId === undefined && isAssistantAgentId(input.agent)) input.profileId = templateProfileId(input.agent);
        if (session?.agent === "knowledge" && input.profileId === undefined && input.agent === "knowledge") input.profileId = sessionProfileId(session);
        if (input.profileId !== undefined && typeof input.profileId !== "string") return json({ error: "Invalid request" }, 400);
        const profile = input.profileId !== undefined ? agentProfiles.profiles.find(p => p.id === input.profileId) : undefined;
        // An unchanged archival reference is a resume, never a selectable profile.
        const historical = session && input.profileId === sessionProfileId(session) ? historicalAgentProfile(session) : undefined;
        if (input.profileId !== undefined && !profile && !historical) return json({ error: "Unknown agent profile" }, 400);
        let upgrade: AgentProfile | undefined;
        if (profile && !session) {
          const check = canAssign(undefined, profile); if (!check.ok) return json({ error: check.reason }, 400);
          const launch = resolveAgentLaunch(profile);
          Object.assign(input, { harness: launch.harness, model: launch.model, effort: launch.effort, agent: launch.identity?.role });
        } else if (profile && session) {
          const currentId = sessionProfileId(session);
          if (profile.id !== currentId) {
            const current = agentProfiles.profiles.find(p => p.id === currentId) ?? { kind: session.agent ? "assistant" as const : "base" as const, harness: session.harness ?? "claude-code" };
            const check: { ok: boolean; reason?: string } = profile.hidden ? { ok: false, reason: "Hidden agent" } : canAssign(current, profile);
            if (!check.ok) return json({ error: check.reason === "Different harness" ? "Session harness cannot change" : "Session agent cannot change", reason: check.reason }, 400);
            upgrade = profile;
          }
          Object.assign(input, { harness: undefined, model: undefined, effort: undefined, agent: undefined });
        } else if (historical) {
          Object.assign(input, { harness: undefined, model: undefined, effort: undefined, agent: undefined });
        }
        const harness = validateHarness(input.harness !== undefined ? input.harness : session?.harness, { defaultHarness: "claude-code" });
        const descriptor = requireOperation(harness, "prompt");
        if (session && sessionHarness(session) !== harness) return json({ error: "Session harness cannot change" }, 400);
        if (session?.attachment && descriptor.policies.attachedSendRequiresNativeStopped && input.nativeStopped !== true) return json({ error: "External assistant activity is unknown. Explicitly acknowledge external execution is stopped before each SANE submission.", code: "native-acknowledgement-required" }, 409);
        if (input.model !== undefined && !validModel(input.model)) return json({ error: "Invalid model ID" }, 400);
        if (input.effort !== undefined && !(descriptor.policies.effortMode === "model-variant" ? validVariant(input.effort) : validEffort(input.effort))) return json({ error: descriptor.policies.effortMode === "model-variant" ? "Invalid native variant ID" : "effort must be low, medium, high, xhigh, or max" }, 400);
        if (input.agent !== undefined && !isAssistantAgentId(input.agent)) return json({ error: "Unknown agent" }, 400);
        if (session && session.agent !== undefined && input.agent !== undefined && session.agent !== input.agent) return json({ error: "Session agent cannot change" }, 400);
        if (harness === "opencode" && input.model !== undefined) oc.model(input.model, input.effort);
        // Conversation-level defaults: an omitted follow-up inherits the stored
        // selection instead of silently dropping to native default. Stored values
        // were validated when first sent, so only shape-check an inherited OC model.
        let model = upgrade ? upgrade.model || undefined : input.model ?? session?.model;
        let effort = upgrade ? upgrade.effort || undefined : input.effort ?? session?.effort;
        const agent = upgrade ? upgrade.role ?? undefined : input.agent ?? session?.agent;
        if (harness === "opencode" && input.model === undefined && model !== undefined) oc.model(model, effort);
        const selectedBinding = !session && input.cwd === undefined && typeof input.workspaceId === "string" && typeof input.worktreeId === "string" ? await catalog.binding(input.workspaceId, input.worktreeId) : undefined;
        const cwd = resolve(input.cwd ?? session?.cwd ?? selectedBinding?.cwd ?? options.cwd);
        try { if (!(await stat(cwd)).isDirectory()) throw 0; } catch { return json({ error: "cwd must be an existing directory" }, 400); }
        if (session && session.cwd !== cwd) return json({ error: "Session cwd cannot change" }, 400);
        // Resolve before admitting a native creation so configuration errors are not
        // mistaken for an unknown POST outcome. Existing sessions are never reselected.
        const nativeLaunch = harness === "opencode" && !session ? await oc.resolveLaunch(cwd, { model, effort, ...(isAssistantAgentId(agent) ? { agent: nativeAgentId({ kind: "assistant", role: agent }, harness) } : {}) }) : undefined;
        if (nativeLaunch?.model) {
          model = input.model = `${nativeLaunch.model.providerID}/${nativeLaunch.model.id}`;
          effort = input.effort = nativeLaunch.model.variant;
        }
        const conversationId = session?.sessionId ?? crypto.randomUUID();
        const available = availability(conversationId);
        if (!available.canSend) return json({ error: available.reason, code: available.code }, available.code === "capacity" ? 429 : 409);
        admitting.add(conversationId);
        try {
        if (session) await execution(session.sessionId);
        const association = await catalog.associate(conversationId, cwd, input.workspaceId, input.worktreeId);
        const resume = !!session;
        if (!session) {
          if (association.association !== "resolved") throw new WorkstreamAdapterError(409, "association-unresolved", "Execution association unavailable");
          await admissions.begin({ sessionId: conversationId, operation: "create", harness: harness === "opencode" ? "oc" : "cc", cwd, nativeId: harness === "opencode" ? null : crypto.randomUUID(), workspaceId: association.workspaceId, worktreeId: association.worktreeId });
          if (harness === "opencode") await admissions.createNative(conversationId, async () => (await oc.createResolved(cwd, nativeLaunch!)).id);
          const a = admissions.get(conversationId)!;
          const sane = input.agent !== undefined ? saneSessionContext({ kind: "assistant", role: input.agent }) : {};
          if (harness === "opencode" && sane.saneContext) await oc.bindSaneContext(a.nativeId!, sane.saneContext.version, saneContextText(sane.saneContext));
          session = { sessionId: conversationId, harness, nativeSessionId: a.nativeId!, authorityId: a.source.authorityId, cwd, lastStatus: "unknown", lastRunId: null, ...(input.model !== undefined ? { model: input.model } : {}), ...(input.effort !== undefined ? { effort: input.effort } : {}), ...(input.agent !== undefined ? { agent: input.agent, agentKind: "assistant", nativeAgentSelected: true, ...sane } : {}), ...(profile ? { profileId: profile.id } : {}) };
          meta.sessions.push(session); await persist();
          await admissions.register(conversationId);
          admissions.ready(conversationId);
        }
        if (session?.harness === "opencode") await oc.assertIdle(session.nativeSessionId!, cwd);
        if (lifecycleReserved(conversationId)) throw new WorkstreamAdapterError(409, "workstream-action-pending", "A repository phase action is in progress");
        if (closing || storageFailed || meta.reconciliationRequired) return json({ error: "Bridge unavailable" }, 409);
        // Update stored defaults on every send carrying them; an omitted
        // follow-up never erases them (the run below inherits them instead).
        if (input.model !== undefined) session.model = input.model;
        if (input.effort !== undefined) session.effort = input.effort;
        // First assignment persists; later sends inherit. Never erased by omission.
        if (input.agent !== undefined && session.agent === undefined) { session.agent = input.agent; if (session.profileId !== undefined) session.profileId = legacyProfileId(harness, input.agent); }
        if (upgrade) {
          session.profileId = upgrade.id; session.agent = upgrade.role ?? undefined;
          if (upgrade.model) session.model = upgrade.model; else delete session.model;
          if (upgrade.effort) session.effort = upgrade.effort; else delete session.effort;
          await persist();
        }
        // First prompt becomes the durable list title for untitled sessions
        // (handoff `<Role> #<n>` titles already set stay untouched).
        if (!session.title) {
          const firstTitle = titleFromPrompt(input.prompt);
          if (firstTitle) { session.title = firstTitle; await persist(); }
        }
        workerStore.suppress(conversationId, false); // Explicit user submission resumes automatic continuation eligibility.
        const run: Run = { runId: crypto.randomUUID(), sessionId: conversationId, cwd, status: "running", createdAt: new Date().toISOString(), ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}), ...(agent !== undefined ? { agent, agentKind: session.agentKind, nativeAgentSelected: session.nativeAgentSelected } : {}), profileId: sessionProfileId(session), ...saneContextSnapshot(session) };
        const finished = Promise.withResolvers<void>();
        const accepted = Promise.withResolvers<boolean>();
        const owner: Owner = { run, native: harness === "opencode", done: finished.promise, settled: false };
        owners.set(conversationId, owner);
        if (harness === "opencode") {
          run.nativeCommandId = `msg_${crypto.randomUUID().replaceAll("-", "")}`; run.nativePhase = "preparing";
        }
        session.lastRunId = run.runId; session.lastStatus = "running"; meta.runs.push(run); events.set(run.runId, []);
        // Preserve legacy OC framing only where real agent selection was not established.
        const effectivePrompt = isStoredAssistantAgentId(agent) && harness === "opencode" && !session.nativeAgentSelected
          ? `[SANE role: ${storedAssistantLabel(agent)} assistant. Follow the SANE ${storedAssistantLabel(agent)} assistant procedures for this conversation.]\n\n${input.prompt}`
          : input.prompt;
        // Install the complete lifecycle promise before any asynchronous work.
        void executePrompt(owner, effectivePrompt, resume, accepted.resolve).catch(async () => {
          failClosed(); await terminate(owner); accepted.resolve(false);
        }).finally(() => { owner.settled = true; releaseOwner(owner); finished.resolve(); });
        if (!(await accepted.promise)) return json({ error: owner.launchError ?? "Run could not start; operator reconciliation may be required" }, 503);
        return json({ sessionId: run.sessionId, runId: run.runId, harness, nativeSessionId: session.nativeSessionId, ...association }, 202);
        } finally { admitting.delete(conversationId); }
      }
      const transcript = /^\/api\/sessions\/([^/]+)\/transcript(?:\/(meta|refresh))?$/.exec(path);
      if (transcript) {
        const session = meta.sessions.find(s => s.sessionId === transcript[1]);
        if (!session) return json({ error: "Unknown session" }, 404);
        try {
          if (!transcript[2] && req.method === "GET") return json(await transcripts.page(session, url.searchParams));
          if (transcript[2] === "meta" && req.method === "GET") return json(await transcripts.metadataPage(session, url.searchParams));
          if (transcript[2] === "refresh" && req.method === "POST") {
            if (url.searchParams.size) return json({ error: "Refresh does not accept query selectors", code: "transcript-input" }, 400);
            let input: unknown;
            try { input = await body(req); } catch { return json({ error: "Invalid refresh body", code: "transcript-input" }, 400); }
            return json(await transcripts.refresh(session, input as import("./transcript-contract").TranscriptRefreshRequest));
          }
          return json({ error: "Method not allowed" }, 405);
        } catch (error) {
          if (error instanceof TranscriptError) return json({ error: error.message, code: error.code }, error.status);
          throw error;
        }
      }
      const reconciliation = /^\/api\/sessions\/([^/]+)\/(reconcile|native-history)$/.exec(path);
      if (reconciliation) {
        const session = meta.sessions.find(s => s.sessionId === reconciliation[1]);
        if (!session) return json({ error: "Unknown session" }, 404);
        requireOperation(sessionHarness(session), "readHistory");
        if (reconciliation[2] === "native-history" && req.method === "GET") {
          return json({ history: await storedNativeHistory(session) ?? null });
        }
        if (reconciliation[2] !== "reconcile" || req.method !== "POST") return json({ error: "Method not allowed" }, 405);
        const available = availability(session.sessionId);
        if (!available.canSend) return json({ error: available.reason }, available.code === "capacity" ? 429 : 409);
        admitting.add(session.sessionId);
        try {
          await execution(session.sessionId);
          const nativeSessionId = session.nativeSessionId ?? session.sessionId;
          const native = await readNativeHistory(sessionHarness(session), nativeSessionId, session.cwd);
          if (!native.messages.length) return json({ error: "Native transcript is empty; previous history preserved" }, 409);
          if (closing || storageFailed) return json({ error: "Bridge unavailable" }, 503);
          const history: ReconciledHistory = { sessionId: session.sessionId, nativeSessionId, importedAt: new Date().toISOString(), ...native,
            coveredRunIds: coveredNativeRuns(session, meta.runs, native.messages),
            reason: session.harness === "opencode" ? "Read-only native history snapshot. Activity is a point-in-time observation; Reconcile again for later changes. Stop external work in OpenCode." : "Read-only native transcript. Active execution, message timestamps and run outcome are not exposed by the SDK history API. Ensure external assistant execution is stopped before sending here." };
          await enqueue(async () => saveNativeHistory(history));
          return json({ history });
        } catch (error) { return json({ error: error instanceof Error ? error.message : "Native reconciliation unavailable" }, error instanceof OpenCodeError && error.status === 409 ? 409 : 503); }
        finally { admitting.delete(session.sessionId); }
      }
      const interactionMatch = /^\/api\/sessions\/([^/]+)\/interactions(?:\/([^/]+)\/reply)?$/.exec(path);
      const cancelMatch = /^\/api\/sessions\/([^/]+)\/cancel$/.exec(path);
      if (interactionMatch || cancelMatch) {
        const session = meta.sessions.find(s => s.sessionId === (interactionMatch ?? cancelMatch)![1]);
        if (!session) return json({ error: "Unknown session" }, 404);
        if (cancelMatch && req.method === "POST") {
          requireOperation(sessionHarness(session), "cancelOwnedRun");
          const currentOwner = owners.get(session.sessionId);
          if (currentOwner) requireOwnedOperation({ sessionId: session.sessionId, harness: sessionHarness(session) }, currentOwner, "cancelOwnedRun");
          if (closing || storageFailed) return json({ error: "Bridge unavailable; cancellation state must be checked in the native harness" }, 503);
          workerStore.suppress(session.sessionId, true); // Persist even when the parent is already idle. Never cascade.
          const worker = workerStore.getBySession(session.sessionId);
          if (worker && !worker.outcome) workerStore.update(worker.id, { state: "cancelling", cancelRequestedAt: worker.cancelRequestedAt ?? new Date().toISOString() });
          const owner = owners.get(session.sessionId);
          if (!owner) return json({ interrupted: false, status: session.lastStatus, reason: "No active App-owned run; external execution must be stopped in its native harness" });
          if (!owner.cancel) {
          owner.cancelling = true;
          owner.cancel = (async () => {
            owner.stopRequested = true;
            if (owner.run.status === "running") await emit(owner.run, "status", { status: "running", connection: "stopping", reason: "Stop requested; waiting for terminal evidence" });
            if (owners.get(session.sessionId) !== owner || owner.run.status !== "running") return { interrupted: false };
            if (owner.native) return ocRuns.interruptCurrent(owner);
            const stopped = await terminate(owner);
            return { interrupted: stopped };
          })().finally(() => { owner.cancelling = false; releaseOwner(owner); });
          }
          const attempt = owner.cancel;
          try { return json(await attempt); }
          catch (error) {
            // An explicit retry is allowed after an ambiguous network failure;
            // concurrent requests still share the same in-flight attempt.
            if (owner.cancel === attempt) owner.cancel = undefined;
            if (owner.run.status === "running") await emit(owner.run, "status", { status: "running", connection: "unconfirmed", reason: "Stop acknowledgement unavailable; execution state remains unconfirmed" });
            throw error;
          }
        }
        const descriptor = getHarnessDescriptor(sessionHarness(session))!;
        if (!descriptor.operations.listInteractions.supported) return interactionMatch && req.method === "GET" ? json({ interactions: [] }) : json({ error: "This harness's one-shot mode does not support this operation" }, 501);
        if (interactionMatch && !interactionMatch[2] && req.method === "GET") {
          requireOperation(descriptor.id, "listInteractions");
          return json({ interactions: await oc.interactions(session.nativeSessionId!) });
        }
        if (interactionMatch?.[2] && req.method === "POST") {
          const reply = await body(req);
          if (!reply || (reply.type !== "permission" && reply.type !== "question")) return json({ error: "Invalid interaction reply type" }, 400);
          requireOperation(descriptor.id, reply.type === "permission" ? "permissionReply" : "questionReply");
          await oc.reply(session.nativeSessionId!, decodeURIComponent(interactionMatch[2]), reply); return json({ ok: true });
        }
        return json({ error: "Method not allowed" }, 405);
      }
      const visibilityMatch = /^\/api\/sessions\/([^/]+)\/(hide|unhide)$/.exec(path);
      if (visibilityMatch && req.method === "POST") {
        // Soft-delete: the sidebar hides the conversation, but history rows,
        // runs, logs, admissions and catalog associations are retained and the
        // conversation stays fully usable (runs, handoffs, navigation).
        const session = meta.sessions.find(s => s.sessionId === visibilityMatch[1]);
        if (!session) return json({ error: "Unknown conversation" }, 404);
        session.hidden = visibilityMatch[2] === "hide";
        await persist();
        return json({ ok: true, sessionId: session.sessionId, hidden: session.hidden });
      }
      const runsMatch = /^\/api\/sessions\/([^/]+)\/runs$/.exec(path);
      if (runsMatch && req.method === "GET") { if (!meta.sessions.some(s => s.sessionId === runsMatch[1])) return json({ error: "Unknown session" }, 404); return json({ runs: meta.runs.filter(r => r.sessionId === runsMatch[1]) }); }
      const eventMatch = /^\/api\/runs\/([^/]+)\/events$/.exec(path);
      if (eventMatch && req.method === "GET") { const run = meta.runs.find(r => r.runId === eventMatch[1]); if (!run) return json({ error: "Unknown run" }, 404); const after = Number(url.searchParams.get("after") ?? 0); if (!Number.isSafeInteger(after) || after < 0) return json({ error: "Invalid cursor" }, 400); const list = events.get(run.runId)!.filter(e => e.seq > after); return json({ events: list, nextCursor: list.at(-1)?.seq ?? after, status: run.status }); }
      if (path === "/api/sessions/search" && req.method === "GET") {
        // Best-effort message-body search over in-memory event logs plus
        // persisted native-history snapshots. Metadata filters always work
        // client-side even when this endpoint returns no body hits.
        // Bounds: query 1-200 chars, ≤200 sessions, ≤20 recent runs/session,
        // ≤500 recent events/run, ≤50 results. Tool/reasoning parts stripped.
        const q = (url.searchParams.get("q") ?? "").trim();
        if (!q) return json({ results: [] });
        if (q.length > 200) return json({ error: "Query too long" }, 400);
        const limitRaw = Number(url.searchParams.get("limit") ?? 20);
        const limit = Number.isSafeInteger(limitRaw) ? Math.min(50, Math.max(1, limitRaw)) : 20;
        const workspaceFilter = url.searchParams.get("workspaceId"), worktreeFilter = url.searchParams.get("worktreeId");
        const lowered = q.toLowerCase();
        const snippetFor = (text: string): string | null => {
          const at = text.toLowerCase().indexOf(lowered);
          if (at < 0) return null;
          const start = Math.max(0, at - 60), end = Math.min(text.length, at + q.length + 60);
          return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`.slice(0, 240);
        };
        const textOf = (data: unknown): string[] => {
          if (typeof data === "string") return data.length <= 20000 ? [data] : [];
          if (!data || typeof data !== "object" || Array.isArray(data)) return [];
          const record = data as Record<string, any>;
          // Submission events carry {messageId, text}; message snapshots carry parts.
          if (typeof record.text === "string" && typeof record.messageId === "string") return record.text.length <= 20000 ? [record.text] : [];
          if (Array.isArray(record.parts)) {
            const out: string[] = [];
            for (const part of record.parts) {
              if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string" && part.text.length <= 20000) out.push(part.text);
            }
            return out;
          }
          if (record.message && typeof record.message === "object") return textOf(record.message);
          if (Array.isArray(record.content)) {
            const out: string[] = [];
            for (const part of record.content) {
              if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") out.push(part.text);
            }
            return out;
          }
          if (record.type === "result" && typeof record.result === "string") return [record.result];
          if (typeof record.prompt === "string") return [record.prompt];
          return [];
        };
        const results: { sessionId: string; runId?: string; snippet: string; score: number }[] = [];
        const sessions = meta.sessions.slice(-200);
        for (const session of sessions) {
          if (results.length >= limit) break;
          const association = catalog.association(session.sessionId);
          if (workspaceFilter && association.workspaceId !== workspaceFilter) continue;
          if (worktreeFilter && association.worktreeId !== worktreeFilter) continue;
          // Title hits are metadata; body endpoint still surfaces one snippet.
          if (session.title && snippetFor(session.title)) {
            results.push({ sessionId: session.sessionId, snippet: snippetFor(session.title)!, score: 0.9 });
            if (results.length >= limit) break;
          }
          const runs = meta.runs.filter(r => r.sessionId === session.sessionId).slice(-20);
          for (const run of runs) {
            if (results.length >= limit) break;
            const list = (events.get(run.runId) ?? []).slice(-500);
            for (const event of list) {
              if (results.length >= limit) break;
              if (event.kind !== "submission" && event.kind !== "message" && event.kind !== "stdout") continue;
              for (const text of textOf(event.data)) {
                const snippet = snippetFor(text);
                if (snippet) {
                  // Earlier runs rank lower; title-adjacent score stays highest.
                  const score = event.kind === "submission" ? 0.8 : 0.5;
                  results.push({ sessionId: session.sessionId, runId: run.runId, snippet, score });
                  break;
                }
              }
              // One hit per event keeps the cap meaningful across long logs.
              if (results.length && results.at(-1)?.runId === run.runId && results.at(-1)?.sessionId === session.sessionId) {
                // Allow multiple events per run but stop scanning this run after 3 hits.
                if (results.filter(r => r.runId === run.runId).length >= 3) break;
              }
            }
          }
          if (results.length >= limit) break;
          // Attached/reconciled native snapshots not yet covered by run events.
          try {
            const history = await storedNativeHistory(session);
            const messages = history?.messages.slice(-100) ?? [];
            for (const message of messages) {
              if (results.length >= limit) break;
              for (const text of textOf(message)) {
                const snippet = snippetFor(text);
                if (snippet) { results.push({ sessionId: session.sessionId, snippet, score: 0.4 }); break; }
              }
              if (results.filter(r => r.sessionId === session.sessionId && !r.runId).length >= 2) break;
            }
          } catch { /* Missing snapshot: in-memory events are the source. */ }
        }
        return json({ results: results.slice(0, limit) });
      }
      if (/^\/api\/(?:runs|sessions)\/[^/]+\/input$/.test(path) && req.method === "POST") return json({ error: "One-shot mode does not support interactive input" }, 501);
      if (path.startsWith("/api/")) return json({ error: "Not found" }, 404);
      if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "Method not allowed" }, 405);
      let file: string;
      if (path === "/") return new Response(req.method === "HEAD" ? null : indexHtml, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
      else {
        let assetPath: string;
        try { assetPath = decodeURIComponent(path); } catch { return json({ error: "Not found" }, 404); }
        if (!assetPath.startsWith("/assets/") || assetPath.includes("\\") || assetPath.includes("\0") || assetPath.split("/").slice(2).some(part => !part || part.startsWith("."))) return json({ error: "Not found" }, 404);
        const assetsRoot = assetsDir;
        file = resolve(assetsRoot, assetPath.slice("/assets/".length));
        if (!file.startsWith(assetsRoot + "/")) return json({ error: "Not found" }, 404);
        try {
          const canonicalRoot = await realpath(assetsRoot);
          file = await realpath(file);
          if (!file.startsWith(canonicalRoot + "/")) return json({ error: "Not found" }, 404);
        } catch { return json({ error: "Not found" }, 404); }
      }
      try { if (!(await stat(file)).isFile()) return json({ error: "Not found" }, 404); }
      catch { return json({ error: "Not found" }, 404); }
      const asset = Bun.file(file);
      return new Response(req.method === "HEAD" ? null : asset, { headers: { "content-type": asset.type, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    } catch (error) { return error instanceof HarnessOperationError || error instanceof WorkstreamAdapterError ? json({ error: error.message, code: error.code }, error.status) : error instanceof DomainError ? json({ error: error.message, code: error.code }, error.code === "NOT_FOUND" ? 404 : 409) : error instanceof WorkspaceError ? json({ error: error.message, code: error.code }, error.status) : error instanceof OpenCodeError ? json({ error: error.message }, [400, 404, 409].includes(error.status) ? error.status : 503) : json({ error: "Invalid request" }, 400); }
  }
  const server = Bun.serve<TerminalSocketData>({ hostname: options.host, port: options.port, maxRequestBodySize: 1024 * 1024, websocket: terminals.websocket, fetch: (req, srv) => handle(req, srv, (request, data) => srv.upgrade(request, { data })) });
  let hookServer: Bun.Server<undefined>;
   try { hookServer = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 1024 * 1024, fetch: async (req, srv) => new URL(req.url).pathname === "/native/workers" ? (loopback(srv.requestIP(req)?.address ?? "") ? nativeWorker(req) : json({ error: "Forbidden" }, 403)) : new URL(req.url).pathname === "/native/handoffs" ? nativeHandoff(req) : new URL(req.url).pathname.startsWith("/hooks/") ? (await handle(req, srv)) ?? json({ error: "Not found" }, 404) : json({ error: "Not found" }, 404) }); }
  catch (error) { await server.stop(true); throw error; }
  origin = options.publicOrigin ?? `http://${options.host.includes(":") ? `[${options.host}]` : options.host}:${server.port}`;
  try { atomicAppRecord(options.dataDir, "native-handoff.json", { version: 1, url: `http://127.0.0.1:${hookServer.port}/native/handoffs`, token: handoffToken, pid: process.pid }); }
  catch (error) { await server.stop(true); await hookServer.stop(true); throw error; }
  // Start recovery only after both listeners are acquired. A port-bind failure
  // must not leave observers writing after startup releases the ownership lock.
  for (const recovering of meta.runs.filter(r => r.status === "running" && getHarnessDescriptor(sessionHarness(meta.sessions.find(s => s.sessionId === r.sessionId)!))!.operations.recoverRun.supported)) {
    const descriptor = requireOperation(sessionHarness(meta.sessions.find(s => s.sessionId === recovering.sessionId)!), "recoverRun");
    const finished = Promise.withResolvers<void>();
    const owner: Owner = { run: recovering, native: descriptor.nativeHarness === "oc", done: finished.promise, settled: false }; owners.set(recovering.sessionId, owner);
    void Promise.resolve().then(() => dispatchOwnedOperation(ownedSession(owner), owner, "recoverRun", {
      "claude-code": () => { throw new HarnessOperationError("Claude process ownership cannot be recovered", 501, "unsupported-harness-operation"); },
      opencode: () => recovering.operation === "compact" ? ocRuns.recoverNativeCompact(owner) : recovering.nativePhase === "preparing" ? ocRuns.finishNative(owner, "failed", "Bridge restarted before native submission") : ocRuns.monitorNative(owner),
    }))
      .catch(() => { failClosed(); }).finally(async () => { owner.settled = true; releaseOwner(owner); finished.resolve(); const w = workerStore.getByRun(recovering.runId); if (w && !storageFailed) { try { await workers.refresh(w); } catch { failClosed(); } } });
  }
  // Recover selection only from the native identity recorded by admission. Never replay a creation or prompt.
  for (const w of workers.active()) {
    const a = admissions.get(w.sessionId);
    if (!meta.runs.some(r => r.runId === w.runId && r.sessionId === w.sessionId) && a?.nativeId && w.launch.harness === "opencode") {
      try {
        const selected = await oc.recoverLaunch(a.nativeId, w.checkout, w.launch.agent!);
        workerStore.update(w.id, { state: "uncertain", child: { harness: "oc", authorityId: a.source.authorityId, nativeId: a.nativeId }, launch: { ...w.launch, ...(selected?.model ? { model: `${selected.model.providerID}/${selected.model.id}`, effort: selected.model.variant } : {}) }, error: "Native selection recovered; reconciling admission and run-publication evidence without resubmitting" });
      } catch (e) { workerStore.update(w.id, { state: "uncertain", error: e instanceof Error ? e.message : "Native selection recovery unavailable" }); }
    }
    await workers.refresh(workerStore.get(w.id)!);
  }
  let closePromise: Promise<void> | undefined;
  for (const w of (await catalog.list()).workspaces.filter(w => w.kind === "repository")) {
    try { for (const h of await handoffs.listForPolling(w.workspaceId)) if (h.recipient.ownerId === store.manifest.storeId && !["queued", "completed", "failed"].includes(h.status)) handoffReservations.add(h.recipient.sessionId); } catch {}
  }
  // Startup-only reconciliation, after run ownership and worker recovery are known.
  // The admission locks and attachment task set also coordinate request/shutdown races.
  for (const op of branches.list()) void reconcileBranch(op).catch(() => { failClosed(); });
  const handoffTimer = setInterval(() => {
    if (closing || storageFailed || handoffTask) return;
    handoffTask = consumeHandoffs().catch(() => { failClosed(); }).finally(() => { handoffTask = undefined; });
  }, 500);
  const workerOutboxTimer = setInterval(() => {
    if (closing || storageFailed || workerOutboxTask) return;
    workerOutboxTask = consumeWorkerReports().catch(() => { failClosed(); }).finally(() => { workerOutboxTask = undefined; });
  }, 500);
  return { origin, port: server.port, workers, workerOutbox, handoffs, prepareHandoffRecipient, close() {
    if (closePromise) return closePromise;
    closing = true;
    const searchDrain = searches.close();
    clearInterval(handoffTimer);
    clearInterval(workerOutboxTimer);
    closePromise = (async () => {
    try { await workers.drainLaunches(); } catch { failClosed(); }
    await workerOutboxTask;
    await handoffTask;
    await Promise.all(handoffDispatches.values());
    await terminals.close();
    if (attachmentTasks.size) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const attachmentsDrained = await Promise.race([Promise.all([...attachmentTasks]).then(() => true), new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), 12000); })]);
      clearTimeout(timeout);
      if (!attachmentsDrained) failClosed();
    }
    await Promise.all([...owners.values()].map(async owner => {
    if (owner.native) {
      // Let any outstanding bounded HTTP request finish before releasing local
      // storage ownership. This waits for the adapter, never for native work.
       const detached = await Promise.race([Promise.all([owner.done, owner.cancel?.catch(() => {})]).then(() => true), Bun.sleep(12000).then(() => false)]);
      if (!detached) retainOwner = true;
    }
    if (owner && !owner.native) {
      // execute checks closing after every prelaunch await; no future spawn is
      // possible even if preparation outlives this bounded shutdown.
      if (owner.child) await terminate(owner);
      const done = await Promise.race([owner.done.then(() => true), Bun.sleep(3000).then(() => false)]);
      if (!done || (owner.child && groupAlive(owner))) { retainOwner = true; meta.reconciliationRequired = true; }
    }
    }));
    if (retainOwner && !storageFailed) {
      // Best effort only: ownership remains if storage is broken or blocked.
      await Promise.race([persist().catch(() => { failClosed(); }), Bun.sleep(500)]);
    }
    const flushed = await Promise.race([serial.then(() => true), Bun.sleep(500).then(() => false)]);
    if (!flushed) retainOwner = true;
    // Search promises include evaluator reap and all active read finally blocks.
    // If resource cleanup cannot settle, retain ownership without classifying a
    // read-only cancellation as a catalog/metadata storage failure.
    if (!await drainWorkspaceSearches(searchDrain)) retainOwner = true;
    await server.stop(true); await hookServer.stop(true);
    await flushAndCloseWorkstreams(() => catalog.flush(), () => router?.close(), () => { retainOwner = true; });
    if (retainOwner) throw new Error("Shutdown did not drain safely; ownership retained. Explicit reconciliation required after process exit.");
    })();
    return closePromise;
  } };
  } catch (error) {
    if (!await drainWorkspaceSearches(searches.close())) retainOwner = true;
    try { await router?.close(); } catch { retainOwner = true; }
    if (retainOwner) retainOwnership();
    throw error;
  }
}
