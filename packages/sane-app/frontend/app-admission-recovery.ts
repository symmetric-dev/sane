import {
  AppAdmissionCodecError,
  appAdmissionPayloadSha256,
  appAdmissionRecoveryStorageKey,
  canonicalAppAdmissionJSON,
  decodeAppAdmissionEnvelope,
  decodeAppAdmissionIntent,
  decodeAppAdmissionKey,
  decodeAppAdmissionReceiptForIntent,
} from "../shared/conversation/app-admission-contract";
import type {
  AppAdmissionEnvelope,
  AppAdmissionIntent,
  AppAdmissionKey,
  AppAdmissionLookup,
  AppAdmissionReceipt,
  AppAdmissionRecoveryScope,
} from "../shared/conversation/app-admission-contract";
import type { ScienceSnapshotReference } from "../shared/conversation/types";
import { decodeComposerStamp } from "./composer-lineage";
import type { ComposerStamp } from "./composer-lineage";

export type AppAdmissionRecoveryRecord = Readonly<{
  version: 1;
  scope: AppAdmissionRecoveryScope;
  envelope: AppAdmissionEnvelope;
  draftKey: string;
  capturedStamp: ComposerStamp;
  consumedStamp: ComposerStamp | null;
  recovery: Readonly<{
    text: string;
    cwd: string;
    profileId?: string;
    upgradeProfileId?: string;
    scienceSnapshots?: readonly ScienceSnapshotReference[];
  }>;
  receipt: AppAdmissionReceipt | null;
  uncertain: boolean;
}>;

// The shared codec bounds the envelope independently. Applying its 256 KB
// budget to the whole recovery record would reject otherwise valid envelopes
// merely because recovery also stores the original draft text.
const MAX_RECORD_BYTES = 1_000_000;
const MAX_TEXT_LENGTH = 256_000;
const MAX_PATH_LENGTH = 4096;
const MAX_TOKEN_LENGTH = 512;
const MAX_DRAFT_KEY_LENGTH = 1024;
const MAX_SNAPSHOTS = 4;

function check(ok: unknown, message = "Invalid App admission recovery record"): asserts ok {
  if (!ok) throw new AppAdmissionCodecError(message);
}

function shape(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value));
  check(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  check(Reflect.ownKeys(value).every(key => typeof key === "string"));
  check(Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => "value" in descriptor && descriptor.enumerable));
  check(required.every(key => Object.hasOwn(value, key)));
  check(Object.keys(value).every(key => required.includes(key) || optional.includes(key)));
}

function token(value: unknown, limit = MAX_TOKEN_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit
    && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
}

function sameKey(left: AppAdmissionKey, right: AppAdmissionKey): boolean {
  return left.storeId === right.storeId && left.clientRequestId === right.clientRequestId
    && left.payloadSha256 === right.payloadSha256;
}

function decodeRecovery(value: unknown): AppAdmissionRecoveryRecord["recovery"] {
  shape(value, ["text", "cwd"], ["profileId", "upgradeProfileId", "scienceSnapshots"]);
  check(typeof value.text === "string" && value.text.length <= MAX_TEXT_LENGTH);
  check(typeof value.cwd === "string" && value.cwd.length <= MAX_PATH_LENGTH && !/[\x00-\x1f\x7f]/.test(value.cwd));
  const recovery: {
    text: string;
    cwd: string;
    profileId?: string;
    upgradeProfileId?: string;
    scienceSnapshots?: readonly ScienceSnapshotReference[];
  } = { text: value.text, cwd: value.cwd };
  if (Object.hasOwn(value, "profileId")) {
    check(token(value.profileId));
    recovery.profileId = value.profileId;
  }
  if (Object.hasOwn(value, "upgradeProfileId")) {
    check(token(value.upgradeProfileId));
    recovery.upgradeProfileId = value.upgradeProfileId;
  }
  if (Object.hasOwn(value, "scienceSnapshots")) {
    const snapshots: unknown = value.scienceSnapshots;
    check(Array.isArray(snapshots) && Object.getPrototypeOf(snapshots) === Array.prototype);
    check(snapshots.length <= MAX_SNAPSHOTS);
    check(Reflect.ownKeys(snapshots).length === snapshots.length + 1);
    check(Object.entries(Object.getOwnPropertyDescriptors(snapshots)).every(([key, descriptor]) =>
      "value" in descriptor && (descriptor.enumerable || key === "length")));
    const decoded: ScienceSnapshotReference[] = [];
    for (let index = 0; index < snapshots.length; index++) {
      check(Object.hasOwn(snapshots, index));
      const snapshot: unknown = snapshots[index];
      shape(snapshot, ["snapshotId", "blockId"]);
      check(token(snapshot.snapshotId) && token(snapshot.blockId));
      decoded.push(Object.freeze({ snapshotId: snapshot.snapshotId, blockId: snapshot.blockId }));
    }
    recovery.scienceSnapshots = Object.freeze(decoded);
  }
  return Object.freeze(recovery);
}

