import type { AuthoredUserProjection } from "../shared/conversation/transcript";
import type { DiagnosticEvent, Run } from "../shared/conversation/types";
import { decodeContextMessageSubmission, type ContextMessageSubmission } from "./context-message-evidence";
import { nativeMessageId, uuid, type Session } from "./history";

/** Presentation evidence only. The standard submission decoder verifies framing,
 * UTF-8 ranges and every composition hash. Neither a prepared input, a context
 * heading nor a successful run can substitute for this actual bound record.
 * This does not establish native acceptance or change any dispatch evidence. */
export class AuthoredSubmissionProjector {
  private decoded = new WeakMap<DiagnosticEvent, ContextMessageSubmission | null>();

  forSession(session: Session, runs: Run[]): AuthoredUserProjection[] {
    const result: AuthoredUserProjection[] = [];
    for (const run of runs) {
      if (run.operation === "compact") continue;
      const candidates = new Map<string, ContextMessageSubmission[]>();
      const counts = new Map<string, number>();
      for (const event of run.events) {
        if (event.kind !== "submission" || event.runId !== run.id || event.sessionId !== run.conversationId) continue;
        const data = event.data as { messageId?: unknown } | null;
        if (typeof data?.messageId === "string") counts.set(data.messageId, (counts.get(data.messageId) ?? 0) + 1);
        if (!Number.isSafeInteger(event.seq) || event.seq <= 0) continue;
        let submission = this.decoded.get(event);
        if (submission === undefined) {
          try { submission = decodeContextMessageSubmission(event.data); }
          catch { submission = null; }
          this.decoded.set(event, submission);
        }
        if (!submission) continue;
        const entries = candidates.get(submission.messageId) ?? [];
        entries.push(submission); candidates.set(submission.messageId, entries);
      }
      for (const [messageId, entries] of candidates) {
        if (counts.get(messageId) !== 1) continue;
        const submission = entries[0]!;
        const { dispatch, body } = submission.composition, source = dispatch.source;
        if (dispatch.runId !== run.id || run.conversationId !== session.sessionId || run.cwd !== session.cwd
          || source.sessionId !== session.sessionId || source.harnessId !== session.harness || source.harnessId !== run.harness
          || !session.authorityId || source.authorityId !== session.authorityId
          || !session.nativeSessionId || source.nativeSessionId !== session.nativeSessionId || source.nativeSessionId !== run.nativeSessionId
          || source.cwd !== session.cwd) continue;
        let actualId: string;
        if (source.harnessId === "claude-code") {
          // The transport sends run.id for the initial CC message, and the
          // explicit suffix UUID for live input. These are NOT JSONL line UUIDs.
          if (dispatch.nativeCommandId !== null) continue;
          actualId = submission.liveInput === true ? messageId.slice(`${run.id}:user:`.length) : run.id;
          if (!uuid(actualId)) continue;
        } else if (source.harnessId === "opencode") {
          if (!nativeMessageId(dispatch.nativeCommandId) || dispatch.nativeCommandId !== run.nativeCommandId) continue;
          actualId = dispatch.nativeCommandId;
        } else continue;
        result.push({ runId: run.id, messageId, nativeMessageId: actualId, transport: submission.text,
          body: Buffer.from(submission.text, "utf8").subarray(body.range.offset, body.range.offset + body.range.length).toString("utf8") });
      }
    }
    // Conflicting native aliases cannot bless either record as native ownership.
    const aliases = new Map<string, number>();
    for (const projection of result) aliases.set(projection.nativeMessageId, (aliases.get(projection.nativeMessageId) ?? 0) + 1);
    return result.filter(projection => aliases.get(projection.nativeMessageId) === 1);
  }
}
