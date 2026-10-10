import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { atomicAppRecord, exact } from "./app-store";
import { uuid } from "./history";
import { canonicalJSON, fingerprint, immutable } from "./prepared-input-codec";
import { synchronousDispatchHook } from "./dispatch-evidence";
import { SCIENCE_SHARE_MAX_CHARS } from "../shared/science-share";
import type { ScienceJson } from "../shared/science-contract";

export interface SciencePreparedSnapshotReference {
  snapshotId: string;
  blockId: string;
  /** Exact immutable Python source from the authoritative saved snapshot. */
  source: string;
  agentText: string;
  /** Opaque backend provenance, compared in full; never itself authority. */
  provenance: { [key: string]: ScienceJson };
}
export type ScienceSubmissionIntent = {
  storeId: string;
  conversationId: string;
  requestId: string;
  text: string;
  snapshots: SciencePreparedSnapshotReference[];
} & ({ version: 1 } | { version: 2; rolePrefix: string });
export interface ScienceSubmissionKey { conversationId: string; requestId: string }
export interface ScienceSubmissionAssociation { runId: string; nativeCommandId: string | null }
export type ScienceSubmissionState = "prepared" | "unknown" | "submitted" | "not-submitted";
export interface ScienceSubmissionReceipt {
  intent: ScienceSubmissionIntent;
  fingerprint: string;
  /** Exact immutable ordinary-send payload. No attachments or implicit fetches. */
  dispatchText: string;
  state: ScienceSubmissionState;
  association: ScienceSubmissionAssociation | null;
  nativeAttempted: boolean;
}
interface Records { version: 1; storeId: string; items: ScienceSubmissionReceipt[] }
export class ScienceSubmissionError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 404 | 409 | 429 = 409) { super(message); this.name = "ScienceSubmissionError"; }
}
export class ScienceSubmissionStorageError extends Error {
  constructor(message: string, readonly cause?: unknown) { super(message); this.name = "ScienceSubmissionStorageError"; }
}
export interface ScienceSubmissionStoreDependencies {
  /** Must be synchronous. Verify App ownership, current conversation/native
   * binding and authoritative immutable snapshots. Outcome reconciliation must
   * check original run/command evidence, not grant another native attempt.
   * Throw ScienceSubmissionError for expected refusals; other errors fence writes. */
  validateLive: (input: { stage: "prepare" | "reserve" | "associate" | "before-native" | "outcome"; receipt: ScienceSubmissionReceipt }) => void;
  beforeMutation?: () => void;
  write?: typeof atomicAppRecord;
}

