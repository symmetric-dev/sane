import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type TextareaHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { FiArrowLeft, FiArrowRight, FiCheck, FiHelpCircle, FiInfo, FiPlus, FiRefreshCw, FiRotateCcw, FiX } from "react-icons/fi";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { USER_QUESTIONS_LIMITS, type UserQuestion, type UserQuestionAnswer, type UserQuestionsRecord } from "../shared/user-questions-contract";
import type { Message, ToolPart } from "./types";
import type { UserQuestionsController, UserQuestionsDraft } from "./user-questions-client";
import { ChatFileLink } from "./chat-file-link";
import { RequestChoices, RequestTextarea } from "./composer-request";
import { ChatButton, ChatCard, ChatCardBody, ChatCardFooter, ChatCardHeader, ChatDialog, ChatDialogBody, ChatDialogFooter, ChatDisclosure, ChatIconButton, ChatNotice, ChatOverflowMenu, type ChatButtonProps, type ChatButtonVariant, type ChatMenuItem } from "./chat-ui";
import { questionsCompactStatus, questionsNeedAttention, questionsStatus } from "./user-questions-presentation";
import { commandHint } from "./application-commands";
import { USER_QUESTIONS_KEYS, userQuestionsShortcut } from "./user-questions-shortcuts";
import { useQuestionAnswerComposer } from "./question-answer-composer";
import "./user-questions.css";
import type { ExplainQuestion } from "./aside-panel";

export { questionsForMessage } from "./user-questions-presentation";

// Preserve specialized answer controls, while all surrounding presentation uses
// the same controls, disclosures, spacing and surfaces as other transcript cards.
function RequestButton({ variant = "secondary", ...props }: Omit<ChatButtonProps, "variant"> & { variant?: ChatButtonVariant | "quiet" }) {
  return <ChatButton {...props} variant={variant === "quiet" ? "ghost" : variant} />;
}
function RequestDisclosure({ label, children }: { label: ReactNode; children: ReactNode }) {
  return <ChatDisclosure title={label}>{children}</ChatDisclosure>;
}
function RequestBody({ children }: { children: ReactNode }) {
  return <ChatCardBody>{children}</ChatCardBody>;
}

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

function AnswerEditor({ question, answer, change, disabled, otherDisabled, name, formId, page }: { question: UserQuestion; answer: UserQuestionAnswer; change: (answer: UserQuestionAnswer) => void; disabled: boolean; otherDisabled: boolean; name: string; formId: string; page: number }) {
  const composer = useQuestionAnswerComposer();
  const options = question.options ?? [];
  if (!options.length) return <div className="request-field user-questions-answers">
    <label className="sr-only" htmlFor={name}>Your answer</label>
    <span id={`${name}-state`} className="sr-only">{answer === null ? "Unanswered" : answer === "" ? "Empty answer" : "Answer entered"}</span>
    <AnswerTextarea id={name} aria-describedby={`${name}-state`} rows={3} maxLength={USER_QUESTIONS_LIMITS.answerText * 2} value={typeof answer === "string" ? answer : ""} placeholder="Write an answer…" disabled={disabled} change={change} />
  </div>;
  const selection: { selected: string[]; other?: string } = answer !== null && typeof answer === "object" ? answer : { selected: [] };
  const hasOther = selection.other !== undefined;
  // The nearest provider owns the current question scope; never match by text.
  const editingOther = composer?.editor?.formId === formId && composer.editor.questionIndex === page;
  return <div className="request-field user-questions-answers">
    <RequestChoices label={question.question} multiple={question.multiple} disabled={disabled}
      options={options.map((label, index) => ({ value: `option-${index}`, label, shortcut: index < 10 ? `Alt+${(index + 1) % 10}` : undefined }))}
      values={options.flatMap((option, index) => selection.selected.includes(option) ? [`option-${index}`] : [])}
      choose={value => {
        const option = options[Number(value.slice(7))];
        if (option === undefined) return;
        const selected = selection.selected.includes(option);
        if (question.multiple) change(choiceAnswer(selected ? selection.selected.filter(item => item !== option) : [...selection.selected, option], selection.other));
        else change(selected ? null : { selected: [option] });
      }} />
    {question.allow_other && <div className="request-field user-questions-other">
      <button id={`${name}-other`} type="button" className="request-choice user-questions-other-choice" data-editing={editingOther}
        aria-pressed={hasOther} aria-expanded={editingOther} aria-label={hasOther ? `Edit custom answer: ${selection.other === "" ? "Empty answer" : selection.other}` : "Write custom answer"} aria-keyshortcuts="Alt+O"
        title={!composer?.available ? "Return to the chat composer to write a custom answer" : `${hasOther ? "Edit" : "Write"} custom answer (${commandHint(USER_QUESTIONS_KEYS.focusOther)})`}
        disabled={disabled || otherDisabled || !composer?.available}
        onClick={event => { if (!disabled && !otherDisabled) composer?.begin(formId, page, event.currentTarget); }}>
        <span className="request-choice-mark" aria-hidden="true">{hasOther ? <FiCheck size={12} /> : <FiPlus size={12} />}</span>
        <span className="request-choice-copy">{hasOther ? selection.other === "" ? "Empty answer" : selection.other : editingOther ? "Writing another answer…" : "Write another answer"}</span>
      </button>
    </div>}
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
    <h4 className="user-questions-title">{question.question}</h4><AnswerValue answer={answers[index] ?? null} />
  </li>)}</ol>;
}

