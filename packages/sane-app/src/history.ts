import { isAbsolute } from "node:path";
import type { Harness } from "./oc-contract";

export type Status = "running" | "completed" | "failed" | "interrupted";
export type Session = { sessionId: string; harness?: Harness; nativeSessionId?: string; authorityId?: string; cwd: string; lastStatus: Status | "unknown"; lastRunId: string | null; title?: string; hidden?: boolean; model?: string; effort?: string; attachment?: { state: "pending" | "ready"; source: string; error?: string } };
export const efforts = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = typeof efforts[number];
export const validModel = (v: unknown): v is string => typeof v === "string" && v.length <= 200 && /^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]*$/.test(v);
export const validEffort = (v: unknown): v is Effort => typeof v === "string" && (efforts as readonly string[]).includes(v);
export type Run = { runId: string; sessionId: string; cwd: string; status: Status; createdAt: string; endedAt?: string; model?: string; effort?: string; nativeCommandId?: string; nativePhase?: "preparing" | "sending" | "accepted"; nativeAcceptedAt?: number };
export type Event = { seq: number; time: string; runId: string; sessionId: string; kind: "stdout" | "stderr" | "hook" | "status" | "submission" | "message"; data: unknown };
export type Metadata = { sessions: Session[]; runs: Run[]; reconciliationRequired: boolean };

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
export const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
export const validVariant = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200 && !/[\x00-\x1f]/.test(v);
const status = (v: unknown): v is Status => typeof v === "string" && ["running", "completed", "failed", "interrupted"].includes(v);
const timestamp = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
const cwd = (v: unknown) => typeof v === "string" && isAbsolute(v) && !v.includes("\0");

export function validateOwner(value: unknown): { pid: number } {
  if (!object(value) || !Number.isSafeInteger(value.pid) || value.pid <= 0 || value.pid > 2147483647) throw new Error("Invalid owner.lock schema; operator reconciliation required");
  return { pid: value.pid };
}

export function validateMetadata(value: unknown): Metadata {
  const fail = (): never => { throw new Error("Corrupt metadata: invalid schema or session/run relationship"); };
  if (!object(value) || !Array.isArray(value.sessions) || !Array.isArray(value.runs) || typeof value.reconciliationRequired !== "boolean") return fail();
  const sessions = new Map<string, Session>(), runs = new Map<string, Run>();
  const nativeIds = new Set<string>();
  for (const s of value.sessions) {
    if (!object(s) || !uuid(s.sessionId) || !cwd(s.cwd) || sessions.has(s.sessionId)) return fail();
    if (s.attachment !== undefined && (!object(s.attachment) || !["pending", "ready"].includes(s.attachment.state) || typeof s.attachment.source !== "string" || !s.attachment.source || (s.attachment.error !== undefined && typeof s.attachment.error !== "string"))) return fail();
    if (s.lastRunId === null ? s.lastStatus !== "unknown" : !uuid(s.lastRunId) || !status(s.lastStatus)) return fail();
    if (s.harness !== "claude-code" && s.harness !== "opencode") return fail();
    if (s.harness === "opencode" ? typeof s.nativeSessionId !== "string" || !/^ses[a-zA-Z0-9_-]+$/.test(s.nativeSessionId) : !uuid(s.nativeSessionId)) return fail();
    if (typeof s.authorityId !== "string" || !new RegExp(`^sane-native-v1:${s.harness === "opencode" ? "oc" : "cc"}:[a-f0-9]{64}$`).test(s.authorityId)) return fail();
    if (s.title !== undefined && (typeof s.title !== "string" || !s.title.trim() || s.title.includes("\n") || s.title.length > 200)) return fail();
    if (s.hidden !== undefined && typeof s.hidden !== "boolean") return fail();
    // Conversation-level model defaults. Absent on pre-migration records;
    // never persisted as empty (empty means native default at submit time).
    // Effort shape follows the session harness, mirroring run validation below.
    if (s.model !== undefined && !validModel(s.model)) return fail();
    if (s.effort !== undefined && !(s.harness === "opencode" ? validVariant(s.effort) : validEffort(s.effort))) return fail();
    const key = JSON.stringify([s.harness, s.authorityId, s.nativeSessionId]);
    if (nativeIds.has(key)) return fail();
    nativeIds.add(key);
    sessions.set(s.sessionId, s as Session);
  }
  for (const r of value.runs) {
    if (!object(r) || !uuid(r.runId) || !uuid(r.sessionId) || !cwd(r.cwd) || !status(r.status) || !timestamp(r.createdAt) || runs.has(r.runId)) return fail();
    if (r.status === "running" ? r.endedAt !== undefined : !timestamp(r.endedAt)) return fail();
    if (r.endedAt !== undefined && Date.parse(r.endedAt) < Date.parse(r.createdAt)) return fail();
    if ((r.model !== undefined && !validModel(r.model)) || (r.effort !== undefined && !(sessions.get(r.sessionId)?.harness === "opencode" ? validVariant(r.effort) : validEffort(r.effort)))) return fail();
    if (sessions.get(r.sessionId)?.harness === "opencode" && (typeof r.nativeCommandId !== "string" || !/^msg_[a-zA-Z0-9_-]+$/.test(r.nativeCommandId) || !["preparing", "sending", "accepted"].includes(r.nativePhase))) return fail();
    if (sessions.get(r.sessionId)?.cwd !== r.cwd) return fail();
    if (r.status === "running" && sessions.get(r.sessionId)?.lastRunId !== r.runId) return fail();
    runs.set(r.runId, r as Run);
  }
  const running = value.runs.filter((r: Run) => r.status === "running");
  if (new Set(running.map((r: Run) => r.sessionId)).size !== running.length) return fail();
  for (const s of sessions.values()) {
    const history = value.runs.filter((r: Run) => r.sessionId === s.sessionId);
    const last = history.at(-1);
    if (!last ? s.lastRunId !== null : last.runId !== s.lastRunId || last.status !== s.lastStatus) return fail();
  }
  return value as Metadata;
}

