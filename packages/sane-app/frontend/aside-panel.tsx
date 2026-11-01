import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ASIDE_LIMITS, type AsideLifecycle, type AsideTarget } from "../shared/aside-contract";
import type { AsideController } from "./aside-client";
import { captureAsideParentReturn, openAsideConversation, type OpenAsideConversationInput } from "./aside-navigation";
import { catalog } from "./catalog";
import { store } from "./store";
import { ChatButton, ChatDialog, ChatDialogBody, ChatDialogFooter, ChatDisclosure, ChatNotice } from "./chat-ui";
import "./aside.css";

export type ExplainQuestion = (target: Extract<AsideTarget, { kind: "question" }>, draft: string, trigger: HTMLButtonElement) => void;
type Origin = { scope: string; trigger: HTMLButtonElement; card: HTMLElement | null; scroll: { element: HTMLElement; top: number; left: number }[] };

function availableReturnTarget(element: HTMLElement): boolean {
  if (!element.isConnected || element.matches(":disabled") || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    const style = window.getComputedStyle(ancestor);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
  }
  return true;
}

/** Presentation identity includes the current binding, not just the durable source ID. */
export function useAsidePresentation(controller: AsideController, scope: string, active: boolean) {
  const [view, setView] = useState<{ scope: string; mode: "manage" } | null>(null);
  const [attempt, setAttempt] = useState<{ scope: string; opening: boolean; error: string; input?: OpenAsideConversationInput; creating?: boolean } | null>(null);
  const origin = useRef<Origin | null>(null);
  const request = useRef(0);
  const current = useRef({ scope, active, controller, view, attempt });
  current.current = { scope, active, controller, view, attempt };
  const opened = active && view?.scope === scope;
  const mode = opened ? view.mode : null;
  useLayoutEffect(() => {
    if (!active || view && view.scope !== scope || attempt && attempt.scope !== scope) {
      ++request.current;
      origin.current = null;
      setView(null);
      setAttempt(null);
    }
  }, [active, scope, view, attempt]);
  useLayoutEffect(() => () => { ++request.current; origin.current = null; }, []);
  useLayoutEffect(() => {
    if (!controller.enabled && attempt?.opening) { ++request.current; setAttempt(null); }
  }, [controller.enabled, attempt?.opening]);
  const captureOrigin = useCallback((trigger: HTMLButtonElement, sourceViewport?: HTMLElement | null) => {
    // Management dialogs keep the original source return point.
    if (current.current.view?.scope === scope && origin.current?.scope === scope) return;
    captureAsideParentReturn();
    const viewport = sourceViewport ?? trigger.closest<HTMLElement>(".viewport") ?? trigger.closest(".thread")?.querySelector<HTMLElement>(".viewport");
    const card = trigger.closest<HTMLElement>(".user-questions-card") ?? viewport?.querySelector<HTMLElement>('.user-questions-card[data-expanded="true"]') ?? null;
    const elements = new Set<HTMLElement>([...(viewport ? [viewport] : []), ...Array.from(card?.querySelectorAll<HTMLElement>(".user-questions-content, .user-questions-context") ?? [])]);
    origin.current = { scope, trigger, card, scroll: [...elements].map(element => ({ element, top: element.scrollTop, left: element.scrollLeft })) };
  }, [scope]);
  const launch = useCallback((trigger: HTMLButtonElement, sourceViewport?: HTMLElement | null) => {
    if (!active || !current.current.active || current.current.scope !== scope) return;
    captureOrigin(trigger, sourceViewport);
    ++request.current;
    setAttempt(null);
    setView({ scope, mode: "manage" });
  }, [active, scope, captureOrigin]);
  const fence = useCallback((serial: number) => {
    const storeCurrent = store.conversationNavigationFence(), navigation = catalog.snapshot().navigation;
    const controllerScope = current.current.controller.scopeKey;
    return () => request.current === serial && current.current.active && current.current.scope === scope
      && current.current.controller.scopeKey === controllerScope && current.current.controller.enabled
      && storeCurrent() && catalog.snapshot().navigation === navigation;
  }, [scope]);
  const open = useCallback(async (input: OpenAsideConversationInput, valid: () => boolean) => {
    if (!valid()) return;
    setAttempt({ scope, input, opening: true, error: "" });
    try {
      const opened = await openAsideConversation(input, { current: valid, captureReturn: false });
      if (!valid()) return;
      setAttempt({ scope, input, opening: false, error: opened ? "" : "Opening was cancelled because the source view changed. Retry when ready." });
      if (opened) setView(null);
    } catch (error) {
      if (valid()) setAttempt({ scope, input, opening: false, error: error instanceof Error ? error.message : "Aside conversation could not be opened. Nothing was sent." });
    } finally {
      if (current.current.scope === scope) setAttempt(previous => previous?.input === input ? { ...previous, opening: false } : previous);
    }
  }, [scope]);
  const completeCreation = useCallback(async (creation: Promise<string | undefined>, valid: () => boolean, text?: string) => {
    const serial = request.current;
    const id = await creation;
    if (!valid()) {
      if (current.current.scope === scope && request.current === serial) setAttempt(null);
      return id;
    }
    if (!id) { setAttempt({ scope, opening: false, creating: true, error: "Aside creation was not confirmed. Retry the original creation request." }); return; }
    const state = store.snapshot();
    if (!state.config?.storeId || !state.selected) return;
    await open({ storeId: state.config.storeId, sourceSessionId: state.selected, asideId: id, ...(text !== undefined ? { draft: text } : {}) }, valid);
    return id;
  }, [scope, open]);
  const explain: ExplainQuestion = useCallback((target, text, trigger) => {
    const latest = current.current;
    if (!active || !latest.active || latest.scope !== scope || latest.attempt?.opening || !latest.controller.canCreate || latest.controller.creating || latest.controller.pendingCreate && (latest.controller.pendingCreate.uncertain || !latest.controller.pendingCreate.error)) return;
    captureOrigin(trigger);
    const serial = ++request.current;
    const valid = fence(serial);
    // Explain is ordinary navigation with inline progress, never a manager/chat shell.
    setView(null);
    setAttempt({ scope, opening: true, creating: true, error: "" });
    void completeCreation(latest.controller.create(target, text), valid, text);
  }, [active, scope, captureOrigin, completeCreation, fence]);
  const retryCreate = useCallback(async () => {
    const latest = current.current;
    if (!latest.active || latest.scope !== scope || !latest.controller.enabled || latest.controller.creating || !latest.controller.pendingCreate) return;
    if (!origin.current || origin.current.scope !== scope) captureAsideParentReturn();
    const serial = ++request.current;
    const valid = fence(serial), text = latest.controller.pendingCreate.draft;
    setAttempt({ scope, opening: true, creating: true, error: "" });
    return completeCreation(latest.controller.retryCreate(), valid, text);
  }, [scope, completeCreation, fence]);
  const showChat = useCallback((id: string) => {
    const latest = current.current;
    if (!latest.active || latest.scope !== scope || !latest.controller.enabled) return;
    if (!origin.current || origin.current.scope !== scope) captureAsideParentReturn();
    const state = store.snapshot(), selected = latest.controller.selected;
    if (!state.config?.storeId || !state.selected) return;
    const serial = ++request.current;
    setView(null);
    void open({ storeId: state.config.storeId, sourceSessionId: state.selected, asideId: id,
      ...(selected?.record.id === id ? { sourceFingerprint: selected.record.source.transcript.fingerprint, draft: selected.text } : {}) }, fence(serial));
  }, [scope, open, fence]);
  const retryOpen = useCallback(() => {
    const latest = current.current, input = latest.attempt?.input;
    if (!input || !latest.active || latest.scope !== scope || !latest.controller.enabled || latest.attempt?.opening) return;
    const serial = ++request.current;
    void open(input, fence(serial));
  }, [scope, open, fence]);
  const close = useCallback(() => { ++request.current; setView(null); setAttempt(null); }, []);
  const restoreFocus = useCallback(() => {
    const previous = origin.current;
    if (previous && current.current.active && previous.scope === current.current.scope) {
      const fieldset = previous.card?.querySelector<HTMLElement>("fieldset[data-question-page]");
      const target = [previous.trigger, fieldset, previous.card].find((element): element is HTMLElement => !!element && availableReturnTarget(element));
      if (target) for (const { element, top, left } of previous.scroll) if (element.isConnected) { element.scrollTop = top; element.scrollLeft = left; }
      target?.focus({ preventScroll: true });
      if (target) return target;
    }
    // ShellDialog otherwise falls back to its previous focus, which may now
    // belong to another source/view. A detached target deliberately suppresses it.
    return document.createElement("span");
  }, []);
  const launchAttempt = active && attempt?.scope === scope ? attempt : null;
  const error = launchAttempt?.creating ? controller.pendingCreate?.error || launchAttempt.error : launchAttempt?.error || "";
  return { opened: !!opened, mode, launch, explain, showChat, retryCreate, retryOpen: launchAttempt?.input ? retryOpen : undefined, close, restoreFocus,
    opening: !!launchAttempt?.opening, error };
}
export type AsidePresentation = ReturnType<typeof useAsidePresentation>;

