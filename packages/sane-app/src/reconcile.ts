import { forkSession, getSessionInfo, getSessionMessages, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { MessagePart, MessageSnapshot } from "./oc-contract";
import type { ReconciledHistory } from "../shared/conversation/native-history-contract";
export type { ReconciledHistory } from "../shared/conversation/native-history-contract";
import type { Run, Session } from "./history";
import { uuid } from "./history";
import { open, realpath } from "node:fs/promises";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";
import { assertClaudeSource, claudeSourceRoot } from "./claude-source";
import { normalizeClaudeCompactionBoundary } from "./compaction";
import { isClaudeRootRecord } from "../shared/conversation/cc-scope";
import { ClaudeHistorySnapshotChangedError } from "./claude-history-snapshot-error";

export function coveredNativeRuns(session: Session, runs: Run[], messages: MessageSnapshot[]) {
  if (session.harness !== "opencode") return [];
  const nativeUsers = new Set(messages.filter(m => m.role === "user").map(m => m.messageId));
  const nativeCompacts = new Set(messages.filter(m => m.compaction).map(m => m.compaction!.nativeId ?? m.messageId));
  return runs.filter(r => r.sessionId === session.sessionId && (r.operation === "compact"
    ? nativeCompacts.has(r.compact?.nativeAdmittedId ?? r.compact?.nativeRequestId ?? r.nativeCommandId ?? "")
    : !!r.nativeCommandId && nativeUsers.has(r.nativeCommandId))).map(r => r.runId);
}

/** Fail closed outside the verified local JSONL layout. SDKSessionInfo.cwd alone
 * is NOT evidence: installed SDK Ia falls back to the requested project path. */
async function claudeCwdEvidence(id: string, cwd: string, root: string, fork?: { source: string; boundary: string }) {
  const project = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (!uuid(id) || project.length > 200) throw new Error("Unsupported native transcript locator; genuine native cwd evidence is unavailable");
  if (await realpath(cwd) !== cwd) throw new Error("Checkout root must be canonical for native attachment");
  if (await realpath(root) !== root) throw new Error("Configuration root must be canonical for native attachment");
  const path = join(root, "projects", project, `${id}.jsonl`);
  if (await realpath(path) !== path) throw new Error("Transcript path must be canonical for native attachment");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > 16 * 1024 * 1024) throw new Error("Native transcript is not a bounded local file");
    // Bounded read even if a concurrent native writer grows the file.
    const bytes = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bytes.length) { const result = await file.read(bytes, length, bytes.length - length, length); if (!result.bytesRead) break; length += result.bytesRead; }
    const after = await file.stat();
    if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Native transcript changed while checking native cwd evidence");
    let found = false, forkFound = false;
    const directories = new Set<string>(), order: string[] = [];
    const boundaries = new Map<string, MessageSnapshot>();
    const summaries = new Map<string, MessageSnapshot>();
    for (const line of bytes.subarray(0, length).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (row.type === "relocated") throw new Error("Relocated native transcript requires unsupported locator verification; no cwd inferred");
      if (!isClaudeRootRecord(row)) continue;
      if (row.type === "system" && row.subtype === "compact_boundary") {
        // SDK getSessionMessages omits these records and their metadata. Retain
        // only actual main-session system boundaries from the bounded raw read.
        if (row.sessionId !== id) throw new Error("Native raw compaction boundary session identity mismatch");
        const boundary = normalizeClaudeCompactionBoundary(row, id);
        if (!boundary) throw new Error("Invalid native raw compaction boundary");
        const previous = boundaries.get(boundary.messageId);
        if (previous && JSON.stringify(previous) !== JSON.stringify(boundary)) throw new Error("Conflicting native raw compaction boundary UUID");
        if (!previous) { boundaries.set(boundary.messageId, boundary); order.push(boundary.messageId); }
        if (boundaries.size > 10000) throw new Error("Native transcript exceeds 10,000-boundary import budget");
        continue;
      }
      if (row.type !== "user" && row.type !== "assistant") continue;
      if (row.sessionId !== id) throw new Error("Native raw transcript session identity mismatch");
      if (typeof row.uuid === "string") order.push(row.uuid);
      if (row.type === "user" && row.isCompactSummary === true && uuid(row.uuid)) {
        // This native flag and sometimes the summary itself are omitted by SDK
        // history reads. Retain the original text, not a guessed user turn.
        const summary = normalizeClaudeHistory(id, [{ type: "user", uuid: row.uuid, session_id: id, message: row.message, parent_tool_use_id: null, parent_agent_id: null }])[0];
        if (summary) summaries.set(row.uuid, { ...summary, compactionSummary: true });
        if (summaries.size > 10000) throw new Error("Native transcript exceeds 10,000-summary import budget");
      }
      if (row.cwd !== undefined && !directories.has(row.cwd)) {
        if (typeof row.cwd !== "string" || !isAbsolute(row.cwd)) throw new Error("Native raw transcript execution directory is not an absolute path");
        const child = relative(cwd, row.cwd);
        // A shell cd may change cwd within the checkout. Require canonical paths
        // so lexical containment cannot admit a symlink escape (or ../ alias).
        if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child) || await realpath(row.cwd) !== row.cwd) throw new Error("Native raw transcript execution directory is not a canonical path within the pinned checkout");
        directories.add(row.cwd);
      }
      if (row.cwd === cwd) found = true;
      if (fork && row.forkedFrom?.sessionId === fork.source && row.forkedFrom?.messageUuid === fork.boundary) forkFound = true;
    }
    if (!found) throw new Error("Native transcript has no genuine native cwd evidence; SDK project-path fallback is insufficient");
    if (fork && !forkFound) throw new Error("Native fork provenance does not contain the selected source boundary");
    return { size: before.size, mtime: before.mtimeMs, ctime: before.ctimeMs, ino: before.ino, dev: before.dev,
      sha256: createHash("sha256").update(bytes.subarray(0, length)).digest("hex"),
      directories: [...directories], boundaries: [...boundaries.values()], summaries: [...summaries.values()], order };
  } finally { await file.close(); }
}