/** Checks wire identity and the operation's actual admitted target, not text or
 * guessed native IDs. A caller may additionally check its pinned source. */
export function correlateAppAdmissionReceipt(value: unknown, record: AppAdmissionRecoveryRecord): AppAdmissionReceipt {
  const envelope = decodeAppAdmissionEnvelope(record.envelope);
  const receipt = decodeAppAdmissionReceiptForIntent(value, envelope);
  check(sameKey(receipt, envelope), "App admission receipt key mismatch");
  if (receipt.state === "admitted") {
    const intent = envelope.intent;
    check(intent.conversationId === null || receipt.target.dispatch.source.sessionId === intent.conversationId,
      "App admission target conversation mismatch");
    check((intent.operation === "live-input") === (receipt.target.kind === "live-input"),
      "App admission target kind mismatch");
    if (intent.operation === "live-input") check(receipt.target.dispatch.runId === intent.expectedLiveRunId,
      "App admission expected live run mismatch");
  }
  return receipt;
}

export function decodeAppAdmissionLookup(value: unknown, record: AppAdmissionRecoveryRecord): AppAdmissionLookup {
  // Inspect kind only after ruling out accessors, prototypes, and unknown keys.
  shape(value, ["kind"], ["receipt", "key"]);
  if (value.kind === "found") {
    shape(value, ["kind", "receipt"]);
    return Object.freeze({ kind: "found", receipt: correlateAppAdmissionReceipt(value.receipt, record) });
  }
  check(value.kind === "absent");
  shape(value, ["kind", "key"]);
  const key = decodeAppAdmissionKey(value.key);
  check(sameKey(key, decodeAppAdmissionEnvelope(record.envelope)), "App admission lookup key mismatch");
  return Object.freeze({ kind: "absent", key });
}

function decodeRecord(value: unknown, expectedScope?: AppAdmissionRecoveryScope): AppAdmissionRecoveryRecord {
  shape(value, ["version", "scope", "envelope", "draftKey", "capturedStamp", "consumedStamp", "recovery", "receipt", "uncertain"]);
  check(value.version === 1 && typeof value.uncertain === "boolean");
  shape(value.scope, ["version", "browserOrigin", "storeId"]);
  check(value.scope.version === 1 && typeof value.scope.browserOrigin === "string" && typeof value.scope.storeId === "string");
  const scope: AppAdmissionRecoveryScope = Object.freeze({ version: 1, browserOrigin: value.scope.browserOrigin, storeId: value.scope.storeId });
  const storageKey = appAdmissionRecoveryStorageKey(scope);
  if (expectedScope !== undefined) check(storageKey === appAdmissionRecoveryStorageKey(expectedScope), "App admission recovery scope mismatch");
  const envelope = decodeAppAdmissionEnvelope(value.envelope);
  check(envelope.storeId === scope.storeId, "App admission recovery store mismatch");
  check(token(value.draftKey, MAX_DRAFT_KEY_LENGTH));
  const capturedStamp = decodeComposerStamp(value.capturedStamp);
  const consumedStamp = value.consumedStamp === null ? null : decodeComposerStamp(value.consumedStamp);
  check(capturedStamp.chainId === envelope.intent.chainId, "App admission recovery chain mismatch");
  if (consumedStamp !== null) check(consumedStamp.editorId === capturedStamp.editorId
    && consumedStamp.chainId === capturedStamp.chainId && capturedStamp.revision < Number.MAX_SAFE_INTEGER
    && consumedStamp.revision === capturedStamp.revision + 1, "App admission recovery consumption lineage mismatch");
  const record: AppAdmissionRecoveryRecord = {
    version: 1, scope, envelope, draftKey: value.draftKey, capturedStamp, consumedStamp,
    recovery: decodeRecovery(value.recovery), receipt: null, uncertain: value.uncertain,
  };
  return Object.freeze({ ...record, receipt: value.receipt === null ? null : correlateAppAdmissionReceipt(value.receipt, record) });
}

