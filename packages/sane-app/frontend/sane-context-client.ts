import { request } from "./cc-client";

export type ContextRun = { id: string; sessionId: string; createdAt: string; harness?: string; nativeSessionId?: string; cwd?: string };
export type RecordedContext = {
  sequence: number; time: string; messageId: string; text: string;
  placement?: string; origin?: string; authoredBody?: string; sha256?: string;
  segments?: { id: string; category: string; reason: string }[];
  submission: string; acceptance: string; warning?: string;
};
type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue => !!value && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === "string" && value.length > 0;
function invalid(): never { throw new Error("Recorded SANE context is incomplete or invalid. No current context was substituted."); }
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : object(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value) ?? "null";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
async function hash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
async function range(bytes: Uint8Array<ArrayBuffer>, value: unknown): Promise<{ text: string; start: number; end: number }> {
  if (!object(value) || !object(value.range) || !string(value.sha256)) invalid();
  const { offset, length } = value.range;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || (offset as number) < 0 || (length as number) < 0
    || (offset as number) > bytes.length - (length as number)) invalid();
  const start = offset as number, end = start + (length as number), selected = bytes.slice(start, end);
  if (await hash(selected) !== value.sha256) invalid();
  return { text: decoder.decode(selected), start, end };
}

/** Existing authenticated, App-owned history only. Never loads native history,
 * framework files, prepared packages, or activation state. Keep only lean IDs. */
