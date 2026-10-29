import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { join, resolve } from "node:path";
import {
  APP_ADMISSION_MAX_PAYLOAD_BYTES, AppAdmissionCodecError, appAdmissionExpectedSourceMatches, canonicalAppAdmissionJSON, canonicalAppAdmissionPayload,
  decodeAppAdmissionEnvelope, decodeAppAdmissionKey, decodeAppAdmissionReceipt,
  decodeAppAdmissionRejection, decodeAppAdmissionTarget,
  type AppAdmissionEnvelope, type AppAdmissionKey, type AppAdmissionLookup,
  type AppAdmissionReceipt, type AppAdmissionRejection, type AppAdmissionTarget,
} from "../shared/conversation/app-admission-contract";
import { synchronousDispatchHook } from "./dispatch-evidence";

declare const permitBrand: unique symbol;
declare const invocationBrand: unique symbol;
/** Process-private intake permission only, NOT native/admission authority. */
export type AppAdmissionPermit = Readonly<{ [permitBrand]: true }>;
export type AppAdmissionInvocation = Readonly<{ [invocationBrand]: true }>;
export type AppAdmissionBegin = Readonly<{ kind: "created"; receipt: AppAdmissionReceipt; permit: AppAdmissionPermit }>
  | Readonly<{ kind: "existing"; receipt: AppAdmissionReceipt }>;
/** Server-owned immutable request binding, NEVER a client hint or native lease.
 * New conversation preparation MUST use this exact ID as its allocation factory;
 * it must not choose another ID or adopt a catalog collision. */
export type AppAdmissionConversationBinding = Readonly<{
  version: 1;
  kind: "existing" | "server-provisional";
  conversationId: string;
}>;
export type AppAdmissionPending = Readonly<{
  receipt: AppAdmissionReceipt;
  operation: AppAdmissionEnvelope["intent"]["operation"];
  /** Protected actual existing/server-reserved ID, including after restart. */
  conversationId: string;
  binding: AppAdmissionConversationBinding;
  chainId: string;
}>;
export type AppAdmissionRequestCode = "invalid-request" | "store-mismatch" | "payload-conflict" | "pending-admission" | "target-conflict" | "no-permit" | "already-initialized" | "capacity" | "science-chat-retired";
export class AppAdmissionRequestError extends Error {
  constructor(readonly code: AppAdmissionRequestCode, message: string, readonly status: 400 | 409 | 429 = 409) { super(message); }
}
export type AppAdmissionStorageCode = "uninitialized" | "corrupt" | "unavailable";
export class AppAdmissionStorageError extends Error {
  constructor(readonly code: AppAdmissionStorageCode, message: string, cause?: unknown) { super(message, { cause }); }
}
export type AppAdmissionStoreDependencies = Readonly<{
  /** Existing installation/data lock and sticky storage-health guard. */
  assertStorage: () => void;
  /** MUST prove synchronous execution INSIDE the existing bridge write queue.
   * Merely holding App locks is insufficient. This store owns no second queue. */
  assertSerializedMutation: () => void;
  /** Existing bridge arbitration/chain barriers, not just absence of a RunOwner.
   * Independently verify operation/conversation/lineage against the frozen wire
   * body and route; client-supplied conversationId/chainId are not authority.
   * For a server-provisional binding MUST reject any getSession(binding ID)
   * catalog collision: never adopt it. For live input MUST check expectedLiveRunId
   * against the selected owner and canSendInput; changed/finished runs reject.
   * May throw AppAdmissionRequestError for an expected refusal. */
  assertCanBegin: (intent: AppAdmissionEnvelope, pending: readonly AppAdmissionPending[], binding: AppAdmissionConversationBinding) => void;
  /** Synchronously verify the EXACT original source/run/message installation
   * against existing durable submission journal AND committed metadata proof.
   * A caller-supplied target/receipt alone is never proof. No native IO/writes.
   * Matching expectedSource never replaces actual-source/current-metadata guards.
   * May throw AppAdmissionRequestError for an expected pre-publication refusal. */
  validateAdmission: (intent: AppAdmissionEnvelope, target: AppAdmissionTarget, binding: AppAdmissionConversationBinding) => void;
  failClosed: (error: AppAdmissionStorageError) => void;
}>;