/** Small launch notice only. The regular Thread owns all child messages/input. */
export function AsideLaunchStatus({ controller, presentation }: { controller: AsideController; presentation: AsidePresentation }) {
  const error = presentation.error || controller.pendingCreate?.error;
  if (!presentation.opening && !error && !controller.pendingCreate) return null;
  return <ChatNotice role={error ? "alert" : "status"} tone={error ? "danger" : undefined}>
    {presentation.opening || controller.creating ? controller.creating ? "Creating aside…" : "Opening aside conversation…" : error || "An original aside creation request is retained. Retry it to reconcile the outcome."}
    {!presentation.opening && controller.pendingCreate && <ChatButton disabled={!controller.enabled || controller.creating} onClick={() => void presentation.retryCreate()}>Retry original creation</ChatButton>}
    {!presentation.opening && !controller.pendingCreate && presentation.retryOpen && <ChatButton disabled={!controller.enabled} onClick={presentation.retryOpen}>Retry opening</ChatButton>}
    {!presentation.opening && !controller.pendingCreate && <ChatButton variant="ghost" onClick={presentation.close}>Dismiss</ChatButton>}
  </ChatNotice>;
}

export function AsidesLauncher({ controller, presentation, disabled = false }: { controller: AsideController; presentation: AsidePresentation; disabled?: boolean }) {
  return <ChatButton variant="ghost" disabled={disabled} onClick={event => presentation.launch(event.currentTarget)}>Asides ({controller.asides.length})</ChatButton>;
}

