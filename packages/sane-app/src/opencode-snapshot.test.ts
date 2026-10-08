import { expect, spyOn, test } from "bun:test";
import { isQueuedHandoffAdmission, OpenCodeAdapter, OpenCodeCommandProtocolError, OpenCodeError, OpenCodeQueuedHandoffProtocolError, OpenCodeSourceMismatchError, OpenCodeUnavailableError, type NativeMessage } from "./opencode";
import { createDispatchEvidence } from "./dispatch-evidence";
import { createOpenCodeDispatchAdapter, DispatchProofUnavailableError, HarnessDispatchRegistry, type DispatchLifecycleHooks } from "./harness-dispatch";
import type { DispatchSource } from "../shared/conversation/dispatch-contract";
import type { RunOwner } from "./run-owner";

const message = (id: string, type: string, outcome?: string): NativeMessage => ({ id, type, time: { created: 1 }, ...(outcome ? { outcome } : {}) });
for (const [app, external] of [["failed", "succeeded"], ["succeeded", "failed"]]) test(`App ${app} is not relabeled by later external ${external}`, async () => {
  const adapter = new OpenCodeAdapter("http://127.0.0.1:1");
  const history = [message("msg_app", "user"), message("answer_app", "assistant"), message("idle_app", "idle", app), message("msg_external", "user"), message("answer_external", "assistant"), message("idle_external", "idle", external)];
  adapter.request = async (path: string) => {
    if (path.includes("/message?")) return { data: [...history].reverse(), cursor: {} } as any;
    if (path.endsWith("/active")) return { data: { ses_fixture: { type: "running" } } } as any; // Yet another external turn may already be running.
    if (path.endsWith("/inbox")) return { data: [] } as any;
    return { data: { id: "ses_fixture", location: { directory: "/fixture" }, outcome: external, time: { created: 0, updated: 3, idle: 3 } } } as any;
  };
  const snapshot = await adapter.snapshot("ses_fixture", "msg_app", "/fixture");
  expect(snapshot.outcome).toBe(app);
  expect(snapshot.messages.map(m => m.id)).toEqual(["msg_app", "answer_app", "idle_app"]);
});

test("ambiguous or missing command boundaries never fall back to the latest session outcome", async () => {
  const adapter = new OpenCodeAdapter("http://127.0.0.1:1");
  let history = [message("msg_app", "user"), message("msg_external", "user"), message("idle_external", "idle", "succeeded")];
  adapter.request = async (path: string) => {
    if (path.includes("/message?")) return { data: [...history].reverse(), cursor: {} } as any;
    if (path.endsWith("/active")) return { data: {} } as any;
    if (path.endsWith("/inbox")) return { data: [] } as any;
    return { data: { id: "ses_fixture", time: { created: 0, updated: 2, idle: 2 }, outcome: "succeeded" } } as any;
  };
  expect(await adapter.snapshot("ses_fixture", "msg_app")).toMatchObject({ outcome: undefined, messages: [history[0]] });
  history = [message("msg_app", "user"), message("idle_app", "idle")];
  expect((await adapter.snapshot("ses_fixture", "msg_app")).outcome).toBeUndefined();
  history = [message("idle_external", "idle", "succeeded")];
  expect(await adapter.snapshot("ses_fixture", "msg_app")).toMatchObject({ outcome: undefined, messages: [] });
});

for (const field of ["identity", "directory"]) for (const observation of [1, 2]) test(`exact snapshot types ${field} mismatch at source observation ${observation}`, async () => {
  const adapter = new OpenCodeAdapter("http://127.0.0.1:1");
  let reads = 0;
  adapter.request = async (path: string) => {
    if (path.includes("/message?")) return { data: [message("msg_app", "user")], cursor: {} } as any;
    if (path.endsWith("/active")) return { data: {} } as any;
    if (path.endsWith("/inbox")) return { data: [] } as any;
    const drift = ++reads === observation;
    return { data: { id: drift && field === "identity" ? "ses_other" : "ses_fixture", location: { directory: drift && field === "directory" ? "/other" : "/fixture" }, time: { created: 1, updated: 2 } } } as any;
  };
  await expect(adapter.snapshot("ses_fixture", "msg_app", "/fixture")).rejects.toBeInstanceOf(OpenCodeSourceMismatchError);
  expect(reads).toBe(observation);
});

