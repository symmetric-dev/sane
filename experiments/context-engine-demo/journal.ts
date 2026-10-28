import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isStoredAssistantAgentId, isWorkerAgentId } from "sane-core/agent-catalog";
import { validateContextMessageBinding } from "../../packages/sane-app/src/context-message";
import { decodeContextMessageDispatchObservation, decodeContextMessageSubmission, type ContextMessageDispatchObservation, type ContextMessageSubmission } from "../../packages/sane-app/src/context-message-evidence";
import { decodeLog, uuid, validAgentSnapshot, validModel, validProfileId, validVariant, type Event } from "../../packages/sane-app/src/history";
import type { DemoJournal, DemoJournalOwner, DemoJournalRead } from "./contract";

/** Experiment-only, synchronous single-owner storage. This is not a dispatch or
 * activation machine. The local fixture directory is the trust root: hashes bind
 * its records, not cryptographic provenance against someone rewriting all files.
 * Layout: owner.json (identity/pairing + ORIGINAL log source), events.jsonl
 * (standard Event envelopes), checkpoint.json (closed, exact protected boundary).
 * A missing checkpoint is deliberately not a complete snapshot. */
const OWNER = "owner.json", LOG = "events.jsonl", CHECKPOINT = "checkpoint.json";
const OWNER_REF = "mock-context-demo-owner-reference", HEALTH = "mock-context-demo-health-failure";
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
function invalid(reason: string): never { throw new Error(`Demo journal: ${reason}`); }
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("expected object");
  return value as Record<string, any>;
}
function keys(value: Record<string, any>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid("unexpected or missing fields");
}
function text(value: unknown): asserts value is string { if (typeof value !== "string" || !value.trim()) invalid("expected nonempty string"); }
function hash(value: unknown): void { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) invalid("expected SHA-256"); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function json(value: unknown): string {
  const encoded = JSON.stringify(value, (_key, item) => {
    if (item === undefined || typeof item === "function" || typeof item === "symbol" || typeof item === "bigint" || typeof item === "number" && !Number.isFinite(item)) invalid("non-JSON data");
    return item;
  });
  if (encoded === undefined) invalid("non-JSON data");
  return encoded;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return json(value);
}
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
function identityOf(value: ContextMessageDispatchObservation["evidence"]) {
  return { source: value.source, runId: value.runId, nativeCommandId: value.nativeCommandId,
    ...(value.requestId !== undefined ? { requestId: value.requestId } : {}) };
}

/** Generic mock identities intentionally do not pass through CC/OC wire regexes.
 * Reuse exact binding/observation/submission codecs; locally validate the bounded
 * owner Run and pairing references. This does NOT reload pins or prove activation. */
