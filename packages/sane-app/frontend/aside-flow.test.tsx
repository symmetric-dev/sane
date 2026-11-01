import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { rmSync } from "node:fs";
import { createAsideRoute } from "../src/aside-routes";
import { AsideService } from "../src/aside-service";
import { createAsideSourceResolver } from "../src/aside-source";
import { ids, questionFixture, sessionFixture, sourceFixture, storeFixture } from "../src/aside-fixtures";
import type { UserQuestionsController, UserQuestionsDraft } from "./user-questions-client";

test("Explain round-trips through the real scoped hook and durable APIs without submitting or replacing the questionnaire", async () => {
  const directories: string[] = [];
  const { store } = storeFixture(directories);
  const form = questionFixture();
  form.input.pages.push({ question: "Why choose an isolated discussion?", context: "Second question context" });
  form.answers = [null, "Keep this unsent answer"];
  const resolver = createAsideSourceResolver({
    storeId: ids.store, authorizeRead: () => () => {},
    authorizeSource: async () => ({ session: sessionFixture(), binding: sourceFixture().binding, assertCurrent: () => {} }),
    captureTranscript: async () => sourceFixture().transcript,
    question: () => form,
  });
  const service = new AsideService(store, resolver);
  const route = createAsideRoute({
    assertCurrent: () => {}, create: (id, input) => service.create(id, input), list: id => service.list(id),
    get: async id => service.get(id), saveDraft: async (id, input) => service.saveDraft(id, input),
    setLifecycle: async (id, input) => service.setLifecycle(id, input),
  });
  const browser = new Window({ url: "http://localhost" });
  const globals = {
    window: browser, document: browser.document, navigator: browser.navigator,
    sessionStorage: browser.sessionStorage, HTMLElement: browser.HTMLElement,
    HTMLButtonElement: browser.HTMLButtonElement, Node: browser.Node,
    Event: browser.Event, CustomEvent: browser.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  browser.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  browser.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  const originalFetch = globalThis.fetch;
  const requests: { path: string; method: string }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
    const req = new Request(url, init);
    requests.push({ path: url.pathname, method: req.method });
    const result = await route(req, url);
    if (!result) throw new Error(`Unexpected request: ${req.method} ${url.pathname}`);
    return result;
  }) as typeof fetch;
  const { createRoot } = await import("react-dom/client");
  const { useAsides } = await import("./aside-client");
  const { AsidePanel, AsidesLauncher, useAsidePresentation } = await import("./aside-panel");
  const { UserQuestionsCard } = await import("./user-questions");
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const draft: UserQuestionsDraft = { form, answers: [...form.answers], dirty: true, edit: 1, conflict: false, error: "" };
  let questionMutations = 0;
  const questions: UserQuestionsController = {
    scopeKey: "original-form-scope", forms: [draft], selected: draft, expanded: true,
    canClose: false, revealRequest: undefined, editable: true, loading: false, error: "",
    open: () => {}, toggle: () => {}, close: () => {}, edit: () => { questionMutations++; },
    mutate: async () => { questionMutations++; }, reconcile: async () => {}, reload: () => {}, retry: () => {},
  };
  function Harness() {
    const controller = useAsides({ storeId: ids.store, sessionId: ids.session }, { enabled: true, canCreate: true });
    const presentation = useAsidePresentation(controller, "original-source-and-binding", true);
    return <div className="thread"><AsidesLauncher controller={controller} presentation={presentation} /><div className="viewport"><UserQuestionsCard questions={questions} draft={draft} onExplain={presentation.explain} /></div><AsidePanel controller={controller} presentation={presentation} /></div>;
  }
  const button = (label: string) => {
    const element = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label || item.getAttribute("aria-label") === label);
    expect(element, label).toBeDefined(); return element!;
  };
  const click = async (label: string) => { const element = button(label); await act(async () => element.click()); return element; };
  try {
    await act(async () => root.render(<Harness />));
    await click("Next question");
    const viewport = document.querySelector<HTMLElement>(".viewport")!;
    viewport.scrollTop = 99;
    const trigger = await click("Explain");
    const record = store.list(ids.session)[0]!;
    expect(record.question).toEqual({ formId: form.id, questionIndex: 1 });
    expect(store.get(record.id)!.draft).toBe("Can you explain Question 2");
    expect(store.get(record.id)!.source.question!.question).toEqual(form.input.pages[1]!);
    const input = document.querySelector<HTMLTextAreaElement>(".aside-editor textarea")!;
    expect(input.value).toBe("Can you explain Question 2");
    await act(async () => {
      Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value")!.set!.call(input, "My edited aside draft");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Save draft");
    expect(store.get(record.id)!.draft).toBe("My edited aside draft");
    expect(store.get(record.id)!.revision).toBe(2);
    expect(button("Send").disabled).toBe(true);
    await click("Send");
    await click("Back to questionnaire / close");
    expect(document.activeElement).toBe(trigger);
    expect(viewport.scrollTop).toBe(99);
    expect(document.querySelector<HTMLElement>("fieldset")!.dataset.questionPage).toBe("1");
    expect(draft.answers).toEqual([null, "Keep this unsent answer"]);
    expect(questionMutations).toBe(0);
    await click("Asides (1)");
    expect(document.querySelector<HTMLTextAreaElement>(".aside-editor textarea")!.value).toBe("My edited aside draft");
    expect(requests.some(request => request.path.endsWith("/messages") || request.path.includes("/prompt") || request.path.includes("user-questions"))).toBe(false);
    expect(requests.filter(request => request.method === "POST").map(request => request.path)).toEqual([`/api/sessions/${ids.session}/asides`, `/api/asides/${record.id}/draft`]);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    browser.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  }
});
