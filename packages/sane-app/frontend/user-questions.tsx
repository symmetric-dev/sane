import { useLayoutEffect, useRef, useState, type ReactNode, type TextareaHTMLAttributes } from "react";
import { FiArrowLeft, FiArrowRight, FiCheck, FiHelpCircle } from "react-icons/fi";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { USER_QUESTIONS_LIMITS, type UserQuestion, type UserQuestionAnswer, type UserQuestionsRecord } from "../shared/user-questions-contract";
import type { Message } from "./types";
import type { UserQuestionsController, UserQuestionsDraft } from "./user-questions-client";
import { ChatFileLink } from "./chat-file-link";
import { FilterDropdown } from "./filter-dropdown";
import { ComposerRequest, RequestActions, RequestBody, RequestButton, RequestChoices, RequestDisclosure, RequestTextarea } from "./composer-request";
import "./user-questions.css";

/** External links are HTTP(S) only; local links use the existing confined Files reader. */
function safeUrl(value?: string): string | undefined {
  if (!value || !/^https?:\/\//i.test(value)) return;
  try { const url = new URL(value); if (!url.username && !url.password) return url.href; } catch {}
}
function QuestionLink({ href, children, form }: { href?: string; children?: ReactNode; form: UserQuestionsRecord }) {
  const url = safeUrl(href);
  if (url) return <a href={url} target="_blank" rel="noopener noreferrer">{children}</a>;
  if (!href || href.startsWith("//")) return <span>{children}</span>;
  // Preserve a line locator in the label. Files opens the file without claiming
  // that its current contents or line numbers match the author's earlier read.
  const path = href.replace(/(?::[1-9]\d*(?:-[1-9]\d*)?|#L[1-9]\d*(?:-L?[1-9]\d*)?)$/, "");
  if (/^[a-z][a-z\d+.-]*:/i.test(path)) return <span>{children}</span>;
  return <ChatFileLink href={path} sessionId={form.sessionId} expectedScope={form}>{children}</ChatFileLink>;
}
const choiceAnswer = (selected: string[], other?: string): UserQuestionAnswer => selected.length || other !== undefined
  ? { selected, ...(other !== undefined ? { other } : {}) } : null;
// HTML counts UTF-16 units. Its outer bound allows astral characters; slicing by
// code point enforces the shared limit without cutting a surrogate pair in half.
const answerText = (value: string) => Array.from(value).slice(0, USER_QUESTIONS_LIMITS.answerText).join("");

/** Do not normalize or autosave an IME's unfinished composition. */
function AnswerTextarea({ value, change, ...props }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & { value: string; change: (value: string) => void }) {
  const composing = useRef(false);
  const [composition, setComposition] = useState<string | null>(null);
  return <RequestTextarea {...props} value={composition ?? value}
    onCompositionStart={event => { composing.current = true; setComposition(event.currentTarget.value); }}
    onCompositionEnd={event => {
      composing.current = false;
      setComposition(null);
      change(answerText(event.currentTarget.value));
    }}
    onChange={event => {
      if (composing.current) setComposition(event.currentTarget.value);
      else change(answerText(event.currentTarget.value));
    }} />;
}

/** Match durable anchors, not tool names, output text, or executable wrapper arguments. */
export function questionsForMessage(sessionId: string, source: Message, forms: readonly UserQuestionsDraft[]) {
  return forms.filter(({ form }) => {
    if (form.sessionId !== sessionId || source.runId !== "native-import" && source.runId !== form.anchor.runId) return false;
    if (form.anchor.messageId && source.id !== form.anchor.messageId && !source.nativeIds?.includes(form.anchor.messageId)) return false;
    return source.parts.some(part => part.type === "tool" && (part.toolCallId ?? part.id) === form.anchor.toolCallId);
  });
}

export function UserQuestionsReference({ questions, source, sessionId }: { questions?: UserQuestionsController; source: Message; sessionId: string }) {
  if (!questions) return null;
  return <>{questionsForMessage(sessionId, source, questions.forms).map(({ form }) => <aside className="user-questions-reference" key={form.id}>
    <span>Questions · {form.input.title}</span><span className="muted">{form.status}</span>
    <button type="button" className="text-button" onClick={() => { questions.open(form.id); requestAnimationFrame(() => { const panel = document.getElementById(`user-questions-${form.id}`); if (!panel || panel.closest("[hidden]")) return; panel.scrollIntoView({ block: "nearest" }); panel.querySelector<HTMLButtonElement>(".composer-request-heading")?.focus({ preventScroll: true }); }); }}>View questions</button>
  </aside>)}</>;
}

function AnswerEditor({ question, answer, change, disabled, name }: { question: UserQuestion; answer: UserQuestionAnswer; change: (answer: UserQuestionAnswer) => void; disabled: boolean; name: string }) {
  const options = question.options ?? [];
  if (!options.length) return <div className="request-field">
    <label className="request-field-label" htmlFor={name}>Your answer <span className="request-field-hint">· optional</span></label>
    <AnswerTextarea id={name} aria-describedby={`${name}-state`} rows={3} maxLength={USER_QUESTIONS_LIMITS.answerText * 2} value={typeof answer === "string" ? answer : ""} placeholder="Write an answer…" disabled={disabled} change={change} />
    <div className="user-questions-answer-meta">
      <span id={`${name}-state`} className="request-field-hint">{answer === null ? "Unanswered" : answer === "" ? "Empty answer" : "Answer entered"}</span>
      <RequestButton variant="quiet" disabled={disabled} onClick={() => change(answer === null ? "" : null)}>{answer === null ? "Use empty answer" : "Leave unanswered"}</RequestButton>
    </div>
  </div>;
  const selection: { selected: string[]; other?: string } = answer !== null && typeof answer === "object" ? answer : { selected: [] };
  const hasOther = selection.other !== undefined;
  return <div className="request-field">
    <span className="request-field-hint">{question.multiple ? "Choose any that apply" : "Choose one answer"} · optional</span>
    <RequestChoices label={question.question} multiple={question.multiple} disabled={disabled}
      options={[...options.map((label, index) => ({ value: `option-${index}`, label })), ...(question.allow_other ? [{ value: "other", label: "Write another answer" }] : [])]}
      values={[...options.flatMap((option, index) => selection.selected.includes(option) ? [`option-${index}`] : []), ...(hasOther ? ["other"] : [])]}
      choose={value => {
        if (value === "other") { change(hasOther ? choiceAnswer(selection.selected) : choiceAnswer(question.multiple ? selection.selected : [], "")); return; }
        const option = options[Number(value.slice(7))];
        if (option === undefined) return;
        const selected = selection.selected.includes(option);
        if (question.multiple) change(choiceAnswer(selected ? selection.selected.filter(item => item !== option) : [...selection.selected, option], selection.other));
        else change(selected ? null : { selected: [option] });
      }} />
    {hasOther && <label className="request-field"><span className="request-field-label">Your other answer</span><AnswerTextarea rows={2} maxLength={USER_QUESTIONS_LIMITS.answerText * 2} value={selection.other ?? ""} disabled={disabled} placeholder="Tell us what you have in mind…" change={value => change(choiceAnswer(question.multiple ? selection.selected : [], value))} /></label>}
    {answer !== null && <div className="user-questions-answer-meta"><RequestButton variant="quiet" disabled={disabled} onClick={() => change(null)}>Leave unanswered</RequestButton></div>}
  </div>;
}

function DeliveryStatus({ form }: { form: UserQuestionsRecord }) {
  if (form.status === "dismissed") return <p className="request-message" role="status">Dismissed. No answers were sent to the assistant.</p>;
  if (form.status !== "submitted") return null;
  const delivery = form.delivery;
  const status = delivery?.state === "accepted" ? "Answers delivered to the conversation."
    : delivery?.state === "wrapper-completed" ? "Answers delivered to Grok. The App execution completed."
    : delivery?.state === "paused" ? "Answers saved. Delivery is paused."
    : delivery?.state === "pending" ? "Answers saved. Waiting to send."
    : delivery?.state === "claimed" ? "Sending answers. Waiting for delivery confirmation."
    : "Answers saved. Delivery is unconfirmed. Do not resend.";
  return <p className="request-message" role="status">{status}</p>;
}

/** Plain text preserves the answer record without exposing mutable inputs or link markup. */
function AnswerValue({ answer }: { answer: UserQuestionAnswer }) {
  if (answer === null) return <span className="request-field-hint">Unanswered</span>;
  if (typeof answer === "string") return answer === "" ? <span className="request-field-hint">Empty answer</span> : <p className="user-questions-answer-text">{answer}</p>;
  return <>
    {!!answer.selected.length && <ul className="user-questions-answer-options" aria-label="Selected options">{answer.selected.map(option => <li key={option}>{option}</li>)}</ul>}
    {answer.other !== undefined && <div><span className="request-field-hint">Other answer</span>{answer.other === "" ? <p className="request-field-hint">Empty answer</p> : <p className="user-questions-answer-text">{answer.other}</p>}</div>}
  </>;
}

function AnswerRecord({ form, answers }: { form: UserQuestionsRecord; answers: readonly UserQuestionAnswer[] }) {
  return <ol className="user-questions-answer-record">{form.input.pages.map((question, index) => <li key={index}>
    <strong>{question.question}</strong><AnswerValue answer={answers[index] ?? null} />
  </li>)}</ol>;
}

function QuestionsConflict({ questions, draft }: { questions: UserQuestionsController; draft: UserQuestionsDraft }) {
  return <div className="request-inline-notice">
    <p>A newer server version is available. Your local answers are kept and won’t be retried automatically.</p>
    <RequestDisclosure label={`Server answers · revision ${draft.form.revision}`}>
      <AnswerRecord form={draft.form} answers={draft.form.submission?.answers ?? draft.form.answers} />
    </RequestDisclosure>
    <RequestDisclosure label="View local answers"><AnswerRecord form={draft.form} answers={draft.answers} /></RequestDisclosure>
    <p>Copy any local answers you want to keep before reloading.</p>
    <RequestButton variant="danger" disabled={!!draft.operation || !questions.editable} onClick={() => questions.reload(draft.form.id)}>Discard local answers and reload</RequestButton>
    <RequestButton variant="quiet" onClick={questions.retry}>Refresh server version</RequestButton>
  </div>;
}

function QuestionsFeedback({ questions, draft, readOnlyReason }: { questions: UserQuestionsController; draft: UserQuestionsDraft; readOnlyReason?: string }) {
  const { form, operation } = draft;
  return <>
    {!questions.editable && <p className="request-message">{readOnlyReason || "Read-only until the connection is available and questions have refreshed."}</p>}
    {draft.error && <p className="request-message request-error" role="alert">{draft.error}</p>}
    {draft.error && draft.dirty && !operation && !draft.conflict && form.status === "presented" && <RequestButton disabled={!questions.editable} onClick={() => void questions.mutate(form.id, "answers")}>Save draft again</RequestButton>}
    {draft.conflict && <QuestionsConflict questions={questions} draft={draft} />}
    {form.status !== "presented" && (draft.dirty || operation?.answers) && !draft.conflict && <div className="request-inline-notice">
      <p>Your local answers are kept separately from this {form.status === "submitted" ? "submission" : "dismissed record"}. Copy any you want to keep.{operation && " The original request still needs confirmation."}</p>
      <RequestDisclosure label="View local answers"><AnswerRecord form={form} answers={draft.answers} /></RequestDisclosure>
    </div>}
    {operation?.uncertain && <RequestButton disabled={!questions.editable} onClick={() => void questions.reconcile(form.id)}>Reconcile original request</RequestButton>}
  </>;
}

/** Only authoritative terminal form states replace the editor, never a pending browser operation. */
function QuestionsOutcome({ questions, draft, readOnlyReason }: { questions: UserQuestionsController; draft: UserQuestionsDraft; readOnlyReason?: string }) {
  const { form } = draft;
  const blocked = !questions.editable || !!draft.operation || draft.conflict;
  return <>
    <RequestBody>
      <DeliveryStatus form={form} />
      <QuestionsFeedback questions={questions} draft={draft} readOnlyReason={readOnlyReason} />
      {form.status === "submitted" && form.submission && <RequestDisclosure label="View submitted answers"><AnswerRecord form={form} answers={form.submission.answers} /></RequestDisclosure>}
      {form.delivery?.reason && <RequestDisclosure label="Delivery details"><p className="user-questions-delivery-detail">{form.delivery.reason}</p></RequestDisclosure>}
    </RequestBody>
    <RequestActions hint="Chat is still available below.">
      {form.status === "submitted" && form.delivery?.state === "paused" && <RequestButton variant="primary" disabled={blocked} onClick={() => void questions.mutate(form.id, "resume")}>Resume delivery</RequestButton>}
    </RequestActions>
  </>;
}

function QuestionsEditor({ questions, draft, readOnlyReason }: { questions: UserQuestionsController; draft: UserQuestionsDraft; readOnlyReason?: string }) {
  const [page, setPage] = useState(0);
  const [confirmDismiss, setConfirmDismiss] = useState(false);
  const pageField = useRef<HTMLFieldSetElement>(null);
  const focusPage = useRef(false);
  const { form, answers, operation } = draft;
  const pageIndex = Math.min(page, form.input.pages.length - 1);
  const question = form.input.pages[pageIndex];
  const final = pageIndex === form.input.pages.length - 1;
  const busy = !!operation && !operation.uncertain;
  const readOnly = !questions.editable || form.status !== "presented";
  const disabled = readOnly || !!operation && operation.kind !== "answers";
  const blocked = !questions.editable || !!operation || draft.conflict;
  useLayoutEffect(() => {
    if (!focusPage.current) return;
    focusPage.current = false;
    pageField.current?.focus({ preventScroll: true });
  }, [pageIndex]);
  const goToPage = (index: number) => {
    focusPage.current = true;
    setPage(Math.max(0, Math.min(index, form.input.pages.length - 1)));
  };
  return <>
    <RequestBody resetKey={pageIndex}>
    <QuestionsFeedback questions={questions} draft={draft} readOnlyReason={readOnlyReason} />
    {question && <fieldset ref={pageField} tabIndex={-1} className="user-questions-page">
      <legend><span className="user-questions-step" role="status">Question {pageIndex + 1} of {form.input.pages.length}</span><strong>{question.question}</strong></legend>
      {question.context && <div className="prose user-questions-context"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: ({ href, children }) => <QuestionLink href={href} form={form}>{children}</QuestionLink>, img: ({ alt }) => <span className="muted">[Image: {alt || "omitted"}]</span> }}>{question.context}</ReactMarkdown></div>}
      {!!question.references?.length && <RequestDisclosure key={`${pageIndex}-references`} label={`References · ${question.references.length}`}><ul className="user-questions-references">{question.references.map((reference, index) => <li key={index}><QuestionLink href={reference} form={form}>{reference}</QuestionLink></li>)}</ul><p className="request-field-hint">Opens current files in the original worktree. Line numbers are informational.</p></RequestDisclosure>}
      <AnswerEditor key={pageIndex} question={question} answer={answers[pageIndex] ?? null} disabled={disabled} name={`question-${form.id}-${pageIndex}`} change={answer => questions.edit(form.id, pageIndex, answer)} />
    </fieldset>}
    </RequestBody>
    {confirmDismiss && form.status === "presented" ? <RequestActions hint="Dismiss without sending any answers?">
      <RequestButton onClick={() => setConfirmDismiss(false)}>Keep answering</RequestButton>
      <RequestButton variant="danger" disabled={blocked} onClick={() => { setConfirmDismiss(false); void questions.mutate(form.id, "dismiss"); }}>Dismiss questions</RequestButton>
    </RequestActions> : <RequestActions hint="Optional · sent only when you submit. Chat is still available below.">
      {form.status === "presented" && <RequestButton variant="quiet" disabled={blocked} onClick={() => setConfirmDismiss(true)}>Dismiss</RequestButton>}
      <RequestButton variant="quiet" disabled={pageIndex <= 0} onClick={() => goToPage(pageIndex - 1)}><FiArrowLeft aria-hidden="true" />Back</RequestButton>
      {!final ? <RequestButton onClick={() => goToPage(pageIndex + 1)}>Next<FiArrowRight aria-hidden="true" /></RequestButton> : form.status === "presented" && <RequestButton variant="primary" disabled={blocked} onClick={() => void questions.mutate(form.id, "submit")}><FiCheck aria-hidden="true" />{operation?.kind === "submit" && busy ? "Submitting…" : "Submit answers"}</RequestButton>}
    </RequestActions>}
  </>;
}

function questionsStatus(draft: UserQuestionsDraft) {
  if (draft.conflict) return "Version conflict";
  if (draft.operation?.uncertain) return "Unconfirmed";
  if (draft.operation) return draft.operation.kind === "answers" ? "Saving…" : "Updating…";
  if (draft.dirty) return draft.form.status === "presented" ? "Unsaved" : "Local answers retained";
  if (draft.error) return "Needs attention";
  if (draft.form.status === "presented") return "Draft saved";
  if (draft.form.status === "dismissed") return "Dismissed";
  switch (draft.form.delivery?.state) {
    case "accepted": return "Delivered";
    case "wrapper-completed": return "Delivered to Grok";
    case "pending": return "Waiting to send";
    case "claimed": return "Sending…";
    case "paused": return "Delivery paused";
    case "unknown": return "Delivery unconfirmed";
    default: return "Answers saved";
  }
}

export function UserQuestionsPanel({ questions, readOnlyReason }: { questions: UserQuestionsController; readOnlyReason?: string }) {
  const draft = questions.selected;
  if (!draft) return questions.error ? <ComposerRequest id="user-questions-unavailable" icon={<FiHelpCircle size={16} />} label="Assistant questions" title="Questions unavailable"><RequestBody><p className="request-message request-error" role="alert">{questions.error} <RequestButton variant="quiet" onClick={questions.retry}>Retry questions</RequestButton></p></RequestBody></ComposerRequest> : null;
  const id = `user-questions-${draft.form.id}`;
  const waiting = questions.forms.find(item => item.form.status === "presented" && item.form.id !== draft.form.id);
  const status = waiting ? "New questions waiting" : questions.error ? "Refresh needed" : questionsStatus(draft);
  const submitted = draft.form.status === "submitted";
  const RequestIcon = submitted ? draft.form.delivery?.state === "accepted" || draft.form.delivery?.state === "wrapper-completed" ? FiCheck : FiArrowRight : FiHelpCircle;
  return <ComposerRequest id={id} className={draft.form.status !== "presented" ? "user-questions-outcome" : ""} icon={<RequestIcon size={16} />} label={submitted ? "Answer delivery" : "Assistant questions"} title={draft.form.input.title} status={status} expanded={questions.expanded} toggle={questions.toggle}
    tools={<>
      {questions.forms.length > 1 && <FilterDropdown label="Question sets" value={draft.form.id} onChange={questions.open} options={questions.forms.map(({ form }) => ({ value: form.id, label: `${form.input.title} · ${form.status === "presented" ? "Awaiting answers" : form.status}` }))} />}
      {questions.canClose && <RequestButton variant="quiet" onClick={questions.close}>Back to chat</RequestButton>}
    </>}>
      {waiting && <p className="request-message user-questions-new"><RequestButton variant="quiet" onClick={() => questions.open(waiting.form.id)}>New questions awaiting answers<FiArrowRight aria-hidden="true" /></RequestButton></p>}
      {questions.error && <p className="request-message request-error user-questions-new" role="alert">{questions.error} <RequestButton variant="quiet" onClick={questions.retry}>Retry questions</RequestButton></p>}
      {draft.form.status === "presented"
        ? <QuestionsEditor key={`${questions.scopeKey}:${draft.form.id}`} questions={questions} draft={draft} readOnlyReason={readOnlyReason} />
        : <QuestionsOutcome key={`${questions.scopeKey}:${draft.form.id}`} questions={questions} draft={draft} readOnlyReason={readOnlyReason} />}
  </ComposerRequest>;
}