const FILE = "science-submissions.json";
const MAX_INTENT_BYTES = 256_000;
const MAX_RECORD_BYTES = 32_000_000;
const MAX_ITEMS = 2_000;
const clone = <T>(value: T): T => immutable(structuredClone(value));
function deny(code: string, message: string, status: 400 | 404 | 409 | 429 = 409): never { throw new ScienceSubmissionError(code, message, status); }
function check(ok: unknown, message = "Invalid science submission"): asserts ok { if (!ok) deny("invalid-science-submission", message, 400); }
function token(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value); }
function shape(value: unknown, keys: string[]): asserts value is Record<string, any> {
  try { exact(value, keys); } catch { check(false, "Invalid science submission fields"); }
}
function jsonObject(value: unknown) {
  check(value !== null && typeof value === "object" && !Array.isArray(value));
  check(canonicalJSON(value).length <= 8_000, "Science provenance is too large");
}
function validateIntent(value: unknown, storeId: string): asserts value is ScienceSubmissionIntent {
  const version = (value as ScienceSubmissionIntent | null)?.version;
  shape(value, ["version", "storeId", "conversationId", "requestId", "text", "snapshots", ...(version === 2 ? ["rolePrefix"] : [])]);
  check((value.version === 1 || value.version === 2) && value.storeId === storeId && uuid(value.storeId) && uuid(value.conversationId) && uuid(value.requestId));
  if (value.version === 2) check(typeof value.rolePrefix === "string" && value.rolePrefix.length <= 1_000);
  check(typeof value.text === "string" && value.text.length <= 8_000);
  check(Array.isArray(value.snapshots) && value.snapshots.length >= 1 && value.snapshots.length <= 4);
  const ids = new Set<string>();
  for (const snapshot of value.snapshots) {
    shape(snapshot, ["snapshotId", "blockId", "source", "agentText", "provenance"]);
    check(token(snapshot.snapshotId) && token(snapshot.blockId) && !ids.has(snapshot.snapshotId)); ids.add(snapshot.snapshotId);
    check(typeof snapshot.agentText === "string" && !!snapshot.agentText.trim() && snapshot.agentText.length <= SCIENCE_SHARE_MAX_CHARS);
    check(typeof snapshot.source === "string" && snapshot.source.length <= 100_000);
    jsonObject(snapshot.provenance);
  }
  check(Buffer.byteLength(canonicalJSON(value), "utf8") <= MAX_INTENT_BYTES, "Science send exceeds the payload budget");
}
function dispatchText(intent: ScienceSubmissionIntent): string {
  return (intent.version === 2 ? intent.rolePrefix : "") + [intent.text, ...intent.snapshots.map(snapshot => `Science block ${JSON.stringify(snapshot.blockId)} / snapshot ${JSON.stringify(snapshot.snapshotId)}:\n${snapshot.agentText}`)].filter(Boolean).join("\n\n");
}
function validateAssociation(value: unknown): asserts value is ScienceSubmissionAssociation {
  shape(value, ["runId", "nativeCommandId"]);
  check(uuid(value.runId) && (value.nativeCommandId === null || token(value.nativeCommandId)));
}
function decode(value: unknown, storeId: string): Records {
  shape(value, ["version", "storeId", "items"]);
  check(value.version === 1 && value.storeId === storeId && Array.isArray(value.items) && value.items.length <= MAX_ITEMS);
  const keys = new Set<string>(), runs = new Set<string>(), commands = new Set<string>();
  for (const item of value.items) {
    shape(item, ["intent", "fingerprint", "dispatchText", "state", "association", "nativeAttempted"]);
    validateIntent(item.intent, storeId);
    const key = `${item.intent.conversationId}/${item.intent.requestId}`;
    check(!keys.has(key)); keys.add(key);
    check(item.fingerprint === fingerprint(item.intent) && item.dispatchText === dispatchText(item.intent));
    check(["prepared", "unknown", "submitted", "not-submitted"].includes(item.state) && typeof item.nativeAttempted === "boolean");
    if (item.association !== null) {
      validateAssociation(item.association);
      check(!runs.has(item.association.runId)); runs.add(item.association.runId);
      if (item.association.nativeCommandId !== null) { check(!commands.has(item.association.nativeCommandId)); commands.add(item.association.nativeCommandId); }
    }
    check(item.state !== "prepared" || item.association === null && !item.nativeAttempted);
    check(!item.nativeAttempted || item.association !== null);
    check(item.state !== "submitted" || item.nativeAttempted && item.association !== null);
  }
  check(Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_RECORD_BYTES, "Science submission ledger is full");
  return value as Records;
}

/** Durable intent/receipt prerequisite, NOT an ordinary-send idempotency layer.
 * The owner must wire reserve -> associate -> beforeNative -> exactly one native
 * send -> markOutcome and fail closed on storage errors. Never dispatch from a
 * duplicate receipt. App data ownership must already be held. No expiry/replay.
 * All reserved receipts are pessimistically unknown, including after restart;
 * only this process's successful reservation grants a one-shot beforeNative. */
