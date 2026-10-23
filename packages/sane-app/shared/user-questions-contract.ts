/** JSON-only contract shared by the App, its UI, and native question tools. */
export interface PresentQuestionsInput { title: string; pages: UserQuestion[] }
export interface UserQuestion {
  question: string;
  context?: string;
  references?: string[];
  options?: string[];
  multiple?: boolean;
  /** Choice questions permit custom answers only when explicitly true. */
  allow_other?: boolean;
}
export type UserQuestionAnswer = string | { selected: string[]; other?: string } | null;
export interface UserQuestionsRecord {
  version: 1;
  id: string;
  sessionId: string;
  native: { harness: "cc" | "oc"; authorityId: string; nativeId: string };
  anchor: { runId: string; toolCallId: string; messageId: string | null; invocationId: string; wrapper: "execute" | null };
  workspaceId: string;
  worktreeId: string;
  bindingRevision: string;
  cwd: string;
  createdAt: string;
  input: PresentQuestionsInput;
  revision: number;
  answers: UserQuestionAnswer[];
  status: "presented" | "submitted" | "dismissed";
  submission: null | { id: string; requestId: string; submittedAt: string; answers: UserQuestionAnswer[] };
  delivery: null | { id: string; state: "pending" | "claimed" | "accepted" | "unknown" | "paused"; runId: string | null; nativeCommandId: string | null; reason?: string };
  dismissal: null | { requestId: string; at: string };
}
export interface UserQuestionsReceipt { form_id: string; status: "presented" }
export interface UserQuestionsListResponse { forms: UserQuestionsRecord[] }
export interface UserQuestionsAnswerRequest { requestId: string; expectedRevision: number; answers: UserQuestionAnswer[] }
export interface UserQuestionsSimpleRequest { requestId: string; expectedRevision: number }

export const USER_QUESTIONS_LIMITS = Object.freeze({
  title: 256, pages: 32, question: 2000, context: 16000,
  references: 16, reference: 4096, options: 32, option: 2000,
  inputBytes: 128 * 1024, answerText: 16000, answerBytes: 512 * 1024,
});

function requireValue(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
/** Refuse extra keys, accessors, and non-JSON prototypes rather than dropping them. */
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), "Expected an object");
  requireValue(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, "Expected a JSON object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireValue(Object.getOwnPropertySymbols(value).length === 0 && Object.values(descriptors).every(d => d.enumerable && "value" in d), "Expected JSON properties");
  requireValue(required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => required.includes(k) || optional.includes(k)), "Unexpected or missing fields");
  return value as Record<string, unknown>;
}
function array(value: unknown, max: number): unknown[] {
  requireValue(Array.isArray(value) && value.length <= max, "Invalid array length");
  requireValue(Object.getPrototypeOf(value) === Array.prototype && Object.getOwnPropertyNames(value).length === value.length + 1
    && Object.getOwnPropertySymbols(value).length === 0 && Object.keys(value).length === value.length
    && Array.from({ length: value.length }, (_, i) => Object.getOwnPropertyDescriptor(value, String(i))).every(d => d && d.enumerable && "value" in d), "Expected a dense JSON array");
  return value;
}
function text(value: unknown, max: number, nonempty = false): string {
  requireValue(typeof value === "string" && value.length <= max * 2 && Array.from(value).length <= max && !value.includes("\0") && (!nonempty || !!value.trim()), `Expected text of at most ${max} characters`);
  return value;
}
function strings(value: unknown, max: number, length: number, nonempty: boolean): string[] {
  const result = array(value, max).map(v => text(v, length, true));
  requireValue(!nonempty || result.length > 0, "Options cannot be empty");
  requireValue(new Set(result).size === result.length, "Duplicate strings are not allowed");
  return result;
}

export function parsePresentQuestionsInput(value: unknown): PresentQuestionsInput {
  const v = object(value, ["title", "pages"]);
  const title = text(v.title, USER_QUESTIONS_LIMITS.title, true);
  const pages = array(v.pages, USER_QUESTIONS_LIMITS.pages).map(value => {
    const p = object(value, ["question"], ["context", "references", "options", "multiple", "allow_other"]);
    const page: UserQuestion = { question: text(p.question, USER_QUESTIONS_LIMITS.question, true) };
    if (Object.hasOwn(p, "context")) page.context = text(p.context, USER_QUESTIONS_LIMITS.context);
    if (Object.hasOwn(p, "references")) page.references = strings(p.references, USER_QUESTIONS_LIMITS.references, USER_QUESTIONS_LIMITS.reference, false);
    if (Object.hasOwn(p, "options")) page.options = strings(p.options, USER_QUESTIONS_LIMITS.options, USER_QUESTIONS_LIMITS.option, true);
    for (const key of ["multiple", "allow_other"] as const) if (Object.hasOwn(p, key)) {
      requireValue(page.options !== undefined && typeof p[key] === "boolean", `${key} requires options and a boolean`);
      page[key] = p[key] as boolean;
    }
    return page;
  });
  requireValue(pages.length > 0, "At least one question is required");
  const result = { title, pages };
  requireValue(new TextEncoder().encode(JSON.stringify(result)).length <= USER_QUESTIONS_LIMITS.inputBytes, "Questions exceed the total input byte limit");
  return result;
}

