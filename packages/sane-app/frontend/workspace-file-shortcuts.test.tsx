import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useSyncExternalStore } from "react";
import type { Root } from "react-dom/client";
import { undo, redo } from "@codemirror/commands";
import { ApplicationCommandProvider } from "./application-commands";
import { catalog } from "./catalog";
import { WorkspaceProvider, useWorkspace, type ActiveView } from "./workspace-controller";
import { WorkspaceFileShortcuts, useWorkspaceFileOperations } from "./workspace-file-shortcuts";
import { dirty, notifyWorkspace, resetWorkspaceState, saveBuffer } from "./workspace-store";

type Controller = ReturnType<typeof useWorkspace>;
type Operations = NonNullable<ReturnType<typeof useWorkspaceFileOperations>>;
type KeyOptions = Pick<KeyboardEventInit, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "repeat" | "isComposing">;
const revision = "a".repeat(64);

async function withFiles(run: (fixture: {
  host: HTMLDivElement; controller: () => Controller; operations: () => Operations;
  files: Map<string, string>; writes: { route: string; method: string; body: any }[];
  navigations: ActiveView[];
  row: (path: string) => HTMLElement;
  key: (target: HTMLElement, options: KeyOptions, focus?: boolean) => Promise<boolean>;
  cancel: () => Promise<void>;
}) => Promise<void>) {
  const browser = new Window({ url: "http://localhost" });
  Object.defineProperty(browser.navigator, "platform", { configurable: true, value: "MacIntel" });
  const files = new Map([["open.md", "open saved"], ["docs/notes.md", "saved notes"]]);
  const writes: { route: string; method: string; body: any }[] = [];
  const navigations: ActiveView[] = [];
  const file = (path: string) => ({ workspaceId: "binding", path, text: files.get(path), revision, bytes: files.get(path)?.length ?? 0, editable: true, eol: "lf", bom: false });
  const globals = { window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
    HTMLElement: browser.HTMLElement, Event: browser.Event, MouseEvent: browser.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (path: string, init?: RequestInit) => {
      const url = new URL(path, "http://localhost"), route = url.pathname.split("/").at(-1)!;
      if (init?.method && init.method !== "GET") {
        const body = JSON.parse(String(init.body)); writes.push({ route, method: init.method, body });
        if (route === "rename" || route === "copy") {
          files.set(body.destination, files.get(body.path)!);
          if (route === "rename") files.delete(body.path);
          return Response.json(file(body.destination));
        }
        if (init.method === "PUT") { files.set(body.path, body.text); return Response.json(file(body.path)); }
        throw new Error(`Unexpected mutation: ${init.method} ${path}`);
      }
      if (route === "tree" || route === "other") return Response.json({ root: `/fixture/${route}`, workspaceId: "binding", bindingRevision: "binding", catalogWorkspaceId: "workspace", worktreeId: route, maxFileBytes: 262144 });
      if (route === "file") return Response.json(file(url.searchParams.get("path")!));
      throw new Error(`Unexpected request: ${path}`);
    },
  };
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const previousCatalog = catalog.state;
  catalog.state = { ...catalog.state, ready: false, navigation: { revision: 0, workspaceId: "workspace", worktreeId: "tree", conversationId: null, view: "code", filePath: "open.md", comparison: null } };
  let root: Root | undefined, controller: Controller | undefined, operations: Operations | undefined;
  function Probe() {
    controller = useWorkspace(); operations = useWorkspaceFileOperations()!;
    return <>
      <div data-workspace-file-tree data-workspace-scope={operations.scopeKey}>
        {([ ["open.md", "file"], ["docs/notes.md", "file"], ["docs/another.md", "file"], ["docs", "directory"], ["lib/another.md", "file"], ["lib", "directory"], ["", "directory"] ] as const).map(([path, kind]) =>
          <button key={path} data-workspace-file-path={path} data-workspace-file-kind={kind}>{path || "Root"}</button>)}
      </div>
      <input aria-label="Text input" /><div className="cm-editor"><div tabIndex={0} contentEditable /></div>
      <div className="xterm"><textarea /></div><div role="textbox" tabIndex={0} contentEditable />
      {operations.notice && <p role="status">{operations.notice.text}</p>}
    </>;
  }
  function Shell() {
    const { navigation } = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
    return <WorkspaceProvider view={navigation.view} navigate={view => { navigations.push(view); catalog.navigate({ view }); }}><WorkspaceFileShortcuts><Probe /></WorkspaceFileShortcuts></WorkspaceProvider>;
  }
  try {
    resetWorkspaceState();
    const { createRoot } = await import("react-dom/client"), host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(<ApplicationCommandProvider><Shell /></ApplicationCommandProvider>));
    expect(controller!.scope).toBeDefined(); expect(controller!.buffer).toBeDefined();
    await run({ host, controller: () => controller!, operations: () => operations!, files, writes, navigations,
      row: path => [...host.querySelectorAll<HTMLElement>("[data-workspace-file-path]")].find(row => row.dataset.workspaceFilePath === path)!,
      key: async (target, options, focus = true) => {
        let prevented = false;
        await act(async () => {
          if (focus) target.focus();
          const event = new browser.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...options });
          target.dispatchEvent(event as unknown as Event); prevented = event.defaultPrevented;
        });
        return prevented;
      },
      cancel: async () => { await act(async () => host.querySelector<HTMLButtonElement>('dialog button[type="button"]:not(.icon-button)')!.click()); },
    });
  } finally {
    if (root) await act(async () => root!.unmount());
    resetWorkspaceState(); catalog.state = previousCatalog; browser.close();
    for (const [key, descriptor] of prior) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}

