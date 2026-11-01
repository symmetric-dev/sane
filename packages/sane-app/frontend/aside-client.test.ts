import { describe, expect, test } from "bun:test";
import { ASIDE_EXECUTION_AVAILABILITY, parseAsideRecord, summarizeAside, type AsideRecord } from "../shared/aside-contract";
import { AsideRequestError, AsideSession, type AsideScope, type AsideTransport } from "./aside-client";

const ids = {
  store: "11111111-1111-4111-8111-111111111111",
  session: "22222222-2222-4222-8222-222222222222",
  aside: "33333333-3333-4333-8333-333333333333",
  other: "44444444-4444-4444-8444-444444444444",
};
const scope: AsideScope = { storeId: ids.store, sessionId: ids.session };
const time = "2026-10-31T12:00:00.000Z";
function record(change: Partial<AsideRecord> = {}): AsideRecord {
  return parseAsideRecord({ version: 1, id: ids.aside, purpose: "discussion", lifecycle: "open", draft: "server", revision: 1,
    createdAt: time, updatedAt: time, source: {
      storeId: scope.storeId, sessionId: scope.sessionId, rootSessionId: scope.sessionId,
      native: { harness: "cc", authorityId: `sane-native-v1:cc:${"a".repeat(64)}`, nativeId: ids.other },
      binding: { workspaceId: ids.store, worktreeId: ids.other, bindingRevision: "binding-1", cwd: "/repo" },
      capturedAt: time, transcript: { kind: "app-transcript", epoch: "epoch", revision: "1", messages: [],
        totalMessages: 0, boundaryMessageId: null, fingerprint: "a".repeat(64) },
    }, ...change });
}
const result = (aside: AsideRecord) => ({ aside, execution: ASIDE_EXECUTION_AVAILABILITY });
const list = (records: AsideRecord[]) => ({ asides: records.map(summarizeAside), execution: ASIDE_EXECUTION_AVAILABILITY });
class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function owner(send: AsideTransport, options: {
  storage?: MemoryStorage; scope?: AsideScope; allowEndpoint?: () => boolean; canCreate?: () => boolean;
} = {}) {
  return new AsideSession(options.scope ?? scope, { transport: send, storage: options.storage ?? new MemoryStorage(),
    allowEndpoint: options.allowEndpoint ?? (() => true), canCreate: options.canCreate });
}
const body = (init?: RequestInit) => JSON.parse(String(init?.body));

