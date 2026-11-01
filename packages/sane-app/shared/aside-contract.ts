import { isNativeHarness, validNativeAuthorityId } from "sane-core/native-source-contract";
import type { Message } from "./conversation/types";
import { parsePresentQuestionsInput, type UserQuestion, type UserQuestionsRecord } from "./user-questions-contract";

export type AsideLifecycle = "open" | "archived" | "discarded";
export type AsideTarget = { kind: "conversation" } | { kind: "question"; formId: string; questionIndex: number };
export type AsideCreateRequest = { requestId: string; target: AsideTarget; draft: string };
export type AsideDraftRequest = { requestId: string; expectedRevision: number; text: string };
export type AsideLifecycleRequest = { requestId: string; expectedRevision: number; lifecycle: AsideLifecycle };
/** Immutable App observation reference ONLY: not a native prefix, context grant,
 * native delivery proof, or permission to execute against the captured binding. */
export type AsideTranscriptSnapshot = {
  kind: "app-transcript"; epoch: string; revision: string;
  messages: (Message & { version: string })[]; totalMessages: number;
  boundaryMessageId: string | null; fingerprint: string;
};
export type AsideSourceSnapshot = {
  storeId: string; sessionId: string; rootSessionId: string;
  native: { harness: "cc" | "oc" | "gk"; authorityId: string; nativeId: string };
  binding: { workspaceId: string; worktreeId: string; bindingRevision: string; cwd: string };
  capturedAt: string; transcript: AsideTranscriptSnapshot;
  question?: { formId: string; formRevision: number; questionIndex: number; question: UserQuestion; anchor: UserQuestionsRecord["anchor"] };
  /** Inert references, never execution/context-delivery claims. */
  context?: { executionRevision?: string; packageRevision?: string };
};
export type AsideRecord = {
  version: 1; id: string; source: AsideSourceSnapshot;
  purpose: "discussion" | "question-explanation"; lifecycle: AsideLifecycle;
  draft: string; revision: number; createdAt: string; updatedAt: string;
};
export type AsideSummary = {
  id: string; sourceSessionId: string; rootSessionId: string; purpose: AsideRecord["purpose"];
  lifecycle: AsideLifecycle; revision: number; createdAt: string; updatedAt: string;
  question?: { formId: string; questionIndex: number };
};
export type AsideExecutionAvailability = { available: false; code: "aside-context-unconfigured" };
/** Added to route responses, never persisted in an AsideRecord. */
export const ASIDE_EXECUTION_AVAILABILITY: Readonly<AsideExecutionAvailability> = Object.freeze({ available: false, code: "aside-context-unconfigured" });
export const ASIDE_LIMITS = Object.freeze({
  draftChars: 100000, snapshotBytes: 4 * 1024 * 1024, messages: 10000,
  partsPerMessage: 10000, tokenChars: 4096, jsonDepth: 64, jsonNodes: 250000,
  ledgerBytes: 64 * 1024 * 1024, sourceLedgerBytes: 16 * 1024 * 1024,
  records: 512, sourceRecords: 64, receipts: 8192, sourceReceipts: 2048,
});

function requireValue(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), "Expected an object");
  requireValue(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, "Expected a JSON object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireValue(Object.getOwnPropertySymbols(value).length === 0 && Object.values(descriptors).every(d => d.enumerable && "value" in d), "Expected JSON properties");
  requireValue(required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => required.includes(k) || optional.includes(k)), "Unexpected or missing fields");
  return value as Record<string, unknown>;
}
function array(value: unknown, max: number): unknown[] {
  requireValue(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= max, "Invalid JSON array");
  requireValue(Object.getOwnPropertyNames(value).length === value.length + 1 && Object.getOwnPropertySymbols(value).length === 0
    && Object.keys(value).length === value.length && Array.from({ length: value.length }, (_, i) => Object.getOwnPropertyDescriptor(value, String(i))).every(d => d && d.enumerable && "value" in d), "Expected a dense JSON array");
  return value;
}
/** Validate opaque tool/error payloads too, before stringify/clone can invoke a
 * getter or toJSON. Bound traversal independently from the serialized byte cap. */
