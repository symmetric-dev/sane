import type { ConversationClient, RunMetadata, RunStatus } from "./types";
import { coalescedFetch } from "./request-coalescing";
import { isConversationUpdateFeedRequest, isConversationUpdatePage } from "../shared/conversation/conversation-updates";
import { nativeNotificationSource } from "./notification-source";
import { SESSION_REFRESH_ERROR } from "./notification-presentation";
import { pendingInputClient } from "./pending-input-client";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}
export async function request(path: string, init: RequestInit = {}) {
  const response = await coalescedFetch(path, { credentials: "same-origin", cache: "no-store", ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
    signal: init.signal ?? AbortSignal.timeout(25000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(body.error || `Request failed (${response.status}).`, response.status, body.code ?? body.reason);
  return body;
}
const transcriptSignal = (signal?: AbortSignal) => signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : undefined;
function mapConversations(data: any) {
  if (!Array.isArray(data?.sessions) || data.sessions.some((session: any) => !session || typeof session.sessionId !== "string" || !session.sessionId)) throw new Error(SESSION_REFRESH_ERROR, { cause: new Error("Invalid conversation listing.") });
  const conversations = data.sessions.map((s: any) => ({ id: s.sessionId, harness: s.harness ?? "claude-code", authorityId: s.authorityId, nativeSessionId: s.nativeSessionId, ...(s.updateSource !== undefined ? { updateSource: s.updateSource } : {}), activity: s.activity, nativeActivity: s.nativeActivity, nativeActivityReason: s.nativeActivityReason, updatedAt: s.updatedAt, cwd: s.cwd, lastRunId: s.lastRunId, lastRunStatus: s.lastRunStatus, lastRunOperation: s.lastRunOperation, lastRunEndedAt: s.lastRunEndedAt, status: s.lastStatus as RunStatus, title: s.title, hidden: s.hidden, model: s.model, effort: s.effort, agent: s.agent, agentKind: s.agentKind, nativeAgentSelected: s.nativeAgentSelected, profileId: s.profileId, workspaceId: s.workspaceId, worktreeId: s.worktreeId, association: s.association, associationReason: s.associationReason, availability: s.availability, queuedFollowups: s.queuedFollowups, attachment: s.attachment, worker: s.worker, ...(s.workerProtocol !== undefined ? { workerProtocol: s.workerProtocol } : {}), directWorkerCount: s.directWorkerCount, branchOrigin: s.branchOrigin, branchDraft: s.branchDraft, replacedBy: s.replacedBy }));
  if (conversations.some((c: any) => c.updateSource !== undefined && !nativeNotificationSource(c))) throw new Error(SESSION_REFRESH_ERROR, { cause: new Error("Invalid conversation update source in listing.") });
  return { conversations, availability: data.availability ?? { canSend: false, reason: "Waiting for bridge availability." } };
}
export const conversationClient: ConversationClient = {
  scienceSubmissions: async (id, signal) => (await request(`/api/sessions/${encodeURIComponent(id)}/science-submissions`, { signal })).submissions,
  scienceSubmission: async (id, requestId, signal) => (await request(`/api/sessions/${encodeURIComponent(id)}/science-submissions/${encodeURIComponent(requestId)}`, { signal })).submission,
  ...pendingInputClient,
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
  async conversations(signal, query) {
    const params = new URLSearchParams({ summary: "1" });
    if (query) {
      params.set("limit", String(query.limit ?? 50));
      for (const key of ["mode", "workspaceId", "worktreeId", "harness", "status", "workstreamId", "phase", "cursor"] as const) {
        if (query[key] !== undefined && query[key] !== null) params.set(key, String(query[key]));
      }
      if (query.showDeleted) params.set("showDeleted", "1");
      if (query.availableOnly) params.set("availableOnly", "1");
      if (query.query) params.set("q", query.query);
    }
    const data = await request(`/api/sessions?${params}`, { signal: transcriptSignal(signal) });
    if (data.page !== undefined && (data.page?.kind !== "partial" || typeof data.page.hasMore !== "boolean"
      || data.page.nextCursor !== null && (typeof data.page.nextCursor !== "string" || !data.page.nextCursor)
      || data.page.hasMore !== (data.page.nextCursor !== null))) throw new Error("Invalid conversation page.");
    return { ...mapConversations(data), ...(data.page ? { page: data.page } : {}) };
  },
  async conversationSummaries(ids, signal) {
    const requested = [...new Set(ids)];
    if (!requested.length || requested.length > 100 || requested.some(id => !id)) throw new Error("Request between one and 100 conversation summaries.");
    const data = await request(`/api/sessions/summaries?ids=${requested.map(encodeURIComponent).join(",")}`, { signal: transcriptSignal(signal) });
    const mapped = mapConversations(data);
    if (!Array.isArray(data.missing) || data.missing.some((item: any) => !item || !requested.includes(item.sessionId) || !["retired", "not-found"].includes(item.reason))) throw new Error("Invalid missing conversation summaries.");
    const returned = [...mapped.conversations.map((c: any) => c.id), ...data.missing.map((item: any) => item.sessionId)];
    if (returned.length !== requested.length || new Set(returned).size !== returned.length || returned.some(id => !requested.includes(id))) throw new Error("Conversation summary identity mismatch.");
    return { ...mapped, missing: data.missing };
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
  async handoffApprovals(id, signal) {
    const data = await request(`/api/sessions/${encodeURIComponent(id)}/handoff-approvals`, { signal });
    const raw = data.approvals ?? data.handoffApprovals ?? data.interactions ?? [];
    if (!Array.isArray(raw)) return [];
    // Backend approvals are domain rows (id/revision/to/message/...); project
    // them to the sender-session Interaction shape for the Permissions-style
    // composer. Already-shaped Interactions pass through unchanged.
    return raw.map((item: any) => {
      if (item && typeof item === "object" && item.type === "handoff-approval" && typeof item.id === "string" && typeof item.handoffId === "string") {
        return { ...item, revision: Number.isSafeInteger(item.revision) ? item.revision : 0 };
      }
      if (!item || typeof item !== "object" || typeof item.id !== "string") return item;
      const handoffId = typeof item.handoffId === "string" ? item.handoffId : item.id;
      const requestId = typeof item.requestId === "string" ? item.requestId : typeof item.request_id === "string" ? item.request_id : handoffId;
      const revision = Number.isSafeInteger(item.revision) ? item.revision : Number.isSafeInteger(item.expectedRevision) ? item.expectedRevision : 0;
      const to = typeof item.to === "string" ? item.to : typeof item.destination === "string" ? item.destination : "";
      const message = typeof item.message === "string" ? item.message : typeof item.description === "string" ? item.description : "";
      const title = typeof item.title === "string" ? item.title : to ? `Handoff to ${to}` : "Handoff approval";
      return { id: item.id, type: "handoff-approval" as const, title, ...(message ? { description: message } : {}), handoffId, requestId, revision,
        ...(typeof item.workstreamId === "string" ? { workstreamId: item.workstreamId } : {}), ...(to ? { to } : {}),
        ...(typeof item.status === "string" ? { status: item.status } : {}) };
    });
  },
  replyHandoff: (id, approvalId, reply) => request(`/api/sessions/${encodeURIComponent(id)}/handoff-approvals/${encodeURIComponent(approvalId)}/reply`, { method: "POST", body: JSON.stringify({ decision: reply.decision, ...(reply.message !== undefined ? { message: reply.message } : {}), expectedRevision: reply.expectedRevision }) }),
  cancel: id => request(`/api/sessions/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" }),
  async verifyCompletion(id, runId, input) {
    const result = await request(`/api/sessions/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/verify-completion`, { method: "POST", body: JSON.stringify(input) });
    if (!["completed", "failed", "interrupted"].includes(result.status) || !result.evidence) throw new Error("Completion verification acknowledgement unavailable.");
    return result;
  },
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
    if (options.scienceSnapshots?.length && (data.queued || data.sessionId !== conversationId || data.scienceSubmission?.conversationId !== conversationId
      || data.scienceSubmission?.requestId !== options.requestId || data.scienceSubmission?.state !== "submitted" || data.scienceSubmission?.runId !== data.runId
      || JSON.stringify(data.scienceSubmission?.snapshots) !== JSON.stringify(options.scienceSnapshots))) throw new Error("Science send acknowledgement is unconfirmed; reconcile its original request without resending");
    if (data.queued === true) {
      if (data.sessionId !== conversationId || !data.receipt || typeof data.receipt.requestId !== "string" || data.receipt.sessionId !== conversationId || data.receipt.prompt !== text) throw new Error("Invalid queue acknowledgement; check conversation history before retrying");
      return { conversationId: data.sessionId, queued: true, receipt: data.receipt };
    }
    if (typeof data.runId !== "string") throw new Error("Invalid run acknowledgement; check conversation history before retrying");
    if (data.messageId !== undefined && typeof data.messageId !== "string") throw new Error("Invalid message acknowledgement; check conversation history before retrying");
    return { conversationId: data.sessionId, runId: data.runId, ...(data.messageId ? { messageId: data.messageId } : {}) };
  },
};
