import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import { useMessageHits, usePreviewRuns } from "./conversation-hooks";

async function withDOM(run: (render: (node: ReactNode) => Promise<void>) => Promise<void>) {
  const browser = new Window({ url: "http://localhost" });
  const globals = { window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client");
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try { await run(async node => { await act(async () => root.render(node)); }); }
  finally {
    await act(async () => root.unmount()); browser.close();
    for (const [key, descriptor] of prior) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}

test("preview results never show another session's runs, model or effort, even before effects", async () => {
  const priorFetch = globalThis.fetch;
  const pending = new Map<string, (response: Response) => void>();
  // Deliberately ignore abort to exercise the response fence, not just browser cancellation.
  globalThis.fetch = ((url: RequestInfo | URL) => new Promise<Response>(resolve => pending.set(String(url), resolve))) as typeof fetch;
  try {
    await withDOM(async render => {
      type Result = ReturnType<typeof usePreviewRuns>;
      const snapshots: { id: string | null; result: Result }[] = [];
      let result!: Result;
      function Probe({ id }: { id: string | null }) { result = usePreviewRuns(id); snapshots.push({ id, result }); return null; }
      const resolveRuns = async (id: string, model: string) => {
        await act(async () => pending.get(`/api/sessions/${id}/runs`)!(Response.json({ runs: [{ runId: `run-${id}`, status: "completed", createdAt: "2026-09-30", model, effort: `effort-${id}` }] })));
      };
      await render(<Probe id="a" />);
      await resolveRuns("a", "model-a");
      expect(result.runs[0]?.model).toBe("model-a");
      await render(<Probe id="b" />);
      expect(result.runs).toEqual([]); expect(result.loading).toBe(true);
      expect(snapshots.filter(s => s.id === "b").every(s => s.result.runs.length === 0 && s.result.loading)).toBe(true);
      await render(<Probe id="c" />);
      await resolveRuns("b", "late-model-b");
      expect(result.runs).toEqual([]); expect(result.loading).toBe(true);
      await resolveRuns("c", "model-c");
      expect(result.runs[0]?.model).toBe("model-c"); expect(result.runs[0]?.effort).toBe("effort-c");
      await render(<Probe id={null} />);
      expect(result).toEqual({ runs: [], loading: false, error: "" });
    });
  } finally { globalThis.fetch = priorFetch; }
});

test("message hits are scope-keyed and a shortened query fences late responses", async () => {
  const priorFetch = globalThis.fetch;
  const pending: { url: string; resolve: (response: Response) => void }[] = [];
  globalThis.fetch = ((url: RequestInfo | URL) => new Promise<Response>(resolve => pending.push({ url: String(url), resolve }))) as typeof fetch;
  try {
    await withDOM(async render => {
      let hits: ReturnType<typeof useMessageHits> = [];
      const snapshots: { workspace: string; hits: typeof hits }[] = [];
      function Probe({ query, workspace }: { query: string; workspace: string }) { hits = useMessageHits(query, workspace, "all"); snapshots.push({ workspace, hits }); return null; }
      const waitForDebounce = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); }); };
      await render(<Probe query="alpha" workspace="ws-a" />);
      await waitForDebounce();
      await act(async () => pending[0]!.resolve(Response.json({ results: [{ sessionId: "a", snippet: "match a", score: 1 }] })));
      expect(hits[0]?.sessionId).toBe("a");
      await render(<Probe query="alpha" workspace="ws-b" />);
      expect(hits).toEqual([]);
      expect(snapshots.filter(s => s.workspace === "ws-b").every(s => !s.hits.length)).toBe(true);
      await waitForDebounce();
      expect(pending[1]!.url).toContain("workspaceId=ws-b");
      await render(<Probe query="a" workspace="ws-b" />);
      await act(async () => pending[1]!.resolve(Response.json({ results: [{ sessionId: "late-b", snippet: "late", score: 1 }] })));
      expect(hits).toEqual([]);
      await render(<Probe query="alpha" workspace="ws-b" />);
      expect(hits).toEqual([]);
    });
  } finally { globalThis.fetch = priorFetch; }
});
