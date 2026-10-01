import { expect, test } from "bun:test";
import { act } from "react";
import { CreateWorkstreamDialog, WorkstreamDetails, WorkstreamDocuments } from "./workstream-content";
import { assignment, button, click, deferred, detail, field, input, pin, repositoryId, row, select, submit, timestamp, withDom } from "./workstreams.test-utils";

test("create requires explicit type, generates ID, keeps custom conflict inputs and prevents duplicate submissions", async () => {
  const requests: unknown[] = [], responses: ReturnType<typeof deferred>[] = [], selected: string[] = []; let closes = 0;
  await withDom(async (_, init) => { requests.push(JSON.parse(String(init?.body))); const response = deferred(); responses.push(response); return response.promise; }, async (host, _, render) => {
    await render(<CreateWorkstreamDialog workspaceId="workspace" close={() => closes++} onCreated={async id => { selected.push(id); }} />);
    const dialog = host.querySelector("dialog")!, title = field(dialog, "Title"), type = field<HTMLSelectElement>(dialog, "Type");
    expect(type.required).toBe(true); expect(type.value).toBe("");
    await input(title, "Café & Checkout UI"); expect(field(dialog, "Identifier").value).toBe("cafe-checkout-ui");
    await submit(dialog); expect(requests).toHaveLength(0); expect(dialog.querySelector('[role="alert"]')?.textContent).toBe("Choose a workstream type.");
    await select(type, "foundation"); await input(field(dialog, "Identifier"), "custom-id"); await submit(dialog, 2);
    expect(requests).toEqual([{ id: "custom-id", title: "Café & Checkout UI", type: "foundation" }]);
    expect(button(dialog, "Creating…").disabled).toBe(true);
    await act(async () => { dialog.dispatchEvent(new window.Event("cancel", { bubbles: true, cancelable: true })); }); expect(closes).toBe(0);
    await act(async () => { responses[0]!.resolve(Response.json({ error: "Workstream already exists" }, { status: 409 })); });
    expect(title.value).toBe("Café & Checkout UI"); expect(type.value).toBe("foundation"); expect(field(dialog, "Identifier").value).toBe("custom-id");
    expect(dialog.querySelector("details")!.open).toBe(true); expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("entries have been kept");
    await input(title, "Different title"); expect(field(dialog, "Identifier").value).toBe("custom-id");
    await click(button(dialog, "Generate from title again")); expect(field(dialog, "Identifier").value).toBe("different-title");
    await select(field<HTMLSelectElement>(dialog, "Default working checkout"), "/repo/main"); await submit(dialog);
    expect(requests[1]).toEqual({ id: "different-title", title: "Different title", type: "foundation", defaultCheckout: "/repo/main" });
    await act(async () => { responses[1]!.resolve(Response.json({})); }); expect(selected).toEqual(["different-title"]); expect(closes).toBe(1);
  });
});

test("create callback rejection retains saved creation and retries selection/refresh without another create POST", async () => {
  let writes = 0, calls = 0, closes = 0;
  await withDom(async () => { writes++; return Response.json({}); }, async (host, _, render) => {
    await render(<CreateWorkstreamDialog workspaceId="workspace" close={() => closes++} onCreated={async id => { expect(id).toBe("created"); if (++calls === 1) throw new Error("refresh unavailable"); }} />);
    await input(field(host, "Title"), "Created"); await select(field<HTMLSelectElement>(host, "Type"), "issue"); await submit(host);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("created, but the view couldn't refresh"); expect(closes).toBe(0);
    expect(host.querySelector("fieldset")!.disabled).toBe(true); expect(button(host, "Retry opening workstream").disabled).toBe(false);
    await submit(host, 2); expect(writes).toBe(1); expect(calls).toBe(2); expect(closes).toBe(1);
  });
});

test("create rejects invalid custom ID and relative checkout without a mutation", async () => {
  let writes = 0;
  await withDom(async () => { writes++; return Response.json({}); }, async (host, _, render) => {
    await render(<CreateWorkstreamDialog workspaceId="workspace" close={() => {}} onCreated={async () => {}} />);
    await input(field(host, "Title"), "Title"); await select(field<HTMLSelectElement>(host, "Type"), "feature");
    await input(field(host, "Identifier"), "Not Valid"); await submit(host); expect(writes).toBe(0);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("identifier must be");
    await input(field(host, "Identifier"), "valid"); await select(field<HTMLSelectElement>(host, "Default working checkout"), "__absolute_path__");
    await input(field(host, "Absolute checkout path"), "relative/path"); await submit(host); expect(writes).toBe(0);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("absolute checkout path");
  });
});

