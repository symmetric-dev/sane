import type { DispatchIdentity } from "./dispatch-contract";

/** App request receipt only. None of these states describes transport delivery,
 * native acceptance, execution completion, or permission to retry. */
export type AppAdmissionState = "pending" | "admitted" | "rejected";
export type AppAdmissionJson = null | boolean | number | string | readonly AppAdmissionJson[] | { readonly [key: string]: AppAdmissionJson };
export type AppAdmissionOperation = "new-conversation" | "message" | "live-input" | "science-message";
/** Frozen browser expectation only, never native/source authority. Actual-source,
 * current-metadata and native-boundary guards remain mandatory. */
export type AppAdmissionExpectedSource = Readonly<{
  harnessId: "claude-code" | "opencode";
  authorityId: string;
  nativeSessionId: string;
  cwd: string;
}>;
export type AppAdmissionIntent = Readonly<{
  version: 1;
  operation: AppAdmissionOperation;
  /** Null only while creating a conversation. Exact lookup never needs this ID. */
  conversationId: string | null;
  /** Required exact tuple for existing conversations; null ONLY for creation.
   * Included in the frozen wire-intent hash, not an authority or adoption hint. */
  expectedSource: AppAdmissionExpectedSource | null;
  /** Frozen selected run for live input ONLY. Required UUID for live-input and
   * required null otherwise. A changed/finished run must reject, never fall back
   * to an initial send. This expectation is not native execution authority. */
  expectedLiveRunId: string | null;
  /** Stable browser draft/conversation lineage, not execution/admission authority. */
  chainId: string;
  /** Frozen ordinary wire body BEFORE POST, not a prepared prompt or text match.
   * Domain/science request IDs remain here, distinct from clientRequestId. */
  payload: Readonly<{ [key: string]: AppAdmissionJson }>;
}>;
export type AppAdmissionKey = Readonly<{ storeId: string; clientRequestId: string; payloadSha256: string }>;
export type AppAdmissionEnvelope = AppAdmissionKey & Readonly<{ version: 1; intent: AppAdmissionIntent }>;
export type AppAdmissionTarget = Readonly<{
  kind: "run-initial" | "live-input";
  dispatch: DispatchIdentity;
  /** Logical submission journal ID, e.g. runId:user. */
  messageId: string;
  /** Exact actual native UUID/command, REQUIRED also for CC live messages. */
  nativeMessageId: string;
}>;
export type AppAdmissionRejectionCode = "invalid-request" | "unsupported" | "conflict" | "unavailable" | "cancelled" | "preparation-refused";
export type AppAdmissionRejection = Readonly<{ code: AppAdmissionRejectionCode }>;
export type AppAdmissionReceipt = AppAdmissionKey & Readonly<{ version: 1 }> & (
  | Readonly<{ state: "pending"; target: null; rejection: null }>
  | Readonly<{ state: "admitted"; target: AppAdmissionTarget; rejection: null }>
  | Readonly<{ state: "rejected"; target: null; rejection: AppAdmissionRejection }>
);
export type AppAdmissionLookup = Readonly<{ kind: "found"; receipt: AppAdmissionReceipt }>
  /** Absence during a race is NOT proof of non-submission or permission to POST. */
  | Readonly<{ kind: "absent"; key: AppAdmissionKey }>;
export type AppAdmissionRecoveryScope = Readonly<{ version: 1; browserOrigin: string; storeId: string }>;

export const APP_ADMISSION_MAX_PAYLOAD_BYTES = 256_000;
const MAX_TOKEN_CHARS = 512;
/** Worst case: five free-form token occurrences (cwd, logical message ID,
 * command ID, native message ID, optional domain request ID), each at most six
 * JSON/UTF-8 bytes per UTF-16 code unit. All remaining fixed keys, enums, UUIDs,
 * authority/hash/session grammars fit within the additional 4096 bytes. Enforce
 * the bound in the codec too, so future shape changes cannot silently exceed a
 * pending request's durable terminal-capacity reservation. */
export const APP_ADMISSION_MAX_RECEIPT_BYTES = 5 * MAX_TOKEN_CHARS * 6 + 4096;
const id = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const token = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_TOKEN_CHARS && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
export class AppAdmissionCodecError extends Error {}
function check(ok: unknown, message = "Invalid App admission record"): asserts ok { if (!ok) throw new AppAdmissionCodecError(message); }
function shape(value: unknown, keys: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value));
  check(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  check(Reflect.ownKeys(value).every(key => typeof key === "string") && Object.values(descriptors).every(d => "value" in d && d.enumerable));
  check(keys.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => keys.includes(key) || optional.includes(key)));
}

/** Browser-safe strict canonical JSON: no node imports, dropped fields, custom
 * prototypes/getters, sparse arrays, nonfinite numbers, cycles or unbounded trees. */