const DIRECTORY = "app-admissions";
const MAX_FILE_BYTES = 270_000;
const PRIVATE_VERSION = 2;
/** Fixed wrapper keys plus a UUID and bounded binding enum fit in 512 bytes,
 * independently of the client's already-bounded immutable envelope. */
const MAX_PENDING_WRAPPER_OVERHEAD_BYTES = 512;
const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const recordName = new RegExp(`^(${uuidPattern})\\.(pending|admitted|rejected)\\.json$`);
type Pin = Pick<Stats, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs" | "mode" | "uid" | "nlink">;
type Snapshot = { pin: Pin; bytes: Buffer };
type Root = { path: string; pin: Pin; manifest: Snapshot };
type PrivatePending = Readonly<{ version: 2; envelope: AppAdmissionEnvelope; binding: AppAdmissionConversationBinding }>;
type Stored = { envelope: AppAdmissionEnvelope; binding: AppAdmissionConversationBinding; receipt: AppAdmissionReceipt };
type Invocation = { key: AppAdmissionKey; used: boolean };

function deny(code: AppAdmissionRequestCode, message: string, status?: 400 | 409 | 429): never { throw new AppAdmissionRequestError(code, message, status); }
function unsafe(message: string): never { throw new AppAdmissionStorageError("corrupt", message); }
const identity = (a: Pin, b: Pin) => a.dev === b.dev && a.ino === b.ino;
const equalPin = (a: Pin, b: Pin) => identity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.mode === b.mode && a.uid === b.uid && a.nlink === b.nlink;
function secure(stat: Stats, directory: boolean): void {
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.isSymbolicLink()
    || (stat.mode & 0o7777) !== (directory ? 0o700 : 0o600)
    || process.getuid && stat.uid !== process.getuid() || !directory && stat.nlink !== 1) unsafe("Unsafe App admission storage permissions or identity");
}
function directory(path: string, expected?: Pin): Pin {
  const stat = lstatSync(path); secure(stat, true);
  if (realpathSync(path) !== path || expected && !identity(stat, expected)) unsafe("App admission directory identity changed");
  return stat;
}
function read(path: string, max = MAX_FILE_BYTES): Snapshot {
  const before = lstatSync(path); secure(before, false);
  if (before.size > max || realpathSync(path) !== path) unsafe("Unsafe or oversized App admission record");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd); secure(opened, false);
    if (!equalPin(before, opened) || opened.size > max) unsafe("App admission record changed before read");
    // A concurrently growing file cannot turn a bounded record into an
    // unbounded allocation/read. Check one extra byte for unexpected growth.
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) unsafe("App admission record ended during read");
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0) unsafe("App admission record grew during read");
    const after = fstatSync(fd), current = lstatSync(path);
    secure(after, false); secure(current, false);
    if (!equalPin(opened, after) || !equalPin(after, current) || bytes.length !== after.size) unsafe("App admission record changed during read");
    return { pin: after, bytes };
  } finally { closeSync(fd); }
}
function parsed(snapshot: Snapshot): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(snapshot.bytes));
}
function verify(path: string, expected: Snapshot): void {
  const current = read(path);
  if (!equalPin(current.pin, expected.pin) || !current.bytes.equals(expected.bytes)) unsafe("Pinned App admission record changed");
}
function root(path: string, storeId: string): Root {
  if (resolve(path) !== path) unsafe("App admission root must be canonical");
  const pin = directory(path), manifest = read(join(path, "manifest.json"), 4096), value = parsed(manifest) as Record<string, unknown>;
  if (!value || Object.keys(value).sort().join(",") !== "createdAt,format,storeId,version" || value.format !== "sane-app-store" || value.version !== 1
    || value.storeId !== storeId || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) unsafe("App admission manifest identity mismatch");
  return { path, pin, manifest };
}
function checkRoot(value: Root): void { directory(value.path, value.pin); verify(join(value.path, "manifest.json"), value.manifest); }
function syncDirectory(path: string, expected: Pin): void {
  directory(path, expected);
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const opened = fstatSync(fd); secure(opened, true); if (!identity(opened, expected)) unsafe("App admission directory changed before fsync"); fsyncSync(fd); }
  finally { closeSync(fd); }
  directory(path, expected);
}
function publishExclusive(path: string, pin: Pin, name: string, bytes: Buffer, guard: () => void): Snapshot {
  const temporary = join(path, `.publish-${randomUUID()}.tmp`), destination = join(path, name);
  guard(); directory(path, pin);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  let installed: Pin | undefined;
  try {
    secure(fstatSync(fd), false);
    writeFileSync(fd, bytes); fsyncSync(fd);
    const owned = fstatSync(fd), current = lstatSync(temporary); secure(owned, false); secure(current, false);
    if (!equalPin(owned, current) || owned.size !== bytes.length) unsafe("App admission temporary publication changed");
    guard(); directory(path, pin);
    // link is an atomic NO-OVERWRITE installation. EEXIST is never adopted.
    linkSync(temporary, destination);
    const linked = lstatSync(destination), retained = lstatSync(temporary), opened = fstatSync(fd);
    if (!identity(linked, owned) || !identity(retained, owned) || !identity(opened, owned)
      || linked.nlink !== 2 || retained.nlink !== 2 || opened.nlink !== 2
      || (linked.mode & 0o7777) !== 0o600 || linked.uid !== owned.uid || linked.size !== bytes.length) unsafe("App admission linked publication changed");
    guard(); directory(path, pin);
    // Remove only this proven-owned transitional link, never unknown leftovers.
    const unlinking = lstatSync(temporary);
    if (!equalPin(unlinking, retained)) unsafe("App admission temporary link changed before unlink");
    unlinkSync(temporary);
    const unlinked = fstatSync(fd), published = lstatSync(destination);
    secure(unlinked, false); secure(published, false);
    if (!equalPin(unlinked, published) || !identity(unlinked, owned)) unsafe("App admission installed inode changed");
    installed = unlinked;
  } finally { closeSync(fd); }
  guard(); syncDirectory(path, pin); guard();
  const result = read(destination);
  if (!installed || !equalPin(result.pin, installed) || !result.bytes.equals(bytes)) unsafe("App admission committed inode, stamps or bytes changed");
  return result;
}
function keyOf(value: AppAdmissionEnvelope | AppAdmissionReceipt): AppAdmissionKey {
  return decodeAppAdmissionKey({ storeId: value.storeId, clientRequestId: value.clientRequestId, payloadSha256: value.payloadSha256 });
}
function pending(envelope: AppAdmissionEnvelope): AppAdmissionReceipt {
  return decodeAppAdmissionReceipt({ version: 1, ...keyOf(envelope), state: "pending", target: null, rejection: null });
}
function fingerprint(envelope: AppAdmissionEnvelope): string { return createHash("sha256").update(canonicalAppAdmissionPayload(envelope.intent)).digest("hex"); }
function targetKey(target: AppAdmissionTarget): string {
  return canonicalAppAdmissionJSON([target.dispatch.source.harnessId, target.dispatch.source.authorityId, target.dispatch.source.nativeSessionId, target.nativeMessageId]);
}
function validateTargetIntent(envelope: AppAdmissionEnvelope, binding: AppAdmissionConversationBinding, target: AppAdmissionTarget): void {
  if ((envelope.intent.operation === "live-input") !== (target.kind === "live-input")
    || target.dispatch.source.sessionId !== binding.conversationId
    || envelope.intent.expectedSource !== null && !appAdmissionExpectedSourceMatches(envelope.intent.expectedSource, target.dispatch.source)
    || envelope.intent.operation === "live-input" && target.dispatch.runId !== envelope.intent.expectedLiveRunId) deny("target-conflict", "Admission target differs from the original server binding, expected source or expected live run");
}

