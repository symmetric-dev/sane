import type { SessionEventDurable, SessionLogOutput } from "@opencode/client";
import { updateOccurrenceId, updateSourceKey, type ConversationUpdateCandidate, type ConversationUpdateSource } from "./conversation-updates";

export const OC_REPLY_UNQUALIFIED_REASON = "Exact final-parent-reply controlflow needs runtime verification";
export const OC_REPLY_MAX_MESSAGES = 4096;
const MAX_PARTS = 1024, MAX_PENDING = 256;

export type OpenCodeReplyInputKind = "user" | "synthetic" | "control";
/** Installed synthetics have text/description/arbitrary metadata, but no typed
 * child-result origin. Do not invent a worker/subagent metadata whitelist. The
 * two control notices below are evidenced by the existing adapter contract. */
export function openCodeSyntheticKind(payload: { text: string; metadata?: Record<string, unknown> }): "synthetic" | "control" {
  return payload.metadata?.sane === "framework"
    || payload.metadata?.notice === "restart" && payload.text === "The server restarted while you were working. Continue from where you left off without repeating completed work."
    ? "control" : "synthetic";
}
export class OpenCodeReplyReconstructionLimitError extends Error {
  constructor(public readonly reason: "pending-inbox" | "message-identities") {
    super(reason === "pending-inbox" ? "Unsupported reconstruction: more than 256 pending inbox entries" : "Unsupported reconstruction: more than 4096 message identities; an evidenced replay baseline is required");
  }
}

