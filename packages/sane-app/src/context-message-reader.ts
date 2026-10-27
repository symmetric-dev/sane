import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { synchronousDispatchHook } from "./dispatch-evidence";
import { decodeLog, uuid, type Event, type Run } from "./history";

export type ContextMessageHistoryErrorCode = "context-activation-unproven" | "context-retention-unproven" | "context-source-unavailable";

/** Scoped absence of protected history, never a storage-owner failure or native permission. */
export class ContextMessageHistoryError extends Error {
  constructor(readonly code: ContextMessageHistoryErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ContextMessageHistoryError";
  }
}

type RootPin = { dev: bigint; ino: bigint };
type FilePin = RootPin & { size: bigint; mtimeNs: bigint; ctimeNs: bigint };
type Capture = { pin: FilePin; bytes: Buffer; hash: string };
type KnownRun = { sessionId: string; pin: FilePin; hash: string };
export type ContextMessageHistorySnapshot = Readonly<{ events: readonly Event[]; source: string; assertCurrent(): void }>;
const maximumBytes = 16 * 1024 * 1024;
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const sameRoot = (a: RootPin, b: RootPin): boolean => a.dev === b.dev && a.ino === b.ino;
const samePin = (a: FilePin, b: FilePin): boolean => sameRoot(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
function freezeEvents(events: Event[]): readonly Event[] {
  // Iterative freezing also handles deeply nested, otherwise-valid JSON without
  // recursively exhausting the stack. These decoded values have no live brands.
  const pending: object[] = [events];
  while (pending.length) {
    const value = pending.pop()!;
    for (const child of Object.values(value)) if (child && typeof child === "object") pending.push(child);
    Object.freeze(value);
  }
  return events;
}

/** Nonrepairing, existing-file-only history reader. No writer, queue, activation
 * ledger, file creation, durability flush, or live-observation capability lives
 * here. A snapshot protects the WHOLE observed file, not a moving tail; after an
 * await its owner must call assertCurrent before relying on that history.
 * Fresh reads may observe append-only growth. Only small identity/hash pins are
 * retained per run, not old buffers or decoded event trees. */
export class ContextMessageJournalReader {
  private readonly root: RootPin;
  private readonly manifest: { pin: FilePin; hash: string };
  private readonly known = new Map<string, KnownRun>();
  private busy = true;

  constructor(private readonly directory: string, private readonly storeId: string,
    private readonly deps: { assertStorage: () => void }) {
    try {
      synchronousDispatchHook(() => deps.assertStorage());
      this.root = this.rootPin();
      if (!uuid(storeId)) throw new Error("Invalid context history store identity");
      const manifest = this.captureFile(join(directory, "manifest.json"), 64 * 1024);
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(manifest.bytes));
      if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).length !== 4 || !["format", "version", "storeId", "createdAt"].every(key => Object.hasOwn(value, key))
        || (value as { format?: unknown }).format !== "sane-app-store" || (value as { version?: unknown }).version !== 1
        || (value as { storeId?: unknown }).storeId !== storeId || typeof (value as { createdAt?: unknown }).createdAt !== "string"
        || !Number.isFinite(Date.parse((value as { createdAt: string }).createdAt))) throw new Error("Context history manifest mismatch");
      this.manifest = { pin: manifest.pin, hash: manifest.hash };
      this.guard();
    } catch (error) {
      throw this.error(error, "context-source-unavailable");
    } finally { this.busy = false; }
  }

  private error(error: unknown, code: ContextMessageHistoryErrorCode): ContextMessageHistoryError {
    return error instanceof ContextMessageHistoryError ? error : new ContextMessageHistoryError(code, "Protected context history is unavailable or changed", error);
  }
  private rootPin(): RootPin {
    const stat = lstatSync(this.directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(this.directory) !== this.directory) throw new Error("Unsafe context history directory");
    return { dev: stat.dev, ino: stat.ino };
  }
  private assertRoot(): void {
    if (!sameRoot(this.root, this.rootPin())) throw new Error("Context history root changed");
  }
  private filePin(fd: number, path: string, limit: number): FilePin {
    const opened = fstatSync(fd, { bigint: true }), current = lstatSync(path, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1n
      || realpathSync(path) !== path || !samePin(opened, current) || opened.size < 0n || opened.size > BigInt(limit)) throw new Error("Unsafe or oversized context history file");
    return { dev: opened.dev, ino: opened.ino, size: opened.size, mtimeNs: opened.mtimeNs, ctimeNs: opened.ctimeNs };
  }
  private captureFile(path: string, limit: number): Capture {
    this.assertRoot();
    // NONBLOCK prevents a substituted FIFO from hanging before fstat can reject
    // it. Explicit bounded reads never follow a growing stream to an unknown EOF.
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const pin = this.filePin(fd, path, limit), bytes = Buffer.alloc(Number(pin.size));
      let position = 0;
      while (position < bytes.length) {
        const count = readSync(fd, bytes, position, Math.min(64 * 1024, bytes.length - position), position);
        if (count <= 0) throw new Error("Context history ended while reading");
        position += count;
      }
      if (!samePin(pin, this.filePin(fd, path, limit))) throw new Error("Context history changed while reading");
      this.assertRoot();
      return { pin, bytes, hash: sha256(bytes) };
    } finally { closeSync(fd); }
  }
  private assertRootManifest(): void {
    const manifest = this.captureFile(join(this.directory, "manifest.json"), 64 * 1024);
    if (!samePin(this.manifest.pin, manifest.pin) || this.manifest.hash !== manifest.hash) throw new Error("Context history manifest changed");
  }
  private guard(): void {
    synchronousDispatchHook(() => this.deps.assertStorage());
    this.assertRootManifest();
  }
  private capture(path: string): Capture {
    this.assertRootManifest();
    const capture = this.captureFile(path, maximumBytes);
    this.assertRootManifest();
    return capture;
  }
  private operation<T>(action: () => { result: T; verify: () => void }): T {
    if (this.busy) throw new ContextMessageHistoryError("context-source-unavailable", "Reentrant context history read refused");
    this.busy = true;
    try {
      this.guard();
      const { result, verify } = action();
      this.guard();
      // Mandatory callbacks can mutate a source. Verify it again AFTER the last
      // callback, with root/manifest checks on both sides of the actual read.
      verify();
      return result;
    } catch (error) { throw this.error(error, "context-source-unavailable"); }
    finally { this.busy = false; }
  }
  private assertCapture(path: string, expected: { pin: FilePin; hash: string }): void {
    const current = this.capture(path);
    if (!samePin(current.pin, expected.pin) || current.hash !== expected.hash) throw new ContextMessageHistoryError("context-retention-unproven", "Protected context history snapshot changed");
  }

  read(target: Pick<Run, "runId" | "sessionId">): ContextMessageHistorySnapshot {
    // Copy identity before mandatory callbacks or returned closures can observe
    // the caller mutating its Run object.
    const { runId, sessionId } = target;
    return this.operation(() => {
      if (!uuid(runId) || !uuid(sessionId)) throw new Error("Invalid context history target");
      const path = join(this.directory, `${runId}.jsonl`), captured = this.capture(path), previous = this.known.get(runId);
      if (previous && (previous.sessionId !== sessionId || !sameRoot(previous.pin, captured.pin)
        || captured.pin.size < previous.pin.size || sha256(captured.bytes.subarray(0, Number(previous.pin.size))) !== previous.hash
        || captured.pin.size === previous.pin.size && !samePin(previous.pin, captured.pin))) {
        throw new ContextMessageHistoryError("context-retention-unproven", "Previously protected context history was replaced or rewritten");
      }
      let events: readonly Event[];
      try {
        const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(captured.bytes);
        if (!raw || !raw.endsWith("\n")) throw new Error("Context history must be nonempty and newline terminated");
        const decoded = decodeLog(raw, { runId, sessionId });
        if (!decoded.events.length || decoded.repaired !== undefined) throw new Error("Context history requires repair");
        events = freezeEvents(decoded.events);
      } catch (error) { throw this.error(error, "context-activation-unproven"); }
      // Closures retain only exact pins/hashes, never the captured byte buffer.
      const expected = { pin: captured.pin, hash: captured.hash };
      const result = Object.freeze({ events,
        source: `sane-app-store:${this.storeId}:run:${runId}:session:${sessionId}:sha256:${captured.hash}`,
        assertCurrent: (): void => this.operation(() => {
          this.assertCapture(path, expected);
          return { result: undefined, verify: () => this.assertCapture(path, expected) };
        }),
      });
      return { result, verify: () => {
        this.assertCapture(path, expected);
        this.known.set(runId, { sessionId, ...expected });
      } };
    });
  }
}
