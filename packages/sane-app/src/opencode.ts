import { Service } from "@opencode/client/service";
import { OpenCode, type GenerateTextInput, type OpenCodeClient } from "@opencode/client";
import type { CompactionLifecycle, CompactionMetadata, FormField, HarnessModel, Interaction, InteractionReply, MessagePart, MessageSnapshot, NativeCommandBoundary } from "./oc-contract";
import { nativeMessageId, validModel, validVariant } from "./history";
import { settleCommandInterval, type CommandSettlement } from "./opencode-command-settlement";
import { matchesOpenCodeWorkerPart, type NativeWorkerInvocation } from "../../sane-cli/src/native-worker-contract";
import { synchronousDispatchHook } from "./dispatch-evidence";

// HTTP shapes from https://opencode.ai/v2/openapi.json and the V2 client guide.
// Discovery connects to a registered service; this adapter never manages its process.
type Connection = { base: string; headers: Record<string, string> };
/** Read-only, endpoint-bound generation. No process management or message GETs. */
export type OpenCodeReplyTransport = {
  info: OpenCodeClient["server"]["info"];
  events: OpenCodeClient["event"]["subscribe"];
  log: OpenCodeClient["session"]["log"];
  session: OpenCodeClient["session"]["get"];
};
export type ModelRef = { id: string; providerID: string; variant?: string };
/** Stateless utilities only: no session operations, endpoint details, or auth. */
export type OpenCodeUtilityTransport = {
  generate(input: GenerateTextInput, options: { signal: AbortSignal; maxResponseBytes: number }): Promise<{ text: string }>;
};
export type NativeAgent = { id: string; model?: ModelRef };
export type OpenCodeLaunch = { agent?: string; model?: ModelRef };
type NativeSession = { id: string; parentID?: string; location?: { directory?: string }; agent?: string; permissions?: unknown; model?: ModelRef; outcome?: "succeeded" | "failed" | "interrupted"; revert?: unknown; metadata?: Record<string, unknown>; time: { created: number; updated: number; idle?: number } };
type NativeInput = { id: string; sessionID?: string; type?: string; delivery?: string; time?: { created: number }; payload?: { metadata?: Record<string, unknown> } };
export type NativeQueuedHandoffAdmission = { id: string; sessionID: string; type: "user"; delivery: "queue"; time: { created: number } };
/** The string is the actual HTTP body, serialized once before any admission hook. */
export type OpenCodePromptPacket = Readonly<{ sessionId: string; body: string }>;
export type OpenCodePromptAdmission = Readonly<{ id: string; time: { created: number } }>;
/** Opaque authenticated generation; single-use, without discovery at send time. */
export type OpenCodePreparedPrompt = Readonly<{
  send: (beforeSubmit: (body: string) => void) => Promise<OpenCodePromptAdmission>;
}>;
export function prepareOpenCodePrompt(sessionId: string, commandId: string, text: string, delivery?: "queue"): OpenCodePromptPacket {
  return Object.freeze({ sessionId, body: JSON.stringify({ id: commandId, text, ...(delivery === undefined ? {} : { delivery }) }) });
}
/** Only the actual inbox/ack DTO proves delivery policy. Committed User messages
 * omit sessionID/delivery in V2 and cannot reconstruct a lost queue receipt. */
export function isQueuedHandoffAdmission(value: unknown, sessionId: string, commandId: string): value is NativeQueuedHandoffAdmission {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as NativeInput;
  return input.id === commandId && input.sessionID === sessionId && input.type === "user" && input.delivery === "queue"
    && !!input.time && typeof input.time === "object" && !Array.isArray(input.time) && Number.isFinite(input.time.created);
}
type NativePart = { type: string; id?: string; name?: string; text?: string; state?: { status: string; input?: unknown; content?: unknown; error?: unknown; metadata?: Record<string, unknown> } };
export type NativeMessage = { id: string; type: string; agent?: string; metadata?: Record<string, unknown>; time: { created: number; completed?: number }; model?: ModelRef; text?: string; content?: NativePart[]; error?: unknown; retry?: MessageSnapshot["retry"]; cost?: number; tokens?: unknown; outcome?: string; status?: string; reason?: string; summary?: string; preTokens?: number; postTokens?: number; durationMs?: number };
export type NativeCompactAdmission = { id: string; sessionID: string; type: "compaction"; time: { created: number }; delivery: "queue" | "steer"; payload?: unknown };
export type NativeCompactionProjection = { messages: NativeMessage[]; compaction?: CompactionMetadata; outcome?: "succeeded" | "failed" | "skipped" };
export type NativeCompactionObservation = NativeCompactionProjection & { pending: boolean; active: boolean; observed: boolean };
export type NativeCommandObservation =
  | { kind: "pending"; input: unknown }
  | { kind: "exact-terminal"; outcome: "succeeded" | "failed" | "interrupted" }
  | { kind: "foreign-boundary"; boundary: NativeCommandBoundary }
  | { kind: "protocol-contradiction"; reason: string }
  | { kind: "termination-uncertain" }
  | { kind: "unavailable"; reason: string };
export type NativeCommandSnapshot = { messages: NativeMessage[]; outcome?: string; pending: boolean; pendingInput?: unknown; currentInputId?: string; boundary?: NativeCommandBoundary; settlement?: CommandSettlement; observation?: NativeCommandObservation };
type Page = { data: NativeMessage[]; cursor: { next?: string | null } };
/** App-delivered startup synthetics are model context, never transcript turns. */
const saneFrameworkMetadata = { sane: "framework" } as const;
const saneStartupContext = (metadata: Record<string, unknown> | undefined) => metadata?.sane === saneFrameworkMetadata.sane || metadata?.sane === "session";
// SessionRestart in native V2 publishes this notice while preserving the same
// execution claim. Shutdown interruptions deliberately have no idle boundary.
// Do not treat arbitrary synthetics (including other notices) as continuations.
const restartContinuation = (message: NativeMessage, command: NativeMessage) => message.type === "synthetic"
  && message.metadata?.notice === "restart"
  && message.text === "The server restarted while you were working. Continue from where you left off without repeating completed work."
  && nativeMessageId(message.id) && Number.isFinite(message.time?.created)
  && message.time.created >= command.time.created;
/** Native instruction discovery inserts context during a turn, not a new inbox
 * input. Recognize only the evidenced metadata shape; prose and filenames are
 * never lifecycle evidence. Unknown/malformed synthetics still fence ownership. */
const instructionContext = (message: NativeMessage, command: NativeMessage) => {
  if (message.type !== "synthetic" || !nativeMessageId(message.id) || !Number.isFinite(message.time?.created)
    || message.time.created < command.time.created) return false;
  const metadata = message.metadata, instruction = metadata?.instruction;
  if (!metadata || Object.keys(metadata).some(key => key !== "instruction")
    || !instruction || typeof instruction !== "object" || Array.isArray(instruction)) return false;
  const value = instruction as Record<string, unknown>;
  return Object.keys(value).every(key => key === "paths") && Array.isArray(value.paths) && value.paths.length > 0
    && value.paths.every(path => typeof path === "string" && !!path.trim() && !path.includes("\0"));
};
/** Completion attribution and queued-input cancellation must agree on which
 * messages are new inputs. Do not exempt all synthetic messages. */
