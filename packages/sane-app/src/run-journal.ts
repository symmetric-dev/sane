import { createHash, type Hash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, realpathSync, writeSync } from "node:fs";
import { join } from "node:path";
import { decodeLog, uuid, type Event, type Run } from "./history";
import { synchronousDispatchHook } from "./dispatch-evidence";

/** A process-private reservation in the existing App run log, not a dispatch,
 * activation, ownership or restart-coverage claim. Copying its fields grants no
 * capability. Serialized bytes are captured once, before queued work can run. */
export type RunJournalReservation = Readonly<{ event: Event }>;
type Pin = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
type Entry = { reservation: RunJournalReservation; state: State; bytes?: Buffer; published: boolean; queueConsumed: boolean; committed?: (event: Event) => void };
type State = { runId: string; sessionId: string; path: string; pin: Pin | null; hash: Hash;
  reserved: number; appended: number; durable: number; queued: number; pending: Entry[] };
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

/** One live/startup append implementation for a bridge-owned data directory.
 * Scheduling remains in the bridge's existing serial queue; actual writes are
 * synchronous, so a native-boundary fence can drain unwritten predecessors
 * without racing an in-flight async append. Normal commits do NOT fsync every
 * stdout record. A fence fsyncs the file and directory through the appended tail.
 *
 * This does not flush metadata or authorize native execution. Callers retain
 * admission/owner gates and must independently establish metadata durability.
 * Original-recovery journals are explicitly excluded, never silently adopted.
 * Any partial/uncertain write permanently fails this writer; there is no repair,
 * replay, truncate, retry-from-zero, or writer takeover API. */
export class RunJournalWriter {
  private readonly root: { dev: number; ino: number };
  private readonly states = new Map<string, State>();
  private readonly excluded = new Set<string>();
  private readonly entries = new WeakMap<RunJournalReservation, Entry>();
  private readonly byEvent = new WeakMap<Event, RunJournalReservation>();
  private failed = false;
  private busy = false;
  private publishing = false;

  constructor(private readonly directory: string, private readonly deps: {
    assertStorage: () => void;
    failClosed: (error: unknown) => void;
  }) {
    const root = lstatSync(directory);
    if (!root.isDirectory() || root.isSymbolicLink() || realpathSync(directory) !== directory) throw new Error("Unsafe run journal directory");
    this.root = { dev: root.dev, ino: root.ino };
  }

