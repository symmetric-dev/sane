import { useRef, useSyncExternalStore } from "react";
import { ApiError, conversationClient } from "./cc-client";
import { publishWorkers, workersFor, registerWorkerSessions, forgetWorkerSessions, setWorkerNavigator, workerReference, workerProjectionInFlight, clearWorkerStates } from "./worker-client";
import { consume, createRun } from "./cc-reducer";
import { pendingTurnRecorded, transcriptMessages } from "./transcript";
import { contextUsageFor, type ContextUsageSnapshot } from "./context-usage";
import { catalog } from "./catalog";
import { clearWorkstreamSelection } from "./workstream-selection-storage";
import { clearWorkstreamMembership } from "./workstream-membership-storage";
import { invalidateWorkspaceRequests, onWorkspaceAuthExpired } from "./workspace-store";
import { BASE_PROFILE_IDS, builtinProfiles, canAssign, legacyProfileId, type AgentProfile, type AgentProfileInput, type AgentProfiles } from "../src/agent-profiles-contract";
import { displayProfile, profileDisplayLabel, savedProfileSnapshot, validatedAgentSnapshot, type DisplayProfile, type ProfileSnapshot } from "./profile-presentation";
import type { Availability, CompletionVerificationRequest, CompletionVerificationTarget, Config, Conversation, ConversationClient, Harness, HandoffApprovalReply, Interaction, InteractionReply, Message, ModelChoice, PendingTurn, Run } from "./types";
import { liveInputReady } from "./types";
import type { ReconciledHistory } from "../src/reconcile";
import type { CompactRequest, CompactState, CompactionRecord } from "../src/oc-contract";
import { compactCommand, compactionsFor } from "./compaction";
import { ConversationCache, cloneRunForConsume, conversationKey } from "./conversation-cache";
import { ConversationListing, conversationQueryKey } from "./conversation-listing";
import { ConversationGroupListing, conversationGroupPageSize, type ConversationGroupPage, type ConversationGroupDirectory } from "./conversation-group-listing";
export type { ConversationGroupPage, ConversationGroupDirectory } from "./conversation-group-listing";
import type { SessionCatalogQuery } from "./types";
import { canonicalCount, equalValue, mergePage, pageMessages, pagedUsage, refreshPages, sameRunMetadata, TranscriptCoverageError, type PagedTranscript, type PageRequest } from "./transcript-pages";
import type { TranscriptMetadataItem, TranscriptMetadataPage, TranscriptPage } from "../src/transcript-contract";
import { capabilitiesFor, getHarnessDescriptor, type HarnessCapabilities } from "../shared/conversation/harness-capabilities";
import { notificationStore } from "./notifications";
import { notificationContextKey, notificationSourceMatches } from "./notification-source";
import type { NotificationFeedStatus } from "./notification-presentation";
import { isConversationUpdatePage, updateSourceKey, type ConversationUpdateFeedRequest } from "../shared/conversation/conversation-updates";
import type { PendingInputOperation, PendingInputView } from "./pending-input-presentation";
import { isPendingInputResumeResult, isPendingInputStatus, isPendingInputView } from "./pending-input-presentation";
import { isPendingInputCapability, isPendingInputRemovalResult, isPendingInputSubmissionResult, type PendingInputRemovalRequest, type PendingInputRequest, type PendingInputResumeRequest } from "../shared/conversation/pending-input-contract";
import { isDefinitePendingInputRefusal, PendingInputApiError } from "./pending-input-client";
import { PendingInputLedger, pendingInputLedgerKey, type PendingInputRecord } from "./pending-input-ledger";
import type { ScienceShareSnapshot } from "../shared/science-chat-contract";
import type { ScienceSubmissionView } from "../shared/conversation/types";
import { jitteredDelay } from "./visibility";
import { subscribeWake, wakePolls } from "./poll-wake";
import { invalidateCoalescedRequests } from "./request-coalescing";
import { MAX_SESSION_TITLE_LENGTH, normalizeSessionTitle } from "../shared/conversation/session-title";
import { appAdmissionExpectedSourceMatches, appAdmissionRecoveryStorageKey, decodeAppAdmissionIntent } from "../shared/conversation/app-admission-contract";
import type { AppAdmissionIntent, AppAdmissionLookup, AppAdmissionReceipt, AppAdmissionRecoveryScope } from "../shared/conversation/app-admission-contract";
import { createAppAdmissionEnvelope, settleAppAdmissionRecovery } from "./app-admission-recovery";
import type { AppAdmissionRecoveryRecord } from "./app-admission-recovery";
import { AppAdmissionLedger } from "./app-admission-ledger";
import { advanceComposerStamp, sameComposerStamp } from "./composer-lineage";
import type { ComposerStamp } from "./composer-lineage";
import type { GrokSessionView, GrokTurnInput } from "./types";
import { grokAvailability, grokMessages, grokProfileChoices, grokRuns, grokSessionView, GROK_UNKNOWN_NOTICE } from "./grok-presentation";

export type SessionNameIntent = { conversationId: string; mode: "rename" | "regenerate"; title: string; expectedRevision: number; scope: string; restoreFocus?: () => HTMLElement | null };

/** Composer draft. New conversations pick `profileId` ("" = profiles.defaultId);
 * selected Base conversations may stage `upgradeId` (assistant profile, same harness). */
