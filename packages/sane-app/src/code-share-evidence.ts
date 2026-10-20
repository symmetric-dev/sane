import type { NativeCodeShareRequest } from "../shared/code-share-contract";
import { parseCodeShareInput } from "../shared/code-share-contract";
import { canonicalJSON } from "./prepared-input-codec";
import { CodeShareError } from "./code-share-store";
import { nativeMessageId } from "./history";
import { openCodeTurnContext, type NativeMessage, type OpenCodeAdapter } from "./opencode";

export const denyCodeShareIdentity = (): never => { throw new CodeShareError(409, "code-share-identity", "Code share requires the exact evidenced invocation in an App-owned turn"); };
export function matchesCodeShareTool(request: NativeCodeShareRequest, name: unknown, input: unknown): boolean {
  if (request.invocation.wrapper === "execute") return request.caller.source.harness === "oc" && name === "execute";
  if (name !== "sane_share_code" && !(request.caller.source.harness === "cc" && name === "mcp__sane__sane_share_code")) return false;
  try { return canonicalJSON(parseCodeShareInput(input)) === canonicalJSON(request.input); } catch { return false; }
}
export function matchesCodeSharePart(request: NativeCodeShareRequest, messageId: string, part: { type?: string; id?: string; name?: string; state?: { status?: string; input?: unknown } }): boolean {
  return messageId === request.invocation.messageId && part.type === "tool" && part.id === request.invocation.toolCallId && part.state?.status === "running" && matchesCodeShareTool(request, part.name, part.state.input);
}
const terminal = (value: unknown) => typeof value === "string" && ["completed", "failed", "error", "interrupted", "cancelled"].includes(value);
function backgroundResult(message: NativeMessage): boolean {
  const m = message.metadata;
  if (!m || !terminal(m.state)) return false;
  if (m.source === "shell") return typeof m.shellID === "string" && /^sh_[a-zA-Z0-9]+$/.test(m.shellID) && (m.jobID === undefined || m.jobID === m.shellID);
  return m.source === "subagent" && typeof m.childID === "string" && /^ses_[a-zA-Z0-9]+$/.test(m.childID);
}
/** Shares in native continuations need the same precise command ancestry as
 * workers, but no repository enrollment or worker operation grants. Unknown
 * native inputs and arbitrary same-session tool calls are never authorization. */
export async function readCodeShareContinuation(oc: OpenCodeAdapter, request: NativeCodeShareRequest, assertCurrent: () => void) {
  const { nativeId, cwd } = request.caller;
  assertCurrent();
  const before = await oc.activity(nativeId, cwd);
  assertCurrent();
  if (!before.active || !Number.isFinite(before.session.time.created) || before.session.revert != null) return denyCodeShareIdentity();
  const descending: NativeMessage[] = [], ids = new Set<string>(), cursors = new Set<string>();
  let command: NativeMessage | undefined, cursor: string | undefined;
  const deadline = Date.now() + 15000;
  for (let page = 0; page < 100 && !command; page++) {
    assertCurrent();
    if (Date.now() >= deadline) return denyCodeShareIdentity();
    const result = await oc.request<{ data: NativeMessage[]; cursor: { next?: string | null } }>(oc.path(nativeId) + `/message?limit=100&${cursor ? `cursor=${encodeURIComponent(cursor)}` : "order=desc"}`);
    assertCurrent();
    if (!Array.isArray(result.data) || !result.cursor || result.data.length > 100) return denyCodeShareIdentity();
    for (const message of result.data) {
      if (!message || !nativeMessageId(message.id) || !Number.isFinite(message.time?.created) || ids.has(message.id)) return denyCodeShareIdentity();
      ids.add(message.id); descending.push(message);
      if (message.type === "user") { command = message; break; }
    }
    if (command) break;
    const next = result.cursor.next;
    if (!next || typeof next !== "string" || next.length > 8192 || cursors.has(next) || !result.data.length) return denyCodeShareIdentity();
    cursors.add(next); cursor = next;
  }
  if (!command) return denyCodeShareIdentity();
  const messages = descending.reverse(), target = messages.find(message => message.id === request.invocation.messageId);
  if (!target || target.type !== "assistant" || target.time.completed !== undefined || messages.findLast(message => message.type === "assistant") !== target || !target.content?.some(part => matchesCodeSharePart(request, target.id, part))) return denyCodeShareIdentity();
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
      if (reachedTarget || !backgroundResult(message) && !retry) return denyCodeShareIdentity();
      activated = true; continuationIds.push(message.id);
    } else if (message.type === "idle") {
      if (reachedTarget || message.outcome === "interrupted") return denyCodeShareIdentity();
      activated = false; afterIdle = true;
    } else if (message.type !== "assistant" && (reachedTarget || message.type !== "compaction" || message.reason !== "auto" || message.status !== "completed")) return denyCodeShareIdentity();
  }
  if (!activated || !continuationIds.length) return denyCodeShareIdentity();
  const after = await oc.activity(nativeId, cwd);
  assertCurrent();
  if (!after.active || after.session.revert != null || before.session.time.created !== after.session.time.created || before.session.time.updated !== after.session.time.updated) return denyCodeShareIdentity();
  return { commandId: command.id, messageId: target.id, toolCallId: request.invocation.toolCallId, continuationIds, afterIdle, nativeCreatedAt: after.session.time.created };
}
