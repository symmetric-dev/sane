import { readFile, writeFile, appendFile, stat, readdir, realpath, open } from "node:fs/promises";
import { constants, readFileSync, statSync, writeFileSync, lstatSync, realpathSync } from "node:fs";
import { resolve, dirname, join, isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";
import { BridgeAuth, validateBridgeAuthOptions } from "./bridge-auth";
import { body, json, loopback } from "./bridge-http";
import { withApiCompression } from "./api-compression";
import { requireNativeBearer, requireStartupReady } from "./bridge-native-auth";
import { matchesNativeCallerCwd } from "./native-caller-cwd";
import { CodeShareStore, CodeShareError } from "./code-share-store";
import { MediaShareStore, MediaShareError } from "./media-share-store";
import { MediaShareService } from "./media-share-service";
import { mediaShareRoute } from "./media-share-routes";
import { BrowserPairStore, BrowserPairError } from "./browser-pair-store";
import { createBrowserPairRoute } from "./browser-pair-routes";
import { sameBrowserPairSession } from "../shared/browser-pair-contract";
import { ResourcePairStore, ResourcePairError } from "./resource-pair-store";
import { isPairLinkedSnapshot, isPairTarget, isPairWrite, type PairSession, type PairTarget } from "../shared/resource-pair-contract";
import { CodeShareService } from "./code-share-service";
import { denyCodeShareIdentity, matchesCodeShareTool, matchesCodeSharePart, readCodeShareContinuation } from "./code-share-evidence";
import { denyMediaShareIdentity, matchesMediaShareTool, matchesMediaSharePart, readMediaShareContinuation } from "./media-share-evidence";
import type { NativeCodeShareRequest, CodeShareRecord } from "../shared/code-share-contract";
import type { NativeMediaShareRequest } from "../shared/media-share-contract";
import type { UserQuestionsRecord } from "../shared/user-questions-contract";
import { UserQuestionsStore, UserQuestionsError } from "./user-questions-store";
import { UserQuestionsService } from "./user-questions-service";
import { denyUserQuestionsIdentity, matchesUserQuestionsTool, matchesUserQuestionsPart, readUserQuestionsContinuation } from "./user-questions-evidence";
import { UserQuestionsDelivery, UserQuestionsDeliveryDeferred, UserQuestionsDeliverySuperseded, type UserQuestionsDeliveryDenial } from "./user-questions-delivery";
import { httpErrorResponse, toHttpError } from "./bridge-errors";
import { newDispatchRun, newNativeCommandId } from "./dispatch-run";
import { preparedAdmissionNativeCommandId } from "./prepared-admission-command";
import { toNativeHarness, toSessionHarness } from "./harness-names";
import { createPoller } from "./poller";
import { createPresentationSnapshot } from "./presentation-snapshot";
import { copyPreparationTimings, createSubmissionTimingArchive } from "./submission-timing-archive";
import { SessionRetirements, SessionRetirementError } from "./session-retirement";
import { SessionNamingService, SessionNamingError, regenerationNamingTranscript } from "./session-naming";
import { MAX_SESSION_TITLE_LENGTH, normalizeSessionTitle } from "../shared/conversation/session-title";
import { runSessionNamingUtility } from "./utility-execution";
import { ClaudeRunService, hookEvents } from "./claude-run-service";
import { projectClaudeFollowups } from "./claude-followup-projection";
import { explicitGrokExecutable, resolveAppConfig } from "./app-config";
import { AssetBuildError, buildAssets, validateAssets } from "./asset-build";
import { createAssetRoute } from "./asset-routes";
import { createAgentProfileRoute } from "./agent-profile-routes";
import { acquireInstallation, acquireData, validateOwnershipPaths, type OwnershipHandle } from "./installation-ownership";
import { claudeSourceRoot } from "./claude-source";
import { decodeLog, lastJournalSeq, validCompactRequest, uuid, efforts, type SaneSessionContext, type Session, type Run, type Event, type Metadata, type TerminationUncertainty } from "./history";
import { projectCompactions } from "./compaction";
import type { CompactEligibility, CompactRequest, CompactResponse, MessageSnapshot, Harness } from "./oc-contract";
import type { OpenCodeLaunch } from "./opencode";
import { OpenCodeAdapter, OpenCodeError, OpenCodeSourceMismatchError, OpenCodeUnavailableError, openCodePermissionAllows, permissionPatternMatches } from "./opencode";
import { readOpenCodeWorkerContinuation, type OpenCodeWorkerContinuation } from "./opencode-worker-continuation";
import { OpenCodeRunService } from "./opencode-run-service";
import { OpenCodeObservationService } from "./opencode-observation-service";
import { OC_REPLY_ACTIVATION_BLOCKED, OpenCodeReplyIntegration } from "./opencode-reply-integration";
import type { OpenCodeReplyQualification } from "./opencode-reply-observer";
import { ConversationUpdateStore } from "./conversation-update-store";
import { ConversationUpdates } from "./conversation-updates";
import { createClaudeUpdateState, projectClaudeCommittedEvent, type ClaudeConversationUpdateState } from "./claude-conversation-updates";
import { conversationUpdateRoute } from "./conversation-update-routes";
import { ChromePushService } from "./chrome-push";
import { isConversationUpdateSource, updateOccurrenceId, updateSourceKey, type ConversationUpdatePage } from "../shared/conversation/conversation-updates";
import type { RunOwner as Owner } from "./run-owner";
import { bindRunControls, requestRunCancellation } from "./run-controls";
import { ConversationCoordinator, type ConversationAdmissionLease, type ConversationOperationIntent, type ConversationReadinessOptions } from "./conversation-coordinator";
import { sessionListProjection, SessionListReadinessScope, type SessionListProjection } from "./session-list-projection";
import { sessionDisplayTitle, type SessionListRow } from "./session-list-response";
import { SessionCatalog, SessionCatalogError } from "./session-catalog";
import { createSessionCatalogRoute, matchesSessionCatalogRoute } from "./session-catalog-routes";
import { workerObservationEvidence } from "./worker-observation-evidence";
import { HarnessDispatchRegistry, HarnessDispatchError, DispatchProofUnavailableError, createClaudeDispatchAdapter, createOpenCodeDispatchAdapter, sameDispatchSource, type DispatchLifecycleHooks } from "./harness-dispatch";
import type { DispatchOrigin, DispatchSource, DispatchIdentity, DispatchEvidenceHooks } from "../shared/conversation/dispatch-contract";
import type { PreparedAdmissionContext, PreparedAdmissionOptions, PreparedInputAdmission } from "./prepared-input-admission";
import { createDispatchEvidence, synchronousDispatchHook } from "./dispatch-evidence";
import { RunJournalWriter } from "./run-journal";
import { MetadataPublisher, MetadataCommitProofError, captureMetadataDispatchBinding, type MetadataDispatchBinding, type CommittedMetadataReceipt } from "./metadata-publication";
import { PendingActivationJournals, type PendingActivationPreparation } from "./pending-activation-journal";
import { prepareActivationWhileAdmitted, prepareRunJournalInstallation } from "./run-journal-installation";
import { createDispatchContextBinding } from "./dispatch-context-binding";
import { createExecutionPreparationService } from "./execution-preparation-service";
import { createDispatchSource } from "./dispatch-source";
import { createSessionMessageSource } from "./session-context-source";
import { createPrepareOwnedMessage, type SubmissionMessageIntent } from "./owned-message-preparation";
import type { OwnedSubmissionPublication } from "./context-message-transport";
import { AppAdmissionAuthorizationError, AppAdmissionService, assertAppAdmissionEligibility, type OriginalAppAdmission } from "./app-admission-service";
import { AppAdmissionRequestError, AppAdmissionStorageError, type AppAdmissionConversationBinding, type AppAdmissionPending } from "./app-admission-store";
import { captureOriginalAppAdmissionRootProof, readAppAdmissionFeature, initializeAppAdmissionFeature, type OriginalAppAdmissionRootProof } from "./app-admission-feature";
import { appAdmissionExpectedSourceMatches, decodeAppAdmissionEnvelope, decodeAppAdmissionKey, decodeAppAdmissionTarget, type AppAdmissionEnvelope, type AppAdmissionIntent } from "../shared/conversation/app-admission-contract";
import { decodeContextMessageSubmission } from "./context-message-evidence";
import type { ContextMessageActivationPairing } from "./context-message-activation";
import { ContextMessageJournalReader } from "./context-message-reader";
import { PendingInputService, pendingInputRoute, type PendingInputPreflight } from "./pending-input-service";
import { createPendingInputRecovery, createOriginalRecoveryJournal, type PendingInputRecovery } from "./pending-input-recovery";
import { PendingInputDomainError, PendingInputStorageError, type PendingInputPins, type PendingInputStoredItem } from "./pending-input-contract";
import { createPendingInputBridge, type PendingInputBridge } from "./pending-input-bridge";
import { createPendingInputWake, type PendingInputWake, type PendingInputWakeClock, type PendingInputWakeKind } from "./pending-input-wake";
import { createPendingInputControls } from "./pending-input-controls";
import { assertPendingInputDomainMutation, assertDomainInitializationIdle, chainInRepository } from "./pending-input-domain-guard";
import { equal as equalPendingPin } from "./prepared-input-codec";
import { decodePendingInputPins } from "./pending-input-codec";
import { prepareUserInput, revalidatePreparedUserInput, assertPreparedUserInputCurrent, UserInputPreparationError, createCanonicalActivation, validateCanonicalActivation, type ActivationSnapshot, type PreparedUserInput } from "./user-input-preparation";
import { ScienceSubmissionStore, ScienceSubmissionError, ScienceSubmissionStorageError, type ScienceSubmissionReceipt } from "./science-submission-store";
import { canonicalJSON } from "./prepared-input-codec";
import type { ScienceSubmissionView } from "../shared/conversation/types";
import { WorkspaceService, WorkspaceError } from "./workspace";
import { createWorkspaceRoute, matchesWorkspaceRoute } from "./workspace-routes";
import { ImageUploadService } from "./image-upload-service";
import { createImageUploadRoute, matchesImageUploadRoute } from "./image-upload-routes";
import { createImageUploadLifecycle } from "./image-upload-lifecycle";
import { IMAGE_UPLOAD_LIMITS } from "../shared/image-upload-contract";
import { GitOperationsService } from "./git-operations";
import { CatalogService } from "./catalog";
import { WorkspaceCreationService } from "./workspace-creation";
import { TerminalService, type TerminalSocketData } from "./terminal";
import { createTerminalRoute, matchesTerminalRoute } from "./terminal-routes";
import { BrowserService, type BrowserSocketData } from "./browser/browser-service";
import { BrowserGrantError } from "./browser/browser-grant-registry";
import { BROWSER_MCP_TOOLS } from "../shared/browser-host-contract";
import { ScienceService, scienceRoute } from "./science";
import { RepositoryRouter, RepositoryStoreError, WorkstreamAdapterError, flushAndCloseWorkstreams } from "./workstreams";
import { createWorkstreamRoute, matchesWorkstreamRoute } from "./workstream-routes";
import type { WorkstreamAction, WorkstreamActionInput, WorkstreamActionResult, WorkstreamCompleteResult } from "./workstreams-contract";
import { validateAppStore, assertSourceConfiguration, atomicAppRecord, atomicNativeHistory, loadAgentProfiles, validateAgentProfiles, AppStoreError, type Admission, type SourceConfiguration } from "./app-store";
import { genericSessionTitle, legacyProfileId, resolveAssistantProfile, resolveAgentLaunch, resolveProfileDefaults, type AgentProfiles } from "./agent-profiles-contract";
import { AdmissionService } from "./admission";
import { beginConversationCreation, completeConversationCreation, type NativeConversationCreation } from "./conversation-creation";
import { claudeConversationCreation, openCodeConversationCreation } from "./native-conversation-creation";
import { HandoffService, handoffRecipientTitle, nextSlotSessionIndex, projectHandoffEnqueue, projectHandoffStatus, slotSessionIndex } from "./handoff";
import { DomainError, canonicalSlot, equivalentSlots, normalizeNativeSource, revalidateCheckout, discoverRepository, inspectRepositoryStore } from "sane-core/server";
import type { Handoff, NativeSourceDescriptor } from "sane-core/contracts";
import { WorkerStorageError, WorkerStore } from "./worker-store";
import { WorkerService, type WorkerParent } from "./workers";
import { WorkerCompletionRecoveryCoordinator, WORKER_COMPLETION_REMINDER, type WorkerCompletionRecoveryCandidate } from "./worker-completion-recovery-coordinator";
import { classifyWorkerCompletionRecovery, workerCompletionRecoveryAttemptKey, WORKER_COMPLETION_RECOVERY_SPENT_DIAGNOSTIC, type WorkerCompletionRecoveryInput } from "./worker-completion-recovery";
import type { ExplicitWorkerOperations } from "./native-workers";
import { createNativeWorkerHandler, NativeWorkerRequestError, type NativeWorkerCallerResolver } from "./native-workers";
import { matchesOpenCodeWorkerPart, nativeWorkerInput, projectNativeWorkerReply, type NativeWorkerInvocation } from "../../sane-cli/src/native-worker-contract";
import { installedRuntimeSchemaDrift, proveInstalledExplicitWorkerRuntime, type NativeRuntimeSelection, type SelectedNativeRuntime } from "../../sane-cli/src/install-sane-agent-context-packages";
import { GROK_RUNTIME_HEADER, grokRuntimeInputDigest, verifyGrokRuntimeProof } from "../../sane-cli/src/native-grok-binding";
import { workerTerminationUncertainty } from "./worker-recovery";
import { hasVerifiedSettledTermination } from "./settled-journal-reconciliation";
import { exchangeDeliveryEvidence, grokWrapperCompletion, workerDeliveryEvidence, workerExchangePrompt, workerReportPrompt } from "./worker-outbox";
import { restoreWorkerOutput, workerOutput } from "./worker-output";
import { DEFAULT_MAX_WORKERS_PER_CHECKOUT, WORKER_STATE_BATCH_LIMIT, workerResults, type WorkerDelivery, type WorkerProtocolOperation, type WorkerProtocolPin, type WorkerRecord, type WorkerStateBatch, type WorkerStateSnapshot } from "./worker-contract";
import { explicitObservationChange, isExplicitWorker } from "./worker-protocol";
import { managedWorkerCoordination, managedWorkerRoles, managedWorkerWaiting } from "./managed-worker-lifecycle";
import { ASSISTANT_AGENT_DESCRIPTIONS, ASSISTANT_AGENT_IDS, ASSISTANT_AGENT_LABELS, WORKER_AGENT_CATALOG, isAssistantAgentId, isStoredAssistantAgentId, nativeAgentId } from "sane-core/agent-catalog";
import { agentLaunchSnapshot, claudeAgentSettings, saneContextSnapshot, saneSessionContext, workerAssignmentOnly, snapshotIdentity } from "./agent-launch";
import { ContextPackageStore } from "./context-package-store";
import { readClaudeHistory, forkClaudeHistory, verifyClaudeFork, coveredNativeRuns, type ReconciledHistory } from "./reconcile";
import { BranchStore, type BranchOperation } from "./branches";
import { CanonicalExecutionStore, type CanonicalExecutionRef } from "./canonical-execution-store";
import { NativeHistoryCache, TranscriptError, TranscriptService } from "./transcript-service";
import { NativeSubagentService } from "./native-subagent-service";
import { GrokAppService } from "./grok-app-service";
import { GrokModelCatalog } from "./grok-model-catalog";
import { GrokOutputProjection } from "./grok-output";
import { GrokRunService } from "./grok-run-service";
import { proveInstalledGrokWorkerRuntime } from "./grok-native-runtime";
import { grokSessionExists, prepareGrokFork, readGrokHistory, verifyGrokFork } from "./grok-native-history";
import { forkGrokSession, GrokAcpForkError, type GrokAcpCloseEvidence, type GrokAcpSpawnInfo } from "./grok-acp";
import { composeContextMessage } from "./context-message";
import type { GrokSessionView, GrokTurnInput } from "../shared/conversation/grok-contract";
import { SessionRunPreviewService } from "./session-run-preview";
import { createNativeSubagentEvidenceRoute, createTranscriptEvidenceRoute, createRunEvidenceRoute, createConversationSearchRoute,
  matchesNativeSubagentEvidenceRoute, matchesTranscriptEvidenceRoute, matchesRunEvidenceRoute, matchesConversationSearchRoute } from "./conversation-evidence-routes";
import { OpenCodeSubagentRecorder } from "./opencode-subagent-recorder";
import { capabilitiesFor, getHarnessDescriptor, isHarness } from "../shared/conversation/harness-capabilities";
import { isClaudeRootRecord } from "../shared/conversation/cc-scope";
import { HarnessOperationError, dispatchHarness, dispatchOwnedOperation, requireOperation, requireOwnedOperation, validateHarness } from "./harness-operations";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export { hookEvents };
export type Options = { host: string; port: number; cwd: string; dataDir: string; claudeBin: string; nativeSources: SourceConfiguration; nativeRuntime?: NativeRuntimeSelection; /** Saved absolute Grok executable. Omitted unless explicit; never a PATH name. */ grokExecutable?: string; grokHomeRoot?: string; allowRemote: boolean; publicOrigin?: string; reconcileInterrupted: boolean; initializeAppAdmissions?: boolean; maxConcurrentRuns?: number; maxWorkersPerCheckout?: number; packageDir?: string; noBuild?: boolean; contextDelivery?: "startup" | "canonical"; agentModelConfig?: string; /** Internal deterministic fixture dependency; never parsed from CLI/config/HTTP. */ pendingInputWakeClock?: PendingInputWakeClock; /** Trusted backend evidence; activation remains disabled in this preparation phase. */ openCodeReplyQualifications?: readonly OpenCodeReplyQualification[] };
type BridgeMessageIntent = SubmissionMessageIntent;
type SubmissionPublicationFactory = (owner: Owner) => OwnedSubmissionPublication;
type OriginalSubmission = { original: OriginalAppAdmission; envelope: AppAdmissionEnvelope; binding: AppAdmissionConversationBinding };
export function parseOptions(args: string[]): Options {
  return runtimeOptions(resolveAppConfig(args, { packageDir: root, invocationCwd: process.cwd() }));
}
export function runtimeOptions(resolved: ReturnType<typeof resolveAppConfig>): Options {
  const { config: c, operational } = resolved;
  const grokExecutable = explicitGrokExecutable(c);
  return { host: c.server.host, port: c.server.port, cwd: c.defaultExecutionCwd, dataDir: c.dataDir,
    claudeBin: c.native.claude.executable, allowRemote: c.server.allowRemote, publicOrigin: c.server.publicOrigin ?? undefined,
    maxConcurrentRuns: c.maxConcurrentRuns, maxWorkersPerCheckout: c.maxWorkersPerCheckout, reconcileInterrupted: operational.reconcileInterrupted, initializeAppAdmissions: operational.initializeAppAdmissions, noBuild: operational.noBuild, contextDelivery: c.contextDelivery, agentModelConfig: c.agentModelConfig,
    ...(c.nativeRuntime ? { nativeRuntime: c.nativeRuntime } : {}),
    ...(grokExecutable ? { grokExecutable } : {}),
    ...(c.native.grok ? { grokHomeRoot: c.native.grok.homeRoot } : {}),
    nativeSources: { cc: { version: 1, harness: "cc", kind: "local-profile", profileRoot: c.native.claude.profileRoot },
      oc: { version: 1, harness: "oc", kind: "local-registration", registrationFile: c.native.opencode.registrationFile } } };
}
export function startupSummary(o: Options): string {
  return ["SANE App startup configuration:", `  Invocation cwd: ${process.cwd()}`, `  Default execution cwd: ${o.cwd}`, `  App data: ${o.dataDir}`,
    `  Native mode: Claude executable ${o.claudeBin}; configured managed OpenCode registration`,
    `  SANE context delivery: shared user messages`,
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
  let publishingOwnershipFailure = false;
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
    // Latch BEFORE invoking a hook, which may itself reenter a storage guard.
    retentionRequired = true;
    if (publishingOwnershipFailure) return;
    publishingOwnershipFailure = true;
    try {
      try { bridge?.failOwnershipPublication(); } catch { /* Preserve the publication error. */ }
      try { retain(); } catch { /* Both handles were attempted; the latch survives. */ }
    } finally { publishingOwnershipFailure = false; }
  };
  // Only original-root capture/proof and its ownership assertion enter this
  // guard. Expected pre-mutation setup refusals are NOT retention failures.
  const guardOriginalAppRoot = <T>(proof: () => T): T => {
    try { return proof(); }
    catch (error) { failOwnershipPublication(); throw error; }
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
    const startingStore = validateAppStore(options.dataDir);
    assertSourceConfiguration(startingStore.sources, options.nativeSources);
    const assertStorageOwnership = () => {
      if (!storageOwnershipHeld || retentionRequired || !data) throw new Error("App storage ownership unavailable");
      installation.assertOwned(); data.assertOwned();
    };
    // ONE original capability, after data ownership + synchronous validation and
    // before asset building or ANY startup await. Never repin inside startOwned.
    const originalAppAdmissionRoot = guardOriginalAppRoot(() => captureOriginalAppAdmissionRootProof(options.dataDir, startingStore.manifest.storeId, assertStorageOwnership));
    const assertOriginalAppRoot = () => guardOriginalAppRoot(() => { assertStorageOwnership(); originalAppAdmissionRoot.assertCurrent(); });
    installation.update("build");
    let assets: ReturnType<typeof validateAssets> | undefined;
    if (!options.noBuild) { try { assets = validateAssets({ packageDir: paths.packageDir }); } catch (error) { if (!(error instanceof AssetBuildError)) throw error; } }
    assets ??= options.noBuild ? validateAssets({ packageDir: paths.packageDir }) : await buildAssets({ packageDir: paths.packageDir, ownership: installation });
    installation.update("starting");
    bridge = await startOwned(options, assets.assetsDir, paths.packageDir, retain, () => storageOwnershipHeld && !retentionRequired,
      assertOriginalAppRoot, originalAppAdmissionRoot);
    // The await itself is a final startup gap, even if inner classification had
    // no recovered work. Verify the ORIGINAL cap before publishing serving.
    assertOriginalAppRoot();
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
async function startOwned(options: Options, assetsDir: string, packageDir: string, retainOwnership: () => void, ownsStorage: () => boolean,
  assertOriginalAppRoot: () => void, originalAppAdmissionRoot: OriginalAppAdmissionRootProof) {
  // Keep the cap private, outside Options/config/serialization. Existing storage
  // assertions use the OUTER guarded proof, so even the earliest calls retain
  // both ownership handles without touching uninitialized inner failure state.
  let failInitializedStorage: ((error: unknown) => void) | undefined;
  let handlingOriginalRootFailure = false;
  const assertStorageOwned = () => {
    try { assertOriginalAppRoot(); }
    catch (error) {
      if (!handlingOriginalRootFailure) {
        handlingOriginalRootFailure = true;
        try { failInitializedStorage?.(error); } catch { /* Preserve the original proof failure. */ }
        finally { handlingOriginalRootFailure = false; }
      }
      throw error;
    }
  };
  assertStorageOwned();
  const assetManifest = JSON.parse(await readFile(join(assetsDir, "manifest.json"), "utf8")) as ReturnType<typeof validateAssets>["manifest"];
  assertStorageOwned();
  const maxConcurrentRuns = options.maxConcurrentRuns ?? 24;
  if (!Number.isSafeInteger(maxConcurrentRuns) || maxConcurrentRuns < 1 || maxConcurrentRuns > 256) throw new Error("max-concurrent-runs must be an integer from 1 to 256");
  const maxWorkersPerCheckout = options.maxWorkersPerCheckout ?? DEFAULT_MAX_WORKERS_PER_CHECKOUT;
  if (!Number.isSafeInteger(maxWorkersPerCheckout) || maxWorkersPerCheckout < 1 || maxWorkersPerCheckout > 256) throw new Error("maxWorkersPerCheckout must be an integer from 1 to 256");
  const store = validateAppStore(options.dataDir);
  assertStorageOwned();
  // Journal proof is additionally fenced by the pre-await OUTER App-root cap.
  const originalJournals = createOriginalRecoveryJournal(options.dataDir, store.manifest.storeId);
  assertSourceConfiguration(store.sources, options.nativeSources);
  if (options.nativeSources.cc.harness !== "cc" || options.nativeSources.oc.harness !== "oc") throw new Error("Invalid configured native harnesses");
  const claudeRoot = options.nativeSources.cc.profileRoot;
  if (process.env.CLAUDE_CONFIG_DIR !== undefined && claudeSourceRoot() !== claudeRoot) throw new Error("Contradictory native selector: CLAUDE_CONFIG_DIR");
  if (process.env.CLAUDE_CODE_PROJECT_DIR_NAME) throw new Error("Unsupported native selector: CLAUDE_CODE_PROJECT_DIR_NAME");
  const oc = new OpenCodeAdapter(undefined, undefined, options.nativeSources.oc.registrationFile);
  // Diagnostic only: CC/OC native tools run the installed vendored closure, so a
  // stale installed schema otherwise surfaces later as generic caller failures.
  if (options.nativeRuntime) void installedRuntimeSchemaDrift(options.nativeRuntime.pluginDirectory)
    .then(drift => { if (drift) console.warn("[SANE native runtime drift]", drift); }, () => {});
  // Historical App sessions may omit the harness; no unknown value defaults.
  const sessionHarness = (session: Session) => validateHarness(session.harness, { defaultHarness: "claude-code" });
  const pairSessionHarness = (session: Session): Harness => sessionHarness(session);
  const nativeSource = (harness?: string) => {
    const native = getHarnessDescriptor(validateHarness(harness, { defaultHarness: "claude-code" }))!.nativeHarness;
    const source = native === "gk" ? store.sources.version === 2 ? store.sources.gk : undefined : store.sources[native];
    return source?.authorityId ?? "unavailable";
  };
  function grokHistoryHome() {
    const source = store.sources.version === 2 ? store.sources.gk : undefined;
    if (!source || source.descriptor.homeRoot !== options.grokHomeRoot || normalizeNativeSource(source.descriptor).authorityId !== source.authorityId)
      throw new WorkstreamAdapterError(409, "grok-source-mismatch", "Grok history requires its exact configured native home and source authority");
    return source.descriptor.homeRoot;
  }
  function readNativeHistory(harness: unknown, nativeId: string, cwd: string) {
    const descriptor = requireOperation(harness, "readHistory");
    return dispatchHarness(descriptor.id, {
      "claude-code": async () => ({ messages: await readClaudeHistory(nativeId, cwd, claudeRoot), activity: "unknown" as const }),
      opencode: () => oc.history(nativeId, cwd),
      grok: async () => ({ messages: await readGrokHistory(nativeId, cwd, grokHistoryHome()), activity: "unknown" as const }),
    });
  }
  const forbidden = Object.keys(process.env).filter(k => /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_API_KEY|CLAUDE_CODE_BASE_URL|CLAUDE_CODE_CUSTOM_MODEL_OPTION|AWS_BEARER_TOKEN_BEDROCK|OPENAI_API_KEY|OPENAI_BASE_URL)/.test(k));
  if (forbidden.length) throw new Error(`Remove API/provider overrides: ${forbidden.join(", ")}`);
  try { if (!(await stat(options.cwd)).isDirectory()) throw new Error(); }
  catch { throw new Error(`Execution cwd must be an existing directory: ${options.cwd}. Set --cwd to the intended checkout.`); }
  assertStorageOwned();
  const password = process.env.SANE_APP_PASSWORD;
  const authOptions = { ...options, password };
  validateBridgeAuthOptions(authOptions);
  let retainOwner = false;
  let closing = false, storageFailed = false, startupReady = false;
  let appAdmissions: AppAdmissionService | undefined;
  let originalAdmissionScope: OriginalAppAdmission | undefined;
  const appAdmissionLeases = new WeakMap<ConversationAdmissionLease, OriginalAppAdmission>();
  function withOriginalAdmission<T>(original: OriginalAppAdmission, action: () => T): T {
    if (originalAdmissionScope) throw new Error("Original App admission readiness scope reentered");
    originalAdmissionScope = original;
    try { let value!: T; synchronousDispatchHook(() => { value = action(); return value; }); return value; }
    finally { originalAdmissionScope = undefined; }
  }
  let pendingInputs: PendingInputService | undefined;
  let pendingInputBridge: PendingInputBridge | undefined;
  let pendingInputRecovery: PendingInputRecovery | undefined;
  let pendingInputWake: PendingInputWake | undefined;
  let sessionNaming: SessionNamingService | undefined;
  const namingSubmissions = new WeakMap<Run, string>();
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
  let stopPresentationReads: (() => void) | undefined;
  let stopGrokForks: (() => void) | undefined;
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
  let science: ScienceService | undefined;
  let grokApp: GrokAppService | undefined;
  let grokModelCatalog: GrokModelCatalog | undefined;
  let updateService: ConversationUpdates<ClaudeConversationUpdateState> | undefined;
  let replyIntegration: OpenCodeReplyIntegration | undefined;
  let chromePush: ChromePushService | undefined;
  const searches = createWorkspaceSearchLifecycle();
  const imageUploads = createImageUploadLifecycle();
  const imageUploadWorktrees = new Map<string, number>();
  const imageUploadRemovals = new Set<string>();
  let workspaceCreations: WorkspaceCreationService | undefined;
  let gitOperations: GitOperationsService | undefined;
  let workerCompletionRecovery: WorkerCompletionRecoveryCoordinator | undefined;
  let workerCompletionRecoveryStarted = false;
  async function abortStartup() {
    closing = true;
    const imageUploadDrain = imageUploads.close();
    stopGrokForks?.();
    stopPresentationReads?.();
    const repositoryReadDrain = router?.stopReads();
    pendingInputWake?.close();
    pendingInputRecovery?.close();
    const queueDrain = pendingInputBridge?.close();
    const workerRecoveryDrain = workerCompletionRecovery?.close();
    stopStartupConsumers?.();
    // Stop EVERY acquired listener first, even if one stop rejects. Cleanup is
    // bounded and failures retain both locks; nothing may serve unlocked after
    // post-bind recovery, publication, or observer startup fails.
    await Promise.all(boundListenerStops.map(stop => boundedStartupCleanup(stop)));
    await boundedStartupCleanup(() => repositoryReadDrain);
    await boundedStartupCleanup(() => drainStartupExecution?.());
    await boundedStartupCleanup(() => queueDrain);
    await boundedStartupCleanup(() => workerRecoveryDrain);
    await boundedStartupCleanup(() => imageUploadDrain);
    await Promise.all([
      () => chromePush?.close(), () => workspaceCreations?.close(), () => gitOperations?.close(), () => science?.close(),
      async () => { if (grokApp && !(await grokApp.close()).drained) retainOwner = true; },
      async () => { if (grokModelCatalog && !await grokModelCatalog.close()) retainOwner = true; },
      () => replyIntegration?.close(), () => updateService?.close(), () => searches.close(), () => sessionNaming?.close(),
    ].map(cleanup => boundedStartupCleanup(cleanup)));
    await boundedStartupCleanup(() => router?.close());
    await boundedStartupCleanup(() => Promise.all([...queueServiceTasks, ...queueAdmissionTasks]));
    pendingInputBridge?.closeObservations();
    pendingInputRecovery?.closeObservations();
    if (retainOwner) retainOwnership();
  }
  try {
  const meta: Metadata = store.metadata;
  const retirements = new SessionRetirements({ dataDir: options.dataDir, storeId: store.manifest.storeId, claudeRoot, nativeControlPaths: [options.nativeSources.oc.registrationFile],
    sessions: () => meta.sessions, runs: () => meta.runs, oc,
    healthy: () => startupStorageHealthy(), flush: () => serial,
    busy: id => retirementBusy(id), coordinationActivity: id => retirementCoordinationActivity(id),
    authorityCurrent: session => {
      try {
        const harness = toNativeHarness(sessionHarness(session));
        const source = harness === "gk" ? store.sources.version === 2 ? store.sources.gk : undefined : store.sources[harness];
        return !!source && source.authorityId === session.authorityId && normalizeNativeSource(source.descriptor).authorityId === session.authorityId;
      }
      catch { return false; }
    },
    storageFailed: error => failClosed(error, "session-retirement-storage"),
    changed: () => { replyIndexedSessionCount = -1; replyIntegration?.requestRefresh(); },
  });
  const activeSessions = () => meta.sessions.filter(session => !retirements.isRetired(session));
  const sessionCatalog = new SessionCatalog();
  const retiredId = (id: string) => retirements.isRetired(meta.sessions.find(session => session.sessionId === id));
  const retirementPaused = (id: string) => retiredId(id) || retirements.isPaused(id);
  function assertCatalogActive(session: Session | undefined) {
    try { retirements.assertActive(session); }
    catch (error) { if (error instanceof SessionRetirementError) throw new WorkstreamAdapterError(error.status, error.code, error.message); throw error; }
  }
  const sessionRunPreviews = new SessionRunPreviewService(store.manifest.storeId, () => meta.sessions, () => meta.runs, assertCatalogActive);
  // Qualified reply evidence captures durable metadata on its own coalesced
  // queue. Disabled production reads the live catalog only for default coverage.
  const replyJournalThrough = new Map<string, number>();
  let agentProfiles: AgentProfiles = loadAgentProfiles(options.dataDir);
  const catalog = new CatalogService(options.dataDir, activeSessions);
  for (const session of meta.sessions) if (session.attachment && session.attachment.source !== nativeSource(session.harness)) throw new Error("Attached native authority source changed; restore the original native store/service configuration");
  assertStorageOwned();
  await catalog.load();
  assertStorageOwned();
  workspaceCreations = await WorkspaceCreationService.open(options.dataDir, catalog, [options.dataDir, join(packageDir, ".runtime"), claudeRoot]);
  assertStorageOwned();
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
    beforeLifecycle: (domain) => {
      assertDomainMutationOpen();
      const scope = { workspaceId: "", commonDir: domain.context.commonDir, roots: [domain.primaryCheckout, domain.context.invocationCheckout.path] };
      assertLifecycleIdle(scope.workspaceId, domain.repositoryId, scope);
      lifecycleReservations.set(domain.repositoryId, scope);
      return () => { if (lifecycleReservations.delete(domain.repositoryId)) notifyPendingInput("domain"); };
    },
    mutationFailed: failClosed,
  });
  science = new ScienceService(catalog, router);
  const admissions = new AdmissionService(options.dataDir, store.admissions, store.sources, catalog, router);
  function conversationCreation(harness: Harness, cwd: string, launch: () => OpenCodeLaunch): NativeConversationCreation {
    return dispatchHarness(harness, {
      "claude-code": () => claudeConversationCreation(),
      opencode: () => openCodeConversationCreation(oc, cwd, launch),
      grok: () => ({ harness: "gk", kind: "allocated", allocate: () => crypto.randomUUID() }),
    });
  }
  const workerStore = new WorkerStore(options.dataDir);
  const branches = new BranchStore(options.dataDir);
  const branchRequests = new Set<string>();
  const grokForkProcesses = new Map<string, { sourceId: string; controller: AbortController; done: Promise<void>; spawned?: GrokAcpSpawnInfo; observation?: GrokAcpCloseEvidence }>();
  stopGrokForks = () => { for (const fork of grokForkProcesses.values()) fork.controller.abort(); };
  const resolveExecution = async (sessionId: string) => {
    assertCatalogActive(meta.sessions.find(s => s.sessionId === sessionId));
    const admission = admissions.get(sessionId);
    if (!admission) throw new WorkstreamAdapterError(409, "admission-missing", "Conversation has no durable admission");
    return { admission, ...await router!.resolveExecution(admission) };
  };
  const executionContext = async (sessionId: string) => (await resolveExecution(sessionId)).roots;
  const execution = async (sessionId: string) => (await executionContext(sessionId)).executionCheckout;
  const contextPackages = new ContextPackageStore(resolve(root, "../.."), join(options.dataDir, "context-packages"));
  // The legacy option is accepted as a configuration compatibility alias only;
  // it no longer selects an alternate native context delivery channel.
  const executionPackages = new CanonicalExecutionStore(resolve(root, "../.."), join(options.dataDir, "execution-packages"), options.agentModelConfig);
  const activationStores = { execution: executionPackages, context: contextPackages };
  const { executionReservation, prepareCanonicalExecution, canonicalExecution, prepareSaneContext } = createExecutionPreparationService({
    dataDir: options.dataDir, executionPackages, contextPackages,
    getSession: sessionId => meta.sessions.find(s => s.sessionId === sessionId),
    getAdmission: sessionId => admissions.get(sessionId), executionContext,
  });
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
  gitOperations = new GitOperationsService(catalog, worktrees, options.dataDir, () => domainProtectedPaths);
  const events = new Map<string, Event[]>();
  const runJournalDirectory = options.dataDir;
  const runJournals = new RunJournalWriter(options.dataDir, {
    assertStorage: () => { assertStorageOwned(); if (storageFailed) throw new Error("Run journal storage ownership unavailable"); },
    failClosed: error => failClosed(error, "run-journal"),
  });
  const metadataPublisher = new MetadataPublisher(options.dataDir, store.manifest.storeId, {
    assertStorage: () => { assertStorageOwned(); if (storageFailed) throw new Error("Metadata storage ownership unavailable"); },
    failClosed: error => failClosed(error, "metadata-publication"),
  });
  let committedMetadata: CommittedMetadataReceipt | undefined;
  const ownerMetadata = new WeakMap<Owner, { identity: DispatchIdentity; binding: MetadataDispatchBinding; receipt?: CommittedMetadataReceipt }>();
  const pendingActivations = new PendingActivationJournals(options.dataDir, store.manifest.storeId, runJournals, {
    assertStorage: () => { assertStorageOwned(); if (storageFailed) throw new Error("Activation storage ownership unavailable"); },
    failClosed: error => failClosed(error, "pending-activation-journal"),
  });
  const contextHistory = new ContextMessageJournalReader(options.dataDir, store.manifest.storeId, {
    assertStorage: () => { assertStorageOwned(); if (storageFailed) throw new Error("Context evidence storage unavailable"); },
  });
  const boundContextAssociations = new WeakMap<Owner, ContextMessageActivationPairing>();
  const contextJournalSource = (runId: string) => `app:${store.manifest.storeId}/run:${runId}/context-messages`;
  // Discover original anchors before any generic log repair. Discovery never
  // installs a Run or replays a prompt; pending preparation is explicit-only.
  const anchoredActivationRuns = pendingActivations.anchoredRunIds();
  const deferredJournals = new Set<string>();
  let materializeDeferred: ((runId: string) => Event[]) | undefined;
  function journalEvents(id: string): Event[] {
    return events.get(id) ?? materializeDeferred?.(id) ?? [];
  }
  let ensureSessionJournals = (sessionId: string) => { for (const run of meta.runs) if (run.sessionId === sessionId) journalEvents(run.runId); };
  const updateStore = new ConversationUpdateStore(options.dataDir, store.manifest.storeId);
  updateStore.load(); // Optional derived storage: failure never blocks execution.
  const updateEligible = (session: Session, run?: Run) => !retirements.isRetired(session) && session.agentKind !== "worker" && !workerStore.hasSession(session.sessionId) && run?.operation !== "compact";
  const updates = updateService = new ConversationUpdates(updateStore, {
    projector: { createState: createClaudeUpdateState, project: projectClaudeCommittedEvent },
    bootstrap: () => ({ activeRunIds: meta.runs.filter(run => run.status === "running" && updateEligible(meta.sessions.find(session => session.sessionId === run.sessionId)!, run)).map(run => run.runId), sourceBaselines: replyIntegration?.sourceBaselines() ?? [], outstandingWorkerAttention: workerStore.outstandingAttention().filter(a => !retiredId(a.workerSessionId) && !retiredId(a.parentSessionId)) }),
    coverage: () => [...activeSessions().filter(session => updateEligible(session) && session.harness !== "opencode").map(session => ({
      sourceKey: updateSourceKey({ harness: session.harness!, authorityId: session.authorityId!, nativeSessionId: session.nativeSessionId! }),
      state: "ready" as const,
      reason: "App-owned Claude Code results only; external activity is not observed",
    })), ...(replyIntegration?.coverage() ?? [])],
  });
  const nativeSubagents = new NativeSubagentService(() => meta.sessions, () => meta.runs, id => journalEvents(id));
  const nativeHistories = new NativeHistoryCache(options.dataDir);
  const nativeObservations = new OpenCodeObservationService(oc);
  // Presentation-only caches: neither config nor the list waits for discovery
  // or native network I/O. Mutations continue to use fresh adapter evidence.
  const presentationReadsEnabled = () => !closing && !storageFailed;
  // Config health and list activity have independent consumer demand. Keep
  // activity warm across the list's 51–69s idle poll without making ordinary
  // list traffic continually reload the native model catalog.
  let nativeConnectionDemandUntil = 0, nativeActivityDemandUntil = 0;
  const nativeConnectionSnapshot = createPresentationSnapshot({
    load: async () => {
      const connection = await oc.connection(options.cwd);
      if (!connection.connected) throw new Error("OpenCode connection unavailable");
      return connection;
    },
    shouldRun: () => presentationReadsEnabled() && Date.now() < nativeConnectionDemandUntil,
    refreshMs: 5000, maxAgeMs: 15_000, timeoutMs: 15_000,
    label: "OpenCode connection",
  });
  const nativeActivitySnapshot = createPresentationSnapshot({
    load: () => nativeObservations.active(),
    shouldRun: () => presentationReadsEnabled() && Date.now() < nativeActivityDemandUntil && activeSessions().some(session => session.harness === "opencode"),
    refreshMs: 1000, maxAgeMs: 5000, timeoutMs: 15_000, label: "OpenCode activity",
  });
  const refreshPresentationReads = () => { nativeConnectionSnapshot.refresh(); nativeActivitySnapshot.refresh(); };
  const presentationPoller = createPoller(async () => { refreshPresentationReads(); }, {
    intervalMs: 1000,
    shouldRun: () => presentationReadsEnabled() && (Date.now() < nativeConnectionDemandUntil || Date.now() < nativeActivityDemandUntil),
  });
  stopPresentationReads = () => { presentationPoller.stop(); nativeConnectionSnapshot.close(); nativeActivitySnapshot.close(); };
  const nativeSubagentRecorder = new OpenCodeSubagentRecorder(oc, id => events.get(id) ?? [], emit, () => closing || storageFailed,
    session => !retirementPaused(session.sessionId), run => runJournals.canAppend(run.runId));
  // An explicit archived-history read may observe native history if no persisted
  // snapshot exists. This does not restart routine/background polling, and keeps
  // native-only messages accessible without changing or deleting native history.
  const observedHistory = { get: async (session: Session) => {
    if (session.harness !== "opencode") return nativeHistories.get(session);
    if (!retirements.isRetired(session)) return nativeObservations.get(session);
    return await nativeHistories.get(session) ?? nativeObservations.get(session);
  } };
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
  // One physical receipt read for a synchronous presentation response. Actual
  // admission/dispatch never receives this response-scoped projection.
  const presentationAdmissions = new WeakMap<SessionListProjection, readonly AppAdmissionPending[]>();
  const coordinator: ConversationCoordinator<Owner> = new ConversationCoordinator<Owner>({
    maxConcurrentRuns,
    isClosing: () => closing,
    startupReady: () => startupReady,
    retained: () => retainOwner,
    observationAdmission: owner => {
      if (storageFailed) return { ready: false, code: "storage-unavailable", reason: "Storage unavailable; operator reconciliation required" };
      const run = owner.run, session = meta.sessions.find(s => s.sessionId === run.sessionId), a = admissions.get(run.sessionId);
      if (startupObservations.get(run.sessionId) !== run || owner.controls?.source.harnessId !== "opencode" || run.status !== "running" || !run.nativeCommandId
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
      ...workerStore.unfinishedSessionIds().filter(id => !retiredId(id)),
      ...workerStore.deliveriesToReconcile().filter(d => !retiredId(d.parentSessionId)).map(d => d.parentSessionId),
    ],
    policy: options => readinessPolicy(options, sessionListReadiness.current),
    canRetainPredecessor: owner => {
      const session = meta.sessions.find(s => s.sessionId === owner.run.sessionId);
      if (session?.harness === "grok") return false;
      return claudeRuns.canQueueFollowup(owner);
    },
    wake: { dispatch: () => {
      // A failed private queue claim releases its transient lease. Do not feed
      // that notification back into its own scheduler. Foreign changes during
      // this bounded pass are reconsidered by lifecycle hints/the 15s backstop.
      if (!pendingInputBridge?.isReconsidering()) notifyPendingInput("capacity");
      // Generic reservation releases also occur during outbox polling, including
      // declined claims. Recovery is notified by settled lifecycles and explicit
      // operations instead, never by this unqualified capacity wake.
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
    bindOwnerControls(owner);
    const result = coordinator.installOwner(lease, owner);
    if (!result.ready) throw new WorkstreamAdapterError(result.code === "capacity" ? 429 : 409, result.code, result.reason);
  }
  const historyRefreshes = new Map<string, string>();
  const attaching = new Set<string>();
  const attachmentTasks = new Set<Promise<void>>();
  const dispatchTasks = new Set<Promise<void>>();
  const handoffReservations = new Set<string>();
  const handoffAcknowledgements = new Set<string>();
  const handoffDispatches = new Map<string, Promise<void>>();
  const lifecycleReservations = new Map<string, { workspaceId: string; commonDir: string; roots: readonly string[]; phaseRelevant?: (sessionId: string) => boolean }>();
  let retirementChildrenRevision = -1;
  let retirementChildren = new Map<string, string[]>();
  function retirementBusy(id: string): string | undefined {
    if (retirementChildrenRevision !== workerStore.revision) {
      retirementChildren = new Map();
      for (const worker of workerStore.sessionListWorkers()) {
        const children = retirementChildren.get(worker.parent.sessionId) ?? [];
        children.push(worker.sessionId); retirementChildren.set(worker.parent.sessionId, children);
      }
      retirementChildrenRevision = workerStore.revision;
    }
    const scope = [id], seen = new Set(scope);
    for (let index = 0; index < scope.length; index++) for (const child of retirementChildren.get(scope[index]!) ?? []) {
      if (!seen.has(child)) { seen.add(child); scope.push(child); }
    }
    // Historical links alone never prevent retirement. Only actual ownership or
    // mutations in the target/descendant scope may still need this live parent.
    for (const target of scope) {
      const relation = target === id ? "Conversation" : "Descendant";
      if (owners.has(target) || admitting.has(target) || coordinator.hasAdmission(target) || coordinator.hasReconciliation(target)) return `${relation} has current App execution/admission/reconciliation ownership`;
      const session = meta.sessions.find(s => s.sessionId === target);
      if (session && attaching.has(`${session.harness}:${session.nativeSessionId}`) || historyRefreshes.has(target) || handoffDispatches.has(target) || lifecycleReserved(target)) return `${relation} has a current attachment/history/handoff/repository mutation`;
      if (branches.list().some(op => branchRequests.has(op.id) && (op.sourceId === target || op.destinationId === target))) return `${relation} has a current branch mutation`;
    }
    return undefined;
  }
  let retirementCoordinationRevision = -1;
  let retirementCoordination = new Map<string, string[]>();
  function retirementCoordinationActivity(id: string): readonly string[] {
    if (retirementCoordinationRevision !== workerStore.revision) {
      retirementCoordination = new Map();
      const add = (id: string, value?: string) => { if (value) { const values = retirementCoordination.get(id) ?? []; values.push(value); retirementCoordination.set(id, values); } };
      for (const worker of workerStore.list()) {
        // A refresh can restamp updatedAt solely for derived lifecycle flags.
        // Count actual reservations/receipts/results/messages, not that restamp.
        add(worker.sessionId, worker.createdAt); add(worker.sessionId, worker.cancelRequestedAt);
        add(worker.sessionId, worker.continuationCancellation?.requestedAt);
        add(worker.sessionId, worker.completion?.at); add(worker.sessionId, worker.outcome?.at);
        for (const result of workerResults(worker)) add(worker.sessionId, result.outcome.at);
        for (const receipt of worker.operationReceipts ?? []) add(worker.sessionId, receipt.at);
        for (const attention of worker.attention ?? []) add(worker.sessionId, attention.at);
        for (const exchange of worker.exchanges ?? []) { add(exchange.sender.sessionId, exchange.createdAt); add(exchange.recipient.sessionId, exchange.createdAt); }
      }
      retirementCoordinationRevision = workerStore.revision;
    }
    return retirementCoordination.get(id) ?? [];
  }
  function assertDomainMutationOpen() {
    assertStartupReady();
    if (storageFailed || retainOwner || meta.reconciliationRequired) throw new WorkstreamAdapterError(503, "storage-unavailable", "App mutation ownership is unavailable");
  }
  function lifecycleReserved(sessionId: string) {
    const admission = admissions.get(sessionId), workspaceId = catalog.association(sessionId).workspaceId;
    const reservation = admission?.binding.domain.mode === "repository" ? lifecycleReservations.get(admission.binding.domain.repositoryId) : undefined;
    if (reservation && (!reservation.phaseRelevant || reservation.phaseRelevant(sessionId))) return true;
    if ([...lifecycleReservations.values()].some(scope => scope.phaseRelevant ? scope.phaseRelevant(sessionId) : workspaceId && workspaceId === scope.workspaceId
      || admission?.binding.checkoutPin?.commonDir === scope.commonDir
      || scope.roots.includes(admission?.binding.executionCheckout ?? meta.sessions.find(s => s.sessionId === sessionId)?.cwd ?? ""))) return true;
    // A new/unresolved admission cannot yet prove it belongs to an unrelated repo.
    return !admission && !workspaceId && [...lifecycleReservations.values()].some(scope => !scope.phaseRelevant);
  }
  function assertLifecycleIdle(workspaceId: string, repositoryId: string, scope: { commonDir: string; roots: readonly string[]; phaseRelevant?: (sessionId: string) => boolean }) {
    if (pendingInputs?.store.readRecords().conversations.some(c => c.chain && (scope.phaseRelevant ? scope.phaseRelevant(c.conversationId) : chainInRepository(c.chain.pins, { ...scope, workspaceId, repositoryId })))) throw new WorkstreamAdapterError(409, "pending-input-chain-active", "Selected scope has an affected durable input chain");
    const available = availability(undefined, false);
    if (!available.canSend || retainOwner) throw new WorkstreamAdapterError(409, "bridge-busy", available.reason ?? "App execution ownership is unconfirmed");
    if (lifecycleReservations.has(repositoryId)) throw new WorkstreamAdapterError(409, "bridge-busy", "A repository phase action is already in progress");
    const relevant = (sessionId: string, unknownIsBusy = true) => {
      if (scope.phaseRelevant) return scope.phaseRelevant(sessionId);
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
    if ([...busy].some(sessionId => relevant(sessionId)) || workers.executionOccupants().some(worker => relevant(worker.parent.sessionId) || relevant(worker.sessionId, false))) throw new WorkstreamAdapterError(409, "bridge-busy", `${scope.phaseRelevant ? "Selected phase" : "Repository"} has active or unconfirmed App execution; wait for runs and workers to finish`);
  }
  const preparationTimingArchive = createSubmissionTimingArchive();
  function readOwnerPreparationTiming(owner: Owner) {
    try { return copyPreparationTimings(owner.controls?.readPreparationTiming?.()); }
    catch { return undefined; } // Optional diagnostics never gate lifecycle or HTTP handling.
  }
  function releaseOwner(owner: Owner) {
    if (owner.completionTerminalization && owner.completionTerminalization.state !== "committed") return;
    // Capture before the original owner reference is discarded. A snapshot is
    // not release proof, and metrics failure cannot delay or prevent release.
    try { preparationTimingArchive.retain(owner.run.runId, readOwnerPreparationTiming(owner)); }
    catch { /* Optional bounded diagnostics; no authoritative writes or gates. */ }
    // A delayed native interrupt must finish before a replacement can acquire
    // this conversation, even if terminal observation arrived first.
    if (coordinator.releaseOwner(owner)) {
      // Release precedes after-release reconciliation. Never await done inside
      // the lifecycle finalizer or dispatch from this synchronous release hook.
      void owner.done.then(() => workerCompletionRecovery?.notify()).catch(error => failClosed(error, "worker-completion-release"));
    }
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
    sessions: activeSessions,
    runs: () => meta.runs,
    events: id => (events.get(id) ?? []).filter(event => event.seq <= (replyJournalThrough.get(id) ?? 0)),
    admission: id => admissions.get(id), admissions: () => admissions.list().filter(a => !retiredId(a.sessionId)), isWorker: id => workerStore.hasSession(id), catalogVisible: id => !retiredId(id),
    isClosing: () => closing || storageFailed,
    isCurrent: (id, source, admissionSnapshot) => {
      // Sessions are appended, not replaced, in this bridge. Rebuild once per
      // catalog growth; mutable fields remain visible through their live refs.
      if (replyIndexedSessionCount !== meta.sessions.length) {
        replyLiveSessions = new Map(activeSessions().map(session => [session.sessionId, session]));
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
    eligible: (id, source, kind) => {
      const session = meta.sessions.find(session => session.sessionId === id);
      const workerAttention = kind === "worker-attention" && !!session && (session.agentKind === "worker" || workerStore.hasSession(session.sessionId));
      if (closing || storageFailed || !session || retirements.isRetired(session) || session.hidden || (!updateEligible(session) && !workerAttention) || branches.replaced(id)
        || session.attachment?.state === "pending" || session.harness !== source.harness
        || session.authorityId !== source.authorityId || session.nativeSessionId !== source.nativeSessionId) return false;
      return source.incarnation === undefined || updateSourceKey(replyIntegration!.updateSource(id) ?? {
        harness: session.harness, authorityId: session.authorityId!, nativeSessionId: session.nativeSessionId!,
      }) === updateSourceKey(source);
    },
    presentation: (id, source) => {
      const session = meta.sessions.find(session => session.sessionId === id);
      if (!session || retirements.isRetired(session) || session.harness !== source.harness || session.authorityId !== source.authorityId
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
      for (const session of activeSessions()) { sessions.set(session.sessionId, session); yield null; }
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
    events: id => journalEvents(id),
    owns: owner => owners.get(owner.run.sessionId) === owner,
    closing: () => closing, storageFailed: () => storageFailed, retained: () => retainOwner,
    requireReconciliation: () => { retainOwner = true; meta.reconciliationRequired = true; },
    failClosed, emit, persist, enqueue, execution, executionContext, compactExecution,
    refreshCompactHistory, assertWorkerDeliverySubmission, canonicalExecution,
    explicitProtocol: sessionId => workerStore.getBySession(sessionId)?.protocol,
    browserMcp: async (sessionId, runId) => {
      const session = meta.sessions.find(s => s.sessionId === sessionId), admission = admissions.get(sessionId);
      if (!session || !admission || admission.state !== "ready" || session.agentKind === "worker" || !session.nativeSessionId || !session.authorityId) return null;
      // Credential issuance is Claude-only and must not default an omitted harness to Claude Code.
      try {
        if (validateHarness(session.harness) !== "claude-code" || toSessionHarness(admission.source.descriptor.harness) !== "claude-code"
          || admission.nativeId !== session.nativeSessionId || admission.source.authorityId !== session.authorityId
          || admission.binding.executionCheckout !== session.cwd) return null;
      } catch { return null; }
      const token = browsers.issueSessionCredential({ sessionId: session.sessionId, harness: "claude-code", authorityId: session.authorityId, nativeSessionId: session.nativeSessionId });
      const credPath = join(options.dataDir, `${runId}.browser-credential.json`);
      await writeFile(credPath, JSON.stringify({ version: 1, url: `http://127.0.0.1:${hookServer.port}/native/browser`, token, pid: process.pid, sessionId: session.sessionId }), { mode: 0o600 });
      const mcpConfigPath = join(options.dataDir, `${runId}.browser-mcp.json`);
      await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: { "sane-browser": { type: "stdio", command: process.execPath, args: [join(root, "src/browser/browser-mcp-server.ts"), credPath] } } }), { mode: 0o600 });
      return { mcpConfigPath, allowedTools: BROWSER_MCP_TOOLS.map(name => `mcp__sane-browser__${name}`) };
    },
  });
  const handoffs = new HandoffService(admissions, catalog, router, store.sources, () => meta.sessions, () => {
    if (closing || storageFailed || meta.reconciliationRequired) throw new WorkstreamAdapterError(503, "handoff-owner-unavailable", "App execution owner is unavailable");
    grokHandoffAuthorization.getStore()?.();
  }, store.manifest.storeId, async (to, cwd) => {
    const launch = resolveAssistantProfile(agentProfiles, to);
    const descriptor = requireOperation(launch.harness, "prompt");
    const canonical = launch.identity && isAssistantAgentId(launch.identity.role) ? await prepareCanonicalExecution(launch.identity.role) : undefined;
    const native = launch.harness === "opencode" ? await oc.resolveLaunch(cwd, canonical ? { ...launch, agent: "build", model: launch.model ?? canonical.model, effort: launch.effort ?? (!launch.model ? canonical.effort : undefined) } : launch) : undefined;
    const model = native ? native.model ? `${native.model.providerID}/${native.model.id}` : undefined : launch.model;
    const effort = native ? native.model?.variant : launch.effort;
    const repositoryHarness = descriptor.nativeHarness;
    return {
      harness: repositoryHarness,
      executionConfig: { profileId: launch.profileId, agent: launch.agent!, ...(model ? { model } : {}), ...(effort ? { effort } : {}) },
    };
  }, id => !retirementPaused(id));
  async function handoffContextTitle(handoff: Pick<Handoff, "workstreamId" | "input" | "recipient">, workspaceId: string): Promise<string> {
    try {
      const status = (await router!.forWorkspace(workspaceId)).domain.getWorkstreamStatus(handoff.workstreamId);
      const assignments = [...status.phaseHistory, ...status.activePhases];
      const ref = handoff.recipient.ref;
      if (!ref) return handoffRecipientTitle(handoff.input.to, nextSlotSessionIndex(assignments, handoff.input.to));
      const assignment = assignments.find(item => equivalentSlots(item.phase, handoff.input.to) && item.ref.harness === ref.harness && item.ref.authorityId === ref.authorityId && item.ref.nativeId === ref.nativeId);
      return handoffRecipientTitle(handoff.input.to, slotSessionIndex(assignments, handoff.input.to, assignment?.id ?? ""));
    } catch {
      const role = handoff.input.to.split(":")[0];
      return genericSessionTitle({ agent: isStoredAssistantAgentId(role) ? role : undefined, agentKind: "assistant" });
    }
  }
  const handoffToken = crypto.randomUUID();
  const grokBindingDirectory = join(options.dataDir, "native-tools", "grok", "bindings");
  // One immutable proof per incoming HTTP request. Async continuations inherit
  // only their own scope; a concurrent request can never replace this evidence.
  const grokRequestProof = new AsyncLocalStorage<string | undefined>();
  const grokHandoffAuthorization = new AsyncLocalStorage<() => void>();
  function authorizeGrokInvocation(caller: { authorityId: string; nativeId: string; source: unknown; cwd?: string; repository?: string },
    toolName: string, input: unknown, invocation?: { toolCallId: string; messageId?: string; wrapper?: unknown }) {
    const proof = grokRequestProof.getStore();
    const deny = (): never => { throw new WorkstreamAdapterError(409, "grok-tool-identity", "Grok tools require the exact signed native invocation in their original live App-owned run"); };
    let binding: ReturnType<typeof verifyGrokRuntimeProof>;
    try { binding = verifyGrokRuntimeProof({ bindingDirectory: grokBindingDirectory, proof, caller, invocation, toolName, input }); }
    catch { return deny(); }
    const session = meta.sessions.find(row => row.sessionId === binding.appSessionId), owner = owners.get(binding.appSessionId);
    const admission = admissions.get(binding.appSessionId);
    const assertCurrent = () => {
      let current: ReturnType<typeof verifyGrokRuntimeProof>;
      try { current = verifyGrokRuntimeProof({ bindingDirectory: grokBindingDirectory, proof, caller, invocation, toolName, input }); }
      catch { return deny(); }
      if (!startupReady || closing || storageFailed || retainOwner || !ownsStorage() || meta.reconciliationRequired
        || !session || !owner || !admission || current.bindingId !== binding.bindingId || !isDeepStrictEqual(current, binding)
        || meta.sessions.find(row => row.sessionId === binding.appSessionId) !== session || owners.get(binding.appSessionId) !== owner
        || owner.run.runId !== binding.runId || owner.run.sessionId !== binding.appSessionId || !meta.runs.includes(owner.run)
        || owner.run.cwd !== binding.cwd || owner.run.operation === "compact" || owner.run.status !== "running"
        || owner.settled || owner.stopRequested || owner.cancelling || owner.stopping || !owner.nativeDispatched
        || session.harness !== "grok" || session.nativeSessionId !== binding.nativeSessionId || session.authorityId !== binding.authorityId
        || session.cwd !== binding.cwd || session.hidden || session.attachment || retirementPaused(session.sessionId)
        || branches.pending(session.sessionId) || branches.replaced(session.sessionId)
        || !owner.contextIdentity || owner.contextIdentity.runId !== binding.runId || !sameDispatchSource(owner.contextIdentity.source, {
          harnessId: "grok", sessionId: binding.appSessionId, authorityId: binding.authorityId, nativeSessionId: binding.nativeSessionId, cwd: binding.cwd })
        || !isDeepStrictEqual(admissions.get(binding.appSessionId), admission) || admission.state !== "ready"
        || admission.nativeId !== binding.nativeSessionId || admission.source.authorityId !== binding.authorityId
        || !isDeepStrictEqual(admission.source.descriptor, binding.source) || nativeSource("grok") !== binding.authorityId
        || admission.binding.executionCheckout !== binding.cwd
        || binding.repository !== (admission.binding.domain.mode === "repository" ? admission.binding.domain.primaryCheckout : undefined)
        || caller.repository !== undefined && binding.repository !== undefined && caller.repository !== binding.repository) return deny();
      catalog.assertBinding(admission.binding.workspaceId, admission.binding.worktreeId, binding.cwd, admission.binding.bindingRevision);
    };
    assertCurrent();
    return { binding, session: session!, owner: owner!, admission: admission!, assertCurrent };
  }
  async function nativeHandoff(req: Request) {
    return grokRequestProof.run(req.headers.get(GROK_RUNTIME_HEADER) ?? undefined, () => nativeHandoffRequest(req));
  }
  async function nativeHandoffRequest(req: Request) {
    const denied = requireNativeBearer(req, handoffToken) ?? requireStartupReady(startupReady);
    if (denied) return denied;
    try {
      if (closing || storageFailed || meta.reconciliationRequired) return json({ error: "App execution owner unavailable" }, 503);
      const input = await body(req);
      const grok = input?.caller?.source?.harness === "gk"
        ? authorizeGrokInvocation(input.caller, input.operation === "status" ? "sane_handoff_status" : "sane_handoff",
          input.operation === "status" ? { requestId: input.requestId } : input.input) : undefined;
      if (input?.operation === "enqueue") {
        const caller = input.caller;
        const sender = meta.sessions.find(s => s.authorityId === caller?.authorityId && s.nativeSessionId === caller?.nativeId && toNativeHarness(sessionHarness(s)) === caller?.source?.harness);
        assertCatalogActive(sender);
      }
      if (input?.operation === "enqueue") return grokHandoffAuthorization.run(() => grok?.assertCurrent(), async () => json({ handoff: projectHandoffEnqueue(await handoffs.enqueue(input.caller, input.input)) }, 202));
      if (input?.operation === "status") { const handoff = await handoffs.status(input.caller, input.requestId); grok?.assertCurrent(); return json({ handoff: handoff ? projectHandoffStatus(handoff) : handoff, ...(handoff && handoffProblems.has(handoff.id) ? { problem: handoffProblems.get(handoff.id) } : {}) }); }
      return json({ error: "Unknown handoff operation" }, 400);
    } catch (error) { return httpErrorResponse(error, "Handoff admission unavailable"); }
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
      let created = false, predictedTitle: string | undefined;
      const handoff = await handoffs.prepareRecipient(workspaceId, handoffId, async h => {
        created = true;
        predictedTitle = await handoffContextTitle(h, workspaceId);
        const sessionId = h.recipient.sessionId, cwd = h.recipient.checkout.path, harness = toSessionHarness(h.recipient.harness);
        if (sessionId !== selected.recipient.sessionId || !coordinator.holdsAdmission(lease!, sessionId)) throw new WorkstreamAdapterError(409, "recipient-unavailable", "Recipient admission changed");
        let launch: OpenCodeLaunch | undefined;
        const native = conversationCreation(harness, cwd, () => launch!);
        let a = admissions.get(sessionId);
        const freshAdmission = !a;
        if (!a) {
          const association = await catalog.register(cwd);
          a = await beginConversationCreation(admissions, { sessionId, cwd, workspaceId: association.workspaceId, worktreeId: association.worktreeId }, native);
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
        const existingSession = meta.sessions.find(s => s.sessionId === sessionId);
        const sane: ActivationSnapshot = existingSession ? structuredClone({ saneContext: existingSession.saneContext, saneExecution: existingSession.saneExecution })
          : await executionReservation(sessionId, { kind: "assistant", role }, a.state === "intent" || freshAdmission ? () => prepareSaneContext({ kind: "assistant", role }) : undefined);
        const nativeAgent = sane.saneExecution ? "build" : config?.agent ?? nativeAgentId({ kind: "assistant", role }, harness);
        const policy = sane.saneExecution ? (await executionPackages.load(sane.saneExecution)).policy : undefined;
        if (policy && policy.spec.name !== `sane/assistant/${role}`) throw new Error("Reserved execution policy role changed");
        const model = config?.model ?? (policy?.model ? `${policy.model.providerID}/${policy.model.id}` : undefined);
        const effort = config?.effort ?? (!config?.model ? policy?.model?.variant : undefined);
        launch = a.state === "intent" && harness === "opencode"
          ? config ? { agent: nativeAgent, ...(model ? { model: oc.model(model, effort) } : {}) }
            : await oc.resolveLaunch(cwd, { agent: nativeAgent, model, effort })
          : undefined;
        await completeConversationCreation(admissions, a, native, async a => {
          if (!meta.sessions.some(s => s.sessionId === sessionId)) {
            if (harness === "opencode" && !launch) launch = await oc.recoverLaunch(a.nativeId!, cwd, nativeAgent);
            meta.sessions.push({ sessionId, nativeSessionId: a.nativeId!, harness, authorityId: a.source.authorityId, cwd, lastStatus: "unknown", lastRunId: null, title: predictedTitle, titleSource: "handoff", titleRevision: 0, titleAutoEligible: false,
              ...(config ? { profileId: config.profileId, ...(harness !== "opencode" ? { ...(config.model ? { model: config.model } : {}), ...(config.effort ? { effort: config.effort } : {}) } : {}) } : {}),
              ...(harness !== "opencode" || launch ? { agent: role, agentKind: "assistant", nativeAgentSelected: harness === "claude-code" || harness === "opencode" && !sane.saneExecution, ...sane } : {}),
              ...(launch?.model ? { model: `${launch.model.providerID}/${launch.model.id}`, ...(launch.model.variant ? { effort: launch.model.variant } : {}) } : {}),
            });
            await persist();
          }
          await catalog.associate(sessionId, cwd, a.binding.workspaceId, a.binding.worktreeId);
        });
        replyIntegration?.requestRefresh();
      });
      const session = meta.sessions.find(s => s.sessionId === handoff.recipient.sessionId);
      let titled = false;
      // Bound assignment index replaces only the prediction from this attempt.
      // A retry fills a missing title and never renames one already stored.
      if (session && handoff.recipient.ref && session.titleSource !== "manual" && (!session.title || created && session.titleSource === "handoff" && session.title === predictedTitle)) {
        const revision = session.titleRevision ?? 0;
        const title = await handoffContextTitle(handoff, workspaceId);
        if ((session.titleRevision ?? 0) === revision && session.title !== title) { session.title = title; session.titleSource = "handoff"; session.titleRevision = revision + 1; titled = true; }
      }
      if (created && session && !session.profileId && isStoredAssistantAgentId(session.agent)) {
        session.profileId = legacyProfileId(session.harness ?? "claude-code", session.agent);
        titled = true;
      }
      if (titled) await persist();
      return handoff;
    } finally {
      if (lease) coordinator.releaseAdmission(lease);
      finished.resolve(); attachmentTasks.delete(finished.promise);
    }
  }
  function readinessPolicy(options: Readonly<ConversationReadinessOptions<Owner>>, read?: SessionListProjection) {
    const { conversationId: sessionId, intent, phase, lease } = options;
    if (sessionId && appAdmissions) {
      const original = intent.kind === "user-prompt" ? originalAdmissionScope
        ?? (lease && coordinator.holdsAdmission(lease, sessionId) ? appAdmissionLeases.get(lease) : undefined) : undefined;
      const own = original ? appAdmissions.key(original) : undefined;
      const pending = read ? presentationAdmissions.get(read) ?? appAdmissions.readPending() : appAdmissions.readPending();
      if (pending.some(row => row.conversationId === sessionId
        && (!own || row.receipt.clientRequestId !== own.clientRequestId || row.receipt.payloadSha256 !== own.payloadSha256 || row.receipt.storeId !== own.storeId))) {
        return { ready: false as const, code: "app-admission-pending", reason: "An original App submission is unresolved; check its exact request receipt without resending" };
      }
    }
    if (sessionId && retiredId(sessionId)) return { ready: false as const, code: "session-retired", reason: "Conversation is retired from the active catalog. Restore it explicitly before sending." };
    if (sessionId && retirements.isPaused(sessionId)) return { ready: false as const, code: "session-retirement-pending", reason: "Conversation catalog operation is in progress" };
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
    if (sessionId && (read ? read.branchParents.has(sessionId) : branches.blockingSourceIds().some(sourceId => workerStore.hasDescendant(sourceId, sessionId)))) return { ready: false as const, reason: "Ancestor conversation has a pending branch or was replaced", code: "branch-parent" };
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
    const liveReport = sessionId && intent.kind === "worker-report" && phase === "enqueue" && intent.requestId
      && workerStore.deliveriesForParent(sessionId).some(d => d.id === intent.requestId && d.mode === "live-input"
        && d.state === "acceptance-unknown" && owners.get(sessionId)?.run.runId === d.run.runId);
    if (sessionId && !liveReport && !(intent.kind === "worker-report" && phase === "dispatch" && lease) && (read ? read.deliveryParents.has(sessionId) : workerStore.hasActiveDelivery(sessionId))) return { ready: false as const, reason: "Worker report continuation is reserved or acceptance is unconfirmed; inspect worker delivery evidence", code: "worker-delivery-pending" };
    if (sessionId && !(intent.kind === "worker-exchange" && phase === "dispatch" && lease) && workerStore.hasActiveExchange(sessionId)) return { ready: false as const, reason: "Worker exchange delivery is reserved or acceptance is unconfirmed; it will not be resent", code: "worker-exchange-pending" };
    if (sessionId && !delivery && (handoffReservations.has(sessionId) || handoffDispatches.has(sessionId))) return { ready: false as const, reason: "Recipient has an active or uncertain handoff", code: "handoff-pending" };
    const admission = sessionId ? admissions.get(sessionId) : undefined;
    const sourceHarness: string | undefined = admission?.source.descriptor.harness;
    const grokCreate = sourceHarness === "gk" && admission?.state === "identity_known" && intent.kind === "user-prompt";
    if (admission && admission.state !== "ready" && !grokCreate && !(preparation && (["retry-admission", "enroll", "attach"].includes(intent.kind) || admission.state === "identity_known" && admission.nativeId))) return { ready: false as const, reason: "Admission pending; explicit known-identity retry is required", code: "admission-pending" };
    if (sessionId && intent.kind !== "attach" && meta.sessions.find(s => s.sessionId === sessionId)?.attachment?.state === "pending") return { ready: false as const, reason: "Attachment incomplete. Retry Attach with the same harness, native ID and execution directory; no run is permitted.", code: "attachment-pending" };
    // Request IDs/origins are not capabilities. Keep every other policy above,
    // and ordinary callers, unchanged even when they copy the head request ID.
    // Read-only inspection and a source-owned child launch do not compete for
    // this recipient's turn. Every mutating recipient intent does, independently
    // of delivery origin or a copied queue request ID.
    if (sessionId && phase !== "enqueue" && ["user-prompt", "questionnaire-response", "worker-report", "worker-exchange", "worker-recovery", "handoff", "prepare-recipient", "branch", "compact", "branch-recovery", "enroll", "retry-admission", "attach"].includes(intent.kind) && pendingInputs?.hasChain(sessionId)
      && !pendingInputBridge?.allowsReadiness(options)) return { ready: false as const, reason: "A durable input chain is active; use the explicit pending-inputs API", code: "pending-input-chain-active" };
    return undefined;
  }
  function availability(sessionId?: string, capacity = true, delivery = false, preparation = false, inputMode?: "user", read?: SessionListProjection): { canSend: boolean; reason?: string; code?: string; queueAfterRunId?: string; liveInputRunId?: string } {
    const intent = delivery ? { kind: "handoff" as const } : preparation ? { kind: "prepare-recipient" as const } : inputMode === "user" ? { kind: "user-prompt" as const } : capacity ? { kind: "user-prompt" as const } : { kind: "inspect-idle" as const };
    const inspect = () => coordinator.inspectReadiness({ conversationId: sessionId, intent, phase: "admission" });
    const result = read ? sessionListReadiness.inspect(read, inspect) : inspect();
    if (!result.ready && result.code === "conversation-busy" && sessionId && inputMode === "user"
      && !coordinator.hasAdmission(sessionId) && !coordinator.hasReconciliation(sessionId) && !pendingInputs?.hasChain(sessionId)) {
      const owner = owners.get(sessionId);
      const session = meta.sessions.find(s => s.sessionId === sessionId);
      // Live input stays unavailable for Grok. Do not ask Claude whether this owner can send.
      if (session?.harness !== "grok") {
        const inspectEnqueue = () => coordinator.inspectReadiness({ conversationId: sessionId, intent: { kind: "user-prompt" }, phase: "enqueue" });
        const policy = read ? sessionListReadiness.inspect(read, inspectEnqueue) : inspectEnqueue();
        if (policy.ready && owner && claudeRuns.canSendInput(owner)) return { canSend: true, liveInputRunId: owner.run.runId };
      }
    }
    return result.ready ? { canSend: true, ...(result.queueAfterRunId ? { queueAfterRunId: result.queueAfterRunId } : {}) } : { canSend: false, reason: result.reason, code: result.code };
  }
  let serial = Promise.resolve();
  function publishMetadata(snapshot: string) {
    const receipt = metadataPublisher.commitSerialized(snapshot);
    committedMetadata = receipt;
    // Original observation association is captured INSIDE actual publication,
    // not reconstructed later from mutable launch settings or native eligibility.
    for (const owner of owners.values()) {
      const original = ownerMetadata.get(owner);
      if (!original || original.receipt) continue;
      try { metadataPublisher.assertOriginalAssociation(receipt, original.identity); original.receipt = receipt; }
      catch (error) { if (!(error instanceof MetadataCommitProofError)) throw error; }
    }
  }
  function persist() {
    // Capture at enqueue time. A later concurrent admission must not leak into
    // an earlier metadata write before its first log record reaches the queue.
    const snapshot = JSON.stringify(meta);
    return enqueue(async () => { publishMetadata(snapshot); }).then(() => {
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
  const sessionProfileId = (s: Session) => s.profileId ?? legacyProfileId(s.harness ?? "claude-code", s.agent);
  function failClosed(error?: unknown, stage = "unspecified") {
    if (!storageFailed) {
      // Log independently of App storage: the journal itself may be unavailable.
      // Capture a call site even when an older callback supplies no exception.
      const redact = (text: string) => text
        .replace(/(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
        .replace(/((?:token|password|secret|api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1[REDACTED]")
        .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[REDACTED]@");
      const describe = (value: unknown, depth = 0): string => value instanceof Error
        ? `${value.stack ?? value.message}${depth < 3 && value.cause !== undefined ? `\nCaused by: ${describe(value.cause, depth + 1)}` : ""}`
        : value === undefined ? "No exception supplied" : String(value);
      try {
        console.error("[SANE storage fail-closed]", JSON.stringify({ time: new Date().toISOString(), stage,
          error: redact(describe(error)), callSite: new Error("First storage failure").stack }));
      } catch { /* Diagnostics must never prevent ownership retention. */ }
    }
    storageFailed = true; retainOwner = true; meta.reconciliationRequired = true;
    void grokApp?.close().catch(() => {});
    pendingInputWake?.close();
    // Ownership records are the durable sentinel even if every later disk
    // write fails. Reopening requires process exit and explicit reconciliation.
    for (const owner of owners.values()) {
      // Original cleanup must not rediscover a transport or cancel remote work.
      try { void cleanupOwner(owner).catch(() => {}); } catch { /* Retention is already latched. */ }
    }
  }
  // All failClosed dependencies are initialized here. Earlier proof failures
  // already latched OUTER retention; later ones also fence the actual writer.
  failInitializedStorage = error => failClosed(error, "original-app-root-proof");
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
    } catch (error) { failClosed(error, "pending-input-wake-start"); throw error; }
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
      failClosed(error, "pending-input-notify");
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
    serial = next.catch(error => { failClosed(error, "serialized-storage-write"); });
    return next;
  }
  const grokManagedProjections = new Map<string, { projection: GrokOutputProjection; through: number; stderr: string; reason?: string; finished: boolean }>();
  function grokAuthoredBody(run: Run): string | undefined {
    for (const event of journalEvents(run.runId)) {
      if (event.kind !== "submission") continue;
      try {
        const submitted = decodeContextMessageSubmission(event.data), range = submitted.composition.body.range;
        return Buffer.from(submitted.text, "utf8").subarray(range.offset, range.offset + range.length).toString("utf8");
      } catch { /* Other submission evidence does not contain authored text. */ }
    }
  }
  async function grokManagedView(sessionId: string): Promise<GrokSessionView | null> {
    const session = meta.sessions.find(row => row.sessionId === sessionId && row.harness === "grok");
    const history = meta.runs.filter(run => run.sessionId === sessionId);
    if (!session) return null;
    const projections = history.slice(-32).map(run => {
      const records = journalEvents(run.runId);
      const prompt = grokAuthoredBody(run);
      let cached = grokManagedProjections.get(run.runId);
      if (!cached) {
        cached = { projection: new GrokOutputProjection({ id: run.runId, conversationId: sessionId, cwd: run.cwd,
        createdAt: run.createdAt, endedAt: run.endedAt, status: run.status, harness: "grok", nativeSessionId: session.nativeSessionId,
        operation: run.operation, ...(run.compact ? { compact: { requestId: run.compact.requestId } } : {}),
        model: run.model, effort: run.effort, agent: run.agent, agentKind: run.agentKind,
        profileId: run.profileId, nativeAgentSelected: run.nativeAgentSelected, saneContextVersion: run.saneContextVersion }, prompt ?? ""),
          through: 0, stderr: "", finished: false };
        if (prompt !== undefined) grokManagedProjections.set(run.runId, cached);
      }
      for (const event of records.slice(cached.through)) {
        if (event.kind === "stdout") cached.projection.feed(typeof event.data === "string" ? event.data : JSON.stringify(event.data) + "\n");
        if (event.kind === "stderr" && typeof event.data === "string") cached.stderr = (cached.stderr + event.data).slice(-8_000);
        if (event.kind === "status" && event.data && typeof event.data === "object" && typeof (event.data as { reason?: unknown }).reason === "string") cached.reason = (event.data as { reason: string }).reason;
      }
      cached.through = records.length;
      cached.projection.run.endedAt = run.endedAt;
      if (run.status !== "running" && !cached.finished) { cached.projection.finish(); cached.finished = true; }
      return cached.projection.snapshot(run.status, [cached.reason, cached.stderr].filter(Boolean).join("\n"));
    });
    const admission = admissions.get(sessionId), active = owners.has(sessionId);
    const base = agentProfiles.profiles.find(profile => profile.id === "base:gk");
    const ready = availability(sessionId, true, false, false, "user");
    return { protocol: "grok-capture", version: 1, sessionId, nativeSessionId: session.nativeSessionId!, authorityId: session.authorityId!,
      cwd: session.cwd, model: session.model ?? base?.model ?? "", effort: session.effort ?? base?.effort ?? "",
      profileId: session.profileId, agent: session.agent, agentKind: session.agentKind, nativeAgentSelected: session.nativeAgentSelected,
      title: session.title, workspaceId: admission?.binding.workspaceId, worktreeId: admission?.binding.worktreeId,
      phase: active ? "running" : ready.canSend ? "idle" : "blocked", nextTurnIndex: history.length, active,
      blocked: !active && !ready.canSend, availability: ready, ...(ready.reason ? { reason: ready.reason } : {}),
      nativeAcceptance: "unknown", acceptedMessageId: null, messages: projections.flatMap(projection => projection.messages),
      runs: projections.map(projection => projection.run) };
  }
  grokModelCatalog = new GrokModelCatalog({ dataDir: options.dataDir, executable: options.grokExecutable, homeRoot: options.grokHomeRoot,
    authorityId: () => admissions.getGrokSourcePin()?.authorityId ?? undefined,
    assertOpen: () => { assertStorageOwned(); if (closing || storageFailed) throw new Error("App is unavailable for model discovery"); },
  });
  grokApp = new GrokAppService({
    dataDir: options.dataDir, admissions, catalog,
    executable: options.grokExecutable, homeRoot: options.grokHomeRoot,
    appConnectionFile: join(options.dataDir, "native-handoff.json"), bindingDirectory: grokBindingDirectory,
    readSession: id => meta.sessions.find(session => session.sessionId === id),
    resolveProfile: async (input, stored) => {
      if (stored && (!input.profileId || input.profileId === stored.profileId)) return { profileId: stored.profileId ?? "base:gk", agent: stored.agent, agentKind: stored.agentKind,
        nativeAgentSelected: stored.nativeAgentSelected, saneExecution: stored.saneExecution, saneContext: stored.saneContext };
      const profile = agentProfiles.profiles.find(profile => profile.id === (input.profileId ?? "base:gk"));
      if (!profile || profile.harness !== "grok") throw new WorkstreamAdapterError(409, "grok-profile-unavailable", "Select a configured Grok profile");
      const launch = resolveAgentLaunch(profile);
      if (stored && (stored.agent || launch.identity?.kind !== "assistant")) throw new WorkstreamAdapterError(409, "invalid-profile-upgrade", "An existing Base chat can select an assistant on the same harness");
      if (launch.identity?.kind === "utility" || launch.identity?.kind === "worker") throw new WorkstreamAdapterError(409, "invalid-profile", "Worker and utility profiles use their normal App launch actions");
      const snapshot = agentLaunchSnapshot(launch);
      const context = launch.identity ? await executionReservation(input.sessionId, launch.identity, () => prepareSaneContext(launch.identity!)) : {};
      return { profileId: launch.profileId, agent: snapshot.agent, agentKind: snapshot.agentKind,
        ...(snapshot.agent ? { nativeAgentSelected: false } : {}), ...context };
    },
    preparePrompt: async (session, owner, prompt, firstTurn) => {
      if (!firstTurn || !session.saneContext?.package) return prompt;
      const current = () => {
        assertStorageOwned();
        if (owner.stopRequested || closing) throw new WorkstreamAdapterError(409, "grok-stopped", "Grok was stopped before sending");
      };
      const pinned = await contextPackages.load(session.saneContext.package);
      const roots = await sessionMessageSource(session, current);
      current(); roots.check();
      const source = owner.contextIdentity!.source;
      return composeContextMessage({ body: prompt,
        binding: { ...source, authorityId: session.authorityId!, nativeSessionId: session.nativeSessionId! },
        origin: "activation", placement: { kind: "bootstrap" }, context: pinned, session: roots.fragment }).transport.text;
    },
    managedView: grokManagedView,
    managedSubmit: async input => {
      if (Object.hasOwn(input, "scienceSnapshots")) throw new WorkstreamAdapterError(409, "science-chat-retired", "Science chat has been retired; saved submission history remains available");
      const current = await grokManagedView(input.sessionId);
      const existing = meta.sessions.find(session => session.sessionId === input.sessionId);
      if (existing && existing.harness !== "grok") throw new WorkstreamAdapterError(409, "grok-session-conflict", "This App conversation belongs to a different harness");
      if (current && input.turnIndex < current.nextTurnIndex) {
        const prior = meta.runs.filter(run => run.sessionId === input.sessionId)[input.turnIndex];
        if (!prior || grokAuthoredBody(prior) !== input.prompt || prior.model !== input.model || prior.effort !== input.effort) throw new WorkstreamAdapterError(409, "grok-turn-conflict", "This turn already identifies a different message");
        return current;
      }
      if (input.turnIndex !== (current?.nextTurnIndex ?? 0)) throw new WorkstreamAdapterError(409, "grok-turn-conflict", "Grok turn index changed; refresh this conversation");
      const prepared = await prepareUserInput({ ...(existing ? { sessionId: input.sessionId } : { harness: "grok", cwd: input.cwd,
        workspaceId: input.workspaceId, worktreeId: input.worktreeId }), prompt: input.prompt, model: input.model, effort: input.effort,
        ...(input.nativeStopped !== undefined ? { nativeStopped: input.nativeStopped } : {}),
        ...(input.profileId ? { profileId: input.profileId } : {}) }, { ...preparationState(), defaultCwd: options.cwd,
        conversationId: () => input.sessionId, selectedDirectory: async (workspaceId, worktreeId) => (await catalog.binding(workspaceId, worktreeId)).cwd,
        ensureDirectory, validateOpenCodeModel: (model, effort) => oc.model(model, effort), resolveOpenCodeLaunch: (cwd, settings) => oc.resolveLaunch(cwd, settings) });
      const lease = reserve({ kind: "user-prompt" }, input.sessionId);
      try { await admitPreparedInput(prepared, lease); } finally { coordinator.releaseAdmission(lease); }
      return (await grokManagedView(input.sessionId))!;
    },
    managedStop: async sessionId => {
      pendingInputControls.cancellationWrite(() => workerStore.suppress(sessionId, true));
      const forks = [...grokForkProcesses.values()].filter(fork => fork.sourceId === sessionId);
      for (const fork of forks) fork.controller.abort();
      const owner = pendingInputControls.stop(sessionId);
      if (owner) await cancelOwner(owner);
      await Promise.all(forks.map(fork => fork.done));
      return { interrupted: false, nativeCancellation: owner || forks.length ? "unproven" : "not-attempted",
        wrapperClosed: !owners.has(sessionId) && forks.every(fork => !fork.spawned || fork.observation?.closeObserved && fork.observation.processGroupGone),
        reason: owner || forks.length ? "Stopped the owned Grok process; provider cancellation remains unproven." : "No active Grok process." };
    },
    assertOpen: () => {
      assertStartupReady();
      if (!startupStorageHealthy()) throw new WorkstreamAdapterError(503, "bridge-unavailable", "App storage or execution is unavailable");
      assertStorageOwned();
    },
    admit: async <T>(sessionId: string, work: () => Promise<T>): Promise<T> => {
      const lease = reserve({ kind: "user-prompt" }, sessionId);
      try { return await work(); } finally { coordinator.releaseAdmission(lease); }
    },
    reserveTurn: sessionId => {
      const lease = reserve({ kind: "user-prompt" }, sessionId);
      return () => { coordinator.releaseAdmission(lease); };
    },
    persistSession: async session => {
      assertStorageOwned();
      const existing = meta.sessions.find(row => row.sessionId === session.sessionId);
      if (!existing) {
        Object.assign(meta, { version: 2 });
        meta.sessions.push(session);
        await persist();
      } else if (existing.harness === "grok" && existing.nativeSessionId === session.nativeSessionId && existing.authorityId === session.authorityId && existing.cwd === session.cwd) {
        Object.assign(existing, session);
        await persist();
      }
    },
    changed: () => { replyIndexedSessionCount = -1; },
  });
  function claudeGroupAlive(owner: Owner): boolean {
    const session = meta.sessions.find(s => s.sessionId === owner.run.sessionId);
    if (session?.harness === "grok") throw new HarnessOperationError("Grok is not observed through Claude process groups", 501, "unsupported-harness-operation");
    return claudeRuns.groupAlive(owner);
  }
  function bindOwnerControls(owner: Owner) {
    const session = meta.sessions.find(s => s.sessionId === owner.run.sessionId);
    if (!session) throw new HarnessOperationError("Run owner conversation is unavailable", 409, "owner-harness-mismatch");
    const source = dispatchSource(session);
    const controls = dispatchHarness(source.harnessId, {
      "claude-code": () => claudeRuns.controls(owner),
      opencode: () => ocRuns.controls(owner),
      grok: () => grokRuns.controlOperations(owner),
    });
    bindRunControls(owner, source, controls);
  }
  function cleanupOwner(owner: Owner): Promise<boolean> {
    // Cleanup targets original resources even when launch identity has failed.
    if (!owner.controls) throw new HarnessOperationError("Run owner controls are unavailable", 409, "owner-harness-mismatch");
    return owner.controls.cleanup();
  }
  function reserveJournalEvent(run: Run, kind: Event["kind"], data: unknown) {
    if (!events.has(run.runId) && deferredJournals.has(run.runId)) journalEvents(run.runId);
    const list = events.get(run.runId)!;
    const session = meta.sessions.find(session => session.sessionId === run.sessionId);
    let captured: { session: Session; run: Run; event: Event } | undefined;
    const reservation = runJournals.reserve(run, list, kind, data, event => {
      replyJournalThrough.set(run.runId, event.seq);
      // Projection callbacks run outside the writer's synchronous I/O/publication
      // section. A recorder may itself reserve a later event, never reenter a
      // flush or delay its durable native-boundary return.
      queueMicrotask(() => {
        if (captured) { try {
          updates.primaryJournalCommitted(captured.session, captured.run, captured.event);
          replyIntegration?.correlateCommitted(captured.session, captured.run, captured.event);
        } catch { /* optional update coverage */ } }
        if (captured) { try { chromePush?.journalCommitted(captured.session, captured.run, captured.event); } catch { /* optional device delivery */ } }
        if (session && kind === "message" && !retirementPaused(session.sessionId)) {
          try { nativeSubagentRecorder.refresh(session, run); }
          catch (error) { failClosed(error, "native-subagent-journal-projection"); }
        }
      });
    });
    const event = reservation.event;
    list.push(event);
    transcripts.ingest(run, [event]);
    try { if (session && updateEligible(session, run)) captured = structuredClone({ session, run, event }); }
    catch { /* Optional evidence indexing cannot interfere with journal ownership. */ }
    return reservation;
  }
  function emit(run: Run, kind: Event["kind"], data: unknown) {
    let namingText: string | undefined;
    if (kind === "submission" && namingSubmissions.has(run)) {
      const original = namingSubmissions.get(run)!;
      namingSubmissions.delete(run);
      // Only live first-submission evidence qualifies. Never backfill a name
      // from a later send, even if an earlier automatic attempt was unavailable.
      try {
        const list = events.get(run.runId);
        if (list && !list.some(event => event.kind === "submission") && !meta.runs.some(previous => previous.sessionId === run.sessionId && previous.runId !== run.runId
          && previous.operation !== "compact" && journalEvents(previous.runId).some(event => event.kind === "submission"))) namingText = original;
      } catch { /* Optional naming cannot interfere with submission. */ }
    }
    const reservation = reserveJournalEvent(run, kind, data);
    // Preserve the global metadata/write queue. Only the physical run-log append
    // changes implementation; there is no asynchronous append left in flight for
    // this live writer. A future synchronous fence consumes the same reservations.
    const committed = enqueue(async () => { runJournals.commit(reservation); });
    const owner = owners.get(run.sessionId), association = owner?.run === run ? boundContextAssociations.get(owner) : undefined;
    if (kind === "submission" && association && (data as { messageId?: unknown })?.messageId === association.messageId) {
      // The pairing follows its ONE actual standard submission in the same log.
      // onBound only staged these immutable source facts; it certified no send.
      boundContextAssociations.delete(owner!);
      const paired = reserveJournalEvent(run, "context", association);
      const contextCommitted = enqueue(async () => { runJournals.commit(paired); });
      if (namingText !== undefined) {
        const original = namingText;
        void contextCommitted.then(() => { setTimeout(() => sessionNaming?.submitted(run.sessionId, run, original), 0); }).catch(() => {});
      }
      return contextCommitted;
    }
    if (namingText !== undefined) {
      const original = namingText;
      // Both harnesses commit submissions here. Generation runs on a later
      // turn, never inside the journal queue or the run admission barrier.
      void committed.then(() => { setTimeout(() => sessionNaming?.submitted(run.sessionId, run, original), 0); }).catch(() => {});
    }
    return committed;
  }
  // Backfill provenance, not names or automatic eligibility.
  const displayTitle = (session: Session) => session.title ?? sessionDisplayTitle(session, meta.runs, events);
  let backfilledTitles = false;
  for (const session of meta.sessions) {
    if (!session.title) { session.title = genericSessionTitle(session); backfilledTitles = true; }
    if (!session.titleSource) { session.titleSource = session.title === genericSessionTitle(session) ? "fallback" : "legacy"; backfilledTitles = true; }
    if (session.titleRevision === undefined) { session.titleRevision = 0; backfilledTitles = true; }
    if (session.titleGeneration?.state === "pending") { session.titleGeneration.state = "failed"; session.titleGeneration.error = "interrupted"; backfilledTitles = true; }
  }
  if (backfilledTitles) await persist();
  let titleMutations = Promise.resolve();
  sessionNaming = new SessionNamingService({
    session: id => { const session = meta.sessions.find(s => s.sessionId === id); return session && !retirements.isRetired(session) && !retirements.isPaused(id) && !branches.replaced(id) && !branches.pending(id) ? session : undefined; },
    healthy: startupStorageHealthy,
    commit: <T>(action: () => T): Promise<T> => {
      const task = titleMutations.then(async () => {
        assertDomainMutationOpen();
        const result = queueDomainCommitted(action);
        await persist();
        return result;
      });
      titleMutations = task.then(() => {}, () => {});
      return task;
    },
    generate: (transcript, signal) => {
      const profile = agentProfiles.profiles.find(profile => profile.id === "utility:session-namer");
      if (!profile || profile.kind !== "utility" || profile.role !== "session-namer") throw new SessionNamingError(503, "title-profile-unavailable", "Session naming utility profile is unavailable");
      return runSessionNamingUtility({ sourceRoot: resolve(root, "../.."), dataDir: options.dataDir, claudeBin: options.claudeBin, claudeRoot, oc,
        grokExecutable: options.grokExecutable, grokHomeRoot: options.grokHomeRoot,
        profile: structuredClone(resolveProfileDefaults(agentProfiles, profile)), transcript, signal, agentModelConfig: options.agentModelConfig });
    },
  });
  const followupSessions = new Set(meta.runs.filter(run => run.queuedFollowupId).map(run => run.sessionId));
  materializeDeferred = runId => {
    if (!deferredJournals.has(runId)) return [];
    const run = meta.runs.find(item => item.runId === runId);
    if (!run) return [];
    deferredJournals.delete(runId);
    try {
      const logPath = join(options.dataDir, `${run.runId}.jsonl`);
      let raw: string;
      try { raw = readFileSync(logPath, "utf8"); } catch (e: any) { throw new Error(`Cannot load historical event log for ${run.runId}: ${e.code === "ENOENT" ? "missing file" : "read failed"}`); }
      const decoded = decodeLog(raw, run);
      if (decoded.repaired !== undefined) {
        if (retiredId(run.sessionId)) throw new Error("Archived journal requires explicit repair; no history was modified");
        if (anchoredActivationRuns.has(runId)) throw new Error("Anchored activation journal requires explicit reconciliation; no history was modified");
        runJournals.assertUnclaimed(runId);
        writeFileSync(logPath, decoded.repaired, { mode: 0o600 });
      }
      events.set(run.runId, decoded.events);
      replyJournalThrough.set(run.runId, decoded.events.at(-1)?.seq ?? 0);
      transcripts.ingest(run, decoded.events);
      return decoded.events;
    } catch (error) { deferredJournals.add(runId); throw error; }
  };
  const journalByteNotes: { session: Session; run: Run; through: number; bytes: number }[] = [];
  for (const run of meta.runs) {
    const logPath = join(options.dataDir, `${run.runId}.jsonl`);
    const sessionForRun = meta.sessions.find(session => session.sessionId === run.sessionId)!;
    if (retirements.isRetired(sessionForRun) && run.status !== "running") { deferredJournals.add(run.runId); continue; }
    // Reconciliation must still validate termination evidence, but settled
    // transcripts need not be retained/projected merely to prove no uncertainty.
    // Any unresolved, torn, changed or invalid journal uses the original path.
    const mustRead = run.status === "running" || followupSessions.has(run.sessionId)
      || !!options.reconcileInterrupted && sessionForRun.harness === "claude-code" && !await hasVerifiedSettledTermination(logPath, run);
    let present = false, journalSize = 0;
    if (!mustRead) {
      try {
        const file = statSync(logPath);
        present = file.isFile();
        if (present) journalSize = file.size;
      } catch { present = false; }
    }
    // Terminal workers have no update replay. A recorded length skips the tail read.
    // Missing length, size mismatch, or an unsettled terminal still falls through.
    // A missing file still falls through so the existing read reports it.
    if (present && !updateEligible(sessionForRun, run)) {
      deferredJournals.add(run.runId);
      continue;
    }
    if (present && updates.coveredByJournalBytes(sessionForRun, run, journalSize)) {
      deferredJournals.add(run.runId);
      continue;
    }
    if (present) {
      const seq = lastJournalSeq(logPath);
      if (seq !== undefined && updates.replaySettled(sessionForRun, run, seq)) {
        journalByteNotes.push({ session: sessionForRun, run, through: seq, bytes: journalSize });
        deferredJournals.add(run.runId);
        continue;
      }
    }
    let raw: string;
    try { raw = await readFile(logPath, "utf8"); } catch (e: any) { throw new Error(`Cannot load historical event log for ${run.runId}: ${e.code === "ENOENT" ? "missing file" : "read failed"}`); }
    const decoded = decodeLog(raw, run); const list = decoded.events;
    if (decoded.repaired !== undefined) await enqueue(async () => {
      if (anchoredActivationRuns.has(run.runId)) throw new Error("Anchored activation journal requires explicit reconciliation; no history was modified");
      runJournals.assertUnclaimed(run.runId);
      writeFileSync(logPath, decoded.repaired!, { mode: 0o600 });
    });
    events.set(run.runId, list);
    replyJournalThrough.set(run.runId, list.at(-1)?.seq ?? 0);
    transcripts.ingest(run, list);
    const updateSession = meta.sessions.find(session => session.sessionId === run.sessionId)!;
    if (updateEligible(updateSession, run) && await updates.replayRun(updateSession, run, list)) {
      const through = list.at(-1)?.seq;
      // A repair rewrite changes the file. Measure after that write, never the pre-repair size.
      let bytes: number | undefined = decoded.repaired === undefined && present ? journalSize : undefined;
      if (bytes === undefined) { try { bytes = statSync(logPath).size; } catch { bytes = undefined; } }
      if (through !== undefined && bytes !== undefined) journalByteNotes.push({ session: updateSession, run, through, bytes });
    }
    if (run.status === "running" && !getHarnessDescriptor(sessionHarness(meta.sessions.find(s => s.sessionId === run.sessionId)!))!.operations.recoverRun.supported) {
      run.status = "interrupted"; run.endedAt = new Date().toISOString(); meta.reconciliationRequired = true;
      const session = meta.sessions.find(s => s.sessionId === run.sessionId)!; session.lastStatus = "interrupted";
      await emit(run, "status", { status: "interrupted", reason: "server restarted; verify old CLI process has stopped", termination: { kind: "unconfirmed", cause: "server-restart" } satisfies TerminationUncertainty });
    }
    if (options.reconcileInterrupted && meta.sessions.find(s => s.sessionId === run.sessionId)?.harness === "claude-code") {
      const uncertainty = workerTerminationUncertainty(journalEvents(run.runId));
      if (uncertainty) await emit(run, "status", { status: run.status, reason: "Operator confirmed previous CLI termination with --reconcile-interrupted", reconciliation: { kind: "termination-confirmed", throughSeq: uncertainty.seq } });
    }
  }
  if (journalByteNotes.length && !await updates.noteJournalBytes(journalByteNotes)) throw new Error("Conversation update journal length note failed; reconciliation required");
  if (options.reconcileInterrupted) meta.reconciliationRequired = false;
  await persist();
  let origin = "", browserLoopbackOrigin = "";
  const auth = new BridgeAuth(authOptions, {
    getOrigin: () => origin, revokeTerminal: token => { terminals.revoke(token); browsers.revoke(token); chromePush?.revokeOwner(token); },
  });
  const terminalLog = join(options.dataDir, "terminal-performance.log");
  const terminals = new TerminalService(catalog, token => auth.validTerminalToken(token), line => {
    void appendFile(terminalLog, `${line}\n`, { mode: 0o600 }).catch(() => {});
  });
  const browsers = new BrowserService({ dataDir: options.dataDir, validToken: token => auth.validTerminalToken(token),
    getOrigins: () => ({ publicOrigin: origin, loopbackOrigin: browserLoopbackOrigin }),
    onError: error => {
      void appendFile(join(options.dataDir, "browser-errors.log"), `${new Date().toISOString()} ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`, { mode: 0o600 }).catch(() => {});
    },
    validateSession: (target, identity) => {
      const session = meta.sessions.find(session => session.sessionId === identity.sessionId), admission = admissions.get(identity.sessionId);
      let sessionHarnessId: Harness;
      try { sessionHarnessId = validateHarness(session?.harness); }
      catch { throw new BrowserGrantError(409, "browser-grant-identity", "Conversation identity or workspace changed; reconnect before granting browser access"); }
      if (!session || !admission || admission.state !== "ready" || admission.binding.workspaceId !== target.workspaceId
        || identity.harness !== sessionHarnessId || identity.authorityId !== session.authorityId || identity.nativeSessionId !== session.nativeSessionId) throw new BrowserGrantError(409, "browser-grant-identity", "Conversation identity or workspace changed; reconnect before granting browser access");
      const association = catalog.association(session.sessionId);
      let admittedHarness: Harness;
      try { admittedHarness = toSessionHarness(admission.source.descriptor.harness); }
      catch { throw new BrowserGrantError(409, "browser-grant-identity", "Conversation admission or workspace changed; reconnect before granting browser access"); }
      if (association.association !== "resolved" || association.workspaceId !== target.workspaceId || association.worktreeId !== admission.binding.worktreeId
        || admission.nativeId !== session.nativeSessionId || admission.source.authorityId !== session.authorityId
        || admittedHarness !== sessionHarnessId
        || admission.binding.executionCheckout !== session.cwd) throw new BrowserGrantError(409, "browser-grant-identity", "Conversation admission or workspace changed; reconnect before granting browser access");
      assertCatalogActive(session);
      if (session.agentKind === "worker" || workerStore.hasSession(session.sessionId) || session.attachment?.state === "pending"
        || branches.replaced(session.sessionId) || branches.pending(session.sessionId)
        || session.authorityId !== nativeSource(session.harness)) throw new BrowserGrantError(409, "browser-grant-unavailable", "This conversation is unavailable for browser access");
      catalog.assertBinding(admission.binding.workspaceId, admission.binding.worktreeId, admission.binding.executionCheckout, admission.binding.bindingRevision);
      return undefined;
    },
  });
  const branchContext = (id: string) => ({ actor: { kind: "system" as const }, correlationId: id });
  const branchFingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  async function branchDomain(source: Session, enroll = false) {
    const admission = admissions.get(source.sessionId);
    if (!admission || admission.state !== "ready") throw new Error("Source admission is not ready");
    if (source.nativeSessionId !== admission.nativeId || source.authorityId !== admission.source.authorityId || source.harness !== toSessionHarness(admission.source.descriptor.harness) || source.cwd !== admission.binding.executionCheckout) throw new Error("Source identity or execution checkout differs from its admission");
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
    if (workers.hasBlockingDescendants(source.sessionId) || workerStore.hasActiveDelivery(source.sessionId) || workerStore.hasActiveExchange(source.sessionId)) throw new Error("Finish outstanding workers and worker report deliveries before branching");
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
        const assistant = (id: string) => (journalEvents(id)).filter(e => e.kind === "stdout" && isClaudeRootRecord(e.data) && (e.data as any)?.session_id === source.nativeSessionId && (e.data as any)?.type === "assistant").at(-1)?.data as any;
        let latestRunId = source.lastRunId;
        if (source.lastStatus === "failed") {
          // A missing installed role can fail preparation before native launch.
          // Only those failures may retain the preceding completed-turn proof;
          // any launch/stream/hook evidence makes native acceptance uncertain.
          const runs = meta.runs.filter(r => r.sessionId === source.sessionId);
          const completed = runs.findLastIndex(r => r.status === "completed" && r.operation !== "compact");
          const failures = runs.slice(completed + 1);
          if (completed < 0 || !failures.length || failures.at(-1)?.runId !== source.lastRunId || failures.some(r => {
            const log = journalEvents(r.runId);
            return r.status !== "failed" || !log.some(e => e.kind === "status" && (e.data as any)?.status === "failed") || log.some(e => ["launch", "stdout", "hook"].includes(e.kind));
          })) throw new Error("Complete-turn/idle evidence is unavailable after a possibly launched failure");
          latestRunId = runs[completed]!.runId;
        } else if (source.lastStatus !== "completed") throw new Error("Complete-turn/idle evidence is unavailable for this harness");
        const selected = assistant(run.runId), latest = latestRunId && assistant(latestRunId);
        if (!uuid(selected?.uuid) || !uuid(latest?.uuid) || selected.message?.content?.some((p: any) => p.type === "tool_use")) throw new Error("Complete-turn/idle evidence is unavailable for this harness");
        const native = await readClaudeHistory(source.nativeSessionId!, source.cwd, claudeRoot);
        if (native.at(-1)?.messageId !== latest.uuid || !native.some(m => m.messageId === selected.uuid)) throw new Error("Native history differs from SANE's completed run evidence; external activity must be reconciled");
        return { boundary: selected.uuid as string, before: undefined, sourceFingerprint: branchFingerprint(native) };
      },
      grok: async () => {
        if (!run || source.lastRunId !== run.runId || source.lastStatus !== "completed"
          || meta.runs.filter(candidate => candidate.sessionId === source.sessionId).at(-1) !== run
          || source.attachment || !source.nativeSessionId || !source.authorityId) throw new Error("Grok can fork only its latest App-recorded completed native history");
        const snapshot = dispatchSnapshot(source);
        await serial;
        if (storageFailed || !grokWrapperCompletion({ harness: "gk", authorityId: source.authorityId, nativeId: source.nativeSessionId }, run, journalEvents(run.runId)))
          throw new Error("Grok latest-turn fork requires the exact completed wrapper and drained output");
        const native = await readGrokHistory(source.nativeSessionId, source.cwd, grokHistoryHome());
        assertDispatchSnapshot(source.sessionId, snapshot);
        if (!native.length || source.lastRunId !== run.runId || source.lastStatus !== "completed" || owners.has(source.sessionId)) throw new Error("Grok latest native history is unavailable or changed during branch selection");
        return { boundary: native.at(-1)!.messageId, before: undefined, sourceFingerprint: branchFingerprint(native) };
      },
    });
  }
  async function enrollBranch(op: BranchOperation, source: Session) {
    if (!op.nativeId) throw new Error("Native destination identity is unknown; no creation retry is permitted");
    if (meta.sessions.some(s => s.sessionId !== op.destinationId && s.authorityId === source.authorityId && s.nativeSessionId === op.nativeId)) throw new Error("Native fork identity is already associated with another App conversation");
    const original = admissions.get(source.sessionId)!;
    if (!admissions.get(op.destinationId)) await admissions.begin({ sessionId: op.destinationId, operation: "create", harness: toNativeHarness(source.harness as Harness), cwd: source.cwd, nativeId: op.nativeId, workspaceId: original.binding.workspaceId, worktreeId: original.binding.worktreeId, parent: original.binding.domain.mode === "repository" ? { harness: original.source.descriptor.harness, authorityId: original.source.authorityId, nativeId: source.nativeSessionId! } : null });
    const admission = admissions.get(op.destinationId)!;
    if (admission.nativeId !== op.nativeId || !["identity_known", "ready"].includes(admission.state)) throw new Error("Destination admission differs from the confirmed branch identity");
    const sourceDomain = original.binding.domain, destinationDomain = admission.binding.domain;
    if (sourceDomain.mode !== destinationDomain.mode || sourceDomain.mode === "repository" && (destinationDomain.mode !== "repository" || sourceDomain.repositoryId !== destinationDomain.repositoryId || sourceDomain.primaryCheckout !== destinationDomain.primaryCheckout) || admission.source.authorityId !== original.source.authorityId || admission.source.descriptor.harness !== original.source.descriptor.harness || admission.binding.executionCheckout !== original.binding.executionCheckout || admission.binding.workspaceId !== original.binding.workspaceId || admission.binding.worktreeId !== original.binding.worktreeId) throw new Error("Branch source and destination admission domains or execution bindings differ");
    let destination = meta.sessions.find(s => s.sessionId === op.destinationId);
    let activation: ActivationSnapshot | undefined;
    if (op.canonicalActivation) {
      if (source.agentKind !== "assistant" || !isAssistantAgentId(source.agent)) throw new Error("Branch canonical role identity differs from its source");
      activation = await executionReservation(op.destinationId, { kind: "assistant", role: source.agent });
      if (!activation.saneExecution || !activation.saneContext?.package) throw new Error("Branch requires a paired canonical activation");
    }
    if (destination && (destination.nativeSessionId !== op.nativeId || destination.authorityId !== source.authorityId || destination.harness !== source.harness || destination.cwd !== source.cwd || destination.agent !== source.agent || destination.agentKind !== source.agentKind || destination.model !== source.model || destination.effort !== source.effort || activation && (destination.nativeAgentSelected !== false || canonicalJSON({ saneExecution: destination.saneExecution, saneContext: destination.saneContext }) !== canonicalJSON(activation)))) throw new Error("Branch destination identity or activation differs from its reservation");
    if (!destination) {
      // Preserve actual forked history. A reserved activation supersedes its
      // historical startup role; it does not rewrite the source or the transcript.
      destination = { ...source, sessionId: op.destinationId, nativeSessionId: op.nativeId, lastStatus: "unknown", lastRunId: null, title: `${(displayTitle(source) ?? "Conversation").replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ").trim().slice(0, MAX_SESSION_TITLE_LENGTH - 9)} · Branch`, titleSource: "branch", titleRevision: 0, titleAutoEligible: false, titleGeneration: undefined };
      if (activation) Object.assign(destination, activation, { nativeAgentSelected: false });
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
    if (retirementPaused(op.sourceId) || retirementPaused(op.destinationId)) return;
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
        const sourceHistory = await dispatchHarness(sessionHarness(source), {
          opencode: () => oc.history(source.nativeSessionId!, source.cwd),
          "claude-code": async () => ({ messages: await readClaudeHistory(source.nativeSessionId!, source.cwd, claudeRoot) }),
          grok: async () => ({ messages: await readGrokHistory(source.nativeSessionId!, source.cwd, grokHistoryHome()) }),
        });
        if ("activity" in sourceHistory && sourceHistory.activity !== "idle" || branchFingerprint("rawMessages" in sourceHistory ? sourceHistory.rawMessages : sourceHistory.messages) !== op.sourceFingerprint) throw new Error("Source native history changed or became active during branching. Transfer is blocked; the confirmed native destination is retained for inspection.");
      }
      if (source.harness === "claude-code") await verifyClaudeFork(op.nativeId, source.cwd, source.nativeSessionId!, op.boundary, claudeRoot);
      if (source.harness === "grok") await verifyGrokFork(op.nativeId, source.cwd, source.nativeSessionId!, grokHistoryHome());
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
    if (snapshotIdentity(session)) return "SANE compaction requires qualified activation-retention proof; shared context will not be silently bootstrapped again";
    if (!meta.runs.some(row => row.sessionId === session.sessionId) && pendingActivations.hasPending(session.sessionId)) return "Send the original pending activation before compacting; its preparation journal cannot be replaced";
    if (session.agentKind === "worker" || workerStore.hasSession(session.sessionId)) return "Worker conversations cannot be compacted manually";
    if (workers.hasBlockingDescendants(session.sessionId) || workerStore.hasActiveDelivery(session.sessionId) || workerStore.hasActiveExchange(session.sessionId)) return "Finish outstanding workers and worker report deliveries before compacting";
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
    const logs = meta.runs.filter(r => r.sessionId === session.sessionId).flatMap(r => journalEvents(r.runId));
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
  const grokCompactEvidence = new WeakMap<Owner, ReturnType<typeof createDispatchEvidence>>();
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
      const { run } = newDispatchRun({ ...session, cwd }, { operation: "compact", compact: { requestId: input.requestId, ...(input.instructions !== undefined ? { instructions: input.instructions } : {}) } });
      if (session.harness === "opencode") {
        run.compact!.nativeRequestId = run.nativeCommandId;
      }
      const finished = Promise.withResolvers<void>();
      const owner: Owner = { run, native: session.harness === "opencode", nativeDispatched: false, done: finished.promise, settled: false };
      const initialEvents = prepareRunJournalInstallation({ directory: runJournalDirectory, run, runs: meta.runs,
        hasEvents: id => events.has(id), isDeferred: id => deferredJournals.has(id), hasPendingActivation: id => pendingActivations.hasPending(id), claimNew: target => runJournals.claimNew(target) });
      installOwner(lease, owner); session.lastRunId = run.runId; session.lastStatus = "running"; meta.runs.push(run); events.set(run.runId, initialEvents);
      if (session.harness === "grok") {
        const snapshot = dispatchSnapshot(session);
        const identity: DispatchIdentity = Object.freeze({ source: Object.freeze(dispatchSource(session)), runId: run.runId, nativeCommandId: null, requestId: input.requestId });
        owner.contextIdentity = identity;
        ownerMetadata.set(owner, { identity, binding: captureMetadataDispatchBinding(session, run, identity) });
        const original = () => {
          assertStorageOwned();
          if (storageFailed || owner.run !== run || !meta.runs.includes(run) || run.runId !== identity.runId || run.sessionId !== identity.source.sessionId
            || run.cwd !== identity.source.cwd || run.nativeCommandId != null) throw new Error("Original Grok compact journal association changed");
        };
        owner.assertMetadataCommitted = () => {
          original(); assertDispatchSnapshot(session.sessionId, snapshot);
          const published = ownerMetadata.get(owner);
          if (!published?.receipt) throw new Error("Original Grok compact metadata is not durably published");
          metadataPublisher.assertCommitted(published.receipt, published.binding);
        };
        owner.beforeSend = () => {
          original(); assertStartupReady(); assertDispatchSnapshot(session.sessionId, snapshot);
          if (closing || storageFailed || retainOwner || meta.reconciliationRequired || owners.get(session.sessionId) !== owner
            || owner.settled || owner.stopRequested || owner.cancelling || owner.stopping) throw new WorkstreamAdapterError(409, "compact-unavailable", "Original Grok compact owner is no longer current");
        };
        const record = (fact: import("../shared/conversation/dispatch-contract").DispatchSubmissionEvidence) => {
          original();
          // Native RPC dispatch facts, not a submitted context/user message.
          runJournals.commit(reserveJournalEvent(run, "context", { type: "grok-compact-dispatch", ...fact }));
        };
        const evidence = createDispatchEvidence(identity, { beforeNative: fact => { owner.beforeSend!(); owner.assertMetadataCommitted!(); record(fact); }, outcome: record }, error => failClosed(error, "grok-compact-evidence"));
        owner.dispatchEvidence = evidence; grokCompactEvidence.set(owner, evidence);
      }
      // Stable App and native request IDs reach disk before any native mutation.
      try {
        await emit(run, "status", { status: "running", operation: "compact", compactionLifecycle: "requested" });
        await persist();
      } catch (error) { owner.settled = true; finished.resolve(); throw error; }
      void executeCompact(owner, input.instructions).catch(async error => { failClosed(error, "compaction"); await cleanupOwner(owner); }).finally(() => {
        owner.settled = true;
        if (session.harness === "grok" && owner.streamsDrained !== true) { retainOwner = true; meta.reconciliationRequired = true; }
        else releaseOwner(owner);
        finished.resolve();
      });
      return { sessionId: session.sessionId, runId: run.runId, operation: projectCompactions(session, [run], journalEvents(run.runId))[0]! };
    } finally { coordinator.releaseAdmission(lease); }
  }
  function ownedSession(owner: Owner) {
    const session = meta.sessions.find(s => s.sessionId === owner.run.sessionId);
    if (!session) throw new HarnessOperationError("Run owner conversation is unavailable", 409, "owner-harness-mismatch");
    return { sessionId: session.sessionId, harness: sessionHarness(session), authorityId: session.authorityId, nativeSessionId: session.nativeSessionId, cwd: session.cwd };
  }
  async function executeCompact(owner: Owner, instructions?: string) {
    return dispatchOwnedOperation(ownedSession(owner), owner, "compact", {
      "claude-code": () => claudeRuns.execute(owner, `/compact${instructions ? ` ${instructions}` : ""}`, true, () => {}),
      opencode: () => ocRuns.executeNativeCompact(owner),
      grok: async () => {
        let result: Awaited<ReturnType<typeof grokRuns.executeCompact>>;
        try { result = await grokRuns.executeCompact(owner, instructions); }
        finally { grokCompactEvidence.get(owner)?.finish(); }
        if (result.refreshHistory && owner.streamsDrained === true) await refreshCompactHistory(owner);
        return result;
      },
    });
  }
  const ocRuns = new OpenCodeRunService({
    oc, closing: () => closing, storageFailed: () => storageFailed,
    failClosed: error => failClosed(error, "run-submission-invariant"),
    currentOwner: sessionId => owners.get(sessionId),
    session: sessionId => meta.sessions.find(s => s.sessionId === sessionId)!,
    events: runId => journalEvents(runId), emit, persist, execution, executionContext,
    compactExecution, refreshCompactHistory, assertWorkerDeliverySubmission,
    workerHasRun: runId => workerStore.hasExecutionRun(runId), sleep: ms => Bun.sleep(ms), canonicalExecution,
    explicitProtocol: sessionId => workerStore.getBySession(sessionId)?.protocol,
    completionInboxEmpty: async id => {
      const result = await oc.request<{ data: unknown[] }>(oc.path(id) + "/inbox");
      return Array.isArray(result?.data) && result.data.length === 0;
    },
  });
  const grokRuns = new GrokRunService<Owner>({
    executable: options.grokExecutable, homeRoot: options.grokHomeRoot ?? "",
    promptDirectory: join(options.dataDir, "grok-prompts"),
    appConnectionFile: join(options.dataDir, "native-handoff.json"), bindingDirectory: grokBindingDirectory,
    toolPath: grokApp.capability().configured ? grokApp.nativeToolPath() : undefined,
    session: id => meta.sessions.find(session => session.sessionId === id), owner: id => owners.get(id), admissions,
    append: emit, persist,
    assertOpen: () => { assertStartupReady(); if (!startupStorageHealthy()) throw new WorkstreamAdapterError(503, "bridge-unavailable", "App execution is unavailable"); },
    failClosed: error => failClosed(error, "grok-managed-run"),
    updateStatus: async (owner, status, reason) => {
      const session = meta.sessions.find(session => session.sessionId === owner.run.sessionId);
      if (session?.lastRunId === owner.run.runId) session.lastStatus = status;
      const observed = grokRuns.observation(owner);
      const identity = owner.contextIdentity;
      if (session && identity && identity.runId === owner.run.runId
        && identity.nativeCommandId === null && sameDispatchSource(identity.source, dispatchSource(session))
        && owners.get(session.sessionId) === owner && meta.runs.includes(owner.run)
        && observed?.submission === "submitted" && observed.wrapperCompletion === "closed" && owner.streamsDrained) {
        const completed = status === "completed" && observed.exitCode === 0 && observed.exitSignal === null;
        await emit(owner.run, "context", { type: completed ? "grok-wrapper-completion" : "grok-wrapper-termination", status, runId: owner.run.runId,
          source: identity.source, nativeCommandId: null, ...(identity.requestId ? { requestId: identity.requestId } : {}),
          submission: "submitted", nativeAcceptance: "unknown", wrapperCompletion: "closed", streamsDrained: true,
          exitCode: observed.exitCode, exitSignal: observed.exitSignal });
      }
      await emit(owner.run, "status", { status, ...(reason ? { reason } : {}) });
    },
    assertBinding: admission => catalog.assertBinding(admission.binding.workspaceId, admission.binding.worktreeId,
      admission.binding.executionCheckout, admission.binding.bindingRevision),
  });
  const { dispatchSource, dispatchSnapshot, contextBinding } = createDispatchSource({ sessionHarness, nativeSource });
  const sessionMessageSource = createSessionMessageSource({ storeId: store.manifest.storeId,
    resolveExecution, catalog });
  const assertQualifiedContinuation = (session: Session, activeRun: Run) => {
    // Lifecycle compatibility, not a claim about the current native prefix.
    // Existing metadata is validated when loaded; do not reconstruct journals
    // or native history just to send an ordinary body-only continuation.
    if (!session.saneExecution || !session.saneContext?.package) throw new WorkstreamAdapterError(409, "context-activation-unproven", "Legacy SANE context requires explicit lifecycle qualification; ordinary input cannot activate or migrate it");
    const admission = admissions.get(session.sessionId);
    if (activeRun.sessionId !== session.sessionId || !admission || admission.state !== "ready"
      || admission.nativeId !== session.nativeSessionId || admission.source.authorityId !== session.authorityId
      || admission.binding.executionCheckout !== session.cwd || toSessionHarness(admission.source.descriptor.harness) !== session.harness) throw new WorkstreamAdapterError(409, "context-source-unavailable", "Continuation requires its original ready native admission");
    if (branches.list().some(op => op.destinationId === session.sessionId)) throw new WorkstreamAdapterError(409, "context-branch-prefix-unproven", "Inherited shared context has no qualified branch lifecycle");
    for (const run of meta.runs) {
      if (run.sessionId !== session.sessionId) continue;
      let compactNotSubmitted = false;
      for (const event of events.get(run.runId) ?? []) {
        const data = event.data as { contextReset?: boolean; compaction?: unknown; operation?: string; compactNotSubmitted?: boolean } | null;
        if (data?.contextReset || event.kind === "message" && data?.compaction) throw new WorkstreamAdapterError(409, "context-retention-unproven", "Observed context reset or compaction requires explicit qualification before continuing");
        if (event.kind === "status" && event.runId === run.runId && event.sessionId === session.sessionId
          && data?.operation === "compact" && data.compactNotSubmitted === true) compactNotSubmitted = true;
      }
      // A failed status alone proves nothing. Only the original explicit local
      // non-submission fact exempts an attempt, never an accepted/native reset.
      if (run.operation === "compact" && (!compactNotSubmitted || run.nativePhase === "accepted"
        || run.nativeAcceptedAt !== undefined || run.compact?.nativeAdmittedId !== undefined)) throw new WorkstreamAdapterError(409, "context-retention-unproven", "Compaction retention requires explicit qualification before continuing");
    }
  };
  const prepareOwnedMessage = createPrepareOwnedMessage({ storeId: store.manifest.storeId,
    contextPackages, activationStores, assertQualifiedContinuation, sessionMessageSource, contextBinding,
    readWorker: id => workerStore.get(id),
    assertCleanContextChannel: (id, cwd) => oc.assertUserContextChannelClean(id, cwd),
  });
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
    if (source.harnessId === "grok") return grokRuns.readiness(source, "queued-user");
    if (source.harnessId !== "opencode") return { source, readiness: { ready: false as const, reason: "This harness needs its exact local lifecycle readiness", code: "dispatch-proof-unproven" } };
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
  const automation = { "queued-user": { supported: true as const }, "questionnaire-response": { supported: true as const }, "worker-report": { supported: true as const }, "worker-exchange": { supported: true as const }, "worker-recovery": { supported: true as const }, handoff: { supported: true as const } };
  dispatchRegistry.register(createClaudeDispatchAdapter({
    automation,
    readiness: async source => ({ source, readiness: { ready: false, reason: "Claude automatic readiness requires the exact completed process lifecycle", code: "dispatch-proof-unproven" } }),
    execute: (owner, prompt, resume, ready) => { assertLifecyclePublished(owner); return claudeRuns.execute(owner, prompt, resume, ready); },
    settlementEvidence: (owner, source) => {
      const session = meta.sessions.find(s => s.sessionId === source.sessionId);
      return { childPresent: !!owner.child && !!session && sameDispatchSource(source, dispatchSource(session)),
        exitCode: owner.child?.exitCode ?? null, groupAlive: !!owner.child && claudeGroupAlive(owner), streamsDrained: owner.streamsDrained === true };
    },
  }));
  dispatchRegistry.register(createOpenCodeDispatchAdapter({
    // Internal support only: prepared admission requires the strict linked claim.
    // No public queue capability is advertised by this adapter registration.
    automation,
    readiness: pinnedNativeReadiness,
    execute: (owner, prompt, resume, ready) => { assertLifecyclePublished(owner); return ocRuns.executeNative(owner, prompt, resume, ready); },
    exactCommand: async (_owner, source, commandId) => {
      // Operator reconciliation releases a stuck owner, but is deliberately
      // weaker than exact-command evidence for automatic queued continuation.
      if (journalEvents(_owner.run.runId).some(event => event.kind === "context" && event.data && typeof event.data === "object" && "type" in event.data && "proofKind" in event.data
        && event.data.type === "completion-reconciliation" && event.data.proofKind === "operator-verified")) return { commandId, outcome: "unknown" };
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
  dispatchRegistry.register(grokRuns.adapter);
  function executePrompt(lease: ConversationAdmissionLease, session: Session, run: Run, prompt: string, resume: boolean, origin: DispatchOrigin,
    options: { requestId?: string; coordinatorIntent?: ConversationOperationIntent["kind"]; validate?: () => void; link?: () => void; configure?: () => void; evidence?: DispatchEvidenceHooks; delivery?: PreparedAdmissionContext["delivery"]; nativeQueuedHandoff?: DispatchIdentity; publish?: PreparedAdmissionOptions["publish"]; submissionPublication?: SubmissionPublicationFactory; workerDeliveryId?: string; beforeSend?: () => void; messageIntent?: BridgeMessageIntent; activationPreparation?: { preparation: PendingActivationPreparation; assertCurrent: () => void }; reconciliation?: Omit<NonNullable<DispatchLifecycleHooks<Owner>["reconciliation"]>, "begin"> } = {}) {
    let snapshot = dispatchSnapshot(session);
    requireOperation(sessionHarness(session), "prompt");
    let published = false;
    let contextEvidence: DispatchEvidenceHooks | undefined;
    let contextSourceCheck = () => {};
    const originalEvidence = pendingInputControls.evidence(options.evidence) ?? {};
    const lifecycle = dispatchRegistry.start({ source: dispatchSource(session), prompt, resume, origin, requestId: options.requestId }, {
      install: done => {
        assertStartupReady();
        synchronousDispatchHook(() => options.validate?.());
        const preparation = options.activationPreparation?.preparation;
        const initialEvents = prepareRunJournalInstallation({ directory: runJournalDirectory, run, runs: meta.runs,
          hasEvents: id => events.has(id), isDeferred: id => deferredJournals.has(id), hasPendingActivation: id => pendingActivations.hasPending(id),
          claimNew: target => runJournals.claimNew(target),
          preparation, assertPreparation: options.activationPreparation?.assertCurrent });
        synchronousDispatchHook(() => options.link?.());
        assertDispatchSnapshot(session.sessionId, snapshot);
        const claim = options.nativeQueuedHandoff;
        if (claim && (claim.runId !== run.runId || claim.nativeCommandId !== run.nativeCommandId || !sameDispatchSource(claim.source, dispatchSource(session)))) throw new WorkstreamAdapterError(409, "dispatch-source-mismatch", "Linked native handoff identity changed before installation");
        const owner: Owner = { run, native: session.harness === "opencode", nativeDispatched: false, done, settled: false,
          ...(options.delivery ? { nativeDeliveryPolicy: options.delivery } : {}),
          ...(claim ? { nativeQueuedHandoff: Object.freeze({ runId: run.runId, nativeCommandId: run.nativeCommandId!, requestId: claim.requestId!, origin: "queued-user" as const, source: dispatchSource(session) }) } : {}),
          ...(options.workerDeliveryId ? { workerDeliveryId: options.workerDeliveryId } : {}),
          assertMetadataCommitted: () => {
            // Representation proof is separate from execution eligibility. Stop
            // and shutdown cannot suppress original accepted/unknown evidence;
            // live coordinator/cancellation gates still control native admission.
            if (storageFailed) throw new Error("Original metadata storage is unavailable");
            assertDispatchSnapshot(session.sessionId, snapshot);
            const original = ownerMetadata.get(owner);
            if (!committedMetadata || !original?.receipt) throw new Error("Original Run metadata has not been durably published");
            metadataPublisher.assertCommitted(original.receipt, original.binding);
          }, beforeSend: () => {
            assertStartupReady();
            if (closing || storageFailed || retainOwner || meta.reconciliationRequired) throw new WorkstreamAdapterError(409, "dispatch-unavailable", "Execution unavailable before dispatch");
            assertDispatchSnapshot(session.sessionId, snapshot); synchronousDispatchHook(() => options.beforeSend?.()); contextSourceCheck();
          } };
        synchronousDispatchHook(() => options.activationPreparation?.assertCurrent());
        installOwner(lease, owner);
        const resumingWorker = workerStore.getBySession(session.sessionId);
        if (resumingWorker?.error === WORKER_COMPLETION_RECOVERY_SPENT_DIAGNOSTIC) workerStore.update(resumingWorker.id, { error: undefined });
        published = true;
        options.configure?.(); snapshot = dispatchSnapshot(session);
        session.lastRunId = run.runId; session.lastStatus = "running"; meta.runs.push(run);
        events.set(run.runId, initialEvents);
        if (preparation) {
          replyJournalThrough.set(run.runId, initialEvents.at(-1)!.seq);
          transcripts.ingest(run, initialEvents);
        }
        const capturedIdentity: DispatchIdentity = Object.freeze({ source: Object.freeze(dispatchSource(session)), runId: run.runId,
          nativeCommandId: run.nativeCommandId ?? null, ...(options.requestId !== undefined ? { requestId: options.requestId } : {}) });
        owner.contextIdentity = capturedIdentity;
        ownerMetadata.set(owner, { identity: capturedIdentity, binding: captureMetadataDispatchBinding(session, run, capturedIdentity) });
        if (options.submissionPublication) owner.submissionPublication = options.submissionPublication(owner);
        const observeCurrent = () => {
          assertStorageOwned();
          if (storageFailed || owner.run !== run || !meta.runs.includes(run) || run.runId !== capturedIdentity.runId
            || (run.nativeCommandId ?? null) !== capturedIdentity.nativeCommandId || run.sessionId !== capturedIdentity.source.sessionId
            || run.cwd !== capturedIdentity.source.cwd) throw new Error("Original context message journal association changed");
        };
        const launchCurrent = () => {
          observeCurrent(); assertStartupReady();
          if (!coordinator.owns(owner) || owner.settled || owner.stopRequested || owner.cancelling || owner.stopping
            || closing || storageFailed || retainOwner || meta.reconciliationRequired) throw new WorkstreamAdapterError(409, "context-owner-unavailable", "Original context message owner cannot submit new input");
          assertDispatchSnapshot(session.sessionId, snapshot);
          if (!sameDispatchSource(dispatchSource(session), capturedIdentity.source)) throw new WorkstreamAdapterError(409, "context-source-changed", "Original native source changed before new context submission");
          const a = admissions.get(session.sessionId);
          if (!a || a.state !== "ready" || a.nativeId !== session.nativeSessionId || a.source.authorityId !== session.authorityId
            || a.binding.executionCheckout !== session.cwd || toSessionHarness(a.source.descriptor.harness) !== session.harness) throw new WorkstreamAdapterError(409, "context-source-unavailable", "Context message source differs from its ready native admission");
        };
        const assertAdmissionMetadata = owner.assertMetadataCommitted!;
        const messages = createDispatchContextBinding({ identity: capturedIdentity, session, readIntent: () => options.messageIntent,
          originalHooks: originalEvidence, writer: runJournals, readEvents: () => events.get(run.runId) ?? [],
          assertObservationCurrent: observeCurrent, assertLaunchCurrent: launchCurrent, assertAdmissionMetadata,
          assertOriginalMetadataAssociation: () => {
            const original = ownerMetadata.get(owner);
            if (!original?.receipt) throw new Error("Original dispatch metadata association was never durably published");
            metadataPublisher.assertOriginalAssociation(original.receipt, original.identity);
          },
          reserveObservation: observation => {
            const reserved = reserveJournalEvent(run, "context", observation);
            void enqueue(async () => { runJournals.commit(reserved); }).catch(() => {});
            return reserved;
          }, prepare: (request, assertCurrent, publishSourceCheck) => prepareOwnedMessage(session, owner.run, prompt, origin, options.messageIntent, request,
            assertCurrent, publishSourceCheck),
          contextBinding, contextJournalSource: () => contextJournalSource(run.runId),
          stageActivationPairing: pairing => { boundContextAssociations.set(owner, pairing); },
          evidenceFailed: error => failClosed(error, "context-message-evidence"),
          messageFailed: error => failClosed(error, "owned-context-message") });
        contextSourceCheck = messages.assertSourceCurrent;
        owner.contextMessages = messages.transport; contextEvidence = messages.hooks;
        return owner;
      },
      evidence: { beforeNative: fact => {
        if (!contextEvidence) throw new Error("Shared message evidence was not installed");
        return contextEvidence.beforeNative?.(fact);
      }, outcome: fact => (contextEvidence ?? originalEvidence).outcome?.(fact) },
      owns: owner => coordinator.owns(owner), settle: owner => { owner.settled = true; }, release: releaseOwner,
      failClosed: error => {
        // A final validation refusal before publication is definite non-launch,
        // not a storage failure. Partial publication still retains ownership.
        // After-release source errors are still post-publication failures.
        if (published || coordinator.hasOwner(run.sessionId) || !(error instanceof UserInputPreparationError || error instanceof WorkstreamAdapterError)) failClosed();
      }, terminate: cleanupOwner,
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
        const intent: ConversationOperationIntent = { kind: options.coordinatorIntent ?? (origin === "handoff" ? "handoff" : origin === "worker-report" ? "worker-report" : origin === "worker-exchange" ? "worker-exchange" : origin === "worker-recovery" ? "worker-recovery" : origin === "questionnaire-response" ? "questionnaire-response" : "user-prompt"), requestId: options.requestId };
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
    // Central shared dispatch covers worker launch, user/handoff turns and every
    // report/exchange continuation across Claude, OpenCode and Grok. Observation
    // remains read-only with respect to native sends; only this settled event
    // makes the original lifecycle a recovery candidate.
    const settled = lifecycle.done.then(async () => {
      if (closing || storageFailed) return;
      // Live-input reports can belong to an ordinary nonworker parent turn.
      // Its explicit settlement, not the outbox poll, must reconcile their
      // final journal evidence before waking a blocked worker candidate.
      await reconcileWorkerSettlementTraffic(session.sessionId);
      const worker = workerStore.getBySession(session.sessionId);
      if (worker) {
        await reconcileCompletionRecoveryDelivery(worker);
        await workers.refresh(workerStore.get(worker.id)!);
      }
      workerCompletionRecovery?.notify();
    });
    dispatchTasks.add(settled);
    void settled.finally(() => dispatchTasks.delete(settled)).catch(error => failClosed(error, "worker-completion-settlement"));
    if (workerStore.hasSession(session.sessionId)) {
      workerCompletionRecovery?.track({ runId: run.runId, source: Object.freeze({ ...dispatchSource(session) }), successfulSettlement: lifecycle.successfulSettlement }, settled);
    }
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
  const preparationState = () => ({ getSession: (id: string) => meta.sessions.find(s => s.sessionId === id), profiles: agentProfiles, sourceAuthorityId: nativeSource, prepareCanonicalExecution });
  // Historical receipts retain their exact frozen bytes. Never load, migrate or
  // replay retired chat storage to prepare a new submission.
  const scienceOutcomeEvidence = new Map<string, import("../shared/conversation/dispatch-contract").DispatchSubmissionEvidence>();
  const scienceSubmissions = new ScienceSubmissionStore(options.dataDir, store.manifest.storeId, {
    beforeMutation: () => { if (closing || storageFailed || !startupReady) throw new ScienceSubmissionStorageError("Science submission ownership is unavailable"); },
    validateLive: ({ stage, receipt }) => {
      const { intent } = receipt;
      if (stage !== "outcome") throw new ScienceSubmissionError("science-chat-retired", "Science chat has been retired; saved submission history remains available");
      if (stage === "outcome") {
        const evidence = scienceOutcomeEvidence.get(`${intent.conversationId}/${intent.requestId}`);
        if (!evidence || evidence.requestId !== intent.requestId || evidence.source.sessionId !== intent.conversationId
          || evidence.runId !== receipt.association?.runId || evidence.nativeCommandId !== receipt.association?.nativeCommandId
          || evidence.submission !== receipt.state || receipt.state === "not-submitted" && receipt.nativeAttempted) throw new Error("Science outcome lacks original dispatch evidence");
      }
    },
  });
  function scienceView(receipt: ScienceSubmissionReceipt): ScienceSubmissionView {
    return { requestId: receipt.intent.requestId, conversationId: receipt.intent.conversationId, state: receipt.state,
      runId: receipt.association?.runId ?? null, snapshots: receipt.intent.snapshots.map(({ snapshotId, blockId }) => ({ snapshotId, blockId })) };
  }
  /** Backend launch authority shared by immediate admission and explicit queue
   * recovery. Ordinary user sends are idle-only. */
  async function admitPreparedInput(prepared: PreparedUserInput, lease: ConversationAdmissionLease, options: PreparedAdmissionOptions & { messageIntent?: BridgeMessageIntent; submissionPublication?: SubmissionPublicationFactory } = {}) {
    const { conversationId, cwd, harness } = prepared.binding;
    const input = prepared.normalized, { model, effort, agent } = prepared.configuration;
    const { queuedFollowupId, publish } = options;
    const namingText = prepared.prompt;
    // Copy explicit context before any await. Hooks are capabilities, not mutable
    // settings aliases; IDs, intent and origin cannot drift during preflight.
    const context = options.context && Object.freeze({ ...options.context, intent: Object.freeze({ ...options.context.intent }), evidence: options.context.evidence && Object.freeze({ ...options.context.evidence }) });
    if (context && (context.delivery !== "idle-only" && context.delivery !== "native-queued-handoff"
      || !["user", "queued-user", "questionnaire-response", "worker-report", "worker-exchange", "handoff"].includes(context.origin))) throw new UserInputPreparationError("Explicit admission requires a known delivery policy and origin", 409);
    if (publish !== undefined && typeof publish !== "function") throw new UserInputPreparationError("Lifecycle publisher must be a function", 409);
    const nativeHandoff = context?.delivery === "native-queued-handoff";
    if (nativeHandoff && (harness !== "opencode" || context.origin !== "queued-user" || context.intent.kind !== "user-prompt"
      || typeof context.intent.requestId !== "string" || !context.intent.requestId.trim() || queuedFollowupId !== undefined
      || typeof context.validate !== "function" || typeof context.link !== "function"
      || typeof context.evidence?.beforeNative !== "function" || typeof context.evidence?.outcome !== "function")) throw new UserInputPreparationError("Native queued handoff requires OpenCode queued-user intent, stable request ID and synchronous claim/link/evidence capabilities", 409);
    if (harness === "opencode" && (context?.origin ?? (queuedFollowupId ? "queued-user" : "user")) === "queued-user" && !nativeHandoff) throw new UserInputPreparationError("OpenCode queued-user admission requires explicit native-queued-handoff policy", 409);
    if (nativeHandoff) {
      const pins = (configuration: PreparedUserInput["configuration"]) => JSON.stringify([configuration.profileId, configuration.model, configuration.effort,
        configuration.agent, configuration.agentKind, configuration.nativeAgentSelected, configuration.saneContext, configuration.saneExecution, configuration.attachment]);
      if (prepared.stagedUpgrade || prepared.nativeLaunch || !prepared.expectedPrior || pins(prepared.expectedPrior.configuration) !== pins(prepared.configuration)
        || (["model", "effort", "agent", "profileId"] as const).some(key => input[key] !== undefined && input[key] !== prepared.configuration[key])) throw new UserInputPreparationError("Native queued handoff cannot change captured conversation configuration", 409);
    }
    const intent = context?.intent ?? { kind: "user-prompt" as const };
    const origin = context?.origin ?? (queuedFollowupId ? "queued-user" : "user");
    const delivery = context?.delivery ?? (origin === "user" ? "idle-only" : undefined);
    const priorSession = meta.sessions.find(row => row.sessionId === conversationId);
    const noPriorRun = !meta.runs.some(row => row.sessionId === conversationId);
    const anchored = noPriorRun && pendingActivations.hasPending(conversationId);
    const prepareActivationJournal = !context && !queuedFollowupId && !prepared.stagedUpgrade && origin === "user"
      && ((!prepared.resume && prepared.canonicalActivation !== undefined) || anchored);
    if (anchored && !prepareActivationJournal) throw new UserInputPreparationError("Pending activation requires explicit original-journal adoption; this delivery path cannot replace it", 409);
    let activationPreparation: PendingActivationPreparation | undefined;
    const activationHarness = harness;
    const activationInput = prepareActivationJournal && activationHarness && isAssistantAgentId(agent) && prepared.configuration.saneExecution && prepared.configuration.saneContext ? {
      sessionId: conversationId, identity: { kind: "assistant" as const, role: agent },
      activation: { saneExecution: prepared.configuration.saneExecution, saneContext: prepared.configuration.saneContext },
      source: { harnessId: activationHarness, authorityId: prepared.binding.authorityId, cwd },
    } : undefined;
    const assertPreparationAdmission = () => {
      if (!coordinator.holdsAdmission(lease, conversationId) || closing || storageFailed || retainOwner || meta.reconciliationRequired
        || meta.runs.some(row => row.sessionId === conversationId) || coordinator.hasOwner(conversationId) || coordinator.hasReconciliation(conversationId)) throw new UserInputPreparationError("Activation preparation no longer owns its original first-Run admission", 409);
      assertPreparedUserInputCurrent(prepared, preparationState());
      if (nativeSource(harness) !== prepared.binding.authorityId) throw new UserInputPreparationError("Activation native authority changed", 409);
    };
    if (prepareActivationJournal) {
      if (!activationInput || priorSession?.lastRunId) throw new UserInputPreparationError("Pending activation lacks its original canonical configuration", 409);
      assertPreparationAdmission();
      await revalidatePreparedUserInput(prepared, { ...preparationState(), ensureDirectory, validateBinding: assertPreparationAdmission });
      let preparationResult: ReturnType<typeof prepareActivationWhileAdmitted<PendingActivationPreparation>> | undefined;
      await enqueue(async () => { preparationResult = prepareActivationWhileAdmitted(assertPreparationAdmission, () => pendingActivations.prepare(activationInput), error => error instanceof UserInputPreparationError || error instanceof WorkstreamAdapterError); });
      if (!preparationResult) throw new Error("Activation preparation queue did not complete");
      if ("refused" in preparationResult) throw preparationResult.refused;
      activationPreparation = preparationResult.prepared;
      assertPreparationAdmission();
    }
    // Resolve the original preparation identity BEFORE constructing dispatch or
    // linking any consumer. No replacement attempt is allocated on adoption.
    const runId = activationPreparation?.runId ?? context?.runId ?? crypto.randomUUID();
    // Grok throws here, before followup checks, receipts, or admission writes.
    const nativeCommandId = preparedAdmissionNativeCommandId(harness, activationPreparation?.nativeCommandId ?? context?.nativeCommandId);
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
    const upgradedRole = prepared.stagedUpgrade?.role ?? input.agent;
    const upgradeContext: ActivationSnapshot | undefined = session && !session.agent && isAssistantAgentId(upgradedRole) && prepared.configuration.saneExecution
      ? structuredClone({ saneContext: prepared.configuration.saneContext, saneExecution: prepared.configuration.saneExecution }) : undefined;
    if (upgradeContext?.saneContext?.package) upgradeContext.saneContext.package.activation = "upgrade";
    if (upgradeContext && (session!.attachment || branches.list().some(op => op.destinationId === conversationId))) throw new UserInputPreparationError("Attached or branched native context cannot be silently migrated by an assistant upgrade", 409, "context-legacy-channel-active");
    if (upgradeContext?.saneExecution && upgradeContext.saneContext && isAssistantAgentId(upgradedRole)) await validateCanonicalActivation({ saneExecution: upgradeContext.saneExecution, saneContext: upgradeContext.saneContext }, { kind: "assistant", role: upgradedRole }, activationStores);
    assertPreparedUserInputCurrent(prepared, preparationState()); assertLease();
    if (!session) {
      if (association.association !== "resolved") throw new WorkstreamAdapterError(409, "association-unresolved", "Execution association unavailable");
      const sane = activationPreparation?.activation ?? (input.agent !== undefined ? await executionReservation(conversationId, { kind: "assistant", role: input.agent }, async () => prepared.configuration.saneExecution
        ? structuredClone({ saneContext: prepared.configuration.saneContext, saneExecution: prepared.configuration.saneExecution }) : saneSessionContext({ kind: "assistant", role: input.agent! })) : {});
      if (prepared.configuration.saneExecution && (sane.saneExecution?.revision !== prepared.configuration.saneExecution.revision || sane.saneContext?.package?.revision !== prepared.configuration.saneContext?.package?.revision)) throw new Error("Prepared activation differs from its durable reservation");
      assertPreparedUserInputCurrent(prepared, preparationState()); assertLease();
      const native = conversationCreation(harness, cwd, () => { assertLease(); return prepared.nativeLaunch!; });
      const admission = await beginConversationCreation(admissions, { sessionId: conversationId, cwd,
        workspaceId: association.workspaceId, worktreeId: association.worktreeId }, native);
      assertPreparedUserInputCurrent(prepared, preparationState()); assertLease();
      const created = await completeConversationCreation(admissions, admission, native, async a => {
        assertPreparedUserInputCurrent(prepared, preparationState()); assertLease();
        const createdSession: Session = { sessionId: conversationId, harness, nativeSessionId: a.nativeId!, authorityId: a.source.authorityId, cwd, lastStatus: "unknown", lastRunId: null,
          title: genericSessionTitle({ agent: input.agent, agentKind: input.agent ? "assistant" : undefined }), titleSource: "fallback", titleRevision: 0, titleAutoEligible: true,
          ...(input.model !== undefined ? { model: input.model } : {}), ...(input.effort !== undefined ? { effort: input.effort } : {}),
          ...(input.agent !== undefined ? { agent: input.agent, agentKind: "assistant", nativeAgentSelected: harness === "claude-code" || harness === "opencode" && !sane.saneExecution, ...sane } : {}),
          ...(prepared.selectedProfile ? { profileId: prepared.selectedProfile.id } : {}) };
        createdSnapshot = structuredClone(createdSession);
        meta.sessions.push(createdSession); await persist();
        return createdSession;
      });
      session = created.value;
      replyIntegration?.requestRefresh();
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
        if (delivery === "idle-only") throw new WorkstreamAdapterError(409, "native-busy", "Wait for the native assistant to finish before sending");
        if (session.agentKind === "worker" || prepared.stagedUpgrade || input.model !== undefined && input.model !== session.model
          || input.effort !== undefined && input.effort !== session.effort || input.agent !== undefined && input.agent !== session.agent) throw new OpenCodeError("Wait for OpenCode to finish before changing conversation configuration or sending worker input", 409);
        nativeDelivery = "queue";
      }
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
      if (!isAssistantAgentId(prepared.stagedUpgrade.role)) throw new UserInputPreparationError("Conversation upgrade requires an assistant profile", 409);
      configured.profileId = prepared.stagedUpgrade.id; configured.agent = prepared.stagedUpgrade.role ?? undefined;
      if (prepared.stagedUpgrade.model) configured.model = prepared.stagedUpgrade.model; else delete configured.model;
      if (prepared.stagedUpgrade.effort) configured.effort = prepared.stagedUpgrade.effort; else delete configured.effort;
    }
    if (upgradeContext?.saneContext) {
      configured.agentKind = "assistant";
      configured.saneContext = upgradeContext.saneContext;
      configured.saneExecution = prepared.configuration.saneExecution ?? upgradeContext.saneExecution;
      configured.nativeAgentSelected = harness === "claude-code";
      configured.model = prepared.configuration.model;
      configured.effort = prepared.configuration.effort;
    }
    if (!configured.title) { configured.title = genericSessionTitle(configured); configured.titleSource = "fallback"; }
    const run: Run = { runId, sessionId: conversationId, cwd, status: "running", createdAt: new Date().toISOString(),
      ...(nativeDelivery ? { nativeDelivery } : {}), ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}),
      ...(agent !== undefined ? { agent, agentKind: configured.agentKind, nativeAgentSelected: configured.nativeAgentSelected } : {}),
      // Strict delivery preserves actual stored pins, including legacy omission;
      // it must not normalize preferences or upgrade metadata during a claim.
      profileId: nativeHandoff ? configured.profileId : sessionProfileId(configured), ...saneContextSnapshot(configured), ...(queuedFollowupId ? { queuedFollowupId } : {}) };
    if (harness === "opencode") { run.nativeCommandId = nativeCommandId!; run.nativePhase = "preparing"; }
    const installedSnapshot = structuredClone(configured);
    const assertActivationPreparation = () => {
      if (!activationPreparation || !activationInput) throw new Error("Activation preparation capability unavailable");
      assertDispatch(); assertContext();
      const a = admissions.get(conversationId);
      if (!a || a.state !== "ready" || a.nativeId !== session!.nativeSessionId || a.source.authorityId !== session!.authorityId
        || a.source.descriptor.harness !== toNativeHarness(harness) || a.binding.executionCheckout !== cwd
        || session!.authorityId !== activationInput.source.authorityId || sessionHarness(session!) !== harness
        || session!.cwd !== cwd || session!.lastRunId !== null || meta.runs.some(row => row.sessionId === conversationId)
        || canonicalJSON({ saneExecution: session!.saneExecution, saneContext: session!.saneContext }) !== canonicalJSON(activationInput.activation)) throw new UserInputPreparationError("Activation journal has no exact ready original native admission and pinned pair", 409);
      pendingActivations.assertCurrent(activationPreparation, activationInput);
    };
    const messageIntent: BridgeMessageIntent | undefined = options.messageIntent ?? (activationPreparation || upgradeContext ? {
      kind: upgradeContext ? "assistant-upgrade" : "assistant-activation",
      source: activationPreparation ? `app:${store.manifest.storeId}/activation-run:${activationPreparation.runId}` : `app:${store.manifest.storeId}/prepared-upgrade:${run.runId}`,
      assertCurrent: () => {
        assertPreparedUserInputCurrent(prepared, preparationState(), installedSnapshot);
        if (run.runId !== runId || !meta.runs.includes(run) || !configured.saneExecution || !configured.saneContext?.package) throw new UserInputPreparationError("Original canonical activation intent is unavailable", 409);
      },
    } : undefined);    // Capture only user-origin input before role/context expansion.
    // Other dispatch origins and inherited/attached sessions remain ineligible.
    if ((origin === "user" || origin === "queued-user") && session.titleAutoEligible && session.agentKind !== "worker" && !session.attachment) namingSubmissions.set(run, namingText);
    const lifecycle = executePrompt(lease, session, run, prepared.prompt, prepared.resume, origin, {
      requestId: intent.requestId,
      coordinatorIntent: intent.kind,
      validate: () => { assertDispatch(); assertContext(); assertPreparedUserInputCurrent(prepared, preparationState(), createdSnapshot); },
      link: context?.link && (() => context.link!(identity)), evidence: context?.evidence, delivery,
      ...(nativeHandoff ? { nativeQueuedHandoff: identity } : {}), publish,
      messageIntent, submissionPublication: options.submissionPublication,
      ...(activationPreparation ? { activationPreparation: { preparation: activationPreparation, assertCurrent: assertActivationPreparation } } : {}),
      configure: () => {
        // A prepared dispatch owns execution configuration, not title metadata.
        // Never restore its earlier revision over a concurrent edit/generation.
        const executionConfiguration = { ...configured };
        for (const key of ["title", "titleSource", "titleRevision", "titleAutoEligible", "titleGeneration"] as const) delete executionConfiguration[key];
        Object.assign(session!, executionConfiguration);
        if (!("model" in configured)) delete session!.model;
        if (!("effort" in configured)) delete session!.effort;
        workerStore.suppress(conversationId, false);
        // Install accepts the user prompt. Capture the user-wait correlation and clear it here, not on read or open.
        if (origin === "user" || origin === "queued-user") {
          const accepted = workerStore.getBySession(conversationId);
          const correlationId = accepted?.protocol?.id === "explicit-v1" && accepted.wait?.reason === "user" ? accepted.wait.correlationId : undefined;
          if (correlationId) {
            workerStore.resolveAcceptedUserWait(conversationId, correlationId);
            workerCompletionRecovery?.notify(conversationId);
          }
        }
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
  // Request-local capabilities, never reconstructed from model input or a stored
  // run ID. Native continuation workers keep their exact App command ancestry
  // without reopening a completed Run or inventing a new submitted command.
  type WorkerContinuationAuthorization = {
    sessionId: string; runId: string; evidence: OpenCodeWorkerContinuation;
    validate(): void; refresh(): Promise<void>;
  };
  const qualifiedWorkerInvocations = new WeakMap<NativeWorkerInvocation, { admission: Admission; session: Session; starting: boolean; continuation?: WorkerContinuationAuthorization; grok?: ReturnType<typeof authorizeGrokInvocation> }>();
  const codeShares = new CodeShareStore(options.dataDir, store.manifest.storeId, error => failClosed(error, "code-share-storage"));
  const mediaShares = new MediaShareStore(options.dataDir, store.manifest.storeId, error => failClosed(error, "media-share-storage"));
  const browserPairs = new BrowserPairStore(options.dataDir, store.manifest.storeId, error => failClosed(error, "browser-pair-storage"));
  const resourcePairs = new ResourcePairStore(options.dataDir, store.manifest.storeId, browserPairs, error => failClosed(error, "resource-pair-storage"));
  // Shared admission fence for both APIs. Removal never requires the linked
  // conversation to remain active, so stale links can still be removed.
  function assertPairConversation(input: { operation: "clear" } | { operation: "add" | "replace" | "remove"; session: PairSession }, PairError: typeof ResourcePairError | typeof BrowserPairError) {
    if (input.operation === "remove" || input.operation === "clear") return;
    const prefix = PairError === BrowserPairError ? "browser-pair" : "resource-pair";
    const expected = input.session, session = meta.sessions.find(session => session.sessionId === expected.sessionId);
    if (!session || !sameBrowserPairSession(expected, { sessionId: session.sessionId, harness: pairSessionHarness(session), authorityId: session.authorityId ?? "", nativeSessionId: session.nativeSessionId ?? "" })) throw new PairError(409, `${prefix}-identity`, "Conversation identity changed; reconnect before pairing");
    assertCatalogActive(session);
    if (session.agentKind === "worker" || workerStore.hasSession(session.sessionId) || session.attachment?.state === "pending"
      || branches.replaced(session.sessionId) || branches.pending(session.sessionId) || catalog.association(session.sessionId).association !== "resolved"
      || session.authorityId !== nativeSource(session.harness)) throw new PairError(409, `${prefix}-unavailable`, `This conversation is unavailable for ${PairError === BrowserPairError ? "browser" : "resource"} pairing`);
  }
  async function resourcePairTargetFence(target: PairTarget, requireFile: boolean): Promise<() => void> {
    if (target.kind === "browser") return () => {
      if (!catalog.workspaceName(target.workspaceId)) throw new ResourcePairError(404, "resource-pair-workspace", "Unknown browser workspace");
    };
    // Selection metadata plus synchronous catalog inode pins: unlike binding(),
    // this passive operation does not run Git discovery or read file contents.
    const workspace = await catalog.registered(target.workspaceId);
    return resourcePairFileTargetFence(target, workspace, requireFile);
  }
  function resourcePairFileTargetFence(target: Extract<PairTarget, { kind: "file" }>, workspace: Awaited<ReturnType<CatalogService["registered"]>>, requireFile: boolean): () => void {
    const tree = workspace.worktrees.find(tree => tree.worktreeId === target.worktreeId);
    if (!tree) throw new ResourcePairError(404, "resource-pair-worktree", "Unknown file worktree");
    const { root, bindingRevision } = tree;
    const inside = (parent: string, child: string) => { const path = relative(parent, child); return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`); };
    const check = () => {
      catalog.assertBinding(target.workspaceId, target.worktreeId, root, bindingRevision);
      const data = realpathSync(options.dataDir), path = join(root, target.path);
      const protectedPaths = [data, workspace.commonDir, tree.gitDir, ...domainProtectedPaths].filter((path): path is string => !!path);
      if (root.split(sep).some(part => [".git", ".sane"].includes(part.toLowerCase())) || !inside(root, path)
        || protectedPaths.some(protectedPath => inside(protectedPath, root) || inside(protectedPath, path))) throw new ResourcePairError(403, "resource-pair-path", "File path is not accessible");
      if (!requireFile) return;
      let cursor = root;
      try {
        const parts = target.path.split("/");
        for (let i = 0; i < parts.length; i++) {
          cursor = join(cursor, parts[i]!);
          const info = lstatSync(cursor);
          if (info.isSymbolicLink() || realpathSync(cursor) !== cursor || (i < parts.length - 1 ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) throw new ResourcePairError(403, "resource-pair-file", "Pair an existing regular worktree file without symlink or hardlink traversal");
        }
      } catch (error) {
        if (error instanceof ResourcePairError) throw error;
        throw new ResourcePairError(409, "resource-pair-file", "File is unavailable; reopen it before pairing");
      }
    };
    check();
    return check;
  }
  function codeShareSession(request: Pick<NativeCodeShareRequest, "caller">, deny: () => never = denyCodeShareIdentity) {
    let source;
    try { source = normalizeNativeSource(request.caller.source); } catch { return deny(); }
    const caller = request.caller;
    if (source.authorityId !== caller.authorityId) return deny();
    const admission = admissions.getByNative({ harness: source.descriptor.harness, authorityId: source.authorityId, nativeId: caller.nativeId });
    const session = admission && meta.sessions.find(s => s.sessionId === admission.sessionId);
    if (!admission || admission.state !== "ready" || !session || retirementPaused(session.sessionId) || session.hidden || session.attachment
      || session.nativeSessionId !== caller.nativeId || session.authorityId !== caller.authorityId
      || session.harness !== toSessionHarness(source.descriptor.harness)
      || session.cwd !== admission.binding.executionCheckout || !matchesNativeCallerCwd(source.descriptor.harness, session.cwd, caller.cwd)
      || canonicalJSON(admission.source) !== canonicalJSON(source)) return deny();
    return session.sessionId;
  }
  // SANE state belongs to the repository's primary checkout, even when the
  // admitted conversation executes in a linked worktree. Discovery is read-only
  // and does not require an initialized domain or workstream enrollment.
  const codeShareState = new WorkspaceService(async key => {
    const [workspaceId, worktreeId] = key.split("/");
    const binding = await catalog.binding(workspaceId!, worktreeId!);
    let cwd = binding.cwd;
    if (binding.protectedPaths.length) {
      const discovery = discoverRepository(cwd);
      if (discovery.commonDir !== binding.protectedPaths[0]) throw new WorkspaceError(409, "binding-invalid", "Code share repository binding changed");
      cwd = discovery.primaryCheckout;
    }
    return { ...binding, cwd, protectedPaths: [...binding.protectedPaths, ...domainProtectedPaths] };
  }, options.dataDir);
  const codeShareFiles: Pick<WorkspaceService, "file"> = {
    file: (key, revision, path) => path.startsWith(".sane/") ? codeShareState.codeShareFile(key, revision, path) : worktrees.file(key, revision, path),
  };
  // Code and media share exactly the same admission and native-turn fences,
  // while their tool names and parsers remain separate evidence authorities.
  async function authorizeFileShare(kind: "code" | "media", request: NativeCodeShareRequest | NativeMediaShareRequest,
    old?: Pick<CodeShareRecord, "sessionId" | "workspaceId" | "worktreeId" | "bindingRevision" | "anchor">) {
    const deny = kind === "code" ? denyCodeShareIdentity : denyMediaShareIdentity;
    const matchesTool = kind === "code" ? matchesCodeShareTool : matchesMediaShareTool;
    const matchesPart = kind === "code" ? matchesCodeSharePart : matchesMediaSharePart;
    const readContinuation = kind === "code" ? readCodeShareContinuation : readMediaShareContinuation;
    const sessionId = codeShareSession(request, deny), session = meta.sessions.find(s => s.sessionId === sessionId)!;
    const grok = request.caller.source.harness === "gk" ? authorizeGrokInvocation(request.caller, kind === "code" ? "sane_share_code" : "sane_share_media", request.input,
      { toolCallId: request.invocation.toolCallId, messageId: request.invocation.messageId, wrapper: request.invocation.wrapper }) : undefined;
    const admission = admissions.get(sessionId)!, binding = admission.binding, admissionPin = JSON.stringify(admission), sessionPin = dispatchSnapshot(session);
    const owner = owners.get(sessionId), protectionPin = JSON.stringify(domainProtectedPaths);
    const available = () => {
      grok?.assertCurrent();
      if (!startupReady || closing || storageFailed || retainOwner || !ownsStorage() || meta.reconciliationRequired) return deny();
      if (codeShareSession(request, deny) !== sessionId || JSON.stringify(admissions.get(sessionId)) !== admissionPin || dispatchSnapshot(session) !== sessionPin
        || meta.sessions.find(s => s.sessionId === sessionId) !== session || branches.pending(sessionId) || branches.replaced(sessionId)) return deny();
    };
    available();
    if (old) {
      if (old.sessionId !== sessionId || old.workspaceId !== binding.workspaceId || old.worktreeId !== binding.worktreeId || old.bindingRevision !== binding.bindingRevision
        || grok && old.anchor.runId !== grok.binding.runId
        || !meta.runs.some(run => run.sessionId === sessionId && run.runId === old.anchor.runId && run.cwd === binding.executionCheckout && run.operation !== "compact")) return deny();
      return { sessionId, runId: old.anchor.runId, workspaceId: old.workspaceId, worktreeId: old.worktreeId, bindingRevision: old.bindingRevision, assertCurrent: available };
    }
    const current = () => {
      available();
      if (owners.get(sessionId) !== owner || owner && (owner.settled || owner.stopRequested || owner.cancelling || owner.run.status !== "running" || owner.run.operation === "compact")
        || !owner && (admitting.has(sessionId) || lifecycleReserved(sessionId)) || coordinator.hasReconciliation(sessionId) || recoveredInputConversations.has(sessionId)
        || JSON.stringify(domainProtectedPaths) !== protectionPin) return deny();
    };
    let run = owner?.run;
    let refresh: (() => Promise<void>) | undefined;
    if (owner && run && run.cwd === binding.executionCheckout) {
      let evidenced = false;
      for (let attempt = 0; attempt < 3 && !evidenced; attempt++) {
        current();
        if (request.caller.source.harness === "cc") {
          evidenced = journalEvents(run.runId).some(event => {
            const data = event.data as any;
            if (event.kind === "hook") return data?.event === "PreToolUse" && isClaudeRootRecord(data.payload) && data.payload?.session_id === request.caller.nativeId && (!request.invocation.messageId || data.payload?.message_id === request.invocation.messageId) && data.payload?.tool_use_id === request.invocation.toolCallId && matchesTool(request, data.payload?.tool_name, data.payload?.tool_input);
            return event.kind === "stdout" && isClaudeRootRecord(data) && data?.type === "assistant" && data.session_id === request.caller.nativeId && (!request.invocation.messageId || data.message?.id === request.invocation.messageId) && Array.isArray(data.message?.content) && data.message.content.some((part: any) => part.type === "tool_use" && part.id === request.invocation.toolCallId && matchesTool(request, part.name, part.input));
          });
        } else if (request.caller.source.harness === "gk") {
          grok!.assertCurrent();
          evidenced = grok!.owner === owner && grok!.binding.appSessionId === sessionId && grok!.binding.runId === run.runId;
        } else if (request.caller.source.harness === "oc" && run.nativeCommandId && run.nativePhase === "accepted") {
          const snapshot = await oc.snapshot(request.caller.nativeId, run.nativeCommandId, session.cwd);
          current();
          const target = snapshot.messages.findLast(message => message.type === "assistant");
          evidenced = !snapshot.boundary && !snapshot.pending && !snapshot.outcome && snapshot.currentInputId === run.nativeCommandId
            && !!target && target.time.completed === undefined && !!target.content?.some(part => matchesPart(request, target.id, part));
          if (evidenced) {
            const commandId = run.nativeCommandId;
            refresh = async () => {
              current();
              const fresh = await oc.snapshot(request.caller.nativeId, commandId, session.cwd);
              current();
              const assistant = fresh.messages.findLast(message => message.type === "assistant");
              if (fresh.boundary || fresh.pending || fresh.outcome || fresh.currentInputId !== commandId || !assistant || assistant.time.completed !== undefined
                || !assistant.content?.some(part => matchesPart(request, assistant.id, part))) return deny();
            };
          }
        }
        if (!evidenced && attempt < 2) await Bun.sleep(150);
      }
      if (!evidenced) run = undefined;
    } else run = undefined;
    if (!run && request.caller.source.harness === "oc") {
      current();
      const read = async () => {
        for (let attempt = 0; ; attempt++) {
          try { return await readContinuation(oc, request, current); }
          catch (error) { if (!(error instanceof CodeShareError || error instanceof MediaShareError) || error.status !== 409 || attempt >= 2) throw error; await Bun.sleep(150); }
        }
      };
      const evidence = await read();
      current();
      const matches = meta.runs.filter(candidate => candidate.sessionId === sessionId && candidate.nativeCommandId === evidence.commandId);
      if (matches.length !== 1) return deny();
      run = matches[0]!;
      if (run.cwd !== session.cwd || run.operation === "compact" || run.nativePhase !== "accepted" || (owner ? owner.run !== run : run.status !== "completed" || !evidence.afterIdle)) return deny();
      refresh = async () => { if (JSON.stringify(await read()) !== JSON.stringify(evidence)) return deny(); };
    }
    if (!run) return deny();
    const boundRun = run, runPin = JSON.stringify(run);
    await catalog.binding(binding.workspaceId, binding.worktreeId);
    current();
    const assertCurrent = () => {
      current();
      if (!meta.runs.includes(boundRun) || JSON.stringify(boundRun) !== runPin) return deny();
      catalog.assertBinding(binding.workspaceId, binding.worktreeId, binding.executionCheckout, binding.bindingRevision);
    };
    assertCurrent();
    return { sessionId, runId: run.runId, workspaceId: binding.workspaceId, worktreeId: binding.worktreeId, bindingRevision: binding.bindingRevision, assertCurrent, refresh };
  }
  const codeShareService = new CodeShareService(codeShares, codeShareFiles, codeShareSession, (request, old) => authorizeFileShare("code", request, old));
  const mediaShareService = new MediaShareService(mediaShares, worktrees, request => codeShareSession(request, denyMediaShareIdentity), (request, old) => authorizeFileShare("media", request, old));
  async function nativeCodeShare(req: Request) {
    const denied = requireNativeBearer(req, handoffToken) ?? requireStartupReady(startupReady);
    if (denied) return denied;
    try { return json(await grokRequestProof.run(req.headers.get(GROK_RUNTIME_HEADER) ?? undefined, () => codeShareService.handle(req))); }
    catch (error) {
      if (error instanceof CodeShareError || error instanceof WorkspaceError) return json({ error: error.message, code: error.code }, error.status);
      if (error instanceof OpenCodeError) return json({ error: error.message, code: "code-share-native-evidence" }, error.status);
      return json({ error: "Code share authorization or storage unavailable", code: "code-share-unavailable" }, 503);
    }
  }
  async function nativeMediaShare(req: Request) {
    const denied = requireNativeBearer(req, handoffToken) ?? requireStartupReady(startupReady);
    if (denied) return denied;
    if (closing || storageFailed) return json({ error: "App execution owner unavailable" }, 503);
    const task = Promise.withResolvers<void>();
    attachmentTasks.add(task.promise);
    try { return json(await grokRequestProof.run(req.headers.get(GROK_RUNTIME_HEADER) ?? undefined, () => mediaShareService.handle(req))); }
    catch (error) {
      if (error instanceof MediaShareError || error instanceof WorkspaceError) return json({ error: error.message, code: error.code }, error.status);
      if (error instanceof OpenCodeError) return json({ error: error.message, code: "media-share-native-evidence" }, error.status);
      return json({ error: "Media share authorization or storage unavailable", code: "media-share-unavailable" }, 503);
    }
    finally { task.resolve(); attachmentTasks.delete(task.promise); }
  }
  const userQuestions = new UserQuestionsStore(options.dataDir, store.manifest.storeId, error => failClosed(error, "user-questions-storage"));
  userQuestions.recover();
  const userQuestionsSession = (request: Pick<NativeCodeShareRequest, "caller">) => codeShareSession(request, denyUserQuestionsIdentity);
  const userQuestionsService = new UserQuestionsService(userQuestions, userQuestionsSession, async (request, old) => {
    const sessionId = userQuestionsSession(request), session = meta.sessions.find(s => s.sessionId === sessionId)!;
    if (session.agentKind === "worker") return denyUserQuestionsIdentity();
    const grok = request.caller.source.harness === "gk" ? authorizeGrokInvocation(request.caller, "present_questions_to_user", request.input,
      { toolCallId: request.invocation.toolCallId, messageId: request.invocation.messageId, wrapper: request.invocation.wrapper }) : undefined;
    const admission = admissions.get(sessionId)!, binding = admission.binding;
    const admissionPin = JSON.stringify(admission), sessionPin = dispatchSnapshot(session), owner = owners.get(sessionId);
    const available = () => {
      grok?.assertCurrent();
      if (!startupReady || closing || storageFailed || retainOwner || !ownsStorage() || meta.reconciliationRequired) return denyUserQuestionsIdentity();
      if (userQuestionsSession(request) !== sessionId || JSON.stringify(admissions.get(sessionId)) !== admissionPin
        || dispatchSnapshot(session) !== sessionPin || meta.sessions.find(s => s.sessionId === sessionId) !== session
        || branches.pending(sessionId) || branches.replaced(sessionId)) return denyUserQuestionsIdentity();
    };
    const identity = (runId: string) => ({ sessionId, native: { harness: request.caller.source.harness, authorityId: request.caller.authorityId, nativeId: request.caller.nativeId },
      anchor: { runId, toolCallId: request.invocation.toolCallId, messageId: request.invocation.messageId ?? null, invocationId: request.invocation.invocationId, wrapper: request.invocation.wrapper ?? null },
      workspaceId: binding.workspaceId, worktreeId: binding.worktreeId, bindingRevision: binding.bindingRevision, cwd: binding.executionCheckout });
    available();
    if (old) {
      if (old.sessionId !== sessionId || old.workspaceId !== binding.workspaceId || old.worktreeId !== binding.worktreeId
        || grok && old.anchor.runId !== grok.binding.runId
        || old.bindingRevision !== binding.bindingRevision || old.cwd !== binding.executionCheckout
        || !meta.runs.some(run => run.sessionId === sessionId && run.runId === old.anchor.runId && run.cwd === old.cwd && run.operation !== "compact")) return denyUserQuestionsIdentity();
      return { identity: identity(old.anchor.runId), assertCurrent: available };
    }
    const current = () => {
      available();
      if (owners.get(sessionId) !== owner || owner && (owner.settled || owner.stopRequested || owner.cancelling || owner.run.status !== "running" || owner.run.operation === "compact")
        || !owner && (admitting.has(sessionId) || lifecycleReserved(sessionId)) || coordinator.hasReconciliation(sessionId) || recoveredInputConversations.has(sessionId)) return denyUserQuestionsIdentity();
    };
    let run = owner?.run, refresh: (() => Promise<void>) | undefined;
    if (owner && run && run.cwd === binding.executionCheckout) {
      let evidenced = false;
      for (let attempt = 0; attempt < 3 && !evidenced; attempt++) {
        current();
        if (request.caller.source.harness === "cc") {
          evidenced = journalEvents(run.runId).some(event => {
            const data = event.data as any;
            if (event.kind === "hook") return data?.event === "PreToolUse" && isClaudeRootRecord(data.payload)
              && data.payload?.session_id === request.caller.nativeId && (!request.invocation.messageId || data.payload?.message_id === request.invocation.messageId)
              && data.payload?.tool_use_id === request.invocation.toolCallId && matchesUserQuestionsTool(request, data.payload?.tool_name, data.payload?.tool_input);
            return event.kind === "stdout" && isClaudeRootRecord(data) && data?.type === "assistant" && data.session_id === request.caller.nativeId
              && (!request.invocation.messageId || data.message?.id === request.invocation.messageId) && Array.isArray(data.message?.content)
              && data.message.content.some((part: any) => part.type === "tool_use" && part.id === request.invocation.toolCallId && matchesUserQuestionsTool(request, part.name, part.input));
          });
        } else if (request.caller.source.harness === "gk") {
          grok!.assertCurrent();
          evidenced = grok!.owner === owner && grok!.binding.appSessionId === sessionId && grok!.binding.runId === run.runId;
        } else if (request.caller.source.harness === "oc" && run.nativeCommandId && run.nativePhase === "accepted") {
          const commandId = run.nativeCommandId;
          const snapshot = await oc.snapshot(request.caller.nativeId, commandId, session.cwd);
          current();
          const target = snapshot.messages.findLast(message => message.type === "assistant");
          evidenced = !snapshot.boundary && !snapshot.pending && !snapshot.outcome && snapshot.currentInputId === commandId
            && !!target && target.time.completed === undefined && !!target.content?.some(part => matchesUserQuestionsPart(request, target.id, part));
          if (evidenced) refresh = async () => {
            current();
            const fresh = await oc.snapshot(request.caller.nativeId, commandId, session.cwd);
            current();
            const assistant = fresh.messages.findLast(message => message.type === "assistant");
            if (fresh.boundary || fresh.pending || fresh.outcome || fresh.currentInputId !== commandId || !assistant || assistant.time.completed !== undefined
              || !assistant.content?.some(part => matchesUserQuestionsPart(request, assistant.id, part))) return denyUserQuestionsIdentity();
          };
        }
        if (!evidenced && attempt < 2) await Bun.sleep(150);
      }
      if (!evidenced) run = undefined;
    } else run = undefined;
    if (!run && request.caller.source.harness === "oc") {
      current();
      const read = async () => {
        for (let attempt = 0; ; attempt++) {
          try { return await readUserQuestionsContinuation(oc, request, current); }
          catch (error) { if (!(error instanceof UserQuestionsError) || error.status !== 409 || attempt >= 2) throw error; await Bun.sleep(150); }
        }
      };
      const evidence = await read();
      current();
      const matches = meta.runs.filter(candidate => candidate.sessionId === sessionId && candidate.nativeCommandId === evidence.commandId);
      if (matches.length !== 1) return denyUserQuestionsIdentity();
      run = matches[0]!;
      if (run.cwd !== session.cwd || run.operation === "compact" || run.nativePhase !== "accepted" || (owner ? owner.run !== run : run.status !== "completed" || !evidence.afterIdle)) return denyUserQuestionsIdentity();
      refresh = async () => { if (JSON.stringify(await read()) !== JSON.stringify(evidence)) return denyUserQuestionsIdentity(); };
    }
    if (!run) return denyUserQuestionsIdentity();
    const boundRun = run, runPin = JSON.stringify(run);
    await catalog.binding(binding.workspaceId, binding.worktreeId);
    const assertCurrent = () => {
      current();
      if (!meta.runs.includes(boundRun) || JSON.stringify(boundRun) !== runPin) return denyUserQuestionsIdentity();
      catalog.assertBinding(binding.workspaceId, binding.worktreeId, binding.executionCheckout, binding.bindingRevision);
    };
    assertCurrent();
    return { identity: identity(run.runId), assertCurrent, refresh };
  });
  async function nativeUserQuestions(req: Request) {
    const denied = requireNativeBearer(req, handoffToken) ?? requireStartupReady(startupReady);
    if (denied) return denied;
    try { return json(await grokRequestProof.run(req.headers.get(GROK_RUNTIME_HEADER) ?? undefined, () => userQuestionsService.handle(req))); }
    catch (error) {
      if (error instanceof UserQuestionsError || error instanceof CodeShareError || error instanceof WorkspaceError) return json({ error: error.message, code: error.code }, error.status);
      if (error instanceof OpenCodeError) return json({ error: error.message, code: "user-questions-native-evidence" }, error.status);
      return json({ error: "Questions authorization or storage unavailable", code: "user-questions-unavailable" }, 503);
    }
  }
  function assertUserQuestionsRespondent(form: UserQuestionsRecord, req?: Request) {
    if (!startupReady || closing || storageFailed || retainOwner || !ownsStorage() || meta.reconciliationRequired)
      throw new UserQuestionsError(503, "user-questions-unavailable", "Question responses cannot be changed while App ownership is unavailable");
    if (req && !auth.authenticated(req)) throw new UserQuestionsError(401, "authentication-required", "Authentication required");
    const session = meta.sessions.find(s => s.sessionId === form.sessionId), admission = admissions.get(form.sessionId);
    if (retirementPaused(form.sessionId)) throw new UserQuestionsError(409, "session-retired", "Conversation is retired or a catalog operation is pending; restore it before responding");
    if (!session || session.hidden || session.attachment || session.agentKind === "worker" || branches.pending(form.sessionId) || branches.replaced(form.sessionId)
      || session.nativeSessionId !== form.native.nativeId || session.authorityId !== form.native.authorityId || session.cwd !== form.cwd
      || sessionHarness(session) !== toSessionHarness(form.native.harness)
      || nativeSource(session.harness) !== form.native.authorityId
      || !admission || admission.state !== "ready" || admission.nativeId !== form.native.nativeId || admission.source.authorityId !== form.native.authorityId
      || admission.binding.workspaceId !== form.workspaceId || admission.binding.worktreeId !== form.worktreeId
      || admission.binding.executionCheckout !== form.cwd || admission.binding.bindingRevision !== form.bindingRevision)
      throw new UserQuestionsError(409, "user-questions-read-only", "This form's original conversation is unavailable or read-only");
    catalog.assertBinding(form.workspaceId, form.worktreeId, form.cwd, form.bindingRevision);
  }
  const continuationParents = new WeakMap<WorkerParent, () => void>();
  const resolveTrustedWorkerInvocation: NativeWorkerCallerResolver = async (request, context) => {
    const reject = (): never => { throw new NativeWorkerRequestError(409, "worker-identity", "Worker invocation is not evidenced in its App-owned run. Ensure this conversation is repository-enrolled and retry only the same native tool invocation after its tool evidence is persisted."); };
    context.assertActive();
    const e = request.caller, source = normalizeNativeSource(e.source);
    if (source.authorityId !== e.authorityId) reject();
    const admission = admissions.getByNative({ harness: e.source.harness, authorityId: source.authorityId, nativeId: e.nativeId });
    if (!admission || admission.state !== "ready" || admission.binding.domain.mode !== "repository" || admission.binding.domain.primaryCheckout !== e.repository) return reject();
    const session = meta.sessions.find(s => s.sessionId === admission.sessionId && !s.attachment);
    if (!session) return reject();
    assertCatalogActive(session);
    if (branches.pending(session.sessionId) || branches.replaced(session.sessionId)) return reject();
    qualifiedWorkerInvocations.set(request.invocation, { admission, session, starting: request.operation === "start" });
    const owner = owners.get(session.sessionId);
    let grok: ReturnType<typeof authorizeGrokInvocation> | undefined;
    if (e.source.harness === "gk") {
      try {
        grok = authorizeGrokInvocation(e, `sane_worker_${request.operation}`, request.input, request.invocation);
        if (grok.session !== session || grok.owner !== owner || request.invocation.opencode) return reject();
        qualifiedWorkerInvocations.get(request.invocation)!.grok = grok;
      } catch { return reject(); }
    }
    const old = request.operation === "start" ? workerStore.getByRequest(session.sessionId, request.input.requestId) : undefined;
    // A durable reservation is the original binding, even after parent completion.
    if (old && request.operation === "start") {
      if (grok && old.parent.runId !== grok.binding.runId) return reject();
      if (old.parent.native.harness !== e.source.harness || old.parent.native.authorityId !== e.authorityId || old.parent.native.nativeId !== e.nativeId || old.parent.toolCallId !== request.invocation.toolCallId || old.input.worker !== request.input.worker || old.input.prompt !== request.input.prompt || old.input.context !== request.input.context || old.input.subject !== request.input.subject || JSON.stringify(old.input.jobs) !== JSON.stringify(request.input.jobs)) return reject();
      if (JSON.stringify(old.parent.invocation?.opencode) !== JSON.stringify(request.invocation.opencode)) return reject();
      const invocation = old.parent.invocation ?? request.invocation;
      qualifiedWorkerInvocations.set(invocation, qualifiedWorkerInvocations.get(request.invocation)!);
      return { sessionId: session.sessionId, caller: { envelope: e, runId: old.parent.runId, toolCallId: old.parent.toolCallId, invocation } };
    }
    const current = () => {
      context.assertActive();
      grok?.assertCurrent();
      if (!owner || owners.get(session.sessionId) !== owner || owner.settled || owner.stopRequested || owner.cancelling || owner.run.status !== "running" || owner.run.operation === "compact" || closing || storageFailed) reject();
    };
    if (owner || e.source.harness !== "oc") current();
    let run = owner?.run;
    const name = `sane_worker_${request.operation}`;
    const matchesName = (value: unknown) => value === name || e.source.harness === "cc" && value === `mcp__sane__${name}`;
    let evidenced = false;
    for (let attempt = 0; run && attempt < 3 && !evidenced; attempt++) {
      current();
      if (e.source.harness === "cc") {
        evidenced = (journalEvents(run.runId)).some(event => {
          const data = event.data as any;
          if (event.kind === "hook") return data?.event === "PreToolUse" && isClaudeRootRecord(data.payload) && data.payload?.session_id === e.nativeId && data.payload?.tool_use_id === request.invocation.toolCallId && matchesName(data.payload?.tool_name);
          return event.kind === "stdout" && isClaudeRootRecord(data) && data?.type === "assistant" && data.session_id === e.nativeId && Array.isArray(data.message?.content) && data.message.content.some((part: any) => part.type === "tool_use" && part.id === request.invocation.toolCallId && matchesName(part.name));
        });
      } else if (e.source.harness === "gk") {
        grok!.assertCurrent();
        evidenced = grok!.binding.runId === run.runId && grok!.owner === owner;
      } else if (e.source.harness === "oc") {
        if (!run.nativeCommandId) return reject();
        // The run journal already contains command-bounded native observations.
        // Fetch another snapshot only when the tool part has not reached it yet.
        const observed = journalEvents(run.runId).findLast(event => event.kind === "message" && (event.data as MessageSnapshot)?.messageId === request.invocation.messageId)?.data as MessageSnapshot | undefined;
        evidenced = observed?.role === "assistant" && observed.parts.some(part => matchesOpenCodeWorkerPart(request.operation, request.invocation, observed.messageId, part));
        if (!evidenced) {
          const snapshot = await oc.snapshot(e.nativeId, run.nativeCommandId, session.cwd);
          current();
          evidenced = snapshot.messages.some(message => message.type === "assistant" && message.content?.some(part => matchesOpenCodeWorkerPart(request.operation, request.invocation, message.id, part)));
        }
      }
      if (!evidenced && attempt < 2) await Bun.sleep(150);
    }
    if (grok && evidenced && request.operation === "start") {
      const runtimeCapabilities = proveInstalledGrokWorkerRuntime({ bindingDirectory: grokBindingDirectory, appConnectionFile: join(options.dataDir, "native-handoff.json") });
      if (!runtimeCapabilities) return reject();
      await emit(grok.owner.run, "context", { type: "grok-native-worker-invocation", toolName: "sane_worker_start", toolCallId: request.invocation.toolCallId,
        runId: grok.binding.runId, source: grok.owner.contextIdentity!.source, bindingId: grok.binding.bindingId,
        inputDigest: grok.binding.proof.inputDigest, runtimeCapabilities: [...runtimeCapabilities] });
      current();
    }
    if (!evidenced && e.source.harness === "oc") {
      const pin = dispatchSnapshot(session), admissionPin = JSON.stringify(admission);
      const validate = () => {
        context.assertActive();
        assertDispatchSnapshot(session.sessionId, pin);
        if (closing || storageFailed || meta.reconciliationRequired || session.hidden || session.attachment
          || JSON.stringify(admissions.get(session.sessionId)) !== admissionPin
          || owners.get(session.sessionId) !== owner || owner && (owner.settled || owner.stopRequested || owner.cancelling || owner.run.status !== "running" || owner.run.operation === "compact")
          || workerStore.suppressed(session.sessionId) || branches.pending(session.sessionId) || branches.replaced(session.sessionId)
          || admitting.has(session.sessionId) || coordinator.hasReconciliation(session.sessionId) || recoveredInputConversations.has(session.sessionId)
          || lifecycleReserved(session.sessionId)) return reject();
      };
      const read = async () => {
        // As with the owned-command path, allow native tool persistence to catch
        // up with the authenticated plugin callback. Never resend the tool.
        for (let attempt = 0; ; attempt++) {
          try { return await readOpenCodeWorkerContinuation(oc, e.nativeId, session.cwd, request.operation, request.invocation, validate); }
          catch (error) {
            if (!(error instanceof OpenCodeError) || error.status !== 409) throw error;
            if (attempt === 2) return reject();
            await Bun.sleep(150);
          }
        }
      };
      const evidence = await read();
      validate();
      const matches = meta.runs.filter(candidate => candidate.sessionId === session.sessionId && candidate.nativeCommandId === evidence.commandId);
      if (matches.length !== 1) return reject();
      run = matches[0]!;
      if (run.operation === "compact" || run.cwd !== session.cwd || run.nativePhase !== "accepted"
        || (owner ? owner.run !== run : run.status !== "completed" || !evidence.afterIdle)) return reject();
      const boundRun = run, runPin = JSON.stringify(run);
      const authorization: WorkerContinuationAuthorization = {
        sessionId: session.sessionId, runId: run.runId, evidence,
        validate() {
          validate();
          if (!meta.runs.includes(boundRun) || JSON.stringify(boundRun) !== runPin) return reject();
        },
        async refresh() {
          this.validate();
          const fresh = await read();
          this.validate();
          if (JSON.stringify(fresh) !== JSON.stringify(evidence)) return reject();
        },
      };
      authorization.validate();
      qualifiedWorkerInvocations.get(request.invocation)!.continuation = authorization;
    } else {
      current();
      if (!evidenced) return reject();
    }
    if (!run) return reject();
    return { sessionId: session.sessionId, caller: { envelope: e, runId: run.runId, toolCallId: request.invocation.toolCallId, invocation: request.invocation } };
  };
  const failWorkerBeforeSubmit = (workerId: string, summary: string) => {
    workerStore.update(workerId, { state: "failed", error: summary, outcome: { status: "failed", at: new Date().toISOString(), summary, log: null }, notification: { id: `worker-outcome:${workerId}`, state: "pending" } });
  };
  const messageGrant = (permissions: { action?: unknown; effect?: unknown; resource?: unknown }[]) => permissions.some(rule => rule.action === "sane_worker_message" && rule.effect === "allow" && rule.resource === "*") && openCodePermissionAllows(permissions, "sane_worker_message");
  /** Journal decisions are authoritative. Only ordinary OC parents need native
   * permission proof instead of canonical role context or Claude launch settings. */
  const parentCanMessage = async (worker: WorkerRecord): Promise<boolean> => {
    const records = journalEvents(worker.parent.runId);
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const event = records[index]!;
      if (event.kind === "context" && event.data && typeof event.data === "object") {
        const data = event.data as { type?: unknown; configuration?: { permissions?: { action?: unknown; effect?: unknown; resource?: unknown }[] } };
        if (data.type === "canonical-execution" && Array.isArray(data.configuration?.permissions)) return messageGrant(data.configuration.permissions);
      }
      if (event.kind !== "launch" || !event.data || typeof event.data !== "object") continue;
      const settings = (event.data as { settings?: { path?: unknown; sha256?: unknown } }).settings;
      if (!settings || typeof settings.path !== "string" || typeof settings.sha256 !== "string") continue;
      try {
        const text = await readFile(settings.path, "utf8");
        if (createHash("sha256").update(text).digest("hex") !== settings.sha256) return false;
        const parsed = JSON.parse(text) as { permissions?: { allow?: unknown; ask?: unknown; deny?: unknown } };
        const permissions = parsed.permissions;
        if (!permissions || [permissions.allow, permissions.ask, permissions.deny].some(rules => rules !== undefined && (!Array.isArray(rules) || rules.some(rule => typeof rule !== "string")))) return false;
        const matches = (rules: unknown) => Array.isArray(rules) && rules.some(rule => permissionPatternMatches(rule, "mcp__sane__sane_worker_message"));
        return matches(permissions.allow) && !matches(permissions.deny) && !matches(permissions.ask);
      } catch { return false; }
    }
    const parent = worker.parent, invocation = parent.invocation;
    const session = meta.sessions.find(s => s.sessionId === parent.sessionId);
    const run = meta.runs.find(r => r.runId === parent.runId && r.sessionId === parent.sessionId);
    const admission = admissions.get(parent.sessionId);
    if (parent.native.harness === "gk") {
      const tools = proveInstalledGrokWorkerRuntime({ bindingDirectory: grokBindingDirectory, appConnectionFile: join(options.dataDir, "native-handoff.json") });
      if (!tools?.includes("sane_worker_message") || !session || !run || !admission || !invocation
        || invocation.toolCallId !== parent.toolCallId || invocation.messageId || invocation.opencode
        || session.harness !== "grok" || session.attachment || run.operation === "compact"
        || session.nativeSessionId !== parent.native.nativeId || session.authorityId !== parent.native.authorityId
        || nativeSource("grok") !== parent.native.authorityId || admission.state !== "ready" || admission.source.descriptor.harness !== "gk"
        || admission.nativeId !== parent.native.nativeId || admission.source.authorityId !== parent.native.authorityId
        || admission.binding.domain.mode !== "repository" || admission.binding.executionCheckout !== session.cwd
        || worker.checkout !== session.cwd || run.cwd !== session.cwd || branches.pending(parent.sessionId) || branches.replaced(parent.sessionId)) return false;
      return records.some(event => {
        const data = event.data as Record<string, any> | null;
        return event.kind === "context" && event.runId === run.runId && event.sessionId === session.sessionId
          && data?.type === "grok-native-worker-invocation" && data.toolName === "sane_worker_start" && data.toolCallId === parent.toolCallId
          && data.runId === run.runId && sameDispatchSource(data.source, dispatchSource(session))
          && data.inputDigest === grokRuntimeInputDigest("sane_worker_start", worker.input)
          && Array.isArray(data.runtimeCapabilities) && data.runtimeCapabilities.includes("sane_worker_message");
      });
    }
    if (parent.native.harness !== "oc" || !invocation || invocation.toolCallId !== parent.toolCallId || !session || !run || !admission
      || session.harness !== "opencode" || session.attachment || session.saneExecution || run.saneExecution || run.operation === "compact"
      || session.nativeSessionId !== parent.native.nativeId || session.authorityId !== parent.native.authorityId
      || nativeSource("opencode") !== parent.native.authorityId || admission.state !== "ready" || admission.binding.domain.mode !== "repository"
      || admission.source.descriptor.harness !== "oc" || admission.source.authorityId !== parent.native.authorityId || admission.nativeId !== parent.native.nativeId
      || admission.binding.executionCheckout !== session.cwd || run.cwd !== session.cwd || worker.checkout !== session.cwd) return false;
    const pin = dispatchSnapshot(session), admissionPin = JSON.stringify(admission);
    const current = () => !closing && !storageFailed && !meta.reconciliationRequired && meta.sessions.includes(session) && meta.runs.includes(run)
      && dispatchSnapshot(session) === pin && JSON.stringify(admissions.get(parent.sessionId)) === admissionPin
      && nativeSource("opencode") === parent.native.authorityId && !branches.pending(parent.sessionId) && !branches.replaced(parent.sessionId);
    try {
      if (!current()) return false;
      const allowed = await oc.parentCanMessageWorker(parent.native.nativeId, session.cwd, invocation);
      return current() && allowed;
    } catch { return false; }
  };
  const admitExplicitWorker = async (worker: WorkerRecord, pinned: { saneExecution?: CanonicalExecutionRef; saneContext?: SaneSessionContext }): Promise<{ pin?: WorkerProtocolPin; reject?: string }> => {
    const packageRef = pinned.saneContext?.package;
    const executionRevision = pinned.saneExecution?.revision;
    if (!packageRef || !executionRevision) return {};
    await contextPackages.load(packageRef);
    const childHarness = toNativeHarness(worker.launch.harness);
    const selected: SelectedNativeRuntime | undefined = options.nativeRuntime && options.nativeSources.oc.harness === "oc" ? { ...options.nativeRuntime,
      registrationFile: options.nativeSources.oc.registrationFile, appConnectionFile: join(options.dataDir, "native-handoff.json") } : undefined;
    const proveRuntime = async (harness: "cc" | "oc" | "gk", checkout: string) => {
      if (harness === "gk") return proveInstalledGrokWorkerRuntime({ bindingDirectory: grokBindingDirectory, appConnectionFile: join(options.dataDir, "native-handoff.json") });
      const tools = await proveInstalledExplicitWorkerRuntime(claudeRoot, harness, selected);
      if (tools && harness === "oc" && selected) await oc.assertSelectedWorkerRuntime(checkout, selected);
      return tools;
    };
    const tools = await proveRuntime(childHarness, worker.checkout);
    if (!tools) return { reject: "Explicit completion instructions are selected, but the worker's installed runtime is not proven. This launch was not submitted." };
    const parentCheckout = meta.sessions.find(session => session.sessionId === worker.parent.sessionId)?.cwd;
    if (!parentCheckout || worker.parent.native.harness !== childHarness && !await proveRuntime(worker.parent.native.harness, parentCheckout)) return { reject: "Explicit completion instructions are selected, but the parent's installed messaging runtime is not proven. This launch was not submitted." };
    if (!await parentCanMessage(worker)) return { reject: "Explicit completion instructions are selected, but the launching parent's messaging permission is not proven. This launch was not submitted." };
    const operations: WorkerProtocolOperation[] = ["complete"];
    if (worker.input.worker === "implementer" || worker.input.worker === "scout-crew" || worker.input.worker === "verification-crew") operations.push("notify", "message-parent");
    return { pin: { id: "explicit-v1", operations, executionRevision, contextRevision: packageRef.revision, runtimeCapabilities: [...tools] } };
  };
  const nativeTurnActive = (worker: { sessionId: string }) => owners.has(worker.sessionId) || workerStore.hasActiveDelivery(worker.sessionId) || workerStore.hasActiveExchange(worker.sessionId);
  async function workerOperational<T>(operation: () => T | Promise<T>): Promise<T> {
    try { return await operation(); }
    finally { workerCompletionRecovery?.notify(); }
  }
  const workerHandler = createNativeWorkerHandler({
    resolveCaller: resolveTrustedWorkerInvocation,
    nativeTurnActive,
    operations: {
      start: (caller, input, context) => workerOperational(() => workers.start(caller, input, () => context.assertActive())),
      status: (caller, ids, context) => { context.assertActive(); return workers.status(caller, ids); },
      acknowledge: (caller, refs, context) => { context.assertActive(); return workerOperational(() => workers.acknowledgeWait(caller, refs)); },
      cancel: (caller, ids, descendants, context) => { context.assertActive(); return workerOperational(() => workers.cancel(caller, ids, descendants)); },
      cancelAll: (caller, scope, context) => { context.assertActive(); return workerOperational(() => workers.cancelAll(caller, scope)); },
    },
    explicit: {
      complete: (caller, input, context) => { context.assertActive(); return workerOperational(() => workers.complete(caller, { outcome: input.outcome }, input.requestId)); },
      notify: (caller, input, context) => { context.assertActive(); return workerOperational(() => workers.notify(caller, { text: input.text, intent: input.intent }, input.requestId)); },
      messageParent: (caller, input, context) => { context.assertActive(); return workerOperational(() => workers.messageParent(caller, { text: input.text, awaitReply: input.awaitReply }, input.requestId)); },
      messageChild: (caller, input, context) => { context.assertActive(); return workerOperational(() => workers.messageChild(caller, { workerId: input.workerId, text: input.text }, input.requestId)); },
    } satisfies ExplicitWorkerOperations,
  });
  async function nativeWorker(req: Request) {
    const denied = requireNativeBearer(req, handoffToken) ?? requireStartupReady(startupReady);
    if (denied) return denied;
    return grokRequestProof.run(req.headers.get(GROK_RUNTIME_HEADER) ?? undefined, () => workerHandler(req));
  }
  function assertWorkerDeliverySubmission(owner: Owner) {
    if (!owner.workerDeliveryId) return;
    const session = meta.sessions.find(s => s.sessionId === owner.run.sessionId);
    if (closing || storageFailed || meta.reconciliationRequired || owner.stopRequested || owners.get(owner.run.sessionId) !== owner || workerStore.suppressed(owner.run.sessionId) || !session || session.hidden) throw new Error("Worker continuation withheld: parent stopped, hidden, or execution unavailable");
  }
  const workers = new WorkerService(workerStore, {
    async parent(caller) {
      const qualified = caller.invocation && qualifiedWorkerInvocations.get(caller.invocation);
      if (!qualified) throw new WorkstreamAdapterError(409, "worker-parent", "Qualified App-owned native caller required");
      const { admission: a, session, continuation, grok } = qualified;
      const run = meta.runs.find(r => r.sessionId === session.sessionId && r.runId === caller.runId);
      if (!run || run.operation === "compact" || typeof caller.toolCallId !== "string" || !caller.toolCallId || caller.toolCallId.length > 300
        || continuation && (continuation.sessionId !== session.sessionId || continuation.runId !== run.runId)) throw new WorkstreamAdapterError(409, "worker-parent", "Worker operations require an App-owned repository parent and an evidenced live invocation");
      continuation?.validate();
      grok?.assertCurrent();
      const native = { harness: a.source.descriptor.harness, authorityId: a.source.authorityId, nativeId: a.nativeId! };
      const domain = (await router!.forAdmission(a))!.domain;
      revalidateCheckout(domain.context, a.binding.checkoutPin!);
      const context = domain.resolveContext(native), workstream = context.workstream;
      if (context.executionCheckout !== session.cwd) throw new WorkstreamAdapterError(409, "execution-mismatch", "Parent execution checkout changed");
      const holdsExecution = !!workstream && domain.getWorkstreamStatus(workstream.id).activePhases.some(p => equivalentSlots(p.phase, "execution") && p.ref.harness === native.harness && p.ref.authorityId === native.authorityId && p.ref.nativeId === native.nativeId);
      const parent: WorkerParent = { sessionId: session.sessionId, runId: run.runId, native, checkout: context.executionCheckout, profileId: sessionProfileId(session), holdsExecution };
      if (session.saneExecution) parent.allowedWorkerRoles = managedWorkerRoles((await executionPackages.load(session.saneExecution)).policy);
      if (continuation) {
        if (qualified.starting) await emit(run, "context", { type: "native-worker-continuation", ...continuation.evidence });
        await continuation.refresh();
        continuationParents.set(parent, () => continuation.validate());
      }
      if (grok) { grok.assertCurrent(); continuationParents.set(parent, () => grok.assertCurrent()); }
      return parent;
    },
    assertCurrentParent(parent) {
      assertStartupReady();
      assertCatalogActive(meta.sessions.find(s => s.sessionId === parent.sessionId));
      const continuation = continuationParents.get(parent);
      if (continuation) { continuation(); return; }
      const owner = owners.get(parent.sessionId);
      if (!owner || owner.run.runId !== parent.runId || owner.run.status !== "running" || owner.run.operation === "compact" || owner.settled || owner.stopRequested || owner.cancelling) throw new WorkstreamAdapterError(409, "worker-parent", "Parent prompt run ended or stopped during worker qualification; no worker was reserved");
    },
    hasActiveExecution: nativeTurnActive,
    catalogActive: id => !retiredId(id),
    observeAllowed: id => !retirementPaused(id),
    cancellationCommitted(w) {
      const owner = owners.get(w.sessionId);
      return !!w.cancelRequestedAt || w.state === "cancelling" || !!owner?.stopRequested || !!owner?.cancelling;
    },
    publishAttention(worker, attention) {
      if (retirementPaused(worker.sessionId) || retiredId(worker.parent.sessionId)) return;
      const child = worker.child;
      const harness = child ? toSessionHarness(child.harness) : undefined;
      const source = child && harness && { harness, authorityId: child.authorityId, nativeSessionId: child.nativeId };
      if (!child || !isConversationUpdateSource(source)) return;
      const occurrence = updateOccurrenceId(source, attention.occurrenceBoundary);
      void updates.publishWorkerAttention({
        id: occurrence, conversationId: worker.sessionId, source, kind: "worker-attention", occurredAt: null,
        workerId: worker.id, parentSessionId: worker.parent.sessionId, role: worker.input.worker,
        ...(worker.input.jobs ? { jobs: [...worker.input.jobs] } : {}), intent: attention.intent, action: "open-worker",
      });
    },
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
        if (!w.launch.identity) throw new Error("Worker activation requires an identity");
        const pinnedContext = await executionReservation(w.sessionId, w.launch.identity, () => prepareSaneContext(w.launch.identity));
        const policy = pinnedContext.saneExecution ? (await executionPackages.load(pinnedContext.saneExecution)).policy : undefined;
        const coordination = managedWorkerCoordination(policy);
        if (coordination) workerStore.update(w.id, { coordination });
        // Explicit protocol is pinned only after the installed-runtime gate, immediately before first submission.
        if (policy && policy.spec.name !== `sane/${w.launch.identity?.kind}/${w.launch.identity?.role}`) throw new Error("Reserved worker execution policy role changed");
        let nativeLaunch = harness === "opencode" ? await oc.resolveLaunch(w.checkout, { agent: policy ? "build" : w.launch.agent, model: w.launch.model ?? (policy?.model ? `${policy.model.providerID}/${policy.model.id}` : undefined), effort: w.launch.effort ?? (!w.launch.model ? policy?.model?.variant : undefined) }) : undefined;
        if (harness === "claude-code" && !policy) await claudeAgentSettings(claudeRoot, w.launch.identity!);
        const native = conversationCreation(harness, w.checkout, () => nativeLaunch!);
        const admission = await beginConversationCreation(admissions, { sessionId: w.sessionId, cwd: w.checkout,
          workspaceId: parentAdmission.binding.workspaceId, worktreeId: parentAdmission.binding.worktreeId, parent: w.parent.native }, native);
        const { admission: a, value: session } = await completeConversationCreation(admissions, admission, native, async a => {
          const launch = { ...w.launch, ...(nativeLaunch?.model ? { model: `${nativeLaunch.model.providerID}/${nativeLaunch.model.id}`, effort: nativeLaunch.model.variant } : {}) };
          const session: Session = { sessionId: w.sessionId, nativeSessionId: a.nativeId!, harness, authorityId: a.source.authorityId, cwd: w.checkout, lastStatus: "unknown", lastRunId: null, ...agentLaunchSnapshot(launch), ...pinnedContext, ...(pinnedContext.saneExecution ? { nativeAgentSelected: harness === "claude-code" } : {}), title: genericSessionTitle({ agent: w.input.worker, agentKind: "worker" }), titleSource: "fallback", titleRevision: 0, titleAutoEligible: false };
          workerStore.update(w.id, { launch, child: { harness: a.source.descriptor.harness, authorityId: a.source.authorityId, nativeId: a.nativeId! } });
          meta.sessions.push(session); await persist();
          await catalog.associate(w.sessionId, w.checkout, a.binding.workspaceId, a.binding.worktreeId);
          return session;
        });
        replyIntegration?.requestRefresh();
        if (closing || storageFailed || meta.reconciliationRequired) throw new Error("App unavailable before worker submission; launch remains reserved");
        if (workerStore.get(w.id)!.cancelRequestedAt) {
          const at = new Date().toISOString(); workerStore.update(w.id, { state: "interrupted", outcome: { status: "interrupted", at, summary: "Cancelled before submission", log: null }, notification: { id: `worker-outcome:${w.id}`, state: "pending" } }); return;
        }
        try {
          const child = { harness: a.source.descriptor.harness, authorityId: a.source.authorityId, nativeId: a.nativeId! };
          const { saneContext } = pinnedContext;
          if (!saneContext) throw new Error("Worker launch has no SANE worker identity");
          let procedure: string | undefined;
          if (saneContext.package) {
            const { bundle } = await contextPackages.load(saneContext.package);
            procedure = bundle.assets.find(asset => asset.id === `worker-procedure.${w.input.worker}` && asset.kind === "procedure")?.text;
            if (!procedure) throw new Error("Worker context package has no matching procedure");
          }
          saneContext.assignment = workerAssignmentOnly((await router!.forAdmission(a))!.domain, child, w.parent.native, w.input.worker, w.input.jobs ?? [], w.id);
          session.saneContext = saneContext;
        } catch (e) {
          const summary = `Worker assignment unavailable: ${e instanceof Error ? e.message : "context resolution failed"}`;
          workerStore.update(w.id, { state: "failed", error: summary, outcome: { status: "failed", at: new Date().toISOString(), summary, log: null }, notification: { id: `worker-outcome:${w.id}`, state: "pending" } });
          throw e;
        }
        await persist();
        const explicitAdmission = await admitExplicitWorker(w, pinnedContext);
        if (explicitAdmission.reject) {
          failWorkerBeforeSubmit(w.id, explicitAdmission.reject);
          throw new Error(explicitAdmission.reject);
        }
        if (explicitAdmission.pin) {
          try { workers.pinExplicitProtocol(w.id, explicitAdmission.pin); }
          catch (error) {
            if (!workerStore.get(w.id)?.outcome) failWorkerBeforeSubmit(w.id, error instanceof WorkstreamAdapterError ? error.message : "Explicit protocol could not be pinned. This launch was not submitted.");
            throw error;
          }
        }
        const run: Run = { runId: crypto.randomUUID(), sessionId: w.sessionId, cwd: w.checkout, status: "running", createdAt: new Date().toISOString(), agent: session.agent, agentKind: session.agentKind, nativeAgentSelected: session.nativeAgentSelected, saneExecution: session.saneExecution, profileId: session.profileId, model: session.model, effort: session.effort, ...saneContextSnapshot(session), ...(harness === "opencode" ? { nativeCommandId: `msg_${crypto.randomUUID().replaceAll("-", "")}`, nativePhase: "preparing" as const } : {}) };
        workerStore.update(w.id, { runId: run.runId, state: "running" });
        const prompt = w.input.context === undefined ? w.input.prompt : `${w.input.prompt}\n\nSupplied context:\n${w.input.context}`;
        executePrompt(lease, session, run, prompt, false, "user", {
          messageIntent: { kind: "worker-launch", source: `app:${store.manifest.storeId}/worker:${w.id}`, workerId: w.id,
            assertCurrent: () => {
              const current = workerStore.get(w.id);
              if (!current || current.sessionId !== session.sessionId || current.runId !== run.runId || current.cancelRequestedAt || canonicalJSON(current.input) !== canonicalJSON(w.input)) throw new WorkstreamAdapterError(409, "context-source-changed", "Original worker launch authority changed");
            } },
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
      if (retirementPaused(w.sessionId)) return {};
      const continuationSettled = !w.continuation || ["completed", "failed", "interrupted"].includes(w.continuation.state);
      // Restart must not reread every finished worker journal just to rediscover an outcome already stored.
      if (w.outcome && ["completed", "failed", "interrupted"].includes(w.state) && continuationSettled && !workerStore.deliveriesForParent(w.sessionId).some(d => d.state === "claimed" || d.state === "acceptance-unknown")) return {};
      const restored = restoreWorkerOutput(w, runId => journalEvents(runId));
      if (restored) w = workerStore.update(w.id, restored);
      if (isExplicitWorker(w)) return observeExplicit(w);
      const results = workerResults(w);
      // Durable delivery run identity recovers continuations after restart without replay.
      const continuationDeliveries = workerStore.deliveriesForParent(w.sessionId).filter(d => d.mode !== "live-input");
      const continuationIds = new Set(continuationDeliveries.filter(d => d.state !== "not-submitted" && workerDeliveryEvidence(d, meta.runs.find(r => r.runId === d.run.runId), journalEvents(d.run.runId)) !== "not-submitted").map(d => d.run.runId));
      const candidates = meta.runs.filter(r => r.sessionId === w.sessionId && r.operation !== "compact" && (!continuationDeliveries.some(d => d.run.runId === r.runId) || continuationIds.has(r.runId)));
      // Coordinated idle turns are checkpoints, not results. The latest accepted
      // continuation supersedes them; durable run/outbox evidence survives restart.
      const run = w.coordination ? candidates.at(-1) : candidates.find(r => !results.some(result => result.runId === r.runId)) ?? candidates.at(-1);
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
      const records = journalEvents(run.runId);
      const uncertain = workerTerminationUncertainty(records);
      if (uncertain || retainOwner) return { ...(continuation ? { continuation: { ...continuation, state: "uncertain" as const, error: "Execution ownership or termination unconfirmed" } } : {}), state: "uncertain", error: uncertain && w.launch.harness === "claude-code" ? "CLI termination is unconfirmed. Verify the previous CLI process has stopped, then restart with --reconcile-interrupted to persist confirmation and release this reservation." : "Execution ownership or termination remains unconfirmed; reconcile the original native run without resubmitting." };
      if (run.status !== "running") {
        if (owners.get(w.sessionId)?.settled === false) return {}; // Finish log/metadata publication before recording an outcome.
        if (w.coordination && !w.outcome && run.status === "completed") {
          if (w.cancelRequestedAt) return { state: "interrupted", error: undefined, outcome: { status: "interrupted", at: w.cancelRequestedAt, summary: `${WORKER_AGENT_CATALOG[w.input.worker].label} cancelled while awaiting findings`, log: { sessionId: w.sessionId, runId: run.runId } } };
          if (managedWorkerWaiting(workerStore.listMatching(child => child.parent.sessionId === w.sessionId))) return { state: "waiting", ...(continuation ? { continuation } : {}) };
        }
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
      const idleParents = new Set(selected.filter(w => !captured.get(w.sessionId) && !workerStore.hasActiveDelivery(w.sessionId) && !workerStore.hasActiveExchange(w.sessionId)
        && (w.coordination && !w.outcome && meta.runs.filter(r => r.sessionId === w.sessionId && r.operation !== "compact").at(-1)?.status === "completed"
          || isExplicitWorker(w) && (w.state === "idle" || !owners.has(w.sessionId)))).map(w => w.sessionId));
      return async w => {
        const owner = captured.get(w.sessionId);
        if (!owner) { if (idleParents.has(w.sessionId) || isExplicitWorker(w) && !workerStore.hasActiveExchange(w.sessionId) || !w.runId && admitting.has(w.sessionId)) return; throw new Error("No active App owner; termination requires native reconciliation"); }
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

  async function reconcileWorkerDelivery(d: WorkerDelivery, source: "operational" | "observation" = "observation") {
    const result = await reconcileWorkerDeliveryObservation(d);
    if (source === "operational" && result.state !== d.state && ["delivered", "not-submitted"].includes(result.state)) workerCompletionRecovery?.notify();
    return result;
  }
  async function reconcileWorkerDeliveryObservation(d: WorkerDelivery) {
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
    const evidence = workerDeliveryEvidence(d, run, journalEvents(run.runId));
    if (evidence === "accepted" || evidence === "wrapper-completed") {
      // Native evidence may arrive while execution continues. The run owner still
      // holds capacity; delivered means accepted, not finished or comprehended.
      await serial;
      if (storageFailed) return d;
      return workerStore.advanceDelivery(d.id, "delivered", evidence === "wrapper-completed" ? "Grok owned wrapper completed with drained output; provider acceptance and comprehension remain unknown" : undefined);
    }
    if (evidence === "not-submitted" && owners.get(d.parentSessionId)?.settled !== false) return workerStore.advanceDelivery(d.id, "not-submitted", "Continuation did not submit; check parent suppression, visibility and executor configuration before retry");
    if (d.mode === "live-input" && evidence === "not-submitted") return workerStore.advanceDelivery(d.id, "not-submitted", "Live report was withheld before native input; outcomes remain pending");
    const problem = run.status === "running" ? "Waiting for correlated native acceptance; continuation will not be resent" : "Run ended without proof of acceptance or non-submission. Inspect the original native command; no automatic resend, even after termination acknowledgement.";
    return d.error === problem && d.state === "acceptance-unknown" ? d : workerStore.advanceDelivery(d.id, "acceptance-unknown", problem);
  }

  async function dispatchWorkerReport(parentSessionId: string) {
    if (retirementPaused(parentSessionId)) return;
    const problem = (message: string) => workerStore.pendingProblem(parentSessionId, message);
    const session = meta.sessions.find(s => s.sessionId === parentSessionId);
    if (!session) return problem("Parent session unavailable; outcomes retained for inspection");
    requireOperation(sessionHarness(session), "prompt");
    // Hidden is a reversible soft-hide: retain outcomes and pause automatic turns.
    if (session.hidden) return problem("Parent is soft-hidden; unhide to restore report eligibility. Explicit stop suppression still requires user submission.");
    if (workerStore.suppressed(parentSessionId)) return problem("Automatic continuation stopped; explicit user submission resumes report eligibility");
    const liveOwner = session.harness === "claude-code" ? owners.get(parentSessionId) : undefined;
    const liveReadiness = (requestId?: string) => {
      if (!liveOwner || owners.get(parentSessionId) !== liveOwner || coordinator.hasAdmission(parentSessionId)
        || coordinator.hasReconciliation(parentSessionId) || pendingInputs?.hasChain(parentSessionId)) {
        return { ready: false as const, code: "claude-input-unavailable", reason: "Original Claude report recipient is no longer available for live input" };
      }
      return coordinator.inspectReadiness({ conversationId: parentSessionId, intent: { kind: "worker-report", requestId }, phase: "enqueue" });
    };
    const reportReadiness = () => {
      const idle = coordinator.inspectReadiness({ conversationId: parentSessionId, intent: { kind: "worker-report" }, phase: "admission" });
      return !idle.ready && idle.code === "conversation-busy" && liveOwner && claudeRuns.canSendWorkerReport(liveOwner) ? liveReadiness() : idle;
    };
    let available = reportReadiness();
    if (!available.ready) return problem(available.reason);
    const a = admissions.get(parentSessionId);
    if (!a || a.state !== "ready" || a.binding.domain.mode !== "repository" || session.attachment || !session.nativeSessionId || !session.lastRunId) return problem("Report recipient must remain an enrolled App-owned conversation with a known native run");
    const pending = workerStore.listMatching(w => w.parent.sessionId === parentSessionId).filter(w => workerResults(w).some(r => r.notification.state === "pending"));
    const coordinatedParent = workerStore.getBySession(parentSessionId);
    if (coordinatedParent?.coordination) {
      if (coordinatedParent.outcome) return problem("Coordinating worker already ended; child outcomes retained for inspection");
      if (workerStore.listMatching(w => w.parent.sessionId === parentSessionId).some(w => !w.outcome)) return problem("Coordinating worker is awaiting the remaining child outcomes");
    }
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
    if (liveOwner) {
      const now = new Date().toISOString(), uuid = crypto.randomUUID();
      const commandId = `${liveOwner.run.runId}:user:${uuid}`;
      const d = (() => { try {
        const claimed = workerStore.claimDelivery({ id: crypto.randomUUID(), parentSessionId,
          native: { harness: "cc", authorityId: a.source.authorityId, nativeId: session.nativeSessionId! },
          run: liveOwner.run, commandId, mode: "live-input", createdAt: now, updatedAt: now });
        return claimed ? workerStore.advanceDelivery(claimed.id, "acceptance-unknown") : undefined;
      } catch (error) { failClosed(error, "worker-report-claim"); throw error; } })();
      if (!d) return;
      const assertCurrent = () => {
        const ready = liveReadiness(d.id);
        if (!ready.ready) throw new WorkstreamAdapterError(409, ready.code, ready.reason);
        assertDispatchSnapshot(parentSessionId, snapshot);
        if (retirementPaused(parentSessionId) || session.hidden || workerStore.suppressed(parentSessionId)) throw new WorkstreamAdapterError(409, "worker-report-paused", "Parent hidden, stopped or retiring; live report withheld");
      };
      try {
        await claudeRuns.sendWorkerReport(liveOwner, workerReportPrompt(d, workerStore.listForDelivery(d)), uuid, assertCurrent);
      } catch (error) {
        if (storageFailed) throw error;
        const attempted = journalEvents(d.run.runId).some(event => event.kind === "context"
          && (event.data as any)?.type === "context-message-dispatch" && (event.data as any).messageId === commandId
          && (event.data as any).stage === "before-native");
        // No write is possible without this exact durable message intent. A
        // possible/partial write stays unknown and must never be auto-replayed.
        if (!attempted) {
          await emit(liveOwner.run, "status", { status: liveOwner.run.status, workerDeliveryNotSubmitted: d.id });
          workerStore.advanceDelivery(d.id, "not-submitted", error instanceof Error ? error.message : "Live report withheld before native input");
        }
      }
      // This dispatcher is driven by the outbox poll. The owning turn's shared
      // settlement hook reconciles live reports operationally after it finishes.
      if (!storageFailed) await reconcileWorkerDelivery(d, "observation");
      return;
    }
    const workerParent = workerStore.getBySession(parentSessionId);
    if (workerParent && workers.executionCount(cwd, parentSessionId) >= maxWorkersPerCheckout) return problem(`Checkout worker capacity reached (${maxWorkersPerCheckout}); continuation remains pending`);
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
      } catch (error) { failClosed(error, "handoff-claim"); throw error; } })();
      if (!d) return;
      if (workerParent) workerStore.update(workerParent.id, { state: "running", continuation: { runId: run.runId, state: "running" }, continuationCancellation: undefined });
      const prompt = workerReportPrompt(d, workerStore.listForDelivery(d));
      executePrompt(lease, session, run, prompt, true, "worker-report", { workerDeliveryId: d.id,
        reconciliation: { order: "after-release", run: async () => {
          if (!storageFailed) { await reconcileWorkerDelivery(d, "operational"); if (workerParent) await workers.refresh(workerStore.get(workerParent.id)!); }
        } },
      });
    } finally { coordinator.releaseAdmission(lease); }
  }

  async function observeExplicit(w: WorkerRecord): Promise<Partial<WorkerRecord>> {
    const continuationDeliveries = workerStore.deliveriesForParent(w.sessionId).filter(d => d.mode !== "live-input");
    const continuationIds = new Set(continuationDeliveries.filter(d => d.state !== "not-submitted" && workerDeliveryEvidence(d, meta.runs.find(r => r.runId === d.run.runId), journalEvents(d.run.runId)) !== "not-submitted").map(d => d.run.runId));
    const candidates = meta.runs.filter(r => r.sessionId === w.sessionId && r.operation !== "compact" && (!continuationDeliveries.some(d => d.run.runId === r.runId) || continuationIds.has(r.runId)));
    const run = candidates.at(-1);
    const owner = owners.get(w.sessionId);
    const ownerPresent = !!owner || admitting.has(w.sessionId);
    const ownerSettled = !admitting.has(w.sessionId) && (!owner || owner.settled !== false);
    const cancelRequested = !!w.cancelRequestedAt;
    // An audited operator recovery supersedes this run's assignment closure,
    // not its failed native history. A newer real run resumes normal observation.
    const recovery = w.usageRecovery ?? w.stopRecovery;
    if (recovery && recovery.throughRunId === run?.runId && !cancelRequested && !w.completion && !w.outcome && !retainOwner && !storageFailed)
      return ownerPresent ? {} : { state: "idle", assignment: "open" };
    if (!run) {
      if (ownerPresent) return explicitObservationChange(w, { run: null, ownerPresent, ownerSettled, terminationUncertain: false, cancelRequested });
      const uncertain = (reason: string) => explicitObservationChange(w, { run: null, ownerPresent: false, ownerSettled: true, terminationUncertain: true, cancelRequested, nativeSummary: reason });
      if (storageFailed || retainOwner) return uncertain("App storage or execution ownership is unconfirmed");
      if (meta.runs.some(r => r.sessionId === w.sessionId)) return uncertain("Worker run reference disagrees with session run metadata");
      const admission = admissions.get(w.sessionId);
      if (admission?.state === "native_creation_unknown") return uncertain("Native session creation acknowledgement was lost");
      if (!admission && (w.child || meta.sessions.some(s => s.sessionId === w.sessionId)) || admission && (admission.operation !== "create" || admission.binding.executionCheckout !== w.checkout || w.child && (w.child.nativeId !== admission.nativeId || w.child.authorityId !== admission.source.authorityId))) return uncertain("Worker and admission identity evidence disagree");
      if (w.runId) {
        try {
          const raw = await readFile(join(options.dataDir, `${w.runId}.jsonl`), "utf8");
          const orphan = raw.length ? decodeLog(raw, { runId: w.runId, sessionId: w.sessionId } as Run).events : [];
          if (orphan.some(e => e.kind !== "submission" && !(e.kind === "status" && (e.data as { status?: string } | null)?.status === "running" && Object.keys((e.data ?? {}) as object).length === 1))) return uncertain("Orphan log contains evidence beyond the pre-submission publication boundary");
        } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") return uncertain("Orphan run log is unreadable or cannot prove non-submission"); }
      }
      if (admitting.has(w.sessionId) || owners.has(w.sessionId)) return {};
      const status = cancelRequested ? "interrupted" as const : "failed" as const;
      return explicitObservationChange(w, { run: null, ownerPresent: false, ownerSettled: true, terminationUncertain: false, cancelRequested, preparationOutcome: { status, summary: "Worker preparation ended before durable run publication; native work was not submitted. Original request is closed and will not be replayed." } });
    }
    const records = journalEvents(run.runId);
    const reminder = w.completionRecovery?.delivery;
    if (reminder?.runId === run.runId && !w.completion && !w.outcome && !ownerPresent && !cancelRequested
      && ["claimed", "acceptance-unknown"].includes(reminder.state)) return {
      state: "uncertain", continuation: { runId: run.runId, state: "uncertain" },
      error: reminder.error ?? "Completion reminder acceptance or termination remains unconfirmed. Inspect its original run/native command; no automatic retry or inferred assignment success.",
    };
    if (reminder?.runId === run.runId && reminder.state === "not-submitted" && !w.completion && !w.outcome && !ownerPresent && !cancelRequested) return {
      state: "idle", assignment: "open", continuation: { runId: run.runId, state: run.status },
      error: reminder.error ?? "Completion reminder was not submitted. The one-shot claim is retained; explicit operator recovery is required, not automatic replay.",
    };
    return explicitObservationChange(w, {
      run: { runId: run.runId, status: run.status, endedAt: run.endedAt }, ownerPresent, ownerSettled,
      terminationUncertain: !!workerTerminationUncertainty(records) || retainOwner, cancelRequested,
      runStopped: records.some(event => event.kind === "status" && (event.data as { workerRunStopped?: boolean } | null)?.workerRunStopped === true),
      nativeSummary: workerOutput(records) ?? String((records.filter(e => e.kind === "status").at(-1)?.data as { reason?: unknown } | undefined)?.reason ?? run.status),
    });
  }
  async function reconcileExchange(exchange: import("./worker-contract").WorkerExchange, source: "operational" | "observation" = "observation") {
    const result = await reconcileExchangeObservation(exchange);
    if (source === "operational" && result && result.delivery.state !== exchange.delivery.state && ["accepted", "wrapper-completed", "not-submitted"].includes(result.delivery.state)) workerCompletionRecovery?.notify();
    return result;
  }
  async function reconcileExchangeObservation(exchange: import("./worker-contract").WorkerExchange) {
    const delivery = exchange.delivery;
    if (delivery.state !== "claimed" && delivery.state !== "acceptance-unknown" || !delivery.deliveryId || !delivery.runId) return;
    const run = meta.runs.find(r => r.runId === delivery.runId && r.sessionId === exchange.recipient.sessionId);
    if (!run) {
      if (owners.has(exchange.recipient.sessionId) || admitting.has(exchange.recipient.sessionId) || storageFailed) return;
      try {
        const raw = await readFile(join(options.dataDir, `${delivery.runId}.jsonl`), "utf8");
        const records = raw ? decodeLog(raw, { runId: delivery.runId, sessionId: exchange.recipient.sessionId } as Run).events : [];
        if (records.some(e => e.kind !== "submission" && !(e.kind === "status" && (e.data as { status?: string } | null)?.status === "running" && Object.keys((e.data ?? {}) as object).length === 1))) return workerStore.advanceExchange(exchange.id, "acceptance-unknown", "Orphan exchange log exceeds pre-submission boundary; no automatic resend");
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") return workerStore.advanceExchange(exchange.id, "acceptance-unknown", "Exchange log unreadable; no automatic resend"); }
      return workerStore.advanceExchange(exchange.id, "not-submitted", "Exchange was not submitted; it can be retried");
    }
    const evidence = exchangeDeliveryEvidence({ id: delivery.deliveryId, commandId: delivery.commandId, native: exchange.recipient.native, sessionId: exchange.recipient.sessionId, runId: delivery.runId }, run, journalEvents(run.runId));
    if (evidence === "accepted") return workerStore.advanceExchange(exchange.id, "accepted");
    if (evidence === "wrapper-completed") return workerStore.advanceExchange(exchange.id, "wrapper-completed", "Grok local exchange wrapper completed with drained output; provider acceptance and comprehension remain unknown");
    if (evidence === "not-submitted" && owners.get(exchange.recipient.sessionId)?.settled !== false) return workerStore.advanceExchange(exchange.id, "not-submitted", "Exchange did not submit; it can be retried");
    const problem = run.status === "running" ? "Waiting for correlated native acceptance; exchange will not be resent" : "Run ended without proof of acceptance or non-submission. No automatic resend.";
    if (delivery.state === "acceptance-unknown" && delivery.error === problem) return;
    return workerStore.advanceExchange(exchange.id, "acceptance-unknown", problem);
  }
  async function reconcileWorkerSettlementTraffic(sessionId: string) {
    for (const delivery of workerStore.deliveriesToReconcile()) {
      if (closing || storageFailed) return;
      if (delivery.parentSessionId === sessionId && !retirementPaused(sessionId)) await reconcileWorkerDelivery(delivery, "operational");
    }
    for (const { exchange } of workerStore.exchangesToReconcile()) {
      if (closing || storageFailed) return;
      if (exchange.recipient.sessionId === sessionId && !retirementPaused(sessionId)) await reconcileExchange(exchange, "operational");
    }
  }
  async function dispatchWorkerExchange(workerId: string, exchange: import("./worker-contract").WorkerExchange) {
    if (retirementPaused(exchange.recipient.sessionId) || retiredId(exchange.sender.sessionId)) return;
    if (exchange.delivery.state !== "queued") return;
    const session = meta.sessions.find(s => s.sessionId === exchange.recipient.sessionId);
    if (!session || !session.nativeSessionId) return workerStore.noteExchange(exchange.id, "Exchange recipient is unavailable; the message remains queued");
    if (session.hidden) return workerStore.noteExchange(exchange.id, "Recipient is soft-hidden; the exchange remains queued");
    if (workerStore.suppressed(session.sessionId)) return workerStore.noteExchange(exchange.id, "Automatic continuation is stopped; the exchange remains queued");
    const recipientWorker = workerStore.getBySession(session.sessionId);
    if (recipientWorker && (recipientWorker.assignment === "closing" || recipientWorker.assignment === "terminal")) return workerStore.noteExchange(exchange.id, "Recipient assignment is no longer open; the exchange remains queued");
    const ready = coordinator.inspectReadiness({ conversationId: session.sessionId, intent: { kind: "worker-exchange", requestId: exchange.id }, phase: "admission" });
    if (!ready.ready) return workerStore.noteExchange(exchange.id, ready.reason);
    if (recipientWorker && workers.executionCount(session.cwd, session.sessionId) >= maxWorkersPerCheckout) return workerStore.noteExchange(exchange.id, `Checkout worker capacity reached (${maxWorkersPerCheckout}); exchange remains queued`);
    const admission = admissions.get(session.sessionId);
    if (!admission || admission.state !== "ready") return workerStore.noteExchange(exchange.id, "Exchange recipient is not an admitted conversation");
    const cwd = await execution(session.sessionId);
    if (session.harness === "opencode") await oc.assertIdle(session.nativeSessionId, cwd);
    const again = coordinator.inspectReadiness({ conversationId: session.sessionId, intent: { kind: "worker-exchange", requestId: exchange.id }, phase: "admission" });
    if (!again.ready || workerStore.hasActiveExchange(session.sessionId)) return;
    const now = new Date().toISOString();
    const run: Run = { runId: crypto.randomUUID(), sessionId: session.sessionId, cwd, status: "running", createdAt: now, agent: session.agent, agentKind: session.agentKind, nativeAgentSelected: session.nativeAgentSelected, profileId: session.profileId, model: session.model, effort: session.effort, ...saneContextSnapshot(session) };
    const commandId = session.harness === "opencode" ? `msg_${crypto.randomUUID().replaceAll("-", "")}` : `${run.runId}:user`;
    if (session.harness === "opencode") { run.nativeCommandId = commandId; run.nativePhase = "preparing"; }
    const deliveryId = crypto.randomUUID();
    const lease = reserve({ kind: "worker-exchange", requestId: exchange.id }, session.sessionId);
    try {
      const claimed = workerStore.claimExchange(workerId, exchange.id, { deliveryId, runId: run.runId, commandId });
      if (!claimed) return;
      if (recipientWorker && recipientWorker.assignment !== "terminal") workerStore.update(recipientWorker.id, { state: "running", continuation: { runId: run.runId, state: "running" } });
      // owner.workerDeliveryId carries the exchange id only so existing executors can prove non-submission. It is not a WorkerDelivery.
      executePrompt(lease, session, run, workerExchangePrompt(claimed), true, "worker-exchange", {
        requestId: exchange.id, coordinatorIntent: "worker-exchange", workerDeliveryId: deliveryId,
        reconciliation: { order: "after-release", run: async () => {
          if (storageFailed) return;
          const current = workerStore.get(workerId)?.exchanges?.find(item => item.id === exchange.id);
          if (current) await reconcileExchange(current, "operational");
          if (recipientWorker) await workers.refresh(workerStore.get(recipientWorker.id)!);
        } },
      });
    } finally { coordinator.releaseAdmission(lease); }
  }

  /** Gather live facts again after every await and at both install/native-send
   * boundaries. Own admission/owner exemptions are exact identities, never an
   * origin string or a session-wide busy exemption. */
  function completionRecoverySnapshot(worker: WorkerRecord, candidate: WorkerCompletionRecoveryCandidate,
    own?: { lease: ConversationAdmissionLease; runId?: string }): WorkerCompletionRecoveryInput {
    const descendants = workerStore.listDescendants(worker.sessionId);
    const scope = new Set([worker.sessionId, ...descendants.map(child => child.sessionId)]);
    const session = meta.sessions.find(session => session.sessionId === worker.sessionId);
    const latest = meta.runs.filter(run => run.sessionId === worker.sessionId && run.operation !== "compact" && run.runId !== own?.runId).at(-1);
    const sourceCurrent = !!session && sameDispatchSource(candidate.source, dispatchSource(session));
    const sourceUnavailable = !sourceCurrent || !session || session.hidden || !!session.attachment || retirementPaused(worker.sessionId)
      || !!branches.replaced(worker.sessionId) || !!branches.pending(worker.sessionId);
    const records = latest ? journalEvents(latest.runId) : [];
    const active = (id: string, runId?: string) => {
      const owner = owners.get(id);
      return !!owner && (!runId || owner.run.runId === runId) && !(id === worker.sessionId && owner.run.runId === own?.runId)
        || meta.runs.some(run => run.sessionId === id && run.status === "running" && run.runId !== own?.runId && (!runId || run.runId === runId));
    };
    let incomingExchanges = false, outgoingExchanges = false;
    for (const owner of workerStore.list()) for (const exchange of owner.exchanges ?? []) {
      const pending = ["queued", "claimed", "acceptance-unknown"].includes(exchange.delivery.state)
        || !!exchange.delivery.runId && active(exchange.recipient.sessionId, exchange.delivery.runId);
      if (pending && scope.has(exchange.recipient.sessionId)) incomingExchanges = true;
      if (pending && scope.has(exchange.sender.sessionId)) outgoingExchanges = true;
    }
    const scopeWorkers = [worker, ...descendants], workerIds = new Set(scopeWorkers.map(worker => worker.id));
    const pendingAppAdmissions = new Set(appAdmissions?.readPending().map(row => row.conversationId) ?? []);
    // Check durable App admission and all source policy independently of an
    // installed owner. Only this exact recovery lease may ignore itself.
    const sourcePolicyBlocked = !!readinessPolicy({ conversationId: worker.sessionId, intent: { kind: "worker-recovery" },
      phase: own ? "dispatch" : "admission", ...(own ? { lease: own.lease } : {}) });
    const resultDeliveries = scopeWorkers.some(worker => workerResults(worker).some(result => !["wait-consumed", "delivered"].includes(result.notification.state)))
      || workerStore.deliveries().some(delivery => (scope.has(delivery.parentSessionId) || delivery.workerIds.some(id => workerIds.has(id)))
        && (["claimed", "acceptance-unknown"].includes(delivery.state) || delivery.state === "delivered" && active(delivery.parentSessionId, delivery.run.runId)));
    return {
      attemptKey: workerCompletionRecoveryAttemptKey(worker), latestRunId: latest?.runId ?? null,
      run: latest ? { runId: latest.runId, sessionId: latest.sessionId, status: latest.status,
        // This fact is supplied only to policy preflight. Claim/failure callers
        // must first obtain the candidate's positive exact settlement proof.
        successful: latest.runId === candidate.runId, settled: !active(worker.sessionId),
        stopped: records.some(event => event.kind === "status" && (event.data as { workerRunStopped?: boolean } | null)?.workerRunStopped === true) } : null,
      blockers: {
        suppressed: sourceUnavailable || workerStore.suppressed(worker.sessionId) || workerStore.suppressed(worker.parent.sessionId),
        cancellationCommitted: !!worker.cancelRequestedAt || !!worker.continuationCancellation,
        uncertainExecution: closing || storageFailed || retainOwner || !!meta.reconciliationRequired || !startupReady
          || scopeWorkers.some(worker => worker.state === "uncertain" || worker.continuation?.state === "uncertain")
          || [...scope].some(id => meta.runs.filter(run => run.sessionId === id && run.operation !== "compact" && run.runId !== own?.runId).slice(-1)
            .some(run => !!workerTerminationUncertainty(journalEvents(run.runId)))),
        unfinishedDescendants: descendants.some(worker => worker.assignment !== "terminal" && !worker.outcome
          || worker.continuation && !["completed", "failed", "interrupted"].includes(worker.continuation.state)),
        incomingExchanges, outgoingExchanges, resultDeliveries,
        admission: sourcePolicyBlocked || [...scope].some(id => pendingAppAdmissions.has(id) || coordinator.hasReconciliation(id)
          || coordinator.hasAdmission(id) && !(id === worker.sessionId && own && coordinator.holdsAdmission(own.lease, id))
          || !!pendingInputs?.hasChain(id) || admissions.get(id)?.state !== "ready"),
        execution: [...scope].some(id => active(id)),
      },
    };
  }
  function noteCompletionRecovery(workerId: string, error: string) {
    const worker = workerStore.get(workerId);
    if (worker && !worker.completion && !worker.outcome && worker.error !== error) workerStore.update(workerId, { error });
  }
  async function reconcileCompletionRecoveryDelivery(worker: WorkerRecord) {
    const recovery = worker.completionRecovery;
    if (!recovery || !["claimed", "acceptance-unknown"].includes(recovery.delivery.state)) return;
    const delivery = recovery.delivery;
    const run = meta.runs.find(run => run.runId === delivery.runId && run.sessionId === worker.sessionId);
    const evidence = exchangeDeliveryEvidence({ id: delivery.id, commandId: delivery.commandId, native: delivery.native,
      sessionId: worker.sessionId, runId: delivery.runId }, run, run ? journalEvents(run.runId) : []);
    if (evidence === "accepted" || evidence === "wrapper-completed") {
      workerStore.advanceCompletionRecovery(worker.id, delivery.id, evidence === "accepted" ? "delivered" : "wrapper-completed");
      return;
    }
    if (owners.has(worker.sessionId) || admitting.has(worker.sessionId)) return;
    const error = evidence === "not-submitted"
      ? "Completion reminder was not submitted. Its one-shot claim is retained; inspect the original reminder run before explicit operator recovery. No automatic retry."
      : "Completion reminder dispatch or termination is unconfirmed. Inspect the original reminder run/native command; no automatic retry and no inferred assignment success.";
    workerStore.advanceCompletionRecovery(worker.id, delivery.id, evidence === "not-submitted" ? "not-submitted" : "acceptance-unknown", error);
    noteCompletionRecovery(worker.id, error);
  }
  async function reconsiderWorkerCompletion(candidate: WorkerCompletionRecoveryCandidate, isCurrent: () => boolean) {
    const id = candidate.source.sessionId;
    let worker = workerStore.getBySession(id);
    if (!worker || !isExplicitWorker(worker) || !isCurrent()) return;
    let snapshot = completionRecoverySnapshot(worker, candidate);
    let classification = classifyWorkerCompletionRecovery(worker, snapshot);
    if (!["recovery-needed", "escalation-needed", "attention-needed"].includes(classification.status)) return;
    const session = meta.sessions.find(session => session.sessionId === id)!;
    const sourcePin = dispatchSnapshot(session);
    const cwd = await execution(id);
    if (!isCurrent()) return;
    assertDispatchSnapshot(id, sourcePin);
    worker = workerStore.getBySession(id)!;
    snapshot = completionRecoverySnapshot(worker, candidate);
    if (!["recovery-needed", "escalation-needed", "attention-needed"].includes(classifyWorkerCompletionRecovery(worker, snapshot).status)) return;
    const proof = await candidate.successfulSettlement();
    if (!isCurrent()) return;
    assertDispatchSnapshot(id, sourcePin);
    worker = workerStore.getBySession(id)!;
    snapshot = completionRecoverySnapshot(worker, candidate);
    classification = classifyWorkerCompletionRecovery(worker, snapshot);
    if (!["recovery-needed", "escalation-needed", "attention-needed"].includes(classification.status)) return;
    if (!proof.ready) {
      noteCompletionRecovery(worker.id, `Missing completion: exact successful native settlement is not proven (${proof.reason}). Inspect the original run; no automatic task replay.`);
      return;
    }
    const readiness = coordinator.inspectReadiness({ conversationId: id, intent: { kind: "worker-recovery" }, phase: "admission" });
    if (!readiness.ready) return;
    // Both terminal failure and nonterminal attention re-read admission/source,
    // exact worker/attempt/run, and all blockers INSIDE the atomic store writer.
    const workerId = worker.id, attemptKey = snapshot.attemptKey;
    const revalidate = (): WorkerCompletionRecoveryInput | undefined => {
      if (!isCurrent() || dispatchSnapshot(session) !== sourcePin) return;
      const current = workerStore.get(workerId);
      if (!current || current.sessionId !== id || workerCompletionRecoveryAttemptKey(current) !== attemptKey) return;
      const ready = coordinator.inspectReadiness({ conversationId: id, intent: { kind: "worker-recovery" }, phase: "admission" });
      if (!ready.ready) return;
      const fresh = completionRecoverySnapshot(current, candidate);
      return fresh.latestRunId === candidate.runId ? fresh : undefined;
    };
    if (classification.status === "attention-needed") {
      workerStore.claimCompletionRecoveryEscalation(workerId, { expectedRevision: workerStore.revision, snapshot,
        deliveryId: worker.completionRecovery!.delivery.id, escalationId: crypto.randomUUID(), revalidate });
      return;
    }
    if (classification.status === "escalation-needed") {
      const recovery = worker.completionRecovery!;
      // Never terminalize a claim merely because delivery is unknown or a
      // different ordinary turn finished. Only this exact reminder can fail.
      if (candidate.runId !== recovery.delivery.runId || !["delivered", "wrapper-completed"].includes(recovery.delivery.state)) return;
      workerStore.failCompletionRecovery(worker.id, { expectedRevision: workerStore.revision, snapshot, deliveryId: recovery.delivery.id, revalidate,
        summary: "Missing worker completion: the App-owned completion reminder settled successfully, but the worker again neither called worker_complete nor declared a legitimate wait/dependency. The assignment failed its completion protocol; task success was not inferred. Original native reports remain in the run journals." });
      return;
    }
    if (workers.executionCount(cwd, id) >= maxWorkersPerCheckout) return;
    const { run, commandId } = newDispatchRun(session, { cwd });
    const deliveryId = crypto.randomUUID();
    const lease = reserve({ kind: "worker-recovery", requestId: deliveryId }, id);
    let claimed = false;
    try {
      worker = workerStore.getBySession(id)!;
      snapshot = completionRecoverySnapshot(worker, candidate, { lease });
      const recovery = workerStore.claimCompletionRecovery(worker.id, { expectedRevision: workerStore.revision, snapshot,
        delivery: { id: deliveryId, runId: run.runId, commandId, native: worker.child! } });
      if (!recovery) return;
      claimed = true;
      const workerId = worker.id, attemptKey = recovery.attemptKey;
      const assertCurrent = () => {
        if (!isCurrent() && owners.get(id)?.run.runId !== run.runId) throw new WorkstreamAdapterError(409, "worker-recovery-stale", "Original recovery candidate is no longer current");
        assertDispatchSnapshot(id, sourcePin);
        const current = workerStore.get(workerId);
        if (!current || current.completion || current.outcome || current.assignment !== "open" || current.cancelRequestedAt || current.continuationCancellation
          || current.wait?.reason === "parent" || current.wait?.reason === "user" || workerCompletionRecoveryAttemptKey(current) !== attemptKey
          || current.completionRecovery?.delivery.id !== deliveryId || current.completionRecovery.triggerRunId !== candidate.runId) throw new WorkstreamAdapterError(409, "worker-recovery-stale", "Completion, wait or assignment authority changed before reminder dispatch");
        const live = completionRecoverySnapshot(current, candidate, { lease, runId: run.runId });
        if (live.latestRunId !== candidate.runId || Object.values(live.blockers).some(Boolean)) throw new WorkstreamAdapterError(409, "worker-recovery-blocked", "Worker acquired new work, dependencies or execution uncertainty before reminder dispatch");
      };
      // Persist possible submission before installing the native execution. A
      // restart never interprets this durable claim as permission to resend.
      workerStore.advanceCompletionRecovery(workerId, deliveryId, "acceptance-unknown");
      executePrompt(lease, session, run, WORKER_COMPLETION_REMINDER, true, "worker-recovery", {
        requestId: deliveryId, coordinatorIntent: "worker-recovery", workerDeliveryId: deliveryId,
        validate: assertCurrent, beforeSend: assertCurrent,
        reconciliation: { order: "after-release", run: async () => {
          if (!storageFailed) { await reconcileCompletionRecoveryDelivery(workerStore.get(workerId)!); await workers.refresh(workerStore.get(workerId)!); }
        } },
      });
    } catch (error) {
      if (claimed && !storageFailed) {
        const current = workerStore.getBySession(id)!;
        await reconcileCompletionRecoveryDelivery(current);
      }
      throw error;
    } finally { coordinator.releaseAdmission(lease); }
  }
  workerCompletionRecovery = new WorkerCompletionRecoveryCoordinator({
    available: () => workerCompletionRecoveryStarted && startupReady && !closing && !storageFailed && !retainOwner && !meta.reconciliationRequired,
    reconsider: (candidate, current) => reconsiderWorkerCompletion(candidate, current),
    onError: error => {
      // Readiness/source refusals are scoped and consume no budget before claim.
      if (!(error instanceof WorkstreamAdapterError || error instanceof DispatchProofUnavailableError || error instanceof OpenCodeUnavailableError || error instanceof OpenCodeSourceMismatchError)) failClosed(error, "worker-completion-recovery");
    },
  });

  function trackRecoveredWorkerCompletion(sessionId: string) {
    if (workerCompletionRecovery?.has(sessionId)) { workerCompletionRecovery.notify(sessionId); return; }
    const worker = workerStore.getBySession(sessionId), session = meta.sessions.find(session => session.sessionId === sessionId);
    const run = meta.runs.filter(run => run.sessionId === sessionId && run.operation !== "compact").at(-1);
    if (!worker || !isExplicitWorker(worker) || worker.assignment !== "open" || worker.completion || worker.outcome
      || !session || !run || run.status !== "completed" || owners.has(sessionId)) return;
    const source = Object.freeze({ ...dispatchSource(session) }), sourcePin = dispatchSnapshot(session);
    const current = () => !closing && !storageFailed && !retainOwner && startupReady && !meta.reconciliationRequired
      && meta.sessions.includes(session) && meta.runs.includes(run) && run.status === "completed" && !!run.endedAt
      && dispatchSnapshot(session) === sourcePin && sameDispatchSource(source, dispatchSource(session))
      && meta.runs.filter(run => run.sessionId === sessionId && run.operation !== "compact").at(-1) === run
      && !owners.has(sessionId) && !admitting.has(sessionId) && !coordinator.hasReconciliation(sessionId);
    workerCompletionRecovery?.track({ runId: run.runId, source, successfulSettlement: async () => {
      const denied = (reason: string) => ({ ready: false as const, reason, code: "dispatch-proof-unavailable" });
      if (!current() || workerTerminationUncertainty(journalEvents(run.runId))) return denied("Original startup run/source settlement remains unconfirmed");
      // Do not manufacture a live process handle after restart. Claude journals
      // do not positively retain original process-group exit plus stream drain.
      if (session.harness === "claude-code") return denied("Original Claude process exit and stream drain cannot be recertified after restart");
      if (session.harness === "grok") {
        if (!worker.child || !grokWrapperCompletion(worker.child, run, journalEvents(run.runId))) return denied("Original Grok wrapper close, drained output and zero-exit proof are absent");
      } else if (session.harness === "opencode") {
        if (!run.nativeCommandId || run.nativePhase !== "accepted" || journalEvents(run.runId).some(event => event.kind === "context"
          && (event.data as { type?: string; proofKind?: string } | null)?.type === "completion-reconciliation"
          && (event.data as { proofKind?: string }).proofKind === "operator-verified")) return denied("Original exact OpenCode command success is not proven");
        const observed = await readOnlyDispatchProof(() => oc.snapshot(source.nativeSessionId!, run.nativeCommandId!, source.cwd));
        if (!current() || observed.outcome !== "succeeded") return denied("Original exact OpenCode command success is not proven");
      } else return denied("Native startup settlement proof is unsupported");
      const native = await dispatchRegistry.readiness(source, "worker-recovery");
      return current() ? native : denied("Original startup run/source changed during native readiness");
    } });
  }

  let workerOutboxTask: Promise<void> | undefined;
  async function consumeWorkerReports() {
    for (const w of workers.listForRefresh()) { if (closing || storageFailed) return; await workers.refresh(w); }
    for (const d of workerStore.deliveriesToReconcile()) { if (closing || storageFailed) return; if (!retirementPaused(d.parentSessionId)) await reconcileWorkerDelivery(d, "observation"); }
    for (const exchange of workerStore.exchangesToReconcile()) { if (closing || storageFailed) return; if (!retirementPaused(exchange.exchange.recipient.sessionId)) await reconcileExchange(exchange.exchange, "observation"); }
    for (const parent of workerStore.pendingParents()) {
      if (closing || storageFailed) return;
      if (retirementPaused(parent)) continue;
      try { await dispatchWorkerReport(parent); } catch (e) { if (storageFailed) throw e; workerStore.pendingProblem(parent, e instanceof Error ? e.message : "Worker report preparation unavailable"); }
    }
    for (const queued of workerStore.queuedExchanges()) {
      if (closing || storageFailed) return;
      if (retirementPaused(queued.exchange.recipient.sessionId) || retiredId(queued.exchange.sender.sessionId)) continue;
      try { await dispatchWorkerExchange(queued.workerId, queued.exchange); } catch (e) { if (storageFailed) throw e; workerStore.noteExchange(queued.exchange.id, "Exchange preparation is unavailable; the message remains queued"); }
    }
  }
  const workerOutbox = { list: () => workerStore.deliveries(), reconcile: async (id: string) => { const d = workerStore.deliveries().find(d => d.id === id); if (!d) throw new WorkstreamAdapterError(404, "worker-delivery-missing", "Unknown worker delivery"); return reconcileWorkerDelivery(d, "operational"); } };

  async function cancelOwner(owner: Owner) {
    requireOwnedOperation(ownedSession(owner), owner, "cancelOwnedRun");
    return requestRunCancellation(owner, "worker", {
      emitStopping: () => emit(owner.run, "status", { status: "running", connection: "stopping", reason: "Stop requested; waiting for terminal evidence" }),
      isCurrent: () => owners.get(owner.run.sessionId) === owner,
      release: releaseOwner,
    });
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
      if (storage || !refusal) failClosed(error, "handoff-dispatch");
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
    if (retirementPaused(h.recipient.sessionId)) return h;
    if (h.recipient.ownerId !== store.manifest.storeId || !h.runId || ["awaiting_approval", "queued", "completed", "failed"].includes(h.status)) return h;
    const run = meta.runs.find(r => r.runId === h.runId && r.sessionId === h.recipient.sessionId);
    if (!run || run.operation === "compact") return h;
    const records = journalEvents(run.runId);
    if (h.recipient.harness === "gk") {
      // Publish only after the exact original wrapper observation is durable.
      // Process completion is not provider acceptance or task/user approval.
      await serial;
      if (storageFailed) return h;
      h = domain.getHandoff(id);
      if (["completed", "failed"].includes(h.status)) { handoffReservations.delete(h.recipient.sessionId); return h; }
      if (h.status !== "acceptance_unknown" || h.runId !== run.runId || h.dispatchId !== `app:grok:${run.runId}`
        || h.nativeCommandId !== null || run.nativeCommandId != null || !h.recipient.ref) return h;
      if (grokWrapperCompletion(h.recipient.ref, run, records, h.id)) {
        h = handoffMutation(() => domain.advanceHandoff(h.id, h.revision, { status: "completed", wrapperCompleted: true,
          evidence: `Exact Grok App dispatch ${h.dispatchId} wrapper completed successfully with drained output; provider acceptance, comprehension and task/user approval remain unknown` },
          { actor: { kind: "system" }, correlationId: h.id }));
      } else if ((run.status === "failed" || run.status === "interrupted") && records.some(event => {
        const data = event.data as Record<string, any> | null;
        return event.kind === "context" && event.runId === run.runId && event.sessionId === run.sessionId
          && data?.type === "grok-wrapper-termination" && data.runId === run.runId && data.requestId === h.id && data.nativeCommandId === null
          && data.source?.harnessId === "grok" && data.source.sessionId === h.recipient.sessionId && data.source.cwd === run.cwd
          && data.source.authorityId === h.recipient.ref!.authorityId && data.source.nativeSessionId === h.recipient.ref!.nativeId
          && data.submission === "submitted" && data.nativeAcceptance === "unknown" && data.wrapperCompletion === "closed"
          && data.streamsDrained === true && data.status === run.status;
      })) {
        h = handoffMutation(() => domain.advanceHandoff(h.id, h.revision, { status: "failed",
          evidence: `Exact Grok App dispatch ${h.dispatchId} owned wrapper ${run.status} and output drained; provider acceptance/cancellation remain unknown. No automatic resend.` },
          { actor: { kind: "system" }, correlationId: h.id }));
      }
      if (["completed", "failed"].includes(h.status)) { handoffReservations.delete(h.recipient.sessionId); handoffProblems.delete(h.id); }
      return h;
    }
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
  const denialDeliveryId = (id: string, runId: string) => `handoff-denial:${id}:${runId}`;
  const denialReconciliations = new Map<string, Promise<void>>();
  function reconcileHandoffDenial(workspaceId: string, id: string): Promise<void> {
    const pending = denialReconciliations.get(id);
    if (pending) return pending;
    // The poller and lifecycle callback can observe acceptance concurrently.
    // Coalesce them so an old reconciliation cannot release a newer reservation.
    const task = Promise.resolve().then(() => reconcileHandoffDenialOnce(workspaceId, id)).finally(() => { denialReconciliations.delete(id); });
    denialReconciliations.set(id, task);
    return task;
  }
  async function reconcileHandoffDenialOnce(workspaceId: string, id: string) {
    const domain = (await router!.forWorkspace(workspaceId)).domain;
    const h = domain.getHandoff(id), notification = domain.getHandoffDenialNotification(id);
    if (notification && retirementPaused(notification.sessionId)) return;
    if (h.recipient.ownerId !== store.manifest.storeId || notification?.state !== "claimed") return;
    handoffReservations.add(notification.sessionId);
    const advance = (state: "accepted" | "wrapper-completed" | "not-submitted") => {
      handoffMutation(() => domain.recordHandoffDenialNotification(id, { ...notification, state }, { actor: { kind: "system" }, correlationId: id }));
      handoffReservations.delete(notification.sessionId);
      if (state === "accepted" || state === "wrapper-completed") handoffProblems.delete(id);
    };
    const run = meta.runs.find(r => r.runId === notification.runId && r.sessionId === notification.sessionId);
    if (!run) {
      if (owners.has(notification.sessionId) || admitting.has(notification.sessionId) || storageFailed) return;
      // A crash after claiming but before publishing a run is retryable only
      // when the original journal proves it never crossed native submission.
      try {
        const raw = await readFile(join(options.dataDir, `${notification.runId}.jsonl`), "utf8");
        const records = raw ? decodeLog(raw, { runId: notification.runId, sessionId: notification.sessionId } as Run).events : [];
        if (records.some(e => e.kind !== "submission" && !(e.kind === "status" && (e.data as { status?: string } | null)?.status === "running" && Object.keys((e.data ?? {}) as object).length === 1))) {
          await recordHandoffProblem(workspaceId, id, "Denial notification has an unpublished run with uncertain submission; no automatic resend."); return;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          await recordHandoffProblem(workspaceId, id, "Denial notification journal is unreadable; no automatic resend."); return;
        }
      }
      advance("not-submitted"); return;
    }
    const evidence = exchangeDeliveryEvidence({ id: denialDeliveryId(id, notification.runId), commandId: notification.commandId,
      native: h.sender, sessionId: notification.sessionId, runId: notification.runId }, run, journalEvents(run.runId));
    if (evidence === "accepted") {
      await serial;
      if (!storageFailed) advance("accepted");
    } else if (evidence === "wrapper-completed" && grokWrapperCompletion(h.sender, run, journalEvents(run.runId), `denial:${id}`)) {
      await serial;
      if (!storageFailed) advance("wrapper-completed");
    } else if (evidence === "not-submitted" && owners.get(notification.sessionId)?.settled !== false) advance("not-submitted");
    else await recordHandoffProblem(workspaceId, id, "Denial recorded; sender notification acceptance is unconfirmed. The original notification will not be resent.");
  }
  async function dispatchHandoffDenial(workspaceId: string, id: string) {
    const domain = (await router!.forWorkspace(workspaceId)).domain;
    const h = domain.getHandoff(id), notification = domain.getHandoffDenialNotification(id);
    if (h.recipient.ownerId !== store.manifest.storeId || h.status !== "failed" || h.runId
      || notification?.state === "accepted" || notification?.state === "wrapper-completed" || notification?.state === "claimed") return;
    // Only definite non-submission can retry, with a bounded retry cadence.
    if (notification && Date.now() - Date.parse(notification.updatedAt) < 30_000) return;
    const session = meta.sessions.find(s => toNativeHarness(sessionHarness(s)) === h.sender.harness
      && s.authorityId === h.sender.authorityId && s.nativeSessionId === h.sender.nativeId);
    if (!session) throw new WorkstreamAdapterError(409, "handoff-sender-unavailable", "Denial recorded; the original sender is unavailable. Notification remains pending.");
    if (retirementPaused(session.sessionId)) return;
    const descriptor = requireOperation(sessionHarness(session), "prompt");
    if (session.attachment && descriptor.policies.attachedSendRequiresNativeStopped) throw new WorkstreamAdapterError(409, "native-acknowledgement-required", "Denial recorded; automatic notification cannot resume an attached Claude conversation without an external-stopped acknowledgement.");
    if (session.hidden || workerStore.suppressed(session.sessionId) || handoffReservations.has(session.sessionId) || handoffDispatches.has(session.sessionId)) return;
    const admission = admissions.get(session.sessionId);
    if (!admission || admission.state !== "ready" || admission.binding.workspaceId !== workspaceId
      || admission.binding.domain.mode !== "repository" || admission.binding.domain.repositoryId !== h.repositoryId
      || admission.nativeId !== h.sender.nativeId || admission.source.authorityId !== h.sender.authorityId
      || admission.source.descriptor.harness !== h.sender.harness) throw new WorkstreamAdapterError(409, "handoff-sender-changed", "Denial recorded; the original sender admission must be reconciled before notification.");
    if (!availability(session.sessionId, true, true).canSend) return;
    const lease = reserve({ kind: "handoff", requestId: `denial:${id}` }, session.sessionId);
    try {
      const snapshot = dispatchSnapshot(session);
      const cwd = await execution(session.sessionId);
      if (session.harness === "opencode") await oc.assertIdle(session.nativeSessionId!, cwd);
      const ready = coordinator.inspectReadiness({ conversationId: session.sessionId, intent: { kind: "handoff", requestId: `denial:${id}` }, phase: "dispatch", lease });
      if (!ready.ready || session.hidden || workerStore.suppressed(session.sessionId) || handoffReservations.has(session.sessionId) || handoffDispatches.has(session.sessionId)) return;
      assertDispatchSnapshot(session.sessionId, snapshot);
      domain.assertConversationWritable(h.sender);
      const { run, commandId } = newDispatchRun({ ...session, cwd });
      handoffMutation(() => domain.recordHandoffDenialNotification(id, { state: "claimed", sessionId: session.sessionId, runId: run.runId, commandId }, { actor: { kind: "system" }, correlationId: id }));
      handoffReservations.add(session.sessionId);
      const prompt = ["Handoff denied by the user", `Handoff ID: ${h.id}`, `Request ID: ${h.input.requestId}`,
        `Workstream: ${h.workstreamId}`, `Destination: ${h.input.to}`,
        "The user denied this handoff before dispatch. It was not sent to the recipient. The handoff is failed, not awaiting approval.",
        "User's denial reason:", h.evidence ?? "Operator denied handoff delivery",
        "Continue the discussion here with the user. Do not retry or replace this handoff without their direction."].join("\n\n");
      executePrompt(lease, session, run, prompt, true, "handoff", {
        // Reuse executor non-submission evidence and stop/hidden guards only;
        // this delivery is not a WorkerDelivery or a recipient handoff attempt.
        requestId: `denial:${id}`, workerDeliveryId: denialDeliveryId(id, run.runId),
        reconciliation: { order: "after-release", run: async () => { if (!storageFailed) await reconcileHandoffDenial(workspaceId, id); } },
      });
    } finally { coordinator.releaseAdmission(lease); }
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
      const { run, commandId } = newDispatchRun({ ...session, cwd });
      const dispatchId = session.harness === "grok" ? `app:grok:${run.runId}` : undefined;
      h = handoffMutation(() => domain.advanceHandoff(h.id, h.revision, { status: "acceptance_unknown", attemptId: crypto.randomUUID(),
        ...(dispatchId ? { dispatchId } : { nativeCommandId: commandId }), runId: run.runId }, { actor: { kind: "system" }, correlationId: h.id }, current => { handoffs.assertRecipientReady(current); }));
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
        requestId: h.id,
        ...(h.input.createNew && !session.lastRunId ? { messageIntent: { kind: "assistant-activation" as const,
          source: `handoff:${h.id}/attempt:${h.attemptId}`, assertCurrent: () => {
            const current = domain.getHandoff(h.id);
            if (!current.input.createNew || current.attemptId !== h.attemptId || current.runId !== run.runId
              || (dispatchId ? current.dispatchId !== dispatchId || current.nativeCommandId !== null : current.nativeCommandId !== commandId)) throw new WorkstreamAdapterError(409, "context-source-changed", "Original handoff-created activation changed");
          } } } : {}),
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
      let deliveries, denials;
      try {
        deliveries = await handoffs.listForPolling(w.workspaceId);
        denials = await handoffs.denialsForPolling(w.workspaceId);
        handoffPollFailures.delete(w.workspaceId);
      } catch {
        const delay = Math.min((failure?.delay ?? 2500) * 2, 30000);
        handoffPollFailures.set(w.workspaceId, { fingerprint, delay, retryAt: performance.now() + delay });
        continue;
      }
      for (const h of deliveries.filter(h => !retirementPaused(h.recipient.sessionId) && h.recipient.ownerId === store.manifest.storeId && !["awaiting_approval", "queued", "completed", "failed"].includes(h.status))) handoffReservations.add(h.recipient.sessionId);
      for (const h of denials.filter(h => h.recipient.ownerId === store.manifest.storeId)) {
        if (closing || storageFailed) return;
        try {
          await reconcileHandoffDenial(w.workspaceId, h.id);
          await dispatchHandoffDenial(w.workspaceId, h.id);
        } catch (error) {
          if (storageFailed) throw error;
          await recordHandoffProblem(w.workspaceId, h.id, error instanceof Error ? error.message : "Denial recorded; sender notification remains pending.");
        }
      }
      for (const h of deliveries.filter(h => h.recipient.ownerId === store.manifest.storeId && !["awaiting_approval", "completed", "failed"].includes(h.status))) {
        if (closing || storageFailed) return;
        if (retirementPaused(h.recipient.sessionId)) continue;
        try {
          // Pre-dispatch approval gate: awaiting_approval never dispatches or
          // reconciles until an explicit human allow moves it to queued.
          if (h.status === "awaiting_approval") continue;
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
    assertCatalogActive(meta.sessions.find(s => s.sessionId === sessionId));
    // Removal is independent of execution, branch/lifecycle pauses, hidden
    // state and pin drift. It only edits an unclaimed App waiter under our lock.
    if (action === "remove") return;
    const session = meta.sessions.find(s => s.sessionId === sessionId);
    if (!session) throw new PendingInputDomainError("pending-input-not-found", "Unknown conversation", 404);
    if (session.hidden) throw new PendingInputDomainError("pending-input-hidden", "Unhide the conversation before adding/resuming waiting input");
    if (sessionHarness(session) === "claude-code" && session.attachment) throw new PendingInputDomainError("pending-input-attached-cc", "Attached Claude input requires a fresh external-stopped acknowledgement; queued automation is not supported");
    // Legacy immediate/followup reservations cannot race the new FIFO domain.
    if (admitting.has(sessionId) || projectClaudeFollowups(sessionId, meta.runs, id => journalEvents(id), id => claudeRuns.followupPending(id)).some(r => claudeRuns.followupPending(r.requestId))) throw new PendingInputDomainError("pending-input-legacy-reservation", "Finish the existing admission/legacy followup before starting a FIFO chain");
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
      await router!.execution(a, { signal });
      basic();
      const adapter = await router!.forAdmission(a, undefined, { signal });
      basic();
      // App-only repository admissions must be explicitly enrolled when a domain
      // appears; do not silently promote/rebind an immutable queue authority.
      if (!adapter && a.binding.checkoutPin) {
        const inspected = await router!.inspect(a.binding.workspaceId, { signal });
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
    if (!["claude-code", "grok"].includes(source.harnessId) || !sameDispatchSource(source, dispatchSource(session))) throw new PendingInputDomainError("source-changed", "Current App idle source differs from the captured queue source");
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
    if (workers.hasBlockingDescendants(id) || workerStore.hasActiveDelivery(id) || workerStore.hasActiveExchange(id))
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
      || source.harnessId === "claude-code" && claudeRuns.followupPending(run.queuedFollowupId ?? "")))) return blocked("Other App running metadata or followup remains unresolved");
    if (pendingInputs!.store.readRecords().conversations.filter(c => c.conversationId === id).some(c => c.items.some(item =>
      ["claimed", "run-linked"].includes(item.state) && (!own || !item.claim || item.claim.possibleNative || item.claim.uncertain || !equalPendingPin(item.claim.identity, own.identity)))))
      return blocked("Another unresolved App queue claim remains held");
    // Fresh aggregate service observation at EVERY boundary; no preclaim cache.
    // Its sole exclusion is the exact private owner above, before intent writes.
    if (source.harnessId === "grok") {
      // Only a fresh unattempted queue owner is excluded above. Actual process
      // closure/executable/source readiness is read asynchronously before claim.
      const observed = own?.owner && grokRuns.observation(own.owner);
      if (observed && (observed.submission !== "not-submitted" || observed.wrapperCompletion !== "not-started")) return blocked("Grok local process has already been attempted");
      return { ready: true };
    }
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
    groupAlive: claudeGroupAlive, readLocalSettlement: owner => {
      const session = meta.sessions.find(s => s.sessionId === owner.run.sessionId);
      if (session?.harness !== "claude-code") return { ready: false, reason: "Claude settlement requires a Claude run", code: "claude-local-unproven" };
      return claudeRuns.readLocalSettlement(owner);
    }, readGrokSettlement: (owner, source) => grokRuns.successfulSettlement(owner, source), currentAppIdle: queueCurrentAppIdle, failClosed,
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
    hasWork: () => pendingInputs!.store.hasPendingWork() && pendingInputs!.store.readRecords().conversations.some(c => !retirementPaused(c.conversationId)),
    poll: () => pendingInputBridge!.consumer.poll(), onError: failClosed,
  }, options.pendingInputWakeClock);
  // The outer owner starts this only after publishing both serving lock records.
  const pendingInputConsumer = pendingInputBridge.consumer;
  const userQuestionsDelivery = new UserQuestionsDelivery({
    store: { pending: () => userQuestions.pending().filter(form => !retirementPaused(form.sessionId)), getById: id => userQuestions.getById(id), delivery: (...args) => userQuestions.delivery(...args), recover: () => userQuestions.recover() }, coordinator,
    available: () => startupReady && !closing && !storageFailed && !retainOwner && ownsStorage(),
    failClosed: error => failClosed(error, "user-questions-delivery"),
    readiness: form => {
      try { assertUserQuestionsRespondent(form); }
      catch (error) {
        if (error instanceof UserQuestionsError && error.code !== "user-questions-storage") return { ready: false, disposition: "pause", reason: error.message };
        throw error;
      }
      const owner = owners.get(form.sessionId);
      if (owner?.stopRequested || owner?.cancelling || owner?.stopping) return { ready: false, disposition: "pause", reason: "Conversation was stopped; resume answer delivery explicitly" };
      if (form.native.harness === "gk" && (!owner || owner.run.runId === form.delivery?.runId && !owner.nativeDispatched)) {
        const session = meta.sessions.find(s => s.sessionId === form.sessionId)!;
        if (!owner && session.lastStatus === "running") return { ready: false, disposition: "wait", reason: "Grok still has unresolved local execution" };
        if (owner && grokRuns.observation(owner)?.submission !== undefined && grokRuns.observation(owner)?.submission !== "not-submitted") return { ready: false, disposition: "wait", reason: "Grok response delivery has already been attempted" };
      }
      if (form.native.harness === "cc" && (!owner || owner.run.runId === form.delivery?.runId && !owner.nativeDispatched)) {
        const idle = claudeRuns.readLocalIdle(form.sessionId, owner);
        if (!idle.ready) return { ready: false, disposition: "wait", reason: idle.reason };
      }
      return { ready: true };
    },
    classifyError: error => {
      if (error instanceof UserQuestionsDeliveryDeferred) return error.denial;
      if (error instanceof UserQuestionsError && error.code !== "user-questions-storage") return { ready: false, disposition: "pause", reason: error.message };
      if (error instanceof UserInputPreparationError || error instanceof WorkstreamAdapterError || error instanceof WorkspaceError || error instanceof OpenCodeError) {
        if (error instanceof WorkstreamAdapterError && ["STORAGE_ERROR", "CORRUPT_STORE"].includes(error.code)
          || error instanceof WorkspaceError && error.code === "catalog-storage") return undefined;
        const code = "code" in error ? error.code : undefined;
        const wait = typeof code === "string" && ["conversation-busy", "capacity", "native-busy", "dispatch-proof-unavailable", "pending-input-chain-active", "worker-delivery-pending", "worker-exchange-pending", "handoff-pending", "reconciliation-pending"].includes(code);
        return { ready: false, disposition: wait ? "wait" : "pause", reason: error.message } satisfies UserQuestionsDeliveryDenial;
      }
      return undefined;
    },
    dispatch: async (form, context) => {
      const guard = (action: () => void) => {
        try { action(); }
        catch (error) {
          if (error instanceof UserQuestionsDeliverySuperseded) throw new WorkstreamAdapterError(409, "user-questions-superseded", error.message);
          if (error instanceof UserQuestionsDeliveryDeferred) throw new WorkstreamAdapterError(409, "user-questions-deferred", error.message);
          if (error instanceof UserQuestionsError && error.code !== "user-questions-storage") throw new WorkstreamAdapterError(error.status, error.code, error.message);
          throw error;
        }
      };
      guard(context.assertCurrent);
      const prepared = await prepareUserInput({ sessionId: form.sessionId, prompt: context.prompt }, {
        ...preparationState(), defaultCwd: options.cwd, conversationId: () => crypto.randomUUID(), sourceAuthorityId: nativeSource,
        selectedDirectory: async (workspaceId, worktreeId) => (await catalog.binding(workspaceId, worktreeId)).cwd,
        ensureDirectory, validateOpenCodeModel: (model, effort) => oc.model(model, effort), resolveOpenCodeLaunch: (cwd, settings) => oc.resolveLaunch(cwd, settings),
      });
      guard(context.assertCurrent);
      if (context.signal.aborted) throw new WorkstreamAdapterError(409, "user-questions-deferred", "Answer delivery paused during shutdown");
      if (!sameDispatchSource(context.source, { harnessId: prepared.binding.harness, sessionId: prepared.binding.conversationId,
        authorityId: prepared.binding.authorityId, nativeSessionId: prepared.binding.nativeSessionId ?? null, cwd: prepared.binding.cwd }))
        throw new WorkstreamAdapterError(409, "user-questions-source-changed", "The form's original native conversation changed");
      const runId = crypto.randomUUID(), nativeCommandId = form.native.harness === "oc" ? `msg_${crypto.randomUUID().replaceAll("-", "")}` : undefined;
      const result = await preparedInput.admit(prepared, context.lease, { context: {
        origin: context.origin, intent: context.intent, delivery: "idle-only", runId, ...(nativeCommandId ? { nativeCommandId } : {}),
        validate: () => guard(context.assertCurrent), link: identity => guard(() => context.link(identity)), evidence: context.evidence,
      } });
      // Default not-submitted at admission is NOT withholding proof. The original
      // synchronous hooks will record the real native boundary and outcome later.
      return result.lifecycle.submissionEvidence();
    },
    reconcile: async form => {
      const delivery = form.delivery!;
      if (!delivery.runId) return null;
      const run = meta.runs.find(candidate => candidate.sessionId === form.sessionId && candidate.runId === delivery.runId);
      if (!run || run.cwd !== form.cwd || (run.nativeCommandId ?? null) !== delivery.nativeCommandId || run.operation === "compact") return null;
      if (form.native.harness === "gk") {
        if (delivery.nativeCommandId !== null || !grokWrapperCompletion(form.native, run, journalEvents(run.runId), delivery.id)) return null;
        return { wrapperCompleted: true, evidence: { requestId: delivery.id, runId: run.runId, nativeCommandId: null,
          source: { harnessId: "grok", sessionId: form.sessionId, authorityId: form.native.authorityId, nativeSessionId: form.native.nativeId, cwd: form.cwd },
          submission: "submitted", nativeAcceptance: "unknown" } };
      }
      const accepted = form.native.harness === "oc" ? run.nativePhase === "accepted" && !!delivery.nativeCommandId
        : journalEvents(run.runId).some(event => event.kind === "stdout" && isClaudeRootRecord(event.data)
          && (event.data as any)?.session_id === form.native.nativeId && (event.data as any)?.type === "result"
          && ((event.data as any).user_message_uuid === run.runId
            || Array.isArray((event.data as any).user_message_uuids) && (event.data as any).user_message_uuids.includes(run.runId)));
      if (!accepted) return null;
      return { evidence: { requestId: delivery.id, runId: run.runId, nativeCommandId: delivery.nativeCommandId,
        source: { harnessId: toSessionHarness(form.native.harness), sessionId: form.sessionId,
          authorityId: form.native.authorityId, nativeSessionId: form.native.nativeId, cwd: form.cwd },
        submission: "submitted", nativeAcceptance: "accepted" } };
    },
  });
  /** Observe only the selected worker. Never launch, resume, compact, or dispatch. */
  async function observeWorkerState(record: WorkerRecord, modelLookups = new Map<string, ReturnType<typeof oc.models>>()): Promise<WorkerStateSnapshot> {
    let worker: WorkerRecord;
    try { worker = await workers.refresh(record); }
    catch (error) {
      // Classify by the authoritative write boundary, not native/network errno codes.
      if (error instanceof WorkerStorageError) throw new PendingInputStorageError(error.message, error);
      throw error;
    }
    const session = meta.sessions.find(s => s.sessionId === worker.sessionId);
    const snapshot: WorkerStateSnapshot = { worker, latestRun: null, toolCallCount: null, directWorkerCount: 0, contextUsage: null, revision: null, observedAt: new Date().toISOString(), warnings: [] };
    if (session) {
      ensureSessionJournals(session.sessionId);
      // Transcript/storage errors must not become apparently successful partial snapshots.
      const summary = await transcripts.stateSummary(session);
      snapshot.latestRun = summary.latestRun; snapshot.toolCallCount = summary.toolCallCount;
      snapshot.contextUsage = summary.usage; snapshot.revision = summary.revision;
      if (session.harness === "opencode" && snapshot.contextUsage) {
        try {
          let models = modelLookups.get(session.cwd);
          if (!models) { models = oc.models(session.cwd); modelLookups.set(session.cwd, models); }
          const capacity = (await models).find(model => model.id === snapshot.contextUsage!.model)?.contextWindow;
          if (capacity) snapshot.contextUsage = { ...snapshot.contextUsage, capacity, percentage: snapshot.contextUsage.tokens / capacity * 100 };
        } catch (error) {
          if (error instanceof PendingInputStorageError || error instanceof TranscriptError) throw error;
          snapshot.warnings.push("Model window capacity unavailable; context percentage cannot be calculated.");
        }
      }
    }
    snapshot.worker = workerStore.get(record.id)!;
    snapshot.directWorkerCount = workerStore.directWorkerCount(snapshot.worker.sessionId);
    snapshot.observedAt = new Date().toISOString();
    return snapshot;
  }
  const assertAppAdmissionStorage = () => {
    assertStorageOwned();
    if (storageFailed) throw new Error("App admission storage ownership is unavailable");
  };
  function assertAppAdmissionExpectedSource(intent: AppAdmissionIntent, source: DispatchIdentity["source"]) {
    const expected = intent.expectedSource;
    if (intent.operation === "new-conversation") {
      // Native creation has no browser-native identity yet. The server-reserved
      // binding, prepared launch and pinned installation source still govern it.
      if (expected !== null || source.authorityId !== nativeSource(source.harnessId)) throw new AppAdmissionRequestError("target-conflict", "New conversation differs from the pinned native source");
      return;
    }
    if (!expected || source.sessionId !== intent.conversationId || !appAdmissionExpectedSourceMatches(expected, source)
      || source.authorityId !== nativeSource(source.harnessId)) throw new AppAdmissionRequestError("target-conflict", "The original frozen conversation source changed; no replacement submission is allowed");
  }
  const admissionSetupPorts = { enqueue, assertStorage: assertAppAdmissionStorage,
    failClosed: (error: AppAdmissionStorageError) => failClosed(error, "app-admission-storage") };
  if (options.initializeAppAdmissions) await initializeAppAdmissionFeature(options.dataDir, store.manifest.storeId, admissionSetupPorts, originalAppAdmissionRoot);
  let appAdmissionFeature: ReturnType<typeof readAppAdmissionFeature>;
  try { appAdmissionFeature = readAppAdmissionFeature(options.dataDir, store.manifest.storeId, originalAppAdmissionRoot); }
  catch (error) { failClosed(error, "app-admission-feature"); throw error; }
  if (appAdmissionFeature.state === "enabled") appAdmissions = new AppAdmissionService(options.dataDir, store.manifest.storeId, {
    ...admissionSetupPorts,
    assertStorage: () => { assertAppAdmissionStorage(); appAdmissionFeature.assertCurrent(); },
    assertCanBegin: (envelope, _pending, binding) => {
      const { intent } = envelope, input = intent.payload;
      // Existing envelopes are decoded/looked up by the store without entering
      // this new-intake hook. Retirement must not erase their recovery evidence.
      if (intent.operation === "science-message" || Object.hasOwn(input, "scienceSnapshots")) throw new AppAdmissionRequestError("science-chat-retired", "Science chat has been retired; saved submission history remains available");
      assertAppAdmissionEligibility(assertStartupReady);
      const allowed = ["prompt", "sessionId", "nativeStopped", "harness", "cwd", "workspaceId", "worktreeId", "model", "effort", "agent", "profileId"];
      if (Object.keys(input).some(key => !allowed.includes(key)) || typeof input.prompt !== "string"
        || !input.prompt.trim()
        || /^\s*\/compact(?:\s|$)/i.test(input.prompt) || input.nativeStopped !== undefined && typeof input.nativeStopped !== "boolean") throw new AppAdmissionRequestError("invalid-request", "Invalid ordinary submission payload", 400);
      for (const key of ["sessionId", "harness", "cwd", "workspaceId", "worktreeId", "model", "effort", "agent", "profileId"] as const) {
        if (input[key] !== undefined && typeof input[key] !== "string") throw new AppAdmissionRequestError("invalid-request", "Invalid ordinary submission selection", 400);
      }
      if (binding.kind === "server-provisional") {
        if (Object.hasOwn(input, "sessionId") || meta.sessions.some(session => session.sessionId === binding.conversationId) || admissions.get(binding.conversationId)) throw new AppAdmissionRequestError("target-conflict", "Reserved conversation must be new and cannot adopt an existing identity");
      } else {
        if (input.sessionId !== intent.conversationId || binding.conversationId !== intent.conversationId) throw new AppAdmissionRequestError("invalid-request", "Submission conversation differs from its frozen intent", 400);
        const session = meta.sessions.find(session => session.sessionId === binding.conversationId);
        assertAppAdmissionEligibility(() => assertCatalogActive(session));
        if (!session) throw new AppAdmissionRequestError("target-conflict", "The original conversation is unavailable");
        assertAppAdmissionExpectedSource(intent, dispatchSource(session));
      }
      if (intent.operation === "live-input") {
        const owner = owners.get(binding.conversationId);
        const liveSession = meta.sessions.find(s => s.sessionId === binding.conversationId);
        if (liveSession?.harness === "grok" || !owner || owner.run.runId !== intent.expectedLiveRunId || !claudeRuns.canSendInput(owner)) throw new AppAdmissionRequestError("target-conflict", "The selected live run changed or is no longer eligible");
      }
      const decision = coordinator.inspectReadiness({ conversationId: binding.conversationId, intent: { kind: "user-prompt" }, phase: intent.operation === "live-input" ? "enqueue" : "admission" });
      if (!decision.ready) throw new AppAdmissionRequestError(decision.code === "capacity" ? "capacity" : "pending-admission", decision.reason, decision.code === "capacity" ? 429 : 409);
      if (pendingInputs?.hasChain(binding.conversationId)) throw new AppAdmissionRequestError("pending-admission", "A durable input chain already owns this conversation");
    },
  });
  function originalSubmissionPublication(original: OriginalAppAdmission): SubmissionPublicationFactory {
    return owner => {
      if (!appAdmissions) throw new Error("App admission is unavailable");
      const originalMetadata = ownerMetadata.get(owner);
      if (!originalMetadata) throw new Error("Original dispatch metadata association is unavailable");
      const identity = originalMetadata.identity;
      return appAdmissions.publication(original, (envelope, supplied) => {
        const bound = decodeContextMessageSubmission(supplied);
        if (!isDeepStrictEqual(bound.composition.dispatch, identity)) throw new Error("Bound submission differs from its original dispatch");
        assertAppAdmissionExpectedSource(envelope.intent, identity.source);
        const expectedBody = envelope.intent.payload.prompt, range = bound.composition.body.range;
        if (typeof expectedBody !== "string" || Buffer.from(bound.text, "utf8").subarray(range.offset, range.offset + range.length).toString("utf8") !== expectedBody) throw new Error("Bound authored body differs from the immutable App intent");
        const live = bound.liveInput === true;
        let nativeMessageId: string;
        if (identity.source.harnessId === "claude-code") {
          const prefix = `${identity.runId}:user:`;
          nativeMessageId = live && bound.messageId.startsWith(prefix) ? bound.messageId.slice(prefix.length) : identity.runId;
          if (!uuid(nativeMessageId) || (!live && bound.messageId !== `${identity.runId}:user`) || live && bound.messageId !== prefix + nativeMessageId) throw new Error("Actual Claude message UUID correlation is unavailable");
        } else {
          if (live || !identity.nativeCommandId || bound.messageId !== identity.nativeCommandId) throw new Error("Actual native command correlation is unavailable");
          nativeMessageId = identity.nativeCommandId;
        }
        const target = decodeAppAdmissionTarget({ kind: live ? "live-input" : "run-initial", dispatch: identity, messageId: bound.messageId, nativeMessageId });
        const standards = (events.get(identity.runId) ?? []).filter(event => event.kind === "submission" && (event.data as { messageId?: unknown })?.messageId === bound.messageId);
        const standard = standards[0];
        if (standards.length !== 1 || !standard || !isDeepStrictEqual(decodeContextMessageSubmission(standard.data), bound)) throw new Error("Original actual submission journal reservation is unavailable");
        const reservation = runJournals.reservation(standard);
        const metadataReceipt = originalMetadata.receipt;
        if (!metadataReceipt) throw new Error("Original metadata was not durably committed");
        const assertCurrent = () => {
          assertAppAdmissionStorage();
          // Compare only the ORIGINAL dispatch proof, never a replacement owner
          // resolved by conversation ID at publication or the native boundary.
          assertAppAdmissionExpectedSource(envelope.intent, identity.source);
          metadataPublisher.assertOriginalAssociation(metadataReceipt, identity);
          // The original writer already owns the exact reservation and bytes.
          // Its durable fence verifies identity, content and fsync without a
          // second inspector decoding and reconstructing this same journal.
          runJournals.flushThrough(reservation);
        };
        return Object.freeze({ target, assertCurrent });
      });
    };
  }
  const assetRoute = createAssetRoute({ assetsDir, assetManifest });
  const agentProfileRoute = createAgentProfileRoute({ readProfiles: () => agentProfiles, commitProfiles: commitAgents });
  const browserPairRoute = createBrowserPairRoute({ storeId: store.manifest.storeId, browserPairs, catalog,
    findSession: id => meta.sessions.find(session => session.sessionId === id), sessionHarness: pairSessionHarness, nativeSource,
    assertDomainMutationOpen, authenticated: req => auth.authenticated(req), assertCatalogActive,
    isWorkerSession: id => workerStore.hasSession(id),
    branchReplaced: id => !!branches.replaced(id), branchPending: id => !!branches.pending(id),
  });
  const terminalRoute = createTerminalRoute({ terminals, terminalToken: req => auth.terminalToken(req),
    readOrigin: () => origin, closing: () => closing });
  const workspaceRoute = createWorkspaceRoute({ catalog, workspace, worktrees, workspaceCreations: workspaceCreations!,
    gitOperations: gitOperations!, searches, authenticated: req => auth.authenticated(req),
    terminalToken: req => auth.terminalToken(req), assertDomainMutationOpen,
    canCreate: req => !closing && auth.authenticated(req),
    canRunGit: (req, token) => !closing && !storageFailed && !retainOwner && !meta.reconciliationRequired && startupReady && !!token && auth.terminalToken(req) === token,
    withWorktreeRemoval: async (workspaceId, worktreeId, remove) => {
      assertStorageOwned();
      assertDomainMutationOpen();
      const key = `${workspaceId}/${worktreeId}`;
      if (imageUploadWorktrees.has(key) || imageUploadRemovals.has(key)) throw new WorkspaceError(409, "worktree-busy", "Wait for image uploads or removal in this worktree to finish");
      // Reserve synchronously before terminal cleanup or catalog queue awaits.
      imageUploadRemovals.add(key);
      try { return await remove(); } finally { imageUploadRemovals.delete(key); }
    },
    beforeRemoveWorktree: async (workspaceId, worktreeId) => {
      if (imageUploadWorktrees.has(`${workspaceId}/${worktreeId}`)) throw new WorkspaceError(409, "worktree-busy", "Wait for image uploads in this worktree to finish before removing it");
      const admittingSession = meta.sessions.find(s => {
        const a = catalog.association(s.sessionId);
        return a.association === "resolved" && a.workspaceId === workspaceId && a.worktreeId === worktreeId && admitting.has(s.sessionId);
      });
      if (admittingSession) throw new WorkspaceError(409, "worktree-busy", "Wait for the in-flight message submission in this worktree to finish before removing it");
      await terminals.disposeWorktree(workspaceId, worktreeId);
    },
  });
  const imageUploadService = new ImageUploadService(options.dataDir, worktrees);
  const imageUploadPrincipals = new WeakMap<Request, string>();
  const imageUploadRoute = createImageUploadRoute({ service: imageUploadService,
    authenticated: req => {
      const principal = imageUploadPrincipals.get(req);
      return !!principal && auth.authenticated(req) && auth.validTerminalToken(principal) && auth.terminalToken(req) === principal;
    },
    assertOpen: () => {
      imageUploads.assertOpen();
      assertStorageOwned();
      assertDomainMutationOpen();
      if (closing || !ownsStorage()) throw new WorkspaceError(503, "image-upload-unavailable", "Image upload ownership is unavailable");
    },
    run: (signal, action) => imageUploads.run(signal, action),
  });
  const nativeSubagentEvidenceRoute = createNativeSubagentEvidenceRoute({ nativeSubagents, nativeSubagentRecorder,
    findSession: id => meta.sessions.find(session => session.sessionId === id),
    findRun: (runId, sessionId) => meta.runs.find(run => run.runId === runId && run.sessionId === sessionId),
  });
  const transcriptEvidenceRoute = createTranscriptEvidenceRoute({ transcripts,
    findSession: id => meta.sessions.find(session => session.sessionId === id), ensureSessionJournals,
  });
  const runEvidenceRoute = createRunEvidenceRoute({ sessionRunPreviews, auth, storeId: store.manifest.storeId,
    findSession: id => meta.sessions.find(session => session.sessionId === id),
    findRun: id => meta.runs.find(run => run.runId === id),
    runsForSession: id => meta.runs.filter(run => run.sessionId === id), journalEvents,
    readProtectedContext: run => contextHistory.read(run),
    readPreparationTiming: run => {
      const owner = owners.get(run.sessionId);
      const active = owner?.run === run ? readOwnerPreparationTiming(owner) : undefined;
      return { active, archived: active === undefined ? preparationTimingArchive.read(run.runId) : undefined };
    },
  });
  const conversationSearchRoute = createConversationSearchRoute({ activeSessions, catalog,
    runsForSession: id => meta.runs.filter(run => run.sessionId === id), journalEvents, storedNativeHistory,
  });
  const sessionCatalogRoute = createSessionCatalogRoute({ selection: sessionCatalog,
    registeredWorkspaces: async () => (await catalog.registeredWorkspaces()).workspaces,
    registeredWorkspace: id => catalog.registered(id), association: id => catalog.association(id),
    current: () => ({ sessions: meta.sessions.map(session => grokApp!.overlay(session)), active: activeSessions().map(session => grokApp!.overlay(session)),
      runs: [...meta.runs, ...grokApp!.presentationRuns()], events }),
    openMembership: async workspaceId => {
      try {
        const adapter = await router!.forPolling(workspaceId);
        return sessions => adapter.overview(sessions);
      } catch (error) {
        // No repository domain means unknown, never confirmed unassigned.
        // Actual read failures must not silently masquerade as empty data.
        if ((error instanceof WorkstreamAdapterError && error.code === "not-repository") || (error instanceof RepositoryStoreError && error.state === "uninitialized")) return undefined;
        throw error;
      }
    },
    capturePresentation: () => {
      nativeActivityDemandUntil = Date.now() + 90_000;
      nativeActivitySnapshot.refresh();
      // Only fresh cached display evidence may overlay App metadata; refresh is
      // deferred, never awaited, and a cold/stale/failed read remains unknown.
      const native = nativeActivitySnapshot.read();
      const indexes = sessionListProjection(workerStore.sessionListWorkers().filter(worker => !retiredId(worker.sessionId)), workerStore.sessionListDeliveries().filter(delivery => !retiredId(delivery.parentSessionId)), branches.list(), [
        ...recoveredInputConversations, ...handoffDispatches.keys(),
        ...meta.runs.filter(run => run.status === "running").map(run => run.sessionId),
      ]);
      presentationAdmissions.set(indexes, appAdmissions?.readPending() ?? []);
      return { native, indexes };
    },
    projectRow: (session, summary, read): SessionListRow => {
      if (session.harness === "grok") {
        const projected = grokApp!.overlay(session);
        const configured = grokApp!.capability();
        return { session: projected, association: catalog.association(session.sessionId),
          availability: !configured.configured ? { canSend: false, reason: configured.reason }
            : projected.lastStatus === "running" ? { canSend: false, code: "conversation-busy", reason: "Grok is processing this turn" }
              : availability(session.sessionId, true, false, false, "user", read) };
      }
      const observedAt = historyRefreshes.get(session.sessionId);
      const owner = owners.get(session.sessionId);
      const activity = observedAt ? { phase: "refreshing" as const, observedAt }
        : owner && session.harness === "claude-code" ? claudeRuns.activity(owner) : undefined;
      return { session, activity, updateSource: replyIntegration?.updateSource(session.sessionId),
        // Presentation only: authoritative policy uses one verified pending
        // snapshot for this synchronous response, not one ledger scan per row.
        admission: summary ? undefined : admissions.get(session.sessionId), association: catalog.association(session.sessionId),
        availability: availability(session.sessionId, true, false, false, "user", read) };
    },
    globalAvailability: read => availability(undefined, true, false, false, undefined, read),
    followupPending: id => claudeRuns.followupPending(id), isRetired: session => retirements.isRetired(session),
    isWorkerSession: id => workerStore.hasSession(id),
  });
  const workstreamRoute = createWorkstreamRoute({ authenticated: req => auth.authenticated(req),
    inspect: workspaceId => router!.inspect(workspaceId),
    initialize: async workspaceId => {
      const result = await router!.initialize(workspaceId);
      notifyPendingInput("domain");
      return result;
    },
    artifacts: (workspaceId, repositoryId) => router!.forWorkspace(workspaceId, repositoryId),
    open: async (workspaceId, readOnly) => {
      const workstreams = await (readOnly ? router!.forPolling(workspaceId) : router!.forWorkspace(workspaceId));
      return {
        overview: () => workstreams.overview(activeSessions().filter(s => catalog.association(s.sessionId).workspaceId === workspaceId)),
        list: () => workstreams.list(), status: id => workstreams.status(id),
        manage: input => {
          const target = input.ref && workstreams.appSessionId(input.ref, meta.sessions);
          assertPendingInputDomainMutation(pendingInputs!.store.readRecords().conversations, workstreams.domain,
            input.operation === "phase/end" ? { kind: "phase/end", assignmentId: input.assignmentId }
              : input.operation === "associate" ? { kind: "associate", ref: input.ref, workstreamId: input.workstreamId } : { kind: "phase/assign", ref: input.ref });
          const available = availability(target || undefined, false);
          if (!available.canSend) throw new WorkstreamAdapterError(409, "bridge-busy", available.reason!);
          return queueDomainCommitted(() => workstreams.manage(input.ref, input.operation, input));
        },
        create: input => queueDomainCommitted(() => workstreams.create(input)),
        setDefaultCheckout: (id, checkout) => queueDomainCommitted(() => workstreams.setDefaultCheckout(id, checkout)),
        resolveTarget: (id, phase, target) => workstreams.resolveTarget(id, phase, target),
        session: async (operation, input) => {
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
        },
      };
    },
    action: async (workspaceId, operation, actionInput) => {
      let adapter = await router!.forWorkspace(workspaceId, actionInput.repositoryId);
      if (actionInput.sessionId !== undefined) {
        const session = meta.sessions.find(candidate => candidate.sessionId === actionInput.sessionId);
        if (!session) throw new WorkstreamAdapterError(404, "not-found", "Unknown App conversation");
        assertCatalogActive(session);
        const admission = admissions.get(session.sessionId);
        if (!admission || admission.binding.workspaceId !== workspaceId || admission.binding.domain.mode !== "repository" || admission.binding.domain.repositoryId !== actionInput.repositoryId) throw new WorkstreamAdapterError(409, "repository-mismatch", "Conversation and requested repository differ");
        if (session.nativeSessionId !== admission.nativeId || session.authorityId !== admission.source.authorityId || adapter.reference(session).harness !== admission.source.descriptor.harness) throw new WorkstreamAdapterError(409, "invalid-app-reference", "Conversation native identity differs from its admission");
        await router!.execution(admission);
        adapter = await router!.forWorkspace(workspaceId, actionInput.repositoryId);
        if (adapter.invocation(session).workstream?.id !== actionInput.id) throw new WorkstreamAdapterError(409, "workstream-mismatch", "Conversation belongs to another workstream");
      }
      if (adapter.status(actionInput.id).workstream.revision !== actionInput.expectedRevision) throw new DomainError("CONFLICT", "Workstream changed; refresh its current state before retrying");
      if (operation === "complete") {
        await adapter.complete(actionInput.id, actionInput.expectedRevision);
        return { action: "complete", id: actionInput.id, ok: true } satisfies WorkstreamCompleteResult;
      }
      const action: WorkstreamAction = operation, phaseInput = actionInput as WorkstreamActionInput;
      if (action === "validate") {
        const result = await adapter.validate(phaseInput.id, phaseInput.phase);
        return { action, phase: phaseInput.phase, ok: result.ok } satisfies WorkstreamActionResult;
      }
      // The adapter reserves at the actual backend call, covering callers other
      // than HTTP and enqueue/preflight throughout core's awaits.
      await adapter.provide(phaseInput.id, phaseInput.phase, false, phaseInput.expectedRevision);
      return { action, phase: phaseInput.phase, ok: true } satisfies WorkstreamActionResult;
    },
  });
  /** One original submission execution, shared by compatibility HTTP and future
   * durable intake. No Request/auth reentry, replay or receipt scheduling here. */
  async function submitUserInput(input: Awaited<ReturnType<typeof body>>, submissionPublication?: SubmissionPublicationFactory, originalSubmission?: OriginalSubmission): Promise<Response> {
    const originalIntent = originalSubmission?.envelope.intent;
    if (originalIntent?.operation === "science-message" || input && Object.hasOwn(input, "scienceSnapshots")) return json({ error: "Science chat has been retired; saved submission history remains available", code: "science-chat-retired" }, 409);
    if (originalSubmission?.binding.kind === "server-provisional"
      && (meta.sessions.some(session => session.sessionId === originalSubmission.binding.conversationId) || admissions.get(originalSubmission.binding.conversationId))) throw new AppAdmissionRequestError("target-conflict", "Reserved conversation collides with existing App state; it cannot be adopted");
    if (input?.sessionId) {
      const session = meta.sessions.find(s => s.sessionId === input.sessionId);
      assertCatalogActive(session);
      if (originalIntent) {
        if (!session) throw new AppAdmissionRequestError("target-conflict", "The original conversation is unavailable");
        assertAppAdmissionExpectedSource(originalIntent, dispatchSource(session));
      }
    }
    if (input?.sessionId && uuid(input.sessionId) && pendingInputs!.hasChain(input.sessionId)) return json({ error: "A durable input chain is active; use the explicit pending-inputs API", code: "pending-input-chain-active" }, 409);
    const prepared = await prepareUserInput(input, { ...preparationState(), profiles: agentProfiles, getSession: id => meta.sessions.find(s => s.sessionId === id),
      defaultCwd: options.cwd, conversationId: () => originalSubmission?.binding.conversationId ?? crypto.randomUUID(), sourceAuthorityId: nativeSource,
      selectedDirectory: async (workspaceId, worktreeId) => (await catalog.binding(workspaceId, worktreeId)).cwd,
      ensureDirectory, validateOpenCodeModel: (model, effort) => oc.model(model, effort), resolveOpenCodeLaunch: (cwd, settings) => oc.resolveLaunch(cwd, settings) });
    const { conversationId, cwd } = prepared.binding;
    if (originalSubmission && conversationId !== originalSubmission.binding.conversationId) throw new AppAdmissionRequestError("target-conflict", "Prepared conversation differs from its original server binding");
    if (originalIntent) {
      assertAppAdmissionExpectedSource(originalIntent, { sessionId: conversationId, harnessId: prepared.binding.harness,
        authorityId: prepared.binding.authorityId, nativeSessionId: prepared.binding.nativeSessionId ?? null, cwd });
      if (prepared.resume) {
        const session = meta.sessions.find(s => s.sessionId === conversationId);
        if (!session) throw new AppAdmissionRequestError("target-conflict", "The original conversation disappeared during preparation");
        assertAppAdmissionExpectedSource(originalIntent, dispatchSource(session));
      }
    }
    const liveOwner = owners.get(conversationId);
    if (originalIntent?.operation === "live-input" && (!liveOwner || liveOwner.run.runId !== originalIntent.expectedLiveRunId || !claudeRuns.canSendInput(liveOwner))) throw new AppAdmissionRequestError("target-conflict", "The selected live run changed during preparation; no replacement send is allowed");
    if ((!originalIntent || originalIntent.operation === "live-input") && prepared.binding.harness === "claude-code" && liveOwner && claudeRuns.canSendInput(liveOwner)) {
      if (prepared.stagedUpgrade || prepared.configuration.model !== liveOwner.run.model || prepared.configuration.effort !== liveOwner.run.effort) return json({ error: "Wait for this run to finish before changing assistant settings", code: "claude-input-configuration" }, 409);
      const checkCurrent = () => {
        if (originalIntent && liveOwner.run.runId !== originalIntent.expectedLiveRunId) throw new AppAdmissionRequestError("target-conflict", "The original selected live run changed");
        if (originalIntent) {
          if (!liveOwner.contextIdentity) throw new AppAdmissionRequestError("target-conflict", "The original live dispatch source is unavailable");
          assertAppAdmissionExpectedSource(originalIntent, liveOwner.contextIdentity.source);
        }
        assertPreparedUserInputCurrent(prepared, { profiles: agentProfiles, getSession: id => meta.sessions.find(s => s.sessionId === id), sourceAuthorityId: nativeSource });
        const readiness = coordinator.inspectReadiness({ conversationId, intent: { kind: "user-prompt" }, phase: "enqueue" });
        if (!readiness.ready) throw new WorkstreamAdapterError(409, readiness.code, readiness.reason);
        if (owners.get(conversationId) !== liveOwner || coordinator.hasAdmission(conversationId) || coordinator.hasReconciliation(conversationId) || pendingInputs!.hasChain(conversationId)) throw new WorkstreamAdapterError(409, "claude-input-unavailable", "Conversation changed before the follow-up could be sent");
      };
      const assertCurrent = () => originalSubmission ? withOriginalAdmission(originalSubmission.original, checkCurrent) : checkCurrent();
      const task = Promise.withResolvers<void>(); attachmentTasks.add(task.promise);
      try {
        assertCurrent();
        if (await execution(conversationId) !== cwd) throw new WorkstreamAdapterError(409, "execution-mismatch", "Conversation execution checkout changed");
        return json({ sessionId: conversationId, ...await claudeRuns.sendInput(liveOwner, prepared.prompt, assertCurrent, submissionPublication?.(liveOwner)) }, 202);
      } finally { task.resolve(); attachmentTasks.delete(task.promise); }
    }
    const reserveOriginal = () => coordinator.reserveAdmission({ conversationIds: [conversationId], intent: { kind: "user-prompt" } });
    const admission = originalSubmission ? withOriginalAdmission(originalSubmission.original, reserveOriginal) : reserveOriginal();
    if (!admission.ready) return json({ error: admission.reason, code: admission.code }, admission.code === "capacity" ? 429 : 409);
    const lease = admission.lease;
    if (originalSubmission) appAdmissionLeases.set(lease, originalSubmission.original);
    const task = Promise.withResolvers<void>(); attachmentTasks.add(task.promise);
    try {
      const { lifecycle: _lifecycle, ...response } = await admitPreparedInput(prepared, lease, { submissionPublication }); return json(response, 202);
    } finally { coordinator.releaseAdmission(lease); task.resolve(); attachmentTasks.delete(task.promise); }
  }
  function captureAppAdmissionAuthorization(req: Request, acceptedOrigin: URL) {
    const principal = auth.terminalToken(req);
    const scope = Object.freeze({ url: req.url, method: req.method, origin: origin, acceptedOrigin: acceptedOrigin.origin,
      requestOrigin: req.headers.get("origin"), host: req.headers.get("host"), cookie: req.headers.get("cookie"), storeId: store.manifest.storeId });
    return () => {
      // A changed server store identity is an invariant failure, not a revoked
      // browser principal. Keep it on the queue's existing fail-closed path.
      if (store.manifest.storeId !== scope.storeId) throw new AppAdmissionStorageError("corrupt", "The original App store identity changed before submission intake");
      if (!principal || !auth.validTerminalToken(principal) || !auth.authenticated(req) || auth.terminalToken(req) !== principal
        || req.url !== scope.url || req.method !== scope.method || origin !== scope.origin || acceptedOrigin.origin !== scope.acceptedOrigin
        || req.headers.get("origin") !== scope.requestOrigin || req.headers.get("host") !== scope.host || req.headers.get("cookie") !== scope.cookie) throw new AppAdmissionAuthorizationError("The original authenticated submission request was revoked or changed before intake");
    };
  }
  type BridgeSocketData = ({ kind: "terminal" } & TerminalSocketData) | ({ kind: "browser" } & BrowserSocketData);
  async function handle(req: Request, srv: Pick<Bun.Server<undefined>, "requestIP" | "port">, upgrade?: (req: Request, data: BridgeSocketData) => boolean): Promise<Response | undefined> {
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
        // Boot must retry rather than retain a partial capability contract while
        // startup classification is still recovering. Login discovery remains
        // available; completed but unhealthy startup still exposes read-only config.
        if (signedIn && !startupReady) return json({ error: "Startup execution classification is incomplete; retry configuration after recovery", code: "startup-classifying" }, 503, { "retry-after": "1" });
        if (signedIn) {
          nativeConnectionDemandUntil = Date.now() + 15_000;
          nativeConnectionSnapshot.refresh();
        }
        const connection = signedIn ? nativeConnectionSnapshot.read() : undefined;
        const nativeConnection = connection?.value ?? { available: false, connected: false, state: "unavailable", reason: connection?.error };
        const grokCapability = grokApp!.capability();
        return json({ authRequired: !!password, authenticated: signedIn, cwd: signedIn ? options.cwd : null, oneShot: true, ...(signedIn ? { storeId: store.manifest.storeId, appAdmissionCapability: { protocol: "app-admission", version: 1, state: appAdmissionFeature.state === "enabled" ? "enabled" : "requires-initialization" }, conversationUpdates: true, ...(pendingInputAutomationHealthy() ? { pendingInputCapability: { protocol: "pending-input", version: 1, supported: true, maxWaiting: 3, removal: true, resume: true } } : {}), capabilities: { concurrency: { scope: "conversation", limit: maxConcurrentRuns, perConversation: 1, sharedCheckoutWrites: true }, cancelRun: true, midRunInput: false, permissionReplies: true, attachments: false, modelSelection: true, effortValues: efforts, terminal: terminals.capability, browser: browsers.capability }, agents: ASSISTANT_AGENT_IDS.map(id => ({ id, label: ASSISTANT_AGENT_LABELS[id], description: ASSISTANT_AGENT_DESCRIPTIONS[id] })), agentProfiles, harnesses: [          { id: "claude-code", name: getHarnessDescriptor("claude-code")!.label, available: true, connected: true, state: "available", capabilities: capabilitiesFor("claude-code") },
          { id: "opencode", name: getHarnessDescriptor("opencode")!.label, ...nativeConnection, capabilities: capabilitiesFor("opencode") },
          { id: "grok", name: "Grok", available: grokCapability.configured, connected: grokCapability.configured,
            state: grokCapability.configured ? "configured" : "unconfigured", reason: grokCapability.reason,
            capabilities: capabilitiesFor("grok") },
        ], grokCapability } : {}) });
      }
      if (path === "/api/login" && req.method === "POST") return await auth.login(req, expected);
      if (path === "/api/logout" && req.method === "POST") {
        // BridgeAuth revokes every supplied token (and the local token), using
        // the shared revocation callback for terminals and push enrollments.
        return auth.logout(req);
      }
      if (path.startsWith("/api/") && !auth.authenticated(req)) return json({ error: "Authentication required" }, 401);
      // Capture-only Grok intake is deliberately separate from v1 receipts.
      // Browser auth/origin checks above apply to these routes as to normal chat.
      if (path === "/api/grok/turns") {
        if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
        const input = await body(req);
        if (!auth.authenticated(req)) return json({ error: "Authentication required" }, 401);
        if (input && Object.hasOwn(input, "scienceSnapshots")) return json({ error: "Science chat has been retired; saved submission history remains available", code: "science-chat-retired" }, 409);
        const task = Promise.withResolvers<void>();
        attachmentTasks.add(task.promise);
        try { return json(await grokApp!.submit(input as GrokTurnInput), 202); }
        finally { task.resolve(); attachmentTasks.delete(task.promise); }
      }
      const grokSession = /^\/api\/grok\/sessions\/([^/]+)(\/stop)?$/.exec(path);
      if (grokSession) {
        const id = decodeURIComponent(grokSession[1]!);
        if (grokSession[2] && req.method === "POST") return json(await grokApp!.stop(id));
        if (!grokSession[2] && req.method === "GET") return json(await grokApp!.view(id));
        return json({ error: "Method not allowed" }, 405);
      }
      // Capture before any body/queue await. The capability is process-private,
      // request-bound, and is consumed only by this original intake call.
      const appAdmissionAuthorization = path === "/api/submissions" && req.method === "POST"
        ? captureAppAdmissionAuthorization(req, expected) : undefined;
      const appSubmissionLookup = /^\/api\/submissions\/([^/]+)$/.exec(path);
      if (appSubmissionLookup) {
        if (req.method !== "GET") return json({ error: "Method not allowed" }, 405, { allow: "GET" });
        if (!appAdmissions) return json({ error: "App admission requires explicit initialization", code: "app-admission-uninitialized" }, 503);
        if ([...url.searchParams.keys()].some(key => !["storeId", "payloadSha256"].includes(key))
          || ["storeId", "payloadSha256"].some(key => url.searchParams.getAll(key).length !== 1)) return json({ error: "Provide the exact store and payload hash", code: "invalid-request" }, 400);
        const key = decodeAppAdmissionKey({ storeId: url.searchParams.get("storeId"), clientRequestId: decodeURIComponent(appSubmissionLookup[1]!), payloadSha256: url.searchParams.get("payloadSha256") });
        return json(appAdmissions.lookup(key));
      }
      // This read-only endpoint must reject writes before startup/branch mutation guards.
      if (req.method !== "GET" && /^\/api\/sessions\/[^/]+\/runs\/preview$/.test(path)) return json({ error: "Method not allowed" }, 405, { allow: "GET" });
      const codeShareMatch = /^\/api\/sessions\/([^/]+)\/code-shares$/.exec(path);
      if (codeShareMatch && req.method === "GET") {
        const sessionId = codeShareMatch[1]!;
        if (!meta.sessions.some(session => session.sessionId === sessionId)) return json({ error: "Unknown conversation" }, 404);
        return json({ shares: codeShares.list(sessionId) });
      }
      const mediaShareMatch = /^\/api\/sessions\/([^/]+)\/media-shares(?:\/|$)/.exec(path);
      if (mediaShareMatch) {
        const sessionId = decodeURIComponent(mediaShareMatch[1]!);
        if (!meta.sessions.some(session => session.sessionId === sessionId)) return json({ error: "Unknown conversation" }, 404);
        const response = await mediaShareRoute(req, mediaShares);
        if (response) return response;
      }
      const userQuestionsMatch = /^\/api\/sessions\/([^/]+)\/user-questions(?:\/([^/]+)\/(answers|submit|dismiss|resume))?$/.exec(path);
      if (userQuestionsMatch && req.method === "GET" && !userQuestionsMatch[2]) {
        const sessionId = userQuestionsMatch[1]!;
        if (!meta.sessions.some(session => session.sessionId === sessionId)) return json({ error: "Unknown conversation" }, 404);
        return json({ forms: userQuestions.list(sessionId) });
      }
      if (path === "/api/resource-pairs/linked") {
        if (req.method !== "GET") return json({ error: "Method not allowed" }, 405, { allow: "GET" });
        const names = ["storeId", "workspaceId", "worktreeId", "kind", "session"];
        if ([...url.searchParams.keys()].some(key => !names.includes(key)) || names.some(key => url.searchParams.getAll(key).length !== 1)) throw new ResourcePairError(400, "resource-pair-input", "Provide storeId, workspaceId, worktreeId, kind and a JSON session only");
        const encodedSession = url.searchParams.get("session")!;
        if (encodedSession.length > 2048) throw new ResourcePairError(400, "resource-pair-input", "Invalid conversation identity");
        let session: unknown;
        try { session = JSON.parse(encodedSession); } catch { throw new ResourcePairError(400, "resource-pair-input", "Invalid JSON conversation identity"); }
        const lookup = { version: 1, storeId: url.searchParams.get("storeId"), workspaceId: url.searchParams.get("workspaceId"),
          worktreeId: url.searchParams.get("worktreeId"), kind: url.searchParams.get("kind"), session, targets: [] };
        if (!isPairLinkedSnapshot(lookup)) throw new ResourcePairError(400, "resource-pair-input", "Invalid resource pairing discovery identity");
        const { version: _version, targets: _targets, ...scope } = lookup;
        const admissionPin = JSON.stringify(admissions.get(scope.session.sessionId));
        const assertCurrent = () => {
          if (req.signal.aborted || !auth.authenticated(req)) throw new ResourcePairError(409, "resource-pair-interrupted", "Pairing request is no longer current");
          if (!startupReady || closing || storageFailed) throw new ResourcePairError(503, "resource-pair-unavailable", "Resource pairing discovery is unavailable");
          if (scope.storeId !== store.manifest.storeId) throw new ResourcePairError(409, "resource-pair-store", "The App store changed; reconnect before pairing");
          assertPairConversation({ operation: "add", session: scope.session }, ResourcePairError);
          const current = meta.sessions.find(item => item.sessionId === scope.session.sessionId)!, admission = admissions.get(scope.session.sessionId);
          const association = catalog.association(scope.session.sessionId);
          if (current.hidden || !admission || admission.state !== "ready" || JSON.stringify(admission) !== admissionPin
            || admission.nativeId !== scope.session.nativeSessionId || admission.source.authorityId !== scope.session.authorityId
            || admission.source.descriptor.harness !== toNativeHarness(scope.session.harness)
            || association.workspaceId !== admission.binding.workspaceId || association.worktreeId !== admission.binding.worktreeId
            || current.cwd !== admission.binding.executionCheckout) throw new ResourcePairError(409, "resource-pair-identity", "Conversation admission changed; reconnect before restoring links");
          // Cached authority IDs do not attest that their configured/admitted
          // locators still resolve to that authority after an async boundary.
          try {
            const native = admission.source.descriptor.harness;
            const source = native === "gk" ? store.sources.version === 2 ? store.sources.gk : undefined : store.sources[native];
            if (!source || source.authorityId !== scope.session.authorityId
              || normalizeNativeSource(source.descriptor).authorityId !== scope.session.authorityId
              || normalizeNativeSource(admission.source.descriptor).authorityId !== scope.session.authorityId) throw new Error("Native source changed");
          } catch {
            throw new ResourcePairError(409, "resource-pair-identity", "Native authority changed or is unavailable; reconnect before restoring links");
          }
          catalog.assertBinding(admission.binding.workspaceId, admission.binding.worktreeId, admission.binding.executionCheckout, admission.binding.bindingRevision);
        };
        assertCurrent();
        // Navigation is independent of the conversation's execution checkout.
        // Browser targets need only their workspace; files need the exact live
        // browsing worktree. Execution binding checks remain in assertCurrent.
        const workspace = await catalog.registered(scope.workspaceId);
        assertCurrent();
        let assertBrowsing: () => void;
        if (scope.kind === "browser") {
          assertBrowsing = () => {
            if (!catalog.workspaceName(scope.workspaceId)) throw new ResourcePairError(404, "resource-pair-workspace", "Unknown browser workspace");
          };
        } else {
          const tree = workspace.worktrees.find(item => item.worktreeId === scope.worktreeId);
          if (!tree) throw new ResourcePairError(404, "resource-pair-worktree", "Unknown resource worktree");
          assertBrowsing = () => catalog.assertBinding(scope.workspaceId, scope.worktreeId, tree.root, tree.bindingRevision);
        }
        assertBrowsing();
        const snapshot = resourcePairs.listForSession(scope);
        // From this point through publication everything is synchronous: a
        // concurrent unlink cannot be crossed by an async per-file preflight.
        snapshot.targets = snapshot.targets.filter(item => {
          if (item.target.kind === "browser") return true;
          try { resourcePairFileTargetFence(item.target, workspace, true); return true; }
          catch (error) {
            if (error instanceof ResourcePairError && ["resource-pair-path", "resource-pair-file"].includes(error.code)) return false;
            throw error;
          }
        });
        assertCurrent();
        assertBrowsing();
        if (!isPairLinkedSnapshot(snapshot)) throw new ResourcePairError(503, "resource-pair-storage", "Invalid resource pairing discovery snapshot");
        return json(snapshot);
      }
      if (!startupReady && path.startsWith("/api/") && !["GET", "HEAD"].includes(req.method)) return json({ error: "Startup execution classification is incomplete", code: "startup-classifying" }, 503);
      if (path === "/api/submissions") {
        if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, { allow: "POST" });
        if (url.searchParams.size) return json({ error: "Submission intake does not accept query parameters", code: "invalid-request" }, 400);
        const service = appAdmissions;
        if (!service) return json({ error: "App admission requires explicit initialization", code: "app-admission-uninitialized" }, 503);
        const completion = Promise.withResolvers<void>(); attachmentTasks.add(completion.promise);
        const finish = () => { completion.resolve(); attachmentTasks.delete(completion.promise); };
        try {
          const envelope = decodeAppAdmissionEnvelope(await body(req));
          if (!appAdmissionAuthorization) throw new Error("Original submission authorization was not captured");
          const begun = await service.begin(envelope, appAdmissionAuthorization);
          if (begun.kind === "existing") { finish(); return json(begun.receipt, 202); }
          const originalSubmission: OriginalSubmission = { original: begun.original, envelope: begun.intent, binding: begun.binding };
          // One original, supervised background invocation. Browser abort is not
          // cancellation and no receipt, GET, restart or duplicate starts it again.
          void Promise.resolve().then(async () => {
            try {
              const response = await submitUserInput(begun.intent.intent.payload, originalSubmissionPublication(begun.original), originalSubmission);
              if (!response.ok) await service.rejectBeforeInstallation(begun.original, { code: response.status === 400 ? "invalid-request" : response.status === 409 ? "conflict" : "unavailable" });
            } catch (error) {
              if (!(error instanceof AppAdmissionStorageError)) {
                try { await service.rejectBeforeInstallation(begun.original, { code: error instanceof UserInputPreparationError ? "preparation-refused" : error instanceof AppAdmissionRequestError ? "conflict" : "unavailable" }); }
                catch { /* Storage failure retains original pending uncertainty. */ }
              }
            } finally { finish(); }
          });
          return json(begun.receipt, 202);
        } catch (error) { finish(); throw error; }
      }
      if (path === "/api/resource-pairs") {
        if (req.method === "GET") {
          if ([...url.searchParams.keys()].some(key => !["storeId", "target"].includes(key))
            || ["storeId", "target"].some(key => url.searchParams.getAll(key).length !== 1)) throw new ResourcePairError(400, "resource-pair-input", "Provide storeId and a JSON target only");
          if (url.searchParams.get("storeId") !== store.manifest.storeId) throw new ResourcePairError(409, "resource-pair-store", "The App store changed; reconnect before pairing");
          let target: unknown;
          try { target = JSON.parse(url.searchParams.get("target")!); } catch { throw new ResourcePairError(400, "resource-pair-input", "Invalid JSON resource target"); }
          if (!isPairTarget(target)) throw new ResourcePairError(400, "resource-pair-input", "Invalid resource identity");
          const assertTarget = await resourcePairTargetFence(target, false);
          if (req.signal.aborted || !auth.authenticated(req)) throw new ResourcePairError(409, "resource-pair-interrupted", "Pairing request is no longer current");
          assertTarget();
          return json(resourcePairs.read(target));
        }
        if (req.method !== "PUT") return json({ error: "Method not allowed" }, 405, { allow: "GET, PUT" });
        if (url.searchParams.size) throw new ResourcePairError(400, "resource-pair-input", "Pairing writes do not accept query parameters");
        const input = await body(req);
        if (!isPairWrite(input)) throw new ResourcePairError(400, "resource-pair-input", "Provide an exact resource target, operation, expected revision, and conversation identity for session-level changes");
        const assertTarget = await resourcePairTargetFence(input.target, input.operation === "add" || input.operation === "replace");
        const assertCurrent = () => {
          assertDomainMutationOpen();
          if (req.signal.aborted || !auth.authenticated(req)) throw new ResourcePairError(409, "resource-pair-interrupted", "Pairing request is no longer current");
          assertTarget();
          assertPairConversation(input, ResourcePairError);
        };
        return json(resourcePairs.write(input, assertCurrent));
      }
      if (path === "/api/browser-pairs") {
        const response = await browserPairRoute(req, url);
        if (response !== null) return response;      }
      if (path === "/api/session-retirements") {
        if (!loopback(srv.requestIP(req)?.address ?? "")) return json({ error: "Retirement operations require the local authenticated listener", code: "retirement-local-only" }, 403);
        if (url.searchParams.size) return json({ error: "Retirement endpoint does not accept query parameters" }, 400);
        if (req.method === "GET") return json(retirements.archive());
        if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
        const task = Promise.withResolvers<void>(); attachmentTasks.add(task.promise);
        try { return json(await retirements.operate(await body(req))); }
        finally { task.resolve(); attachmentTasks.delete(task.promise); }
      }
      if (path.startsWith("/api/push/")) {
        const owner = auth.terminalToken(req) ?? "local";
        return (await chromePush!.route(req, owner, () => !closing && auth.authenticated(req)
          && (auth.terminalToken(req) ?? "local") === owner)) ?? json({ error: "Not found" }, 404);
      }
      if (path === "/api/conversation-updates" || path === "/api/conversation-updates/bootstrap") {
        const retiredSources = new Set(meta.sessions.filter(s => retirements.isRetired(s)).map(s => JSON.stringify([s.harness, s.authorityId, s.nativeSessionId])));
        const visibleSource = (key: string) => { try { const value = JSON.parse(key); return !Array.isArray(value) || !retiredSources.has(JSON.stringify(value.slice(0, 3))); } catch { return true; } };
        const visiblePage = (page: ConversationUpdatePage): ConversationUpdatePage => {
          // nextCursor is the SCANNED transport position; do not renumber or
          // rewind it when archived occurrences are omitted from the page.
          return { ...page, updates: page.updates.filter(update => !retiredId(update.conversationId) && (!update.parentSessionId || !retiredId(update.parentSessionId))), coverage: page.coverage.filter(value => visibleSource(value.sourceKey)),
            ...(page.bootstrap ? { bootstrap: { ...page.bootstrap, sourceBaselines: page.bootstrap.sourceBaselines.filter(value => visibleSource(value.sourceKey)), outstandingWorkerAttention: page.bootstrap.outstandingWorkerAttention?.filter(value => !retiredId(value.workerSessionId) && !retiredId(value.parentSessionId)) } } : {}) };
        };
        return (await conversationUpdateRoute(req, { bootstrap: async limit => visiblePage(await updates.page({ limit }, true, visibleSource)), page: async input => visiblePage(await updates.page(input, false, visibleSource)) }))!;
      }
      const mutatingSession = /^\/api\/sessions\/([^/]+)(?:\/|$)/.exec(path)?.[1];
      // Auth/startup checks above, but before blanket branch mutation refusal:
      // an independent waiting-item removal is allowed even on a paused branch.
      const queueResponse = await pendingInputRoute(req, path, pendingInputs!);
      if (queueResponse) return queueResponse;
      const readOnlyTranscriptRefresh = req.method === "POST" && /^\/api\/sessions\/[^/]+\/transcript\/refresh$/.test(path);
      const readOnlyWorkerStateRefresh = req.method === "POST" && /^\/api\/sessions\/[^/]+\/workers\/state$/.test(path);
      if (mutatingSession && !["GET", "HEAD"].includes(req.method) && !readOnlyTranscriptRefresh && !readOnlyWorkerStateRefresh) assertCatalogActive(meta.sessions.find(s => s.sessionId === mutatingSession));
      if (!["GET", "HEAD"].includes(req.method) && !readOnlyTranscriptRefresh && !readOnlyWorkerStateRefresh && mutatingSession && !path.endsWith("/branch") && (branches.replaced(mutatingSession) || branches.pending(mutatingSession) && !path.endsWith("/cancel"))) return json({ error: branches.replaced(mutatingSession) ? "Replaced conversation is read-only; open its replacement" : "The branch is not ready yet. Changes are paused to protect this conversation." }, 409);
      if (userQuestionsMatch) {
        if (req.method !== "POST" || !userQuestionsMatch[2] || !userQuestionsMatch[3]) return json({ error: "Method not allowed" }, 405);
        const [, sessionId, formId, operation] = userQuestionsMatch;
        const form = userQuestions.get(sessionId!, formId!);
        assertUserQuestionsRespondent(form, req);
        const input = await body(req);
        await catalog.binding(form.workspaceId, form.worktreeId);
        const assertCurrent = () => assertUserQuestionsRespondent(form, req);
        assertCurrent();
        const result = operation === "answers" ? userQuestions.save(sessionId!, formId!, input, assertCurrent)
          : operation === "submit" ? userQuestions.submit(sessionId!, formId!, input, assertCurrent)
          : operation === "dismiss" ? userQuestions.dismiss(sessionId!, formId!, input, assertCurrent)
          : userQuestions.resume(sessionId!, formId!, input, assertCurrent);
        if (operation === "submit" && workerStore.suppressed(sessionId!)) userQuestions.pause(sessionId!, "Automatic continuation was stopped. Resume explicitly to send these answers.");
        // Return the original operation receipt on replay, not a newer autosave
        // or delivery projection. GET reconciliation independently advances it.
        return json({ form: result });
      }
      if (path === "/api/agents" || path.startsWith("/api/agents/")) {
        const response = await agentProfileRoute(req, url);
        if (response !== null) return response;
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
      if (matchesWorkstreamRoute(path)) {
        // Host/Origin checks above have already accepted this exact request.
        const response = await workstreamRoute(req, url);
        if (response !== null) return response;
      }
      if (/^\/api\/workspaces\/[^/]+\/worktrees\/[^/]+\/science$/.test(path)) {
        const token = auth.terminalToken(req);
        return (await scienceRoute(req, science!, () => !closing && !storageFailed && !!token && auth.terminalToken(req) === token))!;
      }
      if (matchesTerminalRoute(path)) {
        const result = await terminalRoute(req, url, upgrade ? (request, data) => upgrade(request, { kind: "terminal", ...data }) : undefined);
        if (result.handled) return result.response;
      }
      const browserMatch = /^\/api\/workspaces\/([^/]+)\/browser\/(.+)$/.exec(path);
      if (browserMatch) {
        const workspaceId = decodeURIComponent(browserMatch[1]!), suffix = browserMatch[2]!, token = auth.terminalToken(req);
        if (!token) return json({ error: "Authentication required" }, 401);
        if (!catalog.workspaceName(workspaceId)) return json({ error: "Unknown workspace" }, 404);
        if ((suffix.endsWith("/socket") || !["GET", "HEAD"].includes(req.method)) && req.headers.get("origin") !== origin) return json({ error: "Origin rejected" }, 403);
        const authorized = () => !closing && !storageFailed && !!catalog.workspaceName(workspaceId) && auth.terminalToken(req) === token;
        const socketMatch = /^tabs\/([^/]+)\/socket$/.exec(suffix);
        if (socketMatch) {
          if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
          if (url.search) return json({ error: "Browser sockets do not accept query parameters", code: "browser-query" }, 400);
          if (!upgrade || req.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "WebSocket upgrade required" }, 426);
          try {
            const data = await browsers.prepare(workspaceId, decodeURIComponent(socketMatch[1]!), token);
            if (!authorized()) { browsers.cancelUpgrade(data); return json({ error: "Attachment authorization changed" }, 401); }
            try { if (upgrade(req, { kind: "browser", ...data })) return undefined; } catch { browsers.cancelUpgrade(data); return json({ error: "WebSocket upgrade failed" }, 400); }
            browsers.cancelUpgrade(data); return json({ error: "WebSocket upgrade failed" }, 400);
          } catch (error) { return browsers.errorResponse(error); }
        }
        return browsers.route(req, workspaceId, suffix, authorized, token);
      }
      if (matchesImageUploadRoute(path)) {
        const principal = auth.terminalToken(req);
        if (!principal) return json({ error: "Authentication required" }, 401);
        imageUploadPrincipals.set(req, principal);
        const target = /^\/api\/workspaces\/([^/]+)\/worktrees\/([^/]+)\//.exec(path);
        const key = target && req.method === "POST" ? `${decodeURIComponent(target[1]!)}/${decodeURIComponent(target[2]!)}` : undefined;
        if (key && imageUploadRemovals.has(key)) return json({ error: "The worktree is being removed; image uploads are unavailable", code: "worktree-busy" }, 409);
        if (key) imageUploadWorktrees.set(key, (imageUploadWorktrees.get(key) ?? 0) + 1);
        try {
          const response = await imageUploadRoute(req, url);
          if (response !== null) return response;
        } finally {
          if (key) {
            const remaining = (imageUploadWorktrees.get(key) ?? 1) - 1;
            if (remaining) imageUploadWorktrees.set(key, remaining); else imageUploadWorktrees.delete(key);
          }
        }
      }
      if (matchesWorkspaceRoute(path)) {
        const response = await workspaceRoute(req, url);
        if (response !== null) return response;
      }
      const modelsRoute = /^\/api\/harnesses\/([^/]+)\/models$/.exec(path);
      if (modelsRoute && req.method === "GET") {
        const descriptor = requireOperation(modelsRoute[1], "listModels");
        const cwd = resolve(url.searchParams.get("cwd") ?? options.cwd);
        return await dispatchHarness(descriptor.id, {
          "claude-code": () => { throw new HarnessOperationError("This harness has no live model catalog", 501, "unsupported-harness-operation"); },
          opencode: async () => json({ models: await oc.models(cwd) }),
          grok: async () => {
            const capability = grokApp!.capability();
            if (!capability.configured) throw new HarnessOperationError(capability.reason ?? "Grok is not configured", 409, "grok-unconfigured");
            return json(await grokModelCatalog!.read(cwd, url.searchParams.get("refresh") === "true"));
          },
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
      const workerStateBatch = /^\/api\/sessions\/([^/]+)\/workers\/state$/.exec(path);
      if (workerStateBatch) {
        if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
        let parentId: string;
        try { parentId = decodeURIComponent(workerStateBatch[1]!); }
        catch { return json({ error: "Invalid parent selector" }, 400); }
        if (!meta.sessions.some(s => s.sessionId === parentId)) return json({ error: "Unknown parent session" }, 404);
        const input = await body(req);
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, "ids")
          || !Array.isArray(input.ids) || input.ids.length > WORKER_STATE_BATCH_LIMIT
          || input.ids.some((id: unknown) => typeof id !== "string" || !id.trim() || id.length > 1024 || /[\x00-\x1f\x7f]/.test(id))) {
          return json({ error: `Expected {ids} with at most ${WORKER_STATE_BATCH_LIMIT} nonempty worker IDs of at most 1024 characters`, code: "worker-state-input" }, 400);
        }
        const ids = [...new Set<string>(input.ids)];
        if (!ids.length) return json({ results: [] } satisfies WorkerStateBatch);
        // Membership lookup is metadata-only; never observe unrequested tree members.
        const descendants = new Set(workerStore.descendantIds(parentId));
        const modelLookups = new Map<string, ReturnType<typeof oc.models>>();
        const results: WorkerStateBatch["results"] = new Array(ids.length);
        let next = 0, storageError: PendingInputStorageError | undefined;
        await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
          while (!storageError && next < ids.length) {
            const index = next++, id = ids[index]!;
            const record = descendants.has(id) ? workerStore.get(id) : undefined;
            if (!record) { results[index] = { id, error: "Worker not found in this parent session", code: "worker-not-found" }; continue; }
            try { results[index] = { id, snapshot: await observeWorkerState(record, modelLookups) }; }
            catch (error) {
              // A storage authority failure still fails the entire request closed.
              // Stop scheduling and drain in-flight observations before propagating it.
              if (error instanceof PendingInputStorageError) { storageError = error; return; }
              results[index] = { id, error: error instanceof Error ? error.message : "Worker state unavailable", code: error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "worker-state-unavailable" };
            }
          }
        }));
        if (storageError) throw storageError;
        return json({ results } satisfies WorkerStateBatch);
      }
      const workerState = /^\/api\/sessions\/([^/]+)\/workers\/([^/]+)\/state$/.exec(path);
      if (workerState) {
        if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
        let parentId: string, workerId: string;
        try { parentId = decodeURIComponent(workerState[1]!); workerId = decodeURIComponent(workerState[2]!); }
        catch { return json({ error: "Invalid worker selector" }, 400); }
        const record = workerStore.get(workerId);
        if (!meta.sessions.some(s => s.sessionId === parentId) || !record || record.parent.sessionId !== parentId) return json({ error: "Worker not found in this parent session" }, 404);
        try { return json(await observeWorkerState(record)); }
        catch (error) {
          if (error instanceof TranscriptError) return json({ error: error.message, code: error.code }, error.status);
          throw error;
        }
      }
      const workerList = /^\/api\/sessions\/([^/]+)\/workers$/.exec(path);
      if (workerList && req.method === "GET") {
        if (!meta.sessions.some(s => s.sessionId === workerList[1])) return json({ error: "Unknown parent session" }, 404);
        return json({ workers: await Promise.all(workers.tree(workerList[1]!).filter(w => url.searchParams.get("includeRetired") === "1" || !retiredId(w.sessionId)).map(w => workers.refresh(w))), deliveries: workerStore.deliveriesForParent(workerList[1]!), continuationSuppressed: workerStore.suppressed(workerList[1]!) });
      }
      if (matchesSessionCatalogRoute(req, url)) {
        const response = await sessionCatalogRoute(req, url);
        if (response !== null) return response;
      }
      const branchRoute = /^\/api\/sessions\/([^/]+)\/branch$/.exec(path);
      if (branchRoute) {
        const source = meta.sessions.find(s => s.sessionId === branchRoute[1]);
        if (!source) return json({ error: "Unknown source conversation" }, 404);
        if (snapshotIdentity(source) && req.method === "POST") return json({ error: "SANE branching requires verified inherited user-message prefix evidence; no native branch was created", code: "context-branch-prefix-unproven" }, 409);
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
          if (source.saneExecution && source.agentKind === "assistant" && isAssistantAgentId(source.agent)) op.canonicalActivation = true;
          branches.save(op);
          if (op.canonicalActivation) await executionReservation(op.destinationId, { kind: "assistant", role: source.agent as import("sane-core/agent-catalog").AssistantAgentId }, async () => {
            const pair = source.saneExecution
              ? structuredClone({ saneExecution: source.saneExecution, saneContext: source.saneContext })
              : await createCanonicalActivation({ kind: "assistant", role: source.agent as import("sane-core/agent-catalog").AssistantAgentId }, activationStores);
            if (!pair.saneContext?.package) throw new Error("Branch canonical execution requires paired source context");
            pair.saneContext.package.activation = "upgrade";
            return pair;
          });
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
            grok: async () => {
              if (!options.grokExecutable) throw new WorkstreamAdapterError(409, "grok-executable-missing", "Configure the explicit Grok executable before branching");
              const homeRoot = grokHistoryHome(), sourcePin = dispatchSnapshot(source), targetNativeSessionId = crypto.randomUUID();
              await prepareGrokFork(homeRoot, source.cwd, source.nativeSessionId!, targetNativeSessionId);
              assertDispatchSnapshot(source.sessionId, sourcePin);
              op = { ...op!, nativeId: targetNativeSessionId }; branches.save(op);
              const finished = Promise.withResolvers<void>();
              const fork: { sourceId: string; controller: AbortController; done: Promise<void>; spawned?: GrokAcpSpawnInfo; observation?: GrokAcpCloseEvidence } = {
                sourceId: source.sessionId, controller: new AbortController(), done: finished.promise,
              };
              grokForkProcesses.set(op.id, fork);
              let stderr = "";
              try {
                const result = await forkGrokSession({ executable: options.grokExecutable, homeRoot, cwd: source.cwd,
                  sourceNativeSessionId: source.nativeSessionId!, targetNativeSessionId, signal: fork.controller.signal,
                  beforeNative: () => {
                    assertDispatchSnapshot(source.sessionId, sourcePin);
                    if (fork.controller.signal.aborted || !coordinator.holdsAdmission(lease, source.sessionId)
                      || !coordinator.holdsAdmission(lease, op!.destinationId) || owners.has(source.sessionId)
                      || branches.get(op!.id)?.state !== "reserved") throw new WorkstreamAdapterError(409, "grok-fork-withheld", "The original source branch admission is no longer current");
                    beforeFork();
                  },
                  onSpawn: info => { fork.spawned = info; if (closing) fork.controller.abort(); },
                  onStderr: text => { stderr = (stderr + text).slice(-8_000); },
                  onClose: evidence => { fork.observation = evidence; },
                });
                fork.observation = result.process;
                if (result.nativeSessionId !== targetNativeSessionId || result.sourceNativeSessionId !== source.nativeSessionId || !result.parentVerified)
                  throw new Error("Grok fork returned a different native source or target; no App branch was enrolled");
                assertDispatchSnapshot(source.sessionId, sourcePin);
                return result.nativeSessionId;
              } catch (error) {
                if (error instanceof GrokAcpForkError) fork.observation = error.evidence;
                if (stderr) throw new Error(`${error instanceof Error ? error.message : "Grok native fork failed"}\n${stderr}`, { cause: error });
                throw error;
              } finally {
                try {
                  const observed = fork.observation;
                  const unstarted = !fork.spawned && (!observed || observed.pid === null && observed.nativeRequest === "not-written");
                  const drained = unstarted || !!observed && observed.closeObserved && observed.processGroupGone && observed.stdoutEnded && observed.stderrEnded
                    && observed.stdoutClosed && observed.stderrClosed;
                  if (drained) grokForkProcesses.delete(op!.id);
                  else {
                    // Unknown native creation is never retried. Retain process/data
                    // ownership rather than release a possibly surviving ACP group.
                    retainOwner = true; meta.reconciliationRequired = true;
                    if (!storageFailed) await persist();
                  }
                } finally { finished.resolve(); }
              }
            },
          });
          op = { ...op, nativeId, state: "confirmed" }; branches.save(op);
          const destination = await enrollBranch(op, source);
          await finishBranch(op.id);
          if (input.prompt.trim()) {
            const run: Run = { runId: crypto.randomUUID(), sessionId: destination.sessionId, cwd: destination.cwd, status: "running", createdAt: new Date().toISOString(), model: destination.model, effort: destination.effort, agent: destination.agent, agentKind: destination.agentKind, nativeAgentSelected: destination.nativeAgentSelected, profileId: sessionProfileId(destination), ...saneContextSnapshot(destination) };
            branches.save({ ...branches.get(op.id)!, firstRunId: run.runId });
            if (sessionHarness(destination) === "opencode") { run.nativeCommandId = `msg_${crypto.randomUUID().replaceAll("-", "")}`; run.nativePhase = "preparing"; }
            const lifecycle = executePrompt(lease, destination, run, input.prompt, true, "user");
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
          else if (session.harness === "grok") {
            if (pending.source.descriptor.harness !== "gk" || session.authorityId !== pending.source.authorityId
              || pending.source.authorityId !== nativeSource("grok") || pending.nativeId !== session.nativeSessionId
              || pending.binding.executionCheckout !== session.cwd || !uuid(pending.nativeId)) throw new WorkstreamAdapterError(409, "grok-source-mismatch", "Grok admission differs from the original native source");
            if (pending.operation !== "create" && (!(await grokSessionExists(grokHistoryHome(), session.cwd, pending.nativeId))
              || !(await readGrokHistory(pending.nativeId, session.cwd, grokHistoryHome())).length)) return json({ error: "Grok native history unavailable" }, 409);
          } else if (!(await readClaudeHistory(pending.nativeId, pending.binding.executionCheckout, claudeRoot)).length && pending.operation !== "create") return json({ error: "Native history unavailable" }, 409);
          await admissions.register(sessionId); await persist(); admissions.ready(sessionId);
          replyIntegration?.requestRefresh();
          return json({ admission: admissions.get(sessionId) });
        } finally { coordinator.releaseAdmission(lease); }
      }
      if (path === "/api/sessions/attach" && req.method === "POST") {
        const input = await body(req);
        const harness = input?.harness, nativeSessionId = input?.nativeSessionId, cwd = input?.cwd;
        if (!isHarness(harness) || (harness === "opencode" ? typeof nativeSessionId !== "string" || !/^ses[a-zA-Z0-9_-]{1,200}$/.test(nativeSessionId) : !uuid(nativeSessionId)) || typeof cwd !== "string" || !isAbsolute(cwd) || cwd.includes("\0")) return json({ error: "Provide harness, valid native session ID and absolute execution directory" }, 400);
        requireOperation(harness, "attachHistory");
        const key = `${harness}:${nativeSessionId}`;
        let session = meta.sessions.find(s => (s.harness ?? "claude-code") === harness && (s.nativeSessionId ?? s.sessionId) === nativeSessionId);
        assertCatalogActive(session);
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
          if (harness === "grok" && !(await grokSessionExists(grokHistoryHome(), cwd, nativeSessionId))) throw new WorkstreamAdapterError(409, "grok-history-missing", "Grok native session does not exist in the configured home and exact checkout");
          if (!admissions.get(sessionId)) await admissions.begin({ sessionId, operation: "attach", harness: toNativeHarness(harness), nativeId: nativeSessionId, cwd, workspaceId: catalogSelection.workspaceId, worktreeId: catalogSelection.worktreeId });
          const candidate: Session = session ?? { sessionId, nativeSessionId, authorityId: nativeSource(harness), harness, cwd, lastStatus: "unknown", lastRunId: null, title: "Conversation", titleSource: "fallback", titleRevision: 0, titleAutoEligible: false, attachment: { state: "pending", source: nativeSource(harness) } };
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
      const titleRoute = /^\/api\/sessions\/([^/]+)\/title(\/regenerate)?$/.exec(path);
      if (titleRoute) {
        const regenerate = !!titleRoute[2];
        if (req.method !== (regenerate ? "POST" : "PUT")) return json({ error: "Method not allowed" }, 405, { allow: regenerate ? "POST" : "PUT" });
        const session = meta.sessions.find(s => s.sessionId === titleRoute[1]);
        if (!session) return json({ error: "Unknown conversation" }, 404);
        const input = await body(req);
        if (!input || typeof input !== "object" || Array.isArray(input)
          || Object.keys(input).some(key => !(regenerate ? ["expectedRevision"] : ["title", "expectedRevision"]).includes(key))
          || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
          || !regenerate && !normalizeSessionTitle(input.title)) return json({ error: "Provide expectedRevision and a valid 1–120 character title (or expectedRevision only for regeneration)", code: "invalid-title" }, 400);
        try {
          assertDomainMutationOpen();
          assertCatalogActive(session);
          if ((session.titleRevision ?? 0) !== input.expectedRevision) throw new SessionNamingError(409, "title-conflict", "Title changed; refresh before retrying");
          if (!regenerate) return json(await sessionNaming!.edit(session.sessionId, input.title, input.expectedRevision));
          sessionNaming!.assertManualCapacity(session.sessionId, input.expectedRevision);
          // Preparation is read-only and bounded; no generation or native rename
          // occurs under the metadata/domain mutation queue.
          ensureSessionJournals(session.sessionId);
          const transcript = await regenerationNamingTranscript(query => transcripts.page(session, query), req.signal);
          if (!transcript) return json({ error: "Complete an assistant response before generating a title", code: "title-no-output" }, 409);
          return json(await sessionNaming!.request(session.sessionId, input.expectedRevision, transcript));
        } catch (error) {
          if (error instanceof SessionNamingError || error instanceof TranscriptError) return json({ error: error.message, code: error.code }, error.status);
          throw error;
        }
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
      const contextUpdateRoute = /^\/api\/sessions\/([^/]+)\/context-update$/.exec(path);
      if (contextUpdateRoute) {
        if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
        const session = meta.sessions.find(row => row.sessionId === contextUpdateRoute[1]);
        if (!session) return json({ error: "Unknown context-update conversation" }, 404);
        assertCatalogActive(session);
        const input = await body(req);
        if (!input || Object.keys(input).some(key => !["prompt", "nativeStopped"].includes(key)) || typeof input.prompt !== "string" || !input.prompt.trim()) return json({ error: "Provide an authored context-update prompt and optional nativeStopped acknowledgement" }, 400);
        if (pendingInputs!.hasChain(session.sessionId)) return json({ error: "Explicit context updates cannot enter an existing ordinary-input chain", code: "pending-input-chain-active" }, 409);
        const prepared = await prepareUserInput({ ...input, sessionId: session.sessionId }, { ...preparationState(), defaultCwd: options.cwd,
          conversationId: () => crypto.randomUUID(), selectedDirectory: async (workspaceId, worktreeId) => (await catalog.binding(workspaceId, worktreeId)).cwd,
          ensureDirectory, validateOpenCodeModel: (model, effort) => oc.model(model, effort), resolveOpenCodeLaunch: (cwd, settings) => oc.resolveLaunch(cwd, settings) });
        const lease = reserve({ kind: "user-prompt" }, session.sessionId);
        const done = Promise.withResolvers<void>(); attachmentTasks.add(done.promise);
        try {
          const assertInputCurrent = () => assertPreparedUserInputCurrent(prepared, preparationState());
          let rootsCurrent = () => {};
          const messageIntent: BridgeMessageIntent = { kind: "selected", source: `app:${store.manifest.storeId}/explicit-session-update:${session.sessionId}`,
            assertCurrent: () => { assertInputCurrent(); rootsCurrent(); },
            readCurrent: async () => {
              const roots = await sessionMessageSource(session, assertInputCurrent);
              rootsCurrent = roots.check;
              return { body: prepared.prompt, binding: contextBinding(session), origin: "context-update", placement: { kind: "selected", purpose: "update" },
                selections: [{ kind: "fragment", fragment: { ...roots.fragment, reason: "Explicit user-requested Session root and membership update" } }] };
            } };
          const { lifecycle: _lifecycle, ...result } = await admitPreparedInput(prepared, lease, { messageIntent });
          return json(result, 202);
        } finally { coordinator.releaseAdmission(lease); done.resolve(); attachmentTasks.delete(done.promise); }
      }
      if (path === "/api/sessions" && req.method === "POST") {
        return await submitUserInput(await body(req));
      }
      const scienceSubmissionRead = /^\/api\/sessions\/([^/]+)\/science-submissions(?:\/([^/]+))?$/.exec(path);
      if (scienceSubmissionRead && req.method === "GET") {
        const id = scienceSubmissionRead[1];
        if (!uuid(id) || !meta.sessions.some(s => s.sessionId === id)) return json({ error: "Conversation not found" }, 404);
        if (scienceSubmissionRead[2]) {
          const receipt = scienceSubmissions.get({ conversationId: id, requestId: scienceSubmissionRead[2] });
          if (!receipt) return json({ error: "Science submission not found" }, 404);
          return json({ submission: { ...scienceView(receipt), text: receipt.intent.text,
            snapshots: receipt.intent.snapshots.map(({ snapshotId, blockId, source, agentText }) => ({ snapshotId, blockId, source, agentText })) } });
        }
        return json({ submissions: scienceSubmissions.listConversationViews(id) });
      }
      if (matchesNativeSubagentEvidenceRoute(req, url)) {
        const response = await nativeSubagentEvidenceRoute(req, url);
        if (response !== null) return response;
      }
      if (matchesTranscriptEvidenceRoute(req, url)) {
        const response = await transcriptEvidenceRoute(req, url);
        if (response !== null) return response;
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
          const source = dispatchSource(session), snapshot = dispatchSnapshot(session);
          await execution(session.sessionId);
          const nativeSessionId = session.nativeSessionId ?? session.sessionId;
          const native = await readNativeHistory(sessionHarness(session), nativeSessionId, session.cwd);
          assertDispatchSnapshot(session.sessionId, snapshot);
          if (source.harnessId === "grok" && (session.nativeSessionId !== nativeSessionId || source.authorityId !== nativeSource("grok"))) throw new WorkstreamAdapterError(409, "grok-source-mismatch", "Grok history source changed during refresh");
          if (!native.messages.length) return json({ error: "Native transcript is empty; previous history preserved" }, 409);
          if (closing || storageFailed) return json({ error: "Bridge unavailable" }, 503);
          const history: ReconciledHistory = { sessionId: session.sessionId, nativeSessionId, importedAt: new Date().toISOString(), ...native,
            coveredRunIds: coveredNativeRuns(session, meta.runs, native.messages),
            reason: session.harness === "opencode" ? "Read-only native history snapshot. Activity is a point-in-time observation; Reconcile again for later changes. Stop external work in OpenCode."
              : session.harness === "grok" ? "Read-only Grok native history from the pinned home and exact checkout. Native activity, provider acceptance and App run coverage remain unverified. Stop external Grok execution before sending here."
                : "Read-only native transcript. Active execution, message timestamps and run outcome are not exposed by the SDK history API. Ensure external assistant execution is stopped before sending here." };
          await enqueue(async () => saveNativeHistory(history));
          return json({ history });
        } catch (error) { return json({ error: error instanceof Error ? error.message : "Native reconciliation unavailable" }, error instanceof OpenCodeError && error.status === 409 ? 409 : 503); }
        finally { historyRefreshes.delete(session.sessionId); coordinator.releaseAdmission(lease); }
      }
      // Pre-dispatch handoff approval gate. Listing is read-only; the reply
      // mutates awaiting_approval -> queued (allow) or -> failed (deny) with
      // an optimistic-concurrency expectedRevision, mirroring
      // validateWorkstreamInput's revision guard.
      const handoffApprovals = /^\/api\/sessions\/([^/]+)\/handoff-approvals(?:\/([^/]+)\/reply)?$/.exec(path);
      if (handoffApprovals) {
        const sessionId = handoffApprovals[1]!;
        try {
          const session = meta.sessions.find(s => s.sessionId === sessionId);
          if (!session) return json({ error: "Unknown session" }, 404);
          const admission = admissions.get(sessionId);
          if (!admission) return json({ error: "Conversation admission is unavailable", code: "admission-missing" }, 409);
          const adapter = await router!.forAdmission(admission);
          if (!adapter) return !handoffApprovals[2] && req.method === "GET"
            ? json({ approvals: [] })
            : json({ error: "Conversation has no repository domain", code: "not-repository" }, 409);
          // Single harness mapping: bans raw ternaries for session/native conversion.
          const nativeHarness = toNativeHarness(sessionHarness(session));
          const senderRef = adapter.reference(session);
          if (senderRef.harness !== nativeHarness) return json({ error: "Conversation harness changed", code: "harness-mismatch" }, 409);
          const workspaceId = admission.binding.workspaceId;
          const domain = (await router!.forWorkspace(workspaceId)).domain;
          const related = (h: Handoff) => {
            const senderMatch = h.sender.harness === senderRef.harness && h.sender.authorityId === senderRef.authorityId && h.sender.nativeId === senderRef.nativeId;
            return h.recipient.ownerId === store.manifest.storeId && (h.recipient.sessionId === sessionId || senderMatch);
          };
          if (!handoffApprovals[2]) {
            if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
            const approvals = domain.listHandoffs().filter(h => h.status === "awaiting_approval" && related(h));
            return json({ approvals: approvals.map(h => ({ id: h.id, status: h.status, revision: h.revision, workstreamId: h.workstreamId, to: h.input.to, message: h.input.message, requestId: h.input.requestId, recipientSessionId: h.recipient.sessionId, sender: h.sender, createdAt: h.createdAt, updatedAt: h.updatedAt })) });
          }
          if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
          const startupBlock = requireStartupReady(startupReady);
          if (startupBlock) return startupBlock;
          const handoffId = handoffApprovals[2]!;
          const input = await body(req);
          const invalid = (field: string): never => { throw new WorkstreamAdapterError(400, "invalid-request", `Invalid or missing ${field}`); };
          if (!input || typeof input !== "object" || Array.isArray(input)) invalid("request object");
          if (input.decision !== "allow" && input.decision !== "deny") invalid("decision");
          if ("message" in input && (typeof input.message !== "string" || input.message.includes("\0") || input.message.length > 8000)) invalid("message");
          if (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0) invalid("expectedRevision");
          const handoff = domain.getHandoff(handoffId);
          if (!related(handoff)) return json({ error: "Handoff does not belong to this conversation", code: "handoff-mismatch" }, 404);
          if (handoff.status !== "awaiting_approval") return json({ error: "Handoff is not awaiting approval", code: "handoff-not-pending" }, 409);
          if (handoff.revision !== input.expectedRevision) return json({ error: "Handoff changed; refresh its current state before retrying", code: "CONFLICT" }, 409);
          const message = typeof input.message === "string" && input.message.trim() ? input.message.trim().slice(0, 8000) : undefined;
          const result = input.decision === "allow"
            ? await handoffs.approve(workspaceId, handoffId, input.expectedRevision, message)
            : await handoffs.deny(workspaceId, handoffId, input.expectedRevision, message ?? "Operator denied handoff delivery");
          return json({ handoff: result }, input.decision === "allow" ? 202 : 200);
        } catch (error) {
          const mapped = toHttpError(error, "Handoff approval unavailable");
          // Domain CONFLICT already carries code; preserve it for stale revisions.
          return json(mapped.body, mapped.status);
        }
      }
      const verifyCompletionMatch = /^\/api\/sessions\/([^/]+)\/runs\/([^/]+)\/verify-completion$/.exec(path);
      if (verifyCompletionMatch && req.method === "POST") {
        const session = meta.sessions.find(s => s.sessionId === verifyCompletionMatch[1]);
        const run = meta.runs.find(r => r.runId === verifyCompletionMatch[2] && r.sessionId === session?.sessionId);
        if (!session || !run) return json({ error: "Unknown session or run" }, 404);
        const input = await body(req);
        return json(await ocRuns.verifyCompletion(run, input, () => {
          if (session.authorityId !== store.sources.oc.authorityId || workerStore.hasSession(session.sessionId)
            || recoveredInputConversations.has(session.sessionId) || handoffReservations.has(session.sessionId) || handoffDispatches.has(session.sessionId)) {
            throw new OpenCodeError("Completion verification requires the original local plain prompt; workers, handoffs and recovered inputs are ineligible", 409);
          }
        }));
      }
      const interactionMatch = /^\/api\/sessions\/([^/]+)\/interactions(?:\/([^/]+)\/reply)?$/.exec(path);
      const cancelMatch = /^\/api\/sessions\/([^/]+)\/cancel$/.exec(path);
      if (interactionMatch || cancelMatch) {
        const session = meta.sessions.find(s => s.sessionId === (interactionMatch ?? cancelMatch)![1]);
        if (!session) return json({ error: "Unknown session" }, 404);
        if (cancelMatch && req.method === "POST") {
          if (session.harness === "grok") return json(await grokApp!.stop(session.sessionId));
          requireOperation(sessionHarness(session), "cancelOwnedRun");
          const currentOwner = owners.get(session.sessionId);
          if (currentOwner) requireOwnedOperation({ sessionId: session.sessionId, harness: sessionHarness(session) }, currentOwner, "cancelOwnedRun");
          if (closing || storageFailed) return json({ error: "Bridge unavailable; cancellation state must be checked in the native harness" }, 503);
          const owner = pendingInputControls.stop(session.sessionId);
          claudeRuns.cancelFollowup(session.sessionId);
          pendingInputControls.cancellationWrite(() => workerStore.suppress(session.sessionId, true)); // Idle too; never cascade.
          userQuestions.pause(session.sessionId, "Stopped by the user. Resume explicitly to send the saved answers.");
          const worker = workerStore.getBySession(session.sessionId);
          // Composer Stop interrupts a turn, not an explicit worker assignment.
          // Assignment cancellation remains the workers/cancel operation.
          if (worker && !worker.outcome && !isExplicitWorker(worker)) pendingInputControls.cancellationWrite(() => workerStore.update(worker.id, { state: "cancelling", cancelRequestedAt: worker.cancelRequestedAt ?? new Date().toISOString() }));
          if (recoveredInputConversations.has(session.sessionId)) {
            const finished = Promise.withResolvers<void>(); attachmentTasks.add(finished.promise);
            try { return json({ ...(await pendingInputRecovery!.stop(session.sessionId)), code: "pending-input-reconciliation-required" }); }
            finally { finished.resolve(); attachmentTasks.delete(finished.promise); }
          }
          if (!owner) return json({ interrupted: false, status: session.lastStatus,
            ...(recoveredInputConversations.has(session.sessionId) ? { code: "pending-input-reconciliation-required", reconciliationRequired: true } : {}),
            reason: "No active App-owned run; external execution must be stopped in its native harness" });
          try { return json(await requestRunCancellation(owner, "user", {
            emitStopping: () => emit(owner.run, "status", { status: "running", connection: "stopping", reason: "Stop requested; waiting for terminal evidence",
              ...(worker && isExplicitWorker(worker) ? { workerRunStopped: true } : {}) }),
            isCurrent: () => owners.get(session.sessionId) === owner,
            release: releaseOwner,
          })); }
          catch (error) {
            // An explicit retry is allowed after an ambiguous network failure;
            // concurrent requests still share the same in-flight attempt.
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
          const replySource = dispatchSource(session);
          const assertReplyCurrent = () => {
            // Interaction replies are unrelated mutations: no original-intake
            // exemption, copied public request key or chain ID may bypass this.
            if (appAdmissions?.readPending().some(row => row.conversationId === replySource.sessionId)) throw new WorkstreamAdapterError(409, "app-admission-pending", "An original App submission is unresolved; native interaction mutation is unavailable");
            if (recoveredInputConversations.has(replySource.sessionId)) throw new WorkstreamAdapterError(409, "pending-input-reconciliation-required", "Recovered queued execution is uncertain; native interaction mutation is unavailable");
            const current = meta.sessions.find(row => row.sessionId === replySource.sessionId);
            if (!current || !sameDispatchSource(replySource, dispatchSource(current))) throw new WorkstreamAdapterError(409, "dispatch-source-mismatch", "The original interaction conversation source changed");
          };
          assertReplyCurrent();
          const reply = await body(req);
          assertReplyCurrent();
          if (!reply || (reply.type !== "permission" && reply.type !== "question")) return json({ error: "Invalid interaction reply type" }, 400);
          requireOperation(descriptor.id, reply.type === "permission" ? "permissionReply" : "questionReply");
          assertReplyCurrent();
          await oc.reply(replySource.nativeSessionId!, decodeURIComponent(interactionMatch[2]), reply, assertReplyCurrent); return json({ ok: true });
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
        if (hidden) userQuestions.pause(session.sessionId, "Conversation hidden. Resume explicitly to send the saved answers.");
        if (hidden && !session.hidden) pendingInputControls.hide(session.sessionId);
        session.hidden = hidden;
        await persist();
        if (!hidden && startupReady && !closing && !storageFailed) workerCompletionRecovery?.notify(session.sessionId);
        return json({ ok: true, sessionId: session.sessionId, hidden: session.hidden });
      }
      if (matchesRunEvidenceRoute(req, url)) {
        const response = await runEvidenceRoute(req, url);
        if (response !== null) return response;
      }
      if (matchesConversationSearchRoute(req, url)) {
        const response = await conversationSearchRoute(req, url);
        if (response !== null) return response;
      }
      if (/^\/api\/(?:runs|sessions)\/[^/]+\/input$/.test(path) && req.method === "POST") return json({ error: "One-shot mode does not support interactive input" }, 501);
      if (path.startsWith("/api/")) return json({ error: "Not found" }, 404);
      return (await assetRoute(req, url)) ?? json({ error: "Not found" }, 404);
    } catch (error) {
      if (error instanceof AppAdmissionAuthorizationError) return json({ error: error.message, code: error.code }, error.status);
      if (error instanceof AppAdmissionStorageError) { failClosed(error, "app-admission-http"); return json({ error: "App admission storage is unavailable; reconcile the original request without resending", code: "app-admission-storage-unavailable" }, 503); }
      if (error instanceof AppAdmissionRequestError) return json({ error: error.message, code: error.code }, error.status);
      if (error instanceof BrowserPairError || error instanceof ResourcePairError) return json({ error: error.message, code: error.code }, error.status);
      if (error instanceof SessionRetirementError || error instanceof SessionCatalogError) return json({ error: error.message, code: error.code }, error.status);
      if (error instanceof UserQuestionsError) return json({ error: error.message, code: error.code }, error.status);
      if (error instanceof MediaShareError) return json({ error: error.message, code: error.code }, error.status);
      if (error instanceof ScienceSubmissionStorageError) { failClosed(); return json({ error: error.message, code: "science-submission-unknown" }, 503); }
      if (error instanceof ScienceSubmissionError) return json({ error: error.message, code: error.code }, error.status);
      if (error instanceof PendingInputStorageError) { failClosed(); return json({ error: error.message, code: "storage-unavailable" }, 503); }
      if (error instanceof PendingInputDomainError) return json({ error: error.message, code: error.code }, error.status);
      return error instanceof UserInputPreparationError ? json({ error: error.message, ...(error.code ? { code: error.code } : {}), ...(error.reason ? { reason: error.reason } : {}) }, error.status) : error instanceof HarnessOperationError || error instanceof WorkstreamAdapterError ? json({ error: error.message, code: error.code }, error.status) : error instanceof DomainError ? json({ error: error.message, code: error.code }, error.code === "NOT_FOUND" ? 404 : 409) : error instanceof WorkspaceError ? json({ error: error.message, code: error.code }, error.status) : error instanceof OpenCodeError ? json({ error: error.message }, [400, 404, 409].includes(error.status) ? error.status : 503) : json({ error: "Invalid request" }, 400);
    }
  }
  drainStartupExecution = async () => {
    await coordinator.close();
    await userQuestionsDelivery.close();
    await workers.drainLaunches();
    await Promise.all([terminals.close(), browsers.close()]);
    await Promise.all([...owners.values()].map(async owner => {
      if (!await cleanupOwner(owner)) retainOwner = true;
      await Promise.all([owner.done, owner.submission?.catch(() => {}), owner.cancel?.catch(() => {})]);
    }));
    await Promise.all([...dispatchTasks, ...attachmentTasks, ...handoffDispatches.values(), workerOutboxTask, handoffTask, nativeSubagentRecorder.drain()]);
    await serial;
    await catalog.flush();
    if (!coordinator.reconciliationSessionIds().next().done) retainOwner = true;
  };
  // Finite inactivity headroom above the clients' 25s/30s deadlines and 15s
  // backend reads. Do not let Bun's short default terminate valid requests.
  const terminalSocket = (socket: Bun.ServerWebSocket<BridgeSocketData>) => socket as Bun.ServerWebSocket<TerminalSocketData>;
  const browserSocket = (socket: Bun.ServerWebSocket<BridgeSocketData>) => socket as Bun.ServerWebSocket<BrowserSocketData>;
  // Image intake enforces its own streamed limit; ordinary JSON intake retains
  // the independent 1 MiB bound in bridge-http.body().
  const server = Bun.serve<BridgeSocketData>({ hostname: options.host, port: options.port, idleTimeout: 60, maxRequestBodySize: IMAGE_UPLOAD_LIMITS.imageBytes, websocket: {
    maxPayloadLength: 65536, backpressureLimit: 10 * 1024 * 1024, closeOnBackpressureLimit: true, perMessageDeflate: false, idleTimeout: 60, sendPings: true,
    open: socket => socket.data.kind === "terminal" ? terminals.websocket.open?.(terminalSocket(socket)) : browsers.websocket.open?.(browserSocket(socket)),
    message: (socket, message) => socket.data.kind === "terminal" ? terminals.websocket.message(terminalSocket(socket), message) : browsers.websocket.message(browserSocket(socket), message),
    close: (socket, code, reason) => socket.data.kind === "terminal" ? terminals.websocket.close?.(terminalSocket(socket), code, reason) : browsers.websocket.close?.(browserSocket(socket), code, reason),
    drain: socket => socket.data.kind === "terminal" ? terminals.websocket.drain?.(terminalSocket(socket)) : browsers.websocket.drain?.(browserSocket(socket)),
  },
    fetch: (req, srv) => withApiCompression(req, () => handle(req, srv, (request, data) => srv.upgrade(request, { data })), {
      // This POST only reprojects stored/native transcript evidence; it never
      // submits input. Other mutation acknowledgements keep the safer default.
      readOnly: req.method === "POST" && /^\/api\/sessions\/[^/]+\/transcript\/refresh$/.test(new URL(req.url).pathname),
    }),
  });
  boundListenerStops.push(async () => { await server.stop(true); });
  const hookServer = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 60, maxRequestBodySize: 1024 * 1024, fetch: async (req, srv) => new URL(req.url).pathname === "/native/browser" ? (loopback(srv.requestIP(req)?.address ?? "") ? grokRequestProof.run(req.headers.get(GROK_RUNTIME_HEADER) ?? undefined, () => browsers.handleNativeBroker(req, handoffToken, (caller, tool, args) => {
    try {
      const source = normalizeNativeSource(caller.source as NativeSourceDescriptor);
      if (source.authorityId !== caller.authorityId) throw new Error();
      const admission = admissions.getByNative({ harness: source.descriptor.harness, authorityId: caller.authorityId, nativeId: caller.nativeId });
      const session = admission && meta.sessions.find(s => s.sessionId === admission.sessionId);
      const sessionHarnessId = session ? validateHarness(session.harness) : undefined;
      if (!admission || admission.state !== "ready" || !session || !sessionHarnessId || retirementPaused(session.sessionId) || session.hidden
        || session.nativeSessionId !== caller.nativeId || session.authorityId !== caller.authorityId
        || sessionHarnessId !== toSessionHarness(source.descriptor.harness)
        || session.cwd !== caller.cwd || admission.binding.executionCheckout !== caller.cwd
        || canonicalJSON(admission.source) !== canonicalJSON(source)) throw new Error();
      // Like every other Grok tool route: the exact signed invocation of the
      // original live, unstopped App-owned run, not only a matching admission.
      if (source.descriptor.harness === "gk" && authorizeGrokInvocation(caller, tool, args).session !== session) throw new Error();
      return { sessionId: session.sessionId, harness: sessionHarnessId, authorityId: session.authorityId, nativeSessionId: session.nativeSessionId };
    } catch { throw new BrowserGrantError(403, "browser-session-unverified", "This conversation is not an admitted SANE session"); }
  })) : json({ error: "Forbidden" }, 403)) : new URL(req.url).pathname === "/native/user-questions" ? (loopback(srv.requestIP(req)?.address ?? "") ? nativeUserQuestions(req) : json({ error: "Forbidden" }, 403)) : new URL(req.url).pathname === "/native/code-shares" ? (loopback(srv.requestIP(req)?.address ?? "") ? nativeCodeShare(req) : json({ error: "Forbidden" }, 403)) : new URL(req.url).pathname === "/native/media-shares" ? (loopback(srv.requestIP(req)?.address ?? "") ? nativeMediaShare(req) : json({ error: "Forbidden" }, 403)) : new URL(req.url).pathname === "/native/workers" ? (loopback(srv.requestIP(req)?.address ?? "") ? nativeWorker(req) : json({ error: "Forbidden" }, 403)) : new URL(req.url).pathname === "/native/handoffs" ? nativeHandoff(req) : new URL(req.url).pathname.startsWith("/hooks/") ? (await handle(req, srv)) ?? json({ error: "Not found" }, 404) : json({ error: "Not found" }, 404) });
  boundListenerStops.push(async () => { await hookServer.stop(true); });
  presentationPoller.start();
  origin = options.publicOrigin ?? `http://${options.host.includes(":") ? `[${options.host}]` : options.host}:${server.port}`;
  browserLoopbackOrigin = `http://127.0.0.1:${server.port}`;
  browsers.setHookEndpoint(`http://127.0.0.1:${hookServer.port}/native/browser`, handoffToken);
  // OpenCode reads native-handoff.json and sends a qualified caller. Do not publish
  // a second copy of that bearer as browser-mcp.json; possession is not a grant.
  atomicAppRecord(options.dataDir, "native-handoff.json", { version: 1, url: `http://127.0.0.1:${hookServer.port}/native/handoffs`, token: handoffToken, pid: process.pid });
  // Start recovery only after both listeners are acquired. A port-bind failure
  // must not leave observers writing after startup releases the ownership lock.
  recoveredInputClaims = classifyPendingInputMutation(() => pendingInputs!.recover());
  // Capture EVERY original synchronously before the first source/context await,
  // including journals whose Run metadata is missing. Reads never lazily repin.
  try { for (const item of recoveredInputClaims) {
    const identity = item.claim!.identity;
    if (coordinator.hasOwner(identity.source.sessionId) || coordinator.hasAdmission(identity.source.sessionId)
      || coordinator.hasReconciliation(identity.source.sessionId)) throw new Error("Original journal recovery cannot replace a live owner/admission");
    // The existing serialized queue must have consumed any startup-only writes
    // before this explicit, one-way transfer to original-recovery authority.
    runJournals.excludeOriginal(identity.runId);
    originalJournals.capture(item);
  } }
  catch (error) { failClosed(error, "pending-input-initialization"); throw error; }
  const originalJournal = (original: PendingInputStoredItem) => {
    try { runJournals.assertOriginal(original.claim!.identity.runId); return originalJournals.read(original); }
    catch (error) { failClosed(error, "original-journal-authority"); throw error instanceof PendingInputStorageError ? error : new PendingInputStorageError("Original App journal authority lost", error); }
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
  type RecoveryTerminalBasis = "not-submitted" | "exact-native-terminal";
  const originalTerminal = (original: PendingInputStoredItem) => {
    const identity = original.claim!.identity;
    const marker = originalJournal(original)?.records.findLast(event => {
      if (event.kind !== "status" || !event.data || typeof event.data !== "object") return false;
      const data = event.data as Record<string, unknown>, association = data.recoveryOriginal as Record<string, unknown> | undefined;
      return association?.storeId === store.manifest.storeId && association.itemId === original.itemId
        && association.chainId === original.chainId && association.attemptId === original.claim!.attemptId
        && equalPendingPin(association.identity, identity) && !!data.queueRecoveryTerminal;
    });
    const proof = (marker?.data as { queueRecoveryTerminal?: { status?: unknown; basis?: unknown } } | undefined)?.queueRecoveryTerminal;
    if (!proof || !["completed", "failed", "interrupted"].includes(proof.status as string)
      || !["not-submitted", "exact-native-terminal"].includes(proof.basis as string)) return undefined;
    return { status: proof.status as "completed" | "failed" | "interrupted", basis: proof.basis as RecoveryTerminalBasis };
  };
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
      if (!session || !sameDispatchSource(dispatchSource(session), source) || nativeSource(source.harnessId) !== source.authorityId)
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
    terminalProof: original => {
      const proof = originalTerminal(original);
      return proof && proof.basis !== "not-submitted" ? { status: proof.status, basis: proof.basis } : undefined;
    },
    terminalize: (original, status, basis, validate) => enqueue(async () => {
      validate();
      const identity = original.claim!.identity, run = meta.runs.find(row => row.runId === identity.runId);
      if (run && (run.sessionId !== identity.source.sessionId || run.cwd !== identity.source.cwd
        || (run.nativeCommandId ?? null) !== identity.nativeCommandId || run.status !== "running" && run.status !== status))
        throw new PendingInputDomainError("pending-input-unproven", "Original recovered Run cannot be terminalized under this source proof");
      const prior = originalTerminal(original);
      if (prior && (prior.status !== status || prior.basis !== basis))
        throw new PendingInputStorageError("Original recovered terminal marker conflicts with source proof");
      // A never-submitted claim can have no journal. An accepted command must
      // preserve its exact terminal observation even when Run metadata is gone.
      if (!run && !prior && basis === "not-submitted" && !originalJournal(original)) return;
      let event: Event | undefined;
      if (!prior) {
        const journal = originalJournal(original);
        if (!journal) throw new PendingInputStorageError("Original recovered Run journal is missing");
        const file = await open(journal.path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
        try {
          validate();
          const opened = await file.stat(), current = originalJournal(original)!;
          if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== current.dev || opened.ino !== current.ino)
            throw new PendingInputStorageError("Original recovered Run writer pin changed");
          event = { seq: current.records.at(-1)!.seq + 1, time: new Date().toISOString(), runId: identity.runId,
            sessionId: identity.source.sessionId, kind: "status", data: { status, queueRecoveryTerminal: { status, basis },
              recoveryOriginal: { storeId: store.manifest.storeId, itemId: original.itemId, chainId: original.chainId,
                attemptId: original.claim!.attemptId, identity } } };
          await file.appendFile(JSON.stringify(event) + "\n");
          validate(); originalJournal(original);
          await file.sync();
          validate(); originalJournal(original);
        } finally { await file.close(); }
      }
      validate();
      if (!run) return;
      const candidate = structuredClone(meta), stored = candidate.runs.find(row => row.runId === identity.runId)!;
      if (stored.status === "running") { stored.status = status; stored.endedAt = new Date().toISOString(); }
      const session = candidate.sessions.find(row => row.sessionId === identity.source.sessionId)!;
      if (session.lastRunId === identity.runId) session.lastStatus = status;
      publishMetadata(JSON.stringify(candidate));
      run.status = stored.status; run.endedAt = stored.endedAt;
      if (session.lastRunId === identity.runId) meta.sessions.find(row => row.sessionId === session.sessionId)!.lastStatus = status;
      try { replyIntegration?.metadataPublished(JSON.stringify(candidate)); } catch {}
      if (event) {
        journalEvents(run.runId).push(event);
        replyJournalThrough.set(run.runId, event.seq);
        transcripts.ingest(run, [event]);
      }
      validate(); originalJournal(original);
    }),
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
        (events.has(identity.runId) || deferredJournals.has(identity.runId) ? journalEvents(identity.runId) : undefined)?.push(event);
      } finally { await file.close(); }
      validate(); originalJournal(original);
    }), settled: original => {
      const identity = original.claim!.identity, id = identity.source.sessionId;
      const item = pendingInputs!.store.lookup(id, original.requestId)?.item;
      const run = meta.runs.find(row => row.runId === identity.runId);
      if (item?.state !== "settled" || run && (run.status === "running" || !run.endedAt
        || item.history?.kind === "settled" && run.status !== item.history.status)
        || coordinator.hasOwner(id) || coordinator.hasAdmission(id) || coordinator.hasReconciliation(id))
        throw new PendingInputStorageError("Recovered claim settlement lost its original ownership fence");
      recoveredInputConversations.delete(id);
      coordinator.requestWake();
    }, failClosed,
  });
  // Observe originals before admission opens. Unfinished/offline originals are
  // revisited below through the same pinned, observation-only recovery scope.
  await pendingInputRecovery.startup();
  assertStorageOwned();
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
    bindOwnerControls(owner);
    const adoption = coordinator.adoptObservedOwner(owner);
    startupObservations.delete(recovering.sessionId);
    if (!adoption.ready) throw new WorkstreamAdapterError(409, adoption.code, adoption.reason);
    let recoveryHealthy = true;
    const recoveryTask = Promise.resolve().then(() => dispatchOwnedOperation(ownedSession(owner), owner, "recoverRun", {
      "claude-code": () => { throw new HarnessOperationError("Claude process ownership cannot be recovered", 501, "unsupported-harness-operation"); },
      opencode: () => recovering.operation === "compact" ? ocRuns.recoverNativeCompact(owner) : recovering.nativePhase === "preparing" ? ocRuns.finishNative(owner, "failed", "Bridge restarted before native submission") : ocRuns.monitorNative(owner),
      grok: () => { throw new HarnessOperationError("Grok is not available through this driver", 501, "unsupported-harness-operation"); },
    }))
      .catch(error => { recoveryHealthy = false; failClosed(error, "startup-recovery"); }).finally(async () => {
        // Acquire the exact barrier while still owning. Release and done are not
        // proof that the worker/domain reconciliation has completed.
        try {
          const reconciliationWasRequired = !!meta.reconciliationRequired;
          const token = coordinator.beginReconciliation(owner);
          owner.settled = true; releaseOwner(owner);
          if (!storageFailed) await reconcileWorkerSettlementTraffic(recovering.sessionId);
          const w = workerStore.getBySession(recovering.sessionId);
          if (w && !storageFailed) {
            await reconcileCompletionRecoveryDelivery(w);
            await workers.refresh(workerStore.get(w.id)!);
          }
          // A preexisting operator pause does not turn healthy observation into
          // a failed source hook. It still denies all admissions independently;
          // ending this barrier supplies NO automatic continuation proof.
          if (recoveryHealthy && !storageFailed && !retainOwner && (!meta.reconciliationRequired || reconciliationWasRequired)) {
            if (!coordinator.endReconciliation(token)) throw new Error("Recovered source reconciliation barrier is no longer current");
          }
        }
        catch (error) { recoveryHealthy = false; failClosed(error, "startup-recovery-finalize"); }
        finally {
          finished.resolve();
          if (recoveryHealthy && startupReady) trackRecoveredWorkerCompletion(recovering.sessionId);
        }
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
        const session = meta.sessions.find(s => s.sessionId === w.sessionId);
        if (!session && !w.launch.identity) throw new Error("Worker recovery requires its original identity");
        const activation = session ?? await executionReservation(w.sessionId, w.launch.identity!);
        assertStorageOwned();
        const selected = await oc.recoverLaunch(a.nativeId, w.checkout, activation.saneExecution ? "build" : w.launch.agent!);
        assertStorageOwned();
        workerStore.update(w.id, { state: "uncertain", child: { harness: "oc", authorityId: a.source.authorityId, nativeId: a.nativeId }, launch: { ...w.launch, ...(selected?.model ? { model: `${selected.model.providerID}/${selected.model.id}`, effort: selected.model.variant } : {}) }, error: "Native selection recovered; reconciling admission and run-publication evidence without resubmitting" });
      } catch (e) { assertStorageOwned(); workerStore.update(w.id, { state: "uncertain", error: e instanceof Error ? e.message : "Native selection recovery unavailable" }); }
    }
    await workers.refresh(workerStore.get(w.id)!);
    assertStorageOwned();
  }
  let closePromise: Promise<void> | undefined;
  const startupCatalog = await catalog.list();
  assertStorageOwned();
  for (const w of startupCatalog.workspaces.filter(w => w.kind === "repository")) {
    try {
      const startupHandoffs = await handoffs.listForPolling(w.workspaceId);
      assertStorageOwned();
      for (const h of startupHandoffs) if (!retiredId(h.recipient.sessionId) && h.recipient.ownerId === store.manifest.storeId && !["queued", "completed", "failed"].includes(h.status)) handoffReservations.add(h.recipient.sessionId);
      const domain = (await router!.forPolling(w.workspaceId)).domain;
      assertStorageOwned();
      const startupDenials = await handoffs.denialsForPolling(w.workspaceId);
      assertStorageOwned();
      for (const h of startupDenials) {
        if (h.recipient.ownerId !== store.manifest.storeId) continue;
        const notification = domain.getHandoffDenialNotification(h.id);
        if (notification?.state === "claimed" && !retiredId(notification.sessionId)) handoffReservations.add(notification.sessionId);
      }
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
  assertStorageOwned();
  if (closing || storageFailed) throw new Error("Startup classification did not complete safely");
  startupReady = true;
  for (const session of activeSessions()) if (session.harness === "opencode") {
    for (const run of meta.runs.filter(run => run.sessionId === session.sessionId)) nativeSubagentRecorder.resume(session, run);
  }
  // Startup-only reconciliation, after run ownership and worker recovery are known.
  // The admission locks and attachment task set also coordinate request/shutdown races.
  for (const op of branches.list()) void reconcileBranch(op).catch(error => { failClosed(error, "branch-reconciliation"); });
  // Startup is a one-shot operational trigger after ownership classification.
  // Persisted claims are reconciled, never replayed. Durable exact-command or
  // drained-wrapper evidence is distinct from a manufactured live lifecycle.
  // Settle existing traffic first: the observation-only outbox poll below must
  // never be the event that starts native missing-completion recovery.
  for (const delivery of workerStore.deliveriesToReconcile()) {
    if (closing || storageFailed) break;
    if (!retirementPaused(delivery.parentSessionId)) await reconcileWorkerDelivery(delivery, "observation");
  }
  for (const { exchange } of workerStore.exchangesToReconcile()) {
    if (closing || storageFailed) break;
    if (!retirementPaused(exchange.recipient.sessionId)) await reconcileExchange(exchange, "observation");
  }
  for (const worker of workerStore.list()) if (isExplicitWorker(worker)) {
    await reconcileCompletionRecoveryDelivery(worker);
    await workers.refresh(workerStore.get(worker.id)!);
    trackRecoveredWorkerCompletion(worker.sessionId);
  }
  workerCompletionRecoveryStarted = true;
  workerCompletionRecovery.notify();
  const handoffPoller = createPoller(() => consumeHandoffs(), { intervalMs: 500, shouldRun: () => !closing && !storageFailed, onError: (error) => failClosed(error, "handoff-consumer") });
  const workerOutboxPoller = createPoller(() => consumeWorkerReports(), { intervalMs: 500, shouldRun: () => !closing && !storageFailed, onError: (error) => failClosed(error, "worker-outbox") });
  const userQuestionsPoller = createPoller(() => userQuestionsDelivery.poll(), { intervalMs: 500, shouldRun: () => !closing && !storageFailed, onError: error => failClosed(error, "user-questions-consumer") });
  const inputRecoveryPoller = createPoller(
    async () => {
      if (!recoveredInputConversations.size) return;
      const task = pendingInputRecovery!.refresh().catch((error) => failClosed(error, "pending-input-recovery-refresh"));
      dispatchTasks.add(task);
      try { await task; } finally { dispatchTasks.delete(task); }
    },
    { intervalMs: 2000, shouldRun: () => !closing && !storageFailed, onError: (error) => failClosed(error, "pending-input-recovery-refresh") },
  );
  assertStorageOwned();
  handoffPoller.start(); workerOutboxPoller.start(); userQuestionsPoller.start(); inputRecoveryPoller.start();
  stopStartupConsumers = () => { handoffPoller.stop(); workerOutboxPoller.stop(); userQuestionsPoller.stop(); inputRecoveryPoller.stop(); };
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
    stopGrokForks?.();
    stopPresentationReads?.();
    const repositoryReadDrain = router?.stopReads();
    pendingInputWake!.close();
    pendingInputRecovery!.close();
    const queueDrain = pendingInputBridge!.close();
    const workerRecoveryDrain = workerCompletionRecovery!.close();
    const userQuestionsDrain = userQuestionsDelivery.close();
    const coordinatorDrain = coordinator.close();
    const namingDrain = sessionNaming?.close();
    const replyDrain = replyIntegration?.close(); // Abort immediately, before any shutdown awaits.
    const pushDrain = chromePush?.close();
    const searchDrain = searches.close();
    const imageUploadDrain = imageUploads.close();
    const creationDrain = workspaceCreations?.close();
    const gitOperationsDrain = gitOperations?.close();
    const scienceDrain = science?.close();
    const grokDrain = grokApp!.close();
    const grokCatalogDrain = grokModelCatalog!.close();
    // Observe immediately; later shutdown stages still supervise retained ownership.
    void scienceDrain?.catch(() => { retainOwner = true; });
    const nativeSubagentDrain = nativeSubagentRecorder.drain();
    handoffPoller.stop();
    workerOutboxPoller.stop();
    userQuestionsPoller.stop();
    inputRecoveryPoller.stop();
    closePromise = (async () => {
    await boundedStartupCleanup(() => imageUploadDrain);
    await boundedStartupCleanup(() => namingDrain);
    await boundedStartupCleanup(() => titleMutations);
    await boundedStartupCleanup(() => repositoryReadDrain);
    await boundedStartupCleanup(() => queueDrain);
    await boundedStartupCleanup(() => workerRecoveryDrain);
    await boundedStartupCleanup(() => userQuestionsDrain);
    await boundedStartupCleanup(() => Promise.all([...queueServiceTasks]));
    await coordinatorDrain;
    await creationDrain;
    await gitOperationsDrain;
    await boundedStartupCleanup(() => scienceDrain);
    if (!(await grokDrain).drained) retainOwner = true;
    if (!await grokCatalogDrain) retainOwner = true;
    await nativeSubagentDrain;
    try { await workers.drainLaunches(); } catch (error) { failClosed(error, "shutdown-worker-drain"); }
    await workerOutboxTask;
    await handoffTask;
    await Promise.all(handoffDispatches.values());
    await Promise.all([terminals.close(), browsers.close()]);
    if (attachmentTasks.size) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const attachmentsDrained = await Promise.race([Promise.all([...attachmentTasks]).then(() => true), new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), 12000); })]);
      clearTimeout(timeout);
      if (!attachmentsDrained) failClosed();
    }
    await Promise.all([...owners.values()].map(async owner => {
      if (!owner.controls) throw new HarnessOperationError("Run owner controls are unavailable", 409, "owner-harness-mismatch");
      const outcome = await owner.controls.shutdown();
      if (!outcome.drained) retainOwner = true;
      if (outcome.reconciliationRequired) meta.reconciliationRequired = true;
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
    if (retainOwner && !storageFailed) {
      // Best effort only: ownership remains if storage is broken or blocked.
      await Promise.race([persist().catch(error => { failClosed(error, "shutdown-persist"); }), Bun.sleep(500)]);
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
