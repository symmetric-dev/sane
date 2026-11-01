import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { AsideController } from "./aside-client";
import type { AsideRecord } from "../shared/aside-contract";
import type { UserQuestionsController, UserQuestionsDraft } from "./user-questions-client";

const time = "2026-10-31T12:00:00.000Z";
function record(): AsideRecord {
  return { version: 1, id: "aside-one", purpose: "question-explanation", lifecycle: "open", revision: 1, draft: "Can you explain Question 2", createdAt: time, updatedAt: time,
    source: { storeId: "store", sessionId: "source", rootSessionId: "source", native: { harness: "oc", authorityId: "authority", nativeId: "native" }, binding: { workspaceId: "workspace", worktreeId: "worktree", bindingRevision: "binding", cwd: "/repo" }, capturedAt: time,
      transcript: { kind: "app-transcript", epoch: "epoch", revision: "revision", messages: [], totalMessages: 0, boundaryMessageId: null, fingerprint: "fingerprint" },
      question: { formId: "form", formRevision: 1, questionIndex: 1, question: { question: "Second question?", context: "Second context" }, anchor: { runId: "run", toolCallId: "tool", messageId: "message", invocationId: "tool", wrapper: null } } } };
}
function questionnaire(): UserQuestionsDraft {
  return { form: { version: 1, id: "form", sessionId: "source", native: { harness: "oc", authorityId: "authority", nativeId: "native" }, anchor: { runId: "run", toolCallId: "tool", messageId: "message", invocationId: "tool", wrapper: null }, workspaceId: "workspace", worktreeId: "worktree", bindingRevision: "binding", cwd: "/repo", createdAt: time, input: { title: "Original questionnaire", pages: [{ question: "First question?", context: "First context" }, { question: "Second question?", context: "Second context" }] }, revision: 1, answers: ["untouched first", "untouched second"], status: "presented", submission: null, delivery: null, dismissal: null }, answers: ["untouched first", "untouched second"], dirty: false, edit: 0, conflict: false, error: "" };
}
type Fixture = { controller: AsideController; calls: unknown[][]; questions: UserQuestionsController; host: HTMLDivElement; render: () => Promise<void>; setScope: (scope: string, active?: boolean) => Promise<void>; click: (label: string) => Promise<HTMLButtonElement>; button: (label: string) => HTMLButtonElement; input: (text: string) => Promise<void> };
async function fixture(run: (value: Fixture) => Promise<void>) {
  const browser = new Window({ url: "http://localhost" });
  const globals = { window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage, sessionStorage: browser.sessionStorage, HTMLElement: browser.HTMLElement, HTMLButtonElement: browser.HTMLButtonElement, Node: browser.Node, Event: browser.Event, CustomEvent: browser.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  browser.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  browser.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  const { createRoot } = await import("react-dom/client");
  const { AsidePanel, AsidesLauncher, useAsidePresentation } = await import("./aside-panel");
  const { UserQuestionsCard } = await import("./user-questions");
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host), calls: unknown[][] = [];
  let scope = "source:binding", active = true;
  const form = questionnaire();
  const questions = { scopeKey: "source", forms: [form], selected: form, expanded: true, canClose: false, editable: true, loading: false, error: "", revealRequest: undefined,
    open: () => {}, toggle: () => {}, close: () => {}, edit: (...args: unknown[]) => { calls.push(["answer", ...args]); }, mutate: (...args: unknown[]) => { calls.push(["question-mutate", ...args]); }, reconcile: () => {}, reload: () => {}, retry: () => {} } as UserQuestionsController;
  const initial = record();
  const controller: AsideController = { scopeKey: "source", asides: [{ id: initial.id, sourceSessionId: "source", rootSessionId: "source", purpose: initial.purpose, lifecycle: "open", revision: 1, question: { formId: "form", questionIndex: 1 }, createdAt: time, updatedAt: time }], selected: { record: initial, text: initial.draft, dirty: false, conflict: false, error: "" }, loading: false, error: "", enabled: true, canCreate: true, creating: false,
    create: async (target, text) => { calls.push(["create", target, text]); return initial.id; }, retryCreate: async () => { calls.push(["retry-create"]); return initial.id; }, open: async id => { calls.push(["open", id]); },
    edit: (id, text) => { calls.push(["edit", id, text]); controller.selected = { ...controller.selected!, text, dirty: true }; rerender(); },
    save: async id => { calls.push(["save", id, controller.selected!.text]); controller.selected = { ...controller.selected!, dirty: false }; rerender(); },
    setLifecycle: async (id, lifecycle) => { calls.push(["lifecycle", id, lifecycle]); controller.selected = { ...controller.selected!, record: { ...controller.selected!.record, lifecycle } }; rerender(); }, refresh: async () => { calls.push(["refresh"]); }, reconcile: async id => { calls.push(["reconcile", id]); }, reload: async id => { calls.push(["reload", id]); } };
  function Harness() {
    const presentation = useAsidePresentation(controller, scope, active);
    return <div className="thread"><AsidesLauncher controller={controller} presentation={presentation} /><div className="viewport"><UserQuestionsCard questions={questions} draft={form} onExplain={presentation.explain} explainDisabled={!controller.canCreate || controller.creating || !!controller.pendingCreate?.uncertain} /></div><AsidePanel controller={controller} presentation={presentation} /></div>;
  }
  const rerender = () => root.render(<Harness />);
  const render = async () => { await act(async () => rerender()); };
  const button = (label: string) => {
    const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(element => element.textContent === label || element.getAttribute("aria-label") === label);
    expect(found, label).toBeDefined(); return found!;
  };
  const click = async (label: string) => { const found = button(label); await act(async () => found.click()); return found; };
  try {
    await render();
    await run({ controller, calls, questions, host, render, button, click, setScope: async (next, nextActive = true) => { scope = next; active = nextActive; await render(); }, input: async text => {
      const textarea = document.querySelector<HTMLTextAreaElement>(".aside-editor textarea")!;
      await act(async () => { Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
    } });
  } finally {
    await act(async () => root.unmount()); browser.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}

test("Explain targets the expanded current page and presets only the editable user draft; Send never executes", async () => {
  const originalFetch = globalThis.fetch;
  const modelRequests: unknown[] = [];
  globalThis.fetch = (async (...args: unknown[]) => { modelRequests.push(args); throw new Error("Unexpected model request"); }) as unknown as typeof fetch;
  try { await fixture(async ({ click, calls, button }) => {
    await click("Next question"); await click("Explain");
    expect(calls).toEqual([["create", { kind: "question", formId: "form", questionIndex: 1 }, "Can you explain Question 2"]]);
    expect(document.querySelector<HTMLTextAreaElement>(".aside-editor textarea")!.value).toBe("Can you explain Question 2");
    expect(button("Send").disabled).toBe(true); await click("Send");
    expect(calls).toHaveLength(1);
    expect(modelRequests).toEqual([]);
    expect(document.querySelector("dialog")!.textContent).toContain("context provider not connected");
    expect(document.querySelector(".user-questions-card")).not.toBeNull();
  }); } finally { globalThis.fetch = originalFetch; }
});

test("draft editing, explicit save and clearing preserve the empty string", async () => {
  await fixture(async ({ click, input, calls, controller, button }) => {
    await click("Asides (1)"); await input("my local draft");
    expect(controller.selected!.text).toBe("my local draft"); expect(button("Save draft").disabled).toBe(false);
    expect(calls.filter(call => call[0] === "save")).toHaveLength(0);
    await click("Save draft"); expect(calls.at(-1)).toEqual(["save", "aside-one", "my local draft"]);
    await click("Clear draft"); expect(controller.selected!.text).toBe("");
    await click("Save draft"); expect(calls.at(-1)).toEqual(["save", "aside-one", ""]);
  });
});

test("lifecycle changes require confirmation; archived is read-only and discarded is terminal", async () => {
  await fixture(async ({ click, calls }) => {
    await click("Asides (1)"); await click("Archive…");
    expect(calls).toEqual([]); expect(document.querySelector("dialog")!.textContent).toContain("retained record, not deletion");
    await click("Confirm archive"); expect(calls.at(-1)).toEqual(["lifecycle", "aside-one", "archived"]);
    expect(document.querySelector<HTMLTextAreaElement>(".aside-editor textarea")!.readOnly).toBe(true);
    await click("Reopen…"); await click("Confirm reopen");
    expect(document.querySelector<HTMLTextAreaElement>(".aside-editor textarea")!.readOnly).toBe(false);
    await click("Discard…"); await click("Confirm discard");
    expect(document.querySelector(".aside-editor")!.textContent).not.toContain("Reopen…");
    expect(document.querySelector<HTMLTextAreaElement>(".aside-editor textarea")!.readOnly).toBe(true);
  });
});

test("close restores the exact questionnaire page, answer, focus and bounded scrolls without dropping dirty edits", async () => {
  await fixture(async ({ click, input, controller, questions, calls }) => {
    await click("Next question");
    const viewport = document.querySelector<HTMLElement>(".viewport")!, content = document.querySelector<HTMLElement>(".user-questions-content")!, context = document.querySelector<HTMLElement>(".user-questions-context")!;
    viewport.scrollTop = 123; content.scrollTop = 45; context.scrollTop = 67;
    const trigger = await click("Explain"); await input("unsaved aside");
    viewport.scrollTop = 0; content.scrollTop = 0; context.scrollTop = 0;
    await click("Back to questionnaire / close");
    expect([viewport.scrollTop, content.scrollTop, context.scrollTop]).toEqual([123, 45, 67]);
    expect(document.activeElement).toBe(trigger);
    expect(document.querySelector("fieldset")!.dataset.questionPage).toBe("1");
    expect(questions.selected!.answers).toEqual(["untouched first", "untouched second"]);
    expect(questions.expanded).toBe(true); expect(controller.selected!.text).toBe("unsaved aside");
    expect(calls.some(call => call[0] === "question-mutate" || call[0] === "answer")).toBe(false);
    await click("Asides (1)"); expect(document.querySelector<HTMLTextAreaElement>(".aside-editor textarea")!.value).toBe("unsaved aside");
  });
});

test("source or view changes close without restoring an old view's scroll", async () => {
  await fixture(async ({ click, setScope }) => {
    const viewport = document.querySelector<HTMLElement>(".viewport")!; viewport.scrollTop = 123;
    await click("Explain"); viewport.scrollTop = 10;
    await setScope("other-binding");
    expect(document.querySelector("dialog")).toBeNull(); expect(viewport.scrollTop).toBe(10);
    await click("Explain"); viewport.scrollTop = 22;
    await setScope("other-binding", false);
    expect(document.querySelector("dialog")).toBeNull(); expect(viewport.scrollTop).toBe(22);
  });
});

test("return focus falls back to the current question fieldset when the Explain trigger disappears", async () => {
  await fixture(async ({ click }) => {
    await click("Next question"); const trigger = await click("Explain");
    trigger.remove(); await click("Back to questionnaire / close");
    expect(document.activeElement).toBe(document.querySelector("fieldset[data-question-page='1']"));
  });
});

test("closing an uncertain creation skips the connected disabled Explain trigger and preserves questionnaire scroll/page", async () => {
  await fixture(async ({ click, controller, render }) => {
    await click("Next question");
    const viewport = document.querySelector<HTMLElement>(".viewport")!, content = document.querySelector<HTMLElement>(".user-questions-content")!, context = document.querySelector<HTMLElement>(".user-questions-context")!;
    viewport.scrollTop = 123; content.scrollTop = 45; context.scrollTop = 67;
    const trigger = await click("Explain");
    controller.pendingCreate = { requestId: "original", target: { kind: "question", formId: "form", questionIndex: 1 }, draft: "Can you explain Question 2", uncertain: true, error: "Lost response" };
    await render();
    expect(trigger.isConnected).toBe(true); expect(trigger.disabled).toBe(true);
    viewport.scrollTop = 0; content.scrollTop = 0; context.scrollTop = 0;
    await click("Back to questionnaire / close");
    const fieldset = document.querySelector<HTMLElement>("fieldset[data-question-page='1']")!;
    expect(document.activeElement).toBe(fieldset);
    expect([viewport.scrollTop, content.scrollTop, context.scrollTop]).toEqual([123, 45, 67]);
    expect(fieldset.dataset.questionPage).toBe("1");
  });
});

test("return focus skips hidden and inert Explain triggers", async () => {
  for (const attribute of ["hidden", "inert"]) {
    await fixture(async ({ click }) => {
      const trigger = await click("Explain"); trigger.setAttribute(attribute, "");
      await click("Back to questionnaire / close");
      expect(document.activeElement).toBe(document.querySelector("fieldset[data-question-page='0']"));
    });
  }
});

test("Explain is exposed only for the expanded current question", async () => {
  await fixture(async ({ questions, render, click }) => {
    questions.expanded = false; await render();
    expect([...document.querySelectorAll("button")].some(button => button.textContent === "Explain")).toBe(false);
    questions.expanded = true; await render(); await click("Explain");
    expect(document.querySelector("dialog")).not.toBeNull();
  });
});

test("conflicts retain local text and require explicit reload confirmation; uncertain operations retry the original", async () => {
  await fixture(async ({ click, controller, render, calls, button }) => {
    controller.selected = { ...controller.selected!, text: "local preserved", dirty: true, conflict: true };
    await render(); await click("Asides (1)");
    expect(button("Save draft").disabled).toBe(true);
    await click("Reload server draft…"); expect(calls).toEqual([]);
    await click("Confirm reload"); expect(calls).toEqual([["reload", "aside-one"]]); expect(controller.selected!.text).toBe("local preserved");
    controller.selected = { ...controller.selected!, conflict: false, operation: { kind: "draft", uncertain: true } }; await render();
    await click("Retry original save"); expect(calls.at(-1)).toEqual(["reconcile", "aside-one"]);
    expect(button("Save draft").disabled).toBe(true);
    controller.pendingCreate = { requestId: "original", target: { kind: "question", formId: "form", questionIndex: 1 }, draft: "original draft", uncertain: true, error: "Lost response" }; await render();
    expect(button("New aside").disabled).toBe(true); await click("Retry original creation"); expect(calls.at(-1)).toEqual(["retry-create"]);
  });
});

test("history opens independently of creation permission and no unavailable creation is attempted", async () => {
  await fixture(async ({ click, controller, render, button, calls }) => {
    controller.canCreate = false; await render(); await click("Asides (1)");
    expect(button("New aside").disabled).toBe(true);
    const saved = document.querySelector<HTMLButtonElement>(".aside-list button")!;
    await act(async () => saved.click()); expect(calls).toEqual([["open", "aside-one"]]);
    await click("Back to questionnaire / close"); await click("Explain");
    expect(calls).toHaveLength(1); expect(document.querySelector("dialog")).toBeNull();
  });
});

test("uncertain creation can retry its original request without current create permission", async () => {
  await fixture(async ({ click, controller, render, button, calls }) => {
    controller.canCreate = false;
    controller.pendingCreate = { requestId: "original", target: { kind: "conversation" }, draft: "recoverable draft", uncertain: true, error: "Lost response" };
    await render(); await click("Asides (1)");
    expect(button("New aside").disabled).toBe(true);
    expect(button("Retry original creation").disabled).toBe(false);
    await click("Retry original creation"); expect(calls).toEqual([["retry-create"]]);
    controller.enabled = false; await render();
    expect(button("Retry original creation").disabled).toBe(true);
  });
});

test("a definite create rejection allows new Explain and New aside intents", async () => {
  await fixture(async ({ click, controller, render, button, calls }) => {
    controller.pendingCreate = { requestId: "rejected", target: { kind: "conversation" }, draft: "rejected draft", uncertain: false, error: "Source rejected" };
    await render();
    expect(button("Explain").disabled).toBe(false);
    await click("Explain");
    expect(calls).toEqual([["create", { kind: "question", formId: "form", questionIndex: 0 }, "Can you explain Question 1"]]);
    expect(button("New aside").disabled).toBe(false);
    await click("New aside"); expect(calls.at(-1)).toEqual(["create", { kind: "conversation" }, ""]);
    controller.creating = true; await render();
    expect(button("New aside").disabled).toBe(true);
    expect(button("Retry original creation").disabled).toBe(true);
    await click("Back to questionnaire / close"); expect(button("Explain").disabled).toBe(true);
  });
});
