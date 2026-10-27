import { body, json } from "./bridge-http";
import type { BridgeAuth } from "./bridge-auth";
import type { CatalogService } from "./catalog";
import { ContextMessageHistoryError, type ContextMessageHistorySnapshot } from "./context-message-reader";
import type { Event, Run, Session } from "./history";
import { NativeSubagentError, type NativeSubagentService } from "./native-subagent-service";
import type { OpenCodeSubagentRecorder } from "./opencode-subagent-recorder";
import type { ReconciledHistory } from "./reconcile";
import { SessionRunPreviewError, type SessionRunPreviewService } from "./session-run-preview";
import type { RunPreparationTimings } from "./submission-timing-archive";
import { systemPromptSnapshot } from "./system-prompt";
import { TranscriptError, type TranscriptService } from "./transcript-service";

const nativeSubagentPattern = /^\/api\/sessions\/([^/]+)\/native-subagents(?:\/([^/]+)\/([^/]+)(\/refresh)?)?$/;
const transcriptPattern = /^\/api\/sessions\/([^/]+)\/transcript(?:\/(meta|refresh))?$/;
const runPreviewPattern = /^\/api\/sessions\/([^/]+)\/runs\/preview$/;
const runsPattern = /^\/api\/sessions\/([^/]+)\/runs$/;
const preparationTimingPattern = /^\/api\/runs\/([^/]+)\/preparation-timing$/;
const eventPattern = /^\/api\/runs\/([^/]+)\/events$/;
const contextEvidencePattern = /^\/api\/runs\/([^/]+)\/context-evidence$/;
const systemPromptPattern = /^\/api\/runs\/([^/]+)\/system-prompt$/;
const contextPattern = /^\/api\/runs\/([^/]+)\/context$/;

// The bridge can check these synchronously before awaiting a matched handler.
// GET-only legacy branches must still fall through on other methods.
export const matchesNativeSubagentEvidenceRoute = (_req: Request, url: URL): boolean => nativeSubagentPattern.test(url.pathname);
export const matchesTranscriptEvidenceRoute = (_req: Request, url: URL): boolean => transcriptPattern.test(url.pathname);
export const matchesRunEvidenceRoute = (req: Request, url: URL): boolean => {
  const path = url.pathname;
  return runPreviewPattern.test(path) || preparationTimingPattern.test(path) || contextEvidencePattern.test(path)
    || req.method === "GET" && (runsPattern.test(path) || eventPattern.test(path) || systemPromptPattern.test(path) || contextPattern.test(path));
};
export const matchesConversationSearchRoute = (req: Request, url: URL): boolean => url.pathname === "/api/sessions/search" && req.method === "GET";

export type NativeSubagentEvidenceRoutePorts = Readonly<{
  nativeSubagents: Pick<NativeSubagentService, "list" | "page">;
  nativeSubagentRecorder: Pick<OpenCodeSubagentRecorder, "refresh">;
  findSession: (sessionId: string) => Session | undefined;
  /** Match both identities, just like the original metadata predicate. */
  findRun: (runId: string, sessionId: string) => Run | undefined;
}>;

/** Authentication and refresh POST guard exceptions remain in the bridge. */
export function createNativeSubagentEvidenceRoute({ nativeSubagents, nativeSubagentRecorder, findSession, findRun }: NativeSubagentEvidenceRoutePorts) {
  return async function nativeSubagentEvidenceRoute(req: Request, url: URL): Promise<Response | null> {
    const nativeSubagent = nativeSubagentPattern.exec(url.pathname);
    if (!nativeSubagent) return null;
    const force = nativeSubagent[4] === "/refresh";
    if (req.method !== (force ? "POST" : "GET")) return json({ error: "Method not allowed" }, 405);
    if (force && url.searchParams.size) return json({ error: "Refresh does not accept query selectors", code: "native-subagent-input" }, 400);
    try {
      const selectors = nativeSubagent.slice(1).map(value => value === undefined ? undefined : decodeURIComponent(value));
      const result = selectors[1] === undefined ? nativeSubagents.list(selectors[0]!, url.searchParams)
        : nativeSubagents.page(selectors[0]!, selectors[1], selectors[2]!, url.searchParams);
      const parent = findSession(selectors[0]!)!;
      const summaries = "subagents" in result ? result.subagents : [result.subagent];
      for (const summary of summaries) {
        const run = findRun(summary.runId, parent.sessionId);
        if (run) nativeSubagentRecorder.refresh(parent, run, summary.parentToolUseId, force);
      }
      return json(result);
    } catch (error) {
      if (error instanceof URIError) return json({ error: "Invalid native subagent selector", code: "native-subagent-input" }, 400);
      if (error instanceof NativeSubagentError) return json({ error: error.message, code: error.code }, error.status);
      throw error;
    }
  };
}

