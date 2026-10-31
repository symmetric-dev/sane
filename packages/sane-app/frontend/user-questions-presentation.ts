import type { Message, ToolPart } from "./types";
import type { UserQuestionsController, UserQuestionsDraft } from "./user-questions-client";
import type { ChatStatus } from "./chat-status";

export const isUserQuestionsTool = (part: ToolPart) => /(?:^|[_.:/])present_questions_to_user$/.test(part.name);

/** Durable anchors only, including native imports and executable wrappers. */
export function questionsForMessage(sessionId: string, source: Message, forms: readonly UserQuestionsDraft[]) {
  return forms.filter(({ form }) => form.sessionId === sessionId
    && (source.runId === "native-import" || source.runId === form.anchor.runId)
    && (!form.anchor.messageId || source.id === form.anchor.messageId || source.nativeIds?.includes(form.anchor.messageId))
    && source.parts.some(part => part.type === "tool" && (part.toolCallId ?? part.id) === form.anchor.toolCallId));
}

export function questionsForTool(sessionId: string, source: Message, part: ToolPart, forms: readonly UserQuestionsDraft[]) {
  return questionsForMessage(sessionId, source, forms).filter(({ form }) => form.anchor.toolCallId === (part.toolCallId ?? part.id));
}

/** The response is a real user message, not the questionnaire tool's receipt.
 * Match only the persisted delivery's initial command/message identity. Run
 * ownership alone would also hide unrelated live user input in that same run. */
export function submittedQuestionsForMessage(sessionId: string, source: Message, forms: readonly UserQuestionsDraft[]) {
  if (source.role !== "user") return;
  return forms.find(({ form }) => {
    const delivery = form.delivery;
    if (form.sessionId !== sessionId || form.status !== "submitted" || !form.submission || !delivery?.runId) return false;
    if (source.runId !== "native-import" && source.runId !== delivery.runId) return false;
    const ids = delivery.nativeCommandId ? [delivery.nativeCommandId]
      : [`${delivery.runId}:user`, ...(form.native.harness === "cc" ? [delivery.runId] : [])];
    return ids.some(id => source.id === id || source.nativeIds?.includes(id) === true);
  });
}

export const questionsNeedAttention = (draft: UserQuestionsDraft) => draft.conflict || !!draft.error || !!draft.operation?.uncertain
  || draft.form.status !== "presented" && (draft.dirty || !!draft.operation)
  || draft.form.status === "submitted" && (!draft.form.delivery || draft.form.delivery.state === "paused");

export function userQuestionsActivityStatus(questions: UserQuestionsController): ChatStatus | undefined {
  const pending = questions.forms.filter(draft => draft.form.status === "presented");
  const attention = questions.forms.filter(questionsNeedAttention);
  if (questions.error) return { id: "user-questions", text: "Questionnaire refresh needs attention", detail: questions.error, priority: 86 };
  if (attention.length) return { id: "user-questions", text: "Questions need attention", detail: `${attention.length} questionnaire${attention.length === 1 ? "" : "s"} need review${pending.length ? ` · ${pending.length} awaiting answers` : ""}. Open the original card to review or recover.`, priority: 86 };
  if (pending.length) return { id: "user-questions", text: `${pending.length} questionnaire${pending.length === 1 ? "" : "s"} awaiting answers`, detail: "Answer in the transcript. Answers are sent only when you submit; normal chat remains available.", priority: 66 };
}

export function questionsStatus(draft: UserQuestionsDraft) {
  if (draft.conflict) return "Version conflict";
  if (draft.operation?.uncertain) return "Unconfirmed";
  if (draft.operation) return draft.operation.kind === "answers" ? "Saving…" : draft.operation.kind === "submit" ? "Submitting…" : "Updating…";
  if (draft.dirty) return draft.form.status === "presented" ? "Unsaved" : "Local answers retained";
  if (draft.error) return "Needs attention";
  if (draft.form.status === "presented") return "Draft saved";
  if (draft.form.status === "dismissed") return "Dismissed";
  switch (draft.form.delivery?.state) {
    case "accepted": return "Delivered";
    case "wrapper-completed": return "Delivered to Grok";
    case "pending": return "Delivery pending";
    case "claimed": return "Sending…";
    case "paused": return "Delivery paused";
    case "unknown": return "Delivery unconfirmed";
    default: return "Delivery unconfirmed";
  }
}
