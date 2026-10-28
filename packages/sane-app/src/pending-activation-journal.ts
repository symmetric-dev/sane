import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isAssistantAgentId, type StoredSaneAgentIdentity } from "sane-core/agent-catalog";
import type { CanonicalActivation } from "./canonical-activation-validation";
import { synchronousDispatchHook } from "./dispatch-evidence";
import { nativeMessageId, uuid, type Event } from "./history";
import { RunJournalWriter, type RunJournalBaseline } from "./run-journal";
import type { Harness } from "./oc-contract";
import { toNativeHarness } from "./harness-names";
import { validNativeAuthorityId } from "sane-core/native-source-contract";

export type PendingActivationInput = {
  sessionId: string;
  identity: StoredSaneAgentIdentity;
  activation: CanonicalActivation;
  source: { harnessId: Harness; authorityId: string; cwd: string };
};
type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
declare const preparationBrand: unique symbol;
/** Installation data only: never a native submission/acceptance capability. */
export type PendingActivationPreparation = Readonly<{
  runId: string;
  nativeCommandId: string | null;
  activation: Immutable<CanonicalActivation>;
  events: readonly Event[];
  [preparationBrand]: true;
}>;
type RecordV3 = PendingActivationInput & { schema: 3; storeId: string; runId: string; nativeCommandId: string | null };
type DirectoryPin = { dev: number; ino: number };
type FilePin = DirectoryPin & { size: number; mtimeMs: number; ctimeMs: number; hash: string };
type Captured = { record: RecordV3; baseline: RunJournalBaseline; token: PendingActivationPreparation };
class LegacyActivation extends Error {}
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) throw new Error("Invalid pending activation shape");
}
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const revision = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

function assertInput(input: PendingActivationInput): void {
  exact(input, ["sessionId", "identity", "activation", "source"]);
  exact(input.identity, ["kind", "role"]);
  if (!uuid(input.sessionId) || input.identity.kind !== "assistant" || !isAssistantAgentId(input.identity.role)) throw new Error("Pending activation requires an ordinary assistant identity");
  const pair = input.activation;
  exact(pair, ["saneExecution", "saneContext"]);
  exact(pair.saneExecution, ["schema", "revision"]);
  exact(pair.saneContext, ["version", "framework", "package"]);
  exact(pair.saneContext.package, ["schema", "revision", "delivery"]);
  if (pair.saneExecution.schema !== 1 || !revision(pair.saneExecution.revision) || !Number.isSafeInteger(pair.saneContext.version)
    || pair.saneContext.version < 1 || typeof pair.saneContext.framework !== "string" || !pair.saneContext.framework
    || pair.saneContext.package.schema !== 1 || !revision(pair.saneContext.package.revision) || pair.saneContext.package.delivery !== "standing-native-role") throw new Error("Invalid pending canonical pair");
  exact(input.source, ["harnessId", "authorityId", "cwd"]);
  const source = input.source;
  if (!["claude-code", "opencode", "grok"].includes(source.harnessId)
    || !validNativeAuthorityId(toNativeHarness(source.harnessId), source.authorityId)
    || typeof source.cwd !== "string" || !isAbsolute(source.cwd) || source.cwd.includes("\0")) throw new Error("Invalid pending activation source");
}
const inputOf = (record: RecordV3): PendingActivationInput => ({ sessionId: record.sessionId, identity: record.identity, activation: record.activation, source: record.source });
const markerOf = (record: RecordV3) => ({ schema: 1, type: "activation-preparation", storeId: record.storeId, sessionId: record.sessionId,
  runId: record.runId, identity: record.identity, activation: record.activation, source: record.source, nativeCommandId: record.nativeCommandId });

/** A bounded anchor in the existing activation namespace and existing run log.
 * Call prepare only inside the bridge's existing global queue. This class has
 * no scheduler, metadata writer, native handle, retry ledger or repair path.
 * The caller still owns canonical-content validation, admission, lease and
 * no-existing-Run checks, including after native creation and before install. */
export class PendingActivationJournals {
  private readonly root: DirectoryPin;
  private readonly directories = new Map<string, DirectoryPin>();
  private readonly files = new Map<string, FilePin>();
  private readonly captures = new Map<string, Captured>();
  private readonly tokens = new WeakMap<PendingActivationPreparation, Captured>();
  private failed = false;
  private busy = false;

