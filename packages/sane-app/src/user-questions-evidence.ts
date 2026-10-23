import type { NativeUserQuestionsRequest } from "../../sane-cli/src/native-user-questions-contract";
import { parsePresentQuestionsInput } from "../shared/user-questions-contract";
import { canonicalJSON } from "./prepared-input-codec";
import { UserQuestionsError } from "./user-questions-store";
import { nativeMessageId } from "./history";
import { openCodeTurnContext, type NativeMessage, type OpenCodeAdapter } from "./opencode";

export const denyUserQuestionsIdentity = (): never => { throw new UserQuestionsError(409, "user-questions-identity", "Presenting questions requires the exact evidenced invocation in an App-owned turn"); };
export function matchesUserQuestionsTool(request: NativeUserQuestionsRequest, name: unknown, input: unknown): boolean {
  if (request.invocation.wrapper === "execute") return request.caller.source.harness === "oc" && name === "execute";
  if (name !== "present_questions_to_user" && !(request.caller.source.harness === "cc" && name === "mcp__sane__present_questions_to_user")) return false;
  try { return canonicalJSON(parsePresentQuestionsInput(input)) === canonicalJSON(request.input); } catch { return false; }
}
export function matchesUserQuestionsPart(request: NativeUserQuestionsRequest, messageId: string, part: { type?: string; id?: string; name?: string; state?: { status?: string; input?: unknown } }): boolean {
  return messageId === request.invocation.messageId && part.type === "tool" && part.id === request.invocation.toolCallId && part.state?.status === "running" && matchesUserQuestionsTool(request, part.name, part.state.input);
}
const terminal = (value: unknown) => typeof value === "string" && ["completed", "failed", "error", "interrupted", "cancelled"].includes(value);
function backgroundResult(message: NativeMessage): boolean {
  const m = message.metadata;
  if (!m || !terminal(m.state)) return false;
  if (m.source === "shell") return typeof m.shellID === "string" && /^sh_[a-zA-Z0-9]+$/.test(m.shellID) && (m.jobID === undefined || m.jobID === m.shellID);
  return m.source === "subagent" && typeof m.childID === "string" && /^ses_[a-zA-Z0-9]+$/.test(m.childID);
}

/** Native background continuations are authorized against their original App
 * command, never merely against a session ID or the latest transcript text. */
export async function readUserQuestionsContinuation(oc: OpenCodeAdapter, request: NativeUserQuestionsRequest, assertCurrent: () => void) {
  const { nativeId, cwd } = request.caller;
  assertCurrent();
  const before = await oc.activity(nativeId, cwd);
  assertCurrent();
  if (!before.active || !Number.isFinite(before.session.time.created) || before.session.revert != null) return denyUserQuestionsIdentity();
  const descending: NativeMessage[] = [], ids = new Set<string>(), cursors = new Set<string>();
  let command: NativeMessage | undefined, cursor: string | undefined;
  const deadline = Date.now() + 15000;
  for (let page = 0; page < 100 && !command; page++) {
    assertCurrent();
    if (Date.now() >= deadline) return denyUserQuestionsIdentity();
    const result = await oc.request<{ data: NativeMessage[]; cursor: { next?: string | null } }>(oc.path(nativeId) + `/message?limit=100&${cursor ? `cursor=${encodeURIComponent(cursor)}` : "order=desc"}`);
    assertCurrent();
    if (!Array.isArray(result.data) || !result.cursor || result.data.length > 100) return denyUserQuestionsIdentity();
    for (const message of result.data) {
      if (!message || !nativeMessageId(message.id) || !Number.isFinite(message.time?.created) || ids.has(message.id)) return denyUserQuestionsIdentity();
      ids.add(message.id); descending.push(message);
      if (message.type === "user") { command = message; break; }
    }
    if (command) break;
    const next = result.cursor.next;
    if (!next || typeof next !== "string" || next.length > 8192 || cursors.has(next) || !result.data.length) return denyUserQuestionsIdentity();
    cursors.add(next); cursor = next;
  }
  if (!command) return denyUserQuestionsIdentity();
  const messages = descending.reverse(), target = messages.find(message => message.id === request.invocation.messageId);
  if (!target || target.type !== "assistant" || target.time.completed !== undefined || messages.findLast(message => message.type === "assistant") !== target || !target.content?.some(part => matchesUserQuestionsPart(request, target.id, part))) return denyUserQuestionsIdentity();
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
      if (reachedTarget || !backgroundResult(message) && !retry) return denyUserQuestionsIdentity();
      activated = true; continuationIds.push(message.id);
    } else if (message.type === "idle") {
      if (reachedTarget || message.outcome === "interrupted") return denyUserQuestionsIdentity();
      activated = false; afterIdle = true;
    } else if (message.type !== "assistant" && (reachedTarget || message.type !== "compaction" || message.reason !== "auto" || message.status !== "completed")) return denyUserQuestionsIdentity();
  }
  if (!activated || !continuationIds.length) return denyUserQuestionsIdentity();
  const after = await oc.activity(nativeId, cwd);
  assertCurrent();
  if (!after.active || after.session.revert != null || before.session.time.created !== after.session.time.created || before.session.time.updated !== after.session.time.updated) return denyUserQuestionsIdentity();
  return { commandId: command.id, messageId: target.id, toolCallId: request.invocation.toolCallId, continuationIds, afterIdle, nativeCreatedAt: after.session.time.created };
}
