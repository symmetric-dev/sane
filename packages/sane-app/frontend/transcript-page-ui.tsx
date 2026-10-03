import type { State } from "./store";
import { store } from "./store";
import type { Message } from "./types";
import { canonicalCount, type PagedTranscript, type TranscriptIsland } from "./transcript-pages";

export const gapId = (island: TranscriptIsland) => `transcript-gap:${island.key}`;
/** A system separator also breaks activity grouping across uncovered history. */
export function withCoverageGaps(messages: Message[], pages?: PagedTranscript | null): Message[] {
  if (!pages || pages.islands.length < 2) return messages;
  const gaps = new Map(pages.islands.slice(1).map(island => [island.messages[0]?.id, island]));
  return messages.flatMap(message => {
    const island = gaps.get(message.id);
    return island ? [{ id: gapId(island), runId: "transcript-gap", role: "system" as const, parts: [], status: "completed" as const, time: "" }, message] : [message];
  });
}
export function HistoryEdge({ state, island, direction, label }: { state: State; island: TranscriptIsland; direction: "older" | "newer"; label?: string }) {
  const cursor = direction === "older" ? island.coverage.olderCursor : island.coverage.newerCursor;
  if (!cursor && !(direction === "newer" && state.transcript && island.coverage.lastIndex! < canonicalCount(state.transcript) - 1)) return null;
  const key = `${island.key}:${direction}`, busy = state.pageBusy === key;
  const error = state.pageErrors?.[key];
  return <div className="transcript-page-control"><button type="button" className="text-button" disabled={!!state.pageBusy} aria-busy={busy} onClick={() => void store.loadTranscriptPage({ island: island.key, direction })}>{error ? `Retry ${direction} history` : label ?? `Load ${direction} history`}</button>{error && <p className="notice error" role="alert">{error}</p>}</div>;
}
export function HistoryGap({ state, island }: { state: State; island: TranscriptIsland }) {
  const index = state.transcript?.islands.indexOf(island) ?? -1;
  const previous = state.transcript?.islands[index - 1];
  return <section className="transcript-gap" aria-label="Unloaded history">{previous && <HistoryEdge state={state} island={previous} direction="newer" label="Load newer history in gap" />}<HistoryEdge state={state} island={island} direction="older" label="Load older history in gap" /></section>;
}
