import { getSessionInfo, getSessionMessages, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { MessagePart, MessageSnapshot } from "./oc-contract";
import type { Run, Session } from "./history";
import { uuid } from "./history";
import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
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
async function claudeCwdEvidence(id: string, cwd: string, root: string) {
  const project = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (!uuid(id) || project.length > 200) throw new Error("Unsupported Claude transcript locator; genuine native cwd evidence is unavailable");
  if (await realpath(root) !== root) throw new Error("Claude configuration root must be canonical for native attachment");
  const path = join(root, "projects", project, `${id}.jsonl`);
  if (await realpath(path) !== path) throw new Error("Claude transcript path must be canonical for native attachment");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > 16 * 1024 * 1024) throw new Error("Claude transcript is not a bounded local file");
    // Bounded read even if a concurrent native writer grows the file.
    const bytes = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bytes.length) { const result = await file.read(bytes, length, bytes.length - length, length); if (!result.bytesRead) break; length += result.bytesRead; }
    const after = await file.stat();
    if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Claude transcript changed while checking native cwd evidence");
    let found = false;
    for (const line of bytes.subarray(0, length).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (row.type === "relocated") throw new Error("Relocated Claude transcript requires unsupported locator verification; no cwd inferred");
      if (row.isSidechain || (row.type !== "user" && row.type !== "assistant")) continue;
      if (row.sessionId !== id) throw new Error("Claude raw transcript session identity mismatch");
      if (row.cwd !== undefined && row.cwd !== cwd) throw new Error("Claude raw transcript execution directory differs from the pinned conversation");
      if (row.cwd === cwd) found = true;
    }
    if (!found) throw new Error("Claude transcript has no genuine native cwd evidence; SDK project-path fallback is insufficient");
    return { size: before.size, mtime: before.mtimeMs, ctime: before.ctimeMs, ino: before.ino, dev: before.dev };
  } finally { await file.close(); }
}

/** SDK read-only transcript helpers plus raw local cwd evidence. Never invoke a native run. */
export async function readClaudeHistory(id: string, cwd: string, sourceRoot = claudeSourceRoot()) {
  assertClaudeSource(sourceRoot);
  const evidence = await claudeCwdEvidence(id, cwd, sourceRoot);
  const before = await getSessionInfo(id, { dir: cwd });
  if (!before || before.sessionId !== id || before.cwd !== cwd) throw new Error("Claude transcript missing or its execution directory differs from the pinned conversation");
  if (before.fileSize === undefined || before.fileSize > 16 * 1024 * 1024) throw new Error("Claude transcript size unavailable or exceeds 16 MiB import budget");
  if (before.fileSize !== evidence.size || before.lastModified !== Math.trunc(evidence.mtime)) throw new Error("SDK history does not match the verified local transcript");
  const records = await getSessionMessages(id, { dir: cwd, limit: 10001 });
  if (records.length > 10000) throw new Error("Claude transcript exceeds 10,000-message import budget");
  const after = await getSessionInfo(id, { dir: cwd });
  if (!after || after.sessionId !== id || after.cwd !== cwd || before.lastModified !== after.lastModified || before.fileSize !== after.fileSize) throw new Error("Claude transcript changed during reconciliation; retry after native activity settles");
  const finalEvidence = await claudeCwdEvidence(id, cwd, sourceRoot);
  if (JSON.stringify(evidence) !== JSON.stringify(finalEvidence)) throw new Error("Claude transcript changed during reconciliation; previous history preserved");
  assertClaudeSource(sourceRoot);
  return normalizeClaudeHistory(id, records);
}

export function normalizeClaudeHistory(id: string, records: SessionMessage[]): MessageSnapshot[] {
  const messages = new Map<string, MessageSnapshot>();
  const tools = new Map<string, Extract<MessagePart, { type: "tool" }>>();
  for (const record of records) {
    if (record.session_id !== id) throw new Error("Claude transcript session identity mismatch");
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
