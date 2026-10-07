import { createHash } from "node:crypto";
import type { Message, ToolPart } from "../shared/conversation/types";
import { isClaudeRootRecord } from "../shared/conversation/cc-scope";
import type { Event, Run, Session } from "./history";
import type { NativeSubagentStatus, NativeSubagentSummary } from "./native-subagent-contract";
import type { MessageSnapshot } from "./oc-contract";

type RecordValue = Record<string, any>;
type Child = { summary: NativeSubagentSummary; messages: Message[]; revision: string; seq: number };
type Alias = { id: string; child: Child; seq: number };
const object = (value: unknown): value is RecordValue => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;
const blocks = (value: unknown): RecordValue[] => Array.isArray(value) ? value.filter(object) : [];
export const nativeSubagentRevision = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("base64url");

export function projectNativeSubagents(session: Session, run: Run, events: readonly Event[]): Child[] {
  if (session.harness === "opencode") return projectOpenCodeSubagents(session, run, events);
  if (session.harness !== "claude-code" && session.harness !== undefined || !session.nativeSessionId) return [];
  const records = events.filter(event => event.runId === run.runId && event.sessionId === session.sessionId).flatMap(event => {
    const data = event.kind === "hook" && object(event.data) ? event.data.payload : event.kind === "stdout" ? event.data : undefined;
    return object(data) && data.session_id === session.nativeSessionId ? [{ event, data }] : [];
  });
  const children = new Map<string, Child>();
  for (const { event, data } of records) {
    if (event.kind !== "stdout" || data.type !== "assistant" || !isClaudeRootRecord(data)) continue;
    for (const block of blocks(data.message?.content)) {
      if (block.type !== "tool_use" || (block.name !== "Agent" && block.name !== "Task") || !text(block.id) || children.has(block.id)) continue;
      const input = object(block.input) ? block.input : {};
      children.set(block.id, {
        summary: { parentSessionId: session.sessionId, runId: run.runId, parentToolUseId: block.id, toolName: block.name,
          name: text(input.name) ?? text(input.subagent_type) ?? text(input.description), assignment: text(input.prompt),
          parentMessageId: text(data.message?.id), status: "unknown", activityObserved: false, toolCallCount: 0 },
        messages: [], revision: "", seq: event.seq,
      });
    }
  }
  const aliases: Alias[] = [];
  const addAlias = (id: unknown, child: Child, seq: number) => { if (text(id)) aliases.push({ id: id as string, child, seq }); };
  const rootResult = (data: RecordValue): { child: Child; result: RecordValue; block: RecordValue } | undefined => {
    if (data.type !== "user" || !isClaudeRootRecord(data)) return;
    const results = blocks(data.message?.content).filter(block => block.type === "tool_result");
    if (results.length !== 1) return;
    const block = results[0]!;
    const child = children.get(block.tool_use_id);
    if (child) return { child, result: object(data.tool_use_result) ? data.tool_use_result : {}, block };
  };
  for (const { event, data } of records) {
    if (event.kind !== "stdout") continue;
    const child = children.get(data.tool_use_id);
    if (child && data.type === "system" && ["task_started", "task_progress", "task_notification"].includes(data.subtype)) addAlias(data.task_id, child, event.seq);
    const result = rootResult(data);
    if (result) {
      addAlias(result.result.agentId, result.child, event.seq);
      addAlias(result.result.taskId, result.child, event.seq);
    }
  }
  const associated = (id: unknown, seq: number): Child | undefined => {
    if (!text(id)) return;
    const candidates = aliases.filter(alias => alias.id === id && alias.child.seq <= seq);
    // Alias timing does not prove nonoverlapping child lifecycles. Include
    // explicit aliases learned later, but never children not yet created.
    const distinct = new Set(candidates.map(alias => alias.child));
    return distinct.size === 1 ? distinct.values().next().value : undefined;
  };
  const warning = (child: Child, value: string) => {
    const warnings = child.summary.warnings ??= [];
    if (!warnings.includes(value)) warnings.push(value);
  };
  const terminal = (status: NativeSubagentStatus) => status === "completed" || status === "failed" || status === "interrupted";
  const status = (child: Child, value: NativeSubagentStatus, kind: string, event: Event) => {
    if (value === "running" && terminal(child.summary.status)) return;
    child.summary.status = value;
    child.summary.statusEvidence = { kind, seq: event.seq, time: event.time };
  };
  const messageMaps = new Map<Child, Map<string, Message>>();
  const deliveredBlocks = new Map<Message, RecordValue[]>();
  const tools = new Map<Child, Map<string, ToolPart>>();
  const results = new Map<Child, Map<string, { output: unknown; error?: boolean }>>();
  const seen = new Map<Child, Set<string>>();
  const namespace = (child: Child, kind: string, id: string) => `native-subagent:${Buffer.from(JSON.stringify([session.sessionId, run.runId, child.summary.parentToolUseId, kind, id])).toString("base64url")}`;
  for (const { event, data } of records) {
    const result = event.kind === "stdout" ? rootResult(data) : undefined;
    if (result) {
      if (result.result.status === "completed") {
        status(result.child, "completed", "agent-result-completed", event);
        const report = blocks(result.result.content).filter(block => block.type === "text" && typeof block.text === "string").map(block => block.text).join("\n");
        if (report) result.child.summary.returnedReport = report;
      } else if (result.result.status === "async_launched" || result.result.status === "remote_launched") {
        status(result.child, "running", `agent-result-${result.result.status}`, event);
      } else if (result.block.is_error === true) status(result.child, "failed", "agent-tool-result-error", event);
      else warning(result.child, "The recorded delegation result does not confirm the child lifecycle or a final report.");
    }
    if (event.kind === "stdout" && data.type === "system" && ["task_started", "task_progress", "task_notification", "task_updated"].includes(data.subtype)) {
      const direct = text(data.tool_use_id) ? children.get(data.tool_use_id) : undefined;
      const child = direct ?? (!text(data.tool_use_id) ? associated(data.task_id, event.seq) : undefined);
      if (child) {
        if (data.subtype === "task_notification") {
          const value = data.status === "completed" ? "completed" : data.status === "failed" ? "failed" : data.status === "stopped" ? "interrupted" : undefined;
          if (value) status(child, value, `task-notification-${data.status}`, event);
        } else if (data.subtype === "task_updated") {
          const value = data.patch?.status === "completed" ? "completed" : data.patch?.status === "failed" ? "failed" : data.patch?.status === "killed" ? "interrupted" : data.patch?.status === "running" ? "running" : undefined;
          if (value) status(child, value, `task-updated-${data.patch.status}`, event);
        } else status(child, "running", data.subtype, event);
      }
    }
    if (event.kind === "hook" && (data.hook_event_name === "SubagentStart" || data.hook_event_name === "SubagentStop")) {
      const child = associated(data.agent_id, event.seq);
      if (child && data.hook_event_name === "SubagentStart") status(child, "running", "SubagentStart", event);
      if (child && data.hook_event_name === "SubagentStop" && !terminal(child.summary.status)) warning(child, "A recorded SubagentStop hook alone does not confirm terminal completion.");
      continue;
    }
    if (event.kind !== "stdout" || !text(data.parent_tool_use_id) || (data.type !== "assistant" && data.type !== "user")) continue;
    const child = children.get(data.parent_tool_use_id);
    if (!child || event.seq < child.seq) continue;
    let deliveries = seen.get(child);
    if (!deliveries) seen.set(child, deliveries = new Set());
    if (text(data.uuid)) {
      if (deliveries.has(data.uuid)) continue;
      deliveries.add(data.uuid);
    }
    let childTools = tools.get(child);
    if (!childTools) tools.set(child, childTools = new Map());
    let childResults = results.get(child);
    if (!childResults) results.set(child, childResults = new Map());
    const content = typeof data.message?.content === "string" ? [{ type: "text", text: data.message.content }] : blocks(data.message?.content);
    for (const block of content) {
      if (block.type !== "tool_result" || !text(block.tool_use_id)) continue;
      const output = { output: block.content, error: block.is_error === true };
      childResults.set(block.tool_use_id, output);
      const tool = childTools.get(block.tool_use_id);
      if (tool) Object.assign(tool, output, { toolStatus: output.error ? "failed" : "completed" });
      child.summary.activityObserved = true;
    }
    const visible = content.filter(block => ["text", "thinking", "tool_use"].includes(block.type));
    if (!visible.length) continue;
    child.summary.activityObserved = true;
    let messages = messageMaps.get(child);
    if (!messages) messageMaps.set(child, messages = new Map());
    const nativeId = text(data.message?.id);
    const localId = `${data.type}:${nativeId ?? text(data.uuid) ?? event.seq}`;
    let message = messages.get(localId);
    if (!message) {
      message = { id: namespace(child, "message", localId), nativeIds: [nativeId, text(data.uuid)].filter((id): id is string => !!id),
        runId: run.runId, role: data.type, parts: [], time: event.time, status: "unknown" };
      messages.set(localId, message);
      child.messages.push(message);
    } else if (text(data.uuid) && !message.nativeIds?.includes(data.uuid)) message.nativeIds?.push(data.uuid);
    const delivered = deliveredBlocks.get(message) ?? [];
    let prefix = 0;
    if (visible.length > 1) {
      while (prefix < delivered.length && prefix < visible.length && JSON.stringify(delivered[prefix]) === JSON.stringify(visible[prefix])) prefix++;
    }
    for (const block of visible.slice(prefix)) {
      if (block.type === "text" && typeof block.text === "string") message.parts.push({ type: "text", text: block.text });
      if (block.type === "thinking" && typeof block.thinking === "string") message.parts.push({ type: "reasoning", id: namespace(child, "reasoning", `${localId}:${message.parts.length}`), text: block.thinking });
      if (block.type === "tool_use" && text(block.id) && text(block.name)) {
        let tool = childTools.get(block.id);
        if (!tool) {
          const output = childResults.get(block.id);
          tool = { type: "tool", id: namespace(child, "tool", block.id), toolCallId: block.id, name: block.name, input: block.input,
            ...output, toolStatus: output ? output.error ? "failed" : "completed" : "running" };
          childTools.set(block.id, tool);
        }
        if (!message.parts.includes(tool)) message.parts.push(tool);
      }
      delivered.push(block);
    }
    deliveredBlocks.set(message, delivered);
  }
  for (const child of children.values()) {
    child.summary.toolCallCount = tools.get(child)?.size ?? 0;
    if (!child.summary.activityObserved) warning(child, "No associated child text or tools were recorded; coverage is recorded-only.");
    if (!terminal(child.summary.status) && run.status !== "running") {
      child.summary.status = "unknown";
      warning(child, "The parent run ended without confirmed terminal child evidence.");
    }
    for (const message of child.messages) message.status = message.role === "user" ? "completed" : child.summary.status;
    child.revision = nativeSubagentRevision({ subagent: child.summary, messages: child.messages });
  }
  return [...children.values()];
}

