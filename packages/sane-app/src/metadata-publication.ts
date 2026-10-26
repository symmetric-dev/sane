import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { DispatchIdentity } from "../shared/conversation/dispatch-contract";
import { synchronousDispatchHook } from "./dispatch-evidence";
import { uuid, validateMetadata, type Metadata, type Run, type Session } from "./history";

declare const receiptBrand: unique symbol;
/** Process-private publication evidence. There are deliberately no public fields,
 * serializable credentials, or read-disk APIs that can manufacture this receipt. */
export type CommittedMetadataReceipt = Readonly<{ [receiptBrand]: true }>;

const sessionKeys = ["sessionId", "cwd", "lastRunId", "agent", "agentKind", "nativeAgentSelected", "saneExecution", "profileId", "model", "effort", "attachment", "saneContext"] as const satisfies readonly (keyof Session)[];
const runKeys = ["runId", "sessionId", "cwd", "createdAt", "agent", "agentKind", "nativeAgentSelected", "saneExecution", "profileId", "model", "effort", "nativeCommandId", "nativeDelivery", "operation", "saneContextVersion", "queuedFollowupId"] as const satisfies readonly (keyof Run)[];
type SessionPins = Pick<Session, typeof sessionKeys[number]>;
type RunPins = Pick<Run, typeof runKeys[number]> & { compact?: Pick<NonNullable<Run["compact"]>, "requestId" | "instructions"> };
type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
/** Capture from trusted live configuration, not from the metadata being proved.
 * Missing optional config is a pin too; title/status/native-phase are not config. */
export type MetadataDispatchBinding = DispatchIdentity & {
  readonly session: Immutable<SessionPins>;
  readonly run: Immutable<RunPins>;
};

export class MetadataCommitProofError extends Error {}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function project<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  // JSON's omission rules are the persisted metadata rules, including omission
  // vs false/empty/null. Parse again so caller mutations cannot alter the pins.
  return JSON.parse(JSON.stringify(Object.fromEntries(keys.map(key => [key, value[key]])))) as Pick<T, K>;
}
function source(session: Session): DispatchIdentity["source"] {
  return { harnessId: session.harness ?? "claude-code", sessionId: session.sessionId,
    authorityId: session.authorityId ?? null, nativeSessionId: session.nativeSessionId ?? null, cwd: session.cwd };
}
function correlate(session: Session, run: Run, dispatch: DispatchIdentity): void {
  if (!isDeepStrictEqual(source(session), dispatch.source) || run.runId !== dispatch.runId
    || run.sessionId !== session.sessionId || run.cwd !== session.cwd || session.lastRunId !== run.runId
    || (run.nativeCommandId ?? null) !== dispatch.nativeCommandId
    || run.compact !== undefined && run.compact.requestId !== dispatch.requestId) {
    throw new MetadataCommitProofError("Metadata dispatch source/run correlation changed");
  }
}

/** Existing session/run/context/execution pins only: NOT activation delivery,
 * native acceptance, ownership, or authorization to dispatch. */
export function captureMetadataDispatchBinding(session: Session, run: Run, dispatch: DispatchIdentity): MetadataDispatchBinding {
  correlate(session, run, dispatch);
  const runPins: RunPins = project(run, runKeys);
  // Native compaction admission/coalescing is progress, not requested config.
  // nativeCommandId above already pins the requested native input identity.
  if (run.compact !== undefined) runPins.compact = project(run.compact, ["requestId", "instructions"]);
  return freeze({ ...JSON.parse(JSON.stringify(dispatch)), session: project(session, sessionKeys), run: runPins });
}

type Pin = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
type FileSnapshot = { pin: Pin; bytes: Buffer };
type Committed = { metadata: Metadata };
const sameIdentity = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) => a.dev === b.dev && a.ino === b.ino;
const samePin = (a: Pin, b: Pin) => sameIdentity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const unsafe = (message: string): never => { throw new Error(`Metadata publication: ${message}`); };
function decode(bytes: Buffer): Metadata {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  if (value?.version !== 1) unsafe("unsupported metadata version");
  return validateMetadata(value);
}

/** Sole physical metadata writer after construction, including recovery writes.
 * Invoke commitSerialized INSIDE the bridge's existing global write queue with
 * an enqueue-time captured string. This class owns no queue, drain, or retries.
 * A new receipt is returned only after file AND directory fsync have succeeded.
 * Even identical bytes are a real publication with a distinct receipt/inode.
 * Uncertain failures leave the exact new temp (if any) for operator inspection;
 * no rollback, broad deletion, adoption of external writes, or repair is done. */
export class MetadataPublisher {
  readonly #directory: string;
  readonly #deps: { assertStorage: () => void; failClosed: (error: unknown) => void };
  #root!: { dev: number; ino: number };
  #manifest!: FileSnapshot;
  #current!: FileSnapshot;
  readonly #receipts = new WeakMap<CommittedMetadataReceipt, Committed>();
  #latest: Committed | undefined;
  #failed = false;
  #busy = false;