export async function loadContextRuns(sessionId: string, signal: AbortSignal): Promise<ContextRun[]> {
  const result: unknown = await request(`/api/sessions/${encodeURIComponent(sessionId)}/runs`, { signal });
  if (!object(result) || !Array.isArray(result.runs)) invalid();
  const seen = new Set<string>();
  return result.runs.map((value): ContextRun => {
    if (!object(value) || !string(value.runId) || value.sessionId !== sessionId || !string(value.createdAt)
      || !Number.isFinite(Date.parse(value.createdAt)) || seen.has(value.runId)) invalid();
    seen.add(value.runId);
    for (const key of ["harness", "nativeSessionId", "cwd"] as const) if (value[key] !== undefined && typeof value[key] !== "string") invalid();
    return { id: value.runId, sessionId, createdAt: value.createdAt, harness: value.harness as string | undefined,
      nativeSessionId: value.nativeSessionId as string | undefined, cwd: value.cwd as string | undefined };
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Inspection integrity checks only, NOT the Node composer's admission decoder.
 * Checks recorded byte ranges/hashes and source correlation without importing
 * server-only fs/crypto modules or inferring composition from textual headings. */
async function inspectComposition(data: RecordValue, run: ContextRun) {
  const meta = data.composition;
  if (!object(meta) || meta.schema !== 1 || meta.type !== "context-message-composition" || meta.messageSchema !== 1
    || !object(meta.dispatch) || !object(meta.dispatch.source) || !object(meta.placement) || !object(meta.transport)
    || !Array.isArray(meta.segments) || !string(meta.origin) || typeof data.text !== "string") invalid();
  const dispatch = meta.dispatch, source = dispatch.source as RecordValue;
  if (dispatch.runId !== run.id || source.sessionId !== run.sessionId
    || !["harnessId", "sessionId", "authorityId", "nativeSessionId", "cwd"].every(key => string(source[key]))
    || run.harness !== undefined && source.harnessId !== run.harness
    || run.nativeSessionId !== undefined && source.nativeSessionId !== run.nativeSessionId
    || run.cwd !== undefined && source.cwd !== run.cwd
    || source.harnessId === "opencode" && dispatch.nativeCommandId !== data.messageId) invalid();
  const kind = meta.placement.kind;
  if (!["body-only", "bootstrap", "selected"].includes(kind as string)
    || kind === "selected" && !["update", "sharing", "branch-update"].includes(meta.placement.purpose as string)) invalid();
  const bytes = encoder.encode(data.text);
  if (decoder.decode(bytes) !== data.text || bytes.length !== meta.transport.byteLength || await hash(bytes) !== meta.transport.sha256) invalid();
  const body = await range(bytes, meta.body);
  if (body.end !== bytes.length) invalid();
  let previousEnd = 0;
  const ids = new Set<string>(), contents: RecordValue[] = [];
  const segments: NonNullable<RecordedContext["segments"]> = [];
  for (const segment of meta.segments) {
    if (!object(segment) || !string(segment.id) || !string(segment.category) || !string(segment.reason) || !object(segment.provenance)
      || ids.has(segment.id)) invalid();
    ids.add(segment.id);
    const selected = await range(bytes, segment);
    if (selected.start < previousEnd || selected.end > body.start) invalid();
    previousEnd = selected.end;
    const { range: _range, ...content } = segment;
    contents.push({ ...content, text: selected.text });
    segments.push({ id: segment.id, category: segment.category, reason: segment.reason });
  }
  if (await hash(encoder.encode(canonical(contents))) !== meta.selectionHash
    || kind === "body-only" && (segments.length !== 0 || body.start !== 0)
    || kind !== "body-only" && !segments.length) invalid();
  return { placement: kind === "selected" ? `selected · ${meta.placement.purpose}` : kind as string,
    origin: meta.origin, authoredBody: body.text, sha256: meta.transport.sha256 as string, segments, dispatch };
}

/** Bounded, protected, nonrepairing disk snapshot. Never fall back to the legacy
 * event endpoint, whose deferred-history reader may repair a journal. */
export async function loadRecordedContext(run: ContextRun, signal: AbortSignal): Promise<RecordedContext[]> {
  const result: unknown = await request(`/api/runs/${encodeURIComponent(run.id)}/context-evidence`, { signal });
  if (!object(result) || !Array.isArray(result.events)) invalid();
  let previous = 0;
  const events = result.events.map(value => {
    if (!object(value) || value.runId !== run.id || value.sessionId !== run.sessionId || !Number.isSafeInteger(value.seq)
      || (value.seq as number) !== previous + 1 || !string(value.kind) || !string(value.time)) invalid();
    previous = value.seq as number;
    return value;
  });
  if (result.nextCursor !== previous) invalid();
  const entries: RecordedContext[] = [];
  for (const event of events) {
    signal.throwIfAborted();
    const data = event.data;
    // Legacy marker-like user text is never classified as SANE context.
    if (event.kind !== "submission" || !object(data) || !Object.hasOwn(data, "composition")) continue;
    if (typeof data.text !== "string" || !string(data.messageId)) invalid();
    const entry: RecordedContext = { sequence: event.seq as number, time: event.time as string, messageId: data.messageId,
      text: data.text, submission: "Recorded only; delivery unknown", acceptance: "Unknown" };
    entries.push(entry);
    try {
      const { dispatch, ...composition } = await inspectComposition(data, run);
      Object.assign(entry, composition);
      if (events.filter(other => other.kind === "submission" && object(other.data) && other.data.messageId === data.messageId).length !== 1) invalid();
      let attempted = false, outcome = false;
      let boundary: unknown, recordedOutcome: string | undefined;
      for (const other of events) {
        const fact = other.data;
        if (other.kind !== "context" || !object(fact) || fact.type !== "context-message-dispatch" || fact.messageId !== data.messageId) continue;
        if (fact.schema !== 1 || (other.seq as number) <= (event.seq as number) || fact.transportSha256 !== entry.sha256
          || !["run-initial", "message"].includes(fact.boundary as string) || !object(fact.evidence)
          || boundary !== undefined && boundary !== fact.boundary || data.liveInput === true && fact.boundary !== "message") invalid();
        boundary = fact.boundary;
        const { submission, nativeAcceptance, ...identity } = fact.evidence;
        if (canonical(identity) !== canonical(dispatch) || !["not-submitted", "attempted", "submitted", "unknown"].includes(submission as string)
          || !["not-accepted", "accepted", "unknown"].includes(nativeAcceptance as string)
          || submission === "not-submitted" && nativeAcceptance !== "not-accepted"
          || nativeAcceptance === "accepted" && submission !== "submitted"
          || submission !== "not-submitted" && submission !== "submitted" && nativeAcceptance !== "unknown") invalid();
        if (fact.stage === "before-native" && submission === "attempted" && !outcome) attempted = true;
        else if (fact.stage === "outcome" && submission !== "attempted" && (attempted || submission === "not-submitted")) {
          const currentOutcome = canonical(fact.evidence);
          if (recordedOutcome !== undefined && recordedOutcome !== currentOutcome) invalid();
          recordedOutcome = currentOutcome;
          outcome = true;
        }
        else invalid();
        entry.submission = submission as string;
        entry.acceptance = nativeAcceptance as string;
      }
    } catch {
      // Preserve original transport evidence even when derived details cannot be
      // checked; don't bless a partial/contradictory observation as acceptance.
      delete entry.authoredBody; delete entry.segments;
      entry.submission = "Unconfirmed"; entry.acceptance = "Unknown";
      entry.warning = "Composition or dispatch evidence could not be fully checked. Only the original recorded outgoing text is authoritative here.";
    }
  }
  signal.throwIfAborted();
  return entries;
}