/** Native SDK copies the actual chain (inclusive), remaps UUIDs and records
 * forkedFrom provenance. It does not copy undo snapshots or execute a model. */
export async function forkClaudeHistory(source: string, cwd: string, boundary: string, root = claudeSourceRoot(), beforeFork?: () => void) {
  assertClaudeSource(root);
  await claudeCwdEvidence(source, cwd, root);
  beforeFork?.();
  return forkSession(source, { dir: cwd, upToMessageId: boundary });
}
export async function verifyClaudeFork(id: string, cwd: string, source: string, boundary: string, root = claudeSourceRoot()) {
  assertClaudeSource(root);
  await claudeCwdEvidence(id, cwd, root, { source, boundary });
}

/** SDK read-only transcript helpers plus raw local cwd evidence. Never invoke a native run. */
export async function readClaudeHistory(id: string, cwd: string, sourceRoot = claudeSourceRoot()) {
  return (await importClaudeHistory(id, cwd, sourceRoot)).messages;
}

async function importClaudeHistory(id: string, cwd: string, sourceRoot: string) {
  assertClaudeSource(sourceRoot);
  const evidence = await claudeCwdEvidence(id, cwd, sourceRoot);
  const before = await getSessionInfo(id, { dir: cwd });
  if (!before || before.sessionId !== id || !before.cwd || !evidence.directories.includes(before.cwd)) throw new Error("Native transcript missing or its execution directory differs from the verified native cwd evidence");
  if (before.fileSize === undefined || before.fileSize > 16 * 1024 * 1024) throw new Error("Native transcript size unavailable or exceeds 16 MiB import budget");
  if (before.fileSize !== evidence.size || before.lastModified !== Math.trunc(evidence.mtime)) throw new Error("SDK history does not match the verified local transcript");
  const records = await getSessionMessages(id, { dir: cwd, limit: 10001 });
  if (records.length > 10000) throw new Error("Native transcript exceeds 10,000-message import budget");
  const after = await getSessionInfo(id, { dir: cwd });
  if (!after || after.sessionId !== id || after.cwd !== before.cwd || before.lastModified !== after.lastModified || before.fileSize !== after.fileSize) throw new Error("Native transcript changed during reconciliation; retry after native activity settles");
  const finalEvidence = await claudeCwdEvidence(id, cwd, sourceRoot);
  if (JSON.stringify(evidence) !== JSON.stringify(finalEvidence)) throw new Error("Native transcript changed during reconciliation; previous history preserved");
  assertClaudeSource(sourceRoot);
  const messages = normalizeClaudeHistory(id, records);
  const byId = new Map([...messages, ...evidence.boundaries, ...evidence.summaries].map(m => [m.messageId, m]));
  const ordered: MessageSnapshot[] = [];
  for (const messageId of evidence.order) {
    const message = byId.get(messageId);
    if (message) { ordered.push(message); byId.delete(messageId); }
  }
  // Never guess the placement of a native message outside the verified raw
  // transcript. Keeping order matters for context resets and usage projection.
  if (byId.size) throw new Error("SDK history contains messages absent from the verified native transcript");
  if (ordered.length > 10000) throw new Error("Native transcript exceeds 10,000-message import budget");
  return { messages: ordered, evidence: finalEvidence };
}

/** One preparation's immutable native evidence, NOT a native-session lease.
 * Reuse only with assertCurrent after awaits and at the synchronous send gate.
 * Every check rereads/hashes the complete bounded file: timestamps alone never
 * authorize reuse. Even append-only growth refuses this snapshot; the caller
 * must prepare anew, not extend a possibly reset/compacted native prefix. */
