import { nativeMessageId } from "./history";
import type { NativeMessage } from "./opencode";

export type CommandSettlement = {
  kind: "quiescent-command-interval";
  commandId: string;
  terminalMessageId: string;
  outcome: "succeeded" | "failed" | "interrupted";
  nativeCreatedAt: number;
  nativeUpdatedAt: number;
  continuationIds: string[];
};

type NativeState = {
  id: string;
  location?: { directory?: string };
  revert?: unknown;
  outcome?: string;
  time: { created: number; updated: number; idle?: number };
};
const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isFinite(new Date(value).getTime());

/** A synthetic message is not proof of a new user command. Conversely, its
 * wording is not proof of continuation. Certify the whole execution interval
 * instead: exact user anchor, first terminal idle, and stable native identity/
 * idle state. Later completed turns may be present after reconnect; their
 * outcomes never replace this interval's first idle. The caller verifies an empty raw inbox
 * and no active native execution, then rechecks this certificate before use.
 *
 * Deliberately independent of notices, retry wording and synthetic metadata.
 * It works after App restarts and for worker-result and queued-user runs too.
 */
export function settleCommandInterval(messages: readonly NativeMessage[], commandId: string, before: NativeState, after: NativeState): CommandSettlement | undefined {
  if (before.id !== after.id || before.location?.directory !== after.location?.directory || before.revert != null || after.revert != null
    || !timestamp(before.time.created) || !timestamp(before.time.updated) || !timestamp(before.time.idle)
    || before.time.created !== after.time.created || before.time.updated !== after.time.updated || before.time.idle !== after.time.idle
    || before.outcome !== after.outcome || before.time.updated < before.time.created) return;
  const command = messages[0], latest = messages.at(-1), terminal = messages.find(message => message.type === "idle");
  if (!command || command.id !== commandId || command.type !== "user" || !terminal || !latest || latest.type !== "idle"
    || latest.time.created !== after.time.idle || latest.outcome !== after.outcome) return;
  const ids = new Set<string>(), continuationIds: string[] = [];
  let sealed = false;
  for (const message of messages) {
    if (!nativeMessageId(message.id) || ids.has(message.id) || !timestamp(message.time?.created)
      || message.time.created < before.time.created || message.time.created < command.time.created || message.time.created > latest.time.created
      || !sealed && message.time.created > terminal.time.created
      || message.time.completed !== undefined && (!timestamp(message.time.completed) || message.time.completed < message.time.created || message.time.completed > (sealed ? latest : terminal).time.created)) return;
    ids.add(message.id);
    if (message === command) continue;
    if (message.type === "user" && !sealed) return;
    if (message.type === "idle" && !["succeeded", "failed", "interrupted"].includes(message.outcome ?? "")) return;
    if (!["user", "assistant", "synthetic", "compaction", "idle", "system", "model-switched", "tool"].includes(message.type)) return;
    if (["assistant", "tool", "compaction"].includes(message.type) && message.time.completed === undefined) return;
    if (message.type === "compaction" && !["completed", "failed", "skipped"].includes(message.status ?? "")) return;
    if (message.type === "tool" && !["completed", "failed", "error"].includes(message.status ?? "")) return;
    if (message.content !== undefined && (!Array.isArray(message.content) || message.content.some(part => !part || typeof part.type !== "string"
      || part.type === "tool" && !["completed", "failed", "error"].includes(part.state?.status ?? "")))) return;
    if (message.type === "synthetic" && !sealed) continuationIds.push(message.id);
    if (message === terminal) sealed = true;
  }
  return { kind: "quiescent-command-interval", commandId, terminalMessageId: terminal.id,
    outcome: terminal.outcome as CommandSettlement["outcome"], nativeCreatedAt: after.time.created,
    nativeUpdatedAt: after.time.updated, continuationIds };
}
