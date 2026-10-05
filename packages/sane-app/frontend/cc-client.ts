import type { ConversationClient, RunMetadata, RunStatus } from "./types";
import { isConversationUpdateFeedRequest, isConversationUpdatePage } from "../shared/conversation/conversation-updates";
import { nativeNotificationSource } from "./notification-source";
import { SESSION_REFRESH_ERROR } from "./notification-presentation";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}
export async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
    signal: init.signal ?? AbortSignal.timeout(25000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(body.error || `Request failed (${response.status}).`, response.status, body.code ?? body.reason);
  return body;
}
const transcriptSignal = (signal?: AbortSignal) => signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : undefined;
export const conversationClient: ConversationClient = {
  async conversationUpdates(input = {}, signal, bootstrap = false) {
    if (!isConversationUpdateFeedRequest(input) || bootstrap && (input.cursor || input.through !== undefined)) throw new Error("Invalid conversation update request.");
    const params = new URLSearchParams({ limit: String(input.limit ?? 100) });
    if (input.cursor) { params.set("epoch", input.cursor.epoch); params.set("after", String(input.cursor.after)); }
    if (input.through !== undefined) params.set("through", String(input.through));
    const page = await request(`/api/conversation-updates${bootstrap ? "/bootstrap" : ""}?${params}`, { signal: transcriptSignal(signal) });
    if (!isConversationUpdatePage(page, { epoch: input.cursor?.epoch, cursor: input.cursor, through: input.through, limit: input.limit ?? 100 })
      || bootstrap !== !!page.bootstrap) throw new Error("Invalid conversation update page.");
    return page;
  },
  transcriptPage: (id, query = {}, signal) => request(`/api/sessions/${encodeURIComponent(id)}/transcript?${new URLSearchParams({ limit: "100", ...query })}`, { signal: transcriptSignal(signal) }),
  transcriptMeta: (id, cursor, signal) => request(`/api/sessions/${encodeURIComponent(id)}/transcript/meta?${new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : {}) })}`, { signal: transcriptSignal(signal) }),
  transcriptRefresh: (id, input, signal) => request(`/api/sessions/${encodeURIComponent(id)}/transcript/refresh`, { method: "POST", body: JSON.stringify(input), signal: transcriptSignal(signal) }),
  config: (signal) => request("/api/config", { signal }),
  login: (password) => request("/api/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => request("/api/logout", { method: "POST" }),
  async conversations(signal) {
    const data = await request("/api/sessions", { signal });
    if (!Array.isArray(data?.sessions) || data.sessions.some((session: any) => !session || typeof session.sessionId !== "string" || !session.sessionId)) throw new Error(SESSION_REFRESH_ERROR, { cause: new Error("Invalid conversation listing.") });
    const conversations = data.sessions.map((s: any) => ({ id: s.sessionId, harness: s.harness ?? "claude-code", authorityId: s.authorityId, nativeSessionId: s.nativeSessionId, ...(s.updateSource !== undefined ? { updateSource: s.updateSource } : {}), nativeActivity: s.nativeActivity, nativeActivityReason: s.nativeActivityReason, updatedAt: s.updatedAt, cwd: s.cwd, lastRunId: s.lastRunId, lastRunStatus: s.lastRunStatus, lastRunOperation: s.lastRunOperation, lastRunEndedAt: s.lastRunEndedAt, status: s.lastStatus as RunStatus, title: s.title, hidden: s.hidden, model: s.model, effort: s.effort, agent: s.agent, agentKind: s.agentKind, nativeAgentSelected: s.nativeAgentSelected, profileId: s.profileId, workspaceId: s.workspaceId, worktreeId: s.worktreeId, association: s.association, associationReason: s.associationReason, availability: s.availability, queuedFollowups: s.queuedFollowups, attachment: s.attachment, worker: s.worker, directWorkerCount: s.directWorkerCount, branchOrigin: s.branchOrigin, branchDraft: s.branchDraft, replacedBy: s.replacedBy }));
    if (conversations.some((c: any) => c.updateSource !== undefined && !nativeNotificationSource(c))) throw new Error(SESSION_REFRESH_ERROR, { cause: new Error("Invalid conversation update source in listing.") });
    return { conversations,
      availability: data.availability ?? { canSend: false, reason: "Waiting for bridge availability." } };
  },
  async runs(id, signal): Promise<RunMetadata[]> {
    const data = await request(`/api/sessions/${encodeURIComponent(id)}/runs`, { signal });
    return (data.runs ?? []).map((r: any) => ({ id: r.runId, conversationId: r.sessionId, harness: r.harness ?? "claude-code", nativeSessionId: r.nativeSessionId, nativeCommandId: r.nativeCommandId, nativeDelivery: r.nativeDelivery, operation: r.operation, compact: r.compact, cwd: r.cwd, status: r.status, createdAt: r.createdAt, endedAt: r.endedAt, model: r.model, effort: r.effort, agent: r.agent, agentKind: r.agentKind, nativeAgentSelected: r.nativeAgentSelected, profileId: r.profileId, saneContextVersion: r.saneContextVersion }));
  },
  events: (run, signal) => request(`/api/runs/${encodeURIComponent(run.id)}/events?after=${run.cursor}`, { signal }),
  workers: (id, signal) => request(`/api/sessions/${encodeURIComponent(id)}/workers`, { signal }),
  async models(cwd, signal) {
    const data = await request(`/api/harnesses/opencode/models?cwd=${encodeURIComponent(cwd)}`, { signal });
    return data.models ?? [];
  },
  async interactions(id, signal) { return (await request(`/api/sessions/${encodeURIComponent(id)}/interactions`, { signal })).interactions ?? []; },
  reply: (id, interactionId, reply) => request(`/api/sessions/${encodeURIComponent(id)}/interactions/${encodeURIComponent(interactionId)}/reply`, { method: "POST", body: JSON.stringify(reply) }),
  cancel: id => request(`/api/sessions/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" }),
  compactState: (id, signal) => request(`/api/sessions/${encodeURIComponent(id)}/compact`, { signal }),
  compact: (id, input) => request(`/api/sessions/${encodeURIComponent(id)}/compact`, { method: "POST", body: JSON.stringify(input) }),
  hide: id => request(`/api/sessions/${encodeURIComponent(id)}/hide`, { method: "POST", body: "{}" }),
  unhide: id => request(`/api/sessions/${encodeURIComponent(id)}/unhide`, { method: "POST", body: "{}" }),
  search: async (query, opts) => {
    const params = new URLSearchParams({ q: query });
    if (opts?.workspaceId && opts.workspaceId !== "all" && opts.workspaceId !== "unavailable") params.set("workspaceId", opts.workspaceId);
    if (opts?.worktreeId && opts.worktreeId !== "all") params.set("worktreeId", opts.worktreeId);
    if (opts?.limit) params.set("limit", String(opts.limit));
    const data = await request(`/api/sessions/search?${params.toString()}`, { signal: opts?.signal });
    return { results: data.results ?? [] };
  },
  reconcile: id => request(`/api/sessions/${encodeURIComponent(id)}/reconcile`, { method: "POST", body: "{}" }),
  nativeHistory: (id, signal) => request(`/api/sessions/${encodeURIComponent(id)}/native-history`, { signal }),
  agents: signal => request("/api/agents", { signal }),
  createAgent: (fromId, input = {}) => request("/api/agents", { method: "POST", body: JSON.stringify({ ...input, fromId }) }),
  updateAgent: (id, input) => request(`/api/agents/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteAgent: id => request(`/api/agents/${encodeURIComponent(id)}`, { method: "DELETE" }),
  resetAgent: id => request(`/api/agents/${encodeURIComponent(id)}/reset`, { method: "POST", body: "{}" }),
  orderAgents: input => request("/api/agents/order", { method: "PUT", body: JSON.stringify(input) }),
  async submit({ text, conversationId, ...options }) {
    const data = await request("/api/sessions", { method: "POST", body: JSON.stringify({ prompt: text, ...(conversationId ? { sessionId: conversationId } : {}), ...options }) });
    if (data.queued === true) {
      if (data.sessionId !== conversationId || !data.receipt || typeof data.receipt.requestId !== "string" || data.receipt.sessionId !== conversationId || data.receipt.prompt !== text) throw new Error("Invalid queue acknowledgement; check conversation history before retrying");
      return { conversationId: data.sessionId, queued: true, receipt: data.receipt };
    }
    if (typeof data.runId !== "string") throw new Error("Invalid run acknowledgement; check conversation history before retrying");
    return { conversationId: data.sessionId, runId: data.runId };
  },
};
