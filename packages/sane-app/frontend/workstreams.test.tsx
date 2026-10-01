import { expect, test } from "bun:test";
import { act } from "react";
import { WorkstreamsView } from "./workstreams";
import { appOnly, button, click, deferred, detail, field, input, overview, repositoryId, row, select, submit, withDom } from "./workstreams.test-utils";

test("organizer selects first, preserves selection across refresh, falls back after removal, counts Unassigned and filters", async () => {
  let snapshot = overview([row(), row("null-member", null), appOnly()]);
  await withDom(async url => url.includes("/inspect?") ? Response.json({ state: "ready" }) : Response.json(snapshot), async (host, _, render) => {
    await render(<WorkstreamsView workspaceId="workspace" />);
    const selected = () => host.querySelector('[aria-current="true"] .workstreams-list-title')?.textContent;
    expect(selected()).toBe("Alpha");
    expect(host.querySelector("dialog")).toBeNull();
    expect(host.textContent).toContain("Friendly repository");
    expect(host.textContent).not.toContain(repositoryId);
    expect(host.querySelector('.workstreams-unassigned [aria-label="2 conversations"]')).not.toBeNull();
    await click(host.querySelectorAll<HTMLButtonElement>(".workstreams-list button")[1]!);
    await click(button(host, "Refresh")); expect(selected()).toBe("Beta");
    await input(field(host, "Search workstreams"), "ALPHA");
    expect(host.querySelectorAll(".workstreams-list-title").length).toBe(2); // Match plus Unassigned; selected content remains.
    expect(host.querySelector(".workstreams-content-header h3")?.textContent).toBe("Beta");
    snapshot = overview(snapshot.conversations, [detail()]);
    await click(button(host, "Refresh")); expect(selected()).toBe("Alpha");
    await click(host.querySelector<HTMLButtonElement>(".workstreams-unassigned")!);
    await click(button(host, "Refresh")); expect(selected()).toBe("Unassigned");
    expect(host.querySelectorAll(".workstream-conversations-row")).toHaveLength(2);
    expect(host.querySelector<HTMLButtonElement>('[role="tab"]:last-child')!.disabled).toBe(true);
    await input(field(host, "Search workstreams"), "no matches");
    expect(host.textContent).toContain("No workstreams match your search.");
  });
});

test("Documents tabs support keyboard focus and Details is a modal, not permanent content", async () => {
  await withDom(async url => url.includes("/inspect?") ? Response.json({ state: "ready" }) : url.includes("/artifacts/list?") ? Response.json(["README.md"]) : Response.json(overview()), async (host, _, render) => {
    await render(<WorkstreamsView workspaceId="workspace" />);
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    await act(async () => { tabs[0]!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })); });
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true"); expect(document.activeElement).toBe(tabs[1]!);
    expect(host.querySelector('[aria-label="Workstream documents"]')?.textContent).toContain("Workstream overview");
    await act(async () => { tabs[1]!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Home", bubbles: true })); });
    expect(tabs[0]!.tabIndex).toBe(0); expect(document.activeElement).toBe(tabs[0]!);
    await click(button(host, "Details")); expect(host.querySelector("dialog[open]")).not.toBeNull();
    expect(host.textContent).toContain("Document lifecycle");
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Close workstream details"]')!);
    expect(host.textContent).not.toContain("Document lifecycle");
  });
});

test("a delayed refresh updates the view without dismissing a newer failed action", async () => {
  const reads: ReturnType<typeof deferred>[] = [], writes: ReturnType<typeof deferred>[] = [], submitted: unknown[] = [];
  const pendingInspection = deferred(); let inspections = 0;
  await withDom(async (url, init) => {
    if (url.includes("/inspect?")) return ++inspections === 2 ? pendingInspection.promise : Response.json({ state: "ready" });
    const response = deferred();
    if (url.includes("/overview?")) reads.push(response);
    else if (url.startsWith("/api/workstreams?") && init?.method === "POST") { writes.push(response); submitted.push(JSON.parse(String(init.body))); }
    else throw new Error(`Unexpected request: ${url}`);
    return response.promise;
  }, async (host, _, render) => {
    const snapshot = overview([], []);
    await render(<WorkstreamsView workspaceId="workspace" />);
    await act(async () => { reads[0]!.resolve(Response.json(snapshot)); });
    const refresh = button(host, "Refresh"); await click(refresh); expect(inspections).toBe(2);
    await click(button(host, "New workstream")); const dialog = host.querySelector("dialog")!;
    await input(field(dialog, "Title"), "Duplicate");
    const type = field<HTMLSelectElement>(dialog, "Type");
    expect(type.required).toBe(true); expect(type.value).toBe(""); expect([...type.options].map(value => value.value)).toEqual(["", "feature", "foundation", "issue", "maintenance"]);
    await select(type, "foundation"); await submit(dialog);
    expect(writes).toHaveLength(1); expect(submitted[0]).toEqual({ id: "duplicate", title: "Duplicate", type: "foundation" });
    await act(async () => { writes[0]!.resolve(Response.json({ error: "Workstream already exists." }, { status: 409 })); });
    const message = dialog.querySelector('[role="alert"]')!.textContent;
    expect(message).toContain("identifier is already in use"); expect(dialog.textContent).toContain("Workstream already exists.");
    await act(async () => { pendingInspection.resolve(Response.json({ state: "ready" })); });
    await act(async () => { reads[1]!.resolve(Response.json(overview([], [detail("external", "Externally created")]))); });
    expect(host.textContent).toContain("Externally created"); expect(host.querySelector("dialog")).toBe(dialog);
    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(message); expect(refresh.disabled).toBe(false);
    // An initially empty list intentionally selects Unassigned; select the new row as in the legacy dropdown test.
    await click(host.querySelector<HTMLButtonElement>(".workstreams-list button")!);
    expect(host.querySelector(".workstreams-content-header")?.textContent).toContain("feature");
    await click(refresh);
    await act(async () => { reads[2]!.resolve(Response.json({ error: "Read unavailable" }, { status: 503 })); });
    expect([...host.querySelectorAll('[role="alert"]')].map(node => node.textContent)).toEqual(["Couldn't refresh workstreams. Your previous view is still available.", message]);
    expect(host.textContent).toContain("Read unavailable");
    await click(refresh); await act(async () => { reads[3]!.resolve(Response.json(snapshot)); });
    expect(host.querySelector("dialog")).toBe(dialog); expect(field(dialog, "Title").value).toBe("Duplicate");
    await input(field(dialog, "Title"), "Created"); await input(field(dialog, "Identifier"), "created"); await select(type, "feature"); await submit(dialog);
    await act(async () => { writes[1]!.resolve(Response.json({ id: "created" })); }); expect(reads).toHaveLength(5);
    await act(async () => { reads[4]!.resolve(Response.json(overview([], [detail("created", "Created")]))); });
    expect(host.querySelector('[role="alert"]')).toBeNull(); expect(host.querySelector("dialog")).toBeNull();
    expect(host.querySelector('[aria-current="true"] .workstreams-list-title')?.textContent).toBe("Created");
  });
});

