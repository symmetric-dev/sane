import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { WorkspaceProvider, useWorkspace } from "./workspace-controller";
import { WorkspaceHeader } from "./workspace";
import { WorkspaceSidebar } from "./workspace-tree";
import { catalog } from "./catalog";
import { dirty, notifyWorkspace, resetWorkspaceState } from "./workspace-store";
import { copyDestination } from "./workspace-file-actions";

test("copy destination preserves folders/extensions, including extensionless and hidden files", () => {
  expect(copyDestination("docs/notes.md")).toBe("docs/notes-copy.md");
  expect(copyDestination("docs/README")).toBe("docs/README-copy");
  expect(copyDestination(".env")).toBe(".env-copy");
});

test("Code actions copy saved contents, preserve failed input/local edits, and confirm deletion", async () => {
  const browser = new Window({ url: "http://localhost" });
  const responses: ReturnType<typeof Promise.withResolvers<Response>>[] = [], writes: { route: string; method: string; body: any }[] = [];
  const revision = "a".repeat(64), files = new Map([["notes.md", "saved text"]]);
  const globals = { window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, Event: browser.Event, MouseEvent: browser.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (path: string, init?: RequestInit) => {
      const url = new URL(path, "http://localhost"), route = url.pathname.split("/").at(-1)!;
      if (init?.method && init.method !== "GET") {
        const pending = Promise.withResolvers<Response>(); responses.push(pending);
        writes.push({ route, method: init.method, body: JSON.parse(String(init.body)) });
        return pending.promise;
      }
      if (route === "tree") return Response.json({ root: "/fixture", workspaceId: "binding", bindingRevision: "binding", catalogWorkspaceId: "workspace", worktreeId: "tree", maxFileBytes: 262144 });
      if (route === "list") return Response.json({ workspaceId: "binding", path: url.searchParams.get("path"), entries: [], truncated: false });
      if (route === "file") {
        const filePath = url.searchParams.get("path")!;
        return Response.json({ workspaceId: "binding", path: filePath, text: files.get(filePath), revision, bytes: 10, editable: true, eol: "lf", bom: false });
      }
      throw new Error(`Unexpected request: ${path}`);
    },
  };
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const previousCatalog = catalog.state;
  catalog.state = { ...catalog.state, ready: false, navigation: { revision: 0, workspaceId: "workspace", worktreeId: "tree", conversationId: null, view: "code", filePath: "notes.md", comparison: null } };
  let root: Root | undefined, controller: ReturnType<typeof useWorkspace>;
  function Probe() { controller = useWorkspace(); return <><WorkspaceHeader /><WorkspaceSidebar /></>; }
  try {
    resetWorkspaceState();
    const { createRoot } = await import("react-dom/client"), host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(<WorkspaceProvider view="code" navigate={() => {}}><Probe /></WorkspaceProvider>));
    expect(controller!.selected).toBe("notes.md"); expect(controller!.buffer).toBeDefined();
    const footer = host.querySelector(".workspace-sidebar-actions")!;
    expect(footer.tagName).toBe("FOOTER");
    expect(footer.previousElementSibling?.className).toBe("workspace-sidebar-content");
    expect(host.querySelector(".workspace-sidebar-heading button")).toBeNull();
    expect(footer.textContent).toBe("New fileRefresh");
    const original = controller!.buffer!;
    await act(async () => { original.state = original.state.update({ changes: { from: 0, to: original.state.doc.length, insert: "unsaved text" } }).state; notifyWorkspace(); });
    const button = (label: string) => [...host.querySelectorAll("button")].find(node => node.textContent === label)!;
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="File actions"]')!.click());
    expect(button("New file")).toBeDefined();
    await act(async () => button("Copy file").click());
    expect(host.textContent).toContain("unsaved edits are not included");
    expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("notes-copy.md");
    const submit = () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await act(async () => { submit(); });
    expect(writes[0]).toEqual({ route: "copy", method: "POST", body: { workspaceId: "binding", path: "notes.md", destination: "notes-copy.md", expectedRevision: revision } });
    await act(async () => host.querySelector("dialog")!.dispatchEvent(new Event("cancel", { bubbles: true, cancelable: true })));
    expect(host.querySelector("dialog")).not.toBeNull(); // Busy operations cannot be dismissed or resubmitted.
    await act(async () => { submit(); }); expect(writes).toHaveLength(1);
    await act(async () => responses[0]!.resolve(Response.json({ error: "Destination exists", code: "path-exists" }, { status: 409 })));
    expect(host.querySelector('[role="alert"]')!.textContent).toBe("Destination exists");
    expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("notes-copy.md");
    expect(original.saving).toBe(false); expect(dirty(original)).toBe(true);
    let invalidated = false;
    controller!.scope!.directories.set("", { result: { listing: { workspaceId: "binding", path: "", entries: [], truncated: false } } });
    controller!.scope!.invalidators.add(() => { invalidated = true; });
    await act(async () => { submit(); });
    files.set("notes-copy.md", "saved text");
    await act(async () => responses[1]!.resolve(Response.json({ path: "notes-copy.md" }, { status: 201 })));
    expect(host.querySelector("dialog")).toBeNull(); expect(invalidated).toBe(true);
    expect(controller!.selected).toBe("notes-copy.md"); expect(controller!.buffer!.state.doc.toString()).toBe("saved text");
    expect(original.state.doc.toString()).toBe("unsaved text"); expect(dirty(original)).toBe(true);
    await act(async () => { const buffer = controller!.buffer!; buffer.state = buffer.state.update({ changes: { from: 0, insert: "local " } }).state; notifyWorkspace(); });
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="File actions"]')!.click());
    await act(async () => button("Delete file").click());
    expect(host.textContent).toContain("discard those edits"); expect(writes).toHaveLength(2);
    await act(async () => { submit(); });
    expect(writes[2]).toEqual({ route: "file", method: "DELETE", body: { workspaceId: "binding", path: "notes-copy.md", expectedRevision: revision } });
    await act(async () => responses[2]!.resolve(Response.json({ path: "notes-copy.md", workspaceId: "binding" })));
    expect(controller!.selected).toBe(""); expect(controller!.root!.buffers.has("notes-copy.md")).toBe(false);
    expect(controller!.root!.buffers.has("notes.md")).toBe(true); expect(host.querySelector("dialog")).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="File actions"]')!.click());
    await act(async () => button("New file").click());
    expect(host.querySelector("input")!.getAttribute("placeholder")).toBe("docs/notes.md");
    expect(button("New file").disabled).toBe(true);
    await act(async () => button("Cancel").click());
    // Submit the actual sidebar dialog, rather than bypassing it via the controller.
    await act(async () => footer.querySelector<HTMLButtonElement>("button")!.click());
    await act(async () => {
      const input = host.querySelector<HTMLInputElement>("#file-destination")!;
      Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(input, "docs/new.md");
      input.dispatchEvent(new browser.Event("input", { bubbles: true }) as unknown as Event);
    });
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    await act(async () => { submit(); });
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.textContent).toBe("Working…");
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    expect(writes[3]).toEqual({ route: "file", method: "POST", body: { workspaceId: "binding", path: "docs/new.md" } });
    files.set("docs/new.md", "");
    await act(async () => { responses[3]!.resolve(Response.json({ path: "docs/new.md" }, { status: 201 })); });
    expect(host.querySelector("dialog")).toBeNull();
    expect(host.textContent).not.toContain("Working…");
    expect(controller!.selected).toBe("docs/new.md"); expect(controller!.buffer!.state.doc.toString()).toBe("");
    expect(controller!.root!.codeTree.expandedItems).toContain("directory:docs");
    invalidated = false;
    await act(async () => footer.querySelector<HTMLButtonElement>('[aria-label="Refresh files"]')!.click());
    expect(invalidated).toBe(true);
    // Late responses after switching workspaces never navigate back or strand a cached source.
    const newBuffer = controller!.buffer!;
    let copying: Promise<boolean>;
    await act(async () => { copying = controller!.mutateFile("copy", "docs/new-copy.md"); });
    expect(newBuffer.saving).toBe(true);
    await act(async () => catalog.navigate({ worktreeId: "other", filePath: null }));
    expect(controller!.scope).toBeUndefined();
    await act(async () => { responses[4]!.resolve(Response.json({ path: "docs/new-copy.md" }, { status: 201 })); expect(await copying!).toBe(false); });
    expect(catalog.state.navigation.worktreeId).toBe("other"); expect(newBuffer.saving).toBe(false);
  } finally {
    if (root) await act(async () => root!.unmount());
    resetWorkspaceState(); catalog.state = previousCatalog; browser.close();
    for (const [key, descriptor] of prior) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
