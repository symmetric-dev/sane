import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { ASIDE_LIMITS, parseAsideSourceSnapshot, type AsideTarget } from "../shared/aside-contract";
import type { ReconciledHistory } from "../shared/conversation/native-history-contract";
import { AsideSourceResolver, type AsideSourcePorts } from "./aside-source";
import { AsideService } from "./aside-service";
import { AsideError } from "./aside-store";
import { TranscriptService } from "./transcript-service";
import { capturedAt, createRequest, digest, ids, questionFixture, sessionFixture, sourceFixture, storeFixture } from "./aside-fixtures";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const questionTarget: AsideTarget = { kind: "question", formId: "form-1", questionIndex: 0 };
function resolverFixture() {
  const session = sessionFixture(), binding = sourceFixture().binding, form = questionFixture();
  let current = true, readable = true, retired = false, captures = 0, authorizations = 0;
  let duringCapture = () => {};
  const ports: AsideSourcePorts = {
    storeId: ids.store,
    authorizeRead: sessionId => {
      if (sessionId !== ids.session) throw new AsideError(404, "source-missing");
      return () => { if (!readable) throw new AsideError(401, "owner-revoked"); };
    },
    authorizeSource: async () => {
      authorizations++;
      if (retired) throw new AsideError(409, "source-retired");
      return { session, binding, assertCurrent: () => { if (!current) throw new AsideError(409, "source-replaced"); } };
    },
    captureTranscript: async captured => {
      captures++;
      expect(captured).not.toBe(session);
      expect(captured).toEqual(session);
      duringCapture();
      await Promise.resolve();
      return sourceFixture().transcript;
    },
    question: () => form,
  };
  const resolver = new AsideSourceResolver(ports);
  return { session, binding, form, ports, resolver,
    drift: (action: () => void) => { duringCapture = action; },
    replace: () => { current = false; }, revoke: () => { readable = false; }, retire: () => { retired = true; },
    counts: () => ({ captures, authorizations }) };
}