for (const foreign of ["before-anchor", "between-anchor-and-terminal"] as const) test(`handoff snapshot foreign ${foreign} never borrows a different turn's completion`, async () => {
  const adapter = new OpenCodeAdapter("http://127.0.0.1:1");
  const external = [message("msg_foreign", "user"), message("idle_foreign", "idle", "succeeded")];
  const command = message("msg_app", "user");
  const history = foreign === "before-anchor" ? [...external, command, message("idle_app", "idle", "failed")]
    : [command, external[0]!, message("answer_foreign", "assistant"), external[1]!];
  adapter.request = async <T>(path: string): Promise<T> => {
    if (path.includes("/message?")) return { data: [...history].reverse(), cursor: {} } as T;
    if (path.endsWith("/active")) return { data: {} } as T;
    if (path.endsWith("/inbox")) return { data: [] } as T;
    return { data: { id: "ses_fixture", location: { directory: "/fixture" }, outcome: "succeeded", time: { created: 0, updated: 4, idle: 4 } } } as T;
  };
  const snapshot = await adapter.snapshot("ses_fixture", "msg_app", "/fixture", "native-queued-handoff");
  expect(snapshot.outcome).toBe(foreign === "before-anchor" ? "failed" : undefined);
  expect(snapshot.messages[0]?.id).toBe("msg_app");
  if (foreign === "between-anchor-and-terminal") expect(snapshot.boundary).toEqual({ messageId: "msg_foreign", type: "user" });
});

test("handoff pending projection preserves exact source, actual delivery, time and payload without walking foreign inbox/history", async () => {
  const adapter = new OpenCodeAdapter("http://127.0.0.1:1"); let historyReads = 0;
  const exact = { id: "msg_app", sessionID: "ses_fixture", type: "user", delivery: "queue", time: { created: 8 }, payload: { text: "App head", metadata: { fixture: true } } };
  const inbox = [{ ...exact, id: "msg_foreign_before" }, exact, { ...exact, id: "msg_foreign_after" }];
  adapter.request = async <T>(path: string): Promise<T> => {
    if (path.includes("/message?")) { historyReads++; throw new Error("pending must not walk history"); }
    if (path.endsWith("/inbox")) return { data: inbox } as T;
    return { data: { id: "ses_fixture", location: { directory: "/fixture" }, time: { created: 0, updated: 4 } } } as T;
  };
  const before = structuredClone(inbox);
  expect(await adapter.snapshot("ses_fixture", "msg_app", "/fixture", "native-queued-handoff")).toEqual({ messages: [], pending: true, pendingInput: exact });
  expect(inbox).toEqual(before); expect(historyReads).toBe(0);
});

for (const phase of ["initial", "after history"] as const) for (const defect of ["malformed", "duplicate"] as const) {
  test(`strict snapshot refuses ${defect} inbox entry ${phase}`, async () => {
    const adapter = new OpenCodeAdapter("http://127.0.0.1:1"); let reads = 0;
    adapter.request = async <T>(path: string): Promise<T> => {
      if (path.endsWith("/inbox")) {
        const current = ++reads === (phase === "initial" ? 1 : 2);
        const exact = { id: "msg_app", sessionID: "ses_fixture", type: "user", delivery: "queue", time: { created: 8 } };
        return { data: current ? [exact, defect === "malformed" ? { id: 7 } : { ...exact }] : [] } as T;
      }
      if (path.includes("/message?")) return { data: [message("msg_app", "user"), message("idle_app", "idle", "succeeded")].reverse(), cursor: {} } as T;
      if (path.endsWith("/active")) return { data: {} } as T;
      return { data: { id: "ses_fixture", location: { directory: "/fixture" }, time: { created: 0, updated: 4 } } } as T;
    };
    await expect(adapter.snapshot("ses_fixture", "msg_app", "/fixture", "native-queued-handoff")).rejects.toBeInstanceOf(OpenCodeCommandProtocolError);
    expect(reads).toBe(phase === "initial" ? 1 : 2);
    reads = 0;
    expect((await adapter.observeCommand("ses_fixture", "msg_app", "/fixture", "native-queued-handoff")).observation.kind).toBe("protocol-contradiction");
  });
}

