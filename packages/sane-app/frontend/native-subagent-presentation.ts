import type { NativeSubagentKey, NativeSubagentSummary } from "../src/native-subagent-contract";
import type { Harness, Message, Run, ToolPart } from "./types";

export const nativeSubagentId = (key: NativeSubagentKey) => JSON.stringify([key.parentSessionId, key.runId, key.parentToolUseId]);

export function nativeSubagentKey(sessionId: string, source: Message, part: ToolPart, runs: Run[], harness: Harness): NativeSubagentKey | null {
  if (source.role !== "assistant" || (harness === "opencode" ? part.name !== "subagent" : part.name !== "Agent" && part.name !== "Task")) return null;
  const run = runs.find(run => run.id === source.runId && run.conversationId === sessionId);
  if (!run || run.harness && run.harness !== harness) return null;
  return { parentSessionId: sessionId, runId: source.runId, parentToolUseId: part.toolCallId ?? part.id };
}

export function nativeSubagentFallback(key: NativeSubagentKey, part: ToolPart): NativeSubagentSummary {
  const input = part.input && typeof part.input === "object" ? part.input as Record<string, unknown> : {};
  const text = (value: unknown) => typeof value === "string" && value.trim() ? value : undefined;
  return { ...key, toolName: part.name === "subagent" ? "subagent" : part.name === "Task" ? "Task" : "Agent", harness: part.name === "subagent" ? "opencode" : "claude-code", name: text(input.name) ?? text(input.agent) ?? text(input.description) ?? text(input.subagent_type), assignment: text(input.prompt), status: "unknown", activityObserved: false, toolCallCount: 0, ...(part.error ? { warnings: [`Reported tool error: ${typeof part.output === "string" ? part.output : JSON.stringify(part.output ?? { error: true }, null, 2)}`] } : {}) };
}
