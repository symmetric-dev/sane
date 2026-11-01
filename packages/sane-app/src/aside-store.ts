import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { atomicAppRecord, exact } from "./app-store";
import { canonicalJSON } from "./prepared-input-codec";
import { uuid } from "./history";
import {
  ASIDE_LIMITS, parseAsideCreateRequest, parseAsideDraftRequest, parseAsideLifecycleRequest,
  parseAsideRecord, parseAsideSourceSnapshot, summarizeAside,
  type AsideCreateRequest, type AsideDraftRequest, type AsideLifecycleRequest,
  type AsideRecord, type AsideSourceSnapshot, type AsideSummary,
} from "../shared/aside-contract";

export class AsideError extends Error {
  constructor(readonly status: number, readonly code: string, message = code) { super(message); }
}
type Operation = "create" | "draft" | "lifecycle";
type State = Pick<AsideRecord, "draft" | "lifecycle" | "revision" | "updatedAt">;
/** Only mutable response state is repeated. The immutable source/identity lives
 * once in records; replay reconstructs the exact original response from it. */
type Receipt = { operation: Operation; id: string; requestId: string; fingerprint: string; state: State };
type Ledger = { version: 1; storeId: string; records: AsideRecord[]; receipts: Receipt[] };
const referenceSnapshot = Symbol("aside-store-reference");
/** Internal reference capability, never a response or persisted delivery claim.
 * Its complete record/source tree is frozen by the owning store. */
export type AsideReferenceSnapshot = Readonly<{
  [referenceSnapshot]: true;
  record: Readonly<AsideRecord>;
  sourceFingerprint: string;
}>;
export type AsideReadMetadata = Readonly<{
  id: string; sourceSessionId: string; sourceFingerprint: string; transcriptFingerprint: string;
  native: Readonly<AsideSourceSnapshot["native"]>; binding: Readonly<AsideSourceSnapshot["binding"]>;
  lifecycle: AsideRecord["lifecycle"]; revision: number;
}>;
type ReadEntry = { metadata: AsideReadMetadata; reference: AsideReferenceSnapshot };
const FILE = "asides.json";
const hash = (v: unknown) => createHash("sha256").update(canonicalJSON(v)).digest("hex");
const state = (r: AsideRecord): State => ({ draft: r.draft, lifecycle: r.lifecycle, revision: r.revision, updatedAt: r.updatedAt });
const target = (r: AsideRecord): AsideCreateRequest["target"] => r.source.question
  ? { kind: "question", formId: r.source.question.formId, questionIndex: r.source.question.questionIndex }
  : { kind: "conversation" };