function serialize(record: AppAdmissionRecoveryRecord): string {
  const text = JSON.stringify(record);
  check(text.length <= MAX_RECORD_BYTES && new TextEncoder().encode(text).byteLength <= MAX_RECORD_BYTES,
    "App admission recovery exceeds the byte limit");
  return text;
}

/** Synchronous structural encoding; asynchronous decode verifies the intent hash.
 * Call createAppAdmissionEnvelope when constructing a new request envelope. */
export function encodeAppAdmissionRecovery(record: AppAdmissionRecoveryRecord): string {
  return serialize(decodeRecord(record));
}

export async function decodeAppAdmissionRecovery(raw: unknown, expectedScope: AppAdmissionRecoveryScope): Promise<AppAdmissionRecoveryRecord> {
  // Required even for untyped callers: never silently accept a missing scope.
  appAdmissionRecoveryStorageKey(expectedScope);
  check(typeof raw === "string" && raw.length <= MAX_RECORD_BYTES);
  check(new TextEncoder().encode(raw).byteLength <= MAX_RECORD_BYTES, "App admission recovery exceeds the byte limit");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new AppAdmissionCodecError("Invalid App admission recovery JSON"); }
  const record = decodeRecord(value, expectedScope);
  serialize(record);
  check(await appAdmissionPayloadSha256(record.envelope.intent) === record.envelope.payloadSha256,
    "App admission recovery intent hash mismatch");
  return record;
}

/** Pending and absent are unresolved, never permission to POST again. Terminal
 * receipts survive stale pending/absent observations; conflicting terminals fail. */
export function settleAppAdmissionRecovery(
  record: AppAdmissionRecoveryRecord,
  evidence: AppAdmissionLookup | AppAdmissionReceipt,
): AppAdmissionRecoveryRecord {
  const current = decodeRecord(record);
  shape(evidence, [], ["kind", "receipt", "key", "version", "storeId", "clientRequestId", "payloadSha256", "state", "target", "rejection"]);
  const lookup = Object.hasOwn(evidence, "kind") ? decodeAppAdmissionLookup(evidence, current) : null;
  const incoming = lookup === null ? correlateAppAdmissionReceipt(evidence, current)
    : lookup.kind === "found" ? lookup.receipt : null;
  const previous = current.receipt;
  if (previous !== null && previous.state !== "pending") {
    if (incoming !== null && incoming.state !== "pending") {
      check(canonicalAppAdmissionJSON(previous) === canonicalAppAdmissionJSON(incoming),
        "Conflicting terminal App admission receipts");
    }
    return Object.freeze({ ...current, uncertain: false });
  }
  const receipt = incoming ?? previous;
  return Object.freeze({ ...current, receipt, uncertain: receipt === null || receipt.state === "pending" });
}

/** Caller supplies identities. No native identity is derived here. */
export async function createAppAdmissionEnvelope(
  intent: AppAdmissionIntent,
  storeId: string,
  clientRequestId: string,
): Promise<AppAdmissionEnvelope> {
  const decoded = decodeAppAdmissionIntent(intent);
  return decodeAppAdmissionEnvelope({
    version: 1, storeId, clientRequestId,
    payloadSha256: await appAdmissionPayloadSha256(decoded), intent: decoded,
  });
}
