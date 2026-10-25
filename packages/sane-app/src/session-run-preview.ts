import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isAbsolute } from "node:path";
import { setImmediate } from "node:timers/promises";
import { uuid, type Run, type Session } from "./history";
import type { SessionRunPreview, SessionRunPreviewResponse, SessionRunPreviewSource } from "../shared/conversation/session-run-preview";

export const SESSION_RUN_PREVIEW_DEFAULT_LIMIT = 20;
export const SESSION_RUN_PREVIEW_MAX_LIMIT = 50;
export const SESSION_RUN_PREVIEW_MAX_BYTES = 256 * 1024;
const CURSOR_TTL_MS = 10 * 60 * 1000;
const SCAN_DEADLINE_MS = 5000;
const MAX_CURSOR_LENGTH = 4096;

export class SessionRunPreviewError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const invalid = (message = "Invalid session run preview selector or cursor"): never => {
  throw new SessionRunPreviewError(400, "session-run-preview-input", message);
};
const reset = (): never => {
  throw new SessionRunPreviewError(409, "session-run-preview-reset", "Run preview snapshot changed or expired; reload the first page");
};
const tooLarge = (): never => {
  throw new SessionRunPreviewError(413, "session-run-preview-too-large", "Run preview exceeds the 256 KiB response budget");
};
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: readonly string[]) => Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("base64url");
const digest = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
type Position = { createdAt: number; runId: string };
type Fence = { length: number; terminalRunId: string | null };
type Cursor = {
  version: 1; purpose: "session-run-preview"; generation: string; sessionId: string;
  identity: string; owner: string; limit: number; expiresAt: number;
  fence: Fence; total: number; after: Position;
};
type Candidate = { run: Run; position: Position };
/** Negative means a precedes b: descending milliseconds, then binary ID order. */
const compare = (a: Position, b: Position) => a.createdAt === b.createdAt ? a.runId === b.runId ? 0 : a.runId > b.runId ? -1 : 1 : a.createdAt > b.createdAt ? -1 : 1;
const identity = (source: SessionRunPreviewSource) => hash([source.storeId, source.sessionId, source.harness, source.authorityId, source.nativeSessionId, source.cwd]);

/** Stateless cursors pin an append-only metadata prefix, not mutable run status.
 * Only limit+1 candidate references are retained; no journal/native reads occur. */
export class SessionRunPreviewService {
  private readonly secret = randomBytes(32);
  private readonly generation = randomBytes(12).toString("base64url");
  constructor(
    private readonly storeId: string,
    private readonly sessions: () => readonly Session[],
    private readonly runs: () => readonly Run[],
    private readonly assertActive: (session: Session) => void,
  ) {}

  private source(sessionId: string): SessionRunPreviewSource {
    if (!uuid(sessionId)) return invalid("Invalid session selector");
    const session = this.sessions().find(session => session.sessionId === sessionId);
    if (!session) throw new SessionRunPreviewError(404, "session-run-preview-missing", "Unknown session");
    this.assertActive(session);
    const { harness, authorityId, nativeSessionId, cwd } = session;
    if ((harness !== "opencode" && harness !== "claude-code")
      || typeof authorityId !== "string" || !new RegExp(`^sane-native-v1:${harness === "opencode" ? "oc" : "cc"}:[a-f0-9]{64}$`).test(authorityId)
      || typeof nativeSessionId !== "string" || !(harness === "opencode" ? /^ses[a-zA-Z0-9_-]+$/.test(nativeSessionId) : uuid(nativeSessionId))
      || typeof cwd !== "string" || !isAbsolute(cwd) || cwd.includes("\0")) return reset();
    return { storeId: this.storeId, sessionId, harness, authorityId, nativeSessionId, cwd };
  }