function QuestionToolDetails({ tool }: { tool: ToolPart }) {
  return <><h3>{tool.name}</h3><h4>Input</h4><pre className="user-questions-tool-detail">{JSON.stringify(tool.input, null, 2)}</pre><h4>{tool.error ? "Error" : "Output"}</h4><pre className="user-questions-tool-detail">{typeof tool.output === "string" ? tool.output : JSON.stringify(tool.output, null, 2) ?? "No output recorded"}</pre></>;
}

function QuestionsConflict({ questions, draft }: { questions: UserQuestionsController; draft: UserQuestionsDraft }) {
  return <ChatNotice tone="warning" className="user-questions-conflict">
    <p>A newer server version is available. Your local answers are kept and won’t be retried automatically.</p>
    <RequestDisclosure label={`Server answers · revision ${draft.form.revision}`}>
      <AnswerRecord form={draft.form} answers={draft.form.submission?.answers ?? draft.form.answers} />
    </RequestDisclosure>
    <RequestDisclosure label="View local answers"><AnswerRecord form={draft.form} answers={draft.answers} /></RequestDisclosure>
    <p>Copy any local answers you want to keep before reloading.</p>
    <RequestButton variant="danger" disabled={!!draft.operation || !questions.editable} onClick={() => questions.reload(draft.form.id)}>Discard local answers and reload</RequestButton>
    <RequestButton variant="quiet" onClick={questions.retry}>Refresh server version</RequestButton>
  </ChatNotice>;
}

function QuestionsFeedback({ questions, draft, readOnlyReason }: { questions: UserQuestionsController; draft: UserQuestionsDraft; readOnlyReason?: string }) {
  const { form, operation } = draft;
  return <>
    {!questions.editable && <ChatNotice>{readOnlyReason || "Read-only until the connection is available and questions have refreshed."}</ChatNotice>}
    {draft.error && <ChatNotice tone="danger" role="alert">{draft.error}</ChatNotice>}
    {draft.error && draft.dirty && !operation && !draft.conflict && form.status === "presented" && <RequestButton disabled={!questions.editable} onClick={() => void questions.mutate(form.id, "answers")}>Save draft again</RequestButton>}
    {draft.conflict && <QuestionsConflict questions={questions} draft={draft} />}
    {form.status !== "presented" && (draft.dirty || operation?.answers) && !draft.conflict && <ChatNotice tone="warning">
      <p>Your local answers are kept separately from this {form.status === "submitted" ? "submission" : "dismissed record"}. Copy any you want to keep.{operation && " The original request still needs confirmation."}</p>
      <RequestDisclosure label="View local answers"><AnswerRecord form={form} answers={draft.answers} /></RequestDisclosure>
    </ChatNotice>}
    {operation?.uncertain && <RequestButton disabled={!questions.editable} onClick={() => void questions.reconcile(form.id)}>Reconcile original request</RequestButton>}
  </>;
}

