import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { nativeMessageId } from "./history";
import { OpenCodeError, type OpenCodeAdapter, type NativeMessage } from "./opencode";

export type OperatorCompletionRequest = {
  nativeSessionId: string;
  cwd: string;
  commandId: string;
};
/** Operator reconciliation evidence, NOT native exact-command certification or
 * automatic ownership proof. Persist the operator action and this evidence
 * before settling a run. Synthetic boundaries remain explicitly unidentified. */
export type OperatorCompletionEvidence = {
  mode: "operator-requested";
  commandId: string;
  nativeSessionId: string;
  cwd: string;
  nativeCreatedAt: number;
  terminalMessageId: string;
  outcome: "succeeded" | "failed" | "interrupted";
  boundaryIds: { messageId: string; type: "synthetic" | "compaction" }[];
  observedAt: string;
  activityDigest: string;
};

const invalid = (reason: string): never => { throw new OpenCodeError(`Operator completion verification: ${reason}`, 409); };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isFinite(new Date(value).getTime());

/** Invoke ONLY for an explicit operator completion-verification action, never
 * from automatic recovery/ownership detection. Caller owns authorization/audit.
 * Read-only, bounded full-history check; never interprets synthetic prose.
 * activity.pending follows the adapter's inbox policy (startup context excluded).
 * This helper cannot certify literal raw-inbox emptiness with that interface. */
export async function verifyOpenCodeCompletion(
  native: Pick<OpenCodeAdapter, "activity" | "history">,
  request: OperatorCompletionRequest,
): Promise<OperatorCompletionEvidence> {
  if (!record(request) || typeof request.nativeSessionId !== "string" || !/^ses[a-zA-Z0-9_-]+$/.test(request.nativeSessionId)
    || !nativeMessageId(request.commandId) || typeof request.cwd !== "string" || !isAbsolute(request.cwd) || request.cwd.includes("\0")) return invalid("invalid explicit operator request or pinned identity");
  const { nativeSessionId, cwd, commandId } = request;
  const inspect = (value: unknown) => {
    if (!record(value) || !record(value.session) || !record(value.session.location) || value.session.id !== nativeSessionId || value.session.location.directory !== cwd) return invalid("native session identity or directory changed");
    const session = value.session, time = session.time;
    if (!record(time) || !timestamp(time.created) || !timestamp(time.updated) || time.updated < time.created
      || time.idle !== undefined && (!timestamp(time.idle) || time.idle < time.created)
      || typeof value.active !== "boolean" || typeof value.pending !== "boolean"
      || session.outcome !== undefined && !["succeeded", "failed", "interrupted"].includes(session.outcome as string)) return invalid("invalid native activity or timestamps");
    if (value.active || value.pending) return invalid("native session is busy or has pending inbox input");
    // Stable rewound history still cannot establish the unreverted command boundary.
    if (session.revert != null) return invalid("native revert is present; rewound history cannot verify completion");
    const fingerprint = JSON.stringify([session.id, cwd, time.created, time.updated, time.idle ?? null, session.outcome ?? null, null]);
    return { fingerprint, created: time.created, idle: time.idle, outcome: session.outcome };
  };
  const before = inspect(await native.activity(nativeSessionId, cwd));
  const history = await native.history(nativeSessionId, cwd);
  const after = inspect(await native.activity(nativeSessionId, cwd));
  if (before.fingerprint !== after.fingerprint) return invalid("native activity, creation identity, or revert changed during verification");
  if (!record(history) || history.activity !== "idle" || !Array.isArray(history.rawMessages) || history.rawMessages.length > 10000) return invalid("invalid, active, or oversized full native history");
  const messages: NativeMessage[] = history.rawMessages;
  const ids = new Set<string>();
  for (const message of messages) {
    const sessionID = (message as NativeMessage & { sessionID?: unknown })?.sessionID;
    if (!record(message) || !nativeMessageId(message.id) || typeof message.type !== "string" || !message.type || !record(message.time)
      || !timestamp(message.time.created) || message.time.created < before.created
      || message.time.completed !== undefined && (!timestamp(message.time.completed) || message.time.completed < message.time.created)
      || sessionID !== undefined && sessionID !== nativeSessionId) return invalid("invalid native message identity or timestamps");
    if (ids.has(message.id)) return invalid("duplicate native message identity in full history");
    ids.add(message.id);
  }
  const index = messages.findIndex(message => message.id === commandId);
  if (index < 0) return invalid("exact command is missing from full native history");
  const command = messages[index]!;
  if (command.type !== "user") return invalid("exact command is not a user message");
  const later = messages.slice(index + 1), terminal = later.at(-1);
  if (later.some(message => message.type === "user")) return invalid("newer user message follows the exact command");
  if (!terminal || terminal.type !== "idle") return invalid("missing terminal idle or messages after the latest idle");
  if (!["succeeded", "failed", "interrupted"].includes(terminal.outcome ?? "")) return invalid("invalid terminal idle outcome");
  if (after.idle !== undefined && terminal.time.created !== after.idle) return invalid("terminal idle timestamp differs from native session idle");
  if (after.outcome !== undefined && terminal.outcome !== after.outcome) return invalid("terminal idle outcome differs from native session outcome");
  const boundaryIds: OperatorCompletionEvidence["boundaryIds"] = [];
  for (const message of later) {
    if (message.time.created < command.time.created || message.time.created > terminal.time.created
      || message.time.completed !== undefined && message.time.completed > terminal.time.created) return invalid("invalid command/terminal message timestamps");
    if (!["assistant", "synthetic", "compaction", "idle", "system", "model-switched", "tool"].includes(message.type)) return invalid("unknown native message type after command");
    if (message.type === "idle" && !["succeeded", "failed", "interrupted"].includes(message.outcome ?? "")) return invalid("invalid historical idle outcome");
    if (["assistant", "tool", "compaction"].includes(message.type) && message.time.completed === undefined) return invalid("unfinished assistant, tool, or compaction after command");
    if (message.type === "compaction" && !["completed", "failed", "skipped"].includes(message.status ?? "")) return invalid("unfinished or invalid compaction status");
    if (message.type === "tool" && !["completed", "failed", "error"].includes(message.status ?? "")) return invalid("unfinished or invalid tool status");
    if (message.content !== undefined && (!Array.isArray(message.content) || message.content.some(part => !record(part) || typeof part.type !== "string"
      || part.type === "tool" && (!record(part.state) || !["completed", "failed", "error"].includes(part.state.status as string))))) return invalid("unfinished or invalid tool content");
    // Completed failed retry attempts are historical diagnostics, not active retries.
    const retry = message.retry;
    if (retry !== undefined && (!record(retry) || !Number.isSafeInteger(retry.attempt) || retry.attempt < 1 || !timestamp(retry.at)
      || !record(retry.error) || typeof retry.error.type !== "string" || typeof retry.error.message !== "string")) return invalid("invalid retry metadata");
    if (message.type === "synthetic" || message.type === "compaction") boundaryIds.push({ messageId: message.id, type: message.type });
  }
  return { mode: "operator-requested", commandId, nativeSessionId, cwd, nativeCreatedAt: before.created,
    terminalMessageId: terminal.id, outcome: terminal.outcome as OperatorCompletionEvidence["outcome"], boundaryIds,
    observedAt: new Date().toISOString(), activityDigest: createHash("sha256").update(before.fingerprint).digest("hex") };
}
