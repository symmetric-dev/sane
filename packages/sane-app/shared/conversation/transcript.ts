import type { ReconciledHistory } from "./native-history-contract";
import { messagesForRun } from "./cc-reducer";
import type { Message, Run } from "./types";
import { claudeCompactionHistory } from "./claude-compaction-history";

/** Supplied only by the server's bound standard-submission decoder. This is a
 * display projection, never an acceptance receipt or permission to send input. */
export type AuthoredUserProjection = Readonly<{
  runId: string; messageId: string; nativeMessageId: string; transport: string; body: string;
}>;
const textOnly = (message: Message) => message.parts.every(part => part.type === "text")
  ? message.parts.map(part => part.type === "text" ? part.text : "").join("") : undefined;

/** Keep native order and identity. Text alone never establishes run ownership. */
export function transcriptMessages(history: ReconciledHistory | null | undefined, runs: Run[], authored: readonly AuthoredUserProjection[] = []): Message[] {
  const imported = claudeCompactionHistory(history?.messages ?? []);
  const native: Message[] = imported.filter(m => !m.compaction && (m.role !== "system" || m.parts.length)).map(m => ({
    id: m.messageId, runId: "native-import", role: m.role, time: m.createdAt,
    status: m.status, normalized: true, error: m.error, retry: m.retry, nativeSubagentResult: m.nativeSubagentResult, nativeShellResult: m.nativeShellResult, nativeInstructionContext: m.nativeInstructionContext,
    parts: m.parts.map(p => p.type === "tool" ? { type: "tool", id: p.id, toolCallId: p.id, name: p.name, input: p.input, toolStatus: p.status, output: p.output ?? p.error, error: p.error !== undefined } : { type: p.type, text: p.text, ...(p.type === "reasoning" ? { id: p.id } : {}) }),
  }));
  const app = runs.flatMap(run => {
    const messages = messagesForRun(run);
    for (const proof of authored.filter(proof => proof.runId === run.id)) {
      const index = messages.findIndex(message => message.id === proof.messageId && message.role === "user" && textOnly(message) === proof.transport);
      if (index < 0) continue;
      const submission = messages[index]!;
      const duplicate = messages.find(message => message.id === proof.nativeMessageId && message.role === "user" && textOnly(message) === proof.transport);
      messages[index] = { ...submission, ...duplicate, id: submission.id, runId: run.id,
        parts: [{ type: "text", text: proof.body }],
        ...(duplicate ? { nativeIds: [...new Set([...(submission.nativeIds ?? []), ...(duplicate.nativeIds ?? []), proof.nativeMessageId])] } : {}) };
      if (duplicate && duplicate !== submission) messages.splice(messages.indexOf(duplicate), 1);
    }
    return messages;
  });
  // Only the actual CC input UUID / OC command ID AND exact verified transport
  // bytes qualify a native user message. Do not scan or strip user-like markers,
  // borrow an assistant's turn ownership, or rewrite imported/persisted history.
  const mismatchedAuthoredIds = new Set<string>();
  for (const proof of authored) {
    const recorded = app.find(message => message.runId === proof.runId && message.id === proof.messageId && message.role === "user" && textOnly(message) === proof.body);
    const index = native.findIndex(message => message.id === proof.nativeMessageId);
    if (index < 0) continue;
    if (native[index]!.role !== "user" || textOnly(native[index]!) !== proof.transport) { mismatchedAuthoredIds.add(proof.nativeMessageId); continue; }
    if (!recorded) continue;
    native[index] = { ...native[index]!, parts: recorded.parts };
    // Preserve native annotations/status even when samePrompt below selects the
    // logical App bubble rather than the native UUID. Both are display clones.
    app[app.indexOf(recorded)] = { ...recorded, ...native[index]!, id: recorded.id, runId: recorded.runId,
      nativeIds: [...new Set([...(recorded.nativeIds ?? []), proof.nativeMessageId])] };
  }
  const byNativeId = new Map<string, Message>();
  for (const message of app) for (const id of [message.id, ...(message.nativeIds ?? [])]) if (!mismatchedAuthoredIds.has(id)) byNativeId.set(id, message);
  const emitted = new Set<string>();
  const nativeIds = new Set(native.map(message => message.id));
  const anchored = (message: Message) => nativeIds.has(message.id) || message.nativeIds?.some(id => nativeIds.has(id));
  const result: Message[] = [];
  const append = (message: Message) => { if (!emitted.has(message.id)) { emitted.add(message.id); result.push(message); } };
  // A user boundary plus a durable assistant UUID (CC), or command ID (OC),
  // anchors a turn. Repeated prompt text in unrelated turns is not deduplicated.
  for (let start = 0; start < native.length;) {
    let end = start + 1;
    while (end < native.length && native[end]!.role !== "user") end++;
    const turn = native.slice(start, end);
    const owners = new Set(turn.map(m => byNativeId.get(m.id)?.runId).filter((id): id is string => !!id));
    // Live OC history also contains later synthetic continuations. Only exact
    // journaled IDs establish their App ownership; a preceding user is not proof.
    const commandRun = runs.find(r => r.operation !== "compact" && r.harness === "opencode" && r.nativeCommandId === turn[0]?.id && !mismatchedAuthoredIds.has(turn[0]!.id));
    if (commandRun) owners.add(commandRun.id);
    const runId = owners.size === 1 ? [...owners][0] : undefined;
    // Failed submissions can have no native message at all. Keep them before
    // the next proven App turn, rather than moving them to the end of history.
    if (runId) {
      const preceding = new Set(runs.slice(0, runs.findIndex(r => r.id === runId)).map(r => r.id));
      for (const message of app) if (preceding.has(message.runId) && (!history?.observation || !anchored(message))) append(message);
    }
    const owned = runId ? app.filter(m => m.runId === runId) : [];
    const first = turn[0]!;
    const exactSubmission = byNativeId.get(first.id);
    const submission = exactSubmission?.role === "user" && exactSubmission.runId === runId ? exactSubmission : owned.find(m => m.role === "user");
    const authoredSubmission = submission && authored.find(proof => proof.runId === submission.runId && proof.messageId === submission.id);
    const samePrompt = submission && first.role === "user" && !mismatchedAuthoredIds.has(first.id)
      && (!authoredSubmission || authoredSubmission.nativeMessageId === first.id) && JSON.stringify(submission.parts) === JSON.stringify(first.parts);
    if (submission && !samePrompt && !turn.some(m => m.id === submission.id)) append(submission);
    for (const message of turn) {
      const recorded = byNativeId.get(message.id);
      if (message === first && samePrompt) append(submission);
      else append(recorded && history?.observation ? { ...recorded, ...message, id: recorded.id, runId: recorded.runId, nativeIds: recorded.nativeIds }
        : recorded ?? (!history?.observation && commandRun && runId === commandRun.id && !mismatchedAuthoredIds.has(message.id) ? { ...message, runId } : message));
    }
    // Preserve failures, submissions and terminal fallback messages even when a
    // snapshot covers the command. Never discard an entire covered App run.
    for (const message of owned) {
      const nativeResponse = turn.some(m => m.role === "assistant" && (!history?.observation || byNativeId.get(m.id)?.runId === runId));
      if (nativeResponse && message.id === `${runId}:empty`) {
        // Native output is present, so the reducer's no-output placeholder no
        // longer applies. A failure still needs its own visible run warning.
        if (message.status !== "completed") append({ ...message, parts: [] });
        else emitted.add(message.id);
      } else if (message.id === `${runId}:result` && turn.some(m => m.role === "assistant" && (!history?.observation || byNativeId.get(m.id)?.runId === runId) && JSON.stringify(m.parts) === JSON.stringify(message.parts))) emitted.add(message.id);
      else if (!history?.observation || !anchored(message)) append(message);
    }
    start = end;
  }
  for (const message of app) append(message);
  for (const run of runs) {
    if (run.operation === "compact") continue;
    if (run.status !== "failed" && run.status !== "interrupted") continue;
    if (result.some(m => m.runId === run.id && m.role === "assistant" && m.status === run.status)) continue;
    const index = result.findLastIndex(m => m.runId === run.id);
    if (index >= 0) result.splice(index + 1, 0, { id: `${run.id}:outcome`, runId: run.id, role: "assistant", parts: [], status: run.status, time: run.endedAt ?? "" });
  }
  return result;
}
