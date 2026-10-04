import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Event, Run, Session } from "./history";
import { NATIVE_SUBAGENT_MAX_MESSAGES, NATIVE_SUBAGENT_PAGE_BYTES, type NativeSubagentList, type NativeSubagentPage } from "./native-subagent-contract";
import { nativeSubagentRevision, projectNativeSubagents } from "./native-subagent-projection";

export class NativeSubagentError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
type Projection = ReturnType<typeof projectNativeSubagents>;
type Cursor = { scope: string[]; revision: string; offset: number };
type CachedRun = { events: readonly Event[]; length: number; last?: Event; signature: string; children: Projection };
const inputError = () => new NativeSubagentError(400, "native-subagent-input", "Invalid native subagent selector or cursor");

export class NativeSubagentService {
  private readonly secret = randomBytes(32);
  private readonly cache = new Map<string, CachedRun>();
  private readonly lists = new Map<string, { signature: string; children: Projection; revision: string }>();
  constructor(private readonly sessions: () => readonly Session[], private readonly runs: () => readonly Run[], private readonly events: (runId: string) => readonly Event[]) {}

  private session(id: string) {
    const session = this.sessions().find(session => session.sessionId === id);
    if (!session) throw new NativeSubagentError(404, "native-subagent-missing", "Unknown session");
    return session;
  }
  private projection(session: Session, run: Run): Projection {
    const events = this.events(run.runId);
    const signature = JSON.stringify([session.harness, session.nativeSessionId, run.status]);
    const previous = this.cache.get(run.runId);
    if (previous && previous.events === events && previous.length === events.length && previous.last === events.at(-1) && previous.signature === signature) return previous.children;
    const children = projectNativeSubagents(session, run, events);
    this.cache.set(run.runId, { events, length: events.length, last: events.at(-1), signature, children });
    return children;
  }
  private parameters(params: URLSearchParams) {
    if ([...params.keys()].some(key => key !== "limit" && key !== "cursor") || params.getAll("limit").length > 1 || params.getAll("cursor").length > 1) throw inputError();
    const raw = params.get("limit");
    if (raw !== null && !/^[1-9]\d*$/.test(raw)) throw inputError();
    const limit = raw === null ? NATIVE_SUBAGENT_MAX_MESSAGES : Number(raw);
    if (!Number.isSafeInteger(limit) || limit > NATIVE_SUBAGENT_MAX_MESSAGES) throw inputError();
    return { limit, cursor: params.get("cursor") };
  }
  private encode(cursor: Cursor) {
    const payload = Buffer.from(JSON.stringify(cursor)).toString("base64url");
    return `${payload}.${createHmac("sha256", this.secret).update(payload).digest("base64url")}`;
  }
  private offset(raw: string | null, scope: string[], revision: string, fallback: number, maximum: number) {
    if (raw === null) return fallback;
    if (raw.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(raw)) throw inputError();
    const [payload, signature] = raw.split(".") as [string, string];
    const expected = createHmac("sha256", this.secret).update(payload).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw inputError();
    let cursor: Cursor;
    try { cursor = JSON.parse(Buffer.from(payload, "base64url").toString()); } catch { throw inputError(); }
    if (!cursor || JSON.stringify(cursor.scope) !== JSON.stringify(scope) || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || typeof cursor.revision !== "string") throw inputError();
    if (cursor.revision !== revision) throw new NativeSubagentError(409, "native-subagent-reset", "Recorded native subagent evidence changed; reload the snapshot");
    if (cursor.offset > maximum) throw inputError();
    return cursor.offset;
  }
  list(parentSessionId: string, params: URLSearchParams): NativeSubagentList {
    const session = this.session(parentSessionId);
    const { limit, cursor } = this.parameters(params);
    const projections = this.runs().filter(run => run.sessionId === parentSessionId).map(run => this.projection(session, run));
    const signature = projections.map(children => children.map(child => child.revision).join(",")).join(";");
    let list = this.lists.get(parentSessionId);
    if (!list || list.signature !== signature) {
      const children = projections.flat().reverse();
      list = { signature, children, revision: nativeSubagentRevision([parentSessionId, children.map(child => child.revision)]) };
      this.lists.set(parentSessionId, list);
    }
    const scope = ["list", parentSessionId];
    const start = this.offset(cursor, scope, list.revision, 0, list.children.length);
    const subagents: NativeSubagentList["subagents"] = [];
    const response: NativeSubagentList = { subagents, revision: list.revision, nextCursor: null, coverage: "recorded-only" };
    let end = start, bytes = Buffer.byteLength(JSON.stringify(response));
    while (end < list.children.length && subagents.length < limit) {
      const summary = list.children[end]!.summary;
      const size = Buffer.byteLength(JSON.stringify(summary)) + (subagents.length ? 1 : 0);
      const nextCursor = end + 1 < list.children.length ? this.encode({ scope, revision: list.revision, offset: end + 1 }) : null;
      const cursorBytes = Buffer.byteLength(JSON.stringify(nextCursor)) - 4;
      if (subagents.length && bytes + size + cursorBytes > NATIVE_SUBAGENT_PAGE_BYTES) break;
      subagents.push(summary); bytes += size; end++;
      response.nextCursor = nextCursor;
      if (bytes + cursorBytes >= NATIVE_SUBAGENT_PAGE_BYTES) break;
    }
    return response;
  }
  page(parentSessionId: string, runId: string, parentToolUseId: string, params: URLSearchParams): NativeSubagentPage {
    const session = this.session(parentSessionId);
    const run = this.runs().find(run => run.runId === runId && run.sessionId === parentSessionId);
    const child = run && this.projection(session, run).find(child => child.summary.parentToolUseId === parentToolUseId);
    if (!child) throw new NativeSubagentError(404, "native-subagent-missing", "Unknown native subagent");
    const { limit, cursor } = this.parameters(params);
    const scope = ["detail", parentSessionId, runId, parentToolUseId];
    const end = this.offset(cursor, scope, child.revision, child.messages.length, child.messages.length);
    const response: NativeSubagentPage = { subagent: child.summary, messages: [], revision: child.revision, nextCursor: null, coverage: "recorded-only" };
    // Serialize the mandatory summary once; add whole messages and cursor overhead.
    let start = end, bytes = Buffer.byteLength(JSON.stringify(response));
    while (start > 0 && end - start < limit) {
      const size = Buffer.byteLength(JSON.stringify(child.messages[start - 1])) + (start < end ? 1 : 0);
      const nextCursor = start > 1 ? this.encode({ scope, revision: child.revision, offset: start - 1 }) : null;
      const cursorBytes = Buffer.byteLength(JSON.stringify(nextCursor)) - 4;
      if (start < end && bytes + size + cursorBytes > NATIVE_SUBAGENT_PAGE_BYTES) break;
      start--; bytes += size;
      response.nextCursor = nextCursor;
      if (bytes + cursorBytes >= NATIVE_SUBAGENT_PAGE_BYTES) break;
    }
    response.messages = child.messages.slice(start, end);
    return response;
  }
}
