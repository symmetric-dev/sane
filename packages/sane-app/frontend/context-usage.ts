import type { MessageSnapshot } from "../src/oc-contract";
import type { ReconciledHistory } from "../src/reconcile";
import type { Harness, ModelChoice, Run } from "./types";

export type ContextUsageSnapshot = { tokens: number; capacity: number; percentage: number; model: string; time: string };
type InputUsage = { tokens: number; model: string; time: string };
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Cache categories are disjoint from fresh input. Never sum requests or add output. */
function inputTokens(input: unknown, read: unknown, write: unknown): number | undefined {
  const cachedRead = read ?? 0, cachedWrite = write ?? 0;
  if (!count(input) || !count(cachedRead) || !count(cachedWrite)) return;
  const total = input + cachedRead + cachedWrite;
  return Number.isFinite(total) ? total : undefined;
}
function snapshot(input: InputUsage | undefined, capacity: unknown): ContextUsageSnapshot | null {
  if (!input || !count(capacity) || capacity <= 0) return null;
  return { ...input, capacity, percentage: input.tokens / capacity * 100 };
}

/** CLI stdout is normally already parsed by the bridge; older logs may contain chunks. */
function* claudeRecords(run: Run): Generator<{ record: Record<string, any>; time: string }> {
  let buffer = "";
  for (const event of run.events) {
    if (event.kind !== "stdout") continue;
    if (object(event.data)) { yield { record: event.data, time: event.time }; continue; }
    if (typeof event.data !== "string") continue;
    buffer += event.data;
    const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
    for (const line of lines) {
      try { const record: unknown = JSON.parse(line); if (object(record)) yield { record, time: event.time }; } catch { /* Diagnostic, not usage. */ }
    }
    try { const record: unknown = JSON.parse(buffer); if (object(record)) yield { record, time: event.time }; buffer = ""; } catch { /* Incomplete chunk. */ }
  }
}

function claudeUsage(runs: Run[], history?: ReconciledHistory | null): ContextUsageSnapshot | null {
  const windows = new Map<string, number>(), observedIds = new Set<string>();
  let input: InputUsage | undefined, model: string | undefined;
  for (const run of runs) for (const { record: r, time } of claudeRecords(run)) {
    if (r.session_id !== (run.nativeSessionId ?? run.conversationId) || r.parent_tool_use_id || r.parent_agent_id || r.subagent_type) continue;
    if (r.type === "system" && r.subtype === "compact_boundary") input = undefined;
    const reportedModel = r.type === "system" && r.subtype === "init" ? r.model : r.type === "assistant" ? r.message?.model : undefined;
    if (typeof reportedModel === "string" && reportedModel) {
      if (model && model !== reportedModel) input = undefined;
      model = reportedModel;
    }
    if (r.type === "assistant") {
      if (typeof r.uuid === "string") observedIds.add(r.uuid);
      const usage = r.message?.usage;
      const tokens = inputTokens(usage?.input_tokens, usage?.cache_read_input_tokens, usage?.cache_creation_input_tokens);
      if (tokens !== undefined && model) input = { tokens, model, time };
    }
    // The result supplies capacity only. Its usage/modelUsage tokens are cumulative.
    if (r.type === "result" && object(r.modelUsage)) for (const [id, usage] of Object.entries(r.modelUsage)) {
      if (object(usage) && count(usage.contextWindow) && usage.contextWindow > 0) windows.set(id, usage.contextWindow);
    }
  }
  // A refreshed external Claude response has no usable metrics in SDK history.
  // Do not mislabel an older App response as that conversation's latest context.
  const latestImported = history?.messages.findLast(message => message.role === "assistant");
  if (input && latestImported && !observedIds.has(latestImported.messageId) && history!.importedAt >= input.time) return null;
  return snapshot(input, input ? windows.get(input.model) : undefined);
}

function openCodeUsage(runs: Run[], models: ModelChoice[], history?: ReconciledHistory | null): ContextUsageSnapshot | null {
  // Message events are UPSERTs: replacing an older message must not move it after
  // newer responses or make a repeated compaction snapshot clear newer usage.
  const messages = new Map<string, { message: MessageSnapshot; time: string }>();
  for (const message of history?.messages ?? []) messages.set(message.messageId, { message, time: history!.importedAt });
  for (const run of runs) for (const event of run.events) {
    if (event.kind !== "message" || !object(event.data)) continue;
    const message = event.data as MessageSnapshot;
    if (history && event.time <= history.importedAt && messages.has(message.messageId)) continue;
    messages.set(message.messageId, { message, time: event.time });
  }
  let input: InputUsage | undefined, model: string | undefined;
  const ordered = [...messages.values()].sort((a, b) => a.message.createdAt.localeCompare(b.message.createdAt) || a.message.messageId.localeCompare(b.message.messageId));
  for (const { message, time } of ordered) {
    if (message.contextReset) input = undefined;
    if (message.model) {
      if (model && model !== message.model) input = undefined;
      model = message.model;
    }
    if (message.role !== "assistant" || !object(message.usage?.tokens)) continue;
    const usage = message.usage.tokens;
    const tokens = inputTokens(usage.input, usage.cache?.read, usage.cache?.write);
    // Older snapshots lack model identity; never guess from the model picker.
    if (tokens !== undefined) input = message.model ? { tokens, model: message.model, time } : undefined;
  }
  return snapshot(input, models.find(entry => entry.id === input?.model)?.contextWindow);
}

/** Last-reported model-window usage, not a live token counter or compaction threshold. */
export function contextUsageFor(harness: Harness, runs: Run[], models: ModelChoice[], history?: ReconciledHistory | null): ContextUsageSnapshot | null {
  return harness === "opencode" ? openCodeUsage(runs, models, history) : claudeUsage(runs, history);
}