function json(value: unknown, maxBytes: number): void {
  const ancestors = new Set<object>(); let nodes = 0;
  const walk = (v: unknown, depth: number): void => {
    requireValue(++nodes <= ASIDE_LIMITS.jsonNodes && depth <= ASIDE_LIMITS.jsonDepth, "Aside JSON complexity limit exceeded");
    if (v === null || typeof v === "boolean" || typeof v === "string" || typeof v === "number" && Number.isFinite(v)) return;
    requireValue(v && typeof v === "object" && !ancestors.has(v), "Expected finite, acyclic JSON");
    ancestors.add(v);
    if (Array.isArray(v)) for (const child of array(v, ASIDE_LIMITS.jsonNodes)) walk(child, depth + 1);
    else { const obj = object(v, [], Object.keys(v)); for (const child of Object.values(obj)) walk(child, depth + 1); }
    ancestors.delete(v);
  };
  walk(value, 0);
  requireValue(new TextEncoder().encode(JSON.stringify(value)).length <= maxBytes, "Aside byte limit exceeded");
}
function text(value: unknown, max: number): string {
  requireValue(typeof value === "string" && value.length <= max * 2 && Array.from(value).length <= max && !value.includes("\0"), "Invalid aside text"); return value;
}
function token(value: unknown): string {
  const result = text(value, ASIDE_LIMITS.tokenChars);
  requireValue(!!result && result.trim() === result && !/[\u0000-\u001f\u007f]/.test(result), "Invalid aside token"); return result;
}
function uuid(value: unknown): string {
  requireValue(typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value), "Invalid aside UUID"); return value;
}
function integer(value: unknown, min = 1): number {
  requireValue(Number.isSafeInteger(value) && (value as number) >= min, "Invalid aside revision or index"); return value as number;
}
function time(value: unknown): string {
  requireValue(typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value)), "Invalid aside timestamp"); return value;
}
function lifecycle(value: unknown): AsideLifecycle {
  requireValue(value === "open" || value === "archived" || value === "discarded", "Invalid aside lifecycle"); return value;
}
function path(value: unknown): string {
  const result = token(value);
  requireValue(result.startsWith("/") && (result === "/" || !result.endsWith("/") && result.slice(1).split("/").every(part => !!part && part !== "." && part !== "..")), "Invalid canonical aside path"); return result;
}
function questionIndex(value: unknown): number { const index = integer(value, 0); requireValue(index < 32, "Invalid question index"); return index; }

export function parseAsideCreateRequest(value: unknown): AsideCreateRequest {
  json(value, ASIDE_LIMITS.snapshotBytes);
  const v = object(value, ["requestId", "target", "draft"]);
  const t = object(v.target, ["kind"], ["formId", "questionIndex"]);
  let target: AsideTarget;
  if (t.kind === "conversation") { object(t, ["kind"]); target = { kind: "conversation" }; }
  else { object(t, ["kind", "formId", "questionIndex"]); requireValue(t.kind === "question", "Invalid aside target"); target = { kind: "question", formId: token(t.formId), questionIndex: questionIndex(t.questionIndex) }; }
  return { requestId: token(v.requestId), target, draft: text(v.draft, ASIDE_LIMITS.draftChars) };
}
export function parseAsideDraftRequest(value: unknown): AsideDraftRequest {
  json(value, ASIDE_LIMITS.snapshotBytes); const v = object(value, ["requestId", "expectedRevision", "text"]);
  return { requestId: token(v.requestId), expectedRevision: integer(v.expectedRevision), text: text(v.text, ASIDE_LIMITS.draftChars) };
}
export function parseAsideLifecycleRequest(value: unknown): AsideLifecycleRequest {
  json(value, ASIDE_LIMITS.snapshotBytes); const v = object(value, ["requestId", "expectedRevision", "lifecycle"]);
  return { requestId: token(v.requestId), expectedRevision: integer(v.expectedRevision), lifecycle: lifecycle(v.lifecycle) };
}

