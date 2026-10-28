import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import type { CompactionMetadata, MessagePart, MessageSnapshot } from "./oc-contract";

/** Grok 1.0.70: user-guide/17-sessions.md (storage and persistence),
 * 14-headless-mode.md (fork/create/resume), 15-agent-mode.md (ACP).
 * Read updates.jsonl, not chat_history.jsonl (model inputs are not UI history).
 * No local file writes, model invocation, or App command receipt inference. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_UPDATES_BYTES = 16 * 1024 * 1024;
const MAX_SUMMARY_BYTES = 1024 * 1024;
const MAX_UPDATES = 100_000;
const MAX_MESSAGES = 10_000;
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => !!value && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value);
const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const invalid = (message: string): never => { throw new Error(`Grok native history: ${message}`); };
function assertId(value: string) { if (!UUID.test(value)) invalid("session ID must be a UUID"); }
function assertPath(value: string) {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value || /[\x00-\x1f\x7f]/.test(value)) invalid("home and cwd must be exact canonical absolute paths");
}
async function directory(path: string) {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) invalid("directory is not canonical or is a symlink");
  return `${info.dev}:${info.ino}`;
}
type FileSnapshot = { text: string; assertCurrent(): Promise<void> };
const signature = (info: Awaited<ReturnType<typeof statBig>>) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
const statBig = (path: string) => lstat(path, { bigint: true });

/** Bounded even when a writer appends; reject partial lines and mixed generations.
 * Canonical parents plus O_NOFOLLOW reject aliases, including symlink escapes. */
async function readBounded(path: string, budget: number): Promise<FileSnapshot> {
  const parent = path.slice(0, path.lastIndexOf("/"));
  const parentPin = await directory(parent);
  if (await realpath(path) !== path) invalid("file path is not canonical");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(budget)) invalid("file is not regular or exceeds its import budget");
    const pin = signature(before), bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const assertCurrent = async () => {
      const current = await statBig(path);
      if (!current.isFile() || current.isSymbolicLink() || signature(current) !== pin
        || await realpath(path) !== path || await directory(parent) !== parentPin) invalid("transcript changed during import; retry once native activity settles");
    };
    if (length !== Number(before.size) || signature(await file.stat({ bigint: true })) !== pin) invalid("file changed during read");
    await assertCurrent();
    // Fatal UTF-8 decoding prevents damaged bytes silently changing native IDs.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    return { text, assertCurrent };
  } finally { await file.close(); }
}

/** URL encoding differs between libraries for otherwise-safe punctuation. Decode
 * group names and compare the ENTIRE cwd, rather than guessing one encoding.
 * Long slug/hash groups require the documented exact .cwd evidence. */
async function locate(homeRoot: string, cwd: string, nativeId: string) {
  assertId(nativeId); assertPath(homeRoot); assertPath(cwd);
  const homePin = await directory(homeRoot), cwdPin = await directory(cwd);
  const sessions = join(homeRoot, "sessions");
  let sessionsPin: string;
  try { sessionsPin = await directory(sessions); } catch (error) { if (absent(error)) return; throw error; }
  const encodedLength = Buffer.byteLength(encodeURIComponent(cwd));
  const groups: Array<{ path: string; pin: string; evidence?: FileSnapshot }> = [];
  const entries = await opendir(sessions);
  let count = 0;
  for await (const entry of entries) {
    if (++count > 10_000) invalid("session directory exceeds discovery budget");
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(sessions, entry.name);
    let decoded: string | undefined;
    try { decoded = decodeURIComponent(entry.name); } catch { /* Not an encoded cwd. */ }
    if (decoded === cwd) groups.push({ path, pin: await directory(path) });
    else if (encodedLength > 255) {
      let evidence: FileSnapshot;
      try { evidence = await readBounded(join(path, ".cwd"), 64 * 1024); }
      catch (error) { if (absent(error)) continue; throw error; }
      // Native writes the path as text. Accept a final line terminator only.
      if (evidence.text.replace(/\r?\n$/, "") === cwd) groups.push({ path, pin: await directory(path), evidence });
    }
  }
  if (groups.length > 1) invalid("ambiguous cwd groups; refusing to choose a transcript");
  if (!groups.length) return;
  const group = groups[0]!, path = join(group.path, nativeId);
  let sessionPin: string;
  try { sessionPin = await directory(path); } catch (error) { if (absent(error)) return; throw error; }
  const assertCurrent = async () => {
    if (await directory(homeRoot) !== homePin || await directory(cwd) !== cwdPin || await directory(sessions) !== sessionsPin
      || await directory(group.path) !== group.pin || await directory(path) !== sessionPin) invalid("native source identity changed during import");
    await group.evidence?.assertCurrent();
  };
  await assertCurrent();
  return { path, assertCurrent };
}