for (const placement of ["same page", "older page"] as const) test(`duplicate exact command on ${placement} cannot prove a terminal`, async () => {
  const adapter = new OpenCodeAdapter("http://127.0.0.1:1"); const pages: string[] = [];
  const newer = [message("idle_app", "idle", "succeeded"), message("msg_app", "user")];
  adapter.request = async <T>(path: string): Promise<T> => {
    if (path.includes("/message?")) {
      pages.push(path);
      if (pages.length === 1) return { data: placement === "same page" ? [...newer, message("msg_app", "user")] : newer,
        cursor: placement === "same page" ? {} : { next: "older" } } as T;
      expect(path).toContain("cursor=older");
      return { data: [message("msg_app", "user")], cursor: {} } as T;
    }
    if (path.endsWith("/active")) return { data: {} } as T;
    if (path.endsWith("/inbox")) return { data: [] } as T;
    return { data: { id: "ses_fixture", location: { directory: "/fixture" }, time: { created: 0, updated: 4 } } } as T;
  };
  await expect(adapter.snapshot("ses_fixture", "msg_app", "/fixture", "native-queued-handoff")).rejects.toBeInstanceOf(OpenCodeCommandProtocolError);
  pages.length = 0;
  expect(await adapter.observeCommand("ses_fixture", "msg_app", "/fixture", "native-queued-handoff")).toMatchObject({
    messages: [], pending: false, observation: { kind: "protocol-contradiction" },
  });
  expect(pages).toHaveLength(placement === "same page" ? 1 : 2);
});

test("exact command with older paginated history retains its terminal projection", async () => {
  const adapter = new OpenCodeAdapter("http://127.0.0.1:1"); let pages = 0;
  adapter.request = async <T>(path: string): Promise<T> => {
    if (path.includes("/message?")) return ++pages === 1
      ? { data: [message("idle_app", "idle", "succeeded"), message("msg_app", "user")], cursor: { next: "older" } } as T
      : { data: [message("msg_previous", "user")], cursor: {} } as T;
    if (path.endsWith("/active")) return { data: {} } as T;
    if (path.endsWith("/inbox")) return { data: [] } as T;
    return { data: { id: "ses_fixture", location: { directory: "/fixture" }, time: { created: 0, updated: 4 } } } as T;
  };
  expect(await adapter.observeCommand("ses_fixture", "msg_app", "/fixture", "native-queued-handoff")).toMatchObject({
    messages: [message("msg_app", "user"), message("idle_app", "idle", "succeeded")], observation: { kind: "exact-terminal", outcome: "succeeded" },
  });
  expect(pages).toBe(2);
});

test("an exact terminal does not bypass the older history page budget", async () => {
  const adapter = new OpenCodeAdapter("http://127.0.0.1:1"); let pages = 0;
  adapter.request = async <T>(path: string): Promise<T> => {
    if (path.includes("/message?")) return { data: ++pages === 1
      ? [message("idle_app", "idle", "succeeded"), message("msg_app", "user")]
      : [message(`msg_older_${pages}`, "assistant")], cursor: { next: `older_${pages}` } } as T;
    if (path.endsWith("/active")) return { data: {} } as T;
    if (path.endsWith("/inbox")) return { data: [] } as T;
    return { data: { id: "ses_fixture", location: { directory: "/fixture" }, time: { created: 0, updated: 4 } } } as T;
  };
  expect((await adapter.observeCommand("ses_fixture", "msg_app", "/fixture", "native-queued-handoff")).observation.kind).toBe("unavailable");
  expect(pages).toBe(100);
});