function ownerValue(value: unknown): DemoJournalOwner {
  const owner = object(value);
  keys(owner, ["schema", "type", "run", "dispatch", "messageId", "agent", "activation"]);
  if (owner.schema !== 1 || owner.type !== "mock-context-demo-owner") invalid("unsupported owner");
  const dispatch = object(owner.dispatch);
  validateContextMessageBinding(dispatch.source);
  const probe = decodeContextMessageDispatchObservation({ schema: 1, type: "context-message-dispatch", messageId: owner.messageId,
    transportSha256: "0".repeat(64), boundary: "message", stage: "before-native", evidence: { ...dispatch, submission: "attempted", nativeAcceptance: "unknown" } });
  if (!same(identityOf(probe.evidence), dispatch)) invalid("invalid owner dispatch");
  const run = object(owner.run);
  keys(run, ["runId", "sessionId", "cwd", "status", "createdAt"], ["endedAt", "agent", "agentKind", "nativeAgentSelected", "saneExecution", "model", "effort", "profileId", "nativeCommandId", "nativeDelivery", "nativePhase", "nativeAcceptedAt", "operation", "compact", "saneContextVersion", "queuedFollowupId"]);
  if (!uuid(run.runId) || !uuid(run.sessionId) || !isAbsolute(run.cwd) || run.cwd.includes("\0")
    || !["running", "completed", "failed", "interrupted"].includes(run.status)
    || typeof run.createdAt !== "string" || !Number.isFinite(Date.parse(run.createdAt))
    || run.status === "running" && run.endedAt !== undefined
    || run.status !== "running" && (typeof run.endedAt !== "string" || !Number.isFinite(Date.parse(run.endedAt)))
    || run.endedAt !== undefined && Date.parse(run.endedAt) < Date.parse(run.createdAt)
    || !validAgentSnapshot(run) || run.runId !== dispatch.runId || run.sessionId !== dispatch.source.sessionId || run.cwd !== dispatch.source.cwd
    || run.nativeCommandId !== undefined && run.nativeCommandId !== dispatch.nativeCommandId
    || run.model !== undefined && !validModel(run.model)
    || run.effort !== undefined && !validVariant(run.effort)
    || run.profileId !== undefined && !validProfileId(run.profileId)
    || run.nativeDelivery !== undefined && run.nativeDelivery !== "queue"
    || run.nativePhase !== undefined && !["preparing", "sending", "accepted"].includes(run.nativePhase)
    || run.nativeAcceptedAt !== undefined && (typeof run.nativeAcceptedAt !== "number" || !Number.isFinite(run.nativeAcceptedAt) || run.nativeAcceptedAt < 0 || !Number.isFinite(new Date(run.nativeAcceptedAt).getTime()))
    || run.operation !== undefined && run.operation !== "prompt" || run.compact !== undefined
    || run.queuedFollowupId !== undefined && !uuid(run.queuedFollowupId)) invalid("invalid run/owner relationship");
  const agent = object(owner.agent);
  keys(agent, ["kind", "role"]);
  if (!(agent.kind === "assistant" ? isStoredAssistantAgentId(agent.role) : agent.kind === "worker" && isWorkerAgentId(agent.role))
    || run.agent !== undefined && (run.agent !== agent.role || (run.agentKind ?? "assistant") !== agent.kind)) invalid("invalid agent pairing");
  const activation = object(owner.activation); keys(activation, ["saneExecution", "saneContext"]);
  const execution = object(activation.saneExecution); keys(execution, ["schema", "revision"]); hash(execution.revision);
  const context = object(activation.saneContext); keys(context, ["version", "framework", "package"], ["assignment"]);
  const pin = object(context.package); keys(pin, ["schema", "revision", "delivery"], ["activation"]); hash(pin.revision); text(context.framework);
  if (execution.schema !== 1 || pin.schema !== 1 || pin.delivery !== "standing-native-role" || pin.activation !== undefined && pin.activation !== "upgrade"
    || !Number.isSafeInteger(context.version) || context.version < 1
    || context.assignment !== undefined && (typeof context.assignment !== "string" || !context.assignment.trim() || agent.kind !== "worker")
    || run.saneExecution !== undefined && !same(run.saneExecution, execution)
    || run.saneContextVersion !== undefined && run.saneContextVersion !== context.version) invalid("invalid owner pairing references");
  return freeze(JSON.parse(json(owner))) as DemoJournalOwner;
}

