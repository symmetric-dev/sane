import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { atomicAppRecord, exact } from "./app-store";
import { canonicalJSON } from "./prepared-input-codec";
import {
  isUserQuestionsRecord, parsePresentQuestionsInput, parseUserQuestionAnswers,
  type PresentQuestionsInput, type UserQuestionsAnswerRequest, type UserQuestionsSimpleRequest, type UserQuestionsRecord,
} from "../shared/user-questions-contract";

export class UserQuestionsError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
type Identity = Pick<UserQuestionsRecord, "sessionId" | "native" | "anchor" | "workspaceId" | "worktreeId" | "bindingRevision" | "cwd">;
type Operation = "save" | "submit" | "dismiss" | "resume";
type Receipt = { operation: Operation; sessionId: string; formId: string; requestId: string; fingerprint: string; record: UserQuestionsRecord };
type Ledger = { version: 1; storeId: string; forms: UserQuestionsRecord[]; operations: Receipt[] };
const FILE = "user-questions.json", MAX_BYTES = 32 * 1024 * 1024, SESSION_BYTES = 8 * 1024 * 1024;
const MAX_FORMS = 2000, MAX_OPERATIONS = 8192;
const hash = (value: unknown) => createHash("sha256").update(canonicalJSON(value)).digest("hex");
// A run can be replayed under another App run; native invocation identity is stable.
const invocation = (v: Identity) => [v.sessionId, v.native, v.anchor.toolCallId, v.anchor.messageId, v.anchor.invocationId, v.anchor.wrapper];
const formId = (v: Identity) => hash(invocation(v));
const token = (v: unknown): v is string => typeof v === "string" && !!v && v.length <= 4096 && v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v);
const definition = (v: UserQuestionsRecord) => ({ version: v.version, id: v.id, sessionId: v.sessionId, native: v.native, anchor: v.anchor, workspaceId: v.workspaceId, worktreeId: v.worktreeId, bindingRevision: v.bindingRevision, cwd: v.cwd, createdAt: v.createdAt, input: v.input });
function invalid(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function conflict(message: string): never { throw new UserQuestionsError(409, "user-questions-conflict", message); }
function badRequest(error: unknown): never { throw new UserQuestionsError(400, "user-questions-invalid", error instanceof Error ? error.message : "Invalid questions request"); }

/** Lock-owned durable snapshots. Readers receive copies, never mutable store state.
 * Operations retain their original response until explicit storage reconciliation;
 * reaching a ledger budget rejects writes instead of silently evicting receipts. */
export class UserQuestionsStore {
  private ledger: Ledger;
  private failed = false;
  private rootIdentity!: { dev: number; ino: number };
  private fileIdentity: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number } | null = null;

  constructor(private readonly dataDir: string, private readonly storeId: string, private readonly failClosed: (error: unknown) => void) {
    this.ledger = { version: 1, storeId, forms: [], operations: [] };
    try {
      invalid(token(storeId), "Invalid question store identity");
      const root = lstatSync(dataDir);
      invalid(root.isDirectory() && !root.isSymbolicLink() && realpathSync(dataDir) === dataDir && root.uid === process.getuid?.() && !(root.mode & 0o022), "Unsafe question store directory");
      this.rootIdentity = { dev: root.dev, ino: root.ino };
      let info;
      try { info = lstatSync(join(dataDir, FILE)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      this.safeFile(info);
      const fd = openSync(join(dataDir, FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = fstatSync(fd); this.safeFile(opened);
        invalid(opened.dev === info.dev && opened.ino === info.ino, "Question ledger changed");
        const bytes = Buffer.alloc(opened.size + 1); let used = 0, count = 0;
        while (used < bytes.length && (count = readSync(fd, bytes, used, bytes.length - used, used))) used += count;
        invalid(used === opened.size, "Question ledger changed");
        const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used)));
        this.validate(value);
        const after = fstatSync(fd), current = lstatSync(join(dataDir, FILE)); this.safeFile(current);
        invalid(after.size === opened.size && after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs && current.dev === opened.dev && current.ino === opened.ino && current.size === opened.size && current.mtimeMs === opened.mtimeMs && current.ctimeMs === opened.ctimeMs, "Question ledger changed");
        this.fileIdentity = this.fileStamp(current);
        this.ledger = value;
      } finally { closeSync(fd); }
    } catch (error) {
      this.failed = true;
      try { this.failClosed(error); } catch { /* Report the storage error, not callback failure. */ }
      throw new UserQuestionsError(503, "user-questions-storage", `Question storage unavailable or corrupt: ${error instanceof Error ? error.message : "invalid ledger"}`);
    }
  }

  private safeFile(info: Stats) {
    invalid(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= MAX_BYTES && info.uid === process.getuid?.() && !(info.mode & 0o077), "Unsafe question ledger");
  }
  private fileStamp(info: Stats) {
    return { dev: Number(info.dev), ino: Number(info.ino), size: Number(info.size), mtimeMs: Number(info.mtimeMs), ctimeMs: Number(info.ctimeMs) };
  }
  private available() { if (this.failed) throw new UserQuestionsError(503, "user-questions-storage", "Question storage is unavailable"); }
  private assertStorageCurrent() {
    this.available();
    const root = lstatSync(this.dataDir);
    invalid(root.isDirectory() && !root.isSymbolicLink() && root.dev === this.rootIdentity.dev && root.ino === this.rootIdentity.ino && root.uid === process.getuid?.() && !(root.mode & 0o022) && realpathSync(this.dataDir) === this.dataDir, "Question store directory changed");
    let info;
    try { info = lstatSync(join(this.dataDir, FILE)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && this.fileIdentity === null) return; throw error; }
    this.safeFile(info);
    invalid(this.fileIdentity !== null && canonicalJSON(this.fileStamp(info)) === canonicalJSON(this.fileIdentity), "Question ledger changed outside its owner");
  }

  private validate(value: unknown): asserts value is Ledger {
    exact(value, ["version", "storeId", "forms", "operations"]);
    invalid(value.version === 1 && value.storeId === this.storeId && Array.isArray(value.forms) && Array.isArray(value.operations), "Invalid question ledger");
    invalid(value.forms.length <= MAX_FORMS && value.operations.length <= MAX_OPERATIONS, "Question ledger is full");
    const ids = new Set<string>(), conversations = new Set<string>(), forms = new Map<string, UserQuestionsRecord>();
    const submissionIds = new Set<string>(), deliveryIds = new Set<string>();
    const sessionSizes = new Map<string, number>(), sessionCounts = new Map<string, number>();
    const budget = (sessionId: string, item: unknown) => {
      const size = (sessionSizes.get(sessionId) ?? 0) + Buffer.byteLength(JSON.stringify(item));
      invalid(size <= SESSION_BYTES, "Conversation question storage budget exceeded"); sessionSizes.set(sessionId, size);
    };
    for (const record of value.forms) {
      invalid(isUserQuestionsRecord(record), "Invalid question record");
      invalid(record.id === formId(record) && !ids.has(record.id) && resolve(record.cwd) === record.cwd, "Conflicting question identity");
      ids.add(record.id); forms.set(record.id, record);
      if (record.submission && record.delivery) {
        invalid(!submissionIds.has(record.submission.id) && !deliveryIds.has(record.delivery.id), "Duplicate submission or delivery identity");
        submissionIds.add(record.submission.id); deliveryIds.add(record.delivery.id);
      }
      if (record.status === "presented") {
        invalid(!conversations.has(record.sessionId), "Multiple unanswered forms in a conversation"); conversations.add(record.sessionId);
      }
      const count = (sessionCounts.get(record.sessionId) ?? 0) + 1;
      invalid(count <= 128, "Conversation form limit exceeded"); sessionCounts.set(record.sessionId, count);
      budget(record.sessionId, record);
    }
    const keys = new Set<string>(), revisions = new Set<string>(), terminalReceipts = new Set<string>();
    for (const receipt of value.operations) {
      exact(receipt, ["operation", "sessionId", "formId", "requestId", "fingerprint", "record"]);
      invalid(["save", "submit", "dismiss", "resume"].includes(receipt.operation) && [receipt.sessionId, receipt.formId, receipt.requestId].every(token) && typeof receipt.fingerprint === "string" && /^[a-f0-9]{64}$/.test(receipt.fingerprint), "Invalid question operation");
      const key = canonicalJSON([receipt.sessionId, receipt.operation, receipt.requestId]);
      invalid(!keys.has(key), "Duplicate question operation"); keys.add(key);
      const record = forms.get(receipt.formId);
      invalid(record && record.sessionId === receipt.sessionId && isUserQuestionsRecord(receipt.record)
        && receipt.record.id === record.id && canonicalJSON(definition(receipt.record)) === canonicalJSON(definition(record))
        && receipt.record.revision > 1 && receipt.record.revision <= record.revision, "Invalid question operation receipt");
      const revisionKey = canonicalJSON([record.id, receipt.record.revision]);
      invalid(!revisions.has(revisionKey), "Duplicate operation revision"); revisions.add(revisionKey);
      if (receipt.record.revision === record.revision) invalid(canonicalJSON(receipt.record) === canonicalJSON(record), "Current operation receipt differs from form");
      const intent = { requestId: receipt.requestId, expectedRevision: receipt.record.revision - 1,
        ...(receipt.operation === "save" || receipt.operation === "submit" ? { answers: receipt.record.answers } : {}) };
      invalid(receipt.fingerprint === hash([record.id, intent]), "Operation fingerprint differs from committed intent");
      invalid(receipt.operation === "save" ? receipt.record.status === "presented"
        : receipt.operation === "dismiss" ? receipt.record.status === "dismissed" && receipt.record.dismissal?.requestId === receipt.requestId
        : receipt.record.status === "submitted" && (receipt.operation === "resume" || receipt.record.submission?.requestId === receipt.requestId), "Operation lifecycle mismatch");
      if (receipt.record.submission) invalid(canonicalJSON(receipt.record.submission) === canonicalJSON(record.submission), "Submission changed after commit");
      if (receipt.record.dismissal) invalid(canonicalJSON(receipt.record.dismissal) === canonicalJSON(record.dismissal), "Dismissal changed after commit");
      if (receipt.operation === "submit" || receipt.operation === "dismiss") terminalReceipts.add(record.id);
      budget(receipt.sessionId, receipt);
    }
    for (const record of forms.values()) invalid(record.status === "presented" || terminalReceipts.has(record.id), "Terminal form lacks its durable operation receipt");
    invalid(Buffer.byteLength(JSON.stringify(value)) <= MAX_BYTES, "Question ledger byte limit exceeded");
  }

  private commit(next: Ledger, assertCurrent: () => void) {
    this.available();
    try { this.validate(next); } catch (error) { throw new UserQuestionsError(429, "user-questions-limit", error instanceof Error ? error.message : "Question storage budget reached"); }
    assertCurrent();
    try {
      this.assertStorageCurrent();
      atomicAppRecord(this.dataDir, FILE, next);
      const current = lstatSync(join(this.dataDir, FILE)); this.safeFile(current);
      this.fileIdentity = this.fileStamp(current);
    } catch (error) {
      this.failed = true;
      try { this.failClosed(error); } catch { /* Preserve the durable storage error. */ }
      throw new UserQuestionsError(503, "user-questions-storage", "Question commit failed; reconciliation required");
    }
    this.ledger = next;
  }

  list(sessionId: string): UserQuestionsRecord[] {
    this.available();
    return structuredClone(this.ledger.forms.filter(v => v.sessionId === sessionId).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)));
  }
  getById(id: string): UserQuestionsRecord | undefined {
    this.available(); const record = this.ledger.forms.find(v => v.id === id); return record && structuredClone(record);
  }
  get(sessionId: string, id: string): UserQuestionsRecord {
    const record = this.getById(id);
    if (!record || record.sessionId !== sessionId) throw new UserQuestionsError(404, "user-questions-not-found", "Question form not found");
    return record;
  }
  publish(identity: Identity, input: PresentQuestionsInput, assertCurrent: () => void): UserQuestionsRecord {
    this.available(); assertCurrent();
    let parsed: PresentQuestionsInput, id: string;
    try { parsed = parsePresentQuestionsInput(input); canonicalJSON(identity); id = formId(identity); } catch (error) { badRequest(error); }
    const old = this.getById(id);
    if (old) {
      if (canonicalJSON(old.input) !== canonicalJSON(parsed)) conflict("This invocation already presented different questions");
      return old;
    }
    if (this.ledger.forms.some(v => v.sessionId === identity.sessionId && v.status === "presented")) conflict("This conversation already has an unanswered form");
    const record: UserQuestionsRecord = {
      version: 1, id, sessionId: identity.sessionId, native: structuredClone(identity.native), anchor: structuredClone(identity.anchor),
      workspaceId: identity.workspaceId, worktreeId: identity.worktreeId, bindingRevision: identity.bindingRevision, cwd: identity.cwd,
      createdAt: new Date().toISOString(), input: parsed,
      revision: 1, answers: parsed.pages.map(() => null), status: "presented", submission: null, delivery: null, dismissal: null,
    };
    if (!isUserQuestionsRecord(record) || resolve(record.cwd) !== record.cwd) badRequest(new Error("Invalid question form identity"));
    const next = structuredClone(this.ledger); next.forms.push(record); this.commit(next, assertCurrent);
    return structuredClone(record);
  }

  private mutate(operation: Operation, sessionId: string, id: string, request: UserQuestionsAnswerRequest | UserQuestionsSimpleRequest, assertCurrent: () => void): UserQuestionsRecord {
    this.available(); assertCurrent();
    const current = this.get(sessionId, id);
    let fingerprint: string;
    try {
      canonicalJSON(request);
      exact(request, ["requestId", "expectedRevision", ...(operation === "save" || operation === "submit" ? ["answers"] : [])]);
      invalid(token(request.requestId) && Number.isSafeInteger(request.expectedRevision) && request.expectedRevision >= 1, "Invalid mutation request");
      fingerprint = hash([id, request]);
    } catch (error) { badRequest(error); }
    // Return the original response, including its original revision and delivery,
    // before testing today's lifecycle or optimistic concurrency token.
    const prior = this.ledger.operations.find(v => v.sessionId === sessionId && v.operation === operation && v.requestId === request.requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) conflict("Request ID already used for a different intent");
      return structuredClone(prior.record);
    }
    if (current.revision !== request.expectedRevision) conflict("Question form revision changed");
    const next = structuredClone(this.ledger), record = next.forms.find(v => v.id === id)!;
    if (operation === "save" || operation === "submit") {
      if (record.status !== "presented") conflict("Submitted and dismissed forms are read-only");
      try { record.answers = parseUserQuestionAnswers(record.input, (request as UserQuestionsAnswerRequest).answers); } catch (error) { badRequest(error); }
      if (operation === "submit") {
        record.status = "submitted";
        record.submission = { id: randomUUID(), requestId: request.requestId, submittedAt: new Date().toISOString(), answers: structuredClone(record.answers) };
        record.delivery = { id: randomUUID(), state: "pending", runId: null, nativeCommandId: null };
      }
    } else if (operation === "dismiss") {
      if (record.status !== "presented") conflict("Only a presented form can be dismissed");
      record.status = "dismissed"; record.dismissal = { requestId: request.requestId, at: new Date().toISOString() };
    } else {
      if (record.status !== "submitted" || !record.delivery || record.delivery.state !== "paused") conflict("Only a definitely unsubmitted, paused delivery can be resumed; uncertain native acceptance must be reconciled first");
      // Only an unattempted or proven-not-submitted pause grants a new attempt.
      // Unknown acceptance is observation-only, never permission to resend.
      record.delivery = { id: randomUUID(), state: "pending", runId: null, nativeCommandId: null };
    }
    record.revision++;
    next.operations.push({ operation, sessionId, formId: id, requestId: request.requestId, fingerprint, record: structuredClone(record) });
    this.commit(next, assertCurrent); return structuredClone(record);
  }
  save(sessionId: string, id: string, request: UserQuestionsAnswerRequest, assertCurrent: () => void): UserQuestionsRecord { return this.mutate("save", sessionId, id, request, assertCurrent); }
  submit(sessionId: string, id: string, request: UserQuestionsAnswerRequest, assertCurrent: () => void): UserQuestionsRecord { return this.mutate("submit", sessionId, id, request, assertCurrent); }
  dismiss(sessionId: string, id: string, request: UserQuestionsSimpleRequest, assertCurrent: () => void): UserQuestionsRecord { return this.mutate("dismiss", sessionId, id, request, assertCurrent); }
  resume(sessionId: string, id: string, request: UserQuestionsSimpleRequest, assertCurrent: () => void): UserQuestionsRecord { return this.mutate("resume", sessionId, id, request, assertCurrent); }

  delivery(id: string, change: Partial<NonNullable<UserQuestionsRecord["delivery"]>>, assertCurrent: () => void): UserQuestionsRecord {
    this.available(); assertCurrent();
    const current = this.getById(id);
    if (!current) throw new UserQuestionsError(404, "user-questions-not-found", "Question form not found");
    if (current.status !== "submitted" || !current.delivery) conflict("Form has no submitted delivery");
    try {
      canonicalJSON(change); exact(change, [], ["id", "state", "runId", "nativeCommandId", "reason"]);
      if (change.id !== undefined && change.id !== current.delivery.id) conflict("Delivery attempt changed");
    } catch (error) { if (error instanceof UserQuestionsError) throw error; badRequest(error); }
    const transitions: Record<NonNullable<UserQuestionsRecord["delivery"]>["state"], readonly string[]> = {
      pending: ["pending", "claimed", "paused"], claimed: ["claimed", "accepted", "wrapper-completed", "unknown", "paused"],
      accepted: ["accepted"], "wrapper-completed": ["wrapper-completed"], unknown: ["unknown", "accepted", "wrapper-completed", "paused"], paused: ["paused"],
    };
    const target = { ...current.delivery, ...structuredClone(change) };
    if (!transitions[current.delivery.state].includes(target.state)) conflict("Invalid delivery state transition");
    if (["accepted", "wrapper-completed"].includes(current.delivery.state) && canonicalJSON(target) !== canonicalJSON(current.delivery)) conflict("Completed delivery is immutable");
    if (current.delivery.nativeCommandId !== null && target.nativeCommandId !== current.delivery.nativeCommandId) conflict("Native delivery command is immutable once assigned");
    if (current.delivery.runId !== null && target.runId !== current.delivery.runId) conflict("Delivery run is immutable once assigned");
    if (canonicalJSON(target) === canonicalJSON(current.delivery)) return current;
    const next = structuredClone(this.ledger), record = next.forms.find(v => v.id === id)!;
    record.delivery = target; record.revision++;
    if (!isUserQuestionsRecord(record)) badRequest(new Error("Invalid delivery projection"));
    this.commit(next, assertCurrent); return structuredClone(record);
  }
  pending(): UserQuestionsRecord[] {
    this.available(); return structuredClone(this.ledger.forms.filter(v => v.delivery && ["pending", "claimed", "unknown"].includes(v.delivery.state)));
  }
  /** Owner-only lifecycle operations: storage ownership is checked at commit.
   * Recovery never schedules a native retry; uncertain sends need explicit resume. */
  pause(sessionId: string, reason: string): void {
    this.available();
    if (typeof reason !== "string" || reason.length > 4096 || reason.includes("\0")) badRequest(new Error("Invalid delivery pause reason"));
    const next = structuredClone(this.ledger); let changed = false;
    for (const record of next.forms) if (record.sessionId === sessionId && record.delivery?.state === "pending") {
      record.delivery.state = "paused"; record.delivery.reason = reason; record.revision++; changed = true;
    }
    if (changed) this.commit(next, () => this.available());
  }
  recover(): void {
    this.available(); const next = structuredClone(this.ledger); let changed = false;
    for (const record of next.forms) if (record.delivery?.state === "pending" || record.delivery?.state === "claimed") {
      const claimed = record.delivery.state === "claimed";
      record.delivery.state = claimed ? "unknown" : "paused";
      record.delivery.reason = claimed ? "Delivery interrupted; native acceptance is unknown" : "Delivery paused after recovery";
      record.revision++; changed = true;
    }
    if (changed) this.commit(next, () => this.available());
  }
}