function message(value: unknown): void {
  const m = object(value, ["id", "runId", "role", "parts", "time", "status", "version"], ["nativeIds", "normalized", "error", "retry", "queuedFollowup", "nativeSubagentResult", "nativeShellResult", "nativeInstructionContext"]);
  token(m.id); token(m.runId); token(m.version);
  // Transcript outcome placeholders use an empty time when no end timestamp
  // was recorded. Preserve that observation instead of inventing a timestamp.
  if (m.time !== "") time(m.time);
  requireValue(["user", "assistant", "system"].includes(m.role as string) && ["starting", "running", "completed", "failed", "interrupted", "unknown"].includes(m.status as string), "Invalid transcript message");
  if (Object.hasOwn(m, "normalized")) requireValue(typeof m.normalized === "boolean", "Invalid normalized flag");
  if (Object.hasOwn(m, "nativeIds")) { const ids = array(m.nativeIds, ASIDE_LIMITS.messages).map(token); requireValue(new Set(ids).size === ids.length, "Duplicate native message ID"); }
  for (const part of array(m.parts, ASIDE_LIMITS.partsPerMessage)) {
    const p = object(part, ["type"], ["id", "toolCallId", "name", "input", "output", "error", "toolStatus", "text"]);
    if (p.type === "text" || p.type === "reasoning") {
      object(p, ["type", "text"], p.type === "reasoning" ? ["id"] : []); text(p.text, ASIDE_LIMITS.snapshotBytes);
      if (Object.hasOwn(p, "id")) token(p.id);
    } else {
      // Native streaming observations can precede tool input. Materialization
      // omits undefined input; retain that absence rather than synthesizing it.
      object(p, ["type", "id", "name"], ["input", "toolCallId", "output", "error", "toolStatus"]);
      requireValue(p.type === "tool", "Invalid message part"); token(p.id); token(p.name);
      if (Object.hasOwn(p, "toolCallId")) token(p.toolCallId);
      if (Object.hasOwn(p, "toolStatus")) token(p.toolStatus);
      if (Object.hasOwn(p, "error")) requireValue(typeof p.error === "boolean", "Invalid tool error flag");
    }
  }
  if (Object.hasOwn(m, "retry")) { const r = object(m.retry, ["attempt", "at", "error"]); integer(r.at, 0); integer(r.attempt, 0); }
  if (Object.hasOwn(m, "nativeInstructionContext")) {
    const context = object(m.nativeInstructionContext, ["paths"]);
    const paths = array(context.paths, ASIDE_LIMITS.snapshotBytes);
    requireValue(m.role === "system" && paths.length > 0, "Invalid native instruction context");
    for (const value of paths) requireValue(typeof value === "string" && !!value.trim() && !value.includes("\0"), "Invalid native instruction path");
  }
  if (Object.hasOwn(m, "nativeShellResult")) {
    const r = object(m.nativeShellResult, ["shellId", "state"], ["exit", "truncated"]); token(r.shellId); token(r.state);
    if (Object.hasOwn(r, "exit")) requireValue(Number.isSafeInteger(r.exit), "Invalid shell exit");
    if (Object.hasOwn(r, "truncated")) requireValue(typeof r.truncated === "boolean", "Invalid shell truncation flag");
  }
  if (Object.hasOwn(m, "nativeSubagentResult")) { const r = object(m.nativeSubagentResult, ["sessionId", "state"], ["agent"]); token(r.sessionId); token(r.state); if (Object.hasOwn(r, "agent")) token(r.agent); }
  if (Object.hasOwn(m, "queuedFollowup")) {
    const q = object(m.queuedFollowup, ["requestId", "afterRunId", "sessionId", "prompt", "time", "state"], ["runId", "configuration"]);
    token(q.requestId); token(q.afterRunId); uuid(q.sessionId); text(q.prompt, ASIDE_LIMITS.snapshotBytes); time(q.time);
    requireValue(["queued", "not-submitted", "admission-unconfirmed", "dispatched"].includes(q.state as string), "Invalid queued followup state");
    if (Object.hasOwn(q, "runId")) token(q.runId);
    if (Object.hasOwn(q, "configuration")) { const c = object(q.configuration, ["cwd", "profileId"], ["model", "effort", "agent"]); path(c.cwd); token(c.profileId); for (const k of ["model", "effort", "agent"]) if (Object.hasOwn(c, k)) text(c[k], ASIDE_LIMITS.tokenChars); }
  }
}

/** Reuse the strict retained-observation schema for independent chat projections. */
export function parseAsideTranscriptMessage(value: unknown): Message {
  json(value, ASIDE_LIMITS.snapshotBytes);
  const v = object(value, ["id", "runId", "role", "parts", "time", "status"], ["version", "nativeIds", "normalized", "error", "retry", "queuedFollowup", "nativeSubagentResult", "nativeShellResult", "nativeInstructionContext"]);
  message(Object.hasOwn(v, "version") ? v : { ...v, version: "unversioned" });
  return structuredClone(v) as Message;
}