export const openCodeTurnContext = (message: NativeMessage, command: NativeMessage) => restartContinuation(message, command) || instructionContext(message, command);
const commandBoundary = (message: NativeMessage, command: NativeMessage): NativeCommandBoundary | undefined => {
  if (message.type === "user" || message.type === "synthetic" && !openCodeTurnContext(message, command)) {
    return { messageId: message.id, type: message.type };
  }
};
export class OpenCodeError extends Error {
  constructor(message: string, public status = 503) { super(message); }
}
/** A successful observation contradicted the immutable native identity pin. */
export class OpenCodeSourceMismatchError extends OpenCodeError {
  constructor(message: string) { super(message, 409); }
}
/** Read-only proof may be retried after transport/service availability recovers. */
export class OpenCodeUnavailableError extends OpenCodeError {}
/** A returned native DTO conflicts with the promised queue handoff. Acceptance
 * may already have happened; never turn a later user anchor into policy proof. */
export class OpenCodeQueuedHandoffProtocolError extends OpenCodeError {}
export class OpenCodeCommandProtocolError extends OpenCodeError {
  constructor(message: string) { super(message, 409); }
}
/** A strict inbox read must account for every entry before absence or an exact
 * receipt can be used as proof. A duplicate exact ID is never a single input. */
function strictInbox(data: unknown, sessionId: string, commandId: string): NativeInput | undefined {
  if (!Array.isArray(data) || data.some(value => !value || typeof value !== "object" || Array.isArray(value)
    || !nativeMessageId(value.id) || value.sessionID !== sessionId
    || !["user", "synthetic", "compaction"].includes(value.type)
    || !["queue", "steer"].includes(value.delivery)
    || !value.time || typeof value.time !== "object" || Array.isArray(value.time) || !Number.isFinite(value.time.created)))
    throw new OpenCodeCommandProtocolError("Malformed native inbox entry; cancellation and execution remain unconfirmed");
  const matches = (data as NativeInput[]).filter(value => value.id === commandId);
  if (matches.length > 1) throw new OpenCodeCommandProtocolError("Duplicate exact native inbox identity; operator reconciliation required");
  return matches[0];
}
export class OpenCodeReplyTransportLimitError extends OpenCodeError {
  constructor() { super("OpenCode reply transport exceeded 16 MiB raw response budget"); }
}
export const permissionPatternMatches = (pattern: string, value: string) => new RegExp(`^${pattern.split(/([*?])/).map(part => part === "*" ? ".*" : part === "?" ? "." : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("")}$`, "s").test(value);
/** Native rules are ordered: the last matching rule wins. Unknown/ask is not proof. */
export function openCodePermissionAllows(rules: unknown, action: string, resource = "*"): boolean {
  if (!Array.isArray(rules)) return false;
  let effect: unknown;
  for (const rule of rules) {
    if (!rule || typeof rule.action !== "string" || typeof rule.resource !== "string" || !["allow", "ask", "deny"].includes(rule.effect)) return false;
    if (permissionPatternMatches(rule.action, action) && permissionPatternMatches(rule.resource, resource)) effect = rule.effect;
  }
  return effect === "allow";
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
    const unavailable = () => new OpenCodeUnavailableError("OpenCode managed service unavailable; verify the intended existing service and its registered source with the operator before proceeding");
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
  /** V2 stateless generation uses base configuration/provider credentials, but
   * not the session runner, instruction discovery, tools, or session storage.
   * Keep the authenticated connection private and pinned for this utility; never
   * retry a generation or start another service on transport failure.
   * Location-scoped model.default cannot resolve the base-config default used
   * here; omit model to let the stateless endpoint select its own native default.
   * https://opencode.ai/v2/openapi.json: experimental.generate.text
   */
  async utilityTransport(options: { signal: AbortSignal }): Promise<OpenCodeUtilityTransport> {
    const cancelled = () => new OpenCodeError("OpenCode utility cancelled or timed out");
    if (options.signal.aborted) throw cancelled();
    const connection = await this.endpoint();
    if (options.signal.aborted) throw cancelled();
    const request = async (data: GenerateTextInput, signal: AbortSignal, maxBytes: number): Promise<unknown> => {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) throw new OpenCodeError("Invalid OpenCode utility response budget", 400);
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 60_000);
      const combined = AbortSignal.any([options.signal, signal, controller.signal]);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let complete = false;
      try {
        if (combined.aborted) throw cancelled();
        const response = await fetch(connection.base + "/api/experimental/generate", {
          method: "POST", headers: connection.headers,
          body: JSON.stringify(data), signal: combined, redirect: "error",
        });
        if (!response.ok) {
          if (response.status === 401 || response.status === 403 || response.status >= 500) this.invalidate(connection);
          controller.abort(); // Do not read or expose an untrusted error body.
          throw new OpenCodeError(`OpenCode utility API rejected the request (HTTP ${response.status})`, response.status);
        }
        if (!response.body) throw new OpenCodeError("OpenCode utility returned an empty response");
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) { complete = true; break; }
          bytes += chunk.value.byteLength;
          if (bytes > maxBytes) {
            // Abort the HTTP task as well as dropping its buffered output.
            controller.abort();
            throw new OpenCodeError("OpenCode utility response exceeded its byte budget");
          }
          chunks.push(chunk.value);
        }
        if (combined.aborted) throw cancelled();
        const body = Buffer.concat(chunks, bytes);
        try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
        catch { throw new OpenCodeError("OpenCode utility returned invalid JSON"); }
      } catch (error) {
        // Locally-triggered budget cancellation keeps its specific safe error.
        if (options.signal.aborted || signal.aborted) throw cancelled();
        if (error instanceof OpenCodeError) throw error;
        if (combined.aborted) throw cancelled();
        this.invalidate(connection);
        throw new OpenCodeUnavailableError("OpenCode utility transport unavailable");
      } finally {
        clearTimeout(deadline);
        if (!complete) {
          controller.abort();
          try { await reader?.cancel(); } catch { /* Aborted transport already owns cancellation. */ }
        }
        reader?.releaseLock();
      }
    };
    const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
    return {
      generate: async (input, call) => {
        // This API has no system/tool/session options. Forward only its documented
        // fields even if an untyped caller supplies additional properties.
        if (typeof input.prompt !== "string" || Buffer.byteLength(input.prompt, "utf8") > 512 * 1024) throw new OpenCodeError("Invalid OpenCode utility prompt budget", 400);
        const result = await request({ prompt: input.prompt, ...(input.model ? { model: { id: input.model.id, providerID: input.model.providerID, ...(input.model.variant === undefined ? {} : { variant: input.model.variant }) } } : {}) }, call.signal, call.maxResponseBytes);
        if (!object(result) || !object(result.data) || typeof result.data.text !== "string") throw new OpenCodeError("OpenCode utility generation response is malformed");
        return { text: result.data.text };
      },
    };
  }
  async replyTransport(): Promise<OpenCodeReplyTransport> {
    const connection = await this.endpoint();
    const client = OpenCode.make({
      baseUrl: connection.base,
      headers: connection.headers,
      // The generated SDK caps individual SSE frames, not total response bytes.
      // Bound the raw body too, before JSON decoding; global streams rotate at
      // this budget and reconnect/catch up through the authoritative log.
      fetch: Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        let response: Response;
        try { response = await fetch(input, { ...init, redirect: "error" }); }
        catch { this.invalidate(connection); throw new OpenCodeError("OpenCode reply transport unavailable"); }
        if (!response.ok) {
          if (response.status === 401 || response.status === 403 || response.status >= 500) this.invalidate(connection);
          await response.body?.cancel();
          throw new OpenCodeError("OpenCode reply transport rejected", response.status);
        }
        if (!response.body) return response;
        const reader = response.body.getReader();
        let bytes = 0;
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = await reader.read();
              if (next.done) { controller.close(); reader.releaseLock(); return; }
              bytes += next.value.byteLength;
              if (bytes > 16 * 1024 * 1024) {
                await reader.cancel();
                throw new OpenCodeReplyTransportLimitError();
              }
              controller.enqueue(next.value);
            } catch (error) {
              try { await reader.cancel(); } catch { /* transport already failed */ }
              try { reader.releaseLock(); } catch { /* cancellation may own the reader */ }
              controller.error(error instanceof OpenCodeReplyTransportLimitError ? error : new OpenCodeError("OpenCode reply stream incomplete"));
            }
          },
          async cancel(reason) {
            try { await reader.cancel(reason); } finally {
              try { reader.releaseLock(); } catch { /* pending pull owns the reader */ }
            }
          },
        });
        return new Response(body, { status: response.status, headers: response.headers });
      }, { preconnect: fetch.preconnect }),
    });
    return { info: options => client.server.info(options), events: options => client.event.subscribe(options), log: (input, options) => client.session.log(input, options), session: (input, options) => client.session.get(input, options) };
  }
  async request<T>(path: string, method = "GET", data?: unknown, beforeSend?: () => void, timeoutMs = 10000): Promise<T> {
    // Even a toJSON hook must run before the synchronous admission boundary.
    const body = data === undefined ? undefined : JSON.stringify(data);
    return this.requestEncoded<T>(path, method, body, beforeSend, timeoutMs);
  }
  private async requestEncoded<T>(path: string, method: string, encoded: string | undefined, beforeSend?: (body: string | undefined) => void, timeoutMs = 10000): Promise<T> {
    const connection = await this.endpoint();
    return this.requestEncodedAt<T>(connection, path, method, encoded, beforeSend, timeoutMs);
  }
  /** No discovery or await before the synchronous gate and its one fetch. */
  private async requestEncodedAt<T>(connection: Connection, path: string, method: string, encoded: string | undefined, beforeSend?: (body: string | undefined) => void, timeoutMs = 10000): Promise<T> {
    const wireBody = encoded;
    // Reject thenable hooks as well as synchronous failures before HTTP dispatch.
    synchronousDispatchHook(() => beforeSend?.(wireBody));
    let response: Response;
    try { response = await fetch(connection.base + path, { method, headers: connection.headers, ...(wireBody === undefined ? {} : { body: wireBody }), signal: AbortSignal.timeout(timeoutMs), redirect: "error" }); }
    catch { this.invalidate(connection); throw new OpenCodeUnavailableError("OpenCode connection unavailable; execution state remains unconfirmed"); }
    // Refresh on the next request only. In particular, never replay mutations.
    if (!response.ok) {
      const auth = response.status === 401 || response.status === 403;
      if (auth || response.status >= 500) this.invalidate(connection);
      const Failure = auth || response.status >= 500 || response.status === 408 || response.status === 429 ? OpenCodeUnavailableError : OpenCodeError;
      // This fixed route identifies configuration failures without exposing query
      // strings, credentials, prompts, or untrusted server response bodies.
      const diagnostic = method === "POST" && path.split("?")[0] === "/api/rpc/sane-execution/configure"
        ? " (POST /api/rpc/sane-execution/configure; inspect the OpenCode server log for the configuration failure)" : "";
      throw new Failure(auth ? this.explicit ? "OpenCode authentication rejected; configure OPENCODE_TOKEN for the explicit URL" : "OpenCode managed authentication rejected; discovery will refresh on the next request" : `OpenCode API returned HTTP ${response.status}${diagnostic}`, response.status);
    }
    if (response.status === 204) return undefined as T;
    // Headers do not prove that the body arrived. A failed read is unavailable
    // observation (or an uncertain mutation), not successfully observed bad JSON.
    let body: string;
    try { body = await response.text(); }
    catch { this.invalidate(connection); throw new OpenCodeUnavailableError("OpenCode response body unavailable; execution state remains unconfirmed"); }
    try { return JSON.parse(body) as T; } catch { this.invalidate(connection); throw new OpenCodeError("OpenCode returned an invalid JSON response"); }
  }
  path(id: string) { return `/api/session/${encodeURIComponent(id)}`; }
  async connection(cwd: string) {
    try { await this.models(cwd); return { available: true, connected: true, state: "connected" as const }; }
    catch (error) { return { available: false, connected: false, state: "unavailable" as const, reason: error instanceof Error ? error.message : "OpenCode unavailable" }; }
  }
  async models(cwd: string): Promise<HarnessModel[]> {
    const response = await this.request<{ data: { id: string; providerID: string; name: string; enabled: boolean; variants: { id: string }[]; limit?: { context?: number } }[] }>(`/api/model?location%5Bdirectory%5D=${encodeURIComponent(cwd)}`);
    if (!Array.isArray(response.data)) throw new OpenCodeError("Unsupported OpenCode V2 model response");
    return response.data.filter(m => m.enabled).map(m => ({ id: `${m.providerID}/${m.id}`, name: m.name, efforts: m.variants.map(v => ({ id: v.id, name: v.id })), ...(typeof m.limit?.context === "number" && Number.isFinite(m.limit.context) && m.limit.context > 0 ? { contextWindow: m.limit.context } : {}) }));
  }
  model(value: string, effort?: string): ModelRef {
    const slash = value.indexOf("/");
    if (slash < 1 || slash === value.length - 1) throw new OpenCodeError("OpenCode model must be provider/model", 400);
    return { providerID: value.slice(0, slash), id: value.slice(slash + 1), ...(effort === undefined ? {} : { variant: effort }) };
  }
  async agents(cwd: string, timeoutMs = 10000): Promise<NativeAgent[]> {
    const response = await this.request<{ data: NativeAgent[] }>(`/api/agent?location%5Bdirectory%5D=${encodeURIComponent(cwd)}`, "GET", undefined, undefined, timeoutMs);
    const validModel = (m: ModelRef) => m && typeof m.id === "string" && !!m.id && typeof m.providerID === "string" && !!m.providerID && (m.variant === undefined || typeof m.variant === "string");
    if (!Array.isArray(response.data) || response.data.some(a => !a || typeof a.id !== "string" || !a.id || a.model !== undefined && !validModel(a.model))) throw new OpenCodeError("Unsupported OpenCode V2 agent response");
    return response.data;
  }
  /** Cold locations can return a valid but incomplete catalog before agent.updated.
   * Retry only an absent agent in a successful read; API/transport errors still fail
   * immediately, and native session creation and submission are never replayed. */
  private async readyAgent(cwd: string, id: string): Promise<NativeAgent> {
    const waitMs = 3000, deadline = performance.now() + waitMs;
    let attempts = 0, delay = 100;
    while (performance.now() < deadline) {
      attempts++;
      const agent = (await this.agents(cwd, Math.max(1, Math.ceil(deadline - performance.now())))).find(a => a.id === id);
      if (agent) return agent;
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(delay, remaining)));
      delay = Math.min(delay * 2, 500);
    }
    throw new OpenCodeError(`OpenCode did not expose agent ${id} for ${cwd} within ${waitMs} ms (${attempts} agent-list attempts); check service readiness and global or project agent configuration`, 400);
  }
  /** Profile model > agent model > native default. Explicit models never inherit another model's variant. */
  async resolveLaunch(cwd: string, input: { agent?: string; model?: string; effort?: string }): Promise<OpenCodeLaunch> {
    const agent = input.agent === undefined ? undefined : await this.readyAgent(cwd, input.agent);
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
  private promptPacket(id: string, commandId: string, text: string, delivery: "queue" | undefined, packet?: OpenCodePromptPacket) {
    const prepared = packet ?? prepareOpenCodePrompt(id, commandId, text, delivery);
    const body = prepared.body, actual = JSON.parse(body);
    if (prepared.sessionId !== id || actual.id !== commandId || actual.text !== text || actual.delivery !== delivery
      || Object.keys(actual).some(key => !["id", "text", "delivery"].includes(key))) throw new OpenCodeSourceMismatchError("Native prompt packet differs from the pinned submission");
    return body;
  }
  /** Preparation never submits a prompt. Keep the discovered URL and its own
   * credentials together in this private generation, not in evidence or DTOs. */
  async preparePromptSubmission(id: string, commandId: string, text: string, delivery: "queue" | undefined, packet: OpenCodePromptPacket, handoff = false): Promise<OpenCodePreparedPrompt> {
    if (handoff && delivery !== "queue") throw new OpenCodeSourceMismatchError("Native handoff requires explicit queue delivery");
    const body = this.promptPacket(id, commandId, text, delivery, packet);
    const connection = await this.endpoint();
    const path = this.path(id) + "/prompt";
    let used = false;
    return Object.freeze({
      send: (beforeSubmit: (body: string) => void) => {
        if (used) throw new OpenCodeError("Prepared native prompt already consumed; replay forbidden", 409);
        used = true;
        // requestEncodedAt enters beforeSubmit and fetch synchronously. Validation
        // after its promise resolves is observation, never a second admission.
        return this.requestEncodedAt<unknown>(connection, path, "POST", body, encoded => beforeSubmit(encoded!)).then(response => {
          if (handoff) {
            if (!response || typeof response !== "object" || Array.isArray(response) || !("data" in response)
              || !isQueuedHandoffAdmission(response.data, id, commandId)) throw new OpenCodeQueuedHandoffProtocolError("Native queue acknowledgement protocol mismatch; retain ownership for operator reconciliation; do not resend");
            return response.data;
          }
          const data = (response as { data?: OpenCodePromptAdmission } | null | undefined)?.data;
          if (data?.id !== commandId || !Number.isFinite(data.time?.created)) throw new OpenCodeError("OpenCode prompt acknowledgement mismatch; execution state unconfirmed");
          return data;
        });
      },
    });
  }
  async prompt(id: string, commandId: string, text: string, beforeSubmit?: (body: string) => void, delivery?: "queue", packet?: OpenCodePromptPacket) {
    const body = this.promptPacket(id, commandId, text, delivery, packet);
    const response = await this.requestEncoded<{ data: { id: string; time: { created: number } } }>(this.path(id) + "/prompt", "POST", body, encoded => beforeSubmit?.(encoded!));
    const data = response?.data;
    if (data?.id !== commandId || !Number.isFinite(data.time?.created)) throw new OpenCodeError("OpenCode prompt acknowledgement mismatch; execution state unconfirmed");
    return data;
  }
  /** Existing prompt endpoint, once, with explicit delivery. No idle lease,
   * selection, synthetic context, fallback or mutation retry. */
  async promptQueuedHandoff(id: string, commandId: string, text: string, beforeSubmit?: (body: string) => void, packet?: OpenCodePromptPacket): Promise<NativeQueuedHandoffAdmission> {
    const body = this.promptPacket(id, commandId, text, "queue", packet);
    const response = await this.requestEncoded<unknown>(this.path(id) + "/prompt", "POST", body, encoded => beforeSubmit?.(encoded!));
    // Validate the complete received envelope, including an empty 204 result.
    // Transport/body-read failures escape unchanged as uncertain availability.
    if (!response || typeof response !== "object" || Array.isArray(response) || !("data" in response)
      || !isQueuedHandoffAdmission(response.data, id, commandId)) throw new OpenCodeQueuedHandoffProtocolError("Native queue acknowledgement protocol mismatch; retain ownership for operator reconciliation; do not resend");
    return response.data;
  }
  /** Fresh binding read only: foreign activity after claim is allowed, but a
   * different identity/checkout is not. Native preference freezing is not claimed. */
  async preflightNativeSession(id: string, cwd: string) {
    const session = await this.session(id);
    if (session?.id !== id || session.location?.directory !== cwd) throw new OpenCodeSourceMismatchError("Native session identity or execution directory differs from the claimed conversation");
  }
  /** Migration proof only: never deletes, clears, or rewrites native context.
   * A missing/unsupported endpoint is not proof that an old entry is absent. */
  async assertUserContextChannelClean(id: string, cwd: string): Promise<void> {
    await this.preflightNativeSession(id, cwd);
    let result: { data: { key: string; value: unknown }[] };
    try {
      // This is the existing instruction-entry list/read endpoint used by the
      // historical standing-context delivery, not a new deletion protocol.
      result = await this.request(`/api/experimental/session/${encodeURIComponent(id)}/instructions/entries`);
    } catch (error) {
      if (error instanceof OpenCodeError && error.status === 404) throw new OpenCodeError("Native instruction-entry absence cannot be verified: read endpoint unavailable; user-context migration refused", 409);
      throw error;
    }
    if (!result || !Array.isArray(result.data) || result.data.some(entry => !entry || typeof entry !== "object" || Array.isArray(entry)
      || typeof entry.key !== "string" || !Object.hasOwn(entry, "value"))) throw new OpenCodeError("Native instruction-entry read is malformed; user-context migration refused", 409);
    if (result.data.some(entry => entry.key === "sane.context")) throw new OpenCodeError("Legacy native sane.context entry remains present; user-context migration refused without explicit supported cleanup", 409);
  }
  async configureCanonicalExecution(input: import("./canonical-agent-operations").OpenCodeExecutionConfiguration, guard: () => void, readOnly = false) {
    const response = await this.request<{ output?: { sessionID: string; agent: string; nativeChildren: string[] } }>(`/api/rpc/sane-execution/configure?location%5Bdirectory%5D=${encodeURIComponent(input.directory)}`, "POST", { input: { ...input, ...(readOnly ? { readOnly: true } : {}) } }, guard);
    guard();
    if (response?.output?.sessionID !== input.sessionID || response.output.agent !== input.agent || JSON.stringify(response.output.nativeChildren) !== JSON.stringify(input.nativeChildren.map(child => child.id))) throw new OpenCodeError("Canonical execution acknowledgement mismatch; prompt withheld");
    return response.output;
  }
  /** Disk configuration alone cannot establish which plugin/options the selected
   * service actually loaded. This RPC is observational and never creates a turn. */
  async assertSelectedWorkerRuntime(directory: string, selected: import("../../sane-cli/src/install-sane-agent-context-packages").SelectedNativeRuntime) {
    if (selected.registrationFile !== this.registrationFile || this.explicit) throw new OpenCodeSourceMismatchError("Selected worker runtime belongs to another managed source");
    const response = await this.request<{ output?: { schema: number; directory: string; pluginDirectory: string; registrationFile: string; appConnectionFile: string; tools: string[] } }>(
      `/api/rpc/sane-execution/runtime?location%5Bdirectory%5D=${encodeURIComponent(directory)}`, "POST", { input: {} });
    const actual = response?.output;
    if (!actual || actual.schema !== 1 || actual.directory !== directory || actual.pluginDirectory !== selected.pluginDirectory
      || actual.registrationFile !== selected.registrationFile || actual.appConnectionFile !== selected.appConnectionFile
      || !Array.isArray(actual.tools) || !["complete", "notify", "message_parent", "message"].every(op => actual.tools.includes(`sane_worker_${op}`))) {
      throw new OpenCodeSourceMismatchError("Loaded OpenCode worker runtime or App routing differs from the selected installation");
    }
  }
  /** Explicit user-requested, idle-only admission. Caller owns the idle gate and
   * persists request ID before this mutation and returned ID before observation.
   * Native may coalesce into a different pending ID; this is not rejection.
   * Never automatically retry, including after an invalid acknowledgement. */
  async compact(id: string, requestId: string, beforeSubmit?: () => void): Promise<NativeCompactAdmission> {
    if (!/^ses[a-zA-Z0-9_-]+$/.test(id) || !nativeMessageId(requestId)) throw new OpenCodeError("Invalid native compaction identity", 400);
    const { data } = await this.request<{ data: NativeCompactAdmission }>(this.path(id) + "/compact", "POST", { id: requestId, delivery: "queue" }, beforeSubmit);
    if (!data || !nativeMessageId(data.id) || data.sessionID !== id || data.type !== "compaction" || !["queue", "steer"].includes(data.delivery) || typeof data.time?.created !== "number" || !Number.isFinite(data.time.created) || data.time.created < 0 || !Number.isFinite(new Date(data.time.created).getTime())) throw new OpenCodeError("OpenCode compaction acknowledgement mismatch; admission remains unconfirmed; do not resend");
    return data;
  }
  async session(id: string) { return (await this.request<{ data: NativeSession }>(this.path(id))).data; }
  /** Read-only capability proof for an already-qualified worker-start invocation.
   * Base sessions may omit agent; the exact assistant tool message records it.
   * Never use permission.create here: an ask would create an approval request. */
  async parentCanMessageWorker(id: string, cwd: string, invocation: NativeWorkerInvocation): Promise<boolean> {
    if (!invocation.messageId) return false;
    const { data: message } = await this.request<{ data: NativeMessage }>(this.path(id) + `/message/${encodeURIComponent(invocation.messageId)}`);
    if (message?.id !== invocation.messageId || message.type !== "assistant" || typeof message.agent !== "string" || !message.agent
      || !Array.isArray(message.content) || !message.content.some(part => matchesOpenCodeWorkerPart("start", invocation, message.id, part))) return false;
    const [session, agent] = await Promise.all([
      this.session(id),
      this.request<{ location: { directory: string }; data: { id: string; permissions: unknown } }>(`/api/agent/${encodeURIComponent(message.agent)}?location%5Bdirectory%5D=${encodeURIComponent(cwd)}`),
    ]);
    if (session?.id !== id || session.location?.directory !== cwd || session.agent !== undefined && session.agent !== message.agent
      || agent?.location?.directory !== cwd || agent.data?.id !== message.agent || !Array.isArray(agent.data.permissions)
      || session.permissions !== undefined && !Array.isArray(session.permissions)) return false;
    return openCodePermissionAllows([...agent.data.permissions, ...(session.permissions ?? []) as unknown[]], "sane_worker_message");
  }
  async boundSaneSession(id: string): Promise<string | null> {
    const session = await this.session(id);
    if (session?.id !== id) throw new OpenCodeError("Native SANE session binding identity differs from the conversation", 409);
    const current = session.metadata?.saneContext;
    if (!current || typeof current !== "object" || !("sessionID" in current) || current.sessionID !== id) return null;
    if (!("text" in current) || typeof current.text !== "string") throw new OpenCodeError("Native SANE session binding is malformed", 409);
    return current.text;
  }
  async fork(id: string, cwd: string, boundary: string, before?: string, beforeSend?: () => void) {
    const { data } = await this.request<{ data: NativeSession & { fork?: { sessionID: string; boundary: { type: string; messageID: string } } } }>(this.path(id) + "/fork", "POST", before ? { before } : {}, beforeSend);
    if (!data || !/^ses[a-zA-Z0-9_-]+$/.test(data.id) || data.id === id || data.location?.directory !== cwd || data.fork?.sessionID !== id || data.fork.boundary.type !== (before ? "before" : "through") || data.fork.boundary.messageID !== (before ?? boundary)) throw new OpenCodeError("Native fork acknowledgement mismatch; do not retry creation", 409);
    return data;
  }
  /** Recover an admission from confirmed Session.Info, never today's agent defaults.
   * Reusable for assistant/worker admissions whose App metadata was not committed. */
  async recoverLaunch(id: string, cwd: string, expectedAgent: string): Promise<OpenCodeLaunch> {
    const session = await this.session(id);
    if (!session || session.id !== id || session.location?.directory !== cwd) throw new OpenCodeSourceMismatchError("Cannot recover launch: native session identity or checkout differs from the admission");
    if (session.agent !== expectedAgent) throw new OpenCodeError("Cannot recover launch: native selected agent is missing or differs from the requested agent; reconcile the admission", 409);
    const model = session.model;
    if (!model || typeof model.id !== "string" || !model.id || typeof model.providerID !== "string" || !model.providerID || model.variant !== undefined && (typeof model.variant !== "string" || !model.variant)) throw new OpenCodeError("Cannot recover launch: native selected model/variant is unavailable or invalid; reconcile the admission", 409);
    if (!validModel(`${model.providerID}/${model.id}`) || model.variant !== undefined && !validVariant(model.variant)) throw new OpenCodeError("Cannot recover launch: native model/variant cannot be represented in App metadata; reconcile the admission", 409);
    return { agent: session.agent, model: { ...model } };
  }
  async activity(id: string, cwd: string) {
    const [session, active, inbox] = await Promise.all([
      this.session(id), this.request<{ data: Record<string, { type: string }> }>("/api/session/active"),
      this.request<{ data: NativeInput[] }>(this.path(id) + "/inbox"),
    ]);
    if (session?.id !== id || session.location?.directory !== cwd) throw new OpenCodeSourceMismatchError("Native session identity or execution directory differs from the pinned conversation");
    if (!active.data || !Array.isArray(inbox.data)) throw new OpenCodeError("Unsupported native activity response");
    // Startup context waits for the first prompt; it is not foreign input.
    return { session, active: !!active.data[id], pending: inbox.data.some(m => !(m.type === "synthetic" && saneStartupContext(m.payload?.metadata))) };
  }
  async assertIdle(id: string, cwd: string) {
    const state = await this.activity(id, cwd);
    if (state.active || state.pending) throw new OpenCodeError("Native conversation is active or has pending input; reconcile and finish it in its native harness before sending", 409);
  }
  async history(id: string, cwd: string, options?: { requireUnreverted?: true }) {
    const before = await this.activity(id, cwd);
    if (options?.requireUnreverted && before.session.revert != null) throw new OpenCodeUnavailableError("Native history is reverted; unreverted context prefix cannot be qualified");
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
        if (options?.requireUnreverted && after.session.revert != null) throw new OpenCodeUnavailableError("Native history is reverted; unreverted context prefix cannot be qualified");
        // Pagination is not a transactional native snapshot. Report activity and
        // reject a moving transcript rather than importing a mixed history.
        if (before.session.time.updated !== after.session.time.updated) throw new OpenCodeError("Native history changed during reconciliation; retry after native activity settles", 409);
        const rawMessages = messages.reverse();
        return { rawMessages, messages: rawMessages.map(normalizeMessage).filter((m): m is MessageSnapshot => !!m), activity: after.active || after.pending ? "active" as const : "idle" as const };
      }
    }
    throw new OpenCodeError("History exceeds 10,000-message import budget; no partial import");
  }
  async snapshot(id: string, commandId: string, cwd?: string, policy?: "native-queued-handoff"): Promise<NativeCommandSnapshot> {
    // A queued command is not committed history yet. Check its exact inbox
    // identity first, so waiting/cancellation never walks an unrelated backlog.
    const [initialSession, initialInbox] = await Promise.all([
      this.session(id), this.request<{ data: NativeInput[] }>(this.path(id) + "/inbox"),
    ]);
    if (!initialSession?.time || !Array.isArray(initialInbox.data) || initialInbox.data.some(input => !input || typeof input !== "object" || typeof input.id !== "string")) throw new OpenCodeCommandProtocolError("Unsupported OpenCode V2 execution response");
    if (initialSession.id !== id || cwd !== undefined && initialSession.location?.directory !== cwd) throw new OpenCodeSourceMismatchError("Native session identity or directory changed; execution remains unconfirmed");
    const initialInput = policy ? strictInbox(initialInbox.data, id, commandId) : initialInbox.data.find(message => message.id === commandId);
    if (initialInput) return { messages: [], pending: true, ...(policy ? { pendingInput: initialInput } : {}) };
    // Native message IDs are unique storage keys. Read through the exact anchor,
    // checking fetched pages for contradictory identities, not all older turns.
    // Scanning unrelated history makes long-lived sessions eventually hit the
    // page budget even when their latest command and terminal fit in one page.
    const messages: NativeMessage[] = []; let cursor: string | undefined; let found = false;
    const deadline = Date.now() + 15000;
    for (let page = 0; page < 100; page++) {
      if (Date.now() > deadline) throw new OpenCodeUnavailableError("Native observation exceeded its 15-second page budget; state remains unconfirmed");
      const result = await this.request<Page>(this.path(id) + `/message?limit=100&${cursor ? `cursor=${encodeURIComponent(cursor)}` : "order=desc"}`);
      if (!Array.isArray(result.data) || !result.cursor || result.data.some(message => !message || typeof message !== "object" || typeof message.id !== "string" || typeof message.type !== "string" || !Number.isFinite(message.time?.created))) throw new OpenCodeCommandProtocolError("Unsupported OpenCode V2 message response");
      const matches = result.data.filter(m => m.id === commandId);
      if (matches.length > 1 || found && matches.length) throw new OpenCodeCommandProtocolError("Exact native command identity conflicts with native history; operator reconciliation required");
      if (!found) {
        const index = result.data.findIndex(m => m.id === commandId);
        messages.push(...(index < 0 ? result.data : result.data.slice(0, index + 1)));
        if (index >= 0) found = true;
      }
      cursor = result.cursor.next ?? undefined;
      if (found || !cursor) break;
      if (page === 99) throw new OpenCodeUnavailableError("OpenCode history reconciliation exceeded its page budget");
    }
    const [session, active, inbox] = await Promise.all([
      this.session(id), this.request<{ data: Record<string, { type: "running" }> }>("/api/session/active"),
      this.request<{ data: NativeInput[] }>(this.path(id) + "/inbox"),
    ]);
    if (!session?.time || !active.data || !Array.isArray(inbox.data) || inbox.data.some(input => !input || typeof input !== "object" || typeof input.id !== "string")) throw new OpenCodeCommandProtocolError("Unsupported OpenCode V2 execution response");
    if (session.id !== id || (cwd !== undefined && session.location?.directory !== cwd)) throw new OpenCodeSourceMismatchError("Native session identity or directory changed; execution remains unconfirmed");
    if (initialSession.time.created !== session.time.created || initialSession.time.updated !== session.time.updated)
      throw new OpenCodeUnavailableError("Native history changed during command observation; retrying without resending");
    if (initialSession.revert != null || session.revert != null) throw new OpenCodeUnavailableError("Native history is reverted; original command completion remains unconfirmed");
    const input = policy ? strictInbox(inbox.data, id, commandId) : inbox.data.find(m => m.id === commandId), pending = !!input;
    const ordered = found ? messages.reverse() : [];
    if (ordered.some(message => message.id === commandId && message.type !== "user")
      || ordered.filter(message => message.id === commandId).length > 1) throw new OpenCodeCommandProtocolError("Exact native command identity conflicts with native history; operator reconciliation required");
    const bounded = commandSnapshot(ordered, commandId);
    const command = ordered.find(message => message.id === commandId);
    const currentInputId = command ? ordered.findLast(message => commandBoundary(message, command))?.id : undefined;
    // Resolve unknown synthetic boundaries automatically only from a sealed,
    // quiescent execution interval. This is stronger than notice allowlists and
    // remains valid when retry/compaction/context wording changes upstream.
    if (bounded.boundary?.type === "synthetic" && !active.data[id] && !inbox.data.length && !initialInbox.data.length) {
      const settlement = settleCommandInterval(ordered, commandId, initialSession, session);
      if (settlement) {
        const [confirmed, confirmedActive, confirmedInbox] = await Promise.all([
          this.session(id), this.request<{ data: Record<string, { type: string }> }>("/api/session/active"),
          this.request<{ data: NativeInput[] }>(this.path(id) + "/inbox"),
        ]);
        if (!confirmed || !confirmedActive.data || !Array.isArray(confirmedInbox.data)) throw new OpenCodeUnavailableError("Native settlement confirmation unavailable");
        if (confirmed.id !== id || cwd !== undefined && confirmed.location?.directory !== cwd) throw new OpenCodeSourceMismatchError("Native source changed during settlement");
        if (!confirmedActive.data[id] && !confirmedInbox.data.length && settleCommandInterval(ordered, commandId, session, confirmed))
          return { messages: ordered.slice(0, ordered.findIndex(message => message.id === settlement.terminalMessageId) + 1), outcome: settlement.outcome, pending: false, settlement };
        throw new OpenCodeUnavailableError("Native execution changed during settlement; retrying without resending");
      }
    }
    // Session.outcome belongs to the latest turn, not necessarily this command.
    // Later external activity cannot overwrite a recorded command boundary.
    return { messages: bounded.messages, outcome: pending ? undefined : bounded.outcome, pending, currentInputId, ...(policy && input ? { pendingInput: input } : {}), ...(bounded.boundary ? { boundary: bounded.boundary } : {}) };
  }
  async observeCommand(id: string, commandId: string, cwd: string, policy?: "native-queued-handoff"): Promise<NativeCommandSnapshot & { observation: NativeCommandObservation }> {
    let snapshot: NativeCommandSnapshot;
    try { snapshot = await this.snapshot(id, commandId, cwd, policy); }
    catch (error) {
      if (error instanceof OpenCodeCommandProtocolError) return { messages: [], pending: false, observation: { kind: "protocol-contradiction", reason: error.message } };
      if (!(error instanceof OpenCodeUnavailableError)) throw error;
      return { messages: [], pending: false, observation: { kind: "unavailable", reason: error.message } };
    }
    let observation: NativeCommandObservation;
    if (snapshot.pending) observation = policy && !isQueuedHandoffAdmission(snapshot.pendingInput, id, commandId)
      ? { kind: "protocol-contradiction", reason: "Original pending input contradicts the strict native queue receipt protocol; operator reconciliation required; do not resend" }
      : { kind: "pending", input: snapshot.pendingInput };
    else if (snapshot.boundary) observation = { kind: "foreign-boundary", boundary: snapshot.boundary };
    else if (snapshot.outcome === "succeeded" || snapshot.outcome === "failed" || snapshot.outcome === "interrupted") observation = { kind: "exact-terminal", outcome: snapshot.outcome };
    else observation = { kind: "termination-uncertain" };
    return { ...snapshot, observation };
  }
  /** Observe only the exact admitted compact input. No user-message anchor,
   * session outcome, idle heuristic, or resend. Activity is reported separately
   * from ownership of this input; pending disappearance is never success. */
  async compactionSnapshot(id: string, admittedId: string, cwd?: string): Promise<NativeCompactionObservation> {
    if (!nativeMessageId(admittedId)) throw new OpenCodeError("Invalid admitted compaction identity", 400);
    const messages: NativeMessage[] = []; let cursor: string | undefined;
    const deadline = Date.now() + 15000;
    for (let page = 0; page < 100; page++) {
      if (Date.now() > deadline) throw new OpenCodeError("Compaction observation exceeded its page budget; state remains unconfirmed");
      const result = await this.request<Page>(this.path(id) + `/message?limit=100&${cursor ? `cursor=${encodeURIComponent(cursor)}` : "order=desc"}`);
      if (!Array.isArray(result.data) || !result.cursor) throw new OpenCodeError("Unsupported native compaction history response");
      messages.push(...result.data);
      if (JSON.stringify(messages).length > 16 * 1024 * 1024) throw new OpenCodeError("Compaction history exceeds 16 MiB observation budget");
      if (result.data.some(m => m.id === admittedId)) break;
      cursor = result.cursor.next ?? undefined;
      if (!cursor) break;
      if (page === 99) throw new OpenCodeError("Compaction observation exceeded its page budget; state remains unconfirmed");
    }
    const [session, active, inbox] = await Promise.all([
      this.session(id), this.request<{ data: Record<string, { type: string }> }>("/api/session/active"),
      this.request<{ data: { id: string; sessionID?: string; type?: string }[] }>(this.path(id) + "/inbox"),
    ]);
    if (!session?.time || !active.data || !Array.isArray(inbox.data)) throw new OpenCodeError("Unsupported native compaction activity response");
    if (session.id !== id || cwd !== undefined && session.location?.directory !== cwd) throw new OpenCodeSourceMismatchError("Native compaction session identity or directory changed; state remains unconfirmed");
    const input = inbox.data.find(m => m.id === admittedId);
    if (input && (input.type !== "compaction" || input.sessionID !== id)) throw new OpenCodeError("Exact admitted input is not this session's compaction; state remains unconfirmed");
    const exact = compactionSnapshot(messages, admittedId);
    return { ...exact, pending: !!input, active: !!active.data[id], observed: !!input || exact.messages.length > 0 };
  }
  async cancelInput(id: string, commandId: string, beforeCancel?: () => void, policy?: "native-queued-handoff"): Promise<boolean> {
    if (!/^ses[a-zA-Z0-9_-]+$/.test(id) || !nativeMessageId(commandId)) throw new OpenCodeError("Invalid queued input identity", 400);
    const { data } = await this.request<{ data: NativeInput[] }>(this.path(id) + "/inbox");
    if (!Array.isArray(data)) throw new OpenCodeError("Unsupported native inbox response");
    const input = policy ? strictInbox(data, id, commandId) : data.find(value => value.id === commandId);
    if (!input) return false;
    if (input.sessionID !== id || input.type !== "user") throw new OpenCodeError("Exact queued input is not this session's prompt; cancellation remains unconfirmed");
    if (policy && !isQueuedHandoffAdmission(input, id, commandId)) throw new OpenCodeCommandProtocolError("Exact pending input changed its native queue receipt before cancellation; operator reconciliation required");
    await this.request(this.path(id) + `/inbox/${encodeURIComponent(commandId)}`, "DELETE", undefined, beforeCancel);
    // DELETE is a no-op when consumption won the race. Check exact history
    // without walking the backlog; these separate reads are not an atomic
    // inbox-to-history visibility guarantee.
    try {
      const delivered = await this.request<{ data: NativeMessage }>(this.path(id) + `/message/${encodeURIComponent(commandId)}`);
      if (delivered.data?.id !== commandId || delivered.data.type !== "user") throw new OpenCodeError("Queued input delivery identity is unconfirmed");
      return false;
    } catch (error) {
      if (!(error instanceof OpenCodeError) || error.status !== 404) throw error;
    }
    const after = await this.request<{ data: NativeInput[] }>(this.path(id) + "/inbox");
    if (!Array.isArray(after.data)) throw new OpenCodeError("Unsupported native inbox response");
    if (policy) strictInbox(after.data, id, commandId);
    // Neither DELETE nor separate absence reads certify that this input was
    // removed before native consumption. No command-scoped cancellation receipt
    // exists on this endpoint, so retain ownership until exact terminal history.
    return false;
  }
  async cancel(id: string, beforeCancel?: () => void) { return this.request<{ interrupted: boolean }>(this.path(id) + "/interrupt?resume=false", "POST", undefined, beforeCancel); }
  async interactions(id: string): Promise<Interaction[]> {
    const [permissions, forms] = await Promise.all([
      this.request<{ data: { id: string; action: string; resources: string[]; message?: string }[] }>(this.path(id) + "/permission"),
      this.request<{ data: { id: string; title: string; fields: FormField[] }[] }>(this.path(id) + "/form"),
    ]);
    return [...permissions.data.map(p => ({ id: p.id, type: "permission" as const, title: p.action, description: [p.message, ...p.resources].filter(Boolean).join("\n"), options: [{ id: "once", name: "Allow once" }, { id: "always", name: "Always allow" }, { id: "reject", name: "Reject" }] })), ...forms.data.map(f => ({ id: f.id, type: "question" as const, title: f.title, fields: f.fields }))];
  }
  /** Optional conversation admission guard runs through request's synchronous
   * hook after discovery/encoding, immediately before either native mutation. */
  async reply(id: string, interactionId: string, reply: InteractionReply, beforeReply?: () => void) {
    if (!reply || (reply.type !== "permission" && reply.type !== "question")) throw new OpenCodeError("Invalid interaction reply type", 400);
    const pending = (await this.interactions(id)).find(i => i.id === interactionId && i.type === reply.type);
    if (!pending) throw new OpenCodeError("Unknown pending interaction", 404);
    if (reply.type === "permission") {
      if (!["once", "always", "reject"].includes(reply.decision) || (reply.message !== undefined && typeof reply.message !== "string")) throw new OpenCodeError("Invalid permission decision", 400);
      await this.request(this.path(id) + `/permission/${encodeURIComponent(interactionId)}/reply`, "POST", { decision: reply.decision, ...(reply.message === undefined ? {} : { message: reply.message }) }, beforeReply);
    } else if (reply.type === "question") {
      if (!reply.answer || typeof reply.answer !== "object" || Array.isArray(reply.answer)) throw new OpenCodeError("Invalid form answer", 400);
      await this.request(this.path(id) + `/form/${encodeURIComponent(interactionId)}/reply`, "POST", { answer: reply.answer }, beforeReply);
    }
  }
}