function QuestionsEditor({ questions, draft, page, navigation, active }: { questions: UserQuestionsController; draft: UserQuestionsDraft; page: number; navigation: ReactNode; active: boolean }) {
  const pageField = useRef<HTMLFieldSetElement>(null);
  const previousPage = useRef(page);
  const { form, answers, operation } = draft;
  const pageIndex = Math.min(page, form.input.pages.length - 1);
  const question = form.input.pages[pageIndex];
  const progressId = `question-${form.id}-progress`;
  const readOnly = !questions.editable || form.status !== "presented";
  const disabled = readOnly || !!operation && operation.kind !== "answers";
  useLayoutEffect(() => {
    if (previousPage.current === pageIndex || pageField.current?.dataset.questionPage !== String(pageIndex)) return;
    previousPage.current = pageIndex;
    const content = pageField.current?.closest<HTMLElement>(".user-questions-content");
    if (content) content.scrollTop = 0;
    const card = pageField.current?.closest<HTMLElement>(".user-questions-card");
    if (card) card.closest(".viewport")?.dispatchEvent(new CustomEvent("questionnaire-page-jump", { detail: card }));
    pageField.current?.focus({ preventScroll: true });
  }, [pageIndex]);
  return <RequestBody>
    {question && <fieldset ref={pageField} data-question-page={pageIndex} tabIndex={-1} className="user-questions-page" aria-labelledby={`question-${form.id}-${pageIndex}-title`} aria-describedby={progressId}>
      <h4 id={`question-${form.id}-${pageIndex}-title`} className="user-questions-title">{question.question}</h4>
      {question.context && (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded context region needs keyboard focus for scrolling.
        <section key={pageIndex} className="prose user-questions-context" aria-label="Question context" tabIndex={0}><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: ({ href, children }) => <QuestionLink href={href} form={form}>{children}</QuestionLink>, img: ({ alt }) => <span className="muted">[Image: {alt || "omitted"}]</span> }}>{question.context}</ReactMarkdown></section>
      )}
      {navigation}
      <AnswerEditor key={`answers-${pageIndex}`} question={question} answer={answers[pageIndex] ?? null} disabled={disabled} otherDisabled={draft.conflict || !!draft.error || !!operation?.uncertain || !active} name={`question-${form.id}-${pageIndex}`} formId={form.id} page={pageIndex} change={answer => questions.edit(form.id, pageIndex, answer)} />
    </fieldset>}
    </RequestBody>;
}