  constructor(private readonly directory: string, private readonly storeId: string, private readonly writer: RunJournalWriter,
    private readonly deps: { assertStorage: () => void; failClosed: (error: unknown) => void }) {
    try {
      synchronousDispatchHook(() => deps.assertStorage());
      this.root = this.directoryPin(directory);
      if (!uuid(storeId)) throw new Error("Invalid pending activation store identity");
      const manifest = this.readPinned(join(directory, "manifest.json"));
      exact(manifest, ["format", "version", "storeId", "createdAt"]);
      if (manifest.format !== "sane-app-store" || manifest.version !== 1 || manifest.storeId !== storeId
        || typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt))) throw new Error("Pending activation manifest mismatch");
      this.guard();
    } catch (error) { this.fatal(error); }
  }

  private fatal(error: unknown): never {
    this.failed = true;
    try { synchronousDispatchHook(() => this.deps.failClosed(error)); } finally { throw error; }
  }
  private operation<T>(action: () => T): T {
    if (this.busy) throw new Error("Reentrant pending activation operation");
    this.busy = true;
    try { this.guard(); const result = action(); this.guard(); return result; }
    catch (error) { if (error instanceof LegacyActivation) throw error; return this.fatal(error); }
    finally { this.busy = false; }
  }
  private directoryPin(path: string): DirectoryPin {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error("Unsafe pending activation directory");
    const pin = { dev: stat.dev, ino: stat.ino }, previous = this.directories.get(path);
    if (previous && !equal(previous, pin)) throw new Error("Pending activation directory changed");
    this.directories.set(path, pin);
    return pin;
  }
  private filePin(fd: number, path: string, bytes: Buffer): FilePin {
    const opened = fstatSync(fd), current = lstatSync(path);
    if (!opened.isFile() || opened.nlink !== 1 || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || realpathSync(path) !== path
      || current.dev !== opened.dev || current.ino !== opened.ino || current.size !== opened.size
      || current.mtimeMs !== opened.mtimeMs || current.ctimeMs !== opened.ctimeMs || bytes.length !== opened.size) throw new Error("Unsafe pending activation file");
    return { dev: opened.dev, ino: opened.ino, size: opened.size, mtimeMs: opened.mtimeMs, ctimeMs: opened.ctimeMs, hash: createHash("sha256").update(bytes).digest("hex") };
  }
  private readPinned(path: string): unknown {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1) throw new Error("Unsafe pending activation file");
      const bytes = readFileSync(fd), pin = this.filePin(fd, path, bytes);
      if (before.dev !== pin.dev || before.ino !== pin.ino || before.size !== pin.size || before.mtimeMs !== pin.mtimeMs || before.ctimeMs !== pin.ctimeMs) throw new Error("Pending activation file changed while reading");
      const previous = this.files.get(path);
      if (previous && !equal(previous, pin)) throw new Error("Pending activation pinned bytes changed");
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
      this.files.set(path, pin);
      return value;
    } finally { closeSync(fd); }
  }
  private guard(): void {
    if (this.failed) throw new Error("Pending activation failed; operator reconciliation required");
    synchronousDispatchHook(() => this.deps.assertStorage());
    if (!equal(this.root, this.directoryPin(this.directory))) throw new Error("Pending activation root changed");
    this.readPinned(join(this.directory, "manifest.json"));
    for (const path of this.directories.keys()) this.directoryPin(path);
    // Recheck every discovered immutable anchor, not just the requested session.
    for (const path of this.files.keys()) if (path !== join(this.directory, "manifest.json")) this.readPinned(path);
  }
  private exists(path: string): boolean {
    try { lstatSync(path); return true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (this.directories.has(path) || this.files.has(path)) throw new Error("Pinned pending activation path missing");
      return false;
    }
  }
  private record(sessionId: string): RecordV3 | null {
    if (!uuid(sessionId)) throw new Error("Invalid pending activation session");
    const ancestors = join(this.directory, "activations"), directory = join(ancestors, sessionId);
    if (!this.exists(ancestors)) return null;
    this.directoryPin(ancestors);
    if (!this.exists(directory)) return null;
    this.directoryPin(directory);
    const value = this.readPinned(join(directory, "activation.json"));
    if (value && typeof value === "object" && "schema" in value && value.schema === 2) {
      // A version edit cannot downgrade an anchored record into an ignored
      // legacy slot and thereby remove its journal's startup repair exclusion.
      const legacy: unknown = value;
      exact(legacy, ["schema", "identity", "activation"]);
      exact(legacy.identity, ["kind", "role"]);
      if (!legacy.activation || typeof legacy.activation !== "object" || Array.isArray(legacy.activation)
        || Object.keys(legacy.activation).some(key => !["saneExecution", "saneContext"].includes(key))) throw new Error("Invalid legacy activation shape");
      return null;
    }
    exact(value, ["schema", "storeId", "sessionId", "identity", "activation", "source", "runId", "nativeCommandId"]);
    if (value.schema !== 3 || value.storeId !== this.storeId || value.sessionId !== sessionId || !uuid(value.runId)
      || (value.source?.harnessId === "opencode" ? !nativeMessageId(value.nativeCommandId) : value.nativeCommandId !== null)) throw new Error("Invalid pending activation anchor identity");
    const record = value as RecordV3;
    assertInput(inputOf(record));
    return freeze(record);
  }
  /** Noncreating detection only. Legacy schema 2 is never retrofitted. */
  hasPending(sessionId: string): boolean { return this.operation(() => this.record(sessionId) !== null); }

  /** Startup repair exclusion, not replay/adoption. Journals may be absent or
   * contain real execution events; only an explicit prepare validates prep-only. */
  anchoredRunIds(): ReadonlySet<string> {
    return this.operation(() => {
      const path = join(this.directory, "activations"), ids = new Set<string>();
      if (!this.exists(path)) return ids;
      this.directoryPin(path);
      for (const sessionId of readdirSync(path)) {
        const record = this.record(sessionId);
        if (record) { if (ids.has(record.runId)) throw new Error("Duplicate pending activation run anchor"); ids.add(record.runId); }
      }
      return ids;
    });
  }
  private syncDirectory(path: string): void {
    const pin = this.directoryPin(path), fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (!opened.isDirectory() || opened.dev !== pin.dev || opened.ino !== pin.ino) throw new Error("Pending activation sync directory changed");
      fsyncSync(fd);
      this.directoryPin(path);
    } finally { closeSync(fd); }
  }
  private createRecord(input: PendingActivationInput): RecordV3 {
    const ancestors = join(this.directory, "activations"), directory = join(ancestors, input.sessionId);
    if (!this.exists(ancestors)) { mkdirSync(ancestors, { mode: 0o700 }); this.directoryPin(ancestors); this.syncDirectory(ancestors); this.syncDirectory(this.directory); }
    else this.directoryPin(ancestors);
    // An existing directory without its record is unknown, never a fresh slot.
    if (this.exists(directory)) throw new Error("Existing activation namespace cannot be recreated");
    mkdirSync(directory, { mode: 0o700 }); this.directoryPin(directory); this.syncDirectory(directory); this.syncDirectory(ancestors);
    const record: RecordV3 = { schema: 3, storeId: this.storeId, ...JSON.parse(JSON.stringify(input)), runId: randomUUID(),
      nativeCommandId: input.source.harnessId === "opencode" ? `msg_${randomUUID().replaceAll("-", "")}` : null };
    const path = join(directory, "activation.json"), bytes = Buffer.from(JSON.stringify(record));
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(fd, bytes); fsyncSync(fd);
      // Retain the descriptor's identity AND intended bytes before closing it.
      // A later replacement must not become the first observed/pinned anchor.
      this.files.set(path, this.filePin(fd, path, bytes));
    } finally { closeSync(fd); }
    this.syncDirectory(directory);
    // The immutable anchored record is durable BEFORE the journal is reserved.
    const saved = this.record(input.sessionId);
    if (!saved || !equal(saved, record)) throw new Error("Created pending activation anchor changed");
    return saved;
  }
  private assertPreparation(record: RecordV3, events: readonly Event[]): void {
    if (events.length !== 1) throw new Error("Pending activation requires exactly one preparation event; execution history cannot be adopted");
    const event = events[0]!;
    exact(event, ["seq", "time", "runId", "sessionId", "kind", "data"]);
    if (event.seq !== 1 || event.kind !== "context" || event.runId !== record.runId || event.sessionId !== record.sessionId
      || !equal(event.data, markerOf(record))) throw new Error("Pending activation preparation does not match its anchor");
  }
  prepare(input: PendingActivationInput): PendingActivationPreparation {
    return this.operation(() => {
      assertInput(input);
      let record = this.record(input.sessionId);
      const fresh = !record;
      if (!record) {
        const directory = join(this.directory, "activations", input.sessionId);
        if (this.exists(directory)) throw new LegacyActivation("Legacy activation cannot acquire a pending preparation journal");
        record = this.createRecord(input);
      }
      if (!equal(inputOf(record), input)) throw new Error("Pending activation identity/pair/source changed");
      const captured = this.captures.get(input.sessionId);
      if (captured) { this.assertCaptured(captured, input); return captured.token; }
      const target = { runId: record.runId, sessionId: record.sessionId };
      if (fresh) {
        const reservation = this.writer.reserveNew(target, "context", markerOf(record));
        this.writer.commit(reservation);
        this.writer.flushThrough(reservation);
      }
      // Existing records MUST have an already-present complete journal, even
      // across a crash between durable anchor and journal publication.
      const baseline = this.writer.adoptExisting(target);
      this.assertPreparation(record, baseline.events);
      const token = Object.freeze({ runId: record.runId, nativeCommandId: record.nativeCommandId, activation: record.activation, events: baseline.events }) as PendingActivationPreparation;
      const capture = { record, baseline, token };
      this.captures.set(input.sessionId, capture); this.tokens.set(token, capture);
      this.assertCaptured(capture, input);
      return token;
    });
  }
  private assertCaptured(captured: Captured, input: PendingActivationInput): void {
    const current = this.record(input.sessionId);
    if (!current || !equal(current, captured.record) || !equal(inputOf(current), input)) throw new Error("Pending activation anchor changed");
    this.writer.assertCurrentBaseline(captured.baseline);
    this.assertPreparation(current, captured.baseline.events);
  }
  /** Final read-only installation guard. No queue drain, writes or native
   * dispatch authority. Parent must install events.slice(), retaining identities. */
  assertCurrent(token: PendingActivationPreparation, input: PendingActivationInput): void {
    this.operation(() => {
      assertInput(input);
      const capture = this.tokens.get(token);
      if (!capture) throw new Error("Foreign pending activation preparation");
      this.assertCaptured(capture, input);
    });
  }
}