function privateShape(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null
    || Object.getOwnPropertySymbols(value).length || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !("value" in d) || !d.enumerable)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new AppAdmissionCodecError("Invalid private App admission fields");
}
function decodePrivatePending(value: unknown): PrivatePending {
  privateShape(value, ["version", "envelope", "binding"]);
  if (value.version !== PRIVATE_VERSION) throw new AppAdmissionCodecError("Unsupported private App admission version");
  const envelope = decodeAppAdmissionEnvelope(value.envelope);
  privateShape(value.binding, ["version", "kind", "conversationId"]);
  const binding = value.binding;
  if (binding.version !== 1 || typeof binding.conversationId !== "string" || !new RegExp(`^${uuidPattern}$`).test(binding.conversationId)
    || (envelope.intent.conversationId === null ? binding.kind !== "server-provisional" : binding.kind !== "existing" || binding.conversationId !== envelope.intent.conversationId)) throw new AppAdmissionCodecError("Invalid private App admission conversation binding");
  return Object.freeze({ version: PRIVATE_VERSION, envelope, binding: Object.freeze({ version: 1, kind: binding.kind as AppAdmissionConversationBinding["kind"], conversationId: binding.conversationId }) });
}
function privatePendingBytes(record: PrivatePending): Buffer {
  // Compose only strictly decoded fixed wrapper fields. Do not feed the whole
  // wrapper through the client-envelope size limit or change its public hash.
  const envelope = canonicalAppAdmissionJSON(record.envelope), binding = canonicalAppAdmissionJSON(record.binding);
  const text = `{"binding":${binding},"envelope":${envelope},"version":${PRIVATE_VERSION}}`;
  const bytes = Buffer.from(text), envelopeBytes = Buffer.byteLength(envelope);
  if (bytes.length - envelopeBytes > MAX_PENDING_WRAPPER_OVERHEAD_BYTES
    || bytes.length > APP_ADMISSION_MAX_PAYLOAD_BYTES + MAX_PENDING_WRAPPER_OVERHEAD_BYTES || bytes.length > MAX_FILE_BYTES) throw new AppAdmissionCodecError("Private App admission wrapper exceeds its byte limit");
  return bytes;
}