  constructor(directory: string, storeId: string, deps: { assertStorage: () => void; failClosed: (error: unknown) => void }) {
    this.#directory = directory;
    this.#deps = { assertStorage: deps.assertStorage, failClosed: deps.failClosed };
    this.#busy = true;
    try {
      this.#ownership();
      const root = lstatSync(directory);
      if (!root.isDirectory() || root.isSymbolicLink() || realpathSync(directory) !== directory) unsafe("unsafe canonical root");
      this.#root = { dev: root.dev, ino: root.ino };
      this.#manifest = this.#read("manifest.json");
      const manifest = JSON.parse(this.#manifest.bytes.toString("utf8"));
      if (!manifest || Object.keys(manifest).sort().join(",") !== "createdAt,format,storeId,version"
        || manifest.format !== "sane-app-store" || manifest.version !== 1 || !uuid(storeId) || manifest.storeId !== storeId
        || typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt))) unsafe("invalid pinned manifest/storeId");
      this.#current = this.#read("metadata.json");
      decode(this.#current.bytes);
      this.#guard();
    } catch (error) { this.#fatal(error); }
    finally { this.#busy = false; }
  }

  #ownership(): void {
    if (this.#failed) unsafe("failed; operator reconciliation required");
    synchronousDispatchHook(() => this.#deps.assertStorage());
    if (this.#failed) unsafe("failed; operator reconciliation required");
  }
  #checkRoot(): void {
    const root = lstatSync(this.#directory);
    if (!root.isDirectory() || root.isSymbolicLink() || realpathSync(this.#directory) !== this.#directory || !sameIdentity(root, this.#root)) unsafe("canonical root changed");
  }
  #pin(fd: number, path: string): Pin {
    const opened = fstatSync(fd), current = lstatSync(path);
    if (!opened.isFile() || opened.nlink !== 1 || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1
      || realpathSync(path) !== path || !samePin(opened, current)) unsafe("file changed or unsafe");
    return { dev: opened.dev, ino: opened.ino, size: opened.size, mtimeMs: opened.mtimeMs, ctimeMs: opened.ctimeMs };
  }
  #read(name: string): FileSnapshot {
    const path = join(this.#directory, name), fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const pin = this.#pin(fd, path), bytes = readFileSync(fd);
      if (bytes.length !== pin.size || !samePin(pin, this.#pin(fd, path))) unsafe("file changed while reading");
      return { pin, bytes };
    } finally { closeSync(fd); }
  }
  #verify(name: string, expected: FileSnapshot): void {
    const current = this.#read(name);
    if (!samePin(current.pin, expected.pin) || !current.bytes.equals(expected.bytes)) unsafe(`${name} changed outside publisher`);
  }
  #guard(): void {
    this.#ownership(); this.#checkRoot();
    this.#verify("manifest.json", this.#manifest);
    this.#verify("metadata.json", this.#current);
    this.#checkRoot();
  }
  #fatal(error: unknown): never {
    if (!this.#failed) {
      this.#failed = true;
      try { synchronousDispatchHook(() => this.#deps.failClosed(error)); } catch { /* Preserve the original physical failure. */ }
    }
    throw error;
  }
  #operation<T>(action: () => T): T {
    if (this.#failed) unsafe("failed; operator reconciliation required");
    if (this.#busy) return this.#fatal(new Error("Reentrant metadata publication operation"));
    this.#busy = true;
    try {
      this.#guard();
      const value = action();
      this.#guard();
      return value;
    } catch (error) { return this.#fatal(error); }
    finally { this.#busy = false; }
  }

  commitSerialized(snapshot: string): CommittedMetadataReceipt {
    return this.#operation(() => {
      if (typeof snapshot !== "string") unsafe("snapshot must be an enqueue-time captured string");
      const bytes = Buffer.from(snapshot, "utf8"), metadata = freeze(decode(bytes));
      // Refuse strings whose UTF-8 encoding would silently replace lone surrogates.
      if (bytes.toString("utf8") !== snapshot) unsafe("snapshot is not exact UTF-8");
      const name = `.metadata.json.${randomUUID()}.tmp`, path = join(this.#directory, name);
      const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      let temporary: Pin;
      try {
        temporary = this.#pin(fd, path);
        writeFileSync(fd, bytes); fsyncSync(fd);
        const after = this.#pin(fd, path);
        if (!sameIdentity(temporary, after) || after.size !== bytes.length) unsafe("temporary file changed");
        temporary = after;
      } finally { closeSync(fd); }
      this.#guard();
      this.#verify(name, { pin: temporary, bytes });
      renameSync(path, join(this.#directory, "metadata.json"));
      const published = this.#read("metadata.json");
      // Rename may change ctime. Its inode and exact bytes must still be ours.
      if (!sameIdentity(temporary, published.pin) || !published.bytes.equals(bytes)) unsafe("renamed metadata changed");
      this.#current = published;
      this.#guard();
      const dir = openSync(this.#directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(dir);
        if (!opened.isDirectory() || !sameIdentity(opened, this.#root)) unsafe("directory fsync root changed");
        fsyncSync(dir);
      } finally { closeSync(dir); }
      this.#guard();
      const committed = { metadata }, receipt = Object.freeze({}) as CommittedMetadataReceipt;
      this.#receipts.set(receipt, committed); this.#latest = committed;
      return receipt;
    });
  }

  /** Checks physical ownership even for bad proof. Semantic refusal is NOT a
   * storage failure: no receipt, a copied/foreign receipt, or changed config must
   * withhold this boundary without poisoning otherwise healthy storage. Old real
   * receipts remain valid only while BOTH their snapshot and the latest actual
   * publication still contain the exact expected pins. No queued work is flushed. */
  assertCommitted(receipt: CommittedMetadataReceipt, expected: MetadataDispatchBinding): void {
    const [committed, latest] = this.#operation(() => [this.#receipts.get(receipt), this.#latest] as const);
    if (!committed || !latest) throw new MetadataCommitProofError("No original committed metadata receipt (publication may still be queued)");
    for (const value of [committed, latest]) {
      const session = value.metadata.sessions.find(s => s.sessionId === expected.source.sessionId);
      const run = value.metadata.runs.find(r => r.runId === expected.runId);
      if (!session || !run) throw new MetadataCommitProofError("Committed metadata source/run is missing");
      const actual = captureMetadataDispatchBinding(session, run, expected);
      if (!isDeepStrictEqual(actual, expected)) throw new MetadataCommitProofError("Committed metadata dispatch configuration changed");
    }
  }
}