describe("aside source resolution and service", () => {
  test("captures a detached inert App reference with revision references, never context bodies or unsent answers", async () => {
    const h = resolverFixture();
    h.session.saneExecution = { schema: 1, revision: "a".repeat(64) };
    h.session.saneContext = { version: 1, framework: "private framework body", assignment: "private assignment body",
      package: { schema: 1, revision: "b".repeat(64), delivery: "standing-native-role" } };
    const { source, assertCurrent } = await h.resolver.resolve(ids.session, questionTarget);
    expect(source).toMatchObject({ storeId: ids.store, sessionId: ids.session, rootSessionId: ids.session,
      native: sourceFixture().native, binding: h.binding, question: { formId: h.form.id, formRevision: 2, questionIndex: 0,
        question: h.form.input.pages[0], anchor: h.form.anchor }, context: { executionRevision: "a".repeat(64), packageRevision: "b".repeat(64) } });
    expect(Object.keys(source.question!).sort()).toEqual(["anchor", "formId", "formRevision", "question", "questionIndex"]);
    expect(JSON.stringify(source)).not.toContain("private framework body");
    expect(JSON.stringify(source)).not.toContain("private assignment body");
    expect(JSON.stringify(source)).not.toContain('"answers"');
    expect(JSON.stringify(source)).not.toContain('"submission"');
    // Unsent answer edits alone do not contaminate or invalidate an immutable
    // question definition (its form revision remains pinned independently).
    h.form.answers = [{ selected: ["A"] }];
    assertCurrent();
    source.question!.question.question = "client mutation";
    expect(h.form.input.pages[0]!.question).toBe("Which approach?");
    expect(h.counts()).toEqual({ captures: 1, authorizations: 1 });
  });

  test("does not pin streaming run status or claim execution readiness", async () => {
    const h = resolverFixture();
    h.drift(() => { h.session.lastStatus = "completed"; h.session.lastRunId = "next-run"; });
    const { source, assertCurrent } = await h.resolver.resolve(ids.session, { kind: "conversation" });
    assertCurrent();
    expect(source.question).toBeUndefined();
    expect(Object.keys(source)).not.toContain("execution");
    expect(Object.keys(source.transcript)).not.toContain("nativePrefix");
  });

  for (const kind of ["source", "binding", "context", "question", "replacement"] as const) {
    test(`${kind} drift during async capture commits no record or receipt`, async () => {
      const h = resolverFixture(), { store, failures } = storeFixture(directories), service = new AsideService(store, h.resolver);
      h.session.saneContext = { version: 1, framework: "original" };
      h.drift(() => {
        if (kind === "source") h.session.nativeSessionId = ids.other;
        if (kind === "binding") h.binding.bindingRevision = "binding-v2";
        if (kind === "context") h.session.saneContext!.framework = "replacement";
        if (kind === "question") h.form.revision++;
        if (kind === "replacement") h.replace();
      });
      const request = { ...createRequest(), target: questionTarget };
      await expect(service.create(ids.session, request)).rejects.toMatchObject({ status: 409 });
      expect(store.summaries()).toEqual([]);
      expect(store.replayCreate(ids.session, request)).toBeUndefined();
      expect(failures).toEqual([]);
    });
  }

  test("the captured guard detects later drift immediately before store commit", async () => {
    const h = resolverFixture(), { store } = storeFixture(directories);
    const resolved = await h.resolver.resolve(ids.session, questionTarget);
    h.form.input.pages[0]!.question = "changed after capture";
    expect(() => store.create(ids.session, { ...createRequest(), target: questionTarget }, resolved.source, resolved.assertCurrent)).toThrow();
    expect(store.summaries()).toEqual([]);
  });

  test("question targets are read server-side and must belong to the exact session/native/binding", async () => {
    for (const change of [
      (h: ReturnType<typeof resolverFixture>) => { h.form.sessionId = ids.other; },
      (h: ReturnType<typeof resolverFixture>) => { h.form.native.nativeId = ids.other; },
      (h: ReturnType<typeof resolverFixture>) => { h.form.native.authorityId = `sane-native-v1:cc:${"b".repeat(64)}`; },
      (h: ReturnType<typeof resolverFixture>) => { h.form.workspaceId = ids.other; },
      (h: ReturnType<typeof resolverFixture>) => { h.form.worktreeId = ids.other; },
      (h: ReturnType<typeof resolverFixture>) => { h.form.bindingRevision = "foreign-binding"; },
      (h: ReturnType<typeof resolverFixture>) => { h.form.cwd = "/foreign/checkout"; },
    ]) {
      const h = resolverFixture(); change(h);
      await expect(h.resolver.resolve(ids.session, questionTarget)).rejects.toMatchObject({ status: 409, code: "aside-question-source" });
      expect(h.counts().captures).toBe(0);
    }
    for (const target of [{ ...questionTarget, questionIndex: 1 }, { ...questionTarget, questionIndex: -1 }]) {
      await expect(resolverFixture().resolver.resolve(ids.session, target)).rejects.toMatchObject({ status: 404, code: "aside-question-missing" });
    }
    const missing = resolverFixture(); missing.ports.question = () => undefined;
    await expect(missing.resolver.resolve(ids.session, questionTarget)).rejects.toMatchObject({ status: 404, code: "aside-question-missing" });
  });

  test("source capture refuses unqualified identities, pending attachments and mismatched bindings before projection", async () => {
    for (const change of [
      (h: ReturnType<typeof resolverFixture>) => { h.session.sessionId = ids.other; },
      (h: ReturnType<typeof resolverFixture>) => { h.session.harness = undefined; },
      (h: ReturnType<typeof resolverFixture>) => { h.session.authorityId = "unqualified"; },
      (h: ReturnType<typeof resolverFixture>) => { h.session.nativeSessionId = "not-a-uuid"; },
      (h: ReturnType<typeof resolverFixture>) => { h.session.attachment!.state = "pending"; },
      (h: ReturnType<typeof resolverFixture>) => { h.binding.cwd = "/different/checkout"; },
    ]) {
      const h = resolverFixture(); change(h);
      await expect(h.resolver.resolve(ids.session, { kind: "conversation" })).rejects.toMatchObject({ status: 409 });
      expect(h.counts().captures).toBe(0);
    }
  });

  test("retired-source create replay returns the original source/state without live authorization or recapture, including restart", async () => {
    const h = resolverFixture(), { store, open } = storeFixture(directories), service = new AsideService(store, h.resolver);
    const request = { ...createRequest(), target: questionTarget }, created = await service.create(ids.session, request);
    service.saveDraft(created.id, { requestId: "edit", expectedRevision: 1, text: "later state" });
    h.retire(); h.form.revision++; h.session.attachment!.state = "pending";
    for (const current of [service, new AsideService(open(), h.resolver)]) {
      expect(await current.create(ids.session, request)).toEqual(created);
      expect(current.get(created.id).draft).toBe("later state");
      expect(current.list(ids.session)).toHaveLength(1);
      await expect(current.create(ids.session, { ...request, draft: "changed intent" })).rejects.toMatchObject({ status: 409, code: "aside-conflict" });
    }
    expect(h.counts()).toEqual({ captures: 1, authorizations: 1 });
    h.revoke();
    await expect(service.create(ids.session, request)).rejects.toMatchObject({ status: 401 });
    expect(() => service.get(created.id)).toThrow();
    expect(() => service.list(ids.session)).toThrow();
  });

  test("service validates input before resolving and rechecks source read authority after capture", async () => {
    const h = resolverFixture(), { store } = storeFixture(directories), service = new AsideService(store, h.resolver);
    await expect(service.create(ids.session, { ...createRequest(), source: sourceFixture() })).rejects.toMatchObject({ status: 400, code: "aside-input" });
    expect(h.counts()).toEqual({ captures: 0, authorizations: 0 });
    h.drift(h.revoke);
    await expect(service.create(ids.session, createRequest())).rejects.toMatchObject({ status: 401 });
    expect(store.summaries()).toEqual([]);
  });

  test("historical mutations recheck read ownership at commit, without requiring a live source", async () => {
    const h = resolverFixture(), { store } = storeFixture(directories), service = new AsideService(store, h.resolver);
    const created = await service.create(ids.session, createRequest()); h.retire();
    const saved = service.saveDraft(created.id, { requestId: "edit", expectedRevision: 1, text: "historical draft" });
    expect(saved.revision).toBe(2);
    let checks = 0;
    h.ports.authorizeRead = () => () => { if (++checks === 4) throw new AsideError(401, "owner-revoked-at-commit"); };
    expect(() => service.setLifecycle(created.id, { requestId: "archive", expectedRevision: 2, lifecycle: "archived" })).toThrow();
    expect(checks).toBe(4);
    expect(store.get(created.id)).toEqual(saved);
    expect(h.counts()).toEqual({ captures: 1, authorizations: 1 });
  });
});