export function canonicalAppAdmissionJSON(value: unknown): string {
  const ancestors = new Set<object>();
  let nodes = 0, budget = 0;
  const render = (item: unknown, depth: number): string => {
    check(++nodes <= 20_000 && depth <= 32, "App admission payload complexity exceeds the limit");
    let result: string;
    if (item === null || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) result = JSON.stringify(item);
    else if (typeof item === "string") {
      check(item.length <= APP_ADMISSION_MAX_PAYLOAD_BYTES, "App admission string exceeds the limit");
      result = JSON.stringify(item);
    } else {
      check(item !== null && typeof item === "object" && !ancestors.has(item), "Non-JSON App admission value");
      check(Array.isArray(item) ? Object.getPrototypeOf(item) === Array.prototype : Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null);
      check(Object.getOwnPropertySymbols(item).length === 0);
      check(Object.entries(Object.getOwnPropertyDescriptors(item)).every(([key, d]) => "value" in d && (d.enumerable || Array.isArray(item) && key === "length")));
      ancestors.add(item);
      if (Array.isArray(item)) {
        check(item.length <= 20_000 && Object.keys(item).length === item.length && Array.from({ length: item.length }, (_, i) => Object.hasOwn(item, i)).every(Boolean));
        const parts: string[] = [];
        for (let index = 0; index < item.length; index++) parts.push(render(item[index], depth + 1));
        result = `[${parts.join(",")}]`;
      } else result = `{${Object.keys(item).sort().map(key => {
        check(key.length <= 1024);
        budget += key.length;
        check(budget <= APP_ADMISSION_MAX_PAYLOAD_BYTES);
        return `${JSON.stringify(key)}:${render((item as Record<string, unknown>)[key], depth + 1)}`;
      }).join(",")}}`;
      ancestors.delete(item);
    }
    if (typeof item === "string") budget += result.length;
    check(budget <= APP_ADMISSION_MAX_PAYLOAD_BYTES && result.length <= APP_ADMISSION_MAX_PAYLOAD_BYTES, "App admission payload exceeds the limit");
    return result;
  };
  const text = render(value, 0);
  check(new TextEncoder().encode(text).byteLength <= APP_ADMISSION_MAX_PAYLOAD_BYTES, "App admission payload exceeds the byte limit");
  return text;
}
function frozen<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}
function copy<T>(value: T): T { return frozen(JSON.parse(canonicalAppAdmissionJSON(value)) as T); }

function checkSourceFields(value: Record<string, unknown>): void {
  const cc = value.harnessId === "claude-code";
  check(cc || value.harnessId === "opencode");
  check(token(value.authorityId) && new RegExp(`^sane-native-v1:${cc ? "cc" : "oc"}:[a-f0-9]{64}$`).test(value.authorityId));
  check(token(value.nativeSessionId) && (cc ? id(value.nativeSessionId) : /^ses[a-zA-Z0-9_-]{1,200}$/.test(value.nativeSessionId)));
  check(token(value.cwd) && value.cwd.startsWith("/"));
}
export function decodeAppAdmissionExpectedSource(value: unknown): AppAdmissionExpectedSource {
  shape(value, ["harnessId", "authorityId", "nativeSessionId", "cwd"]);
  checkSourceFields(value);
  return copy(value as AppAdmissionExpectedSource);
}
/** Exact tuple correlation of decoded sources, not current-source validation. */
export function appAdmissionExpectedSourceMatches(expected: AppAdmissionExpectedSource, actual: Pick<DispatchIdentity["source"], keyof AppAdmissionExpectedSource>): boolean {
  return expected.harnessId === actual.harnessId && expected.authorityId === actual.authorityId
    && expected.nativeSessionId === actual.nativeSessionId && expected.cwd === actual.cwd;
}

export function decodeAppAdmissionIntent(value: unknown): AppAdmissionIntent {
  shape(value, ["version", "operation", "conversationId", "expectedSource", "expectedLiveRunId", "chainId", "payload"]);
  check(value.version === 1 && ["new-conversation", "message", "live-input", "science-message"].includes(value.operation as string));
  check(id(value.chainId) && (value.conversationId === null || id(value.conversationId)));
  check((value.operation === "new-conversation") === (value.conversationId === null));
  if (value.operation === "new-conversation") check(value.expectedSource === null);
  else decodeAppAdmissionExpectedSource(value.expectedSource);
  check(value.operation === "live-input" ? id(value.expectedLiveRunId) : value.expectedLiveRunId === null);
  check(value.payload !== null && typeof value.payload === "object" && !Array.isArray(value.payload));
  return copy(value as AppAdmissionIntent);
}
export function decodeAppAdmissionKey(value: unknown): AppAdmissionKey {
  shape(value, ["storeId", "clientRequestId", "payloadSha256"]);
  check(id(value.storeId) && id(value.clientRequestId) && hash(value.payloadSha256));
  return copy(value as AppAdmissionKey);
}
export function decodeAppAdmissionEnvelope(value: unknown): AppAdmissionEnvelope {
  shape(value, ["version", "storeId", "clientRequestId", "payloadSha256", "intent"]);
  check(value.version === 1);
  const key = decodeAppAdmissionKey({ storeId: value.storeId, clientRequestId: value.clientRequestId, payloadSha256: value.payloadSha256 });
  const envelope = { version: 1 as const, ...key, intent: decodeAppAdmissionIntent(value.intent) };
  // Bound the entire persisted envelope at intake, not just its nested intent.
  // An expected request-size refusal must never become a storage failure later.
  canonicalAppAdmissionJSON(envelope);
  return frozen(envelope);
}
/** Hash exactly the immutable wire intent, not envelope identity/hash/store keys.
 * Text is never trimmed, normalized, matched, or replaced by prepared context. */
