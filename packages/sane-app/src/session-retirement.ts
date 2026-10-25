import { Database } from "bun:sqlite";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, writeFileSync, fsyncSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicAppRecord } from "./app-store";
import { uuid, type Run, type Session } from "./history";
import type { OpenCodeAdapter } from "./opencode";

const FILE = "session-retirements.json", WEEK = 7 * 86400_000, MAX_BATCH = 24, OPERATION_MS = 45_000;
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const object = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const keys = (x: Record<string, unknown>, required: string[]) => Object.keys(x).sort().join() === [...required].sort().join();
const timestamp = (x: unknown): x is string => typeof x === "string" && /^\d{4}-\d\d-\d\dT.*Z$/.test(x) && Number.isFinite(Date.parse(x));
const inside = (root: string, path: string) => { const r = relative(root, path); return !isAbsolute(r) && r !== ".." && !r.startsWith(`..${sep}`); };
export class SessionRetirementError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
const deny = (code: string, message: string, status = 409): never => { throw new SessionRetirementError(code, message, status); };
/** One monotonic budget, including discovery/flush waits and cooperative disk
 * work. Late read completions cannot resume publication after expiry. */
class RetirementBudget {
  private readonly until = performance.now() + OPERATION_MS;
  private expired = false;
  check() {
    if (this.expired || performance.now() >= this.until) {
      this.expired = true;
      deny("retirement-deadline", "Catalog operation exceeded its 45-second budget; retry the exact request ID/body", 504);
    }
  }
  remaining() { this.check(); return Math.max(1, Math.floor(this.until - performance.now())); }
  async wait<T>(action: () => Promise<T>): Promise<T> {
    this.check();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => { this.check(); return action(); }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => {
          this.expired = true;
          reject(new SessionRetirementError("retirement-deadline", "Catalog operation exceeded its 45-second budget; retry the exact request ID/body", 504));
        }, this.remaining()); }),
      ]);
      this.check(); return value;
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  async yield() { await this.wait(() => new Promise<void>(done => setImmediate(done))); }
}
type Identity = Pick<Session, "sessionId" | "harness" | "nativeSessionId" | "authorityId" | "cwd">;
const identity = (s: Identity): Identity => ({ sessionId: s.sessionId, harness: s.harness, nativeSessionId: s.nativeSessionId, authorityId: s.authorityId, cwd: s.cwd });
const same = (a: Identity, b: Identity) => JSON.stringify(identity(a)) === JSON.stringify(identity(b));
type Entry = { identity: Identity; state: "retired" | "restored"; retiredAt: string; restoredAt: string | null; lastActivity: string; lastRunId: string | null; approvalSha256: string; requestId: string };
type Outcome = "eligible" | "retired" | "already-retired" | "restored" | "reactivated" | "already-active" | "recent" | "active" | "unknown" | "inflight" | "identity-changed";
type Result = { sessionId: string; outcome: Outcome; lastActivity: string | null; reason?: string };
type Response = { requestId: string; operation: Request["operation"]; revision: number; cutoff: string; counts: Record<string, number>; results: Result[]; backupDirectory?: string; replayed?: boolean };
type Records = { version: 1; storeId: string; revision: number; entries: Entry[]; operations: { requestId: string; fingerprint: string; response: Response }[] };
type Request = { version: 1; storeId: string; requestId: string; operation: "preview" | "retire" | "restore"; expectedRevision: number; approvalManifest: { path: string; sha256: string }; sessionIds: string[] };
type Fingerprint = [number, number, number, number, number];
type BackupRef = { source: string; backup_path: string; bytes: number; sha256: string; fingerprint_json: string };
type Approved = { app_id: string; harness: string; native_id: string; workspace: string; last_activity_utc: string };
type Native = { id: string; location?: { directory?: string }; time: { created: number; updated: number; idle?: number } };
type Observation = { last: number | null; files: Map<string, Fingerprint>; signature: string; native?: Native; error?: string };
type PendingObservation = { outcome?: "unknown" | "recent"; reason?: string; latest?: number; warnings: string[] };
export type SessionRetirementDependencies = {
  dataDir: string; storeId: string; claudeRoot: string;
  nativeControlPaths: readonly string[];
  sessions(): readonly Session[]; runs(): readonly Run[];
  /** Actual owner/reservation/refresh barriers only, never stale lifecycle labels. */
  busy(id: string): string | undefined;
  healthy(): boolean;
  authorityCurrent(session: Session): boolean;
  coordinationActivity(id: string): readonly string[];
  flush(): Promise<void>;
  oc: Pick<OpenCodeAdapter, "request" | "path">;
  storageFailed(error: unknown): void;
  changed(): void;
};

/** Separate, lock-owner-written catalog overlay. History/admissions/domain IDs are
 * never removed. A stale overlay cannot retire a rebound identity or a new run. */
