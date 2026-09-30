import { Service } from "@opencode/client/service";
import type { FormField, HarnessModel, Interaction, InteractionReply, MessagePart, MessageSnapshot } from "./oc-contract";
import { validModel, validVariant } from "./history";

// HTTP shapes from https://opencode.ai/v2/openapi.json and the V2 client guide.
// Discovery connects to a registered service; this adapter never manages its process.
type Connection = { base: string; headers: Record<string, string> };
export type ModelRef = { id: string; providerID: string; variant?: string };
export type NativeAgent = { id: string; model?: ModelRef };
export type OpenCodeLaunch = { agent?: string; model?: ModelRef };
type NativeSession = { id: string; location?: { directory?: string }; agent?: string; model?: ModelRef; outcome?: "succeeded" | "failed" | "interrupted"; time: { created: number; updated: number; idle?: number } };
type NativePart = { type: string; id?: string; name?: string; text?: string; state?: { status: string; input?: unknown; content?: unknown; error?: unknown } };
export type NativeMessage = { id: string; type: string; time: { created: number; completed?: number }; text?: string; content?: NativePart[]; error?: unknown; cost?: number; tokens?: unknown; outcome?: string };
type Page = { data: NativeMessage[]; cursor: { next?: string | null } };
export class OpenCodeError extends Error {
  constructor(message: string, public status = 503) { super(message); }
}
export class OpenCodeAdapter {
  private explicit?: Connection;
  private managed?: Connection;
  private discovery?: Promise<Connection>;
  private expires = 0;
  private retryAfter = 0;
  constructor(url?: string, token = process.env.OPENCODE_TOKEN, private registrationFile?: string) {
    if (url === undefined) return;
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Invalid --opencode-url");
    this.explicit = { base: url.replace(/\/$/, ""), headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) } };
  }
  private async endpoint(): Promise<Connection> {
    if (this.explicit) return this.explicit;
    if (this.discovery) return this.discovery;
    if (this.managed && Date.now() < this.expires) return this.managed;
    const unavailable = () => new OpenCodeError("OpenCode managed service unavailable; verify the intended existing service and its registered source with the operator before proceeding");
    if (Date.now() < this.retryAfter) throw unavailable();
    this.discovery = (async () => {
      try {
        if (!this.registrationFile) throw unavailable();
        const endpoint = await Service.discover({ file: this.registrationFile });
        if (!endpoint) throw unavailable();
        // Keep URL and its own credentials together, never merge the explicit token.
        const connection = { base: endpoint.url.replace(/\/$/, ""), headers: { "content-type": "application/json", ...Service.headers(endpoint) } };
        this.managed = connection;
        this.expires = Date.now() + 5000;
        this.retryAfter = 0;
        return connection;
      } catch {
        this.managed = undefined;
        this.retryAfter = Date.now() + 1000;
        // SDK errors may contain endpoint details; expose only a fixed diagnostic.
        throw unavailable();
      }
    })();
    try { return await this.discovery; } finally { this.discovery = undefined; }
  }
  private invalidate(connection: Connection) {
    // An old in-flight request must not invalidate a newly discovered generation.
    if (this.managed === connection) { this.managed = undefined; this.expires = 0; }
  }
  async request<T>(path: string, method = "GET", data?: unknown, beforeSend?: () => void): Promise<T> {
    const connection = await this.endpoint();
    beforeSend?.(); // Synchronous admission gate after discovery, immediately before the HTTP mutation.
    let response: Response;
    try { response = await fetch(connection.base + path, { method, headers: connection.headers, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(10000), redirect: "error" }); }
    catch { this.invalidate(connection); throw new OpenCodeError("OpenCode connection unavailable; execution state remains unconfirmed"); }
    // Refresh on the next request only. In particular, never replay mutations.
    if (!response.ok) {
      const auth = response.status === 401 || response.status === 403;
      if (auth || response.status >= 500) this.invalidate(connection);
      throw new OpenCodeError(auth ? this.explicit ? "OpenCode authentication rejected; configure OPENCODE_TOKEN for the explicit URL" : "OpenCode managed authentication rejected; discovery will refresh on the next request" : `OpenCode API returned HTTP ${response.status}`, response.status);
    }
    if (response.status === 204) return undefined as T;
    try { return await response.json() as T; } catch { this.invalidate(connection); throw new OpenCodeError("OpenCode returned an invalid JSON response"); }
  }
  path(id: string) { return `/api/session/${encodeURIComponent(id)}`; }
  async connection(cwd: string) {
    try { await this.models(cwd); return { available: true, connected: true, state: "connected" as const }; }
    catch (error) { return { available: false, connected: false, state: "unavailable" as const, reason: error instanceof Error ? error.message : "OpenCode unavailable" }; }
  }
  async models(cwd: string): Promise<HarnessModel[]> {
    const response = await this.request<{ data: { id: string; providerID: string; name: string; enabled: boolean; variants: { id: string }[] }[] }>(`/api/model?location%5Bdirectory%5D=${encodeURIComponent(cwd)}`);
    if (!Array.isArray(response.data)) throw new OpenCodeError("Unsupported OpenCode V2 model response");
    return response.data.filter(m => m.enabled).map(m => ({ id: `${m.providerID}/${m.id}`, name: m.name, efforts: m.variants.map(v => ({ id: v.id, name: v.id })) }));
  }
  model(value: string, effort?: string): ModelRef {
    const slash = value.indexOf("/");
    if (slash < 1 || slash === value.length - 1) throw new OpenCodeError("OpenCode model must be provider/model", 400);
    return { providerID: value.slice(0, slash), id: value.slice(slash + 1), ...(effort === undefined ? {} : { variant: effort }) };
  }
  async agents(cwd: string): Promise<NativeAgent[]> {
    const response = await this.request<{ data: NativeAgent[] }>(`/api/agent?location%5Bdirectory%5D=${encodeURIComponent(cwd)}`);
    const validModel = (m: ModelRef) => m && typeof m.id === "string" && !!m.id && typeof m.providerID === "string" && !!m.providerID && (m.variant === undefined || typeof m.variant === "string");
    if (!Array.isArray(response.data) || response.data.some(a => !a || typeof a.id !== "string" || !a.id || a.model !== undefined && !validModel(a.model))) throw new OpenCodeError("Unsupported OpenCode V2 agent response");
    return response.data;
  }
  /** Profile model > agent model > native default. Explicit models never inherit another model's variant. */
  async resolveLaunch(cwd: string, input: { agent?: string; model?: string; effort?: string }): Promise<OpenCodeLaunch> {
    const agent = input.agent === undefined ? undefined : (await this.agents(cwd)).find(a => a.id === input.agent);
    if (input.agent !== undefined && !agent) throw new OpenCodeError(`OpenCode agent ${input.agent} is not installed for ${cwd}`, 400);
    let model = input.model !== undefined ? this.model(input.model) : agent?.model ? { ...agent.model } : undefined;
    if (input.effort !== undefined) {
      if (!model) throw new OpenCodeError("Cannot resolve a model for the requested variant; configure a profile model or an agent model", 400);
      model = { ...model, variant: input.effort };
    }
    return { ...(agent ? { agent: agent.id } : {}), ...(model ? { model } : {}) };
  }
  async createResolved(cwd: string, launch: OpenCodeLaunch) {
    const { data } = await this.request<{ data: NativeSession }>("/api/session", "POST", { location: { directory: cwd }, ...launch });
    if (!data || !/^ses[a-zA-Z0-9_-]+$/.test(data.id)) throw new OpenCodeError("Unsupported OpenCode V2 session response");
    if (data.location?.directory !== cwd) throw new OpenCodeError("Created native session directory differs from the requested execution pin", 409);
    return data;
  }
  async create(cwd: string, model?: string, effort?: string, agent?: string) {
    return this.createResolved(cwd, await this.resolveLaunch(cwd, { agent, model, effort }));
  }
  async select(id: string, model?: string, effort?: string) {
    if (model === undefined && effort === undefined) return;
    const current = model === undefined ? (await this.session(id)).model : undefined;
    if (!model && !current) throw new OpenCodeError("Select a model before selecting a variant", 400);
    const ref = model ? this.model(model, effort) : { id: current!.id, providerID: current!.providerID, variant: effort };
    await this.request(this.path(id) + "/model", "POST", { model: ref });
  }
  async prompt(id: string, commandId: string, text: string, beforeSubmit?: () => void) {
    const { data } = await this.request<{ data: { id: string; time: { created: number } } }>(this.path(id) + "/prompt", "POST", { id: commandId, text }, beforeSubmit);
    if (data?.id !== commandId || !Number.isFinite(data.time?.created)) throw new OpenCodeError("OpenCode prompt acknowledgement mismatch; execution state unconfirmed");
    return data;
  }
  async session(id: string) { return (await this.request<{ data: NativeSession }>(this.path(id))).data; }
  async fork(id: string, cwd: string, boundary: string, before?: string, beforeSend?: () => void) {
    const { data } = await this.request<{ data: NativeSession & { fork?: { sessionID: string; boundary: { type: string; messageID: string } } } }>(this.path(id) + "/fork", "POST", before ? { before } : {}, beforeSend);
    if (!data || !/^ses[a-zA-Z0-9_-]+$/.test(data.id) || data.id === id || data.location?.directory !== cwd || data.fork?.sessionID !== id || data.fork.boundary.type !== (before ? "before" : "through") || data.fork.boundary.messageID !== (before ?? boundary)) throw new OpenCodeError("Native fork acknowledgement mismatch; do not retry creation", 409);
    return data;
  }
  /** Recover an admission from confirmed Session.Info, never today's agent defaults.
   * Reusable for assistant/worker admissions whose App metadata was not committed. */
  async recoverLaunch(id: string, cwd: string, expectedAgent: string): Promise<OpenCodeLaunch> {
    const session = await this.session(id);
    if (!session || session.id !== id || session.location?.directory !== cwd) throw new OpenCodeError("Cannot recover launch: native session identity or checkout differs from the admission", 409);
    if (session.agent !== expectedAgent) throw new OpenCodeError("Cannot recover launch: native selected agent is missing or differs from the requested agent; reconcile the admission", 409);
    const model = session.model;
    if (!model || typeof model.id !== "string" || !model.id || typeof model.providerID !== "string" || !model.providerID || model.variant !== undefined && (typeof model.variant !== "string" || !model.variant)) throw new OpenCodeError("Cannot recover launch: native selected model/variant is unavailable or invalid; reconcile the admission", 409);
    if (!validModel(`${model.providerID}/${model.id}`) || model.variant !== undefined && !validVariant(model.variant)) throw new OpenCodeError("Cannot recover launch: native model/variant cannot be represented in App metadata; reconcile the admission", 409);
    return { agent: session.agent, model: { ...model } };
  }
  async activity(id: string, cwd: string) {
    const [session, active, inbox] = await Promise.all([
      this.session(id), this.request<{ data: Record<string, { type: string }> }>("/api/session/active"),
      this.request<{ data: { id: string }[] }>(this.path(id) + "/inbox"),
    ]);
    if (session?.id !== id || session.location?.directory !== cwd) throw new OpenCodeError("Native session identity or execution directory differs from the pinned conversation", 409);
    if (!active.data || !Array.isArray(inbox.data)) throw new OpenCodeError("Unsupported native activity response");
    return { session, active: !!active.data[id], pending: inbox.data.length > 0 };
  }
  async assertIdle(id: string, cwd: string) {
    const state = await this.activity(id, cwd);
    if (state.active || state.pending) throw new OpenCodeError("Native conversation is active or has pending input; reconcile and finish it in its native harness before sending", 409);
  }
  async history(id: string, cwd: string) {
    const before = await this.activity(id, cwd);
    const messages: NativeMessage[] = []; let cursor: string | undefined;
    const deadline = Date.now() + 15000;
    for (let page = 0; page < 100; page++) {
      if (Date.now() > deadline) throw new OpenCodeError("History read exceeded 15-second budget; no snapshot imported");
      const result = await this.request<Page>(this.path(id) + `/message?limit=100&${cursor ? `cursor=${encodeURIComponent(cursor)}` : "order=desc"}`);
      if (!Array.isArray(result.data) || !result.cursor) throw new OpenCodeError("Unsupported native history response");
      messages.push(...result.data);
      if (JSON.stringify(messages).length > 16 * 1024 * 1024) throw new OpenCodeError("History exceeds 16 MiB import budget");
      cursor = result.cursor.next ?? undefined;
      if (!cursor) {
        const after = await this.activity(id, cwd);
        // Pagination is not a transactional native snapshot. Report activity and
        // reject a moving transcript rather than importing a mixed history.
        if (before.session.time.updated !== after.session.time.updated) throw new OpenCodeError("Native history changed during reconciliation; retry after native activity settles", 409);
        const rawMessages = messages.reverse();
        return { rawMessages, messages: rawMessages.map(normalizeMessage).filter((m): m is MessageSnapshot => !!m), activity: after.active || after.pending ? "active" as const : "idle" as const };
      }
    }
    throw new OpenCodeError("History exceeds 10,000-message import budget; no partial import");
  }
  async snapshot(id: string, commandId: string, cwd?: string) {
    // Newest first until the exact durable command is found. Bounded, with no
    // completion inference if the required history lies outside this budget.
    const messages: NativeMessage[] = []; let cursor: string | undefined; let found = false;
    const deadline = Date.now() + 15000;
    for (let page = 0; page < 100; page++) {
      if (Date.now() > deadline) throw new OpenCodeError("Native observation exceeded its 15-second page budget; state remains unconfirmed");
      const result = await this.request<Page>(this.path(id) + `/message?limit=100&${cursor ? `cursor=${encodeURIComponent(cursor)}` : "order=desc"}`);
      if (!Array.isArray(result.data) || !result.cursor) throw new OpenCodeError("Unsupported OpenCode V2 message response");
      const index = result.data.findIndex(m => m.id === commandId);
      messages.push(...(index < 0 ? result.data : result.data.slice(0, index + 1)));
      if (index >= 0) { found = true; break; }
      cursor = result.cursor.next ?? undefined;
      if (!cursor) break;
      if (page === 99) throw new OpenCodeError("OpenCode history reconciliation exceeded its page budget");
    }
    const [session, active, inbox] = await Promise.all([
      this.session(id), this.request<{ data: Record<string, { type: "running" }> }>("/api/session/active"),
      this.request<{ data: { id: string }[] }>(this.path(id) + "/inbox"),
    ]);
    if (!session?.time || !active.data || !Array.isArray(inbox.data)) throw new OpenCodeError("Unsupported OpenCode V2 execution response");
    if (session.id !== id || (cwd !== undefined && session.location?.directory !== cwd)) throw new OpenCodeError("Native session identity or directory changed; execution remains unconfirmed", 409);
    const pending = inbox.data.some(m => m.id === commandId);
    const bounded = commandSnapshot(found ? messages.reverse() : [], commandId);
    // Session.outcome belongs to the latest turn, not necessarily this command.
    // Later external activity cannot overwrite a recorded command boundary.
    return { messages: bounded.messages, outcome: pending ? undefined : bounded.outcome, pending };
  }
  async cancel(id: string) { return this.request<{ interrupted: boolean }>(this.path(id) + "/interrupt?resume=false", "POST"); }
  async interactions(id: string): Promise<Interaction[]> {
    const [permissions, forms] = await Promise.all([
      this.request<{ data: { id: string; action: string; resources: string[]; message?: string }[] }>(this.path(id) + "/permission"),
      this.request<{ data: { id: string; title: string; fields: FormField[] }[] }>(this.path(id) + "/form"),
    ]);
    return [...permissions.data.map(p => ({ id: p.id, type: "permission" as const, title: p.action, description: [p.message, ...p.resources].filter(Boolean).join("\n"), options: [{ id: "once", name: "Allow once" }, { id: "always", name: "Always allow" }, { id: "reject", name: "Reject" }] })), ...forms.data.map(f => ({ id: f.id, type: "question" as const, title: f.title, fields: f.fields }))];
  }
  async reply(id: string, interactionId: string, reply: InteractionReply) {
    const pending = (await this.interactions(id)).find(i => i.id === interactionId && i.type === reply.type);
    if (!pending) throw new OpenCodeError("Unknown pending interaction", 404);
    if (reply.type === "permission") {
      if (!["once", "always", "reject"].includes(reply.decision) || (reply.message !== undefined && typeof reply.message !== "string")) throw new OpenCodeError("Invalid permission decision", 400);
      await this.request(this.path(id) + `/permission/${encodeURIComponent(interactionId)}/reply`, "POST", { decision: reply.decision, ...(reply.message === undefined ? {} : { message: reply.message }) });
    } else {
      if (!reply.answer || typeof reply.answer !== "object" || Array.isArray(reply.answer)) throw new OpenCodeError("Invalid form answer", 400);
      await this.request(this.path(id) + `/form/${encodeURIComponent(interactionId)}/reply`, "POST", { answer: reply.answer });
    }
  }
}

