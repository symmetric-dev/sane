import type { Message } from "../shared/conversation/types";
import { normalizeSessionTitle, type SessionTitleResponse } from "../shared/conversation/session-title";
import type { Run, Session } from "./history";
import type { TranscriptPage } from "./transcript-contract";

export class SessionNamingError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const conflict = () => new SessionNamingError(409, "title-conflict", "Title changed; refresh before retrying");

/** Only visible conversation text is shared. No tools, reasoning, context,
 * filesystem access, or raw native records enter the utility prompt. */
export function namingTranscript(messages: readonly Message[]): string | undefined {
  const visible = messages.filter(message => (message.role === "user" || message.role === "assistant") && message.id !== `${message.runId}:empty` && !message.nativeSubagentResult && !message.nativeShellResult)
    .map(message => ({ role: message.role, text: message.parts.filter(part => part.type === "text").map(part => part.text).join("\n").trim().slice(0, 6000) }))
    .filter(message => message.text);
  const assistant = visible.findLast(message => message.role === "assistant");
  if (!assistant) return;
  // JSON encoding keeps role delimiters unambiguous; the runner treats this as
  // untrusted source material, never instructions. Hard bound includes escaping.
  const user = visible.find(message => message.role === "user");
  const selected = user ? [{ ...user }, { ...assistant }] : [{ ...assistant }];
  for (const message of selected) while (JSON.stringify(message).length > 8500) message.text = message.text.slice(0, Math.floor(message.text.length * 0.8));
  return JSON.stringify(selected);
}

/** Automatic naming sees only the original user input, before App expansion. */
export function submissionNamingTranscript(text: string): string | undefined {
  const message = { role: "user", text: text.trim().slice(0, 6000) };
  if (!message.text) return;
  while (JSON.stringify(message).length > 8500) message.text = message.text.slice(0, Math.floor(message.text.length * 0.8));
  return JSON.stringify([message]);
}

/** Search canonical history rather than mistaking the UI's latest window for
 * the conversation. Large tool messages and unfinished/failed turns may occupy
 * whole pages. Native-only attached conversations use the same cursor contract.
 * Bound both traversal and wall time, leaving room for the 60-second utility
 * inside the client's 120-second request budget. No tool content enters output. */
export async function regenerationNamingTranscript(readPage: (query: URLSearchParams) => Promise<TranscriptPage>, signal?: AbortSignal): Promise<string | undefined> {
  const deadline = Date.now() + 20_000;
  const visited = new Set<string>();
  let cursor: string | undefined;
  for (let index = 0; index < 32; index++) {
    if (signal?.aborted) throw new SessionNamingError(503, "title-unavailable", "Title preparation was cancelled");
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new SessionNamingError(503, "title-transcript-timeout", "Title history lookup timed out; try again or enter a title manually");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let page: TranscriptPage;
    try {
      page = await Promise.race([
        readPage(new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : {}) })),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SessionNamingError(503, "title-transcript-timeout", "Title history lookup timed out; try again or enter a title manually")), remaining); }),
      ]);
    } finally { clearTimeout(timer); }
    if (signal?.aborted) throw new SessionNamingError(503, "title-unavailable", "Title preparation was cancelled");
    const transcript = namingTranscript(page.messages.filter(message => message.role !== "assistant" || message.status === "completed"));
    if (transcript) return transcript;
    const older = page.coverage.olderCursor;
    if (!older) return;
    if (visited.has(older)) break;
    visited.add(older); cursor = older;
  }
  // Exhausted lookup is not proof of no assistant output in older history.
  throw new SessionNamingError(413, "title-transcript-budget", "Completed output was not found within the title history lookup budget; enter a title manually");
}

type Dependencies = {
  session: (id: string) => Session | undefined;
  healthy: () => boolean;
  /** Serializes synchronous App mutations and persists via the bridge queue. */
  commit: <T>(action: () => T) => Promise<T>;
  generate: (transcript: string, signal: AbortSignal) => Promise<string>;
};
type Job = { sessionId: string; revision: number; automatic: boolean; transcript: string; attemptId: string; resolve: (value: SessionTitleResponse) => void; reject: (error: unknown) => void };

