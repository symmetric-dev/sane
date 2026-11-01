import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { parseUserQuestionAnswers, USER_QUESTIONS_LIMITS, type UserQuestionAnswer, type UserQuestionsRecord } from "../shared/user-questions-contract";
import { userQuestionsScopeKey, type UserQuestionsController, type UserQuestionsDraft } from "./user-questions-client";
import { store } from "./store";

export type QuestionAnswerComposerEditor = {
  key: string;
  formId: string;
  questionIndex: number;
  questionNumber: number;
  questionCount: number;
  question: string;
  text: string;
  canSave: boolean;
  reason?: string;
};

export type QuestionAnswerComposerContextValue = {
  editor: QuestionAnswerComposerEditor | null;
  available: boolean;
  begin(formId: string, questionIndex: number, trigger?: HTMLElement): void;
  update(text: string): void;
  save(): boolean;
  cancel(): void;
  discard(): void;
  reveal(): void;
};

const QuestionAnswerComposerContext = createContext<QuestionAnswerComposerContextValue | null>(null);

export function useQuestionAnswerComposer(): QuestionAnswerComposerContextValue | null {
  return useContext(QuestionAnswerComposerContext);
}

type Buffer = {
  scopeKey: string;
  formId: string;
  questionIndex: number;
  identity: string;
  // Absence and an explicitly empty custom answer are different base values.
  baseOther: string | null;
  text: string;
  edited: boolean;
};
type Target = Buffer & { key: string; epoch: number; navigationCurrent: () => boolean; trigger?: HTMLElement; failure?: string };
type Owner = { questions: UserQuestionsController; active: boolean; epoch: number };
const STORAGE_KEY = "sane:question-answer-composer:v1";
const MAX_BUFFERS = 64;
const MAX_STORAGE_LENGTH = 2 * 1024 * 1024;
const MAX_IDENTITY_LENGTH = 256 * 1024;
const bufferKey = (buffer: Pick<Buffer, "scopeKey" | "formId" | "questionIndex">) => JSON.stringify([buffer.scopeKey, buffer.formId, buffer.questionIndex]);
const hasEdits = (buffer: Buffer) => buffer.text !== (buffer.baseOther ?? "") || buffer.baseOther === "" && buffer.edited;
const validText = (value: unknown): value is string => typeof value === "string"
  && value.length <= USER_QUESTIONS_LIMITS.answerText * 2 && Array.from(value).length <= USER_QUESTIONS_LIMITS.answerText;
// A composing IME may temporarily exceed the code-point limit. Recovery stores
// that raw text; only the explicit Save path applies the answer contract.
const validBufferText = (value: unknown): value is string => typeof value === "string" && value.length <= USER_QUESTIONS_LIMITS.answerText * 2;
const otherValue = (answer: UserQuestionAnswer | undefined): string | null => answer !== null && typeof answer === "object" ? answer.other ?? null : null;

function liveScopeKey(): string {
  const state = store.snapshot();
  const conversation = state.conversations.find(item => item.id === state.selected);
  return state.config?.storeId && conversation?.nativeSessionId && conversation.authorityId ? userQuestionsScopeKey({
    storeId: state.config.storeId, sessionId: state.selected, harness: conversation.harness,
    nativeSessionId: conversation.nativeSessionId, authorityId: conversation.authorityId,
  }) : "";
}

function liveReadOnlyReason(): string | undefined {
  const state = store.snapshot();
  const conversation = state.conversations.find(item => item.id === state.selected);
  if (state.phase !== "ready" || !state.config?.authenticated || !state.connected || !(state.interactive ?? state.connected)) return "Questions are read-only while disconnected.";
  if (!conversation || conversation.replacedBy || conversation.worker || conversation.attachment || store.conversationKind() === "worker") return "This conversation is read-only for questionnaire answers.";
}

// Revision, status and answers may advance; the originating form definition and
// native/binding identity may not. Include the entire definition, not its label.
function formIdentity(form: UserQuestionsRecord): string {
  return JSON.stringify([form.version, form.id, form.sessionId, form.native, form.anchor,
    form.workspaceId, form.worktreeId, form.bindingRevision, form.cwd, form.createdAt, form.input]);
}