export function canonicalAppAdmissionPayload(intent: AppAdmissionIntent): string { return canonicalAppAdmissionJSON(decodeAppAdmissionIntent(intent)); }
export async function appAdmissionPayloadSha256(intent: AppAdmissionIntent): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalAppAdmissionPayload(intent));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}

export function decodeAppAdmissionTarget(value: unknown): AppAdmissionTarget {
  shape(value, ["kind", "dispatch", "messageId", "nativeMessageId"]);
  check(value.kind === "run-initial" || value.kind === "live-input");
  shape(value.dispatch, ["source", "runId", "nativeCommandId"], ["requestId"]);
  const dispatch = value.dispatch;
  shape(dispatch.source, ["harnessId", "sessionId", "authorityId", "nativeSessionId", "cwd"]);
  const source = dispatch.source, cc = source.harnessId === "claude-code";
  checkSourceFields(source);
  check(id(source.sessionId) && id(dispatch.runId) && (!Object.hasOwn(dispatch, "requestId") || token(dispatch.requestId)));
  check(cc ? dispatch.nativeCommandId === null : token(dispatch.nativeCommandId));
  check(token(value.messageId) && (cc ? id(value.nativeMessageId) : value.nativeMessageId === dispatch.nativeCommandId));
  check(value.kind !== "live-input" || cc);
  return copy(value as AppAdmissionTarget);
}
export function decodeAppAdmissionRejection(value: unknown): AppAdmissionRejection {
  shape(value, ["code"]);
  check(["invalid-request", "unsupported", "conflict", "unavailable", "cancelled", "preparation-refused"].includes(value.code as string));
  return copy(value as AppAdmissionRejection);
}
export function decodeAppAdmissionReceipt(value: unknown): AppAdmissionReceipt {
  shape(value, ["version", "storeId", "clientRequestId", "payloadSha256", "state", "target", "rejection"]);
  check(value.version === 1);
  decodeAppAdmissionKey({ storeId: value.storeId, clientRequestId: value.clientRequestId, payloadSha256: value.payloadSha256 });
  if (value.state === "pending") check(value.target === null && value.rejection === null);
  else if (value.state === "admitted") { decodeAppAdmissionTarget(value.target); check(value.rejection === null); }
  else { check(value.state === "rejected" && value.target === null); decodeAppAdmissionRejection(value.rejection); }
  check(new TextEncoder().encode(canonicalAppAdmissionJSON(value)).byteLength <= APP_ADMISSION_MAX_RECEIPT_BYTES, "App admission receipt exceeds its reserved byte limit");
  return copy(value as AppAdmissionReceipt);
}

/** Correlate a response/GET against the browser's ORIGINAL frozen pre-POST
 * envelope, never an envelope reconstructed from that response or text history.
 * New-conversation server binding is private: its source session can only be
 * learned from the exact admitted receipt, not guessed from a client hint.
 * This proves request/target correlation only, not native acceptance/completion. */
export function decodeAppAdmissionReceiptForIntent(value: unknown, original: AppAdmissionEnvelope): AppAdmissionReceipt {
  const envelope = decodeAppAdmissionEnvelope(original), receipt = decodeAppAdmissionReceipt(value);
  check(receipt.storeId === envelope.storeId && receipt.clientRequestId === envelope.clientRequestId && receipt.payloadSha256 === envelope.payloadSha256, "App admission receipt differs from the original request identity");
  if (receipt.state === "admitted") {
    const { intent } = envelope, { target } = receipt;
    check((intent.operation === "live-input") === (target.kind === "live-input"), "App admission receipt differs from the original message boundary");
    check(intent.conversationId === null || target.dispatch.source.sessionId === intent.conversationId, "App admission receipt differs from the original conversation");
    check(intent.expectedSource === null || appAdmissionExpectedSourceMatches(intent.expectedSource, target.dispatch.source), "App admission receipt differs from the frozen expected source");
    check(intent.operation !== "live-input" || target.dispatch.runId === intent.expectedLiveRunId, "App admission receipt differs from the frozen expected live run");
  }
  return receipt;
}

/** Scope browser recovery to BOTH this exact origin and App installation. An
 * absent GET or unknown pending receipt never authorizes another POST. */
export function appAdmissionRecoveryStorageKey(scope: AppAdmissionRecoveryScope): string {
  shape(scope, ["version", "browserOrigin", "storeId"]);
  check(scope.version === 1 && id(scope.storeId) && typeof scope.browserOrigin === "string");
  let origin: URL;
  try { origin = new URL(scope.browserOrigin); } catch { throw new AppAdmissionCodecError("Invalid App admission browser origin"); }
  check(["http:", "https:"].includes(origin.protocol) && origin.origin === scope.browserOrigin);
  return `sane.app-admission.v1:${encodeURIComponent(scope.browserOrigin)}:${scope.storeId}`;
}
