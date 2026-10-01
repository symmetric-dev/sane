import { expect, spyOn, test } from "bun:test";
import { act } from "react";
import { WorkstreamArtifact } from "./workstream-artifact";
import * as editor from "./workspace-editor";
import { button, click, deferred, repositoryId, withDom } from "./workstreams.test-utils";

test("artifact reads exact selection into read-only editor, hides identities/paths and error diagnostics in disclosures", async () => {
  const selections: unknown[] = []; let closes = 0, failed = false;
  const readOnly = spyOn(editor, "ReadOnlyDocument").mockImplementation(({ path, text }) => <div aria-label="Mock read-only editor" data-path={path}>{text}</div>);
  try {
    await withDom(async (url, init) => {
      selections.push({ url, body: JSON.parse(String(init?.body)) });
      return failed ? Response.json({ error: "raw /repo/secret.md failed" }, { status: 503 }) : Response.json({ content: "# Artifact text" });
    }, async (host, _, render) => {
      const artifact = { workspaceId: "workspace", workstreamId: "alpha", path: "research/topic/REPORT.md", repositoryId };
      await render(<WorkstreamArtifact artifact={artifact} close={() => closes++} />);
      expect(selections).toEqual([{ url: "/api/workstreams/artifacts/read?workspaceId=workspace", body: { id: "alpha", path: "research/topic/REPORT.md" } }]);
      expect(readOnly).toHaveBeenCalled(); expect(host.querySelector('[aria-label="Mock read-only editor"]')?.textContent).toBe("# Artifact text");
      expect(host.querySelector("strong")?.textContent).toBe("REPORT.md"); expect(host.querySelector("details")!.open).toBe(false); expect(host.querySelector("details")!.textContent).toContain(repositoryId);
      const surface = [...host.querySelector(".artifact-context")!.children].filter(node => node.tagName !== "DETAILS").map(node => node.textContent).join("");
      expect(surface).not.toContain(repositoryId); expect(surface).not.toContain("research/topic/REPORT.md");
      failed = true; await click(button(host, "Reload document"));
      expect(host.querySelector('[role="alert"]')?.textContent).toBe("This document could not be loaded. Try reloading it.");
      const diagnostics = host.querySelector<HTMLDetailsElement>(".workspace-error details")!; expect(diagnostics.open).toBe(false); expect(diagnostics.textContent).toContain("raw /repo/secret.md failed");
      failed = false; await click(button(host, "Reload document")); expect(host.querySelector('[role="alert"]')).toBeNull();
      await click(button(host, "Close document")); expect(closes).toBe(1);
    });
  } finally { readOnly.mockRestore(); }
});

test("late artifact read never overwrites a different selected artifact", async () => {
  const pending = deferred();
  const readOnly = spyOn(editor, "ReadOnlyDocument").mockImplementation(({ text }) => <div aria-label="Mock read-only editor">{text}</div>);
  try {
    await withDom(async (_, init) => JSON.parse(String(init?.body)).id === "alpha" ? pending.promise : Response.json({ content: "New content" }), async (host, _, render) => {
      const artifact = { workspaceId: "workspace", workstreamId: "alpha", path: "README.md", repositoryId };
      await render(<WorkstreamArtifact artifact={artifact} close={() => {}} />);
      await render(<WorkstreamArtifact artifact={{ ...artifact, workstreamId: "beta" }} close={() => {}} />);
      await act(async () => { pending.resolve(Response.json({ content: "Stale content" })); });
      expect(host.querySelector('[aria-label="Mock read-only editor"]')?.textContent).toBe("New content"); expect(host.textContent).not.toContain("Stale content");
    });
  } finally { readOnly.mockRestore(); }
});
