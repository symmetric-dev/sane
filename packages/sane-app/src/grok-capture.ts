import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, type BigIntStats } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * Non-receipt Grok capture journal.
 *
 * One file per App session id, `grok-capture.<appSessionId>.json`, in the
 * caller-supplied directory. Not an admission, not a metadata run, not a public
 * receipt, and not native acceptance. `msg_0`, `result.subtype === "success"`,
 * process exit 0, and the session UUID stay non-acceptance even when those
 * strings appear in stdout. This module does not spawn, retry, or allocate a
 * native session id, and it does not import the bridge or the receipt codec.
 *
 * File version is the capture file, `{ version: 1, turns: [...], execution? }`. An unknown
 * version refuses. That is not a receipt bump and not metadata v2. A missing
 * session file is an empty version-1 journal. A persist that would drop or
 * change a stored turn refuses and leaves that file's bytes alone. A caller
 * owns one writer per session. Stat drift checks are not a concurrency lock.
 */
export const GROK_CAPTURE_VERSION = 1 as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUTHORITY = /^sane-native-v1:gk:[a-f0-9]{64}$/;
const TURN_KEYS = [
  "appSessionId", "nativeSessionId", "authorityId", "cwd", "model", "effort", "turnIndex", "prompt",
  "submission", "nativeAcceptance", "acceptedMessageId", "stdout", "stderr", "exitCode", "nativeCancellation",
] as const;
const JOURNAL_KEYS = ["version", "turns"] as const;
const EXECUTION_KEYS = ["appSessionId", "nativeSessionId", "authorityId", "turnIndex", "disposition"] as const;

export class GrokCaptureRefusal extends Error {
  readonly name = "GrokCaptureRefusal";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export type GrokCaptureSubmission = "submitted" | "not-submitted";
export type GrokCaptureCancellation = "not-requested" | "unproven";

/** Sealed non-acceptance. `acceptedMessageId` cannot hold a message id. */
export type GrokCaptureTurn = {
  readonly appSessionId: string;
  readonly nativeSessionId: string;
  readonly authorityId: string;
  readonly cwd: string;
  readonly model: string;
  readonly effort: string;
  readonly turnIndex: number;
  /** App UI identity only; neither field is native acceptance evidence. */
  readonly runId?: string;
  readonly createdAt?: string;
  readonly profileId?: string;
  readonly contextRevision?: string;
  readonly prompt: string;
  readonly submission: GrokCaptureSubmission;
  readonly nativeAcceptance: "unknown";
  readonly acceptedMessageId: null;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly exitSignal?: string | null;
  readonly nativeCancellation: GrokCaptureCancellation;
};

export type GrokCaptureTurnInput = {
  appSessionId: string;
  nativeSessionId: string;
  authorityId: string;
  cwd: string;
  model: string;
  effort: string;
  turnIndex: number;
  runId?: string;
  createdAt?: string;
  profileId?: string;
  contextRevision?: string;
  prompt: string;
  submission: GrokCaptureSubmission;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  exitSignal?: string | null;
  nativeCancellation: GrokCaptureCancellation;
  nativeAcceptance?: "unknown";
  acceptedMessageId?: null;
};

export type GrokCaptureExecution = {
  readonly appSessionId: string;
  readonly nativeSessionId: string;
  readonly authorityId: string;
  /** Idle points at the next turn; pending/blocked points at the attempted turn. */
  readonly turnIndex: number;
  readonly disposition: "idle" | "pending" | "blocked";
};

export type GrokCaptureJournal = {
  readonly version: typeof GROK_CAPTURE_VERSION;
  readonly turns: GrokCaptureTurn[];
  readonly execution?: GrokCaptureExecution;
};

type Identity = Pick<GrokCaptureExecution, "appSessionId" | "nativeSessionId" | "authorityId">;
type JournalState = {
  turns: Map<number, GrokCaptureTurn>;
  identity?: Identity;
  execution?: GrokCaptureExecution;
  file?: { path: string; stamp: BigIntStats | null };
};
// Per-object provenance, not a cross-session cache or a competing writer lock.
const journals = new WeakMap<GrokCaptureJournal, JournalState>();
let temporarySerial = 0;

function refuse(message: string): never {
  throw new GrokCaptureRefusal(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse(`Grok capture ${label} is not a record`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const present = Object.keys(value);
  if (present.length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) refuse(`Grok capture ${label} has unexpected fields`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") refuse(`Grok capture ${label} is not text`);
  return value;
}

function explicit(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") refuse(`Grok capture ${label} is empty`);
  return value;
}

function sessionUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) refuse(`Grok capture ${label} is not a UUID`);
  return value;
}

function authorityId(value: unknown): string {
  if (typeof value !== "string" || !AUTHORITY.test(value)) refuse("Grok capture authority is not a resolved sane-native-v1:gk identity");
  return value;
}

function absoluteCwd(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) refuse("Grok capture cwd is not absolute");
  return value;
}

function turnIndex(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) refuse("Grok capture turn index is not a zero-based integer");
  return value;
}