/** A null answer is unanswered; an empty string is an explicit text answer. */
export function parseUserQuestionAnswers(input: PresentQuestionsInput, value: unknown): UserQuestionAnswer[] {
  const definition = parsePresentQuestionsInput(input);
  const answers = array(value, USER_QUESTIONS_LIMITS.pages);
  requireValue(answers.length === definition.pages.length, "Answer count must match the question count");
  const result = answers.map((answer, index) => {
    if (answer === null) return null;
    const page = definition.pages[index]!;
    if (!page.options) return text(answer, USER_QUESTIONS_LIMITS.answerText);
    const a = object(answer, ["selected"], ["other"]);
    const selected = array(a.selected, page.options.length).map(value => text(value, USER_QUESTIONS_LIMITS.option, true));
    requireValue(new Set(selected).size === selected.length && selected.every(option => page.options!.includes(option)), "Answers must use unique, exact option strings");
    requireValue(page.multiple === true || selected.length <= 1, "Only one option may be selected");
    const result: { selected: string[]; other?: string } = { selected };
    if (Object.hasOwn(a, "other")) {
      requireValue(page.allow_other === true && (page.multiple === true || selected.length === 0), "Custom answer is not permitted with this selection");
      result.other = text(a.other, USER_QUESTIONS_LIMITS.answerText);
    }
    requireValue(selected.length > 0 || Object.hasOwn(result, "other"), "Use null for an unanswered question");
    return result;
  });
  requireValue(new TextEncoder().encode(JSON.stringify(result)).length <= USER_QUESTIONS_LIMITS.answerBytes, "Combined answers exceed the 512 KiB limit");
  return result;
}

const token = (v: unknown): v is string => typeof v === "string" && !!v && v.length <= 4096 && v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v);
const time = (v: unknown): v is string => typeof v === "string" && v.length <= 64 && Number.isFinite(Date.parse(v));
const nullableToken = (v: unknown) => v === null || token(v);
const equalAnswers = (a: UserQuestionAnswer[], b: UserQuestionAnswer[]) => JSON.stringify(a) === JSON.stringify(b);

/** Strict projection validator: invalid persisted or remote state is never repaired. */
export function isUserQuestionsRecord(value: unknown): value is UserQuestionsRecord {
  try {
    const v = object(value, ["version", "id", "sessionId", "native", "anchor", "workspaceId", "worktreeId", "bindingRevision", "cwd", "createdAt", "input", "revision", "answers", "status", "submission", "delivery", "dismissal"]);
    requireValue(v.version === 1 && [v.id, v.sessionId, v.workspaceId, v.worktreeId, v.bindingRevision].every(token)
      && typeof v.cwd === "string" && v.cwd.startsWith("/") && v.cwd.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(v.cwd)
      && time(v.createdAt) && Number.isSafeInteger(v.revision) && (v.revision as number) >= 1, "Invalid form identity");
    const native = object(v.native, ["harness", "authorityId", "nativeId"]);
    requireValue((native.harness === "cc" || native.harness === "oc") && token(native.authorityId) && token(native.nativeId), "Invalid native identity");
    const anchor = object(v.anchor, ["runId", "toolCallId", "messageId", "invocationId", "wrapper"]);
    requireValue([anchor.runId, anchor.toolCallId, anchor.invocationId].every(token) && nullableToken(anchor.messageId)
      && (anchor.wrapper === null || anchor.wrapper === "execute"), "Invalid invocation anchor");
    requireValue(native.harness === "cc" ? anchor.wrapper === null && anchor.invocationId === anchor.toolCallId
      : anchor.messageId !== null && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(anchor.invocationId as string), "Invalid native invocation");
    const input = parsePresentQuestionsInput(v.input), answers = parseUserQuestionAnswers(input, v.answers);
    requireValue(v.revision !== 1 || v.status === "presented" && answers.every(answer => answer === null), "Initial form must be unanswered");
    if (v.status === "submitted") {
      const submission = object(v.submission, ["id", "requestId", "submittedAt", "answers"]);
      requireValue(token(submission.id) && token(submission.requestId) && time(submission.submittedAt)
        && equalAnswers(answers, parseUserQuestionAnswers(input, submission.answers)), "Invalid immutable submission");
      const delivery = object(v.delivery, ["id", "state", "runId", "nativeCommandId"], ["reason"]);
      requireValue(token(delivery.id) && ["pending", "claimed", "accepted", "unknown", "paused"].includes(delivery.state as string)
        && nullableToken(delivery.runId) && nullableToken(delivery.nativeCommandId), "Invalid delivery");
      if (delivery.state === "pending") requireValue(delivery.runId === null && delivery.nativeCommandId === null, "Unclaimed delivery cannot have a native run");
      if (["claimed", "accepted", "unknown"].includes(delivery.state as string)) requireValue(token(delivery.runId), "Native delivery must retain its original run");
      requireValue(delivery.runId === null ? delivery.nativeCommandId === null
        : native.harness === "cc" ? delivery.nativeCommandId === null : token(delivery.nativeCommandId), "Delivery command differs from its harness");
      if (Object.hasOwn(delivery, "reason")) text(delivery.reason, 4096);
      requireValue(v.dismissal === null, "Submitted form cannot be dismissed");
    } else {
      requireValue(v.submission === null && v.delivery === null, "Unsubmitted form has an outbox");
      if (v.status === "dismissed") {
        const dismissal = object(v.dismissal, ["requestId", "at"]);
        requireValue(token(dismissal.requestId) && time(dismissal.at), "Invalid dismissal");
      } else requireValue(v.status === "presented" && v.dismissal === null, "Invalid form lifecycle");
    }
    return true;
  } catch { return false; }
}
