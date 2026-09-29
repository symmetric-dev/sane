import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { WorkstreamOverview } from "../src/workstreams-contract";
import { WorkstreamsView } from "./workstreams";

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
}

test("a delayed refresh updates the view without dismissing a newer failed action", async () => {
  const browser = new Window({ url: "http://localhost" });
  const reads: ReturnType<typeof deferredResponse>[] = [], writes: ReturnType<typeof deferredResponse>[] = [];
  const submitted: unknown[] = [];
  const pendingInspection = deferredResponse();
  let inspections = 0;
  const globals: Record<string, unknown> = {
    window: browser, document: browser.document, navigator: browser.navigator,
    HTMLElement: browser.HTMLElement, Event: browser.Event, MouseEvent: browser.MouseEvent,
    FormData: browser.FormData, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (input: string, init?: RequestInit) => {
      if (input.startsWith("/api/workstreams/inspect?")) return ++inspections === 2 ? pendingInspection.promise : Promise.resolve(Response.json({ state: "ready" }));
      const response = deferredResponse();
      if (input.startsWith("/api/workstreams/overview?") && !init?.method) reads.push(response);
      else if (input.startsWith("/api/workstreams?") && init?.method === "POST") { writes.push(response); submitted.push(JSON.parse(String(init.body))); }
      else if (input.startsWith("/api/workstreams/artifacts/list?")) return Promise.resolve(Response.json(["README.md"]));
      else throw new Error(`Unexpected request: ${input}`);
      return response.promise;
    },
  };
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let root: Root | undefined;
  try {
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div"); document.body.append(host);
    root = createRoot(host);
    const snapshot: WorkstreamOverview = { repositoryId: "fixture", workstreams: [], conversations: [] };
    await act(async () => { root!.render(<WorkstreamsView workspaceId="fixture" openArtifact={() => { throw new Error("Unexpected artifact navigation"); }} />); });
    expect(reads).toHaveLength(1);
    await act(async () => { reads[0]!.resolve(Response.json(snapshot)); });
    const refresh = [...host.querySelectorAll("button")].find(button => button.textContent === "Refresh")!;
    await act(async () => { refresh.click(); });
    expect(inspections).toBe(2); // Leave this older inspection pending while submitting.
    const form = host.querySelector("details form") as HTMLFormElement;
    (form.elements.namedItem("id") as HTMLInputElement).value = "duplicate";
    (form.elements.namedItem("title") as HTMLInputElement).value = "Duplicate";
    const type = form.elements.namedItem("type") as HTMLSelectElement;
    expect(type.required).toBe(true);
    expect(type.value).toBe("");
    expect([...type.options].map(option => option.value)).toEqual(["", "feature", "foundation", "issue", "maintenance"]);
    type.value = "foundation";
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(writes).toHaveLength(1);
    expect(submitted[0]).toEqual({ id: "duplicate", title: "Duplicate", type: "foundation" });
    await act(async () => { writes[0]!.resolve(Response.json({ error: "Workstream already exists." }, { status: 409 })); });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Workstream already exists.");
    await act(async () => { pendingInspection.resolve(Response.json({ state: "ready" })); });
    const refreshed: WorkstreamOverview = { ...snapshot, workstreams: [{
      workstream: { repositoryId: "fixture", id: "external", title: "Externally created", type: "feature", defaultCheckout: null, createdAt: "2026-09-26T00:00:00Z", updatedAt: "2026-09-26T00:00:00Z", revision: 1, lifecycle: { status: "open", phases: [], approvals: [], jobs: [], mutations: [] } },
      conversations: [], activePhases: [], phaseHistory: [], research: { registered: [], unregistered: [], warnings: [] },
    }] };
    await act(async () => { reads[1]!.resolve(Response.json(refreshed)); });
    expect(host.textContent).toContain("Externally created");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Workstream already exists.");
    expect(refresh.disabled).toBe(false);
    const details = host.querySelector('label > select:not([name])') as HTMLSelectElement;
    await act(async () => { details.value = "external"; details.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(host.textContent).toContain("Type: feature");

    // A read failure is shown alongside the explicit action failure, not over it.
    await act(async () => { refresh.click(); });
    await act(async () => { reads[2]!.resolve(Response.json({ error: "Read unavailable" }, { status: 503 })); });
    expect([...host.querySelectorAll('[role="alert"]')].map(node => node.textContent)).toEqual(["Read unavailable", "Workstream already exists."]);

    // Recover the read before retrying through the newly mounted form.
    await act(async () => { refresh.click(); });
    await act(async () => { reads[3]!.resolve(Response.json(snapshot)); });
    const retryForm = host.querySelector("details form") as HTMLFormElement;
    (retryForm.elements.namedItem("id") as HTMLInputElement).value = "created";
    (retryForm.elements.namedItem("title") as HTMLInputElement).value = "Created";
    (retryForm.elements.namedItem("type") as HTMLSelectElement).value = "feature";
    await act(async () => { retryForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await act(async () => { writes[1]!.resolve(Response.json({ id: "created" })); });
    expect(reads).toHaveLength(5);
    await act(async () => { reads[4]!.resolve(Response.json(snapshot)); });
    expect(host.querySelector('[role="alert"]')).toBe(null);
  } finally {
    try { if (root) await act(async () => { root!.unmount(); }); }
    finally {
      browser.close();
      for (const [key, descriptor] of prior) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  }
});
