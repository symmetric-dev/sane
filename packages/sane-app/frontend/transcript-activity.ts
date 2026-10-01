import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { WorkerDelivery, WorkerRecord } from "../src/worker-contract";
import type { Message, TextPart, ToolPart } from "./types";
import { dispatchedWorkers, workerReportDelivery } from "./worker-presentation";

export type ActivityEntry = { id: string; source: Message; index: number; part: Extract<TextPart, { type: "reasoning" }> | ToolPart };
export type ActivityGroup = { id: string; entries: ActivityEntry[] };
export type ActivityPlan = { positions: Map<string, ActivityGroup | null>; entries: ActivityEntry[] };
export type ActivityEntrance = { claimed: boolean; startedAt?: number; owner?: object };
export type ActivityPresentation = { plan: ActivityPlan; entrances: Map<string, ActivityEntrance> };

export const activityPosition = (messageId: string, index: number) => JSON.stringify([messageId, index]);

/** Presentation only: preserve native messages and break at every text part. */
export function planTranscriptActivities(sessionId: string, messages: Message[], workers: WorkerRecord[], deliveries: WorkerDelivery[] = []): ActivityPlan {
  const positions = new Map<string, ActivityGroup | null>();
  const entries: ActivityEntry[] = [];
  let sequence: ActivityEntry[] = [];
  const flush = () => {
    if (!sequence.length) return;
    const first = sequence[0]!;
    positions.set(activityPosition(first.source.id, first.index), { id: first.id, entries: sequence });
    for (const entry of sequence.slice(1)) positions.set(activityPosition(entry.source.id, entry.index), null);
    sequence = [];
  };
  for (const source of messages) {
    if (source.role !== "assistant" || workerReportDelivery(source, deliveries)) { flush(); continue; }
    if (sequence.length && sequence[0]!.source.runId !== source.runId) flush();
    let reasoning = 0;
    source.parts.forEach((part, index) => {
      if (part.type === "text" || part.type === "tool" && dispatchedWorkers(sessionId, source, part, workers).length) { flush(); return; }
      const ordinal = part.type === "reasoning" ? reasoning++ : undefined;
      const identity = part.type === "tool" ? part.toolCallId ?? part.id : part.id ?? ordinal;
      const entry: ActivityEntry = { id: JSON.stringify([source.id, part.type, identity]), source, index, part };
      entries.push(entry); sequence.push(entry);
    });
    // These notices render after the parts, and must not move into a tab group.
    if (source.error !== undefined || source.status === "failed" || source.status === "interrupted" || source.status === "unknown" && source.runId !== "native-import") flush();
  }
  flush();
  return { positions, entries };
}

/** Seed loaded history; only later arrivals get a single, consumable entrance. */
export function useActivityPresentation({ sessionId, messages, workers, deliveries, loading, animate }: {
  sessionId: string; messages: Message[]; workers: WorkerRecord[]; deliveries?: WorkerDelivery[]; loading: boolean; animate: boolean;
}): ActivityPresentation {
  const plan = useMemo(() => planTranscriptActivities(sessionId, messages, workers, deliveries), [sessionId, messages, workers, deliveries]);
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
      if (!previous.seen.has(entry.id) && animate && entry.source.runId !== "native-import" && liveMessages.has(entry.source.id)) arrivals.push(entry);
      previous.seen.add(entry.id);
    }
    previous.tail = messages.at(-1)?.id;
    if (arrivals.length) setEntrances(current => {
      const next = new Map([...current].filter(([, entrance]) => !entrance.claimed || entrance.startedAt !== undefined && performance.now() - entrance.startedAt < 1500));
      for (const entry of arrivals) next.set(entry.id, { claimed: false });
      return next;
    });
  }, [sessionId, messages, plan, loading, animate]);
  return { plan, entrances };
}
