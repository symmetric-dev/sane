import { matchesOpenCodeWorkerPart, type NativeWorkerInvocation, type NativeWorkerOperation } from "../../sane-cli/src/native-worker-contract";
import { nativeMessageId } from "./history";
import { OpenCodeError, openCodeTurnContext, type NativeMessage, type OpenCodeAdapter } from "./opencode";

export type OpenCodeWorkerContinuation = {
  commandId: string;
  messageId: string;
  toolCallId: string;
  continuationIds: string[];
  afterIdle: boolean;
  nativeCreatedAt: number;
  revert: string;
};

const reject = (): never => { throw new OpenCodeError("No live worker invocation in a supported native continuation", 409); };
const terminal = (state: unknown) => typeof state === "string" && ["completed", "failed", "error", "interrupted", "cancelled"].includes(state);
function backgroundResult(message: NativeMessage): boolean {
  const metadata = message.metadata;
  if (!metadata || !terminal(metadata.state)) return false;
  if (metadata.source === "shell") return typeof metadata.shellID === "string" && /^sh_[a-zA-Z0-9]+$/.test(metadata.shellID)
    && (metadata.jobID === undefined || metadata.jobID === metadata.shellID);
  return metadata.source === "subagent" && typeof metadata.childID === "string" && /^ses_[a-zA-Z0-9]+$/.test(metadata.childID);
}

/** Worker authorization only, not command completion or queued-input delivery
 * evidence. A native callback can be live after an App command has completed.
 * Bind it to the actual preceding user command, never the App's latest Run.
 * Unknown inputs, old/completed tool calls and foreign user commands cannot
 * acquire this capability. The bridge must map commandId to an existing Run. */
export async function readOpenCodeWorkerContinuation(
  oc: Pick<OpenCodeAdapter, "activity" | "request" | "path">,
  nativeId: string, cwd: string, operation: NativeWorkerOperation,
  invocation: NativeWorkerInvocation, assertCurrent: () => void,
): Promise<OpenCodeWorkerContinuation> {
  if (!invocation.messageId || !invocation.opencode || invocation.opencode.operation !== operation) return reject();
  assertCurrent();
  const before = await oc.activity(nativeId, cwd);
  assertCurrent();
  if (!before.active || !Number.isFinite(before.session.time.created)) return reject();
  const revert = (session: typeof before.session) => JSON.stringify((session as typeof session & { revert?: unknown }).revert ?? null);
  const descending: NativeMessage[] = [], ids = new Set<string>(), cursors = new Set<string>();
  let cursor: string | undefined, command: NativeMessage | undefined;
  // Only the current user-command span is needed. Do not import or normalize a
  // whole long-running conversation just to authenticate one live callback.
  for (let page = 0; page < 100 && !command; page++) {
    assertCurrent();
    const result = await oc.request<{ data: NativeMessage[]; cursor: { next?: string | null } }>(
      oc.path(nativeId) + `/message?limit=100&${cursor ? `cursor=${encodeURIComponent(cursor)}` : "order=desc"}`);
    assertCurrent();
    if (!Array.isArray(result.data) || !result.cursor || result.data.length > 100) return reject();
    for (const message of result.data) {
      if (!message || !nativeMessageId(message.id) || !Number.isFinite(message.time?.created) || ids.has(message.id)) return reject();
      ids.add(message.id); descending.push(message);
      if (message.type === "user") { command = message; break; }
    }
    if (command) break;
    const next = result.cursor.next;
    if (!next || typeof next !== "string" || next.length > 8192 || cursors.has(next) || !result.data.length) return reject();
    cursors.add(next); cursor = next;
  }
  if (!command) return reject();
  const messages = descending.reverse(), target = messages.find(message => message.id === invocation.messageId);
  if (!target || target.type !== "assistant" || target.time.completed !== undefined
    || messages.findLast(message => message.type === "assistant") !== target
    || !target.content?.some(part => matchesOpenCodeWorkerPart(operation, invocation, target.id, part) && part.state?.status === "running")) return reject();
  const continuationIds: string[] = [];
  let activated = false, afterIdle = false, reachedTarget = false;
  for (let i = 1; i < messages.length; i++) {
    const message = messages[i]!;
    if (message === target) { reachedTarget = true; continue; }
    if (message.type === "synthetic") {
      if (openCodeTurnContext(message, command)) {
        if (message.metadata?.notice === "restart" && !reachedTarget) { activated = true; continuationIds.push(message.id); }
        continue;
      }
      // The native transport retry notice predates typed notice metadata. Require
      // its adjacent failed assistant as well as the exact native notice shape.
      const retry = message.metadata === undefined && !!messages[i - 1]?.error && messages[i - 1]?.type === "assistant"
        && message.text === "The previous response was interrupted. Continue from where you left off without repeating completed content.";
      if (reachedTarget || !backgroundResult(message) && !retry) return reject();
      activated = true; continuationIds.push(message.id);
    } else if (message.type === "idle") {
      if (reachedTarget || message.outcome === "interrupted") return reject();
      activated = false; afterIdle = true;
    } else if (message.type !== "assistant") {
      // Manual/unknown compaction and other native inputs remain boundaries.
      if (reachedTarget || message.type !== "compaction" || message.reason !== "auto" || message.status !== "completed") return reject();
    }
  }
  if (!activated || !continuationIds.length) return reject();
  const after = await oc.activity(nativeId, cwd);
  assertCurrent();
  if (!after.active || before.session.time.created !== after.session.time.created
    || before.session.time.updated !== after.session.time.updated || revert(before.session) !== revert(after.session)) return reject();
  return { commandId: command.id, messageId: target.id, toolCallId: invocation.toolCallId, continuationIds, afterIdle,
    nativeCreatedAt: after.session.time.created, revert: revert(after.session) };
}
