import type { HandoffPresentation } from "../src/handoff-contract";
import type { NativeSubagentKey } from "../src/native-subagent-contract";
import type { WorkerRecord } from "../src/worker-contract";
import { isHandoffTool, sentHandoffs } from "./handoff-presentation";
import { nativeSubagentKey } from "./native-subagent-presentation";
import { active, type Harness, type Message, type Run, type TextPart, type ToolPart } from "./types";
import { dispatchedWorkers } from "./worker-presentation";

type ActivityPart = Extract<TextPart, { type: "reasoning" }> | ToolPart;
export type ActivityEntry = { id: string; messageId: string; index: number; type: "reasoning" | "tool"; name: string; status?: string; error?: boolean };
export type ActivityDetail = { id: string; source: Message; index: number; part: ActivityPart };
export type ActivitySegment = { id: string; type: ActivityEntry["type"]; name: string; entries: ActivityEntry[]; status?: string; error?: boolean };
export type TranscriptToolClassification = { kind: "activity" } | { kind: "native-subagent"; key: NativeSubagentKey } | { kind: "handoff"; handoffs: HandoffPresentation[] } | { kind: "pending-handoff" } | { kind: "worker"; workers: WorkerRecord[] };

export function activityEntryId(source: Message, part: ActivityPart, index: number): string {
  let ordinal = 0;
  if (part.type === "reasoning" && part.id === undefined) {
    for (let before = 0; before < index; before++) if (source.parts[before]?.type === "reasoning") ordinal++;
  }
  const identity = part.type === "tool" ? part.id : part.id ?? ordinal;
  return JSON.stringify([source.id, part.type, identity]);
}

export function createActivityEntry(source: Message, part: ActivityPart, index: number): ActivityEntry {
  const entry: ActivityEntry = { id: activityEntryId(source, part, index), messageId: source.id, index, type: part.type, name: part.type === "reasoning" ? "Reasoning" : part.name };
  if (part.type === "tool") {
    const statuses: string[] = [];
    if (part.error) { entry.error = true; statuses.push("Failed"); }
    if (part.toolStatus && !/^(result|completed|complete|success)$/i.test(part.toolStatus)) statuses.push(part.toolStatus);
    else if (!part.toolStatus && !part.error && part.output === undefined) statuses.push(active(source.status) ? "Working" : "No result recorded");
    if (statuses.length) entry.status = [...new Set(statuses)].join(" · ");
  }
  return entry;
}

export function resolveActivityDetail(entry: ActivityEntry, messagesById: ReadonlyMap<string, Message>): ActivityDetail | undefined {
  const source = messagesById.get(entry.messageId);
  if (!source) return;
  const matches = (part: TextPart | ToolPart | undefined, index: number): part is ActivityPart => !!part && part.type !== "text" && part.type === entry.type && activityEntryId(source, part, index) === entry.id;
  const indexed = source.parts[entry.index];
  if (matches(indexed, entry.index)) return { id: entry.id, source, index: entry.index, part: indexed };
  for (let index = 0; index < source.parts.length; index++) {
    const part = source.parts[index];
    if (matches(part, index)) return { id: entry.id, source, index, part };
  }
}

export function classifyTranscriptTool({ sessionId, source, part, workers, handoffs, nativeRuns, nativeHarness, readOnly }: {
  sessionId: string; source: Message; part: ToolPart; workers: WorkerRecord[]; handoffs: HandoffPresentation[]; nativeRuns: Run[]; nativeHarness: Harness; readOnly?: boolean;
}): TranscriptToolClassification {
  if (readOnly) return { kind: "activity" };
  const key = nativeSubagentKey(sessionId, source, part, nativeRuns, nativeHarness);
  if (key) return { kind: "native-subagent", key };
  const sent = sentHandoffs(part, sessionId, handoffs);
  if (sent.length) return { kind: "handoff", handoffs: sent };
  if (isHandoffTool(part)) return { kind: "pending-handoff" };
  const dispatched = dispatchedWorkers(sessionId, source, part, workers);
  if (dispatched.length) return { kind: "worker", workers: dispatched };
  return { kind: "activity" };
}

export function consecutiveActivitySegments(entries: readonly ActivityEntry[]): ActivitySegment[] {
  const segments: ActivitySegment[] = [];
  let statuses = new Set<string>();
  for (const entry of entries) {
    let segment = segments.at(-1);
    if (!segment || segment.type !== entry.type || entry.type === "tool" && segment.name !== entry.name) {
      segment = { id: entry.id, type: entry.type, name: entry.type === "reasoning" ? "Reasoning" : entry.name, entries: [] };
      segments.push(segment);
      statuses = new Set();
    }
    segment.entries.push(entry);
    if (entry.error) { segment.error = true; statuses.add("Failed"); }
    if (entry.status) for (const status of entry.status.split(" · ")) statuses.add(status);
    if (statuses.size) segment.status = [...statuses].join(" · ");
  }
  return segments;
}