/** Terminal records stay compact; recovery never hides behind the answers modal. */
export function UserQuestionsCard({ questions, draft, readOnlyReason, tool, active = true, onExplain, explainDisabled = false }: {
  questions: UserQuestionsController; draft: UserQuestionsDraft; readOnlyReason?: string; tool?: ToolPart; active?: boolean; onExplain?: ExplainQuestion; explainDisabled?: boolean;
}) {
  const { form } = draft;
  const answerComposer = useQuestionAnswerComposer();
  const editingCustomAnswer = answerComposer?.editor?.formId === form.id;
  const presented = form.status === "presented";
  const expanded = presented && questions.selected?.form.id === form.id && questions.expanded;
  const blocked = !questions.editable || !!draft.operation || draft.conflict;
  const pageIndex = questions.page(form.id);
  const final = pageIndex === form.input.pages.length - 1;
  const submitting = draft.operation?.kind === "submit" && !draft.operation.uncertain;
  const [view, setView] = useState<"answers" | "details" | "tool" | "dismiss" | null>(null);
  useEffect(() => { if (!active) setView(null); }, [active]);
  const trigger = useRef<HTMLButtonElement | null>(null), primary = useRef<HTMLButtonElement>(null);
  const focused = useRef(false), previouslyExpanded = useRef(expanded);
  useLayoutEffect(() => {
    if (active && previouslyExpanded.current && !expanded && focused.current) { primary.current?.focus({ preventScroll: true }); focused.current = false; }
    previouslyExpanded.current = expanded;
  }, [expanded, active]);
  const show = (next: NonNullable<typeof view>, button: HTMLButtonElement) => { trigger.current = button; setView(next); };
  const items: ChatMenuItem[] = [
    { id: "details", label: "Details", icon: <FiInfo />, opensDialog: true, onSelect: button => show("details", button) },
    { id: "refresh", label: questions.loading ? "Refreshing…" : "Refresh", icon: <FiRefreshCw />, disabled: questions.loading, busy: questions.loading, onSelect: questions.retry },
  ];
  if (expanded) {
    const answer = draft.answers[pageIndex] ?? null;
    const canEdit = questions.editable && (!draft.operation || draft.operation.kind === "answers");
    items.unshift({ id: "clear", label: "Clear current answer", icon: <FiRotateCcw />, disabled: !canEdit || answer === null, onSelect: () => questions.edit(form.id, pageIndex, null) });
    // Keep the explicit-empty-text distinction available without another row.
    if (!form.input.pages[pageIndex]?.options?.length && answer === null) items.splice(1, 0, { id: "empty", label: "Use empty answer", disabled: !canEdit, onSelect: () => questions.edit(form.id, pageIndex, "") });
    if (editingCustomAnswer && answerComposer) items.push({ id: "discard-custom", label: "Discard unsaved custom draft", danger: true, disabled: !active, onSelect: () => answerComposer.discard() });
  }
  if (tool) items.push({ id: "tool", label: "Tool details", icon: <FiInfo />, opensDialog: true, onSelect: button => show("tool", button) });
  if (presented) items.push({ id: "separator", separator: true }, { id: "dismiss", label: "Dismiss questions", icon: <FiX />, danger: true, disabled: blocked, opensDialog: true, onSelect: button => show("dismiss", button) });
  const count = form.input.pages.length;
  const status = questionsCompactStatus(draft, questions.loading);
  const fullStatus = questionsStatus(draft);
  const subtitle = presented ? expanded ? `${pageIndex + 1}/${count}` : `${count} question${count === 1 ? "" : "s"} · ${status}` : form.status === "submitted" ? `Submitted · ${status}` : status === "Dismissed" ? status : `Dismissed · ${status}`;
  const statusDetail = questions.loading && fullStatus === "Draft saved" ? "Loading saved answers…" : fullStatus;
  const progressDetail = expanded ? `Question ${pageIndex + 1} of ${count}` : `${presented ? `${count} questions` : form.status === "submitted" ? "Submitted" : "Dismissed"} · ${statusDetail}`;
  const progress = <span id={`question-${form.id}-progress`} title={progressDetail} role="status" aria-label={progressDetail}>{subtitle}</span>;
  const references = expanded ? form.input.pages[pageIndex]?.references : undefined;
  const hasReferences = (references?.length ?? 0) > 0;
  const Glyph = form.status === "submitted" ? FiCheck : FiX;
  const needsFeedback = !!draft.error || draft.conflict || !!draft.operation?.uncertain
    || !presented && (draft.dirty || !!draft.operation?.answers) || presented && expanded && !questions.editable;
  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    const card = event.currentTarget, target = event.target;
    if (!active || !expanded || view || event.defaultPrevented || !(target instanceof Element) || !card.contains(target)
      || target.closest('[hidden], [inert], select, [role="combobox"], [role="menu"], [role="listbox"], .cm-editor, .xterm')
      || document.querySelector('dialog[open], [role="dialog"][aria-modal="true"], [role="menu"][data-open="true"], [aria-haspopup="menu"][aria-expanded="true"]')) return;
    const shortcut = userQuestionsShortcut(event.nativeEvent);
    if (!shortcut) return;
    const typing = target.closest('input, textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
    let control: HTMLElement | null;
    if (shortcut.kind === "exitInput") {
      if (!target.closest(".user-questions-answers input, .user-questions-answers textarea")) return;
      control = card.querySelector<HTMLElement>(".user-questions-page");
    } else {
      if (typing && shortcut.kind !== "submit") return;
      control = shortcut.kind === "answer" ? card.querySelectorAll<HTMLButtonElement>(".user-questions-page .request-choices .request-choice")[shortcut.index] ?? null
        : shortcut.kind === "focusOther" ? card.querySelector<HTMLButtonElement>(".user-questions-other button")
        : card.querySelector<HTMLButtonElement>(`[data-question-action="${shortcut.kind}"]`);
    }
    if (!control) return;
    // Consume navigation even at the ends, so Alt+Left/Right cannot fall through
    // to browser history. Holding a shortcut must not toggle or submit twice.
    event.preventDefault(); event.stopPropagation();
    if (event.repeat || control instanceof HTMLButtonElement && control.disabled || control instanceof HTMLInputElement && control.disabled) return;
    if (shortcut.kind === "exitInput") control.focus({ preventScroll: true });
    else {
      if (shortcut.kind === "answer" || shortcut.kind === "focusOther") control.focus({ preventScroll: true });
      control.click();
    }
  };
  const navigation = expanded && <ChatCardFooter className="user-questions-navigation" aria-label="Questionnaire navigation">
    <div className="user-questions-progress">
      <ChatIconButton data-question-action="previous" aria-label="Previous question" aria-keyshortcuts="Alt+ArrowLeft" title={`Previous question (${commandHint(USER_QUESTIONS_KEYS.previous)})`} disabled={pageIndex === 0} onClick={() => questions.setPage(form.id, pageIndex - 1)}><FiArrowLeft /></ChatIconButton>
      {progress}
      <ChatIconButton data-question-action="next" aria-label="Next question" aria-keyshortcuts="Alt+ArrowRight" title={`Next question (${commandHint(USER_QUESTIONS_KEYS.next)})`} disabled={final} onClick={() => questions.setPage(form.id, pageIndex + 1)}><FiArrowRight /></ChatIconButton>
    </div>
    <div className="user-questions-navigation-actions">
      <span className="user-questions-navigation-state" title={statusDetail} role="status" aria-label={statusDetail}>{status}</span>
      <ChatButton ref={primary} data-question-action="submit" className="user-questions-submit" variant="primary" disabled={!final || blocked || editingCustomAnswer} busy={submitting} title={editingCustomAnswer ? "Save or cancel the custom answer before submitting" : !final ? "Review the remaining questions before submitting" : `Submit answers (${commandHint(USER_QUESTIONS_KEYS.submit)})`} aria-keyshortcuts="Alt+Enter" aria-label={submitting ? "Submitting answers" : "Submit answers"} onClick={() => void questions.mutate(form.id, "submit")}>Submit</ChatButton>
    </div>
  </ChatCardFooter>;
  return <><ChatCard id={`user-questions-${form.id}`} tabIndex={-1} density="compact" className={`user-questions-card${hasReferences ? " has-references" : ""}`} aria-label={`Questionnaire: ${form.input.title}`} data-expanded={expanded} data-send-kind="questions" data-send-id={form.id} data-question-scope={questions.scopeKey} data-question-active={active} onKeyDown={keyDown}>
    <ChatCardHeader className="user-questions-header user-questions-header-single" icon={presented ? undefined : <Glyph size={28} />} title={<span title={form.input.title}>{form.input.title}</span>}
      actions={<>
        {presented && <ChatIconButton className="user-questions-collapse" aria-label={expanded ? "Collapse questionnaire" : "Expand questionnaire"} aria-expanded={expanded} aria-controls={`user-questions-${form.id}-editor`} onClick={() => expanded ? questions.toggle() : questions.open(form.id)}><FiHelpCircle /></ChatIconButton>}
        {expanded && onExplain && <ChatButton variant="ghost" data-question-focus="explain" disabled={!active || explainDisabled} onClick={event => onExplain({ kind: "question", formId: form.id, questionIndex: pageIndex }, `Can you explain Question ${pageIndex + 1}`, event.currentTarget)}>Explain</ChatButton>}
        {!expanded && <ChatButton ref={primary} variant="ghost" aria-expanded={presented ? false : undefined} aria-controls={presented ? `user-questions-${form.id}-editor` : undefined} aria-haspopup={presented ? undefined : "dialog"} onClick={event => presented ? questions.open(form.id) : show("answers", event.currentTarget)}>{presented ? questions.editable ? "Answer" : "View questions" : form.status === "submitted" ? "View answers" : "View questions"}</ChatButton>}
        <ChatOverflowMenu label="Questionnaire actions" attention={draft.conflict || !!draft.error || !!draft.operation?.uncertain || !!tool?.error || form.delivery?.state === "paused"} items={items} />
      </>}>
      {!expanded && <div className="user-questions-header-state">{progress}</div>}
    </ChatCardHeader>
    <div className="user-questions-content">
    {needsFeedback && <ChatCardBody className="user-questions-feedback"><QuestionsFeedback questions={questions} draft={draft} readOnlyReason={readOnlyReason} /></ChatCardBody>}
    {tool?.error && <ChatNotice tone="warning" role="alert">The question tool reported an error. The saved questionnaire is retained; inspect Tool details before retrying.</ChatNotice>}
    {form.status === "submitted" && (form.delivery?.state === "paused" || form.delivery?.state === "unknown" || !form.delivery) && <ChatCardBody className="user-questions-feedback"><ChatNotice tone="warning"><DeliveryStatus form={form} />{form.delivery?.reason && <p className="user-questions-delivery-detail">{form.delivery.reason}</p>}{form.delivery?.state === "paused" && <ChatButton variant="primary" disabled={blocked} onClick={() => void questions.mutate(form.id, "resume")}>Resume delivery</ChatButton>}</ChatNotice></ChatCardBody>}
    {presented && <div id={`user-questions-${form.id}-editor`} hidden={!expanded} onFocusCapture={() => { focused.current = true; }} onBlurCapture={event => { if (event.relatedTarget instanceof Node) focused.current = event.currentTarget.contains(event.relatedTarget); }}>
      <QuestionsEditor key={`${questions.scopeKey}:${form.id}`} questions={questions} draft={draft} page={pageIndex} navigation={navigation} active={active} />
    </div>}
    </div>
    {active && view && createPortal(<ChatDialog title={view === "dismiss" ? "Dismiss questions?" : view === "tool" ? "Question tool details" : view === "details" ? "Questionnaire details" : form.status === "submitted" ? "Submitted answers" : "Questions"} subtitle={form.input.title} size="wide" close={() => setView(null)} restoreFocus={() => trigger.current}>
      <ChatDialogBody>
        {view === "dismiss" ? <p>No answers will be sent. Your normal chat remains available.</p> : view === "tool" && tool ? <QuestionToolDetails tool={tool} /> : view === "answers" ? <><DeliveryStatus form={form} /><AnswerRecord form={form} answers={form.submission?.answers ?? form.answers} /></> : <>
          <DeliveryStatus form={form} />
          <dl className="facts">{[["Questionnaire ID", form.id], ["Form state", form.status], ["Revision", String(form.revision)], ["Delivery state", form.delivery?.state ?? "Not submitted"], ["Delivery diagnostic", form.delivery?.reason ?? "None"], ["Delivery run", form.delivery?.runId ?? "Unavailable"], ["Original run", form.anchor.runId], ["Original tool call", form.anchor.toolCallId], ["Created", new Date(form.createdAt).toLocaleString()]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        </>}
      </ChatDialogBody>
      {view === "dismiss" && <ChatDialogFooter><ChatButton onClick={() => setView(null)}>Keep answering</ChatButton><ChatButton variant="danger" disabled={blocked || !presented} onClick={() => { setView(null); void questions.mutate(form.id, "dismiss"); }}>Dismiss questions</ChatButton></ChatDialogFooter>}
    </ChatDialog>, document.body)}
  </ChatCard>
    {hasReferences && references && <footer className="user-questions-references-footer" onFocusCapture={() => { focused.current = true; }} onBlurCapture={event => { if (event.relatedTarget instanceof Node) focused.current = event.currentTarget.contains(event.relatedTarget); }}>
      <ChatDisclosure key={`${form.id}:${pageIndex}-references`} className="user-questions-references-disclosure" headingLevel={5} title={`References · ${references.length}`}>
        <ul className="user-questions-references">{references.map(reference => <li key={reference}><QuestionLink href={reference} form={form}>{reference}</QuestionLink></li>)}</ul>
      </ChatDisclosure>
    </footer>}
  </>;
}

export function UserQuestionsActivity({ questions, close, disabled = false }: { questions: UserQuestionsController; close: () => void; disabled?: boolean }) {
  const attention = questions.forms.filter(questionsNeedAttention);
  const pending = questions.forms.filter(draft => draft.form.status === "presented");
  const candidates = [...attention, ...pending.filter(draft => !attention.includes(draft))];
  if (!candidates.length) return null;
  return <section className="user-questions-activity" aria-label="Questionnaires"><h3>Questionnaires</h3><ul>{candidates.map(draft => <li key={draft.form.id}><span><strong>{draft.form.input.title}</strong><span className="muted">{draft.form.status === "presented" ? `Awaiting answers · ${questionsStatus(draft)}` : `${draft.form.status === "submitted" ? "Submitted" : "Dismissed"} · ${questionsStatus(draft)}`}</span></span><ChatButton variant="ghost" icon={<FiArrowRight />} disabled={disabled} onClick={() => { close(); questions.open(draft.form.id); }}>Go to questions</ChatButton></li>)}</ul></section>;
}

/** Compact transcript projection only; the delivered prompt is left untouched. */
export function UserQuestionsResponse({ questions, draft, message, active = true, disabled = false }: {
  questions: UserQuestionsController; draft: UserQuestionsDraft; message: Message; active?: boolean; disabled?: boolean;
}) {
  const { form } = draft;
  const [original, setOriginal] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { if (!active) setOriginal(false); }, [active]);
  const raw = message.parts.filter(part => part.type === "text").map(part => part.text).join("\n\n");
  const status = `Submitted answers · ${questionsStatus(draft)}`;
  return <ChatCard density="compact" className="user-questions-card user-questions-response" aria-label={`Submitted questionnaire answers: ${form.input.title}`}>
    <ChatCardHeader className="user-questions-header" icon={<FiCheck size={28} />} title={<span title={form.input.title}>{form.input.title}</span>} description={<span title={status}>{status}</span>}
      actions={<>
        <ChatButton variant="ghost" disabled={disabled} onClick={() => questions.open(form.id)}>Go to questions</ChatButton>
        <ChatOverflowMenu label="Submitted answer actions" items={[{ id: "original", label: "View original message", icon: <FiInfo />, opensDialog: true, onSelect: button => { trigger.current = button; setOriginal(true); } }]} />
      </>} />
    {active && original && createPortal(<ChatDialog title="Original answer message" subtitle={form.input.title} size="wide" close={() => setOriginal(false)} restoreFocus={() => trigger.current}><ChatDialogBody><pre className="user-questions-tool-detail">{raw || "No text recorded"}</pre></ChatDialogBody></ChatDialog>, document.body)}
  </ChatCard>;
}

export function UserQuestionsStatus({ questions }: { questions: UserQuestionsController }) {
  return questions.error ? <ChatNotice className="user-questions-status" tone="warning" role="alert" actions={<ChatButton onClick={questions.retry}>Retry questions</ChatButton>}>Questionnaire refresh unavailable: {questions.error}</ChatNotice> : null;
}

export function PendingUserQuestions({ questions, running, tool }: { questions: UserQuestionsController; running: boolean; tool: ToolPart }) {
  return <ChatNotice className="user-questions-status" tone={tool.error || questions.error ? "warning" : "neutral"} role="status" actions={<ChatButton disabled={questions.loading} onClick={questions.retry}>Refresh questions</ChatButton>}>
    {questions.error ? "Questionnaire persistence is unconfirmed because questions could not be refreshed." : questions.loading || running ? "Waiting for the saved questionnaire…" : "No saved questionnaire is available for this call."}
    <ChatDisclosure title={tool.error ? "Tool error" : "Tool details"}><QuestionToolDetails tool={tool} /></ChatDisclosure>
  </ChatNotice>;
}
