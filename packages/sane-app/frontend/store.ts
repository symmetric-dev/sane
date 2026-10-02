import { useRef, useSyncExternalStore } from "react";
import { ApiError, conversationClient } from "./cc-client";
import { publishWorkers, workersFor, registerWorkerSessions, setWorkerNavigator, workerReference } from "./worker-client";
import { consume, createRun } from "./cc-reducer";
import { transcriptMessages } from "./transcript";
import { contextUsageFor, type ContextUsageSnapshot } from "./context-usage";
import { catalog } from "./catalog";
import { invalidateWorkspaceRequests, onWorkspaceAuthExpired } from "./workspace-store";
import { BASE_PROFILE_IDS, builtinProfiles, canAssign, legacyProfileId, type AgentProfile, type AgentProfileInput, type AgentProfiles } from "../src/agent-profiles-contract";
import { displayProfile, profileDisplayLabel, savedProfileSnapshot, validatedAgentSnapshot, type DisplayProfile, type ProfileSnapshot } from "./profile-presentation";
import type { Availability, Config, Conversation, ConversationClient, Harness, Interaction, InteractionReply, Message, ModelChoice, PendingTurn, Run } from "./types";
import type { ReconciledHistory } from "../src/reconcile";
import type { CompactRequest, CompactState, CompactionRecord } from "../src/oc-contract";
import { compactCommand, compactionsFor } from "./compaction";
import { ConversationCache, cloneRunForConsume, conversationKey } from "./conversation-cache";

/** Composer draft. New conversations pick `profileId` ("" = profiles.defaultId);
 * selected Base conversations may stage `upgradeId` (assistant profile, same harness). */