test("instruction discovery preserves exact handoff command while unevidenced synthetic context fences terminal attribution", async () => {
  const adapter = new OpenCodeAdapter("http://127.0.0.1:1");
  const command = message("msg_app", "user"), context = { ...message("msg_context", "synthetic"), metadata: { instruction: { paths: ["/fixture/AGENTS.md"] } } };
  let history = [command, context, message("idle_app", "idle", "succeeded")];
  adapter.request = async <T>(path: string): Promise<T> => {
    if (path.includes("/message?")) return { data: [...history].reverse(), cursor: {} } as T;
    if (path.endsWith("/active")) return { data: {} } as T;
    if (path.endsWith("/inbox")) return { data: [] } as T;
    return { data: { id: "ses_fixture", location: { directory: "/fixture" }, time: { created: 0, updated: 4 } } } as T;
  };
  expect((await adapter.snapshot("ses_fixture", "msg_app", "/fixture", "native-queued-handoff")).outcome).toBe("succeeded");
  history = [command, { ...context, metadata: { instruction: { paths: [] } } }, message("idle_app", "idle", "succeeded")];
  expect(await adapter.snapshot("ses_fixture", "msg_app", "/fixture", "native-queued-handoff")).toMatchObject({ outcome: undefined, boundary: { messageId: "msg_context", type: "synthetic" } });
});

test("typed command observations fence metadata-free synthetic before a later successful idle", async () => {
  const adapter = new OpenCodeAdapter("http://127.0.0.1:1");
  let history = [message("msg_app", "user"), message("msg_foreign", "synthetic"), message("msg_final", "assistant"), message("idle_foreign", "idle", "succeeded")];
  adapter.request = async <T>(path: string): Promise<T> => {
    if (path.includes("/message?")) return { data: [...history].reverse(), cursor: {} } as T;
    if (path.endsWith("/active")) return { data: {} } as T;
    if (path.endsWith("/inbox")) return { data: [] } as T;
    return { data: { id: "ses_fixture", location: { directory: "/fixture" }, outcome: "succeeded", time: { created: 0, updated: 4, idle: 4 } } } as T;
  };
  expect((await adapter.observeCommand("ses_fixture", "msg_app", "/fixture", "native-queued-handoff")).observation).toEqual({ kind: "foreign-boundary", boundary: { messageId: "msg_foreign", type: "synthetic" } });
  history = [message("msg_app", "user"), message("idle_app", "idle", "failed")];
  expect((await adapter.observeCommand("ses_fixture", "msg_app", "/fixture", "native-queued-handoff")).observation).toEqual({ kind: "exact-terminal", outcome: "failed" });
  history = [message("msg_app", "user"), message("idle_app", "idle")];
  expect((await adapter.observeCommand("ses_fixture", "msg_app", "/fixture", "native-queued-handoff")).observation).toEqual({ kind: "termination-uncertain" });
  history = [message("msg_app", "synthetic"), message("idle_app", "idle", "succeeded")];
  expect((await adapter.observeCommand("ses_fixture", "msg_app", "/fixture", "native-queued-handoff")).observation).toMatchObject({ kind: "protocol-contradiction" });
});

test("typed observation distinguishes invalid original queue receipt from unavailable read", async () => {
  const adapter = new OpenCodeAdapter("http://127.0.0.1:1");
  adapter.request = async <T>(path: string): Promise<T> => path.endsWith("/inbox")
    ? { data: [{ id: "msg_app", sessionID: "ses_fixture", type: "user", delivery: "steer", time: { created: 8 } }] } as T
    : { data: { id: "ses_fixture", location: { directory: "/fixture" }, time: { created: 0, updated: 4 } } } as T;
  expect((await adapter.observeCommand("ses_fixture", "msg_app", "/fixture", "native-queued-handoff")).observation).toMatchObject({ kind: "protocol-contradiction" });
  adapter.request = async () => { throw new OpenCodeUnavailableError("Disconnected"); };
  expect((await adapter.observeCommand("ses_fixture", "msg_app", "/fixture", "native-queued-handoff")).observation).toEqual({ kind: "unavailable", reason: "Disconnected" });
});