export type TranscriptEvidenceRoutePorts = Readonly<{
  transcripts: Pick<TranscriptService, "page" | "metadataPage" | "refresh">;
  findSession: (sessionId: string) => Session | undefined;
  /** Legacy transcript reads alone retain their existing materialization step. */
  ensureSessionJournals: (sessionId: string) => void;
}>;

export function createTranscriptEvidenceRoute({ transcripts, findSession, ensureSessionJournals }: TranscriptEvidenceRoutePorts) {
  return async function transcriptEvidenceRoute(req: Request, url: URL): Promise<Response | null> {
    const transcript = transcriptPattern.exec(url.pathname);
    if (!transcript) return null;
    const session = findSession(transcript[1]!);
    if (!session) return json({ error: "Unknown session" }, 404);
    try {
      if (!transcript[2] && req.method === "GET") { ensureSessionJournals(session.sessionId); return json(await transcripts.page(session, url.searchParams)); }
      if (transcript[2] === "meta" && req.method === "GET") { ensureSessionJournals(session.sessionId); return json(await transcripts.metadataPage(session, url.searchParams)); }
      if (transcript[2] === "refresh" && req.method === "POST") {
        if (url.searchParams.size) return json({ error: "Refresh does not accept query selectors", code: "transcript-input" }, 400);
        let input: unknown;
        try { input = await body(req); } catch { return json({ error: "Invalid refresh body", code: "transcript-input" }, 400); }
        return json(await transcripts.refresh(session, input as import("./transcript-contract").TranscriptRefreshRequest));
      }
      return json({ error: "Method not allowed" }, 405);
    } catch (error) {
      if (error instanceof TranscriptError) return json({ error: error.message, code: error.code }, error.status);
      throw error;
    }
  };
}

export type RunEvidenceRoutePorts = Readonly<{
  sessionRunPreviews: Pick<SessionRunPreviewService, "page">;
  auth: Pick<BridgeAuth, "terminalToken" | "authenticated">;
  findSession: (sessionId: string) => Session | undefined;
  findRun: (runId: string) => Run | undefined;
  runsForSession: (sessionId: string) => Run[];
  journalEvents: (runId: string) => Event[];
  storeId: string;
  /** Use contextHistory.read(run) unchanged, never journalEvents or repair. */
  readProtectedContext: (run: Run) => ContextMessageHistorySnapshot;
  /** The bridge owns the owner identity check and lazy archive fallback. */
  readPreparationTiming: (run: Run) => { active?: RunPreparationTimings; archived?: RunPreparationTimings };
}>;