export function commandSnapshot(history: NativeMessage[], commandId: string): { messages: NativeMessage[]; outcome?: string; boundary?: NativeCommandBoundary } {
  const start = history.findIndex(m => m.id === commandId && m.type === "user");
  if (start < 0) return { messages: [] as NativeMessage[], outcome: undefined as string | undefined };
  const messages = [history[start]!];
  for (const message of history.slice(start + 1)) {
    // Instruction context and an evidenced restart preserve this claim. Another
    // input still makes attribution ambiguous; never borrow its terminal outcome.
    const boundary = commandBoundary(message, history[start]!);
    if (boundary) return { messages, boundary };
    messages.push(message);
    if (message.type === "idle") return { messages, outcome: ["succeeded", "failed", "interrupted"].includes(message.outcome ?? "") ? message.outcome : undefined };
  }
  return { messages, outcome: undefined };
}

/** Pure exact-ID reconciliation, also usable with a bounded imported history.
 * Different admitted and requested IDs must already have been persisted by the
 * caller. A conflicting repeated native ID is ambiguous, never completion. */
export function compactionSnapshot(history: readonly NativeMessage[], admittedId: string): NativeCompactionProjection {
  const matches = history.filter(m => m.id === admittedId);
  if (matches.some(m => m.type !== "compaction") || matches.some(m => JSON.stringify(m) !== JSON.stringify(matches[0]))) throw new OpenCodeError("Conflicting native compaction identity; state remains unconfirmed");
  const message = matches[0];
  if (!message) return { messages: [] };
  const compaction = normalizeMessage(message)?.compaction;
  const outcome = compaction?.lifecycle === "completed" ? "succeeded" : compaction?.lifecycle === "failed" ? "failed" : compaction?.lifecycle === "skipped" ? "skipped" : undefined;
  return { messages: [message], compaction, outcome };
}

