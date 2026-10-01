import { forkSession, getSessionInfo, getSessionMessages, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { MessagePart, MessageSnapshot } from "./oc-contract";
import type { Run, Session } from "./history";
import { uuid } from "./history";
import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { assertClaudeSource, claudeSourceRoot } from "./claude-source";

export function coveredNativeRuns(session: Session, runs: Run[], messages: MessageSnapshot[]) {
  if (session.harness !== "opencode") return [];
  const nativeUsers = new Set(messages.filter(m => m.role === "user").map(m => m.messageId));
  return runs.filter(r => r.sessionId === session.sessionId && r.nativeCommandId && nativeUsers.has(r.nativeCommandId)).map(r => r.runId);
}

export type ReconciledHistory = {
  sessionId: string; nativeSessionId: string; importedAt: string;
  activity: "active" | "idle" | "unknown"; reason: string;
  coveredRunIds: string[]; messages: MessageSnapshot[];
};

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
    const directories = new Set<string>();
    for (const line of bytes.subarray(0, length).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (row.type === "relocated") throw new Error("Relocated native transcript requires unsupported locator verification; no cwd inferred");
      if (row.isSidechain || (row.type !== "user" && row.type !== "assistant")) continue;
      if (row.sessionId !== id) throw new Error("Native raw transcript session identity mismatch");
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
    return { size: before.size, mtime: before.mtimeMs, ctime: before.ctimeMs, ino: before.ino, dev: before.dev, directories: [...directories] };
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
  return normalizeClaudeHistory(id, records);
}

export function normalizeClaudeHistory(id: string, records: SessionMessage[]): MessageSnapshot[] {
  const messages = new Map<string, MessageSnapshot>();
  const tools = new Map<string, Extract<MessagePart, { type: "tool" }>>();
  for (const record of records) {
    if (record.session_id !== id) throw new Error("Native transcript session identity mismatch");
    if (record.parent_tool_use_id || record.parent_agent_id) continue;
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