export function createRunEvidenceRoute({ sessionRunPreviews, auth, findSession, findRun, runsForSession, journalEvents, storeId, readProtectedContext, readPreparationTiming }: RunEvidenceRoutePorts) {
  return async function runEvidenceRoute(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;
    const runPreviewMatch = runPreviewPattern.exec(path);
    if (runPreviewMatch) {
      if (req.method !== "GET") return json({ error: "Method not allowed" }, 405, { allow: "GET" });
      try {
        const owner = auth.terminalToken(req);
        const preview = await sessionRunPreviews.page(runPreviewMatch[1]!, url.searchParams, owner, req.signal);
        if (!auth.authenticated(req) || auth.terminalToken(req) !== owner) return json({ error: "Authentication revoked" }, 401);
        return json(preview);
      } catch (error) {
        if (error instanceof SessionRunPreviewError) return json({ error: error.message, code: error.code }, error.status);
        throw error;
      }
    }
    const runsMatch = runsPattern.exec(path);
    if (runsMatch && req.method === "GET") {
      if (!findSession(runsMatch[1]!)) return json({ error: "Unknown session" }, 404);
      return json({ runs: runsForSession(runsMatch[1]!) });
    }
    const preparationTimingMatch = preparationTimingPattern.exec(path);
    if (preparationTimingMatch) {
      if (req.method !== "GET") return json({ error: "Method not allowed" }, 405, { allow: "GET" });
      const run = findRun(preparationTimingMatch[1]!);
      if (!run) return json({ available: false, reason: "run-not-found" }, 404);
      const { active, archived } = readPreparationTiming(run);
      const timing = active ?? archived;
      return json(timing ? { available: true, source: active ? "active" : "archive", diagnosticsOnly: true, timing }
        : { available: false, reason: "not-recorded", diagnosticsOnly: true });
    }
    const eventMatch = eventPattern.exec(path);
    if (eventMatch && req.method === "GET") {
      const run = findRun(eventMatch[1]!);
      if (!run) return json({ error: "Unknown run" }, 404);
      const after = Number(url.searchParams.get("after") ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) return json({ error: "Invalid cursor" }, 400);
      const list = journalEvents(run.runId).filter(e => e.seq > after);
      return json({ events: list, nextCursor: list.at(-1)?.seq ?? after, status: run.status });
    }
    const contextEvidenceMatch = contextEvidencePattern.exec(path);
    if (contextEvidenceMatch) {
      if (req.method !== "GET") return json({ error: "Method not allowed" }, 405, { allow: "GET" });
      const run = findRun(contextEvidenceMatch[1]!);
      if (!run) return json({ error: "Unknown run" }, 404);
      // The explicit inspector reads only the existing bounded protected disk
      // snapshot. No deferred log repair or current-context substitution.
      try {
        const snapshot = readProtectedContext(run);
        snapshot.assertCurrent();
        return json({ events: snapshot.events, nextCursor: snapshot.events.at(-1)?.seq ?? 0, status: run.status });
      } catch (error) {
        if (error instanceof ContextMessageHistoryError) return json({ error: "Recorded context evidence is unavailable or incomplete; no journal was repaired and no current context was substituted", code: error.code }, 409);
        throw error;
      }
    }
    const systemPromptMatch = systemPromptPattern.exec(path);
    if (systemPromptMatch && req.method === "GET") {
      const run = findRun(systemPromptMatch[1]!);
      if (!run) return json({ error: "Unknown run" }, 404);
      const expectedStore = url.searchParams.get("storeId");
      if (expectedStore !== null && expectedStore !== storeId) return json({ error: "System prompt belongs to another App store" }, 409);
      return json(systemPromptSnapshot(storeId, run, journalEvents(run.runId)));
    }
    const contextMatch = contextPattern.exec(path);
    if (contextMatch && req.method === "GET") {
      const run = findRun(contextMatch[1]!);
      if (!run) return json({ error: "Unknown run" }, 404);
      return json({ schema: 1, runId: run.runId, sessionId: run.sessionId, status: run.status,
        records: (journalEvents(run.runId)).filter(event => event.kind === "context" || event.kind === "launch"),
        evidence: "Prepared segments and transport receipts; model-request observation is not implied" });
    }
    return null;
  };
}

export type ConversationSearchRoutePorts = Readonly<{
  activeSessions: () => Session[];
  catalog: Pick<CatalogService, "association">;
  runsForSession: (sessionId: string) => Run[];
  journalEvents: (runId: string) => Event[];
  storedNativeHistory: (session: Session) => Promise<ReconciledHistory | undefined>;
}>;

