/** Dormant future wire contract only: no routes, persistence, queue execution or
 * capability advertisement. Endpoint names are intentionally unspecified.
 * This protocol is separate from harness operation/capability flags. */
export type PendingInputCapability = {
  readonly protocol: "pending-input";
  readonly version: 1;
  readonly supported: true;
  readonly maxWaiting: 3;
  readonly removal: true;
  readonly resume: true;
};

/** Exact App harness ID and identity pin; null is unknown, not a default. */
export type PendingInputSource = {
  readonly harnessId: string;
  readonly conversationId: string;
  readonly authorityId: string | null;
  readonly nativeSessionId: string | null;
  readonly cwd: string;
};
export type PendingInputConfiguration = {
  readonly cwd: string;
  readonly profileId: string;
  readonly model?: string;
  readonly effort?: string;
  readonly agent?: string;
};
/** Future ordinary-input submission. requestId is stable across retransmission;
 * identical text with different requestIds represents distinct inputs. The
 * configuration and source are captured at submission, not read at dispatch. */
export type PendingInputRequest = {
  readonly version: 1;
  readonly requestId: string;
  readonly conversationId: string;
  readonly text: string;
  readonly source: PendingInputSource;
  readonly configuration: PendingInputConfiguration;
};
type PendingInputItemIdentity = {
  readonly itemId: string;
  readonly sequence: number;
};
export type PendingInputItem = PendingInputRequest & PendingInputItemIdentity & (
  | { readonly state: "waiting"; readonly runId?: never }
  | { readonly state: "claimed"; readonly runId?: string }
  | { readonly state: "run-linked"; readonly runId: string }
);
/** Removal evidence is not an active item or a complete history. Retained
 * tombstones have no cap of three; omitted tombstones do not imply never seen. */
export type PendingInputTombstone = PendingInputItemIdentity & {
  readonly conversationId: string;
  readonly requestId: string;
  readonly state: "removed";
};
/** Future queue read/update projection: both arrays are ascending by sequence.
 * sequence is positive and never reused; revision is a nonnegative safe integer.
 * Only waiting items consume the three slots, not claimed or run-linked items.
 * paused requires a reason; an unpaused queue has reason:null. */
export type PendingInputSnapshot = {
  readonly version: 1;
  readonly conversationId: string;
  readonly revision: number;
  readonly paused: boolean;
  readonly reason: string | null;
  readonly items: readonly PendingInputItem[];
  readonly tombstones: readonly PendingInputTombstone[];
};
/** Future submission response. An enqueue receipt proves only queue admission,
 * NEVER native acceptance. Run admission is App admission, not native acceptance.
 * Uncertainty must be reconciled by identity, not interpreted as safe to retry. */
export type PendingInputEnqueueReceipt = {
  readonly version: 1; readonly outcome: "enqueued";
  readonly conversationId: string; readonly requestId: string;
  readonly itemId: string; readonly sequence: number; readonly revision: number;
};
export type PendingInputRunAdmission = {
  readonly version: 1; readonly outcome: "run-admitted";
  readonly conversationId: string; readonly requestId: string;
  readonly runId: string; readonly itemId?: string;
};
export type PendingInputUncertainty = {
  readonly version: 1; readonly outcome: "uncertain";
  readonly conversationId: string; readonly requestId: string;
  readonly reason: string; readonly itemId?: string; readonly runId?: string;
};
export type PendingInputSubmissionResult = PendingInputEnqueueReceipt | PendingInputRunAdmission | PendingInputUncertainty;

/** Future removal mutation. requestId identifies this mutation; inputRequestId
 * identifies the original ordinary input. Claimed work cannot be removed. */
export type PendingInputRemovalRequest = {
  readonly version: 1; readonly requestId: string; readonly conversationId: string;
  readonly inputRequestId: string; readonly itemId: string;
};
export type PendingInputRemovalResult = PendingInputRemovalRequest & { readonly revision: number } & (
  | { readonly outcome: "removed" | "already-removed"; readonly runId?: never }
  | { readonly outcome: "claimed"; readonly runId?: string }
);
/** Future explicit resume mutation: unpause the existing queue at the observed
 * revision. It does NOT retry a submission, recreate an item, remove a claim,
 * clear uncertainty, or assert that dispatch/native acceptance has occurred. */