function restoreBuffers(): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw || raw.length > MAX_STORAGE_LENGTH) return result;
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length > MAX_BUFFERS) return result;
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)
        || Object.keys(item).sort().join(",") !== "baseOther,edited,formId,identity,questionIndex,scopeKey,text") continue;
      const entry = item as Record<string, unknown>;
      if (typeof entry.scopeKey !== "string" || !entry.scopeKey || entry.scopeKey.length > 32768
        || typeof entry.formId !== "string" || !entry.formId || entry.formId.length > 4096
        || typeof entry.questionIndex !== "number" || !Number.isInteger(entry.questionIndex) || entry.questionIndex < 0 || entry.questionIndex >= USER_QUESTIONS_LIMITS.pages
        || typeof entry.identity !== "string" || !entry.identity || entry.identity.length > MAX_IDENTITY_LENGTH
        || !validBufferText(entry.text) || entry.baseOther !== null && !validText(entry.baseOther) || typeof entry.edited !== "boolean") continue;
      const buffer = entry as Buffer;
      if (hasEdits(buffer)) result.set(bufferKey(buffer), buffer);
    }
  } catch { /* Storage is optional; in-memory recovery and beforeunload remain. */ }
  return result;
}

let sharedBuffers: Map<string, Buffer> | undefined;
function recoveryBuffers(): Map<string, Buffer> {
  // Kept-mounted Thread providers share the storage key and therefore must also
  // share its latest in-memory contents. Editor ownership remains provider-local.
  if (!sharedBuffers) sharedBuffers = restoreBuffers();
  return sharedBuffers;
}