export function decodeLog(raw: string, run: Run): { events: Event[]; repaired?: string } {
  const events: Event[] = [];
  const lines = raw.split("\n");
  let repaired = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (i === lines.length - 1 && line === "") continue;
    let event: unknown;
    try { event = JSON.parse(line); }
    catch {
      // Only a final unterminated JSON object may be a torn append. Complete
      // records with bad schema, blank lines, and malformed terminated records
      // are corruption, never silently discarded.
      if (i === lines.length - 1 && line.trimStart().startsWith("{") && incompleteObject(line)) { repaired = true; break; }
      throw new Error(`Corrupt event log for ${run.runId}: invalid JSON at line ${i + 1}`);
    }
    if (!object(event) || !Number.isSafeInteger(event.seq) || event.seq <= (events.at(-1)?.seq ?? 0) || !timestamp(event.time) || event.runId !== run.runId || event.sessionId !== run.sessionId || !["stdout", "stderr", "hook", "status", "submission", "message"].includes(event.kind) || !("data" in event)) throw new Error(`Corrupt event log for ${run.runId}: invalid record at line ${i + 1}`);
    events.push(event as Event);
  }
  if (!events.length) throw new Error(`Corrupt event log for ${run.runId}: missing historical records`);
  return { events, ...(repaired || !raw.endsWith("\n") ? { repaired: events.map(e => JSON.stringify(e) + "\n").join("") } : {}) };
}

// Distinguish a valid JSON prefix from malformed input without depending on
// engine-specific JSON.parse exception text.
function incompleteObject(text: string): boolean {
  const incomplete = Symbol(), invalid = Symbol(); let at = 0;
  function peek() { if (at >= text.length) throw incomplete; return text[at]!; }
  function whitespace() { while (at < text.length && /[\t\r\n ]/.test(text[at]!)) at++; }
  function take(c: string) { if (peek() !== c) throw invalid; at++; }
  function string() {
    take('"');
    while (true) {
      const c = peek(); at++;
      if (c === '"') return;
      if (c.charCodeAt(0) < 32) throw invalid;
      if (c === "\\") {
        const escape = peek(); at++;
        if (escape === "u") { for (let n = 0; n < 4; n++) { if (!/[0-9a-f]/i.test(peek())) throw invalid; at++; } }
        else if (!'"\\/bfnrt'.includes(escape)) throw invalid;
      }
    }
  }
  function value(depth: number) {
    if (depth > 512) throw invalid;
    whitespace(); const c = peek();
    if (c === '"') return string();
    if (c === "{" || c === "[") {
      at++; whitespace(); const end = c === "{" ? "}" : "]";
      if (peek() === end) { at++; return; }
      while (true) {
        if (c === "{") { whitespace(); string(); whitespace(); take(":"); }
        value(depth + 1); whitespace();
        if (peek() === end) { at++; return; }
        take(","); whitespace();
      }
    }
    for (const literal of ["true", "false", "null"]) {
      if (c === literal[0]) { for (const char of literal) take(char); return; }
    }
    if (c === "-" || /[0-9]/.test(c)) {
      if (c === "-") at++;
      if (peek() === "0") at++;
      else { if (!/[1-9]/.test(peek())) throw invalid; while (at < text.length && /[0-9]/.test(text[at]!)) at++; }
      if (text[at] === ".") { at++; if (!/[0-9]/.test(peek())) throw invalid; while (at < text.length && /[0-9]/.test(text[at]!)) at++; }
      if (text[at] === "e" || text[at] === "E") { at++; if (text[at] === "+" || text[at] === "-") at++; if (!/[0-9]/.test(peek())) throw invalid; while (at < text.length && /[0-9]/.test(text[at]!)) at++; }
      return;
    }
    throw invalid;
  }
  try { value(0); whitespace(); return false; } catch (error) { return error === incomplete; }
}