describe("aside scoped client validation", () => {
  for (const mismatch of ["store", "source", "id"] as const) {
    test(`rejects a wrong-${mismatch} record without publication`, async () => {
      const wrong = record();
      if (mismatch === "store") wrong.source.storeId = ids.other;
      if (mismatch === "source") wrong.source.sessionId = ids.other;
      if (mismatch === "id") wrong.id = ids.other;
      const session = owner(async () => result(wrong));
      await session.open(ids.aside);
      expect(session.snapshot().selected).toBeUndefined();
      expect(session.snapshot().asides).toEqual([]);
      expect(session.snapshot().error).toContain("does not match");
    });
  }

  test("rejects immutable source drift on the same id", async () => {
    let current = record();
    const session = owner(async () => result(current));
    await session.open(ids.aside);
    current = record({ revision: 2 });
    current.source.binding.cwd = "/different";
    await session.open(ids.aside);
    expect(session.snapshot().selected?.record.source.binding.cwd).toBe("/repo");
    expect(session.snapshot().selected?.error).toContain("immutable source changed");
  });

  test("validates complete list summary fields and never erases local recovery on list failure", async () => {
    let projection: unknown = list([record()]);
    const session = owner(async path => path.includes("/sessions/") ? projection : result(record()));
    await session.open(ids.aside);
    session.edit(ids.aside, "local");
    await session.refresh();
    const original = summarizeAside(record());
    for (const bad of [
      { ...original, sourceSessionId: ids.other }, { ...original, revision: 0 },
      { ...original, lifecycle: "deleted" }, { ...original, rootSessionId: "invalid" },
      { ...original, updatedAt: "invalid" }, { ...original, purpose: "question-explanation" },
      { ...original, question: { formId: "unexpected", questionIndex: 0 } },
      { ...original, rootSessionId: ids.other }, { ...original, extra: true },
    ]) {
      projection = { asides: [bad], execution: ASIDE_EXECUTION_AVAILABILITY };
      await session.refresh();
      expect(session.snapshot().error).not.toBe("");
      expect(session.snapshot().asides).toEqual([original]);
      expect(session.snapshot().selected?.text).toBe("local");
    }
    projection = { asides: [original, original], execution: ASIDE_EXECUTION_AVAILABILITY };
    await session.refresh();
    expect(session.snapshot().error).toContain("Duplicate");
  });

  test("restores only records matching both stored owner IDs and retains same-source/different-store isolation", async () => {
    const storage = new MemoryStorage();
    const a = owner(async () => result(record()), { storage });
    await a.open(ids.aside); a.edit(ids.aside, "store A edit");
    const bScope = { ...scope, storeId: ids.other };
    const bRecord = record(); bRecord.source.storeId = ids.other;
    const b = owner(async () => result(bRecord), { storage, scope: bScope });
    expect(b.snapshot().selected).toBeUndefined();
    await b.open(ids.aside); b.edit(ids.aside, "store B edit");
    expect(storage.values.size).toBe(2);
    const reloadedA = owner(async () => result(record()), { storage });
    const reloadedB = owner(async () => result(bRecord), { storage, scope: bScope });
    expect(reloadedA.snapshot().selected).toBeUndefined();
    expect(reloadedB.snapshot().selected).toBeUndefined();
    await reloadedA.open(ids.aside); await reloadedB.open(ids.aside);
    expect(reloadedA.snapshot().selected?.text).toBe("store A edit");
    expect(reloadedB.snapshot().selected?.text).toBe("store B edit");
    const key = [...storage.values.keys()].find(key => key.includes(ids.store))!;
    const corrupt = JSON.parse(storage.getItem(key)!);
    corrupt.scopeKey = JSON.stringify([ids.other, ids.session]);
    storage.setItem(key, JSON.stringify(corrupt));
    const restored = owner(async () => result(record()), { storage });
    expect(restored.snapshot().selected).toBeUndefined();
    expect(restored.snapshot().asides).toEqual([]);
  });
});