test("strict pending cancellation rechecks native queue receipt before DELETE", async () => {
  const adapter = new OpenCodeAdapter("http://127.0.0.1:1"); let deletes = 0;
  adapter.request = async <T>(_path: string, method = "GET"): Promise<T> => {
    if (method === "DELETE") deletes++;
    return { data: [{ id: "msg_app", sessionID: "ses_fixture", type: "user", delivery: "steer", time: { created: 8 } }] } as T;
  };
  await expect(adapter.cancelInput("ses_fixture", "msg_app", undefined, "native-queued-handoff")).rejects.toMatchObject({ status: 409 });
  expect(deletes).toBe(0);
});

test("offline HTTP rejection preserves generic 409 but explicitly types service unavailability", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => new Response(null, { status: new URL(request.url).pathname === "/busy" ? 503 : 409 }) });
  const adapter = new OpenCodeAdapter(`http://127.0.0.1:${server.port}`);
  try {
    const conflict = await adapter.request("/conflict").catch(error => error);
    if (!(conflict instanceof OpenCodeError)) throw new Error("Expected HTTP conflict error");
    expect(conflict.constructor).toBe(OpenCodeError); expect(conflict.status).toBe(409);
    await expect(adapter.request("/busy")).rejects.toBeInstanceOf(OpenCodeUnavailableError);
  } finally { await server.stop(true); }
});

test("offline HTTP timeout is explicitly retryable availability rather than an observation invariant", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async () => { await Bun.sleep(50); return Response.json({ data: [] }); } });
  const adapter = new OpenCodeAdapter(`http://127.0.0.1:${server.port}`);
  try {
    await expect(adapter.request("/slow", "GET", undefined, undefined, 5)).rejects.toBeInstanceOf(OpenCodeUnavailableError);
    expect(await adapter.request<{ data: unknown[] }>("/fresh", "GET", undefined, undefined, 1000)).toEqual({ data: [] });
  } finally { await server.stop(true); }
});

function incompleteResponse(signal?: AbortSignal | null) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"data":'));
      if (signal) signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    },
    pull(controller) { if (!signal) controller.error(new TypeError("Offline body disconnected")); },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

const mockFetch = (implementation: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>) =>
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(implementation, { preconnect: fetch.preconnect }));

const queueReceipt = { id: "msg_app", sessionID: "ses_fixture", type: "user" as const, delivery: "queue" as const, time: { created: 8 } };
const malformedQueueAcknowledgements: [string, unknown][] = [
  ["null envelope", null], ["undefined envelope", undefined], ["missing data", {}], ["array envelope", []], ["primitive envelope", "accepted"],
  ["null data", { data: null }], ["undefined data", { data: undefined }], ["array data", { data: [] }], ["primitive data", { data: "accepted" }],
  ...Object.keys(queueReceipt).map((field): [string, unknown] => [`missing ${field}`, { data: Object.fromEntries(Object.entries(queueReceipt).filter(([key]) => key !== field)) }]),
  ["wrong id", { data: { ...queueReceipt, id: "msg_other" } }], ["wrong session", { data: { ...queueReceipt, sessionID: "ses_other" } }],
  ["wrong type", { data: { ...queueReceipt, type: "synthetic" } }], ["wrong delivery", { data: { ...queueReceipt, delivery: "steer" } }],
  ["null time", { data: { ...queueReceipt, time: null } }], ["array time", { data: { ...queueReceipt, time: [] } }],
  ["missing created", { data: { ...queueReceipt, time: {} } }], ["string created", { data: { ...queueReceipt, time: { created: "8" } } }],
  ["nonfinite created", { data: { ...queueReceipt, time: { created: Infinity } } }],
];

for (const [label, response] of malformedQueueAcknowledgements) test(`queued handoff ${label} is exactly a protocol mismatch without replay`, async () => {
  const adapter = new OpenCodeAdapter("http://127.0.0.1:1"); let sends = 0, intents = 0;
  adapter.request = async <T>(path: string, method?: string, data?: unknown, beforeSend?: () => void): Promise<T> => {
    expect(path).toBe("/api/session/ses_fixture/prompt"); expect(method).toBe("POST");
    expect(data).toEqual({ id: "msg_app", text: "offline", delivery: "queue" });
    beforeSend?.(); sends++; return response as T;
  };
  const error: unknown = await adapter.promptQueuedHandoff("ses_fixture", "msg_app", "offline", () => { intents++; }).catch(error => error);
  expect(error).toBeInstanceOf(OpenCodeQueuedHandoffProtocolError);
  expect((error as Error).constructor).toBe(OpenCodeQueuedHandoffProtocolError);
  expect(sends).toBe(1); expect(intents).toBe(1);
});

