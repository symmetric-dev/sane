import { expect, test } from "bun:test";
import { act } from "react";
import { WorkstreamConversations } from "./workstream-conversations";
import { WorkstreamsView } from "./workstreams";
import { admission, appOnly, assignment, button, click, deferred, detail, field, input, overview, repositoryId, row, select, submit, withDom } from "./workstreams.test-utils";

test("conversation Open callback and sending/no App session guards; search and distinct phase filtering", async () => {
  const first = row(), native = row("native", "alpha", null), value = detail();
  value.activePhases = [assignment(first, "design"), assignment(first, "research:deployment"), assignment(native, "execution")];
  const snapshot = overview([first, native], [value]), opened: string[] = [];
  await withDom(async () => Response.json({ sessions: [] }), async (host, _, render) => {
    const props = { overview: snapshot, workspaceId: "workspace", workstreamId: "alpha", onChanged: async () => {}, openConversation: (id: string) => opened.push(id) };
    await render(<WorkstreamConversations {...props} />);
    expect(host.querySelector("dialog")).toBeNull(); expect(host.textContent).not.toContain(repositoryId);
    const openButtons = [...host.querySelectorAll<HTMLButtonElement>("button")].filter(node => node.textContent === "Open");
    expect(openButtons[0]!.disabled).toBe(false); expect(openButtons[1]!.disabled).toBe(true);
    await click(openButtons[0]!); expect(opened).toEqual(["app-one"]);
    await render(<WorkstreamConversations {...props} disabled />); expect(openButtons[0]!.disabled).toBe(true); await click(openButtons[0]!); expect(opened).toHaveLength(1);
    expect(host.querySelector(".workstream-conversations-phases")?.textContent).toContain("DesignResearch · deployment");
    await select(field<HTMLSelectElement>(host, "Active phase"), "execution"); expect(host.querySelectorAll(".workstream-conversations-row")).toHaveLength(1); expect(host.querySelector("h4")?.textContent).toBe("Conversation native");
    await input(field(host, "Search conversations"), "no match"); expect(host.textContent).toContain("No conversations match these filters.");
  });
});

test("picker selects App-only conversation, enrolls before associating, locks duplicate add and preserves pin payload", async () => {
  const candidate = appOnly(), enrolled = deferred(), associated = deferred(), calls: { url: string; body?: unknown }[] = []; let changes = 0;
  await withDom(async (url, init) => {
    if (url === "/api/sessions") return Response.json({ sessions: [{ sessionId: candidate.sessionId, admission: admission(candidate) }] });
    calls.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (url.endsWith("/enroll")) return enrolled.promise;
    if (url.includes("/manage?")) return associated.promise;
    throw new Error(url);
  }, async (host, _, render) => {
    await render(<WorkstreamConversations overview={overview([candidate])} workspaceId="workspace" workstreamId="alpha" onChanged={async () => { changes++; }} />);
    await click(button(host, "Add existing conversation")); const dialog = host.querySelector("dialog")!;
    expect(button(dialog, "Add to workstream").disabled).toBe(true); await click(dialog.querySelector<HTMLInputElement>('input[type="radio"]')!);
    expect(dialog.textContent).toContain("Connection and workstream assignment are separate steps");
    const add = button(dialog, "Connect and add");
    await act(async () => { add.click(); add.click(); }); expect(calls.map(call => call.url)).toEqual(["/api/sessions/app-only/enroll"]); expect(changes).toBe(0);
    await act(async () => { dialog.dispatchEvent(new window.Event("cancel", { bubbles: true, cancelable: true })); }); expect(host.querySelector("dialog")).toBe(dialog);
    await act(async () => { enrolled.resolve(Response.json({})); });
    expect(calls).toHaveLength(2); expect(calls[1]).toEqual({ url: "/api/workstreams/manage?workspaceId=workspace", body: { operation: "associate", ref: candidate.ref, workstreamId: "alpha" } });
    expect(changes).toBe(0); await act(async () => { associated.resolve(Response.json({})); });
    expect(changes).toBe(1); expect(host.querySelector("dialog")).toBeNull();
  });
});