export class ScienceSubmissionStore {
  private records: Records;
  private failed = false;
  private changing = false;
  private readonly permits = new Set<string>();
  constructor(private readonly dataDir: string, readonly storeId: string, private readonly deps: ScienceSubmissionStoreDependencies) {
    check(uuid(storeId), "A real App store identity is required");
    try {
      const root = lstatSync(dataDir);
      if (!root.isDirectory() || root.isSymbolicLink() || realpathSync(dataDir) !== dataDir) throw new Error("Noncanonical App directory");
      const path = join(dataDir, FILE); let stat;
      try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!stat) { this.records = decode({ version: 1, storeId, items: [] }, storeId); return; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_RECORD_BYTES) throw new Error("Unsafe science submission file");
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.nlink !== 1 || opened.size > MAX_RECORD_BYTES || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error("Science submission file changed during load");
        this.records = decode(JSON.parse(readFileSync(fd, "utf8")), storeId);
        const current = lstatSync(path);
        if (current.isSymbolicLink() || current.nlink !== 1 || current.dev !== opened.dev || current.ino !== opened.ino) throw new Error("Science submission file changed during load");
      } finally { closeSync(fd); }
    } catch (error) { throw new ScienceSubmissionStorageError("Science submission store unavailable or corrupt; reconciliation required", error); }
  }
  private input<T>(action: () => T): T {
    try { return action(); } catch (error) { if (error instanceof ScienceSubmissionError) throw error; return deny("invalid-science-submission", "Invalid science submission input", 400); }
  }
  private key(key: ScienceSubmissionKey): string {
    this.input(() => { shape(key, ["conversationId", "requestId"]); check(uuid(key.conversationId) && uuid(key.requestId)); });
    return `${key.conversationId}/${key.requestId}`;
  }
  private find(records: Records, key: ScienceSubmissionKey) {
    this.key(key);
    return records.items.find(item => item.intent.conversationId === key.conversationId && item.intent.requestId === key.requestId);
  }
  private require(records: Records, key: ScienceSubmissionKey) { return this.find(records, key) ?? deny("science-submission-not-found", "Unknown science submission", 404); }
  private validate(stage: Parameters<ScienceSubmissionStoreDependencies["validateLive"]>[0]["stage"], receipt: ScienceSubmissionReceipt) {
    try { synchronousDispatchHook(() => this.deps.validateLive({ stage, receipt: clone(receipt) })); }
    catch (error) {
      if (error instanceof ScienceSubmissionError) throw error;
      this.failed = true; this.permits.clear();
      throw new ScienceSubmissionStorageError("Science submission authority check failed", error);
    }
  }
  private change<T>(action: (candidate: Records) => T): T {
    if (this.failed) throw new ScienceSubmissionStorageError("Science submission storage fenced; reload under App ownership");
    if (this.changing) deny("science-submission-reentrant", "Science submission mutation already in progress");
    this.changing = true;
    try {
      try { synchronousDispatchHook(() => this.deps.beforeMutation?.()); }
      catch (error) {
        if (error instanceof ScienceSubmissionError) throw error;
        this.failed = true; this.permits.clear(); throw new ScienceSubmissionStorageError("Science submission ownership fence failed", error);
      }
      const candidate = structuredClone(this.records), result = action(candidate);
      let validated: Records;
      try { validated = decode(candidate, this.storeId); }
      catch (error) { this.failed = true; this.permits.clear(); throw new ScienceSubmissionStorageError("Science submission candidate invariant failed", error); }
      try { synchronousDispatchHook(() => (this.deps.write ?? atomicAppRecord)(this.dataDir, FILE, validated)); }
      catch (error) { this.failed = true; this.permits.clear(); throw new ScienceSubmissionStorageError("Science submission write failed; publication withheld", error); }
      this.records = validated;
      return clone(result);
    } finally { this.changing = false; }
  }
  get(key: ScienceSubmissionKey): ScienceSubmissionReceipt | null { const item = this.find(this.records, key); return item ? clone(item) : null; }
  listConversation(conversationId: string): ScienceSubmissionReceipt[] {
    check(uuid(conversationId)); return clone(this.records.items.filter(item => item.intent.conversationId === conversationId));
  }
  /** Discovery excludes frozen source, dispatch text and provenance entirely. */
  listConversationViews(conversationId: string) {
    check(uuid(conversationId));
    return this.records.items.filter(item => item.intent.conversationId === conversationId).map(item => ({
      requestId: item.intent.requestId, conversationId: item.intent.conversationId, state: item.state,
      runId: item.association?.runId ?? null,
      snapshots: item.intent.snapshots.map(({ snapshotId, blockId }) => ({ snapshotId, blockId })),
    }));
  }
  /** Same key + full canonical intent returns the original receipt, including
   * unknown outcomes. Same key + ANY changed field is rejected. */
  prepare(input: ScienceSubmissionIntent): ScienceSubmissionReceipt {
    const intent = this.input(() => { validateIntent(input, this.storeId); return structuredClone(input); });
    const hash = fingerprint(intent), key = { conversationId: intent.conversationId, requestId: intent.requestId };
    const old = this.find(this.records, key);
    if (old) { if (old.fingerprint !== hash) deny("science-submission-id-conflict", "Request ID reused with different science intent"); return clone(old); }
    return this.change(records => {
      if (records.items.length >= MAX_ITEMS) deny("science-submission-full", "Science submission ledger capacity reached", 429);
      const receipt: ScienceSubmissionReceipt = { intent, fingerprint: hash, dispatchText: dispatchText(intent), state: "prepared", association: null, nativeAttempted: false };
      if (Buffer.byteLength(JSON.stringify({ ...records, items: [...records.items, receipt] }), "utf8") > MAX_RECORD_BYTES) deny("science-submission-full", "Science submission ledger byte capacity reached", 429);
      this.validate("prepare", receipt); records.items.push(receipt); return receipt;
    });
  }
  /** Persist pessimistic uncertainty BEFORE any native dispatch. reserved=false
   * is a receipt lookup, never permission to submit or retry. */
  reserve(key: ScienceSubmissionKey): { reserved: boolean; receipt: ScienceSubmissionReceipt } {
    const id = this.key(key);
    const prior = this.require(this.records, key);
    if (prior.state !== "prepared") return { reserved: false, receipt: clone(prior) };
    const receipt = this.change(records => { const item = this.require(records, key); this.validate("reserve", item); item.state = "unknown"; return item; });
    this.permits.add(id);
    return { reserved: true, receipt };
  }
  /** May reconcile the original association after restart, but grants no permit. */
  associate(key: ScienceSubmissionKey, association: ScienceSubmissionAssociation): ScienceSubmissionReceipt {
    this.input(() => validateAssociation(association));
    const pinned = structuredClone(association);
    return this.change(records => {
      const item = this.require(records, key);
      if (item.state === "prepared") deny("science-submission-transition", "Reserve before associating a native run");
      if (item.association && canonicalJSON(item.association) !== canonicalJSON(pinned)) deny("science-submission-association-conflict", "Original run/command association is immutable");
      if (records.items.some(other => other !== item && other.association && (other.association.runId === pinned.runId || pinned.nativeCommandId !== null && other.association.nativeCommandId === pinned.nativeCommandId))) deny("science-submission-association-conflict", "Run or command already belongs to another submission");
      item.association = pinned; this.validate("associate", item); return item;
    });
  }
  /** Call at the actual ordinary-send before-native boundary. Only a successful
   * return permits ONE immediate send of receipt.dispatchText. Never retry this
   * send on timeout. A restart cannot reconstruct the in-memory permit. */
  beforeNative(key: ScienceSubmissionKey, association: ScienceSubmissionAssociation): ScienceSubmissionReceipt {
    this.input(() => validateAssociation(association));
    const id = this.key(key);
    return this.change(records => {
      const item = this.require(records, key);
      if (!this.permits.has(id) || item.state !== "unknown" || item.nativeAttempted || !item.association || canonicalJSON(item.association) !== canonicalJSON(association)) deny("science-submission-no-permit", "No fresh one-shot native dispatch reservation");
      this.permits.delete(id);
      item.nativeAttempted = true; this.validate("before-native", item); return item;
    });
  }
  /** Outcomes describe transport submission, not execution success. The live
   * callback must verify authoritative evidence for this exact original receipt.
   * Unknown is never replayable, and terminal evidence cannot be reversed. */
  markOutcome(key: ScienceSubmissionKey, outcome: "unknown" | "submitted" | "not-submitted"): ScienceSubmissionReceipt {
    check(["unknown", "submitted", "not-submitted"].includes(outcome));
    const id = this.key(key);
    return this.change(records => {
      const item = this.require(records, key);
      if (item.state === "prepared" || item.state !== "unknown" && item.state !== outcome) deny("science-submission-transition", "Submission evidence cannot be reversed");
      if (outcome === "submitted" && (!item.nativeAttempted || !item.association)) deny("science-submission-unproven", "Submission needs the original associated native attempt");
      item.state = outcome; this.validate("outcome", item); this.permits.delete(id); return item;
    });
  }
}