  private guard(): void {
    if (this.failed) throw new Error("Run journal failed; operator reconciliation required");
    synchronousDispatchHook(() => this.deps.assertStorage());
    const root = lstatSync(this.directory);
    if (!root.isDirectory() || root.isSymbolicLink() || realpathSync(this.directory) !== this.directory || root.dev !== this.root.dev || root.ino !== this.root.ino) throw new Error("Run journal directory changed");
  }
  private fatal(error: unknown): never {
    this.failed = true;
    try { synchronousDispatchHook(() => this.deps.failClosed(error)); } finally { throw error; }
  }
  private operation<T>(action: () => T): T {
    // Optional publication reentry is refused without poisoning core storage.
    // Reentry from a mandatory guard/I/O propagates to its outer operation.
    if (this.busy || this.publishing) throw new Error("Reentrant run journal operation");
    this.busy = true;
    try {
      this.guard();
      const result = action();
      this.guard();
      return result;
    } catch (error) { return this.fatal(error); }
    finally { this.busy = false; }
  }
  private pin(fd: number, path: string): Pin {
    const opened = fstatSync(fd), current = lstatSync(path);
    if (!opened.isFile() || opened.nlink !== 1 || current.isSymbolicLink() || current.nlink !== 1 || realpathSync(path) !== path
      || current.dev !== opened.dev || current.ino !== opened.ino || current.size !== opened.size) throw new Error("Run journal file changed or is unsafe");
    return { dev: opened.dev, ino: opened.ino, size: opened.size, mtimeMs: opened.mtimeMs, ctimeMs: opened.ctimeMs };
  }
  private samePin(a: Pin, b: Pin): boolean {
    return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  }
  private capture(run: Run, previous: readonly Event[]): State {
    if (!uuid(run.runId) || !uuid(run.sessionId) || this.excluded.has(run.runId)) throw new Error("Run journal namespace unavailable");
    const state: State = { runId: run.runId, sessionId: run.sessionId, path: join(this.directory, `${run.runId}.jsonl`), pin: null,
      hash: createHash("sha256"), reserved: previous.at(-1)?.seq ?? 0, appended: previous.at(-1)?.seq ?? 0, durable: 0, queued: 0, pending: [] };
    let exists = true;
    try { lstatSync(state.path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; exists = false; }
    if (exists) {
      const fd = openSync(state.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = this.pin(fd, state.path), bytes = readFileSync(fd);
        const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        const decoded = raw ? decodeLog(raw, run) : { events: [] as Event[] };
        if (decoded.repaired !== undefined || JSON.stringify(decoded.events) !== JSON.stringify(previous)
          || !this.samePin(before, this.pin(fd, state.path))) throw new Error("Run journal baseline is missing, changed or incomplete");
        state.pin = before; state.hash.update(bytes);
      } finally { closeSync(fd); }
    } else if (previous.length) throw new Error("Run journal with historical events is missing");
    this.states.set(run.runId, state);
    return state;
  }

  reserve(run: Run, previous: readonly Event[], kind: Event["kind"], data: unknown, committed?: (event: Event) => void): RunJournalReservation {
    return this.operation(() => {
      if (this.excluded.has(run.runId)) throw new Error("Original-recovery journal cannot borrow live append authority");
      const state = this.states.get(run.runId) ?? this.capture(run, previous);
      if (run.sessionId !== state.sessionId || (previous.at(-1)?.seq ?? 0) !== state.reserved) throw new Error("Run journal reservation source/sequence changed");
      const event = JSON.parse(JSON.stringify({ seq: state.reserved + 1, time: new Date().toISOString(), runId: state.runId, sessionId: state.sessionId, kind, data })) as Event;
      // Reuse the real envelope validator, including special message validation.
      decodeLog(JSON.stringify(event) + "\n", run);
      if (!Number.isSafeInteger(event.seq)) throw new Error("Run journal sequence exhausted");
      const reservation = Object.freeze({ event: freeze(event) });
      const entry: Entry = { reservation, state, bytes: Buffer.from(JSON.stringify(event) + "\n"), published: false, queueConsumed: false, committed };
      state.reserved = event.seq; state.pending.push(entry); state.queued++;
      this.entries.set(reservation, entry); this.byEvent.set(event, reservation);
      return reservation;
    });
  }

  /** Only actual live reservations, never copied/decoded historical events. */
  reservation(event: Event): RunJournalReservation {
    return this.operation(() => {
      const reservation = this.byEvent.get(event);
      if (!reservation) throw new Error("Event has no original run journal reservation");
      return reservation;
    });
  }

  private drain(reservation: RunJournalReservation, durable: boolean): void {
    const published: Entry[] = [];
    this.operation(() => {
      const entry = this.entries.get(reservation);
      if (!entry || this.states.get(entry.state.runId) !== entry.state || this.excluded.has(entry.state.runId)) throw new Error("Foreign or relinquished run journal reservation");
      const state = entry.state;
      if (!durable && !entry.queueConsumed) { entry.queueConsumed = true; state.queued--; }
      const fd = openSync(state.path, state.pin ? constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW
        : constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        const before = this.pin(fd, state.path);
        if (state.pin ? !this.samePin(state.pin, before) : before.size !== 0) throw new Error("Run journal append pin changed");
        state.pin = before;
        while (state.pending.length && state.pending[0]!.reservation.event.seq <= reservation.event.seq) {
          const next = state.pending[0]!, bytes = next.bytes!;
          if (next.reservation.event.seq !== state.appended + 1) throw new Error("Run journal append sequence changed");
          let offset = 0;
          while (offset < bytes.length) {
            const written = writeSync(fd, bytes, offset, bytes.length - offset);
            if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.length - offset) throw new Error("Uncertain partial run journal append");
            offset += written;
          }
          const after = this.pin(fd, state.path);
          if (after.dev !== state.pin.dev || after.ino !== state.pin.ino || after.size !== state.pin.size + bytes.length) throw new Error("Run journal append length changed");
          state.pin = after; state.hash.update(bytes); state.appended = next.reservation.event.seq;
          state.pending.shift(); next.bytes = undefined; published.push(next);
        }
        if (durable) {
          // O_APPEND moves the descriptor offset. Read the protected prefix with
          // explicit positions, not readFileSync(fd) from that current offset.
          const actual = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
          let position = 0;
          while (position < state.pin.size) {
            const count = readSync(fd, buffer, 0, Math.min(buffer.length, state.pin.size - position), position);
            if (count <= 0) throw new Error("Run journal prefix ended before durable fence");
            actual.update(buffer.subarray(0, count)); position += count;
          }
          if (actual.digest("hex") !== state.hash.copy().digest("hex")) throw new Error("Run journal bytes changed before durable fence");
          fsyncSync(fd);
          const directory = openSync(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const opened = fstatSync(directory);
            if (!opened.isDirectory() || opened.dev !== this.root.dev || opened.ino !== this.root.ino) throw new Error("Run journal directory sync pin changed");
            fsyncSync(directory);
          } finally { closeSync(directory); }
          if (!this.samePin(state.pin, this.pin(fd, state.path))) throw new Error("Run journal changed during durable fence");
          state.durable = state.appended;
        }
      } finally { closeSync(fd); }
    });
    // Optional projections cannot run inside I/O or reenter a writer mid-publish.
    // These callbacks are append notifications, not independent durability proof.
    this.publishing = true;
    try { for (const entry of published) if (!entry.published) {
      entry.published = true;
      try { entry.committed?.(entry.reservation.event); } catch { /* optional projection */ }
      entry.committed = undefined;
    } } finally { this.publishing = false; }
  }