export type ScienceStagedSnapshot = ScienceShareSnapshot & { snapshotId: string };
export type SciencePendingSend = { version: 1; requestId: string; conversationId: string; text: string; snapshots: ScienceStagedSnapshot[] };
export type ScienceRejectedRecovery = SciencePendingSend & { status: "rejected" };
export type Draft = { text: string; cwd: string; profileId: string; upgradeId: string; scienceSnapshots?: ScienceStagedSnapshot[] };
export type UnconfirmedSubmission = { conversationId: string; sourceKey: string; localId: string; requestId?: string; text: string; draft: Draft };
export type SendOutcome = { status: "accepted"; conversationId: string; runId: string } | { status: "queued"; conversationId: string; requestId: string } | { status: "recorded"; requestId: string; conversationId?: string } | { status: "blocked" | "rejected" | "unknown" };
export type PendingCompact = { payload: CompactRequest; phase: "sending" | "unconfirmed" | "accepted" | "rejected"; runId?: string };
export type State = {
  /** Exact original-origin/store recovery, never a replay queue. Snapshot refs
   * remain refs after reload; they are not fabricated science previews. */
  appAdmissionRecoveries?: Record<string, AppAdmissionRecoveryRecord>;
  grokView?: GrokSessionView | null;
  appAdmissionLoading?: boolean; appAdmissionError?: string; appAdmissionChecking?: string[];
  sessionNameDialog?: SessionNameIntent;
  sessionTitleRequests?: Record<string, boolean>;
  /** Separate durable run-ID map, independent of transcript page versions. */
  scienceSubmissions?: Record<string, ScienceSubmissionView[]>;
  sciencePending?: Record<string, SciencePendingSend | null>;
  scienceRecoveries?: Record<string, ScienceRejectedRecovery[]>;
  scienceSubmissionError?: string;
  pendingInputs?: PendingInputView | null; pendingInputLoading?: boolean; pendingInputError?: string;
  pendingInputOperations?: Record<string, PendingInputOperation>;
  phase: "connecting" | "login" | "ready"; config?: Config; conversations: Conversation[]; conversationsReady: boolean;
  /** Matching loaded sidebar pages only; conversations is the known-summary union. */
  conversationPageIds?: string[];
  conversationPage?: { hasMore: boolean; loading: boolean; loadingMore: boolean; error: string; queryKey: string };
  conversationGroups?: Record<string, ConversationGroupPage>;
  conversationGroupDirectory?: ConversationGroupDirectory;
  globalAvailability?: Availability;
  selected: string; runs: Run[]; messages: Message[]; drafts: Record<string, Draft>;
  connected: boolean; interactive?: boolean; loading: boolean; sending: boolean; availability: Availability;
  connectionError: string; submissionError: string; authError: string;
  /** Original-source evidence only, never a retry/replay queue. */
  unconfirmedSubmissions?: Record<string, UnconfirmedSubmission>;
  models: ModelChoice[]; modelsLoading: boolean; modelsError: string; modelsLoaded: boolean;
  /** Separate advisory discovery; never substitutes for the OpenCode catalog. */
  grokModelCatalog?: import("../shared/conversation/model-catalog").ModelCatalog & { cwd: string; loading: boolean; loaded: boolean };
  modelsCwd: string; interactions: Interaction[]; handoffApprovals: Interaction[]; interactionError: string; actionBusy: boolean; actionNotice: string;
  nativeHistory?: ReconciledHistory | null;
  pendingTurn?: PendingTurn | null;
  contextUsage?: ContextUsageSnapshot | null;
  compactState?: CompactState | null; compactions?: CompactionRecord[];
  compactError?: string; compactDialog?: string; compactInstructions?: Record<string, string>;
  pendingCompacts?: Record<string, PendingCompact>;
  profiles: AgentProfiles | null; profileError: string; profileBusy: boolean;
  transcript?: PagedTranscript | null;
  transcriptPaged?: boolean;
  transcriptInitialLoading?: boolean; transcriptRefreshing?: boolean; transcriptError?: string; metadataError?: string;
  pageBusy?: string; pageErrors?: Record<string, string>;
  workerLoading?: boolean;
};
const emptyDraft = (): Draft => ({ text: "", cwd: "", profileId: "", upgradeId: "" });
/** UI eligibility only; the server verifies native ownership, idle state and outcome. */
export function completionVerificationTarget(state: State): CompletionVerificationTarget | undefined {
  const conversation = state.conversations.find(item => item.id === state.selected);
  const run = state.runs.at(-1);
  if (!state.connected || conversation?.harness !== "opencode" || conversation.worker || conversation.agentKind === "worker"
    || !run || run.id !== conversation.lastRunId || run.conversationId !== conversation.id || run.harness !== "opencode"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(run.id)
    || run.status !== "running" || !run.nativeCompletionBoundary || run.operation === "compact" || run.compact
    || run.nativeDelivery === "queue" || run.agentKind === "worker" || !run.nativeCommandId || !run.nativeSessionId
    || run.nativeSessionId !== conversation.nativeSessionId || state.compactions?.some(record => record.lifecycle === "running")
    || state.pendingInputs?.snapshot.conversationId === conversation.id && state.pendingInputs.presentation.chainLocked) return;
  return { sessionId: conversation.id, runId: run.id, nativeSessionId: run.nativeSessionId, nativeCommandId: run.nativeCommandId };
}
const fallbackProfiles: AgentProfiles = { version: 1, defaultId: BASE_PROFILE_IDS["claude-code"], profiles: builtinProfiles("") };
export class ChatStore {
  private readonly composerEditorId = crypto.randomUUID();
  private composerStamps = new Map<string, ComposerStamp>();
  private composerStamp(key: string): ComposerStamp {
    let stamp = this.composerStamps.get(key);
    if (!stamp) {
      stamp = Object.freeze({ editorId: this.composerEditorId, chainId: crypto.randomUUID(), revision: 0 });
      this.composerStamps.set(key, stamp);
    }
    return stamp;
  }
  private pendingInputDraftStamps = new Map<string, ComposerStamp>();
  private appAdmissionSendGuard = false;
  private appAdmissionSuspended = false;
  private appAdmissionLedger?: AppAdmissionLedger;
  private appAdmissionRecords = new Map<string, AppAdmissionRecoveryRecord>();
  private appAdmissionRead?: Promise<boolean>;
  private appAdmissionLoaded = false;
  private appAdmissionStorageError = "";
  private appAdmissionLastPoll = 0;
  private appAdmissionPollCursor = 0;
  private appAdmissionChecks = new Map<string, AbortController>();
  private appAdmissionApplied = new Set<string>();
  private appAdmissionSubmissionError?: { requestId: string; message: string };
  private appAdmissionContexts = new Map<string, {
    draft: Draft; preserveDraft: boolean; consumed: boolean; auth: number;
    selection: number; generation: number; selected: string; sourceKey: string;
    pendingTurn: PendingTurn;
  }>();
  private appAdmissionScope(): AppAdmissionRecoveryScope | undefined {
    const config = this.state.config;
    if (this.appAdmissionSuspended || this.state.phase !== "ready" || config?.authenticated !== true || !config.storeId) return;
    if (typeof location === "undefined") throw new Error("An exact browser origin is required for durable App admission recovery.");
    const scope = { version: 1 as const, browserOrigin: location.origin, storeId: config.storeId };
    appAdmissionRecoveryStorageKey(scope);
    return scope;
  }
  private appAdmissionCurrent(ledger: AppAdmissionLedger, auth: number): boolean {
    try {
      const scope = this.appAdmissionScope();
      return auth === this.authEpoch && !!scope && appAdmissionRecoveryStorageKey(scope) + ":" === ledger.prefix;
    } catch { return false; }
  }
  appAdmissionSupported = (): boolean => {
    const capability = this.state.config?.appAdmissionCapability;
    return !this.appAdmissionSuspended && this.state.phase === "ready" && this.state.config?.authenticated === true
      && capability?.protocol === "app-admission" && capability.version === 1 && capability.state === "enabled"
      && !!this.client.submitAdmission && !!this.client.lookupAdmission;
  };
  grokCaptureSupported = (): boolean => {
    const capability = this.state.config?.grokCapability;
    return this.state.phase === "ready" && this.state.config?.authenticated === true
      && capability?.protocol === "grok-capture" && capability.version === 1 && capability.configured
      && !!this.client.grokTurn && !!this.client.grokSession;
  };
  captureSendSupported = (): boolean => this.harness() === "grok" ? this.grokCaptureSupported() : this.appAdmissionSupported();
  private grokViews = new Map<string, GrokSessionView>();
  /** Only unresolved in-memory capture identities, never a replay queue. */
  private grokUnconfirmed = new Map<string, { turnIndex: number; draftKey: string; stamp: ComposerStamp; preserveDraft?: boolean }>();
  private publishGrok(view: GrokSessionView, readiness?: Availability, history = this.state.nativeHistory) {
    const original = this.grokUnconfirmed.get(view.sessionId);
    if (original && (view.nextTurnIndex > original.turnIndex || view.active || view.blocked || view.phase === "not-submitted")) {
      this.grokUnconfirmed.delete(view.sessionId);
      const draft = this.state.drafts[original.draftKey];
      if (draft && !original.preserveDraft && view.phase !== "not-submitted" && sameComposerStamp(this.composerStamp(original.draftKey), original.stamp)) {
        this.update({ drafts: { ...this.state.drafts, [original.draftKey]: { ...draft, text: "",
          ...(draft.upgradeId && view.profileId === draft.upgradeId ? { upgradeId: "" } : {}) } } });
      }
    }
    this.grokViews.delete(view.sessionId); this.grokViews.set(view.sessionId, view);
    if (this.grokViews.size > 20) this.grokViews.delete(this.grokViews.keys().next().value!);
    const previous = this.state.conversations.find(item => item.id === view.sessionId);
    const captureAvailability = grokAvailability(view, this.grokUnconfirmed.has(view.sessionId));
    // Managed status includes current shared readiness. A sidebar summary read
    // before it may still say busy after the original owner has been released.
    // Use summary restrictions only for capture responses lacking readiness.
    const availability = !view.availability && captureAvailability.canSend && readiness?.canSend === false ? readiness : captureAvailability;
    const last = view.runs.at(-1);
    const nativeHistory = history?.sessionId === view.sessionId && history.nativeSessionId === view.nativeSessionId ? history : null;
    const runs = grokRuns(view);
    let conversation: Conversation = { ...previous, id: view.sessionId, harness: "grok", authorityId: view.authorityId,
      nativeSessionId: view.nativeSessionId ?? undefined, cwd: view.cwd || previous?.cwd || "",
      model: view.model || previous?.model, effort: view.effort || previous?.effort,
      profileId: view.profileId ?? previous?.profileId ?? last?.profileId,
      agent: view.agent ?? previous?.agent ?? last?.agent,
      agentKind: view.agentKind ?? previous?.agentKind ?? last?.agentKind,
      nativeAgentSelected: view.nativeAgentSelected ?? previous?.nativeAgentSelected ?? last?.nativeAgentSelected,
      ...(view.title !== undefined ? { title: view.title } : {}),
      lastRunId: last?.id ?? previous?.lastRunId ?? null, lastRunStatus: last?.status ?? previous?.lastRunStatus,
      status: view.active ? "running" : last?.status ?? "unknown", availability };
    // Keep an existing unresolved association intact unless the service supplies
    // both resolved IDs. Override the entire discriminated association together.
    if (view.workspaceId && view.worktreeId) conversation = { ...conversation,
      workspaceId: view.workspaceId, worktreeId: view.worktreeId, association: "resolved" };
    const compactions = compactionsFor(conversation, runs, nativeHistory, this.state.selected === view.sessionId ? this.state.compactState?.operations : []);
    const conversations = previous ? this.state.conversations.map(item => item.id === view.sessionId ? conversation : item) : [conversation, ...this.state.conversations];
    this.update({ conversations, ...(this.state.selected === view.sessionId ? {
      grokView: view, runs, messages: grokMessages(view, nativeHistory), availability,
      pendingTurn: null, nativeHistory, compactions, contextUsage: contextUsageFor("grok", runs, this.state.models, nativeHistory, compactions), transcript: null, transcriptPaged: false,
      transcriptInitialLoading: false, transcriptRefreshing: false, transcriptError: "", metadataError: "", workerLoading: false,
      interactions: [],
      connected: true, interactive: true, loading: false, connectionError: "",
      ...(!this.grokUnconfirmed.has(view.sessionId) && this.state.submissionError === GROK_UNKNOWN_NOTICE ? { submissionError: "" } : {}),
    } : {}) });
  }
  private appAdmissionSource(conversation?: Conversation) {
    // Missing identity is not an alias for the currently selected native source.
    if (!conversation?.authorityId || !conversation.nativeSessionId || (conversation.harness !== "claude-code" && conversation.harness !== "opencode")) return null;
    return { harnessId: conversation.harness, authorityId: conversation.authorityId,
      nativeSessionId: conversation.nativeSessionId, cwd: conversation.cwd };
  }
  private appAdmissionSourceMatches(record: AppAdmissionRecoveryRecord, conversation?: Conversation): boolean {
    const intent = record.envelope.intent;
    const expected = intent.expectedSource ?? (intent.operation === "new-conversation" && record.receipt?.state === "admitted"
      ? record.receipt.target.dispatch.source : null);
    const id = intent.conversationId ?? (record.receipt?.state === "admitted" ? record.receipt.target.dispatch.source.sessionId : null);
    const actual = this.appAdmissionSource(conversation);
    return !!expected && !!actual && conversation?.id === id && appAdmissionExpectedSourceMatches(actual, expected);
  }
  private publishAppAdmissions(error = this.appAdmissionStorageError) {
    const records = Object.fromEntries(this.appAdmissionRecords);
    this.update({ appAdmissionRecoveries: equalValue(records, this.state.appAdmissionRecoveries) ? this.state.appAdmissionRecoveries : records,
      appAdmissionError: error, appAdmissionChecking: [...this.appAdmissionChecks.keys()],
      ...(error ? { submissionError: error } : {}) });
  }
  private suspendAppAdmissions() {
    this.appAdmissionSuspended = true;
    this.appAdmissionSubmissionError = undefined;
    for (const controller of this.appAdmissionChecks.values()) controller.abort();
    this.appAdmissionChecks.clear(); this.appAdmissionLoaded = false; this.appAdmissionRead = undefined;
    // Only hide authenticated display. Never delete or re-scope durable records.
    this.update({ appAdmissionRecoveries: {}, appAdmissionChecking: [], appAdmissionLoading: false, appAdmissionError: "" });
  }
  private async loadAppAdmissions(force = false): Promise<boolean> {
    if (this.appAdmissionRead) return this.appAdmissionRead;
    const auth = this.authEpoch;
    let ledger: AppAdmissionLedger;
    try {
      const scope = this.appAdmissionScope();
      if (!scope) return false;
      const prefix = `${appAdmissionRecoveryStorageKey(scope)}:`;
      if (this.appAdmissionLedger?.prefix !== prefix) {
        this.appAdmissionLedger = new AppAdmissionLedger(scope, localStorage);
        this.appAdmissionRecords.clear(); this.appAdmissionLoaded = false;
        this.appAdmissionContexts.clear(); this.appAdmissionApplied.clear();
      }
      if (!this.appAdmissionLedger) throw new Error("App admission recovery storage is unavailable.");
      ledger = this.appAdmissionLedger;
    } catch (error) {
      this.appAdmissionStorageError = error instanceof Error ? error.message : "Durable App admission storage is unavailable.";
      this.publishAppAdmissions(); return false;
    }
    if (!force && this.appAdmissionLoaded) return !this.appAdmissionStorageError;
    this.update({ appAdmissionLoading: true });
    const read = (async () => {
      try {
        const records = await ledger.read();
        if (!this.appAdmissionCurrent(ledger, auth)) return false;
        const next = new Map<string, AppAdmissionRecoveryRecord>();
        for (const record of records) {
          const id = record.envelope.clientRequestId, previous = this.appAdmissionRecords.get(id);
          next.set(id, previous ? settleAppAdmissionRecovery(previous, record.receipt ?? { kind: "absent", key: record.envelope }) : record);
        }
        // A removed durable identity is a failure, never permission to mint a
        // replacement UUID for the same conversation or composer lineage.
        for (const [id, previous] of this.appAdmissionRecords) if (!next.has(id)) {
          if (!previous.receipt || previous.receipt.state === "pending") throw new Error("An unresolved App admission recovery record disappeared. Sending is blocked; no request was retried.");
          // A terminal may have been explicitly discarded by another tab.
          this.appAdmissionContexts.delete(id); this.appAdmissionApplied.delete(id);
        }
        this.appAdmissionRecords = next; this.appAdmissionStorageError = ""; this.appAdmissionLoaded = true;
        this.publishAppAdmissions();
        for (const record of next.values()) if (record.receipt && record.receipt.state !== "pending"
          && this.appAdmissionContexts.has(record.envelope.clientRequestId)) this.applyAppAdmission(record);
        return true;
      } catch (error) {
        if (this.appAdmissionCurrent(ledger, auth)) {
          this.appAdmissionStorageError = `App admission recovery is blocked: ${error instanceof Error ? error.message : "storage unavailable"}`;
          this.publishAppAdmissions();
        }
        return false;
      } finally { if (this.appAdmissionCurrent(ledger, auth)) this.update({ appAdmissionLoading: false }); }
    })();
    this.appAdmissionRead = read;
    try { return await read; }
    finally { if (this.appAdmissionRead === read) this.appAdmissionRead = undefined; }
  }
  private appAdmissionOwnsConsumed(record: AppAdmissionRecoveryRecord): boolean {
    const context = this.appAdmissionContexts.get(record.envelope.clientRequestId);
    return !!context?.consumed && context.auth === this.authEpoch && !context.preserveDraft && !!record.consumedStamp
      && (!context.selected || this.appAdmissionSourceMatches(record, this.state.conversations.find(c => c.id === context.selected)))
      && sameComposerStamp(this.composerStamp(record.draftKey), record.consumedStamp);
  }
  private restoreOwnedAppAdmission(record: AppAdmissionRecoveryRecord) {
    const context = this.appAdmissionContexts.get(record.envelope.clientRequestId);
    if (!context || !this.appAdmissionOwnsConsumed(record)) return;
    this.update({ drafts: { ...this.state.drafts, [record.draftKey]: structuredClone(context.draft) } });
  }
  private applyAppAdmission(record: AppAdmissionRecoveryRecord) {
    const requestId = record.envelope.clientRequestId, receipt = record.receipt;
    this.appAdmissionRecords.set(requestId, record); this.publishAppAdmissions();
    if (!receipt || receipt.state === "pending") {
      // Ordinary receipt progress belongs to the activity row, not an error
      // banner. Durable recovery and exact-status polling remain unchanged.
      return;
    }
    if (this.appAdmissionApplied.has(requestId)) return;
    this.appAdmissionApplied.add(requestId);
    const context = this.appAdmissionContexts.get(requestId);
    if (receipt.state === "rejected") {
      this.restoreOwnedAppAdmission(record);
      this.update({ ...(context && this.state.pendingTurn?.id === context.pendingTurn.id ? { pendingTurn: null } : {}),
        ...(record.draftKey === this.draftKey() ? { submissionError: `App admission rejected (${receipt.rejection.code}). The original draft is retained in recovery; no request was retried.` } : {}) });
      return;
    }
    const target = receipt.target, conversationId = target.dispatch.source.sessionId;
    // Settled records are already durable, even if their original selection or
    // generation no longer exists. Those fences govern presentation only.
    if (!context || context.auth !== this.authEpoch) return;
    wakePolls(conversationId);
    const owns = this.appAdmissionOwnsConsumed(record);
    if (owns && context.selected && context.draft.upgradeId && record.envelope.intent.operation !== "science-message") {
      const draft = this.state.drafts[record.draftKey];
      if (draft) this.update({ drafts: { ...this.state.drafts, [record.draftKey]: { ...draft, upgradeId: "" } } });
    }
    if (owns && !context.selected && !this.state.drafts[conversationId] && !this.composerStamps.has(conversationId)) {
      const draft = this.state.drafts[record.draftKey];
      if (draft) this.update({ drafts: { ...this.state.drafts, [conversationId]: { ...draft, profileId: "", upgradeId: "" } } });
    }
    const turn: PendingTurn = { ...context.pendingTurn, conversationId, runId: target.dispatch.runId,
      messageId: target.messageId, nativeMessageId: target.nativeMessageId };
    const originalSelection = context.selection === this.selectionEpoch && context.generation === this.generation
      && context.selected === this.state.selected && record.draftKey === this.draftKey(context.selected)
      && (!context.selected || this.appAdmissionSourceMatches(record, this.state.conversations.find(c => c.id === context.selected)));
    if (!originalSelection) return;
    const submissionError = this.appAdmissionSubmissionError;
    const clearSubmissionError = submissionError?.requestId === requestId && this.state.submissionError === submissionError.message;
    if (submissionError?.requestId === requestId) this.appAdmissionSubmissionError = undefined;
    this.update({ sending: false, ...(clearSubmissionError ? { submissionError: "" } : {}),
      ...(conversationId === this.state.selected ? { pendingTurn: turn } : {}) });
    if (!context.selected && owns) { this.choose(conversationId, turn); catalog.navigate({ conversationId }); }
    else this.requestSelectedRefresh();
    this.sciencePolling(true);
  }
  private async settleAppAdmission(ledger: AppAdmissionLedger, record: AppAdmissionRecoveryRecord, evidence: AppAdmissionLookup | AppAdmissionReceipt, auth: number) {
    // Persist first, independent of selected-chat generations. A late response
    // must not be lost simply because choose()/reconnect() fenced its UI.
    const next = await ledger.settle(record, evidence);
    if (this.appAdmissionCurrent(ledger, auth)) this.applyAppAdmission(next);
    return next;
  }
  appAdmissionStatus = (requestId: string): AppAdmissionRecoveryRecord | undefined => this.state.appAdmissionRecoveries?.[requestId];
  /** Direct authenticated hydration, not a selected/sidebar row or native-owner
   * lookup. No catalog publication happens until the persistent source matches. */
  private async hydrateAppAdmissionSource(record: AppAdmissionRecoveryRecord, current: () => boolean, signal: AbortSignal): Promise<Conversation | undefined> {
    invalidateCoalescedRequests(url => /^\/api\/config(?:\?|$)/.test(url));
    const config = await this.client.config(signal);
    if (!current()) return;
    if (!config.authenticated) { this.loginRequired(); return; }
    if (config.storeId !== record.scope.storeId) throw new Error("The original App store changed. Recovery was not redirected.");
    const intent = record.envelope.intent;
    const id = intent.conversationId ?? (record.receipt?.state === "admitted" ? record.receipt.target.dispatch.source.sessionId : null);
    if (!id) return; // A still-unbound new draft has no native source to adopt.
    // A direct client call can still join a cached/in-flight HTTP coalescer
    // entry. Retire it AND the listing cache before assigning this acquisition
    // its publication serial. Never allocate a new serial after the response.
    this.invalidateSessionNameRequests();
    this.conversationListing.invalidate();
    const revision = this.conversationListing.revision, readSerial = ++this.catalogSummarySerial;
    const targetVersion = this.catalogSummaryVersions.get(id), targetSource = this.pendingInputSource(id);
    const listing = this.client.conversationSummaries ? await this.client.conversationSummaries([id], signal) : await this.client.conversations(signal);
    if (!current()) return;
    if (revision !== this.conversationListing.revision || targetVersion !== this.catalogSummaryVersions.get(id)
      || targetSource !== this.pendingInputSource(id)) throw new Error("Newer conversation evidence superseded recovery hydration. Check the original source again; nothing was opened or restored.");
    if (!this.client.conversationSummaries && "page" in listing && listing.page) throw new Error("This bridge cannot hydrate an off-page original conversation safely.");
    const row = listing.conversations.find(c => c.id === id);
    if (!row || !this.appAdmissionSourceMatches(record, row)) throw new Error("The original conversation source changed or is unavailable. Recovery cannot open or restore into a replacement source.");
    // Hydration may itself retire an already displayed stale source. In that
    // case its generation fence deliberately refuses the pending UI action.
    this.mergeConversationSummaries([row], listing.availability, [], readSerial, true);
    if (!current() || !this.appAdmissionSourceMatches(record, this.state.conversations.find(c => c.id === id))) return;
    return row;
  }
  openAppAdmissionConversation = async (requestId: string): Promise<boolean> => {
    const record = this.appAdmissionRecords.get(requestId), ledger = this.appAdmissionLedger, auth = this.authEpoch;
    if (!record || record.receipt?.state !== "admitted" || !ledger || !this.appAdmissionCurrent(ledger, auth) || this.state.sending || this.state.actionBusy
      || this.appAdmissionChecks.has(requestId) || this.appAdmissionChecks.size >= 4) return false;
    const selection = this.selectionEpoch, generation = this.generation, navigation = { ...catalog.state.navigation };
    const draftKey = this.draftKey(), stamp = this.composerStamp(draftKey), controller = new AbortController();
    this.appAdmissionChecks.set(requestId, controller); this.publishAppAdmissions();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]);
    const current = () => !signal.aborted && this.appAdmissionCurrent(ledger, auth) && selection === this.selectionEpoch && generation === this.generation
      && this.appAdmissionRecords.get(requestId) === record && equalValue(navigation, catalog.state.navigation)
      && draftKey === this.draftKey() && sameComposerStamp(stamp, this.composerStamp(draftKey)) && !this.state.sending && !this.state.actionBusy;
    try {
      const conversation = await this.hydrateAppAdmissionSource(record, current, signal);
      if (!current() || !conversation) return false;
      // Normal application navigation opens Chat and updates its catalog bookmark.
      return this.openConversation(conversation.id);
    } catch (error) {
      if (current() && !this.expired(error)) this.publishAppAdmissions(error instanceof Error ? error.message : "Original conversation unavailable.");
      return false;
    } finally {
      if (this.appAdmissionChecks.get(requestId) === controller) this.appAdmissionChecks.delete(requestId);
      if (this.appAdmissionCurrent(ledger, auth)) this.update({ appAdmissionChecking: [...this.appAdmissionChecks.keys()] });
    }
  };
  checkAppAdmission = async (requestId: string): Promise<void> => {
    if (!this.appAdmissionSupported() || !await this.loadAppAdmissions()) return;
    const record = this.appAdmissionRecords.get(requestId), ledger = this.appAdmissionLedger, auth = this.authEpoch;
    if (!record || !ledger || this.appAdmissionChecks.has(requestId) || this.appAdmissionChecks.size >= 4) return;
    const controller = new AbortController(); this.appAdmissionChecks.set(requestId, controller); this.publishAppAdmissions();
    const deadline = setTimeout(() => controller.abort(), 15000);
    const current = () => !controller.signal.aborted && this.appAdmissionCurrent(ledger, auth);
    try {
      // Authenticated installation identity is checked independently of whatever
      // conversation is now selected. The only submission read is exact GET.
      const config = await this.client.config(controller.signal);
      if (!current()) return;
      if (!config.authenticated) { this.loginRequired(); return; }
      if (config.storeId !== record.scope.storeId || config.appAdmissionCapability?.protocol !== "app-admission"
        || config.appAdmissionCapability.version !== 1 || config.appAdmissionCapability.state !== "enabled") {
        this.suspendAppAdmissions();
        this.update({ submissionError: "The original authenticated App store or admission capability changed. Recovery is suspended; original records were preserved and nothing was redirected." });
        return;
      }
      const { storeId, clientRequestId, payloadSha256 } = record.envelope;
      const lookup = await this.client.lookupAdmission!({ storeId, clientRequestId, payloadSha256 }, controller.signal);
      if (!current()) return;
      await this.settleAppAdmission(ledger, record, lookup, auth);
    } catch (error) {
      if (this.appAdmissionCurrent(ledger, auth) && !this.expired(error)) this.publishAppAdmissions(`${error instanceof Error ? error.message : "Exact status lookup unavailable."} Original request retained; no retransmission occurred.`);
    } finally {
      clearTimeout(deadline);
      if (this.appAdmissionChecks.get(requestId) === controller) this.appAdmissionChecks.delete(requestId);
      if (this.appAdmissionCurrent(ledger, auth)) this.update({ appAdmissionChecking: [...this.appAdmissionChecks.keys()] });
    }
  };
  /** Explicit empty-composer action only. Reloaded science references remain in
   * the recovery card; only the in-process original contains staged previews. */
  restoreAppAdmissionDraft = async (requestId: string): Promise<boolean> => {
    const record = this.appAdmissionRecords.get(requestId), ledger = this.appAdmissionLedger, auth = this.authEpoch;
    if (!record || !ledger || !this.appAdmissionCurrent(ledger, auth) || this.state.sending || this.state.actionBusy
      || this.appAdmissionChecks.has(requestId) || this.appAdmissionChecks.size >= 4
      || record.draftKey !== this.draftKey() || this.draft().text || this.draft().scienceSnapshots?.length) return false;
    const stamp = this.composerStamp(record.draftKey), selection = this.selectionEpoch, generation = this.generation;
    const navigation = { ...catalog.state.navigation }, controller = new AbortController();
    this.appAdmissionChecks.set(requestId, controller); this.publishAppAdmissions();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]);
    const current = () => !signal.aborted && this.appAdmissionCurrent(ledger, auth) && selection === this.selectionEpoch && generation === this.generation
      && this.appAdmissionRecords.get(requestId) === record
      && equalValue(navigation, catalog.state.navigation) && !this.state.sending && !this.state.actionBusy
      && record.draftKey === this.draftKey() && sameComposerStamp(stamp, this.composerStamp(record.draftKey))
      && !this.draft().text && !this.draft().scienceSnapshots?.length;
    try {
      const conversation = await this.hydrateAppAdmissionSource(record, current, signal);
      if (!current()) return false;
      if ((record.envelope.intent.conversationId !== null || record.receipt?.state === "admitted") && !conversation) return false;
      const context = this.appAdmissionContexts.get(requestId);
      const original = context?.auth === this.authEpoch && !context.preserveDraft ? context.draft : undefined;
      const draft: Draft = original ? structuredClone(original) : { text: record.recovery.text, cwd: record.recovery.cwd,
        profileId: record.recovery.profileId ?? "", upgradeId: record.recovery.upgradeProfileId ?? "" };
      this.update({ drafts: { ...this.state.drafts, [record.draftKey]: draft }, actionNotice: !original && record.recovery.scienceSnapshots?.length
        ? "Recovered text only. Original science snapshot references remain in recovery; re-open their previews explicitly. No request was resent."
        : "Draft explicitly restored. The original request remains in recovery; nothing was resent." });
      return true;
    } catch (error) {
      if (current() && !this.expired(error)) this.publishAppAdmissions(error instanceof Error ? error.message : "Original draft source unavailable.");
      return false;
    } finally {
      if (this.appAdmissionChecks.get(requestId) === controller) this.appAdmissionChecks.delete(requestId);
      if (this.appAdmissionCurrent(ledger, auth)) this.update({ appAdmissionChecking: [...this.appAdmissionChecks.keys()] });
    }
  };
  /** Explicit UI discard, needed to release bounded terminal recovery capacity.
   * An App-admitted science request is not terminal science evidence. */
  dismissAppAdmissionRecovery = async (requestId: string): Promise<boolean> => {
    if (!await this.loadAppAdmissions()) return false;
    const record = this.appAdmissionRecords.get(requestId), ledger = this.appAdmissionLedger, auth = this.authEpoch;
    if (!record?.receipt || record.receipt.state === "pending" || !ledger || !this.appAdmissionCurrent(ledger, auth)
      || this.appAdmissionChecks.has(requestId) || this.appAdmissionSendGuard) return false;
    if (record.envelope.intent.operation === "science-message" && record.receipt.state !== "rejected") {
      const evidence = this.appAdmissionScienceEvidence(record);
      if (!evidence || evidence.state === "prepared" || evidence.state === "unknown") return false;
    }
    try {
      await ledger.removeTerminal(record);
      if (!this.appAdmissionCurrent(ledger, auth)) return true;
      this.appAdmissionRecords.delete(requestId); this.appAdmissionContexts.delete(requestId); this.appAdmissionApplied.delete(requestId);
      this.publishAppAdmissions(); return true;
    } catch (error) {
      if (this.appAdmissionCurrent(ledger, auth)) this.publishAppAdmissions(error instanceof Error ? error.message : "Recovery discard unavailable.");
      return false;
    }
  };
  private appAdmissionPolling(force = false) {
    if (!this.appAdmissionSupported() || typeof document !== "undefined" && document.hidden || !force && Date.now() - this.appAdmissionLastPoll < 5000) return;
    this.appAdmissionLastPoll = Date.now();
    void (async () => {
      if (!await this.loadAppAdmissions()) return;
      const unresolved = [...this.appAdmissionRecords.values()].filter(record => !record.receipt || record.receipt.state === "pending");
      if (!unresolved.length) return;
      const start = this.appAdmissionPollCursor % unresolved.length;
      this.appAdmissionPollCursor = (start + 4) % unresolved.length;
      const batch = Array.from({ length: Math.min(4, unresolved.length) }, (_, index) => unresolved[(start + index) % unresolved.length]);
      await Promise.all(batch.map(record => this.checkAppAdmission(record.envelope.clientRequestId)));
    })();
  }
  private sessionTitleMutations = new Map<string, { scope: string; expectedRevision: number; optimisticTitle?: string }>();
  sessionNameScope = (id: string) => JSON.stringify([this.authEpoch, this.state.config?.storeId, this.pendingInputSource(id)]);
  openSessionNameDialog = (conversationId: string, mode: SessionNameIntent["mode"], restoreFocus?: () => HTMLElement | null) => {
    const conversation = this.state.conversations.find(c => c.id === conversationId);
    if (this.state.phase !== "ready" || !conversation || conversation.replacedBy || this.state.sessionTitleRequests?.[conversationId]) return;
    this.update({ sessionNameDialog: { conversationId, mode, title: conversation.title ?? "", expectedRevision: conversation.titleRevision ?? 0,
      scope: this.sessionNameScope(conversationId), restoreFocus } });
  };
  closeSessionNameDialog = () => {
    if (!this.state.sessionNameDialog || this.state.sessionTitleRequests?.[this.state.sessionNameDialog.conversationId]) return;
    this.update({ sessionNameDialog: undefined });
  };
  private invalidateSessionNameRequests() {
    // ConversationListing invalidation alone cannot retire the HTTP coalescer's
    // cached responses or pre-mutation in-flight GETs. Limit this to catalog
    // endpoints used by naming, leaving transcript/run and other reads alone.
    invalidateCoalescedRequests(url => /^\/api\/sessions(?:\/(?:summaries|groups))?(?:\?|$)/.test(url));
  }
  refreshSessionName = async (intent: SessionNameIntent): Promise<Conversation> => {
    if (this.state.phase !== "ready" || intent.scope !== this.sessionNameScope(intent.conversationId)) throw new Error("This conversation or sign-in changed. Close the dialog and try again.");
    this.invalidateSessionNameRequests();
    this.conversationListing.invalidate();
    const rows = await this.ensureConversations([intent.conversationId]);
    const row = rows.find(c => c.id === intent.conversationId);
    if (!row || this.sessionNameScope(row.id) !== intent.scope) throw new Error("This conversation is no longer available. Close the dialog and try again.");
    return row;
  };
  /** Metadata-only actions never acquire actionBusy or interrupt a native run. */
  changeSessionName = async (intent: SessionNameIntent, title?: string): Promise<void> => {
    const id = intent.conversationId, previous = this.state.conversations.find(c => c.id === id), auth = this.authEpoch;
    if (this.state.phase !== "ready" || !previous || previous.replacedBy || intent.scope !== this.sessionNameScope(id)) throw new Error("This conversation or sign-in changed. Close the dialog and try again.");
    if (this.sessionTitleMutations.has(id)) throw new Error("A name change is already in progress for this conversation.");
    if ((previous.titleRevision ?? 0) !== intent.expectedRevision) throw new ApiError("The name changed elsewhere. Review the latest name before trying again.", 409);
    const manual = intent.mode === "rename", normalized = normalizeSessionTitle(title);
    if (manual && !normalized) throw new Error(`Enter a name between 1 and ${MAX_SESSION_TITLE_LENGTH} characters on one line, without control characters.`);
    if (manual ? !this.client.renameConversation : !this.client.regenerateConversationName) throw new Error("Naming is unavailable on this bridge. Update the bridge and try again.");
    const mutation = { scope: intent.scope, expectedRevision: intent.expectedRevision, ...(manual ? { optimisticTitle: normalized! } : {}) };
    const current = () => this.state.phase === "ready" && this.sessionNameScope(id) === intent.scope && this.sessionTitleMutations.get(id) === mutation;
    this.sessionTitleMutations.set(id, mutation);
    this.update({ sessionTitleRequests: { ...this.state.sessionTitleRequests, [id]: true },
      ...(manual ? { conversations: this.state.conversations.map(c => c.id === id ? { ...c, title: normalized! } : c) } : {}) });
    try {
      const result = await this.listingMutation(async () => {
        this.invalidateSessionNameRequests();
        try {
          return await (manual
            ? this.client.renameConversation!(id, { title: normalized!, expectedRevision: intent.expectedRevision })
            : this.client.regenerateConversationName!(id, { expectedRevision: intent.expectedRevision }));
        } finally {
          // Retire reads started during the mutation BEFORE listingMutation's
          // finally refreshes groups or the naming recovery reads summaries.
          this.invalidateSessionNameRequests();
        }
      });
      if (!current()) throw new Error("The conversation or sign-in changed while updating its name. Check the original conversation before retrying.");
      this.sessionTitleMutations.delete(id);
      this.update({ conversations: this.state.conversations.map(c => c.id === id && (c.titleRevision ?? 0) <= result.titleRevision ? { ...c, ...result } : c) });
    } catch (error) {
      if (current()) {
        this.sessionTitleMutations.delete(id);
        // Roll back only our title field, never a newer revision or unrelated
        // status/visibility/identity updates received while awaiting the request.
        if (manual) this.update({ conversations: this.state.conversations.map(c => c.id === id && c.title === normalized && (c.titleRevision ?? 0) === intent.expectedRevision
          ? { ...c, title: previous.title } : c) });
        this.expired(error);
      }
      throw error;
    } finally {
      if (this.sessionTitleMutations.get(id) === mutation) this.sessionTitleMutations.delete(id);
      if (auth === this.authEpoch && !this.sessionTitleMutations.has(id)) {
        const requests = { ...this.state.sessionTitleRequests }; delete requests[id];
        this.update({ sessionTitleRequests: requests });
      }
      if (this.sessionNameScope(id) === intent.scope) {
        // Refresh both sidebar membership and targeted History previews without
        // reconnecting, canceling, or resending anything in the running chat.
        if (this.state.phase === "ready") {
          void this.refreshConversationHead();
          void this.ensureConversations([id]).catch(() => {});
        }
      }
    }
  };
  private completionVerificationBusy = new Set<string>();
  prepareCompletionVerification = (target: CompletionVerificationTarget): (() => Promise<void>) | undefined => {
    if (!this.client.verifyCompletion || this.state.actionBusy || JSON.stringify(completionVerificationTarget(this.state)) !== JSON.stringify(target)) return;
    const selection = this.selectionEpoch, auth = this.authEpoch, storeId = this.state.config?.storeId, source = this.pendingInputSource();
    const key = JSON.stringify([storeId, source, target]);
    const identityCurrent = () => selection === this.selectionEpoch && auth === this.authEpoch && storeId === this.state.config?.storeId
      && source === this.pendingInputSource()
      && JSON.stringify(completionVerificationTarget(this.state)) === JSON.stringify(target);
    return async () => {
      if (!identityCurrent() || this.state.actionBusy || this.completionVerificationBusy.has(key)) return;
      // SANE run IDs are UUIDs. Reuse the run's identity for this route so an
      // audited request can be retried after reload or from another client.
      const input: CompletionVerificationRequest = { requestId: target.runId, nativeSessionId: target.nativeSessionId,
        nativeCommandId: target.nativeCommandId, confirm: true, reason: "User requested reconciliation of the completed native execution" };
      this.completionVerificationBusy.add(key);
      const actionCurrent = this.beginAction();
      const current = () => actionCurrent() && storeId === this.state.config?.storeId && source === this.pendingInputSource();
      try {
        await this.listingMutation(() => this.client.verifyCompletion!(target.sessionId, target.runId, input));
        if (current()) {
          this.invalidateConversationCache(target.sessionId);
          this.update({ actionNotice: "Completion verification recorded. Refreshing native run status." });
          this.reconnect();
        }
      } catch (error) {
        if (current() && !this.expired(error)) this.update({ interactionError: `${error instanceof Error ? error.message : "Completion verification unavailable."} Retry verification to check the same request; no prompt was resent.` });
      } finally {
        this.completionVerificationBusy.delete(key);
        if (current()) this.update({ actionBusy: false });
      }
    };
  };
  private pendingInputVisible = false;
  private pendingInputRead?: { key: string; promise: Promise<boolean> };
  private pendingInputLastRead = 0;
  private pendingInputFresh = "";
  private pendingInputNamespace = "";
  private pendingInputRecords = new Map<string, PendingInputRecord>();
  private pendingInputTerminals = new Map<string, { operation: PendingInputOperation; sourceScope: string }>();
  private pendingInputViews = new Map<string, PendingInputView>();
  private pendingInputConfirmedChains = new Set<string>();
  private pendingInputReadSerial = 0;
  private pendingInputAcknowledged = new Map<string, { revision: number; readSerial: number }>();
  private pendingInputContextFailure = "";
  private pendingInputMutations = new Set<string>();
  private pendingInputSuspended = false;
  private pendingInputStorageError = "";
  private pendingInputConfig?: Config;
  private pendingInputConfigEpoch = 0;
  private pendingInputVerifiedKey = "";
  private pendingInputVerifiedAt = 0;
  private pendingInputOrigin = () => typeof location === "undefined" ? "local" : location.origin;
  private pendingInputSource = (id = this.state.selected) => {
    const c = this.state.conversations.find(c => c.id === id);
    return c ? JSON.stringify([c.harness, c.authorityId ?? null, c.nativeSessionId ?? null, c.cwd]) : "";
  };
  private pendingInputStoreId = (value: unknown): value is string => typeof value === "string" && value === value.trim() && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  private pendingInputKey = () => !this.pendingInputSuspended && this.state.phase === "ready" && this.state.config?.authenticated === true && this.pendingInputStoreId(this.state.config.storeId)
    ? pendingInputLedgerKey(this.pendingInputOrigin(), this.state.config.storeId) : "";
  private pendingInputFence = () => {
    if (this.pendingInputConfig !== this.state.config) { this.pendingInputConfig = this.state.config; this.pendingInputConfigEpoch++; }
    const c = this.state.conversations.find(c => c.id === this.state.selected);
    return JSON.stringify([this.authEpoch, this.selectionEpoch, this.pendingInputConfigEpoch, this.pendingInputKey(), this.state.selected, this.pendingInputSource(), c?.profileId, c?.model, c?.effort, c?.agent, this.draft().upgradeId]);
  };
  private pendingInputLedger = () => {
    const key = this.pendingInputKey();
    if (!key) throw new Error("Sign in to an identified App store before queueing.");
    try { return new PendingInputLedger(key, localStorage); }
    catch { throw new Error("Durable browser recovery storage is unavailable. Your draft is unchanged."); }
  };
  private pendingInputSourceMatches(source: PendingInputRequest["source"] | null, id = this.state.selected, scope = this.pendingInputSource(id)) {
    return !!source && source.authorityId !== null && source.nativeSessionId !== null && source.conversationId === id
      && JSON.stringify([source.harnessId, source.authorityId, source.nativeSessionId, source.cwd]) === scope;
  }
  /** Boot config is a namespace selection, not permission to replay into whatever
   * App later occupies the same origin. Never switch the original ledger here. */
  private async verifyPendingInputContext(namespace: string, fence: string): Promise<boolean> {
    // Consecutive verifications for unchanged state share one config read.
    // refreshPendingInputs verifies before and after its queue read, which
    // would otherwise issue two identical config requests back to back.
    const cacheKey = `${namespace}|${fence}`;
    if (cacheKey === this.pendingInputVerifiedKey && Date.now() - this.pendingInputVerifiedAt < 5000) {
      // Skip only the network read. The synchronous fence check still runs:
      // state that moved on since the cached verification must not publish.
      return fence === this.pendingInputFence() && namespace === this.pendingInputKey();
    }
    try {
      const config = await this.client.config();
      if (fence !== this.pendingInputFence() || namespace !== this.pendingInputKey()) return false;
      if (!config || config.authenticated !== true || !this.pendingInputStoreId(config.storeId)
        || pendingInputLedgerKey(this.pendingInputOrigin(), config.storeId) !== namespace
        || !isPendingInputCapability(config.pendingInputCapability)) throw new Error("The authenticated App store changed or queue support is unavailable. Original operations remain unconfirmed; nothing was redirected.");
      this.pendingInputContextFailure = "";
      this.pendingInputVerifiedKey = cacheKey; this.pendingInputVerifiedAt = Date.now();
      return true;
    } catch (cause) {
      if (cacheKey === this.pendingInputVerifiedKey) this.pendingInputVerifiedKey = "";
      if (fence === this.pendingInputFence() && namespace === this.pendingInputKey()) {
        this.invalidatePendingInputContext(namespace, cause instanceof Error ? cause.message : "Fresh App store identification is unavailable. Nothing was sent.");
      }
      return false;
    }
  }
  private invalidatePendingInputContext(namespace: string, error: string) {
    this.pendingInputVerifiedKey = "";
    this.pendingInputContextFailure = namespace; this.pendingInputFresh = "";
    for (const [id, view] of this.pendingInputViews) if (view.presentation.chainLocked) this.pendingInputConfirmedChains.add(id);
    this.pendingInputViews.clear();
    this.update({ pendingInputs: null, pendingInputOperations: {}, pendingInputError: error });
  }
  private acknowledgePendingInput(id: string, revision: number) {
    const previous = this.pendingInputAcknowledged.get(id);
    this.pendingInputAcknowledged.set(id, { revision: Math.max(previous?.revision ?? 0, revision), readSerial: this.pendingInputReadSerial });
  }
  private async freshPendingInputs(fence: string): Promise<boolean> {
    // After an acknowledgement, settle every older read, then START a GET.
    while (this.pendingInputRead) {
      const read = this.pendingInputRead;
      await read.promise;
      if (this.pendingInputRead?.promise === read.promise) this.pendingInputRead = undefined;
      if (fence !== this.pendingInputFence()) return false;
    }
    return fence === this.pendingInputFence() && this.refreshPendingInputs();
  }
  private loadPendingInputLedger(publish = true) {
    const namespace = this.pendingInputKey();
    if (namespace !== this.pendingInputNamespace) {
      this.pendingInputNamespace = namespace; this.pendingInputRecords.clear(); this.pendingInputTerminals.clear(); this.pendingInputViews.clear(); this.pendingInputConfirmedChains.clear(); this.pendingInputAcknowledged.clear(); this.pendingInputContextFailure = ""; this.pendingInputFresh = "";
      if (publish) this.update({ pendingInputs: null, pendingInputLoading: false, pendingInputError: "", pendingInputOperations: {} });
    }
    this.pendingInputStorageError = "";
    if (namespace) try {
      const records = this.pendingInputLedger().read(), next = new Map<string, PendingInputRecord>();
      for (const record of records) {
        const previous = this.pendingInputRecords.get(record.operation.requestId);
        next.set(record.operation.requestId, previous ?? { ...record, operation: { ...record.operation, state: "unknown", error: "Original queue operation is unconfirmed. Check status or explicitly retransmit the same identity." } });
      }
      // A storage failure must not discard a locally known unconfirmed request.
      for (const [id, record] of this.pendingInputRecords) if (!next.has(id)) next.set(id, record);
      this.pendingInputRecords = next;
    } catch (error) { this.pendingInputStorageError = error instanceof Error ? error.message : "Pending-input recovery storage is unavailable."; }
    if (publish) this.publishPendingInputOperations();
  }
  private publishPendingInputOperations() {
    if (this.pendingInputContextFailure && this.pendingInputContextFailure === this.pendingInputKey()) { this.update({ pendingInputOperations: {} }); return; }
    const scope = this.pendingInputSource(), id = this.state.selected;
    const operations: Record<string, PendingInputOperation> = {};
    for (const { operation, sourceScope } of this.pendingInputTerminals.values()) if (operation.conversationId === id && sourceScope === scope) operations[operation.requestId] = operation;
    for (const record of this.pendingInputRecords.values()) if (record.operation.conversationId === id && record.sourceScope === scope) operations[record.operation.requestId] = record.operation;
    const drift = [...this.pendingInputRecords.values()].some(r => r.operation.conversationId === id && r.sourceScope !== scope);
    this.update({ pendingInputOperations: equalValue(operations, this.state.pendingInputOperations) ? this.state.pendingInputOperations : operations, ...(this.pendingInputStorageError || drift ? { pendingInputError: this.pendingInputStorageError || "An unconfirmed queue operation belongs to the original native source. It cannot be redirected here." } : {}) });
  }
  private clearPendingInputDisplay() {
    this.pendingInputSuspended = true;
    this.pendingInputNamespace = ""; this.pendingInputRecords.clear(); this.pendingInputTerminals.clear(); this.pendingInputViews.clear(); this.pendingInputConfirmedChains.clear(); this.pendingInputAcknowledged.clear(); this.pendingInputContextFailure = ""; this.pendingInputFresh = "";
    this.update({ pendingInputs: null, pendingInputLoading: false, pendingInputError: "", pendingInputOperations: {} });
  }
  pendingInputSupported = (): boolean => {
    const p = this.state.pendingInputs?.presentation;
    return !!this.pendingInputKey() && this.pendingInputContextFailure !== this.pendingInputKey() && isPendingInputCapability(this.state.config?.pendingInputCapability)
      && (!p?.source || this.pendingInputSourceMatches(p.source)) && (!p?.currentAssertions || this.pendingInputSourceMatches(p.currentAssertions.source));
  };
  pendingInputChainLocked = (): boolean => {
    if (!this.state.selected || this.state.phase !== "ready") return false;
    this.loadPendingInputLedger(false);
    return !!this.pendingInputContextFailure && this.pendingInputContextFailure === this.pendingInputKey() || !!this.pendingInputStorageError && this.pendingInputSupported() || [...this.pendingInputRecords.values()].some(r => r.operation.conversationId === this.state.selected)
      || this.pendingInputMutations.has(`${this.pendingInputKey()}:${this.state.selected}`)
      || this.pendingInputConfirmedChains.has(this.state.selected)
      || !!this.pendingInputViews.get(this.state.selected)?.presentation.chainLocked
      || this.state.pendingInputs?.snapshot.conversationId === this.state.selected && this.state.pendingInputs.presentation.chainLocked;
  };
  pendingInputUnavailable = (): string => {
    if (!this.pendingInputSupported()) return "App-owned input queue is unavailable on this bridge.";
    if (!this.state.selected || this.state.phase !== "ready") return "Choose an authenticated conversation to queue an input.";
    this.loadPendingInputLedger(false);
    if (this.pendingInputStorageError) return this.pendingInputStorageError;
    if ([...this.pendingInputRecords.values()].some(r => r.operation.conversationId === this.state.selected)) return "Resolve the original unconfirmed queue operation first.";
    if (this.pendingInputRecords.size >= 32) return "Pending-input recovery ledger is full. Resolve an original operation first.";
    if (this.draft().upgradeId) return "Assign the staged profile with an ordinary send before queueing. Your draft is unchanged.";
    if (this.state.sending || this.state.actionBusy || this.compactBlocked()) return "Wait for the current action to settle.";
    if (this.state.pendingInputLoading) return "Reading current queue eligibility…";
    if (this.pendingInputFresh !== this.pendingInputFence() || !this.state.pendingInputs) return this.state.pendingInputError || "Read current queue eligibility before queueing.";
    const p = this.state.pendingInputs.presentation;
    if (!p.automation.supported) return p.automation.reason || "Queue automation is unavailable.";
    if (!p.enqueue.allowed) return p.enqueue.reason || "Queue admission is unavailable.";
    if (!p.currentAssertions) return "Current queue source and configuration are unavailable.";
    if (p.chainLocked && !equalValue(p.configuration, p.currentAssertions.configuration)) return "Current configuration differs from the original waiting chain.";
    return "";
  };
  setPendingInputVisible = (visible: boolean): void => {
    this.pendingInputVisible = visible;
    if (visible) { this.loadPendingInputLedger(); if (typeof document !== "undefined" && !document.hidden) void this.refreshPendingInputs(); }
  };
  refreshPendingInputs = async (): Promise<boolean> => {
    const id = this.state.selected, key = this.pendingInputFence(), namespace = this.pendingInputKey();
    if (!id || !namespace || !isPendingInputCapability(this.state.config?.pendingInputCapability) || !this.client.pendingInputs) { this.loadPendingInputLedger(); return false; }
    if (this.pendingInputRead) {
      if (this.pendingInputRead.key === key) return this.pendingInputRead.promise;
      await this.pendingInputRead.promise;
      return key === this.pendingInputFence() ? this.refreshPendingInputs() : false;
    }
    this.loadPendingInputLedger(); this.pendingInputLastRead = Date.now();
    const readSerial = ++this.pendingInputReadSerial;
    // The private read still fences every GET and mutation. Only initial or
    // source-invalidated reads need visible loading; retries retain attention.
    this.update({ pendingInputLoading: !this.state.pendingInputError
      && (this.pendingInputFresh !== key || this.state.pendingInputs?.snapshot.conversationId !== id) });
    const promise = (async () => {
      try {
        if (!await this.verifyPendingInputContext(namespace, key)) return false;
        const view = await this.client.pendingInputs!(id);
        if (!isPendingInputView(view, id)) throw new Error("Invalid queue projection. Queue state is stale.");
        if (!await this.verifyPendingInputContext(namespace, key)) return false;
        if (view.presentation.source && !this.pendingInputSourceMatches(view.presentation.source)) {
          this.invalidatePendingInputContext(namespace, "The queue belongs to a different native source. Refresh the conversation before using it."); return false;
        }
        const acknowledged = this.pendingInputAcknowledged.get(id);
        if (acknowledged && (readSerial <= acknowledged.readSerial || view.snapshot.revision < acknowledged.revision)) return false;
        this.pendingInputFresh = key; this.pendingInputViews.set(id, view); this.pendingInputConfirmedChains.delete(id);
        if (this.pendingInputViews.size > 32) {
          const removable = [...this.pendingInputViews].find(([other]) => other !== id);
          if (removable) {
            // Bound cached text without silently forgetting a known chain lock.
            if (removable[1].presentation.chainLocked) this.pendingInputConfirmedChains.add(removable[0]);
            this.pendingInputViews.delete(removable[0]);
          }
        }
        this.update({ pendingInputs: view, pendingInputError: "" }); this.publishPendingInputOperations();
        return true;
      } catch (error) {
        if (key === this.pendingInputFence()) {
          this.pendingInputFresh = "";
          if (!this.expired(error)) this.update({ pendingInputError: `Queue state is stale: ${error instanceof Error ? error.message : "connection error"}. No input was retried.` });
        }
        return false;
      } finally { if (key === this.pendingInputFence()) this.update({ pendingInputLoading: false }); }
    })();
    this.pendingInputRead = { key, promise };
    try { return await promise; }
    finally { if (this.pendingInputRead?.promise === promise) this.pendingInputRead = undefined; }
  };
  private pendingInputPolling() {
    if (!this.pendingInputVisible || typeof document !== "undefined" && document.hidden || Date.now() - this.pendingInputLastRead < 5000) return;
    this.loadPendingInputLedger(false);
    const id = this.state.selected, view = this.pendingInputViews.get(id);
    if (view && !view.presentation.chainLocked && !view.presentation.unresolved && !view.presentation.pauseCode
      && this.pendingInputSourceMatches(view.presentation.currentAssertions?.source ?? null)
      && !this.pendingInputConfirmedChains.has(id) && !this.pendingInputContextFailure && !this.pendingInputStorageError
      && !this.state.pendingInputError && !this.pendingInputMutations.has(`${this.pendingInputKey()}:${id}`)
      && ![...this.pendingInputRecords.values()].some(record => record.operation.conversationId === id)) return;
    void this.refreshPendingInputs();
  }
  private async newPendingInputOperation(kind: PendingInputOperation["kind"], text?: string, itemId?: string): Promise<SendOutcome> {
    if (kind === "enqueue" && this.appAdmissionSupported()) {
      const fence = this.pendingInputFence();
      if (!await this.loadAppAdmissions(true) || fence !== this.pendingInputFence()) return { status: "blocked" };
      if ([...this.appAdmissionRecords.values()].some(record => (!record.receipt || record.receipt.state === "pending")
        && (record.draftKey === this.draftKey() || record.envelope.intent.conversationId === this.state.selected))) {
        this.update({ pendingInputError: "Resolve the original App admission request before queueing another input in this conversation or draft chain." });
        return { status: "blocked" };
      }
    }
    if (kind === "enqueue" && this.draft().scienceSnapshots?.length) { this.update({ pendingInputError: "Science snapshots cannot be queued. Send them from an idle conversation." }); return { status: "blocked" }; }
    const id = this.state.selected, fence = this.pendingInputFence(), namespace = this.pendingInputKey(), lock = `${namespace}:${id}`;
    if (!id || !namespace || !isPendingInputCapability(this.state.config?.pendingInputCapability) || this.pendingInputMutations.has(lock)) return { status: "blocked" };
    this.loadPendingInputLedger();
    if (this.pendingInputStorageError || [...this.pendingInputRecords.values()].some(r => r.operation.conversationId === id)) return { status: "blocked" };
    if (kind === "enqueue" && (!text?.trim() || compactCommand(text) || this.draft().upgradeId || this.state.sending || this.state.actionBusy || this.compactBlocked())) {
      this.update({ pendingInputError: compactCommand(text ?? "") ? "Use ordinary /compact; compaction cannot be queued." : this.pendingInputUnavailable() }); return { status: "blocked" };
    }
    const draftKey = this.draftKey(), draftText = this.draft().text, sourceScope = this.pendingInputSource();
    const draftStamp = this.composerStamp(draftKey);
    this.pendingInputMutations.add(lock);
    try {
      // A mutation must observe a GET started for this explicit action, not
      // borrow an earlier poll/Stop read that may already hold an old revision.
      if (!await this.freshPendingInputs(fence) || fence !== this.pendingInputFence()) return { status: "blocked" };
      // Another tab may have saved an unresolved intent during the GET.
      this.loadPendingInputLedger();
      if (this.pendingInputStorageError || [...this.pendingInputRecords.values()].some(r => r.operation.conversationId === id)) return { status: "blocked" };
      const view = this.state.pendingInputs!, p = view.presentation;
      let body: PendingInputRecord["body"];
      if (kind === "enqueue") {
        if (this.draft().scienceSnapshots?.length) { this.update({ pendingInputError: "Science snapshots cannot be queued." }); return { status: "blocked" }; }
        const unavailable = this.pendingInputUnavailable();
        if (unavailable || !this.client.enqueuePendingInput) { this.update({ pendingInputError: unavailable || "Queue submission is unavailable." }); return { status: "blocked" }; }
        const source = p.currentAssertions!.source;
        if (!this.pendingInputSourceMatches(source, id, sourceScope)) { this.update({ pendingInputError: "The native source changed. Refresh the conversation before queueing; your draft is unchanged." }); return { status: "blocked" }; }
        body = { version: 1, requestId: crypto.randomUUID(), conversationId: id, text: text!, source: structuredClone(p.currentAssertions!.source), configuration: structuredClone(p.currentAssertions!.configuration) };
      } else if (kind === "remove") {
        const item = view.snapshot.items.find(i => i.itemId === itemId);
        if (!this.client.removePendingInput || !item || item.state !== "waiting" || !this.pendingInputSourceMatches(p.source, id, sourceScope)
          || !this.pendingInputSourceMatches(item.source, id, sourceScope) || !p.removals.find(r => r.itemId === itemId)?.allowed) { this.update({ pendingInputError: "This input is no longer removable waiting work." }); return { status: "blocked" }; }
        body = { version: 1, requestId: crypto.randomUUID(), conversationId: id, inputRequestId: item.requestId, itemId: item.itemId };
      } else {
        if (!this.client.resumePendingInputs || !p.resumeAllowed || p.unresolved || this.draft().upgradeId
          || !this.pendingInputSourceMatches(p.source, id, sourceScope) || !this.pendingInputSourceMatches(p.currentAssertions?.source ?? null, id, sourceScope)
          || !equalValue(p.configuration, p.currentAssertions?.configuration)
          || !p.enqueue.allowed && p.enqueue.code !== "pending-input-full") { this.update({ pendingInputError: "The existing chain is not eligible to resume at its current revision and selected source." }); return { status: "blocked" }; }
        body = { version: 1, requestId: crypto.randomUUID(), conversationId: id, action: "resume", expectedRevision: view.snapshot.revision };
      }
      const record: PendingInputRecord = { operation: { kind, requestId: body.requestId, conversationId: id, state: "pending", ...(text === undefined ? {} : { text }) }, body,
        sourceScope, ...(kind === "enqueue" ? { draftKey, draftText } : {}) };
      const ledger = this.pendingInputLedger();
      ledger.reserve(record); // Durable immutable UUID/body BEFORE any POST.
      if (kind === "enqueue" && text === draftText) this.pendingInputDraftStamps.set(body.requestId, draftStamp);
      this.pendingInputRecords.set(body.requestId, record); this.publishPendingInputOperations();
      return await this.transmitPendingInput(record, ledger, fence);
    } catch (error) {
      if (fence === this.pendingInputFence()) this.update({ pendingInputError: `${error instanceof Error ? error.message : "Recovery storage unavailable"} Your draft is unchanged.` });
      return { status: "blocked" };
    } finally { this.pendingInputMutations.delete(lock); if (namespace === this.pendingInputKey() && id === this.state.selected) this.update({ pendingInputOperations: { ...this.state.pendingInputOperations } }); }
  }
  enqueuePendingInput = (text: string): Promise<SendOutcome> => this.newPendingInputOperation("enqueue", text);
  removePendingInput = async (itemId: string): Promise<void> => { await this.newPendingInputOperation("remove", undefined, itemId); };
  resumePendingInputs = async (): Promise<void> => { await this.newPendingInputOperation("resume"); };
  private async transmitPendingInput(record: PendingInputRecord, ledger: PendingInputLedger, fence: string): Promise<SendOutcome> {
    const { operation: o, body } = record, id = o.conversationId;
    const current = () => fence === this.pendingInputFence() && ledger.key === this.pendingInputKey() && record.sourceScope === this.pendingInputSource();
    let state: PendingInputOperation["state"] = "unknown", error = "", outcome: SendOutcome = { status: "unknown" };
    try {
      if (!current() || !await this.verifyPendingInputContext(ledger.key, fence) || !current()) throw new Error("Fresh original App store verification failed. No request was sent.");
      // Give the client a copy; the persisted body remains the original intent.
      if (o.kind === "enqueue") {
        const result = await this.client.enqueuePendingInput!(id, structuredClone(body as PendingInputRequest));
        if (!isPendingInputSubmissionResult(result, body)) throw new Error("Invalid queue acknowledgement.");
        if (result.outcome !== "enqueued") throw new Error(result.outcome === "uncertain" ? result.reason : "Expected the original enqueue receipt, not run admission.");
        if (!await this.verifyPendingInputContext(ledger.key, fence) || !current()) throw new Error("Queue acknowledgement could not be verified in the original App store.");
        this.acknowledgePendingInput(id, result.revision);
        state = "confirmed"; outcome = { status: "queued", conversationId: id, requestId: o.requestId };
      } else if (o.kind === "remove") {
        const result = await this.client.removePendingInput!(id, structuredClone(body as PendingInputRemovalRequest));
        if (!isPendingInputRemovalResult(result, body)) throw new Error("Invalid removal acknowledgement.");
        if (!await this.verifyPendingInputContext(ledger.key, fence) || !current()) throw new Error("Removal acknowledgement could not be verified in the original App store.");
        this.acknowledgePendingInput(id, result.revision);
        state = "confirmed"; error = result.outcome === "claimed" ? "This input is already claimed; it was not removed." : "";
      } else {
        const result = await this.client.resumePendingInputs!(id, structuredClone(body as PendingInputResumeRequest));
        if (!isPendingInputResumeResult(result, body as PendingInputResumeRequest)) throw new Error("Invalid resume acknowledgement.");
        if (!await this.verifyPendingInputContext(ledger.key, fence) || !current()) throw new Error("Resume acknowledgement could not be verified in the original App store.");
        this.acknowledgePendingInput(id, result.revision);
        state = "confirmed";
      }
    } catch (cause) {
      const definite = isDefinitePendingInputRefusal(cause, o.kind) && current() && await this.verifyPendingInputContext(ledger.key, fence) && current();
      state = definite ? "rejected" : "unknown"; outcome = { status: definite ? "rejected" : "unknown" };
      error = `${cause instanceof Error ? cause.message : "Queue response unavailable."}${definite ? "" : " Acceptance is unconfirmed. Check status or explicitly retransmit the original UUID; no automatic retry occurs."}`;
    }
    const operation = { ...o, state, error }, next = { ...record, operation };
    try { if (state === "unknown") ledger.unknown(next, error); else ledger.finish(o.requestId); }
    catch (cause) { error += ` Recovery storage: ${cause instanceof Error ? cause.message : "unavailable"}.`; }
    if (ledger.key === this.pendingInputNamespace) {
      if (state === "confirmed" && o.kind === "enqueue") this.pendingInputConfirmedChains.add(id);
      if (state === "unknown") this.pendingInputRecords.set(o.requestId, next);
      else {
        this.pendingInputRecords.delete(o.requestId); this.pendingInputTerminals.set(o.requestId, { operation: { ...operation, error }, sourceScope: record.sourceScope });
        if (this.pendingInputTerminals.size > 32) this.pendingInputTerminals.delete(this.pendingInputTerminals.keys().next().value!);
      }
      if (current()) { this.update({ pendingInputError: error }); this.publishPendingInputOperations(); }
    }
    if (current()) {
      if (state === "confirmed") {
        const fresh = await this.freshPendingInputs(fence);
        const stamp = this.pendingInputDraftStamps.get(o.requestId);
        if (fresh && current() && o.kind === "enqueue" && record.draftKey === this.draftKey() && stamp
          && sameComposerStamp(stamp, this.composerStamp(record.draftKey))) this.setDraft({ text: "" });
        if (current() && error) this.update({ pendingInputError: error });
      }
      if (state === "rejected") await this.freshPendingInputs(fence);
    }
    return outcome;
  }
  checkPendingInput = async (requestId: string): Promise<void> => {
    this.loadPendingInputLedger();
    const record = this.pendingInputRecords.get(requestId), fence = this.pendingInputFence();
    if (!record || record.operation.conversationId !== this.state.selected || record.sourceScope !== this.pendingInputSource() || record.operation.state === "pending") return;
    let ledger: PendingInputLedger;
    try { ledger = this.pendingInputLedger(); }
    catch (cause) { this.update({ pendingInputError: cause instanceof Error ? cause.message : "Recovery storage unavailable." }); return; }
    const lock = `${ledger.key}:${record.operation.conversationId}`;
    if (this.pendingInputMutations.has(lock)) return;
    this.pendingInputMutations.add(lock);
    try {
      if (!await this.verifyPendingInputContext(ledger.key, fence)) return;
      if (record.operation.kind !== "enqueue") {
        await this.refreshPendingInputs();
        if (fence !== this.pendingInputFence()) return;
        let reason = "A queue GET cannot confirm the original resume consent. Explicit retransmission preserves its UUID and observed revision.";
        if (record.operation.kind === "remove") {
          const body = record.body as PendingInputRemovalRequest, s = this.state.pendingInputs?.snapshot;
          reason = s?.tombstones.some(i => i.itemId === body.itemId && i.requestId === body.inputRequestId) ? "The original target is removed; GET cannot confirm this specific removal receipt."
            : s?.items.some(i => i.itemId === body.itemId && i.state !== "waiting") ? "The original target is claimed and cannot be removed. Explicit retransmission will reconcile the same removal identity."
            : "The original removal receipt is unconfirmed. A missing target is not proof; explicitly retransmit the original identity to reconcile.";
        }
        ledger.unknown(record, reason); this.pendingInputRecords.set(requestId, { ...record, operation: { ...record.operation, error: reason } });
        this.update({ pendingInputError: reason }); this.publishPendingInputOperations(); return;
      }
      if (!this.client.pendingInputStatus) throw new Error("Original-input status is unavailable.");
      const result = await this.client.pendingInputStatus(record.operation.conversationId, requestId);
      if (!isPendingInputStatus(result, record.operation.conversationId, requestId)) throw new Error("Invalid original-input receipt.");
      if (!await this.verifyPendingInputContext(ledger.key, fence)) return;
      this.acknowledgePendingInput(record.operation.conversationId, result.receipt.revision);
      ledger.finish(requestId);
      if (ledger.key !== this.pendingInputNamespace) return;
      this.pendingInputConfirmedChains.add(record.operation.conversationId);
      this.pendingInputRecords.delete(requestId); this.pendingInputTerminals.set(requestId, { operation: { ...record.operation, state: "confirmed", error: "" }, sourceScope: record.sourceScope });
      if (this.pendingInputTerminals.size > 32) this.pendingInputTerminals.delete(this.pendingInputTerminals.keys().next().value!);
      if (fence === this.pendingInputFence()) {
        this.publishPendingInputOperations();
        const fresh = await this.freshPendingInputs(fence), stamp = this.pendingInputDraftStamps.get(requestId);
        if (fresh && fence === this.pendingInputFence() && record.draftKey === this.draftKey() && stamp
          && sameComposerStamp(stamp, this.composerStamp(record.draftKey))) this.setDraft({ text: "" });
      }
    } catch (cause) {
      const reason = `${cause instanceof Error ? cause.message : "Status unavailable."} The original operation remains unconfirmed; missing/404 does not prove it cannot commit.`;
      try { ledger.unknown(record, reason); } catch { /* Existing durable identity remains; never mint a replacement. */ }
      if (ledger.key === this.pendingInputNamespace) this.pendingInputRecords.set(requestId, { ...record, operation: { ...record.operation, state: "unknown", error: reason } });
      if (fence === this.pendingInputFence()) { this.update({ pendingInputError: reason }); this.publishPendingInputOperations(); }
    } finally { this.pendingInputMutations.delete(lock); if (ledger.key === this.pendingInputKey() && record.operation.conversationId === this.state.selected) this.update({ pendingInputOperations: { ...this.state.pendingInputOperations } }); }
  };
  retransmitPendingInput = async (requestId: string): Promise<void> => {
    this.loadPendingInputLedger();
    const record = this.pendingInputRecords.get(requestId), fence = this.pendingInputFence();
    if (!record || record.operation.conversationId !== this.state.selected || record.sourceScope !== this.pendingInputSource() || record.operation.state === "pending") return;
    let ledger: PendingInputLedger;
    try { ledger = this.pendingInputLedger(); }
    catch (cause) { this.update({ pendingInputError: cause instanceof Error ? cause.message : "Recovery storage unavailable." }); return; }
    const lock = `${ledger.key}:${record.operation.conversationId}`;
    if (this.pendingInputMutations.has(lock)) return;
    this.pendingInputMutations.add(lock);
    try {
      if (!await this.verifyPendingInputContext(ledger.key, fence)) return;
      // This is explicit replay ONLY: no fresh assertions, UUID, or resume CAS.
      ledger.unknown(record, "Explicitly retransmitting the original immutable request.");
      const pending = { ...record, operation: { ...record.operation, state: "pending" as const } };
      this.pendingInputRecords.set(requestId, pending); this.publishPendingInputOperations();
      await this.transmitPendingInput(pending, ledger, fence);
    } catch (cause) { if (fence === this.pendingInputFence()) this.update({ pendingInputError: cause instanceof Error ? cause.message : "Recovery unavailable. No request was sent." }); }
    finally { this.pendingInputMutations.delete(lock); if (ledger.key === this.pendingInputKey() && record.operation.conversationId === this.state.selected) this.update({ pendingInputOperations: { ...this.state.pendingInputOperations } }); }
  };
  private listeners = new Set<() => void>();
  private shellRevision = 0;
  private generation = 0;
  private authEpoch = 0;
  // Parent-attention reads belong to auth, never the selected transcript generation.
  private notificationFence = 0;
  private notificationController?: AbortController;
  private notificationTimer?: ReturnType<typeof setTimeout>;
  private notificationScope = "";
  private notificationSources = new Map<string, string>();
  private queuedNotificationReceipts = new Map<string, Set<string>>();
  private notificationRefreshCursor?: { epoch: string; after: number };
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private pollFlight?: { generation: number };
  private selectedRefreshPending = false;
  private unsubscribeRefreshWake?: () => void;
  private emittingListingWake = false;
  private subscribeRefreshWake() {
    if (this.unsubscribeRefreshWake) return;
    this.unsubscribeRefreshWake = subscribeWake(id => {
      // Listing changes wake auxiliary consumers, not this same poll again.
      if (!this.emittingListingWake && (!id || id === this.state.selected)) this.requestSelectedRefresh();
    });
  }
  /** Read-only invalidation. A burst during a poll becomes ONE fresh successor;
   * never abort useful history progress or replay a composer/queue operation. */
  private requestSelectedRefresh = () => {
    if (this.state.phase !== "ready") return;
    this.selectedRefreshPending = true;
    clearTimeout(this.timer); this.timer = undefined;
    if (this.state.sending || typeof document !== "undefined" && document.hidden || this.pollFlight?.generation === this.generation) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.poll(); }, 0);
  };
  private runMap = new Map<string, Run>();
  private conversationCache = new ConversationCache();
  private conversationListing: ConversationListing;
  private groupListing: ConversationGroupListing;
  private conversationQuery: SessionCatalogQuery = { mode: "chat", limit: 50 };
  private catalogController = new AbortController();
  private summaryRequests = new Set<AbortController>();
  private catalogHead?: Promise<void>;
  private catalogCursor: string | null = null;
  private catalogSnapshotPinned = false;
  private catalogMoreSerial = 0;
  private catalogMoreError = "";
  private catalogSummarySerial = 0;
  private catalogSummaryVersions = new Map<string, number>();
  private catalogMissing = new Set<string>();

  setConversationQuery = (query: SessionCatalogQuery): void => {
    const next = { ...query, limit: query.limit ?? 50, cursor: undefined };
    const grouped = this.groupListing.enabled;
    this.groupListing.disable();
    if (!grouped && conversationQueryKey(next) === conversationQueryKey(this.conversationQuery) && this.state.conversationPage) return;
    this.conversationQuery = next;
    this.update({ conversationGroups: undefined, conversationGroupDirectory: undefined });
    this.resetConversationPages();
    if (this.state.phase === "ready") void this.refreshConversationHead();
  };
  setConversationGroups = (baseQuery: SessionCatalogQuery, expandedQueries: SessionCatalogQuery[]): void => {
    if (!this.groupListing.enabled) {
      this.catalogController.abort(); this.catalogController = new AbortController();
      this.catalogHead = undefined; this.catalogCursor = null; this.catalogSnapshotPinned = false;
      this.catalogMoreSerial++; this.catalogMoreError = "";
    }
    this.conversationQuery = { ...baseQuery, limit: conversationGroupPageSize(baseQuery.mode), cursor: undefined };
    this.groupListing.configure(this.conversationQuery, expandedQueries);
  };
  loadMoreConversationGroup = (query: SessionCatalogQuery): Promise<void> => this.groupListing.more(query);
  retryConversationGroup = (query: SessionCatalogQuery): void => this.groupListing.retry(query);
  retryConversationGroups = (): void => this.groupListing.retryDirectory();
  private resetConversationPages() {
    this.catalogController.abort(); this.catalogController = new AbortController();
    this.catalogHead = undefined; this.catalogCursor = null;
    this.catalogSnapshotPinned = false; this.catalogMoreSerial++;
    this.catalogMoreError = "";
    this.update({ conversationPageIds: [], conversationPage: { hasMore: false, loading: this.state.phase !== "login", loadingMore: false, error: "", queryKey: conversationQueryKey(this.conversationQuery) } });
  }
  private conversationPagePatch(patch: Partial<NonNullable<State["conversationPage"]>>) {
    this.update({ conversationPage: { hasMore: false, loading: false, loadingMore: false, error: "", queryKey: conversationQueryKey(this.conversationQuery), ...this.state.conversationPage, ...patch } });
  }
  /** Old loaded tails keep their original frozen snapshot cursor. Head refreshes
   * prepend new matches, but never splice a new snapshot into that traversal.
   * Expiry (409) explicitly resets sidebar IDs to a fresh head, not the cache. */
  private refreshConversationHead(): Promise<void> {
    if (this.groupListing.enabled) return Promise.resolve();
    if (this.catalogHead) return this.catalogHead;
    const owner = this.catalogController, auth = this.authEpoch, query = this.conversationQuery, readSerial = ++this.catalogSummarySerial;
    // Sidebar acquisition belongs to its query/auth owner, not to whichever
    // selected poll first requested it. Selection changes must not strand an
    // aborted head promise or turn an unacquired first page into "no matches".
    const requestSignal = AbortSignal.any([owner.signal, AbortSignal.timeout(25000)]);
    const current = () => owner === this.catalogController && auth === this.authEpoch && this.state.phase === "ready";
    this.conversationPagePatch({ loading: !this.state.conversationsReady || !this.state.conversationPageIds?.length });
    const task = (async () => {
      try {
        const acquired = await this.conversationListing.read(requestSignal, 1000, query);
        requestSignal.throwIfAborted();
        if (!current() || acquired.revision !== this.conversationListing.revision) return;
        const data = acquired.value;
        if (!data.page) {
          this.conversationCache.prune(data.conversations);
          this.update({ conversations: data.conversations, conversationsReady: true, conversationPageIds: undefined, conversationPage: undefined, globalAvailability: data.availability });
          registerWorkerSessions(data.conversations); this.observeNotifications(data.conversations);
          return;
        }
        const tail = this.catalogSnapshotPinned ? this.state.conversationPageIds ?? [] : [];
        if (!this.catalogSnapshotPinned) {
          this.catalogCursor = data.page.nextCursor;
          // Even an initially exhausted snapshot remains exhausted. New head
          // membership is still merged without silently reopening traversal.
          if (!data.page.hasMore) this.catalogSnapshotPinned = true;
        }
        // A fresh head can authoritatively rediscover an explicitly restored
        // session; an old frozen continuation cannot undo a missing result.
        this.mergeConversationSummaries(data.conversations, data.availability, [], readSerial, true);
        if (!current()) return;
        const head = [...new Set(data.conversations.map(c => c.id))].filter(id => !this.catalogMissing.has(id));
        this.update({ conversationsReady: true, conversationPageIds: [...new Set([...head, ...tail])] });
        this.conversationPagePatch({ hasMore: this.catalogCursor !== null, error: this.catalogMoreError });
      } catch (error) {
        if (current() && !this.expired(error)) this.conversationPagePatch({ error: error instanceof Error ? error.message : "Conversations unavailable." });
      } finally {
        if (current() && this.state.conversationPage) this.conversationPagePatch({ loading: false });
      }
    })();
    this.catalogHead = task;
    void task.finally(() => { if (this.catalogHead === task) this.catalogHead = undefined; });
    return task;
  }
  loadMoreConversations = async (): Promise<void> => {
    if (this.groupListing.enabled) return;
    if (this.state.phase !== "ready" || !this.catalogCursor || this.state.conversationPage?.loadingMore || this.state.conversationPage?.loading) return;
    const owner = this.catalogController, auth = this.authEpoch, serial = ++this.catalogMoreSerial;
    const cursor = this.catalogCursor, query = { ...this.conversationQuery, cursor }, readSerial = ++this.catalogSummarySerial;
    const signal = AbortSignal.any([owner.signal, AbortSignal.timeout(25000)]);
    const current = () => owner === this.catalogController && auth === this.authEpoch && serial === this.catalogMoreSerial && this.state.phase === "ready";
    this.catalogSnapshotPinned = true;
    this.catalogMoreError = "";
    this.conversationPagePatch({ loadingMore: true, error: "" });
    try {
      const acquired = await this.conversationListing.read(signal, 1000, query);
      signal.throwIfAborted();
      if (!current() || acquired.revision !== this.conversationListing.revision) return;
      const data = acquired.value;
      if (!data.page) throw new Error("Conversation pagination is unavailable.");
      this.mergeConversationSummaries(data.conversations, data.availability, [], readSerial);
      if (!current()) return;
      this.catalogCursor = data.page.nextCursor;
      this.update({ conversationPageIds: [...new Set([...(this.state.conversationPageIds ?? []), ...data.conversations.map(c => c.id)])].filter(id => !this.catalogMissing.has(id)) });
      this.conversationPagePatch({ hasMore: data.page.hasMore });
    } catch (error) {
      if (!current() || this.expired(error)) return;
      if (error instanceof ApiError && error.status === 409 && error.code === "session-catalog-reset") {
        this.resetConversationPages(); this.conversationListing.invalidate(); await this.refreshConversationHead();
      } else {
        this.catalogMoreError = error instanceof Error ? error.message : "More conversations unavailable.";
        this.conversationPagePatch({ error: this.catalogMoreError });
      }
    } finally { if (current()) this.conversationPagePatch({ loadingMore: false }); }
  };
  retryConversations = (): void => {
    if (this.groupListing.enabled) { this.retryConversationGroups(); return; }
    this.conversationListing.invalidate();
    // A retry targets the failed continuation when one exists; it never drains.
    if (this.catalogMoreError && this.catalogCursor) void this.loadMoreConversations();
    else { this.resetConversationPages(); if (this.state.phase === "ready") void this.refreshConversationHead(); }
  };
  private mergeConversationSummaries(rows: Conversation[], availability: Availability, missing: string[] = [], serial = ++this.catalogSummarySerial, targeted = false) {
    const fresh = (id: string) => serial >= (this.catalogSummaryVersions.get(id) ?? 0);
    rows = rows.filter(row => fresh(row.id) && (targeted || !this.catalogMissing.has(row.id)));
    missing = missing.filter(fresh);
    for (const row of rows) { this.catalogSummaryVersions.set(row.id, serial); if (targeted) this.catalogMissing.delete(row.id); }
    for (const id of missing) { this.catalogSummaryVersions.set(id, serial); this.catalogMissing.add(id); }
    const previousSelected = this.state.conversations.find(c => c.id === this.state.selected);
    const next = new Map(this.state.conversations.map(c => [c.id, c]));
    for (const id of missing) { next.delete(id); this.invalidateConversationCache(id); this.notificationSources.delete(id); }
    for (const row of rows) {
      const previous = next.get(row.id);
      const sameIdentity = previous && conversationKey(previous) === conversationKey(row);
      if (previous && !sameIdentity) this.invalidateConversationCache(row.id);
      next.set(row.id, !row.title && sameIdentity && previous.title ? { ...row, title: previous.title } : row);
    }
    this.update({ conversations: [...next.values()], conversationsReady: true, globalAvailability: availability,
      ...(missing.length && this.state.conversationPageIds ? { conversationPageIds: this.state.conversationPageIds.filter(id => !missing.includes(id)) } : {}) });
    this.groupListing.reconcileRows(rows);
    if (missing.length) this.groupListing.forget(missing);
    if (missing.length) { notificationStore.forget(missing); forgetWorkerSessions(missing); }
    registerWorkerSessions(rows, true); this.observeNotifications(rows, true);
    const selected = next.get(this.state.selected);
    if (previousSelected && (missing.includes(previousSelected.id) || selected && conversationKey(previousSelected) !== conversationKey(selected))) {
      // Targeted retirement/rebinding is authoritative even outside a selected
      // poll (push, feed hydration, message search). Fence actions immediately.
      this.stop(); this.selectionEpoch++; this.actionSerial++; this.compactReadSerial++;
      this.runMap = new Map(); this.transcriptKey = ""; this.cacheable = false; this.nativeHistoryLoaded = false; this.workerReady = false;
      this.runGateId = ""; this.runGateMarkers = ""; this.replied.clear();
      if (this.paged) this.resetPages();
      const pendingCompacts = { ...this.state.pendingCompacts }, compactInstructions = { ...this.state.compactInstructions };
      delete pendingCompacts[previousSelected.id]; delete compactInstructions[previousSelected.id];
      this.update({ runs: [], messages: [], pendingTurn: null, sending: false, nativeHistory: null, contextUsage: null,
        compactState: null, compactions: [], compactDialog: "", compactError: "", pendingCompacts, compactInstructions,
        interactions: [], handoffApprovals: [], interactionError: "", pendingInputs: null, pendingInputOperations: {}, actionBusy: false, actionNotice: "",
        availability: { canSend: false }, connected: false, loading: !!selected,
        connectionError: selected ? "" : "Conversation is no longer in the active catalog. Archived history is preserved." });
      this.pendingInputFresh = "";
      this.timer = setTimeout(() => void this.poll(), selected ? 0 : 5000);
    }
  }
  /** Direct active/hidden/worker lookups, independent of the sidebar query.
   * Legacy clients may supply only a complete unpaginated listing. */
  ensureConversations = async (ids: readonly string[], signal?: AbortSignal): Promise<Conversation[]> => {
    const requested = [...new Set(ids.filter(Boolean))];
    if (!requested.length) return [];
    if (this.state.phase !== "ready") throw new Error("Sign in before loading conversations.");
    const controller = new AbortController(), auth = this.authEpoch;
    this.summaryRequests.add(controller);
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : []), AbortSignal.timeout(25000)]);
    try {
      for (let offset = 0; offset < requested.length; offset += 100) {
        const batch = requested.slice(offset, offset + 100), readSerial = ++this.catalogSummarySerial;
        if (this.client.conversationSummaries) {
          const acquired = await this.conversationListing.readSummaries(batch, combined);
          combined.throwIfAborted();
          if (auth !== this.authEpoch || acquired.revision !== this.conversationListing.revision) throw new Error("Conversation lookup invalidated.");
          this.mergeConversationSummaries(acquired.value.conversations, acquired.value.availability, acquired.value.missing.map(item => item.sessionId), readSerial, true);
        } else {
          const acquired = await this.conversationListing.read(combined);
          combined.throwIfAborted();
          if (auth !== this.authEpoch || acquired.revision !== this.conversationListing.revision) throw new Error("Conversation lookup invalidated.");
          if (acquired.value.page) throw new Error("This bridge cannot resolve off-page conversations without targeted summaries.");
          this.mergeConversationSummaries(acquired.value.conversations, acquired.value.availability, batch.filter(id => !acquired.value.conversations.some(c => c.id === id)), readSerial, true);
          this.observeNotifications(acquired.value.conversations);
          registerWorkerSessions(acquired.value.conversations);
        }
      }
      return requested.flatMap(id => this.state.conversations.find(c => c.id === id) ?? []);
    } catch (error) { if (auth === this.authEpoch) this.expired(error); throw error; }
    finally { this.summaryRequests.delete(controller); }
  };
  private async listingMutation<T>(run: () => Promise<T>): Promise<T> {
    const auth = this.authEpoch;
    this.conversationListing.invalidate();
    try { return await run(); }
    finally { if (auth === this.authEpoch) { this.conversationListing.invalidate(); this.groupListing.refresh(); } }
  }
  private transcriptKey = "";
  private cacheable = false;
  private started = false;
  private modelRequest = 0;
  private grokModelRequest = 0;
  private replied = new Set<string>();
  private nativeHistoryLoaded = false;
  private selectionEpoch = 0;
  private actionSerial = 0;
  private compactInFlight = new Set<string>();
  private compactReadSerial = 0;
  private pageFence = 0;
  private pageValidated = false;
  private refreshedRevision = "";
  private coverageSerial = 0;
  private publicationSerial = 0;
  private summarySerial = 0;
  private envelopeReceipts = new Map<string, number>();
  private workerReady = false;
  private workerPollAfter = 0;
  private workerPollMarkers = "";
  private workerMarkers(conversation?: Conversation) { return JSON.stringify([conversation?.id, conversation?.directWorkerCount, conversation?.worker]); }
  private workerPollDue(conversation?: Conversation) {
    const projection = workersFor(this.state.selected);
    return !this.workerReady || !!projection.error || workerProjectionInFlight(projection)
      || this.state.conversations.some(item => item.worker?.parent.sessionId === conversation?.id && (item.status === "running" || item.status === "starting" || item.lastRunStatus === "running" || item.lastRunStatus === "starting"))
      || this.workerPollMarkers !== this.workerMarkers(conversation) || !this.pollBusy() || Date.now() >= this.workerPollAfter;
  }
  private recordWorkerPoll(conversation?: Conversation) {
    this.workerReady = true; this.workerPollMarkers = this.workerMarkers(conversation); this.workerPollAfter = Date.now() + jitteredDelay(60000);
  }
  private pageRequests = new Set<AbortController>();
  private get paged() { return !!(this.client.transcriptPage && this.client.transcriptMeta && this.client.transcriptRefresh); }
  private cacheConversation() {
    const conversation = this.state.conversations.find(c => c.id === this.state.selected);
    if (conversation?.harness === "grok") return;
    if (this.state.phase !== "ready" || !this.cacheable || !conversation || this.compactInFlight.has(conversation.id) || conversationKey(conversation) !== this.transcriptKey) return;
    // pendingTurn is presentation only, never recorded transcript evidence.
    this.conversationCache.put(conversation, { runs: this.runMap, messages: this.state.messages, nativeHistory: this.state.nativeHistory, nativeHistoryLoaded: this.nativeHistoryLoaded, transcript: this.state.transcript });
  }
  private invalidateConversationCache(id: string) {
    this.conversationCache.invalidate(id);
    if (id === this.state.selected) this.cacheable = false;
  }
  private invalidateCompactReadiness(id: string) {
    this.invalidateConversationCache(id);
    if (id !== this.state.selected) return;
    // Fence even while hidden: reconnect may defer its GET, but an outstanding
    // revisit poll/eligibility read must not publish pre-compaction readiness.
    this.stop(); this.compactReadSerial++; this.nativeHistoryLoaded = false;
    if (this.paged) this.resetPages();
    this.update({ connected: false, loading: true, availability: { canSend: false }, compactState: null, contextUsage: null, interactions: [], handoffApprovals: [] });
  }
  private clearCachedHistory() {
    this.grokViews.clear(); this.grokUnconfirmed.clear(); this.update({ grokView: null });
    this.sessionTitleMutations.clear();
    // Authentication starts a new browsing scope, even if the previous owner
    // signed out from flat search. Capable clients boot directory-only again.
    this.conversationQuery = { mode: "chat", limit: this.client.conversationGroups ? 5 : 50 };
    this.groupListing.clear();
    this.resetConversationPages();
    for (const controller of this.summaryRequests) controller.abort();
    this.summaryRequests.clear();
    this.catalogSummaryVersions.clear(); this.catalogMissing.clear();
    this.update({ conversations: [], conversationsReady: false, globalAvailability: { canSend: false }, unconfirmedSubmissions: {}, sessionNameDialog: undefined, sessionTitleRequests: {},
      ...(!this.groupListing.enabled ? { conversationGroups: undefined, conversationGroupDirectory: undefined } : {}) });
    clearWorkerStates();
    this.conversationCache.clear(); this.runMap = new Map();
    this.runGateId = ""; this.runGateMarkers = "";
    this.workerReady = false;
    this.transcriptKey = ""; this.cacheable = false; this.nativeHistoryLoaded = false;
    this.resetPages();
  }
  private resetPages(owner?: AbortController) {
    this.pageFence++; this.pageRequests.forEach(request => { if (request !== owner) { request.abort(); this.pageRequests.delete(request); } }); this.pageValidated = false; this.refreshedRevision = "";
    this.coverageSerial++; this.envelopeReceipts.clear(); this.summarySerial = ++this.publicationSerial;
    this.update({ transcript: null, compactions: [], contextUsage: null, transcriptInitialLoading: !!this.state.selected, transcriptRefreshing: false, transcriptError: "", metadataError: "", pageBusy: "", pageErrors: {} });
  }
  private publishPages(transcript: PagedTranscript) {
    const conversation = this.state.conversations.find(item => item.id === this.state.selected);
    const previous = this.state.transcript;
    if (previous && previous.islands !== transcript.islands && previous.islands.length === transcript.islands.length && previous.islands.every((island, index) => {
      const next = transcript.islands[index]!;
      return island.key === next.key && island.scope === next.scope && island.observedEndBoundary === next.observedEndBoundary && island.endRevision === next.endRevision && equalValue(island.coverage, next.coverage) && equalValue(island.continuation, next.continuation) && island.messages.length === next.messages.length && island.messages.every((message, offset) => message === next.messages[offset]);
    })) transcript = { ...transcript, islands: previous.islands };
    if (previous && transcript.islands === previous.islands && transcript.compactions === previous.compactions && transcript.metadataRevision === previous.metadataRevision && equalValue(transcript.summary, previous.summary) && equalValue(transcript.target, previous.target)) transcript = previous;
    const loaded = transcript.islands === previous?.islands ? this.state.messages : pageMessages(transcript), pending = this.state.pendingTurn;
    const messages = loaded === this.state.messages || loaded.length === this.state.messages.length && loaded.every((message, index) => message === this.state.messages[index]) ? this.state.messages : loaded;
    const summaryChanged = !equalValue(previous?.summary, transcript.summary);
    if (summaryChanged || messages !== this.state.messages) {
      const receipt = ++this.publicationSerial;
      if (summaryChanged) this.summarySerial = receipt;
      if (messages !== this.state.messages) {
        const previousMessages = new Map(this.state.messages.map(message => [message.id, message]));
        const versions = new Map(messages.map(message => [message.id, message.version]));
        // Only canonical version changes fence older independent reads.
        for (const message of messages) if (message.version !== previousMessages.get(message.id)?.version) this.envelopeReceipts.set(message.id, receipt);
        for (const id of this.envelopeReceipts.keys()) if (!versions.has(id)) this.envelopeReceipts.delete(id);
      }
    }
    const usage = conversation ? pagedUsage(transcript, conversation.harness, this.state.modelsCwd === conversation.cwd && this.state.modelsLoaded ? this.state.models : []) : null;
    const contextUsage = equalValue(usage, this.state.contextUsage) ? this.state.contextUsage : usage;
    this.update({ transcript, messages, transcriptInitialLoading: false, contextUsage,
      pendingTurn: pendingTurnRecorded(messages, pending) ? null : pending });
  }
  private protectedAfter(serial: number, messages: { id: string }[]) {
    return new Set(messages.filter(message => (this.envelopeReceipts.get(message.id) ?? 0) > serial).map(message => message.id));
  }
  private acceptPage(page: TranscriptPage, edge?: PageRequest, latest = false, owner?: AbortController, readSerial = this.publicationSerial) {
    if (page.sessionId !== this.state.selected) throw new Error("Transcript session identity mismatch.");
    if (this.state.transcript && this.state.transcript.summary.epoch !== page.epoch) this.resetPages(owner);
    const independent = !latest;
    const transcript = mergePage(this.state.transcript, page, edge, latest, independent, this.protectedAfter(readSerial, page.messages), independent || this.summarySerial > readSerial);
    // Even a same-epoch delayed response can introduce R1-only coverage after a
    // completed R2 refresh. A concurrent refresh pass cannot certify that island.
    if (independent) { this.coverageSerial++; this.refreshedRevision = ""; }
    this.publishPages(transcript);
  }
  private cursorExpired(error: unknown) { return error instanceof TranscriptCoverageError || error instanceof ApiError && (error.code === "transcript-reset" || error.code === "invalid-cursor" || error.status === 400 && /cursor/i.test(error.message)); }
  loadTranscriptPage = async (edge: PageRequest) => {
    if (!this.paged || this.state.pageBusy || !this.pageValidated) return;
    const island = this.state.transcript?.islands.find(island => island.key === edge.island);
    const cursor = edge.direction === "older" ? island?.coverage.olderCursor : island?.coverage.newerCursor;
    const probe = !cursor && edge.direction === "newer" && island?.coverage.lastId && this.state.transcript && island.coverage.lastIndex! < canonicalCount(this.state.transcript) - 1 ? island.coverage.lastId : undefined;
    if (!cursor && !probe) return;
    const id = this.state.selected, selection = this.selectionEpoch, auth = this.authEpoch, fence = this.pageFence, readSerial = this.publicationSerial;
    const controller = new AbortController(); this.pageRequests.add(controller);
    const current = () => id === this.state.selected && selection === this.selectionEpoch && auth === this.authEpoch && fence === this.pageFence && !controller.signal.aborted;
    const key = `${edge.island}:${edge.direction}`;
    this.update({ pageBusy: key, pageErrors: { ...this.state.pageErrors, [key]: "" } });
    try {
      const page = await this.client.transcriptPage!(id, cursor ? { cursor } : { targetMessageId: probe }, controller.signal);
      if (current()) this.acceptPage({ ...page, target: undefined }, edge, false, controller, readSerial);
    } catch (error) {
      if (!current() || this.expired(error)) return;
      if (this.cursorExpired(error) || probe && error instanceof ApiError && error.status === 404) { this.resetPages(); this.update({ messages: [], transcriptError: "History changed or the bridge restarted. Reopening latest history…" }); this.reconnect(); }
      else this.update({ pageErrors: { ...this.state.pageErrors, [key]: error instanceof Error ? error.message : "History page unavailable. Try again." } });
    } finally { this.pageRequests.delete(controller); if (current()) this.update({ pageBusy: "" }); }
  };
  /** Explicit Go-to-send loads its target page; caller cancellation aborts it. */
  loadSendTarget = async (target: { kind: "worker" | "handoff"; id: string; sessionId: string }, signal: AbortSignal): Promise<"loaded" | "missing" | "legacy"> => {
    if (!this.paged) return "legacy";
    const selection = this.selectionEpoch, auth = this.authEpoch;
    let fence = this.pageFence;
    const controller = new AbortController(); this.pageRequests.add(controller);
    const abort = () => controller.abort(); signal.addEventListener("abort", abort, { once: true });
    const current = () => !signal.aborted && !controller.signal.aborted && selection === this.selectionEpoch && auth === this.authEpoch && target.sessionId === this.state.selected && fence === this.pageFence;
    try {
      if (!current()) throw new DOMException("Navigation cancelled", "AbortError");
      let page: TranscriptPage | undefined;
      let readSerial = this.publicationSerial;
      for (let attempt = 0; attempt < 2; attempt++) {
        readSerial = this.publicationSerial;
        try { page = await this.client.transcriptPage!(target.sessionId, { targetKind: target.kind, targetId: target.id }, controller.signal); break; }
        catch (error) {
          if (!current()) throw error;
          if (error instanceof ApiError && error.status === 404) return "missing";
          if (this.expired(error)) throw error;
          if (!attempt && this.cursorExpired(error)) { this.resetPages(controller); fence = this.pageFence; this.update({ messages: [] }); continue; }
          throw error;
        }
      }
      if (!current() || !page) throw new DOMException("Navigation cancelled", "AbortError");
      this.acceptPage(page, undefined, false, controller, readSerial);
      const message = page.target && pageMessages(this.state.transcript).find(message => message.id === page.target!.messageId);
      if (!message) throw new Error("Target page did not identify its original send.");
      return "loaded";
    } catch (error) {
      if (current() && this.cursorExpired(error)) { this.resetPages(controller); this.update({ messages: [] }); this.reconnect(); }
      throw error;
    } finally { signal.removeEventListener("abort", abort); this.pageRequests.delete(controller); }
  };
  private beginAction() {
    const selection = this.selectionEpoch, auth = this.authEpoch, operation = ++this.actionSerial;
    this.update({ actionBusy: true, interactionError: "", actionNotice: "" });
    return () => selection === this.selectionEpoch && auth === this.authEpoch && operation === this.actionSerial;
  }
  state: State = { phase: "connecting", conversations: [], conversationsReady: false, selected: "", runs: [], messages: [], drafts: {}, connected: false, loading: true, sending: false, availability: { canSend: false }, connectionError: "", submissionError: "", authError: "", models: [], modelsLoading: false, modelsError: "", modelsLoaded: false, modelsCwd: "", interactions: [], handoffApprovals: [], interactionError: "", actionBusy: false, actionNotice: "", profiles: null, profileError: "", profileBusy: false };
  constructor(private client: ConversationClient) {
    this.conversationListing = new ConversationListing((signal, query) => client.conversations(signal, query), 1000,
      () => performance.now(), client.conversationSummaries ? (ids, signal) => client.conversationSummaries!(ids, signal) : undefined,
      client.conversationGroups ? (query, signal) => client.conversationGroups!(query, signal) : undefined);
    this.groupListing = new ConversationGroupListing({
      listing: this.conversationListing, nativeDirectory: !!client.conversationGroups,
      ready: () => this.state.phase === "ready", hidden: () => typeof document !== "undefined" && document.hidden,
      delay: () => this.pollDelay(this.state.connected), serial: () => ++this.catalogSummarySerial,
      expired: error => this.expired(error), missing: id => this.catalogMissing.has(id),
      rows: () => this.state.conversations,
      merge: (rows, availability, serial, head) => this.mergeConversationSummaries(rows, availability, [], serial, head),
      available: availability => this.update({ globalAvailability: availability, conversationsReady: true,
        ...(!this.state.selected ? { availability, connected: true, interactive: true, loading: false, connectionError: "" } : {}) }),
      publish: (groups, directory, ids) => {
        const marker = { hasMore: false, loading: directory.loading, loadingMore: false, error: directory.error, queryKey: directory.queryKey };
        this.update({
          conversationGroups: equalValue(this.state.conversationGroups, groups) ? this.state.conversationGroups : groups,
          conversationGroupDirectory: equalValue(this.state.conversationGroupDirectory, directory) ? this.state.conversationGroupDirectory : directory,
          conversationPageIds: equalValue(this.state.conversationPageIds, ids) ? this.state.conversationPageIds : ids,
          // Partial-mode compatibility marker only, never a global page request.
          conversationPage: equalValue(this.state.conversationPage, marker) ? this.state.conversationPage : marker,
        });
      },
    });
    this.state = { ...this.state, transcriptPaged: this.paged }; onWorkspaceAuthExpired(() => this.loginRequired());
    if (client.conversationGroups) this.setConversationGroups({ mode: "chat", limit: conversationGroupPageSize("chat") }, []);
    else if (client.conversationSummaries) this.resetConversationPages();
    if (typeof window !== "undefined") window.addEventListener("storage", event => {
      if (event.key === this.pendingInputKey()) { this.loadPendingInputLedger(); if (this.pendingInputVisible) void this.refreshPendingInputs(); }
      if (this.appAdmissionLedger && (event.key === null || event.key.startsWith(this.appAdmissionLedger.prefix))) {
        this.appAdmissionLoaded = false;
        void this.loadAppAdmissions(true).then(() => this.appAdmissionPolling(true));
      }
    });
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  shellSnapshot = () => this.shellRevision;
  private update(patch: Partial<State>, publishShell = true) {
    if (patch.drafts) {
      for (const key of new Set([...Object.keys(this.state.drafts), ...Object.keys(patch.drafts)])) {
        if (this.state.drafts[key] !== patch.drafts[key]) this.composerStamps.set(key, advanceComposerStamp(this.composerStamp(key)));
      }
    }
    if (patch.conversations) {
      const previousRows = new Map(this.state.conversations.map(c => [c.id, c]));
      patch.conversations = patch.conversations.map(row => {
        const previous = previousRows.get(row.id);
        if (!previous || conversationKey(previous) !== conversationKey(row)) return row;
        // Frozen catalog pages and transcript polls can predate the title request.
        // Preserve newer title metadata, while still accepting all other fields.
        if ((row.titleRevision ?? 0) < (previous.titleRevision ?? 0)) return { ...row, title: previous.title, titleSource: previous.titleSource, titleRevision: previous.titleRevision };
        const mutation = this.sessionTitleMutations.get(row.id);
        return mutation?.optimisticTitle !== undefined && mutation.scope === this.sessionNameScope(row.id) && (row.titleRevision ?? 0) === mutation.expectedRevision
          ? { ...row, title: mutation.optimisticTitle } : row;
      });
    }
    if (patch.connected === false && patch.interactive === undefined) patch.interactive = false;
    for (const key of ["scienceSubmissions", "sciencePending", "scienceRecoveries"] as const) {
      if (Object.hasOwn(patch, key) && equalValue(this.state[key] ?? {}, patch[key] ?? {})) patch[key] = this.state[key] as never;
    }
    // Stabilize lightweight API projections, never serialize or deep-walk the
    // loaded transcript parts or reducer diagnostics on idle polls.
    if (this.paged) for (const key of ["conversations", "availability", "compactState", "compactions", "contextUsage", "interactions", "handoffApprovals", "pendingCompacts"] as const) {
      if (Object.hasOwn(patch, key) && equalValue(this.state[key], patch[key])) (patch as Record<string, unknown>)[key] = this.state[key];
    }
    let changed = false;
    for (const key of Object.keys(patch) as (keyof State)[]) {
      if (!Object.is(this.state[key], patch[key])) { changed = true; break; }
    }
    if (!changed) return;
    const selected = this.state.selected;
    const scienceChanged = selected && (patch.selected === undefined || patch.selected === selected) && patch.transcript
      && (patch.transcript.summary.epoch !== this.state.transcript?.summary.epoch || patch.transcript.summary.revision !== this.state.transcript?.summary.revision);
    this.state = { ...this.state, ...patch };
    if (publishShell) this.shellRevision++;
    this.listeners.forEach(fn => fn());
    if (scienceChanged) this.sciencePolling(true);
  }
  draftKey = (id = this.state.selected) => id || `draft:${catalog.state.navigation.workspaceId}:${catalog.state.navigation.worktreeId}`;
  draft = (id = this.state.selected): Draft => {
    const nav = catalog.state.navigation;
    const worktree = catalog.state.workspaces.find(w => w.workspaceId === nav.workspaceId)?.worktrees.find(w => w.worktreeId === nav.worktreeId);
    return this.state.drafts[this.draftKey(id)] ?? { ...emptyDraft(), cwd: id ? this.state.conversations.find(c => c.id === id)?.cwd ?? "" : worktree?.root ?? "" };
  };
  setDraft = (patch: Partial<Draft>, id = this.state.selected) => {
    if (id === this.state.selected && (Object.hasOwn(patch, "profileId") || Object.hasOwn(patch, "upgradeId") || Object.hasOwn(patch, "cwd")) && this.pendingInputChainLocked()) return;
    const key = this.draftKey(id), previous = this.draft(id), next = { ...previous, ...patch };
    const textOnly = previous.cwd === next.cwd && previous.profileId === next.profileId && previous.upgradeId === next.upgradeId && equalValue(previous.scienceSnapshots ?? [], next.scienceSnapshots ?? []);
    if (this.state.drafts[key] && textOnly && previous.text === next.text) return;
    this.update({ drafts: { ...this.state.drafts, [key]: next } }, !textOnly);
  };
  /** Preview is advisory only: submit strips everything except immutable IDs. */
  stageScienceSnapshot = (snapshot: ScienceShareSnapshot, conversationId = this.state.selected) => {
    if (!conversationId || conversationId !== this.state.selected || this.state.sending || this.state.actionBusy || this.pendingInputChainLocked()) return;
    const snapshots = this.draft(conversationId).scienceSnapshots ?? [];
    if (snapshots.some(s => s.snapshotId === snapshot.id)) return;
    if (snapshots.length >= 4) { this.update({ submissionError: "At most four science snapshots can be staged." }); return; }
    this.setDraft({ scienceSnapshots: [...snapshots, { ...structuredClone(snapshot), snapshotId: snapshot.id }] }, conversationId);
  };
  removeScienceSnapshot = (snapshotId: string) => this.setDraft({ scienceSnapshots: (this.draft().scienceSnapshots ?? []).filter(s => s.snapshotId !== snapshotId) });
  sciencePreview = () => this.draft().scienceSnapshots ?? [];
  private scienceStorageKey(id = this.state.selected) {
    if (!this.state.config?.storeId || !id) throw new Error("Science send storage identity unavailable");
    return `sane:science-send:v1:${this.state.config.storeId}:${id}`;
  }
  private readSciencePending(id = this.state.selected): SciencePendingSend | null {
    const raw = localStorage.getItem(this.scienceStorageKey(id));
    if (!raw) return null;
    const value = JSON.parse(raw) as SciencePendingSend;
    if (value.version !== 1 || value.conversationId !== id || typeof value.requestId !== "string" || typeof value.text !== "string" || !Array.isArray(value.snapshots)) throw new Error("Stored science send cannot be read; original submission remains unresolved");
    // Recover interruption between recording a definite refusal and removing
    // its pending marker; rejected recovery is not a submission fence.
    if (this.readScienceRecoveries(id).some(item => item.requestId === value.requestId)) {
      localStorage.removeItem(this.scienceStorageKey(id));
      return null;
    }
    return value;
  }
  private readScienceRecoveries(id: string): ScienceRejectedRecovery[] {
    const items = JSON.parse(localStorage.getItem(`${this.scienceStorageKey(id)}:rejected`) ?? "[]") as ScienceRejectedRecovery[];
    if (!Array.isArray(items) || items.some(item => item.version !== 1 || item.status !== "rejected" || item.conversationId !== id || typeof item.requestId !== "string" || typeof item.text !== "string" || !Array.isArray(item.snapshots))) throw new Error("Rejected science draft recovery cannot be read");
    return items;
  }
  consumeScienceRecovery = (id: string, requestId: string, restore: boolean, storeId: string) => {
    if (this.state.selected !== id || this.state.config?.storeId !== storeId || this.state.phase !== "ready" || !this.state.config.authenticated || this.state.sending || this.state.actionBusy || this.pendingInputChainLocked()) return;
    try {
      const items = this.readScienceRecoveries(id), item = items.find(item => item.requestId === requestId);
      if (!item) return;
      const draft = this.draft(id);
      if (restore && (draft.text || draft.scienceSnapshots?.length)) { this.update({ scienceSubmissionError: "Keep or clear your current draft before restoring the rejected science draft." }); return; }
      if (restore) this.setDraft({ text: item.text, scienceSnapshots: item.snapshots }, id);
      const remaining = items.filter(item => item.requestId !== requestId);
      localStorage.setItem(`${this.scienceStorageKey(id)}:rejected`, JSON.stringify(remaining));
      this.update({ scienceRecoveries: { ...this.state.scienceRecoveries, [id]: remaining }, scienceSubmissionError: "" });
    } catch (error) { this.update({ scienceSubmissionError: error instanceof Error ? error.message : "Science draft recovery unavailable" }); }
  };
  private async refreshScienceSubmissions(id: string, current: () => boolean, signal: AbortSignal, supplied?: ScienceSubmissionView[]) {
    if (!this.state.config?.storeId || !supplied && !this.client.scienceSubmissions) return;
    try {
      const pending = this.readSciencePending(id), submissions = supplied ?? await this.client.scienceSubmissions!(id, signal);
      if (!current()) return;
      // Another tab can replace the durable marker while discovery is in flight.
      // Leave that newer intent and its composer untouched until the next read.
      if (this.readSciencePending(id)?.requestId !== pending?.requestId) return;
      if (!Array.isArray(submissions) || submissions.some(s => s.conversationId !== id || !["prepared", "unknown", "submitted", "not-submitted"].includes(s.state) || !Array.isArray(s.snapshots))) throw new Error("Science send evidence is unavailable");
      const resolved = pending && submissions.find(s => s.requestId === pending.requestId && ["submitted", "not-submitted"].includes(s.state));
      if (pending) {
        const evidence = submissions.find(item => item.requestId === pending.requestId);
        if (evidence && (!equalValue(evidence.snapshots, pending.snapshots.map(({ snapshotId, blockId }) => ({ snapshotId, blockId })))
          || evidence.state === "submitted" && !evidence.runId)) throw new Error("Science receipt does not match the original request and snapshots. Nothing was resent.");
      }
      let consumed = resolved?.state === "submitted";
      const recoveries = this.readScienceRecoveries(id);
      if (resolved?.state === "not-submitted" && pending) {
        // Legacy markers have no editor stamp. Preserve them as explicit
        // recovery, never infer ownership from empty or matching draft text.
        if (!recoveries.some(item => item.requestId === pending.requestId)) recoveries.push({ ...pending, status: "rejected" });
        const key = `${this.scienceStorageKey(id)}:rejected`, raw = JSON.stringify(recoveries);
        localStorage.setItem(key, raw);
        if (localStorage.getItem(key) !== raw) throw new Error("Science recovery could not be verified after writing");
        consumed = true;
      }
      if (consumed && pending && this.readSciencePending(id)?.requestId === pending.requestId) localStorage.removeItem(this.scienceStorageKey(id));
      if (resolved?.state === "submitted" && id === this.state.selected && this.harness() === "grok") {
        const draft = this.draft(id);
        if (draft.upgradeId && draft.upgradeId === this.state.grokView?.profileId) this.setDraft({ upgradeId: "" }, id);
      }
      for (const record of this.appAdmissionRecords.values()) {
        if (record.scope.storeId !== this.state.config?.storeId || record.envelope.intent.operation !== "science-message" || record.envelope.intent.conversationId !== id) continue;
        const evidence = this.appAdmissionScienceEvidence(record, submissions);
        if (evidence?.state === "not-submitted") this.restoreOwnedAppAdmission(record);
        if (evidence?.state === "submitted" && this.appAdmissionOwnsConsumed(record)) {
          const draft = this.state.drafts[record.draftKey];
          if (draft?.upgradeId) this.update({ drafts: { ...this.state.drafts, [record.draftKey]: { ...draft, upgradeId: "" } } });
        }
      }
      this.update({ scienceRecoveries: { ...this.state.scienceRecoveries, [id]: recoveries }, scienceSubmissions: { ...this.state.scienceSubmissions, [id]: submissions }, sciencePending: { ...this.state.sciencePending, [id]: consumed ? null : pending }, scienceSubmissionError: "",
        ...(consumed && id === this.state.selected && (this.state.submissionError.startsWith("Science send outcome is unresolved.") || this.state.submissionError.startsWith("A previous science send is unresolved.")) ? { submissionError: "" } : {}) });
      return true;
    } catch (error) { if (current() && !this.expired(error)) this.update({ scienceSubmissionError: error instanceof Error ? error.message : "Science submission evidence unavailable" }); }
  }
  executionUnavailable = () => {
    if (this.state.selected) {
      const conversation = this.state.conversations.find(c => c.id === this.state.selected);
      const worktree = catalog.state.workspaces.find(w => w.workspaceId === conversation?.workspaceId)?.worktrees.find(w => w.worktreeId === conversation?.worktreeId);
      return conversation?.association !== "resolved" || !catalog.state.ready || worktree?.state !== "available" ? "Execution workspace unavailable. Recorded history remains accessible." : "";
    }
    const nav = catalog.state.navigation;
    const worktree = catalog.state.workspaces.find(w => w.workspaceId === nav.workspaceId)?.worktrees.find(w => w.worktreeId === nav.worktreeId);
    return !catalog.state.ready || !worktree || worktree.state !== "available" ? "Choose an available workspace and worktree to start a conversation." : "";
  };
  harness = (): Harness => this.state.selected ? this.state.conversations.find(c => c.id === this.state.selected)?.harness
    ?? (this.grokViews.has(this.state.selected) || this.grokUnconfirmed.has(this.state.selected) ? "grok" : "claude-code") : this.draftProfile().harness;
  profileSet = (): AgentProfiles => this.state.profiles ?? this.state.config?.agentProfiles ?? fallbackProfiles;
  profileList = (): AgentProfile[] => [...this.profileSet().profiles].sort((a, b) => a.order - b.order);
  profile = (id: string | undefined): AgentProfile | undefined => id ? this.profileSet().profiles.find(p => p.id === id) : undefined;
  profileChoices = (profile: Pick<AgentProfile, "harness" | "model" | "effort">): { model: string; effort: string } => profile.harness === "grok"
    ? grokProfileChoices(profile, this.profile(BASE_PROFILE_IDS.grok)) : { model: profile.model, effort: profile.effort };
  grokProfileUpgradesSupported = (): boolean => this.state.config?.grokCapability?.profileUpgrades === true;
  defaultProfile = (): AgentProfile => { const set = this.profileSet(); return this.profile(set.defaultId) ?? this.profile(BASE_PROFILE_IDS["claude-code"]) ?? fallbackProfiles.profiles[0]!; };
  /** New-conversation profile: the draft pick when still visible, else the default. */
  draftProfile = (): AgentProfile => { const picked = this.profile(this.draft("").profileId); return picked && !picked.hidden && (picked.kind === "base" || picked.kind === "assistant") ? picked : this.defaultProfile(); };
  conversationProfileId = (id: string): string => {
    const snapshot = this.conversationSnapshot(id);
    const harness = snapshot.harness ?? "claude-code";
    return snapshot.profileId ?? (getHarnessDescriptor(harness) ? legacyProfileId(harness, validatedAgentSnapshot(snapshot)?.agent) : "");
  };
  /** Listing-only lookup: never guess archival identity from migrated configuration. */
  profileFor = (c: Conversation): DisplayProfile | undefined => displayProfile(this.profileSet(), c);
  private latestStoredRun = (id: string): Run | undefined => [...this.runMap.values()].filter(r => r.conversationId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  conversationSnapshot = (id: string): ProfileSnapshot => {
    const conversation = this.state.conversations.find(c => c.id === id);
    const grok = this.grokViews.get(id);
    return savedProfileSnapshot(conversation ?? (grok || this.grokUnconfirmed.has(id) ? { harness: "grok", model: grok?.model, effort: grok?.effort,
      profileId: grok?.profileId, agent: grok?.agent, agentKind: grok?.agentKind, nativeAgentSelected: grok?.nativeAgentSelected } : { harness: "claude-code" }),
      grok?.runs.at(-1) ?? (id === this.state.selected ? this.latestStoredRun(id) : undefined));
  };
  conversationProfile = (id: string): DisplayProfile | undefined => displayProfile(this.profileSet(), this.conversationSnapshot(id));
  conversationProfileLabel = (id: string): string => profileDisplayLabel(this.conversationProfile(id), this.conversationSnapshot(id));
  /** kind/harness of the selected conversation even when its profile was deleted. */
  private currentShape = (): Pick<AgentProfile, "kind" | "harness"> | undefined => {
    if (!this.state.selected) return undefined;
    const profile = this.conversationProfile(this.state.selected);
    if (profile) return profile;
    const agent = this.storedDefaults(this.state.selected).agent || this.conversationProfileId(this.state.selected).startsWith("template:");
    return { kind: agent ? "assistant" : "base", harness: this.harness() };
  };
  conversationKind = () => this.currentShape()?.kind;
  pendingUpgrade = (): AgentProfile | undefined => this.state.selected ? this.profile(this.draft().upgradeId) : undefined;
  /** Profile the next send runs with: pending upgrade, else the conversation's, else the draft's. */
  effectiveProfile = (): DisplayProfile | undefined => this.state.selected ? this.pendingUpgrade() ?? this.conversationProfile(this.state.selected) : this.draftProfile();
  assignable = (profile: AgentProfile) => this.harness() === "grok" && !!this.state.selected && !this.grokProfileUpgradesSupported()
    ? { ok: false as const, reason: "Existing Grok sessions keep their saved profile. Choose a profile for a new chat instead." }
    : canAssign(this.currentShape(), profile);
  pickProfile = (id: string) => {
    if (this.pendingInputChainLocked()) return;
    const next = this.profile(id);
    if (this.state.sending || !next || !this.assignable(next).ok) return;
    if (this.state.selected) this.setDraft({ upgradeId: id }); else this.setDraft({ profileId: id }, "");
    if (next.harness === "grok" && this.state.submissionError.startsWith("App admission requires initialization")) this.update({ submissionError: "" });
  };
  clearUpgrade = () => { if (this.state.selected && !this.state.sending && !this.pendingInputChainLocked()) this.setDraft({ upgradeId: "" }); };
  workspace = () => {
    if (this.state.selected) return this.state.conversations.find(c => c.id === this.state.selected)?.cwd ?? "";
    const navigation = catalog.state.navigation;
    return this.draft().cwd.trim() || catalog.state.workspaces.find(w => w.workspaceId === navigation.workspaceId)?.worktrees.find(w => w.worktreeId === navigation.worktreeId)?.root || "";
  };
  capabilities = (harness: unknown = this.harness()): Partial<HarnessCapabilities> => capabilitiesFor(harness, this.state.config?.harnesses?.find(h => h.id === harness)?.capabilities);
  // Older callers override only one advertised flag (notably cancelRun).
  // Keep omitted flags on their known static defaults; explicit false still narrows.
  private supportedCapabilities = (harness: unknown = this.harness()) => capabilitiesFor(harness, this.capabilities(harness));
  compactUnavailable = () => {
    if (this.pendingInputChainLocked()) return "Resolve the existing input chain before compacting.";
    const conversation = this.state.conversations.find(c => c.id === this.state.selected);
    if (!conversation) return "Choose an existing conversation to compact.";
    if (!this.supportedCapabilities(conversation.harness).compaction) return "Context compaction is unavailable for this harness.";
    if (!this.client.compact || !this.client.compactState) return "Context compaction is unavailable on this bridge.";
    if (conversation.worker || workerReference(conversation.id) || this.conversationKind() === "worker") return "Managed worker conversations cannot be compacted here.";
    if (conversation.replacedBy) return "This conversation has been replaced and is read-only.";
    if (conversation.attachment?.state === "pending") return "Complete the native attachment before compacting.";
    if (this.state.loading || this.state.sending || this.state.actionBusy || !this.state.connected) return "Wait for the bridge and current action to settle.";
    if (this.executionUnavailable()) return this.executionUnavailable();
    if (conversation.status === "running" || conversation.status === "starting" || this.state.runs.some(r => r.status === "running" || r.status === "starting")) return "Wait until the current run is idle.";
    if (!this.state.compactState) return "Waiting for compaction eligibility.";
    return this.state.compactState.eligibility.eligible ? "" : this.state.compactState.eligibility.reason || "Native session is not eligible for compaction.";
  };
  compactBlocked = () => {
    const pending = this.state.pendingCompacts?.[this.state.selected];
    if (this.compactInFlight.has(this.state.selected) || pending?.phase === "sending") return true;
    if (this.state.compactions?.some(r => r.lifecycle === "running")) return true;
    // Fresh bridge availability can release an old unconfirmed owner even when
    // the compaction GET is unavailable. It cannot release a new requested run.
    if (pending?.phase === "unconfirmed" && !this.state.compactions?.some(r => r.requestId === pending.payload.requestId)) return this.state.compactState?.eligibility.eligible !== true;
    if (this.state.compactions?.some(r => r.lifecycle === "requested")) return this.state.compactState?.eligibility.eligible !== true;
    return Boolean(this.state.compactions?.some(r => r.lifecycle === "unconfirmed") && this.state.compactState?.eligibility.eligible !== true && (!this.state.availability.canSend || !!this.state.availability.queueAfterRunId));
  };
  openCompact = (instructions?: string) => {
    if (this.draft().scienceSnapshots?.length) { this.update({ compactError: "Remove staged science snapshots before compacting; they cannot be compact instructions." }); return; }
    if (this.pendingInputChainLocked()) { this.update({ compactError: "Resolve the existing input chain before compacting." }); return; }
    if (!this.state.selected) { this.update({ submissionError: "Choose an existing conversation before using /compact." }); return; }
    if (!this.supportedCapabilities().compaction) { this.update({ submissionError: "Context compaction is unavailable for this harness. Your draft is unchanged." }); return; }
    if (instructions && !this.supportedCapabilities().compactionInstructions) { this.update({ submissionError: `${getHarnessDescriptor(this.harness())?.label ?? "This harness"} /compact does not support instructions. Your draft is unchanged.` }); return; }
    this.update({ compactDialog: this.state.selected, compactError: "", ...(instructions !== undefined ? { compactInstructions: { ...this.state.compactInstructions, [this.state.selected]: instructions } } : {}) });
    void this.refreshCompact();
  };
  closeCompact = () => this.update({ compactDialog: "" });
  setCompactInstructions = (instructions: string) => this.update({ compactInstructions: { ...this.state.compactInstructions, [this.state.selected]: instructions } });
  private compactReadFeedback(error?: unknown, recoveredUncertainty = false) {
    const existing = this.state.compactError ?? "";
    // One bounded feedback field: polling may replace/clear its own transport
    // notice, but never erase or overwrite a definitive manual-action error.
    if (existing && !existing.startsWith("Compaction state unavailable:") && !recoveredUncertainty) return existing;
    return error === undefined ? "" : `Compaction state unavailable: ${error instanceof Error ? error.message : "connection error"}. No compaction was retried.`;
  }
  refreshCompact = async () => {
    const id = this.state.selected, selection = this.selectionEpoch, auth = this.authEpoch, read = ++this.compactReadSerial;
    if (!id || !this.supportedCapabilities().compaction || !this.client.compactState || this.compactInFlight.has(id)) return false;
    try {
      const state = await this.client.compactState(id);
      if (selection !== this.selectionEpoch || auth !== this.authEpoch || read !== this.compactReadSerial || this.compactInFlight.has(id)) return false;
      this.applyCompactState(state);
      return true;
    } catch (error) {
      if (selection === this.selectionEpoch && auth === this.authEpoch && read === this.compactReadSerial && !this.expired(error)) this.update({ compactError: this.compactReadFeedback(error) });
      return false;
    }
  };
  private applyCompactState(compactState: CompactState) {
    if (this.paged && this.harness() !== "grok") {
      const pending = this.state.pendingCompacts?.[compactState.sessionId];
      const recovered = pending && compactState.operations.find(record => record.requestId === pending.payload.requestId);
      const records = new Map<string, CompactionRecord>((this.state.transcript?.compactions ?? []).map(record => [record.id, record]));
      for (const record of compactState.operations) records.set(record.id, { ...records.get(record.id), ...record });
      this.update({ compactState, compactions: [...records.values()], compactError: this.compactReadFeedback(undefined, !!recovered && pending?.phase === "unconfirmed"), ...(recovered && pending!.phase !== "sending" ? { pendingCompacts: { ...this.state.pendingCompacts, [compactState.sessionId]: { ...pending!, phase: "accepted", runId: recovered.runId } } } : {}) });
      return;
    }
    if (compactState.nativeHistoryImportedAt && compactState.nativeHistoryImportedAt !== this.state.nativeHistory?.importedAt) { this.nativeHistoryLoaded = false; this.invalidateConversationCache(compactState.sessionId); }
    const conversation = this.state.conversations.find(c => c.id === compactState.sessionId);
    const pending = this.state.pendingCompacts?.[compactState.sessionId];
    const recovered = pending && compactState.operations.find(r => r.requestId === pending.payload.requestId);
    const compactions = conversation ? compactionsFor(conversation, this.state.runs, this.state.nativeHistory, compactState.operations) : [];
    this.update({ compactState, compactError: this.compactReadFeedback(undefined, !!recovered && pending?.phase === "unconfirmed"), compactions, ...(conversation ? { contextUsage: contextUsageFor(conversation.harness, this.state.runs, this.state.models, this.state.nativeHistory, compactions) } : {}), ...(recovered && pending!.phase !== "sending" ? { pendingCompacts: { ...this.state.pendingCompacts, [compactState.sessionId]: { ...pending!, phase: "accepted", runId: recovered.runId } } } : {}) });
  }
  compact = async (nativeStopped = false) => {
    if (this.draft().scienceSnapshots?.length) { this.update({ compactError: "Staged science snapshots cannot be compact instructions." }); return; }
    if (this.pendingInputChainLocked()) { this.update({ compactError: "Resolve the existing input chain before compacting." }); return; }
    const id = this.state.selected, selection = this.selectionEpoch, auth = this.authEpoch;
    const conversation = this.state.conversations.find(c => c.id === id);
    const identity = conversation ? conversationKey(conversation) : "";
    const sameIdentity = () => {
      const current = this.state.conversations.find(c => c.id === id);
      return !!current && conversationKey(current) === identity;
    };
    const old = this.state.pendingCompacts?.[id];
    if (this.compactInFlight.has(id) || old?.phase === "sending" || !id || !this.client.compact) return;
    this.update({ compactError: "" });
    // Explicit resume observes first, then may reuse exactly the reserved request.
    if (old?.phase === "unconfirmed") {
      const refreshed = await this.refreshCompact();
      if (selection !== this.selectionEpoch || auth !== this.authEpoch) return;
      if (!refreshed) return;
      if (this.state.pendingCompacts?.[id]?.phase === "accepted") return;
    }
    const unavailable = this.compactUnavailable();
    if (unavailable) { this.update({ compactError: unavailable }); return; }
    const instructions = this.state.compactInstructions?.[id]?.trim();
    if (instructions && (!this.supportedCapabilities().compactionInstructions || !this.state.compactState?.eligibility.supportsInstructions)) { this.update({ compactError: "This harness does not support compaction instructions." }); return; }
    const resuming = old?.phase === "unconfirmed";
    if ((this.state.compactState?.eligibility.requiresNativeStopped || conversation?.attachment && this.supportedCapabilities().attachedSendRequiresNativeStopped) && !nativeStopped && !(resuming && old?.payload.nativeStopped)) { this.update({ compactError: "Confirm external assistant execution is stopped before compacting." }); return; }
    const payload = old?.phase === "unconfirmed" ? old.payload : { requestId: crypto.randomUUID(), ...(instructions ? { instructions } : {}), ...(nativeStopped ? { nativeStopped: true } : {}) };
    const pending: PendingCompact = { payload, phase: "sending" };
    this.compactInFlight.add(id);
    this.invalidateCompactReadiness(id);
    this.update({ pendingCompacts: { ...this.state.pendingCompacts, [id]: pending }, compactError: "", availability: { canSend: false, reason: "Requesting compaction…" } });
    try {
      const response = await this.listingMutation(() => this.client.compact!(id, payload));
      if (auth !== this.authEpoch || !sameIdentity()) return;
      this.invalidateCompactReadiness(id);
      this.update({ pendingCompacts: { ...this.state.pendingCompacts, [id]: { payload, phase: "accepted", runId: response.runId } } });
      if (selection === this.selectionEpoch) {
        this.nativeHistoryLoaded = false;
        const existing = this.state.compactions?.find(r => r.requestId === payload.requestId);
        const operation = existing && (existing.contextReset || existing.observedAt && existing.observedAt > (response.operation.observedAt ?? "")) ? existing : response.operation;
        this.update({ compactions: [...(this.state.compactions ?? []).filter(r => r.requestId !== payload.requestId), operation], compactState: null, availability: { canSend: false, reason: "Compaction requested. Waiting for native state." } });
      }
    } catch (error) {
      if (auth !== this.authEpoch || !sameIdentity() || this.expired(error)) return;
      const definite = error instanceof ApiError && error.status >= 400 && error.status < 500;
      this.invalidateCompactReadiness(id);
      this.update({ pendingCompacts: { ...this.state.pendingCompacts, [id]: { payload, phase: definite ? "rejected" : "unconfirmed" } }, ...(selection === this.selectionEpoch ? { ...(!definite ? { compactState: null } : {}), compactError: `${error instanceof Error ? error.message : "Compaction request unavailable."}${definite ? "" : " Acceptance is unconfirmed. Check status or explicitly resume this same request; no automatic retry will occur."}` } : {}) });
    } finally {
      this.compactInFlight.delete(id);
      // Readiness belongs to the currently selected identity, not the originating
      // selection epoch. Only operation-specific presentation above uses that epoch.
      if (auth === this.authEpoch && sameIdentity() && this.state.selected === id) this.reconnect();
    }
  };
  loadModels = async (harness: unknown = this.harness(), refresh = false) => {
    if (harness === "grok") {
      if (!this.supportedCapabilities(harness).listModels || !this.client.grokModels) return;
      const cwd = this.workspace(), cached = this.state.grokModelCatalog?.cwd === cwd ? this.state.grokModelCatalog : undefined;
      if (cached?.loading) return;
      const auth = this.authEpoch, request = ++this.grokModelRequest;
      const starting = { models: cached?.models ?? [], fetchedAt: cached?.fetchedAt ?? "", stale: cached?.stale ?? true,
        cwd, loading: true, loaded: cached?.loaded ?? false, error: "" };
      this.update({ grokModelCatalog: starting });
      try {
        const result = await this.client.grokModels(cwd, AbortSignal.timeout(25000), refresh);
        if (auth !== this.authEpoch || request !== this.grokModelRequest) return;
        if (!Array.isArray(result.models) || result.models.some(m => !m || typeof m.id !== "string" || typeof m.name !== "string" || !Array.isArray(m.efforts))) throw new Error("Invalid Grok model catalog");
        this.update({ grokModelCatalog: { ...result, cwd, loading: false, loaded: true, error: result.error ?? "" } });
      } catch (error) {
        if (auth !== this.authEpoch || request !== this.grokModelRequest || this.expired(error)) return;
        this.update({ grokModelCatalog: { ...starting, loading: false, stale: true,
          error: `Grok catalog unavailable: ${error instanceof Error ? error.message : "Could not load models."} You can still enter model and effort IDs manually.` } });
      }
      return;
    }
    if (!this.supportedCapabilities(harness).listModels || !this.client.models) return;
    const cwd = this.workspace();
    if (this.state.modelsLoading && this.state.modelsCwd === cwd) return;
    const auth = this.authEpoch, request = ++this.modelRequest;
    this.update({ modelsLoading: true, modelsError: "", modelsCwd: cwd, modelsLoaded: false });
    try {
      const models = await this.client.models(cwd);
      if (auth !== this.authEpoch || request !== this.modelRequest) return;
      this.update({ models, modelsLoaded: true, modelsLoading: false, modelsError: models.length ? "" : "OpenCode has no available models." });
      if (this.paged && this.state.transcript && this.harness() === "opencode" && cwd === this.workspace()) this.update({ contextUsage: pagedUsage(this.state.transcript, "opencode", models) });
    } catch (error) {
      if (auth !== this.authEpoch || request !== this.modelRequest || this.expired(error)) return;
      this.update({ modelsLoading: false, modelsLoaded: false, modelsError: `OpenCode unavailable: ${error instanceof Error ? error.message : "Could not load models."}` });
    }
  };
  /** OpenCode gate: sending waits for the live per-cwd catalog. An empty profile
   * model means the OC native default and is allowed. */
  modelUnavailable = () => {
    if (!this.supportedCapabilities().catalogRequiredForSend) return false;
    return !this.state.modelsLoaded || this.state.modelsCwd !== this.workspace() || Boolean(this.state.modelsError);
  };
  /** Model/variant the next OC send resolves (profile first, then saved session values). */
  effectiveModel = (): { model: string; effort: string } => {
    const profile = this.state.selected ? this.pendingUpgrade() : this.draftProfile();
    if (profile?.harness === "grok") return this.profileChoices(profile);
    if (profile?.model) return { model: profile.model, effort: profile.effort };
    const saved = this.state.selected ? this.storedDefaults(this.state.selected) : { model: "", effort: "" };
    return { model: saved.model, effort: saved.effort };
  };
  /** Warn-not-fail: a model absent from the live catalog still sends for native resolution. */
  missingModel = (): string => {
    // Grok's optional catalog is presented in profile settings, not the shared
    // OpenCode send gate. Unknown/custom Grok IDs remain valid selections.
    if (this.harness() === "grok") return "";
    if (getHarnessDescriptor(this.harness())?.policies.modelInput !== "live-catalog" || this.modelUnavailable()) return "";
    const { model, effort } = this.effectiveModel();
    if (!model) return "";
    const entry = this.state.models.find(m => m.id === model);
    return !entry ? model : effort && !entry.efforts.some(e => e.id === effort) ? `${model} (${effort})` : "";
  };
  /** Saved model/effort/agent for a conversation: Session defaults first, then the
   * last run's values for pre-migration sessions that predate Session fields. */
  storedDefaults = (id: string): { model: string; effort: string; agent: string } => {
    const conversation = this.state.conversations.find(c => c.id === id);
    // runMap holds only the selected conversation's committed or restored runs.
    const last = this.latestStoredRun(id);
    return { model: conversation?.model || last?.model || "", effort: conversation?.effort || last?.effort || "", agent: conversation?.agent || last?.agent || "" };
  };
  /** Assistant role of the selected conversation (stored) or of the new-conversation profile. */
  agent = (): string => this.state.selected ? this.storedDefaults(this.state.selected).agent || this.conversationProfile(this.state.selected)?.role || "" : this.draftProfile().role ?? "";
  private async profileAction<T>(run: (client: ConversationClient) => Promise<T> | undefined): Promise<T | undefined> {
    if (this.state.profileBusy) return;
    const auth = this.authEpoch;
    this.update({ profileBusy: true, profileError: "" });
    try {
      const pending = run(this.client);
      if (!pending) throw new Error("Agent profiles are unavailable on this bridge.");
      const result = await pending;
      if (auth !== this.authEpoch) return;
      await this.refreshProfiles();
      return result;
    } catch (error) {
      if (auth === this.authEpoch && !this.expired(error)) this.update({ profileError: error instanceof Error ? error.message : "Agent update failed." });
    } finally { if (auth === this.authEpoch) this.update({ profileBusy: false }); }
  }
  refreshProfiles = async () => {
    if (!this.client.agents) return;
    const auth = this.authEpoch;
    try { const profiles = await this.client.agents(); if (auth === this.authEpoch) this.update({ profiles }); }
    catch (error) { if (auth === this.authEpoch && !this.expired(error)) this.update({ profileError: error instanceof Error ? error.message : "Could not load agents." }); }
  };
  saveProfile = (id: string, input: AgentProfileInput) => this.profileAction(c => c.updateAgent?.(id, input)).then(r => r?.profile);
  createProfile = (fromId: string, input: AgentProfileInput = {}) => this.profileAction(c => c.createAgent?.(fromId, input)).then(r => r?.profile);
  deleteProfile = (id: string) => this.profileAction(c => c.deleteAgent?.(id)).then(r => !!r);
  resetProfile = (id: string) => this.profileAction(c => c.resetAgent?.(id)).then(r => r?.profile);
  setDefaultProfile = (defaultId: string) => this.profileAction(c => c.orderAgents?.({ defaultId })).then(r => !!r);
  reorderProfiles = (order: string[]) => this.profileAction(c => c.orderAgents?.({ order })).then(r => !!r);
  clearProfileError = () => this.update({ profileError: "" });
  reply = async (interactionId: string, reply: InteractionReply) => {
    const capabilities = this.supportedCapabilities();
    if (this.state.actionBusy || !this.state.selected || !this.client.reply || !(reply.type === "permission" ? capabilities.permissionReplies : reply.type === "question" ? capabilities.questionReplies : reply.type === "handoff-approval" ? capabilities.handoffReplies : false)) return;
    const id = this.state.selected, current = this.beginAction();
    try {
      await this.listingMutation(() => this.client.reply!(id, interactionId, reply));
      if (current()) { wakePolls(id); this.replied.add(interactionId); this.update({ interactions: this.state.interactions.filter(i => i.id !== interactionId), handoffApprovals: this.state.handoffApprovals.filter(i => i.id !== interactionId), actionNotice: "Reply sent. Waiting for native state to reconcile." }); }
    } catch (error) {
      if (current() && !this.expired(error)) this.update({ interactionError: `${error instanceof Error ? error.message : "Reply failed."} No automatic retry was made; check the pending request before replying again.` });
    } finally { if (current()) this.update({ actionBusy: false }); }
  };
  /** Sender-session handoff decision. Attached to the sender sessionId that
   * called sane_handoff, never the recipient. Mirrors reply(). expectedRevision
   * is the optimistic-concurrency guard; stale revisions surface as CONFLICT. */
  replyHandoff = async (approvalId: string, reply: HandoffApprovalReply) => {
    const capabilities = this.supportedCapabilities();
    if (this.state.actionBusy || !this.state.selected || !this.client.replyHandoff || !capabilities.handoffReplies || !capabilities.listHandoffApprovals) return;
    if (reply.decision !== "allow" && reply.decision !== "deny") return;
    if (reply.message !== undefined && (typeof reply.message !== "string" || reply.message.includes("\0") || reply.message.length > 8000)) return;
    if (!Number.isSafeInteger(reply.expectedRevision) || reply.expectedRevision < 0) return;
    // The approval must still be pending for this sender session; DOM events
    // from a suspended conversation must never decide a new one.
    const pending = [...this.state.handoffApprovals, ...this.state.interactions].some(item => item.id === approvalId && item.type === "handoff-approval");
    if (!pending) return;
    const id = this.state.selected, current = this.beginAction();
    try {
      await this.listingMutation(() => this.client.replyHandoff!(id, approvalId, reply));
      if (current()) { wakePolls(id); this.replied.add(approvalId); this.update({ handoffApprovals: this.state.handoffApprovals.filter(i => i.id !== approvalId), interactions: this.state.interactions.filter(i => i.id !== approvalId), actionNotice: reply.decision === "allow" ? "Handoff allowed. Waiting for delivery to reconcile." : "Handoff denied. The reason is queued for the sender." }); }
    } catch (error) {
      if (current() && !this.expired(error)) this.update({ interactionError: `${error instanceof Error ? error.message : "Handoff reply failed."} No automatic retry was made; check the pending approval before replying again.` });
    } finally { if (current()) this.update({ actionBusy: false }); }
  };
  cancel = async () => {
    if (this.harness() === "grok") {
      if (this.state.actionBusy || !this.state.selected || !this.client.grokStop || !this.supportedCapabilities().cancelRun) return;
      const id = this.state.selected, current = this.beginAction();
      try {
        const result = await this.client.grokStop(id);
        if (current()) {
          this.update({ actionNotice: `${result.wrapperClosed ? "Grok wrapper closed." : "Grok wrapper closure is unconfirmed."} Native cancellation is ${result.nativeCancellation === "unproven" ? "unproven" : "not attempted"}. ${result.reason}` });
          this.requestSelectedRefresh();
        }
      } catch (error) {
        if (current() && !this.expired(error)) this.update({ interactionError: `${error instanceof Error ? error.message : "Grok Stop unavailable."} Native cancellation is unproven; no automatic retry was made.` });
      } finally { if (current()) this.update({ actionBusy: false }); }
      return;
    }
    if (this.state.actionBusy || !this.state.selected || !this.client.cancel) return;
    this.loadPendingInputLedger();
    const id = this.state.selected, source = this.pendingInputSource(), namespace = this.pendingInputKey(), fence = this.pendingInputFence();
    const view = this.state.pendingInputs?.snapshot.conversationId === id ? this.state.pendingInputs : this.pendingInputViews.get(id);
    const chain = !!view && isPendingInputView(view, id) && view.presentation.chainLocked;
    const unknown = [...this.pendingInputRecords.values()].some(record => record.operation.conversationId === id);
    const queueAware = chain || this.pendingInputConfirmedChains.has(id) || unknown;
    if (!chain && !this.supportedCapabilities().cancelRun) {
      if (unknown) this.update({ actionNotice: "Original queue admission remains unknown. No known waiting chain can be paused; check status or explicitly retransmit its original identity." });
      return;
    }
    const actionCurrent = this.beginAction();
    const current = () => actionCurrent() && namespace === this.pendingInputKey() && source === this.pendingInputSource();
    try {
      // Canonical FIFO Pause also reaches cancel when native cancel is absent.
      // That button must not pause a replacement App at the same origin.
      if (queueAware && (chain && !this.pendingInputSourceMatches(view!.presentation.source, id, source) || !await this.verifyPendingInputContext(namespace, fence) || !current())) return;
      const result = await this.listingMutation(() => this.client.cancel!(id));
      if (current()) this.update({ actionNotice: `${chain ? result.interrupted ? "Waiting messages paused; interruption requested. Waiting for the run’s terminal state." : "Waiting messages paused; native cancellation not confirmed." : result.interrupted ? "Interruption requested. Waiting for the run’s terminal state." : "No interruption was reported. Waiting for the run’s current state."}${unknown ? " Original queue admission/consent remains unknown: a late original POST may still commit. Check status or explicitly retransmit the same identity; no pause guarantee applies to that unconfirmed intent." : ""}` });
    } catch (error) {
      if (current() && !this.expired(error)) this.update({ interactionError: `${error instanceof Error ? error.message : "Cancellation unavailable."} Run status will reconcile separately.` });
    } finally { if (current()) { this.update({ actionBusy: false }); void this.refreshPendingInputs(); } }
  };
  reconcile = async () => {
    if (this.state.actionBusy || this.compactBlocked() || !this.state.selected || !this.supportedCapabilities().nativeHistoryRefresh || !this.client.reconcile) return;
    const id = this.state.selected, current = this.beginAction();
    try {
      const { history } = await this.listingMutation(() => this.client.reconcile!(id));
      if (current()) {
        // Invalidate older reads even if reconnect is deferred while hidden.
        this.stop(); this.nativeHistoryLoaded = true;
        this.invalidateConversationCache(id);
        if (this.paged && this.harness() !== "grok") { this.resetPages(); this.update({ messages: [], nativeHistory: null, contextUsage: null, compactState: null, compactions: [], loading: true, connected: false, availability: { canSend: false }, actionNotice: "Conversation history refreshed." }); }
        else this.update({ nativeHistory: history, messages: this.harness() === "grok" ? grokMessages(this.grokViews.get(id), history) : transcriptMessages(history, this.state.runs), contextUsage: null, compactState: null, compactions: [], actionNotice: "Conversation history refreshed." });
        this.reconnect();
      }
    } catch (error) {
      if (current() && !this.expired(error)) this.update({ interactionError: error instanceof Error ? error.message : "Reconciliation unavailable" });
    } finally { if (current()) this.update({ actionBusy: false }); }
  };
  hide = (id: string) => this.setVisibility(id, true);
  unhide = (id: string) => this.setVisibility(id, false);
  private setVisibility = async (id: string, hidden: boolean) => {
    const action = hidden ? this.client.hide : this.client.unhide;
    if (this.state.actionBusy || !id || !action) return;
    const verb = hidden ? "Hidden" : "Restored";
    this.loadPendingInputLedger(false);
    const namespace = this.pendingInputKey(), fence = this.pendingInputFence();
    const view = this.state.pendingInputs?.snapshot.conversationId === id ? this.state.pendingInputs : this.pendingInputViews.get(id);
    const queueContext = !!view?.presentation.chainLocked || this.pendingInputConfirmedChains.has(id) || [...this.pendingInputRecords.values()].some(record => record.operation.conversationId === id);
    const current = this.beginAction();
    try {
      if (queueContext && (!await this.verifyPendingInputContext(namespace, fence) || !current())) return;
      await this.listingMutation(() => action.call(this.client, id));
      if (!current()) return;
      this.update({ conversations: this.state.conversations.map(c => c.id === id ? { ...c, hidden } : c), actionNotice: hidden ? "Conversation hidden from the sidebar. Nothing was deleted." : "Conversation restored to the sidebar." });
      this.groupListing.reconcileRows(this.state.conversations);
      this.reconnect();
    } catch (error) {
      if (!current() || this.expired(error)) return;
      if (error instanceof ApiError && error.status === 404) {
        this.update({ actionNotice: `${verb} state unknown: the conversation no longer exists.` });
        this.reconnect();
        return;
      }
      this.update({ interactionError: `${error instanceof Error ? error.message : "Visibility change unavailable."} No history was changed.` });
    } finally {
      if (current()) this.update({ actionBusy: false });
      if (current() && id === this.state.selected) void this.refreshPendingInputs();
    }
  };
  private stop() {
    clearTimeout(this.scienceTimer); this.scienceTimer = undefined;
    this.scienceController?.abort(); this.scienceController = undefined;
    this.generation++; clearTimeout(this.timer); this.timer = undefined; this.controller?.abort();
    this.selectedRefreshPending = false;
    this.unsubscribeRefreshWake?.(); this.unsubscribeRefreshWake = undefined;
    this.pageFence++; this.pageRequests.forEach(request => request.abort()); this.pageRequests.clear();
    if (this.paged) this.update({ pageBusy: "", transcriptRefreshing: false });
  }
  private stopNotifications() {
    this.stopNotificationPolling();
    this.notificationScope = ""; this.notificationSources.clear(); this.queuedNotificationReceipts.clear();
    this.notificationRefreshCursor = undefined;
  }
  private stopNotificationPolling() {
    this.notificationFence++; clearTimeout(this.notificationTimer); this.notificationTimer = undefined;
    this.notificationController?.abort(); this.notificationController = undefined;
  }
  private configureNotifications(config: Config) {
    this.stopNotifications();
    const supported = config.conversationUpdates === true && !!this.client.conversationUpdates;
    const scope = config.authenticated === true && typeof config.storeId === "string" && config.storeId.trim() ? config.storeId : "";
    if (!scope) { notificationStore.suspend(); notificationStore.setFeedEnabled(supported); return; }
    if (!supported) {
      // Legacy delivery still requires an authenticated owner, never cwd/default.
      notificationStore.activate(scope);
      notificationStore.setFeedEnabled(false);
      return;
    }
    notificationStore.activate(scope); notificationStore.setFeedEnabled(true); this.notificationScope = scope;
    void this.pollNotifications();
  }
  private notificationSource(conversation: Conversation) {
    return notificationContextKey(conversation);
  }
  private observeNotifications(conversations: Conversation[], partial = false) {
    this.notificationSources = new Map([...(partial ? this.notificationSources : []), ...conversations.map(conversation => [conversation.id, this.notificationSource(conversation)] as const)]);
    for (const conversation of conversations) {
      const pending = this.queuedNotificationReceipts.get(conversation.id);
      if (!pending) continue;
      for (const receipt of conversation.queuedFollowups ?? []) {
        if (!pending.has(receipt.requestId)) continue;
        // Queue admission is not native acceptance. Only the global listing's
        // exact dispatched receipt can promote a send made in this auth session.
        if (receipt.state === "dispatched" && receipt.runId) {
          notificationStore.acceptRun(conversation.id, receipt.runId); pending.delete(receipt.requestId);
        } else if (receipt.state === "not-submitted") pending.delete(receipt.requestId);
      }
      if (!pending.size) this.queuedNotificationReceipts.delete(conversation.id);
    }
    notificationStore.observe(conversations, partial);
  }
  private async pollNotifications() {
    const scope = this.notificationScope, fence = this.notificationFence, auth = this.authEpoch;
    if (!scope || this.notificationController || !this.client.conversationUpdates || this.state.phase !== "ready" || typeof document !== "undefined" && document.hidden) return;
    const controller = this.notificationController = new AbortController();
    const current = () => !controller.signal.aborted && fence === this.notificationFence && auth === this.authEpoch
      && scope === this.notificationScope && scope === this.state.config?.storeId && this.state.config?.authenticated === true && this.state.phase === "ready";
    let healthy = false, listingFailed = false, feedStatus: NotificationFeedStatus | null = null;
    const publishError = () => notificationStore.setFeedError(feedStatus ?? (listingFailed ? "session-error" : null));
    try {
      await notificationStore.ready();
      if (!current()) return;
      const listing = async () => {
        try {
          if (this.client.conversationSummaries) {
            // Explicit missing results stay suppressed until rediscovered by a
            // fresh head, direct navigation, or a new feed occurrence. Persisted
            // old unread evidence must not repeatedly fetch retired summaries.
            const ids = [...notificationStore.summaryIds(), ...this.queuedNotificationReceipts.keys()].filter(id => !this.catalogMissing.has(id));
            await this.ensureConversations(ids, controller.signal);
            if (current()) healthy = true;
            return;
          }
          // Notification sources tolerate a stale listing: the feed cursors are
          // self-healing, and the main poll publishes anything newer. Sharing
          // the main loop's cache avoids a second listing GET per cycle.
          const acquired = await this.conversationListing.read(AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]), 15000);
          if (!current() || acquired.revision !== this.conversationListing.revision) return;
          const data = acquired.value;
          if (data.page) throw new Error("Off-page notifications require targeted conversation summaries.");
          // Metadata/legacy OC fallback only. Selected-chat polling remains the
          // sole publisher of main conversation/transcript state.
          this.observeNotifications(data.conversations); healthy = true;
        } catch (error) {
          if (!current() || this.expired(error)) return;
          listingFailed = true; publishError();
        }
      };
      const drain = async () => {
        try {
          let resume = notificationStore.resume();
          let bootstrap = !resume?.cursor;
          const started = performance.now(); let pages = 0;
          do {
            const input: ConversationUpdateFeedRequest = bootstrap ? { limit: 100 }
              : { cursor: resume!.cursor, ...(resume?.through !== undefined ? { through: resume.through } : {}), limit: 100 };
            const page = await this.client.conversationUpdates!(input, AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]), bootstrap);
            if (!current()) return;
            if (!isConversationUpdatePage(page, { storeId: scope, epoch: input.cursor?.epoch, cursor: input.cursor, through: input.through, limit: input.limit })
              || bootstrap !== !!page.bootstrap) throw new Error("Invalid conversation update page or authenticated store identity.");
            // Resolve every feed source (including bootstrap-only worker waits)
            // BEFORE source validation/display. A failed lookup must not advance
            // the durable cursor and silently lose an off-page notification.
            await this.ensureConversations([...page.updates.map(update => update.conversationId),
              ...(page.bootstrap?.outstandingWorkerAttention ?? []).map(item => item.workerSessionId)], controller.signal);
            if (!current()) return;
            if (!await notificationStore.applyPage(page, input.cursor ?? null, bootstrap)) throw new Error("Notification updates could not be saved. The same page will retry.");
            if (!current()) return;
            const previousRefresh = this.notificationRefreshCursor;
            const after = Math.max(input.cursor?.after ?? 0, previousRefresh?.epoch === page.epoch ? previousRefresh.after : 0);
            this.notificationRefreshCursor = { ...page.nextCursor };
            const conversation = this.state.conversations.find(item => item.id === this.state.selected);
            // Seeding includes ALL pages of the bootstrap traversal, not just
            // the first page. Historical attention is not a live invalidation.
            // Successful cursor-CAS application plus transport order dedupes
            // occurrences AND revisions, including page retries and resets.
            if (!bootstrap && !resume?.seeding && conversation && page.updates.some(update => {
              const source = updateSourceKey(update.source);
              const baseline = page.coverage.find(item => item.sourceKey === source)?.baselineThrough;
              return update.sequence > after && !update.historical && update.conversationId === conversation.id
                && notificationSourceMatches(conversation, source)
                && (baseline === undefined || update.sourceSequence !== undefined && update.sourceSequence > baseline);
            })) this.requestSelectedRefresh();
            healthy = true;
            resume = notificationStore.resume(); bootstrap = false;
            if (!page.hasMore) break;
            if (!resume?.cursor || resume.cursor.epoch !== page.epoch || resume.cursor.after !== page.nextCursor.after || resume.through !== page.through) throw new Error("Notification update traversal did not preserve its cursor.");
            if (++pages >= 5 || performance.now() - started >= 1000) break;
          } while (current());
        } catch (error) {
          if (!current() || this.expired(error)) return;
          if (error instanceof ApiError && (error.status === 410 || error.code === "conversation-update-gap" || error.code === "update-gap")) {
            feedStatus = "refreshing"; publishError();
            await notificationStore.resetResume();
          } else { feedStatus = "refresh-error"; publishError(); }
        }
      };
      await Promise.all([listing(), drain()]);
      if (current()) publishError();
    } catch (error) {
      if (current() && !this.expired(error)) notificationStore.setFeedError("storage-error");
    } finally {
      if (this.notificationController === controller) this.notificationController = undefined;
      if (current()) this.notificationTimer = setTimeout(() => { this.notificationTimer = undefined; void this.pollNotifications(); }, this.pollDelay(healthy));
    }
  }
  private loginRequired() {
    this.suspendAppAdmissions();
    this.update({ scienceSubmissions: {}, sciencePending: {}, scienceRecoveries: {}, scienceSubmissionError: "" });
    this.clearPendingInputDisplay();
    this.stopNotifications();
    notificationStore.suspend();
    this.stop(); this.authEpoch++; this.conversationListing.invalidate(); this.clearCachedHistory();
    catalog.invalidate(); invalidateWorkspaceRequests();
    clearWorkstreamSelection();
    clearWorkstreamMembership();
    this.replied.clear();
    this.update({ pendingCompacts: {}, compactState: null, compactions: [], compactDialog: "", compactError: "", compactInstructions: {} });
    this.update({ phase: "login", config: undefined, conversations: [], conversationsReady: false, runs: [], messages: [], pendingTurn: null, nativeHistory: null, contextUsage: null, connected: false, loading: false, sending: false, availability: { canSend: false }, connectionError: "", submissionError: "", models: [], modelsLoading: false, modelsLoaded: false, modelsError: "", modelsCwd: "", grokModelCatalog: undefined, interactions: [], handoffApprovals: [], interactionError: "", actionBusy: false, actionNotice: "", profiles: null, profileError: "", profileBusy: false });
  }
  private expired(error: unknown) { if ((error instanceof ApiError || error instanceof PendingInputApiError) && error.status === 401) { this.loginRequired(); return true; } return false; }
  start = () => { if (this.started) return; this.started = true; void this.boot(); };
  reconnect = () => {
    // Foreground/online reads must not join pre-suspension GETs, even when a
    // send keeps its own lifecycle alive. Retirement does not abort existing
    // consumers or replay mutations; their auth/generation fences still apply.
    invalidateCoalescedRequests();
    this.stopNotificationPolling();
    if (typeof document !== "undefined" && document.hidden) { this.groupListing.pause(); if (!this.state.sending) this.stop(); return; }
    if (this.state.phase === "login") return;
    this.appAdmissionPolling(true);
    this.groupListing.refresh();
    if (this.state.sending) { void this.pollNotifications(); return; }
    this.pendingInputFresh = ""; this.pendingInputPolling();
    void this.pollNotifications(); this.sciencePolling(true);
    if (this.state.phase === "connecting") void this.boot();
    else this.requestSelectedRefresh();
  };
  private async boot() {
    if (typeof document !== "undefined" && document.hidden) return;
    this.stop(); this.conversationListing.invalidate(); const generation = this.generation, auth = this.authEpoch;
    const controller = this.controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 25000);
    try {
      const config = await this.client.config(controller.signal);
      if (generation !== this.generation || auth !== this.authEpoch) return;
      if (config.authRequired && !config.authenticated) { this.loginRequired(); return; }
      this.pendingInputSuspended = false;
      this.appAdmissionSuspended = false;
      this.update({ config, phase: "ready", authError: "", connectionError: "", ...(config.agentProfiles ? { profiles: config.agentProfiles } : {}) });
      if (this.harness() !== "grok" && !this.appAdmissionSupported()) this.update({ submissionError: "App admission requires initialization on this bridge. Update and initialize the App admission store before sending; your draft is unchanged. Legacy submission is not used." });
      void this.loadAppAdmissions(true).then(() => this.appAdmissionPolling(true));
      this.groupListing.refresh();
      this.loadPendingInputLedger(); if (this.pendingInputVisible && !document.hidden) void this.refreshPendingInputs();
      this.configureNotifications(config);
      if (!config.agentProfiles) void this.refreshProfiles();
      void this.poll();
    } catch (error) {
      if (generation !== this.generation || auth !== this.authEpoch || this.expired(error)) return;
      this.update({ connectionError: `${error instanceof Error ? error.message : "Connection failed"} Retrying automatically…` });
      this.timer = setTimeout(() => void this.boot(), 5000);
    } finally { clearTimeout(deadline); }
  }
  login = async (password: string) => {
    this.suspendAppAdmissions();
    this.clearPendingInputDisplay();
    this.stopNotifications();
    notificationStore.suspend();
    this.stop(); this.conversationListing.invalidate(); const auth = ++this.authEpoch;
    this.clearCachedHistory();
    this.update({ authError: "", conversationsReady: false, runs: [], messages: [], pendingTurn: null, nativeHistory: null, contextUsage: null, compactState: null, compactions: [], interactions: [], handoffApprovals: [], interactionError: "", actionBusy: false, actionNotice: "", connected: false, availability: { canSend: false } });
    try { await this.client.login(password); if (auth !== this.authEpoch) return; this.update({ phase: "connecting" }); await this.boot(); }
    catch (error) { if (auth === this.authEpoch) this.update({ authError: error instanceof Error ? error.message : "Sign-in failed." }); }
  };
  logout = async () => {
    this.suspendAppAdmissions();
    this.clearPendingInputDisplay();
    this.stopNotifications();
    notificationStore.suspend();
    this.stop(); this.conversationListing.invalidate(); const auth = ++this.authEpoch;
    // Even an ambiguous logout must not retain authenticated transcript snapshots.
    this.clearCachedHistory(); this.replied.clear();
    this.update({ conversationsReady: false, runs: [], messages: [], pendingTurn: null, nativeHistory: null, contextUsage: null, compactState: null, compactions: [], compactDialog: "", interactions: [], handoffApprovals: [], interactionError: "", actionBusy: false, actionNotice: "", connected: false, loading: true, availability: { canSend: false } });
    catalog.invalidate(); invalidateWorkspaceRequests();
    clearWorkstreamSelection();
    clearWorkstreamMembership();
    try { await this.client.logout(); if (auth === this.authEpoch) this.loginRequired(); }
    catch (error) { if (auth !== this.authEpoch || this.expired(error)) return; this.update({ submissionError: `Sign-out failed: ${error instanceof Error ? error.message : "connection error"}` }); void this.boot(); }
  };
  openConversation = (id: string, options: { deferAck?: boolean } = {}): boolean => {
    if (this.state.sending || this.state.phase !== "ready") return false;
    const conversation = this.state.conversations.find(c => c.id === id);
    if (id && !conversation) return false;
    // Optional notification metadata must not block ordinary navigation. When
    // it is stale/missing, navigate normally but leave notification reads alone.
    const canAcknowledge = !conversation || !this.notificationScope || this.notificationSources.get(id) === this.notificationSource(conversation);
    const candidate = options.deferAck || !canAcknowledge ? null : notificationStore.captureOpen(id);
    const capture = conversation && candidate?.contextKey === this.notificationSource(conversation) ? candidate : null;
    const auth = this.authEpoch, config = this.state.config;
    const identity = (item?: Conversation) => item ? this.notificationSource(item) : "";
    const source = identity(conversation);
    this.choose(id);
    if (auth !== this.authEpoch || this.state.phase !== "ready" || this.state.config !== config || this.state.selected !== id
      || source !== identity(this.state.conversations.find(c => c.id === id))) return false;
    const previousNavigation = catalog.snapshot().navigation;
    const sameCheckout = conversation && conversation.workspaceId === previousNavigation.workspaceId && conversation.worktreeId === previousNavigation.worktreeId;
    catalog.navigate({ conversationId: id || null, view: "chat", ...(conversation ? { workspaceId: conversation.workspaceId ?? null, worktreeId: conversation.worktreeId ?? null,
      filePath: sameCheckout ? previousNavigation.filePath : null, comparison: sameCheckout ? previousNavigation.comparison : null } : {}) });
    const navigation = catalog.snapshot().navigation;
    if (auth !== this.authEpoch || this.state.phase !== "ready" || this.state.config !== config || this.state.selected !== id
      || navigation.view !== "chat" || navigation.conversationId !== (id || null)
      || source !== identity(this.state.conversations.find(c => c.id === id))) return false;
    if (capture) notificationStore.acknowledgeCaptured(capture);
    return true;
  };
  openWorkerConversation = async (id: string): Promise<void> => {
    const auth = this.authEpoch, selection = this.selectionEpoch;
    const current = () => auth === this.authEpoch && selection === this.selectionEpoch && this.state.phase === "ready";
    try {
      await this.ensureConversations([id]);
      if (!current()) return;
      if (!this.openConversation(id)) this.update({ submissionError: "Worker conversation is no longer in the active catalog." });
    } catch (error) {
      if (current() && !this.expired(error)) this.update({ submissionError: error instanceof Error ? error.message : "Worker conversation unavailable." });
    }
  };
  choose = (selected: string, pendingTurn: PendingTurn | null = null) => {
    if (this.state.sending) return;
    if (selected === this.state.selected) { if (selected) this.requestSelectedRefresh(); return; }
    this.selectionEpoch++;
    this.stop(); this.conversationListing.invalidate(); this.cacheConversation();
    const conversation = this.state.conversations.find(c => c.id === selected);
    const cached = conversation ? this.conversationCache.take(conversation) : undefined;
    this.runMap = cached?.runs ?? new Map();
    this.transcriptKey = cached && conversation ? conversationKey(conversation) : "";
    this.cacheable = !!cached && !this.compactInFlight.has(selected);
    this.nativeHistoryLoaded = cached?.nativeHistoryLoaded ?? false;
    this.pageValidated = false;
    this.refreshedRevision = "";
    this.coverageSerial++; this.envelopeReceipts.clear(); this.summarySerial = ++this.publicationSerial; this.workerReady = false;
    this.replied.clear();
    this.update({ compactState: null, compactions: [], compactDialog: "", compactError: "" });
    const runs = [...this.runMap.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const compactions = cached && conversation ? compactionsFor(conversation, runs, cached.nativeHistory).filter(record => record.lifecycle === "completed" || record.lifecycle === "failed" || record.lifecycle === "skipped") : [];
    // Never show the source's turns or actions under a newly selected branch.
    // Same-id sends do not reach here; their transcript remains mounted.
    this.update(selected
      ? { selected, runs, messages: cached?.messages ?? [], compactions, pendingTurn, availability: { canSend: false }, nativeHistory: cached?.nativeHistory ?? null, contextUsage: null, interactions: [], handoffApprovals: [], interactionError: "", actionBusy: false, actionNotice: "", loading: true, connected: false, connectionError: "", submissionError: "" }
        : { selected, runs: [], messages: [], pendingTurn, availability: { canSend: false }, nativeHistory: null, contextUsage: null, interactions: [], handoffApprovals: [], interactionError: "", actionBusy: false, actionNotice: "", loading: false, connected: false, connectionError: "", submissionError: "" });
    this.update({ grokView: null, transcriptPaged: conversation?.harness !== "grok" && this.paged });
    this.pendingInputFresh = ""; this.loadPendingInputLedger();
    this.update({ pendingInputs: this.pendingInputViews.get(selected) ?? null, pendingInputLoading: false, pendingInputError: "" }); this.publishPendingInputOperations();
    if (this.pendingInputVisible && !document.hidden) void this.refreshPendingInputs();
    if (conversation?.harness === "grok") {
      const view = this.grokViews.get(selected);
      if (view) this.publishGrok(view);
      this.update({ availability: { canSend: false }, loading: true, interactive: false, transcript: null,
        transcriptPaged: false, transcriptInitialLoading: false, workerLoading: false });
      this.sciencePolling(true);
      void this.poll();
      return;
    }
    if (this.paged) this.update({ transcript: cached?.transcript ?? null, transcriptInitialLoading: !!selected && !cached?.messages.length, transcriptError: "", metadataError: "", pageBusy: "", pageErrors: {}, workerLoading: !!selected && !!this.client.workers, compactions: cached?.transcript?.compactions ?? [] });
    this.sciencePolling(true);
    void this.poll();
  };
  private async pollPaged(listing: { conversations: Conversation[]; availability: Availability }, current: () => boolean, signal: AbortSignal, forceRead = false) {
    const id = this.state.selected, conversation = listing.conversations.find(item => item.id === id);
    const awaitingCompact = this.compactInFlight.has(id);
    this.update({ availability: awaitingCompact ? { canSend: false } : conversation?.availability ?? listing.availability });
    if (!id) { this.update({ connected: true, loading: false, connectionError: "", transcriptInitialLoading: false }); return; }
    this.update({ transcriptRefreshing: !this.pageValidated || !!this.state.transcriptError });
    const metadataHead = (async () => {
      const readFence = this.pageFence;
      const page = await this.client.transcriptMeta!(id, undefined, signal);
      if (!current()) return;
      signal.throwIfAborted();
      if (readFence !== this.pageFence) throw new ApiError("Transcript changed while reading metadata.", 409, "transcript-reset");
      if (page.sessionId !== id) throw new Error("Run metadata session identity mismatch.");
      if (this.state.transcript && page.epoch !== this.state.transcript.summary.epoch) { this.resetPages(); this.update({ messages: [] }); }
      return page;
    })();
    let metadataProjection: { epoch: string; metadataRevision: string; compactions: PagedTranscript["compactions"] } | undefined;
    const publishMetadata = () => {
      const transcript = this.state.transcript;
      if (!metadataProjection || transcript?.summary.epoch !== metadataProjection.epoch) return;
      const compactions = equalValue(transcript.compactions, metadataProjection.compactions) ? transcript.compactions : metadataProjection.compactions;
      this.update({ transcript: { ...transcript, metadataRevision: metadataProjection.metadataRevision, compactions } });
    };
    const validatedTail = () => {
      const transcript = this.state.transcript;
      return this.pageValidated && !this.state.transcriptError && !this.state.pageBusy && !Object.values(this.state.pageErrors ?? {}).some(Boolean)
        && transcript?.summary.sessionId === id && !!transcript.summary.epoch && !!transcript.summary.revision
        && this.refreshedRevision === transcript.summary.revision
        && transcript.islands.length === 1 && !transcript.islands[0]!.scope && transcript.islands[0]!.endRevision === transcript.summary.revision
        && (canonicalCount(transcript) === 0 || transcript.islands[0]!.coverage.lastIndex === canonicalCount(transcript) - 1) ? transcript : undefined;
    };
    const historyRead = (async () => {
      try {
        let head: TranscriptMetadataPage | undefined;
        // Uncertain coverage must load independently of metadata availability.
        // Only an already validated tail can wait for the cheap skip decision.
        if (!forceRead && validatedTail()) {
          try { head = await metadataHead; }
          catch (error) { if (!current() || this.expired(error)) return; }
        }
        if (!current()) return;
        let readFence = this.pageFence, readSerial = this.publicationSerial;
        const transcript = validatedTail();
        const unchanged = !forceRead && head && transcript?.summary.epoch === head.epoch && transcript.summary.revision === head.revision;
        let latest = unchanged && head ? head : await this.client.transcriptPage!(id, {}, signal);
        if (!current()) return;
        // Parallel metadata can reset the epoch while the tail is in flight.
        // Re-read under the new fence rather than accepting stale coverage.
        if (readFence !== this.pageFence) {
          signal.throwIfAborted();
          readFence = this.pageFence; readSerial = this.publicationSerial;
          latest = await this.client.transcriptPage!(id, {}, signal);
        }
        if (!current() || readFence !== this.pageFence) return;
        signal.throwIfAborted();
        const reopen = !this.pageValidated || this.state.transcript?.summary.epoch !== latest.epoch;
        if ("messages" in latest) this.acceptPage(latest, undefined, true, undefined, readSerial);
        publishMetadata();
        this.pageValidated = true; this.transcriptKey = conversation ? conversationKey(conversation) : "";
        // Render latest first. ALL loaded-island refreshes can then continue
        // independently of live-status/eligibility readiness.
        this.update({ transcriptError: "", transcriptRefreshing: false, loading: awaitingCompact });
        const pending = this.state.pendingTurn;
        if (pending?.runId && !pageMessages(this.state.transcript).some(message => message.runId === pending.runId && message.role === "user")) {
          try {
            const submittedFence = this.pageFence, submittedSerial = this.publicationSerial;
            const submitted = await this.client.transcriptPage!(id, { targetRunId: pending.runId }, signal);
            if (!current() || submittedFence !== this.pageFence) return;
            this.acceptPage({ ...submitted, target: undefined }, undefined, false, undefined, submittedSerial);
          } catch (error) { if (!current() || this.expired(error)) return; if (!(error instanceof ApiError && error.status === 404)) throw error; }
        }
        if (forceRead || reopen || this.refreshedRevision !== latest.revision) {
          const requested = pageMessages(this.state.transcript).map(message => ({ id: message.id, version: message.version }));
          const epoch = this.state.transcript!.summary.epoch;
          const coverageSerial = this.coverageSerial;
          let stableRevision = latest.revision;
          this.update({ transcriptRefreshing: true });
          for (let offset = 0; offset < requested.length;) {
            const batch = requested.slice(offset, offset + 100);
            const refreshSerial = this.publicationSerial;
            const refresh = await this.client.transcriptRefresh!(id, { epoch, messages: batch }, signal);
            if (!current() || this.state.transcript?.summary.epoch !== epoch) return;
            signal.throwIfAborted();
            if (refresh.sessionId !== id || refresh.epoch !== epoch || !Number.isInteger(refresh.processed) || refresh.processed < 1 || refresh.processed > batch.length) throw new Error("Invalid transcript refresh response.");
            if (refresh.removedIds.length) throw new ApiError("Canonical messages were removed; reopen transcript coverage.", 409, "transcript-reset");
            const protectedIds = this.protectedAfter(refreshSerial, refresh.upserts), protectedSummary = this.summarySerial > refreshSerial;
            this.publishPages(refreshPages(this.state.transcript, refresh, protectedIds, protectedSummary));
            if (protectedIds.size || protectedSummary) stableRevision = "";
            if (refresh.revision !== latest.revision) stableRevision = "";
            offset += refresh.processed;
          }
          this.refreshedRevision = coverageSerial === this.coverageSerial ? stableRevision : "";
        }
        this.pageValidated = true; this.transcriptKey = conversation ? conversationKey(conversation) : ""; this.cacheable = !!conversation && !awaitingCompact;
      } catch (error) {
        if (!current() || this.expired(error)) return;
        if (this.cursorExpired(error)) { this.resetPages(); this.update({ messages: [] }); }
        this.update({ transcriptInitialLoading: false, transcriptError: `${error instanceof Error ? error.message : "History unavailable."} History will retry automatically.` });
      } finally { if (current()) this.update({ transcriptRefreshing: false, loading: awaitingCompact }); }
    })();
    // Listing + ALL lightweight run summaries, not the displayed history window,
    // are the active-run authority. No per-run event cursor is seeded here.
    const metadata = async () => {
      try {
        let items: TranscriptMetadataItem[] = [], revision = "", epoch = "";
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            let cursor: string | undefined; items = [];
            do {
              const readFence = this.pageFence;
              const page = !attempt && !cursor ? await metadataHead : await this.client.transcriptMeta!(id, cursor, signal);
              if (!current()) return false;
              signal.throwIfAborted();
              if (!page) return false;
              if ((attempt || cursor) && readFence !== this.pageFence) throw new ApiError("Transcript changed while reading metadata.", 409, "transcript-reset");
              if (page.sessionId !== id) throw new Error("Run metadata session identity mismatch.");
              if (this.state.transcript && page.epoch !== this.state.transcript.summary.epoch) { this.resetPages(); this.update({ messages: [] }); }
              if (!cursor) { revision = page.metadataRevision; epoch = page.epoch; }
              else if (revision !== page.metadataRevision || epoch !== page.epoch) throw new ApiError("Metadata changed; retrying traversal.", 409, "transcript-reset");
              if (!forceRead && !cursor && this.state.transcript?.metadataRevision === revision && !this.state.metadataError) return true;
              items.push(...page.items); cursor = page.nextCursor ?? undefined;
            } while (cursor);
            break;
          } catch (error) { if (attempt === 2 || !this.cursorExpired(error)) throw error; }
        }
        if (!current()) return false;
        const runMap = new Map<string, Run>();
        for (const item of items) if (item.kind === "run") {
          if (item.run.conversationId !== id) throw new Error("Run identity does not match the selected conversation.");
          const previous = this.runMap.get(item.run.id);
          const same = previous && sameRunMetadata(previous, item.run);
          runMap.set(item.run.id, same ? previous : { ...createRun(item.run), summaryOnly: true });
        }
        this.runMap = runMap;
        const proposed = items.flatMap(item => item.kind === "compaction" ? [item.compaction] : []);
        const transcript = this.state.transcript;
        const compactions = transcript && equalValue(transcript.compactions, proposed) ? transcript.compactions : proposed;
        metadataProjection = { epoch, metadataRevision: revision, compactions };
        publishMetadata();
        const ordered = [...runMap.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const runs = ordered.length === this.state.runs.length && ordered.every((run, index) => run === this.state.runs[index]) ? this.state.runs : ordered;
        this.update({ runs, compactions, metadataError: "" });
        return true;
      } catch (error) {
        if (current() && !this.expired(error)) this.update({ metadataError: `Run status unavailable: ${error instanceof Error ? error.message : "connection error"}` });
        return false;
      }
    };
    const eligibility = async () => {
      if (!this.supportedCapabilities(conversation?.harness).compaction || !this.client.compactState || awaitingCompact) return;
      const read = ++this.compactReadSerial;
      try {
        const compactState = await this.client.compactState(id, signal);
        if (current() && read === this.compactReadSerial) this.applyCompactState(compactState);
      } catch (error) { if (current() && !this.expired(error) && read === this.compactReadSerial) this.update({ compactState: null, compactError: this.compactReadFeedback(error) }); }
    };
    const workers = async () => {
      if (!this.client.workers) return;
      // Match legacy acquisition: the listing proves worker-free membership,
      // but never discard recovered deliveries or suppress an errored read.
      const knownWorkers = workersFor(id);
      const workerQuiet = !!conversation && !knownWorkers.workers.length && !knownWorkers.deliveries.length && !knownWorkers.error
        && (conversation.directWorkerCount ?? 0) === 0 && !conversation.worker;
      if (workerQuiet) {
        if (current()) { this.recordWorkerPoll(conversation); this.update({ workerLoading: false }); }
        return;
      }
      if (!this.workerPollDue(conversation)) return;
      if (!this.workerReady) this.update({ workerLoading: true });
      try { const projection = await this.client.workers(id, signal); if (current()) publishWorkers(id, projection); }
      catch (error) { if (current() && !this.expired(error)) publishWorkers(id, { ...workersFor(id), error: error instanceof Error ? error.message : "Worker status unavailable" }); }
      finally { if (current()) { this.recordWorkerPoll(conversation); this.update({ workerLoading: false }); } }
    };
    const eligibilityRead = eligibility(), workerRead = workers();
    const metadataReady = await metadata();
    if (!current()) return;
    signal.throwIfAborted();
    // Merge lifecycle detail after parallel reads; metadata never overwrites an
    // eligibility response just because it happened to finish later.
    if (this.state.compactState) this.applyCompactState(this.state.compactState);
    const ready = metadataReady && !awaitingCompact;
    this.update({ connected: ready, interactive: !awaitingCompact, connectionError: ready ? "" : this.state.metadataError ?? "" });
    const branchDraft = conversation?.branchDraft;
    if (branchDraft && !this.state.runs.some(run => run.operation !== "compact") && !this.state.drafts[this.draftKey(id)]) this.setDraft({ text: branchDraft }, id);
    if (this.supportedCapabilities(conversation?.harness).listInteractions && this.client.interactions && ready) {
      try { const interactions = await this.client.interactions(id, signal); if (current()) this.update({ interactions: interactions.filter(item => !this.replied.has(item.id)), ...(this.state.interactionError.startsWith("Pending requests unavailable:") ? { interactionError: "" } : {}) }); }
      catch (error) { if (current() && !this.expired(error)) this.update({ interactionError: `Pending requests unavailable: ${error instanceof Error ? error.message : "connection error"}` }); }
    }
    if (this.supportedCapabilities(conversation?.harness).listHandoffApprovals && this.client.handoffApprovals && ready) {
      try {
        const approvals = await this.client.handoffApprovals(id, signal);
        if (current()) this.update({ handoffApprovals: approvals.filter(item => !this.replied.has(item.id)), ...(this.state.interactionError.startsWith("Handoff approvals unavailable:") ? { interactionError: "" } : {}) });
      } catch (error) {
        // Missing backend route (404) means no sender approvals yet; keep the
        // sender composer usable instead of surfacing a transport error.
        if (current() && !this.expired(error)) {
          if (error instanceof ApiError && error.status === 404) this.update({ handoffApprovals: [], ...(this.state.interactionError.startsWith("Handoff approvals unavailable:") ? { interactionError: "" } : {}) });
          else this.update({ interactionError: `Handoff approvals unavailable: ${error instanceof Error ? error.message : "connection error"}` });
        }
      }
    }
    await Promise.all([historyRead, eligibilityRead, workerRead]);
    if (current() && this.state.compactState) this.applyCompactState(this.state.compactState);
  }
  private scienceTimer?: ReturnType<typeof setTimeout>;
  private scienceController?: AbortController;
  private scienceDiscoveryPending = false;
  private scienceListing?: Conversation;
  private appAdmissionScienceEvidence(record: AppAdmissionRecoveryRecord, submissions = this.state.scienceSubmissions?.[record.envelope.intent.conversationId ?? ""] ?? []) {
    const requestId = record.envelope.intent.payload.requestId;
    return submissions.find(item => typeof requestId === "string" && item.requestId === requestId
      && item.conversationId === record.envelope.intent.conversationId
      && equalValue(item.snapshots, record.recovery.scienceSnapshots ?? [])
      && (item.state !== "submitted" || record.receipt?.state !== "admitted" || item.runId === record.receipt.target.dispatch.runId));
  }
  private sciencePendingFor(id: string) {
    if (this.state.sciencePending?.[id] || this.state.scienceSubmissions?.[id]?.some(item => item.state === "prepared" || item.state === "unknown")) return true;
    for (const record of this.appAdmissionRecords.values()) {
      if (record.scope.storeId !== this.state.config?.storeId || record.envelope.intent.operation !== "science-message" || record.envelope.intent.conversationId !== id || record.receipt?.state === "rejected") continue;
      const evidence = this.appAdmissionScienceEvidence(record);
      if (!evidence || evidence.state === "prepared" || evidence.state === "unknown") return true;
    }
    try { return !!this.readSciencePending(id); }
    catch { return true; }
  }
  /** Independent single-flight discovery also covers sends made by other clients. */
  private sciencePolling(discover = false) {
    // Keep invalidations that arrive during a read or while polling is paused.
    if (discover) this.scienceDiscoveryPending = true;
    if (this.state.phase !== "ready" || this.scienceTimer || this.scienceController || !this.client.scienceSubmissions || !this.state.selected || !this.state.config?.authenticated || !this.state.config.storeId || typeof document !== "undefined" && document.hidden) return;
    if (!this.scienceDiscoveryPending && this.state.scienceSubmissions?.[this.state.selected] !== undefined && !this.sciencePendingFor(this.state.selected)) return;
    this.scienceDiscoveryPending = false;
    const id = this.state.selected, auth = this.authEpoch, selection = this.selectionEpoch, generation = this.generation, storeId = this.state.config.storeId;
    const controller = this.scienceController = new AbortController();
    const current = () => !controller.signal.aborted && this.state.phase === "ready" && this.state.config?.authenticated === true && this.state.config.storeId === storeId && auth === this.authEpoch && selection === this.selectionEpoch && generation === this.generation && id === this.state.selected;
    const deadline = setTimeout(() => controller.abort(), 25000);
    void this.refreshScienceSubmissions(id, current, controller.signal).then(refreshed => {
      if (!refreshed && this.scienceController === controller) this.scienceDiscoveryPending = true;
    }).finally(() => {
      clearTimeout(deadline);
      if (this.scienceController !== controller) return;
      this.scienceController = undefined;
      if (auth !== this.authEpoch || selection !== this.selectionEpoch || generation !== this.generation || this.state.phase !== "ready") return;
      if (this.scienceDiscoveryPending || this.sciencePendingFor(id) || this.state.scienceSubmissions?.[id] === undefined) this.scienceTimer = setTimeout(() => { this.scienceTimer = undefined; this.sciencePolling(); }, jitteredDelay(5000));
    });
  }
  /** Live sessions (running work or pending submission state) poll fast; static opened sessions back off. */
  private pollBusy() {
    return this.state.loading || this.state.sending || !!this.state.pendingTurn || this.state.actionBusy
      // Run completion can precede release of the conversation reservation.
      // Keep checking that transition rather than backing off for a full minute.
      || !!this.state.selected && (this.state.availability.code === "conversation-busy" || !this.state.availability.code
        && this.state.availability.reason === "This conversation already has an active run or reconciliation")
      || !!this.state.transcriptInitialLoading || !!this.state.transcriptError || !!this.state.metadataError
      || this.state.interactions.length > 0 || this.state.handoffApprovals.length > 0
      || this.state.conversations.some(conversation => conversation.status === "running" || conversation.status === "starting" || conversation.lastRunStatus === "running" || conversation.lastRunStatus === "starting")
      || this.state.conversations.some(conversation => conversation.id === this.state.selected && (conversation.nativeActivity === "active" || !!conversation.activity))
      || workerProjectionInFlight(workersFor(this.state.selected))
      || this.state.runs.some(run => run.status === "running" || run.status === "starting");
  }
  private pollDelay(healthy: boolean) { return jitteredDelay(!healthy || this.pollBusy() ? 5000 : 60000); }
  private runGateId = "";
  private runGateMarkers = "";
  private async poll() {
    if (this.state.phase !== "ready" || this.state.sending || typeof document !== "undefined" && document.hidden || this.pollFlight?.generation === this.generation) return;
    clearTimeout(this.timer); this.timer = undefined;
    const flight = this.pollFlight = { generation: this.generation };
    const forceRead = this.selectedRefreshPending;
    this.selectedRefreshPending = false;
    const generation = this.generation, auth = this.authEpoch, selected = this.state.selected, selection = this.selectionEpoch;
    const controller = this.controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 25000);
    const lifecycleCurrent = () => generation === this.generation && auth === this.authEpoch && selection === this.selectionEpoch && selected === this.state.selected;
    let listingRevision: number | undefined;
    const current = () => lifecycleCurrent() && this.pollFlight === flight && (listingRevision === undefined || listingRevision === this.conversationListing.revision);
    try {
      this.subscribeRefreshWake();
      if (forceRead) {
        // Invalidate only when the preceding poll has settled. Listing revision
        // changes here must not fence out the poll that received the hint.
        invalidateCoalescedRequests(); this.conversationListing.invalidate();
        this.nativeHistoryLoaded = false; this.refreshedRevision = "";
        this.runGateId = ""; this.runGateMarkers = ""; this.workerPollAfter = 0;
      }
      const selectedGrok = !!selected && this.harness() === "grok";
      this.pendingInputPolling();
      this.sciencePolling();
      if (!selectedGrok && this.harness() !== "grok") {
        this.appAdmissionPolling();
      }
      // Sidebar head acquisition has its own scope/auth fences. With targeted
      // support it runs alongside the selected read, not in front of it.
      const head = this.groupListing.enabled ? Promise.resolve() : this.refreshConversationHead();
      if (selected && this.client.conversationSummaries) await this.ensureConversations([selected], controller.signal);
      else if (selected && this.groupListing.enabled) await this.ensureConversations([selected], controller.signal);
      else await head;
      listingRevision = this.conversationListing.revision;
      const listing = { conversations: this.state.conversations, availability: this.state.globalAvailability ?? this.state.availability };
      if (!current()) return;
      controller.signal.throwIfAborted();
      if (this.groupListing.enabled && !selected) {
        const available = this.state.globalAvailability;
        // Blank chats skip transcript hydration, which normally restores this
        // flag after choose()/disconnect explicitly set interactive to false.
        this.update({ conversationsReady: true, connected: !!available, interactive: !!available, loading: false, availability: available ?? { canSend: false }, connectionError: "" });
        return;
      }
      if (!this.notificationScope && !(this.state.config?.conversationUpdates === true && this.client.conversationUpdates)) this.observeNotifications(listing.conversations, !!this.state.conversationPage);
      if (!current()) return;
      registerWorkerSessions(listing.conversations, !!this.state.conversationPage);
      const currentConversation = listing.conversations.find(c => c.id === selected);
      if (currentConversation?.harness === "grok") {
        let history = this.state.nativeHistory?.sessionId === selected && this.state.nativeHistory.nativeSessionId === currentConversation.nativeSessionId ? this.state.nativeHistory : null;
        let historyError = "";
        if (this.supportedCapabilities("grok").nativeHistoryRefresh && this.client.nativeHistory) {
          try {
            const result = await this.client.nativeHistory(selected, controller.signal);
            if (!current()) return;
            if (result.history && (result.history.sessionId !== selected || result.history.nativeSessionId !== currentConversation.nativeSessionId)) throw new Error("Native history identity does not match this Grok conversation.");
            history = result.history;
            this.nativeHistoryLoaded = true;
            // Imported conversations can display their genuine native history
            // even if the capture-status endpoint is temporarily unavailable.
            const cached = this.grokViews.get(selected);
            this.update({ nativeHistory: history, messages: grokMessages(cached?.nativeSessionId === currentConversation.nativeSessionId ? cached : undefined, history) });
          } catch (error) {
            if (!current() || this.expired(error)) return;
            historyError = `Native history unavailable: ${error instanceof Error ? error.message : "connection error"}`;
          }
        }
        if (!this.client.grokSession) throw new Error("Grok capture status is unavailable on this bridge.");
        const view = grokSessionView(await this.client.grokSession(selected, controller.signal), selected);
        if (current()) {
          this.publishGrok(view, currentConversation.availability, history);
          if (historyError) this.update({ metadataError: historyError });
          if (!equalValue(this.scienceListing, currentConversation)) { this.scienceListing = currentConversation; this.sciencePolling(true); }
        }
        if (!current()) return;
        if (this.supportedCapabilities("grok").compaction && this.client.compactState) {
          try { const compact = await this.client.compactState(selected, controller.signal); if (current()) this.applyCompactState(compact); }
          catch (error) { if (current() && !this.expired(error)) this.update({ compactError: this.compactReadFeedback(error) }); }
        }
        // These are ordinary App endpoints. Grok's capture transport does not
        // expose a native interaction inbox or pretend to be a CC transcript.
        if (this.client.workers && this.workerPollDue(currentConversation)) {
          try { const projection = await this.client.workers(selected, controller.signal); if (current()) publishWorkers(selected, projection); }
          catch (error) { if (current() && !this.expired(error)) publishWorkers(selected, { ...workersFor(selected), error: error instanceof Error ? error.message : "Worker status unavailable" }); }
          if (current()) this.recordWorkerPoll(currentConversation);
        }
        if (current() && this.supportedCapabilities("grok").listHandoffApprovals && this.client.handoffApprovals) {
          try {
            const approvals = await this.client.handoffApprovals(selected, controller.signal);
            if (current()) this.update({ handoffApprovals: approvals.filter(item => !this.replied.has(item.id)), ...(this.state.interactionError.startsWith("Handoff approvals unavailable:") ? { interactionError: "" } : {}) });
          } catch (error) {
            if (current() && !this.expired(error)) this.update({ interactionError: `Handoff approvals unavailable: ${error instanceof Error ? error.message : "connection error"}` });
          }
        }
        return;
      }
      if (selected && (!currentConversation || this.transcriptKey && this.transcriptKey !== conversationKey(currentConversation))) {
        // A listing can remove or rebind an App id even while its history GET
        // fails. Never keep the old native transcript/actions under that id.
        this.runMap = new Map(); this.transcriptKey = ""; this.cacheable = false; this.nativeHistoryLoaded = false; this.workerReady = false;
        this.runGateId = ""; this.runGateMarkers = "";
        if (this.paged) this.resetPages();
        this.replied.clear(); this.selectionEpoch++; this.actionSerial++; this.compactReadSerial++;
        this.stop();
        const pendingCompacts = { ...this.state.pendingCompacts }, compactInstructions = { ...this.state.compactInstructions };
        delete pendingCompacts[selected]; delete compactInstructions[selected];
        this.update({ conversations: listing.conversations, conversationsReady: true, runs: [], messages: [], pendingTurn: null, nativeHistory: null, contextUsage: null, compactState: null, compactions: [], compactDialog: "", compactError: "", pendingCompacts, compactInstructions, interactions: [], handoffApprovals: [], interactionError: "", actionBusy: false, actionNotice: "", availability: { canSend: false }, connected: false, loading: !!currentConversation, connectionError: currentConversation ? "" : "Conversation is no longer in the active catalog. If retired, restore it explicitly before reopening. Archived history is preserved." });
        // Restart with a fresh action/selection fence and the new identity.
        if (currentConversation) void this.poll();
        else this.timer = setTimeout(() => void this.poll(), 5000);
        return;
      }
      // Compare server rows, not locally derived titles or optimistic updates.
      if (selected && !equalValue(this.scienceListing, currentConversation)) {
        this.scienceListing = currentConversation;
        this.sciencePolling(true);
        // Run/worker markers changed (possibly from another client).
        this.emittingListingWake = true;
        try { wakePolls(selected); }
        finally { this.emittingListingWake = false; }
      }
      const conversations = listing.conversations.map(conversation => {
        const title = this.state.conversations.find(previous => previous.id === conversation.id)?.title;
        return !conversation.title && title ? { ...conversation, title } : conversation;
      });
      this.update({ conversations: equalValue(this.state.conversations, conversations) ? this.state.conversations : conversations, conversationsReady: true,
        interactive: !this.compactInFlight.has(selected), availability: this.compactInFlight.has(selected) ? { canSend: false } : currentConversation?.availability ?? listing.availability });
      if (!current()) return;
      if (this.paged) { await this.pollPaged(listing, current, controller.signal, forceRead); return; }
      // Safe GET also notices reconciliation by another view/client. Reuse the
      // snapshot identity when the backend refresh timestamp has not changed.
      const historyRead = selected && this.client.nativeHistory ? (await this.client.nativeHistory(selected, controller.signal)).history : null;
      if (!current()) return;
      controller.signal.throwIfAborted();
      if (historyRead && (historyRead.sessionId !== selected || historyRead.nativeSessionId !== (currentConversation?.nativeSessionId ?? selected))) throw new Error("Native history identity changed. Waiting for the conversation listing to refresh.");
      if (historyRead?.importedAt !== this.state.nativeHistory?.importedAt) this.invalidateConversationCache(selected);
      const nativeHistory = this.nativeHistoryLoaded && historyRead?.importedAt === this.state.nativeHistory?.importedAt ? this.state.nativeHistory : historyRead;
      if (selected && this.client.workers) {
        // Worker-free sessions stay worker-free without re-reading: any
        // worker appearing changes the listing row (count/ref) and forces a
        // read, while a non-empty projection always refreshes.
        const workerRow = listing.conversations.find(c => c.id === selected);
        const knownWorkers = workersFor(selected);
        const workerQuiet = !knownWorkers.workers.length && !knownWorkers.deliveries.length && !knownWorkers.error
          && (workerRow?.directWorkerCount ?? 0) === 0 && !workerRow?.worker;
        if (!workerQuiet && this.workerPollDue(workerRow)) {
          try { const projection = await this.client.workers(selected, controller.signal); if (current()) publishWorkers(selected, projection); }
          catch (error) { if (!current() || this.expired(error)) return; publishWorkers(selected, { ...workersFor(selected), error: error instanceof Error ? error.message : "Worker status unavailable" }); }
          if (current()) this.recordWorkerPoll(workerRow);
        }
      }
      if (!current()) return;
      controller.signal.throwIfAborted();
      // Only commit reducer state alongside the transcript at the end. Failed
      // or aborted reads must not advance published cursors, buffers, or Sets.
      // Session gate: the listing row already carries updatedAt/lastRunId/
      // lastRunStatus/lastRunEndedAt. If all are unchanged since the last runs
      // read and no run is active (nor any local submission state), no run or
      // event could have appeared: reuse the known runs without any read.
      // Same-millisecond event bursts are covered by forcing the gate open
      // while any run is active; terminal runs never append events.
      const gateRow = selected ? listing.conversations.find(c => c.id === selected) : undefined;
      const gateMarkers = gateRow ? JSON.stringify([gateRow.updatedAt ?? null, gateRow.lastRunId ?? null, gateRow.lastRunStatus ?? null, gateRow.lastRunEndedAt ?? null]) : "";
      const gateActive = gateRow?.status === "running" || gateRow?.status === "starting" || gateRow?.lastRunStatus === "running" || gateRow?.lastRunStatus === "starting";
      const gateHit = !!selected && !!gateRow && gateRow.id === this.runGateId && gateMarkers === this.runGateMarkers
        && !gateActive && !this.state.loading && !this.state.sending && !this.state.pendingTurn && !this.state.actionBusy && !this.compactInFlight.has(selected);
      const runMap = new Map<string, Run>();
      if (gateHit) {
        for (const run of this.runMap.values()) runMap.set(run.id, run);
      }
      if (!gateHit && selected) {
        const metadata = await this.client.runs(selected, controller.signal);
        if (!current()) return;
        controller.signal.throwIfAborted();
        const ordered = [...metadata].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const latestId = ordered.at(-1)?.id;
        for (const meta of ordered) {
          if (meta.conversationId !== selected) throw new Error("Run identity does not match the selected conversation.");
          meta.harness = currentConversation?.harness ?? "claude-code";
          meta.nativeSessionId = currentConversation?.nativeSessionId;
          const previous = this.runMap.get(meta.id);
          // Settled runs (terminal, metadata-identical, not the latest) can
          // never grow events; only active, new, changed, or latest runs need
          // an events read. "unknown" is deliberately not settled: it may resolve.
          const settled = !!previous && meta.id !== latestId
            && (previous.status === "completed" || previous.status === "failed" || previous.status === "interrupted")
            && meta.status === previous.status
            && meta.harness === previous.harness && meta.nativeSessionId === previous.nativeSessionId
            && (Object.keys(meta) as (keyof typeof meta)[]).every(key => key === "status" || key === "harness" || key === "nativeSessionId"
              || (key === "compact" ? JSON.stringify(meta[key]) === JSON.stringify(previous[key]) : meta[key] === previous[key]));
          if (settled) { runMap.set(previous.id, previous); continue; }
          let run = previous ?? createRun(meta);
          // The client uses only id/cursor for this GET; it never consumes events.
          const page = await this.client.events(run, controller.signal);
          if (!current()) return;
          controller.signal.throwIfAborted();
          const status = page.status || meta.status;
          const cursor = Number.isFinite(page.nextCursor) ? Math.max(run.cursor, page.nextCursor) : run.cursor;
          const changed = !previous || status !== run.status || cursor !== run.cursor ||
            (page.events ?? []).some(event => event.runId === run.id && event.sessionId === selected && !run.seen.has(event.seq)) ||
            (Object.keys(meta) as (keyof typeof meta)[]).some(key => key !== "status" && (key === "compact" ? JSON.stringify(meta[key]) !== JSON.stringify(run[key]) : meta[key] !== run[key]));
          if (changed) {
            // Own mutable reducer containers without deep-copying diagnostic payloads.
            if (previous) run = cloneRunForConsume(previous);
            Object.assign(run, meta, { status });
            consume(run, page.events ?? []);
            run.cursor = cursor;
          }
          runMap.set(run.id, run);
        }
      }
      // Recorded only when the read above ran to completion: markers always
      // describe the listing the reused/fetched runs were resolved against.
      if (!gateHit) { this.runGateId = selected; this.runGateMarkers = gateMarkers; }
      const runs = [...runMap.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const messages = transcriptMessages(nativeHistory, runs);
      const pending = this.state.pendingTurn;
      const pendingTurn = pendingTurnRecorded(messages, pending) ? null : pending;
      const title = messages.find(m => m.role === "user")?.parts.find(p => p.type === "text");
      // Backend titles win (persisted first prompt or handoff `<Role> #<n>`).
      // Otherwise the open conversation derives from its transcript and other
      // rows keep their previous derived value until the backend backfills.
      const titledConversations = this.state.conversations.map(c => {
        if (c.title) return c;
        if (c.id === selected && title?.type === "text") return { ...c, title: title.text };
        const old = this.state.conversations.find(prev => prev.id === c.id)?.title;
        return old ? { ...c, title: old } : c;
      });
      const branchDraft = titledConversations.find(c => c.id === selected)?.branchDraft;
      const awaitingCompact = this.compactInFlight.has(selected);
      const availability = awaitingCompact ? { canSend: false } : titledConversations.find(c => c.id === selected)?.availability ?? listing.availability;
      const conversation = titledConversations.find(c => c.id === selected);
      const models = this.state.modelsLoaded && !this.state.modelsError && this.state.modelsCwd === conversation?.cwd ? this.state.models : [];
      let compactState = this.state.compactState, compactError = this.state.compactError;
      // Compact state only moves with runs or compact operations. When the
      // session gate holds, nothing ran: skip the re-read once loaded, unless
      // a compact operation is still unconfirmed.
      const compactQuiet = gateHit && !this.compactInFlight.has(selected) && !this.state.pendingCompacts?.[selected]
        && this.state.compactState !== undefined && this.state.compactState !== null;
      if (selected && !compactQuiet && this.supportedCapabilities(conversation?.harness).compaction && this.client.compactState) {
        const read = ++this.compactReadSerial;
        try {
          const result = await this.client.compactState(selected, controller.signal);
          compactState = read === this.compactReadSerial ? result : this.state.compactState;
          const pending = this.state.pendingCompacts?.[selected];
          const recovered = read === this.compactReadSerial && pending?.phase === "unconfirmed" && result.operations.some(record => record.requestId === pending.payload.requestId);
          compactError = read === this.compactReadSerial ? this.compactReadFeedback(undefined, !!recovered) : this.state.compactError;
        }
        catch (error) { if (!current() || this.expired(error)) return; compactState = this.state.compactState; compactError = read === this.compactReadSerial ? this.compactReadFeedback(error) : this.state.compactError; }
      }
      if (!current()) return;
      controller.signal.throwIfAborted();
      if (awaitingCompact) compactState = null;
      this.nativeHistoryLoaded = !awaitingCompact && !(compactState?.nativeHistoryImportedAt && compactState.nativeHistoryImportedAt !== nativeHistory?.importedAt);
      const compactions = conversation ? compactionsFor(conversation, runs, nativeHistory, compactState?.operations) : [];
      const contextUsage = conversation && !awaitingCompact ? contextUsageFor(conversation.harness, runs, models, nativeHistory, compactions) : null;
      const pendingCompact = this.state.pendingCompacts?.[selected];
      const recovered = pendingCompact && compactState?.operations.find(r => r.requestId === pendingCompact.payload.requestId);
      const pendingCompacts = recovered && pendingCompact.phase !== "accepted" && pendingCompact.phase !== "sending" ? { ...this.state.pendingCompacts, [selected]: { ...pendingCompact, phase: "accepted" as const, runId: recovered.runId } } : this.state.pendingCompacts;
      // Referential stability: an idle poll produces deep-equal data. Skipping
      // the broadcast keeps whole-store subscribers (App, transcript) from
      // re-rendering every 1.5s; the reschedule in finally still runs.
      const prev = this.state;
      const quiet = prev.connected && !prev.loading && !prev.connectionError &&
        prev.pendingTurn === pendingTurn &&
        prev.nativeHistory === nativeHistory &&
        JSON.stringify(prev.conversations) === JSON.stringify(titledConversations) &&
        JSON.stringify(prev.availability) === JSON.stringify(availability) &&
        JSON.stringify(prev.contextUsage) === JSON.stringify(contextUsage) &&
        JSON.stringify(prev.compactState) === JSON.stringify(compactState) && JSON.stringify(prev.compactions) === JSON.stringify(compactions) && prev.compactError === compactError && prev.pendingCompacts === pendingCompacts &&
        prev.runs.length === runs.length && runs.every((run, index) => prev.runs[index] === run) &&
        JSON.stringify(prev.messages) === JSON.stringify(messages);
      this.runMap = runMap;
      this.transcriptKey = conversation ? conversationKey(conversation) : "";
      this.cacheable = !!conversation && this.nativeHistoryLoaded && !awaitingCompact;
      if (!quiet) this.update({ ...listing, availability, nativeHistory, contextUsage, compactState, compactions, compactError, pendingCompacts, conversations: titledConversations, runs, messages, pendingTurn, connected: !awaitingCompact, loading: awaitingCompact, connectionError: "" });
      if (!current()) return;
      if (branchDraft && !runs.some(run => run.operation !== "compact") && !this.state.drafts[this.draftKey(selected)]) this.setDraft({ text: branchDraft }, selected);
      if (!current()) return;
      if (selected && !awaitingCompact && this.supportedCapabilities(conversation?.harness).listInteractions && this.client.interactions) {
        try {
          const interactions = await this.client.interactions(selected, controller.signal);
          if (current()) this.update({ interactions: interactions.filter(i => !this.replied.has(i.id)), ...(this.state.interactionError.startsWith("Pending requests unavailable:") ? { interactionError: "" } : {}) });
        } catch (error) {
          if (current() && !this.expired(error)) this.update({ interactionError: `Pending requests unavailable: ${error instanceof Error ? error.message : "connection error"}` });
        }
      }
      if (selected && !awaitingCompact && this.supportedCapabilities(conversation?.harness).listHandoffApprovals && this.client.handoffApprovals) {
        try {
          const approvals = await this.client.handoffApprovals(selected, controller.signal);
          if (current()) this.update({ handoffApprovals: approvals.filter(i => !this.replied.has(i.id)), ...(this.state.interactionError.startsWith("Handoff approvals unavailable:") ? { interactionError: "" } : {}) });
        } catch (error) {
          if (current() && !this.expired(error)) {
            if (error instanceof ApiError && error.status === 404) this.update({ handoffApprovals: [], ...(this.state.interactionError.startsWith("Handoff approvals unavailable:") ? { interactionError: "" } : {}) });
            else this.update({ interactionError: `Handoff approvals unavailable: ${error instanceof Error ? error.message : "connection error"}` });
          }
        }
      }
    } catch (error) {
      if (!current() || this.expired(error)) return;
      this.update({ connected: false, loading: false, connectionError: `${error instanceof Error ? error.message : "Connection lost."} History will reconnect automatically.` });
    } finally {
      clearTimeout(deadline);
      if (this.pollFlight === flight) this.pollFlight = undefined;
      if (lifecycleCurrent() && this.state.phase === "ready" && !(typeof document !== "undefined" && document.hidden)) {
        // Errors/observed activity stay on bounded fast retries even when run
        // metadata alone is ready. Wake bursts get one immediate successor.
        this.timer = setTimeout(() => { this.timer = undefined; void this.poll(); }, this.selectedRefreshPending ? 0 : this.pollDelay(this.state.connected));
      }
    }
  }
  private async sendGrok(text: string, options: { preserveDraft?: boolean }, nativeStopped = false): Promise<SendOutcome> {
    const selected = this.state.selected, conversation = this.state.conversations.find(item => item.id === selected);
    const profile = options.preserveDraft && selected ? this.conversationProfile(selected) : this.effectiveProfile();
    const upgrade = options.preserveDraft ? undefined : this.pendingUpgrade();
    const scienceSnapshots = options.preserveDraft ? [] : structuredClone(this.draft().scienceSnapshots ?? []);
    if (!this.grokCaptureSupported()) {
      this.update({ submissionError: this.state.config?.grokCapability?.reason || "Grok capture is not configured on this bridge. Your draft is unchanged." });
      return { status: "blocked" };
    }
    const command = compactCommand(text);
    if (command && scienceSnapshots.length) { this.update({ submissionError: "Remove staged science snapshots before compacting." }); return { status: "blocked" }; }
    if (command) { this.openCompact(command.instructions); return { status: "blocked" }; }
    const unsupported = !selected && (scienceSnapshots.length || options.preserveDraft) ? "Start a conversation before sharing snapshots or a document review."
      : scienceSnapshots.length && this.draft().text !== text ? "Send snapshots from their original conversation draft."
      : !options.preserveDraft && this.draft().upgradeId && (!upgrade || !this.assignable(upgrade).ok) ? "This bridge does not support the selected Grok profile upgrade."
      : this.pendingInputChainLocked() ? "Resolve the existing input chain before sending ordinary input."
      : this.state.availability.queueAfterRunId || this.state.availability.nativeQueue ? "Wait for the current run to finish before sending."
      : selected ? conversation?.harness !== "grok" ? "The selected conversation is not a Grok session." : ""
      : !profile || profile.harness !== "grok" ? "Choose a Grok conversation profile." : "";
    if (unsupported) {
      this.update({ submissionError: `${unsupported} Your draft is unchanged.` });
      return { status: "blocked" };
    }
    if (conversation?.attachment && this.supportedCapabilities("grok").attachedSendRequiresNativeStopped && !nativeStopped) {
      this.update({ submissionError: "Confirm external assistant execution is stopped before sending." }); return { status: "blocked" };
    }
    if (selected && this.state.config?.storeId && this.sciencePendingFor(selected)) {
      this.update({ submissionError: "A previous science send is unresolved. Check its original receipt before sending; nothing was resent." });
      this.sciencePolling(true); return { status: "blocked" };
    }
    if (!text.trim() && !scienceSnapshots.length || this.state.sending || this.state.actionBusy || this.executionUnavailable()
      || !(this.state.interactive ?? this.state.connected) || selected && (!this.state.availability.canSend || this.grokUnconfirmed.has(selected))) return { status: "blocked" };
    // Use the same synchronous guard and composer lineage as ordinary sends.
    this.appAdmissionSendGuard = true;
    const draft = structuredClone(this.draft()), draftKey = this.draftKey(), stamp = this.composerStamp(draftKey);
    const navigation = { ...catalog.state.navigation }, auth = this.authEpoch, selection = this.selectionEpoch;
    const sessionId = selected || crypto.randomUUID();
    const scienceRequestId = scienceSnapshots.length ? crypto.randomUUID() : undefined;
    const choices = profile ? this.profileChoices(profile) : { model: "", effort: "" };
    const saved = selected ? this.storedDefaults(selected) : undefined;
    const model = selected && !upgrade ? saved?.model || choices.model : choices.model;
    const effort = selected && !upgrade ? saved?.effort || choices.effort : choices.effort;
    const cwd = selected ? conversation?.cwd : this.workspace();
    this.stop();
    const generation = this.generation;
    const current = () => auth === this.authEpoch && selection === this.selectionEpoch && generation === this.generation
      && selected === this.state.selected && draftKey === this.draftKey();
    this.update({ sending: true, submissionError: "", scienceSubmissionError: "" });
    let posted = false, input: GrokTurnInput | undefined;
    try {
      const before = selected ? grokSessionView(await this.client.grokSession!(sessionId, AbortSignal.timeout(25000)), sessionId) : undefined;
      if (!current()) return { status: "blocked" };
      if (before) {
        this.publishGrok(before);
        if (!this.state.availability.canSend) return { status: "blocked" };
      }
      input = { sessionId, turnIndex: before?.nextTurnIndex ?? 0, prompt: text,
        model: upgrade ? model : before?.model || model, effort: upgrade ? effort : before?.effort || effort, cwd: before?.cwd || cwd,
        profileId: upgrade?.id ?? (selected ? before?.profileId ?? conversation?.profileId : profile?.id),
        workspaceId: selected ? before?.workspaceId ?? conversation?.workspaceId : navigation.workspaceId,
        worktreeId: selected ? before?.worktreeId ?? conversation?.worktreeId : navigation.worktreeId,
        ...(scienceRequestId ? { requestId: scienceRequestId, scienceSnapshots: scienceSnapshots.map(({ snapshotId, blockId }) => ({ snapshotId, blockId })) } : {}),
        ...(nativeStopped ? { nativeStopped: true } : {}) };
      if (!input.model.trim() || !input.effort.trim()) throw new Error("Grok requires explicit nonempty model and effort strings in its profile.");
      if (scienceRequestId) {
        if (this.readSciencePending(sessionId)) throw new Error("A previous science request is unresolved. No replacement request was posted.");
        const pending: SciencePendingSend = { version: 1, requestId: scienceRequestId, conversationId: sessionId, text, snapshots: scienceSnapshots };
        const key = this.scienceStorageKey(sessionId), encoded = JSON.stringify(pending);
        localStorage.setItem(key, encoded);
        if (localStorage.getItem(key) !== encoded) throw new Error("The original science request could not be saved. Nothing was posted.");
        this.update({ sciencePending: { ...this.state.sciencePending, [sessionId]: pending } });
        if (sameComposerStamp(this.composerStamp(draftKey), stamp)) this.update({ drafts: { ...this.state.drafts, [draftKey]: { ...draft, text: "", scienceSnapshots: [] } } });
      }
      posted = true;
      let view: GrokSessionView;
      try {
        view = grokSessionView(await this.client.grokTurn!(input, AbortSignal.timeout(25000)), sessionId);
      } catch (error) {
        if (!current() || this.expired(error)) return { status: "unknown" };
        if (!scienceRequestId) this.grokUnconfirmed.set(sessionId, { turnIndex: input.turnIndex, draftKey, stamp, preserveDraft: options.preserveDraft });
        if (scienceRequestId) await this.refreshScienceSubmissions(sessionId, current, AbortSignal.timeout(25000));
        // Never repeat the POST, including when this exact GET is absent/stale.
        view = grokSessionView(await this.client.grokSession!(sessionId, AbortSignal.timeout(25000)), sessionId);
      }
      if (!current()) return { status: "unknown" };
      this.publishGrok(view);
      if (scienceRequestId) {
        if (view.scienceSubmission) {
          if (view.scienceSubmission.requestId !== scienceRequestId || !equalValue(view.scienceSubmission.snapshots, input.scienceSnapshots)) throw new Error("Science response does not match the original request.");
          const supplied = [...(this.state.scienceSubmissions?.[sessionId] ?? []).filter(item => item.requestId !== scienceRequestId), view.scienceSubmission];
          await this.refreshScienceSubmissions(sessionId, current, AbortSignal.timeout(25000), supplied);
        } else await this.refreshScienceSubmissions(sessionId, current, AbortSignal.timeout(25000));
        if (!current()) return { status: "unknown" };
        const receipt = this.state.scienceSubmissions?.[sessionId]?.find(item => item.requestId === scienceRequestId);
        if (receipt?.state === "submitted" && receipt.runId && !this.state.sciencePending?.[sessionId]) return { status: "accepted", conversationId: sessionId, runId: receipt.runId };
        if (receipt?.state === "not-submitted" && !this.state.sciencePending?.[sessionId]) return { status: "rejected" };
        this.update({ submissionError: "Science send outcome is unresolved. The original request is retained; check its receipt. Nothing will be resent automatically." });
        return { status: "unknown" };
      }
      const unresolved = this.grokUnconfirmed.has(sessionId);
      if (!options.preserveDraft && !unresolved && view.phase !== "not-submitted" && sameComposerStamp(this.composerStamp(draftKey), stamp)) {
        this.update({ drafts: { ...this.state.drafts, [draftKey]: { ...draft, text: "",
          ...(upgrade && view.profileId === upgrade.id ? { upgradeId: "" } : {}) } } });
      }
      if (!selected) {
        // A definitely withheld first turn retains its editable draft under the
        // original capture ID, so an explicit retry does not require a new chat.
        if (!unresolved && view.phase === "not-submitted" && !this.state.drafts[sessionId] && !this.composerStamps.has(sessionId)
          && sameComposerStamp(this.composerStamp(draftKey), stamp)) {
          this.update({ drafts: { ...this.state.drafts, [draftKey]: { ...draft, text: "" },
            [sessionId]: { ...draft, profileId: "", upgradeId: "" } } });
        }
        this.update({ conversations: this.state.conversations.map(item => item.id === sessionId ? { ...item,
          cwd: item.cwd || input!.cwd || "", model: item.model || input!.model, effort: item.effort || input!.effort,
          workspaceId: item.workspaceId ?? input!.workspaceId ?? undefined, worktreeId: item.worktreeId ?? input!.worktreeId ?? undefined, association: "resolved",
          profileId: item.profileId ?? input!.profileId, title: item.title ?? text.slice(0, 160) } : item), sending: false });
        this.choose(sessionId); this.publishGrok(view); catalog.navigate({ conversationId: sessionId });
      }
      if (unresolved) this.update({ submissionError: GROK_UNKNOWN_NOTICE });
      return unresolved ? { status: "unknown" } : view.phase === "not-submitted" ? { status: "rejected" }
        : { status: "recorded", requestId: `${sessionId}:${input.turnIndex}`, conversationId: sessionId };
    } catch (error) {
      if (current() && !this.expired(error)) {
        if (posted && input) {
          if (scienceRequestId) {
            this.update({ submissionError: `Science send outcome is unresolved. ${error instanceof Error ? error.message : "Science response unavailable."} The original science request is retained; check its receipt. Nothing was resent.` });
            await this.refreshScienceSubmissions(sessionId, current, AbortSignal.timeout(25000));
            const receipt = this.state.scienceSubmissions?.[sessionId]?.find(item => item.requestId === scienceRequestId);
            if (current() && receipt?.state === "submitted" && receipt.runId && !this.state.sciencePending?.[sessionId]) return { status: "accepted", conversationId: sessionId, runId: receipt.runId };
            if (current() && receipt?.state === "not-submitted" && !this.state.sciencePending?.[sessionId]) return { status: "rejected" };
            return { status: "unknown" };
          }
          this.grokUnconfirmed.set(sessionId, { turnIndex: input.turnIndex, draftKey, stamp, preserveDraft: options.preserveDraft });
          if (!selected) {
            // Keep the original App UUID reachable even if both responses were
            // lost. This is local uncertain metadata, not a native acknowledgement.
            const row: Conversation = { id: sessionId, harness: "grok", cwd: input.cwd ?? "", model: input.model, effort: input.effort,
              workspaceId: input.workspaceId ?? undefined, worktreeId: input.worktreeId ?? undefined, association: "resolved", profileId: input.profileId,
              title: text.slice(0, 160), lastRunId: null, status: "unknown", availability: { canSend: false, reason: GROK_UNKNOWN_NOTICE } };
            this.update({ conversations: [row, ...this.state.conversations], sending: false });
            this.choose(sessionId); catalog.navigate({ conversationId: sessionId });
          }
          this.update({ availability: { canSend: false, reason: GROK_UNKNOWN_NOTICE }, submissionError: GROK_UNKNOWN_NOTICE });
        } else {
          if (scienceRequestId) {
            try { if (this.readSciencePending(sessionId)?.requestId === scienceRequestId) localStorage.removeItem(this.scienceStorageKey(sessionId)); }
            catch { /* Keep any unremovable identity fenced; never repost it. */ }
          }
          this.update({ submissionError: `${error instanceof Error ? error.message : "Grok capture unavailable."} Your draft is unchanged; nothing was posted.` });
        }
      }
      return { status: posted ? "unknown" : "blocked" };
    } finally {
      this.appAdmissionSendGuard = false;
      if (auth === this.authEpoch) { this.update({ sending: false }); this.sciencePolling(true); void this.poll(); }
    }
  }
  send = async (text: string, nativeStopped = false, options: { preserveDraft?: boolean } = {}): Promise<SendOutcome> => {
    if (this.appAdmissionSendGuard) return { status: "blocked" };
    if (this.harness() === "grok" || this.effectiveProfile()?.harness === "grok") return this.sendGrok(text, options, nativeStopped);
    if (!this.appAdmissionSupported() && !compactCommand(text)) {
      this.update({ submissionError: "App admission requires initialization on this bridge. Update and initialize the App admission store before sending; your draft is unchanged. Legacy submission is not used." });
      return { status: "blocked" };
    }
    if (this.pendingInputChainLocked()) { this.update({ submissionError: "Resolve the existing input chain before sending ordinary input." }); return { status: "blocked" }; }
    if (this.state.availability.queueAfterRunId || this.state.availability.nativeQueue) { this.update({ submissionError: "Wait for the current run to finish before sending." }); return { status: "blocked" }; }
    if (options.preserveDraft && !this.state.selected) return { status: "blocked" };
    const scienceSnapshots = options.preserveDraft ? [] : structuredClone(this.draft().scienceSnapshots ?? []);
    if (scienceSnapshots.length && (!this.state.selected || this.draft().text !== text || this.state.availability.queueAfterRunId || this.state.availability.nativeQueue)) { this.update({ submissionError: "Science snapshots require an ordinary idle-conversation send." }); return { status: "blocked" }; }
    const command = compactCommand(text);
    if (scienceSnapshots.length && command) { this.update({ submissionError: "Science snapshots cannot be sent as compaction instructions." }); return { status: "blocked" }; }
    if (command) { this.openCompact(command.instructions); return { status: "blocked" }; }
    if (this.compactBlocked() || this.state.actionBusy) return { status: "blocked" };
    const conversation = this.state.conversations.find(c => c.id === this.state.selected);
    if (!this.supportedCapabilities().prompt) return { status: "blocked" };
    if (conversation?.attachment && this.supportedCapabilities(conversation.harness).attachedSendRequiresNativeStopped && !nativeStopped) { this.update({ submissionError: "Confirm external assistant execution is stopped before sending." }); return { status: "blocked" }; }
    const running = conversation?.status === "starting" || conversation?.status === "running" || this.state.runs.some(r => r.status === "starting" || r.status === "running");
    if (scienceSnapshots.length && running) { this.update({ submissionError: "Science snapshots require an idle conversation." }); return { status: "blocked" }; }
    if (!text.trim() && !scienceSnapshots.length || running && !liveInputReady(conversation, this.state.availability) || this.state.sending || !(this.state.interactive ?? this.state.connected) || !this.state.availability.canSend || this.modelUnavailable() || this.executionUnavailable()) return { status: "blocked" };
    // Acquire synchronously, before hashing or any other await. Freeze every
    // wire selector now; later composer/navigation/profile changes cannot alter
    // either the persisted intent or the single POST body.
    this.appAdmissionSendGuard = true;
    const selected = this.state.selected, draft = structuredClone(this.draft()), draftKey = this.draftKey();
    const capturedStamp = this.composerStamp(draftKey), preserveDraft = !!options.preserveDraft;
    const clientRequestId = crypto.randomUUID(), scienceRequestId = scienceSnapshots.length ? crypto.randomUUID() : undefined;
    const pendingTurn: PendingTurn = { id: `admission:${clientRequestId}`, conversationId: selected, text, time: new Date().toISOString() };
    const upgrade = selected && !preserveDraft ? this.pendingUpgrade() : undefined;
    const profileId = selected ? upgrade && this.assignable(upgrade).ok ? upgrade.id : "" : this.draftProfile().id;
    const navigation = { ...catalog.state.navigation };
    const live = !!selected && !scienceRequestId && liveInputReady(conversation, this.state.availability);
    const expectedLiveRunId = live ? this.state.availability.liveInputRunId ?? null : null;
    const expectedSource = selected ? this.appAdmissionSource(conversation) : null;
    const auth = this.authEpoch;
    let ledger: AppAdmissionLedger | undefined, record: AppAdmissionRecoveryRecord | undefined, posted = false;
    try {
      const scope = this.appAdmissionScope();
      if (!scope) throw new Error("Sign in to an identified App store before sending.");
      if (selected && !expectedSource) throw new Error("The original conversation source is unavailable. Refresh it before sending; no request was posted.");
      if (scienceRequestId === clientRequestId) throw new Error("Science and App admission request identities must be distinct.");
      const intent: AppAdmissionIntent = decodeAppAdmissionIntent({ version: 1,
        operation: !selected ? "new-conversation" : scienceRequestId ? "science-message" : live ? "live-input" : "message",
        conversationId: selected || null, expectedSource, expectedLiveRunId, chainId: capturedStamp.chainId,
        payload: { prompt: text, ...(selected ? { sessionId: selected } : {
          ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
          ...(navigation.workspaceId !== undefined ? { workspaceId: navigation.workspaceId } : {}),
          ...(navigation.worktreeId !== undefined ? { worktreeId: navigation.worktreeId } : {}) }),
          ...(profileId ? { profileId } : {}), ...(nativeStopped ? { nativeStopped: true } : {}),
          ...(scienceRequestId ? { requestId: scienceRequestId, scienceSnapshots: scienceSnapshots.map(({ snapshotId, blockId }) => ({ snapshotId, blockId })) } : {}) } });
      const consumedStamp = preserveDraft ? null : advanceComposerStamp(capturedStamp);
      // A pre-existing legacy science marker is also unresolved; never bypass it
      // by minting an App UUID, even though new sends no longer write that format.
      if (selected && this.readSciencePending(selected)) throw new Error("A previous science request is unresolved. Check its original evidence; no replacement send is allowed.");
      this.stop();
      const context = { draft, preserveDraft, consumed: false, auth, selection: this.selectionEpoch, generation: this.generation,
        selected, sourceKey: this.pendingInputSource(selected), pendingTurn };
      this.update({ sending: true, submissionError: "" });
      const envelope = await createAppAdmissionEnvelope(intent, scope.storeId, clientRequestId);
      if (!await this.loadAppAdmissions(true)) return { status: "blocked" };
      ledger = this.appAdmissionLedger;
      if (!ledger || !this.appAdmissionCurrent(ledger, auth) || context.selection !== this.selectionEpoch || selected !== this.state.selected
        || draftKey !== this.draftKey(selected)
        || context.generation !== this.generation || !sameComposerStamp(this.composerStamp(draftKey), capturedStamp)
        || context.sourceKey !== this.pendingInputSource(selected) || !this.appAdmissionSupported()) return { status: "blocked" };
      record = await ledger.reserve({ version: 1, scope, envelope, draftKey, capturedStamp, consumedStamp,
        recovery: { text, cwd: draft.cwd, ...(draft.profileId ? { profileId: draft.profileId } : {}),
          ...(draft.upgradeId ? { upgradeProfileId: draft.upgradeId } : {}),
          ...(scienceSnapshots.length ? { scienceSnapshots: scienceSnapshots.map(({ snapshotId, blockId }) => ({ snapshotId, blockId })) } : {}) },
        receipt: null, uncertain: true });
      this.appAdmissionContexts.set(clientRequestId, context);
      if (this.appAdmissionCurrent(ledger, auth)) {
        this.appAdmissionRecords.set(clientRequestId, record); this.publishAppAdmissions();
      }
      if (!this.appAdmissionCurrent(ledger, auth) || context.selection !== this.selectionEpoch || selected !== this.state.selected
        || draftKey !== this.draftKey(selected)
        || context.generation !== this.generation || context.sourceKey !== this.pendingInputSource(selected)) return { status: "unknown" };
      // The durable record contains the planned consumed stamp BEFORE this write.
      // A write during hashing/storage leaves the newer composer untouched.
      if (!preserveDraft && sameComposerStamp(this.composerStamp(draftKey), capturedStamp)) {
        context.consumed = true;
        this.update({ drafts: { ...this.state.drafts, [draftKey]: { ...draft, text: "", scienceSnapshots: [] } } });
      }
      this.update({ pendingTurn, availability: { canSend: false, reason: "Recording App admission…" } });
      posted = true;
      const receipt = await this.client.submitAdmission!(envelope, AbortSignal.timeout(25000));
      const settled = await this.settleAppAdmission(ledger, record, receipt, auth);
      if (!this.appAdmissionCurrent(ledger, auth)) return { status: "unknown" };
      if (settled.receipt?.state === "rejected") return { status: "rejected" };
      if (settled.receipt?.state === "admitted") return { status: "accepted", conversationId: settled.receipt.target.dispatch.source.sessionId, runId: settled.receipt.target.dispatch.runId };
      return { status: "recorded", requestId: clientRequestId };
    } catch (error) {
      if (auth === this.authEpoch && !this.expired(error)) {
        // An exact GET may have durably settled while the original POST timed
        // out. Never downgrade that terminal to this call's captured null state.
        const known = record && ledger && this.appAdmissionCurrent(ledger, auth) ? this.appAdmissionRecords.get(clientRequestId)?.receipt : undefined;
        if (known?.state === "admitted") return { status: "accepted", conversationId: known.target.dispatch.source.sessionId, runId: known.target.dispatch.runId };
        if (known?.state === "rejected") return { status: "rejected" };
        // A failed persistence/read-back can leave a durable record even without
        // returning it. Force a strict reload before any later send.
        this.appAdmissionLoaded = false;
        const message = `${error instanceof Error ? error.message : "App admission unavailable."} ${posted || record ? "Original request retained. Acceptance is unconfirmed; use exact status lookup only. No automatic retry occurs." : "Your draft is unchanged; nothing was posted."}`;
        this.appAdmissionSubmissionError = { requestId: clientRequestId, message };
        this.update({ submissionError: message });
      }
      return { status: posted || record ? "unknown" : "blocked" };
    } finally {
      this.appAdmissionSendGuard = false;
      if (auth === this.authEpoch) {
        this.update({ sending: false });
        void this.poll(); this.appAdmissionPolling(true);
      }
    }
  };
}
export const store = new ChatStore(conversationClient);
setWorkerNavigator(id => { void store.openWorkerConversation(id); });

export function useShellState(): State {
  useSyncExternalStore(store.subscribe, store.shellSnapshot);
  return store.snapshot();
}

/** Slice subscription with per-selector equality: rerenders only when the
 * selected value changes identity (or content, via Object.is fallback in the
 * caller). Replaces whole-store useSyncExternalStore for hot components. */
export function useStore<T>(selector: (state: State) => T): T {
  const cache = useRef<{ state: State; selector: (state: State) => T; value: T } | null>(null);
  const snapshot = () => {
    const current = store.snapshot();
    const cached = cache.current;
    if (cached && cached.state === current && cached.selector === selector) return cached.value;
    const value = selector(current);
    cache.current = { state: current, selector, value };
    return value;
  };
  return useSyncExternalStore(store.subscribe, snapshot);
}
