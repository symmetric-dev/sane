import { active, type DiagnosticEvent, type Message, type Run, type RunMetadata, type ToolPart } from "./types";
import type { MessageSnapshot } from "../src/oc-contract";

export function createRun(meta: RunMetadata): Run {
  return { ...meta, messages: [], events: [], seen: new Set(), cursor: 0, buffer: "", observedEfforts: [], resultCount: 0, resultKeys: new Set(), toolResults: new Map() };
}
const object = (value: any): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
function user(run: Run, text: string, time: string, id = `${run.id}:user`) {
  const message: Message = { id, runId: run.id, role: "user", parts: [{ type: "text", text }], time, status: "completed" };
  const index = run.messages.findIndex(m => m.id === id);
  if (index < 0) run.messages.unshift(message); else run.messages[index] = message;
}
function tool(run: Run, id: string): ToolPart | undefined {
  return run.messages.flatMap(m => m.parts).find((p): p is ToolPart => p.type === "tool" && p.id === `${run.id}:${id}`);
}
function record(run: Run, value: unknown, event: DiagnosticEvent) {
  if (!object(value)) return;
  if (run.operation === "compact") return;
  const r = value;
  if (r.session_id && r.session_id !== (run.nativeSessionId ?? run.conversationId)) return;
  if (r.type === "system" && r.subtype === "init" && typeof r.model === "string") run.observedModel = r.model;
  if (r.type === "result") {
    const key = r.uuid || JSON.stringify(r);
    run.resultKeys.add(key); run.resultCount = run.resultKeys.size;
    if (r.session_id === (run.nativeSessionId ?? run.conversationId)) run.usage ??= { runId: run.id, time: event.time, record: r };
    if (typeof r.result === "string") run.result = r.result;
  }
  const content = r.message?.content ?? r.content;
  if (r.type === "assistant") {
    const id = `${run.id}:assistant:${r.message?.id || r.uuid || event.seq}`;
    const previous = run.messages.find(m => m.id === id);
    const parts: Message["parts"] = typeof content === "string" ? [{ type: "text", text: content }] : [];
    if (Array.isArray(content)) for (const p of content) {
      if (p.type === "text" && typeof p.text === "string") parts.push({ type: "text", text: p.text });
      if (p.type === "thinking" && typeof p.thinking === "string") parts.push({ type: "reasoning", text: p.thinking });
      if (p.type === "tool_use" && typeof p.id === "string") {
        const existing = tool(run, p.id) ?? run.toolResults.get(`${run.id}:${p.id}`);
        parts.push({ type: "tool", id: `${run.id}:${p.id}`, toolCallId: p.id, name: p.name || "Tool", input: p.input, ...(existing?.output !== undefined ? { output: existing.output, error: existing.error } : {}) });
      }
    }
    if (previous) {
      if (typeof r.uuid === "string" && !previous.nativeIds?.includes(r.uuid)) (previous.nativeIds ??= []).push(r.uuid);
      // CLI can emit multiple content blocks with the same message ID.
      for (const part of parts) {
        const index = previous.parts.findIndex(p => part.type === "tool" ? p.type === "tool" && p.id === part.id : p.type !== "tool" && p.type === part.type && p.text === part.text);
        if (index < 0) previous.parts.push(part); else previous.parts[index] = part;
      }
    } else if (parts.length) run.messages.push({ id, nativeIds: typeof r.uuid === "string" ? [r.uuid] : [], runId: run.id, role: "assistant", parts, time: event.time, status: run.status });
  }
  if (r.type === "user" && Array.isArray(content)) for (const p of content) {
    if (p.type === "tool_result" && typeof p.tool_use_id === "string") {
      const match = tool(run, p.tool_use_id);
      run.toolResults.set(`${run.id}:${p.tool_use_id}`, { output: p.content, error: Boolean(p.is_error) });
      if (match) { match.output = p.content; match.error = Boolean(p.is_error); }
    }
  }
}
function stdout(run: Run, value: unknown, event: DiagnosticEvent) {
  if (object(value)) { record(run, value, event); return; }
  if (typeof value !== "string") return;
  run.buffer += value;
  const lines = run.buffer.split("\n"); run.buffer = lines.pop() || "";
  for (const line of lines) { try { record(run, JSON.parse(line), event); } catch { /* Non-JSON output remains in diagnostics. */ } }
  try { const parsed = JSON.parse(run.buffer); record(run, parsed, event); run.buffer = ""; } catch { /* Incomplete record: retain the transport buffer. */ }
}
export function consume(run: Run, events: DiagnosticEvent[]) {
  for (const event of events) {
    if (event.runId !== run.id || event.sessionId !== run.conversationId || run.seen.has(event.seq)) continue;
    run.seen.add(event.seq); run.events.push(event);
    if (run.operation !== "compact" && event.kind === "submission" && object(event.data) && typeof event.data.text === "string") user(run, event.data.text, event.time, event.data.messageId);
    if (event.kind === "message" && object(event.data)) {
      const snapshot = event.data as MessageSnapshot;
      if (snapshot.compaction || run.operation === "compact") continue;
      if (snapshot.role === "system" && !snapshot.parts.length) continue;
      const message: Message = { id: snapshot.messageId, runId: run.id, role: snapshot.role, time: snapshot.createdAt, status: snapshot.status, normalized: true, error: snapshot.error,
        parts: snapshot.parts.map(p => p.type === "tool" ? { type: "tool", id: p.id, toolCallId: p.id, name: p.name, input: p.input, toolStatus: p.status, output: p.output ?? p.error, error: p.error !== undefined } : { type: p.type, text: p.text, ...(p.type === "reasoning" ? { id: p.id } : {}) }) };
      const index = run.messages.findIndex(m => m.id === message.id);
      if (index < 0) run.messages.push(message); else run.messages[index] = message;
      if (snapshot.usage) { run.nativeUsage = snapshot.usage; run.nativeUsageTime = event.time; }
    }
    if (event.kind === "status" && object(event.data)) {
      if (typeof event.data.connection === "string") { run.nativeConnection = event.data.connection; run.nativeReason = event.data.reason; }
      if (event.data.status && !active(event.data.status)) { run.nativeConnection = undefined; run.nativeReason = event.data.reason; }
    }
    if (event.kind === "stdout" && run.harness !== "opencode") stdout(run, event.data, event);
    if (event.kind === "hook" && run.harness !== "opencode") {
      let data = event.data;
      if (typeof data === "string") { try { data = JSON.parse(data); } catch { continue; } }
      const p = object(data) ? data.payload ?? data : undefined;
      if (!object(p) || p.session_id !== (run.nativeSessionId ?? run.conversationId) || p.agent_id) continue;
      if (run.operation !== "compact" && p.hook_event_name === "UserPromptSubmit" && typeof p.prompt === "string" && !run.messages.some(m => m.role === "user")) user(run, p.prompt, event.time);
      if (typeof p.effort?.level === "string" && !run.observedEfforts.includes(p.effort.level)) run.observedEfforts.push(p.effort.level);
      if (typeof p.tool_use_id === "string") {
        const match = tool(run, p.tool_use_id);
        if (p.hook_event_name === "PostToolUse") run.toolResults.set(`${run.id}:${p.tool_use_id}`, { output: p.tool_response });
        if (p.hook_event_name === "PostToolUseFailure") run.toolResults.set(`${run.id}:${p.tool_use_id}`, { output: p.error, error: true });
        if (match && p.hook_event_name === "PostToolUse") match.output = p.tool_response;
        if (match && p.hook_event_name === "PostToolUseFailure") { match.output = p.error; match.error = true; }
      }
    }
  }
}
export function messagesForRun(run: Run): Message[] {
  if (run.operation === "compact") return [];
  const messages = run.messages.map(m => ({ ...m, parts: m.parts.map(p => ({ ...p })), status: m.role === "assistant" && (!m.normalized || (active(m.status) && !active(run.status))) ? run.status : m.status }));
  // Result is a fallback only: assistant records are the canonical transcript.
  if (run.result && !messages.some(m => m.role === "assistant" && m.parts.some(p => p.type === "text" && p.text.trim()))) {
    messages.push({ id: `${run.id}:result`, runId: run.id, role: "assistant", parts: [{ type: "text", text: run.result }], time: run.createdAt, status: run.status });
  }
  if (!active(run.status) && !messages.some(m => m.role === "assistant")) {
    messages.push({ id: `${run.id}:empty`, runId: run.id, role: "assistant", parts: [{ type: "text", text: "No assistant response was recorded for this run." }], time: run.createdAt, status: run.status });
  }
  return messages;
}