const fingerprint = (sessionId: string, operation: Operation, id: string, request: unknown) => hash([sessionId, operation, operation === "create" ? null : id, request]);
function invalid(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function conflict(message: string): never { throw new AsideError(409, "aside-conflict", message); }
function badRequest(error: unknown): never { throw new AsideError(400, "aside-invalid", error instanceof Error ? error.message : "Invalid aside request"); }
function parse<T>(parser: (v: unknown) => T, value: unknown): T { try { return parser(value); } catch (error) { badRequest(error); } }
const ordered = (a: AsideSummary, b: AsideSummary) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
function freezeTree(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeTree(child);
  Object.freeze(value);
}

/** App-owned durable drafts, not sessions or native runs. No admissions,
 * namespace grants, source locks, context delivery, or execution are created.
 * Discard is a retained terminal tombstone, NOT physical data erasure. */
export class AsideStore {
  private ledger: Ledger;
  private failed = false;
  private reads = new Map<string, ReadEntry>();
  private sourceFingerprints = new WeakMap<AsideSourceSnapshot, string>();
  private rootIdentity!: { dev: number; ino: number };
  private fileIdentity: ReturnType<AsideStore["fileStamp"]> | null = null;

  constructor(private readonly dataDir: string, private readonly storeId: string, private readonly failClosed: (error: unknown) => void) {
    this.ledger = { version: 1, storeId, records: [], receipts: [] };
    try {
      invalid(uuid(storeId), "Invalid aside store identity");
      const root = lstatSync(dataDir);
      invalid(root.isDirectory() && !root.isSymbolicLink() && realpathSync(dataDir) === dataDir && root.uid === process.getuid?.() && !(root.mode & 0o022), "Unsafe aside store directory");
      this.rootIdentity = { dev: root.dev, ino: root.ino };
      let info: Stats;
      try { info = lstatSync(join(dataDir, FILE)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      this.safeFile(info);
      const fd = openSync(join(dataDir, FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = fstatSync(fd); this.safeFile(opened);
        invalid(opened.dev === info.dev && opened.ino === info.ino, "Aside ledger changed");
        const bytes = Buffer.alloc(opened.size + 1); let used = 0, count = 0;
        while (used < bytes.length && (count = readSync(fd, bytes, used, bytes.length - used, used))) used += count;
        invalid(used === opened.size, "Aside ledger changed");
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used)));
        this.validate(value);
        const after = fstatSync(fd), current = lstatSync(join(dataDir, FILE)); this.safeFile(current);
        invalid(canonicalJSON(this.fileStamp(after)) === canonicalJSON(this.fileStamp(opened))
          && canonicalJSON(this.fileStamp(current)) === canonicalJSON(this.fileStamp(opened)), "Aside ledger changed");
        this.assertRootCurrent(); this.fileIdentity = this.fileStamp(current);
        this.install(value, this.index(value));
      } finally { closeSync(fd); }
    } catch (error) { this.storageFailure(error, "Aside storage unavailable or corrupt"); }
  }

  private safeFile(info: Stats): void {
    invalid(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= ASIDE_LIMITS.ledgerBytes
      && info.uid === process.getuid?.() && !(info.mode & 0o077), "Unsafe aside ledger");
  }
  private fileStamp(info: Stats) { return { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs }; }
  private available(): void { if (this.failed) throw new AsideError(503, "aside-storage", "Aside storage is unavailable"); }
  private storageFailure(error: unknown, message: string): never {
    this.failed = true;
    this.reads.clear(); this.sourceFingerprints = new WeakMap();
    try { this.failClosed(error); } catch { /* Preserve the storage error, not callback failure. */ }
    throw new AsideError(503, "aside-storage", `${message}; reconciliation required`);
  }
  private assertRootCurrent(): void {
    const root = lstatSync(this.dataDir);
    invalid(root.isDirectory() && !root.isSymbolicLink() && realpathSync(this.dataDir) === this.dataDir
      && root.dev === this.rootIdentity.dev && root.ino === this.rootIdentity.ino
      && root.uid === process.getuid?.() && !(root.mode & 0o022), "Aside store directory changed");
  }
  private assertStorageCurrent(): void {
    this.available(); this.assertRootCurrent();
    let info: Stats;
    try { info = lstatSync(join(this.dataDir, FILE)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && this.fileIdentity === null) return; throw error; }
    this.safeFile(info);
    invalid(this.fileIdentity !== null && canonicalJSON(this.fileStamp(info)) === canonicalJSON(this.fileIdentity), "Aside ledger changed outside its owner");
  }

  /** Every committed revision has exactly one receipt, starting with create.
   * Replay the entire compact history at startup; do not repair missing receipts,
   * prune old requests, or silently normalize corrupt state. */
  private validate(value: unknown): asserts value is Ledger {
    canonicalJSON(value); exact(value, ["version", "storeId", "records", "receipts"]);
    invalid(value.version === 1 && value.storeId === this.storeId && Array.isArray(value.records) && Array.isArray(value.receipts), "Invalid aside ledger");
    invalid(value.records.length <= ASIDE_LIMITS.records && value.receipts.length <= ASIDE_LIMITS.receipts, "Aside ledger count limit exceeded");
    invalid(Buffer.byteLength(JSON.stringify(value)) <= ASIDE_LIMITS.ledgerBytes, "Aside ledger byte limit exceeded");
    const records = new Map<string, AsideRecord>(), previous = new Map<string, State>(), requestIds = new Set<string>();
    const sizes = new Map<string, number>(), counts = new Map<string, number>(), receipts = new Map<string, number>();
    const budget = (sessionId: string, item: unknown): void => {
      const size = (sizes.get(sessionId) ?? 0) + Buffer.byteLength(JSON.stringify(item));
      invalid(size <= ASIDE_LIMITS.sourceLedgerBytes, "Source aside byte budget exceeded"); sizes.set(sessionId, size);
    };
    for (const raw of value.records) {
      const r = parseAsideRecord(raw);
      invalid(!records.has(r.id) && r.source.storeId === this.storeId && resolve(r.source.binding.cwd) === r.source.binding.cwd, "Invalid aside source identity");
      invalid(r.source.transcript.fingerprint === hash(r.source.transcript.messages), "Aside transcript fingerprint mismatch");
      records.set(r.id, r);
      const count = (counts.get(r.source.sessionId) ?? 0) + 1;
      invalid(count <= ASIDE_LIMITS.sourceRecords, "Source aside count budget exceeded"); counts.set(r.source.sessionId, count);
      budget(r.source.sessionId, r);
    }
    for (const receipt of value.receipts) {
      exact(receipt, ["operation", "id", "requestId", "fingerprint", "state"]);
      invalid(["create", "draft", "lifecycle"].includes(receipt.operation) && typeof receipt.fingerprint === "string" && /^[a-f0-9]{64}$/.test(receipt.fingerprint), "Invalid aside receipt");
      const record = records.get(receipt.id); invalid(record, "Orphan aside receipt");
      const s = receipt.state; exact(s, ["draft", "lifecycle", "revision", "updatedAt"]);
      // Reuse request validators for text, request identity, revisions, lifecycle,
      // and strict JSON shape without copying the immutable source per receipt.
      parseAsideDraftRequest({ requestId: receipt.requestId, expectedRevision: s.revision, text: s.draft });
      parseAsideLifecycleRequest({ requestId: receipt.requestId, expectedRevision: s.revision, lifecycle: s.lifecycle });
      invalid(typeof s.updatedAt === "string" && s.updatedAt.length <= 64 && Number.isFinite(Date.parse(s.updatedAt)), "Invalid aside receipt timestamp");
      const key = canonicalJSON([record.source.sessionId, receipt.requestId]);
      invalid(!requestIds.has(key), "Duplicate aside request ID"); requestIds.add(key);
      const prior = previous.get(record.id); let intent: AsideCreateRequest | AsideDraftRequest | AsideLifecycleRequest;
      if (receipt.operation === "create") {
        invalid(!prior && s.revision === 1 && s.lifecycle === "open" && s.updatedAt === record.createdAt, "Invalid aside creation receipt");
        intent = { requestId: receipt.requestId, target: target(record), draft: s.draft };
        parseAsideCreateRequest(intent);
      } else {
        invalid(prior && s.revision === prior.revision + 1 && prior.lifecycle !== "discarded"
          && Date.parse(s.updatedAt) >= Date.parse(prior.updatedAt), "Invalid aside revision chain");
        if (receipt.operation === "draft") {
          invalid(prior.lifecycle === "open" && s.lifecycle === "open", "Closed aside was edited");
          intent = { requestId: receipt.requestId, expectedRevision: prior.revision, text: s.draft };
        } else {
          invalid(s.draft === prior.draft, "Lifecycle mutation changed the draft");
          intent = { requestId: receipt.requestId, expectedRevision: prior.revision, lifecycle: s.lifecycle };
        }
      }
      invalid(receipt.fingerprint === fingerprint(record.source.sessionId, receipt.operation, record.id, intent), "Aside receipt intent mismatch");
      previous.set(record.id, { draft: s.draft, lifecycle: s.lifecycle, revision: s.revision, updatedAt: s.updatedAt });
      const count = (receipts.get(record.source.sessionId) ?? 0) + 1;
      invalid(count <= ASIDE_LIMITS.sourceReceipts, "Source aside receipt budget exceeded"); receipts.set(record.source.sessionId, count);
      budget(record.source.sessionId, receipt);
    }
    for (const record of records.values()) invalid(canonicalJSON(previous.get(record.id)) === canonicalJSON(state(record)), "Aside current state lacks matching receipt history");
  }

  private commit(next: Ledger, assertCurrent: () => void): void {
    this.available();
    try { this.validate(next); } catch (error) { throw new AsideError(429, "aside-limit", error instanceof Error ? error.message : "Aside storage budget reached"); }
    const reads = this.index(next);
    try { this.assertStorageCurrent(); } catch (error) { this.storageFailure(error, "Aside storage ownership changed"); }
    // Service guard runs after validation, immediately before durable mutation;
    // a stale source/binding is a domain rejection, not a storage failure latch.
    assertCurrent();
    try {
      atomicAppRecord(this.dataDir, FILE, next);
      this.assertRootCurrent();
      const current = lstatSync(join(this.dataDir, FILE)); this.safeFile(current); this.fileIdentity = this.fileStamp(current);
    } catch (error) { this.storageFailure(error, "Aside commit failed"); }
    this.install(next, reads);
  }

  private index(ledger: Ledger): Map<string, ReadEntry> {
    const reads = new Map<string, ReadEntry>();
    for (const record of ledger.records) {
      // Only validated, owned JSON reaches this path. Fingerprints cover the
      // COMPLETE source, including its exact question, not just the transcript.
      freezeTree(record);
      let sourceFingerprint = this.sourceFingerprints.get(record.source);
      if (sourceFingerprint === undefined) {
        sourceFingerprint = hash(record.source);
        this.sourceFingerprints.set(record.source, sourceFingerprint);
      }
      const metadata: AsideReadMetadata = Object.freeze({ id: record.id, sourceSessionId: record.source.sessionId,
        sourceFingerprint, transcriptFingerprint: record.source.transcript.fingerprint,
        native: record.source.native, binding: record.source.binding, lifecycle: record.lifecycle, revision: record.revision });
      reads.set(record.id, { metadata, reference: Object.freeze({ [referenceSnapshot]: true as const, record, sourceFingerprint }) });
    }
    return reads;
  }
  private install(ledger: Ledger, reads: Map<string, ReadEntry>): void { this.ledger = ledger; this.reads = reads; }
  private copyLedger(): Ledger {
    // Records are deeply frozen and receipts are private append-only history.
    // Mutations replace their selected record before editing scalar state.
    return { ...this.ledger, records: [...this.ledger.records], receipts: [...this.ledger.receipts] };
  }

  /** Cheap internal state reads; no transcript clone and no delivery inference. */
  getMetadata(id: string): AsideReadMetadata | undefined { this.available(); return this.reads.get(id)?.metadata; }
  /** Internal immutable reference only. Public reads remain detached via get(). */
  getReference(id: string): AsideReferenceSnapshot | undefined { this.available(); return this.reads.get(id)?.reference; }

  get(id: string): AsideRecord | undefined {
    this.available(); const record = this.ledger.records.find(r => r.id === id); return record && structuredClone(record);
  }
  list(sessionId: string): AsideSummary[] { this.available(); return this.ledger.records.filter(r => r.source.sessionId === sessionId).map(summarizeAside).sort(ordered); }
  summaries(): AsideSummary[] { this.available(); return this.ledger.records.map(summarizeAside).sort(ordered); }

  private replay(sessionId: string, operation: Operation, id: string, request: { requestId: string }): AsideRecord | undefined {
    const receipt = this.ledger.receipts.find(v => v.requestId === request.requestId && this.ledger.records.find(r => r.id === v.id)?.source.sessionId === sessionId);
    if (!receipt) return undefined;
    if (receipt.fingerprint !== fingerprint(sessionId, operation, id, request)) conflict("Request ID already used for a different aside intent");
    const current = this.ledger.records.find(r => r.id === receipt.id)!;
    return structuredClone({ ...current, ...receipt.state });
  }
  replayCreate(sessionId: string, request: AsideCreateRequest): AsideRecord | undefined {
    this.available(); if (!uuid(sessionId)) badRequest(new Error("Invalid source session UUID"));
    return this.replay(sessionId, "create", "", parse(parseAsideCreateRequest, request));
  }
  create(sessionId: string, request: AsideCreateRequest, source: AsideSourceSnapshot, assertCurrent: () => void): AsideRecord {
    this.available(); const input = parse(parseAsideCreateRequest, request), prior = this.replayCreate(sessionId, input);
    // Replay precedes recapture/revalidation of today's mutable source state.
    if (prior) return prior;
    const snapshot = parse(parseAsideSourceSnapshot, source);
    if (snapshot.storeId !== this.storeId || snapshot.sessionId !== sessionId) badRequest(new Error("Aside source does not match its store/session"));
    if (snapshot.transcript.fingerprint !== hash(snapshot.transcript.messages)) badRequest(new Error("Aside transcript fingerprint mismatch"));
    const q = snapshot.question;
    if (input.target.kind === "conversation" ? !!q : !q || q.formId !== input.target.formId || q.questionIndex !== input.target.questionIndex) badRequest(new Error("Aside target differs from captured source"));
    const now = new Date(Math.max(Date.now(), Date.parse(snapshot.capturedAt))).toISOString();
    const record = parse(parseAsideRecord, { version: 1, id: randomUUID(), source: snapshot, purpose: q ? "question-explanation" : "discussion",
      lifecycle: "open", draft: input.draft, revision: 1, createdAt: now, updatedAt: now });
    const next = this.copyLedger(); next.records.push(record);
    next.receipts.push({ operation: "create", id: record.id, requestId: input.requestId,
      fingerprint: fingerprint(sessionId, "create", record.id, input), state: state(record) });
    this.commit(next, assertCurrent); return structuredClone(record);
  }

  private mutate(operation: "draft" | "lifecycle", id: string, request: AsideDraftRequest | AsideLifecycleRequest, assertCurrent: () => void): AsideRecord {
    this.available();
    const input = operation === "draft" ? parse(parseAsideDraftRequest, request) : parse(parseAsideLifecycleRequest, request);
    const current = this.ledger.records.find(r => r.id === id);
    if (!current) throw new AsideError(404, "aside-not-found", "Aside not found");
    const prior = this.replay(current.source.sessionId, operation, id, input); if (prior) return prior;
    if (input.expectedRevision !== current.revision) conflict("Aside revision changed");
    if (current.lifecycle === "discarded") conflict("Discarded asides are terminal retained records");
    if (operation === "draft" && current.lifecycle !== "open") conflict("Only open aside drafts can be edited");
    const next = this.copyLedger(), record = { ...current };
    next.records[next.records.findIndex(r => r.id === id)] = record;
    if (operation === "draft") record.draft = (input as AsideDraftRequest).text;
    else record.lifecycle = (input as AsideLifecycleRequest).lifecycle;
    record.revision++; record.updatedAt = new Date(Math.max(Date.now(), Date.parse(record.updatedAt))).toISOString();
    next.receipts.push({ operation, id, requestId: input.requestId, fingerprint: fingerprint(current.source.sessionId, operation, id, input), state: state(record) });
    this.commit(next, assertCurrent); return structuredClone(record);
  }
  saveDraft(id: string, request: AsideDraftRequest, assertCurrent: () => void): AsideRecord { return this.mutate("draft", id, request, assertCurrent); }
  setLifecycle(id: string, request: AsideLifecycleRequest, assertCurrent: () => void): AsideRecord { return this.mutate("lifecycle", id, request, assertCurrent); }
}