describe("TranscriptService.captureAsideReference", () => {
  function transcriptFixture(count = 2) {
    const session = sessionFixture();
    const history: ReconciledHistory = { sessionId: ids.session, nativeSessionId: ids.session, importedAt: capturedAt,
      activity: "active", reason: "offline fixture", coveredRunIds: [], messages: Array.from({ length: count }, (_, i) => ({
        messageId: `native-${i}`, role: "assistant", status: "running", createdAt: "",
        parts: [{ type: "tool", id: `tool-${i}`, name: "Read", status: "running" }],
      })) };
    const service = new TranscriptService(() => [session], () => [], { get: async () => history });
    return { service, session, history };
  }

  test("captures the full materialized projection, with stable fingerprint, streaming import quirks and detached messages", async () => {
    const { service, session, history } = transcriptFixture(121);
    const snapshot = await service.captureAsideReference(session);
    expect(snapshot.messages).toHaveLength(121);
    expect(snapshot.totalMessages).toBe(121);
    expect(snapshot.boundaryMessageId).toBe("native-120");
    expect(snapshot.fingerprint).toBe(digest(snapshot.messages));
    const original = structuredClone(snapshot);
    parseAsideSourceSnapshot({ ...sourceFixture(), transcript: snapshot });
    expect(snapshot.messages[0]!.time).toBe("");
    expect(Object.hasOwn(snapshot.messages[0]!.parts[0]!, "input")).toBe(false);
    snapshot.messages[0]!.parts.length = 0;
    history.messages[0]!.parts = [{ type: "text", id: "changed", text: "mutated native object" }];
    expect(await service.captureAsideReference(session)).toEqual(original);
  });

  test("empty projections have an explicit null boundary and hash of the empty message list", async () => {
    const { service, session } = transcriptFixture(0), snapshot = await service.captureAsideReference(session);
    expect(snapshot).toMatchObject({ messages: [], totalMessages: 0, boundaryMessageId: null, fingerprint: digest([]) });
  });

  test("oversized complete references are rejected, never truncated to the ordinary transcript page", async () => {
    const many = transcriptFixture(ASIDE_LIMITS.messages + 1);
    await expect(many.service.captureAsideReference(many.session)).rejects.toMatchObject({ status: 413, code: "aside-snapshot-too-large" });
    const large = transcriptFixture(1);
    large.history.messages[0]!.parts = [{ id: "large", type: "text", text: "x".repeat(ASIDE_LIMITS.snapshotBytes) }];
    await expect(large.service.captureAsideReference(large.session)).rejects.toMatchObject({ status: 413, code: "aside-snapshot-too-large" });
  });

  test("projection read failures are classified without exposing filesystem errors", async () => {
    const session = sessionFixture();
    const service = new TranscriptService(() => [session], () => [], { get: async () => { throw new Error("private filesystem path"); } });
    await expect(service.captureAsideReference(session)).rejects.toMatchObject({ status: 409, code: "aside-transcript-unavailable" });
  });
});