test("already enrolled conversation skips enroll; picker confirms Move from another workstream", async () => {
  const candidate = row("elsewhere", "beta"), calls: { url: string; body: unknown }[] = [];
  await withDom(async (url, init) => {
    if (url === "/api/sessions") return Response.json({ sessions: [] });
    calls.push({ url, body: init?.body && JSON.parse(String(init.body)) }); return Response.json({});
  }, async (host, _, render) => {
    await render(<WorkstreamConversations overview={overview([candidate])} workspaceId="workspace" workstreamId="alpha" onChanged={async () => {}} />);
    await click(button(host, "Add existing conversation")); const dialog = host.querySelector("dialog")!; await click(dialog.querySelector<HTMLInputElement>('input[type="radio"]')!);
    expect(calls).toHaveLength(0); expect(dialog.textContent).toContain("Move from Beta to Alpha?"); expect(dialog.textContent).toContain("ends its current phase assignments and preserves its execution checkout");
    await click(button(dialog, "Move conversation"));
    expect(calls).toEqual([{ url: "/api/workstreams/manage?workspaceId=workspace", body: { operation: "associate", ref: candidate.ref, workstreamId: "alpha" } }]);
  });
});

test("Unassigned destination picker skips enrollment for registered null membership", async () => {
  const candidate = row("unassigned", null), calls: unknown[] = [];
  await withDom(async (url, init) => {
    if (url === "/api/sessions") return Response.json({ sessions: [] }); calls.push({ url, body: JSON.parse(String(init?.body)) }); return Response.json({});
  }, async (host, _, render) => {
    await render(<WorkstreamConversations overview={overview([candidate])} workspaceId="workspace" workstreamId={null} onChanged={async () => {}} />);
    await click(button(host, "Add to workstream")); const dialog = host.querySelector("dialog")!;
    expect(button(dialog, "Add to workstream").disabled).toBe(true); await select(field<HTMLSelectElement>(dialog, "Destination workstream"), "beta"); await click(button(dialog, "Add to workstream"));
    expect(calls).toEqual([{ url: "/api/workstreams/manage?workspaceId=workspace", body: { operation: "associate", ref: candidate.ref, workstreamId: "beta" } }]);
  });
});

test("Remove confirmation only clears membership, warns phases end, never deletes conversation", async () => {
  const candidate = row(), calls: { url: string; method: string | undefined; body: unknown }[] = [];
  await withDom(async (url, init) => {
    if (url === "/api/sessions") return Response.json({ sessions: [] }); calls.push({ url, method: init?.method, body: JSON.parse(String(init?.body)) }); return Response.json({});
  }, async (host, _, render) => {
    await render(<WorkstreamConversations overview={overview([candidate])} workspaceId="workspace" workstreamId="alpha" onChanged={async () => {}} />);
    await click(button(host, "Remove from workstream")); const dialog = host.querySelector("dialog")!;
    expect(calls).toHaveLength(0); expect(dialog.textContent).toContain("does not delete the conversation"); expect(dialog.textContent).toContain("ends current phase assignments"); expect(dialog.textContent).toContain("does not complete or approve lifecycle phases");
    await click(button(dialog, "Remove from workstream"));
    expect(calls).toEqual([{ url: "/api/workstreams/manage?workspaceId=workspace", method: "POST", body: { operation: "associate", ref: candidate.ref, workstreamId: null } }]);
  });
});