function submission(value: unknown): GrokCaptureSubmission {
  if (value !== "submitted" && value !== "not-submitted") refuse("Grok capture submission is not submitted or not-submitted");
  return value;
}

function cancellation(value: unknown): GrokCaptureCancellation {
  if (value !== "not-requested" && value !== "unproven") refuse("Grok capture native cancellation is not not-requested or unproven");
  return value;
}

function exitCode(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) refuse("Grok capture exit code is not an integer or null");
  return value;
}

/** Always the literals. Stdout, exit 0, and session ids are not consulted. */
function sealNonAcceptance(): { nativeAcceptance: "unknown"; acceptedMessageId: null } {
  return { nativeAcceptance: "unknown", acceptedMessageId: null };
}

function readTurn(value: unknown, stored: boolean): GrokCaptureTurn {
  const item = record(value, "turn");
  const optional = ["exitSignal", "runId", "createdAt", "profileId", "contextRevision"].filter(key => Object.hasOwn(item, key));
  const keys = [...TURN_KEYS, ...optional];
  if (stored) exactKeys(item, keys, "turn");
  else {
    for (const key of Object.keys(item)) if (!optional.includes(key) && !TURN_KEYS.includes(key as typeof TURN_KEYS[number])) refuse("Grok capture turn has an unexpected field");
  }
  if (Object.hasOwn(item, "runId") && (typeof item.runId !== "string" || !UUID.test(item.runId))) refuse("Grok capture App run id is invalid");
  if (Object.hasOwn(item, "createdAt") && (typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt)))) refuse("Grok capture creation time is invalid");
  if (Object.hasOwn(item, "profileId")) explicit(item.profileId, "profile id");
  if (Object.hasOwn(item, "contextRevision") && (typeof item.contextRevision !== "string" || !/^[a-f0-9]{64}$/.test(item.contextRevision))) refuse("Grok capture context revision is invalid");
  if (Object.hasOwn(item, "exitSignal") && item.exitSignal !== null && (typeof item.exitSignal !== "string" || !/^SIG[A-Z0-9]+$/.test(item.exitSignal))) refuse("Grok capture exit signal is invalid");
  const claimedAcceptance = stored || Object.hasOwn(item, "nativeAcceptance");
  if (claimedAcceptance && item.nativeAcceptance !== "unknown") refuse("Grok capture native acceptance is not unknown");
  const claimedMessageId = stored || Object.hasOwn(item, "acceptedMessageId");
  if (claimedMessageId && item.acceptedMessageId !== null) refuse("Grok capture accepted message id is not null");
  const sealed = sealNonAcceptance();
  return Object.freeze({
    appSessionId: sessionUuid(item.appSessionId, "App session id"),
    nativeSessionId: sessionUuid(item.nativeSessionId, "native session id"),
    authorityId: authorityId(item.authorityId),
    cwd: absoluteCwd(item.cwd),
    model: explicit(item.model, "model"),
    effort: explicit(item.effort, "effort"),
    turnIndex: turnIndex(item.turnIndex),
    ...(Object.hasOwn(item, "runId") ? { runId: item.runId as string } : {}),
    ...(Object.hasOwn(item, "createdAt") ? { createdAt: item.createdAt as string } : {}),
    ...(Object.hasOwn(item, "profileId") ? { profileId: item.profileId as string } : {}),
    ...(Object.hasOwn(item, "contextRevision") ? { contextRevision: item.contextRevision as string } : {}),
    prompt: text(item.prompt, "prompt"),
    submission: submission(item.submission),
    nativeAcceptance: sealed.nativeAcceptance,
    acceptedMessageId: sealed.acceptedMessageId,
    stdout: text(item.stdout, "stdout"),
    stderr: text(item.stderr, "stderr"),
    exitCode: exitCode(item.exitCode),
    ...(Object.hasOwn(item, "exitSignal") ? { exitSignal: item.exitSignal as string | null } : {}),
    nativeCancellation: cancellation(item.nativeCancellation),
  });
}

