import { expect } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import type { CheckoutPin, PhaseAssignment } from "sane-core/contracts";
import type { WorkstreamConversation, WorkstreamOverview } from "../src/workstreams-contract";
import { catalog } from "./catalog";

export const repositoryId = "e9da1b20-820f-467a-8000-123456789abc";
export const timestamp = "2026-10-01T00:00:00Z";
export const pin: CheckoutPin = { path: "/repo/pinned", gitDir: "/repo/.git/worktrees/pinned", commonDir: "/repo/.git", device: 1, inode: 2, gitDevice: 1, gitInode: 3, commonDevice: 1, commonInode: 4 };
export function detail(id = "alpha", title = "Alpha"): WorkstreamOverview["workstreams"][number] {
  return { workstream: { repositoryId, id, title, type: "feature", defaultCheckout: null, createdAt: timestamp, updatedAt: timestamp, revision: 1, lifecycle: { status: "open", phases: [], approvals: [], jobs: [], mutations: [] } }, conversations: [], activePhases: [], phaseHistory: [], research: { registered: [], unregistered: [], warnings: [] } };
}
export function row(id = "app-one", membership: string | null | undefined = "alpha", sessionId: string | null = id): WorkstreamConversation {
  const ref = { harness: "oc" as const, authorityId: "authority", nativeId: `native-${id}` };
  return { ref, sessionId, title: `Conversation ${id}`, conversation: membership === undefined ? null : { id: `domain-${id}`, repositoryId, ref, workstreamId: membership, executionCheckout: pin, parent: null, createdAt: timestamp } };
}
export function appOnly(id = "app-only"): WorkstreamConversation { const value = row(id); value.conversation = null; return value; }
export function assignment(value: WorkstreamConversation, phase: PhaseAssignment["phase"], id = phase): PhaseAssignment {
  return { id, ref: value.ref!, membershipId: "membership", workstreamId: value.conversation?.workstreamId ?? "alpha", phase, startedAt: timestamp, endedAt: null };
}
export function overview(rows: WorkstreamConversation[] = [], details = [detail(), detail("beta", "Beta")]): WorkstreamOverview {
  return { repositoryId, workstreams: details.map(value => ({ ...value, conversations: rows.flatMap(row => row.conversation?.workstreamId === value.workstream.id ? [row.conversation] : []) })), conversations: rows };
}
export function admission(value: WorkstreamConversation, state = "ready", mode = "app-only") {
  return { sessionId: value.sessionId!, state, nativeId: value.ref!.nativeId, operation: "enroll", source: { authorityId: value.ref!.authorityId, descriptor: { harness: "oc" } }, binding: { workspaceId: "workspace", domain: { mode, ...(mode === "repository" ? { repositoryId } : {}) }, executionCheckout: pin.path }, createdAt: timestamp, error: state === "ready" ? null : "Native activity pending" };
}
export function deferred() { return Promise.withResolvers<Response>(); }
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export const unexpected: Fetcher = async url => { throw new Error(`Unexpected request: ${url}`); };
export function button(host: ParentNode, label: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find(value => value.textContent === label);
  expect(found, `Button ${label}`).toBeDefined(); return found!;
}
export function field<T extends HTMLInputElement | HTMLSelectElement = HTMLInputElement>(host: ParentNode, label: string): T {
  const found = [...host.querySelectorAll("label")].find(value => value.firstChild?.textContent === label)?.querySelector("input,select");
  expect(found, `Field ${label}`).toBeDefined(); return found as T;
}
export async function click(value: HTMLElement) { await act(async () => { value.click(); }); }
export async function input(value: HTMLInputElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(value, text);
    value.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
export async function select(value: HTMLSelectElement, text: string) { await act(async () => { value.value = text; value.dispatchEvent(new window.Event("change", { bubbles: true })); }); }
export async function submit(host: ParentNode, times = 1) { await act(async () => { for (let index = 0; index < times; index++) host.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); }); }
export async function withDom(fetcher: Fetcher, run: (host: HTMLDivElement, root: Root, render: (node: ReactNode) => Promise<void>) => Promise<void>) {
  const browser = new Window({ url: "http://localhost" });
  const globals = { window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage, HTMLElement: browser.HTMLElement, Event: browser.Event, MouseEvent: browser.MouseEvent, FormData: browser.FormData, IS_REACT_ACT_ENVIRONMENT: true, fetch: fetcher };
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const previous = catalog.snapshot();
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  if (!browser.HTMLDialogElement.prototype.showModal) {
    browser.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
    browser.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  }
  catalog.invalidate();
  catalog.state = { ...previous, ready: false, loading: false, error: "", workspaces: [{ workspaceId: "workspace", kind: "repository", name: "Friendly repository", commonDir: "/repo/.git", worktrees: [{ worktreeId: "main", root: "/repo/main", gitDir: "/repo/.git", bindingRevision: "revision", state: "available", branch: "refs/heads/main", alias: "Primary" }, { worktreeId: "topic", root: "/repo/topic", gitDir: "/repo/.git/worktrees/topic", bindingRevision: "revision", state: "available", branch: "refs/heads/topic" }] }] };
  let root: Root | undefined;
  try {
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    const render = async (node: ReactNode) => { await act(async () => { root!.render(node); }); };
    await run(host, root, render);
  } finally {
    try { if (root) await act(async () => { root!.unmount(); }); }
    finally { catalog.invalidate(); catalog.state = previous; browser.close(); for (const [key, descriptor] of prior) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } }
  }
}
