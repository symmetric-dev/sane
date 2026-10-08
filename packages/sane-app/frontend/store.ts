import { useRef, useSyncExternalStore } from "react";
import { ApiError, conversationClient } from "./cc-client";
import { publishWorkers, workersFor, registerWorkerSessions, setWorkerNavigator, workerReference } from "./worker-client";
import { consume, createRun } from "./cc-reducer";
import { transcriptMessages } from "./transcript";
import { contextUsageFor, type ContextUsageSnapshot } from "./context-usage";
import { catalog } from "./catalog";
import { clearWorkstreamSelection } from "./workstream-selection-storage";
import { clearWorkstreamMembership } from "./workstream-membership-storage";
import { invalidateWorkspaceRequests, onWorkspaceAuthExpired } from "./workspace-store";
import { BASE_PROFILE_IDS, builtinProfiles, canAssign, legacyProfileId, type AgentProfile, type AgentProfileInput, type AgentProfiles } from "../src/agent-profiles-contract";
import { displayProfile, profileDisplayLabel, savedProfileSnapshot, validatedAgentSnapshot, type DisplayProfile, type ProfileSnapshot } from "./profile-presentation";
import type { Availability, CompletionVerificationRequest, CompletionVerificationTarget, Config, Conversation, ConversationClient, Harness, Interaction, InteractionReply, Message, ModelChoice, PendingTurn, Run } from "./types";
import type { ReconciledHistory } from "../src/reconcile";
import type { CompactRequest, CompactState, CompactionRecord } from "../src/oc-contract";
import { compactCommand, compactionsFor } from "./compaction";
import { ConversationCache, cloneRunForConsume, conversationKey } from "./conversation-cache";
import { ConversationListing } from "./conversation-listing";
import { canonicalCount, equalValue, mergePage, pageMessages, pagedUsage, refreshPages, sameRunMetadata, TranscriptCoverageError, type PagedTranscript, type PageRequest } from "./transcript-pages";
import type { TranscriptMetadataItem, TranscriptPage } from "../src/transcript-contract";
import { capabilitiesFor, getHarnessDescriptor, type HarnessCapabilities } from "../shared/conversation/harness-capabilities";
import { notificationStore } from "./notifications";
import { notificationContextKey } from "./notification-source";
import type { NotificationFeedStatus } from "./notification-presentation";
import { isConversationUpdatePage, type ConversationUpdateFeedRequest } from "../shared/conversation/conversation-updates";
import type { PendingInputOperation, PendingInputView } from "./pending-input-presentation";
import { isPendingInputResumeResult, isPendingInputStatus, isPendingInputView } from "./pending-input-presentation";
import { isPendingInputCapability, isPendingInputRemovalResult, isPendingInputSubmissionResult, type PendingInputRemovalRequest, type PendingInputRequest, type PendingInputResumeRequest } from "../shared/conversation/pending-input-contract";
import { isDefinitePendingInputRefusal, PendingInputApiError } from "./pending-input-client";
import { PendingInputLedger, pendingInputLedgerKey, type PendingInputRecord } from "./pending-input-ledger";

/** Composer draft. New conversations pick `profileId` ("" = profiles.defaultId);
 * selected Base conversations may stage `upgradeId` (assistant profile, same harness). */