export function commandSnapshot(history: NativeMessage[], commandId: string) {
  const start = history.findIndex(m => m.id === commandId && m.type === "user");
  if (start < 0) return { messages: [] as NativeMessage[], outcome: undefined as string | undefined };
  const messages = [history[start]!];
  for (const message of history.slice(start + 1)) {
    // Another admitted input before an idle boundary makes attribution ambiguous.
    if (message.type === "user" || message.type === "synthetic") break;
    messages.push(message);
    if (message.type === "idle") return { messages, outcome: ["succeeded", "failed", "interrupted"].includes(message.outcome ?? "") ? message.outcome : undefined };
  }
  return { messages, outcome: undefined };
}

export function normalizeMessage(message: NativeMessage): MessageSnapshot | undefined {
  if (!["user", "assistant", "system", "synthetic"].includes(message.type)) return;
  const parts: MessagePart[] = message.type === "assistant" ? (message.content ?? []).flatMap((part, i): MessagePart[] => {
    const id = part.id ?? `${message.id}:part:${i}`;
    if (part.type === "text" || part.type === "reasoning") return [{ id, type: part.type, text: part.text ?? "" }];
    if (part.type === "tool") return [{ id, type: "tool", name: part.name ?? "tool", status: part.state?.status ?? "streaming", input: part.state?.input, output: part.state?.content, error: part.state?.error }];
    return [];
  }) : [{ id: `${message.id}:text`, type: "text", text: message.text ?? "" }];
  return { messageId: message.id, role: message.type === "assistant" ? "assistant" : message.type === "user" ? "user" : "system", parts, status: message.error ? "failed" : message.type !== "assistant" || message.time.completed !== undefined ? "completed" : "running", createdAt: new Date(message.time.created).toISOString(), ...(message.cost !== undefined || message.tokens !== undefined ? { usage: { cost: message.cost, tokens: message.tokens } } : {}), ...(message.error ? { error: message.error } : {}) };
}