export function createConversationSearchRoute({ activeSessions, catalog, runsForSession, journalEvents, storedNativeHistory }: ConversationSearchRoutePorts) {
  return async function conversationSearchRoute(req: Request, url: URL): Promise<Response | null> {
    if (!matchesConversationSearchRoute(req, url)) return null;
    // Best-effort message-body search over in-memory event logs plus persisted
    // native-history snapshots; tool/reasoning parts remain stripped.
    // Bounds: query 1-200 chars, ≤200 sessions, ≤20 recent runs/session,
    // ≤500 recent events/run, ≤50 results.
    const q = (url.searchParams.get("q") ?? "").trim();
    if (!q) return json({ results: [] });
    if (q.length > 200) return json({ error: "Query too long" }, 400);
    const limitRaw = Number(url.searchParams.get("limit") ?? 20);
    const limit = Number.isSafeInteger(limitRaw) ? Math.min(50, Math.max(1, limitRaw)) : 20;
    const workspaceFilter = url.searchParams.get("workspaceId"), worktreeFilter = url.searchParams.get("worktreeId");
    const lowered = q.toLowerCase();
    const snippetFor = (text: string): string | null => {
      const at = text.toLowerCase().indexOf(lowered);
      if (at < 0) return null;
      const start = Math.max(0, at - 60), end = Math.min(text.length, at + q.length + 60);
      return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`.slice(0, 240);
    };
    const textOf = (data: unknown): string[] => {
      if (typeof data === "string") return data.length <= 20000 ? [data] : [];
      if (!data || typeof data !== "object" || Array.isArray(data)) return [];
      const record = data as Record<string, any>;
      // Submission events carry {messageId, text}; message snapshots carry parts.
      if (typeof record.text === "string" && typeof record.messageId === "string") return record.text.length <= 20000 ? [record.text] : [];
      if (Array.isArray(record.parts)) {
        const out: string[] = [];
        for (const part of record.parts) {
          if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string" && part.text.length <= 20000) out.push(part.text);
        }
        return out;
      }
      if (record.message && typeof record.message === "object") return textOf(record.message);
      if (Array.isArray(record.content)) {
        const out: string[] = [];
        for (const part of record.content) {
          if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") out.push(part.text);
        }
        return out;
      }
      if (record.type === "result" && typeof record.result === "string") return [record.result];
      if (typeof record.prompt === "string") return [record.prompt];
      return [];
    };
    const results: { sessionId: string; runId?: string; snippet: string; score: number }[] = [];
    const sessions = activeSessions().slice(-200);
    for (const session of sessions) {
      if (results.length >= limit) break;
      const association = catalog.association(session.sessionId);
      if (workspaceFilter && association.workspaceId !== workspaceFilter) continue;
      if (worktreeFilter && association.worktreeId !== worktreeFilter) continue;
      // Title hits are metadata; body endpoint still surfaces one snippet.
      if (session.title && snippetFor(session.title)) {
        results.push({ sessionId: session.sessionId, snippet: snippetFor(session.title)!, score: 0.9 });
        if (results.length >= limit) break;
      }
      const runs = runsForSession(session.sessionId).slice(-20);
      for (const run of runs) {
        if (results.length >= limit) break;
        const list = (journalEvents(run.runId)).slice(-500);
        for (const event of list) {
          if (results.length >= limit) break;
          if (event.kind !== "submission" && event.kind !== "message" && event.kind !== "stdout") continue;
          for (const text of textOf(event.data)) {
            const snippet = snippetFor(text);
            if (snippet) {
              // Earlier runs rank lower; title-adjacent score stays highest.
              const score = event.kind === "submission" ? 0.8 : 0.5;
              results.push({ sessionId: session.sessionId, runId: run.runId, snippet, score });
              break;
            }
          }
          // One hit per event keeps the cap meaningful across long logs.
          if (results.length && results.at(-1)?.runId === run.runId && results.at(-1)?.sessionId === session.sessionId) {
            // Allow multiple events per run but stop scanning this run after 3 hits.
            if (results.filter(r => r.runId === run.runId).length >= 3) break;
          }
        }
      }
      if (results.length >= limit) break;
      // Attached/reconciled native snapshots not yet covered by run events.
      try {
        const history = await storedNativeHistory(session);
        const messages = history?.messages.slice(-100) ?? [];
        for (const message of messages) {
          if (results.length >= limit) break;
          for (const text of textOf(message)) {
            const snippet = snippetFor(text);
            if (snippet) { results.push({ sessionId: session.sessionId, snippet, score: 0.4 }); break; }
          }
          if (results.filter(r => r.sessionId === session.sessionId && !r.runId).length >= 2) break;
        }
      } catch { /* Missing snapshot: in-memory events are the source. */ }
    }
    return json({ results: results.slice(0, limit) });
  };
}