describe("aside exact mutation recovery", () => {
  test("persists creation before transport and retries the SAME payload after same-tab reload without recapture", async () => {
    const storage = new MemoryStorage(), posts: unknown[] = [];
    let created = 0;
    const createdRecord = record({ draft: "initial draft" });
    const send: AsideTransport = async (_path, init) => {
      if (init?.method !== "POST") return result(record({ draft: "later server draft", revision: 2 }));
      const request = body(init);
      posts.push(request);
      const saved = JSON.parse([...storage.values.values()][0]!);
      expect(saved.pendingCreate.requestId).toBe(request.requestId);
      expect(Object.keys(request).sort()).toEqual(["draft", "requestId", "target"]);
      expect(request.target).toEqual({ kind: "conversation" });
      if (posts.length === 1) { created++; throw new Error("response lost after commit"); }
      return result(createdRecord);
    };
    const first = owner(send, { storage });
    expect(await first.create({ kind: "conversation" }, "initial draft")).toBeUndefined();
    expect(first.snapshot().pendingCreate?.uncertain).toBe(true);
    const restored = owner(send, { storage, canCreate: () => false });
    expect(restored.snapshot().pendingCreate?.requestId).toBe(first.snapshot().pendingCreate?.requestId);
    expect(await restored.create({ kind: "conversation" }, "new intent is forbidden")).toBeUndefined();
    expect(posts).toHaveLength(1);
    expect(await restored.retryCreate()).toBe(ids.aside);
    expect(posts[1]).toEqual(posts[0]);
    expect(created).toBe(1);
    expect(restored.snapshot().pendingCreate).toBeUndefined();
    expect(restored.snapshot().selected?.text).toBe("later server draft");
    expect(restored.snapshot().selected?.record.revision).toBe(2);
    expect(storage.values.size).toBe(0);
  });

  test("does not duplicate an in-flight creation or silently synthesize a new create intent", async () => {
    const pending = deferred<unknown>(); let posts = 0;
    const session = owner(async (_path, init) => {
      if (init?.method === "POST") { posts++; return pending.promise; }
      return result(record({ draft: "one" }));
    });
    const creating = session.create({ kind: "conversation" }, "one");
    expect(session.snapshot().creating).toBe(true);
    await session.create({ kind: "conversation" }, "two"); await session.retryCreate();
    expect(posts).toBe(1);
    pending.reject(new Error("offline")); await creating;
    const requestId = session.snapshot().pendingCreate?.requestId;
    await session.create({ kind: "conversation" }, "three");
    expect(session.snapshot().pendingCreate?.requestId).toBe(requestId);
    expect(posts).toBe(1);
  });

  test("wrong-scope creation acknowledgement remains uncertain with exact recovery intent", async () => {
    const wrong = record({ draft: "draft" }); wrong.source.storeId = ids.other;
    const session = owner(async () => result(wrong));
    await session.create({ kind: "conversation" }, "draft");
    expect(session.snapshot().pendingCreate?.uncertain).toBe(true);
    expect(session.snapshot().selected).toBeUndefined();
    expect(session.snapshot().asides).toEqual([]);
  });

  test("an explicitly new create can replace a definite rejection, but never an uncertain intent", async () => {
    for (const status of [400, 409, 503]) {
      const requests: ReturnType<typeof body>[] = [];
      const storage = new MemoryStorage();
      const send: AsideTransport = async (_path, init) => {
        if (init?.method !== "POST") return result(record({ draft: "corrected" }));
        requests.push(body(init));
        if (requests.length === 1) throw new AsideRequestError("rejected", status, status === 400 ? "aside-input" : status === 409 ? "aside-conflict" : "asides-unavailable");
        return result(record({ draft: "corrected" }));
      };
      let session = owner(send, { storage });
      await session.create({ kind: "conversation" }, "original");
      const firstId = session.snapshot().pendingCreate?.requestId;
      expect(session.snapshot().pendingCreate?.error).toContain(status === 503 ? "unconfirmed" : "rejected");
      session = owner(send, { storage });
      const second = await session.create({ kind: "conversation" }, "corrected");
      if (status === 503) {
        expect(second).toBeUndefined(); expect(requests).toHaveLength(1);
        expect(session.snapshot().pendingCreate).toMatchObject({ requestId: firstId, draft: "original", uncertain: true });
      } else {
        expect(second).toBe(ids.aside); expect(requests).toHaveLength(2);
        expect(requests[1]?.requestId).not.toBe(firstId);
        expect(requests[1]?.draft).toBe("corrected");
        expect(session.snapshot().pendingCreate).toBeUndefined();
      }
    }
  });

  test("malformed protocol responses remain uncertain even with a 4xx HTTP status", async () => {
    const originalFetch = globalThis.fetch;
    try {
      let calls = 0;
      globalThis.fetch = (async () => { calls++; return new Response("not-json", { status: 400 }); }) as unknown as typeof fetch;
      const session = new AsideSession(scope, { storage: new MemoryStorage(), allowEndpoint: () => true });
      await session.create({ kind: "conversation" }, "original");
      expect(session.snapshot().pendingCreate?.uncertain).toBe(true);
      await session.create({ kind: "conversation" }, "replacement");
      expect(calls).toBe(1);
      expect(session.snapshot().pendingCreate?.draft).toBe("original");
    } finally { globalThis.fetch = originalFetch; }
  });

  for (const [status, code] of [[401, "authentication-required"], [403, "authentication-required"], [409, "aside-interrupted"]] as const) {
    test(`create committed before ${status}/${code} retains its original identity across reload`, async () => {
      const originalFetch = globalThis.fetch, storage = new MemoryStorage();
      const requests: ReturnType<typeof body>[] = [];
      let commits = 0, committed: AsideRecord | undefined;
      try {
        globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
          if (init?.method !== "POST") return Response.json(result(committed!));
          const payload = body(init); requests.push(payload);
          if (!committed) {
            commits++; committed = record({ draft: payload.draft });
            // Simulate commit, followed by the route's late authority check.
            return Response.json({ error: "request revoked after commit", code }, { status });
          }
          return Response.json(result(committed)); // Exact receipt replay.
        }) as unknown as typeof fetch;
        const first = new AsideSession(scope, { storage, allowEndpoint: () => true });
        await first.create({ kind: "conversation" }, "committed once");
        expect(first.snapshot().pendingCreate?.uncertain).toBe(true);
        const requestId = first.snapshot().pendingCreate?.requestId;
        await first.create({ kind: "conversation" }, "must not replace");
        expect(requests).toHaveLength(1);
        const restored = new AsideSession(scope, { storage, allowEndpoint: () => true, canCreate: () => false });
        expect(restored.snapshot().pendingCreate).toMatchObject({ requestId, uncertain: true, draft: "committed once" });
        expect(await restored.retryCreate()).toBe(ids.aside);
        expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
        expect(commits).toBe(1);
        expect(restored.snapshot().pendingCreate).toBeUndefined();
      } finally { globalThis.fetch = originalFetch; }
    });

    for (const kind of ["draft", "lifecycle"] as const) {
      test(`${kind} committed before ${status}/${code} retains exact request/revision through reload`, async () => {
        const originalFetch = globalThis.fetch, storage = new MemoryStorage();
        const requests: ReturnType<typeof body>[] = [];
        let current = record(), commits = 0;
        try {
          globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
            if (init?.method !== "POST") return Response.json(result(current));
            const payload = body(init); requests.push(payload);
            if (requests.length === 1) {
              commits++;
              current = record({ revision: 2, ...(kind === "draft" ? { draft: payload.text } : { lifecycle: payload.lifecycle }) });
              return Response.json({ error: "request revoked after commit", code }, { status });
            }
            return Response.json(result(current));
          }) as unknown as typeof fetch;
          const first = new AsideSession(scope, { storage, allowEndpoint: () => true });
          await first.open(ids.aside); first.edit(ids.aside, "original local draft");
          if (kind === "draft") await first.save(ids.aside);
          else await first.setLifecycle(ids.aside, "archived");
          expect(first.snapshot().selected).toMatchObject({ conflict: false, operation: { kind, uncertain: true } });
          first.edit(ids.aside, "later local text");
          await first.reload(ids.aside); // Unresolved identity cannot be discarded.
          const restored = new AsideSession(scope, { storage, allowEndpoint: () => true });
          await restored.reconcile(ids.aside); // GET validation is mandatory first.
          expect(requests).toHaveLength(1);
          await restored.open(ids.aside);
          expect(restored.snapshot().selected).toMatchObject({ text: "later local text", conflict: false,
            operation: { kind, uncertain: true } });
          await restored.reconcile(ids.aside);
          expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
          expect(requests[1]).toMatchObject({ expectedRevision: 1 });
          expect(commits).toBe(1);
          expect(restored.snapshot().selected?.operation).toBeUndefined();
          expect(restored.snapshot().selected?.text).toBe("later local text");
        } finally { globalThis.fetch = originalFetch; }
      });
    }
  }

  test("a historical create receipt cannot undo edits to an already-open current projection", async () => {
    let posts = 0;
    const current = record({ draft: "current", revision: 3 });
    const session = owner(async (_path, init) => {
      if (init?.method !== "POST") return result(current);
      if (++posts === 1) throw new Error("lost");
      return result(record({ draft: "initial" }));
    });
    await session.create({ kind: "conversation" }, "initial");
    await session.open(ids.aside); session.edit(ids.aside, "new local edit");
    await session.retryCreate();
    expect(session.snapshot().selected?.record.revision).toBe(3);
    expect(session.snapshot().selected?.text).toBe("new local edit");
    expect(session.snapshot().selected?.dirty).toBe(true);
  });

  for (const kind of ["draft", "lifecycle"] as const) {
    test(`recovers an uncertain ${kind} operation with identical revision/request/payload after reload`, async () => {
      const storage = new MemoryStorage(), requests: { path: string; payload: unknown }[] = [];
      let current = record();
      const send: AsideTransport = async (path, init) => {
        if (init?.method !== "POST") return result(current);
        const payload = body(init); requests.push({ path, payload });
        current = record({ revision: 2, ...(kind === "draft" ? { draft: payload.text } : { lifecycle: payload.lifecycle }) });
        if (requests.length === 1) throw new Error("timeout after commit");
        return result(current);
      };
      const first = owner(send, { storage });
      await first.open(ids.aside); first.edit(ids.aside, "local draft");
      if (kind === "draft") await first.save(ids.aside);
      else await first.setLifecycle(ids.aside, "archived");
      expect(first.snapshot().selected?.operation?.uncertain).toBe(true);
      first.edit(ids.aside, "newer local draft");
      const restored = owner(send, { storage });
      expect(restored.snapshot().selected).toBeUndefined();
      expect(restored.hasUnsavedWork()).toBe(true);
      await restored.reconcile(ids.aside);
      expect(requests).toHaveLength(1); // No writes before GET validates the source.
      // A GET can observe a later projection, but is NOT an acknowledgement.
      await restored.open(ids.aside);
      expect(restored.snapshot().selected?.operation).toBeDefined();
      expect(restored.snapshot().selected?.text).toBe("newer local draft");
      await restored.reconcile(ids.aside);
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(requests[0]);
      expect(requests[1]?.payload).toMatchObject({ expectedRevision: 1 });
      expect(restored.snapshot().selected?.operation).toBeUndefined();
      expect(restored.snapshot().selected?.text).toBe("newer local draft");
      expect(restored.snapshot().selected?.dirty).toBe(true);
      expect(restored.snapshot().selected?.record.lifecycle).toBe(kind === "draft" ? "open" : "archived");
      await restored.reconcile(ids.aside);
      expect(requests).toHaveLength(2);
    });
  }

  test("distinguishes definite rejection from uncertain transport without automatic retry loops", async () => {
    const cases: [number, string | undefined, boolean][] = [
      [400, "aside-input", true], [400, "aside-invalid", true], [400, undefined, false],
      [401, "authentication-required", false], [403, "aside-input", false],
      [404, "aside-not-found", true], [404, "unrecognized", false], [408, undefined, false],
      [409, "aside-interrupted", false], [409, "unrecognized", false],
      [409, "aside-source-binding", true], [429, "aside-limit", true], [503, "aside-input", false],
    ];
    for (const [status, code, definite] of cases) {
      let calls = 0;
      const session = owner(async (_path, init) => {
        if (init?.method !== "POST") return result(record());
        calls++; throw new AsideRequestError("not accepted", status, code);
      });
      await session.open(ids.aside); session.edit(ids.aside, "local"); await session.save(ids.aside);
      expect(calls).toBe(1);
      expect(session.snapshot().selected?.text).toBe("local");
      expect(session.snapshot().selected?.operation?.uncertain).toBe(definite ? undefined : true);
      expect(session.snapshot().selected?.error).toContain(definite ? "rejected" : "reconcile");
    }
    const rejectedCreate = owner(async () => { throw new AsideRequestError("invalid", 400, "aside-input"); });
    await rejectedCreate.create({ kind: "conversation" }, "recoverable");
    expect(rejectedCreate.snapshot().pendingCreate).toMatchObject({ draft: "recoverable", uncertain: false });
  });
});

