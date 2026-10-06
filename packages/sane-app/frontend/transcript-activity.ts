import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { WorkerDelivery, WorkerRecord } from "../src/worker-contract";
import type { HandoffPresentation } from "../src/handoff-contract";
import type { CompactionRecord } from "../src/oc-contract";
import type { Harness, Message, Run } from "./types";
import { workerReportDelivery } from "./worker-presentation";
import { receivedHandoff } from "./handoff-presentation";
import { ACTIVITY_ANIMATION_MAX_MS } from "./activity-visuals";
import { classifyTranscriptTool, createActivityEntry, type ActivityEntry } from "./activity-model";

export type { ActivityEntry, ActivityDetail } from "./activity-model";
export { consecutiveActivitySegments } from "./activity-model";
export type ActivityGroup = { id: string; entries: ActivityEntry[] };
export type ActivityPlan = { positions: Map<string, ActivityGroup | null>; entries: ActivityEntry[]; byId: Map<string, ActivityEntry>; groupByEntry: Map<string, ActivityGroup> };
export type ActivityEntrance = { claimed: boolean; startedAt?: number; owner?: object };
export type ActivityPresentation = { plan: ActivityPlan; entrances: Map<string, ActivityEntrance> };

export const activityPosition = (messageId: string, index: number) => JSON.stringify([messageId, index]);

/** Presentation only: preserve native messages and break at every text part. */
export function planTranscriptActivities(sessionId: string, messages: Message[], workers: WorkerRecord[], deliveries: WorkerDelivery[] = [], handoffs: HandoffPresentation[] = [], nativeRuns: Run[] = [], nativeHarness: Harness = "claude-code", compactionPositions?: ReadonlyMap<string, readonly CompactionRecord[]>, readOnly: boolean = false): ActivityPlan {
  const positions = new Map<string, ActivityGroup | null>();
  const entries: ActivityEntry[] = [];
  const byId = new Map<string, ActivityEntry>();
  const groupByEntry = new Map<string, ActivityGroup>();
  let sequence: ActivityEntry[] = [];
  let sequenceRunId: string | undefined;
  const registerGroup = (groupEntries: ActivityEntry[]) => {
    const first = groupEntries[0]!;
    const group = { id: first.id, entries: groupEntries };
    positions.set(activityPosition(first.messageId, first.index), group);
    for (const entry of groupEntries.slice(1)) positions.set(activityPosition(entry.messageId, entry.index), null);
    for (const entry of groupEntries) {
      entries.push(entry); byId.set(entry.id, entry); groupByEntry.set(entry.id, group);
    }
  };
  const flush = () => {
    if (!sequence.length) return;
    registerGroup(sequence);
    sequence = [];
    sequenceRunId = undefined;
  };
  for (const source of messages) {
    if (compactionPositions?.get(source.id)?.length) flush();
    if (!readOnly && (workerReportDelivery(source, deliveries) || receivedHandoff(source, sessionId, handoffs))) { flush(); continue; }
    if (source.role !== "assistant") {
      flush();
      source.parts.forEach((part, index) => {
        if (part.type === "text" || part.type === "tool" && classifyTranscriptTool({ sessionId, source, part, workers, handoffs, nativeRuns, nativeHarness, readOnly }).kind !== "activity") return;
        registerGroup([createActivityEntry(source, part, index)]);
      });
      continue;
    }
    if (sequence.length && sequenceRunId !== source.runId) flush();
    source.parts.forEach((part, index) => {
      if (part.type === "text" || part.type === "tool" && classifyTranscriptTool({ sessionId, source, part, workers, handoffs, nativeRuns, nativeHarness, readOnly }).kind !== "activity") { flush(); return; }
      const entry = createActivityEntry(source, part, index);
      sequence.push(entry);
      sequenceRunId = source.runId;
    });
    // These notices render after the parts, and must not move into a tab group.
    if (source.error !== undefined || source.status === "failed" || source.status === "interrupted" || source.status === "unknown" && source.runId !== "native-import") flush();
  }
  flush();
  return { positions, entries, byId, groupByEntry };
}

/** Seed loaded history; only later arrivals get a single, consumable entrance. */
export function useActivityPresentation({ sessionId, messages, workers, deliveries, handoffs, loading, animate, nativeRuns, nativeHarness, compactionPositions, readOnly }: {
  sessionId: string; messages: Message[]; workers: WorkerRecord[]; deliveries?: WorkerDelivery[]; handoffs?: HandoffPresentation[]; loading: boolean; animate: boolean; nativeRuns?: Run[]; nativeHarness?: Harness; compactionPositions?: ReadonlyMap<string, readonly CompactionRecord[]>; readOnly?: boolean;
}): ActivityPresentation {
  const plan = useMemo(() => planTranscriptActivities(sessionId, messages, workers, deliveries, handoffs, nativeRuns, nativeHarness, compactionPositions, readOnly), [sessionId, messages, workers, deliveries, handoffs, nativeRuns, nativeHarness, compactionPositions, readOnly]);
  const messagesById = useMemo(() => new Map(messages.map(message => [message.id, message])), [messages]);
  const observed = useRef<{ sessionId: string; seen: Set<string>; tail?: string } | null>(null);
  const [entrances, setEntrances] = useState(new Map<string, ActivityEntrance>());
  useLayoutEffect(() => {
    if (loading || !sessionId) {
      observed.current = null;
      setEntrances(previous => previous.size ? new Map() : previous);
      return;
    }
    const previous = observed.current;
    if (!previous || previous.sessionId !== sessionId) {
      observed.current = { sessionId, seen: new Set(plan.entries.map(entry => entry.id)), tail: messages.at(-1)?.id };
      setEntrances(current => current.size ? new Map() : current);
      return;
    }
    // History inserted before the previous tail is not a live arrival.
    const tailIndex = previous.tail ? messages.findIndex(message => message.id === previous.tail) : 0;
    const liveMessages = new Set(tailIndex < 0 ? [] : messages.slice(tailIndex).map(message => message.id));
    const arrivals: ActivityEntry[] = [];
    for (const entry of plan.entries) {
      if (!previous.seen.has(entry.id) && animate && messagesById.get(entry.messageId)?.runId !== "native-import" && liveMessages.has(entry.messageId)) arrivals.push(entry);
      previous.seen.add(entry.id);
    }
    previous.tail = messages.at(-1)?.id;
    if (arrivals.length) setEntrances(current => {
      const next = new Map([...current].filter(([, entrance]) => !entrance.claimed || entrance.startedAt !== undefined && performance.now() - entrance.startedAt < ACTIVITY_ANIMATION_MAX_MS));
      for (const entry of arrivals) next.set(entry.id, { claimed: false });
      return next;
    });
  }, [sessionId, messages, messagesById, plan, loading, animate]);
  return { plan, entrances };
}