function summaryInfo(text: string, nativeId: string, cwd: string): ObjectValue {
  const summary: unknown = JSON.parse(text);
  if (!object(summary) || !object(summary.info) || summary.info.cwd !== cwd) return invalid("summary session/cwd identity mismatch");
  // Native summary.json stores info.id (not the ACP envelope's sessionId).
  const ids = [summary.info.id, summary.info.sessionId, summary.info.session_id].filter(value => value !== undefined);
  if (!ids.length || ids.some(value => value !== nativeId)) return invalid("summary session/cwd identity mismatch");
  return summary;
}

/** Existence is native disk evidence, not acceptance, liveness, or completion.
 * Missing sessions return false; corrupt/aliased/mismatched sources throw. */
export async function grokSessionExists(homeRoot: string, cwd: string, nativeId: string): Promise<boolean> {
  const source = await locate(homeRoot, cwd, nativeId);
  if (!source) return false;
  try {
    const summary = await readBounded(join(source.path, "summary.json"), MAX_SUMMARY_BYTES);
    summaryInfo(summary.text, nativeId, cwd);
    const updates = join(source.path, "updates.jsonl"), info = await statBig(updates);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(updates) !== updates) invalid("updates log must be a canonical regular file");
    await summary.assertCurrent(); await source.assertCurrent();
    return true;
  } catch (error) { if (absent(error)) return false; throw error; }
}

export async function readGrokHistory(nativeId: string, cwd: string, homeRoot: string): Promise<MessageSnapshot[]> {
  const source = await locate(homeRoot, cwd, nativeId);
  if (!source) return invalid("session not found in the pinned home/cwd");
  const summary = await readBounded(join(source.path, "summary.json"), MAX_SUMMARY_BYTES);
  summaryInfo(summary.text, nativeId, cwd);
  const updates = await readBounded(join(source.path, "updates.jsonl"), MAX_UPDATES_BYTES);
  const lines = updates.text.split("\n");
  // A complete final JSON value without LF is readable; an unfinished write is
  // rejected by JSON.parse, never silently discarded as an empty conversation.
  const records: unknown[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (records.length >= MAX_UPDATES) invalid("updates log exceeds import event budget");
    records.push(JSON.parse(line));
  }
  const messages = normalizeGrokHistory(nativeId, records);
  await updates.assertCurrent(); await summary.assertCurrent(); await source.assertCurrent();
  return messages;
}

/** Projection keys lacking an ACP messageId are explicitly grok-update keys,
 * scoped to native session and log position. They are NOT native message IDs,
 * provider IDs, resumable boundaries, or App command receipts. Native ACP IDs
 * are retained verbatim, without imposing OpenCode's msg_ namespace. */