/** Utilities never acquire conversation execution capacity or create App runs. */
export class SessionNamingService {
  private abort = new AbortController();
  private jobs: Job[] = [];
  private pending = new Set<string>();
  private active = new Set<Promise<void>>();
  private closed = false;
  constructor(private deps: Dependencies) {}
  private current(id: string) {
    if (this.closed || !this.deps.healthy()) throw new SessionNamingError(503, "title-unavailable", "Title editing is unavailable");
    const session = this.deps.session(id);
    if (!session) throw new SessionNamingError(404, "not-found", "Unknown conversation");
    return session;
  }
  private response(session: Session): SessionTitleResponse {
    return { title: session.title ?? "Conversation", titleSource: session.titleSource ?? (session.title ? "legacy" : "fallback"), titleRevision: session.titleRevision ?? 0 };
  }
  async edit(id: string, title: string, revision: number) {
    const normalized = normalizeSessionTitle(title);
    if (!normalized) throw new SessionNamingError(400, "invalid-title", "Title must be 1–120 characters without control characters or newlines");
    return this.deps.commit(() => {
      const session = this.current(id);
      if ((session.titleRevision ?? 0) !== revision) throw conflict();
      if (revision >= Number.MAX_SAFE_INTEGER) throw conflict();
      session.title = normalized; session.titleSource = "manual"; session.titleRevision = revision + 1;
      session.titleAutoEligible = false;
      if (session.titleGeneration?.state === "pending") session.titleGeneration.state = "discarded";
      return this.response(session);
    });
  }
  /** A manual HTTP request must not sit behind the automatic backlog. Pending
   * includes jobs reserving metadata, so concurrent admissions cannot overbook
   * the two immediate execution slots while awaiting persistence. */
  assertManualCapacity(id: string, revision: number) {
    const session = this.current(id);
    if ((session.titleRevision ?? 0) !== revision) throw conflict();
    if (this.pending.has(id)) throw new SessionNamingError(409, "title-busy", "Title generation is already in progress");
    if (this.pending.size >= 2) throw new SessionNamingError(429, "title-capacity", "Title generation is busy; retry later");
  }
  /** Called only after the first user submission commits, never on GET or replay. */
  submitted(sessionId: string, run: Run, text: string) {
    const session = this.deps.session(sessionId);
    if (this.closed || !this.deps.healthy() || !session?.titleAutoEligible || session.titleSource !== "fallback"
      || session.titleGeneration || session.agentKind === "worker" || session.attachment || run.operation === "compact") return;
    const transcript = submissionNamingTranscript(text);
    if (!transcript) return;
    void this.request(sessionId, session.titleRevision ?? 0, transcript, true).catch(() => { /* Optional naming never blocks sends. */ });
  }
  async request(id: string, revision: number, transcript: string, automatic = false): Promise<SessionTitleResponse> {
    if (!automatic) this.assertManualCapacity(id, revision);
    const session = this.current(id);
    if ((session.titleRevision ?? 0) !== revision) throw conflict();
    if (this.pending.has(id)) throw new SessionNamingError(409, "title-busy", "Title generation is already in progress");
    if (this.pending.size >= 64) throw new SessionNamingError(429, "title-capacity", "Title generation is busy; retry later");
    if (transcript.length > 18000 || !transcript) throw new SessionNamingError(409, "title-no-output", "Complete an assistant response before generating a title");
    this.pending.add(id);
    const attemptId = crypto.randomUUID();
    try {
      await this.deps.commit(() => {
        const current = this.current(id);
        if ((current.titleRevision ?? 0) !== revision || automatic && (!current.titleAutoEligible || current.titleSource !== "fallback" || current.titleGeneration)) throw conflict();
        current.titleAutoEligible = false;
        current.titleGeneration = { state: "pending", attemptId, expectedRevision: revision, requestedAt: new Date().toISOString(), automatic };
      });
    } catch (error) { this.pending.delete(id); throw error; }
    if (this.closed) { this.pending.delete(id); throw new SessionNamingError(503, "title-unavailable", "Title generation stopped"); }
    return new Promise<SessionTitleResponse>((resolve, reject) => { this.jobs.push({ sessionId: id, revision, automatic, transcript, attemptId, resolve, reject }); this.pump(); });
  }
  private pump() {
    while (!this.closed && this.active.size < 2 && this.jobs.length) {
      const job = this.jobs.shift()!;
      const task = this.execute(job).finally(() => { this.active.delete(task); this.pending.delete(job.sessionId); this.pump(); });
      this.active.add(task);
    }
  }
  private async execute(job: Job) {
    try {
      const raw = await this.deps.generate(job.transcript, this.abort.signal);
      const title = normalizeSessionTitle(raw);
      if (!title) throw new SessionNamingError(502, "title-generation-failed", "Title generator returned an invalid title");
      const result = await this.deps.commit(() => {
        const session = this.current(job.sessionId);
        if ((session.titleRevision ?? 0) !== job.revision || session.titleGeneration?.attemptId !== job.attemptId
          || job.automatic && session.titleSource !== "fallback" || job.revision >= Number.MAX_SAFE_INTEGER) {
          if (session.titleGeneration?.attemptId === job.attemptId) session.titleGeneration.state = "discarded";
          return undefined;
        }
        session.title = title; session.titleSource = "generated"; session.titleRevision = job.revision + 1;
        session.titleGeneration.state = "completed";
        return this.response(session);
      });
      if (!result) throw conflict();
      job.resolve(result);
    } catch (error) {
      if (!this.closed && this.deps.healthy()) {
        try { await this.deps.commit(() => {
          const generation = this.deps.session(job.sessionId)?.titleGeneration;
          if (generation?.attemptId === job.attemptId && generation.state === "pending") { generation.state = "failed"; generation.error = "generation-failed"; }
        }); } catch { /* Primary persistence has its own fail-closed supervision. */ }
      }
      job.reject(error instanceof SessionNamingError ? error : new SessionNamingError(502, "title-generation-failed", "Title generation failed; the previous title was preserved"));
    }
  }
  close(): Promise<void> {
    this.closed = true; this.abort.abort();
    for (const job of this.jobs.splice(0)) { this.pending.delete(job.sessionId); job.reject(new SessionNamingError(503, "title-unavailable", "Title generation stopped")); }
    return Promise.all([...this.active]).then(() => {});
  }
}