test("integration: successful creation plus failed root refresh must retain refresh-only recovery", async () => {
  let reads = 0, writes = 0;
  await withDom(async (url, init) => {
    if (url.includes("/inspect?")) return Response.json({ state: "ready" });
    if (url.includes("/overview?")) return ++reads === 1 ? Response.json(overview()) : Response.json({ error: "offline after create" }, { status: 503 });
    if (init?.method === "POST") { writes++; return Response.json({ id: "created" }); }
    throw new Error(url);
  }, async (host, _, render) => {
    await render(<WorkstreamsView workspaceId="workspace" />); await click(button(host, "New workstream"));
    await input(field(host.querySelector("dialog")!, "Title"), "Created"); await select(field<HTMLSelectElement>(host.querySelector("dialog")!, "Type"), "feature"); await submit(host.querySelector("dialog")!);
    expect(writes).toBe(1); expect(reads).toBe(2);
    expect(host.querySelector("dialog"), "Saved create must remain recoverable without a duplicate POST").not.toBeNull();
    expect(button(host, "Retry opening workstream")).toBeDefined();
  });
});

test("integration: saved default checkout plus failed root refresh must offer Retry refresh, not success", async () => {
  let reads = 0; const writes: unknown[] = [];
  await withDom(async (url, init) => {
    if (url.includes("/inspect?")) return Response.json({ state: "ready" });
    if (url.includes("/overview?")) return ++reads === 1 ? Response.json(overview()) : Response.json({ error: "offline after checkout" }, { status: 503 });
    writes.push(JSON.parse(String(init?.body))); return Response.json({});
  }, async (host, _, render) => {
    await render(<WorkstreamsView workspaceId="workspace" />); await click(button(host, "Details")); const dialog = host.querySelector("dialog")!;
    await click(button(dialog, "Change default checkout…")); await select(field<HTMLSelectElement>(dialog, "Default working checkout"), "/repo/topic"); await submit(dialog);
    expect(writes).toEqual([{ id: "alpha", checkout: "/repo/topic" }]);
    expect(dialog.querySelector('[role="alert"]')?.textContent ?? "", "Saved checkout must not report success when root refresh failed").toContain("saved, but the workstream view couldn't refresh");
    expect(button(dialog, "Retry refresh")).toBeDefined();
  });
});

test("Enable workstreams is explicit, double-click locked, friendly failure preserves retry and success loads organizer", async () => {
  const responses: ReturnType<typeof deferred>[] = [], bodies: unknown[] = []; let ready = false;
  await withDom(async (url, init) => {
    if (url.includes("/inspect?")) return Response.json({ state: ready ? "ready" : "uninitialized", message: "raw domain missing" });
    if (url.includes("/overview?")) return Response.json(overview());
    if (url.includes("/init?")) { bodies.push(JSON.parse(String(init?.body))); const response = deferred(); responses.push(response); return response.promise; }
    throw new Error(url);
  }, async (host, _, render) => {
    await render(<WorkstreamsView workspaceId="workspace" />); expect(bodies).toHaveLength(0);
    const enable = button(host, "Enable workstreams"); await act(async () => { enable.click(); enable.click(); }); expect(bodies).toEqual([{}]);
    await act(async () => { responses[0]!.resolve(Response.json({ error: "Repository denied permission" }, { status: 503 })); });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Couldn't enable workstreams. Try again when the repository is available.");
    expect(host.textContent).toContain("Repository denied permission"); await click(button(host, "Enable workstreams"));
    ready = true; await act(async () => { responses[1]!.resolve(Response.json({})); });
    expect(host.querySelector(".workstreams-organizer")).not.toBeNull(); expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});