/** Immutable App intake receipts only; NOT RunOwner storage, a dispatch journal,
 * native intent, or an admission scheduler. All writes are synchronous, invoked
 * INSIDE the existing bridge serialized queue. Public reads never create/repair.
 * The existing storage owner lock protects the loaded receipt indexes; routine
 * reads do not re-inventory durable history. Each new record is durably published
 * before its receipt becomes visible in memory.
 * Restart loads history but manufactures NO permit/invocation and never resumes
 * pending work. Unknown pending history remains an arbitration barrier.
 *
 * Explicit initialize is required before first use. Missing directories/markers
 * on open are errors, not an empty ledger or an implicit migration/repair. */
export class AppAdmissionStore {
  readonly #deps: AppAdmissionStoreDependencies;
  readonly #root: Root;
  readonly #path: string;
  readonly #pin: Pin;
  readonly #records = new Map<string, Stored>();
  readonly #pendingRecords = new Map<string, Stored>();
  readonly #targets = new Set<string>();
  /** Receipt-data index only, not a conversation/execution owner registry. */
  readonly #conversationIds = new Set<string>();
  #permits = new WeakMap<AppAdmissionPermit, AppAdmissionKey>();
  #invocations = new WeakMap<AppAdmissionInvocation, Invocation>();
  #failure?: AppAdmissionStorageError;
  #busy = false;