function syncDirectory(directory: string): void {
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset);
    if (count <= 0) invalid("short write");
    offset += count;
  }
}
function durableFile(path: string, bytes: Buffer): void {
  const fd = openSync(path, "wx", 0o600);
  try { writeAll(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
function publish(directory: string, name: string, bytes: Buffer): void {
  // Exclusive temporary file + rename + parent fsync. Failed temporaries stay as
  // diagnostics inside this owned directory, never guessed/deleted on replay.
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
  durableFile(temporary, bytes);
  renameSync(temporary, join(directory, name));
  syncDirectory(directory);
}
function fresh(directory: string): string {
  const path = resolve(directory);
  mkdirSync(path, { mode: 0o700 }); // no recursive mkdir, reuse, or broad deletion
  syncDirectory(dirname(path));
  return path;
}
function bytesJson(value: unknown): Buffer { return Buffer.from(json(value) + "\n"); }

function verifySubmission(owner: DemoJournalOwner, value: unknown): ContextMessageSubmission {
  const submission = decodeContextMessageSubmission(value);
  if (submission.messageId !== owner.messageId || !same(submission.composition.dispatch, owner.dispatch)) invalid("foreign submission identity");
  return submission;
}
function verifyObservation(owner: DemoJournalOwner, submission: ContextMessageSubmission | undefined, value: unknown): ContextMessageDispatchObservation {
  const observation = decodeContextMessageDispatchObservation(value);
  if (!submission || observation.messageId !== owner.messageId || !same(identityOf(observation.evidence), owner.dispatch)
    || observation.transportSha256 !== submission.composition.transport.sha256) invalid("foreign or unbound observation identity/hash");
  if (owner.dispatch.source.harnessId === "claude-code" && observation.boundary === "run-initial"
    && (submission.liveInput === true || submission.messageId !== `${owner.dispatch.runId}:user`)) invalid("invalid initial message boundary");
  return observation;
}

export function createDemoJournal(directory: string, suppliedOwner: DemoJournalOwner): DemoJournal {
  const owner = ownerValue(suppliedOwner), path = fresh(directory), source = join(path, LOG);
  const ownerBytes = bytesJson({ schema: 1, type: "mock-context-demo-owner-record", source, owner });
  const ownerSha256 = sha(ownerBytes);
  publish(path, OWNER, ownerBytes);
  let seq = 1, closed = false, submission: ContextMessageSubmission | undefined;
  const failures: string[] = [];
  const event = (kind: Event["kind"], data: unknown, at: number): Event => ({ seq: at, time: new Date().toISOString(),
    runId: owner.run.runId, sessionId: owner.run.sessionId, kind, data });
  let expected = bytesJson(event("context", { schema: 1, type: OWNER_REF, source, ownerSha256 }, seq));
  durableFile(source, expected); syncDirectory(path);
  function checkOpen(): void { if (closed) invalid("journal is closed"); }
  function writeEvents(events: Event[]): void {
    // Verify that an external truncation/replacement is not silently blessed by
    // seal. No O_CREAT on append: losing the file is a storage failure.
    const fd = openSync(source, constants.O_WRONLY | constants.O_APPEND);
    const tail = Buffer.concat(events.map(bytesJson));
    try {
      if (fstatSync(fd).size !== expected.length || !readFileSync(source).equals(expected)) invalid("log changed outside its owner");
      if (!readFileSync(join(path, OWNER)).equals(ownerBytes)) invalid("owner changed before boundary persistence");
      writeAll(fd, tail); fsyncSync(fd);
    } finally { closeSync(fd); }
    expected = Buffer.concat([expected, tail]);
    seq = events.at(-1)!.seq;
  }
  function mark(reason: string): void {
    text(reason);
    if (!failures.includes(reason)) failures.push(reason);
  }
  function guarded<T>(action: () => T): T {
    checkOpen();
    try { return action(); }
    catch (error) { mark(errorText(error)); throw error; }
  }
  function append(kind: Event["kind"], data: unknown): Event {
    return guarded(() => {
      const copy = JSON.parse(json(data));
      let nextSubmission = submission;
      if (kind === "submission") {
        if (submission) invalid("duplicate actual submission");
        nextSubmission = verifySubmission(owner, copy);
      }
      if (kind === "context" && copy?.type === "context-message-dispatch") verifyObservation(owner, submission, copy);
      if (kind === "context" && copy?.type === OWNER_REF) invalid("duplicate owner association");
      if (kind === "context" && copy?.type === HEALTH) { text(copy.reason); mark(copy.reason); }
      const value = event(kind, copy, seq + 1);
      decodeLog(json(value) + "\n", owner.run); // standard envelope validation
      writeEvents([value]); submission = nextSubmission;
      return freeze(value);
    });
  }
  return Object.freeze({ directory: path, owner, append,
    persist(value, observationValue) {
      guarded(() => {
        const next = verifySubmission(owner, value);
        if (submission && !same(submission, next)) invalid("different actual submission for existing message");
        const observation = verifyObservation(owner, next, observationValue);
        const events: Event[] = [];
        if (!submission) events.push(event("submission", next, seq + 1));
        events.push(event("context", observation, seq + events.length + 1));
        writeEvents(events); submission = next;
      });
    },
    fail(reason) {
      guarded(() => {
        mark(reason); // sticky even if its diagnostic record cannot be written
        writeEvents([event("context", { schema: 1, type: HEALTH, reason }, seq + 1)]);
      });
    },
    seal() {
      if (closed) return;
      try {
        if (!readFileSync(source).equals(expected) || !readFileSync(join(path, OWNER)).equals(ownerBytes)) invalid("owner/log changed before seal");
        publish(path, CHECKPOINT, bytesJson({ schema: 1, type: "mock-context-demo-checkpoint", state: "closed", source, ownerSha256,
          log: { byteLength: expected.length, sha256: sha(expected), eventCount: seq, lastSeq: seq },
          coverage: { state: failures.length ? "partial" : "complete", issues: [...failures] } }));
        closed = true;
      } catch (error) {
        mark(errorText(error));
        // A rename may have succeeded before its directory fsync failed. Poison
        // that newly visible boundary too, when the filesystem still permits a
        // diagnostic append. Never leave a successful-looking boundary merely
        // because the publication error occurred after rename.
        try { writeEvents([event("context", { schema: 1, type: HEALTH, reason: errorText(error) }, seq + 1)]); } catch { /* original failure wins */ }
        throw error;
      }
    },
  } satisfies DemoJournal);
}

export function readDemoJournal(directory: string): DemoJournalRead {
  const path = resolve(directory), issues: string[] = [];
  let owner: DemoJournalOwner | null = null, source = join(path, LOG), ownerBytes: Buffer | undefined, logBytes: Buffer | undefined;
  let checkpoint: Record<string, any> | undefined;
  let events: Event[] = [];
  const observations: { source: string; order: number; value: unknown }[] = [];
  function read(name: string): Buffer | undefined {
    try { return readFileSync(join(path, name)); }
    catch (error) { issues.push(`${name}: ${errorText(error)}`); return undefined; }
  }
  ownerBytes = read(OWNER);
  if (ownerBytes) try {
    const record = object(JSON.parse(ownerBytes.toString("utf8")));
    keys(record, ["schema", "type", "source", "owner"]); text(record.source);
    if (record.schema !== 1 || record.type !== "mock-context-demo-owner-record" || !isAbsolute(record.source)) invalid("invalid owner record/source");
    owner = ownerValue(record.owner); source = record.source;
  } catch (error) { issues.push(`owner: ${errorText(error)}`); }
  const checkpointBytes = read(CHECKPOINT);
  if (checkpointBytes) try {
    const record = object(JSON.parse(checkpointBytes.toString("utf8")));
    keys(record, ["schema", "type", "state", "source", "ownerSha256", "log", "coverage"]);
    const log = object(record.log), coverage = object(record.coverage);
    keys(log, ["byteLength", "sha256", "eventCount", "lastSeq"]); keys(coverage, ["state", "issues"]);
    hash(record.ownerSha256); hash(log.sha256);
    if (record.schema !== 1 || record.type !== "mock-context-demo-checkpoint" || record.state !== "closed" || record.source !== source
      || ![log.byteLength, log.eventCount, log.lastSeq].every(n => Number.isSafeInteger(n) && n > 0)
      || !["complete", "partial"].includes(coverage.state) || !Array.isArray(coverage.issues)
      || coverage.issues.some((item: unknown) => typeof item !== "string" || !item.trim())
      || coverage.state === "complete" && coverage.issues.length !== 0) invalid("invalid checkpoint");
    if (!ownerBytes || record.ownerSha256 !== sha(ownerBytes)) invalid("checkpoint owner hash mismatch");
    checkpoint = record;
    if (coverage.state !== "complete") issues.push("Owner closed this journal with partial coverage", ...coverage.issues);
  } catch (error) { issues.push(`checkpoint: ${errorText(error)}`); }
  logBytes = read(LOG);
  if (logBytes && owner) try {
    const raw = logBytes.toString("utf8");
    if (!Buffer.from(raw).equals(logBytes)) issues.push("Log contains malformed/torn UTF-8 bytes");
    const decoded = decodeLog(raw, owner.run); events = decoded.events;
    if (decoded.repaired !== undefined) issues.push("Decoder reported a torn or unterminated tail; replay did not repair it");
    const reference = object(events[0]?.data);
    keys(reference, ["schema", "type", "source", "ownerSha256"]);
    if (events[0]?.kind !== "context" || reference.schema !== 1 || reference.type !== OWNER_REF || reference.source !== source
      || !ownerBytes || reference.ownerSha256 !== sha(ownerBytes)) invalid("log owner association mismatch");
    let submission: ContextMessageSubmission | undefined;
    for (const [index, event] of events.entries()) {
      if (event.seq !== index + 1) invalid("noncontiguous owner log sequence");
      if (index > 0 && event.kind === "context" && (event.data as any)?.type === OWNER_REF) invalid("duplicate owner association");
      if (event.kind === "submission") {
        if (submission) invalid("duplicate actual submission");
        submission = verifySubmission(owner, event.data);
      }
      if (event.kind === "context" && (event.data as any)?.type === "context-message-dispatch") {
        const value = verifyObservation(owner, submission, event.data);
        observations.push({ source, order: event.seq, value });
      }
      if (event.kind === "context" && (event.data as any)?.type === HEALTH) issues.push(`Owner health failure: ${(event.data as any).reason}`);
    }
    if (checkpoint && (logBytes.length !== checkpoint.log.byteLength || sha(logBytes) !== checkpoint.log.sha256
      || events.length !== checkpoint.log.eventCount || events.at(-1)?.seq !== checkpoint.log.lastSeq)) invalid("checkpoint log length/hash/count mismatch");
  } catch (error) { issues.push(`log: ${errorText(error)}`); }
  const state = issues.length ? !ownerBytes && !logBytes && !checkpointBytes ? "unavailable" : "partial" : "complete";
  return freeze({ owner, issues, snapshot: { coverage: { state, source, ...(issues.length ? { reason: issues.join("; ") } : {}) }, events, observations } });
}

export function createDemoReplayVariant(source: string, destination: string, kind: "torn" | "missing"): void {
  if (kind !== "torn" && kind !== "missing") invalid("unknown replay variant");
  const original = readDemoJournal(source);
  // Only a verified closed journal (including deliberately partial health) may
  // be copied. Never copy fixtures, arbitrary directory contents, or repair data.
  const checkpointBytes = readFileSync(join(resolve(source), CHECKPOINT));
  const checkpoint = object(JSON.parse(checkpointBytes.toString("utf8")));
  const ownerBytes = readFileSync(join(resolve(source), OWNER)), logBytes = readFileSync(join(resolve(source), LOG));
  if (!original.owner || checkpoint.state !== "closed" || checkpoint.ownerSha256 !== sha(ownerBytes)
    || checkpoint.log?.sha256 !== sha(logBytes) || checkpoint.log?.byteLength !== logBytes.length
    || checkpoint.log?.eventCount !== original.snapshot.events.length || checkpoint.log?.lastSeq !== original.snapshot.events.at(-1)?.seq
    || original.issues.some(issue => !issue.startsWith("Owner health failure:") && issue !== "Owner closed this journal with partial coverage" && !checkpoint.coverage?.issues?.includes(issue))) invalid("source is not an intact closed experiment journal");
  const path = fresh(destination);
  durableFile(join(path, OWNER), ownerBytes);
  durableFile(join(path, CHECKPOINT), checkpointBytes);
  // 'missing' intentionally omits the expected log, retaining known query owner.
  if (kind === "torn") durableFile(join(path, LOG), Buffer.concat([logBytes, Buffer.from('{"seq":')]));
  syncDirectory(path);
}