export function normalizeGrokHistory(nativeId: string, records: readonly unknown[]): MessageSnapshot[] {
  assertId(nativeId);
  if (records.length > MAX_UPDATES) return invalid("too many updates");
  const messages: MessageSnapshot[] = [], byId = new Map<string, MessageSnapshot>();
  const positionalIds = new Set<string>();
  const tools = new Map<string, Extract<MessagePart, { type: "tool" }>>();
  let current: MessageSnapshot | undefined;
  function add(id: string, role: MessageSnapshot["role"], positional = false) {
    const previous = byId.get(id);
    if (previous) {
      if (previous.role !== role || positionalIds.has(id) !== positional) invalid("message ID reused across roles or native/projection namespaces");
      return previous;
    }
    if (messages.length >= MAX_MESSAGES) invalid("history exceeds message import budget");
    const message: MessageSnapshot = { messageId: id, role, parts: [], createdAt: "", status: "unknown" };
    messages.push(message); byId.set(id, message); if (positional) positionalIds.add(id); return message;
  }
  for (const [index, row] of records.entries()) {
    if (!object(row)) return invalid("update is not an object");
    let update: ObjectValue;
    let envelope = row;
    if (object(row.params)) envelope = row.params;
    if (envelope.sessionId !== undefined && envelope.sessionId !== nativeId) return invalid("update session identity mismatch");
    if (object(envelope.update)) update = envelope.update;
    else update = envelope;
    const type = update.sessionUpdate;
    if (typeof type !== "string") {
      // Extension notifications share the stream but are not conversation chunks.
      if (typeof row.method === "string" && row.method.startsWith("x.ai/")) continue;
      return invalid("unrecognized ACP update envelope");
    }
    const key = `grok-update:${nativeId}:${index}`;
    if (["user_message_chunk", "agent_message_chunk", "agent_thought_chunk"].includes(type)) {
      const role = type === "user_message_chunk" ? "user" : "assistant";
      if (update.messageId !== undefined && update.messageId !== null && !identifier(update.messageId)) return invalid("invalid ACP message ID");
      const id = identifier(update.messageId) ? update.messageId : undefined;
      // With no native ID, only adjacent same-role chunks can be coalesced.
      // Explicit IDs never merge with these position-addressed projections.
      if (id) current = add(id, role);
      else if (!current || current.role !== role || !positionalIds.has(current.messageId)) current = add(key, role, true);
      if (!object(update.content)) return invalid("ACP content chunk missing content");
      appendContent(current, update.content, key, type === "agent_thought_chunk" ? "reasoning" : "text");
    } else if (type === "tool_call" || type === "tool_call_update") {
      if (!identifier(update.toolCallId)) return invalid("tool update missing its native toolCallId");
      let tool = tools.get(update.toolCallId);
      if (!tool) {
        if (!current || current.role !== "assistant") current = add(key, "assistant", true);
        tool = { id: update.toolCallId, type: "tool", name: typeof update.title === "string" ? update.title : "Tool", status: "unknown" };
        tools.set(update.toolCallId, tool); current.parts.push(tool);
      }
      if (typeof update.title === "string") tool.name = update.title;
      if (typeof update.status === "string") tool.status = update.status === "failed" ? "error" : update.status;
      if ("rawInput" in update) tool.input = update.rawInput;
      if ("rawOutput" in update) tool.output = update.rawOutput;
      else if (Array.isArray(update.content)) tool.output = update.content;
      if (update.status === "failed") tool.error = tool.output;
    } else if (type === "usage_update") {
      // Standard ACP usage_update is session context occupancy, not a message's
      // token spend or a completion receipt. Do not attach it to a guessed turn.
      continue;
    }
    // Plans, advertised commands, model/config/session info are not messages.
  }
  return messages.filter(message => message.parts.length > 0);
}

function appendContent(message: MessageSnapshot, content: ObjectValue, key: string, kind: "text" | "reasoning") {
  let text: string;
  if (content.type === "text" && typeof content.text === "string") text = content.text;
  else if (content.type === "resource" && object(content.resource) && typeof content.resource.text === "string") text = content.resource.text;
  else if (content.type === "resource_link" && typeof content.uri === "string") text = `[Native resource: ${content.uri}]`;
  else if (content.type === "image" || content.type === "audio" || content.type === "resource") text = `[Native ${content.type} content]`;
  else return invalid("unsupported ACP content block");
  const last = message.parts.at(-1);
  if (last?.type === kind) last.text += text;
  else message.parts.push({ id: key, type: kind, text });
}