  private parameters(params: URLSearchParams) {
    if ([...params.keys()].some(key => key !== "limit" && key !== "cursor") || params.getAll("limit").length > 1 || params.getAll("cursor").length > 1) return invalid();
    const raw = params.get("limit");
    if (raw !== null && !/^[1-9]\d?$/.test(raw)) return invalid("Limit must be an integer from 1 to 50");
    const limit = raw === null ? SESSION_RUN_PREVIEW_DEFAULT_LIMIT : Number(raw);
    if (limit > SESSION_RUN_PREVIEW_MAX_LIMIT) return invalid("Limit must be an integer from 1 to 50");
    return { limit, cursor: params.get("cursor") };
  }

  private encode(cursor: Cursor): string {
    const payload = Buffer.from(JSON.stringify(cursor)).toString("base64url");
    const encoded = `${payload}.${createHmac("sha256", this.secret).update(payload).digest("base64url")}`;
    if (encoded.length > MAX_CURSOR_LENGTH) return tooLarge();
    return encoded;
  }

  private decode(raw: string): Cursor {
    if (raw.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(raw)) return invalid();
    const [payload, signature] = raw.split(".") as [string, string];
    const data = Buffer.from(payload, "base64url"), actual = Buffer.from(signature, "base64url");
    if (actual.length !== 32 || actual.toString("base64url") !== signature || data.toString("base64url") !== payload) return invalid();
    let value: unknown;
    try { value = JSON.parse(data.toString("utf8")); } catch { return invalid(); }
    if (!object(value) || !keys(value, ["version", "purpose", "generation", "sessionId", "identity", "owner", "limit", "expiresAt", "fence", "total", "after"])
      || value.version !== 1 || value.purpose !== "session-run-preview"
      || typeof value.generation !== "string" || !/^[A-Za-z0-9_-]{16}$/.test(value.generation)
      || !uuid(value.sessionId) || !digest(value.identity) || !digest(value.owner)
      || typeof value.limit !== "number" || !Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > SESSION_RUN_PREVIEW_MAX_LIMIT
      || typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0
      || !object(value.fence) || !keys(value.fence, ["length", "terminalRunId"])
      || typeof value.fence.length !== "number" || !Number.isSafeInteger(value.fence.length) || value.fence.length < 1 || !uuid(value.fence.terminalRunId)
      || typeof value.total !== "number" || !Number.isSafeInteger(value.total) || value.total < 1 || value.total > value.fence.length
      || !object(value.after) || !keys(value.after, ["createdAt", "runId"])
      || typeof value.after.createdAt !== "number" || !Number.isSafeInteger(value.after.createdAt) || Math.abs(value.after.createdAt) > 8.64e15 || !uuid(value.after.runId)
      || JSON.stringify(value) !== data.toString("utf8")) return invalid();
    // A foreign generation is only a reset hint, never accepted cursor authority.
    if (value.generation !== this.generation) return reset();
    const expected = createHmac("sha256", this.secret).update(payload).digest();
    if (!timingSafeEqual(actual, expected)) return invalid();
    return value as unknown as Cursor;
  }

  private assertFence(runs: readonly Run[], fence: Fence) {
    if (runs.length < fence.length || (fence.length ? runs[fence.length - 1]?.runId ?? null : null) !== fence.terminalRunId) return reset();
  }

  private project(run: Run): SessionRunPreview {
    // Explicit allowlist: never spread a Run, including compact.instructions.
    const preview: SessionRunPreview = { runId: run.runId, sessionId: run.sessionId, status: run.status, createdAt: run.createdAt, cwd: run.cwd };
    if (run.endedAt !== undefined) preview.endedAt = run.endedAt;
    if (run.model !== undefined) preview.model = run.model;
    if (run.effort !== undefined) preview.effort = run.effort;
    if (run.agent !== undefined) preview.agent = run.agent;
    if (run.agentKind !== undefined) preview.agentKind = run.agentKind;
    if (run.nativeAgentSelected !== undefined) preview.nativeAgentSelected = run.nativeAgentSelected;
    if (run.profileId !== undefined) preview.profileId = run.profileId;
    return preview;
  }

