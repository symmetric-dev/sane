import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, linkSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ASIDE_LIMITS, parseAsideCreateRequest, parseAsideDraftRequest, parseAsideLifecycleRequest, parseAsideRecord, parseAsideSourceSnapshot } from "../shared/aside-contract";
import { AsideError, AsideStore } from "./aside-store";
import { createRequest, digest, ids, questionFixture, sourceFixture, storeFixture } from "./aside-fixtures";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const noDrift = () => {};
function fails(action: () => unknown, status: number, code: string) {
  let error: unknown;
  try { action(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(AsideError);
  expect(error).toMatchObject({ status, code });
}

describe("aside strict JSON contracts", () => {
  test("create accepts only a client intent, not client-supplied sources or execution fields", () => {
    expect(parseAsideCreateRequest(createRequest())).toEqual(createRequest());
    for (const input of [null, [], {}, { ...createRequest(), source: sourceFixture() }, { ...createRequest(), execution: true },
      { ...createRequest(), target: { kind: "conversation", formId: "form-1" } },
      { ...createRequest(), target: { kind: "question", formId: "form-1", questionIndex: 32 } },
      { ...createRequest(), requestId: " bad " }, { ...createRequest(), draft: "bad\0text" },
      { ...createRequest(), draft: "x".repeat(ASIDE_LIMITS.draftChars + 1) }]) {
      expect(() => parseAsideCreateRequest(input)).toThrow();
    }
  });

  test("JSON validation rejects getters without invoking them, toJSON, cycles, sparse arrays and nonfinite opaque data", () => {
    let invoked = false;
    const accessor = Object.defineProperty({}, "requestId", { enumerable: true, get: () => { invoked = true; return "evil"; } });
    expect(() => parseAsideCreateRequest(accessor)).toThrow();
    expect(invoked).toBe(false);
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    for (const input of [{ ...createRequest(), toJSON() { invoked = true; return createRequest(); } }, Object.assign(new Date(), createRequest()), cycle]) {
      expect(() => parseAsideCreateRequest(input)).toThrow();
    }
    for (const value of [NaN, Infinity, undefined, 1n, new Array(1), { toJSON() { invoked = true; return null; } }, cycle]) {
      const source = sourceFixture();
      source.transcript.messages[0]!.parts = [{ type: "tool", id: "tool-1", name: "Read", input: value }];
      expect(() => parseAsideSourceSnapshot(source)).toThrow();
    }
    expect(invoked).toBe(false);
  });

  test("mutation schemas reject stale-shape revisions, unknown fields and invalid lifecycles", () => {
    for (const revision of [0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseAsideDraftRequest({ requestId: "draft", expectedRevision: revision, text: "ok" })).toThrow();
    }
    expect(() => parseAsideDraftRequest({ requestId: "draft", expectedRevision: 1, text: "ok", draft: "extra" })).toThrow();
    expect(() => parseAsideLifecycleRequest({ requestId: "archive", expectedRevision: 1, lifecycle: "deleted" })).toThrow();
  });

  test("complete source snapshots retain empty timestamps and absent streaming tool input, but reject broken boundaries", () => {
    const source = sourceFixture();
    expect(parseAsideSourceSnapshot(source)).toEqual(source);
    expect(Object.hasOwn(parseAsideSourceSnapshot(source).transcript.messages[0]!.parts[1]!, "input")).toBe(false);
    for (const change of [
      (s: typeof source) => { s.transcript.totalMessages++; },
      (s: typeof source) => { s.transcript.boundaryMessageId = "missing"; },
      (s: typeof source) => { s.transcript.messages.push(s.transcript.messages[0]!); s.transcript.totalMessages++; },
      (s: typeof source) => { s.binding.cwd = "/offline/../escape"; },
      (s: typeof source) => { s.native.authorityId = `sane-native-v1:oc:${"a".repeat(64)}`; },
    ]) { const changed = structuredClone(source); change(changed); expect(() => parseAsideSourceSnapshot(changed)).toThrow(); }
  });
});

describe("App-owned aside ledger", () => {
  test("returns detached records and summaries; source and identity stay immutable across edits", () => {
    const { store } = storeFixture(directories), source = sourceFixture();
    const form = questionFixture();
    source.question = { formId: form.id, formRevision: form.revision, questionIndex: 0, question: form.input.pages[0]!, anchor: form.anchor };
    const request = { ...createRequest(), target: { kind: "question" as const, formId: form.id, questionIndex: 0 } };
    const created = store.create(ids.session, request, source, noDrift), original = structuredClone(created);
    created.source.question!.question.question = "client mutation"; source.binding.cwd = "/client/mutation";
    store.get(created.id)!.source.transcript.messages.length = 0;
    const summary = store.list(ids.session)[0]!; summary.question!.formId = "changed";
    store.summaries()[0]!.lifecycle = "discarded";
    expect(store.get(created.id)).toEqual(original);
    expect(store.list(ids.session)[0]!.question!.formId).toBe(form.id);
    expect(store.list(ids.other)).toEqual([]);
    const saved = store.saveDraft(created.id, { requestId: "draft-1", expectedRevision: 1, text: "New draft" }, noDrift);
    expect(saved).toMatchObject({ id: original.id, source: original.source, createdAt: original.createdAt, draft: "New draft", revision: 2 });
    expect(Object.keys(store.list(ids.session)[0]!)).not.toContain("draft");
    expect(Object.keys(saved)).not.toContain("execution");
  });

  test("verifies server fingerprints and store/session/target ownership before commit", () => {
    const { store, dir } = storeFixture(directories);
    for (const change of [
      (s: ReturnType<typeof sourceFixture>) => { s.transcript.messages[0]!.parts = [{ type: "text", text: "changed without a hash" }]; },
      (s: ReturnType<typeof sourceFixture>) => { s.storeId = ids.other; },
      (s: ReturnType<typeof sourceFixture>) => { s.sessionId = ids.other; },
    ]) { const source = sourceFixture(); change(source); fails(() => store.create(ids.session, createRequest(), source, noDrift), 400, "aside-invalid"); }
    fails(() => store.create(ids.session, { ...createRequest(), target: { kind: "question", formId: "form-1", questionIndex: 0 } }, sourceFixture(), noDrift), 400, "aside-invalid");
    expect(store.summaries()).toEqual([]);
    expect(() => statSync(join(dir, "asides.json"))).toThrow();
  });

  test("same requests replay their ORIGINAL revision, draft and source after later edits and restart", () => {
    const { store, open } = storeFixture(directories), source = sourceFixture(), request = createRequest();
    const created = store.create(ids.session, request, source, noDrift);
    const draftRequest = { requestId: "draft-1", expectedRevision: 1, text: "Second state" };
    const drafted = store.saveDraft(created.id, draftRequest, noDrift);
    const archived = store.setLifecycle(created.id, { requestId: "archive-1", expectedRevision: 2, lifecycle: "archived" }, noDrift);
    expect(archived.revision).toBe(3);
    source.transcript.revision = "later-live-revision";
    const shouldNotCheckLiveSource = () => { throw new Error("replay must not recapture/check a live source"); };
    for (const current of [store, open()]) {
      expect(current.create(ids.session, request, source, shouldNotCheckLiveSource)).toEqual(created);
      expect(current.saveDraft(created.id, draftRequest, shouldNotCheckLiveSource)).toEqual(drafted);
      expect(current.get(created.id)).toEqual(archived);
    }
  });

  test("request IDs conflict for changed intent, another aside, or another operation within the source", () => {
    const { store } = storeFixture(directories), source = sourceFixture(), request = createRequest();
    const first = store.create(ids.session, request, source, noDrift);
    const second = store.create(ids.session, createRequest("create-2"), source, noDrift);
    fails(() => store.create(ids.session, { ...request, draft: "different" }, source, noDrift), 409, "aside-conflict");
    fails(() => store.saveDraft(first.id, { requestId: request.requestId, expectedRevision: 1, text: request.draft }, noDrift), 409, "aside-conflict");
    store.saveDraft(first.id, { requestId: "shared", expectedRevision: 1, text: "edited" }, noDrift);
    fails(() => store.saveDraft(first.id, { requestId: "shared", expectedRevision: 1, text: "changed" }, noDrift), 409, "aside-conflict");
    fails(() => store.saveDraft(second.id, { requestId: "shared", expectedRevision: 1, text: "edited" }, noDrift), 409, "aside-conflict");
    fails(() => store.setLifecycle(first.id, { requestId: "shared", expectedRevision: 2, lifecycle: "archived" }, noDrift), 409, "aside-conflict");
    const other = sourceFixture(); other.sessionId = other.rootSessionId = ids.other;
    expect(store.create(ids.other, request, other, noDrift).revision).toBe(1);
  });

  test("revision conflicts do not commit; archive can reopen and discard is terminal retained data", () => {
    const { store, open, dir } = storeFixture(directories);
    const created = store.create(ids.session, createRequest(), sourceFixture(), noDrift);
    const originalBytes = readFileSync(join(dir, "asides.json"), "utf8");
    fails(() => store.saveDraft(created.id, { requestId: "stale", expectedRevision: 2, text: "wrong" }, noDrift), 409, "aside-conflict");
    expect(readFileSync(join(dir, "asides.json"), "utf8")).toBe(originalBytes);
    store.setLifecycle(created.id, { requestId: "archive", expectedRevision: 1, lifecycle: "archived" }, noDrift);
    fails(() => store.saveDraft(created.id, { requestId: "closed", expectedRevision: 2, text: "wrong" }, noDrift), 409, "aside-conflict");
    store.setLifecycle(created.id, { requestId: "reopen", expectedRevision: 2, lifecycle: "open" }, noDrift);
    const discarded = store.setLifecycle(created.id, { requestId: "discard", expectedRevision: 3, lifecycle: "discarded" }, noDrift);
    expect(discarded).toMatchObject({ source: created.source, draft: created.draft, revision: 4, lifecycle: "discarded" });
    for (const lifecycle of ["open", "archived", "discarded"] as const) {
      fails(() => store.setLifecycle(created.id, { requestId: `after-${lifecycle}`, expectedRevision: 4, lifecycle }, noDrift), 409, "aside-conflict");
    }
    fails(() => store.saveDraft(created.id, { requestId: "after-draft", expectedRevision: 4, text: "wrong" }, noDrift), 409, "aside-conflict");
    expect(open().get(created.id)).toEqual(discarded);
    expect(store.list(ids.session)[0]!.lifecycle).toBe("discarded");
    expect(store.replayCreate(ids.session, createRequest())).toEqual(created);
  });

  test("a final source guard refusal leaves no receipt/record and does not poison healthy storage", () => {
    const { store, failures } = storeFixture(directories), source = sourceFixture(), request = createRequest();
    const refusal = new AsideError(409, "aside-source-changed");
    expect(() => store.create(ids.session, request, source, () => { throw refusal; })).toThrow(refusal);
    expect(store.summaries()).toEqual([]);
    expect(store.replayCreate(ids.session, request)).toBeUndefined();
    const created = store.create(ids.session, request, source, noDrift);
    expect(() => store.saveDraft(created.id, { requestId: "save", expectedRevision: 1, text: "not committed" }, () => { throw refusal; })).toThrow(refusal);
    expect(store.get(created.id)).toEqual(created);
    expect(failures).toEqual([]);
  });

  test("per-source record budget rejects only the excess operation, retaining all originals", () => {
    const { store, open, failures } = storeFixture(directories), source = sourceFixture();
    for (let n = 0; n < ASIDE_LIMITS.sourceRecords; n++) store.create(ids.session, createRequest(`create-${n}`), source, noDrift);
    fails(() => store.create(ids.session, createRequest("excess"), source, noDrift), 429, "aside-limit");
    expect(store.list(ids.session)).toHaveLength(ASIDE_LIMITS.sourceRecords);
    expect(open().list(ids.session)).toHaveLength(ASIDE_LIMITS.sourceRecords);
    expect(store.replayCreate(ids.session, createRequest("excess"))).toBeUndefined();
    expect(failures).toEqual([]);
  });

  test("per-source byte budget is enforced at mutation without pruning original replay receipts", () => {
    const { store, open, dir, failures } = storeFixture(directories);
    const original = store.create(ids.session, createRequest(), sourceFixture(), noDrift);
    // Build a valid compact history just below the real 16 MiB budget; no limit
    // overrides and no hundreds-of-commits setup loop are needed.
    const path = join(dir, "asides.json"), ledger = JSON.parse(readFileSync(path, "utf8"));
    const draft = "x".repeat(ASIDE_LIMITS.draftChars);
    for (let revision = 2; revision <= 167; revision++) {
      const request = { requestId: `draft-${revision}`, expectedRevision: revision - 1, text: draft };
      const state = { draft, lifecycle: "open", revision, updatedAt: original.updatedAt };
      ledger.receipts.push({ operation: "draft", id: original.id, requestId: request.requestId,
        fingerprint: digest([ids.session, "draft", original.id, request]), state });
      Object.assign(ledger.records[0], state);
    }
    writeFileSync(path, JSON.stringify(ledger), { mode: 0o600 });
    const current = open(), before = readFileSync(path, "utf8");
    fails(() => current.saveDraft(original.id, { requestId: "excess-bytes", expectedRevision: 167, text: draft }, noDrift), 429, "aside-limit");
    expect(current.get(original.id)!.revision).toBe(167);
    expect(current.replayCreate(ids.session, createRequest())).toEqual(original);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(failures).toEqual([]);
  });

  test("startup rejects corruption, forged fingerprints, absent receipts, and foreign store IDs", () => {
    const { store, dir } = storeFixture(directories);
    const created = store.create(ids.session, createRequest(), sourceFixture(), noDrift);
    const path = join(dir, "asides.json"), original = readFileSync(path, "utf8");
    for (const corrupt of [
      () => "{not-json", () => JSON.stringify({ ...JSON.parse(original), storeId: ids.other }),
      () => { const v = JSON.parse(original); v.receipts = []; return JSON.stringify(v); },
      () => { const v = JSON.parse(original); v.records[0].source.transcript.fingerprint = "0".repeat(64); return JSON.stringify(v); },
      () => { const v = JSON.parse(original); v.receipts[0].fingerprint = "0".repeat(64); return JSON.stringify(v); },
      () => { const v = JSON.parse(original); v.records[0].id = randomUUID(); return JSON.stringify(v); },
    ]) {
      writeFileSync(path, corrupt(), { mode: 0o600 });
      const failures: unknown[] = [];
      fails(() => new AsideStore(dir, ids.store, e => { failures.push(e); }), 503, "aside-storage");
      expect(failures).toHaveLength(1);
    }
    expect(parseAsideRecord(created)).toEqual(created);
  });

  test("unsafe file permissions, symlinks, hardlinks and writable roots fail closed", () => {
    const { store, dir } = storeFixture(directories);
    store.create(ids.session, createRequest(), sourceFixture(), noDrift);
    const path = join(dir, "asides.json"), original = readFileSync(path);
    chmodSync(path, 0o644);
    fails(() => new AsideStore(dir, ids.store, noDrift), 503, "aside-storage");
    chmodSync(path, 0o600);
    linkSync(path, join(dir, "hardlink"));
    fails(() => new AsideStore(dir, ids.store, noDrift), 503, "aside-storage");
    rmSync(join(dir, "hardlink")); renameSync(path, join(dir, "owned-original")); symlinkSync(join(dir, "owned-original"), path);
    fails(() => new AsideStore(dir, ids.store, noDrift), 503, "aside-storage");
    rmSync(path); writeFileSync(path, original, { mode: 0o600 }); chmodSync(dir, 0o777);
    fails(() => new AsideStore(dir, ids.store, noDrift), 503, "aside-storage");
    chmodSync(dir, 0o700);
  });

  test("external ledger replacement latches storage failure before a write can overwrite it", () => {
    const { store, dir, failures } = storeFixture(directories);
    const created = store.create(ids.session, createRequest(), sourceFixture(), noDrift), path = join(dir, "asides.json");
    const replacement = `${readFileSync(path, "utf8")}\n`;
    writeFileSync(join(dir, "replacement"), replacement, { mode: 0o600 }); renameSync(join(dir, "replacement"), path);
    fails(() => store.saveDraft(created.id, { requestId: "save", expectedRevision: 1, text: "cannot overwrite" }, noDrift), 503, "aside-storage");
    expect(readFileSync(path, "utf8")).toBe(replacement);
    expect(failures).toHaveLength(1);
    fails(() => store.get(created.id), 503, "aside-storage");
    fails(() => store.list(ids.session), 503, "aside-storage");
  });
});
