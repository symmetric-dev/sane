import { MEDIA_SHARE_LIMITS as LIMITS, parseMediaShareInput, type MediaShareRecord, type MediaShareReceipt, type NativeMediaShareRequest } from "../shared/media-share-contract";
import { exact } from "./app-store-format";
import { canonicalJSON } from "./prepared-input-codec";
import { parseCodeShareRequest } from "./code-share-service";
import { MediaShareError, MediaShareStore, mediaShareKey, mediaShareId } from "./media-share-store";
import { mediaFormat } from "./media-share-format";
import { WorkspaceError, type WorkspaceService } from "./workspace";

/** Reuse precisely the existing native caller/invocation admission grammar,
 * replacing only its input. Native source policy must not drift between tools. */
export function parseMediaShareRequest(value: unknown): NativeMediaShareRequest {
  try {
    exact(value, ["version", "caller", "invocation", "input"]);
    const envelope = parseCodeShareRequest({ ...value, input: { path: "media", startLine: 1, endLine: 1 } });
    return { ...envelope, input: parseMediaShareInput(value.input) };
  } catch { throw new MediaShareError(400, "invalid-media-share", "Invalid media share request"); }
}
export interface MediaShareAuthorization {
  sessionId: string; runId: string; workspaceId: string; worktreeId: string; bindingRevision: string;
  assertCurrent(): void;
  refresh?(): Promise<void>;
}
// Shared across service instances, not one counter per conversation.
let captures = 0;
const pendingByStore = new WeakMap<MediaShareStore, Map<string, Promise<MediaShareRecord>>>();
type Operation = { signal: AbortSignal; deadline: number; check(): void };
async function requestBody(req: Request, operation: Operation): Promise<unknown> {
  const declared = req.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > LIMITS.inputBytes)) throw new MediaShareError(413, "media-share-size", "Media request exceeds 128 KiB");
  if (!req.body) throw new MediaShareError(400, "invalid-media-share", "Expected a JSON request body");
  const reader = req.body.getReader(), chunks: Uint8Array[] = []; let used = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  operation.signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      operation.check(); const next = await reader.read(); operation.check();
      if (next.done) break;
      used += next.value.length;
      if (used > LIMITS.inputBytes) throw new MediaShareError(413, "media-share-size", "Media request exceeds 128 KiB");
      chunks.push(next.value);
    }
    const bytes = Buffer.concat(chunks);
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new MediaShareError(400, "invalid-media-share", "Expected bounded UTF-8 JSON"); }
  } finally { operation.signal.removeEventListener("abort", abort); void reader.cancel().catch(() => {}); }
}
export class MediaShareService {
  private readonly pending: Map<string, Promise<MediaShareRecord>>;
  constructor(private readonly store: MediaShareStore, private readonly workspace: Pick<WorkspaceService, "captureMedia">, private readonly resolveSession: (request: NativeMediaShareRequest) => string, private readonly authorize: (request: NativeMediaShareRequest, old?: MediaShareRecord) => Promise<MediaShareAuthorization>) {
    this.pending = pendingByStore.get(store) ?? new Map(); pendingByStore.set(store, this.pending);
  }
  async handle(req: Request): Promise<MediaShareReceipt> {
    if (req.method !== "POST") throw new MediaShareError(405, "method-not-allowed", "Use POST");
    const deadline = Date.now() + LIMITS.captureMs, controller = new AbortController();
    const abort = () => controller.abort(); req.signal.addEventListener("abort", abort, { once: true }); if (req.signal.aborted) abort();
    const timer = setTimeout(abort, LIMITS.captureMs);
    const operation: Operation = { signal: controller.signal, deadline, check() {
      if (req.signal.aborted) throw new MediaShareError(499, "media-share-aborted", "Media capture cancelled");
      if (Date.now() >= deadline) throw new MediaShareError(504, "media-share-time-limit", "Media capture deadline reached");
      if (controller.signal.aborted) throw new MediaShareError(499, "media-share-aborted", "Media capture cancelled");
    } };
    try {
      operation.check();
      const request = parseMediaShareRequest(await requestBody(req, operation)), sessionId = this.resolveSession(request), key = mediaShareKey(sessionId, request);
      // Reserve the invocation synchronously, before the first authorization
      // await. Waiters never replace the in-flight owner or read its sources.
      let prior = this.pending.get(key);
      while (prior) {
        const settled = prior.catch(() => undefined);
        await this.wait(settled, operation); operation.check();
        prior = this.pending.get(key);
      }
      operation.check();
      const capture = this.capture(request, sessionId, key, operation);
      this.pending.set(key, capture);
      try {
        const record = await capture;
        return { type: "sane.media-share", version: 1, shareId: record.id, media: record.media.map(({ path }) => ({ path })) };
      } finally { if (this.pending.get(key) === capture) this.pending.delete(key); }
    } catch (error) {
      // Workspace's existing operation controls deliberately retain their old
      // search error names. Classify only this binary capability at the edge.
      if (error instanceof WorkspaceError) {
        if (controller.signal.aborted || Date.now() >= deadline) operation.check();
        throw new MediaShareError(error.status, error.code, error.message);
      }
      throw error;
    } finally { clearTimeout(timer); req.signal.removeEventListener("abort", abort); }
  }
  private async wait<T>(promise: Promise<T>, operation: Operation): Promise<T> {
    // Observe late evidence-read failures even if the operation expired during
    // the synchronous part of the producer, before the race can be installed.
    void promise.catch(() => {});
    operation.check();
    let abort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => { try { operation.check(); } catch (error) { reject(error); } };
      operation.signal.addEventListener("abort", abort, { once: true }); if (operation.signal.aborted) abort();
    });
    try { return await Promise.race([promise, cancelled]); }
    finally { if (abort) operation.signal.removeEventListener("abort", abort); }
  }
  private async capture(request: NativeMediaShareRequest, expectedSessionId: string, key: string, operation: Operation): Promise<MediaShareRecord> {
    const old = this.store.find(key);
    // Even conflicts require authoritative admission, before any workspace I/O.
    const authorization = await this.wait(this.authorize(request, old), operation);
    operation.check(); authorization.assertCurrent();
    if (authorization.sessionId !== expectedSessionId) throw new MediaShareError(409, "media-share-binding", "Conversation admission changed");
    if (old) {
      if (canonicalJSON(old.input) !== canonicalJSON(request.input)) throw new MediaShareError(409, "media-share-conflict", "This invocation already shared different media");
      return old; // Source deletion or checkout loss does not affect recovery.
    }
    if (captures >= LIMITS.concurrentCaptures) throw new MediaShareError(429, "media-share-busy", "Media capture is busy; try again shortly");
    captures++;
    let stage: ReturnType<MediaShareStore["begin"]> | undefined;
    const check = () => { operation.check(); authorization.assertCurrent(); };
    try {
      check();
      const { sessionId, runId, workspaceId, worktreeId, bindingRevision } = authorization, id = mediaShareId(key);
      stage = this.store.begin(sessionId, id);
      const media: MediaShareRecord["media"] = [];
      for (const input of request.input.media) {
        check(); let format: ReturnType<typeof mediaFormat>;
        try { format = mediaFormat(input.path); }
        catch { throw new MediaShareError(415, "media-share-format", "Only PNG, JPEG, WebP and MP4 files are supported"); }
        const item = await stage.capture(input.path, sink => this.workspace.captureMedia(`${workspaceId}/${worktreeId}`, bindingRevision, input.path, format.maxBytes, sink, operation), check);
        media.push(item); check();
      }
      await this.wait(authorization.refresh?.() ?? Promise.resolve(), operation); check();
      const record: MediaShareRecord = {
        version: 1, id, sessionId, native: { harness: request.caller.source.harness, authorityId: request.caller.authorityId, nativeId: request.caller.nativeId },
        anchor: { runId, toolCallId: request.invocation.toolCallId, messageId: request.invocation.messageId ?? null, invocationId: request.invocation.invocationId, wrapper: request.invocation.wrapper ?? null },
        workspaceId, worktreeId, bindingRevision, createdAt: new Date().toISOString(), input: request.input, media,
      };
      return stage.commit(record, check);
    } finally {
      try { await stage?.discard(); } finally { captures--; }
    }
  }
}