export function normalizeMessage(message: NativeMessage): MessageSnapshot | undefined {
  if (message.retry !== undefined && (!message.retry || typeof message.retry !== "object" || Array.isArray(message.retry)
    || !Number.isSafeInteger(message.retry.attempt) || message.retry.attempt < 1
    || !Number.isFinite(message.retry.at) || message.retry.at < 0 || !Number.isFinite(new Date(message.retry.at).getTime())
    || !message.retry.error || typeof message.retry.error !== "object" || Array.isArray(message.retry.error)
    || typeof (message.retry.error as Record<string, unknown>).type !== "string"
    || typeof (message.retry.error as Record<string, unknown>).message !== "string")) throw new OpenCodeError("Invalid native retry metadata");
  const model = message.model?.providerID && message.model.id ? `${message.model.providerID}/${message.model.id}` : undefined;
  // Preserve context boundaries for the usage indicator without rendering them
  // as conversation turns or counting the compaction request's token usage.
  if (message.type === "compaction") {
    if (!nativeMessageId(message.id) || typeof message.time?.created !== "number" || !Number.isFinite(message.time.created) || message.time.created < 0 || !Number.isFinite(new Date(message.time.created).getTime())) throw new OpenCodeError("Invalid native compaction message identity or timestamp");
    if (message.time.completed !== undefined && (typeof message.time.completed !== "number" || !Number.isFinite(message.time.completed) || message.time.completed < message.time.created || !Number.isFinite(new Date(message.time.completed).getTime()))) throw new OpenCodeError("Invalid native compaction completion timestamp");
    if (message.cost !== undefined && (typeof message.cost !== "number" || !Number.isFinite(message.cost) || message.cost < 0)) throw new OpenCodeError("Invalid native compaction summarizer cost");
    for (const value of [message.preTokens, message.postTokens, message.durationMs]) if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new OpenCodeError("Invalid native compaction metric");
    const lifecycle: CompactionLifecycle = message.status === "failed" || message.error !== undefined ? "failed" : ["requested", "running", "completed", "skipped"].includes(message.status ?? "") ? message.status as CompactionLifecycle : "unconfirmed";
    const createdAt = new Date(message.time.created).toISOString();
    const compaction: CompactionMetadata = { nativeId: message.id, trigger: message.reason === "auto" || message.reason === "manual" ? message.reason : "unknown", lifecycle, startedAt: createdAt,
      ...(message.time.completed !== undefined && message.time.completed >= message.time.created ? { endedAt: new Date(message.time.completed).toISOString() } : {}),
      ...(typeof message.summary === "string" ? { summary: message.summary } : {}),
      ...(message.error !== undefined ? { error: message.error } : {}),
      ...(message.cost !== undefined || message.tokens !== undefined ? { summaryUsage: { cost: message.cost, tokens: message.tokens } } : {}),
      ...Object.fromEntries(["preTokens", "postTokens", "durationMs"].flatMap(key => { const v = message[key as "preTokens" | "postTokens" | "durationMs"]; return typeof v === "number" && Number.isFinite(v) && v >= 0 ? [[key, v]] : []; })),
    };
    return { messageId: message.id, role: "system", parts: [], status: lifecycle === "completed" ? "completed" : lifecycle === "failed" ? "failed" : lifecycle === "running" || lifecycle === "requested" ? "running" : "unknown", createdAt, ...(model ? { model } : {}), ...(lifecycle === "completed" ? { contextReset: true } : {}), compaction, ...(message.error !== undefined ? { error: message.error } : {}) };
  }
  if (message.type === "model-switched") return { messageId: message.id, role: "system", parts: [], status: "completed", createdAt: new Date(message.time.created).toISOString(), ...(model ? { model } : {}) };
  if (!["user", "assistant", "system", "synthetic"].includes(message.type)) return;
  if (message.type === "synthetic" && saneStartupContext(message.metadata)) return;
  if (message.type === "synthetic" && message.metadata?.source === "shell" && typeof message.metadata.shellID === "string" && typeof message.metadata.state === "string") {
    return { messageId: message.id, role: "system", parts: [{ id: `${message.id}:text`, type: "text", text: message.text ?? "" }], status: "completed", createdAt: new Date(message.time.created).toISOString(),
      nativeShellResult: { shellId: message.metadata.shellID, state: message.metadata.state,
        ...(typeof message.metadata.exit === "number" ? { exit: message.metadata.exit } : {}), ...(message.metadata.truncated === true ? { truncated: true } : {}) } };
  }
  if (message.type === "synthetic" && message.metadata?.source === "subagent" && typeof message.metadata.childID === "string" && /^ses[a-zA-Z0-9_-]+$/.test(message.metadata.childID) && typeof message.metadata.state === "string") {
    return { messageId: message.id, role: "system", parts: [{ id: `${message.id}:text`, type: "text", text: message.text ?? "" }], status: "completed", createdAt: new Date(message.time.created).toISOString(),
      nativeSubagentResult: { sessionId: message.metadata.childID, state: message.metadata.state, ...(typeof message.metadata.agent === "string" ? { agent: message.metadata.agent } : {}) } };
  }
  const parts: MessagePart[] = message.type === "assistant" ? (message.content ?? []).flatMap((part, i): MessagePart[] => {
    const id = part.id ?? `${message.id}:part:${i}`;
    if (part.type === "text" || part.type === "reasoning") return [{ id, type: part.type, text: part.text ?? "" }];
    if (part.type === "tool") {
      const child = part.name === "subagent" ? part.state?.metadata?.sessionID : undefined;
      return [{ id, type: "tool", name: part.name ?? "tool", status: part.state?.status ?? "streaming", input: part.state?.input, output: part.state?.content, error: part.state?.error,
        ...(typeof child === "string" && /^ses[a-zA-Z0-9_-]+$/.test(child) ? { nativeSubagentSessionId: child } : {}) }];
    }
    return [];
  }) : [{ id: `${message.id}:text`, type: "text", text: message.text ?? "" }];
  // Retry errors are attempt diagnostics until the assistant message completes.
  // Keep terminal retry evidence without projecting it as ongoing recovery.
  const retrying = message.type === "assistant" && message.time.completed === undefined && !!message.retry;
  return { messageId: message.id, role: message.type === "assistant" ? "assistant" : message.type === "user" ? "user" : "system", parts, status: retrying ? "running" : message.error ? "failed" : message.type !== "assistant" || message.time.completed !== undefined ? "completed" : "running", createdAt: new Date(message.time.created).toISOString(), ...(model ? { model } : {}), ...(message.cost !== undefined || message.tokens !== undefined ? { usage: { cost: message.cost, tokens: message.tokens } } : {}), ...(message.error ? { error: message.error } : {}), ...(message.retry ? { retry: message.retry } : {}) };
}