function persistBuffers(buffers: Map<string, Buffer>) {
  // Insertion order is LRU. Both memory and storage have a bounded recovery
  // window; older entries are evicted, never automatically applied as answers.
  while (buffers.size > MAX_BUFFERS) {
    const oldest = buffers.keys().next().value;
    if (oldest === undefined) break;
    buffers.delete(oldest);
  }
  try {
    const entries = [...buffers.values()];
    let raw = JSON.stringify(entries);
    while (raw.length > MAX_STORAGE_LENGTH && entries.length) {
      entries.shift();
      raw = JSON.stringify(entries);
    }
    if (entries.length) sessionStorage.setItem(STORAGE_KEY, raw);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch { /* Private mode/quota must not discard the in-memory answer. */ }
}

function blocked(questions: UserQuestionsController, draft: UserQuestionsDraft | undefined): string | undefined {
  if (!draft) return "The original questionnaire is unavailable. Your answer text is kept.";
  if (draft.form.status !== "presented") return "This questionnaire is no longer accepting answers. Your answer text is kept.";
  if (draft.conflict) return "Resolve the questionnaire conflict before saving. Your answer text is kept.";
  if (draft.operation?.uncertain) return "Reconcile the unconfirmed operation before saving. Your answer text is kept.";
  if (draft.operation && draft.operation.kind !== "answers") return "Wait for the questionnaire operation to finish before saving.";
  if (draft.error) return draft.error;
  if (questions.error) return questions.error;
  if (!questions.editable || questions.loading) return "Questions are read-only until the connection is available and questions have refreshed.";
}

function inspect(questions: UserQuestionsController, target: Target): { draft?: UserQuestionsDraft; answer?: UserQuestionAnswer; reason?: string } {
  if (questions.scopeKey !== target.scopeKey || liveScopeKey() !== target.scopeKey || !target.navigationCurrent()) return { reason: "The conversation identity changed. Your answer text is kept; reopen its selector in the original conversation to continue." };
  const draft = questions.forms.find(item => item.form.id === target.formId);
  if (!draft) return { reason: blocked(questions, draft) };
  if (formIdentity(draft.form) !== target.identity) return { reason: "The original question changed. Your answer text is kept separately." };
  const question = draft.form.input.pages[target.questionIndex];
  if (!question?.options?.length || question.allow_other !== true) return { reason: "This question does not accept a custom choice answer." };
  const reason = blocked(questions, draft) ?? liveReadOnlyReason();
  if (reason) return { draft, reason };
  if (otherValue(draft.answers[target.questionIndex]) !== target.baseOther) return { draft, reason: "The custom answer changed while you were editing. Your text is kept; review the current answer before saving." };
  try {
    const current = draft.answers[target.questionIndex];
    const selected = current !== null && typeof current === "object" ? current.selected : [];
    const nextSelected = target.text !== "" && !question.multiple ? [] : selected;
    // Opening and saving a loaded other:"" is a no-op, not an implicit clear.
    // Only an explicit edit of that empty value authorizes removing its `other`.
    const keepOther = target.text !== "" || target.baseOther === "" && !target.edited;
    const answer: UserQuestionAnswer = keepOther ? { selected: [...nextSelected], other: target.text }
      : nextSelected.length ? { selected: [...nextSelected] } : null;
    const answers = parseUserQuestionAnswers(draft.form.input, draft.answers.map((value, index) => index === target.questionIndex ? answer : value));
    return { draft, answer: answers[target.questionIndex] };
  } catch (error) {
    return { draft, reason: error instanceof Error ? error.message : "This answer could not be validated." };
  }
}

/** Temporary composer ownership only: no chat draft, send, submit or backend API. */
export function QuestionAnswerComposerProvider({ questions, active = true, children }: {
  questions: UserQuestionsController;
  active?: boolean;
  children: ReactNode;
}) {
  const [buffers] = useState(recoveryBuffers);
  const [, redraw] = useState(0);
  const target = useRef<Target | null>(null);
  const mounted = useRef(true);
  const owner = useRef<Owner>({ questions, active, epoch: 0 });
  const focus = useRef<Target | null>(null);
  if (owner.current.questions.scopeKey !== questions.scopeKey || owner.current.active !== active) owner.current.epoch++;
  owner.current = { questions, active, epoch: owner.current.epoch };
  const epoch = owner.current.epoch;
  const renderedTarget = target.current;
  const navigationCurrent = store.conversationNavigationFence();
  const current = useCallback(() => mounted.current && owner.current.active && owner.current.epoch === epoch
    && owner.current.questions.scopeKey === questions.scopeKey && liveScopeKey() === questions.scopeKey, [epoch, questions.scopeKey]);
  const editing = () => current() && target.current === renderedTarget && renderedTarget?.epoch === epoch ? renderedTarget : null;
  const refresh = useCallback(() => redraw(value => value + 1), []);

  const remember = (value: Target) => {
    const key = bufferKey(value);
    buffers.delete(key);
    if (hasEdits(value)) {
      const { scopeKey, formId, questionIndex, identity, baseOther, text, edited } = value;
      buffers.set(key, { scopeKey, formId, questionIndex, identity, baseOther, text, edited });
    }
    persistBuffers(buffers);
  };
  const finish = (value: Target) => {
    target.current = null;
    focus.current = value;
    refresh();
  };

  const begin: QuestionAnswerComposerContextValue["begin"] = (formId, questionIndex, trigger) => {
    if (!current() || !navigationCurrent() || liveReadOnlyReason() || !questions.scopeKey || !Number.isInteger(questionIndex) || questionIndex < 0) return;
    const latest = owner.current.questions;
    const draft = latest.forms.find(item => item.form.id === formId);
    if (blocked(latest, draft) || !draft || latest.page(formId) !== questionIndex) return;
    const renderedDraft = questions.forms.find(item => item.form.id === formId);
    if (!renderedDraft || formIdentity(renderedDraft.form) !== formIdentity(draft.form) || questions.page(formId) !== questionIndex) return;
    const question = draft.form.input.pages[questionIndex];
    if (!question?.options?.length || question.allow_other !== true) return;
    // A trigger from a reused transcript DOM node must not enter another scope.
    const card = trigger?.closest<HTMLElement>("[data-question-scope]");
    if (card && (card.dataset.questionScope !== latest.scopeKey || card.dataset.sendId !== formId)) return;
    const triggerPage = trigger?.closest<HTMLElement>("[data-question-page]");
    if (triggerPage && triggerPage.dataset.questionPage !== String(questionIndex)) return;
    const identity = formIdentity(draft.form);
    const baseOther = otherValue(draft.answers[questionIndex]);
    const fresh: Buffer = { scopeKey: latest.scopeKey, formId, questionIndex, identity, baseOther, text: baseOther ?? "", edited: false };
    const key = bufferKey(fresh);
    if (target.current) remember(target.current);
    const recovered = buffers.get(key);
    // An old buffer is not rebased onto a changed custom answer. Retain its base
    // so Save stays blocked instead of silently overwriting the newer answer.
    const buffer = recovered ?? fresh;
    target.current = { ...buffer, key, epoch, navigationCurrent: store.conversationNavigationFence(), trigger };
    focus.current = null;
    refresh();
  };
  const update: QuestionAnswerComposerContextValue["update"] = text => {
    const value = editing();
    if (!value) return;
    // Do not normalize an IME's unfinished composition. The composer clamps at
    // composition end; the parser still independently validates explicit Save.
    value.text = text.slice(0, USER_QUESTIONS_LIMITS.answerText * 2);
    value.edited = true;
    value.failure = undefined;
    remember(value);
    refresh();
  };
  const cancel = () => {
    const value = editing();
    if (!value) return;
    remember(value);
    finish(value);
  };
  const discard = () => {
    const value = editing();
    if (!value) return;
    // Explicit recovery only: discard this custom edit, not the questionnaire's
    // saved/local answer or another scope's recovery buffer.
    buffers.delete(value.key);
    persistBuffers(buffers);
    finish(value);
  };
  const save = (): boolean => {
    const value = editing();
    if (!value) return false;
    const checked = inspect(owner.current.questions, value);
    if (checked.reason || !checked.draft || checked.answer === undefined) { refresh(); return false; }
    try {
      // The controller acknowledges only local draft acceptance. Its existing
      // autosave owner is solely responsible for persistence and reconciliation.
      const accepted = owner.current.questions.edit(value.formId, value.questionIndex, checked.answer) === true;
      if (!accepted || !current() || !value.navigationCurrent() || target.current !== value) {
        value.failure = "The questionnaire draft update was not confirmed. Your answer text is kept; review the questionnaire before retrying.";
        remember(value);
        refresh();
        return false;
      }
    } catch {
      value.failure = "The questionnaire draft could not be updated. Your answer text is kept.";
      remember(value);
      refresh();
      return false;
    }
    buffers.delete(value.key);
    persistBuffers(buffers);
    finish(value);
    return true;
  };
  const reveal = () => {
    const value = editing();
    if (!value?.navigationCurrent()) return;
    const latest = owner.current.questions;
    const draft = latest.forms.find(item => item.form.id === value.formId);
    if (!draft || formIdentity(draft.form) !== value.identity) return;
    latest.setPage(value.formId, value.questionIndex);
    if (current()) owner.current.questions.open(value.formId);
  };

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useLayoutEffect(() => {
    const suspended = target.current;
    if (!active || !current() || !suspended || suspended.epoch === epoch
      || suspended.scopeKey !== questions.scopeKey || !suspended.navigationCurrent()) return;
    const draft = questions.forms.find(item => item.form.id === suspended.formId);
    // Only an activity overlay in the same still-current conversation can
    // resume answer mode. Away/back, rebinding and changed definitions cannot.
    if (!draft || formIdentity(draft.form) !== suspended.identity) return;
    suspended.epoch = epoch;
    refresh();
  }, [active, epoch, questions.scopeKey, questions.forms, current, refresh]);
  useLayoutEffect(() => {
    const previous = focus.current;
    focus.current = null;
    if (!previous || !current() || previous.epoch !== epoch || !previous.navigationCurrent() || target.current) return;
    const trigger = previous.trigger;
    if (!trigger?.isConnected || trigger.matches(":disabled") || trigger.closest('[hidden], [inert], [aria-hidden="true"]')) return;
    const card = trigger.closest<HTMLElement>("[data-question-scope]");
    if (card && (card.dataset.questionScope !== previous.scopeKey || card.dataset.sendId !== previous.formId)) return;
    const page = trigger.closest<HTMLElement>("[data-question-page]");
    if (page && page.dataset.questionPage !== String(previous.questionIndex)) return;
    trigger.focus({ preventScroll: true });
  });
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (![...buffers.values()].some(hasEdits)) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [buffers]);
  // The composer routes Escape to cancel(), with its own IME/menu guards. A
  // global listener here would bypass those guards during unfinished input.

  const value = editing();
  const checked = value ? inspect(questions, value) : null;
  const page = value && questions.forms.find(item => item.form.id === value.formId)?.form.input.pages[value.questionIndex];
  const reason = checked?.reason ?? value?.failure;
  const editor: QuestionAnswerComposerEditor | null = value ? {
    key: value.key, formId: value.formId, questionIndex: value.questionIndex,
    questionNumber: value.questionIndex + 1,
    questionCount: questions.forms.find(item => item.form.id === value.formId)?.form.input.pages.length ?? 0,
    question: page?.question ?? "Original question unavailable", text: value.text,
    canSave: !!checked && !reason && checked.answer !== undefined,
    ...(reason ? { reason } : {}),
  } : null;
  return <QuestionAnswerComposerContext.Provider value={{ editor, available: current(), begin, update, save, cancel, discard, reveal }}>{children}</QuestionAnswerComposerContext.Provider>;
}