export type PendingInputResumeRequest = {
  readonly version: 1; readonly requestId: string; readonly conversationId: string;
  readonly action: "resume"; readonly expectedRevision: number;
};

export type PendingInputValidation = {
  /** Backend registry validation of exact future App harness IDs. No callback
   * means only today's two IDs. Native aliases cc/oc are never accepted. */
  readonly validateHarnessId?: (harnessId: string) => boolean;
  readonly conversationId?: string;
  readonly requestId?: string;
  readonly itemId?: string;
  readonly inputRequestId?: string;
};

type WireObject = Record<string, unknown>;
const object = (value: unknown): value is WireObject => value !== null && typeof value === "object" && !Array.isArray(value);
// Identity/config tokens allow internal spaces, but never ASCII controls.
// Prompt text has its own validator and remains multiline/harness-neutral.
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const integer = (value: unknown, minimum = 0): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const keys = (value: WireObject, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const optionalId = (value: WireObject, key: string) => !(key in value) || id(value[key]);
const nullableId = (value: unknown) => value === null || id(value);
const envelope = (value: WireObject, expected: PendingInputValidation) => value.version === 1 && id(value.conversationId) && id(value.requestId)
  && (["conversationId", "requestId", "itemId", "inputRequestId"] as const).every(key => expected[key] === undefined || value[key] === expected[key]);
const requestKeys = ["version", "requestId", "conversationId", "text", "source", "configuration"];
const removalKeys = ["version", "requestId", "conversationId", "inputRequestId", "itemId"];

/** Absence, partial/malformed advertisements and legacy harness flags all fail
 * closed. No exported capability value is installed into production configs. */
export function isPendingInputCapability(value: unknown): value is PendingInputCapability {
  return object(value) && keys(value, ["protocol", "version", "supported", "maxWaiting", "removal", "resume"])
    && value.protocol === "pending-input" && value.version === 1 && value.supported === true
    && value.maxWaiting === 3 && value.removal === true && value.resume === true;
}

function source(value: unknown, expected: PendingInputValidation): value is PendingInputSource {
  if (!object(value) || !keys(value, ["harnessId", "conversationId", "authorityId", "nativeSessionId", "cwd"])
    || !id(value.harnessId) || !id(value.conversationId) || !id(value.cwd)
    || !nullableId(value.authorityId) || !nullableId(value.nativeSessionId)
    || value.harnessId === "cc" || value.harnessId === "oc") return false;
  if (value.harnessId === "claude-code" || value.harnessId === "opencode") return true;
  return expected.validateHarnessId?.(value.harnessId) === true;
}
function configuration(value: unknown): value is PendingInputConfiguration {
  return object(value) && keys(value, ["cwd", "profileId", "model", "effort", "agent"])
    && id(value.cwd) && id(value.profileId) && ["model", "effort", "agent"].every(key => optionalId(value, key));
}
function request(value: WireObject, expected: PendingInputValidation): boolean {
  return envelope(value, expected) && text(value.text) && source(value.source, expected) && configuration(value.configuration)
    && value.source.conversationId === value.conversationId && value.source.cwd === value.configuration.cwd;
}
export function isPendingInputRequest(value: unknown, expected: PendingInputValidation = {}): value is PendingInputRequest {
  return object(value) && keys(value, requestKeys) && request(value, expected);
}
export function isPendingInputItem(value: unknown, expected: PendingInputValidation = {}): value is PendingInputItem {
  return object(value) && keys(value, [...requestKeys, "itemId", "sequence", "state", "runId"])
    && request(value, expected) && id(value.itemId) && integer(value.sequence, 1)
    && (value.state === "waiting" ? !("runId" in value)
      : value.state === "claimed" ? optionalId(value, "runId")
      : value.state === "run-linked" && id(value.runId));
}
export function isPendingInputTombstone(value: unknown, expected: PendingInputValidation = {}): value is PendingInputTombstone {
  return object(value) && keys(value, ["conversationId", "requestId", "itemId", "sequence", "state"])
    && id(value.conversationId) && id(value.requestId) && id(value.itemId) && integer(value.sequence, 1) && value.state === "removed"
    && (["conversationId", "requestId", "itemId"] as const).every(key => expected[key] === undefined || value[key] === expected[key]);
}
export function isPendingInputSnapshot(value: unknown, expected: PendingInputValidation = {}): value is PendingInputSnapshot {
  if (!object(value) || !keys(value, ["version", "conversationId", "revision", "paused", "reason", "items", "tombstones"])
    || value.version !== 1 || !id(value.conversationId) || !integer(value.revision)
    || (expected.conversationId !== undefined && value.conversationId !== expected.conversationId)
    || typeof value.paused !== "boolean" || !(value.paused ? text(value.reason) : value.reason === null)
    || !Array.isArray(value.items) || !Array.isArray(value.tombstones)) return false;
  const scope = { ...expected, conversationId: value.conversationId };
  if (!value.items.every(item => isPendingInputItem(item, scope)) || !value.tombstones.every(item => isPendingInputTombstone(item, scope))) return false;
  const items = value.items as PendingInputItem[], tombstones = value.tombstones as PendingInputTombstone[];
  if (items.filter(item => item.state === "waiting").length > 3) return false;
  const ordered = (entries: readonly PendingInputItemIdentity[]) => entries.every((item, index) => index === 0 || entries[index - 1]!.sequence < item.sequence);
  const all = [...items, ...tombstones];
  const unique = (values: readonly unknown[]) => new Set(values).size === values.length;
  return ordered(items) && ordered(tombstones) && unique(all.map(item => item.itemId))
    && unique(all.map(item => item.requestId)) && unique(all.map(item => item.sequence))
    && unique(items.flatMap(item => item.runId === undefined ? [] : [item.runId]));
}
export function isPendingInputSubmissionResult(value: unknown, expected: PendingInputValidation = {}): value is PendingInputSubmissionResult {
  if (!object(value) || !envelope(value, expected)) return false;
  const base = ["version", "outcome", "conversationId", "requestId", "itemId"];
  if (value.outcome === "enqueued") return keys(value, [...base, "sequence", "revision"])
    && id(value.itemId) && integer(value.sequence, 1) && integer(value.revision);
  if (value.outcome === "run-admitted") return keys(value, [...base, "runId"]) && id(value.runId) && optionalId(value, "itemId");
  return value.outcome === "uncertain" && keys(value, [...base, "runId", "reason"])
    && text(value.reason) && optionalId(value, "itemId") && optionalId(value, "runId");
}
export function isPendingInputRemovalRequest(value: unknown, expected: PendingInputValidation = {}): value is PendingInputRemovalRequest {
  return object(value) && keys(value, removalKeys) && envelope(value, expected) && id(value.inputRequestId) && id(value.itemId);
}
export function isPendingInputRemovalResult(value: unknown, expected: PendingInputValidation = {}): value is PendingInputRemovalResult {
  return object(value) && keys(value, [...removalKeys, "revision", "outcome", "runId"])
    && envelope(value, expected) && id(value.inputRequestId) && id(value.itemId) && integer(value.revision)
    && (value.outcome === "claimed" ? optionalId(value, "runId")
      : (value.outcome === "removed" || value.outcome === "already-removed") && !("runId" in value));
}
export function isPendingInputResumeRequest(value: unknown, expected: PendingInputValidation = {}): value is PendingInputResumeRequest {
  return object(value) && keys(value, ["version", "requestId", "conversationId", "action", "expectedRevision"])
    && envelope(value, expected) && value.action === "resume" && integer(value.expectedRevision);
}