export class SessionRetirements {
  private records: Records;
  private byId = new Map<string, Entry>();
  private reservations = new Set<string>();
  private flight = false;
  private readonly manifestPin: Fingerprint;
  private registryPin: Fingerprint | null = null;
  private verifiedCopies = new Map<string, { path: string; sha256: string }>();
  private readonly backupRoot = resolve(homedir(), ".local/state/sane/session-retirement-backups");
  constructor(private deps: SessionRetirementDependencies) {
    this.manifestPin = this.fingerprint(join(deps.dataDir, "manifest.json"));
    let raw: unknown;
    try { raw = JSON.parse(this.readStable(join(deps.dataDir, FILE)).bytes.toString("utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (raw === undefined) this.records = { version: 1, storeId: deps.storeId, revision: 0, entries: [], operations: [] };
    else {
      if (!object(raw) || !keys(raw, ["version", "storeId", "revision", "entries", "operations"]) || raw.version !== 1 || raw.storeId !== deps.storeId || !Number.isSafeInteger(raw.revision) || raw.revision < 0 || !Array.isArray(raw.entries) || !Array.isArray(raw.operations)) throw new Error("Invalid session retirement registry; reconcile before startup");
      const ids = new Set<string>(), requests = new Set<string>();
      for (const e of raw.entries) {
        if (!object(e) || !keys(e, ["identity", "state", "retiredAt", "restoredAt", "lastActivity", "lastRunId", "approvalSha256", "requestId"]) || !this.validIdentity(e.identity) || ids.has(e.identity.sessionId) || !["retired", "restored"].includes(e.state) || !timestamp(e.retiredAt) || !timestamp(e.lastActivity) || e.restoredAt !== null && !timestamp(e.restoredAt) || e.lastRunId !== null && !uuid(e.lastRunId) || !/^[a-f0-9]{64}$/.test(e.approvalSha256) || !uuid(e.requestId)) throw new Error("Invalid session retirement entry");
        ids.add(e.identity.sessionId);
      }
      for (const op of raw.operations) {
        if (!object(op) || !keys(op, ["requestId", "fingerprint", "response"]) || !uuid(op.requestId) || requests.has(op.requestId) || !/^[a-f0-9]{64}$/.test(op.fingerprint) || !this.validResponse(op.response) || op.response.requestId !== op.requestId || op.response.revision > raw.revision) throw new Error("Invalid session retirement operation");
        requests.add(op.requestId);
      }
      if (raw.operations.length !== raw.revision) throw new Error("Retirement operation/revision history is inconsistent");
      this.records = raw as Records;
    }
    this.reindex();
    if (raw !== undefined) this.registryPin = this.fingerprint(join(deps.dataDir, FILE));
  }
  private validIdentity(x: unknown): x is Identity {
    return object(x) && keys(x, ["sessionId", "harness", "nativeSessionId", "authorityId", "cwd"]) && uuid(x.sessionId) && ["claude-code", "opencode"].includes(x.harness) && typeof x.nativeSessionId === "string" && (x.harness === "claude-code" ? uuid(x.nativeSessionId) : /^ses[a-zA-Z0-9_-]+$/.test(x.nativeSessionId)) && typeof x.authorityId === "string" && new RegExp(`^sane-native-v1:${x.harness === "opencode" ? "oc" : "cc"}:[a-f0-9]{64}$`).test(x.authorityId) && typeof x.cwd === "string" && isAbsolute(x.cwd) && !x.cwd.includes("\0");
  }
  private validResponse(x: unknown): x is Response {
    const outcomes = ["eligible", "retired", "already-retired", "restored", "reactivated", "already-active", "recent", "active", "unknown", "inflight", "identity-changed"];
    return object(x) && Object.keys(x).every(k => ["requestId", "operation", "revision", "cutoff", "counts", "results", "backupDirectory"].includes(k))
      && uuid(x.requestId) && ["retire", "restore"].includes(x.operation) && Number.isSafeInteger(x.revision) && x.revision > 0 && timestamp(x.cutoff)
      && object(x.counts) && keys(x.counts, outcomes) && Object.values(x.counts).every(n => Number.isSafeInteger(n) && n >= 0)
      && Array.isArray(x.results) && x.results.length > 0 && x.results.length <= MAX_BATCH
      && new Set(x.results.map(r => r?.sessionId)).size === x.results.length
      && x.results.every(r => object(r) && Object.keys(r).every(k => ["sessionId", "outcome", "lastActivity", "reason"].includes(k)) && uuid(r.sessionId) && outcomes.includes(r.outcome) && (r.lastActivity === null || timestamp(r.lastActivity)) && (r.reason === undefined || typeof r.reason === "string" && r.reason.length <= 8192))
      && outcomes.every(outcome => x.counts[outcome] === x.results.filter((r: Result) => r.outcome === outcome).length)
      && typeof x.backupDirectory === "string" && inside(this.backupRoot, x.backupDirectory);
  }
  private reindex() { this.byId = new Map(this.records.entries.map(e => [e.identity.sessionId, e])); }
  get revision() { return this.records.revision; }
  isRetired(s: Session | undefined) {
    const e = s && this.byId.get(s.sessionId);
    return !!s && !!e && e.state === "retired" && same(e.identity, s) && e.lastRunId === s.lastRunId;
  }
  isPaused(id: string) { return this.reservations.has(id); }
  assertActive(s: Session | undefined) {
    if (this.isRetired(s)) deny("session-retired", "Conversation is retired from the active catalog. Restore it explicitly before making changes.");
    if (s && this.isPaused(s.sessionId)) deny("session-retirement-pending", "Conversation catalog operation is in progress; retry after it finishes.");
  }
  archive() {
    const live = new Map(this.deps.sessions().map(s => [s.sessionId, s]));
    const sessions = this.records.entries.map(e => ({ ...e, effectiveRetired: this.isRetired(live.get(e.identity.sessionId)), title: live.get(e.identity.sessionId)?.title }));
    return { version: 1, storeId: this.deps.storeId, revision: this.revision, counts: { retired: sessions.filter(e => e.effectiveRetired).length, restored: sessions.filter(e => e.state === "restored").length, reboundOrNewRun: sessions.filter(e => e.state === "retired" && !e.effectiveRetired).length }, sessions };
  }
  private fingerprint(path: string): Fingerprint {
    if (realpathSync(path) !== resolve(path)) throw new Error("Retirement source must not traverse symlinks");
    const s = lstatSync(path);
    if (!s.isFile() || s.nlink !== 1) throw new Error("Retirement source must be a single-link regular file");
    return [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs];
  }
  private readStable(path: string, maxBytes = 256 * 1024 * 1024, budget?: RetirementBudget) {
    budget?.check();
    const before = this.fingerprint(path);
    if (before[2] > maxBytes) throw new Error("Retirement source exceeds bounded read budget");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const s = fstatSync(fd);
      if (s.dev !== before[0] || s.ino !== before[1] || s.size !== before[2]) throw new Error("Retirement source changed before read");
      const buffer = Buffer.alloc(before[2] + 1); let length = 0;
      while (length < buffer.length) { budget?.check(); const n = readSync(fd, buffer, length, Math.min(1024 * 1024, buffer.length - length), length); if (!n) break; length += n; }
      bytes = buffer.subarray(0, length);
    } finally { closeSync(fd); }
    if (bytes.length !== before[2] || JSON.stringify(before) !== JSON.stringify(this.fingerprint(path))) throw new Error("Retirement source changed during read");
    budget?.check();
    return { bytes, fingerprint: before };
  }
  private parse(value: unknown): Request {
    if (!object(value) || !keys(value, ["version", "storeId", "requestId", "operation", "expectedRevision", "approvalManifest", "sessionIds"]) || value.version !== 1 || value.storeId !== this.deps.storeId || !uuid(value.requestId) || !["preview", "retire", "restore"].includes(value.operation) || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 || !object(value.approvalManifest) || !keys(value.approvalManifest, ["path", "sha256"]) || typeof value.approvalManifest.path !== "string" || !/^[a-f0-9]{64}$/.test(value.approvalManifest.sha256) || !Array.isArray(value.sessionIds) || !value.sessionIds.length || value.sessionIds.length > (value.operation === "preview" ? 1000 : MAX_BATCH) || value.sessionIds.some((id: unknown) => !uuid(id)) || new Set(value.sessionIds).size !== value.sessionIds.length) deny("retirement-input", `Exact operation/identity fields required; mutations accept at most ${MAX_BATCH} approved IDs`, 400);
    return value as Request;
  }
  private approval(request: Request, budget: RetirementBudget) {
    budget.check();
    const path = resolve(request.approvalManifest.path);
    if (!inside(this.backupRoot, path) || inside(this.deps.dataDir, path)) deny("retirement-approval", "Approval manifest must be a private retirement backup outside live App data");
    const raw = this.readStable(path, 32 * 1024 * 1024, budget);
    if ((lstatSync(path).mode & 0o077) !== 0 || hash(raw.bytes) !== request.approvalManifest.sha256) deny("retirement-approval", "Private approval manifest hash/permissions do not match");
    const db = new Database(path, { readonly: true, create: false });
    try {
      const rows = db.query("SELECT app_id,harness,native_id,workspace,last_activity_utc FROM sessions WHERE date_bucket='age_eligible'").all() as Approved[];
      const approved = new Map(rows.map(r => [r.app_id, r]));
      if (request.sessionIds.some(id => !approved.has(id))) deny("retirement-scope", "Operation contains an ID outside the user-approved age-eligible manifest");
      const refs = db.query("SELECT source,backup_path,bytes,sha256,fingerprint_json FROM files WHERE error IS NULL").all() as BackupRef[];
      budget.check();
      const expectedManifest = refs.find(r => r.source === join(this.deps.dataDir, "manifest.json"));
      if (!expectedManifest || !inside(this.backupRoot, expectedManifest.backup_path) || hash(this.readStable(expectedManifest.backup_path, undefined, budget).bytes) !== expectedManifest.sha256 || JSON.parse(readFileSync(expectedManifest.backup_path, "utf8")).storeId !== this.deps.storeId) deny("retirement-store-mismatch", "Approval belongs to a different App store");
      const sourceRef = refs.find(r => r.source === join(this.deps.dataDir, "sources.json"));
      if (!sourceRef || !inside(this.backupRoot, sourceRef.backup_path) || hash(this.readStable(sourceRef.backup_path, undefined, budget).bytes) !== sourceRef.sha256) deny("retirement-approval", "Approved native source pins are unavailable");
      const sources = JSON.parse(readFileSync(sourceRef!.backup_path, "utf8"));
      budget.check();
      return { approved, sources, refs: new Map(refs.map(r => [r.source, r])) };
    } finally { db.close(); }
  }
  private async local(s: Session, budget: RetirementBudget): Promise<Observation> {
    const runs = this.deps.runs().filter(r => r.sessionId === s.sessionId), files = new Map<string, Fingerprint>();
    let last: number | null = null;
    const note = (value: unknown) => {
      if (!timestamp(value) || Date.parse(value) > Date.now() + 1000) throw new Error("Invalid/future activity date");
      last = Math.max(last ?? 0, Date.parse(value));
    };
    try {
      let scannedRuns = 0;
      for (const r of runs) {
        budget.check();
        note(r.createdAt); if (r.endedAt) note(r.endedAt);
        const path = join(this.deps.dataDir, `${r.runId}.jsonl`), raw = this.readStable(path, undefined, budget);
        files.set(path, raw.fingerprint);
        // Validate rows without retaining an entire decoded transcript or ever
        // invoking historical journal repair from a catalog operation.
        const text = raw.bytes.toString("utf8");
        if (!text.endsWith("\n")) throw new Error("Journal requires explicit repair; retirement did not alter it");
        let start = 0, sequence = 0, rows = 0;
        for (let end = text.indexOf("\n", start); end >= 0; end = text.indexOf("\n", start)) {
          if (rows++ % 128 === 0) budget.check();
          if (rows % 2048 === 0) await budget.yield();
          const e = JSON.parse(text.slice(start, end)); start = end + 1;
          if (!object(e) || e.runId !== r.runId || e.sessionId !== s.sessionId || !Number.isSafeInteger(e.seq) || e.seq <= sequence || !["stdout", "stderr", "hook", "status", "submission", "message", "launch", "context", "native-subagent"].includes(e.kind) || !("data" in e)) throw new Error("Journal identity/sequence/record is invalid");
          sequence = e.seq; note(e.time);
        }
        if (!sequence) throw new Error("Historical journal is empty");
        if (++scannedRuns % 16 === 0) await budget.yield();
      }
      for (const value of this.deps.coordinationActivity(s.sessionId)) { budget.check(); note(value); }
    } catch { budget.check(); return { last, files, signature: "", error: "App activity evidence is unavailable, changed, or invalid; no journal repair was performed" }; }
    budget.check();
    return { last, files, signature: JSON.stringify([identity(s), s.lastRunId, runs]) };
  }
  private nativeRequest<T>(path: string, budget: RetirementBudget): Promise<T> {
    return budget.wait(() => this.deps.oc.request<T>(path, "GET", undefined, () => budget.check(), Math.min(10_000, budget.remaining())));
  }
  private async nativeBulk(budget: RetirementBudget) {
    const rows = new Map<string, Native>(), seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const response = await this.nativeRequest<{ data: Native[]; cursor: { next?: string | null } }>(`/api/session?limit=2000&order=desc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, budget);
      budget.check();
      if (!Array.isArray(response.data) || !object(response.cursor)) throw new Error("Invalid native retirement catalog");
      for (const n of response.data) {
        budget.check();
        if (!object(n) || typeof n.id !== "string" || !object(n.time) || !Number.isFinite(n.time.updated) || !Number.isFinite(n.time.created)) throw new Error("Invalid native retirement identity/activity");
        rows.set(n.id, n);
      }
      cursor = response.cursor.next ?? undefined;
      if (!cursor) return rows;
      if (seen.has(cursor)) throw new Error("Native retirement cursor did not advance");
      seen.add(cursor);
    }
    throw new Error("Native retirement bulk catalog exceeds bounded page budget");
  }
  private async activeNative(budget: RetirementBudget) {
    const response = await this.nativeRequest<{ data: Record<string, { type: string }> }>("/api/session/active", budget);
    budget.check();
    if (!object(response.data) || Object.entries(response.data).some(([id, state]) => !/^ses[a-zA-Z0-9_-]+$/.test(id) || !object(state) || state.type !== "running")) throw new Error("Native active-session proof unavailable");
    return response.data;
  }
  private async pendingNative(s: Session, cutoff: number, budget: RetirementBudget): Promise<PendingObservation> {
    const base = this.deps.oc.path(s.nativeSessionId!);
    const warnings: string[] = [];
    let latest: number | undefined;
    for (const suffix of ["/inbox", "/form", "/permission"]) {
      budget.check();
      let data: unknown;
      try { data = (await this.nativeRequest<{ data: unknown }>(base + suffix, budget)).data; }
      catch { budget.check(); warnings.push(`Native ${suffix.slice(1)} observation unavailable; pending state remains unverified`); continue; }
      budget.check();
      if (!Array.isArray(data)) { warnings.push(`Native ${suffix.slice(1)} response is malformed; pending state remains unverified`); continue; }
      for (const entry of data) {
        budget.check();
        if (!object(entry) || entry.sessionID !== undefined && entry.sessionID !== s.nativeSessionId) return { outcome: "unknown" as const, reason: "Native pending-input identity is malformed or mismatched", latest, warnings };
        const dates = [entry.time?.created, entry.time?.updated, entry.time?.started, entry.createdAt, entry.updatedAt, entry.startedAt].filter(value => value !== undefined);
        // Inbox entries promise a creation date; forms/permissions may not expose
        // one. Missing optional dates are disclosed, not invented or age vetoes.
        if (suffix === "/inbox" && !dates.length) return { outcome: "unknown" as const, reason: "Native inbox activity date is unknown", latest, warnings };
        for (const value of dates) {
          const at = typeof value === "number" ? value : timestamp(value) ? Date.parse(value) : NaN;
          if (!Number.isFinite(at) || at < 0 || at > Date.now() + 1000) return { outcome: "unknown" as const, reason: "Native pending-input activity date is malformed", latest, warnings };
          latest = Math.max(latest ?? 0, at);
          if (at >= cutoff) return { outcome: "recent" as const, reason: `Recent native ${suffix.slice(1)} activity; input remains untouched`, latest, warnings };
        }
      }
      if (data.length) warnings.push(`${data.length} native ${suffix.slice(1)} entries preserved untouched${suffix === "/inbox" ? " with old activity dates" : "; dates not exposed by the API remain unverified"}; no consumption or delivery is inferred`);
    }
    return { latest, warnings };
  }
  private recordPending(result: Result, observation: Observation, pending: PendingObservation) {
    if (pending.latest !== undefined) {
      observation.last = Math.max(observation.last ?? 0, pending.latest);
      result.lastActivity = new Date(observation.last).toISOString();
    }
    if (pending.outcome) result.outcome = pending.outcome;
    const notes = result.reason ? [result.reason] : [];
    for (const note of [...(pending.reason ? [pending.reason] : []), ...pending.warnings]) if (!notes.some(existing => existing.includes(note))) notes.push(note);
    if (notes.length) result.reason = notes.join("; ");
  }
  private privateDirectory(path: string, durable?: Set<string>, budget?: RetirementBudget) {
    const parts = resolve(path).split(sep).filter(Boolean); let current: string = sep;
    for (const part of parts) {
      budget?.check();
      current = join(current, part);
      try { const s = lstatSync(current); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("Unsafe backup ancestor"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        mkdirSync(current, { mode: 0o700 }); durable?.add(current); durable?.add(resolve(current, ".."));
      }
    }
  }
  /** Fresh exact controls + every target App/run-ID sidecar (including settings,
   * context and delivery markers) + complete referenced context/execution package
   * trees. Unchanged bytes reference verified private copies; changed bytes use
   * exclusive new files. Native histories/inputs and old archives stay untouched;
   * runtime ownership files are excluded. This is not an atomic live-store copy. */
  private async backup(request: Request, refs: Map<string, BackupRef>, targets: Session[], budget: RetirementBudget) {
    const durable = new Set<string>();
    this.privateDirectory(this.backupRoot, durable, budget);
    budget.check();
    if ((lstatSync(this.backupRoot).mode & 0o077) !== 0) throw new Error("Retirement backup root must be private");
    const directory = join(this.backupRoot, `${new Date().toISOString().replace(/[:.]/g, "-")}-apply-${request.requestId}`);
    mkdirSync(directory, { mode: 0o700 });
    durable.add(directory); durable.add(this.backupRoot);
    const directoryHierarchy = (path: string) => {
      for (let parent = resolve(path, ".."); inside(this.backupRoot, parent); parent = resolve(parent, "..")) {
        budget.check(); durable.add(parent);
        if (parent === this.backupRoot) break;
      }
    };
    const stems = new Set([...targets.map(s => s.sessionId), ...this.deps.runs().filter(r => targets.some(s => s.sessionId === r.sessionId)).map(r => r.runId)]);
    const paths = new Set<string>();
    for (const path of this.deps.nativeControlPaths) { budget.check(); paths.add(path); }
    let traversed = 0;
    for (const name of readdirSync(this.deps.dataDir)) {
      budget.check();
      if (++traversed % 16 === 0) await budget.yield();
      if (name === "native-handoff.json" || name.endsWith(".tmp") || name.endsWith(".lock")) continue;
      const path = join(this.deps.dataDir, name), s = lstatSync(path);
      if (s.isFile() && (name.endsWith(".json") && !/^[a-f0-9-]{36}\./.test(name) || stems.has(name.slice(0, 36)))) paths.add(path);
    }
    const addTree = async (directory: string): Promise<void> => {
      budget.check();
      for (const name of readdirSync(directory)) {
        budget.check();
        if (++traversed % 16 === 0) await budget.yield();
        const path = join(directory, name), s = lstatSync(path);
        if (s.isSymbolicLink()) throw new Error("Backup refuses package symlink");
        if (s.isDirectory()) { await addTree(path); budget.check(); } else if (s.isFile()) paths.add(path);
      }
    };
    for (const name of ["context-packages", "execution-packages"]) {
      try { await addTree(join(this.deps.dataDir, name)); budget.check(); } catch (error) { budget.check(); if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const files: object[] = [];
    for (const source of paths) {
      budget.check();
      const raw = this.readStable(source, undefined, budget), digest = hash(raw.bytes), ref = refs.get(source);
      budget.check();
      let backup: string, coverage: string;
      const previous = this.verifiedCopies.get(source);
      if (previous && previous.sha256 === digest && (lstatSync(previous.path).mode & 0o077) === 0 && hash(this.readStable(previous.path, undefined, budget).bytes) === digest) {
        backup = previous.path; coverage = "verified-earlier-batch-copy-reference";
      } else if (ref && ref.sha256 === digest && inside(this.backupRoot, ref.backup_path) && (lstatSync(ref.backup_path).mode & 0o077) === 0 && hash(this.readStable(ref.backup_path, undefined, budget).bytes) === digest) {
        backup = ref.backup_path; coverage = "verified-prior-copy-reference";
      } else {
        backup = inside(this.deps.dataDir, source) ? join(directory, "files", relative(this.deps.dataDir, source)) : join(directory, "native-control", `${hash(source)}.json`);
        this.privateDirectory(resolve(backup, ".."), durable, budget);
        budget.check();
        const fd = openSync(backup, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { writeFileSync(fd, raw.bytes); budget.check(); fsyncSync(fd); } finally { closeSync(fd); }
        budget.check();
        if (hash(this.readStable(backup, undefined, budget).bytes) !== digest) throw new Error("Retirement backup hash mismatch");
        coverage = "new-stable-copy";
      }
      budget.check();
      directoryHierarchy(backup);
      this.verifiedCopies.set(source, { path: backup, sha256: digest });
      files.push({ source, backup, coverage, bytes: raw.bytes.length, sha256: digest, fingerprint: raw.fingerprint });
      if (files.length % 16 === 0) await budget.yield();
    }
    budget.check();
    const manifest = { version: 1, storeId: this.deps.storeId, createdAt: new Date().toISOString(), requestId: request.requestId, approvalManifest: request.approvalManifest, retirementRecordBefore: this.records, files, atomicAcrossLiveWriters: false, nativeHistoryUntouched: true };
    const manifestBytes = JSON.stringify(manifest);
    budget.check();
    const fd = openSync(join(directory, "manifest.json"), "wx", 0o600);
    try { writeFileSync(fd, manifestBytes); budget.check(); fsyncSync(fd); } finally { closeSync(fd); }
    budget.check();
    // Flush children before their parents, including the batch entry in
    // backupRoot and any newly-created ancestors. Reference namespaces are also
    // included, so an earlier timed-out batch cannot bypass directory durability.
    let synced = 0;
    for (const path of [...durable].sort((a, b) => b.split(sep).length - a.split(sep).length)) {
      budget.check();
      const dir = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!fstatSync(dir).isDirectory() || realpathSync(path) !== resolve(path)) throw new Error("Unsafe backup directory during durability fence");
        fsyncSync(dir);
      } finally { closeSync(dir); }
      budget.check();
      if (++synced % 16 === 0) await budget.yield();
    }
    budget.check();
    return directory;
  }
  async operate(value: unknown): Promise<Response> {
    const budget = new RetirementBudget();
    const request = this.parse(value), fingerprint = hash(JSON.stringify(request));
    budget.check();
    const prior = this.records.operations.find(op => op.requestId === request.requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) deny("retirement-request-conflict", "Request ID is already bound to another exact operation");
      return { ...structuredClone(prior.response), replayed: true };
    }
    if (this.flight) deny("retirement-busy", "Another catalog operation is in progress");
    this.assertStorage();
    if (!this.deps.healthy()) deny("retirement-owner-unavailable", "Healthy serving App storage ownership is required", 503);
    if (request.expectedRevision !== this.revision) deny("retirement-revision", "Retirement revision changed; read the archive before retrying");
    const approval = this.approval(request, budget), sessions = new Map(this.deps.sessions().map(s => [s.sessionId, s]));
    budget.check();
    const results: Result[] = [], observations = new Map<string, Observation>(), cutoff = Date.now() - WEEK;
    const cutoffText = new Date(cutoff).toISOString();
    this.flight = true;
    const initiallyBusy = new Map<string, string>();
    try {
      for (const id of request.sessionIds) {
        budget.check();
        const busy = this.deps.busy(id);
        if (busy) initiallyBusy.set(id, busy);
        // Never fence an already-owned turn, and never reserve for a read-only
        // preview or visibility-only restore. Existing work must keep its gates.
        else if (request.operation === "retire") this.reservations.add(id);
      }
      await budget.wait(() => this.deps.flush());
      budget.check();
      let natives = new Map<string, Native>(), active: Record<string, { type: string }> | undefined;
      if (request.operation !== "restore" && request.sessionIds.some(id => sessions.get(id)?.harness === "opencode")) {
        await Promise.all([
          this.nativeBulk(budget).then(value => { budget.check(); natives = value; }, () => { budget.check(); }),
          this.activeNative(budget).then(value => { budget.check(); active = value; }, () => { budget.check(); }),
        ]); // Preserve valid activity dates even when execution observation fails.
        budget.check();
      }
      let scanned = 0;
      for (const id of request.sessionIds) {
        budget.check();
        if (++scanned % 16 === 0) await budget.yield();
        budget.check();
        const s = sessions.get(id), a = approval.approved.get(id)!;
        const finish = (outcome: Outcome, lastActivity: string | null, reason?: string) => results.push({ sessionId: id, outcome, lastActivity, ...(reason ? { reason } : {}) });
        if (!s || s.harness !== a.harness || s.nativeSessionId !== a.native_id || s.cwd !== a.workspace || s.authorityId !== approval.sources[s.harness === "opencode" ? "oc" : "cc"]?.authorityId || !this.validIdentity(identity(s)) || !this.deps.authorityCurrent(s)) { finish("identity-changed", null, "Approved App/native/source identity no longer matches"); continue; }
        if (request.operation === "restore") { finish(this.isRetired(s) ? "restored" : "already-active", this.byId.get(id)?.lastActivity ?? null); continue; }
        const local = await this.local(s, budget); budget.check(); observations.set(id, local);
        if (local.error) { finish("unknown", local.last === null ? null : new Date(local.last).toISOString(), local.error); continue; }
        const n = natives.get(s.nativeSessionId!);
        if (n) {
          local.native = n;
          const dates = [n.time.updated, n.time.idle].filter((v): v is number => typeof v === "number");
          if (dates.some(v => !Number.isFinite(v) || v > Date.now() + 1000)) { finish("unknown", null, "Native activity timestamp is invalid"); continue; }
          local.last = Math.max(local.last ?? 0, ...dates);
        }
        if (s.harness === "claude-code") {
          try {
            const path = join(this.deps.claudeRoot, "projects", s.cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${s.nativeSessionId}.jsonl`), raw = this.readStable(path, 32 * 1024 * 1024, budget);
            local.files.set(path, raw.fingerprint);
            let dated = false, nativeRows = 0;
            for (const line of raw.bytes.toString("utf8").split("\n")) if (line) {
              if (nativeRows++ % 128 === 0) budget.check();
              if (nativeRows % 2048 === 0) await budget.yield();
              const row = JSON.parse(line);
              if (row.sessionId === s.nativeSessionId && ["user", "assistant", "system", "progress"].includes(row.type)) {
                if (!timestamp(row.timestamp) || Date.parse(row.timestamp) > Date.now() + 1000) throw new Error("Invalid native activity date");
                local.last = Math.max(local.last ?? 0, Date.parse(row.timestamp)); dated = true;
              }
            }
            if (!dated) throw new Error("Native activity date is unknown");
          } catch { budget.check(); finish("unknown", null, "Native Claude activity unavailable"); continue; }
        }
        const lastActivity = local.last === null ? null : new Date(local.last).toISOString();
        if (local.last !== null && local.last >= cutoff) { finish("recent", lastActivity, "Activity is within the rolling seven-day window"); continue; }
        const busy = initiallyBusy.get(id) ?? this.deps.busy(id);
        if (busy) { finish("inflight", lastActivity, busy); continue; }
        if (active?.[s.nativeSessionId!]) { finish("active", lastActivity, "Native foreground execution is positively active"); continue; }
        if (local.last === null || s.harness === "opencode" && !n) { finish("unknown", lastActivity, "Current native activity date is unavailable"); continue; }
        finish(this.isRetired(s) ? "already-retired" : "eligible", lastActivity,
          s.harness === "claude-code" ? "Approved age-only catalog unregistration; external Claude execution idleness remains unverified. Native history is preserved."
            : !active ? "Native foreground execution observation unavailable; execution state remains unverified despite valid old activity dates" : undefined);
      }
      // Mutations are bounded to 24 exact approved identities, four native reads
      // in flight; preview is bulk-only and never promises empty native queues.
      if (request.operation === "retire") {
        const eligible = results.filter(r => r.outcome === "eligible" && sessions.get(r.sessionId)!.harness === "opencode");
        let offset = 0;
        await Promise.all(Array.from({ length: Math.min(4, eligible.length) }, async () => {
          while (offset < eligible.length) {
            budget.check();
            const r = eligible[offset++]!, s = sessions.get(r.sessionId)!;
            const pending = await this.pendingNative(s, cutoff, budget);
            budget.check(); this.recordPending(r, observations.get(r.sessionId)!, pending);
          }
        }));
        budget.check();
      }
      let backupDirectory: string | undefined;
      if (request.operation === "retire") for (const r of results) {
        budget.check();
        if (["recent", "active"].includes(r.outcome) && this.isRetired(sessions.get(r.sessionId))) { r.outcome = "reactivated"; r.reason = "New activity observed; previous retirement is explicitly reactivated, not reapplied"; }
      }
      const changing = results.filter(r => request.operation === "retire" ? r.outcome === "eligible" || r.outcome === "reactivated" : request.operation === "restore" && r.outcome === "restored");
      if (request.operation !== "preview") {
        await budget.wait(() => this.deps.flush());
        budget.check();
        if (!this.deps.healthy() || request.expectedRevision !== this.revision) deny("retirement-owner-unavailable", "App ownership/revision changed during verification");
        try { backupDirectory = await this.backup(request, approval.refs, changing.map(r => sessions.get(r.sessionId)!), budget); }
        catch {
          budget.check();
          deny("retirement-backup-unavailable", "Verified backup durability could not be established; no retirement registry was published", 503);
        }
        budget.check();
        let freshActive: Record<string, { type: string }> | undefined;
        const retiringNative = changing.filter(r => r.outcome === "eligible" && sessions.get(r.sessionId)!.harness === "opencode");
        if (request.operation === "retire" && retiringNative.length) {
          try { freshActive = await this.activeNative(budget); } catch { budget.check(); /* Retain all unconfirmed rows below. */ }
          budget.check();
          // Latest exact metadata after backup catches activity during I/O.
          const retiring = retiringNative; let cursor = 0;
          await Promise.all(Array.from({ length: Math.min(4, retiring.length) }, async () => {
            while (cursor < retiring.length) {
              budget.check();
              const r = retiring[cursor++]!, s = sessions.get(r.sessionId)!;
              try {
                const n = (await this.nativeRequest<{ data: Native }>(this.deps.oc.path(s.nativeSessionId!), budget)).data;
                budget.check();
                const original = observations.get(r.sessionId)!.native!.time;
                if (!n || n.id !== s.nativeSessionId || JSON.stringify([n.time.created, n.time.updated, n.time.idle]) !== JSON.stringify([original.created, original.updated, original.idle])) { r.outcome = "recent"; r.reason = "Native activity changed during the operation; retained for fresh review"; }
                else {
                  const pending = await this.pendingNative(s, cutoff, budget);
                  budget.check(); this.recordPending(r, observations.get(r.sessionId)!, pending);
                }
              } catch { budget.check(); r.outcome = "unknown"; r.reason = "Final native activity proof unavailable"; }
            }
          }));
          budget.check();
          try { freshActive = await this.activeNative(budget); } catch { budget.check(); freshActive = undefined; }
          budget.check();
        }
        // No await between this final owner/identity/file fence and registry write.
        budget.check();
        if (!this.deps.healthy()) deny("retirement-owner-unavailable", "Serving ownership changed before publication");
        this.assertStorage();
        for (const r of changing) {
          budget.check();
          if (r.outcome !== "eligible" && r.outcome !== "restored" && r.outcome !== "reactivated") continue;
          const s = sessions.get(r.sessionId)!;
          if (!this.deps.sessions().includes(s) || !same(identity(s), { sessionId: r.sessionId, harness: approval.approved.get(r.sessionId)!.harness as Session["harness"], nativeSessionId: approval.approved.get(r.sessionId)!.native_id, authorityId: s.authorityId, cwd: approval.approved.get(r.sessionId)!.workspace }) || !this.deps.authorityCurrent(s)) { r.outcome = "identity-changed"; continue; }
          const busy = this.deps.busy(r.sessionId);
          if (busy && r.outcome === "eligible") { r.outcome = "inflight"; r.reason = busy; continue; }
          if (request.operation === "retire" && r.outcome === "eligible") {
            if (s.harness === "opencode" && freshActive?.[s.nativeSessionId!]) { r.outcome = "active"; r.reason = "Native foreground execution is positively active"; continue; }
            if (s.harness === "opencode" && !freshActive) r.reason = [r.reason, "Final native foreground execution observation unavailable; uncertainty is disclosed, not an age veto"].filter(Boolean).join("; ");
            const o = observations.get(r.sessionId)!;
            if (JSON.stringify([identity(s), s.lastRunId, this.deps.runs().filter(run => run.sessionId === r.sessionId)]) !== o.signature || [...o.files].some(([path, pin]) => { budget.check(); return JSON.stringify(this.fingerprint(path)) !== JSON.stringify(pin); })) { r.outcome = "recent"; r.reason = "App/native evidence changed while preparing backup"; continue; }
            r.outcome = "retired";
          }
        }
      }
      const counts: Record<string, number> = Object.fromEntries(["eligible", "retired", "already-retired", "restored", "reactivated", "already-active", "recent", "active", "unknown", "inflight", "identity-changed"].map(key => [key, 0]));
      for (const r of results) { budget.check(); counts[r.outcome] = (counts[r.outcome] ?? 0) + 1; }
      const response: Response = { requestId: request.requestId, operation: request.operation, revision: this.revision + (request.operation === "preview" ? 0 : 1), cutoff: cutoffText, counts, results, ...(backupDirectory ? { backupDirectory } : {}) };
      if (request.operation !== "preview") {
        const next = structuredClone(this.records), entries = new Map(next.entries.map(e => [e.identity.sessionId, e]));
        for (const r of results) {
          budget.check();
          if (r.outcome === "retired") {
            const s = sessions.get(r.sessionId)!;
            entries.set(r.sessionId, { identity: identity(s), state: "retired", retiredAt: new Date().toISOString(), restoredAt: null, lastActivity: r.lastActivity!, lastRunId: s.lastRunId, approvalSha256: request.approvalManifest.sha256, requestId: request.requestId });
          } else if (r.outcome === "restored" || r.outcome === "reactivated") { const e = entries.get(r.sessionId)!; e.state = "restored"; e.restoredAt = new Date().toISOString(); }
        }
        next.entries = [...entries.values()]; next.revision = response.revision;
        next.operations.push({ requestId: request.requestId, fingerprint, response });
        this.assertStorage();
        // Outside the storage-failure catch: expiry is retryable, never a reason
        // to fail-close unrelated App execution. The atomic writer is synchronous.
        budget.check();
        try { atomicAppRecord(this.deps.dataDir, FILE, next); this.registryPin = this.fingerprint(join(this.deps.dataDir, FILE)); }
        catch (error) { this.deps.storageFailed(error); throw error; }
        this.records = next; this.reindex(); this.deps.changed();
      }
      return response;
    } finally { this.reservations.clear(); this.flight = false; }
  }
  private assertStorage() {
    if (JSON.stringify(this.fingerprint(join(this.deps.dataDir, "manifest.json"))) !== JSON.stringify(this.manifestPin)) deny("retirement-store-changed", "Original App manifest binding changed", 503);
    let current: Fingerprint | null = null;
    try { current = this.fingerprint(join(this.deps.dataDir, FILE)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (JSON.stringify(current) !== JSON.stringify(this.registryPin)) deny("retirement-registry-changed", "Retirement registry changed outside the serving owner", 503);
  }
}