test("multiple phase assignments remain distinct, research topic validates, duplicate submission locks, ending targets only selected assignment", async () => {
  const candidate = row(), value = detail(); value.activePhases = [assignment(candidate, "design"), assignment(candidate, "execution")]; value.phaseHistory = value.activePhases;
  const calls: unknown[] = [], responses: ReturnType<typeof deferred>[] = [];
  await withDom(async (url, init) => {
    if (url === "/api/sessions") return Response.json({ sessions: [] }); calls.push(JSON.parse(String(init?.body))); const pending = deferred(); responses.push(pending); return pending.promise;
  }, async (host, _, render) => {
    await render(<WorkstreamConversations overview={overview([candidate], [value])} workspaceId="workspace" workstreamId="alpha" onChanged={async () => {}} />);
    await click(button(host, "Change phase")); const dialog = host.querySelector("dialog")!;
    expect(dialog.querySelectorAll(".workstream-conversation-phase-list li")).toHaveLength(2); expect(button(dialog, "Add phase").disabled).toBe(true);
    await select(field<HTMLSelectElement>(dialog, "Phase"), "research"); await input(field(dialog, "Research topic (optional)"), "NOT valid");
    expect(button(dialog, "Add phase").disabled).toBe(true); await submit(dialog); expect(calls).toHaveLength(0);
    await input(field(dialog, "Research topic (optional)"), "deployment-options"); await submit(dialog, 2);
    expect(calls).toEqual([{ operation: "phase/assign", ref: candidate.ref, phase: "research:deployment-options" }]);
    await act(async () => { responses[0]!.resolve(Response.json({})); }); expect(host.querySelector("dialog")).toBe(dialog);
    await input(field(dialog, "Research topic (optional)"), ""); await submit(dialog); expect(calls[1]).toEqual({ operation: "phase/assign", ref: candidate.ref, phase: "research" });
    await act(async () => { responses[1]!.resolve(Response.json({})); });
    await click(dialog.querySelector<HTMLButtonElement>(".workstream-conversation-phase-list li button")!); expect(dialog.textContent).toContain("Other assignments remain active");
    await click(button(dialog, "Confirm end assignment")); expect(calls[2]).toEqual({ operation: "phase/end", ref: candidate.ref, assignmentId: "design" });
    await act(async () => { responses[2]!.resolve(Response.json({})); }); expect(value.activePhases).toHaveLength(2); expect(host.querySelector("dialog")).toBe(dialog);
  });
});

test("partial enrollment success then associate failure keeps dialog through overview refresh and retry skips enroll", async () => {
  const candidate = appOnly(), calls: string[] = []; let associates = 0, changes = 0;
  await withDom(async (url) => {
    if (url === "/api/sessions") return Response.json({ sessions: [{ sessionId: candidate.sessionId, admission: admission(candidate) }] });
    calls.push(url); if (url.endsWith("/enroll")) return Response.json({});
    if (url.includes("/manage?")) return ++associates === 1 ? Response.json({ error: "membership unavailable" }, { status: 503 }) : Response.json({});
    throw new Error(url);
  }, async (host, _, render) => {
    const props = { workspaceId: "workspace", workstreamId: "alpha", onChanged: async () => { changes++; } };
    await render(<WorkstreamConversations {...props} overview={overview([candidate])} />);
    await click(button(host, "Add existing conversation")); const dialog = host.querySelector("dialog")!; await click(dialog.querySelector<HTMLInputElement>('input[type="radio"]')!); await click(button(dialog, "Connect and add"));
    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe("Connected to repository, but not added to workstream. Retry adding it."); expect(changes).toBe(1);
    await render(<WorkstreamConversations {...props} overview={overview([candidate])} />); expect(host.querySelector("dialog")).toBe(dialog);
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("not added to workstream");
    await click(button(dialog, "Add to workstream")); expect(calls).toEqual(["/api/sessions/app-only/enroll", "/api/workstreams/manage?workspaceId=workspace", "/api/workstreams/manage?workspaceId=workspace"]); expect(changes).toBe(2); expect(host.querySelector("dialog")).toBeNull();
  });
});

test("failed pending admission performs status GET and requires explicit retry-admission before associate", async () => {
  const candidate = appOnly(), calls: string[] = []; let metadataReads = 0, pending = false;
  await withDom(async url => {
    if (url === "/api/sessions") { metadataReads++; return Response.json({ sessions: [{ sessionId: candidate.sessionId, admission: admission(candidate, pending ? "identity_known" : "ready") }] }); }
    calls.push(url);
    if (url.endsWith("/enroll")) { pending = true; return Response.json({ error: "native busy" }, { status: 409 }); }
    if (url.endsWith("/retry-admission")) return Response.json({ admission: admission(candidate, "ready", "repository") });
    if (url.includes("/manage?")) return Response.json({});
    throw new Error(url);
  }, async (host, _, render) => {
    await render(<WorkstreamConversations overview={overview([candidate])} workspaceId="workspace" workstreamId="alpha" onChanged={async () => {}} />);
    await click(button(host, "Add existing conversation")); const dialog = host.querySelector("dialog")!; await click(dialog.querySelector<HTMLInputElement>('input[type="radio"]')!); await click(button(dialog, "Connect and add"));
    expect(metadataReads).toBe(3); expect(calls).toEqual(["/api/sessions/app-only/enroll"]);
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("Connection is pending"); expect(button(dialog, "Connect and add").disabled).toBe(true);
    await click(button(dialog, "Retry connection and add"));
    expect(metadataReads).toBe(4); expect(calls).toEqual(["/api/sessions/app-only/enroll", "/api/sessions/app-only/retry-admission", "/api/workstreams/manage?workspaceId=workspace"]); expect(host.querySelector("dialog")).toBeNull();
  });
});