export type OpenCodeCreationIdentity = { eventId: string; createdAt: number };
export function openCodeIncarnation(identity: OpenCodeCreationIdentity): string {
  if (!id(identity.eventId) || !time(identity.createdAt)) throw new TypeError("Invalid native creation identity");
  return JSON.stringify([identity.eventId, identity.createdAt]);
}
type Step = {
  messageId: string;
  generationId: string;
  generation: number;
  status: "running" | "stop" | "other" | "failed";
  texts: { complete: boolean; nonempty: boolean }[];
  tool: boolean;
  unsafe: boolean;
  retryAllowed: boolean;
};
/** JSON-serializable, bounded reconstruction, not a transcript/text cache. */
export type OpenCodeReplyState = {
  version: 1;
  sourceKey: string;
  creation: OpenCodeCreationIdentity;
  seq: number;
  created: boolean;
  parent: boolean;
  deleted: boolean;
  seenMessages: string[];
  pending: Record<string, OpenCodeReplyInputKind>;
  delivered?: OpenCodeReplyInputKind;
  window?: { id: string; eligible: boolean; compacting: boolean; input?: OpenCodeReplyInputKind; step?: Step };
};
export type OpenCodeReplyBinding = {
  conversationId: string;
  source: ConversationUpdateSource;
  creation: OpenCodeCreationIdentity;
};
export function initialOpenCodeReplyState(binding: OpenCodeReplyBinding): OpenCodeReplyState {
  if (binding.source.harness !== "opencode" || binding.source.incarnation !== openCodeIncarnation(binding.creation)) throw new TypeError("OpenCode source must include its native creation identity");
  return { version: 1, sourceKey: updateSourceKey(binding.source), creation: { ...binding.creation }, seq: 0, created: false, parent: false, deleted: false, seenMessages: [], pending: {} };
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(v);
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const time = (v: unknown): v is number => typeof v === "number" && v >= 0 && Number.isFinite(new Date(v).getTime());
function requireShape(ok: unknown): asserts ok { if (!ok) throw new TypeError("Unsupported or incomplete OpenCode durable reply log"); }

// Installed @opencode/client 2.0.18 SessionEventDurable versions. Live deltas
// and session.idle are deliberately absent: neither is the durable boundary.
const versions: Record<string, number> = {
  "session.created": 1, "session.agent.selected": 1, "session.model.selected": 1,
  "session.moved": 1, "session.renamed": 1, "session.metadata.updated": 1,
  "session.permissions": 1, "session.viewed": 1, "session.deleted": 2, "session.forked": 2,
  "session.inbox.delivered": 1, "session.inbox.enqueued": 1, "session.inbox.cancelled": 1,
  "session.inbox.delivery.changed": 1, "session.execution.started": 1,
  "session.execution.succeeded": 1, "session.execution.failed": 1, "session.execution.interrupted": 1,
  "session.instructions.updated": 2, "session.synthetic": 1, "session.skill.activated": 1,
  "session.shell.started": 1, "session.shell.ended": 1, "session.step.started": 1,
  "session.step.streamed": 1, "session.step.ended": 1, "session.step.failed": 1,
  "session.text.started": 1, "session.text.ended": 1, "session.reasoning.started": 1,
  "session.reasoning.ended": 1, "session.tool.input.started": 1, "session.tool.input.ended": 1,
  "session.tool.called": 1, "session.tool.success": 2, "session.tool.failed": 2,
  "session.retry.scheduled": 1, "session.compaction.started": 1, "session.compaction.ended": 1,
  "session.compaction.failed": 1, "session.revert.staged": 1, "session.revert.cleared": 1,
  "session.revert.committed": 1, "session.usage.recorded": 1, "session.message.content.updated": 1,
};
/** SDK Promise streams parse JSON but do not validate native event schemas. */
export function openCodeLogItem(raw: unknown, nativeSessionId: string): SessionLogOutput {
  requireShape(object(raw));
  if (raw.type === "log.synced") {
    requireShape(raw.aggregateID === nativeSessionId && (raw.seq === undefined || integer(raw.seq)));
    return raw as SessionLogOutput;
  }
  requireShape(typeof raw.type === "string" && Object.hasOwn(versions, raw.type) && id(raw.id) && time(raw.created)
    && object(raw.durable) && raw.durable.aggregateID === nativeSessionId
    && integer(raw.durable.seq) && raw.durable.seq > 0 && raw.durable.version === versions[raw.type]
    && object(raw.data) && raw.data.sessionID === nativeSessionId);
  const d = raw.data, type = raw.type;
  if (type.startsWith("session.step.") || type.startsWith("session.text.") || type.startsWith("session.reasoning.") || type.startsWith("session.tool.") || type === "session.retry.scheduled") requireShape(id(d.assistantMessageID));
  if (type === "session.text.started" || type === "session.text.ended") requireShape(integer(d.ordinal) && d.ordinal < MAX_PARTS);
  if (type === "session.text.ended") requireShape(typeof d.text === "string");
  if (type === "session.step.ended") requireShape(["stop", "length", "tool-calls", "content-filter", "error", "unknown"].includes(d.finish as string));
  if (type === "session.execution.interrupted") requireShape(["user", "shutdown", "superseded", "inactivity"].includes(d.reason as string));
  if (type === "session.created") requireShape(d.parentID === undefined || id(d.parentID));
  if (type.startsWith("session.inbox.")) requireShape(id(d.inboxID));
  if (type === "session.synthetic") requireShape(typeof d.text === "string" && (d.metadata === undefined || object(d.metadata)));
  if (type === "session.inbox.enqueued") {
    requireShape(object(d.item) && ["user", "synthetic", "compaction", "move"].includes(d.item.type as string));
    if (d.item.type === "synthetic") requireShape(object(d.item.payload) && typeof d.item.payload.text === "string" && (d.item.payload.metadata === undefined || object(d.item.payload.metadata)));
  }
  if (type === "session.message.content.updated") {
    requireShape(id(d.messageID) && Array.isArray(d.content) && d.content.length <= MAX_PARTS);
    for (const part of d.content) requireShape(object(part) && (["text", "reasoning"].includes(part.type as string) ? typeof part.text === "string" : part.type === "tool" && id(part.id)));
  }
  return raw as SessionEventDurable;
}

/** Pure event-time reduction. No message GET can supply text for a past terminal.
 * A terminal consumes its window even when suppressed, so later edits cannot
 * revise it by borrowing current mutable content. */
export function reduceOpenCodeReply(previous: OpenCodeReplyState, raw: unknown, binding: OpenCodeReplyBinding, historical = false): { state: OpenCodeReplyState; candidate?: ConversationUpdateCandidate } {
  requireShape(previous.version === 1 && previous.sourceKey === updateSourceKey(binding.source)
    && openCodeIncarnation(previous.creation) === openCodeIncarnation(binding.creation)
    && binding.source.incarnation === openCodeIncarnation(binding.creation));
  const event = openCodeLogItem(raw, binding.source.nativeSessionId);
  requireShape(event.type !== "log.synced");
  requireShape(event.durable.seq === previous.seq + 1);
  const state = structuredClone(previous);
  state.seq = event.durable.seq;
  if (event.type === "session.created") {
    requireShape(!state.created && previous.seq === 0 && event.id === binding.creation.eventId && event.created === binding.creation.createdAt);
    state.created = true;
    state.parent = event.data.parentID === undefined;
    return { state };
  }
  requireShape(state.created && !state.deleted);
  const window = state.window, step = window?.step;
  if (event.type === "session.inbox.enqueued") {
    if (Object.keys(state.pending).length >= MAX_PENDING) throw new OpenCodeReplyReconstructionLimitError("pending-inbox");
    requireShape(!Object.hasOwn(state.pending, event.data.inboxID));
    const item = event.data.item;
    state.pending[event.data.inboxID] = item.type === "user" ? "user" : item.type === "synthetic" ? openCodeSyntheticKind(item.payload) : "control";
  } else if (event.type === "session.inbox.cancelled") delete state.pending[event.data.inboxID];
  else if (event.type === "session.inbox.delivered") {
    state.delivered = Object.hasOwn(state.pending, event.data.inboxID) ? state.pending[event.data.inboxID] : undefined;
    delete state.pending[event.data.inboxID];
    // Input is not attention, nor does it invalidate later parent model output.
    // Clear the previous step so an input-only terminal cannot borrow its text.
    if (window) { window.input = state.delivered; window.step = undefined; }
  } else if (event.type === "session.execution.started") {
    // The durable parent execution boundary is sufficient. Native background
    // result continuations need not have an App/user admission or even an inbox
    // delivery. A stop step still must be reconstructed wholly in this window.
    state.window = { id: event.id, eligible: !window && state.parent, compacting: false, input: state.delivered };
    delete state.delivered;
  } else if (event.type === "session.synthetic") {
    const kind = openCodeSyntheticKind(event.data);
    if (window) { window.input = kind; window.step = undefined; }
    else state.delivered = kind;
  } else if (event.type === "session.step.started" && window) {
    const reused = state.seenMessages.includes(event.data.assistantMessageID);
    const retry = reused && step?.messageId === event.data.assistantMessageID && step.status === "failed" && step.retryAllowed;
    if (!reused) {
      if (state.seenMessages.length >= OC_REPLY_MAX_MESSAGES) throw new OpenCodeReplyReconstructionLimitError("message-identities");
      state.seenMessages.push(event.data.assistantMessageID);
    }
    window.step = { messageId: event.data.assistantMessageID, generationId: event.id,
      generation: retry ? step!.generation + 1 : 1, status: "running", texts: [], tool: false,
      unsafe: window.compacting || reused && !retry || !!step && step.status === "running", retryAllowed: false };
  } else if (event.type === "session.message.content.updated") {
    if (step && step.messageId === event.data.messageID) {
      // Replacement, never append; array order is the installed content ordinal.
      step.texts = event.data.content.map(part => ({ complete: true, nonempty: part.type === "text" && part.text.trim().length > 0 }));
      step.tool ||= event.data.content.some(part => part.type === "tool");
    }
  } else if ("assistantMessageID" in event.data && step) {
    if (event.data.assistantMessageID !== step.messageId) {
      // Out-of-generation text/step activity cannot update the latest step.
      if (event.type === "session.text.started" || event.type === "session.text.ended" || event.type === "session.step.ended" || event.type === "session.step.failed") step.unsafe = true;
    } else if (event.type === "session.text.started") {
      if (step.status !== "running" || step.texts[event.data.ordinal]) step.unsafe = true;
      step.texts[event.data.ordinal] = { complete: false, nonempty: false };
    } else if (event.type === "session.text.ended") {
      if (step.status !== "running" || !step.texts[event.data.ordinal] || step.texts[event.data.ordinal]!.complete) step.unsafe = true;
      step.texts[event.data.ordinal] = { complete: true, nonempty: event.data.text.trim().length > 0 };
    } else if (event.type === "session.step.ended") {
      if (step.status !== "running") step.unsafe = true;
      step.status = event.data.finish === "stop" ? "stop" : "other";
    } else if (event.type === "session.step.failed") step.status = "failed";
    else if (event.type === "session.retry.scheduled") step.retryAllowed = step.status === "failed";
    else if (event.type.startsWith("session.tool.")) step.tool = true;
  }
  if (window && event.type === "session.compaction.started") { window.compacting = true; window.step = undefined; }
  if (window && (event.type === "session.compaction.ended" || event.type === "session.compaction.failed")) { window.compacting = false; window.step = undefined; }
  if (window && ["session.shell.started", "session.revert.staged", "session.revert.committed", "session.forked", "session.moved"].includes(event.type)) { window.eligible = false; window.step = undefined; }
  if (event.type === "session.deleted") { state.deleted = true; delete state.window; }
  if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed" || event.type === "session.execution.interrupted") {
    delete state.window;
    delete state.delivered;
    if (!window?.eligible || window.compacting) return { state };
    const success = event.type === "session.execution.succeeded";
    const last = window.step;
    if (success && (!last || last.status !== "stop" || last.unsafe || last.tool || !last.texts.some(p => p?.nonempty) || last.texts.some(p => p && !p.complete))) return { state };
    // Framework/restart/compaction/control-only boundaries are not attention.
    // Unknown input can produce a reply through model evidence, but without
    // such evidence its error/control terminal is conservatively suppressed.
    if (!success && (last?.unsafe || !last && window.input !== "user")) return { state };
    // Shutdown is continuation, not user attention; superseding is ambiguous.
    if (event.type === "session.execution.interrupted" && !["user", "inactivity"].includes(event.data.reason)) return { state };
    const candidate: ConversationUpdateCandidate = {
      id: updateOccurrenceId(binding.source, event.id), conversationId: binding.conversationId,
      source: { ...binding.source }, kind: success ? "reply" : event.type === "session.execution.failed" ? "failed" : "interrupted",
      nativeBoundaryId: event.id, occurredAt: new Date(event.created).toISOString(), sourceSequence: event.durable.seq,
      ...(success ? { messageId: last!.messageId } : {}), ...(historical ? { historical: true } : {}),
    };
    return { state, candidate };
  }
  return { state };
}
