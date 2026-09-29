import type { ConversationClient, RunMetadata, RunStatus } from "./types";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
async function request(path: string, init: RequestInit = {}) {
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
    return { conversations: (data.sessions ?? []).map((s: any) => ({ id: s.sessionId, harness: s.harness ?? "claude-code", nativeSessionId: s.nativeSessionId, cwd: s.cwd, lastRunId: s.lastRunId, status: s.lastStatus as RunStatus, workspaceId: s.workspaceId, worktreeId: s.worktreeId, association: s.association, associationReason: s.associationReason })),
      availability: data.availability ?? { canSend: false, reason: "Waiting for bridge availability." } };
  },
  async runs(id, signal): Promise<RunMetadata[]> {
    const data = await request(`/api/sessions/${encodeURIComponent(id)}/runs`, { signal });
    return (data.runs ?? []).map((r: any) => ({ id: r.runId, conversationId: r.sessionId, harness: r.harness ?? "claude-code", nativeSessionId: r.nativeSessionId, cwd: r.cwd, status: r.status, createdAt: r.createdAt, endedAt: r.endedAt, model: r.model, effort: r.effort }));
  },
  events: (run, signal) => request(`/api/runs/${encodeURIComponent(run.id)}/events?after=${run.cursor}`, { signal }),
  async models(cwd, signal) {
    const data = await request(`/api/harnesses/opencode/models?cwd=${encodeURIComponent(cwd)}`, { signal });
    return data.models ?? [];
  },
  async interactions(id, signal) { return (await request(`/api/sessions/${encodeURIComponent(id)}/interactions`, { signal })).interactions ?? []; },
  reply: (id, interactionId, reply) => request(`/api/sessions/${encodeURIComponent(id)}/interactions/${encodeURIComponent(interactionId)}/reply`, { method: "POST", body: JSON.stringify(reply) }),
  cancel: id => request(`/api/sessions/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" }),
  async submit({ text, conversationId, ...options }) {
    const data = await request("/api/sessions", { method: "POST", body: JSON.stringify({ prompt: text, ...(conversationId ? { sessionId: conversationId } : {}), ...options }) });
    return { conversationId: data.sessionId, runId: data.runId };
  },
};