/** No execution handler exists here: saved drafts are not model requests. */
export function AsidePanel({ controller, presentation }: { controller: AsideController; presentation: AsidePresentation }) {
  const [confirm, setConfirm] = useState<{ id: string; action: AsideLifecycle | "reload" } | null>(null);
  const selected = controller.selected;
  useLayoutEffect(() => setConfirm(null), [selected?.record.id, presentation.opened]);
  if (presentation.mode !== "manage") return null;
  const draft = selected, record = draft?.record;
  const busy = !!draft?.operation;
  const editable = controller.enabled && record?.lifecycle === "open" && !busy && !draft?.conflict;
  const changeLifecycle = (action: AsideLifecycle) => { if (record) setConfirm({ id: record.id, action }); };
  const confirmAction = async () => {
    if (!confirm || confirm.id !== record?.id) return;
    const action = confirm; setConfirm(null);
    if (action.action === "reload") await controller.reload(action.id);
    else await controller.setLifecycle(action.id, action.action);
  };
  return createPortal(<ChatDialog title="Asides" subtitle="Separate saved drafts · main conversation unchanged" size="wide" className="aside-panel" close={presentation.close} restoreFocus={presentation.restoreFocus}>
    <ChatDialogBody>
      <ChatNotice role="status">Manage saved asides here. Choose Open chat to continue a separate conversation; opening it does not send a message.</ChatNotice>
      {!controller.enabled && <ChatNotice>Connection unavailable. Saved local drafts remain here.</ChatNotice>}
      <div className="aside-panel-actions"><ChatButton disabled={!controller.enabled || controller.loading} onClick={() => void controller.refresh()}>Refresh asides</ChatButton><ChatButton disabled={!controller.canCreate || controller.creating || controller.pendingCreate?.uncertain} onClick={() => void controller.create({ kind: "conversation" }, "")}>New aside</ChatButton></div>
      {controller.loading && <p role="status">Loading asides…</p>}
      {controller.error && <ChatNotice tone="danger" role="alert">{controller.error}<ChatButton disabled={!controller.enabled} onClick={() => void controller.refresh()}>Retry refresh</ChatButton></ChatNotice>}
      {controller.pendingCreate && <ChatNotice tone="warning" role="status"><p>{controller.pendingCreate.uncertain ? "Creation unconfirmed. Retry only the original request." : controller.creating ? "Creating aside…" : controller.pendingCreate.error ? "Creation rejected. You may retry the original request or start a new aside." : "Aside creation pending."}</p><pre className="aside-local-text">{controller.pendingCreate.draft || "Empty draft"}</pre>{controller.pendingCreate.error && <p>{controller.pendingCreate.error}</p>}<ChatButton disabled={!controller.enabled || controller.creating} onClick={() => void controller.retryCreate()}>Retry original creation</ChatButton></ChatNotice>}
      <div className="aside-panel-layout"><nav className="aside-list" aria-label="Saved asides">
        {!controller.asides.length && !controller.loading && <p className="muted">No saved asides.</p>}
        {controller.asides.map(aside => <ChatButton key={aside.id} variant="ghost" aria-current={record?.id === aside.id ? "true" : undefined} disabled={!controller.enabled} onClick={() => void controller.open(aside.id)}><span>{aside.question ? `Question ${aside.question.questionIndex + 1}` : "Conversation aside"}<small>{aside.lifecycle} · {new Date(aside.createdAt).toLocaleString()}</small></span></ChatButton>)}
      </nav><section className="aside-editor" aria-label="Aside draft">
        {draft && record ? <>
           <h3>{record.source.question ? `Question ${record.source.question.questionIndex + 1} aside` : "Conversation aside"}</h3>
           <ChatButton disabled={!controller.enabled || busy} onClick={() => presentation.showChat(record.id)}>Open chat</ChatButton>
          <p className="muted">{record.lifecycle} · Source captured <time dateTime={record.source.capturedAt}>{new Date(record.source.capturedAt).toLocaleString()}</time></p>
          {record.source.question && <ChatDisclosure title="Source question snapshot"><p>{record.source.question.question.question}</p>{record.source.question.question.context && <pre className="aside-local-text">{record.source.question.question.context}</pre>}{record.source.question.question.options && <ul>{record.source.question.question.options.map((option, index) => <li key={index}>{option}</li>)}</ul>}</ChatDisclosure>}
          {record.lifecycle !== "open" && <ChatNotice>{record.lifecycle === "archived" ? "Archived: read-only until reopened." : "Discarded: terminal retained record, not deletion."}</ChatNotice>}
          <label htmlFor={`aside-draft-${record.id}`}>Your aside draft</label>
          <textarea id={`aside-draft-${record.id}`} rows={7} maxLength={ASIDE_LIMITS.draftChars * 2} value={draft.text} readOnly={!editable} onChange={event => controller.edit(record.id, Array.from(event.currentTarget.value).slice(0, ASIDE_LIMITS.draftChars).join(""))} />
          <p className="muted" role="status">{draft.dirty ? "Local changes kept. Save explicitly when ready." : "Draft saved."} Closing does not discard local edits.</p>
          {draft.error && <ChatNotice tone="danger" role="alert">{draft.error}</ChatNotice>}
          {draft.conflict && <ChatNotice tone="warning"><p>A newer server version exists. Your local draft is preserved above; it will not overwrite the server automatically.</p><ChatDisclosure title="Server draft"><pre className="aside-local-text">{record.draft || "Empty draft"}</pre></ChatDisclosure><ChatButton disabled={!controller.enabled || busy} onClick={() => setConfirm({ id: record.id, action: "reload" })}>Reload server draft…</ChatButton></ChatNotice>}
          {draft.operation?.uncertain && <ChatButton disabled={!controller.enabled} onClick={() => void controller.reconcile(record.id)}>Retry original {draft.operation.kind === "draft" ? "save" : "lifecycle change"}</ChatButton>}
           <div className="aside-panel-actions"><ChatButton disabled={!editable || !draft.dirty} onClick={() => void controller.save(record.id)}>Save draft</ChatButton><ChatButton disabled={!editable || !draft.text} onClick={() => controller.edit(record.id, "")}>Clear draft</ChatButton></div>
          <div className="aside-panel-actions">{record.lifecycle === "open" && <ChatButton disabled={!controller.enabled || busy || draft.conflict} onClick={() => changeLifecycle("archived")}>Archive…</ChatButton>}{record.lifecycle === "archived" && <ChatButton disabled={!controller.enabled || busy || draft.conflict} onClick={() => changeLifecycle("open")}>Reopen…</ChatButton>}{record.lifecycle !== "discarded" && <ChatButton variant="danger" disabled={!controller.enabled || busy || draft.conflict} onClick={() => changeLifecycle("discarded")}>Discard…</ChatButton>}</div>
          {confirm?.id === record.id && <ChatNotice tone="warning"><p>{confirm.action === "reload" ? "Reload the server draft and discard local edits? Copy any text you want to keep first." : `${confirm.action === "open" ? "Reopen" : confirm.action === "archived" ? "Archive" : "Discard"} this aside? This is a retained record, not deletion. Local unsaved edits stay local.${confirm.action === "discarded" ? " Discarding is terminal." : ""}`}</p><ChatButton onClick={() => setConfirm(null)}>Cancel</ChatButton><ChatButton variant="danger" disabled={!controller.enabled || busy} onClick={() => void confirmAction()}>Confirm {confirm.action === "reload" ? "reload" : confirm.action === "open" ? "reopen" : confirm.action === "archived" ? "archive" : "discard"}</ChatButton></ChatNotice>}
        </> : <p className="muted">Select an aside or create a new draft.</p>}
      </section></div>
    </ChatDialogBody><ChatDialogFooter><ChatButton onClick={presentation.close}>Back to questionnaire / close</ChatButton></ChatDialogFooter>
  </ChatDialog>, document.body);
}