for (const [label, response] of [["null", null], ["empty object", {}], ["array", []], ["null data", { data: null }]] as const) test(`parsed HTTP 200 ${label} retains the queued protocol error identity`, async () => {
  const adapter = new OpenCodeAdapter("http://127.0.0.1:1"); let sends = 0;
  const transport = mockFetch(async () => { sends++; return Response.json(response); });
  try {
    await expect(adapter.promptQueuedHandoff("ses_fixture", "msg_app", "offline")).rejects.toBeInstanceOf(OpenCodeQueuedHandoffProtocolError);
    expect(sends).toBe(1);
  } finally { transport.mockRestore(); }
});

test("queued handoff 204 is a protocol mismatch while generic 204 stays compatible", async () => {
  const adapter = new OpenCodeAdapter("http://127.0.0.1:1");
  const transport = mockFetch(async () => new Response(null, { status: 204 }));
  try {
    await expect(adapter.promptQueuedHandoff("ses_fixture", "msg_app", "offline")).rejects.toBeInstanceOf(OpenCodeQueuedHandoffProtocolError);
    expect(await adapter.request("/generic")).toBeUndefined();
  } finally { transport.mockRestore(); }
});

test("queued handoff retains the actual valid receipt and immediate prompt keeps its legacy acknowledgement", async () => {
  const adapter = new OpenCodeAdapter("http://127.0.0.1:1");
  const exact = { ...queueReceipt, payload: { text: "offline", metadata: { fixture: true } } }, legacy = { id: "msg_app", time: { created: 8 } };
  adapter.request = async <T>(): Promise<T> => ({ data: exact }) as T;
  expect(await adapter.promptQueuedHandoff("ses_fixture", "msg_app", "offline")).toBe(exact);
  expect(isQueuedHandoffAdmission(exact, "ses_fixture", "msg_app")).toBe(true);
  expect(isQueuedHandoffAdmission(legacy, "ses_fixture", "msg_app")).toBe(false);
  expect(isQueuedHandoffAdmission(Object.assign([], exact), "ses_fixture", "msg_app")).toBe(false);
  expect(isQueuedHandoffAdmission({ ...exact, time: Object.assign([], exact.time) }, "ses_fixture", "msg_app")).toBe(false);
  adapter.request = async <T>(): Promise<T> => ({ data: legacy }) as T;
  expect(await adapter.prompt("ses_fixture", "msg_app", "offline")).toBe(legacy);
});

for (const mode of ["partial", "unavailable", "invalid"] as const) test(`queued handoff ${mode} acknowledgement remains unknown and is never replayed`, async () => {
  const adapter = new OpenCodeAdapter("http://127.0.0.1:1");
  const source: DispatchSource = { harnessId: "opencode", sessionId: "fixture", authorityId: "offline", nativeSessionId: "ses_fixture", cwd: "/fixture" };
  let sends = 0, intents = 0, failClosed = 0;
  const evidence = createDispatchEvidence({ runId: "run_fixture", nativeCommandId: "msg_app", source }, { beforeNative: () => { intents++; } }, () => { failClosed++; });
  const transport = mockFetch(async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/prompt")) {
      sends++; expect(evidence.snapshot().submission).toBe("attempted");
      if (mode === "unavailable") throw new TypeError("Offline transport unavailable");
      return mode === "partial" ? incompleteResponse() : new Response('{"data":', { status: 200 });
    }
    if (path.endsWith("/inbox")) return Response.json({ data: [queueReceipt] });
    return Response.json({ data: { id: "ses_fixture", location: { directory: "/fixture" }, time: { created: 0, updated: 4 } } });
  });
  try {
    const error: unknown = await adapter.promptQueuedHandoff("ses_fixture", "msg_app", "offline", evidence.beforeNative).catch(error => error);
    expect((error as Error).constructor).toBe(mode === "invalid" ? OpenCodeError : OpenCodeUnavailableError);
    expect(error).not.toBeInstanceOf(OpenCodeQueuedHandoffProtocolError);
    evidence.finish();
    expect(evidence.snapshot()).toMatchObject({ submission: "unknown", nativeAcceptance: "unknown" });
    expect(() => evidence.withheld()).toThrow();
    const fresh = await adapter.snapshot("ses_fixture", "msg_app", "/fixture", "native-queued-handoff");
    expect(fresh).toEqual({ messages: [], pending: true, pendingInput: queueReceipt });
    expect(isQueuedHandoffAdmission(fresh.pendingInput, "ses_fixture", "msg_app")).toBe(true);
    expect(sends).toBe(1); expect(intents).toBe(1); expect(failClosed).toBe(0);
  } finally { transport.mockRestore(); }
});