/** Actual native fork launch flags. Combine with --prompt-file and the normal
 * model/output/environment options. Native creates the target during launch;
 * NEVER precreate/import a fake child transcript or append to the source.
 * Latest-turn only: Grok 1.0.70 explicitly does not support /fork --at. */
export function grokForkSessionArgs(sourceNativeId: string, targetNativeId: string): readonly string[] {
  assertId(sourceNativeId); assertId(targetNativeId);
  if (sourceNativeId.toLowerCase() === targetNativeId.toLowerCase()) return invalid("fork target must differ from source");
  return Object.freeze(["--resume", sourceNativeId, "--fork-session", "--session-id", targetNativeId]);
}

/** Read-only preflight, NOT an atomic reservation. Grok performs its own
 * anti-overwrite check. Persist the launch intent and do not retry an uncertain
 * spawn; validate the actual child's summary.parent_session_id after launch. */
export async function prepareGrokFork(homeRoot: string, cwd: string, sourceNativeId: string, targetNativeId: string) {
  const args = grokForkSessionArgs(sourceNativeId, targetNativeId);
  if (!await grokSessionExists(homeRoot, cwd, sourceNativeId)) return invalid("fork source is missing");
  if (await locate(homeRoot, cwd, targetNativeId)) return invalid("fork target already exists, including an incomplete native session");
  return args;
}

/** Check native provenance only after the fork process has actually persisted
 * its child. A successful preflight or allocated target UUID proves no fork. */
export async function verifyGrokFork(nativeId: string, cwd: string, sourceNativeId: string, homeRoot: string): Promise<void> {
  grokForkSessionArgs(sourceNativeId, nativeId);
  const source = await locate(homeRoot, cwd, nativeId);
  if (!source) return invalid("native fork child is missing");
  const summary = await readBounded(join(source.path, "summary.json"), MAX_SUMMARY_BYTES);
  const info = summaryInfo(summary.text, nativeId, cwd);
  if (info.parent_session_id !== sourceNativeId) return invalid("native fork child lacks the expected parent_session_id provenance");
  await summary.assertCurrent(); await source.assertCurrent();
}

/** Native command, not prompt prose. Requires an initialized ACP connection,
 * session/load of the pinned ID/cwd, and extension availability discovery.
 * The headless -p '/compact' path is NOT established by the installed docs. */
export function grokCompactRequest(nativeId: string) {
  assertId(nativeId);
  // Grok documents the logical extension name; ACP puts a leading underscore
  // on extension methods on the JSON-RPC wire (normally added by its SDK).
  return { method: "_x.ai/compact_conversation" as const, params: { sessionId: nativeId } };
}

/** Parse actual ACP/headless auto_compact_* notifications, not an assistant saying
 * it compacted, ordinary result.success, process exit, or the ACP RPC ack.
 * Installed native notification schema uses tokens_before/tokens_after and
 * elapsed_ms. A preview is retained as native metadata, not a full summary.
 * There is no invented nativeId: callers may use a scoped log-position key for
 * display while keeping command completion attribution explicitly unconfirmed. */
export function parseGrokCompactionEvent(value: unknown): CompactionMetadata | undefined {
  if (!object(value)) return;
  // ACP session/update and _x.ai/session/update identify events with
  // sessionUpdate. Headless notification payloads may instead use type.
  const type = value.sessionUpdate ?? value.type;
  const lifecycle = type === "auto_compact_started" ? "running"
    : type === "auto_compact_completed" ? "completed"
    : type === "auto_compact_failed" ? "failed"
    : type === "auto_compact_cancelled" ? "unconfirmed" : undefined;
  if (!lifecycle) return;
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  return { trigger: "auto", lifecycle, preTokens: number(value.tokens_before ?? value.tokens_used), postTokens: number(value.tokens_after),
    durationMs: number(value.elapsed_ms), ...(lifecycle === "failed" && value.error !== undefined ? { error: value.error } : {}),
    nativeMetadata: { ...value } };
}