  async page(sessionId: string, params: URLSearchParams, ownerToken: string | undefined, signal: AbortSignal): Promise<SessionRunPreviewResponse> {
    const deadline = performance.now() + SCAN_DEADLINE_MS;
    const check = () => {
      if (signal.aborted) throw new SessionRunPreviewError(499, "session-run-preview-aborted", "Run preview request cancelled");
      if (performance.now() >= deadline) throw new SessionRunPreviewError(504, "session-run-preview-deadline", "Run preview metadata scan exceeded its deadline");
    };
    check();
    const session = this.source(sessionId), { limit, cursor: raw } = this.parameters(params);
    if (ownerToken !== undefined && (typeof ownerToken !== "string" || !ownerToken)) return invalid("Invalid preview owner");
    const owner = hash(["browser-owner", ownerToken ?? null]), sourceIdentity = identity(session);
    const cursor = raw === null ? undefined : this.decode(raw);
    if (cursor && (cursor.sessionId !== sessionId || cursor.owner !== owner || cursor.limit !== limit)) return invalid("Cursor session, owner or limit does not match the request");
    if (cursor && (cursor.identity !== sourceIdentity || cursor.expiresAt <= Date.now())) return reset();
    const runs = this.runs();
    const fence: Fence = cursor?.fence ?? { length: runs.length, terminalRunId: runs.at(-1)?.runId ?? null };
    const expiresAt = cursor?.expiresAt ?? Date.now() + CURSOR_TTL_MS;
    this.assertFence(runs, fence);
    const best: Candidate[] = [];
    let total = 0, anchorFound = !cursor;
    for (let index = 0; index < fence.length; index++) {
      // Yield periodically so disconnects and other bridge work can progress.
      if (index % 4096 === 0) { check(); if (index) { await setImmediate(); check(); } }
      const run = runs[index];
      if (!run) return reset();
      if (run.sessionId !== sessionId) continue;
      total++;
      const position = { createdAt: Date.parse(run.createdAt), runId: run.runId };
      if (cursor && compare(position, cursor.after) === 0) anchorFound = true;
      if (cursor && compare(position, cursor.after) <= 0) continue;
      if (best.length === limit + 1 && compare(position, best[best.length - 1]!.position) >= 0) continue;
      if (best.length === limit + 1) best.pop();
      let low = 0, high = best.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (compare(position, best[middle]!.position) < 0) high = middle; else low = middle + 1;
      }
      best.splice(low, 0, { run, position });
    }
    check();
    // Recheck after yielding: retirement, namespace and prefix are live guards.
    if (identity(this.source(sessionId)) !== sourceIdentity || this.runs() !== runs) return reset();
    this.assertFence(runs, fence);
    if (cursor && (cursor.total !== total || !anchorFound || expiresAt <= Date.now())) return reset();
    const hasMore = best.length > limit;
    const selected = best.slice(0, limit);
    const nextCursor = hasMore ? this.encode({ version: 1, purpose: "session-run-preview", generation: this.generation, sessionId,
      identity: sourceIdentity, owner, limit, expiresAt, fence, total, after: selected[selected.length - 1]!.position }) : null;
    const response: SessionRunPreviewResponse = { session, runs: selected.map(candidate => this.project(candidate.run)), total, page: { nextCursor, hasMore } };
    // Bound the whole envelope, including source and cursor; never truncate rows.
    let stringUnits = 0;
    for (const value of Object.values(session)) stringUnits += value.length;
    for (const run of response.runs) for (const value of Object.values(run)) if (typeof value === "string") stringUnits += value.length;
    if (stringUnits > SESSION_RUN_PREVIEW_MAX_BYTES || Buffer.byteLength(JSON.stringify(response)) > SESSION_RUN_PREVIEW_MAX_BYTES) return tooLarge();
    check();
    return response;
  }
}
