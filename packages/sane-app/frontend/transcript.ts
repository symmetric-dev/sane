import type { ReconciledHistory } from "../src/reconcile";
import { messagesForRun } from "./cc-reducer";
import type { Message, Run } from "./types";

/** Keep native order and identity. Text alone never establishes run ownership. */
export function transcriptMessages(history: ReconciledHistory | null | undefined, runs: Run[]): Message[] {
  const native: Message[] = (history?.messages ?? []).map(m => ({
    id: m.messageId, runId: "native-import", role: m.role, time: m.createdAt,
    status: m.status, normalized: true, error: m.error,
    parts: m.parts.map(p => p.type === "tool" ? { type: "tool", id: p.id, toolCallId: p.id, name: p.name, input: p.input, toolStatus: p.status, output: p.output ?? p.error, error: p.error !== undefined } : { type: p.type, text: p.text }),
  }));
  const app = runs.flatMap(messagesForRun);
  const byNativeId = new Map<string, Message>();
  for (const message of app) for (const id of [message.id, ...(message.nativeIds ?? [])]) byNativeId.set(id, message);
  const emitted = new Set<string>();
  const result: Message[] = [];
  const append = (message: Message) => { if (!emitted.has(message.id)) { emitted.add(message.id); result.push(message); } };
  // A user boundary plus a durable assistant UUID (CC), or command ID (OC),
  // anchors a turn. Repeated prompt text in unrelated turns is not deduplicated.
  for (let start = 0; start < native.length;) {
    let end = start + 1;
    while (end < native.length && native[end]!.role !== "user") end++;
    const turn = native.slice(start, end);
    const owners = new Set(turn.map(m => byNativeId.get(m.id)?.runId).filter((id): id is string => !!id));
    const commandRun = runs.find(r => r.harness === "opencode" && r.nativeCommandId === turn[0]?.id);
    if (commandRun) owners.add(commandRun.id);
    const runId = owners.size === 1 ? [...owners][0] : undefined;
    // Failed submissions can have no native message at all. Keep them before
    // the next proven App turn, rather than moving them to the end of history.
    if (runId) {
      const preceding = new Set(runs.slice(0, runs.findIndex(r => r.id === runId)).map(r => r.id));
      for (const message of app) if (preceding.has(message.runId)) append(message);
    }
    const owned = runId ? app.filter(m => m.runId === runId) : [];
    const submission = owned.find(m => m.role === "user");
    const first = turn[0]!;
    const samePrompt = submission && first.role === "user" && JSON.stringify(submission.parts) === JSON.stringify(first.parts);
    if (submission && !samePrompt && !turn.some(m => m.id === submission.id)) append(submission);
    for (const message of turn) {
      const recorded = byNativeId.get(message.id);
      if (message === first && samePrompt) append(submission);
      else append(recorded ?? (commandRun && runId === commandRun.id ? { ...message, runId } : message));
    }
    // Preserve failures, submissions and terminal fallback messages even when a
    // snapshot covers the command. Never discard an entire covered App run.
    for (const message of owned) {
      const nativeResponse = turn.some(m => m.role === "assistant");
      if (nativeResponse && message.id === `${runId}:empty`) {
        // Native output is present, so the reducer's no-output placeholder no
        // longer applies. A failure still needs its own visible run warning.
        if (message.status !== "completed") append({ ...message, parts: [] });
        else emitted.add(message.id);
      } else if (message.id === `${runId}:result` && turn.some(m => m.role === "assistant" && JSON.stringify(m.parts) === JSON.stringify(message.parts))) emitted.add(message.id);
      else append(message);
    }
    start = end;
  }
  for (const message of app) append(message);
  for (const run of runs) {
    if (run.status !== "failed" && run.status !== "interrupted") continue;
    if (result.some(m => m.runId === run.id && m.role === "assistant" && m.status === run.status)) continue;
    const index = result.findLastIndex(m => m.runId === run.id);
    if (index >= 0) result.splice(index + 1, 0, { id: `${run.id}:outcome`, runId: run.id, role: "assistant", parts: [], status: run.status, time: run.endedAt ?? "" });
  }
  return result;
}