export type Draft = { text: string; cwd: string; profileId: string; upgradeId: string };
export type SendOutcome = { status: "accepted"; conversationId: string; runId: string } | { status: "queued"; conversationId: string; requestId: string } | { status: "blocked" | "rejected" | "unknown" };
export type PendingCompact = { payload: CompactRequest; phase: "sending" | "unconfirmed" | "accepted" | "rejected"; runId?: string };
export type State = {
  pendingInputs?: PendingInputView | null; pendingInputLoading?: boolean; pendingInputError?: string;
  pendingInputOperations?: Record<string, PendingInputOperation>;
  phase: "connecting" | "login" | "ready"; config?: Config; conversations: Conversation[]; conversationsReady: boolean;
  selected: string; runs: Run[]; messages: Message[]; drafts: Record<string, Draft>;
  connected: boolean; loading: boolean; sending: boolean; availability: Availability;
  connectionError: string; submissionError: string; authError: string;
  models: ModelChoice[]; modelsLoading: boolean; modelsError: string; modelsLoaded: boolean;
  modelsCwd: string; interactions: Interaction[]; interactionError: string; actionBusy: boolean; actionNotice: string;
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
    try {
      const config = await this.client.config();
      if (fence !== this.pendingInputFence() || namespace !== this.pendingInputKey()) return false;
      if (!config || config.authenticated !== true || !this.pendingInputStoreId(config.storeId)
        || pendingInputLedgerKey(this.pendingInputOrigin(), config.storeId) !== namespace
        || !isPendingInputCapability(config.pendingInputCapability)) throw new Error("The authenticated App store changed or queue support is unavailable. Original operations remain unconfirmed; nothing was redirected.");
      this.pendingInputContextFailure = "";
      return true;
    } catch (cause) {
      if (fence === this.pendingInputFence() && namespace === this.pendingInputKey()) {
        this.invalidatePendingInputContext(namespace, cause instanceof Error ? cause.message : "Fresh App store identification is unavailable. Nothing was sent.");
      }
      return false;
    }
  }
  private invalidatePendingInputContext(namespace: string, error: string) {
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
      || this.state.pendingInputs?.snapshot.conversationId === this.state.selected && this.state.pendingInputs.presentation.chainLocked
      || this.pendingInputSupported() && this.pendingInputFresh !== this.pendingInputFence();
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
    if (this.pendingInputVisible && typeof document !== "undefined" && !document.hidden && Date.now() - this.pendingInputLastRead >= 5000) void this.refreshPendingInputs();
  }
  private async newPendingInputOperation(kind: PendingInputOperation["kind"], text?: string, itemId?: string): Promise<SendOutcome> {
    const id = this.state.selected, fence = this.pendingInputFence(), namespace = this.pendingInputKey(), lock = `${namespace}:${id}`;
    if (!id || !namespace || !isPendingInputCapability(this.state.config?.pendingInputCapability) || this.pendingInputMutations.has(lock)) return { status: "blocked" };
    this.loadPendingInputLedger();
    if (this.pendingInputStorageError || [...this.pendingInputRecords.values()].some(r => r.operation.conversationId === id)) return { status: "blocked" };
    if (kind === "enqueue" && (!text?.trim() || compactCommand(text) || this.draft().upgradeId || this.state.sending || this.state.actionBusy || this.compactBlocked())) {
      this.update({ pendingInputError: compactCommand(text ?? "") ? "Use ordinary /compact; compaction cannot be queued." : this.pendingInputUnavailable() }); return { status: "blocked" };
    }
    const draftKey = this.draftKey(), draftText = this.draft().text, sourceScope = this.pendingInputSource();
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
        if (fresh && current() && o.kind === "enqueue" && record.draftKey === this.draftKey() && record.draftText === (body as PendingInputRequest).text && this.draft().text === record.draftText) this.setDraft({ text: "" });
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
        if (await this.freshPendingInputs(fence) && fence === this.pendingInputFence() && record.draftKey === this.draftKey() && record.draftText === (record.body as PendingInputRequest).text && this.draft().text === record.draftText) this.setDraft({ text: "" });
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
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private runMap = new Map<string, Run>();
  private conversationCache = new ConversationCache();
  private conversationListing = new ConversationListing(signal => this.client.conversations(signal));
  private async listingMutation<T>(run: () => Promise<T>): Promise<T> {
    const auth = this.authEpoch;
    this.conversationListing.invalidate();
    try { return await run(); }
    finally { if (auth === this.authEpoch) this.conversationListing.invalidate(); }
  }
  private transcriptKey = "";
  private cacheable = false;
  private started = false;
  private modelRequest = 0;
  private replied = new Set<string>();
  private nativeHistoryLoaded = false;
  private selectionEpoch = 0;
  private actionSerial = 0;
  private submissionSerial = 0;
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
  private pageRequests = new Set<AbortController>();
  private get paged() { return !!(this.client.transcriptPage && this.client.transcriptMeta && this.client.transcriptRefresh); }
  private cacheConversation() {
    const conversation = this.state.conversations.find(c => c.id === this.state.selected);
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
    this.update({ connected: false, loading: true, availability: { canSend: false }, compactState: null, contextUsage: null, interactions: [] });
  }
  private clearCachedHistory() {
    this.conversationCache.clear(); this.runMap = new Map();
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
      pendingTurn: pending && messages.some(message => message.runId === pending.runId && message.role === "user") ? null : pending });
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
  state: State = { phase: "connecting", conversations: [], conversationsReady: false, selected: "", runs: [], messages: [], drafts: {}, connected: false, loading: true, sending: false, availability: { canSend: false }, connectionError: "", submissionError: "", authError: "", models: [], modelsLoading: false, modelsError: "", modelsLoaded: false, modelsCwd: "", interactions: [], interactionError: "", actionBusy: false, actionNotice: "", profiles: null, profileError: "", profileBusy: false };
  constructor(private client: ConversationClient) {
    this.state = { ...this.state, transcriptPaged: this.paged }; onWorkspaceAuthExpired(() => this.loginRequired());
    if (typeof window !== "undefined") window.addEventListener("storage", event => {
      if (event.key === this.pendingInputKey()) { this.loadPendingInputLedger(); if (this.pendingInputVisible) void this.refreshPendingInputs(); }
    });
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  shellSnapshot = () => this.shellRevision;
  private update(patch: Partial<State>, publishShell = true) {
    // Stabilize lightweight API projections, never serialize or deep-walk the
    // loaded transcript parts or reducer diagnostics on idle polls.
    if (this.paged) for (const key of ["conversations", "availability", "compactState", "compactions", "contextUsage", "interactions", "pendingCompacts"] as const) {
      if (Object.hasOwn(patch, key) && equalValue(this.state[key], patch[key])) (patch as Record<string, unknown>)[key] = this.state[key];
    }
    let changed = false;
    for (const key of Object.keys(patch) as (keyof State)[]) {
      if (!Object.is(this.state[key], patch[key])) { changed = true; break; }
    }
    if (!changed) return;
    this.state = { ...this.state, ...patch };
    if (publishShell) this.shellRevision++;
    this.listeners.forEach(fn => fn());
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
    const textOnly = previous.cwd === next.cwd && previous.profileId === next.profileId && previous.upgradeId === next.upgradeId;
    if (this.state.drafts[key] && textOnly && previous.text === next.text) return;
    this.update({ drafts: { ...this.state.drafts, [key]: next } }, !textOnly);
  };
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
  harness = (): Harness => this.state.selected ? this.state.conversations.find(c => c.id === this.state.selected)?.harness ?? "claude-code" : this.draftProfile().harness;
  profileSet = (): AgentProfiles => this.state.profiles ?? this.state.config?.agentProfiles ?? fallbackProfiles;
  profileList = (): AgentProfile[] => [...this.profileSet().profiles].sort((a, b) => a.order - b.order);
  profile = (id: string | undefined): AgentProfile | undefined => id ? this.profileSet().profiles.find(p => p.id === id) : undefined;
  defaultProfile = (): AgentProfile => { const set = this.profileSet(); return this.profile(set.defaultId) ?? this.profile(BASE_PROFILE_IDS["claude-code"]) ?? fallbackProfiles.profiles[0]!; };
  /** New-conversation profile: the draft pick when still visible, else the default. */
  draftProfile = (): AgentProfile => { const picked = this.profile(this.draft("").profileId); return picked && !picked.hidden && picked.kind !== "worker" ? picked : this.defaultProfile(); };
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
    return savedProfileSnapshot(conversation ?? { harness: "claude-code" }, id === this.state.selected ? this.latestStoredRun(id) : undefined);
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
  assignable = (profile: AgentProfile) => canAssign(this.currentShape(), profile);
  pickProfile = (id: string) => {
    if (this.pendingInputChainLocked()) return;
    const next = this.profile(id);
    if (this.state.sending || !next || !this.assignable(next).ok) return;
    if (this.state.selected) this.setDraft({ upgradeId: id }); else this.setDraft({ profileId: id }, "");
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
    if (this.pendingInputChainLocked()) { this.update({ compactError: "Resolve the existing input chain before compacting." }); return; }
    if (!this.state.selected) { this.update({ submissionError: "Choose an existing conversation before using /compact." }); return; }
    if (!this.supportedCapabilities().compaction) { this.update({ submissionError: "Context compaction is unavailable for this harness. Your draft is unchanged." }); return; }
    if (instructions && !this.supportedCapabilities().compactionInstructions) { this.update({ submissionError: "OpenCode /compact does not support instructions. Your draft is unchanged." }); return; }
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
    if (this.paged) {
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
  loadModels = async (harness: unknown = this.harness()) => {
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
    if (profile?.model) return { model: profile.model, effort: profile.effort };
    const saved = this.state.selected ? this.storedDefaults(this.state.selected) : { model: "", effort: "" };
    return { model: saved.model, effort: saved.effort };
  };
  /** Warn-not-fail: a model absent from the live catalog still sends for native resolution. */
  missingModel = (): string => {
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
    if (this.state.actionBusy || !this.state.selected || !this.client.reply || !(reply.type === "permission" ? capabilities.permissionReplies : reply.type === "question" ? capabilities.questionReplies : false)) return;
    const id = this.state.selected, current = this.beginAction();
    try {
      await this.listingMutation(() => this.client.reply!(id, interactionId, reply));
      if (current()) { this.replied.add(interactionId); this.update({ interactions: this.state.interactions.filter(i => i.id !== interactionId), actionNotice: "Reply sent. Waiting for native state to reconcile." }); }
    } catch (error) {
      if (current() && !this.expired(error)) this.update({ interactionError: `${error instanceof Error ? error.message : "Reply failed."} No automatic retry was made; check the pending request before replying again.` });
    } finally { if (current()) this.update({ actionBusy: false }); }
  };
  cancel = async () => {
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
        if (this.paged) { this.resetPages(); this.update({ messages: [], nativeHistory: null, contextUsage: null, compactState: null, compactions: [], loading: true, connected: false, availability: { canSend: false }, actionNotice: "Conversation history refreshed." }); }
        else this.update({ nativeHistory: history, messages: transcriptMessages(history, this.state.runs), contextUsage: null, compactState: null, compactions: [], actionNotice: "Conversation history refreshed." });
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
    this.generation++; clearTimeout(this.timer); this.controller?.abort();
    this.pageFence++; this.pageRequests.forEach(request => request.abort()); this.pageRequests.clear();
    if (this.paged) this.update({ pageBusy: "", transcriptRefreshing: false });
  }
  private stopNotifications() {
    this.notificationFence++; clearTimeout(this.notificationTimer); this.notificationTimer = undefined;
    this.notificationController?.abort(); this.notificationController = undefined;
    this.notificationScope = ""; this.notificationSources.clear(); this.queuedNotificationReceipts.clear();
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
  private observeNotifications(conversations: Conversation[]) {
    this.notificationSources = new Map(conversations.map(conversation => [conversation.id, this.notificationSource(conversation)]));
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
    notificationStore.observe(conversations);
  }
  private async pollNotifications() {
    const scope = this.notificationScope, fence = this.notificationFence, auth = this.authEpoch;
    if (!scope || this.notificationController || !this.client.conversationUpdates || this.state.phase !== "ready") return;
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
          const acquired = await this.conversationListing.read(AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]));
          if (!current() || acquired.revision !== this.conversationListing.revision) return;
          const data = acquired.value;
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
            if (!await notificationStore.applyPage(page, input.cursor ?? null, bootstrap)) throw new Error("Notification updates could not be saved. The same page will retry.");
            if (!current()) return;
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
      if (current()) this.notificationTimer = setTimeout(() => { this.notificationTimer = undefined; void this.pollNotifications(); }, healthy ? 1500 : 5000);
    }
  }
  private loginRequired() {
    this.clearPendingInputDisplay();
    this.stopNotifications();
    notificationStore.suspend();
    this.stop(); this.authEpoch++; this.conversationListing.invalidate(); this.clearCachedHistory();
    catalog.invalidate(); invalidateWorkspaceRequests();
    clearWorkstreamSelection();
    clearWorkstreamMembership();
    this.replied.clear();
    this.update({ pendingCompacts: {}, compactState: null, compactions: [], compactDialog: "", compactError: "", compactInstructions: {} });
    this.update({ phase: "login", config: undefined, conversations: [], conversationsReady: false, runs: [], messages: [], pendingTurn: null, nativeHistory: null, contextUsage: null, connected: false, loading: false, sending: false, availability: { canSend: false }, connectionError: "", submissionError: "", models: [], modelsLoading: false, modelsLoaded: false, modelsError: "", modelsCwd: "", interactions: [], interactionError: "", actionBusy: false, actionNotice: "", profiles: null, profileError: "", profileBusy: false });
  }
  private expired(error: unknown) { if ((error instanceof ApiError || error instanceof PendingInputApiError) && error.status === 401) { this.loginRequired(); return true; } return false; }
  start = () => { if (this.started) return; this.started = true; void this.boot(); };
  reconnect = () => { this.conversationListing.invalidate(); if (document.hidden || this.state.sending) return; if (this.state.phase === "login") return; this.pendingInputFresh = ""; void this.refreshPendingInputs(); this.nativeHistoryLoaded = false; this.stop(); void (this.state.phase === "connecting" ? this.boot() : this.poll()); };
  private async boot() {
    this.stop(); this.conversationListing.invalidate(); const generation = this.generation, auth = this.authEpoch;
    const controller = this.controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 25000);
    try {
      const config = await this.client.config(controller.signal);
      if (generation !== this.generation || auth !== this.authEpoch) return;
      if (config.authRequired && !config.authenticated) { this.loginRequired(); return; }
      this.pendingInputSuspended = false;
      this.update({ config, phase: "ready", authError: "", connectionError: "", ...(config.agentProfiles ? { profiles: config.agentProfiles } : {}) });
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
    this.clearPendingInputDisplay();
    this.stopNotifications();
    notificationStore.suspend();
    this.stop(); this.conversationListing.invalidate(); const auth = ++this.authEpoch;
    this.clearCachedHistory();
    this.update({ authError: "", conversationsReady: false, runs: [], messages: [], pendingTurn: null, nativeHistory: null, contextUsage: null, compactState: null, compactions: [], interactions: [], interactionError: "", actionBusy: false, actionNotice: "", connected: false, availability: { canSend: false } });
    try { await this.client.login(password); if (auth !== this.authEpoch) return; this.update({ phase: "connecting" }); await this.boot(); }
    catch (error) { if (auth === this.authEpoch) this.update({ authError: error instanceof Error ? error.message : "Sign-in failed." }); }
  };
  logout = async () => {
    this.clearPendingInputDisplay();
    this.stopNotifications();
    notificationStore.suspend();
    this.stop(); this.conversationListing.invalidate(); const auth = ++this.authEpoch;
    // Even an ambiguous logout must not retain authenticated transcript snapshots.
    this.clearCachedHistory(); this.replied.clear();
    this.update({ conversationsReady: false, runs: [], messages: [], pendingTurn: null, nativeHistory: null, contextUsage: null, compactState: null, compactions: [], compactDialog: "", interactions: [], interactionError: "", actionBusy: false, actionNotice: "", connected: false, loading: true, availability: { canSend: false } });
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
    catalog.navigate({ conversationId: id || null, view: "chat", ...(conversation ? { workspaceId: conversation.workspaceId ?? null, worktreeId: conversation.worktreeId ?? null, filePath: null, comparison: null } : {}) });
    const navigation = catalog.snapshot().navigation;
    if (auth !== this.authEpoch || this.state.phase !== "ready" || this.state.config !== config || this.state.selected !== id
      || navigation.view !== "chat" || navigation.conversationId !== (id || null)
      || source !== identity(this.state.conversations.find(c => c.id === id))) return false;
    if (capture) notificationStore.acknowledgeCaptured(capture);
    return true;
  };
  choose = (selected: string, pendingTurn: PendingTurn | null = null) => {
    if (this.state.sending) return;
    if (selected === this.state.selected) return;
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
      ? { selected, runs, messages: cached?.messages ?? [], compactions, pendingTurn, availability: { canSend: false }, nativeHistory: cached?.nativeHistory ?? null, contextUsage: null, interactions: [], interactionError: "", actionBusy: false, actionNotice: "", loading: true, connected: false, connectionError: "", submissionError: "" }
       : { selected, runs: [], messages: [], pendingTurn, availability: { canSend: false }, nativeHistory: null, contextUsage: null, interactions: [], interactionError: "", actionBusy: false, actionNotice: "", loading: false, connected: false, connectionError: "", submissionError: "" });
    this.pendingInputFresh = ""; this.loadPendingInputLedger();
    this.update({ pendingInputs: this.pendingInputViews.get(selected) ?? null, pendingInputLoading: false, pendingInputError: "" }); this.publishPendingInputOperations();
    if (this.pendingInputVisible && !document.hidden) void this.refreshPendingInputs();
    if (this.paged) this.update({ transcript: cached?.transcript ?? null, transcriptInitialLoading: !!selected && !cached?.messages.length, transcriptError: "", metadataError: "", pageBusy: "", pageErrors: {}, workerLoading: !!selected && !!this.client.workers, compactions: cached?.transcript?.compactions ?? [] });
    void this.poll();
  };
  private async pollPaged(listing: { conversations: Conversation[]; availability: Availability }, current: () => boolean, signal: AbortSignal) {
    const id = this.state.selected, conversation = listing.conversations.find(item => item.id === id);
    const awaitingCompact = this.compactInFlight.has(id);
    this.update({ conversations: listing.conversations, availability: awaitingCompact ? { canSend: false } : conversation?.availability ?? listing.availability });
    if (!id) { this.update({ connected: true, loading: false, connectionError: "", transcriptInitialLoading: false }); return; }
    this.update({ transcriptRefreshing: !this.pageValidated || !!this.state.transcriptError });
    let opened!: () => void;
    const initialPage = new Promise<void>(resolve => { opened = resolve; });
    const historyRead = (async () => {
      try {
        const readFence = this.pageFence, readSerial = this.publicationSerial;
        const latest = await this.client.transcriptPage!(id, {}, signal);
        if (!current() || readFence !== this.pageFence) return;
        signal.throwIfAborted();
        const reopen = !this.pageValidated || this.state.transcript?.summary.epoch !== latest.epoch;
        this.acceptPage(latest, undefined, true, undefined, readSerial);
        this.pageValidated = true; this.transcriptKey = conversation ? conversationKey(conversation) : "";
        // Render latest first. ALL loaded-island refreshes can then continue
        // independently of live-status/eligibility readiness.
        this.update({ transcriptError: "", transcriptRefreshing: false }); opened();
        const pending = this.state.pendingTurn;
        if (pending?.runId && !pageMessages(this.state.transcript).some(message => message.runId === pending.runId && message.role === "user")) {
          try {
            const submittedFence = this.pageFence, submittedSerial = this.publicationSerial;
            const submitted = await this.client.transcriptPage!(id, { targetRunId: pending.runId }, signal);
            if (!current() || submittedFence !== this.pageFence) return;
            this.acceptPage({ ...submitted, target: undefined }, undefined, false, undefined, submittedSerial);
          } catch (error) { if (!current() || this.expired(error)) return; if (!(error instanceof ApiError && error.status === 404)) throw error; }
        }
        if (reopen || this.refreshedRevision !== latest.revision) {
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
      } finally { opened(); if (current()) this.update({ transcriptRefreshing: false }); }
    })();
    await initialPage;
    if (!current()) return;
    // Listing + ALL lightweight run summaries, not the displayed history window,
    // are the active-run authority. No per-run event cursor is seeded here.
    const metadata = async () => {
      try {
        let items: TranscriptMetadataItem[] = [], revision = "";
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            let cursor: string | undefined; items = [];
            do {
              const readFence = this.pageFence;
              const page = await this.client.transcriptMeta!(id, cursor, signal);
              if (!current()) return false;
              signal.throwIfAborted();
              if (readFence !== this.pageFence) throw new ApiError("Transcript changed while reading metadata.", 409, "transcript-reset");
              if (page.sessionId !== id) throw new Error("Run metadata session identity mismatch.");
              if (this.state.transcript && page.epoch !== this.state.transcript.summary.epoch) { this.resetPages(); this.update({ messages: [] }); }
              if (!cursor) revision = page.metadataRevision;
              else if (revision !== page.metadataRevision) throw new ApiError("Metadata changed; retrying traversal.", 409, "transcript-reset");
              if (!cursor && this.state.transcript?.metadataRevision === revision && !this.state.metadataError) return true;
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
        if (transcript) this.update({ transcript: { ...transcript, metadataRevision: revision, compactions } });
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
      if (!this.workerReady) this.update({ workerLoading: true });
      try { const projection = await this.client.workers(id, signal); if (current()) publishWorkers(id, projection); }
      catch (error) { if (current() && !this.expired(error)) publishWorkers(id, { ...workersFor(id), error: error instanceof Error ? error.message : "Worker status unavailable" }); }
      finally { if (current()) { this.workerReady = true; this.update({ workerLoading: false }); } }
    };
    const eligibilityRead = eligibility(), workerRead = workers();
    const metadataReady = await metadata();
    if (!current()) return;
    signal.throwIfAborted();
    // Merge lifecycle detail after parallel reads; metadata never overwrites an
    // eligibility response just because it happened to finish later.
    if (this.state.compactState) this.applyCompactState(this.state.compactState);
    const ready = metadataReady && !awaitingCompact;
    this.update({ connected: ready, loading: awaitingCompact, connectionError: ready ? "" : this.state.metadataError ?? "", ...(ready ? {} : { availability: { canSend: false } }) });
    const branchDraft = conversation?.branchDraft;
    if (branchDraft && !this.state.runs.some(run => run.operation !== "compact") && !this.state.drafts[this.draftKey(id)]) this.setDraft({ text: branchDraft }, id);
    if (this.supportedCapabilities(conversation?.harness).listInteractions && this.client.interactions && ready) {
      try { const interactions = await this.client.interactions(id, signal); if (current()) this.update({ interactions: interactions.filter(item => !this.replied.has(item.id)), ...(this.state.interactionError.startsWith("Pending requests unavailable:") ? { interactionError: "" } : {}) }); }
      catch (error) { if (current() && !this.expired(error)) this.update({ interactionError: `Pending requests unavailable: ${error instanceof Error ? error.message : "connection error"}` }); }
    }
    await Promise.all([historyRead, eligibilityRead, workerRead]);
  }
  private async poll() {
    if (this.state.phase !== "ready") return;
    this.pendingInputPolling();
    const generation = this.generation, auth = this.authEpoch, selected = this.state.selected, selection = this.selectionEpoch;
    const controller = this.controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 25000);
    const lifecycleCurrent = () => generation === this.generation && auth === this.authEpoch && selection === this.selectionEpoch && selected === this.state.selected;
    let listingRevision: number | undefined;
    const current = () => lifecycleCurrent() && (listingRevision === undefined || listingRevision === this.conversationListing.revision);
    try {
      const acquired = await this.conversationListing.read(controller.signal);
      listingRevision = acquired.revision;
      const listing = acquired.value;
      if (!current()) return;
      controller.signal.throwIfAborted();
      if (!this.notificationScope && !(this.state.config?.conversationUpdates === true && this.client.conversationUpdates)) this.observeNotifications(listing.conversations);
      if (!current()) return;
      this.conversationCache.prune(listing.conversations);
      registerWorkerSessions(listing.conversations);
      const currentConversation = listing.conversations.find(c => c.id === selected);
      if (selected && (!currentConversation || this.transcriptKey && this.transcriptKey !== conversationKey(currentConversation))) {
        // A listing can remove or rebind an App id even while its history GET
        // fails. Never keep the old native transcript/actions under that id.
        this.runMap = new Map(); this.transcriptKey = ""; this.cacheable = false; this.nativeHistoryLoaded = false; this.workerReady = false;
        if (this.paged) this.resetPages();
        this.replied.clear(); this.selectionEpoch++; this.actionSerial++; this.compactReadSerial++;
        this.stop();
        const pendingCompacts = { ...this.state.pendingCompacts }, compactInstructions = { ...this.state.compactInstructions };
        delete pendingCompacts[selected]; delete compactInstructions[selected];
        this.update({ conversations: listing.conversations, conversationsReady: true, runs: [], messages: [], pendingTurn: null, nativeHistory: null, contextUsage: null, compactState: null, compactions: [], compactDialog: "", compactError: "", pendingCompacts, compactInstructions, interactions: [], interactionError: "", actionBusy: false, actionNotice: "", availability: { canSend: false }, connected: false, loading: !!currentConversation, connectionError: currentConversation ? "" : "Conversation is no longer available. History will reconnect automatically." });
        // Restart with a fresh action/selection fence and the new identity.
        if (currentConversation) void this.poll();
        else this.timer = setTimeout(() => void this.poll(), 5000);
        return;
      }
      const conversations = listing.conversations.map(conversation => {
        const title = this.state.conversations.find(previous => previous.id === conversation.id)?.title;
        return !conversation.title && title ? { ...conversation, title } : conversation;
      });
      this.update({ conversations: equalValue(this.state.conversations, conversations) ? this.state.conversations : conversations, conversationsReady: true });
      if (!current()) return;
      if (this.paged) { await this.pollPaged(listing, current, controller.signal); return; }
      // Safe GET also notices reconciliation by another view/client. Reuse the
      // snapshot identity when the backend refresh timestamp has not changed.
      const historyRead = selected && this.client.nativeHistory ? (await this.client.nativeHistory(selected, controller.signal)).history : null;
      if (!current()) return;
      controller.signal.throwIfAborted();
      if (historyRead && (historyRead.sessionId !== selected || historyRead.nativeSessionId !== (currentConversation?.nativeSessionId ?? selected))) throw new Error("Native history identity changed. Waiting for the conversation listing to refresh.");
      if (historyRead?.importedAt !== this.state.nativeHistory?.importedAt) this.invalidateConversationCache(selected);
      const nativeHistory = this.nativeHistoryLoaded && historyRead?.importedAt === this.state.nativeHistory?.importedAt ? this.state.nativeHistory : historyRead;
      if (selected && this.client.workers) {
        try { const projection = await this.client.workers(selected, controller.signal); if (current()) publishWorkers(selected, projection); }
        catch (error) { if (!current() || this.expired(error)) return; publishWorkers(selected, { ...workersFor(selected), error: error instanceof Error ? error.message : "Worker status unavailable" }); }
      }
      if (!current()) return;
      controller.signal.throwIfAborted();
      // Only commit reducer state alongside the transcript at the end. Failed
      // or aborted reads must not advance published cursors, buffers, or Sets.
      const runMap = new Map<string, Run>();
      if (selected) {
        const metadata = await this.client.runs(selected, controller.signal);
        if (!current()) return;
        controller.signal.throwIfAborted();
        const ordered = [...metadata].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        for (const meta of ordered) {
          if (meta.conversationId !== selected) throw new Error("Run identity does not match the selected conversation.");
          meta.harness = currentConversation?.harness ?? "claude-code";
          meta.nativeSessionId = currentConversation?.nativeSessionId;
          const previous = this.runMap.get(meta.id);
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
      const runs = [...runMap.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const messages = transcriptMessages(nativeHistory, runs);
      const pending = this.state.pendingTurn;
      const pendingTurn = pending && messages.some(message => message.runId === pending.runId && message.role === "user") ? null : pending;
      const title = messages.find(m => m.role === "user")?.parts.find(p => p.type === "text");
      // Backend titles win (persisted first prompt or handoff `<Role> #<n>`).
      // Otherwise the open conversation derives from its transcript and other
      // rows keep their previous derived value until the backend backfills.
      const titledConversations = listing.conversations.map(c => {
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
      if (selected && this.supportedCapabilities(conversation?.harness).compaction && this.client.compactState) {
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
    } catch (error) {
      if (!current() || this.expired(error)) return;
      this.update({ connected: false, loading: false, connectionError: `${error instanceof Error ? error.message : "Connection lost."} History will reconnect automatically.` });
    } finally {
      clearTimeout(deadline);
      if (lifecycleCurrent() && this.state.phase === "ready") this.timer = setTimeout(() => void this.poll(), this.state.connected ? 1500 : 5000);
    }
  }
  canQueueInput = (state: State = this.state): boolean => {
    if (isPendingInputCapability(state.config?.pendingInputCapability)) return false;
    const conversation = state.conversations.find(c => c.id === state.selected);
    // Native continuation is not an App-owned run. Its queue gets a fresh exact
    // command admission; it must never borrow the previous completed run ID.
    if (conversation?.harness === "opencode" && conversation.nativeActivity === "active"
      && state.availability.canSend && state.availability.nativeQueue === true && conversation.availability?.nativeQueue === true
      && !state.runs.some(run => run.status === "running" || run.status === "starting")) return true;
    const after = state.availability.queueAfterRunId;
    // An old backend, another conversation's availability, or stale ownership
    // cannot opt into mid-run input. This is a receipt-bound CC queue, not steering.
    return !!after && state.availability.canSend && conversation?.harness === "claude-code"
      && conversation.lastRunId === after && conversation.availability?.queueAfterRunId === after
      && state.runs.some(run => run.id === after && run.conversationId === conversation.id && run.status === "running");
  };
  send = async (text: string, nativeStopped = false, options: { preserveDraft?: boolean } = {}): Promise<SendOutcome> => {
    const pendingFence = this.pendingInputFence();
    if (this.pendingInputSupported() && this.state.selected && this.pendingInputFresh !== pendingFence && (!await this.refreshPendingInputs() || pendingFence !== this.pendingInputFence())) return { status: "blocked" };
    if (this.pendingInputChainLocked()) { this.update({ submissionError: "Resolve the existing input chain before sending ordinary input." }); return { status: "blocked" }; }
    if (this.pendingInputSupported() && (this.state.availability.queueAfterRunId || this.state.availability.nativeQueue)) { this.update({ submissionError: "Use the explicit App-owned queue for a future input." }); return { status: "blocked" }; }
    if (options.preserveDraft && !this.state.selected) return { status: "blocked" };
    const command = compactCommand(text);
    if (command) { this.openCompact(command.instructions); return { status: "blocked" }; }
    if (this.compactBlocked() || this.state.actionBusy) return { status: "blocked" };
    const conversation = this.state.conversations.find(c => c.id === this.state.selected);
    if (!this.supportedCapabilities().prompt) return { status: "blocked" };
    if (conversation?.attachment && this.supportedCapabilities(conversation.harness).attachedSendRequiresNativeStopped && !nativeStopped) { this.update({ submissionError: "Confirm external assistant execution is stopped before sending." }); return { status: "blocked" }; }
    const running = conversation?.status === "starting" || conversation?.status === "running" || this.state.runs.some(r => r.status === "starting" || r.status === "running");
    if (!text.trim() || this.state.loading || running && !this.canQueueInput() || this.state.sending || !this.state.connected || !this.state.availability.canSend || this.modelUnavailable() || this.executionUnavailable()) return { status: "blocked" };
    const selected = this.state.selected, draft = this.draft(), draftKey = this.draftKey();
    // Flow submissions are independent of the ordinary chat draft and any
    // staged agent upgrade. They never consume or replace that draft.
    const preserveDraft = !!options.preserveDraft;
    const pendingTurn: PendingTurn = { id: `pending:${++this.submissionSerial}`, conversationId: selected, text, time: new Date().toISOString() };
    const upgrade = selected && !preserveDraft ? this.pendingUpgrade() : undefined;
    const profileId = selected ? upgrade && this.assignable(upgrade).ok ? upgrade.id : "" : this.draftProfile().id;
    this.stop(); const generation = this.generation, auth = this.authEpoch;
    // Move text into a local bubble immediately; retain it here for failure recovery.
    // This is presentation, not acceptance evidence. Never auto-retry POST.
    this.update({ ...(!preserveDraft ? { drafts: { ...this.state.drafts, [draftKey]: { ...draft, text: "" } } } : {}), pendingTurn, sending: true, submissionError: "", availability: { canSend: false, reason: "Submitting…" } });
    try {
      const navigation = catalog.state.navigation;
      const result = await this.listingMutation(() => this.client.submit({ text, ...(nativeStopped ? { nativeStopped: true } : {}), ...(selected ? { conversationId: selected } : { ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}), workspaceId: navigation.workspaceId!, worktreeId: navigation.worktreeId! }), ...(profileId ? { profileId } : {}) }));
      if (generation !== this.generation || auth !== this.authEpoch) return { status: "unknown" };
      if (result.queued) {
        const receipts = this.queuedNotificationReceipts.get(result.conversationId) ?? new Set<string>();
        receipts.add(result.receipt.requestId); this.queuedNotificationReceipts.set(result.conversationId, receipts);
        // Replace the Sending bubble with the durable receipt, not the old run
        // ID. Listing reloads/selection changes reconstruct it from the journal.
        this.update({ sending: false, pendingTurn: null, conversations: this.state.conversations.map(c => c.id !== result.conversationId ? c : { ...c, queuedFollowups: [...(c.queuedFollowups ?? []).filter(r => r.requestId !== result.receipt.requestId), result.receipt], availability: { canSend: false } }), availability: { canSend: false } });
        if (selected && profileId) this.setDraft({ upgradeId: "" }, selected);
        void this.poll();
        return { status: "queued", conversationId: result.conversationId, requestId: result.receipt.requestId };
      }
      // A successful prompt receipt is trusted run evidence for both existing
      // and new conversations. The notification store binds it to the actual
      // native identity from a subsequent listing, never a placeholder.
      notificationStore.acceptRun(result.conversationId, result.runId);
      if (selected && profileId) this.setDraft({ upgradeId: "" }, selected);
      if (!selected) {
        const nextDraft = this.state.drafts[draftKey] ?? { ...draft, text: "" };
        this.update({ drafts: { ...this.state.drafts, [result.conversationId]: { ...nextDraft, profileId: "", upgradeId: "" }, [draftKey]: { ...nextDraft, text: "" } } });
      }
      const acceptedTurn = { ...pendingTurn, conversationId: result.conversationId, runId: result.runId };
      // Keep the local bubble in the old selection until choose switches both
      // identities together. There must be no empty/welcome frame in between.
      this.update({ sending: false, pendingTurn: result.conversationId === selected ? acceptedTurn : pendingTurn });
      if (result.conversationId === selected) {
        // Same-conversation follow-up: keep the mounted transcript and let the
        // next poll merge the new run as a delta. choose() would wipe
        // runs/messages and flash the welcome empty-state.
        void this.poll();
        return { status: "accepted", conversationId: result.conversationId, runId: result.runId };
      }
      this.choose(result.conversationId, acceptedTurn);
      if (!selected) catalog.navigate({ conversationId: result.conversationId });
      return { status: "accepted", conversationId: result.conversationId, runId: result.runId };
    } catch (error) {
      if (generation !== this.generation || auth !== this.authEpoch) return { status: "unknown" };
      const definite = error instanceof ApiError && error.status >= 400 && error.status < 500;
      // Do not overwrite a new draft typed while this submission was in flight.
      const currentDraft = this.state.drafts[draftKey] ?? draft;
      const restored = !preserveDraft && !currentDraft.text;
      if (error instanceof ApiError && error.status === 401) {
        if (restored) this.update({ drafts: { ...this.state.drafts, [draftKey]: { ...currentDraft, text } } });
        this.expired(error);
        return { status: "rejected" };
      }
      this.update({ sending: false, pendingTurn: null, ...(restored ? { drafts: { ...this.state.drafts, [draftKey]: { ...currentDraft, text } } } : {}), submissionError: `${error instanceof Error ? error.message : "Submission failed."} ${definite ? "" : "Acceptance is unknown. Check history before sending again; this request will not be retried automatically. "}${preserveDraft ? "Your chat draft and review feedback are preserved." : restored ? "Your draft is restored." : `Your new draft is preserved. Submitted message: ${text}`}` });
      void this.poll();
      return { status: definite ? "rejected" : "unknown" };
    }
  };
}
export const store = new ChatStore(conversationClient);
setWorkerNavigator(store.openConversation);

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