export type Draft = { text: string; cwd: string; profileId: string; upgradeId: string };
export type SendOutcome = { status: "accepted"; conversationId: string; runId: string } | { status: "blocked" | "rejected" | "unknown" };
export type PendingCompact = { payload: CompactRequest; phase: "sending" | "unconfirmed" | "accepted" | "rejected"; runId?: string };
export type State = {
  phase: "connecting" | "login" | "ready"; config?: Config; conversations: Conversation[];
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
};
const emptyDraft = (): Draft => ({ text: "", cwd: "", profileId: "", upgradeId: "" });
const fallbackProfiles: AgentProfiles = { version: 1, defaultId: BASE_PROFILE_IDS["claude-code"], profiles: builtinProfiles("") };
export class ChatStore {
  private listeners = new Set<() => void>();
  private generation = 0;
  private authEpoch = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private runMap = new Map<string, Run>();
  private conversationCache = new ConversationCache();
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
  private cacheConversation() {
    const conversation = this.state.conversations.find(c => c.id === this.state.selected);
    if (this.state.phase !== "ready" || !this.cacheable || !conversation || this.compactInFlight.has(conversation.id) || conversationKey(conversation) !== this.transcriptKey) return;
    // pendingTurn is presentation only, never recorded transcript evidence.
    this.conversationCache.put(conversation, { runs: this.runMap, messages: this.state.messages, nativeHistory: this.state.nativeHistory, nativeHistoryLoaded: this.nativeHistoryLoaded });
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
    this.update({ connected: false, loading: true, availability: { canSend: false }, compactState: null, contextUsage: null, interactions: [] });
  }
  private clearCachedHistory() {
    this.conversationCache.clear(); this.runMap = new Map();
    this.transcriptKey = ""; this.cacheable = false; this.nativeHistoryLoaded = false;
  }
  private beginAction() {
    const selection = this.selectionEpoch, auth = this.authEpoch, operation = ++this.actionSerial;
    this.update({ actionBusy: true, interactionError: "", actionNotice: "" });
    return () => selection === this.selectionEpoch && auth === this.authEpoch && operation === this.actionSerial;
  }
  state: State = { phase: "connecting", conversations: [], selected: "", runs: [], messages: [], drafts: {}, connected: false, loading: true, sending: false, availability: { canSend: false }, connectionError: "", submissionError: "", authError: "", models: [], modelsLoading: false, modelsError: "", modelsLoaded: false, modelsCwd: "", interactions: [], interactionError: "", actionBusy: false, actionNotice: "", profiles: null, profileError: "", profileBusy: false };
  constructor(private client: ConversationClient) { onWorkspaceAuthExpired(() => this.loginRequired()); }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private update(patch: Partial<State>) {
    let changed = false;
    for (const key of Object.keys(patch) as (keyof State)[]) {
      if (!Object.is(this.state[key], patch[key])) { changed = true; break; }
    }
    if (!changed) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(fn => fn());
  }
  draftKey = (id = this.state.selected) => id || `draft:${catalog.state.navigation.workspaceId}:${catalog.state.navigation.worktreeId}`;
  draft = (id = this.state.selected): Draft => {
    const nav = catalog.state.navigation;
    const worktree = catalog.state.workspaces.find(w => w.workspaceId === nav.workspaceId)?.worktrees.find(w => w.worktreeId === nav.worktreeId);
    return this.state.drafts[this.draftKey(id)] ?? { ...emptyDraft(), cwd: id ? this.state.conversations.find(c => c.id === id)?.cwd ?? "" : worktree?.root ?? "" };
  };
  setDraft = (patch: Partial<Draft>, id = this.state.selected) => {
    this.update({ drafts: { ...this.state.drafts, [this.draftKey(id)]: { ...this.draft(id), ...patch } } });
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
    return snapshot.profileId ?? legacyProfileId(snapshot.harness ?? "claude-code", validatedAgentSnapshot(snapshot)?.agent);
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
    const next = this.profile(id);
    if (this.state.sending || !next || !this.assignable(next).ok) return;
    if (this.state.selected) this.setDraft({ upgradeId: id }); else this.setDraft({ profileId: id }, "");
  };
  clearUpgrade = () => { if (this.state.selected && !this.state.sending) this.setDraft({ upgradeId: "" }); };
  workspace = () => {
    if (this.state.selected) return this.state.conversations.find(c => c.id === this.state.selected)?.cwd ?? "";
    const navigation = catalog.state.navigation;
    return this.draft().cwd.trim() || catalog.state.workspaces.find(w => w.workspaceId === navigation.workspaceId)?.worktrees.find(w => w.worktreeId === navigation.worktreeId)?.root || "";
  };
  capabilities = () => this.state.config?.harnesses?.find(h => h.id === this.harness())?.capabilities;
  compactUnavailable = () => {
    const conversation = this.state.conversations.find(c => c.id === this.state.selected);
    if (!conversation) return "Choose an existing conversation to compact.";
    if (!this.client.compact || !this.client.compactState) return "Context compaction is unavailable on this bridge.";
    if (conversation.worker || workerReference(conversation.id) || this.conversationKind() === "worker") return "Managed worker conversations cannot be compacted here.";
    if (conversation.replacedBy) return "This conversation has been replaced and is read-only.";
    if (conversation.attachment?.state === "pending") return "Complete the native attachment before compacting.";
    if (this.state.loading || this.state.sending || this.state.actionBusy || !this.state.connected) return "Wait for the bridge and current action to settle.";
    if (this.executionUnavailable()) return this.executionUnavailable();
    if (this.state.runs.some(r => r.status === "running" || r.status === "starting")) return "Wait until the current run is idle.";
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
    return Boolean(this.state.compactions?.some(r => r.lifecycle === "unconfirmed") && this.state.compactState?.eligibility.eligible !== true && !this.state.availability.canSend);
  };
  openCompact = (instructions?: string) => {
    if (!this.state.selected) { this.update({ submissionError: "Choose an existing conversation before using /compact." }); return; }
    if (instructions && this.harness() !== "claude-code") { this.update({ submissionError: "OpenCode /compact does not support instructions. Your draft is unchanged." }); return; }
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
    if (!id || !this.client.compactState || this.compactInFlight.has(id)) return false;
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
    if (compactState.nativeHistoryImportedAt && compactState.nativeHistoryImportedAt !== this.state.nativeHistory?.importedAt) { this.nativeHistoryLoaded = false; this.invalidateConversationCache(compactState.sessionId); }
    const conversation = this.state.conversations.find(c => c.id === compactState.sessionId);
    const pending = this.state.pendingCompacts?.[compactState.sessionId];
    const recovered = pending && compactState.operations.find(r => r.requestId === pending.payload.requestId);
    const compactions = conversation ? compactionsFor(conversation, this.state.runs, this.state.nativeHistory, compactState.operations) : [];
    this.update({ compactState, compactError: this.compactReadFeedback(undefined, !!recovered && pending?.phase === "unconfirmed"), compactions, ...(conversation ? { contextUsage: contextUsageFor(conversation.harness, this.state.runs, this.state.models, this.state.nativeHistory, compactions) } : {}), ...(recovered && pending!.phase !== "sending" ? { pendingCompacts: { ...this.state.pendingCompacts, [compactState.sessionId]: { ...pending!, phase: "accepted", runId: recovered.runId } } } : {}) });
  }
  compact = async (nativeStopped = false) => {
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
    if (instructions && !this.state.compactState?.eligibility.supportsInstructions) { this.update({ compactError: "This harness does not support compaction instructions." }); return; }
    const resuming = old?.phase === "unconfirmed";
    if (this.state.compactState?.eligibility.requiresNativeStopped && !nativeStopped && !(resuming && old?.payload.nativeStopped)) { this.update({ compactError: "Confirm external assistant execution is stopped before compacting." }); return; }
    const payload = old?.phase === "unconfirmed" ? old.payload : { requestId: crypto.randomUUID(), ...(instructions ? { instructions } : {}), ...(nativeStopped ? { nativeStopped: true } : {}) };
    const pending: PendingCompact = { payload, phase: "sending" };
    this.compactInFlight.add(id);
    this.invalidateCompactReadiness(id);
    this.update({ pendingCompacts: { ...this.state.pendingCompacts, [id]: pending }, compactError: "", availability: { canSend: false, reason: "Requesting compaction…" } });
    try {
      const response = await this.client.compact(id, payload);
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
  loadModels = async () => {
    const cwd = this.workspace();
    if (this.state.modelsLoading && this.state.modelsCwd === cwd) return;
    const auth = this.authEpoch, request = ++this.modelRequest;
    this.update({ modelsLoading: true, modelsError: "", modelsCwd: cwd, modelsLoaded: false });
    try {
      const models = await this.client.models(cwd);
      if (auth !== this.authEpoch || request !== this.modelRequest) return;
      this.update({ models, modelsLoaded: true, modelsLoading: false, modelsError: models.length ? "" : "OpenCode has no available models." });
    } catch (error) {
      if (auth !== this.authEpoch || request !== this.modelRequest || this.expired(error)) return;
      this.update({ modelsLoading: false, modelsLoaded: false, modelsError: `OpenCode unavailable: ${error instanceof Error ? error.message : "Could not load models."}` });
    }
  };
  /** OpenCode gate: sending waits for the live per-cwd catalog. An empty profile
   * model means the OC native default and is allowed. */
  modelUnavailable = () => {
    if (this.harness() !== "opencode") return false;
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
    if (this.harness() !== "opencode" || this.modelUnavailable()) return "";
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
    if (this.state.actionBusy || !this.state.selected) return;
    const id = this.state.selected, current = this.beginAction();
    try {
      await this.client.reply(id, interactionId, reply);
      if (current()) { this.replied.add(interactionId); this.update({ interactions: this.state.interactions.filter(i => i.id !== interactionId), actionNotice: "Reply sent. Waiting for native state to reconcile." }); }
    } catch (error) {
      if (current() && !this.expired(error)) this.update({ interactionError: `${error instanceof Error ? error.message : "Reply failed."} No automatic retry was made; check the pending request before replying again.` });
    } finally { if (current()) this.update({ actionBusy: false }); }
  };
  cancel = async () => {
    if (this.state.actionBusy || !this.state.selected || !this.capabilities()?.cancelRun) return;
    const id = this.state.selected, current = this.beginAction();
    try {
      const result = await this.client.cancel(id);
      if (current()) this.update({ actionNotice: result.interrupted ? "Interruption requested. Waiting for the run’s terminal state." : "No interruption was reported. Waiting for the run’s current state." });
    } catch (error) {
      if (current() && !this.expired(error)) this.update({ interactionError: `${error instanceof Error ? error.message : "Cancellation unavailable."} Run status will reconcile separately.` });
    } finally { if (current()) this.update({ actionBusy: false }); }
  };
  reconcile = async () => {
    if (this.state.actionBusy || this.compactBlocked() || !this.state.selected || !this.client.reconcile) return;
    const id = this.state.selected, current = this.beginAction();
    try {
      const { history } = await this.client.reconcile(id);
      if (current()) {
        // Invalidate older reads even if reconnect is deferred while hidden.
        this.stop(); this.nativeHistoryLoaded = true;
        this.invalidateConversationCache(id);
        this.update({ nativeHistory: history, messages: transcriptMessages(history, this.state.runs), contextUsage: null, compactState: null, compactions: [], actionNotice: "Conversation history refreshed." });
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
    const current = this.beginAction();
    try {
      await action.call(this.client, id);
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
    }
  };
  private stop() { this.generation++; clearTimeout(this.timer); this.controller?.abort(); }
  private loginRequired() {
    this.stop(); this.authEpoch++; this.clearCachedHistory();
    catalog.invalidate(); invalidateWorkspaceRequests();
    this.replied.clear();
    this.update({ pendingCompacts: {}, compactState: null, compactions: [], compactDialog: "", compactError: "", compactInstructions: {} });
    this.update({ phase: "login", config: undefined, conversations: [], runs: [], messages: [], pendingTurn: null, nativeHistory: null, contextUsage: null, connected: false, loading: false, sending: false, availability: { canSend: false }, connectionError: "", submissionError: "", models: [], modelsLoading: false, modelsLoaded: false, modelsError: "", modelsCwd: "", interactions: [], interactionError: "", actionBusy: false, actionNotice: "", profiles: null, profileError: "", profileBusy: false });
  }
  private expired(error: unknown) { if (error instanceof ApiError && error.status === 401) { this.loginRequired(); return true; } return false; }
  start = () => { if (this.started) return; this.started = true; void this.boot(); };
  reconnect = () => { if (document.hidden || this.state.sending) return; if (this.state.phase === "login") return; this.nativeHistoryLoaded = false; this.stop(); void (this.state.phase === "connecting" ? this.boot() : this.poll()); };
  private async boot() {
    this.stop(); const generation = this.generation, auth = this.authEpoch;
    const controller = this.controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 25000);
    try {
      const config = await this.client.config(controller.signal);
      if (generation !== this.generation || auth !== this.authEpoch) return;
      if (config.authRequired && !config.authenticated) { this.loginRequired(); return; }
      this.update({ config, phase: "ready", authError: "", connectionError: "", ...(config.agentProfiles ? { profiles: config.agentProfiles } : {}) });
      if (!config.agentProfiles) void this.refreshProfiles();
      void this.poll();
    } catch (error) {
      if (generation !== this.generation || auth !== this.authEpoch || this.expired(error)) return;
      this.update({ connectionError: `${error instanceof Error ? error.message : "Connection failed"} Retrying automatically…` });
      this.timer = setTimeout(() => void this.boot(), 5000);
    } finally { clearTimeout(deadline); }
  }
  login = async (password: string) => {
    this.stop(); const auth = ++this.authEpoch;
    this.clearCachedHistory();
    this.update({ authError: "", runs: [], messages: [], pendingTurn: null, nativeHistory: null, contextUsage: null, compactState: null, compactions: [], interactions: [], interactionError: "", actionBusy: false, actionNotice: "", connected: false, availability: { canSend: false } });
    try { await this.client.login(password); if (auth !== this.authEpoch) return; this.update({ phase: "connecting" }); await this.boot(); }
    catch (error) { if (auth === this.authEpoch) this.update({ authError: error instanceof Error ? error.message : "Sign-in failed." }); }
  };
  logout = async () => {
    this.stop(); const auth = ++this.authEpoch;
    // Even an ambiguous logout must not retain authenticated transcript snapshots.
    this.clearCachedHistory(); this.replied.clear();
    this.update({ runs: [], messages: [], pendingTurn: null, nativeHistory: null, contextUsage: null, compactState: null, compactions: [], compactDialog: "", interactions: [], interactionError: "", actionBusy: false, actionNotice: "", connected: false, loading: true, availability: { canSend: false } });
    catalog.invalidate(); invalidateWorkspaceRequests();
    try { await this.client.logout(); if (auth === this.authEpoch) this.loginRequired(); }
    catch (error) { if (auth !== this.authEpoch || this.expired(error)) return; this.update({ submissionError: `Sign-out failed: ${error instanceof Error ? error.message : "connection error"}` }); void this.poll(); }
  };
  openConversation = (id: string) => {
    if (this.state.sending) return;
    const conversation = this.state.conversations.find(c => c.id === id);
    this.choose(id);
    catalog.navigate({ conversationId: id || null, view: "chat", ...(conversation ? { workspaceId: conversation.workspaceId ?? null, worktreeId: conversation.worktreeId ?? null, filePath: null, comparison: null } : {}) });
  };
  choose = (selected: string, pendingTurn: PendingTurn | null = null) => {
    if (this.state.sending) return;
    if (selected === this.state.selected) return;
    this.selectionEpoch++;
    this.stop(); this.cacheConversation();
    const conversation = this.state.conversations.find(c => c.id === selected);
    const cached = conversation ? this.conversationCache.take(conversation) : undefined;
    this.runMap = cached?.runs ?? new Map();
    this.transcriptKey = cached && conversation ? conversationKey(conversation) : "";
    this.cacheable = !!cached && !this.compactInFlight.has(selected);
    this.nativeHistoryLoaded = cached?.nativeHistoryLoaded ?? false;
    this.replied.clear();
    this.update({ compactState: null, compactions: [], compactDialog: "", compactError: "" });
    const runs = [...this.runMap.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const compactions = cached && conversation ? compactionsFor(conversation, runs, cached.nativeHistory).filter(record => record.lifecycle === "completed" || record.lifecycle === "failed" || record.lifecycle === "skipped") : [];
    // Never show the source's turns or actions under a newly selected branch.
    // Same-id sends do not reach here; their transcript remains mounted.
    this.update(selected
      ? { selected, runs, messages: cached?.messages ?? [], compactions, pendingTurn, availability: { canSend: false }, nativeHistory: cached?.nativeHistory ?? null, contextUsage: null, interactions: [], interactionError: "", actionBusy: false, actionNotice: "", loading: true, connected: false, connectionError: "", submissionError: "" }
      : { selected, runs: [], messages: [], pendingTurn, availability: { canSend: false }, nativeHistory: null, contextUsage: null, interactions: [], interactionError: "", actionBusy: false, actionNotice: "", loading: false, connected: false, connectionError: "", submissionError: "" });
    void this.poll();
  };
  private async poll() {
    if (this.state.phase !== "ready") return;
    const generation = this.generation, auth = this.authEpoch, selected = this.state.selected, selection = this.selectionEpoch;
    const controller = this.controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 25000);
    const current = () => generation === this.generation && auth === this.authEpoch && selection === this.selectionEpoch && selected === this.state.selected;
    try {
      const listing = await this.client.conversations(controller.signal);
      if (!current()) return;
      controller.signal.throwIfAborted();
      this.conversationCache.prune(listing.conversations);
      registerWorkerSessions(listing.conversations);
      const currentConversation = listing.conversations.find(c => c.id === selected);
      if (selected && (!currentConversation || this.transcriptKey && this.transcriptKey !== conversationKey(currentConversation))) {
        // A listing can remove or rebind an App id even while its history GET
        // fails. Never keep the old native transcript/actions under that id.
        this.runMap = new Map(); this.transcriptKey = ""; this.cacheable = false; this.nativeHistoryLoaded = false;
        this.replied.clear(); this.selectionEpoch++; this.actionSerial++; this.compactReadSerial++;
        this.stop();
        const pendingCompacts = { ...this.state.pendingCompacts }, compactInstructions = { ...this.state.compactInstructions };
        delete pendingCompacts[selected]; delete compactInstructions[selected];
        this.update({ conversations: listing.conversations, runs: [], messages: [], pendingTurn: null, nativeHistory: null, contextUsage: null, compactState: null, compactions: [], compactDialog: "", compactError: "", pendingCompacts, compactInstructions, interactions: [], interactionError: "", actionBusy: false, actionNotice: "", availability: { canSend: false }, connected: false, loading: !!currentConversation, connectionError: currentConversation ? "" : "Conversation is no longer available. History will reconnect automatically." });
        // Restart with a fresh action/selection fence and the new identity.
        if (currentConversation) void this.poll();
        else this.timer = setTimeout(() => void this.poll(), 5000);
        return;
      }
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
      const conversations = listing.conversations.map(c => {
        if (c.title) return c;
        if (c.id === selected && title?.type === "text") return { ...c, title: title.text };
        const old = this.state.conversations.find(prev => prev.id === c.id)?.title;
        return old ? { ...c, title: old } : c;
      });
      const branchDraft = conversations.find(c => c.id === selected)?.branchDraft;
      const awaitingCompact = this.compactInFlight.has(selected);
      const availability = awaitingCompact ? { canSend: false } : conversations.find(c => c.id === selected)?.availability ?? listing.availability;
      const conversation = conversations.find(c => c.id === selected);
      const models = this.state.modelsLoaded && !this.state.modelsError && this.state.modelsCwd === conversation?.cwd ? this.state.models : [];
      let compactState = this.state.compactState, compactError = this.state.compactError;
      if (selected && this.client.compactState) {
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
        JSON.stringify(prev.conversations) === JSON.stringify(conversations) &&
        JSON.stringify(prev.availability) === JSON.stringify(availability) &&
        JSON.stringify(prev.contextUsage) === JSON.stringify(contextUsage) &&
        JSON.stringify(prev.compactState) === JSON.stringify(compactState) && JSON.stringify(prev.compactions) === JSON.stringify(compactions) && prev.compactError === compactError && prev.pendingCompacts === pendingCompacts &&
        prev.runs.length === runs.length && runs.every((run, index) => prev.runs[index] === run) &&
        JSON.stringify(prev.messages) === JSON.stringify(messages);
      this.runMap = runMap;
      this.transcriptKey = conversation ? conversationKey(conversation) : "";
      this.cacheable = !!conversation && this.nativeHistoryLoaded && !awaitingCompact;
      if (!quiet) this.update({ ...listing, availability, nativeHistory, contextUsage, compactState, compactions, compactError, pendingCompacts, conversations, runs, messages, pendingTurn, connected: !awaitingCompact, loading: awaitingCompact, connectionError: "" });
      if (!current()) return;
      if (branchDraft && !runs.some(run => run.operation !== "compact") && !this.state.drafts[this.draftKey(selected)]) this.setDraft({ text: branchDraft }, selected);
      if (!current()) return;
      if (selected && !awaitingCompact && conversations.find(c => c.id === selected)?.harness === "opencode") {
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
      if (current() && this.state.phase === "ready") this.timer = setTimeout(() => void this.poll(), this.state.connected ? 1500 : 5000);
    }
  }
  send = async (text: string, nativeStopped = false, options: { preserveDraft?: boolean } = {}): Promise<SendOutcome> => {
    if (options.preserveDraft && !this.state.selected) return { status: "blocked" };
    const command = compactCommand(text);
    if (command) { this.openCompact(command.instructions); return { status: "blocked" }; }
    if (this.compactBlocked() || this.state.actionBusy) return { status: "blocked" };
    const conversation = this.state.conversations.find(c => c.id === this.state.selected);
    if (conversation?.attachment && conversation.harness === "claude-code" && !nativeStopped) { this.update({ submissionError: "Confirm external assistant execution is stopped before sending." }); return { status: "blocked" }; }
    if (!text.trim() || this.state.loading || this.state.runs.some(r => r.status === "starting" || r.status === "running") || this.state.sending || !this.state.connected || !this.state.availability.canSend || this.modelUnavailable() || this.executionUnavailable()) return { status: "blocked" };
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
      const result = await this.client.submit({ text, ...(nativeStopped ? { nativeStopped: true } : {}), ...(selected ? { conversationId: selected } : { ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}), workspaceId: navigation.workspaceId!, worktreeId: navigation.worktreeId! }), ...(profileId ? { profileId } : {}) });
      if (generation !== this.generation || auth !== this.authEpoch) return { status: "unknown" };
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

/** Slice subscription with per-selector equality: rerenders only when the
 * selected value changes identity (or content, via Object.is fallback in the
 * caller). Replaces whole-store useSyncExternalStore for hot components. */
export function useStore<T>(selector: (state: State) => T): T {
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const cache = useRef<{ state: State; value: T } | null>(null);
  const snapshot = () => {
    const current = store.snapshot();
    const cached = cache.current;
    if (cached && cached.state === current) return cached.value;
    const value = selectorRef.current(current);
    if (cached && Object.is(cached.value, value)) return cached.value;
    cache.current = { state: current, value };
    return value;
  };
  return useSyncExternalStore(store.subscribe, snapshot);
}