for (const status of [401, 403, 409, 503]) test(`queued handoff HTTP ${status} preserves its existing error type rather than a protocol mismatch`, async () => {
  const adapter = new OpenCodeAdapter("http://127.0.0.1:1");
  const transport = mockFetch(async () => new Response(null, { status }));
  try {
    const error: unknown = await adapter.promptQueuedHandoff("ses_fixture", "msg_app", "offline").catch(error => error);
    expect((error as OpenCodeError).constructor).toBe(status === 409 ? OpenCodeError : OpenCodeUnavailableError);
    expect((error as OpenCodeError).status).toBe(status);
  } finally { transport.mockRestore(); }
});

for (const mode of ["disconnect", "timeout"] as const) test(`HTTP 200 headers followed by partial-body ${mode} are typed unavailable`, async () => {
  const adapter = new OpenCodeAdapter("http://127.0.0.1:1");
  let response: Response | undefined, headersReceived = false;
  const transport = mockFetch(async (_input, init) => {
    response = incompleteResponse(mode === "timeout" ? init?.signal : undefined);
    headersReceived = true;
    expect(init?.signal?.aborted).toBe(false);
    return response;
  });
  try {
    await expect(adapter.request("/partial", "GET", undefined, undefined, 20)).rejects.toBeInstanceOf(OpenCodeUnavailableError);
    expect(headersReceived).toBe(true); expect(response?.status).toBe(200); expect(response?.bodyUsed).toBe(true);
  } finally { transport.mockRestore(); }
});

test("complete invalid JSON remains an invariant, while 204 preserves the undefined result", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => new URL(request.url).pathname === "/empty" ? new Response(null, { status: 204 }) : new Response('{"data":', { status: 200 }) });
  const adapter = new OpenCodeAdapter(`http://127.0.0.1:${server.port}`);
  try {
    const invalid: unknown = await adapter.request("/invalid").catch(error => error);
    if (!(invalid instanceof OpenCodeError)) throw new Error("Expected invalid JSON error");
    expect(invalid.constructor).toBe(OpenCodeError); expect(invalid).not.toBeInstanceOf(OpenCodeUnavailableError);
    expect(await adapter.request<undefined>("/empty")).toBeUndefined();
  } finally { await server.stop(true); }
});

for (const mode of ["partial", "invalid"] as const) test(`${mode} mutation acknowledgement leaves durable intent unknown without replay or non-submission`, async () => {
  const adapter = new OpenCodeAdapter("http://127.0.0.1:1");
  const source: DispatchSource = { harnessId: "opencode", sessionId: "fixture", authorityId: "offline", nativeSessionId: "ses_fixture", cwd: "/fixture" };
  let sends = 0, intents = 0, failClosed = 0;
  const evidence = createDispatchEvidence({ runId: "run_fixture", nativeCommandId: "msg_app", source }, { beforeNative: () => { intents++; } }, () => { failClosed++; });
  const transport = mockFetch(async (_input, init) => {
    expect(init?.method).toBe("POST"); expect(evidence.snapshot().submission).toBe("attempted");
    sends++; return mode === "partial" ? incompleteResponse() : new Response('{"data":', { status: 200 });
  });
  try {
    const error: unknown = await adapter.prompt("ses_fixture", "msg_app", "offline", evidence.beforeNative).catch(error => error);
    if (!(error instanceof OpenCodeError)) throw new Error("Expected uncertain acknowledgement error");
    expect(error.constructor).toBe(mode === "partial" ? OpenCodeUnavailableError : OpenCodeError);
    evidence.finish();
    expect(evidence.snapshot()).toMatchObject({ submission: "unknown", nativeAcceptance: "unknown" });
    expect(() => evidence.withheld()).toThrow();
    expect(sends).toBe(1); expect(intents).toBe(1); expect(failClosed).toBe(0);
  } finally { transport.mockRestore(); }
});