function assertIdentity(existing: Identity | undefined, next: Identity): void {
  if (existing && (existing.appSessionId !== next.appSessionId || existing.nativeSessionId !== next.nativeSessionId || existing.authorityId !== next.authorityId)) refuse("Grok capture refuses to rebind the App session, native session, or source authority");
}

function readExecution(value: unknown): GrokCaptureExecution {
  const item = record(value, "execution");
  exactKeys(item, EXECUTION_KEYS, "execution");
  if (item.disposition !== "idle" && item.disposition !== "pending" && item.disposition !== "blocked") refuse("Grok capture execution disposition is invalid");
  return Object.freeze({
    appSessionId: sessionUuid(item.appSessionId, "App session id"),
    nativeSessionId: sessionUuid(item.nativeSessionId, "native session id"),
    authorityId: authorityId(item.authorityId), turnIndex: turnIndex(item.turnIndex), disposition: item.disposition,
  });
}

function assertExecution(execution: GrokCaptureExecution | undefined, length: number, identity?: Identity): void {
  if (!execution) return;
  assertIdentity(identity, execution);
  if (execution.turnIndex !== length && !(execution.disposition !== "idle" && length > 0 && execution.turnIndex === length - 1)) refuse("Grok capture execution does not align with captured turns");
}

function managedJournal(turns: GrokCaptureTurn[], execution?: GrokCaptureExecution): GrokCaptureJournal {
  const journal: GrokCaptureJournal = { version: GROK_CAPTURE_VERSION, turns, ...(execution ? { execution } : {}) };
  const identity = execution ?? turns[0];
  journals.set(journal, { turns: new Map(turns.map(turn => [turn.turnIndex, turn])), identity, execution });
  return journal;
}

function decodeJournal(value: unknown): GrokCaptureJournal {
  const item = record(value, "journal");
  if (item.version !== GROK_CAPTURE_VERSION) refuse("Unsupported Grok capture file version");
  exactKeys(item, Object.hasOwn(item, "execution") ? [...JOURNAL_KEYS, "execution"] : JOURNAL_KEYS, "journal");
  if (!Array.isArray(item.turns)) refuse("Grok capture turns are missing");
  const turns: GrokCaptureTurn[] = [];
  for (const turn of item.turns) {
    const decoded = readTurn(turn, true);
    assertIdentity(turns[0], decoded);
    if (decoded.turnIndex !== turns.length) refuse("Grok capture turn indexes must be contiguous and zero-based");
    turns.push(decoded);
  }
  // Old captures remain evidence. Their identity comes from the first turn,
  // without inventing historical execution states or native acceptance.
  const execution = Object.hasOwn(item, "execution") ? readExecution(item.execution) : undefined;
  assertExecution(execution, turns.length, turns[0]);
  return managedJournal(turns, execution);
}