test.each(["switch", "unmount"])("late successful create after workspace %s does not select, refresh or close old scope", async mode => {
  const pending = deferred(); let changes = 0, closes = 0;
  await withDom(async () => pending.promise, async (host, root, render) => {
    const props = { close: () => closes++, onCreated: async () => { changes++; } };
    await render(<CreateWorkstreamDialog workspaceId="workspace" {...props} />);
    await input(field(host, "Title"), "Old"); await select(field<HTMLSelectElement>(host, "Type"), "maintenance"); await submit(host);
    if (mode === "switch") await render(<CreateWorkstreamDialog workspaceId="new-workspace" {...props} />); else await act(async () => { root.unmount(); });
    await act(async () => { pending.resolve(Response.json({})); });
    expect(changes).toBe(0); expect(closes).toBe(0);
    if (mode === "switch") expect(field(host, "Title").value).toBe("");
  });
});

test("documents group friendly names, registered missing reports remain visible without Open and modified reports open exact path", async () => {
  const value = detail();
  value.research = { registered: [
    { topic: "missing-topic", reportPath: "research/missing-topic/REPORT.md", contentHash: "hash-one", createdAt: timestamp, updatedAt: timestamp, missing: true, modified: false },
    { topic: "modified-topic", reportPath: "research/modified-topic/REPORT.md", contentHash: "hash-two", createdAt: timestamp, updatedAt: timestamp, missing: false, modified: true },
  ], unregistered: ["research/unregistered/notes.md"], warnings: ["Hash mismatch"] };
  const paths = ["README.md", "design/PRD.md", "design/SDD.md", "design/solutions/options/SOLUTION.md", "execution/PLAN.md", "execution/jobs/job-one.md", "execution/reports/job-one.md", "research/modified-topic/REPORT.md", "research/unregistered/notes.md"];
  const opened: unknown[] = [];
  await withDom(async () => Response.json(paths), async (host, _, render) => {
    await render(<WorkstreamDocuments workspaceId="workspace" detail={value} openArtifact={value => opened.push(value)} />);
    expect([...host.querySelectorAll("h4")].map(node => node.textContent)).toEqual(["Design", "Engineering", "Execution", "Research"]);
    expect(host.textContent).toContain("Product requirements"); expect(host.textContent).toContain("Solution specification"); expect(host.textContent).toContain("Execution plan");
    const missing = [...host.querySelectorAll("li")].find(node => node.textContent?.includes("research/missing-topic/REPORT.md"))!;
    expect(missing.textContent).toContain("Missing"); expect(missing.querySelector("button")).toBeNull();
    const modified = [...host.querySelectorAll("li")].find(node => node.textContent?.includes("research/modified-topic/REPORT.md"))!;
    expect(modified.querySelector(".workstream-content-badge")?.textContent).toBe("Modified");
    expect(modified.querySelector("details")!.open).toBe(false); expect(modified.querySelector("details")!.textContent).toContain("hash-two");
    await click(modified.querySelector<HTMLButtonElement>("button")!);
    expect(opened).toEqual([{ workspaceId: "workspace", workstreamId: "alpha", repositoryId, path: "research/modified-topic/REPORT.md" }]);
    const reports = [...host.querySelectorAll("details")].find(node => node.querySelector("summary")?.textContent === "Job reports · 1")!;
    expect(reports.open).toBe(false); expect(host.textContent).toContain("1 missing · 1 modified · 1 unregistered");
  });
});

test("research REPORT.md rows have distinguishable topic-derived surface names", async () => {
  const value = detail();
  value.research.registered = ["deployment-options", "storage-options"].map(topic => ({ topic, reportPath: `research/${topic}/REPORT.md`, contentHash: "hash", createdAt: timestamp, updatedAt: timestamp, missing: false, modified: false }));
  await withDom(async () => Response.json(value.research.registered.map(report => report.reportPath)), async (host, _, render) => {
    await render(<WorkstreamDocuments workspaceId="workspace" detail={value} openArtifact={() => {}} />);
    const names = [...host.querySelectorAll('.workstream-document-group[aria-label="Research documents"] .workstream-document-name')].map(node => node.textContent!);
    expect(names).toHaveLength(2); expect(new Set(names).size, "Both names currently collapse to REPORT.md").toBe(2);
    expect(names[0]!.toLowerCase()).toContain("deployment"); expect(names[1]!.toLowerCase()).toContain("storage");
  });
});