export function parseAsideSourceSnapshot(value: unknown): AsideSourceSnapshot {
  json(value, ASIDE_LIMITS.snapshotBytes);
  const v = object(value, ["storeId", "sessionId", "rootSessionId", "native", "binding", "capturedAt", "transcript"], ["question", "context"]);
  uuid(v.storeId); uuid(v.sessionId); uuid(v.rootSessionId); time(v.capturedAt);
  const n = object(v.native, ["harness", "authorityId", "nativeId"]);
  requireValue(isNativeHarness(n.harness) && validNativeAuthorityId(n.harness, n.authorityId), "Invalid native aside authority");
  if (n.harness === "oc") requireValue(typeof n.nativeId === "string" && /^ses[a-zA-Z0-9_-]{1,200}$/.test(n.nativeId), "Invalid OpenCode native identity"); else uuid(n.nativeId);
  const b = object(v.binding, ["workspaceId", "worktreeId", "bindingRevision", "cwd"]);
  uuid(b.workspaceId); uuid(b.worktreeId); token(b.bindingRevision); path(b.cwd);
  const t = object(v.transcript, ["kind", "epoch", "revision", "messages", "totalMessages", "boundaryMessageId", "fingerprint"]);
  requireValue(t.kind === "app-transcript", "Invalid aside observation kind"); token(t.epoch); token(t.revision);
  requireValue(typeof t.fingerprint === "string" && /^[a-f0-9]{64}$/.test(t.fingerprint), "Invalid transcript fingerprint");
  const messages = array(t.messages, ASIDE_LIMITS.messages); messages.forEach(message);
  requireValue(integer(t.totalMessages, 0) === messages.length, "Aside snapshots must contain the full transcript");
  const ids = messages.map(m => (m as Message).id);
  requireValue(new Set(ids).size === ids.length && t.boundaryMessageId === (ids.at(-1) ?? null), "Invalid transcript message boundary");
  if (Object.hasOwn(v, "question")) {
    const q = object(v.question, ["formId", "formRevision", "questionIndex", "question", "anchor"]);
    token(q.formId); integer(q.formRevision); questionIndex(q.questionIndex);
    // The existing question definition parser rejects answers and extra fields.
    parsePresentQuestionsInput({ title: "Aside source question", pages: [q.question] });
    const a = object(q.anchor, ["runId", "toolCallId", "messageId", "invocationId", "wrapper"]);
    token(a.runId); token(a.toolCallId); token(a.invocationId); if (a.messageId !== null) token(a.messageId);
    requireValue(a.wrapper === null || a.wrapper === "execute", "Invalid question anchor wrapper");
    requireValue(n.harness === "oc" ? a.messageId !== null && typeof a.invocationId === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(a.invocationId)
      : a.wrapper === null && a.invocationId === a.toolCallId, "Invalid native question anchor");
  }
  if (Object.hasOwn(v, "context")) { const c = object(v.context, [], ["executionRevision", "packageRevision"]); for (const k of Object.keys(c)) token(c[k]); }
  // Hash verification is server-owned (SHA-256 canonicalJSON(messages)); the
  // shared contract deliberately has no Node crypto dependency.
  return structuredClone(v) as AsideSourceSnapshot;
}

export function parseAsideRecord(value: unknown): AsideRecord {
  json(value, ASIDE_LIMITS.snapshotBytes + ASIDE_LIMITS.draftChars * 6 + 16384);
  const v = object(value, ["version", "id", "source", "purpose", "lifecycle", "draft", "revision", "createdAt", "updatedAt"]);
  requireValue(v.version === 1, "Invalid aside record version"); uuid(v.id);
  const source = parseAsideSourceSnapshot(v.source);
  requireValue(v.purpose === (source.question ? "question-explanation" : "discussion"), "Aside purpose differs from its immutable source");
  const state = lifecycle(v.lifecycle), revision = integer(v.revision);
  const createdAt = time(v.createdAt), updatedAt = time(v.updatedAt);
  requireValue(Date.parse(source.capturedAt) <= Date.parse(createdAt) && Date.parse(createdAt) <= Date.parse(updatedAt), "Invalid aside time ordering");
  requireValue(revision !== 1 || state === "open" && updatedAt === createdAt, "Invalid initial aside state");
  return { version: 1, id: v.id as string, source, purpose: v.purpose as AsideRecord["purpose"], lifecycle: state,
    draft: text(v.draft, ASIDE_LIMITS.draftChars), revision, createdAt, updatedAt };
}

export function summarizeAside(record: AsideRecord): AsideSummary {
  return { id: record.id, sourceSessionId: record.source.sessionId, rootSessionId: record.source.rootSessionId,
    purpose: record.purpose, lifecycle: record.lifecycle, revision: record.revision, createdAt: record.createdAt, updatedAt: record.updatedAt,
    ...(record.source.question ? { question: { formId: record.source.question.formId, questionIndex: record.source.question.questionIndex } } : {}) };
}