/** Trust only frozen turn objects installed by this module, not caller mutations. */
function stateFor(journal: GrokCaptureJournal): JournalState {
  let state = journals.get(journal);
  if (!state) {
    const decoded = decodeJournal(journal);
    // An arbitrary object is an untrusted boundary. Normalize it once before
    // allowing it to participate in the session-owned mutation helpers.
    const host = journal as { turns: GrokCaptureTurn[]; execution?: GrokCaptureExecution };
    host.turns = decoded.turns;
    if (decoded.execution) host.execution = decoded.execution;
    state = journals.get(decoded)!;
    journals.set(journal, state);
  }
  exactKeys(record(journal, "journal"), journal.execution ? [...JOURNAL_KEYS, "execution"] : JOURNAL_KEYS, "journal");
  if (journal.version !== GROK_CAPTURE_VERSION || !Array.isArray(journal.turns) || journal.turns.length !== state.turns.size || journal.execution !== state.execution) refuse("Grok capture journal was modified outside its helpers");
  for (let index = 0; index < journal.turns.length; index += 1) {
    if (journal.turns[index] !== state.turns.get(index)) refuse("Grok capture refuses to change or drop a captured turn");
  }
  assertExecution(journal.execution, journal.turns.length, state.identity);
  return state;
}

function setExecution(journal: GrokCaptureJournal, state: JournalState, execution: GrokCaptureExecution): void {
  (journal as { execution?: GrokCaptureExecution }).execution = execution;
  state.execution = execution;
  state.identity ??= execution;
}

