import { isPendingInputRequest, isPendingInputSnapshot, isPendingInputSubmissionResult, isPendingInputResumeRequest, type PendingInputConfiguration, type PendingInputEnqueueReceipt, type PendingInputResumeRequest, type PendingInputSnapshot, type PendingInputSource } from "../shared/conversation/pending-input-contract";

export type PendingInputClassification = "waiting" | "claimed" | "run-linked" | "removed" | "settled" | "uncertain";
export type PendingInputView = {
  snapshot: PendingInputSnapshot;
  presentation: {
    maxWaiting: 3; waitingCount: number; chainLocked: boolean; chainId: string | null;
    source: PendingInputSource | null; configuration: PendingInputConfiguration | null;
    currentAssertions: { source: PendingInputSource; configuration: PendingInputConfiguration } | null;
    removals: { itemId: string; allowed: boolean; code: string | null }[];
    unresolved: { itemId: string; requestId: string; runId?: string; classification: PendingInputClassification } | null;
    pauseCode: string | null; enqueue: { allowed: boolean; code: string | null; reason: string | null };
    removalAllowed: boolean; resumeAllowed: boolean; automation: { supported: boolean; reason: string | null }; hidden: boolean;
  };
};
export type PendingInputOperation = {
  requestId: string; conversationId: string; kind: "enqueue" | "remove" | "resume";
  state: "pending" | "unknown" | "confirmed" | "rejected"; text?: string; error?: string;
};
export type PendingInputResumeResult = PendingInputResumeRequest & { outcome: "resumed"; revision: number };
export type PendingInputStatus = {
  version: 1; conversationId: string; requestId: string; receipt: PendingInputEnqueueReceipt;
  classification: PendingInputClassification; itemId: string; sequence: number; runId?: string; nativeCommandId?: string | null;
};
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, any>, keys: string[]) => Object.keys(v).every(key => keys.includes(key));
const token = (v: unknown): v is string => typeof v === "string" && !!v && v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v);
const nullable = (v: unknown) => v === null || token(v);
const nullableText = (v: unknown) => v === null || typeof v === "string";
const sameFields = (a: Record<string, unknown>, b: Record<string, unknown>) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => a[key] === b[key]);
const integer = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const classification = (v: unknown): v is PendingInputClassification => ["waiting", "claimed", "run-linked", "removed", "settled", "uncertain"].includes(v as string);
const assertions = (v: unknown, id: string) => object(v) && exact(v, ["source", "configuration"])
  && isPendingInputRequest({ version: 1, conversationId: id, requestId: "inspection", text: "inspection", ...v }, { conversationId: id });

/** GET is a bare server projection. Never infer policy from native/staged UI settings. */
export function isPendingInputView(value: unknown, conversationId: string): value is PendingInputView {
  if (!object(value) || !exact(value, ["snapshot", "presentation"]) || !isPendingInputSnapshot(value.snapshot, { conversationId }) || !object(value.presentation)) return false;
  const p = value.presentation, s = value.snapshot;
  if (!exact(p, ["maxWaiting", "waitingCount", "chainLocked", "chainId", "source", "configuration", "currentAssertions", "removals", "unresolved", "pauseCode", "enqueue", "removalAllowed", "resumeAllowed", "automation", "hidden"])
    || p.maxWaiting !== 3 || p.waitingCount !== s.items.filter(i => i.state === "waiting").length
    || typeof p.chainLocked !== "boolean" || !nullable(p.chainId) || p.chainLocked !== (p.chainId !== null) || p.chainLocked !== (s.items.length > 0)
    || !nullable(p.pauseCode) || ![p.removalAllowed, p.resumeAllowed, p.hidden].every(v => typeof v === "boolean")) return false;
  if (p.source === null || p.configuration === null) { if (p.source !== null || p.configuration !== null) return false; }
  else if (!assertions({ source: p.source, configuration: p.configuration }, conversationId)) return false;
  if (p.chainLocked && (!p.source || !p.configuration || !sameFields(p.source, s.items[0]!.source) || !sameFields(p.configuration, s.items[0]!.configuration))) return false;
  if (p.currentAssertions !== null && !assertions(p.currentAssertions, conversationId)) return false;
  if (!object(p.enqueue) || !exact(p.enqueue, ["allowed", "code", "reason"]) || typeof p.enqueue.allowed !== "boolean" || !nullable(p.enqueue.code) || !nullableText(p.enqueue.reason)
    || p.enqueue.allowed && (p.currentAssertions === null || p.waitingCount >= 3)
    || !object(p.automation) || !exact(p.automation, ["supported", "reason"]) || typeof p.automation.supported !== "boolean" || !nullableText(p.automation.reason)
    || p.resumeAllowed && (!p.removalAllowed || p.waitingCount === 0 || p.unresolved !== null)) return false;
  if (!Array.isArray(p.removals) || p.removals.length !== s.items.length || !p.removals.every((r: unknown, i: number) => object(r) && exact(r, ["itemId", "allowed", "code"])
    && r.itemId === s.items[i]!.itemId && typeof r.allowed === "boolean" && nullable(r.code) && (!r.allowed || p.removalAllowed && s.items[i]!.state === "waiting"))) return false;
  const head = s.items.find(i => i.state !== "waiting"), u = p.unresolved;
  return head ? object(u) && exact(u, ["itemId", "requestId", "runId", "classification"]) && u.itemId === head.itemId && u.requestId === head.requestId
    && u.runId === head.runId && classification(u.classification) : u === null;
}
export function isPendingInputStatus(value: unknown, conversationId: string, requestId: string): value is PendingInputStatus {
  return object(value) && exact(value, ["version", "conversationId", "requestId", "receipt", "classification", "itemId", "sequence", "runId", "nativeCommandId"])
    && value.version === 1 && value.conversationId === conversationId && value.requestId === requestId
    && isPendingInputSubmissionResult(value.receipt, { conversationId, requestId }) && value.receipt.outcome === "enqueued"
    && value.itemId === value.receipt.itemId && value.sequence === value.receipt.sequence && classification(value.classification)
    && (!("runId" in value) || token(value.runId)) && (!("nativeCommandId" in value) || nullable(value.nativeCommandId));
}
export function isPendingInputResumeResult(value: unknown, request: PendingInputResumeRequest): value is PendingInputResumeResult {
  if (!object(value) || !exact(value, ["version", "conversationId", "requestId", "action", "expectedRevision", "outcome", "revision"])) return false;
  const { outcome, revision, ...body } = value;
  return outcome === "resumed" && integer(revision) && isPendingInputResumeRequest(body, request)
    && body.expectedRevision === request.expectedRevision;
}
