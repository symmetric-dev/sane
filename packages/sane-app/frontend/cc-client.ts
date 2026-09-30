import type { ConversationClient, RunMetadata, RunStatus } from "./types";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
    signal: init.signal ?? AbortSignal.timeout(25000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(body.error || `Request failed (${response.status}).`, response.status);
  return body;
}
export const conversationClient: ConversationClient = {
  config: (signal) => request("/api/config", { signal }),
  login: (password) => request("/api/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => request("/api/logout", { method: "POST" }),
  async conversations(signal) {
    const data = await request("/api/sessions", { signal });
    return { conversations: (data.sessions ?? []).map((s: any) => ({ id: s.sessionId, harness: s.harness ?? "claude-code", nativeSessionId: s.nativeSessionId, cwd: s.cwd, lastRunId: s.lastRunId, status: s.lastStatus as RunStatus, title: s.title, hidden: s.hidden, model: s.model, effort: s.effort, agent: s.agent, profileId: s.profileId, workspaceId: s.workspaceId, worktreeId: s.worktreeId, association: s.association, associationReason: s.associationReason, availability: s.availability, attachment: s.attachment, worker: s.worker, directWorkerCount: s.directWorkerCount, branchOrigin: s.branchOrigin, replacedBy: s.replacedBy, branchOperation: s.branchOperation })),
      availability: data.availability ?? { canSend: false, reason: "Waiting for bridge availability." } };
  },
  async runs(id, signal): Promise<RunMetadata[]> {
    const data = await request(`/api/sessions/${encodeURIComponent(id)}/runs`, { signal });
    return (data.runs ?? []).map((r: any) => ({ id: r.runId, conversationId: r.sessionId, harness: r.harness ?? "claude-code", nativeSessionId: r.nativeSessionId, nativeCommandId: r.nativeCommandId, cwd: r.cwd, status: r.status, createdAt: r.createdAt, endedAt: r.endedAt, model: r.model, effort: r.effort, agent: r.agent, profileId: r.profileId }));
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
    return { conversationId: data.sessionId, runId: data.runId };
  },
};