function assertDirectory(directory: string): void {
  if (typeof directory !== "string" || !isAbsolute(directory) || directory.includes("\0")) refuse("Grok capture directory is not absolute");
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** `grok-capture.<appSessionId>.json`. The id must already be a UUID. */
export function grokCaptureFilename(appSessionId: string): string {
  const id = sessionUuid(appSessionId, "App session id");
  return `grok-capture.${id}.json`;
}

function singleAppSessionId(journal: GrokCaptureJournal): string {
  const identity = journal.execution ?? journal.turns[0];
  if (!identity) refuse("Grok capture journal has no App session id");
  return identity.appSessionId;
}

function sameTurn(left: GrokCaptureTurn, right: GrokCaptureTurn): boolean {
  return TURN_KEYS.every(key => left[key] === right[key]) && left.exitSignal === right.exitSignal && left.runId === right.runId && left.createdAt === right.createdAt;
}

/** Stored turns must survive unchanged. A new turn index must be higher than every stored index. */
function assertAppendOnly(existing: readonly GrokCaptureTurn[], next: readonly GrokCaptureTurn[]): void {
  const incoming = new Map(next.map(turn => [turn.turnIndex, turn]));
  const storedIndexes = new Set(existing.map(turn => turn.turnIndex));
  const maxExisting = existing.length ? existing[existing.length - 1].turnIndex : -1;
  for (const stored of existing) {
    const match = incoming.get(stored.turnIndex);
    if (!match) refuse("Grok capture refuses to drop a stored turn");
    if (!sameTurn(stored, match)) refuse("Grok capture refuses to change a stored turn");
  }
  for (const turn of next) {
    if (turn.turnIndex > maxExisting) continue;
    if (!storedIndexes.has(turn.turnIndex)) refuse("Grok capture refuses a turn index that is not higher than the stored journal");
  }
}

function fileStamp(path: string): BigIntStats | null {
  try {
    const stamp = lstatSync(path, { bigint: true });
    if (!stamp.isFile() || stamp.isSymbolicLink()) refuse("Grok capture file is not a regular file");
    return stamp;
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

function sameStamp(left: BigIntStats | null, right: BigIntStats | null): boolean {
  return left === null || right === null ? left === right : left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.mode === right.mode;
}

function assertFileUnchanged(path: string, expected: BigIntStats | null): void {
  if (!sameStamp(fileStamp(path), expected)) refuse("Grok capture file changed outside the session writer");
}

/** Temp suffix is a process serial. The name is never the session filename and never a native session id. */
function temporaryPath(directory: string, filename: string): string {
  temporarySerial += 1;
  const name = `.${filename}.${process.pid}.${temporarySerial}.tmp`;
  if (name === filename) refuse("Grok capture temporary name collides with the session file");
  return join(directory, name);
}

function publish(directory: string, filename: string, bytes: string, state: JournalState): void {
  const temporary = temporaryPath(directory, filename);
  const target = join(directory, filename);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let written: BigIntStats;
  try {
    writeFileSync(fd, bytes);
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    written = fstatSync(fd, { bigint: true });
  } catch (error) {
    try { closeSync(fd); } catch { /* Keep the original write error. */ }
    try { unlinkSync(temporary); } catch { /* Keep the original write error. */ }
    throw error;
  }
  try {
    closeSync(fd);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* Keep the original close error. */ }
    throw error;
  }
  try {
    // This drift fence is not a read/compare/rename concurrency transaction.
    // The caller must enforce one session writer; external replacement refuses.
    assertFileUnchanged(target, state.file!.stamp);
    renameSync(temporary, target);
    const stamp = fileStamp(target);
    if (!stamp || stamp.dev !== written.dev || stamp.ino !== written.ino || stamp.size !== written.size || stamp.mtimeNs !== written.mtimeNs || stamp.mode !== written.mode) refuse("Grok capture file changed during publication");
    state.file = { path: target, stamp };
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* Keep the original rename error. */ }
    throw error;
  }
  const dir = openSync(directory, "r");
  try { fsyncSync(dir); }
  catch (error) {
    try { closeSync(dir); } catch { /* Keep the original durability error. */ }
    throw error;
  }
  closeSync(dir);
}

export function createGrokCaptureJournal(): GrokCaptureJournal {
  return managedJournal([]);
}

/** Validates before mutating. A duplicate throws and leaves the journal unchanged. */
export function appendGrokCaptureTurn(journal: GrokCaptureJournal, input: GrokCaptureTurnInput): GrokCaptureTurn {
  const state = stateFor(journal);
  const turn = readTurn(input, false);
  assertIdentity(state.identity, turn);
  if (state.turns.has(turn.turnIndex) || turn.turnIndex !== journal.turns.length) refuse("Grok capture refuses a duplicate or nonsequential turn index");
  if (journal.execution && (journal.execution.disposition !== "pending" || journal.execution.turnIndex !== turn.turnIndex)) refuse("Grok capture turn has no matching pending execution");
  journal.turns.push(turn);
  state.turns.set(turn.turnIndex, turn);
  state.identity ??= turn;
  return turn;
}

/**
 * Caller-supplied directory only. Writes `grok-capture.<appSessionId>.json` by
 * temp-file rename. Mixed App session ids, a dropped turn, or a changed turn
 * refuse before any write and leave the session file bytes unchanged.
 */
export function persistGrokCaptureJournal(directory: string, journal: GrokCaptureJournal): void {
  assertDirectory(directory);
  // Persisting an untrusted/frozen value validates a private copy, not the
  // caller's object. Only journals created/loaded here have trusted provenance.
  if (!journals.has(journal)) journal = decodeJournal(journal);
  const state = stateFor(journal);
  const appSessionId = singleAppSessionId(journal);
  const filename = grokCaptureFilename(appSessionId);
  const path = join(directory, filename);
  if (state.file && state.file.path !== path) refuse("Grok capture journal belongs to another directory");
  if (!state.file) {
    // An independently created journal checks the persisted boundary once.
    const stored = loadGrokCaptureJournal(directory, appSessionId);
    assertIdentity(journals.get(stored)!.identity, state.identity!);
    assertAppendOnly(stored.turns, journal.turns);
    if (stored.execution && !journal.execution) refuse("Grok capture refuses to drop stored execution identity");
    if (stored.execution && stored.execution.disposition !== "idle") refuse("Grok capture refuses to adopt pending or blocked execution with a new journal");
    state.file = journals.get(stored)!.file;
  }
  publish(directory, filename, `${JSON.stringify(journal)}\n`, state);
}

/** Durable intent must precede any possible native execution, including turn 0. */
export function beginGrokCaptureTurn(directory: string, journal: GrokCaptureJournal, input: { appSessionId: string; nativeSessionId: string; authorityId: string; turnIndex: number }): void {
  const state = stateFor(journal);
  const execution = readExecution({ ...input, disposition: "pending" });
  assertIdentity(state.identity, execution);
  if (journal.execution && journal.execution.disposition !== "idle") refuse("Grok capture execution is pending or blocked; native execution must not be retried");
  if (execution.turnIndex !== journal.turns.length) refuse("Grok capture execution has the wrong turn index");
  setExecution(journal, state, execution);
  // On failure leave the in-memory intent pending too: durability may be unknown.
  persistGrokCaptureJournal(directory, journal);
}

/** The caller decides safety. Wrapper exit is not acceptance or cancellation. */
export function finishGrokCaptureTurn(directory: string, journal: GrokCaptureJournal, input: { blocked: boolean }): void {
  const state = stateFor(journal);
  const pending = journal.execution;
  if (!pending || pending.disposition !== "pending") refuse("Grok capture has no pending execution to finish");
  if (typeof input.blocked !== "boolean") refuse("Grok capture finish requires an explicit blocked disposition");
  const execution = readExecution({ ...pending, disposition: input.blocked ? "blocked" : "idle", turnIndex: input.blocked ? pending.turnIndex : journal.turns.length });
  setExecution(journal, state, execution);
  const previousFile = state.file;
  try { persistGrokCaptureJournal(directory, journal); }
  catch (error) {
    setExecution(journal, state, pending);
    // If rename succeeded but directory fsync failed, restore conservative
    // pending bytes where storage still permits it. Before rename, disk already
    // says pending: another full write cannot improve safety. Keep the original error.
    if (state.file !== previousFile) {
      try { persistGrokCaptureJournal(directory, journal); } catch { /* Storage failure remains unknown; the session must stay blocked. */ }
    }
    throw error;
  }
}

/** Missing session file is an empty version-1 journal. A bad version or a broken seal refuses. */
export function loadGrokCaptureJournal(directory: string, appSessionId: string): GrokCaptureJournal {
  assertDirectory(directory);
  const path = join(directory, grokCaptureFilename(appSessionId));
  const before = fileStamp(path);
  if (!before) {
    const journal = createGrokCaptureJournal();
    journals.get(journal)!.file = { path, stamp: null };
    return journal;
  }
  let raw: string;
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!sameStamp(before, fstatSync(fd, { bigint: true }))) refuse("Grok capture file changed while loading");
      raw = readFileSync(fd, "utf8");
      if (!sameStamp(before, fstatSync(fd, { bigint: true }))) refuse("Grok capture file changed while loading");
    } finally { closeSync(fd); }
    assertFileUnchanged(path, before);
  } catch (error) {
    if (error instanceof GrokCaptureRefusal) throw error;
    refuse("Grok capture file cannot be read");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error instanceof GrokCaptureRefusal) throw error;
    refuse("Grok capture file cannot be read");
  }
  const journal = decodeJournal(parsed);
  const identity = journals.get(journal)!.identity;
  if (identity && identity.appSessionId !== appSessionId) refuse("Grok capture file does not match the App session id");
  journals.get(journal)!.file = { path, stamp: before };
  return journal;
}
