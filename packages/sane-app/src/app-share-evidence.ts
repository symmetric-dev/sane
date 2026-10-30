import type { NativeSourceDescriptor } from "sane-core/contracts";
import { canonicalJSON } from "./prepared-input-codec";
import { nativeMessageId } from "./history";
import { openCodeTurnContext, type NativeMessage, type OpenCodeAdapter } from "./opencode";

export interface AppShareInvocation {
  caller: { source: NativeSourceDescriptor; authorityId: string; nativeId: string; cwd: string };
  invocation: { toolCallId: string; messageId?: string; invocationId: string; wrapper?: "execute" };
  input: unknown;
}
type NativePart = { type?: string; id?: string; name?: string; state?: { status?: string; input?: unknown } };
const terminal = (value: unknown) => typeof value === "string" && ["completed", "failed", "error", "interrupted", "cancelled"].includes(value);
function backgroundResult(message: NativeMessage): boolean {
  const m = message.metadata;
  if (!m || !terminal(m.state)) return false;
  if (m.source === "shell") return typeof m.shellID === "string" && /^sh_[a-zA-Z0-9]+$/.test(m.shellID) && (m.jobID === undefined || m.jobID === m.shellID);
  return m.source === "subagent" && typeof m.childID === "string" && /^ses_[a-zA-Z0-9]+$/.test(m.childID);
}

/** Tool-specific parsers and a closed tool-name set preserve exact invocation
 * authority. Sharing is not authorized by a bearer or a same-session tool alone. */
export function createAppShareEvidence(options: {
  toolName: "sane_share_code" | "sane_share_media";
  parseInput: (input: unknown) => unknown;
  deny: () => never;
}) {
  const { toolName, parseInput, deny } = options;
  function matchesTool(request: AppShareInvocation, name: unknown, input: unknown): boolean {
    if (request.invocation.wrapper === "execute") return request.caller.source.harness === "oc" && name === "execute";
    if (name !== toolName && !(request.caller.source.harness === "cc" && name === `mcp__sane__${toolName}`)) return false;
    try { return canonicalJSON(parseInput(input)) === canonicalJSON(request.input); } catch { return false; }
  }
  function matchesPart(request: AppShareInvocation, messageId: string, part: NativePart): boolean {
    return messageId === request.invocation.messageId && part.type === "tool" && part.id === request.invocation.toolCallId && part.state?.status === "running" && matchesTool(request, part.name, part.state.input);
  }
  /** Native continuations require exact command ancestry, never arbitrary
   * same-session activity or permission to replay a completed tool. */
  async function readContinuation(oc: OpenCodeAdapter, request: AppShareInvocation, assertCurrent: () => void) {
    const { nativeId, cwd } = request.caller;
    assertCurrent();
    const before = await oc.activity(nativeId, cwd);
    assertCurrent();
    if (!before.active || !Number.isFinite(before.session.time.created) || before.session.revert != null) return deny();
    const descending: NativeMessage[] = [], ids = new Set<string>(), cursors = new Set<string>();
    let command: NativeMessage | undefined, cursor: string | undefined;
    const deadline = Date.now() + 15000;
    for (let page = 0; page < 100 && !command; page++) {
      assertCurrent();
      if (Date.now() >= deadline) return deny();
      const result = await oc.request<{ data: NativeMessage[]; cursor: { next?: string | null } }>(oc.path(nativeId) + `/message?limit=100&${cursor ? `cursor=${encodeURIComponent(cursor)}` : "order=desc"}`);
      assertCurrent();
      if (!Array.isArray(result.data) || !result.cursor || result.data.length > 100) return deny();
      for (const message of result.data) {
        if (!message || !nativeMessageId(message.id) || !Number.isFinite(message.time?.created) || ids.has(message.id)) return deny();
        ids.add(message.id); descending.push(message);
        if (message.type === "user") { command = message; break; }
      }
      if (command) break;
      const next = result.cursor.next;
      if (!next || typeof next !== "string" || next.length > 8192 || cursors.has(next) || !result.data.length) return deny();
      cursors.add(next); cursor = next;
    }
    if (!command) return deny();
    const messages = descending.reverse(), target = messages.find(message => message.id === request.invocation.messageId);
    if (!target || target.type !== "assistant" || target.time.completed !== undefined || messages.findLast(message => message.type === "assistant") !== target || !target.content?.some(part => matchesPart(request, target.id, part))) return deny();
    const continuationIds: string[] = [];
    let activated = false, afterIdle = false, reachedTarget = false;
    for (let index = 1; index < messages.length; index++) {
      const message = messages[index]!;
      if (message === target) { reachedTarget = true; continue; }
      if (message.type === "synthetic") {
        if (openCodeTurnContext(message, command)) {
          if (message.metadata?.notice === "restart" && !reachedTarget) { activated = true; continuationIds.push(message.id); }
          continue;
        }
        const retry = message.metadata === undefined && !!messages[index - 1]?.error && messages[index - 1]?.type === "assistant" && message.text === "The previous response was interrupted. Continue from where you left off without repeating completed content.";
        if (reachedTarget || !backgroundResult(message) && !retry) return deny();
        activated = true; continuationIds.push(message.id);
      } else if (message.type === "idle") {
        if (reachedTarget || message.outcome === "interrupted") return deny();
        activated = false; afterIdle = true;
      } else if (message.type !== "assistant" && (reachedTarget || message.type !== "compaction" || message.reason !== "auto" || message.status !== "completed")) return deny();
    }
    if (!activated || !continuationIds.length) return deny();
    const after = await oc.activity(nativeId, cwd);
    assertCurrent();
    if (!after.active || after.session.revert != null || before.session.time.created !== after.session.time.created || before.session.time.updated !== after.session.time.updated) return deny();
    return { commandId: command.id, messageId: target.id, toolCallId: request.invocation.toolCallId, continuationIds, afterIdle, nativeCreatedAt: after.session.time.created };
  }
  return { matchesTool, matchesPart, readContinuation };
}
