import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { buildWorkstreamMap, phaseOptions, workstreamOptions } from "./conversation-filter-dialog";
import { ConversationFilterDialog } from "./conversation-filter-dialog";
import { defaultFilterFor } from "./conversation-filter";
import type { WorkstreamOverview } from "../src/workstreams-contract";

const overview = {
  repositoryId: "repo",
  workstreams: [{
    workstream: { repositoryId: "repo", id: "w1", title: "Alpha", type: "feature", defaultCheckout: null, createdAt: "", updatedAt: "", revision: 1, lifecycle: { status: "open", phases: [], approvals: [], jobs: [], mutations: [] } },
    conversations: [], activePhases: [{ id: "a1", membershipId: "m1", ref: { harness: "oc", authorityId: "auth", nativeId: "ses_1" }, workstreamId: "w1", phase: "design", startedAt: "", endedAt: null }],
    phaseHistory: [], research: { registered: [], unregistered: [], warnings: [] },
  }],
  conversations: [
    { ref: { harness: "oc", authorityId: "auth", nativeId: "ses_1" }, sessionId: "c1", title: "One", conversation: { id: "x", repositoryId: "repo", ref: { harness: "oc", authorityId: "auth", nativeId: "ses_1" }, executionCheckout: { path: "/r" }, parent: null, workstreamId: "w1", createdAt: "" } },
    { ref: { harness: "cc", authorityId: "auth2", nativeId: "nid" }, sessionId: "c2", title: "Two", conversation: null },
  ],
} as unknown as WorkstreamOverview;

test("workstream map joins overview rows by sessionId with phases", () => {
  const map = buildWorkstreamMap(overview, []);
  expect(map.get("c1")).toEqual({ workstreamId: "w1", phases: ["design"] });
  expect(map.get("c2")).toEqual({ workstreamId: null, phases: [] });
  expect(workstreamOptions(overview).map(o => o.value)).toContain("workstream:w1");
  expect(phaseOptions(overview)).toEqual(["design"]);
  expect(buildWorkstreamMap(null, []).size).toBe(0);
});

test("filter dialog renders fields and reports changes", async () => {
  const browser = new Window({ url: "http://localhost" });
  const globals: Record<string, unknown> = {
    window: browser, document: browser.document, navigator: browser.navigator,
    HTMLElement: browser.HTMLElement, Event: browser.Event, MouseEvent: browser.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  if (!browser.HTMLDialogElement.prototype.showModal) {
    (browser.HTMLDialogElement.prototype as any).showModal = function () { this.setAttribute("open", ""); };
    (browser.HTMLDialogElement.prototype as any).close = function () { this.removeAttribute("open"); };
  }
  let root: Root | undefined;
  try {
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    let value = defaultFilterFor("ws1", "wt1");
    const seen: string[] = [];
    await act(async () => {
      root!.render(<ConversationFilterDialog value={value} onChange={next => { value = next; seen.push(next.harness); }} workspaces={[]} navigation={{ workspaceId: "ws1", worktreeId: "wt1" }} overview={null} onClose={() => {}} />);
    });
    expect(host.textContent).toContain("Filter conversations");
    expect(host.querySelectorAll("select").length).toBeGreaterThanOrEqual(5);
    const harness = [...host.querySelectorAll("select")].find(s => s.innerHTML.includes("Claude Code")) as HTMLSelectElement;
    await act(async () => { harness.value = "opencode"; harness.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(seen).toContain("opencode");
  } finally {
    if (root) await act(async () => root!.unmount()); browser.close();
    for (const [key, descriptor] of prior) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