for (const mode of ["partial", "invalid"] as const) test(`${mode} exact read-only proof ${mode === "partial" ? "permits fresh proof without global fail-closed" : "remains a fail-closed invariant"}`, async () => {
  const adapter = new OpenCodeAdapter("http://127.0.0.1:1"), registry = new HarnessDispatchRegistry();
  const source: DispatchSource = { harnessId: "opencode", sessionId: "fixture", authorityId: "offline", nativeSessionId: "ses_fixture", cwd: "/fixture" };
  let incomplete = true, storageFailed = false, failClosed = 0, installed: RunOwner | undefined;
  const hooks: DispatchLifecycleHooks = {
    install: done => installed = { run: { runId: "run_fixture", sessionId: source.sessionId, cwd: source.cwd, createdAt: "now", status: "running", nativeCommandId: "msg_app" }, done, settled: false },
    owns: owner => installed === owner,
    settle: owner => { owner.settled = true; }, release: () => { installed = undefined; },
    failClosed: () => { storageFailed = true; failClosed++; }, terminate: async () => {},
    guards: () => ({ settled: true, released: true, status: "completed", cancelling: false, stopRequested: false, stopping: false, closing: false, storageFailed, reconciliationRequired: storageFailed }),
  };
  registry.register(createOpenCodeDispatchAdapter({
    automation: { "queued-user": { supported: false, reason: "Idle-only offline fixture" }, "worker-report": { supported: true }, handoff: { supported: true } },
    readiness: async expected => ({ source: expected, readiness: { ready: true } }),
    execute: async (owner, _prompt, _resume, ready) => { ready(true); owner.run.status = "completed"; },
    exactCommand: async (_owner, expected, commandId) => {
      try {
        const snapshot = await adapter.snapshot(expected.nativeSessionId!, commandId, expected.cwd);
        return { commandId, outcome: snapshot.outcome === "succeeded" ? "succeeded" : "unknown" };
      } catch (error) {
        // Same typed conversion as the bridge proof boundary; no status/message heuristics.
        if (error instanceof OpenCodeUnavailableError) throw new DispatchProofUnavailableError(error.message);
        throw error;
      }
    },
    nativeReadiness: async expected => ({ source: expected, readiness: { ready: true } }),
  }));
  const transport = mockFetch(async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/inbox")) return Response.json({ data: [] });
    if (path.endsWith("/active")) return Response.json({ data: {} });
    if (path.endsWith("/message")) {
      if (incomplete) return mode === "partial" ? incompleteResponse() : new Response('{"data":', { status: 200 });
      return Response.json({ data: [message("idle_app", "idle", "succeeded"), message("msg_app", "user")], cursor: {} });
    }
    return Response.json({ data: { id: "ses_fixture", location: { directory: "/fixture" }, time: { created: 0, updated: 2 } } });
  });
  try {
    const lifecycle = registry.start({ source, origin: "user", prompt: "offline", resume: true }, hooks);
    await lifecycle.admission; await lifecycle.done;
    expect(await lifecycle.successfulSettlement()).toMatchObject({ ready: false, code: mode === "partial" ? "dispatch-proof-unavailable" : "reconciliation-required" });
    expect(storageFailed).toBe(mode === "invalid"); expect(failClosed).toBe(mode === "partial" ? 0 : 1);
    incomplete = false;
    expect((await lifecycle.successfulSettlement()).ready).toBe(mode === "partial");
    expect(storageFailed).toBe(mode === "invalid"); expect(failClosed).toBe(mode === "partial" ? 0 : 1);
  } finally { transport.mockRestore(); }
});