/** Native child snapshots never enter the parent transcript reducer. */
export type OpenCodeSubagentEvidence = {
  parentNativeSessionId: string; parentToolUseId: string; nativeSessionId: string;
  messages?: MessageSnapshot[]; messageIds?: string[];
  status?: NativeSubagentStatus; warning?: string;
};

function projectOpenCodeSubagents(session: Session, run: Run, events: readonly Event[]): Child[] {
  if (!session.nativeSessionId) return [];
  const records = events.filter(event => event.runId === run.runId && event.sessionId === session.sessionId);
  const parents = new Map<string, { snapshot: MessageSnapshot; event: Event }>();
  for (const event of records) if (event.kind === "message" && object(event.data) && Array.isArray(event.data.parts)) {
    parents.set(event.data.messageId, { snapshot: event.data as MessageSnapshot, event });
  }
  const children = new Map<string, Child>();
  for (const { snapshot, event } of parents.values()) {
    if (snapshot.role !== "assistant") continue;
    for (const part of snapshot.parts) {
      if (part.type !== "tool" || part.name !== "subagent") continue;
      const input = object(part.input) ? part.input : {};
      children.set(part.id, { summary: { parentSessionId: session.sessionId, runId: run.runId, parentToolUseId: part.id,
        harness: "opencode", toolName: "subagent", nativeSessionId: part.nativeSubagentSessionId,
        name: text(input.agent) ?? text(input.description), assignment: text(input.prompt), parentMessageId: snapshot.messageId,
        status: "unknown", activityObserved: false, toolCallCount: 0,
        ...(part.error !== undefined ? { warnings: ["The delegation tool reported an error; child completion is unconfirmed."] } : {}),
      }, messages: [], revision: "", seq: event.seq });
    }
  }
  const snapshots = new Map<Child, Map<string, MessageSnapshot>>();
  for (const event of records) {
    if (event.kind !== "native-subagent" || !object(event.data)) continue;
    const data = event.data as OpenCodeSubagentEvidence, child = children.get(data.parentToolUseId);
    if (!child || data.parentNativeSessionId !== session.nativeSessionId || data.nativeSessionId !== child.summary.nativeSessionId) continue;
    if (data.warning) child.summary.warnings = [data.warning];
    if (data.status) {
      child.summary.status = data.status;
      child.summary.statusEvidence = { kind: "native-child-observation", seq: event.seq, time: event.time };
      child.summary.warnings = undefined;
    }
    let messages = snapshots.get(child);
    if (!messages) snapshots.set(child, messages = new Map());
    for (const message of data.messages ?? []) messages.set(message.messageId, message);
    if (data.messageIds) {
      const ordered = new Map<string, MessageSnapshot>();
      for (const id of data.messageIds) { const message = messages.get(id); if (message) ordered.set(id, message); }
      snapshots.set(child, ordered);
    }
  }
  for (const child of children.values()) {
    const namespace = (kind: string, id: string) => `native-subagent:${Buffer.from(JSON.stringify([session.sessionId, run.runId, child.summary.parentToolUseId, kind, id])).toString("base64url")}`;
    child.messages = [...(snapshots.get(child)?.values() ?? [])].filter(message => !message.compaction && (message.role !== "system" || message.parts.length)).map(message => ({
      id: namespace("message", message.messageId), nativeIds: [message.messageId], runId: run.runId, role: message.role,
      time: message.createdAt, status: message.status, normalized: true, error: message.error, nativeSubagentResult: message.nativeSubagentResult, nativeShellResult: message.nativeShellResult,
      parts: message.parts.map(part => part.type === "tool" ? { type: "tool", id: namespace("tool", part.id), toolCallId: part.id,
        name: part.name, input: part.input, output: part.output ?? part.error, error: part.error !== undefined, toolStatus: part.status }
        : { type: part.type, text: part.text, ...(part.type === "reasoning" ? { id: namespace("reasoning", part.id) } : {}) }),
    }));
    child.summary.activityObserved = child.messages.length > 0;
    child.summary.toolCallCount = new Set(child.messages.flatMap(message => message.parts.flatMap(part => part.type === "tool" ? [part.id] : []))).size;
    if (!child.summary.activityObserved) (child.summary.warnings ??= []).push("No associated child text or tools were recorded; coverage is recorded-only.");
    if (child.summary.status === "completed") {
      const last = child.messages.findLast(message => message.role === "assistant");
      const report = last?.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
      if (report) child.summary.returnedReport = report;
    }
    child.revision = nativeSubagentRevision({ subagent: child.summary, messages: child.messages });
  }
  return [...children.values()];
}