  /** Explicit bootstrap only, never call in GET or as recovery after open fails.
   * Refuses an existing directory, including partial initialization. */
  static initialize(dataDir: string, storeId: string, deps: AppAdmissionStoreDependencies): void {
    // Shared codec verifies canonical UUID syntax without deriving a new identity.
    decodeAppAdmissionKey({ storeId, clientRequestId: storeId, payloadSha256: "0".repeat(64) });
    const alreadyInitialized = new AppAdmissionRequestError("already-initialized", "App admission directory already exists; it was not changed");
    try {
      synchronousDispatchHook(deps.assertStorage); synchronousDispatchHook(deps.assertSerializedMutation);
      const app = root(dataDir, storeId), path = join(dataDir, DIRECTORY);
      const guard = () => { synchronousDispatchHook(deps.assertStorage); synchronousDispatchHook(deps.assertSerializedMutation); checkRoot(app); };
      guard();
      try { mkdirSync(path, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw alreadyInitialized; throw error; }
      const pin = directory(path);
      syncDirectory(dataDir, app.pin);
      const marker = publishExclusive(path, pin, "store.json", Buffer.from(canonicalAppAdmissionJSON({ version: PRIVATE_VERSION, storeId })), guard);
      guard(); directory(path, pin); syncDirectory(dataDir, app.pin);
      guard();
      // LAST dependency callback above. Final proof below is callback-free.
      checkRoot(app); directory(path, pin);
      const names = readdirSync(path);
      if (names.length !== 1 || names[0] !== "store.json") unsafe("App admission initialization inventory changed");
      verify(join(path, "store.json"), marker);
      checkRoot(app); directory(path, pin);
    } catch (cause) {
      // Only this exact pre-mutation EEXIST refusal is a request error. Assertion
      // callback errors, especially after partial publication, fence storage.
      if (cause === alreadyInitialized) throw cause;
      const error = cause instanceof AppAdmissionStorageError ? cause : new AppAdmissionStorageError("unavailable", "App admission initialization failed; no automatic repair", cause);
      try { synchronousDispatchHook(() => deps.failClosed(error)); } finally { throw error; }
    }
  }

  constructor(dataDir: string, readonly storeId: string, deps: AppAdmissionStoreDependencies) {
    this.#deps = Object.freeze({ ...deps });
    try {
      decodeAppAdmissionKey({ storeId, clientRequestId: storeId, payloadSha256: "0".repeat(64) });
      synchronousDispatchHook(this.#deps.assertStorage);
      this.#root = root(dataDir, storeId); this.#path = join(dataDir, DIRECTORY);
      try { this.#pin = directory(this.#path); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw new AppAdmissionStorageError("uninitialized", "App admission directory is missing; explicit initialization required", cause); throw cause; }
      const names = readdirSync(this.#path).sort();
      if (!names.includes("store.json")) unsafe("Missing App admission store marker");
      const files = new Map<string, Snapshot>();
      for (const name of names) {
        if (name !== "store.json" && !recordName.test(name)) unsafe("Unknown App admission file; no automatic repair");
        files.set(name, read(join(this.#path, name)));
      }
      const marker = parsed(files.get("store.json")!);
      if (canonicalAppAdmissionJSON(marker) !== canonicalAppAdmissionJSON({ version: PRIVATE_VERSION, storeId })) unsafe("Unsupported App admission private version or store identity; no automatic adoption");
      const provisionalIds = new Set<string>();
      for (const [name, snapshot] of files) {
        const match = recordName.exec(name);
        if (match?.[2] !== "pending") continue;
        const record = decodePrivatePending(parsed(snapshot)), { envelope, binding } = record;
        // Only the certified canonical v2 wrapper is loadable, never an old bare
        // client envelope or an unbounded alternate private representation.
        if (!snapshot.bytes.equals(privatePendingBytes(record))) unsafe("Noncanonical private App admission pending record");
        if (envelope.storeId !== storeId || envelope.clientRequestId !== match[1] || envelope.payloadSha256 !== fingerprint(envelope)) unsafe("App admission immutable intent mismatch");
        if (binding.kind === "server-provisional") {
          if (provisionalIds.has(binding.conversationId)) unsafe("Multiple App requests reserve the same server-provisional conversation");
          provisionalIds.add(binding.conversationId);
        }
        this.#conversationIds.add(binding.conversationId);
        this.#records.set(envelope.clientRequestId, { envelope, binding, receipt: pending(envelope) });
      }
      for (const [name, snapshot] of files) {
        const match = recordName.exec(name);
        if (!match || match[2] === "pending") continue;
        const item = this.#records.get(match[1]), receipt = decodeAppAdmissionReceipt(parsed(snapshot));
        if (!item || item.receipt.state !== "pending" || receipt.state !== match[2]
          || canonicalAppAdmissionJSON(keyOf(receipt)) !== canonicalAppAdmissionJSON(keyOf(item.envelope))) unsafe("App admission terminal receipt correspondence failed");
        if (receipt.state === "admitted") {
          try { validateTargetIntent(item.envelope, item.binding, receipt.target); } catch { unsafe("App admission target/intent/binding mismatch"); }
          const target = targetKey(receipt.target);
          if (this.#targets.has(target)) unsafe("Native message belongs to multiple App admission receipts");
          this.#targets.add(target);
        }
        item.receipt = receipt;
      }
      const pendingConversations = new Set<string>(), pendingChains = new Set<string>();
      for (const item of this.#records.values()) if (item.receipt.state === "pending") {
        if (pendingConversations.has(item.binding.conversationId) || pendingChains.has(item.envelope.intent.chainId)) unsafe("Multiple unresolved App admission records reserve the same conversation or chain");
        pendingConversations.add(item.binding.conversationId); pendingChains.add(item.envelope.intent.chainId);
        this.#pendingRecords.set(item.envelope.clientRequestId, item);
      }
      this.#guard();
      this.#rawRoot();
    } catch (error) { this.#fatal(error); }
  }

  #fatal(cause: unknown): never {
    if (!this.#failure) {
      this.#failure = cause instanceof AppAdmissionStorageError ? cause : new AppAdmissionStorageError(cause instanceof AppAdmissionCodecError || (cause as NodeJS.ErrnoException)?.code === "ENOENT" ? "corrupt" : "unavailable", "App admission storage unavailable or changed; reconciliation required", cause);
      this.#permits = new WeakMap(); this.#invocations = new WeakMap();
      try { synchronousDispatchHook(() => this.#deps.failClosed(this.#failure!)); } catch { /* Preserve the first physical failure. */ }
    }
    throw this.#failure;
  }
  /** Existing storage ownership/health and serialized mutation guard. */
  #guard(mutation = false): void {
    if (this.#failure) throw this.#failure;
    try {
      synchronousDispatchHook(this.#deps.assertStorage);
      if (mutation) synchronousDispatchHook(this.#deps.assertSerializedMutation);
      if (this.#failure) throw this.#failure;
    } catch (error) { this.#fatal(error); }
  }
  #rawRoot(): void {
    if (this.#failure) throw this.#failure;
    checkRoot(this.#root); directory(this.#path, this.#pin);
  }
  #input<T>(action: () => T): T {
    try { return action(); }
    catch (error) { if (error instanceof AppAdmissionRequestError) throw error; deny("invalid-request", "Invalid App admission input", 400); }
  }
  #read<T>(action: () => T): T {
    if (this.#busy) this.#fatal(new Error("App admission store reentered during mutation"));
    try {
      this.#guard();
      return action();
    }
    catch (error) { if (this.#failure) throw this.#failure; if (error instanceof AppAdmissionRequestError) throw error; return this.#fatal(error); }
  }
  #mutate<T>(action: () => T): T {
    if (this.#busy) this.#fatal(new Error("App admission mutation reentered"));
    this.#busy = true;
    try {
      this.#guard(true);
      const result = action();
      this.#guard(true);
      return result;
    } catch (error) { if (this.#failure) throw this.#failure; if (error instanceof AppAdmissionRequestError) throw error; return this.#fatal(error); }
    finally { this.#busy = false; }
  }
  #key(input: AppAdmissionKey): AppAdmissionKey {
    const key = this.#input(() => decodeAppAdmissionKey(input));
    if (key.storeId !== this.storeId) deny("store-mismatch", "App admission lookup belongs to another store");
    return key;
  }
  #find(key: AppAdmissionKey): Stored | undefined {
    const item = this.#records.get(key.clientRequestId);
    if (item && item.envelope.payloadSha256 !== key.payloadSha256) deny("payload-conflict", "Client request ID already names a different immutable payload");
    return item;
  }
  #pending(): readonly AppAdmissionPending[] {
    return Object.freeze([...this.#pendingRecords.values()].map(item => {
      return Object.freeze({ receipt: item.receipt, operation: item.envelope.intent.operation, conversationId: item.binding.conversationId, binding: item.binding, chainId: item.envelope.intent.chainId });
    }));
  }
  #publish(name: string, contents: Buffer): void {
    publishExclusive(this.#path, this.#pin, name, contents, () => { this.#guard(true); this.#rawRoot(); });
  }
  #invocation(handle: AppAdmissionInvocation): Stored {
    const invocation = this.#invocations.get(handle);
    if (!invocation || invocation.used) deny("no-permit", "No original one-shot App admission invocation");
    // Consume BEFORE callbacks or IO; caught reentry/failure cannot reuse it.
    invocation.used = true;
    const item = this.#find(invocation.key);
    if (!item || item.receipt.state !== "pending") deny("no-permit", "Original App admission request is no longer pending");
    return item;
  }

  lookup(input: AppAdmissionKey): AppAdmissionLookup {
    const key = this.#key(input);
    return this.#read(() => { const item = this.#find(key); return item ? Object.freeze({ kind: "found", receipt: item.receipt }) : Object.freeze({ kind: "absent", key }); });
  }
  /** History-only arbitration input. No prompts/private payloads or permits. */
  readPending(): readonly AppAdmissionPending[] { return this.#read(() => this.#pending()); }

  /** Call before ANY async preparation or native creation. Only this successful
   * durable insert returns a private permit. Duplicate/conflicting IDs never do. */
  begin(input: AppAdmissionEnvelope): AppAdmissionBegin {
    const envelope = this.#input(() => decodeAppAdmissionEnvelope(input)), key = this.#key(keyOf(envelope));
    if (envelope.payloadSha256 !== fingerprint(envelope)) deny("invalid-request", "App admission payload hash does not match frozen wire intent", 400);
    return this.#mutate(() => {
      const existing = this.#find(key);
      if (existing) return Object.freeze({ kind: "existing", receipt: existing.receipt });
      const record = this.#input(() => decodePrivatePending({ version: PRIVATE_VERSION, envelope, binding: {
        version: 1, kind: envelope.intent.conversationId === null ? "server-provisional" : "existing",
        conversationId: envelope.intent.conversationId ?? randomUUID(),
      } }));
      const { binding } = record;
      if (binding.kind === "server-provisional" && this.#conversationIds.has(binding.conversationId)) deny("target-conflict", "Server-provisional conversation ID collides with existing receipt history");
      const contents = this.#input(() => privatePendingBytes(record));
      const unresolved = this.#pending();
      if (unresolved.some(item => item.chainId === envelope.intent.chainId || item.conversationId === binding.conversationId)) deny("pending-admission", "An unresolved App admission already blocks this conversation or draft chain");
      synchronousDispatchHook(() => this.#deps.assertCanBegin(envelope, unresolved, binding));
      this.#guard(true); this.#rawRoot();
      const receipt = pending(envelope);
      this.#publish(`${key.clientRequestId}.pending.json`, contents);
      const item = { envelope, binding, receipt };
      this.#records.set(key.clientRequestId, item);
      this.#pendingRecords.set(key.clientRequestId, item);
      this.#conversationIds.add(binding.conversationId);
      const permit = Object.freeze({}) as AppAdmissionPermit;
      this.#permits.set(permit, key);
      return Object.freeze({ kind: "created", receipt, permit });
    });
  }
  /** Original invocation only. Never reconstruct from GET, request IDs, disk,
   * JSON, duplicates, a rejected request, or after restart. No native authority.
   * New-conversation preparation MUST use () => binding.conversationId as its
   * preallocated-ID factory and refuse catalog collisions rather than adopting
   * or choosing another ID. Live dispatch MUST recheck expectedLiveRunId and
   * canSendInput and reject a changed/finished run, never fall through to initial. */
  consume(permit: AppAdmissionPermit): Readonly<{ invocation: AppAdmissionInvocation; intent: AppAdmissionEnvelope; binding: AppAdmissionConversationBinding }> {
    return this.#mutate(() => {
      const key = this.#permits.get(permit);
      if (!key) deny("no-permit", "No fresh App admission intake permit");
      this.#permits.delete(permit);
      const item = this.#find(key);
      if (!item || item.receipt.state !== "pending") deny("no-permit", "Original App admission request is no longer pending");
      const invocation = Object.freeze({}) as AppAdmissionInvocation;
      this.#invocations.set(invocation, { key, used: false });
      return Object.freeze({ invocation, intent: item.envelope, binding: item.binding });
    });
  }
  admit(invocation: AppAdmissionInvocation, input: AppAdmissionTarget): AppAdmissionReceipt {
    const target = this.#input(() => decodeAppAdmissionTarget(input));
    return this.#mutate(() => {
      const item = this.#invocation(invocation);
      validateTargetIntent(item.envelope, item.binding, target);
      const ownershipKey = targetKey(target);
      if (this.#targets.has(ownershipKey)) deny("target-conflict", "Native message already belongs to another App admission");
      synchronousDispatchHook(() => this.#deps.validateAdmission(item.envelope, target, item.binding));
      this.#guard(true); this.#rawRoot();
      const receipt = decodeAppAdmissionReceipt({ version: 1, ...keyOf(item.envelope), state: "admitted", target, rejection: null });
      this.#publish(`${receipt.clientRequestId}.admitted.json`, Buffer.from(canonicalAppAdmissionJSON(receipt)));
      item.receipt = receipt;
      this.#pendingRecords.delete(receipt.clientRequestId);
      this.#targets.add(ownershipKey);
      return receipt;
    });
  }
  reject(invocation: AppAdmissionInvocation, input: AppAdmissionRejection): AppAdmissionReceipt {
    const rejection = this.#input(() => decodeAppAdmissionRejection(input));
    return this.#mutate(() => {
      const item = this.#invocation(invocation);
      const receipt = decodeAppAdmissionReceipt({ version: 1, ...keyOf(item.envelope), state: "rejected", target: null, rejection });
      this.#publish(`${receipt.clientRequestId}.rejected.json`, Buffer.from(canonicalAppAdmissionJSON(receipt))); item.receipt = receipt;
      this.#pendingRecords.delete(receipt.clientRequestId);
      return receipt;
    });
  }
  /** Natural final native-boundary fence: check the exact published receipt.
   * Publication already completed file and directory fsync before indexing it.
   * Caller MUST ALSO retain normal owner/source/context/native-intent guards.
   * Historical admitted receipts alone never authorize execution or replay. */
  assertAdmitted(input: AppAdmissionKey, expected: AppAdmissionTarget): void {
    const key = this.#key(input), target = this.#input(() => decodeAppAdmissionTarget(expected));
    this.#read(() => {
      const item = this.#find(key);
      if (!item || item.receipt.state !== "admitted" || canonicalAppAdmissionJSON(item.receipt.target) !== canonicalAppAdmissionJSON(target)) deny("target-conflict", "Exact durable App admission publication is unavailable");
    });
  }
}
