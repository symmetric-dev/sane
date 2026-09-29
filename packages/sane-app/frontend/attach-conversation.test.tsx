import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { AttachConversation } from "./attach-conversation";
import { catalog } from "./catalog";
import { store } from "./store";

test("attachment UI submits explicit harness/ID/cwd, preserves failed input, and ignores a closed dialog's response", async () => {
  const browser = new Window({ url: "http://localhost" });
  const requests: any[] = [], responses: ReturnType<typeof Promise.withResolvers<Response>>[] = [], selected: string[] = [];
  const globals = { window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, Event: browser.Event, FormData: browser.FormData, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (path: string, init: RequestInit) => { expect(path).toBe("/api/sessions/attach"); requests.push(JSON.parse(String(init.body))); const response = Promise.withResolvers<Response>(); responses.push(response); return response.promise; } };
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let root: Root | undefined;
  try {
    const { createRoot } = await import("react-dom/client"), host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(<AttachConversation onChoose={id => selected.push(id)} />));
    await act(async () => host.querySelector("button")!.click());
    const form = host.querySelector("form")!, id = form.elements.namedItem("nativeSessionId") as HTMLInputElement, cwd = form.elements.namedItem("cwd") as HTMLInputElement;
    id.value = "ses_existing"; cwd.value = "/fixture/repo";
    const submit = () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await act(async () => { submit(); });
    expect(requests[0]).toEqual({ harness: "opencode", nativeSessionId: "ses_existing", cwd: "/fixture/repo" });
    await act(async () => responses[0]!.resolve(Response.json({ error: "Native conversation is already attached" }, { status: 409 })));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("already attached"); expect(id.value).toBe("ses_existing"); expect(selected).toEqual([]);
    const harness = host.querySelector("select")!;
    await act(async () => { harness.value = "claude-code"; harness.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(host.textContent).toContain("Claude activity is unknown");
    id.value = "a952cf6e-e26b-441d-aad4-a659042f81ea";
    await act(async () => { submit(); });
    expect(requests[1].harness).toBe("claude-code");
    await act(async () => host.querySelector("dialog")!.dispatchEvent(new Event("cancel", { bubbles: true, cancelable: true })));
    await act(async () => responses[1]!.resolve(Response.json({ sessionId: id.value }, { status: 201 })));
    expect(selected).toEqual([]); expect(host.querySelector("dialog")).toBeNull(); expect(requests).toHaveLength(2);
  } finally { if (root) await act(async () => root!.unmount()); browser.close(); for (const [key, descriptor] of prior) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } }
});

test("successful attachment survives false/throwing catalog refresh; opening retry never repeats attachment POST", async () => {
  const browser = new Window({ url: "http://localhost" });
  const requests: string[] = [], opens: string[] = [], selected: string[] = [];
  const globals = { window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, Event: browser.Event, FormData: browser.FormData, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (path: string) => { requests.push(path); return Response.json({ sessionId: "attached-app-id" }, { status: 201 }); } };
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const originalOpen = catalog.open, originalReconnect = store.reconnect; let root: Root | undefined;
  catalog.open = async cwd => { opens.push(cwd); if (opens.length === 1) return false; if (opens.length === 2) throw new Error("fixture catalog unavailable"); return true; };
  store.reconnect = () => {};
  try {
    const { createRoot } = await import("react-dom/client"), host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(<AttachConversation onChoose={id => selected.push(id)} />));
    await act(async () => host.querySelector("button")!.click());
    const form = host.querySelector("form")!;
    (form.elements.namedItem("nativeSessionId") as HTMLInputElement).value = "ses_existing";
    (form.elements.namedItem("cwd") as HTMLInputElement).value = "/fixture/repo";
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(host.querySelector('[role="status"]')?.textContent).toContain("attached-app-id");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Attachment succeeded. Opening the conversation failed");
    expect(host.querySelector("form")).toBeNull(); expect(selected).toEqual([]);
    const retry = () => [...host.querySelectorAll("button")].find(button => button.textContent === "Open attached conversation")!.click();
    await act(async () => retry());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("fixture catalog unavailable");
    // Closing/reopening keeps the acknowledged ID, rather than recreating a form.
    await act(async () => host.querySelector("dialog")!.dispatchEvent(new Event("cancel", { bubbles: true, cancelable: true })));
    await act(async () => host.querySelector("button")!.click());
    expect(host.querySelector('[role="status"]')?.textContent).toContain("attached-app-id");
    await act(async () => retry());
    expect(requests).toEqual(["/api/sessions/attach"]); expect(opens).toEqual(["/fixture/repo", "/fixture/repo", "/fixture/repo"]);
    expect(selected).toEqual(["attached-app-id"]); expect(host.querySelector("dialog")).toBeNull();
  } finally {
    catalog.open = originalOpen; store.reconnect = originalReconnect;
    if (root) await act(async () => root!.unmount()); browser.close();
    for (const [key, descriptor] of prior) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
