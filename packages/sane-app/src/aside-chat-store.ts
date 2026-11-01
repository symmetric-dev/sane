import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import { join } from "node:path";
import { atomicAppRecord, exact } from "./app-store";
import { canonicalJSON, decodePreparedUserInput, fingerprint } from "./prepared-input-codec";
import { uuid } from "./history";
import type { PreparedUserInput } from "./user-input-preparation";
import { AsideError } from "./aside-store";
import type { AsideChatSendRequest } from "../shared/aside-chat-contract";
import { parseAsideDraftRequest } from "../shared/aside-contract";
import { decodeAppAdmissionEnvelope, canonicalAppAdmissionPayload, type AppAdmissionEnvelope } from "../shared/conversation/app-admission-contract";
import { createHash } from "node:crypto";

export type AsideChatIntent = { request: AsideChatSendRequest; envelope: AppAdmissionEnvelope };
export type AsideChatBinding = {
  asideId: string; sessionId: string; sourceFingerprint: string; nativeSessionId: string | null;
  /** Original independent base conversation preparation, never parent activation. */
  prepared: PreparedUserInput; requests: AsideChatIntent[];
};
type Ledger = { version: 1; storeId: string; bindings: AsideChatBinding[] };
const FILE = "aside-chats.json", MAX_BYTES = 32 * 1024 * 1024;
/** Separate backend namespace: arbitrary durable aside request tokens cannot
 * collide with an unrelated browser's ordinary submission UUID. */
