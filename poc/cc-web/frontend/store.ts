import { ApiError, conversationClient } from "./cc-client";
import { consume, createRun, messagesForRun } from "./cc-reducer";
import { catalog } from "./catalog";
import { invalidateWorkspaceRequests, onWorkspaceAuthExpired } from "./workspace-store";
import type { Availability, Config, Conversation, ConversationClient, Harness, Interaction, InteractionReply, Message, ModelChoice, Run } from "./types";

export type Draft = { text: string; harness: Harness; model: string; effort: string; cwd: string };
export type State = {
  phase: "connecting" | "login" | "ready"; config?: Config; conversations: Conversation[];
  selected: string; runs: Run[]; messages: Message[]; drafts: Record<string, Draft>;
  connected: boolean; loading: boolean; sending: boolean; availability: Availability;
  connectionError: string; submissionError: string; authError: string;
  models: ModelChoice[]; modelsLoading: boolean; modelsError: string; modelsLoaded: boolean;
  modelsCwd: string; interactions: Interaction[]; interactionError: string; actionBusy: boolean; actionNotice: string;
};
const emptyDraft = (): Draft => ({ text: "", harness: "claude-code", model: "", effort: "", cwd: "" });
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
  state: State = { phase: "connecting", conversations: [], selected: "", runs: [], messages: [], drafts: {}, connected: false, loading: true, sending: false, availability: { canSend: false }, connectionError: "", submissionError: "", authError: "", models: [], modelsLoading: false, modelsError: "", modelsLoaded: false, modelsCwd: "", interactions: [], interactionError: "", actionBusy: false, actionNotice: "" };
  constructor(private client: ConversationClient) { onWorkspaceAuthExpired(() => this.loginRequired()); }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private update(patch: Partial<State>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(fn => fn()); }
  draftKey = (id = this.state.selected) => id || `draft:${catalog.state.navigation.workspaceId}:${catalog.state.navigation.worktreeId}`;
  draft = (id = this.state.selected): Draft => {
    const nav = catalog.state.navigation;
    const worktree = catalog.state.workspaces.find(w => w.workspaceId === nav.workspaceId)?.worktrees.find(w => w.worktreeId === nav.worktreeId);
    return this.state.drafts[this.draftKey(id)] ?? { ...emptyDraft(), cwd: id ? this.state.conversations.find(c => c.id === id)?.cwd ?? "" : worktree?.root ?? "" };
  };
  setDraft = (patch: Partial<Draft>, id = this.state.selected) => this.update({ drafts: { ...this.state.drafts, [this.draftKey(id)]: { ...this.draft(id), ...patch } } });
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
  harness = (): Harness => this.state.selected ? this.state.conversations.find(c => c.id === this.state.selected)?.harness ?? "claude-code" : this.draft().harness;
  workspace = () => {
    if (this.state.selected) return this.state.conversations.find(c => c.id === this.state.selected)?.cwd ?? "";
    const navigation = catalog.state.navigation;
    return this.draft().cwd.trim() || catalog.state.workspaces.find(w => w.workspaceId === navigation.workspaceId)?.worktrees.find(w => w.worktreeId === navigation.worktreeId)?.root || "";
  };
  capabilities = () => this.state.config?.harnesses?.find(h => h.id === this.harness())?.capabilities;
  setHarness = (harness: Harness) => {
    if (this.state.selected || this.state.sending) return;
    this.setDraft({ harness, model: "", effort: "" });
    if (harness === "opencode") void this.loadModels();
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
  modelUnavailable = () => this.harness() === "opencode" && (!this.state.modelsLoaded || this.state.modelsCwd !== this.workspace() || Boolean(this.state.modelsError) || !this.state.models.some(m => m.id === this.draft().model && (!this.draft().effort || m.efforts.some(e => e.id === this.draft().effort))));
  reply = async (interactionId: string, reply: InteractionReply) => {
    if (this.state.actionBusy || !this.state.selected) return;
    const id = this.state.selected, auth = this.authEpoch;
    this.update({ actionBusy: true, interactionError: "", actionNotice: "" });
    try {
      await this.client.reply(id, interactionId, reply);
      if (id === this.state.selected && auth === this.authEpoch) { this.replied.add(interactionId); this.update({ interactions: this.state.interactions.filter(i => i.id !== interactionId), actionNotice: "Reply sent. Waiting for native state to reconcile." }); }
    } catch (error) {
      if (id === this.state.selected && auth === this.authEpoch && !this.expired(error)) this.update({ interactionError: `${error instanceof Error ? error.message : "Reply failed."} No automatic retry was made; check the pending request before replying again.` });
    } finally { if (id === this.state.selected && auth === this.authEpoch) this.update({ actionBusy: false }); }
  };
  cancel = async () => {
    if (this.state.actionBusy || !this.state.selected || !this.capabilities()?.cancelRun) return;
    const id = this.state.selected, auth = this.authEpoch;
    this.update({ actionBusy: true, interactionError: "", actionNotice: "" });
    try {
      const result = await this.client.cancel(id);
      if (id === this.state.selected && auth === this.authEpoch) this.update({ actionNotice: result.interrupted ? "Interruption requested. Waiting for the run’s terminal state." : "No interruption was reported. Waiting for the run’s current state." });
    } catch (error) {
      if (id === this.state.selected && auth === this.authEpoch && !this.expired(error)) this.update({ interactionError: `${error instanceof Error ? error.message : "Cancellation unavailable."} Run status will reconcile separately.` });
    } finally { if (id === this.state.selected && auth === this.authEpoch) this.update({ actionBusy: false }); }
  };
  private stop() { this.generation++; clearTimeout(this.timer); this.controller?.abort(); }
  private loginRequired() {
    this.stop(); this.authEpoch++; this.runMap.clear();
    catalog.invalidate(); invalidateWorkspaceRequests();
    this.replied.clear();
    this.update({ phase: "login", config: undefined, conversations: [], runs: [], messages: [], connected: false, loading: false, sending: false, availability: { canSend: false }, connectionError: "", submissionError: "", models: [], modelsLoading: false, modelsLoaded: false, modelsError: "", modelsCwd: "", interactions: [], interactionError: "", actionBusy: false, actionNotice: "" });
  }
  private expired(error: unknown) { if (error instanceof ApiError && error.status === 401) { this.loginRequired(); return true; } return false; }
  start = () => { if (this.started) return; this.started = true; void this.boot(); };
  reconnect = () => { if (document.hidden || this.state.sending) return; if (this.state.phase === "login") return; this.stop(); void (this.state.phase === "connecting" ? this.boot() : this.poll()); };
  private async boot() {
    this.stop(); const generation = this.generation, auth = this.authEpoch;
    const controller = this.controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 25000);
    try {
      const config = await this.client.config(controller.signal);
      if (generation !== this.generation || auth !== this.authEpoch) return;
      if (config.authRequired && !config.authenticated) { this.loginRequired(); return; }
      this.update({ config, phase: "ready", authError: "", connectionError: "" });
      void this.poll();
    } catch (error) {
      if (generation !== this.generation || auth !== this.authEpoch || this.expired(error)) return;
      this.update({ connectionError: `${error instanceof Error ? error.message : "Connection failed"} Retrying automatically…` });
      this.timer = setTimeout(() => void this.boot(), 5000);
    } finally { clearTimeout(deadline); }
  }
  login = async (password: string) => {
    this.stop(); const auth = ++this.authEpoch;
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
  choose = (selected: string) => {
    if (this.state.sending) return;
    this.stop(); this.runMap.clear();
    this.replied.clear();
    this.update({ selected, runs: [], messages: [], interactions: [], interactionError: "", actionBusy: false, actionNotice: "", loading: Boolean(selected), connected: false, connectionError: "", submissionError: "" });
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
      const byId = new Map<string, Message>();
      for (const message of runs.flatMap(messagesForRun)) byId.set(message.id, message);
      const messages = [...byId.values()].sort((a, b) => a.time.localeCompare(b.time));
      const title = messages.find(m => m.role === "user")?.parts.find(p => p.type === "text");
      const conversations = listing.conversations.map(c => ({ ...c, title: c.id === selected && title?.type === "text" ? title.text : this.state.conversations.find(old => old.id === c.id)?.title }));
      this.update({ ...listing, conversations, runs, messages, connected: true, loading: false, connectionError: "" });
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
  send = async (text: string) => {
    if (!text.trim() || this.state.sending || !this.state.connected || !this.state.availability.canSend || this.modelUnavailable() || this.executionUnavailable()) return;
    const selected = this.state.selected, draft = this.draft();
    this.stop(); const generation = this.generation, auth = this.authEpoch;
    // Keep the submitted text until acceptance is known. Never auto-retry POST.
    this.setDraft({ text }, selected);
    this.update({ sending: true, submissionError: "", availability: { canSend: false, reason: "Submitting…" } });
    try {
      const navigation = catalog.state.navigation;
      const result = await this.client.submit({ text, ...(selected ? { conversationId: selected } : { harness: draft.harness, ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}), workspaceId: navigation.workspaceId!, worktreeId: navigation.worktreeId! }), ...(draft.model.trim() ? { model: draft.model.trim() } : {}), ...(draft.effort ? { effort: draft.effort } : {}) });
      if (generation !== this.generation || auth !== this.authEpoch) return;
      if (this.draft(selected).text === text) this.setDraft({ text: "" }, selected);
      if (!selected) {
        this.setDraft({ ...this.draft(selected) }, result.conversationId);
        this.setDraft({ text: "" }, selected);
      }
      this.update({ sending: false });
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