describe("aside edit and navigation races", () => {
  for (const nextAction of ["save", "lifecycle"] as const) {
    test(`a slow post-ack GET stays visibly busy and cannot strand a later ${nextAction} operation`, async () => {
      const projection = deferred<unknown>(), reading = deferred<void>();
      const posts: { path: string; payload: ReturnType<typeof body> }[] = [];
      let current = record();
      const session = owner(async (path, init) => {
        if (init?.method === "POST") {
          const payload = body(init); posts.push({ path, payload });
          current = record({ ...current, revision: current.revision + 1,
            ...(path.endsWith("/draft") ? { draft: payload.text } : { lifecycle: payload.lifecycle }) });
          return result(current);
        }
        if (posts.length === 1) { reading.resolve(); return projection.promise; }
        return result(current);
      });
      await session.open(ids.aside); session.edit(ids.aside, "first save");
      const firstSave = session.save(ids.aside);
      await reading.promise;
      expect(session.snapshot().selected).toMatchObject({ record: { revision: 2, draft: "first save" },
        operation: { kind: "draft", uncertain: false } });
      session.edit(ids.aside, "typed during reconciliation");
      await session.save(ids.aside); await session.setLifecycle(ids.aside, "archived");
      expect(posts).toHaveLength(1);
      expect(session.snapshot().selected?.operation).toMatchObject({ kind: "draft", uncertain: false });
      projection.resolve(result(current)); await firstSave;
      expect(session.snapshot().selected).toMatchObject({ text: "typed during reconciliation", dirty: true, conflict: false });
      expect(session.snapshot().selected?.operation).toBeUndefined();
      expect(posts).toHaveLength(1); // No queued or synthesized automatic mutation.
      if (nextAction === "save") await session.save(ids.aside);
      else await session.setLifecycle(ids.aside, "archived");
      expect(posts).toHaveLength(2);
      expect(posts[1]?.path.endsWith(nextAction === "save" ? "/draft" : "/lifecycle")).toBe(true);
      expect(posts[1]?.payload.expectedRevision).toBe(2);
      expect(posts[1]?.payload.requestId).not.toBe(posts[0]?.payload.requestId);
      expect(session.snapshot().selected?.operation).toBeUndefined();
    });
  }

  test("an acknowledged write is not stranded when its follow-up GET fails, and a same-revision GET clears that read error", async () => {
    let current = record(), failProjection = false, posts = 0;
    const session = owner(async (_path, init) => {
      if (init?.method === "POST") {
        posts++; current = record({ revision: 2, draft: body(init).text }); failProjection = true;
        return result(current);
      }
      if (failProjection) throw new Error("projection temporarily unavailable");
      return result(current);
    });
    await session.open(ids.aside); session.edit(ids.aside, "saved"); await session.save(ids.aside);
    expect(session.snapshot().selected).toMatchObject({ text: "saved", dirty: false, error: "projection temporarily unavailable" });
    expect(session.snapshot().selected?.operation).toBeUndefined();
    failProjection = false; await session.open(ids.aside);
    expect(session.snapshot().selected).toMatchObject({ text: "saved", dirty: false, error: "" });
    expect(posts).toBe(1);
  });

  test("same-revision GET clears only transient read errors, retaining dirty/conflict and mutation recovery semantics", async () => {
    for (const mode of ["dirty", "conflict", "uncertain", "rejected-lifecycle"] as const) {
      let failRead = false, current = record();
      const session = owner(async (_path, init) => {
        if (init?.method === "POST") {
          if (mode === "conflict") throw new AsideRequestError("changed", 409, "aside-conflict");
          if (mode === "rejected-lifecycle") throw new AsideRequestError("invalid lifecycle", 400, "aside-input");
          throw new Error("write outcome unknown");
        }
        if (failRead) throw new Error("transient GET failure");
        return result(current);
      });
      await session.open(ids.aside);
      if (mode === "rejected-lifecycle") await session.setLifecycle(ids.aside, "archived");
      else {
        session.edit(ids.aside, "local text");
        if (mode !== "dirty") await session.save(ids.aside);
      }
      const recoveryError = session.snapshot().selected?.error;
      failRead = true; await session.open(ids.aside);
      expect(session.snapshot().selected?.error).toContain("transient GET failure");
      failRead = false; await session.open(ids.aside);
      expect(session.snapshot().selected?.error).toBe(recoveryError);
      expect(session.snapshot().selected?.dirty).toBe(mode !== "rejected-lifecycle");
      expect(session.snapshot().selected?.conflict).toBe(mode === "conflict");
      expect(session.snapshot().selected?.operation?.uncertain).toBe(mode === "uncertain" ? true : undefined);
      if (mode === "rejected-lifecycle") {
        current = record({ revision: 2, draft: "new server text" }); await session.open(ids.aside);
        expect(session.snapshot().selected).toMatchObject({ text: "new server text", dirty: false, error: recoveryError });
      }
    }
  });

  test("read-error-only clean records follow newer server text without becoming dirty, including after reload", async () => {
    let current = record(), fail = false;
    const storage = new MemoryStorage();
    const send: AsideTransport = async () => {
      if (fail) throw new Error("temporary read failure");
      return result(current);
    };
    const session = owner(send, { storage });
    await session.open(ids.aside); fail = true; await session.open(ids.aside);
    expect(session.snapshot().selected).toMatchObject({ text: "server", dirty: false, error: "temporary read failure" });
    const restored = owner(send, { storage });
    fail = false; current = record({ revision: 2, draft: "new server text" });
    await session.open(ids.aside); await restored.open(ids.aside);
    for (const candidate of [session, restored]) expect(candidate.snapshot().selected).toMatchObject({
      text: "new server text", dirty: false, conflict: false, error: "", record: { revision: 2 },
    });
  });

  test("an old save response never overwrites edits made while it was in flight", async () => {
    const pending = deferred<unknown>(); let current = record();
    const session = owner(async (_path, init) => init?.method === "POST" ? pending.promise : result(current));
    await session.open(ids.aside); session.edit(ids.aside, "saved text");
    const saving = session.save(ids.aside);
    session.edit(ids.aside, "newer text");
    current = record({ revision: 2, draft: "saved text" }); pending.resolve(result(current)); await saving;
    expect(session.snapshot().selected).toMatchObject({ text: "newer text", dirty: true, conflict: false, record: { revision: 2, draft: "saved text" } });
  });

  test("an exact historical mutation receipt cannot roll back a newer server projection", async () => {
    const pending = deferred<unknown>(); let current = record();
    const session = owner(async (path, init) => init?.method === "POST" ? pending.promise
      : path.includes("/sessions/") ? list([current]) : result(current));
    await session.open(ids.aside); session.edit(ids.aside, "submitted text");
    const saving = session.save(ids.aside);
    current = record({ revision: 3, draft: "other tab text" }); await session.refresh();
    expect(session.snapshot().selected?.operation).toBeDefined();
    pending.resolve(result(record({ revision: 2, draft: "submitted text" }))); await saving;
    expect(session.snapshot().selected).toMatchObject({ text: "submitted text", dirty: true, conflict: true,
      record: { revision: 3, draft: "other tab text" } });
  });

  test("409 preserves local conflict text until explicit reload, including a reload/edit race", async () => {
    let current = record(), posts = 0, reloadRead: ReturnType<typeof deferred<unknown>> | undefined;
    const session = owner(async (_path, init) => {
      if (init?.method === "POST") {
        posts++; current = record({ revision: 2, draft: "other tab" });
        throw new AsideRequestError("revision changed", 409, "aside-conflict");
      }
      return reloadRead ? reloadRead.promise : result(current);
    });
    await session.open(ids.aside); session.edit(ids.aside, "mine"); await session.save(ids.aside);
    expect(session.snapshot().selected).toMatchObject({ text: "mine", conflict: true, dirty: true, record: { draft: "other tab" } });
    await session.save(ids.aside); await session.setLifecycle(ids.aside, "archived"); await session.reconcile(ids.aside);
    expect(posts).toBe(1);
    reloadRead = deferred<unknown>();
    const reloading = session.reload(ids.aside); session.edit(ids.aside, "typed during reload");
    reloadRead.resolve(result(current)); await reloading;
    expect(session.snapshot().selected).toMatchObject({ text: "typed during reload", conflict: true });
    reloadRead = undefined; await session.reload(ids.aside);
    expect(session.snapshot().selected).toMatchObject({ text: "other tab", conflict: false, dirty: false, error: "" });
  });

  test("late responses update only the originating owner and cannot issue follow-ups after scope switch", async () => {
    const pending = deferred<unknown>(); let active = scope, aCalls = 0;
    const a = owner(async (_path, init) => { aCalls++; return init?.method === "POST" ? pending.promise : result(record()); },
      { allowEndpoint: () => active.storeId === scope.storeId && active.sessionId === scope.sessionId });
    await a.open(ids.aside); a.edit(ids.aside, "A edit"); const saving = a.save(ids.aside);
    active = { storeId: ids.other, sessionId: scope.sessionId };
    const bRecord = record(); bRecord.source.storeId = ids.other;
    let bCalls = 0;
    const b = owner(async () => { bCalls++; return result(bRecord); }, { scope: active });
    await b.open(ids.aside); b.edit(ids.aside, "B edit");
    pending.resolve(result(record({ revision: 2, draft: "A edit" }))); await saving;
    expect(a.snapshot().selected).toMatchObject({ text: "A edit", dirty: false, record: { revision: 2 } });
    expect(b.snapshot().selected).toMatchObject({ text: "B edit", dirty: true, record: { revision: 1 } });
    await a.refresh(); await a.save(ids.aside); await a.setLifecycle(ids.aside, "archived");
    expect(aCalls).toBe(2); expect(bCalls).toBe(1);
  });

  test("a late open read cannot change the selected aside after another open", async () => {
    const first = deferred<unknown>(), other = record({ id: ids.other });
    const session = owner(async path => path.endsWith(ids.aside) ? first.promise : result(other));
    const opening = session.open(ids.aside); await session.open(ids.other);
    first.resolve(result(record())); await opening;
    expect(session.snapshot().selected?.record.id).toBe(ids.other);
    expect(session.snapshot().asides).toHaveLength(2);
  });

  test("disabled endpoint access prevents reads, writes, retries and local publication from old callbacks", async () => {
    let enabled = true, calls = 0;
    const session = owner(async () => { calls++; return result(record()); }, { allowEndpoint: () => enabled });
    await session.open(ids.aside); session.edit(ids.aside, "retained"); enabled = false;
    await session.refresh(); await session.save(ids.aside); await session.setLifecycle(ids.aside, "archived");
    await session.create({ kind: "conversation" }, "no"); await session.retryCreate(); await session.reconcile(ids.aside); await session.reload(ids.aside);
    session.edit(ids.aside, "not authorized");
    expect(calls).toBe(1); expect(session.snapshot().selected?.text).toBe("retained");
  });

  test("archived records can reopen and discarded records retain read access without further mutation", async () => {
    let current = record({ revision: 2, lifecycle: "archived" }), posts = 0;
    const session = owner(async (_path, init) => {
      if (init?.method === "POST") { posts++; current = record({ revision: current.revision + 1, lifecycle: body(init).lifecycle }); }
      return result(current);
    }, { canCreate: () => false });
    await session.open(ids.aside);
    await session.setLifecycle(ids.aside, "open");
    expect(session.snapshot().selected?.record.lifecycle).toBe("open");
    await session.setLifecycle(ids.aside, "discarded");
    session.edit(ids.aside, "not editable"); await session.save(ids.aside); await session.setLifecycle(ids.aside, "open");
    await session.open(ids.aside);
    expect(posts).toBe(2);
    expect(session.snapshot().selected).toMatchObject({ text: "server", record: { lifecycle: "discarded" } });
  });

  test("unavailable browser storage cannot crash recovery and unsaved-work warning state remains", async () => {
    const storage = {
      getItem() { throw new Error("blocked"); }, setItem() { throw new Error("quota"); }, removeItem() { throw new Error("blocked"); },
    };
    const session = new AsideSession(scope, { transport: async () => result(record()), storage, allowEndpoint: () => true });
    await session.open(ids.aside); session.edit(ids.aside, "in memory");
    expect(session.snapshot().selected?.text).toBe("in memory");
    expect(session.hasUnsavedWork()).toBe(true);
    expect(session.snapshot().error).toContain("Keep this tab open");
  });

  test("persists mutable metadata without transcript snapshots and validates restored IDs before enabling writes", async () => {
    const storage = new MemoryStorage();
    const large = record();
    large.source.context = { executionRevision: "opaque-server-reference" };
    const session = owner(async () => result(large), { storage });
    await session.open(ids.aside); session.edit(ids.aside, "recover me");
    const serialized = [...storage.values.values()][0]!;
    expect(serialized).not.toContain("transcript");
    expect(serialized).not.toContain("opaque-server-reference");
    expect(serialized).not.toContain("native");
    expect(serialized.length).toBeLessThan(1000);
    const wrong = record(); wrong.source.storeId = ids.other;
    let calls = 0;
    const restored = owner(async () => { calls++; return result(wrong); }, { storage });
    await restored.save(ids.aside); await restored.setLifecycle(ids.aside, "archived");
    expect(calls).toBe(0);
    await restored.open(ids.aside);
    expect(restored.snapshot().selected).toBeUndefined();
    expect(restored.snapshot().error).toContain("does not match");
    expect(restored.hasUnsavedWork()).toBe(true);
    expect([...storage.values.values()][0]).toContain("recover me");
  });
});