test("unavailable sessions status starts no enrollment; Check connection status unlocks safe retry", async () => {
  const candidate = appOnly(); let offline = true, writes = 0;
  await withDom(async url => {
    if (url === "/api/sessions") return offline ? Response.json({ error: "sessions offline" }, { status: 503 }) : Response.json({ sessions: [{ sessionId: candidate.sessionId, admission: admission(candidate) }] });
    writes++; return Response.json({});
  }, async (host, _, render) => {
    await render(<WorkstreamConversations overview={overview([candidate])} workspaceId="workspace" workstreamId="alpha" onChanged={async () => {}} />);
    await click(button(host, "Add existing conversation")); const dialog = host.querySelector("dialog")!; await click(dialog.querySelector<HTMLInputElement>('input[type="radio"]')!); await click(button(dialog, "Connect and add"));
    expect(writes).toBe(0); expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("no enrollment was started");
    offline = false; await click(button(dialog, "Check connection status")); expect(writes).toBe(0); expect(dialog.textContent).toContain("Ready to connect");
    await click(button(dialog, "Connect and add")); expect(writes).toBe(2);
  });
});

test("different repository admission fails safely without enrollment", async () => {
  const candidate = appOnly(); let writes = 0;
  const record = admission(candidate); record.binding.workspaceId = "other-workspace";
  await withDom(async url => { if (url === "/api/sessions") return Response.json({ sessions: [{ sessionId: candidate.sessionId, admission: record }] }); writes++; return Response.json({}); }, async (host, _, render) => {
    await render(<WorkstreamConversations overview={overview([candidate])} workspaceId="workspace" workstreamId="alpha" onChanged={async () => {}} />);
    await click(button(host, "Add existing conversation")); const dialog = host.querySelector("dialog")!; await click(dialog.querySelector<HTMLInputElement>('input[type="radio"]')!); await click(button(dialog, "Connect and add"));
    expect(writes).toBe(0); expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("different repository");
  });
});

test.each(["workspace", "workstream", "unmount"])("late enrollment after %s change does not associate or refresh old scope", async mode => {
  const candidate = appOnly(), pending = deferred(); const calls: string[] = []; let changes = 0;
  await withDom(async url => {
    if (url === "/api/sessions") return Response.json({ sessions: [{ sessionId: candidate.sessionId, admission: admission(candidate) }] }); calls.push(url); return pending.promise;
  }, async (host, root, render) => {
    const props = { overview: overview([candidate]), onChanged: async () => { changes++; } };
    await render(<WorkstreamConversations {...props} workspaceId="workspace" workstreamId="alpha" />);
    await click(button(host, "Add existing conversation")); await click(host.querySelector<HTMLInputElement>('dialog input[type="radio"]')!); await click(button(host.querySelector("dialog")!, "Connect and add"));
    expect(calls).toEqual(["/api/sessions/app-only/enroll"]);
    if (mode === "unmount") await act(async () => { root.unmount(); }); else await render(<WorkstreamConversations {...props} workspaceId={mode === "workspace" ? "other" : "workspace"} workstreamId={mode === "workstream" ? "beta" : "alpha"} />);
    await act(async () => { pending.resolve(Response.json({})); }); expect(calls).toHaveLength(1); expect(changes).toBe(0); expect(host.querySelector("dialog")).toBeNull();
  });
});