export function asideChatAdmissionRequestId(storeId: string, asideId: string, requestId: string): string {
  const h = createHash("sha256").update(canonicalJSON(["aside-chat", storeId, asideId, requestId])).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const check: (ok: unknown, message?: string) => asserts ok = (ok, message = "Invalid aside conversation binding") => { if (!ok) throw new Error(message); };
const stamp = (s: Stats) => ({ dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, mode: s.mode, uid: s.uid, nlink: s.nlink });

/** Binding and frozen request identity ONLY. Dispatch receipts/evidence remain in
 * the existing AppAdmissionService and run journals; this store never retries a
 * dispatch or interprets an unresolved request as permission to send again. */
export class AsideChatStore {
  private ledger: Ledger;
  private root: { dev: number; ino: number };
  private file: ReturnType<typeof stamp> | null = null;
  private failed = false;
  constructor(private readonly directory: string, private readonly storeId: string,
    private readonly assertOwner: () => void, private readonly failClosed: (error: unknown) => void) {
    this.ledger = { version: 1, storeId, bindings: [] };
    const root = lstatSync(directory); this.root = { dev: root.dev, ino: root.ino };
    try {
      check(uuid(storeId)); this.guardRoot();
      let stat: Stats;
      try { stat = lstatSync(join(directory, FILE)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      this.safe(stat);
      const fd = openSync(join(directory, FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = fstatSync(fd); this.safe(opened); check(canonicalJSON(stamp(opened)) === canonicalJSON(stamp(stat)));
        const bytes = Buffer.alloc(opened.size + 1); let used = 0, count = 0;
        while (used < bytes.length && (count = readSync(fd, bytes, used, bytes.length - used, used))) used += count;
        check(used === opened.size);
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used)));
        this.validate(value);
        const after = lstatSync(join(directory, FILE)); this.safe(after);
        check(canonicalJSON(stamp(fstatSync(fd))) === canonicalJSON(stamp(opened)) && canonicalJSON(stamp(after)) === canonicalJSON(stamp(opened)));
        this.guardRoot(); this.file = stamp(after); this.ledger = value;
      } finally { closeSync(fd); }
    } catch (error) { this.fatal(error); }
  }
  private fatal(error: unknown): never {
    this.failed = true;
    try { this.failClosed(error); } catch { /* Preserve the storage refusal. */ }
    throw new AsideError(503, "aside-chat-storage", "Aside conversation storage requires reconciliation");
  }
  private safe(s: Stats) {
    check(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.size <= MAX_BYTES && s.uid === process.getuid?.() && !(s.mode & 0o077), "Unsafe aside conversation ledger");
  }
  private guardRoot() {
    this.assertOwner();
    const s = lstatSync(this.directory);
    check(!this.failed && s.isDirectory() && !s.isSymbolicLink() && realpathSync(this.directory) === this.directory
      && s.dev === this.root.dev && s.ino === this.root.ino && s.uid === process.getuid?.() && !(s.mode & 0o022));
  }
  private guard() {
    this.guardRoot();
    let s: Stats;
    try { s = lstatSync(join(this.directory, FILE)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && this.file === null) return; throw error; }
    this.safe(s); check(this.file !== null && canonicalJSON(stamp(s)) === canonicalJSON(this.file), "Aside binding ledger changed outside its owner");
  }
  private validate(value: unknown): asserts value is Ledger {
    exact(value, ["version", "storeId", "bindings"]);
    check(value.version === 1 && value.storeId === this.storeId && Array.isArray(value.bindings) && value.bindings.length <= 512);
    check(Buffer.byteLength(canonicalJSON(value)) <= MAX_BYTES);
    const ids = new Set<string>(), sessions = new Set<string>(), requests = new Set<string>();
    for (const b of value.bindings) {
      exact(b, ["asideId", "sessionId", "sourceFingerprint", "nativeSessionId", "prepared", "requests"]);
      check(uuid(b.asideId) && uuid(b.sessionId) && !ids.has(b.asideId) && !sessions.has(b.sessionId)); ids.add(b.asideId); sessions.add(b.sessionId);
      check(typeof b.sourceFingerprint === "string" && /^[a-f0-9]{64}$/.test(b.sourceFingerprint));
      const p = decodePreparedUserInput(b.prepared);
      check(!p.resume && p.binding.conversationId === b.sessionId && p.binding.harness !== "grok"
        && !p.configuration.agent && !p.configuration.saneContext && !p.configuration.saneExecution);
      check(b.nativeSessionId === null || (p.binding.harness === "opencode" ? typeof b.nativeSessionId === "string" && /^ses[a-zA-Z0-9_-]{1,200}$/.test(b.nativeSessionId) : uuid(b.nativeSessionId)));
      check(Array.isArray(b.requests) && b.requests.length <= 2048);
      for (const item of b.requests) {
        // Persisted identities retain their original schema. Tightening current
        // send policy (e.g. reserving /compact) must not corrupt old frozen intents.
        exact(item, ["request", "envelope"]); const request = parseAsideDraftRequest(item.request), envelope = decodeAppAdmissionEnvelope(item.envelope);
        check(!!request.text.trim() && Buffer.from(request.text, "utf8").toString("utf8") === request.text);
        const key = canonicalJSON([b.asideId, request.requestId]); check(!requests.has(key)); requests.add(key);
        check(envelope.storeId === this.storeId && envelope.clientRequestId === asideChatAdmissionRequestId(this.storeId, b.asideId, request.requestId) && envelope.intent.operation === "message"
          && envelope.intent.conversationId === b.sessionId && envelope.intent.chainId === b.asideId
          && envelope.intent.payload.sessionId === b.sessionId && envelope.intent.payload.prompt === request.text
          && envelope.payloadSha256 === createHash("sha256").update(canonicalAppAdmissionPayload(envelope.intent)).digest("hex"));
      }
    }
  }
  private commit(next: Ledger, assertCurrent: () => void) {
    try { this.validate(next); } catch { throw new AsideError(429, "aside-chat-limit", "Aside conversation storage budget exceeded"); }
    try { this.guard(); } catch (error) { this.fatal(error); }
    assertCurrent();
    try { atomicAppRecord(this.directory, FILE, next); this.guardRoot(); const s = lstatSync(join(this.directory, FILE)); this.safe(s); this.file = stamp(s); }
    catch (error) { this.fatal(error); }
    this.ledger = next;
  }
  get(id: string): AsideChatBinding | undefined {
    try { this.guard(); } catch (error) { this.fatal(error); }
    const b = this.ledger.bindings.find(b => b.asideId === id); return b && structuredClone(b);
  }
  forSession(id: string): AsideChatBinding | undefined {
    const b = this.ledger.bindings.find(b => b.sessionId === id); return b && this.get(b.asideId);
  }
  allocate(binding: AsideChatBinding, assertCurrent: () => void): AsideChatBinding {
    const prior = this.get(binding.asideId); if (prior) return prior;
    const next = structuredClone(this.ledger); next.bindings.push(structuredClone(binding)); this.commit(next, assertCurrent); return structuredClone(binding);
  }
  bindNative(id: string, nativeSessionId: string, assertCurrent: () => void) {
    const b = this.get(id); if (!b) throw new AsideError(404, "aside-session-missing", "Aside binding is missing");
    if (b.nativeSessionId !== null) {
      if (b.nativeSessionId !== nativeSessionId) throw new AsideError(409, "aside-session-changed", "Original native destination changed");
      return;
    }
    const next = structuredClone(this.ledger); next.bindings.find(b => b.asideId === id)!.nativeSessionId = nativeSessionId; this.commit(next, assertCurrent);
  }
  remember(id: string, item: AsideChatIntent, assertCurrent: () => void): AsideChatIntent {
    const b = this.get(id); if (!b) throw new AsideError(404, "aside-session-missing", "Open the aside conversation first");
    const prior = b.requests.find(r => r.request.requestId === item.request.requestId);
    if (prior) {
      if (fingerprint(prior.request) !== fingerprint(item.request)) throw new AsideError(409, "aside-request-conflict", "Request ID already belongs to different text or revision");
      return prior;
    }
    const next = structuredClone(this.ledger); next.bindings.find(b => b.asideId === id)!.requests.push(structuredClone(item));
    this.commit(next, assertCurrent); return structuredClone(item);
  }
}