export async function readClaudeHistorySnapshot(id: string, cwd: string, sourceRoot: string): Promise<Readonly<{
  messages: readonly MessageSnapshot[];
  assertCurrent(): void;
}>> {
  const { messages, evidence } = await importClaudeHistory(id, cwd, sourceRoot);
  const path = join(sourceRoot, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`);
  const fail = (): never => { throw new Error("Native transcript source or exact snapshot changed during context preparation"); };
  const directory = (path: string) => {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) fail();
    return `${stat.dev}:${stat.ino}`;
  };
  const capture = () => {
    assertClaudeSource(sourceRoot);
    const root = directory(sourceRoot), checkout = directory(cwd);
    // Raw cwd evidence also depends on historical within-checkout directories
    // remaining canonical, not just on the transcript bytes remaining identical.
    const directories = evidence.directories.map(directory);
    const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const pin = () => {
        const opened = fstatSync(file, { bigint: true }), current = lstatSync(path, { bigint: true });
        const key = (stat: typeof opened) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
        if (!opened.isFile() || !current.isFile() || current.isSymbolicLink() || realpathSync(path) !== path
          || key(opened) !== key(current) || opened.size < 0n || opened.size > 16n * 1024n * 1024n) fail();
        return { key: key(opened), size: Number(opened.size) };
      };
      const before = pin(), metadata = fstatSync(file), bytes = Buffer.alloc(before.size);
      let position = 0;
      while (position < bytes.length) {
        const count = readSync(file, bytes, position, Math.min(64 * 1024, bytes.length - position), position);
        if (count <= 0) fail();
        position += count;
      }
      if (before.key !== pin().key || root !== directory(sourceRoot) || checkout !== directory(cwd)) fail();
      if (evidence.directories.some((path, index) => directory(path) !== directories[index])) fail();
      assertClaudeSource(sourceRoot);
      return { root, checkout, directories, pin: before.key, size: metadata.size, mtime: metadata.mtimeMs, ctime: metadata.ctimeMs,
        ino: metadata.ino, dev: metadata.dev, sha256: createHash("sha256").update(bytes).digest("hex") };
    } finally { closeSync(file); }
  };
  const captured = capture();
  // Bind the synchronous proof to the SAME bytes and native file imported by the
  // SDK/raw continuity reader, not a fresh unrelated capture after its awaits.
  for (const key of ["size", "mtime", "ctime", "ino", "dev", "sha256"] as const) {
    if (captured[key] !== evidence[key]) fail();
  }
  const expected = JSON.stringify(captured);
  // The evidence is preparation-local, with no mutable decoded messages exposed.
  const pending: object[] = [messages];
  while (pending.length) {
    const value = pending.pop()!;
    for (const child of Object.values(value)) if (child && typeof child === "object") pending.push(child);
    Object.freeze(value);
  }
  return Object.freeze({ messages, assertCurrent: () => {
    try { if (JSON.stringify(capture()) !== expected) fail(); }
    catch (error) { throw new ClaudeHistorySnapshotChangedError(error); }
  } });
}

export function normalizeClaudeHistory(id: string, records: SessionMessage[]): MessageSnapshot[] {
  const messages = new Map<string, MessageSnapshot>();
  const tools = new Map<string, Extract<MessagePart, { type: "tool" }>>();
  for (const record of records) {
    if (record.session_id !== id) throw new Error("Native transcript session identity mismatch");
    if (!isClaudeRootRecord(record)) continue;
    const raw = record.message as { content?: unknown };
    const content = raw?.content;
    const parts: MessagePart[] = [];
    if (typeof content === "string") parts.push({ id: `${record.uuid}:text`, type: "text", text: content });
    if (Array.isArray(content)) for (const [index, part] of content.entries()) {
      if (part.type === "text" && typeof part.text === "string") parts.push({ id: `${record.uuid}:${index}`, type: "text", text: part.text });
      else if (part.type === "thinking" && typeof part.thinking === "string") parts.push({ id: `${record.uuid}:${index}`, type: "reasoning", text: part.thinking });
      else if (part.type === "tool_use" && typeof part.id === "string") {
        const tool: Extract<MessagePart, { type: "tool" }> = { id: part.id, type: "tool", name: part.name ?? "Tool", status: "unknown", input: part.input };
        tools.set(part.id, tool); parts.push(tool);
      } else if (part.type === "tool_result" && typeof part.tool_use_id === "string") {
        const tool = tools.get(part.tool_use_id);
        if (tool) { tool.output = part.content; tool.status = part.is_error ? "error" : "completed"; if (part.is_error) tool.error = part.content; }
      }
    }
    // SDK does not expose timestamps or run outcome. Empty time is deliberately
    // unavailable; order is native transcript order, never a fabricated clock.
    if (parts.length) messages.set(record.uuid, { messageId: record.uuid, role: record.type, parts, createdAt: "", status: "unknown" });
  }
  return [...messages.values()];
}