test("document failure hides raw diagnostics in details and retry succeeds; old file response cannot overwrite new scope", async () => {
  const pending = deferred(); let calls = 0;
  await withDom(async (_, init) => {
    const id = JSON.parse(String(init?.body)).id;
    if (id === "alpha" && ++calls === 1) return Response.json({ error: "raw repository path unavailable" }, { status: 503 });
    if (id === "alpha") return pending.promise;
    return Response.json(["design/ISSUE.md"]);
  }, async (host, _, render) => {
    await render(<WorkstreamDocuments workspaceId="workspace" detail={detail()} openArtifact={() => {}} />);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Documents couldn't be loaded");
    expect(host.querySelector("details")!.open).toBe(false); expect(host.querySelector("details")!.textContent).toContain("raw repository path unavailable");
    await click(button(host, "Retry"));
    await render(<WorkstreamDocuments workspaceId="workspace" detail={detail("beta", "Beta")} openArtifact={() => {}} />);
    expect(host.textContent).toContain("Issue brief");
    await act(async () => { pending.resolve(Response.json(["design/PRD.md"])); });
    expect(host.textContent).toContain("Issue brief"); expect(host.textContent).not.toContain("Product requirements");
  });
});

test("default checkout picker changes and clears defaults using only checkout payload, preserving execution pin and lifecycle distinctions", async () => {
  const value = detail(), conversation = row(); value.workstream.defaultCheckout = { ...pin, path: "/repo/main" };
  value.conversations = [conversation.conversation!]; value.activePhases = [assignment(conversation, "design"), assignment(conversation, "research:options")]; value.phaseHistory = value.activePhases;
  const before = structuredClone(value), writes: unknown[] = []; let changed = 0;
  await withDom(async (_, init) => { writes.push(JSON.parse(String(init?.body))); return Response.json({}); }, async (host, _, render) => {
    await render(<WorkstreamDetails workspaceId="workspace" detail={value} close={() => {}} onChanged={async () => { changed++; }} />);
    expect(host.textContent).toContain("Document progress and approval evidence are separate from conversation phase assignments");
    expect(host.textContent).toContain("2 active assignments"); expect(host.textContent).toContain("research:options");
    await click(button(host, "Change default checkout…"));
    const picker = field<HTMLSelectElement>(host, "Default working checkout");
    expect([...picker.options].map(option => option.textContent)).toContain("Primary · main"); expect(picker.value).toBe("/repo/main");
    await select(picker, "/repo/topic"); await submit(host, 2); expect(writes).toEqual([{ id: "alpha", checkout: "/repo/topic" }]); expect(changed).toBe(1);
    await click(button(host, "Change default checkout…")); await click(button(host, "Clear default")); await submit(host);
    expect(writes[1]).toEqual({ id: "alpha", checkout: null }); expect(value).toEqual(before);
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Existing conversations are unchanged");
  });
});

test("checkout save callback failure offers refresh-only retry without repeating mutation and preserves editor", async () => {
  let writes = 0, changes = 0;
  await withDom(async () => { writes++; return Response.json({}); }, async (host, _, render) => {
    await render(<WorkstreamDetails workspaceId="workspace" detail={detail()} close={() => {}} onChanged={async () => { if (++changes === 1) throw new Error("refresh failed"); }} />);
    await click(button(host, "Change default checkout…")); await select(field<HTMLSelectElement>(host, "Default working checkout"), "/repo/topic"); await submit(host);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("saved, but the workstream view couldn't refresh");
    expect(host.querySelector("fieldset")!.disabled).toBe(true); expect(field<HTMLSelectElement>(host, "Default working checkout").value).toBe("/repo/topic");
    await submit(host, 2); expect(writes).toBe(1); expect(changes).toBe(2); expect(host.querySelector("form")).toBeNull();
  });
});

test.each(["switch", "unmount"])("late successful checkout save after %s does not refresh old workspace", async mode => {
  const pending = deferred(); let changes = 0;
  await withDom(async () => pending.promise, async (host, root, render) => {
    const props = { close: () => {}, onChanged: async () => { changes++; } };
    await render(<WorkstreamDetails workspaceId="workspace" detail={detail()} {...props} />);
    await click(button(host, "Change default checkout…")); await submit(host);
    if (mode === "switch") await render(<WorkstreamDetails workspaceId="new-workspace" detail={detail("beta")} {...props} />); else await act(async () => { root.unmount(); });
    await act(async () => { pending.resolve(Response.json({})); }); expect(changes).toBe(0);
  });
});