test("Files shortcuts require the focused regular tree file and leave text, editor, terminal and modal keys alone", async () => {
  await withFiles(async f => {
    const source = f.row("docs/notes.md"), rename = { key: "R", shiftKey: true };
    expect(await f.key(source, { key: "c", metaKey: true })).toBe(true);
    expect(f.controller().selected).toBe("open.md");
    for (const target of f.host.querySelectorAll<HTMLElement>('input, .cm-editor div, textarea, [role="textbox"]')) {
      for (const options of [rename, { key: "Delete" }, { key: "Backspace", metaKey: true }, { key: "c", metaKey: true }, { key: "v", metaKey: true }]) expect(await f.key(target, options)).toBe(false);
    }
    expect(await f.key(f.row("docs"), rename)).toBe(false);
    f.row("open.md").focus(); expect(await f.key(source, rename, false)).toBe(false);
    expect(await f.key(source, { ...rename, repeat: true })).toBe(false);
    expect(await f.key(source, { ...rename, isComposing: true })).toBe(false);
    const tree = source.closest<HTMLElement>("[data-workspace-file-tree]")!, scopeKey = tree.dataset.workspaceScope!;
    tree.dataset.workspaceScope = "stale"; expect(await f.key(source, rename)).toBe(false); tree.dataset.workspaceScope = scopeKey;
    expect(f.host.querySelector("dialog")).toBeNull(); expect(f.writes).toHaveLength(0);
    expect(await f.key(source, rename)).toBe(true);
    expect(f.host.querySelector("dialog .context-path")?.textContent).toBe("docs/notes.md");
    expect(f.host.querySelector<HTMLInputElement>("#file-destination")!.value).toBe("notes.md");
    expect(await f.key(source, { key: "Delete" })).toBe(false); // An open modal blocks even tree-targeted events.
    await f.cancel();
    for (const options of [{ key: "Delete" }, { key: "Backspace", metaKey: true }]) {
      expect(await f.key(source, options)).toBe(true);
      expect(f.host.querySelector("dialog h2")?.textContent).toBe("Delete file");
      expect(f.host.querySelector("dialog .context-path")?.textContent).toBe("docs/notes.md");
      await f.cancel();
    }
    expect(f.controller().selected).toBe("open.md"); expect(f.writes).toHaveLength(0);
    const focusedBuffer = f.controller().root!.buffers.get("docs/notes.md")!;
    expect(await f.key(source, rename)).toBe(true);
    await act(async () => {
      const input = f.host.querySelector<HTMLInputElement>("#file-destination")!;
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, "renamed.md");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { f.host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(f.writes).toEqual([{ route: "rename", method: "POST", body: { workspaceId: "binding", path: "docs/notes.md", destination: "docs/renamed.md", expectedRevision: revision } }]);
    expect(f.controller().selected).toBe("open.md");
    expect(f.controller().root!.buffers.get("docs/renamed.md")).toBe(focusedBuffer);
    expect(f.operations().clipboard).toBeNull();
  });
});

test("file clipboard uses saved contents, prefills folder or file-parent destinations, and cannot cross worktrees", async () => {
  await withFiles(async f => {
    expect(await f.key(f.row("docs"), { key: "v", metaKey: true })).toBe(false);
    expect(await f.key(f.row("docs/notes.md"), { key: "c", metaKey: true })).toBe(true);
    expect(f.controller().selected).toBe("open.md"); expect(f.writes).toHaveLength(0);
    expect(f.host.querySelector('[role="status"]')?.textContent).toContain("not unsaved edits");
    const source = f.controller().root!.buffers.get("docs/notes.md")!;
    await act(async () => { source.state = source.state.update({ changes: { from: 0, insert: "local " } }).state; notifyWorkspace(); });
    for (const [target, destination] of [["docs", "docs/notes-copy.md"], ["docs/another.md", "docs/notes-copy.md"], ["lib", "lib/notes.md"], ["lib/another.md", "lib/notes.md"], ["", "notes.md"]]) {
      expect(await f.key(f.row(target!), { key: "v", metaKey: true })).toBe(true);
      expect(f.host.querySelector<HTMLInputElement>("#file-destination")!.value).toBe(destination);
      expect(f.host.querySelector("dialog .context-path")?.textContent).toBe("docs/notes.md");
      await f.cancel();
    }
    expect(f.writes).toHaveLength(0);
    expect(await f.key(f.row("lib"), { key: "v", metaKey: true })).toBe(true);
    await act(async () => { f.host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(f.writes).toEqual([{ route: "copy", method: "POST", body: { workspaceId: "binding", path: "docs/notes.md", destination: "lib/notes.md", expectedRevision: revision } }]);
    expect(f.files.get("lib/notes.md")).toBe("saved notes");
    expect(source.state.doc.toString()).toBe("local saved notes"); expect(dirty(source)).toBe(true);
    await act(async () => catalog.navigate({ worktreeId: "other", filePath: null }));
    expect(f.controller().scope?.workspace.worktreeId).toBe("other");
    expect(f.operations().clipboard).toBeNull();
    expect(await f.key(f.row("lib"), { key: "v", metaKey: true })).toBe(false);
    expect(f.host.querySelector("dialog")).toBeNull(); expect(f.writes).toHaveLength(1);
  });
});

test("rename preserves dirty document identity, selection and undo history and saves through the new path", async () => {
  await withFiles(async f => {
    const buffer = f.controller().buffer!;
    await act(async () => { buffer.state = buffer.state.update({ changes: { from: 0, insert: "local " }, selection: { anchor: 3 } }).state; notifyWorkspace(); });
    await act(async () => { expect(await f.controller().mutateFile("rename", "renamed.txt", "open.md")).toBe(true); });
    expect(f.controller().buffer).toBe(buffer); expect(f.controller().selected).toBe("renamed.txt");
    expect(catalog.state.navigation.filePath).toBe("renamed.txt");
    expect(f.controller().root!.buffers.has("open.md")).toBe(false);
    expect(buffer.path).toBe("renamed.txt"); expect(buffer.file.path).toBe("renamed.txt");
    expect(buffer.state.doc.toString()).toBe("local open saved"); expect(buffer.baseText).toBe("open saved");
    expect(buffer.state.selection.main.anchor).toBe(3); expect(dirty(buffer)).toBe(true);
    await act(async () => {
      expect(undo({ state: buffer.state, dispatch: transaction => { buffer.state = transaction.state; } })).toBe(true);
      expect(buffer.state.doc.toString()).toBe("open saved");
      expect(redo({ state: buffer.state, dispatch: transaction => { buffer.state = transaction.state; } })).toBe(true);
      notifyWorkspace();
    });
    await act(async () => saveBuffer(f.controller().scope!.id, f.controller().workspace!, buffer));
    expect(f.writes).toEqual([
      { route: "rename", method: "POST", body: { workspaceId: "binding", path: "open.md", destination: "renamed.txt", expectedRevision: revision } },
      { route: "file", method: "PUT", body: { workspaceId: "binding", path: "renamed.txt", text: "local open saved", expectedRevision: revision } },
    ]);
    expect(dirty(buffer)).toBe(false); expect(f.files.has("open.md")).toBe(false);
    expect(f.files.get("renamed.txt")).toBe("local open saved");
  });
});

test("a committed rename conflict migrates and quarantines dirty edits, clears the clipboard and disables dialog retry", async () => {
  await withFiles(async f => {
    const buffer = f.controller().buffer!, originalFetch = globalThis.fetch;
    const destinationRead = Promise.withResolvers<Response>(), destination = "renamed.md", message = "Rename committed; refresh the destination before trying again.";
    const reads: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("/rename") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)); f.writes.push({ route: "rename", method: "POST", body });
        f.files.set(body.destination, f.files.get(body.path)!); f.files.delete(body.path);
        return Response.json({ error: message, code: "rename-committed" }, { status: 409 });
      }
      if (url.pathname.endsWith("/file") && !init?.method && url.searchParams.get("path") === destination) {
        reads.push(destination); return destinationRead.promise;
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      await act(async () => { buffer.state = buffer.state.update({ changes: { from: 0, insert: "local " }, selection: { anchor: 3 } }).state; notifyWorkspace(); });
      expect(await f.key(f.row("open.md"), { key: "c", metaKey: true })).toBe(true);
      expect(f.operations().clipboard?.path).toBe("open.md");
      expect(await f.key(f.row("open.md"), { key: "R", shiftKey: true })).toBe(true);
      await act(async () => {
        const input = f.host.querySelector<HTMLInputElement>("#file-destination")!;
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, destination);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const submit = () => f.host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await act(async () => { submit(); });
      expect(f.controller().root!.buffers.has("open.md")).toBe(false);
      expect(f.controller().root!.buffers.get(destination)).toBe(buffer);
      expect(f.controller().buffer).toBe(buffer); expect(buffer.path).toBe(destination);
      expect(catalog.state.navigation.filePath).toBe(destination);
      expect(buffer.state.doc.toString()).toBe("local open saved"); expect(buffer.baseText).toBe("open saved");
      expect(buffer.state.selection.main.anchor).toBe(3); expect(dirty(buffer)).toBe(true);
      expect(buffer.missing).toBe(true); expect(buffer.saving).toBe(false);
      expect(f.operations().clipboard).toBeNull();
      expect(f.host.querySelector('[role="alert"]')?.textContent).toBe(message);
      const retry = f.host.querySelector<HTMLButtonElement>('dialog button[type="submit"]')!;
      expect(retry.disabled).toBe(true); expect(retry.textContent).toBe("Refresh required");
      expect(f.host.querySelector<HTMLInputElement>("#file-destination")!.disabled).toBe(true);
      await act(async () => { submit(); await saveBuffer(f.controller().scope!.id, f.controller().workspace!, buffer); });
      expect(f.writes).toHaveLength(1); expect(reads).toEqual([destination]);
      const diskRevision = "b".repeat(64);
      await act(async () => { destinationRead.resolve(Response.json({ workspaceId: "binding", path: destination, text: "reconciled disk contents", revision: diskRevision, bytes: 24, editable: true, eol: "lf", bom: false })); });
      expect(buffer.missing).toBe(false); expect(buffer.error).toBe("");
      expect(buffer.disk).toMatchObject({ path: destination, revision: diskRevision, text: "reconciled disk contents" });
      expect(buffer.state.doc.toString()).toBe("local open saved"); expect(dirty(buffer)).toBe(true);
      expect(retry.disabled).toBe(true); // Read reconciliation never retries an already committed rename.
      await f.cancel(); expect(f.host.querySelector("dialog")).toBeNull();
    } finally { globalThis.fetch = originalFetch; }
  });
});

for (const operation of ["rename", "delete"] as const) test(`pending ${operation} reconciles a returned worktree's fresh cache and bookmark without restoring an abandoned view`, async () => {
  for (const returningView of ["code", "chat"] as const) await withFiles(async f => {
    const initiating = f.controller(), oldScope = initiating.scope!, root = initiating.root!, buffer = initiating.buffer!;
    const originalFetch = globalThis.fetch, response = Promise.withResolvers<Response>();
    const oldInvalidations: string[] = [], newInvalidations: string[] = [];
    oldScope.invalidators.add(path => oldInvalidations.push(path));
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if ((operation === "rename" && url.pathname.endsWith("/rename") && init?.method === "POST") || (operation === "delete" && init?.method === "DELETE")) {
        f.writes.push({ route: operation === "rename" ? "rename" : "file", method: init!.method!, body: JSON.parse(String(init!.body)) });
        return response.promise;
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      let mutation!: Promise<boolean>;
      await act(async () => { mutation = initiating.mutateFile(operation, operation === "rename" ? "renamed.md" : "", "open.md"); });
      expect(f.writes).toHaveLength(1); expect(buffer.saving).toBe(true);
      await act(async () => { catalog.navigate({ worktreeId: "other", filePath: null }); });
      expect(f.controller().scope?.workspace.worktreeId).toBe("other");
      await act(async () => { catalog.navigate({ worktreeId: "tree", filePath: "open.md", view: returningView }); });
      const returnedScope = f.controller().scope!;
      expect(returnedScope).not.toBe(oldScope); expect(f.controller().root).toBe(root);
      returnedScope.directories.set("", { result: { listing: { workspaceId: "binding", path: "", entries: [], truncated: false } } });
      returnedScope.invalidators.add(path => newInvalidations.push(path));
      const destination = operation === "rename" ? "renamed.md" : "";
      if (operation === "rename") f.files.set(destination, f.files.get("open.md")!);
      f.files.delete("open.md");
      await act(async () => {
        response.resolve(Response.json(operation === "rename"
          ? { workspaceId: "binding", path: destination, text: "open saved", revision, bytes: 10, editable: true, eol: "lf", bom: false }
          : { workspaceId: "binding", path: "open.md" }));
        expect(await mutation).toBe(false); // The initiating scope is stale, although this root is visible again.
      });
      expect(oldInvalidations).toEqual([""]); expect(newInvalidations).toEqual([""]);
      expect(returnedScope.directories.has("")).toBe(false);
      expect(f.controller().scope).toBe(returnedScope); expect(f.controller().selected).toBe(destination);
      expect(catalog.state.navigation).toMatchObject({ worktreeId: "tree", filePath: destination, view: returningView });
      expect(f.controller().view).toBe(returningView); expect(f.navigations).toEqual([]);
      expect(buffer.saving).toBe(false); expect(root.buffers.has("open.md")).toBe(false);
      if (operation === "rename") {
        expect(root.buffers.get(destination)).toBe(buffer);
        if (returningView === "code") expect(f.controller().codeActivation?.source).toBe("files");
      }
    } finally { globalThis.fetch = originalFetch; }
  });
});
