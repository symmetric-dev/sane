import { readFile, writeFile, rename, appendFile, stat, readdir, realpath, open } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { BridgeAuth, validateBridgeAuthOptions } from "./bridge-auth";
import { body, equal, json, loopback } from "./bridge-http";
import { ClaudeRunService, hookEvents } from "./claude-run-service";
import { projectClaudeFollowups } from "./claude-followup-projection";
import { resolveAppConfig } from "./app-config";
import { buildAssets, validateAssets } from "./asset-build";
import { acquireInstallation, acquireData, validateOwnershipPaths, type OwnershipHandle } from "./installation-ownership";
import { claudeSourceRoot } from "./claude-source";
import { decodeLog, validCompactRequest, uuid, efforts, type SaneSessionContext, type Session, type Run, type Event, type Metadata } from "./history";
import { projectCompactions } from "./compaction";
import type { CompactEligibility, CompactRequest, CompactResponse } from "./oc-contract";
import { OpenCodeAdapter, OpenCodeError, OpenCodeSourceMismatchError, OpenCodeUnavailableError } from "./opencode";
import { OpenCodeRunService, type FrameworkDelivery } from "./opencode-run-service";
import { OpenCodeObservationService } from "./opencode-observation-service";
import { OC_REPLY_ACTIVATION_BLOCKED, OpenCodeReplyIntegration } from "./opencode-reply-integration";
import type { OpenCodeReplyQualification } from "./opencode-reply-observer";
import { ConversationUpdateStore } from "./conversation-update-store";
import { ConversationUpdates } from "./conversation-updates";
import { createClaudeUpdateState, projectClaudeCommittedEvent, type ClaudeConversationUpdateState } from "./claude-conversation-updates";
import { conversationUpdateRoute } from "./conversation-update-routes";
import { ChromePushService } from "./chrome-push";
import { updateSourceKey } from "../shared/conversation/conversation-updates";
import type { RunOwner as Owner } from "./run-owner";
import { ConversationCoordinator, type ConversationAdmissionLease, type ConversationOperationIntent, type ConversationReadinessOptions } from "./conversation-coordinator";
import { sessionListProjection, SessionListReadinessScope, type SessionListProjection } from "./session-list-projection";
import { sessionDisplayTitle, sessionListResponse, type SessionListRow } from "./session-list-response";
import { workerObservationEvidence } from "./worker-observation-evidence";
import { HarnessDispatchRegistry, HarnessDispatchError, DispatchProofUnavailableError, createClaudeDispatchAdapter, createOpenCodeDispatchAdapter, sameDispatchSource, type DispatchLifecycleHooks } from "./harness-dispatch";
import type { DispatchOrigin, DispatchSource, DispatchIdentity, DispatchEvidenceHooks } from "../shared/conversation/dispatch-contract";
import type { PreparedAdmissionContext, PreparedAdmissionOptions, PreparedInputAdmission } from "./prepared-input-admission";
import { synchronousDispatchHook } from "./dispatch-evidence";
import { PendingInputService, pendingInputRoute, type PendingInputPreflight } from "./pending-input-service";
import { createPendingInputRecovery, createOriginalRecoveryJournal, type PendingInputRecovery } from "./pending-input-recovery";
import { PendingInputDomainError, PendingInputStorageError, type PendingInputPins, type PendingInputStoredItem } from "./pending-input-contract";
import { createPendingInputBridge, type PendingInputBridge } from "./pending-input-bridge";
import { createPendingInputWake, type PendingInputWake, type PendingInputWakeClock, type PendingInputWakeKind } from "./pending-input-wake";
import { createPendingInputControls } from "./pending-input-controls";
import { assertPendingInputDomainMutation, assertDomainInitializationIdle, chainInRepository } from "./pending-input-domain-guard";
import { equal as equalPendingPin } from "./prepared-input-codec";
import { decodePendingInputPins } from "./pending-input-codec";
import { prepareUserInput, revalidatePreparedUserInput, assertPreparedUserInputCurrent, UserInputPreparationError, type PreparedUserInput } from "./user-input-preparation";
import { WorkspaceService, WorkspaceError, workspaceError } from "./workspace";
import { CatalogService } from "./catalog";
import { WorkspaceCreationService } from "./workspace-creation";
import { TerminalService, type TerminalSocketData } from "./terminal";
import { RepositoryRouter, RepositoryStoreError, WorkstreamAdapterError, authenticatedWorkstreamRoute, validateWorkstreamInput, flushAndCloseWorkstreams } from "./workstreams";
import type { WorkstreamAction, WorkstreamActionInput, WorkstreamActionResult } from "./workstreams-contract";
import { validateAppStore, assertSourceConfiguration, atomicAppRecord, atomicNativeHistory, loadAgentProfiles, validateAgentProfiles, AppStoreError, type SourceConfiguration } from "./app-store";
import { builtinProfiles, legacyProfileId, storedAssistantLabel, resolveAssistantProfile, BASE_PROFILE_IDS, type AgentProfile, type AgentProfiles } from "./agent-profiles-contract";
import { AdmissionService } from "./admission";
import { HandoffService, handoffRecipientTitle, projectHandoffEnqueue, projectHandoffStatus, slotSessionIndex } from "./handoff";
import { DomainError, canonicalSlot, equivalentSlots, normalizeNativeSource, revalidateCheckout, discoverRepository, inspectRepositoryStore } from "sane-core/server";
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
import { agentLaunchSnapshot, claudeAgentSettings, saneContextSnapshot, saneContextText, saneFrameworkMessageId, saneSessionContext, saneSessionText, sha256, workerAssignment } from "./agent-launch";
import { readClaudeHistory, forkClaudeHistory, verifyClaudeFork, coveredNativeRuns, type ReconciledHistory } from "./reconcile";
import { BranchStore, type BranchOperation } from "./branches";
import { NativeHistoryCache, TranscriptError, TranscriptService } from "./transcript-service";
import { NativeSubagentError, NativeSubagentService } from "./native-subagent-service";
import { capabilitiesFor, getHarnessDescriptor, isHarness } from "../shared/conversation/harness-capabilities";
import { isClaudeRootRecord } from "../shared/conversation/cc-scope";
import { HarnessOperationError, dispatchHarness, dispatchOwnedOperation, requireOperation, requireOwnedOperation, validateHarness } from "./harness-operations";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export { hookEvents };
export type Options = { host: string; port: number; cwd: string; dataDir: string; claudeBin: string; nativeSources: SourceConfiguration; allowRemote: boolean; publicOrigin?: string; reconcileInterrupted: boolean; maxConcurrentRuns?: number; maxWorkersPerCheckout?: number; packageDir?: string; noBuild?: boolean; /** Internal deterministic fixture dependency; never parsed from CLI/config/HTTP. */ pendingInputWakeClock?: PendingInputWakeClock; /** Trusted backend evidence; activation remains disabled in this preparation phase. */ openCodeReplyQualifications?: readonly OpenCodeReplyQualification[] };
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
  // Failed drain requires ownership even when BOTH durable retained-state
  // writes fail. Latch before either write; handle.retain() alone only guards
  // release after a successful write. No later cleanup attempt may unlatch it.
  let retentionRequired = false;
  let storageOwnershipHeld = false;
  const retain = () => {
    retentionRequired = true;
    try { data?.retain(); } finally { installation.retain(); }
  };
  const release = () => {
    if (retentionRequired) return;
    storageOwnershipHeld = false;
    data?.release(); installation.release();
  };
  const failOwnershipPublication = () => {
    // Fence the actual inner writer before cleanup; neither a broken fence hook
    // nor failed retained-state writes may clear the outer ownership latch.
    try { bridge?.failOwnershipPublication(); } catch { /* Preserve the publication error. */ }
    try { retain(); } catch { /* Both handles were attempted; the latch survives. */ }
  };
  const publishOwnership = (phase: "serving" | "draining", listener?: { host: string; port: number }) => {
    try {
      synchronousDispatchHook(() => installation.update(phase, listener));
      synchronousDispatchHook(() => data!.update(phase, listener));
    } catch (error) { failOwnershipPublication(); throw error; }
  };
  try {
    data = acquireData(installation, { phase: "starting", reconcileInterrupted: options.reconcileInterrupted });
    storageOwnershipHeld = true;
    options = { ...options, dataDir: paths.dataDir! };
    assertSourceConfiguration(validateAppStore(options.dataDir).sources, options.nativeSources);
    installation.update("build");
    const assets = options.noBuild ? validateAssets({ packageDir: paths.packageDir }) : await buildAssets({ packageDir: paths.packageDir, ownership: installation });
    installation.update("starting");
    bridge = await startOwned(options, assets.assetsDir, paths.packageDir, retain, () => storageOwnershipHeld && !retentionRequired);
    const listener = { host: options.host, port: bridge.port! };
    publishOwnership("serving", listener);
    // Trusted activation only after classification, dependencies, timers and BOTH
    // listener-bound ownership records have been installed. Never an HTTP toggle.
    bridge.startPendingInputWake();
    const running = bridge;
    let closing: Promise<void> | undefined;
    return { origin: running.origin, port: running.port, workers: running.workers, workerOutbox: running.workerOutbox, preparedInput: running.preparedInput, pendingInputs: running.pendingInputs, pendingInputConsumer: running.pendingInputConsumer, pendingInputWake: running.pendingInputWake, close() {
      return closing ??= (async () => {
        try { publishOwnership("draining"); await running.close(); }
        catch (error) {
          if (retentionRequired) { try { await running.abortStartup(); } catch { /* Already latched. */ } }
          else { try { retain(); } catch { /* Preserve the original shutdown error. */ } }
          throw error;
        }
        release();
      })();
    } };
  } catch (error) {
    // Publication of the serving ownership records can fail after startOwned
    // returns. Use the same bounded listener-first abort as inner startup errors,
    // not normal shutdown (which may reject before reaching listener teardown).
    if (bridge) { try { await bridge.abortStartup(); } catch { if (!retentionRequired) { try { retain(); } catch { /* Preserve the original startup error. */ } } } }
    release(); throw error;
  }
}
async function startOwned(options: Options, assetsDir: string, packageDir: string, retainOwnership: () => void, ownsStorage: () => boolean) {
  const indexHtml = await readFile(join(packageDir, "public", "index.html"), "utf8");
  const maxConcurrentRuns = options.maxConcurrentRuns ?? 24;
  if (!Number.isSafeInteger(maxConcurrentRuns) || maxConcurrentRuns < 1 || maxConcurrentRuns > 256) throw new Error("max-concurrent-runs must be an integer from 1 to 256");
  const maxWorkersPerCheckout = options.maxWorkersPerCheckout ?? DEFAULT_MAX_WORKERS_PER_CHECKOUT;
  if (!Number.isSafeInteger(maxWorkersPerCheckout) || maxWorkersPerCheckout < 1 || maxWorkersPerCheckout > 256) throw new Error("maxWorkersPerCheckout must be an integer from 1 to 256");
  const store = validateAppStore(options.dataDir);
  // Capture the original lock-owned App directory/manifest before startup awaits.
  const originalJournals = createOriginalRecoveryJournal(options.dataDir, store.manifest.storeId);
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
  let closing = false, storageFailed = false, startupReady = false;
  let pendingInputs: PendingInputService | undefined;
  let pendingInputBridge: PendingInputBridge | undefined;
  let pendingInputRecovery: PendingInputRecovery | undefined;
  let pendingInputWake: PendingInputWake | undefined;
  const queueServiceTasks = new Set<Promise<void>>();
  const queueAdmissionTasks = new Set<Promise<void>>();
  let classifyingPendingInputs = false;
  // Original strict store records, never reconstructed from mutable run metadata.
  // No ordinary owner release, native idle or operator CLI acknowledgement clears
  // this process's recovered uncertainty. Original-identity reconciliation is separate.
  let recoveredInputClaims: readonly PendingInputStoredItem[] = [];
  const recoveredInputConversations = new Set<string>();
  function classifyPendingInputMutation<T>(action: () => T): T {
    if (classifyingPendingInputs || startupReady || closing || storageFailed) throw new PendingInputDomainError("pending-input-owner-unavailable", "Startup queue classification ownership unavailable", 503);
    classifyingPendingInputs = true;
    try { return action(); } finally { classifyingPendingInputs = false; }
  }
  function assertStartupReady() {
    if (!startupReady || closing) throw new WorkstreamAdapterError(503, "startup-classifying", "Startup execution classification is incomplete; no mutation was admitted");
  }
  const boundListenerStops: (() => Promise<void>)[] = [];
  let drainStartupExecution: (() => Promise<void>) | undefined;
  let stopStartupConsumers: (() => void) | undefined;
  async function boundedStartupCleanup(cleanup: () => unknown | Promise<unknown>) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([
      Promise.resolve().then(cleanup).then(() => true, () => false),
      new Promise<boolean>(done => { timeout = setTimeout(() => done(false), 12000); }),
    ]);
    clearTimeout(timeout);
    if (!completed) retainOwner = true;
  }
  let router: RepositoryRouter | undefined;
  let updateService: ConversationUpdates<ClaudeConversationUpdateState> | undefined;
  let replyIntegration: OpenCodeReplyIntegration | undefined;
  let chromePush: ChromePushService | undefined;
  const searches = createWorkspaceSearchLifecycle();
  let workspaceCreations: WorkspaceCreationService | undefined;
  async function abortStartup() {
    closing = true;
    pendingInputWake?.close();
    pendingInputRecovery?.close();
    const queueDrain = pendingInputBridge?.close();
    stopStartupConsumers?.();
    // Stop EVERY acquired listener first, even if one stop rejects. Cleanup is
    // bounded and failures retain both locks; nothing may serve unlocked after
    // post-bind recovery, publication, or observer startup fails.
    await Promise.all(boundListenerStops.map(stop => boundedStartupCleanup(stop)));
    await boundedStartupCleanup(() => drainStartupExecution?.());
    await boundedStartupCleanup(() => queueDrain);
    await Promise.all([
      () => chromePush?.close(), () => workspaceCreations?.close(),
      () => replyIntegration?.close(), () => updateService?.close(), () => searches.close(),
    ].map(cleanup => boundedStartupCleanup(cleanup)));
    await boundedStartupCleanup(() => router?.close());
    await boundedStartupCleanup(() => Promise.all([...queueServiceTasks, ...queueAdmissionTasks]));
    pendingInputBridge?.closeObservations();
    pendingInputRecovery?.closeObservations();
    if (retainOwner) retainOwnership();
  }
  try {
  const metadataPath = join(options.dataDir, "metadata.json");
  const meta: Metadata = store.metadata;
  // Qualified reply evidence captures durable metadata on its own coalesced
  // queue. Disabled production reads the live catalog only for default coverage.
  const replyJournalThrough = new Map<string, number>();
  let agentProfiles: AgentProfiles = loadAgentProfiles(options.dataDir);
  const catalog = new CatalogService(options.dataDir, () => meta.sessions);
  for (const session of meta.sessions) if (session.attachment && session.attachment.source !== nativeSource(session.harness)) throw new Error("Attached native authority source changed; restore the original native store/service configuration");
  await catalog.load();
  workspaceCreations = await WorkspaceCreationService.open(options.dataDir, catalog, [options.dataDir, join(packageDir, ".runtime"), claudeRoot]);
  // Artifacts are readable only through the domain API, even when its state is
  // outside App data. Use a canonical root for both ordinary Code entry points.
  router = new RepositoryRouter(catalog, store.sources, {
    beforeMutation: (domain, input) => {
      assertDomainMutationOpen();
      assertPendingInputDomainMutation(pendingInputs?.store.readRecords().conversations ?? [], domain, input);
      if (input.kind !== "create" && lifecycleReservations.has(domain.repositoryId)) throw new WorkstreamAdapterError(409, "workstream-action-pending", "A repository phase action is in progress");
    },
    beforeInitialize: (workspaceId, discovery) => {
      assertDomainMutationOpen();
      assertDomainInitializationIdle(pendingInputs?.store.readRecords().conversations ?? [], workspaceId, discovery);
      if ([...lifecycleReservations.values()].some(scope => scope.commonDir === discovery.commonDir)) throw new WorkstreamAdapterError(409, "workstream-action-pending", "A repository phase action is in progress");
    },
    beforeLifecycle: domain => {
      assertDomainMutationOpen();
      const scope = { workspaceId: "", commonDir: domain.context.commonDir, roots: [domain.primaryCheckout, domain.context.invocationCheckout.path] };
      assertLifecycleIdle(scope.workspaceId, domain.repositoryId, scope);
      lifecycleReservations.set(domain.repositoryId, scope);
      return () => { if (lifecycleReservations.delete(domain.repositoryId)) notifyPendingInput("domain"); };
    },
    mutationFailed: failClosed,
  });
  const admissions = new AdmissionService(options.dataDir, store.admissions, store.sources, catalog, router);
  const workerStore = new WorkerStore(options.dataDir);
  const branches = new BranchStore(options.dataDir);
  const branchRequests = new Set<string>();
  const executionContext = async (sessionId: string) => { const a = admissions.get(sessionId); if (!a) throw new WorkstreamAdapterError(409, "admission-missing", "Conversation has no durable admission"); return router!.execution(a); };
  const execution = async (sessionId: string) => (await executionContext(sessionId)).executionCheckout;
  const saneSession = async (sessionId: string) => saneSessionText(meta.sessions.find(s => s.sessionId === sessionId)!, await executionContext(sessionId));
  // Acknowledged at OC creation, before any run exists; the session's first run journals it.
  const frameworkDeliveries = new Map<string, FrameworkDelivery>();
  const deliverSaneFramework = async (nativeId: string, sessionId: string, context: SaneSessionContext) => {
    const messageId = saneFrameworkMessageId(sessionId), text = saneContextText(context);
    await oc.deliverSaneFramework(nativeId, messageId, text);
    frameworkDeliveries.set(sessionId, { messageId, sha256: sha256(text), chars: text.length });
  };
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
  const updateStore = new ConversationUpdateStore(options.dataDir, store.manifest.storeId);
  updateStore.load(); // Optional derived storage: failure never blocks execution.
  const updateEligible = (session: Session, run?: Run) => session.agentKind !== "worker" && !workerStore.getBySession(session.sessionId) && run?.operation !== "compact";
  const updates = updateService = new ConversationUpdates(updateStore, {
    projector: { createState: createClaudeUpdateState, project: projectClaudeCommittedEvent },
    bootstrap: () => ({ activeRunIds: meta.runs.filter(run => run.status === "running" && updateEligible(meta.sessions.find(session => session.sessionId === run.sessionId)!, run)).map(run => run.runId), sourceBaselines: replyIntegration?.sourceBaselines() ?? [] }),
    coverage: () => [...meta.sessions.filter(session => updateEligible(session) && session.harness !== "opencode").map(session => ({
      sourceKey: updateSourceKey({ harness: session.harness!, authorityId: session.authorityId!, nativeSessionId: session.nativeSessionId! }),
      state: "ready" as const,
      reason: "App-owned Claude Code results only; external activity is not observed",
    })), ...(replyIntegration?.coverage() ?? [])],
  });
  const nativeSubagents = new NativeSubagentService(() => meta.sessions, () => meta.runs, id => events.get(id) ?? []);
  const nativeHistories = new NativeHistoryCache(options.dataDir);
  const nativeObservations = new OpenCodeObservationService(oc);
  const observedHistory = { get: (session: Session) => session.harness === "opencode" ? nativeObservations.get(session) : nativeHistories.get(session) };
  const transcripts = new TranscriptService(() => meta.sessions, () => meta.runs, observedHistory, async (session, kind, id) => {
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
  const startupObservations = new Map<string, Run>();
  const sessionListReadiness = new SessionListReadinessScope();
  const coordinator: ConversationCoordinator<Owner> = new ConversationCoordinator<Owner>({
    maxConcurrentRuns,
    isClosing: () => closing,
    startupReady: () => startupReady,
    retained: () => retainOwner,
    observationAdmission: owner => {
      if (storageFailed) return { ready: false, code: "storage-unavailable", reason: "Storage unavailable; operator reconciliation required" };
      const run = owner.run, session = meta.sessions.find(s => s.sessionId === run.sessionId), a = admissions.get(run.sessionId);
      if (startupObservations.get(run.sessionId) !== run || !owner.native || run.status !== "running" || !run.nativeCommandId
        || !["preparing", "sending", "accepted"].includes(run.nativePhase ?? "") || session?.harness !== "opencode"
        || !session.nativeSessionId || session.authorityId !== nativeSource("opencode") || session.cwd !== run.cwd
        || !a || a.source.descriptor.harness !== "oc" || a.nativeId !== session.nativeSessionId
        || a.source.authorityId !== session.authorityId || a.binding.executionCheckout !== session.cwd) {
        return { ready: false, code: "observation-unproven", reason: "Exact startup OpenCode run and source binding are not proven" };
      }
      return { ready: true };
    },
    externalOccupancy: () => sessionListReadiness.current?.occupancy ?? [
      ...recoveredInputConversations,
      ...handoffDispatches.keys(),
      ...meta.runs.filter(run => run.status === "running").map(run => run.sessionId),
      ...workerStore.list().filter(w => !w.outcome).map(w => w.sessionId),
      ...workerStore.deliveriesToReconcile().map(d => d.parentSessionId),
    ],
    policy: options => readinessPolicy(options, sessionListReadiness.current),
    canRetainPredecessor: owner => claudeRuns.canQueueFollowup(owner),
    wake: { dispatch: () => {
      // A failed private queue claim releases its transient lease. Do not feed
      // that notification back into its own scheduler. Foreign changes during
      // this bounded pass are reconsidered by lifecycle hints/the 15s backstop.
      if (!pendingInputBridge?.isReconsidering()) notifyPendingInput("capacity");
    }, onError: failClosed },
  });
  // Read-only projections for existing domain observers; all mutation authority
  // belongs to the coordinator and exact admission leases below.
  const owners = { get: (id: string) => coordinator.getOwner(id), has: (id: string) => coordinator.hasOwner(id),
    keys: () => coordinator.ownerSessionIds(), values: () => coordinator.owners() };
  const admitting = { has: (id: string) => coordinator.hasAdmission(id), [Symbol.iterator]: () => coordinator.admissionSessionIds() };
  function reserve(intent: ConversationOperationIntent, ...conversationIds: string[]): ConversationAdmissionLease {
    const result = coordinator.reserveAdmission({ intent, conversationIds });
    if (!result.ready) throw new WorkstreamAdapterError(result.code === "capacity" ? 429 : 409, result.code, result.reason);
    return result.lease;
  }
  function installOwner(lease: ConversationAdmissionLease, owner: Owner) {
    const result = coordinator.installOwner(lease, owner);
    if (!result.ready) throw new WorkstreamAdapterError(result.code === "capacity" ? 429 : 409, result.code, result.reason);
  }
  const historyRefreshes = new Map<string, string>();
  const attaching = new Set<string>();
  const attachmentTasks = new Set<Promise<void>>();
  const queuedInputTasks = new Set<Promise<void>>();
  const dispatchTasks = new Set<Promise<void>>();
  const handoffReservations = new Set<string>();
  const handoffAcknowledgements = new Set<string>();
  const handoffDispatches = new Map<string, Promise<void>>();
  const lifecycleReservations = new Map<string, { workspaceId: string; commonDir: string; roots: readonly string[] }>();
  function assertDomainMutationOpen() {
    assertStartupReady();
    if (storageFailed || retainOwner || meta.reconciliationRequired) throw new WorkstreamAdapterError(503, "storage-unavailable", "App mutation ownership is unavailable");
  }
  function lifecycleReserved(sessionId: string) {
    const admission = admissions.get(sessionId), workspaceId = catalog.association(sessionId).workspaceId;
    if (admission?.binding.domain.mode === "repository" && lifecycleReservations.has(admission.binding.domain.repositoryId)) return true;
    if ([...lifecycleReservations.values()].some(scope => workspaceId && workspaceId === scope.workspaceId
      || admission?.binding.checkoutPin?.commonDir === scope.commonDir
      || scope.roots.includes(admission?.binding.executionCheckout ?? meta.sessions.find(s => s.sessionId === sessionId)?.cwd ?? ""))) return true;
    // A new/unresolved admission cannot yet prove it belongs to an unrelated repo.
    return !admission && !workspaceId && lifecycleReservations.size > 0;
  }
  function assertLifecycleIdle(workspaceId: string, repositoryId: string, scope: { commonDir: string; roots: readonly string[] }) {
    if (pendingInputs?.store.readRecords().conversations.some(c => c.chain && chainInRepository(c.chain.pins, { ...scope, workspaceId, repositoryId }))) throw new WorkstreamAdapterError(409, "pending-input-chain-active", "Repository has an affected durable input chain");
    const available = availability(undefined, false);
    if (!available.canSend || retainOwner) throw new WorkstreamAdapterError(409, "bridge-busy", available.reason ?? "App execution ownership is unconfirmed");
    if (lifecycleReservations.has(repositoryId)) throw new WorkstreamAdapterError(409, "bridge-busy", "A repository phase action is already in progress");
    const relevant = (sessionId: string, unknownIsBusy = true) => {
      const admission = admissions.get(sessionId), association = catalog.association(sessionId);
      return admission?.binding.workspaceId === workspaceId || admission?.binding.domain.mode === "repository" && admission.binding.domain.repositoryId === repositoryId || association.workspaceId === workspaceId
        || admission?.binding.checkoutPin?.commonDir === scope.commonDir || scope.roots.includes(admission?.binding.executionCheckout ?? meta.sessions.find(s => s.sessionId === sessionId)?.cwd ?? "") || unknownIsBusy && !admission && !association.workspaceId;
    };
    const busy = new Set([
      ...owners.keys(), ...admitting, ...coordinator.reconciliationSessionIds(), ...handoffReservations, ...handoffDispatches.keys(),
      ...meta.runs.filter(run => run.status === "running").map(run => run.sessionId),
      ...workerStore.deliveriesToReconcile().map(delivery => delivery.parentSessionId),
      ...branches.list().filter(branch => !["completed", "failed"].includes(branch.state)).map(branch => branch.sourceId),
    ]);
    // Workers inherit their parent's repository even before child admission exists.
    if ([...busy].some(sessionId => relevant(sessionId)) || workers.active().some(worker => relevant(worker.parent.sessionId) || relevant(worker.sessionId, false))) throw new WorkstreamAdapterError(409, "bridge-busy", "Repository has active or unconfirmed App execution; wait for runs and workers to finish");
  }
  function releaseOwner(owner: Owner) {
    // A delayed native interrupt must finish before a replacement can acquire
    // this conversation, even if terminal observation arrived first.
    coordinator.releaseOwner(owner);
  }
  let replyIndexedSessionCount = -1;
  let replyLiveSessions = new Map<string, Session>();
  replyIntegration = new OpenCodeReplyIntegration({
    dataDir: options.dataDir,
    authorities: store.sources.oc.authorityId ? [{ authorityId: store.sources.oc.authorityId, adapter: oc,
      qualification: options.openCodeReplyQualifications?.find(value => value.authorityId === store.sources.oc.authorityId) }] : [],
    // Native 2.0.21 returned empty replay logs at positive heads. Operator
    // descriptors cannot bypass the outstanding durable-replay qualification.
    allowQualifiedActivation: false, disabledReason: OC_REPLY_ACTIVATION_BLOCKED, capturePublishedMetadata: true,
    sessions: () => meta.sessions,
    runs: () => meta.runs,
    events: id => (events.get(id) ?? []).filter(event => event.seq <= (replyJournalThrough.get(id) ?? 0)),
    admission: id => admissions.get(id), admissions: () => admissions.list(), isWorker: id => !!workerStore.getBySession(id),
    isClosing: () => closing || storageFailed,
    isCurrent: (id, source, admissionSnapshot) => {
      // Sessions are appended, not replaced, in this bridge. Rebuild once per
      // catalog growth; mutable fields remain visible through their live refs.
      if (replyIndexedSessionCount !== meta.sessions.length) {
        replyLiveSessions = new Map(meta.sessions.map(session => [session.sessionId, session]));
        replyIndexedSessionCount = meta.sessions.length;
      }
      const session = replyLiveSessions.get(id), admission = admissionSnapshot ?? admissions.get(id);
      return !closing && !storageFailed && source.harness === "opencode" && !!session && updateEligible(session)
        && session.attachment?.state !== "pending" && session.harness === source.harness
        && session.authorityId === source.authorityId && session.nativeSessionId === source.nativeSessionId
        && source.authorityId === store.sources.oc.authorityId && admission?.state === "ready"
        && admission.source.descriptor.harness === "oc" && admission.source.authorityId === source.authorityId
        && admission.nativeId === source.nativeSessionId && admission.binding.executionCheckout === session.cwd
        && JSON.stringify(admission.source.descriptor) === JSON.stringify(store.sources.oc.descriptor);
    },
    store: updateStore, updates,
  });
  chromePush = new ChromePushService({
    dataDir: options.dataDir, storeId: store.manifest.storeId, feed: updateStore,
    subject: options.publicOrigin?.startsWith("https:") && !loopback(new URL(options.publicOrigin).hostname)
      ? options.publicOrigin : "mailto:notifications@localhost",
    eligible: (id, source) => {
      const session = meta.sessions.find(session => session.sessionId === id);
      if (closing || storageFailed || !session || session.hidden || !updateEligible(session) || branches.replaced(id)
        || session.attachment?.state === "pending" || session.harness !== source.harness
        || session.authorityId !== source.authorityId || session.nativeSessionId !== source.nativeSessionId) return false;
      return source.incarnation === undefined || updateSourceKey(replyIntegration!.updateSource(id) ?? {
        harness: session.harness, authorityId: session.authorityId!, nativeSessionId: session.nativeSessionId!,
      }) === updateSourceKey(source);
    },
    presentation: (id, source) => {
      const session = meta.sessions.find(session => session.sessionId === id);
      if (!session || session.harness !== source.harness || session.authorityId !== source.authorityId
        || session.nativeSessionId !== source.nativeSessionId) return {};
      const workspaceId = catalog.association(id).workspaceId;
      return { sessionTitle: displayTitle(session), workspaceName: workspaceId ? catalog.workspaceName(workspaceId) : undefined };
    },
    recoverCompletions: function* () {
      // Startup-only recovery from committed journals, not mutable message
      // projections or a per-device session/history polling loop.
      // Progress markers charge skipped records to the dispatcher's turn budget.
      // Index construction must be budgeted too, not hidden inside first next().
      const sessions = new Map<string, Session>();
      for (const session of meta.sessions) { sessions.set(session.sessionId, session); yield null; }
      for (const run of meta.runs) {
        yield null;
        const session = sessions.get(run.sessionId);
        if (!session || session.harness !== "opencode" || !updateEligible(session, run)) continue;
        for (const event of events.get(run.runId) ?? []) {
          if (event.seq <= (replyJournalThrough.get(run.runId) ?? 0) && event.kind === "status"
            && (event.data as { status?: unknown } | null)?.status === "completed") yield { session, run, event };
          else yield null;
        }
      }
    },
  });
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
    failClosed, emit, persist, enqueue, execution, executionContext, compactExecution,
    refreshCompactHistory, assertWorkerDeliverySubmission, saneSession,
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
    if (!startupReady) return json({ error: "Startup execution classification is incomplete", code: "startup-classifying" }, 503);
    try {
      if (closing || storageFailed || meta.reconciliationRequired) return json({ error: "App execution owner unavailable" }, 503);
      const input = await body(req);
      if (input?.operation === "enqueue") return json({ handoff: projectHandoffEnqueue(await handoffs.enqueue(input.caller, input.input)) }, 202);
      if (input?.operation === "status") { const handoff = await handoffs.status(input.caller, input.requestId); return json({ handoff: handoff ? projectHandoffStatus(handoff) : handoff, ...(handoff && handoffProblems.has(handoff.id) ? { problem: handoffProblems.get(handoff.id) } : {}) }); }
      return json({ error: "Unknown handoff operation" }, 400);
    } catch (error) { return error instanceof DomainError || error instanceof WorkstreamAdapterError ? json({ error: error.message, code: error.code }, error instanceof WorkstreamAdapterError ? error.status : error.code === "INVALID_INPUT" ? 400 : 409) : json({ error: "Handoff admission unavailable" }, 503); }
  }
  async function prepareHandoffRecipient(workspaceId: string, handoffId: string) {
    assertStartupReady();
    const finished = Promise.withResolvers<void>(); attachmentTasks.add(finished.promise);
    let lease: ConversationAdmissionLease | undefined;
    try {
      const selected = (await router!.forWorkspace(workspaceId)).domain.getHandoff(handoffId);
      // Cover existing recipients too, and keep the SAME reservation through the
      // service's awaited execution validation and synchronous membership/binding.
      lease = reserve({ kind: "prepare-recipient" }, selected.recipient.sessionId);
      // Only the createNew path below runs `create`; reply/attach deliveries
      // (already-bound recipients) never reach it, so only handoff-created
      // sessions get auto-titles and existing sessions are never renamed.
      let created = false;
      const handoff = await handoffs.prepareRecipient(workspaceId, handoffId, async h => {
        created = true;
        const sessionId = h.recipient.sessionId, cwd = h.recipient.checkout.path, harness = h.recipient.harness === "oc" ? "opencode" : "claude-code";
        if (sessionId !== selected.recipient.sessionId || !coordinator.holdsAdmission(lease!, sessionId)) throw new WorkstreamAdapterError(409, "recipient-unavailable", "Recipient admission changed");
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
          if (harness === "opencode" && sane.saneContext) await deliverSaneFramework(a.nativeId, sessionId, sane.saneContext);
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
        replyIntegration?.requestRefresh();
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
    } finally {
      if (lease) coordinator.releaseAdmission(lease);
      finished.resolve(); attachmentTasks.delete(finished.promise);
    }
  }
  function readinessPolicy(options: Readonly<ConversationReadinessOptions<Owner>>, read?: SessionListProjection) {
    const { conversationId: sessionId, intent, phase, lease } = options;
    // Enqueue refills waiting text only; it is not an execution exemption. In
    // particular inspect-idle must deny BEFORE the coordinator's early idle return.
    if (sessionId && recoveredInputConversations.has(sessionId) && !(phase === "enqueue" && intent.kind === "user-prompt"))
      return { ready: false as const, code: "pending-input-reconciliation-required", reason: "Original queued execution is uncertain after restart; reconcile its original identity before further execution" };
    // Startup adoption observes an already occupied exact native command; it
    // does not submit around branch, handoff, or worker delivery reservations.
    if (intent.kind === "recover-run") {
      if (storageFailed) return { ready: false as const, reason: "Storage unavailable; operator reconciliation required", code: "storage-unavailable" };
      return { ready: false as const, reason: "Run recovery is observation-only startup adoption, not dispatch admission", code: "observation-only-recovery" };
    }
    const delivery = intent.kind === "handoff" || intent.kind === "prepare-recipient";
    const preparation = ["prepare-recipient", "retry-admission", "enroll", "attach", "branch-recovery", "recover-run"].includes(intent.kind);
    // A worker is already reserved by its current App-owned parent. Repository
    // lifecycle actions cannot steal that source-owned start during preflight.
    const worker = intent.kind === "worker-launch" && sessionId ? workerStore.getBySession(sessionId) : undefined;
    const sourceOwnedStart = worker && owners.get(worker.parent.sessionId)?.run.runId === worker.parent.runId;
    if (sessionId && lifecycleReserved(sessionId) && !sourceOwnedStart) return { ready: false as const, reason: "A repository phase action is in progress", code: "workstream-action-pending" };
    if (sessionId && (read ? read.branchParents.has(sessionId) : branches.list().some(op => op.state !== "failed" && (op.state !== "completed" || op.replace) && workers.tree(op.sourceId).some(w => w.sessionId === sessionId)))) return { ready: false as const, reason: "Ancestor conversation has a pending branch or was replaced", code: "branch-parent" };
    if (sessionId && (read ? read.replaced.get(sessionId) : branches.replaced(sessionId)) && intent.kind !== "branch-recovery") return { ready: false as const, reason: "Replaced conversation · read-only. Open its replacement to continue.", code: "replaced" };
    const pending = sessionId ? read ? read.pending.get(sessionId) : branches.pending(sessionId) : undefined;
    if (pending && intent.kind !== "branch-recovery" && !(intent.kind === "branch" && pending.id === intent.requestId)) {
      return { ready: false as const, reason: pending.state === "creation_unknown" && !pending.nativeId
        ? "The branch destination could not be confirmed. Sending is paused until its native history can be checked."
        : pending.error ? "The branch could not be finished. Sending is paused to protect the conversation; restart the App to recheck it."
        : "Finishing branch… Sending will be available when it is ready.", code: "branch-pending" };
    }
    if (storageFailed) return { ready: false as const, reason: "Storage unavailable; operator reconciliation required", code: "storage-unavailable" };
    if (meta.reconciliationRequired) return { ready: false as const, reason: "Operator reconciliation required: restart with --reconcile-interrupted after verifying previous CLI processes are stopped", code: "reconciliation-required" };
    if (closing) return { ready: false as const, reason: "Bridge is shutting down", code: "bridge-closing" };
    if (sessionId && !(intent.kind === "worker-report" && phase === "dispatch" && lease) && (read ? read.deliveryParents.has(sessionId) : workerStore.hasActiveDelivery(sessionId))) return { ready: false as const, reason: "Worker report continuation is reserved or acceptance is unconfirmed; inspect worker delivery evidence", code: "worker-delivery-pending" };
    if (sessionId && !delivery && (handoffReservations.has(sessionId) || handoffDispatches.has(sessionId))) return { ready: false as const, reason: "Recipient has an active or uncertain handoff", code: "handoff-pending" };
    const admission = sessionId ? admissions.get(sessionId) : undefined;
    if (admission && admission.state !== "ready" && !(preparation && (["retry-admission", "enroll", "attach"].includes(intent.kind) || admission.state === "identity_known" && admission.nativeId))) return { ready: false as const, reason: "Admission pending; explicit known-identity retry is required", code: "admission-pending" };
    if (sessionId && intent.kind !== "attach" && meta.sessions.find(s => s.sessionId === sessionId)?.attachment?.state === "pending") return { ready: false as const, reason: "Attachment incomplete. Retry Attach with the same harness, native ID and execution directory; no run is permitted.", code: "attachment-pending" };
    // Request IDs/origins are not capabilities. Keep every other policy above,
    // and ordinary callers, unchanged even when they copy the head request ID.
    // Read-only inspection and a source-owned child launch do not compete for
    // this recipient's turn. Every mutating recipient intent does, independently
    // of delivery origin or a copied queue request ID.
    if (sessionId && phase !== "enqueue" && ["user-prompt", "worker-report", "handoff", "prepare-recipient", "branch", "compact", "branch-recovery", "enroll", "retry-admission", "attach"].includes(intent.kind) && pendingInputs?.hasChain(sessionId)
      && !pendingInputBridge?.allowsReadiness(options)) return { ready: false as const, reason: "A durable input chain is active; use the explicit pending-inputs API", code: "pending-input-chain-active" };
    return undefined;
  }
  function availability(sessionId?: string, capacity = true, delivery = false, preparation = false, inputMode?: "user", read?: SessionListProjection): { canSend: boolean; reason?: string; code?: string; queueAfterRunId?: string } {
    const intent = delivery ? { kind: "handoff" as const } : preparation ? { kind: "prepare-recipient" as const } : inputMode === "user" ? { kind: "user-prompt" as const } : capacity ? { kind: "user-prompt" as const } : { kind: "inspect-idle" as const };
    const owner = sessionId && inputMode === "user" ? owners.get(sessionId) : undefined;
    const inspect = () => coordinator.inspectReadiness({ conversationId: sessionId, intent, phase: "admission", ...(owner && claudeRuns.canQueueFollowup(owner) ? { predecessor: owner } : {}) });
    const result = read ? sessionListReadiness.inspect(read, inspect) : inspect();
    return result.ready ? { canSend: true, ...(result.queueAfterRunId ? { queueAfterRunId: result.queueAfterRunId } : {}) } : { canSend: false, reason: result.reason, code: result.code };
  }
  let serial = Promise.resolve();
  function persist() {
    // Capture at enqueue time. A later concurrent admission must not leak into
    // an earlier metadata write before its first log record reaches the queue.
    const snapshot = JSON.stringify(meta);
    return enqueue(async () => { await writeFile(`${metadataPath}.tmp`, snapshot, { mode: 0o600 }); await rename(`${metadataPath}.tmp`, metadataPath); }).then(() => {
      try { replyIntegration?.metadataPublished(snapshot); } catch { /* Optional capture never delays or fails primary publication. */ }
    });
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
    pendingInputWake?.close();
    // Ownership records are the durable sentinel even if every later disk
    // write fails. Reopening requires process exit and explicit reconciliation.
    for (const owner of owners.values()) if (owner.child) void terminate(owner);
  }
  function startupStorageHealthy() {
    return startupReady && ownsStorage() && !storageFailed && !closing && !retainOwner && !meta.reconciliationRequired;
  }
  function pendingInputAutomationHealthy() {
    return startupStorageHealthy() && pendingInputWake?.isStarted() === true;
  }
  function startPendingInputWake() {
    // An operator reconciliation pause remains a serving but unavailable state.
    // A broken start/guard/timer hook instead retains ownership and aborts startup.
    try {
      if (startupStorageHealthy()) {
        synchronousDispatchHook(() => pendingInputWake!.start());
        if (!pendingInputAutomationHealthy()) throw new Error("Pending input wake did not start safely");
      }
      if (!ownsStorage() || storageFailed || closing || retainOwner) throw new Error("Pending input activation failed closed");
    } catch (error) { failClosed(); throw error; }
  }
  function notifyPendingInput(kind: PendingInputWakeKind) {
    try {
      if (!pendingInputWake) {
        if (startupReady) throw new Error("Queue wake was not constructed");
        return;
      }
      synchronousDispatchHook(() => pendingInputWake!.notify(kind));
      if (storageFailed) throw new Error("Queue wake failed closed");
    } catch (error) {
      failClosed();
      throw new PendingInputStorageError("Pending input notification failed; reconcile original identities", error);
    }
  }
  function queueDomainCommitted<T>(action: () => T): T {
    const result = action();
    notifyPendingInput("domain");
    return result;
  }
  const pendingInputControls = createPendingInputControls({ store: () => pendingInputs?.store, owner: id => owners.get(id),
    available: () => !closing && !storageFailed && startupReady, failClosed });
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
    const session = meta.sessions.find(session => session.sessionId === run.sessionId);
    let captured: { session: Session; run: Run; event: Event } | undefined;
    try { if (session && updateEligible(session, run)) captured = structuredClone({ session, run, event }); }
    catch { /* Optional evidence indexing cannot interfere with journal ownership. */ }
    return enqueue(async () => {
      await appendFile(join(options.dataDir, `${run.runId}.jsonl`), JSON.stringify(event) + "\n", { mode: 0o600 });
      replyJournalThrough.set(run.runId, event.seq);
      // Derived storage/projection must never escape into execution failClosed.
      if (captured) { try {
        updates.primaryJournalCommitted(captured.session, captured.run, captured.event);
        replyIntegration?.correlateCommitted(captured.session, captured.run, captured.event);
      } catch { /* optional update coverage */ } }
      if (captured) { try { chromePush?.journalCommitted(captured.session, captured.run, captured.event); } catch { /* optional device delivery */ } }
    });
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
  const displayTitle = (session: Session) => sessionDisplayTitle(session, meta.runs, events);
  for (const run of meta.runs) {
    const logPath = join(options.dataDir, `${run.runId}.jsonl`);
    let raw: string;
    try { raw = await readFile(logPath, "utf8"); } catch (e: any) { throw new Error(`Cannot load historical event log for ${run.runId}: ${e.code === "ENOENT" ? "missing file" : "read failed"}`); }
    const decoded = decodeLog(raw, run); const list = decoded.events;
    if (decoded.repaired !== undefined) await enqueue(() => writeFile(logPath, decoded.repaired!, { mode: 0o600 }));
    events.set(run.runId, list);
    replyJournalThrough.set(run.runId, list.at(-1)?.seq ?? 0);
    transcripts.ingest(run, list);
    const updateSession = meta.sessions.find(session => session.sessionId === run.sessionId)!;
    if (updateEligible(updateSession, run)) await updates.replayRun(updateSession, run, list);
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
    getOrigin: () => origin, revokeTerminal: token => { terminals.revoke(token); chromePush?.revokeOwner(token); },
  });
  const terminalLog = join(options.dataDir, "terminal-performance.log");
  const terminals = new TerminalService(catalog, token => auth.validTerminalToken(token), line => {
    void appendFile(terminalLog, `${line}\n`, { mode: 0o600 }).catch(() => {});
  });
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
          replyIntegration?.requestRefresh();
          return router!.forAdmission(admissions.get(source.sessionId)!);
        }
        return adapter;
      }
    }
    return router!.forAdmission(admission);
  }
  function assertBranchIdle(source: Session) {
    const descriptor = requireOperation(sessionHarness(source), "branch");
    if (closing || storageFailed || meta.reconciliationRequired || owners.has(source.sessionId) || admitting.has(source.sessionId) || coordinator.hasReconciliation(source.sessionId) || handoffReservations.has(source.sessionId) || handoffDispatches.has(source.sessionId)) throw new Error("Source must be idle, with no pending admission or handoff");
    if (source.agentKind === "worker" || workerStore.hasSession(source.sessionId)) throw new Error("Worker conversations cannot be branched");
    if (workers.tree(source.sessionId).some(w => !w.outcome || w.continuation && !["completed", "failed", "interrupted"].includes(w.continuation.state) || workerResults(w).some(r => ["pending", "claimed", "acceptance-unknown"].includes(r.notification.state))) || workerStore.hasActiveDelivery(source.sessionId)) throw new Error("Finish outstanding workers and worker report deliveries before branching");
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
        const assistant = (id: string) => (events.get(id) ?? []).filter(e => e.kind === "stdout" && isClaudeRootRecord(e.data) && (e.data as any)?.session_id === source.nativeSessionId && (e.data as any)?.type === "assistant").at(-1)?.data as any;
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
      // Forks inherit startup framework and Session context in native history.
      destination = { ...source, sessionId: op.destinationId, nativeSessionId: op.nativeId, lastStatus: "unknown", lastRunId: null, title: `${(displayTitle(source) ?? "Conversation").slice(0, 185)} · Branch` };
      delete destination.attachment; delete destination.hidden;
      meta.sessions.push(destination);
    }
    await catalog.associate(destination.sessionId, source.cwd, original.binding.workspaceId, original.binding.worktreeId);
    await persist(); await admissions.register(destination.sessionId);
    if (admissions.get(destination.sessionId)!.state !== "ready") admissions.ready(destination.sessionId);
    replyIntegration?.requestRefresh();
    return destination;
  }
  const branchFinishing = new Map<string, Promise<void>>();
  async function reconcileBranch(op: BranchOperation) {
    if (["completed", "failed"].includes(op.state)) return;
    if (op.state !== "reserved" && !op.nativeId) return;
    if (closing || storageFailed || meta.reconciliationRequired || owners.has(op.sourceId) || owners.has(op.destinationId) || admitting.has(op.sourceId) || admitting.has(op.destinationId) || coordinator.hasReconciliation(op.sourceId) || coordinator.hasReconciliation(op.destinationId)) return;
    const source = meta.sessions.find(s => s.sessionId === op.sourceId);
    if (!source || handoffReservations.has(op.destinationId) || handoffDispatches.has(op.destinationId)) return;
    try { assertBranchIdle(source); } catch { return; }
    const admission = coordinator.reserveAdmission({ intent: { kind: "branch-recovery", requestId: op.id }, conversationIds: [op.sourceId, op.destinationId] });
    if (!admission.ready) return; // A retained chain defers recovery, not a storage fault.
    const lease = admission.lease;
    const done = Promise.withResolvers<void>(); attachmentTasks.add(done.promise);
    try {
      // Only release an unstarted reservation or finish an already identified fork.
      // Never replay native creation or the saved initial prompt.
      if (op.state === "reserved") await releaseBranch(op, "Interrupted before native creation. Original unchanged.");
      else await finishBranch(op.id);
    } catch (error) {
      branches.save({ ...branches.get(op.id)!, error: error instanceof Error ? error.message : "Branch could not be finished" });
    } finally {
      coordinator.releaseAdmission(lease);
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
    if (workers.tree(session.sessionId).some(w => !w.outcome || w.continuation && !["completed", "failed", "interrupted"].includes(w.continuation.state) || workerResults(w).some(r => ["pending", "claimed", "acceptance-unknown"].includes(r.notification.state))) || workerStore.hasActiveDelivery(session.sessionId)) return "Finish outstanding workers and worker report deliveries before compacting";
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
    const history = session.harness === "opencode" ? nativeObservations.peek(session) ?? await storedNativeHistory(session) : await storedNativeHistory(session);
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
    // Completed CC boundaries are immutable; retain them for grouping their
    // continuation summary/command envelopes, including live/import overlaps.
    const messages = history?.messages.filter(message => session.harness === "claude-code" && message.compaction?.lifecycle === "completed" && message.contextReset || !message.compaction || !observedAt.has(message.messageId) || importedAt > observedAt.get(message.messageId)!);
    return { operations: projectCompactions(session, meta.runs, logs, messages), ...(history && !history.observation ? { nativeHistoryImportedAt: history.importedAt } : {}) };
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
    const lease = reserve({ kind: "compact", requestId: input.requestId }, session.sessionId);
    try {
      const cwd = await compactExecution(session);
      if (session.harness === "opencode") await oc.assertIdle(session.nativeSessionId!, cwd);
      // Recheck synchronously without counting our own preflight reservation.
      const current = coordinator.inspectReadiness({ conversationId: session.sessionId, intent: { kind: "compact", requestId: input.requestId }, phase: "dispatch", lease }), reason = compactBlocked(session);
      if (!current.ready || reason) throw new WorkstreamAdapterError(409, !current.ready ? current.code : "compact-unavailable", !current.ready ? current.reason : reason!);
      const run: Run = { runId: crypto.randomUUID(), sessionId: session.sessionId, cwd, status: "running", createdAt: new Date().toISOString(), operation: "compact", compact: { requestId: input.requestId, ...(input.instructions !== undefined ? { instructions: input.instructions } : {}) }, model: session.model, effort: session.effort, agent: session.agent, agentKind: session.agentKind, nativeAgentSelected: session.nativeAgentSelected, profileId: session.profileId, ...saneContextSnapshot(session) };
      if (session.harness === "opencode") {
        run.nativeCommandId = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
        run.nativePhase = "preparing"; run.compact!.nativeRequestId = run.nativeCommandId;
      }
      const finished = Promise.withResolvers<void>();
      const owner: Owner = { run, native: session.harness === "opencode", nativeDispatched: false, done: finished.promise, settled: false };
      installOwner(lease, owner); session.lastRunId = run.runId; session.lastStatus = "running"; meta.runs.push(run); events.set(run.runId, []);
      // Stable App and native request IDs reach disk before any native mutation.
      try {
        await emit(run, "status", { status: "running", operation: "compact", compactionLifecycle: "requested" });
        await persist();
      } catch (error) { owner.settled = true; finished.resolve(); throw error; }
      void executeCompact(owner, input.instructions).catch(async () => { failClosed(); await terminate(owner); }).finally(() => { owner.settled = true; releaseOwner(owner); finished.resolve(); });
      return { sessionId: session.sessionId, runId: run.runId, operation: projectCompactions(session, [run], events.get(run.runId) ?? [])[0]! };
    } finally { coordinator.releaseAdmission(lease); }
  }
  function ownedSession(owner: Owner) {
    const session = meta.sessions.find(s => s.sessionId === owner.run.sessionId);
    if (!session) throw new HarnessOperationError("Run owner conversation is unavailable", 409, "owner-harness-mismatch");
    return { sessionId: session.sessionId, harness: sessionHarness(session) };
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
    events: runId => events.get(runId) ?? [], emit, persist, execution, executionContext,
    takeFrameworkDelivery: sessionId => { const delivery = frameworkDeliveries.get(sessionId); frameworkDeliveries.delete(sessionId); return delivery; },
    compactExecution, refreshCompactHistory, assertWorkerDeliverySubmission,
    workerHasRun: runId => workerStore.hasRun(runId), sleep: ms => Bun.sleep(ms), saneSession,
  });
  function dispatchSource(session: Session): DispatchSource {
    return Object.freeze({ harnessId: sessionHarness(session), sessionId: session.sessionId,
      authorityId: session.authorityId ?? nativeSource(sessionHarness(session)), nativeSessionId: session.nativeSessionId ?? null, cwd: session.cwd });
  }
  function dispatchSnapshot(session: Session) {
    return JSON.stringify([dispatchSource(session), session.profileId, session.model, session.effort, session.agent,
      session.agentKind, session.nativeAgentSelected, session.saneContext, session.attachment]);
  }
  function assertDispatchSnapshot(sessionId: string, snapshot: string) {
    const session = meta.sessions.find(s => s.sessionId === sessionId);
    if (!session || dispatchSnapshot(session) !== snapshot) throw new WorkstreamAdapterError(409, "dispatch-source-mismatch", "Conversation configuration changed during dispatch preflight");
  }
  const dispatchRegistry = new HarnessDispatchRegistry<Owner>();
  // Publication failure must withhold even native discovery in deferred execute.
  // This latch is not a second owner registry or a retry mechanism.
  const unpublishedDispatches = new WeakSet<Owner>();
  function assertLifecyclePublished(owner: Owner) {
    if (unpublishedDispatches.has(owner)) throw new Error("Lifecycle publication failed; native execution withheld");
  }
  async function pinnedNativeReadiness(source: DispatchSource) {
    const session = meta.sessions.find(s => s.sessionId === source.sessionId);
    if (!session) return { source, readiness: { ready: false as const, reason: "Conversation unavailable", code: "conversation-unavailable" } };
    const current = dispatchSource(session);
    if (!sameDispatchSource(current, source)) return { source: current, readiness: { ready: false as const, reason: "Conversation native source changed", code: "dispatch-source-mismatch" } };
    const activity = await readOnlyDispatchProof(() => oc.activity(source.nativeSessionId!, source.cwd));
    const live = meta.sessions.find(s => s.sessionId === source.sessionId), observed = live ? dispatchSource(live) : current;
    return { source: observed, readiness: !live || !sameDispatchSource(observed, source)
      ? { ready: false as const, reason: "Conversation native source changed", code: "dispatch-source-mismatch" }
      : activity.active || activity.pending ? { ready: false as const, reason: "Native conversation is active or has pending input", code: "native-busy" } : { ready: true as const } };
  }
  async function readOnlyDispatchProof<T>(read: () => Promise<T>): Promise<T> {
    try { return await read(); }
    catch (error) {
      if (error instanceof OpenCodeSourceMismatchError) throw new HarnessDispatchError("dispatch-source-mismatch", error.message);
      if (error instanceof OpenCodeUnavailableError) throw new DispatchProofUnavailableError(error.message);
      throw error;
    }
  }
  const automation = { "queued-user": { supported: true as const }, "worker-report": { supported: true as const }, handoff: { supported: true as const } };
  dispatchRegistry.register(createClaudeDispatchAdapter({
    automation,
    readiness: async source => ({ source, readiness: { ready: false, reason: "Claude automatic readiness requires the exact completed process lifecycle", code: "dispatch-proof-unproven" } }),
    execute: (owner, prompt, resume, ready) => { assertLifecyclePublished(owner); return claudeRuns.execute(owner, prompt, resume, ready); },
    settlementEvidence: (owner, source) => {
      const session = meta.sessions.find(s => s.sessionId === source.sessionId);
      return { childPresent: !!owner.child && !!session && sameDispatchSource(source, dispatchSource(session)),
        exitCode: owner.child?.exitCode ?? null, groupAlive: !!owner.child && groupAlive(owner), streamsDrained: owner.streamsDrained === true };
    },
  }));
  dispatchRegistry.register(createOpenCodeDispatchAdapter({
    // Internal support only: prepared admission requires the strict linked claim.
    // No public queue capability is advertised by this adapter registration.
    automation,
    readiness: pinnedNativeReadiness,
    execute: (owner, prompt, resume, ready) => { assertLifecyclePublished(owner); return ocRuns.executeNative(owner, prompt, resume, ready); },
    exactCommand: async (_owner, source, commandId) => {
      const assertSource = () => {
        const session = meta.sessions.find(s => s.sessionId === source.sessionId);
        if (!session || !sameDispatchSource(source, dispatchSource(session))) throw new HarnessDispatchError("dispatch-source-mismatch", "Conversation native source changed during settlement proof");
      };
      assertSource();
      const outcome = (await readOnlyDispatchProof(() => oc.snapshot(source.nativeSessionId!, commandId, source.cwd))).outcome;
      assertSource();
      return { commandId, outcome: outcome === "succeeded" || outcome === "failed" || outcome === "interrupted" ? outcome : "unknown" };
    },
    nativeReadiness: pinnedNativeReadiness,
  }));
  function executePrompt(lease: ConversationAdmissionLease, session: Session, run: Run, prompt: string, resume: boolean, origin: DispatchOrigin,
    options: { requestId?: string; validate?: () => void; link?: () => void; configure?: () => void; evidence?: DispatchEvidenceHooks; delivery?: PreparedAdmissionContext["delivery"]; nativeQueuedHandoff?: DispatchIdentity; publish?: PreparedAdmissionOptions["publish"]; workerDeliveryId?: string; beforeSend?: () => void; reconciliation?: Omit<NonNullable<DispatchLifecycleHooks<Owner>["reconciliation"]>, "begin"> } = {}) {
    let snapshot = dispatchSnapshot(session);
    requireOperation(sessionHarness(session), "prompt");
    let published = false;
    const lifecycle = dispatchRegistry.start({ source: dispatchSource(session), prompt, resume, origin, requestId: options.requestId }, {
      install: done => {
        assertStartupReady();
        synchronousDispatchHook(() => options.validate?.());
        synchronousDispatchHook(() => options.link?.());
        assertDispatchSnapshot(session.sessionId, snapshot);
        const claim = options.nativeQueuedHandoff;
        if (claim && (claim.runId !== run.runId || claim.nativeCommandId !== run.nativeCommandId || !sameDispatchSource(claim.source, dispatchSource(session)))) throw new WorkstreamAdapterError(409, "dispatch-source-mismatch", "Linked native handoff identity changed before installation");
        const owner: Owner = { run, native: session.harness === "opencode", nativeDispatched: false, done, settled: false,
          ...(options.delivery ? { nativeDeliveryPolicy: options.delivery } : {}),
          ...(claim ? { nativeQueuedHandoff: Object.freeze({ runId: run.runId, nativeCommandId: run.nativeCommandId!, requestId: claim.requestId!, origin: "queued-user" as const, source: dispatchSource(session) }) } : {}),
          ...(options.workerDeliveryId ? { workerDeliveryId: options.workerDeliveryId } : {}), beforeSend: () => {
            assertStartupReady();
            if (closing || storageFailed || retainOwner || meta.reconciliationRequired) throw new WorkstreamAdapterError(409, "dispatch-unavailable", "Execution unavailable before dispatch");
            assertDispatchSnapshot(session.sessionId, snapshot); synchronousDispatchHook(() => options.beforeSend?.());
          } };
        installOwner(lease, owner);
        published = true;
        options.configure?.(); snapshot = dispatchSnapshot(session);
        session.lastRunId = run.runId; session.lastStatus = "running"; meta.runs.push(run); events.set(run.runId, []);
        return owner;
      },
      evidence: pendingInputControls.evidence(options.evidence),
      owns: owner => coordinator.owns(owner), settle: owner => { owner.settled = true; }, release: releaseOwner,
      failClosed: error => {
        // A final validation refusal before publication is definite non-launch,
        // not a storage failure. Partial publication still retains ownership.
        // After-release source errors are still post-publication failures.
        if (published || coordinator.hasOwner(run.sessionId) || !(error instanceof UserInputPreparationError || error instanceof WorkstreamAdapterError)) failClosed();
      }, terminate,
      guards: owner => ({ settled: owner.settled, released: !coordinator.owns(owner), status: owner.run.status,
        cancelling: !!owner.cancelling, stopRequested: !!owner.stopRequested, stopping: !!owner.stopping,
        closing, storageFailed, reconciliationRequired: !!meta.reconciliationRequired || retainOwner }),
      releasedGuards: owner => {
        const current = meta.sessions.find(s => s.sessionId === session.sessionId);
        if (!current) throw new HarnessDispatchError("dispatch-source-mismatch", "Released conversation is unavailable");
        const admission = admissions.get(current.sessionId), association = catalog.association(current.sessionId);
        const admittedSource = !!admission && admission.state === "ready" && admission.nativeId === current.nativeSessionId
          && admission.source.authorityId === current.authorityId
          && normalizeNativeSource(admission.source.descriptor).authorityId === admission.source.authorityId
          && admission.binding.executionCheckout === current.cwd && association.association === "resolved"
          && association.workspaceId === admission.binding.workspaceId && association.worktreeId === admission.binding.worktreeId;
        let repository;
        if (admission) {
          catalog.assertBinding(admission.binding.workspaceId, admission.binding.worktreeId,
            admission.binding.executionCheckout, admission.binding.bindingRevision);
          if (admission.binding.checkoutPin) {
            const discovered = discoverRepository(admission.binding.executionCheckout), inspected = inspectRepositoryStore(discovered);
            if (inspected.state !== "ready" && inspected.state !== "uninitialized") throw new RepositoryStoreError(inspected);
            repository = { checkout: discovered.invocationCheckout, store: inspected };
          }
        }
        const ownLease = coordinator.holdsAdmission(lease, current.sessionId);
        const intent: ConversationOperationIntent = { kind: origin === "handoff" ? "handoff" : origin === "worker-report" ? "worker-report" : "user-prompt", requestId: options.requestId };
        const input = { conversationId: current.sessionId, intent, phase: "dispatch" as const, ...(ownLease ? { lease } : {}) };
        const ready = pendingInputBridge!.releasedReadiness(owner, input);
        return { source: dispatchSource(current), installation: JSON.stringify([dispatchSnapshot(current), admission, association, repository]),
          ownerPresent: coordinator.hasOwner(current.sessionId),
          admissionPending: coordinator.hasAdmission(current.sessionId) && !ownLease,
          reconciliationPending: coordinator.hasReconciliation(current.sessionId), capacityAvailable: admittedSource && ready.ready };
      },
      reconciliation: options.reconciliation && {
        order: options.reconciliation.order,
        begin: owner => {
          const token = coordinator.beginReconciliation(owner);
          return { end: () => {
            if (!coordinator.endReconciliation(token)) throw new Error("Source reconciliation barrier is no longer current");
          } };
        },
        run: async owner => {
          if (storageFailed) throw new Error("Storage failure prevents source reconciliation");
          await options.reconciliation!.run(owner);
          if (storageFailed || retainOwner || meta.reconciliationRequired) throw new Error("Source reconciliation requires operator recovery");
        },
      },
      // Do not add native successful-settlement reads while production remains
      // dormant. Once trusted activation starts it, this is a source-proven hint.
      get wake() { return pendingInputWake?.isStarted() ? () => notifyPendingInput("lifecycle") : undefined; },
    });
    dispatchTasks.add(lifecycle.done);
    pendingInputBridge!.recordLifecycle(session.sessionId, lifecycle);
    void lifecycle.done.finally(() => { dispatchTasks.delete(lifecycle.done); });
    try { synchronousDispatchHook(() => options.publish?.(lifecycle)); }
    catch (error) {
      unpublishedDispatches.add(lifecycle.owner); failClosed();
      // Execution has not started. Preserve definite non-submission rather than
      // letting legacy ready(false) weaken it to unknown. Evidence failure still
      // retains global locks and cannot reopen the publication latch.
      try { lifecycle.owner.dispatchEvidence?.withheld(); } catch { failClosed(); }
      throw error;
    }
    return lifecycle;
  }
  async function ensureDirectory(cwd: string) {
    if (!(await stat(cwd)).isDirectory()) throw new Error("Execution directory unavailable");
  }
  const preparationState = () => ({ getSession: (id: string) => meta.sessions.find(s => s.sessionId === id), profiles: agentProfiles, sourceAuthorityId: nativeSource });
  /** Backend launch authority shared by immediate admission and the existing
   * single CC continuation. No HTTP closure or mutable request is retained. */
  async function admitPreparedInput(prepared: PreparedUserInput, lease: ConversationAdmissionLease, options: PreparedAdmissionOptions = {}) {
    const { conversationId, cwd, harness } = prepared.binding;
    const input = prepared.normalized, { model, effort, agent } = prepared.configuration;
    const { queuedFollowupId, publish } = options;
    // Copy explicit context before any await. Hooks are capabilities, not mutable
    // settings aliases; IDs, intent and origin cannot drift during preflight.
    const context = options.context && Object.freeze({ ...options.context, intent: Object.freeze({ ...options.context.intent }), evidence: options.context.evidence && Object.freeze({ ...options.context.evidence }) });
    if (context && (context.delivery !== "idle-only" && context.delivery !== "native-queued-handoff"
      || !["user", "queued-user", "worker-report", "handoff"].includes(context.origin))) throw new UserInputPreparationError("Explicit admission requires a known delivery policy and origin", 409);
    if (publish !== undefined && typeof publish !== "function") throw new UserInputPreparationError("Lifecycle publisher must be a function", 409);
    const nativeHandoff = context?.delivery === "native-queued-handoff";
    if (nativeHandoff && (harness !== "opencode" || context.origin !== "queued-user" || context.intent.kind !== "user-prompt"
      || typeof context.intent.requestId !== "string" || !context.intent.requestId.trim() || queuedFollowupId !== undefined
      || typeof context.validate !== "function" || typeof context.link !== "function"
      || typeof context.evidence?.beforeNative !== "function" || typeof context.evidence?.outcome !== "function")) throw new UserInputPreparationError("Native queued handoff requires OpenCode queued-user intent, stable request ID and synchronous claim/link/evidence capabilities", 409);
    if (harness === "opencode" && (context?.origin ?? (queuedFollowupId ? "queued-user" : "user")) === "queued-user" && !nativeHandoff) throw new UserInputPreparationError("OpenCode queued-user admission requires explicit native-queued-handoff policy", 409);
    if (nativeHandoff) {
      const pins = (configuration: PreparedUserInput["configuration"]) => JSON.stringify([configuration.profileId, configuration.model, configuration.effort,
        configuration.agent, configuration.agentKind, configuration.nativeAgentSelected, configuration.saneContext, configuration.attachment]);
      if (prepared.stagedUpgrade || prepared.nativeLaunch || !prepared.expectedPrior || pins(prepared.expectedPrior.configuration) !== pins(prepared.configuration)
        || (["model", "effort", "agent", "profileId"] as const).some(key => input[key] !== undefined && input[key] !== prepared.configuration[key])) throw new UserInputPreparationError("Native queued handoff cannot change captured conversation configuration", 409);
    }
    const intent = context?.intent ?? { kind: "user-prompt" as const };
    const origin = context?.origin ?? (queuedFollowupId ? "queued-user" : "user");
    const runId = context?.runId ?? crypto.randomUUID();
    const nativeCommandId = harness === "opencode" ? context?.nativeCommandId ?? `msg_${crypto.randomUUID().replaceAll("-", "")}` : null;
    const identity: DispatchIdentity = Object.freeze({ runId, nativeCommandId, ...(intent.requestId !== undefined ? { requestId: intent.requestId } : {}), source: Object.freeze({ harnessId: harness, sessionId: conversationId,
      authorityId: prepared.binding.authorityId, nativeSessionId: prepared.binding.nativeSessionId ?? null, cwd }) });
    if (context && (!prepared.resume || !prepared.binding.nativeSessionId || typeof context.runId !== "string" || !uuid(context.runId)
      || harness === "opencode" && (typeof context.nativeCommandId !== "string" || !/^msg_[a-zA-Z0-9_-]+$/.test(context.nativeCommandId))
      || harness === "claude-code" && context.nativeCommandId !== undefined)) throw new UserInputPreparationError("Explicit admission requires an established source and valid preallocated harness IDs", 409);
    dispatchRegistry.assertSupport(identity.source, origin);
    const validateContext = () => {
      try { synchronousDispatchHook(() => context?.validate?.(identity)); }
      catch (error) {
        // Domain denial withholds launch. Storage/invariant/async-hook failures
        // must retain App ownership even when they occur before installation.
        if (!(error instanceof UserInputPreparationError || error instanceof WorkstreamAdapterError)) failClosed();
        throw error;
      }
    };
    const assertContext = () => {
      if (meta.runs.some(r => r.runId === runId || nativeCommandId && r.nativeCommandId === nativeCommandId)) throw new UserInputPreparationError("Preallocated dispatch identity is already in use", 409);
      validateContext();
    };
    const assertLease = () => {
      if (!coordinator.holdsAdmission(lease, conversationId) || closing || storageFailed || meta.reconciliationRequired
        || queuedFollowupId && !claudeRuns.followupPending(queuedFollowupId)) throw new UserInputPreparationError("Input cancelled or admission unavailable before launch", 409);
    };
    const assertDispatch = () => {
      assertLease();
      const decision = coordinator.inspectReadiness({ conversationId, intent, phase: "dispatch", lease });
      if (!decision.ready) throw new WorkstreamAdapterError(decision.code === "capacity" ? 429 : 409, decision.code, decision.reason);
    };
    assertDispatch(); assertContext();
    await revalidatePreparedUserInput(prepared, { ...preparationState(), ensureDirectory, validateBinding: assertDispatch });
    let session = meta.sessions.find(s => s.sessionId === conversationId), createdSnapshot: Session | undefined;
    if (session) await execution(conversationId);
    const workspaceId = prepared.associationSelection.workspaceId, worktreeId = prepared.associationSelection.worktreeId;
    const association = await catalog.associate(conversationId, cwd, workspaceId, worktreeId);
    assertPreparedUserInputCurrent(prepared, preparationState()); assertLease();
    if (!session) {
      if (association.association !== "resolved") throw new WorkstreamAdapterError(409, "association-unresolved", "Execution association unavailable");
      await admissions.begin({ sessionId: conversationId, operation: "create", harness: harness === "opencode" ? "oc" : "cc", cwd,
        nativeId: harness === "opencode" ? null : crypto.randomUUID(), workspaceId: association.workspaceId, worktreeId: association.worktreeId });
      assertPreparedUserInputCurrent(prepared, preparationState()); assertLease();
      if (harness === "opencode") await admissions.createNative(conversationId, async () => { assertLease(); return (await oc.createResolved(cwd, prepared.nativeLaunch!)).id; });
      const a = admissions.get(conversationId)!;
      const sane = input.agent !== undefined ? saneSessionContext({ kind: "assistant", role: input.agent }) : {};
      assertPreparedUserInputCurrent(prepared, preparationState()); assertLease();
      if (harness === "opencode" && sane.saneContext) await deliverSaneFramework(a.nativeId!, conversationId, sane.saneContext);
      session = { sessionId: conversationId, harness, nativeSessionId: a.nativeId!, authorityId: a.source.authorityId, cwd, lastStatus: "unknown", lastRunId: null,
        ...(input.model !== undefined ? { model: input.model } : {}), ...(input.effort !== undefined ? { effort: input.effort } : {}),
        ...(input.agent !== undefined ? { agent: input.agent, agentKind: "assistant", nativeAgentSelected: true, ...sane } : {}),
        ...(prepared.selectedProfile ? { profileId: prepared.selectedProfile.id } : {}) };
      createdSnapshot = structuredClone(session);
      meta.sessions.push(session); await persist();
      await admissions.register(conversationId); admissions.ready(conversationId); replyIntegration?.requestRefresh();
    }
    let nativeDelivery: "queue" | undefined;
    if (nativeHandoff) {
      // Fresh idle proof belongs BEFORE the durable consumer claim (4c2). After
      // claim, foreign activity is allowed: only recheck native identity/checkout.
      try { await oc.preflightNativeSession(session.nativeSessionId!, cwd); }
      catch (error) {
        if (error instanceof OpenCodeSourceMismatchError) throw new WorkstreamAdapterError(409, "dispatch-source-mismatch", error.message);
        if (error instanceof OpenCodeUnavailableError) throw new WorkstreamAdapterError(503, "dispatch-proof-unavailable", error.message);
        throw error;
      }
      nativeDelivery = "queue";
    } else if (harness === "opencode") {
      const native = await oc.activity(session.nativeSessionId!, cwd);
      if (native.active || native.pending) {
        if (context?.delivery === "idle-only") throw new WorkstreamAdapterError(409, "native-busy", "Idle-only delivery refuses native activity or pending input");
        if (session.agentKind === "worker" || prepared.stagedUpgrade || input.model !== undefined && input.model !== session.model
          || input.effort !== undefined && input.effort !== session.effort || input.agent !== undefined && input.agent !== session.agent) throw new OpenCodeError("Wait for OpenCode to finish before changing conversation configuration or sending worker input", 409);
        nativeDelivery = "queue";
      } else await oc.assertIdle(session.nativeSessionId!, cwd);
    }
    // Final source/profile/default guard AFTER every awaited preflight, including
    // native discovery. No await separates this comparison from installation.
    assertPreparedUserInputCurrent(prepared, preparationState(), createdSnapshot); assertDispatch(); assertContext();
    const configured = structuredClone(session);
    if (input.model !== undefined) configured.model = input.model;
    if (input.effort !== undefined) configured.effort = input.effort;
    if (input.agent !== undefined && configured.agent === undefined) {
      configured.agent = input.agent; if (configured.profileId !== undefined) configured.profileId = legacyProfileId(harness, input.agent);
    }
    if (prepared.stagedUpgrade) {
      configured.profileId = prepared.stagedUpgrade.id; configured.agent = prepared.stagedUpgrade.role ?? undefined;
      if (prepared.stagedUpgrade.model) configured.model = prepared.stagedUpgrade.model; else delete configured.model;
      if (prepared.stagedUpgrade.effort) configured.effort = prepared.stagedUpgrade.effort; else delete configured.effort;
    }
    if (!configured.title) configured.title = titleFromPrompt(prepared.prompt) ?? undefined;
    const run: Run = { runId, sessionId: conversationId, cwd, status: "running", createdAt: new Date().toISOString(),
      ...(nativeDelivery ? { nativeDelivery } : {}), ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}),
      ...(agent !== undefined ? { agent, agentKind: configured.agentKind, nativeAgentSelected: configured.nativeAgentSelected } : {}),
      // Strict delivery preserves actual stored pins, including legacy omission;
      // it must not normalize preferences or upgrade metadata during a claim.
      profileId: nativeHandoff ? configured.profileId : sessionProfileId(configured), ...saneContextSnapshot(configured), ...(queuedFollowupId ? { queuedFollowupId } : {}) };
    if (harness === "opencode") { run.nativeCommandId = nativeCommandId!; run.nativePhase = "preparing"; }
    const effectivePrompt = isStoredAssistantAgentId(agent) && harness === "opencode" && !session.nativeAgentSelected
      ? `[SANE role: ${storedAssistantLabel(agent)} assistant. Follow the SANE ${storedAssistantLabel(agent)} assistant procedures for this conversation.]\n\n${prepared.prompt}` : prepared.prompt;
    const installedSnapshot = structuredClone(configured);
    const lifecycle = executePrompt(lease, session, run, effectivePrompt, prepared.resume, origin, {
      requestId: intent.requestId,
      validate: () => { assertDispatch(); assertContext(); assertPreparedUserInputCurrent(prepared, preparationState(), createdSnapshot); },
      link: context?.link && (() => context.link!(identity)), evidence: context?.evidence, delivery: context?.delivery,
      ...(nativeHandoff ? { nativeQueuedHandoff: identity } : {}), publish,
      configure: () => {
        Object.assign(session!, configured);
        if (!("model" in configured)) delete session!.model;
        if (!("effort" in configured)) delete session!.effort;
        workerStore.suppress(conversationId, false);
      },
      beforeSend: () => {
        assertPreparedUserInputCurrent(prepared, preparationState(), installedSnapshot);
        if (run.runId !== identity.runId || (run.nativeCommandId ?? null) !== identity.nativeCommandId || run.cwd !== identity.source.cwd) { failClosed(); throw new Error("Installed dispatch IDs or checkout changed"); }
        validateContext();
      },
    });
    // Explicit consumers get the handle even on unconfirmed admission; they must
    // persist evidence and must never infer non-submission from ready(false).
    if (!context && (await lifecycle.admission).state !== "admitted") throw new WorkstreamAdapterError(503, "run-unavailable", lifecycle.owner.launchError ?? "Run could not start; operator reconciliation may be required");
    return { sessionId: conversationId, runId: run.runId, harness, nativeSessionId: session.nativeSessionId, ...association, lifecycle };
  }
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
    // execution already validates the repository admission and resolves its context.
    await execution(session.sessionId);
    current();
    let evidenced = false;
    for (let attempt = 0; attempt < 3 && !evidenced; attempt++) {
      current();
      if (e.source.harness === "cc") {
        evidenced = (events.get(run.runId) ?? []).some(event => {
          const data = event.data as any;
          if (event.kind === "hook") return data?.event === "PreToolUse" && isClaudeRootRecord(data.payload) && data.payload?.session_id === e.nativeId && data.payload?.tool_use_id === request.invocation.toolCallId && matchesName(data.payload?.tool_name);
          return event.kind === "stdout" && isClaudeRootRecord(data) && data?.type === "assistant" && data.session_id === e.nativeId && Array.isArray(data.message?.content) && data.message.content.some((part: any) => part.type === "tool_use" && part.id === request.invocation.toolCallId && matchesName(part.name));
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
    if (!startupReady) return json({ error: "Startup execution classification is incomplete", code: "startup-classifying" }, 503);
    return workerHandler(req);
  }
  function assertWorkerDeliverySubmission(owner: Owner) {
    if (!owner.workerDeliveryId) return;
    const session = meta.sessions.find(s => s.sessionId === owner.run.sessionId);
    if (closing || storageFailed || meta.reconciliationRequired || owner.stopRequested || owners.get(owner.run.sessionId) !== owner || workerStore.suppressed(owner.run.sessionId) || !session || session.hidden) throw new Error("Worker continuation withheld: parent stopped, hidden, or execution unavailable");
  }
  const workers = new WorkerService(workerStore, {
    async parent(caller, starting) {
      if (starting) assertStartupReady();
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
      const domain = (await router!.forAdmission(a))!.domain, workstream = domain.resolveContext(native).workstream;
      const holdsExecution = !!workstream && domain.getWorkstreamStatus(workstream.id).activePhases.some(p => equivalentSlots(p.phase, "execution") && p.ref.harness === native.harness && p.ref.authorityId === native.authorityId && p.ref.nativeId === native.nativeId);
      return { sessionId: session.sessionId, runId: run.runId, native, checkout, profileId: sessionProfileId(session), holdsExecution };
    },
    assertCurrentParent(parent) {
      const owner = owners.get(parent.sessionId);
      if (!owner || owner.run.runId !== parent.runId || owner.run.status !== "running" || owner.run.operation === "compact" || owner.settled || owner.stopRequested || owner.cancelling) throw new WorkstreamAdapterError(409, "worker-parent", "Parent prompt run ended or stopped during worker qualification; no worker was reserved");
    },
    hasActiveExecution(w) { return owners.has(w.sessionId) || workerStore.hasActiveDelivery(w.sessionId); },
    observationKey(w) {
      // Only terminal, owner-free observations are cached by WorkerService. The
      // no-run admission/orphan recovery branch is unreachable with an outcome.
      // Legacy output can depend on historical logs outside the candidate runs.
      if (storageFailed || retainOwner || admitting.has(w.sessionId) || owners.has(w.sessionId)
        || w.requiresLegacyOutputObservation) return undefined;
      return workerObservationEvidence(w, meta.runs, events,
        new Set(workerStore.deliveriesForParent(w.sessionId).map(d => d.run.runId)));
    },
    assertCapacity() {
      const a = availability();
      if (!a.canSend) {
        const code = a.code ?? (storageFailed ? "worker-storage-unavailable" : meta.reconciliationRequired ? "worker-reconciliation-required" : closing ? "worker-app-closing" : "worker-unavailable");
        throw new NativeWorkerRequestError(a.code ? 409 : 503, code, `${a.reason} No worker was admitted by this request; other starts in the same batch may have succeeded. Inspect sane_worker_status before retrying only missing assignments once the App is available. Do not bypass this rejection by launching native subagents.`);
      }
    },
    async launch(w) {
      assertStartupReady();
      const harness = validateHarness(w.launch.harness);
      requireOperation(harness, "prompt");
      workerStore.update(w.id, { state: "launching" });
      const parentAdmission = admissions.get(w.parent.sessionId)!;
      const lease = reserve({ kind: "worker-launch", requestId: w.id }, w.sessionId);
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
        replyIntegration?.requestRefresh();
        if (closing || storageFailed || meta.reconciliationRequired) throw new Error("App unavailable before worker submission; launch remains reserved");
        if (workerStore.get(w.id)!.cancelRequestedAt) {
          const at = new Date().toISOString(); workerStore.update(w.id, { state: "interrupted", outcome: { status: "interrupted", at, summary: "Cancelled before submission", log: null }, notification: { id: `worker-outcome:${w.id}`, state: "pending" } }); return;
        }
        try {
          const child = { harness: a.source.descriptor.harness, authorityId: a.source.authorityId, nativeId: a.nativeId! };
          const { saneContext } = saneSessionContext(w.launch.identity, workerAssignment((await router!.forAdmission(a))!.domain, child, w.parent.native, w.input.worker, w.input.jobs ?? [], w.id));
          if (!saneContext) throw new Error("Worker launch has no SANE worker identity");
          if (harness === "opencode") await deliverSaneFramework(a.nativeId!, w.sessionId, saneContext);
          session.saneContext = saneContext;
        } catch (e) {
          const summary = `Worker assignment unavailable: ${e instanceof Error ? e.message : "context resolution failed"}`;
          workerStore.update(w.id, { state: "failed", error: summary, outcome: { status: "failed", at: new Date().toISOString(), summary, log: null }, notification: { id: `worker-outcome:${w.id}`, state: "pending" } });
          throw e;
        }
        await persist();
        const run: Run = { runId: crypto.randomUUID(), sessionId: w.sessionId, cwd: w.checkout, status: "running", createdAt: new Date().toISOString(), ...agentLaunchSnapshot(launch), ...saneContextSnapshot(session), ...(harness === "opencode" ? { nativeCommandId: `msg_${crypto.randomUUID().replaceAll("-", "")}`, nativePhase: "preparing" as const } : {}) };
        workerStore.update(w.id, { runId: run.runId, state: "running" });
        const prompt = w.input.context === undefined ? w.input.prompt : `${w.input.prompt}\n\nSupplied context:\n${w.input.context}`;
        executePrompt(lease, session, run, prompt, false, "user", {
          reconciliation: { order: "after-release", run: async () => { if (!storageFailed) await workers.refresh(workerStore.get(w.id)!); } },
        });
      } catch (e) {
        const a = admissions.get(w.sessionId);
        if (!a || a.state === "intent") {
          const summary = e instanceof Error ? e.message : "Worker preparation failed";
          workerStore.update(w.id, { state: "failed", error: summary, outcome: { status: "failed", at: new Date().toISOString(), summary, log: null }, notification: { id: `worker-outcome:${w.id}`, state: "pending" } });
        }
        throw e;
      } finally { coordinator.releaseAdmission(lease); }
    },
    async observe(w) {
      const restored = restoreWorkerOutput(w, runId => events.get(runId) ?? []);
      if (restored) w = workerStore.update(w.id, restored);
      const results = workerResults(w);
      // Durable delivery run identity recovers continuations after restart without replay.
      const continuationDeliveries = workerStore.deliveriesForParent(w.sessionId);
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
      const hook = records.filter(e => e.kind === "hook" && isClaudeRootRecord((e.data as any)?.payload) && ["PermissionRequest", "PostToolUse"].includes((e.data as any)?.event)).at(-1);
      if (hook) return { state: (hook.data as any).event === "PermissionRequest" ? "waiting" : "running" };
      return {};
    },
    beforeCancel(selected) {
      const captured = new Map(selected.map(w => [w.sessionId, pendingInputControls.stop(w.sessionId)]));
      return async w => {
        const owner = captured.get(w.sessionId);
        if (!owner) { if (!w.runId && admitting.has(w.sessionId)) return; throw new Error("No active App owner; termination requires native reconciliation"); }
        await cancelOwner(owner);
      };
    },
    suppressCancellation: id => pendingInputControls.cancellationWrite(() => workerStore.suppress(id, true)),
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
    const reportReadiness = () => coordinator.inspectReadiness({ conversationId: parentSessionId, intent: { kind: "worker-report" }, phase: "admission" });
    let available = reportReadiness();
    if (!available.ready) return problem(available.reason);
    const a = admissions.get(parentSessionId);
    if (!a || a.state !== "ready" || a.binding.domain.mode !== "repository" || session.attachment || !session.nativeSessionId || !session.lastRunId) return problem("Report recipient must remain an enrolled App-owned conversation with a known native run");
    const pending = workerStore.listMatching(w => w.parent.sessionId === parentSessionId).filter(w => workerResults(w).some(r => r.notification.state === "pending"));
    if (pending.some(w => w.parent.native.nativeId !== a.nativeId || w.parent.native.authorityId !== a.source.authorityId || w.parent.native.harness !== a.source.descriptor.harness)) return problem("Report recipient native identity changed; reconcile the original parent binding");
    const snapshot = dispatchSnapshot(session);
    const cwd = await execution(parentSessionId);
    if (session.harness === "opencode") await oc.assertIdle(session.nativeSessionId, cwd);
    // Recheck after all asynchronous preparation. Claim and owner acquisition below
    // are synchronous, sharing arbitration with explicit wait acknowledgement.
    available = reportReadiness();
    if (!available.ready) return problem(available.reason);
    assertDispatchSnapshot(parentSessionId, snapshot);
    if (session.hidden || workerStore.suppressed(parentSessionId)) return problem("Parent hidden or stopped during preparation; outcomes remain pending");
    const workerParent = workerStore.getBySession(parentSessionId);
    if (workerParent && workers.active().filter(w => w.checkout === cwd && w.sessionId !== parentSessionId).length >= maxWorkersPerCheckout) return problem(`Checkout worker capacity reached (${maxWorkersPerCheckout}); continuation remains pending`);
    const now = new Date().toISOString();
    const run: Run = { runId: crypto.randomUUID(), sessionId: parentSessionId, cwd, status: "running", createdAt: now, agent: session.agent, agentKind: session.agentKind, nativeAgentSelected: session.nativeAgentSelected, profileId: session.profileId, model: session.model, effort: session.effort, ...saneContextSnapshot(session) };
    const commandId = session.harness === "opencode" ? `msg_${crypto.randomUUID().replaceAll("-", "")}` : `${run.runId}:user`;
    if (session.harness === "opencode") { run.nativeCommandId = commandId; run.nativePhase = "preparing"; }
    const lease = reserve({ kind: "worker-report" }, parentSessionId);
    try {
      // Claim writers are storage authority, never retryable readiness failures.
      const d = (() => { try {
        const claimed = workerStore.claimDelivery({ id: crypto.randomUUID(), parentSessionId, native: { harness: a.source.descriptor.harness, authorityId: a.source.authorityId, nativeId: session.nativeSessionId! }, run, commandId, createdAt: now, updatedAt: now });
        if (claimed) workerStore.advanceDelivery(claimed.id, "acceptance-unknown");
        return claimed;
      } catch (error) { failClosed(); throw error; } })();
      if (!d) return;
      if (workerParent) workerStore.update(workerParent.id, { state: "running", continuation: { runId: run.runId, state: "running" }, continuationCancellation: undefined });
      const prompt = workerReportPrompt(d, workerStore.listForDelivery(d));
      executePrompt(lease, session, run, prompt, true, "worker-report", { workerDeliveryId: d.id,
        reconciliation: { order: "after-release", run: async () => {
          if (!storageFailed) { await reconcileWorkerDelivery(d); if (workerParent) await workers.refresh(workerStore.get(workerParent.id)!); }
        } },
      });
    } finally { coordinator.releaseAdmission(lease); }
  }

  let workerOutboxTask: Promise<void> | undefined;
  async function consumeWorkerReports() {
    for (const w of workers.listForRefresh()) { if (closing || storageFailed) return; await workers.refresh(w); }
    for (const d of workerStore.deliveriesToReconcile()) { if (closing || storageFailed) return; await reconcileWorkerDelivery(d); }
    for (const parent of workerStore.pendingParents()) {
      if (closing || storageFailed) return;
      try { await dispatchWorkerReport(parent); } catch (e) { if (storageFailed) throw e; workerStore.pendingProblem(parent, e instanceof Error ? e.message : "Worker report preparation unavailable"); }
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
      })().finally(() => {
        // Native interruption acknowledges one execution, not future restart
        // continuations. Coalesce only in-flight requests; an explicit later
        // Stop must be able to interrupt the still-owned native run again.
        if (owner.native) owner.cancel = undefined;
        owner.cancelling = false; releaseOwner(owner);
      });
    }
    const attempt = owner.cancel;
    try { return await attempt; } catch (e) { if (owner.cancel === attempt) owner.cancel = undefined; throw e; }
  }
  const handoffProblems = new Map<string, string>();
  /** Only actual synchronous writers use this fence; read/native proof failures
   * remain scoped. A thrown write may already have committed its intent. */
  function handoffMutation<T>(write: () => T): T {
    try { return write(); }
    catch (error) {
      const storage = error instanceof PendingInputStorageError || error instanceof AppStoreError && error.code !== "APP_SOURCE_MISMATCH"
        || error instanceof RepositoryStoreError && error.state === "corrupt"
        || (error instanceof DomainError || error instanceof WorkstreamAdapterError) && ["STORAGE_ERROR", "CORRUPT_STORE", "INCOMPLETE_INITIALIZATION"].includes(error.code);
      const refusal = error instanceof DomainError || error instanceof WorkstreamAdapterError || error instanceof PendingInputDomainError
        || error instanceof AppStoreError && error.code === "APP_SOURCE_MISMATCH";
      if (storage || !refusal) failClosed();
      throw error;
    }
  }
  /** The Map is the live projection; each new problem is also durable handoff audit evidence. */
  async function recordHandoffProblem(workspaceId: string, id: string, problem: string) {
    if (handoffProblems.get(id) === problem) return;
    try {
      const domain = (await router!.forWorkspace(workspaceId)).domain;
      handoffMutation(() => domain.recordHandoffProblem(id, problem.slice(0, 8000), { actor: { kind: "system" }, correlationId: id }));
      handoffProblems.set(id, problem);
    } catch { handoffProblems.set(id, `${problem}; durable problem record failed`); }
  }
  async function reconcileHandoff(workspaceId: string, id: string) {
    const domain = (await router!.forWorkspace(workspaceId)).domain;
    let h = domain.getHandoff(id);
    if (h.recipient.ownerId !== store.manifest.storeId || !h.runId || ["queued", "completed", "failed"].includes(h.status)) return h;
    const run = meta.runs.find(r => r.runId === h.runId && r.sessionId === h.recipient.sessionId);
    if (!run || run.operation === "compact") return h;
    const records = events.get(run.runId) ?? [];
    const accepted = h.recipient.harness === "oc" ? run.nativeCommandId === h.nativeCommandId && run.nativePhase === "accepted" : records.some(e => e.kind === "stdout" && isClaudeRootRecord(e.data) && (e.data as any)?.session_id === h.recipient.ref?.nativeId && ((e.data as any)?.type === "result" || (e.data as any)?.type === "system" && (e.data as any)?.subtype === "init"));
    const advance = (status: typeof h.status, evidence: string) => { h = handoffMutation(() => domain.advanceHandoff(h.id, h.revision, { status, evidence }, { actor: { kind: "system" }, correlationId: h.id })); };
    if (h.status === "acceptance_unknown" && accepted) advance("accepted", `Native acceptance recorded in App run ${run.runId}`);
    const executing = h.recipient.harness === "cc" ? accepted : records.some(e => e.kind === "message" && (e.data as any)?.role === "assistant");
    if (h.status === "accepted" && run.status === "running" && executing) advance("running", `Native execution observed in App run ${run.runId}`);
    if (run.status === "completed" && accepted) advance("completed", `Correlated native delivery-run success in App run ${run.runId}; not task completion or user approval`);
    else if (run.status === "failed") advance("failed", `Terminal failure recorded in App run ${run.runId}`);
    else if (run.status === "interrupted" && h.recipient.harness === "oc") advance("failed", `Native interruption recorded in App run ${run.runId}`);
    else if (run.status === "interrupted") await recordHandoffProblem(workspaceId, h.id, "Execution interrupted; inspect native state and acknowledge termination with the handoff reconcile endpoint");
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
    const lease = reserve({ kind: "handoff", requestId: id }, session.sessionId);
    try {
      const snapshot = dispatchSnapshot(session);
      const cwd = await execution(session.sessionId);
      if (session.harness === "opencode") await oc.assertIdle(session.nativeSessionId!, cwd);
      if (closing || storageFailed || meta.reconciliationRequired) return;
      const domain = (await router!.forWorkspace(workspaceId)).domain;
      const status = domain.getWorkstreamStatus(h.workstreamId);
      const fromSender = (a: (typeof status.activePhases)[number]) => a.ref.harness === h.sender.harness && a.ref.authorityId === h.sender.authorityId && a.ref.nativeId === h.sender.nativeId;
      const senderSlots = [...new Set(status.activePhases.filter(fromSender).map(a => a.phase))];
      const originalSenderSlots = [...new Set([...status.phaseHistory, ...status.activePhases].filter(a => fromSender(a) && a.startedAt <= h.createdAt && (!a.endedAt || a.endedAt >= h.createdAt)).map(a => a.phase))];
      const replySlots = domain.getConversation(h.sender)?.workstreamId === h.workstreamId ? originalSenderSlots.filter(slot => senderSlots.some(current => equivalentSlots(slot, current))) : [];
      // All source/native/domain awaits precede the outbox claim. The exact
      // lease serializes claim + owner installation; later legal enqueue behind
      // that installed owner must not retroactively revoke its native send.
      const ready = coordinator.inspectReadiness({ conversationId: session.sessionId, intent: { kind: "handoff", requestId: id }, phase: "dispatch", lease });
      if (!ready.ready) return;
      assertDispatchSnapshot(session.sessionId, snapshot);
      const run: Run = { runId: crypto.randomUUID(), sessionId: session.sessionId, cwd, status: "running", createdAt: new Date().toISOString(), agent: session.agent, agentKind: session.agentKind, nativeAgentSelected: session.nativeAgentSelected, model: session.model, effort: session.effort, profileId: session.profileId, ...saneContextSnapshot(session) };
      const commandId = session.harness === "opencode" ? `msg_${crypto.randomUUID().replaceAll("-", "")}` : `${run.runId}:user`;
      h = handoffMutation(() => domain.advanceHandoff(h.id, h.revision, { status: "acceptance_unknown", attemptId: crypto.randomUUID(), nativeCommandId: commandId, runId: run.runId }, { actor: { kind: "system" }, correlationId: h.id }, current => { handoffs.assertRecipientReady(current); }));
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
      const prompt = [
        `SANE handoff ${h.id}`, `Request ID: ${h.input.requestId}`, `Repository: ${domain.primaryCheckout}`, `Workstream: ${h.workstreamId}`,
        `Destination: ${h.input.to}`, `From: ${JSON.stringify(h.sender)}`,
        `Sender slots at request: ${originalSenderSlots.length ? JSON.stringify(originalSenderSlots) : "(none recorded)"}`,
        `Sender slots now: ${senderSlots.length ? JSON.stringify(senderSlots) : "(none)"}`,
        ...(h.input.kickoff ? ["Origin: kickoff; the sender created this workstream and is not a member."] : []),
        `Recipient: ${JSON.stringify(h.recipient.ref)}`,
        h.input.createNew ? "Perform the assigned assistant's mandatory Pickup and ask the user to confirm scope before proceeding."
          : "Continue within this conversation's confirmed scope and user decisions; confirm any scope change with the user.",
        "A successful delivery run may only establish Pickup readiness; it does not mean request/task completion, user acceptance, or approval.",
        "If this request asks for a reply, use a separate sane_handoff with a new requestId and target exactly the qualified From identity above. Include this handoff ID, request ID, workstream, and original request scope in its message.",
        replySlots.length ? `Reply destination slots from the original scope still assigned now: ${JSON.stringify(replySlots)}. Select the relevant exact slot and recheck eligibility when sending.`
          : "The sender has no eligible original reply slot in this workstream now. If this request asks for a reply, report this membership/assignment authority restriction; an exact reply cannot bypass it or be redirected to another conversation.",
        "", h.input.message,
      ].join("\n");
      executePrompt(lease, session, run, prompt, resume, "handoff", {
        reconciliation: { order: "before-release", run: async () => { if (!storageFailed) await reconcileHandoff(workspaceId, h.id); } },
      });
      handoffProblems.delete(h.id);
    } finally { coordinator.releaseAdmission(lease); }
  }
  let handoffTask: Promise<void> | undefined;
  // Negative retry state only: never reuse domain authority or delay explicit requests.
  const handoffPollFailures = new Map<string, { fingerprint: string; delay: number; retryAt: number }>();
  async function consumeHandoffs() {
    const repositories = (await catalog.registeredWorkspaces()).workspaces.filter(w => w.kind === "repository");
    const registered = new Set(repositories.map(w => w.workspaceId));
    for (const id of handoffPollFailures.keys()) if (!registered.has(id)) handoffPollFailures.delete(id);
    for (const w of repositories) {
      if (closing || storageFailed) return;
      const fingerprint = JSON.stringify([w.commonDir, w.worktrees.map(t => [t.worktreeId, t.root, t.gitDir, t.bindingRevision, t.state])]);
      let failure = handoffPollFailures.get(w.workspaceId);
      if (failure && failure.fingerprint !== fingerprint) {
        handoffPollFailures.delete(w.workspaceId);
        failure = undefined;
      }
      if (failure && performance.now() < failure.retryAt) continue;
      let deliveries;
      try {
        deliveries = await handoffs.listForPolling(w.workspaceId);
        handoffPollFailures.delete(w.workspaceId);
      } catch {
        const delay = Math.min((failure?.delay ?? 2500) * 2, 30000);
        handoffPollFailures.set(w.workspaceId, { fingerprint, delay, retryAt: performance.now() + delay });
        continue;
      }
      for (const h of deliveries.filter(h => h.recipient.ownerId === store.manifest.storeId && !["queued", "completed", "failed"].includes(h.status))) handoffReservations.add(h.recipient.sessionId);
      for (const h of deliveries.filter(h => h.recipient.ownerId === store.manifest.storeId && !["completed", "failed"].includes(h.status))) {
        if (closing || storageFailed) return;
        try {
          if (h.status === "queued") {
            const sessionId = h.recipient.sessionId;
            if (handoffDispatches.has(sessionId) || handoffReservations.has(sessionId) || !availability(sessionId, true, true, true).canSend) continue;
            const task = Promise.resolve().then(() => dispatchHandoff(w.workspaceId, h.id))
              .catch(error => recordHandoffProblem(w.workspaceId, h.id, error instanceof Error ? error.message : "Handoff execution unavailable"))
              .finally(() => { handoffDispatches.delete(sessionId); });
            handoffDispatches.set(sessionId, task);
          } else await reconcileHandoff(w.workspaceId, h.id);
        }
        catch (error) { await recordHandoffProblem(w.workspaceId, h.id, error instanceof Error ? error.message : "Handoff execution unavailable"); }
      }
    }
  }
  function queueGuard(action: "enqueue" | "resume" | "remove", sessionId: string) {
    if (closing || storageFailed || !startupReady) throw new PendingInputDomainError("pending-input-owner-unavailable", "App ownership/startup is unavailable", 503);
    // Removal is independent of execution, branch/lifecycle pauses, hidden
    // state and pin drift. It only edits an unclaimed App waiter under our lock.
    if (action === "remove") return;
    const session = meta.sessions.find(s => s.sessionId === sessionId);
    if (!session) throw new PendingInputDomainError("pending-input-not-found", "Unknown conversation", 404);
    if (session.hidden) throw new PendingInputDomainError("pending-input-hidden", "Unhide the conversation before adding/resuming waiting input");
    if (sessionHarness(session) === "claude-code" && session.attachment) throw new PendingInputDomainError("pending-input-attached-cc", "Attached Claude input requires a fresh external-stopped acknowledgement; queued automation is not supported");
    // Legacy immediate/followup reservations cannot race the new FIFO domain.
    if (admitting.has(sessionId) || projectClaudeFollowups(sessionId, meta.runs, id => events.get(id) ?? [], id => claudeRuns.followupPending(id)).some(r => claudeRuns.followupPending(r.requestId))) throw new PendingInputDomainError("pending-input-legacy-reservation", "Finish the existing admission/legacy followup before starting a FIFO chain");
    const ready = coordinator.inspectReadiness({ conversationId: sessionId, intent: { kind: "user-prompt" }, phase: "enqueue" });
    if (!ready.ready) throw new PendingInputDomainError(ready.code, ready.reason, ["storage-unavailable", "startup-classifying", "bridge-closing"].includes(ready.code) ? 503 : 409);
  }
  async function queuePreflight(prepared: PreparedUserInput): Promise<PendingInputPreflight> {
    return queuePins(prepared, true);
  }
  /** Fresh read-only pin validation, independent of enqueue contention policy.
   * Consumer callers compare these pins to the ORIGINAL snapshot; never upgrade. */
  async function queuePins(prepared: PreparedUserInput, enqueuePolicy: boolean, captured?: PendingInputPins, signal?: AbortSignal): Promise<PendingInputPreflight> {
    const id = prepared.binding.conversationId;
    const domainError = (error: unknown): never => {
      if (error instanceof PendingInputDomainError || error instanceof PendingInputStorageError) throw error;
      if (error instanceof RepositoryStoreError && error.state === "corrupt" || error instanceof WorkspaceError && error.code === "catalog-storage" || (error instanceof DomainError || error instanceof WorkstreamAdapterError) && ["STORAGE_ERROR", "CORRUPT_STORE"].includes(error.code)) throw new PendingInputStorageError("Queue authority storage unavailable", error);
      if (error instanceof RepositoryStoreError && error.state === "unavailable" || (error instanceof DomainError || error instanceof WorkstreamAdapterError) && ["SOURCE_UNAVAILABLE", "UNAVAILABLE", "BUSY", "NATIVE_CONTEXT_UNAVAILABLE", "unavailable"].includes(error.code) || (error instanceof WorkstreamAdapterError || error instanceof WorkspaceError) && error.status === 503) throw new PendingInputDomainError("pending-input-pin-unavailable", error.message, 503);
      if (error instanceof UserInputPreparationError || error instanceof WorkstreamAdapterError || error instanceof WorkspaceError || error instanceof DomainError) throw new PendingInputDomainError(enqueuePolicy ? "pending-input-pin-unavailable" : error instanceof UserInputPreparationError ? "configuration-changed" : "context-changed", error.message);
      throw new PendingInputStorageError("Queue preflight invariant failed", error);
    };
    try {
      const basic = () => {
        if (signal?.aborted) throw new PendingInputDomainError("bridge-closing", "Queue preflight aborted");
        if (enqueuePolicy) queueGuard("enqueue", id);
        const session = meta.sessions.find(s => s.sessionId === id);
        if (!enqueuePolicy && (!session || !sameDispatchSource(dispatchSource(session), { harnessId: prepared.binding.harness, sessionId: id, authorityId: prepared.binding.authorityId, nativeSessionId: prepared.binding.nativeSessionId ?? null, cwd: prepared.binding.cwd }))) throw new PendingInputDomainError("source-changed", "Queue source changed");
        assertPreparedUserInputCurrent(prepared, preparationState());
        if (captured && !equalPendingPin(admissions.get(id), captured.admission)) throw new PendingInputDomainError("source-changed", "Captured queue admission changed");
      };
      basic();
      const a = admissions.get(id);
      if (!a || a.state !== "ready" || !a.nativeId) throw new PendingInputDomainError("pending-input-source-unready", "Established ready admission is required");
      await router!.execution(a);
      basic();
      const adapter = await router!.forAdmission(a);
      basic();
      // App-only repository admissions must be explicitly enrolled when a domain
      // appears; do not silently promote/rebind an immutable queue authority.
      if (!adapter && a.binding.checkoutPin) {
        const inspected = await router!.inspect(a.binding.workspaceId);
        basic();
        if (inspected.state !== "uninitialized" || inspected.code !== "NOT_INITIALIZED") {
          if (inspected.state === "ready") throw new PendingInputDomainError(enqueuePolicy ? "pending-input-domain-changed" : "context-changed", "Repository domain changed; explicitly enroll before queuing");
          throw new RepositoryStoreError(inspected);
        }
      }
      const context = (): PendingInputPins["context"] => {
        if (!adapter) return null;
        const ref = { harness: a.source.descriptor.harness, authorityId: a.source.authorityId, nativeId: a.nativeId! };
        const c = adapter.domain.resolveContext(ref);
        return { conversation: c.conversation, membership: adapter.domain.getActiveMembership(ref),
          workstream: c.workstream ? { id: c.workstream.id, repositoryId: c.workstream.repositoryId, defaultCheckout: c.workstream.defaultCheckout } : null,
          primaryCheckout: c.primaryCheckout, artifactsRoot: c.artifactsRoot,
          assignments: c.workstream ? adapter.domain.getWorkstreamStatus(c.workstream.id).activePhases.filter(p => p.ref.harness === ref.harness && p.ref.authorityId === ref.authorityId && p.ref.nativeId === ref.nativeId).sort((x, y) => x.id.localeCompare(y.id)) : [] };
      };
      const pins = decodePendingInputPins({ admission: a, catalog: { workspaceId: a.binding.workspaceId, worktreeId: a.binding.worktreeId, bindingRevision: a.binding.bindingRevision, cwd: a.binding.executionCheckout },
        configuration: prepared.expectedPrior!.configuration, launch: prepared.configuration, context: context() });
      if (captured && !equalPendingPin(pins, captured)) throw new PendingInputDomainError("context-changed", "Fresh queue pins differ from the captured chain");
      const validate = () => {
        try {
          basic();
          const current = admissions.get(id), association = catalog.association(id);
          if (!equalPendingPin(current, a) || association.association !== "resolved" || association.workspaceId !== a.binding.workspaceId || association.worktreeId !== a.binding.worktreeId) throw new PendingInputDomainError(enqueuePolicy ? "pending-input-admission-changed" : "source-changed", "Queue admission/catalog association changed");
          catalog.assertBinding(a.binding.workspaceId, a.binding.worktreeId, a.binding.executionCheckout, a.binding.bindingRevision);
          if (normalizeNativeSource(a.source.descriptor).authorityId !== a.source.authorityId) throw new PendingInputDomainError(enqueuePolicy ? "pending-input-source-changed" : "source-changed", "Native authority changed");
          if (a.binding.checkoutPin) {
            const discovered = discoverRepository(a.binding.executionCheckout);
            const inspected = inspectRepositoryStore(discovered);
            if (inspected.state !== "ready" && inspected.state !== "uninitialized") throw new RepositoryStoreError(inspected);
            if (!equalPendingPin(discovered.invocationCheckout, a.binding.checkoutPin) || (!adapter ? inspected.state !== "uninitialized" : inspected.state !== "ready" || inspected.context.repositoryId !== adapter.repositoryId)) throw new PendingInputDomainError(enqueuePolicy ? "pending-input-domain-changed" : "context-changed", "Queue repository source/domain changed");
            adapter?.domain.validateHandle();
          }
          if (!equalPendingPin(context(), pins.context)) throw new PendingInputDomainError(enqueuePolicy ? "pending-input-context-changed" : "context-changed", "Queue membership/assignment/context changed");
        } catch (error) { domainError(error); }
      };
      validate(); return { pins, validate };
    } catch (error) { return domainError(error); }
  }
  pendingInputs = new PendingInputService({ dataDir: options.dataDir, storeId: store.manifest.storeId, session: id => meta.sessions.find(s => s.sessionId === id), guard: queueGuard, preflight: queuePreflight, failClosed,
    committed: notifyPendingInput,
    automationStarted: pendingInputAutomationHealthy,
    resumeCommitted: commit => {
      if (!pendingInputBridge) throw new Error("Resume consumer not constructed");
      return pendingInputBridge.resumeCommitted(commit);
    },
    mutationGuard: () => {
      // Private original-outcome scope only; neither caller IDs nor readiness
      // can use this startup/closing exception to claim, link or submit.
      if (pendingInputRecovery?.writing() && !storageFailed) return;
      // Sole startup exception: synchronous lock-owned classification, not a
      // general pre-readiness mutation capability or a dispatch authorization.
      if (!startupReady) {
        if (classifyingPendingInputs && !closing && !storageFailed) return;
        throw new PendingInputDomainError("startup-classifying", "Startup queue classification is incomplete", 503);
      }
      if (!pendingInputBridge) throw new PendingInputDomainError("pending-input-dispatch-dormant", "Consumer not constructed");
      pendingInputBridge.assertMutationOwned();
    },
    validateDispatch: input => {
      if (pendingInputRecovery?.validateDispatch(input)) return;
      if (!pendingInputBridge) throw new PendingInputDomainError("pending-input-dispatch-dormant", "Consumer not constructed");
      pendingInputBridge.validateDispatch(input);
    },
    prepare: (id, text) => prepareUserInput({ sessionId: id, prompt: text }, { ...preparationState(), defaultCwd: options.cwd, conversationId: () => crypto.randomUUID(), sourceAuthorityId: nativeSource,
      selectedDirectory: async (workspaceId, worktreeId) => (await catalog.binding(workspaceId, worktreeId)).cwd, ensureDirectory, validateOpenCodeModel: (model, effort) => oc.model(model, effort), resolveOpenCodeLaunch: (cwd, settings) => oc.resolveLaunch(cwd, settings) }),
    supervise: async action => { const task = Promise.withResolvers<void>(); queueServiceTasks.add(task.promise); try { return await action(); } finally { task.resolve(); queueServiceTasks.delete(task.promise); } },
  });
  function queueSubmissionSafety(id: string) {
    if (closing || storageFailed || !startupReady) throw new PendingInputDomainError("pending-input-owner-unavailable", "Queue submission ownership unavailable", 503);
    const session = meta.sessions.find(s => s.sessionId === id);
    if (!session || session.hidden || sessionHarness(session) === "claude-code" && session.attachment) throw new PendingInputDomainError("pending-input-unavailable", "Queue conversation is hidden, missing or requires an external-stopped acknowledgement");
    const denied = readinessPolicy({ conversationId: id, intent: { kind: "user-prompt" }, phase: "enqueue" });
    if (denied) throw new PendingInputDomainError(denied.code, denied.reason);
  }
  const queueCurrentAppIdle: Parameters<typeof createPendingInputBridge>[0]["currentAppIdle"] = (source, own) => {
    const id = source.sessionId;
    queueSubmissionSafety(id);
    const session = meta.sessions.find(s => s.sessionId === id)!, admission = admissions.get(id);
    if (source.harnessId !== "claude-code" || !sameDispatchSource(source, dispatchSource(session))) throw new PendingInputDomainError("source-changed", "Current App idle source differs from the captured queue source");
    const blocked = (reason: string) => ({ ready: false as const, code: "claude-local-unproven" as const, reason });
    const association = catalog.association(id);
    if (!admission || admission.state !== "ready" || !source.nativeSessionId || admission.nativeId !== source.nativeSessionId
      || admission.source.authorityId !== source.authorityId || normalizeNativeSource(admission.source.descriptor).authorityId !== source.authorityId
      || admission.binding.executionCheckout !== source.cwd || association.association !== "resolved"
      || association.workspaceId !== admission.binding.workspaceId || association.worktreeId !== admission.binding.worktreeId)
      throw new PendingInputDomainError("source-changed", "Current App idle admission/catalog source changed");
    catalog.assertBinding(admission.binding.workspaceId, admission.binding.worktreeId, source.cwd, admission.binding.bindingRevision);
    if (retainOwner || meta.reconciliationRequired || coordinator.hasReconciliation(id)
      || handoffReservations.has(id) || handoffDispatches.has(id)) return blocked("Current App admission, reconciliation or handoff remains held");
    if (workers.tree(id).some(w => !w.outcome || w.continuation && !["completed", "failed", "interrupted"].includes(w.continuation.state)
      || workerResults(w).some(r => ["pending", "claimed", "acceptance-unknown"].includes(r.notification.state)))
      || workerStore.hasActiveDelivery(id))
      return blocked("Current App workers or pending reports remain unresolved");
    if (own && (!coordinator.holdsAdmission(own.lease, id) || !sameDispatchSource(own.identity.source, source))) return blocked("Original queue reservation is no longer current");
    const owner = coordinator.getOwner(id);
    if (owner && owner !== own?.owner || coordinator.hasAdmission(id) && !own) return blocked("A foreign App owner or admission is present");
    if (own?.owner) {
      const run = own.owner.run, claim = pendingInputs!.store.lookup(id, own.identity.requestId!)?.item.claim;
      if (owner !== own.owner || !coordinator.owns(own.owner) || meta.runs.find(r => r.runId === own.identity.runId) !== run
        || run.runId !== own.identity.runId || run.sessionId !== id || run.cwd !== source.cwd || (run.nativeCommandId ?? null) !== own.identity.nativeCommandId
        || run.status !== "running" || own.owner.nativeDispatched || own.owner.settled || own.owner.stopRequested || own.owner.cancelling || own.owner.stopping
        || run.saneContextVersion !== session.saneContext?.version || !claim || claim.possibleNative || claim.uncertain || !equalPendingPin(claim.identity, own.identity))
        return blocked("Only the exact published unattempted queue owner may exclude its preparation");
    }
    if (meta.runs.some(run => run.sessionId === id && (run.status === "running" && run !== own?.owner?.run
      || claudeRuns.followupPending(run.queuedFollowupId ?? "")))) return blocked("Other App running metadata or followup remains unresolved");
    if (pendingInputs!.store.readRecords().conversations.filter(c => c.conversationId === id).some(c => c.items.some(item =>
      ["claimed", "run-linked"].includes(item.state) && (!own || !item.claim || item.claim.possibleNative || item.claim.uncertain || !equalPendingPin(item.claim.identity, own.identity)))))
      return blocked("Another unresolved App queue claim remains held");
    // Fresh aggregate service observation at EVERY boundary; no preclaim cache.
    // Its sole exclusion is the exact private owner above, before intent writes.
    return claudeRuns.readLocalIdle(id, own?.owner);
  };
  pendingInputBridge = createPendingInputBridge({ store: pendingInputs.store, coordinator,
    wake: () => notifyPendingInput("lifecycle"),
    run: id => meta.runs.find(run => run.runId === id),
    isClosing: () => closing, storageFailed: () => storageFailed,
    submissionSafety: queueSubmissionSafety,
    pins: (prepared, captured, signal) => queuePins(prepared, false, captured, signal),
    nativeReadiness: pinnedNativeReadiness,
    terminalSnapshot: (source, commandId) => readOnlyDispatchProof(() => oc.snapshot(source.nativeSessionId!, commandId, source.cwd)),
    readPendingCancellation: owner => ocRuns.readPendingCancellation(owner),
    groupAlive, readLocalSettlement: owner => claudeRuns.readLocalSettlement(owner), currentAppIdle: queueCurrentAppIdle, failClosed,
    // Resolve the existing supervised admission when the scheduler polls,
    // after startup constructs it; do not capture an uninitialized service.
    admit: async (prepared, lease, input) => {
      const task = Promise.withResolvers<void>(); queueAdmissionTasks.add(task.promise);
      try { return await preparedInput.admit(prepared, lease, input); }
      catch (error) {
        if (error instanceof WorkstreamAdapterError && ["STORAGE_ERROR", "CORRUPT_STORE"].includes(error.code)) throw new PendingInputStorageError("Queue admission authority storage failed", error);
        if (error instanceof WorkstreamAdapterError) throw new PendingInputDomainError(error.code, error.message, error.status as 400 | 404 | 409 | 429 | 503);
        if (error instanceof UserInputPreparationError) throw new PendingInputDomainError(error.code ?? "pending-input-admission-refused", error.reason ?? error.message, error.status);
        throw error;
      }
      finally { task.resolve(); queueAdmissionTasks.delete(task.promise); }
    },
  });
  pendingInputWake = createPendingInputWake({
    canRun: startupStorageHealthy,
    hasWork: () => pendingInputs!.store.hasPendingWork(),
    poll: () => pendingInputBridge!.consumer.poll(), onError: failClosed,
  }, options.pendingInputWakeClock);
  // The outer owner starts this only after publishing both serving lock records.
  const pendingInputConsumer = pendingInputBridge.consumer;
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
        // Evaluate automation health after native discovery's await, not before.
        const nativeConnection = signedIn ? await oc.connection(options.cwd) : undefined;
        return json({ authRequired: !!password, authenticated: signedIn, cwd: signedIn ? options.cwd : null, oneShot: true, ...(signedIn ? { storeId: store.manifest.storeId, conversationUpdates: true, ...(pendingInputAutomationHealthy() ? { pendingInputCapability: { protocol: "pending-input", version: 1, supported: true, maxWaiting: 3, removal: true, resume: true } } : {}), capabilities: { concurrency: { scope: "conversation", limit: maxConcurrentRuns, perConversation: 1, sharedCheckoutWrites: true }, cancelRun: true, midRunInput: false, permissionReplies: true, attachments: false, modelSelection: true, effortValues: efforts, terminal: terminals.capability }, agents: ASSISTANT_AGENT_IDS.map(id => ({ id, label: ASSISTANT_AGENT_LABELS[id], description: ASSISTANT_AGENT_DESCRIPTIONS[id] })), agentProfiles, harnesses: [
          { id: "claude-code", name: getHarnessDescriptor("claude-code")!.label, available: true, connected: true, state: "available", capabilities: capabilitiesFor("claude-code") },
          { id: "opencode", name: getHarnessDescriptor("opencode")!.label, ...nativeConnection, capabilities: capabilitiesFor("opencode") },
        ] } : {}) });
      }
      if (path === "/api/login" && req.method === "POST") return await auth.login(req, expected);
      if (path === "/api/logout" && req.method === "POST") {
        // BridgeAuth revokes every supplied token (and the local token), using
        // the shared revocation callback for terminals and push enrollments.
        return auth.logout(req);
      }
      if (path.startsWith("/api/") && !auth.authenticated(req)) return json({ error: "Authentication required" }, 401);
      if (!startupReady && path.startsWith("/api/") && !["GET", "HEAD"].includes(req.method)) return json({ error: "Startup execution classification is incomplete", code: "startup-classifying" }, 503);
      if (path.startsWith("/api/push/")) {
        const owner = auth.terminalToken(req) ?? "local";
        return (await chromePush!.route(req, owner, () => !closing && auth.authenticated(req)
          && (auth.terminalToken(req) ?? "local") === owner)) ?? json({ error: "Not found" }, 404);
      }
      if (path === "/api/conversation-updates" || path === "/api/conversation-updates/bootstrap") {
        return (await conversationUpdateRoute(req, { bootstrap: limit => updates.page({ limit }, true), page: input => updates.page(input) }))!;
      }
      const mutatingSession = /^\/api\/sessions\/([^/]+)(?:\/|$)/.exec(path)?.[1];
      // Auth/startup checks above, but before blanket branch mutation refusal:
      // an independent waiting-item removal is allowed even on a paused branch.
      const queueResponse = await pendingInputRoute(req, path, pendingInputs!);
      if (queueResponse) return queueResponse;
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
           if (path === "/api/workstreams/init" && req.method === "POST") { const result = await router!.initialize(workspaceId); notifyPendingInput("domain"); return result; }
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
          const workstreams = await (req.method === "GET" ? router!.forPolling(workspaceId) : router!.forWorkspace(workspaceId));
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
            assertPendingInputDomainMutation(pendingInputs!.store.readRecords().conversations, workstreams.domain,
              input.operation === "phase/end" ? { kind: "phase/end", assignmentId: input.assignmentId }
                : input.operation === "associate" ? { kind: "associate", ref: input.ref, workstreamId: input.workstreamId } : { kind: "phase/assign", ref: input.ref });
            const available = availability(target || undefined, false);
            if (!available.canSend) throw new WorkstreamAdapterError(409, "bridge-busy", available.reason!);
             return queueDomainCommitted(() => workstreams.manage(input.ref, input.operation, input));
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
            // The adapter reserves at the actual backend call, covering callers
            // other than HTTP and enqueue/preflight throughout core's awaits.
            if (action === "approve") await adapter.approve(actionInput.id, actionInput.phase, actionInput.approvalRef!, actionInput.expectedRevision);
            else await adapter.provide(actionInput.id, actionInput.phase, false, actionInput.expectedRevision);
            return { action, phase: actionInput.phase, ok: true } satisfies WorkstreamActionResult;
          }
            if (path === "/api/workstreams") return queueDomainCommitted(() => workstreams.create({ id: input.id, title: input.title, type: input.type, defaultCheckout: input.defaultCheckout }));
           if (operation === "default-checkout") return queueDomainCommitted(() => workstreams.setDefaultCheckout(input.id, input.checkout));
          if (operation === "target") return workstreams.resolveTarget(input.id, input.phase, input.target);
          if (!["conversation", "associate", "phase/assign", "phase/end", "context"].includes(operation)) throw new WorkstreamAdapterError(404, "not-found", "Unknown workstream operation");
          const session = meta.sessions.find(s => s.sessionId === input.sessionId);
          if (!session) throw new WorkstreamAdapterError(404, "not-found", "Unknown App conversation");
          const admission = admissions.get(session.sessionId);
          if (!admission || admission.binding.workspaceId !== workspaceId) throw new WorkstreamAdapterError(409, "repository-mismatch", "Conversation belongs to another workspace");
          await router!.forAdmission(admission, workspaceId);
          if (operation === "conversation") return workstreams.conversation(session);
          if (operation === "context") return workstreams.invocation(session);
          assertPendingInputDomainMutation(pendingInputs!.store.readRecords().conversations, workstreams.domain,
            operation === "phase/end" ? { kind: "phase/end", assignmentId: input.assignmentId }
              : operation === "associate" ? { kind: "associate", ref: workstreams.reference(session), workstreamId: input.workstreamId } : { kind: "phase/assign", ref: workstreams.reference(session) });
          const available = availability(session.sessionId, false);
          if (!available.canSend) throw new WorkstreamAdapterError(409, "bridge-busy", available.reason!);
           if (operation === "associate") return queueDomainCommitted(() => workstreams.associate(session, input.workstreamId));
           if (operation === "phase/assign") return queueDomainCommitted(() => workstreams.assignPhase(session, input.phase));
           return queueDomainCommitted(() => workstreams.endPhase(session, input.assignmentId));
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
      if (path === "/api/workspaces/create") {
        if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
        return json(await workspaceCreations!.create(await body(req), () => !closing && auth.authenticated(req)), 201);
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
        } catch (error) {
          if (error instanceof PendingInputStorageError) throw error;
          return json({ error: "Cancellation requires {ids, includeDescendants?} within this parent's worker tree, or {all:true}. Inspect worker status before retrying.", code: "worker-cancel" }, 409);
        }
      }
      const handoffList = /^\/api\/sessions\/([^/]+)\/handoffs$/.exec(path);
      if (handoffList && req.method === "GET") {
        const listed = await handoffs.forSession(decodeURIComponent(handoffList[1]!));
        return json({ handoffs: listed.map(presentation => ({ ...presentation, ...(handoffProblems.has(presentation.handoff.id) ? { problem: handoffProblems.get(presentation.handoff.id) } : {}) })) });
      }
      const workerList = /^\/api\/sessions\/([^/]+)\/workers$/.exec(path);
      if (workerList && req.method === "GET") {
        if (!meta.sessions.some(s => s.sessionId === workerList[1])) return json({ error: "Unknown parent session" }, 404);
        return json({ workers: await Promise.all(workers.tree(workerList[1]!).map(w => workers.refresh(w))), deliveries: workerStore.deliveriesForParent(workerList[1]!), continuationSuppressed: workerStore.suppressed(workerList[1]!) });
      }
      if (path === "/api/sessions" && req.method === "GET") {
        // Native continuations outlive the App's exact command run. Observe the
        // shared activity catalog once, without rewriting any completed run.
        let nativeActive: Record<string, { type: string }> = {}, nativeError = "";
        if (meta.sessions.some(s => s.harness === "opencode")) {
          try { nativeActive = await nativeObservations.active(); }
          catch (error) { nativeError = error instanceof Error ? error.message : "OpenCode activity unavailable"; }
        }
        // Capture after native observation's await, then consume synchronously.
        const read = sessionListProjection(workerStore.list(), workerStore.deliveries(), branches.list(), [
          ...recoveredInputConversations, ...handoffDispatches.keys(),
          ...meta.runs.filter(run => run.status === "running").map(run => run.sessionId),
        ]);
        const rows: SessionListRow[] = meta.sessions.map(session => {
          const observedAt = historyRefreshes.get(session.sessionId);
          const owner = owners.get(session.sessionId);
          const activity = observedAt ? { phase: "refreshing" as const, observedAt }
            : owner && session.harness === "claude-code" ? claudeRuns.activity(owner) : undefined;
          return {
            session, activity,
            updateSource: replyIntegration?.updateSource(session.sessionId),
            admission: admissions.get(session.sessionId),
            association: catalog.association(session.sessionId),
            availability: availability(session.sessionId, true, false, false, "user", read),
          };
        });
        return json(sessionListResponse({
          rows, runs: meta.runs, events, indexes: read,
          native: { active: nativeActive, error: nativeError },
          admissions: admissions.list(),
          availability: availability(undefined, true, false, false, undefined, read),
        }, claudeRuns));
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
        if (!available.canSend) return json({ error: available.reason, code: available.code }, 409);
        assertBranchIdle(source);
        if (branchRequests.has(input.requestId)) return json({ error: "This branch request is already in progress. Please wait." }, 409);
        branchRequests.add(input.requestId);
        const lease = reserve({ kind: "branch", requestId: input.requestId }, source.sessionId);
        const branchDone = Promise.withResolvers<void>(); attachmentTasks.add(branchDone.promise);
        let op: BranchOperation | undefined;
        try {
          const boundary = await branchBoundary(source, input.runId, input.messageId);
          const adapter = await branchDomain(source, true), state = adapter?.domain.branchState(adapter.reference(source));
          if (state?.phases.length && !input.replace) throw new Error("Active phase assignments require Replace original");
          op = { id: input.requestId, sourceId: source.sessionId, destinationId: crypto.randomUUID(), ...boundary, selector, replace: input.replace, state: "reserved", createdAt: new Date().toISOString(), ...(input.prompt.trim() ? { firstMessage: input.prompt } : {}) };
          branches.save(op);
          const extension = coordinator.extendAdmission(lease, [op.destinationId]);
          if (!extension.ready) throw new WorkstreamAdapterError(extension.code === "capacity" ? 429 : 409, extension.code, extension.reason);
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
            if (sessionHarness(destination) === "opencode") { run.nativeCommandId = `msg_${crypto.randomUUID().replaceAll("-", "")}`; run.nativePhase = "preparing"; }
            const effectivePrompt = sessionHarness(destination) === "opencode" && isStoredAssistantAgentId(destination.agent) && !destination.nativeAgentSelected ? `[SANE role: ${storedAssistantLabel(destination.agent)} assistant. Follow the SANE ${storedAssistantLabel(destination.agent)} assistant procedures for this conversation.]\n\n${input.prompt}` : input.prompt;
            const lifecycle = executePrompt(lease, destination, run, effectivePrompt, true, "user");
            await lifecycle.admission;
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
        } finally { coordinator.releaseAdmission(lease); branchRequests.delete(input.requestId); branchDone.resolve(); attachmentTasks.delete(branchDone.promise); }
      }
      const branchRecovery = /^\/api\/branches\/([^/]+)\/recover$/.exec(path);
      if (branchRecovery && req.method === "POST") {
        const op = branches.get(branchRecovery[1]!);
        if (!op) return json({ error: "Unknown branch operation" }, 404);
        if (closing || storageFailed || meta.reconciliationRequired || owners.has(op.sourceId) || owners.has(op.destinationId) || admitting.has(op.sourceId) || admitting.has(op.destinationId)) return json({ error: "Branch recovery requires an available bridge and settled source/destination runs" }, 409);
        const lease = reserve({ kind: "branch-recovery", requestId: op.id }, op.sourceId, op.destinationId);
        const recoveryDone = Promise.withResolvers<void>(); attachmentTasks.add(recoveryDone.promise);
        try {
          if (op.state === "reserved") {
            await releaseBranch(op, "Interrupted before native creation. Reservation released; original unchanged.");
          } else if (op.state !== "failed") await finishBranch(op.id);
          return json({ operation: branches.get(op.id), sessionId: branches.get(op.id)?.state === "completed" ? op.destinationId : undefined });
        } catch (error) {
          const current = branches.get(op.id)!, message = error instanceof Error ? error.message : "Recovery unavailable";
          branches.save({ ...current, error: message }); return json({ error: message, operation: branches.get(op.id) }, 409);
        } finally { coordinator.releaseAdmission(lease); recoveryDone.resolve(); attachmentTasks.delete(recoveryDone.promise); }
      }
      const admissionRoute = /^\/api\/sessions\/([^/]+)\/(enroll|retry-admission)$/.exec(path);
      if (admissionRoute && req.method === "POST") {
        const sessionId = admissionRoute[1]!, session = meta.sessions.find(s => s.sessionId === sessionId);
        if (!session) return json({ error: "Unknown conversation" }, 404);
        if (closing || storageFailed || owners.has(sessionId) || admitting.has(sessionId)) return json({ error: "Conversation unavailable" }, 409);
        const lease = reserve({ kind: admissionRoute[2] === "enroll" ? "enroll" : "retry-admission" }, sessionId);
        try {
          if (admissionRoute[2] === "enroll") await admissions.enroll(sessionId);
          const pending = admissions.get(sessionId)!;
          // Do not confuse uncertain creation with same-known-identity retry.
          if (!pending.nativeId) return json({ error: "Native creation identity is unknown; operator inspection required", code: "native_creation_unknown" }, 409);
          if (session.harness === "opencode") await oc.assertIdle(pending.nativeId, pending.binding.executionCheckout);
          else if (!(await readClaudeHistory(pending.nativeId, pending.binding.executionCheckout, claudeRoot)).length && pending.operation !== "create") return json({ error: "Native history unavailable" }, 409);
          await admissions.register(sessionId); await persist(); admissions.ready(sessionId);
          replyIntegration?.requestRefresh();
          return json({ admission: admissions.get(sessionId) });
        } finally { coordinator.releaseAdmission(lease); }
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
        const lease = reserve({ kind: "attach" }, sessionId);
        attaching.add(key);
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
          replyIntegration?.requestRefresh();
          return json({ sessionId, nativeSessionId, harness, ...association, history }, 201);
        } catch (error) {
          if (session?.attachment) { session.attachment = { ...session.attachment, state: "pending", error: error instanceof Error ? error.message : "Attachment failed" }; if (!storageFailed) await persist().catch(() => {}); }
          return json({ error: error instanceof Error ? error.message : "Attachment unavailable", ...(session ? { sessionId, attachment: "pending", recovery: "Retry Attach with the same identity and cwd after resolving the error. No prompt was sent." } : {}) }, error instanceof OpenCodeError || error instanceof WorkstreamAdapterError || error instanceof WorkspaceError ? error.status : error instanceof DomainError && error.code !== "STORAGE_ERROR" ? 409 : 503);
        } finally { attaching.delete(key); coordinator.releaseAdmission(lease); attachmentDone.resolve(); attachmentTasks.delete(attachmentDone.promise); }
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
        if (input?.sessionId && uuid(input.sessionId) && pendingInputs!.hasChain(input.sessionId)) return json({ error: "A durable input chain is active; use the explicit pending-inputs API", code: "pending-input-chain-active" }, 409);
        const prepared = await prepareUserInput(input, { profiles: agentProfiles, getSession: id => meta.sessions.find(s => s.sessionId === id),
          defaultCwd: options.cwd, conversationId: () => crypto.randomUUID(), sourceAuthorityId: nativeSource,
          selectedDirectory: async (workspaceId, worktreeId) => (await catalog.binding(workspaceId, worktreeId)).cwd,
          ensureDirectory, validateOpenCodeModel: (model, effort) => oc.model(model, effort), resolveOpenCodeLaunch: (cwd, settings) => oc.resolveLaunch(cwd, settings) });
        const { conversationId, cwd } = prepared.binding;
        const oldOwner = owners.get(conversationId);
        const admission = coordinator.reserveAdmission({ conversationIds: [conversationId], intent: { kind: "user-prompt" },
          ...(oldOwner && claudeRuns.canQueueFollowup(oldOwner) ? { predecessor: oldOwner } : {}) });
        if (!admission.ready) return json({ error: admission.reason, code: admission.code }, admission.code === "capacity" ? 429 : 409);
        const lease = admission.lease;
        // Reserve admission through old-owner settlement and new-owner creation.
        // This exact reservation belongs only to this send, never another task.
        if (admission.queueAfterRunId) {
          const task = Promise.withResolvers<void>();
          queuedInputTasks.add(task.promise);
          let queued;
          try {
            queued = await claudeRuns.queueFollowup(oldOwner!, prepared.prompt, { cwd, profileId: prepared.configuration.profileId,
              ...(prepared.configuration.model !== undefined ? { model: prepared.configuration.model } : {}), ...(prepared.configuration.effort !== undefined ? { effort: prepared.configuration.effort } : {}), ...(prepared.configuration.agent !== undefined ? { agent: prepared.configuration.agent } : {}) });
          } catch (error) {
            coordinator.releaseAdmission(lease); task.resolve(); queuedInputTasks.delete(task.promise);
            throw error;
          }
          void claudeRuns.drainQueuedFollowup(oldOwner!, async receipt => {
            try {
              const result = await admitPreparedInput(prepared, lease, { queuedFollowupId: receipt.requestId });
              return { runId: result.runId };
            } catch (error) {
              // No new owner/run means definite non-submission. The queue keeps
              // its text, and this validation failure is not a storage failure.
              if (!meta.runs.some(r => r.queuedFollowupId === receipt.requestId)) {
                return { notSubmitted: true };
              }
              throw error;
            }
          }).catch(() => { /* Queue/launch journals retain the outcome; never auto-retry. */ }).finally(() => {
            coordinator.releaseAdmission(lease); task.resolve(); queuedInputTasks.delete(task.promise);
          });
          const receipt = projectClaudeFollowups(conversationId, meta.runs, id => events.get(id) ?? [], id => claudeRuns.followupPending(id)).find(r => r.requestId === queued.requestId)!;
          return json({ sessionId: conversationId, queued: true, receipt }, 202);
        }
        const task = Promise.withResolvers<void>(); attachmentTasks.add(task.promise);
        try { const { lifecycle: _lifecycle, ...response } = await admitPreparedInput(prepared, lease); return json(response, 202); }
        finally { coordinator.releaseAdmission(lease); task.resolve(); attachmentTasks.delete(task.promise); }
      }
      const nativeSubagent = /^\/api\/sessions\/([^/]+)\/native-subagents(?:\/([^/]+)\/([^/]+))?$/.exec(path);
      if (nativeSubagent) {
        if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
        try {
          const selectors = nativeSubagent.slice(1).map(value => value === undefined ? undefined : decodeURIComponent(value));
          return json(selectors[1] === undefined ? nativeSubagents.list(selectors[0]!, url.searchParams)
            : nativeSubagents.page(selectors[0]!, selectors[1], selectors[2]!, url.searchParams));
        } catch (error) {
          if (error instanceof URIError) return json({ error: "Invalid native subagent selector", code: "native-subagent-input" }, 400);
          if (error instanceof NativeSubagentError) return json({ error: error.message, code: error.code }, error.status);
          throw error;
        }
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
          return json({ history: await observedHistory.get(session) ?? null });
        }
        if (reconciliation[2] !== "reconcile" || req.method !== "POST") return json({ error: "Method not allowed" }, 405);
        const available = availability(session.sessionId);
        if (!available.canSend) return json({ error: available.reason }, available.code === "capacity" ? 429 : 409);
        const lease = reserve({ kind: "history-refresh" }, session.sessionId);
        historyRefreshes.set(session.sessionId, new Date().toISOString());
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
        finally { historyRefreshes.delete(session.sessionId); coordinator.releaseAdmission(lease); }
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
          const owner = pendingInputControls.stop(session.sessionId);
          claudeRuns.cancelFollowup(session.sessionId);
          pendingInputControls.cancellationWrite(() => workerStore.suppress(session.sessionId, true)); // Idle too; never cascade.
          const worker = workerStore.getBySession(session.sessionId);
          if (worker && !worker.outcome) pendingInputControls.cancellationWrite(() => workerStore.update(worker.id, { state: "cancelling", cancelRequestedAt: worker.cancelRequestedAt ?? new Date().toISOString() }));
          if (recoveredInputConversations.has(session.sessionId)) {
            const finished = Promise.withResolvers<void>(); attachmentTasks.add(finished.promise);
            try { return json({ ...(await pendingInputRecovery!.stop(session.sessionId)), code: "pending-input-reconciliation-required" }); }
            finally { finished.resolve(); attachmentTasks.delete(finished.promise); }
          }
          if (!owner) return json({ interrupted: false, status: session.lastStatus,
            ...(recoveredInputConversations.has(session.sessionId) ? { code: "pending-input-reconciliation-required", reconciliationRequired: true } : {}),
            reason: "No active App-owned run; external execution must be stopped in its native harness" });
          if (!owner.cancel) {
          owner.cancelling = true;
          owner.cancel = (async () => {
            owner.stopRequested = true;
            if (owner.run.status === "running") await emit(owner.run, "status", { status: "running", connection: "stopping", reason: "Stop requested; waiting for terminal evidence" });
            if (owners.get(session.sessionId) !== owner || owner.run.status !== "running") return { interrupted: false };
            if (owner.native) return ocRuns.interruptCurrent(owner);
            const stopped = await terminate(owner);
            return { interrupted: stopped };
          })().finally(() => {
            // A native restart can resume execution after this acknowledgement.
            // Keep ownership until terminal evidence, but do not cache a settled
            // interrupt forever. Concurrent Stops still share this attempt.
            if (owner.native) owner.cancel = undefined;
            owner.cancelling = false; releaseOwner(owner);
          });
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
          if (recoveredInputConversations.has(session.sessionId)) return json({ code: "pending-input-reconciliation-required", error: "Recovered queued execution is uncertain; native interaction mutation is unavailable" }, 409);
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
        const hidden = visibilityMatch[2] === "hide";
        if (hidden && !session.hidden) pendingInputControls.hide(session.sessionId);
        session.hidden = hidden;
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
      else if (path === "/push-worker.js") {
        const worker = Bun.file(join(assetsDir, "push-worker.js"));
        if (!await worker.exists()) return json({ error: "Not found" }, 404);
        return new Response(req.method === "HEAD" ? null : worker, { headers: {
          "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "service-worker-allowed": "/",
        } });
      }
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
    } catch (error) {
      if (error instanceof PendingInputStorageError) { failClosed(); return json({ error: error.message, code: "storage-unavailable" }, 503); }
      if (error instanceof PendingInputDomainError) return json({ error: error.message, code: error.code }, error.status);
      return error instanceof UserInputPreparationError ? json({ error: error.message, ...(error.code ? { code: error.code } : {}), ...(error.reason ? { reason: error.reason } : {}) }, error.status) : error instanceof HarnessOperationError || error instanceof WorkstreamAdapterError ? json({ error: error.message, code: error.code }, error.status) : error instanceof DomainError ? json({ error: error.message, code: error.code }, error.code === "NOT_FOUND" ? 404 : 409) : error instanceof WorkspaceError ? json({ error: error.message, code: error.code }, error.status) : error instanceof OpenCodeError ? json({ error: error.message }, [400, 404, 409].includes(error.status) ? error.status : 503) : json({ error: "Invalid request" }, 400);
    }
  }
  drainStartupExecution = async () => {
    await coordinator.close();
    await workers.drainLaunches();
    await terminals.close();
    await Promise.all([...owners.values()].map(async owner => {
      if (!owner.native && owner.child && !await terminate(owner)) retainOwner = true;
      await Promise.all([owner.done, owner.submission?.catch(() => {}), owner.cancel?.catch(() => {})]);
    }));
    await Promise.all([...dispatchTasks, ...attachmentTasks, ...queuedInputTasks, ...handoffDispatches.values(), workerOutboxTask, handoffTask]);
    await serial;
    await catalog.flush();
    if (!coordinator.reconciliationSessionIds().next().done) retainOwner = true;
  };
  const server = Bun.serve<TerminalSocketData>({ hostname: options.host, port: options.port, maxRequestBodySize: 1024 * 1024, websocket: terminals.websocket, fetch: (req, srv) => handle(req, srv, (request, data) => srv.upgrade(request, { data })) });
  boundListenerStops.push(async () => { await server.stop(true); });
  const hookServer = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 1024 * 1024, fetch: async (req, srv) => new URL(req.url).pathname === "/native/workers" ? (loopback(srv.requestIP(req)?.address ?? "") ? nativeWorker(req) : json({ error: "Forbidden" }, 403)) : new URL(req.url).pathname === "/native/handoffs" ? nativeHandoff(req) : new URL(req.url).pathname.startsWith("/hooks/") ? (await handle(req, srv)) ?? json({ error: "Not found" }, 404) : json({ error: "Not found" }, 404) });
  boundListenerStops.push(async () => { await hookServer.stop(true); });
  origin = options.publicOrigin ?? `http://${options.host.includes(":") ? `[${options.host}]` : options.host}:${server.port}`;
  atomicAppRecord(options.dataDir, "native-handoff.json", { version: 1, url: `http://127.0.0.1:${hookServer.port}/native/handoffs`, token: handoffToken, pid: process.pid });
  // Start recovery only after both listeners are acquired. A port-bind failure
  // must not leave observers writing after startup releases the ownership lock.
  recoveredInputClaims = classifyPendingInputMutation(() => pendingInputs!.recover());
  // Capture EVERY original synchronously before the first source/context await,
  // including journals whose Run metadata is missing. Reads never lazily repin.
  try { for (const item of recoveredInputClaims) originalJournals.capture(item); }
  catch (error) { failClosed(); throw error; }
  const originalJournal = (original: PendingInputStoredItem) => {
    try { return originalJournals.read(original); }
    catch (error) { failClosed(); throw error instanceof PendingInputStorageError ? error : new PendingInputStorageError("Original App journal authority lost", error); }
  };
  for (const item of recoveredInputClaims) recoveredInputConversations.add(item.claim!.identity.source.sessionId);
  // Publish capacity/policy barriers before ANY native legacy owner adoption or
  // automatic consumer. Current pin drift is scoped, never a non-submission proof.
  for (const item of recoveredInputClaims) {
    try {
      originalJournal(item);
      try { (await queuePins(item.snapshot.prepared, false, item.snapshot.pins)).validate(); }
      finally { originalJournal(item); }
    }
    catch (error) {
      if (!(error instanceof PendingInputDomainError)) throw error;
      if (["source-changed", "configuration-changed", "context-changed"].includes(error.code))
        classifyPendingInputMutation(() => pendingInputs!.store.pause(item.request.conversationId, { code: error.code as "source-changed" | "configuration-changed" | "context-changed", reason: error.message }));
      // Unavailable current pins leave the original restart/strong pause intact.
    }
  }
  const originalProtocolUnsafe = (original: PendingInputStoredItem) => originalJournal(original)?.records.some(event =>
    event.kind === "status" && !!event.data && typeof event.data === "object" && (event.data as Record<string, unknown>).nativeQueuedHandoffProtocolMismatch === true) ?? false;
  pendingInputRecovery = createPendingInputRecovery({ store: pendingInputs!.store, originals: recoveredInputClaims, service: ocRuns,
    available: observationWrite => {
      if (storageFailed || closing && !observationWrite) throw new PendingInputDomainError("pending-input-owner-unavailable", "Original lock-owned recovery observation unavailable", 503);
    },
    association: original => {
      const identity = original.claim!.identity, source = identity.source, id = source.sessionId;
      // Authorization is observation-only against the REAL coordinator and the
      // already-installed ORIGINAL occupancy. No second ownership registry or
      // fabricated Run is required when metadata has been lost. Ordinary gates
      // still deny all admission, including before startupReady is published.
      if (!recoveredInputClaims.includes(original) || !recoveredInputConversations.has(id)
        || !coordinator.occupiedConversationIds().has(id) || coordinator.hasOwner(id) || coordinator.hasAdmission(id)
        || coordinator.hasReconciliation(id) || retainOwner || meta.reconciliationRequired)
        throw new PendingInputDomainError("pending-input-unproven", "Original recovered coordinator association is not available");
      const session = meta.sessions.find(s => s.sessionId === id);
      if (!session || !sameDispatchSource(dispatchSource(session), source) || nativeSource("opencode") !== source.authorityId)
        throw new PendingInputDomainError("source-changed", "Original recovered native source changed");
      const run = meta.runs.find(run => run.runId === identity.runId);
      if (run && (run.sessionId !== id || run.cwd !== source.cwd || run.nativeCommandId !== identity.nativeCommandId))
        throw new PendingInputDomainError("source-changed", "Original recovered run journal association changed");
    },
    pins: async (original, signal) => {
      if (signal.aborted) throw new PendingInputDomainError("bridge-closing", "Recovery preflight closed");
      // The acquired validator must still permit original evidence while the
      // bounded drain retains locks; shutdown independently forbids new reads.
      const pins = await queuePins(original.snapshot.prepared, false, original.snapshot.pins);
      if (signal.aborted) throw new PendingInputDomainError("bridge-closing", "Recovery preflight closed");
      return pins;
    },
    protocolUnsafe: originalProtocolUnsafe,
    protocolMismatch: (original, reason, validate) => enqueue(async () => {
      validate();
      if (originalProtocolUnsafe(original)) return;
      const journal = originalJournal(original);
      if (!journal) throw new PendingInputStorageError("Original pending contradiction has no run journal");
      // Open the existing pinned ORIGINAL file, never create a log or serialize
      // fake Run metadata. This awaited queue participates in the bounded drain.
      const file = await open(journal.path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
      try {
        validate();
        const opened = await file.stat();
        validate();
        const current = originalJournal(original)!;
        if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== current.dev || opened.ino !== current.ino)
          throw new PendingInputStorageError("Original journal writer pin changed");
        if (originalProtocolUnsafe(original)) return;
        const identity = original.claim!.identity;
        const event: Event = { seq: current.records.at(-1)!.seq + 1, time: new Date().toISOString(), runId: identity.runId,
          sessionId: identity.source.sessionId, kind: "status", data: { connection: "unconfirmed", nativeQueuedHandoffProtocolMismatch: true, reason,
            recoveryOriginal: { storeId: store.manifest.storeId, itemId: original.itemId, chainId: original.chainId, attemptId: original.claim!.attemptId, identity } } };
        await file.appendFile(JSON.stringify(event) + "\n");
        validate(); originalJournal(original);
        await file.sync();
        validate(); originalJournal(original);
        // Publish only after the marker is durable. No transcript/lifecycle,
        // completion, wake, accepted evidence or metadata repair is performed.
        events.get(identity.runId)?.push(event);
      } finally { await file.close(); }
      validate(); originalJournal(original);
    }), failClosed,
  });
  // One bounded strict observation per original. No timer, wake, dispatch,
  // historical lifecycle, metadata repair, or automatic settlement is created.
  await pendingInputRecovery.startup();
  replyIntegration.start();
  chromePush.start();
  // Legacy monitor has neither strict queued-user association nor recovered
  // observation fences. Do NOT pass queued originals (even "preparing") to it,
  // borrow its weak ACK/history completion, or manufacture a lifecycle handle.
  const recoveringRuns = meta.runs.filter(r => !recoveredInputConversations.has(r.sessionId) && r.status === "running" && getHarnessDescriptor(sessionHarness(meta.sessions.find(s => s.sessionId === r.sessionId)!))!.operations.recoverRun.supported);
  for (const run of recoveringRuns) startupObservations.set(run.sessionId, run);
  for (const recovering of recoveringRuns) {
    const descriptor = requireOperation(sessionHarness(meta.sessions.find(s => s.sessionId === recovering.sessionId)!), "recoverRun");
    const finished = Promise.withResolvers<void>();
    const owner: Owner = { run: recovering, native: descriptor.nativeHarness === "oc", done: finished.promise, settled: false };
    const adoption = coordinator.adoptObservedOwner(owner);
    startupObservations.delete(recovering.sessionId);
    if (!adoption.ready) throw new WorkstreamAdapterError(409, adoption.code, adoption.reason);
    let recoveryHealthy = true;
    const recoveryTask = Promise.resolve().then(() => dispatchOwnedOperation(ownedSession(owner), owner, "recoverRun", {
      "claude-code": () => { throw new HarnessOperationError("Claude process ownership cannot be recovered", 501, "unsupported-harness-operation"); },
      opencode: () => recovering.operation === "compact" ? ocRuns.recoverNativeCompact(owner) : recovering.nativePhase === "preparing" ? ocRuns.finishNative(owner, "failed", "Bridge restarted before native submission") : ocRuns.monitorNative(owner),
    }))
      .catch(() => { recoveryHealthy = false; failClosed(); }).finally(async () => {
        // Acquire the exact barrier while still owning. Release and done are not
        // proof that the worker/domain reconciliation has completed.
        try {
          const reconciliationWasRequired = !!meta.reconciliationRequired;
          const token = coordinator.beginReconciliation(owner);
          owner.settled = true; releaseOwner(owner);
          const w = workerStore.getByRun(recovering.runId);
          if (w && !storageFailed) await workers.refresh(w);
          // A preexisting operator pause does not turn healthy observation into
          // a failed source hook. It still denies all admissions independently;
          // ending this barrier supplies NO automatic continuation proof.
          if (recoveryHealthy && !storageFailed && !retainOwner && (!meta.reconciliationRequired || reconciliationWasRequired)) {
            if (!coordinator.endReconciliation(token)) throw new Error("Recovered source reconciliation barrier is no longer current");
          }
        }
        catch { recoveryHealthy = false; failClosed(); }
        finally { finished.resolve(); }
      });
    dispatchTasks.add(recoveryTask);
    void recoveryTask.finally(() => { dispatchTasks.delete(recoveryTask); });
  }
  startupObservations.clear();
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
    try {
      for (const h of await handoffs.listForPolling(w.workspaceId)) if (h.recipient.ownerId === store.manifest.storeId && !["queued", "completed", "failed"].includes(h.status)) handoffReservations.add(h.recipient.sessionId);
    } catch (error) {
      // A positively uninitialized repository has no handoff domain to recover.
      // Unavailable/corrupt initialized domains are NOT safe empty outboxes.
      if (!(error instanceof WorkstreamAdapterError && error.code === "NOT_INITIALIZED")) throw error;
    }
  }
  // Classification, not a wait for native completion. BranchStore already pins
  // its pending source/destination policy; reconciliation reserves synchronously
  // below before any request callback can run. Queue barriers were installed
  // before legacy observation; waiting-only chains occupy no running capacity.
  if (closing || storageFailed) throw new Error("Startup classification did not complete safely");
  startupReady = true;
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
  stopStartupConsumers = () => { clearInterval(handoffTimer); clearInterval(workerOutboxTimer); };
  const preparedInput: PreparedInputAdmission = {
    reserve: (intent, id) => reserve(intent, id), release: lease => coordinator.releaseAdmission(lease),
    async admit(prepared, lease, inputOptions) {
      assertStartupReady();
      // Backend consumers receive the same shutdown supervision as HTTP
      // preflight. Awaited association/storage work cannot outlive unlocked App
      // ownership just because the caller did not arrive through a route.
      const finished = Promise.withResolvers<void>(); attachmentTasks.add(finished.promise);
      try { return await admitPreparedInput(prepared, lease, inputOptions); }
      finally { finished.resolve(); attachmentTasks.delete(finished.promise); }
    },
  };
   return { origin, port: server.port, workers, workerOutbox, handoffs, prepareHandoffRecipient, preparedInput, pendingInputs, pendingInputConsumer, pendingInputWake, startPendingInputWake, failOwnershipPublication: failClosed, abortStartup, close() {
    if (closePromise) return closePromise;
    closing = true;
    pendingInputWake!.close();
    pendingInputRecovery!.close();
    const queueDrain = pendingInputBridge!.close();
    const coordinatorDrain = coordinator.close();
    const replyDrain = replyIntegration?.close(); // Abort immediately, before any shutdown awaits.
    const pushDrain = chromePush?.close();
    const searchDrain = searches.close();
    const creationDrain = workspaceCreations?.close();
    clearInterval(handoffTimer);
    clearInterval(workerOutboxTimer);
    closePromise = (async () => {
    await boundedStartupCleanup(() => queueDrain);
    await boundedStartupCleanup(() => Promise.all([...queueServiceTasks]));
    await coordinatorDrain;
    await creationDrain;
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
    // Owner release and source reconciliation are separate boundaries. A report
    // can be released while its journal/domain reconciliation is still awaited.
    if (dispatchTasks.size) {
      const drained = await Promise.race([Promise.all([...dispatchTasks]).then(() => true), Bun.sleep(12000).then(() => false)]);
      if (!drained) { retainOwner = true; meta.reconciliationRequired = true; }
    }
    // Only identity-bound evidence was permitted while locks were supervised.
    await boundedStartupCleanup(() => Promise.all([...queueAdmissionTasks]));
    // No late callback may mutate after the bounded observation drain ends.
    pendingInputBridge!.closeObservations();
    pendingInputRecovery!.closeObservations();
    // A failed source hook may finish done while retaining its safety barrier.
    // Do not wait for retained ownership; preserve the recovery sentinel instead.
    if (!coordinator.reconciliationSessionIds().next().done) { retainOwner = true; meta.reconciliationRequired = true; }
    // Queue drains wait for owner.done, so supervise/stop owners FIRST. They
    // cannot launch after closing, and must journal their non-submission before
    // storage is flushed. Never put them in the pre-termination attachment wait.
    if (queuedInputTasks.size) {
      const drained = await Promise.race([Promise.all([...queuedInputTasks]).then(() => true), Bun.sleep(3000).then(() => false)]);
      if (!drained) { retainOwner = true; meta.reconciliationRequired = true; }
    }
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
    await replyDrain;
    await pushDrain;
    await updates.close();
    await flushAndCloseWorkstreams(() => catalog.flush(), () => router?.close(), () => { retainOwner = true; });
    if (retainOwner) throw new Error("Shutdown did not drain safely; ownership retained. Explicit reconciliation required after process exit.");
    })();
    return closePromise;
  } };
  } catch (error) {
    await abortStartup();
    throw error;
  }
}