test("late association after selection switch does not dismiss newer modal or refresh old scope", async () => {
  const candidate = row("candidate", null), pending = deferred(); let changes = 0;
  await withDom(async url => url === "/api/sessions" ? Response.json({ sessions: [] }) : pending.promise, async (host, _, render) => {
    const props = { overview: overview([candidate]), workspaceId: "workspace", onChanged: async () => { changes++; } };
    await render(<WorkstreamConversations {...props} workstreamId="alpha" />);
    await click(button(host, "Add existing conversation")); await click(host.querySelector<HTMLInputElement>('dialog input[type="radio"]')!); await click(button(host.querySelector("dialog")!, "Add to workstream"));
    await render(<WorkstreamConversations {...props} workstreamId="beta" />); expect(host.querySelector("dialog")).toBeNull();
    await act(async () => { pending.resolve(Response.json({})); }); expect(changes).toBe(0);
    await click(button(host, "Add existing conversation")); expect(host.querySelector("dialog")?.textContent).toContain("Beta");
  });
});

test("integration: main retains same organizer across workstream switches but cancels old modal scope", async () => {
  const candidate = appOnly(), pending = deferred(); const calls: string[] = [];
  await withDom(async url => {
    if (url.includes("/inspect?")) return Response.json({ state: "ready" }); if (url.includes("/overview?")) return Response.json(overview([candidate]));
    if (url === "/api/sessions") return Response.json({ sessions: [{ sessionId: candidate.sessionId, admission: admission(candidate) }] }); calls.push(url); return pending.promise;
  }, async (host, _, render) => {
    await render(<WorkstreamsView workspaceId="workspace" />); await click(button(host, "Add existing conversation")); await click(host.querySelector<HTMLInputElement>('dialog input[type="radio"]')!); await click(button(host.querySelector("dialog")!, "Connect and add"));
    await click(host.querySelectorAll<HTMLButtonElement>(".workstreams-list button")[1]!); expect(host.querySelector("dialog")).toBeNull();
    await act(async () => { pending.resolve(Response.json({})); }); expect(calls).toEqual(["/api/sessions/app-only/enroll"]); expect(host.querySelector(".workstreams-content-header h3")?.textContent).toBe("Beta");
  });
});

test("leaving a workstream then returning before old enrollment resolves does not revive its stale mutation", async () => {
  const candidate = appOnly(), pending = deferred(); const calls: string[] = []; let changes = 0;
  await withDom(async url => {
    if (url === "/api/sessions") return Response.json({ sessions: [{ sessionId: candidate.sessionId, admission: admission(candidate) }] });
    calls.push(url); return url.endsWith("/enroll") ? pending.promise : Response.json({});
  }, async (host, _, render) => {
    const props = { overview: overview([candidate]), workspaceId: "workspace", onChanged: async () => { changes++; } };
    await render(<WorkstreamConversations {...props} workstreamId="alpha" />);
    await click(button(host, "Add existing conversation")); await click(host.querySelector<HTMLInputElement>('dialog input[type="radio"]')!); await click(button(host.querySelector("dialog")!, "Connect and add"));
    await render(<WorkstreamConversations {...props} workstreamId="beta" />);
    await render(<WorkstreamConversations {...props} workstreamId="alpha" />);
    expect(host.querySelector("dialog")).toBeNull();
    await act(async () => { pending.resolve(Response.json({})); });
    expect(calls, "Old enrollment must not associate merely because the selected ID matches again").toEqual(["/api/sessions/app-only/enroll"]);
    expect(changes).toBe(0);
  });
});

test("integration: conversation dialog survives root refresh and retains newer association error", async () => {
  const candidate = row("unassigned", null), pending = deferred(); let reads = 0;
  await withDom(async url => {
    if (url.includes("/inspect?")) return Response.json({ state: "ready" }); if (url.includes("/overview?")) return ++reads === 1 ? Response.json(overview([candidate])) : pending.promise;
    if (url === "/api/sessions") return Response.json({ sessions: [] }); return Response.json({ error: "assignment unavailable" }, { status: 503 });
  }, async (host, _, render) => {
    await render(<WorkstreamsView workspaceId="workspace" />); await click(button(host, "Refresh")); await click(button(host, "Add existing conversation"));
    const dialog = host.querySelector("dialog")!; await click(dialog.querySelector<HTMLInputElement>('input[type="radio"]')!); await click(button(dialog, "Add to workstream"));
    const issue = dialog.querySelector('[role="alert"]')?.textContent; expect(issue).toContain("Could not add this conversation");
    await act(async () => { pending.resolve(Response.json(overview([candidate]))); });
    expect(host.querySelector("dialog")).toBe(dialog); expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(issue);
  });
});
