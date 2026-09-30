import { useRef, useSyncExternalStore } from "react";
import { ApiError, conversationClient } from "./cc-client";
import { publishWorkers, workersFor, registerWorkerSessions, setWorkerNavigator, workerReference } from "./worker-client";
import { consume, createRun } from "./cc-reducer";
import { transcriptMessages } from "./transcript";
import { catalog } from "./catalog";
import { invalidateWorkspaceRequests, onWorkspaceAuthExpired } from "./workspace-store";
import { BASE_PROFILE_IDS, builtinProfiles, canAssign, legacyProfileId, type AgentProfile, type AgentProfileInput, type AgentProfiles } from "../src/agent-profiles-contract";
import type { AssistantAgentId } from "sane-core/agent-catalog";
import type { Availability, Config, Conversation, ConversationClient, Harness, Interaction, InteractionReply, Message, ModelChoice, Run } from "./types";
import type { ReconciledHistory } from "../src/reconcile";

/** Composer draft. New conversations pick `profileId` ("" = profiles.defaultId);
 * selected Base conversations may stage `upgradeId` (assistant profile, same harness). */
export type Draft = { text: string; cwd: string; profileId: string; upgradeId: string };
export type State = {
  phase: "connecting" | "login" | "ready"; config?: Config; conversations: Conversation[];
  selected: string; runs: Run[]; messages: Message[]; drafts: Record<string, Draft>;
  connected: boolean; loading: boolean; sending: boolean; availability: Availability;
  connectionError: string; submissionError: string; authError: string;
  models: ModelChoice[]; modelsLoading: boolean; modelsError: string; modelsLoaded: boolean;
  modelsCwd: string; interactions: Interaction[]; interactionError: string; actionBusy: boolean; actionNotice: string;
  nativeHistory?: ReconciledHistory | null;
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
  private started = false;
  private modelRequest = 0;
  private replied = new Set<string>();
  private nativeHistoryLoaded = false;
  private selectionEpoch = 0;
  private actionSerial = 0;
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
    const conversation = this.state.conversations.find(c => c.id === id);
    return conversation?.profileId || legacyProfileId(conversation?.harness ?? "claude-code", (this.storedDefaults(id).agent || undefined) as AssistantAgentId | undefined);
  };
  /** Listing-only lookup (no run fallback): rows and previews. */
  profileFor = (c: Conversation): AgentProfile | undefined => this.profile(c.profileId || legacyProfileId(c.harness, (c.agent || undefined) as AssistantAgentId | undefined));
  conversationProfile = (id: string): AgentProfile | undefined => this.profile(this.conversationProfileId(id));
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
  effectiveProfile = (): AgentProfile | undefined => this.state.selected ? this.pendingUpgrade() ?? this.conversationProfile(this.state.selected) : this.draftProfile();
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
    // runMap holds only the selected conversation's runs (cleared on choose),
    // so filtering by id is exact at both choose-time (empty) and poll-time.
    const last = [...this.runMap.values()].filter(r => r.conversationId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
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
    if (this.state.actionBusy || !this.state.selected || !this.client.reconcile) return;
    const id = this.state.selected, current = this.beginAction();
    try {
      const { history } = await this.client.reconcile(id);
      if (current()) {
        // Invalidate older reads even if reconnect is deferred while hidden.
        this.stop(); this.nativeHistoryLoaded = true;
        this.update({ nativeHistory: history, actionNotice: "Conversation history refreshed." });
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
    this.stop(); this.authEpoch++; this.runMap.clear();
    this.nativeHistoryLoaded = false;
    catalog.invalidate(); invalidateWorkspaceRequests();
    this.replied.clear();
    this.update({ phase: "login", config: undefined, conversations: [], runs: [], messages: [], nativeHistory: null, connected: false, loading: false, sending: false, availability: { canSend: false }, connectionError: "", submissionError: "", models: [], modelsLoading: false, modelsLoaded: false, modelsError: "", modelsCwd: "", interactions: [], interactionError: "", actionBusy: false, actionNotice: "", profiles: null, profileError: "", profileBusy: false });
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
    this.nativeHistoryLoaded = false;
    this.update({ authError: "" });
    try { await this.client.login(password); if (auth !== this.authEpoch) return; this.update({ phase: "connecting" }); await this.boot(); }
    catch (error) { if (auth === this.authEpoch) this.update({ authError: error instanceof Error ? error.message : "Sign-in failed." }); }
  };
  logout = async () => {
    this.stop(); const auth = ++this.authEpoch;
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
  choose = (selected: string) => {
    if (this.state.sending) return;
    if (selected === this.state.selected) return;
    this.selectionEpoch++;
    this.stop(); this.runMap.clear();
    this.nativeHistoryLoaded = false;
    this.replied.clear();
    // Never show the source's turns or actions under a newly selected branch.
    // Same-id sends do not reach here; their transcript remains mounted.
    this.update(selected
      ? { selected, runs: [], messages: [], availability: { canSend: false }, nativeHistory: null, interactions: [], interactionError: "", actionBusy: false, actionNotice: "", loading: true, connected: false, connectionError: "", submissionError: "" }
      : { selected, runs: [], messages: [], nativeHistory: null, interactions: [], interactionError: "", actionBusy: false, actionNotice: "", loading: false, connected: false, connectionError: "", submissionError: "" });
    void this.poll();
  };
  private async poll() {
    if (this.state.phase !== "ready") return;
    const generation = this.generation, auth = this.authEpoch, selected = this.state.selected;
    const controller = this.controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 25000);
    const current = () => generation === this.generation && auth === this.authEpoch;
    try {
      const listing = await this.client.conversations(controller.signal);
      if (!current()) return;
      registerWorkerSessions(listing.conversations);
      const nativeHistory = selected && this.client.nativeHistory ? this.nativeHistoryLoaded ? this.state.nativeHistory : (await this.client.nativeHistory(selected, controller.signal)).history : null;
      if (selected && this.client.workers) {
        try { const projection = await this.client.workers(selected, controller.signal); if (current()) publishWorkers(selected, projection); }
        catch (error) { if (current()) publishWorkers(selected, { ...workersFor(selected), error: error instanceof Error ? error.message : "Worker status unavailable" }); }
      }
      if (!current()) return;
      if (selected) {
        const metadata = await this.client.runs(selected, controller.signal);
        if (!current()) return;
        const ordered = [...metadata].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        for (const meta of ordered) {
          const conversation = listing.conversations.find(c => c.id === selected);
          meta.harness = conversation?.harness ?? "claude-code";
          meta.nativeSessionId = conversation?.nativeSessionId;
          const run = this.runMap.get(meta.id) ?? createRun(meta);
          const page = await this.client.events(run, controller.signal);
          if (!current()) return;
          Object.assign(run, meta, { status: page.status || meta.status });
          consume(run, page.events ?? []);
          if (Number.isFinite(page.nextCursor)) run.cursor = Math.max(run.cursor, page.nextCursor);
          this.runMap.set(run.id, run);
        }
      }
      const runs = [...this.runMap.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const messages = transcriptMessages(nativeHistory, runs);
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
      this.nativeHistoryLoaded = true;
      const branchDraft = conversations.find(c => c.id === selected)?.branchDraft;
      if (branchDraft && !runs.length && !this.state.drafts[this.draftKey(selected)]) this.setDraft({ text: branchDraft }, selected);
      const availability = conversations.find(c => c.id === selected)?.availability ?? listing.availability;
      // Referential stability: an idle poll produces deep-equal data. Skipping
      // the broadcast keeps whole-store subscribers (App, transcript) from
      // re-rendering every 1.5s; the reschedule in finally still runs.
      const prev = this.state;
      const quiet = prev.connected && !prev.loading && !prev.connectionError &&
        prev.nativeHistory === nativeHistory &&
        JSON.stringify(prev.conversations) === JSON.stringify(conversations) &&
        JSON.stringify(prev.availability) === JSON.stringify(availability) &&
        prev.runs.length === runs.length && runs.every((run, index) => prev.runs[index]?.id === run.id && prev.runs[index]?.status === run.status && prev.runs[index]?.cursor === run.cursor) &&
        JSON.stringify(prev.messages) === JSON.stringify(messages);
      if (!quiet) this.update({ ...listing, availability, nativeHistory, conversations, runs, messages, connected: true, loading: false, connectionError: "" });
      if (selected && conversations.find(c => c.id === selected)?.harness === "opencode") {
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
  send = async (text: string, nativeStopped = false) => {
    const conversation = this.state.conversations.find(c => c.id === this.state.selected);
    if (conversation?.attachment && conversation.harness === "claude-code" && !nativeStopped) { this.update({ submissionError: "Confirm external Claude execution is stopped before sending." }); return; }
    if (!text.trim() || this.state.loading || this.state.runs.some(r => r.status === "starting" || r.status === "running") || this.state.sending || !this.state.connected || !this.state.availability.canSend || this.modelUnavailable() || this.executionUnavailable()) return;
    const selected = this.state.selected, draft = this.draft();
    const upgrade = selected ? this.pendingUpgrade() : undefined;
    const profileId = selected ? upgrade && this.assignable(upgrade).ok ? upgrade.id : "" : this.draftProfile().id;
    this.stop(); const generation = this.generation, auth = this.authEpoch;
    // Keep the submitted text until acceptance is known. Never auto-retry POST.
    this.setDraft({ text }, selected);
    this.update({ sending: true, submissionError: "", availability: { canSend: false, reason: "Submitting…" } });
    try {
      const navigation = catalog.state.navigation;
      const result = await this.client.submit({ text, ...(nativeStopped ? { nativeStopped: true } : {}), ...(selected ? { conversationId: selected } : { ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}), workspaceId: navigation.workspaceId!, worktreeId: navigation.worktreeId! }), ...(profileId ? { profileId } : {}) });
      if (generation !== this.generation || auth !== this.authEpoch) return;
      if (this.draft(selected).text === text) this.setDraft({ text: "" }, selected);
      if (selected && profileId) this.setDraft({ upgradeId: "" }, selected);
      if (!selected) {
        this.setDraft({ ...this.draft(selected), profileId: "", upgradeId: "" }, result.conversationId);
        this.setDraft({ text: "" }, selected);
      }
      this.update({ sending: false });
      if (result.conversationId === selected) {
        // Same-conversation follow-up: keep the mounted transcript and let the
        // next poll merge the new run as a delta. choose() would wipe
        // runs/messages and flash the welcome empty-state.
        void this.poll();
        return;
      }
      this.choose(result.conversationId);
      if (!selected) catalog.navigate({ conversationId: result.conversationId });
    } catch (error) {
      if (generation !== this.generation || auth !== this.authEpoch || this.expired(error)) return;
      const definite = error instanceof ApiError && error.status >= 400 && error.status < 500;
      this.update({ sending: false, submissionError: `${error instanceof Error ? error.message : "Submission failed."} ${definite ? "Your draft is preserved." : "Acceptance is unknown. Check history before sending again; this request will not be retried automatically. Your draft is preserved."}` });
      void this.poll();
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
