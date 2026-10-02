import type { CompactionRecord, MessageSnapshot } from "../src/oc-contract";
import type { ReconciledHistory } from "../src/reconcile";
import type { Harness, ModelChoice, Run } from "./types";

export type ContextUsageSnapshot = { tokens: number; capacity: number; percentage: number; model: string; time: string; stale?: boolean };
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
    if (event.kind === "message" && object(event.data) && event.data.compaction?.lifecycle === "completed") {
      yield { record: { type: "system", subtype: "compact_boundary", session_id: run.nativeSessionId ?? run.conversationId, uuid: event.data.compaction.nativeId ?? event.data.messageId }, time: event.time };
    }
    if (event.kind === "hook" && object(event.data) && object(event.data.payload)) {
      const hook = event.data.payload;
      if (event.data.event === "PostCompact" && hook.hook_event_name === "PostCompact" && hook.compact_result !== "failed" && hook.compact_result !== "skipped" && hook.compact_error === undefined) yield { record: { ...hook, type: "system", subtype: "compact_boundary" }, time: event.time };
    }
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
  const boundaries = new Set<string>();
  let input: InputUsage | undefined, model: string | undefined, inputId: string | undefined;
  for (const run of runs) for (const { record: r, time } of claudeRecords(run)) {
    if (r.session_id !== (run.nativeSessionId ?? run.conversationId) || r.parent_tool_use_id || r.parent_agent_id || r.subagent_type || r.agent_id || r.isSidechain) continue;
    const boundary = r.type === "system" && (r.subtype === "compact_boundary" || r.subtype === "status" && r.compact_result === "success" && r.compact_error === undefined);
    if (boundary && (typeof r.uuid !== "string" || !boundaries.has(r.uuid))) { input = undefined; if (typeof r.uuid === "string") boundaries.add(r.uuid); }
    if (run.operation === "compact") continue;
    const reportedModel = r.type === "system" && r.subtype === "init" ? r.model : r.type === "assistant" ? r.message?.model : undefined;
    if (typeof reportedModel === "string" && reportedModel) {
      if (model && model !== reportedModel) input = undefined;
      model = reportedModel;
    }
    if (r.type === "assistant") {
      if (typeof r.uuid === "string") observedIds.add(r.uuid);
      const usage = r.message?.usage;
      const tokens = inputTokens(usage?.input_tokens, usage?.cache_read_input_tokens, usage?.cache_creation_input_tokens);
      if (tokens !== undefined && model) { input = { tokens, model, time }; inputId = typeof r.uuid === "string" ? r.uuid : undefined; }
    }
    // The result supplies capacity only. Its usage/modelUsage tokens are cumulative.
    if (r.type === "result" && object(r.modelUsage)) for (const [id, usage] of Object.entries(r.modelUsage)) {
      if (object(usage) && count(usage.contextWindow) && usage.contextWindow > 0) windows.set(id, usage.contextWindow);
    }
  }
  // A refreshed external Claude response has no usable metrics in SDK history.
  // Do not mislabel an older App response as that conversation's latest context.
  const imported = history?.messages ?? [];
  const inputIndex = imported.findIndex(message => message.messageId === inputId);
  const boundaryIndex = imported.findLastIndex(message => message.compaction?.lifecycle === "completed");
  if (input && history && input.time <= history.importedAt && boundaryIndex >= 0) {
    const boundary = imported[boundaryIndex]!;
    // Native order provides the evidence even when CC SDK omits timestamps.
    // Never apply an imported observation clock as the boundary's native time.
    if (inputIndex >= 0 && boundaryIndex > inputIndex || inputIndex < 0 && boundary.createdAt && boundary.createdAt >= input.time) input = undefined;
  }
  const latestImported = imported.findLast(message => !message.compaction && message.role === "assistant");
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
    if (run.operation === "compact" && !message.compaction) continue;
    if (history && event.time <= history.importedAt && messages.has(message.messageId)) continue;
    messages.set(message.messageId, { message, time: event.time });
  }
  let input: InputUsage | undefined, model: string | undefined;
  const ordered = [...messages.values()];
  // OC has native timestamps; absent times retain native import/UPSERT order.
  if (ordered.every(entry => entry.message.createdAt)) ordered.sort((a, b) => a.message.createdAt.localeCompare(b.message.createdAt) || a.message.messageId.localeCompare(b.message.messageId));
  for (const { message, time } of ordered) {
    if (message.compaction) { if (message.compaction.lifecycle === "completed") input = undefined; continue; }
    if (message.contextReset && message.status === "completed") input = undefined;
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
export function contextUsageFor(harness: Harness, runs: Run[], models: ModelChoice[], history?: ReconciledHistory | null, compactions: CompactionRecord[] = []): ContextUsageSnapshot | null {
  let usage = harness === "opencode" ? openCodeUsage(runs, models, history) : claudeUsage(runs, history);
  // Snapshot boundaries were already applied in native order. Their most recent
  // observation (including a repeated import/UPSERT) is not a new reset clock.
  const snapshotIds = new Set([...(history?.messages ?? []), ...runs.flatMap(run => run.events.filter(event => event.kind === "message" && object(event.data)).map(event => event.data as MessageSnapshot))].filter(message => message.compaction).map(message => message.compaction?.nativeId ?? message.messageId));
  if (harness === "claude-code") for (const run of runs) for (const { record } of claudeRecords(run)) {
    if (record.type === "system" && record.subtype === "compact_boundary" && typeof record.uuid === "string") snapshotIds.add(record.uuid);
  }
  if (usage && compactions.some(record => record.contextReset && (!record.nativeId || !snapshotIds.has(record.nativeId)) && (record.endedAt ?? record.observedAt ?? "") > usage!.time)) usage = null;
  return usage && compactions.some(record => record.lifecycle === "running") ? { ...usage, stale: true } : usage;
}