  commit(reservation: RunJournalReservation): void { this.drain(reservation, false); }
  flushThrough(reservation: RunJournalReservation): void { this.drain(reservation, true); }
  /** Process-local watermarks only; not persisted completeness, metadata
   * durability, activation delivery, or native acceptance evidence. */
  progress(reservation: RunJournalReservation): Readonly<{ reserved: number; appended: number; durable: number }> {
    return this.operation(() => {
      const entry = this.entries.get(reservation);
      if (!entry || this.states.get(entry.state.runId) !== entry.state) throw new Error("Foreign or relinquished run journal reservation");
      const { reserved, appended, durable } = entry.state;
      return Object.freeze({ reserved, appended, durable });
    });
  }
  /** Non-fatal background-recorder eligibility only. This is not an ownership
   * or append capability; reserve/commit still perform all mandatory guards. */
  canAppend(runId: string): boolean { return !this.failed && !this.excluded.has(runId); }

  assertUnclaimed(runId: string): void {
    this.operation(() => { if (this.states.has(runId) || this.excluded.has(runId)) throw new Error("Reserved/original run journal cannot be repaired or replaced"); });
  }
  /** Startup-only transfer to the existing original-recovery authority. Callers
   * must independently prove no live owner/admission and capture original pins.
   * No pending reservations may be abandoned; old tokens become unusable. */
  excludeOriginal(runId: string): void {
    this.operation(() => {
      if (!uuid(runId)) throw new Error("Invalid original run journal namespace");
      const state = this.states.get(runId);
      if (state && (state.pending.length || state.queued)) throw new Error("Cannot transfer a run journal with pending writes/queued callbacks");
      this.states.delete(runId); this.excluded.add(runId);
    });
  }
  assertOriginal(runId: string): void {
    this.operation(() => { if (!this.excluded.has(runId) || this.states.has(runId)) throw new Error("Original journal lacks exclusive recovery authority"); });
  }
}
