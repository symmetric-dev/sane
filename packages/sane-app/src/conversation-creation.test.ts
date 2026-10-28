import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationRef } from "sane-core/contracts";
import { discoverRepository, initializeRepository, inspectRepositoryStore, openRepositoryDomain } from "sane-core/server";
import { AdmissionService } from "./admission";
import { initializeAppStore, validateAdmissions, type Admission } from "./app-store";
import { CatalogService } from "./catalog";
import { beginConversationCreation, completeConversationCreation, type NativeConversationCreation } from "./conversation-creation";
import { RepositoryRouter, WorkstreamAdapter, WorkstreamAdapterError } from "./workstreams";

// Offline only: private source directories, real durable App records, and (in
// one case) an empty local Git/domain fixture. No native runtime or provider.
const roots: string[] = [];
const routers: RepositoryRouter[] = [];
const adapters: WorkstreamAdapter[] = [];
afterEach(async () => {
  for (const router of routers.splice(0)) await router.close();
  for (const adapter of adapters.splice(0)) adapter.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type CompletionPorts = Pick<AdmissionService, "createNative" | "register" | "ready">;
type BeginInput = Parameters<typeof beginConversationCreation>[1];
const unexpected = () => { throw new Error("Unexpected native allocation/creation"); };

function snapshot(state: Admission["state"] = "identity_known", nativeId: string | null = "ses_created"): Admission {
  return {
    version: 1, requestId: crypto.randomUUID(), sessionId: crypto.randomUUID(), operation: "create", state,
    source: { descriptor: { version: 1, harness: "oc", kind: "local-registration", registrationFile: "/offline/service.json" }, authorityId: `sane-native-v1:oc:${"a".repeat(64)}` },
    binding: { workspaceId: crypto.randomUUID(), worktreeId: crypto.randomUUID(), bindingRevision: crypto.randomUUID(), executionCheckout: "/offline/repo", checkoutPin: null, domain: { mode: "app-only" } },
    nativeId, parent: null, createdAt: "2026-10-27T00:00:00.000Z", error: null,
  };
}

function inputFor(a: Admission): BeginInput {
  return { sessionId: a.sessionId, cwd: a.binding.executionCheckout, workspaceId: a.binding.workspaceId, worktreeId: a.binding.worktreeId, parent: a.parent };
}

function inertPorts(): CompletionPorts {
  return { createNative: unexpected, register: unexpected, ready: unexpected };
}

async function fixture(repository = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "conversation-creation-test-")));
  roots.push(root);
  const data = join(root, "app"), cwd = join(root, "workspace"), profile = join(root, "claude"), registration = join(root, "opencode");
  for (const dir of [data, cwd, profile, registration]) mkdirSync(dir);
  if (repository) execFileSync("git", ["init", "--quiet", cwd], { stdio: "pipe" });
  const { sources, admissions } = initializeAppStore(data, {
    cc: { version: 1, harness: "cc", kind: "local-profile", profileRoot: profile },
    oc: { version: 1, harness: "oc", kind: "local-registration", registrationFile: join(registration, "service.json") },
  });
  const catalog = new CatalogService(data, () => []);
  await catalog.load();
  const { workspaceId, worktreeId } = await catalog.register(cwd);
  const router = new RepositoryRouter(catalog, sources);
  routers.push(router);
  if (repository) {
    // This fixture owns exactly one real domain. Fix only its routing ports,
    // avoiding the unrelated background RepositoryReader worker under bun:test.
    // AdmissionService, catalog checks, checkout pinning and registration remain real.
    const context = initializeRepository(discoverRepository(cwd));
    const adapter = new WorkstreamAdapter(openRepositoryDomain(context), sources);
    adapters.push(adapter);
    router.inspect = async () => inspectRepositoryStore(discoverRepository(cwd));
    router.forAdmission = async () => adapter;
  }
  const service = new AdmissionService(data, admissions, sources, catalog, router);
  const disk = () => validateAdmissions(JSON.parse(readFileSync(join(data, "admissions.json"), "utf8")));
  return {
    data, cwd, service, router, disk,
    input: { sessionId: crypto.randomUUID(), cwd, workspaceId, worktreeId } satisfies BeginInput,
    async reload() {
      const reloadedCatalog = new CatalogService(data, () => []);
      await reloadedCatalog.load();
      const reloadedRouter = new RepositoryRouter(reloadedCatalog, sources);
      routers.push(reloadedRouter);
      return new AdmissionService(data, disk(), sources, reloadedCatalog, reloadedRouter);
    },
  };
}

describe("beginConversationCreation", () => {
  for (const kind of ["allocated", "created"] as const) test(`${kind}: preserves exact begin arguments and allocates only at begin`, async () => {
    const events: string[] = [], a = snapshot();
    const parent: ConversationRef = { harness: "cc", authorityId: `sane-native-v1:cc:${"b".repeat(64)}`, nativeId: crypto.randomUUID() };
    a.parent = parent;
    const input = inputFor(a), nativeId = crypto.randomUUID();
    const native: NativeConversationCreation = kind === "allocated"
      ? { harness: "cc", kind, allocate: () => { events.push("allocate"); return nativeId; } }
      : { harness: "oc", kind, create: unexpected };
    expect(events).toEqual([]);
    events.push("workflow-prepared");
    const admissions: Pick<AdmissionService, "begin"> = {
      begin: async received => {
        events.push("begin");
        expect(received).toEqual({ ...input, operation: "create", harness: native.harness, nativeId: kind === "allocated" ? nativeId : null });
        expect(received.parent).toBe(parent);
        return a;
      },
    };
    expect(await beginConversationCreation(admissions, input, native)).toBe(a);
    expect(events).toEqual(kind === "allocated" ? ["workflow-prepared", "allocate", "begin"] : ["workflow-prepared", "begin"]);
    expect(input).toEqual(inputFor(a));
  });

  test("an allocation exception prevents begin; a begin refusal is propagated without retry", async () => {
    let begins = 0, allocations = 0;
    const failure = new Error("allocation failed"), refusal = new WorkstreamAdapterError(409, "execution-mismatch", "Refused binding");
    const admissions: Pick<AdmissionService, "begin"> = { begin: async () => { begins++; throw refusal; } };
    expect(() => beginConversationCreation(admissions, inputFor(snapshot()), { harness: "cc", kind: "allocated", allocate: () => { throw failure; } })).toThrow(failure);
    expect(begins).toBe(0);
    await expect(beginConversationCreation(admissions, inputFor(snapshot()), { harness: "cc", kind: "allocated", allocate: () => { allocations++; return crypto.randomUUID(); } })).rejects.toBe(refusal);
    expect(begins).toBe(1); expect(allocations).toBe(1);
  });
});

describe("completeConversationCreation ordering", () => {
  test("intent awaits one native acknowledgement, then publication, then registration, then synchronous ready", async () => {
    const intent = snapshot("intent", null), known = { ...intent, state: "identity_known" as const, nativeId: "ses_acknowledged" };
    const ack = Promise.withResolvers<string>(), publishGate = Promise.withResolvers<void>(), registerGate = Promise.withResolvers<void>();
    const publishing = Promise.withResolvers<void>(), registering = Promise.withResolvers<void>();
    const events: string[] = [], value = { published: true };
    let settled = false;
    let latest: Admission = known;
    const native: NativeConversationCreation = { harness: "oc", kind: "created", create: () => { events.push("create"); return ack.promise; } };
    const ports: CompletionPorts = {
      createNative: async (id, create) => {
        expect(id).toBe(intent.sessionId); expect(create).toBe(native.create);
        events.push("createNative");
        expect(await create()).toBe(known.nativeId);
        events.push("acknowledged"); return known;
      },
      register: async id => { expect(id).toBe(intent.sessionId); events.push("register"); registering.resolve(); await registerGate.promise; events.push("registered"); return latest; },
      ready: id => { expect(id).toBe(intent.sessionId); events.push("ready"); latest = { ...known, state: "ready" }; return latest; },
    };
    const completion = completeConversationCreation(ports, intent, native, async admission => {
      expect(admission).toBe(known); events.push("publish"); publishing.resolve(); await publishGate.promise; events.push("published"); return value;
    }).then(result => { settled = true; return result; });
    expect(events).toEqual(["createNative", "create"]); expect(settled).toBe(false);
    ack.resolve(known.nativeId!);
    await publishing.promise;
    expect(events).toEqual(["createNative", "create", "acknowledged", "publish"]); expect(settled).toBe(false);
    publishGate.resolve(); await registering.promise;
    expect(events).toEqual(["createNative", "create", "acknowledged", "publish", "published", "register"]); expect(settled).toBe(false);
    registerGate.resolve();
    const result = await completion;
    expect(events).toEqual(["createNative", "create", "acknowledged", "publish", "published", "register", "registered", "ready"]);
    expect(result.admission).toBe(known); expect(result.admission.state).toBe("identity_known"); expect(result.value).toBe(value);
    expect(latest.state).toBe("ready"); expect(intent.state).toBe("intent");
  });

  for (const state of ["identity_known", "ready"] as const) {
    for (const kind of ["allocated", "created"] as const) test(`${state}/${kind}: keeps identity, republishes/registers, and never allocates or creates`, async () => {
      const a = snapshot(state), events: string[] = [];
      const before = structuredClone(a);
      const native: NativeConversationCreation = kind === "allocated" ? { harness: "cc", kind, allocate: unexpected } : { harness: "oc", kind, create: unexpected };
      const ports: CompletionPorts = {
        createNative: unexpected,
        register: async id => { expect(id).toBe(a.sessionId); events.push("register"); return a; },
        ready: id => { expect(id).toBe(a.sessionId); events.push("ready"); return { ...a, state: "ready" }; },
      };
      for (let i = 0; i < 2; i++) {
        const result = await completeConversationCreation(ports, a, native, async received => { expect(received).toBe(a); events.push("publish"); return i; });
        expect(result.admission).toBe(a); expect(result.value).toBe(i);
      }
      expect(events).toEqual(state === "ready" ? ["publish", "register", "publish", "register"] : ["publish", "register", "ready", "publish", "register", "ready"]);
      expect(a).toEqual(before);
    });
  }

  test("allocated intent refuses before allocation, native creation, publication, registration, or ready", async () => {
    const completion = completeConversationCreation(inertPorts(), snapshot("intent", null), { harness: "cc", kind: "allocated", allocate: unexpected }, unexpected);
    await expect(completion).rejects.toBeInstanceOf(WorkstreamAdapterError);
    await expect(completion).rejects.toMatchObject({ status: 409, code: "native-creation-not-retryable" });
  });

  for (const [state, nativeId] of [
    ["identity_known", null], ["ready", null], ["identity_known", ""],
    ["native_creation_unknown", null], ["native_creation_unknown", "ses_do_not_trust"],
  ] as const) test(`${state}/${String(nativeId)} refuses before any completion side effect`, async () => {
    await expect(completeConversationCreation(inertPorts(), snapshot(state, nativeId), { harness: "oc", kind: "created", create: unexpected }, unexpected))
      .rejects.toMatchObject({ status: 409, code: "native_creation_unknown" });
  });

  for (const state of ["identity_known", "native_creation_unknown"] as const) test(`an unusable ${state} creation acknowledgement cannot reach publication`, async () => {
    const intent = snapshot("intent", null);
    const ports: CompletionPorts = { ...inertPorts(), createNative: async () => ({ ...intent, state }) };
    await expect(completeConversationCreation(ports, intent, { harness: "oc", kind: "created", create: unexpected }, unexpected))
      .rejects.toMatchObject({ status: 409, code: "native_creation_unknown" });
  });
});

describe("real AdmissionService durable creation", () => {
  test("unknown is on disk before native entry; delayed acknowledgement blocks publication and produces a known snapshot", async () => {
    const f = await fixture(), ack = Promise.withResolvers<string>(), entered = Promise.withResolvers<void>();
    let creates = 0, publications = 0;
    const native: NativeConversationCreation = { harness: "oc", kind: "created", create: async () => {
      creates++;
      expect(f.disk().admissions).toEqual([{ ...intent, state: "native_creation_unknown" }]);
      expect(f.service.get(intent.sessionId)?.state).toBe("native_creation_unknown");
      entered.resolve(); return ack.promise;
    } };
    const intent = await beginConversationCreation(f.service, f.input, native);
    expect(intent.state).toBe("intent"); expect(creates).toBe(0);
    const completion = completeConversationCreation(f.service, intent, native, async a => {
      publications++; expect(a.state).toBe("identity_known"); expect(a.nativeId).toBe("ses_durable_ack");
      expect(f.disk().admissions).toEqual([a]); return { id: a.nativeId };
    });
    await entered.promise;
    expect(publications).toBe(0); expect(creates).toBe(1);
    expect((await f.reload()).get(intent.sessionId)?.state).toBe("native_creation_unknown");
    ack.resolve("ses_durable_ack");
    const result = await completion;
    expect(creates).toBe(1); expect(publications).toBe(1);
    expect(result.value).toEqual({ id: "ses_durable_ack" }); expect(result.admission.state).toBe("identity_known");
    expect(f.disk().admissions).toEqual([{ ...result.admission, state: "ready" }]);
    expect(intent.state).toBe("intent"); expect(intent.nativeId).toBeNull();
  });

  test("lost acknowledgement remains durably unknown and refuses stale-intent, current, and reloaded retries", async () => {
    const f = await fixture(), failure = new Error("native created a session but its acknowledgement was lost");
    let creates = 0;
    const native: NativeConversationCreation = { harness: "oc", kind: "created", create: async () => { creates++; throw failure; } };
    const intent = await beginConversationCreation(f.service, f.input, native);
    await expect(completeConversationCreation(f.service, intent, native, unexpected)).rejects.toBe(failure);
    const bytes = readFileSync(join(f.data, "admissions.json"), "utf8");
    expect(f.disk().admissions).toEqual([{ ...intent, state: "native_creation_unknown" }]);
    for (const service of [f.service, await f.reload()]) {
      await expect(completeConversationCreation(service, intent, native, unexpected)).rejects.toMatchObject({ status: 409, code: "native-creation-not-retryable" });
      await expect(completeConversationCreation(service, service.get(intent.sessionId)!, native, unexpected)).rejects.toMatchObject({ status: 409, code: "native_creation_unknown" });
      await expect(service.createNative(intent.sessionId, native.create)).rejects.toMatchObject({ status: 409, code: "native-creation-not-retryable" });
      await expect(beginConversationCreation(service, f.input, native)).rejects.toMatchObject({ status: 409, code: "admission-exists" });
    }
    expect(creates).toBe(1); expect(readFileSync(join(f.data, "admissions.json"), "utf8")).toBe(bytes);
  });

  for (const stage of ["publish", "register", "ready"] as const) test(`${stage} failure preserves known durable identity without automatic recreation or rollback`, async () => {
    const f = await fixture(), failure = new Error(`${stage} failed`), events: string[] = [];
    let creates = 0, fail = true;
    const native: NativeConversationCreation = { harness: "oc", kind: "created", create: async () => { creates++; return "ses_preserved"; } };
    const intent = await beginConversationCreation(f.service, f.input, native);
    const ports: CompletionPorts = {
      createNative: (id, create) => f.service.createNative(id, create),
      register: async id => { events.push("register"); if (fail && stage === "register") throw failure; return f.service.register(id); },
      ready: id => { events.push("ready"); if (fail && stage === "ready") throw failure; return f.service.ready(id); },
    };
    const publish = async (a: Admission) => {
      events.push("publish"); expect(a.nativeId).toBe("ses_preserved");
      if (fail && stage === "publish") throw failure;
      return "published";
    };
    await expect(completeConversationCreation(ports, intent, native, publish)).rejects.toBe(failure);
    expect(events).toEqual(stage === "publish" ? ["publish"] : stage === "register" ? ["publish", "register"] : ["publish", "register", "ready"]);
    expect(creates).toBe(1);
    const known = f.service.get(intent.sessionId)!;
    expect(known).toEqual({ ...intent, state: "identity_known", nativeId: "ses_preserved" });
    expect(f.disk().admissions).toEqual([known]); expect((await f.reload()).get(intent.sessionId)).toEqual(known);
    // Explicit same-identity retry only, using the actual durable known record.
    fail = false; events.length = 0;
    const result = await completeConversationCreation(ports, known, native, publish);
    expect(events).toEqual(["publish", "register", "ready"]); expect(creates).toBe(1);
    expect(result).toEqual({ admission: known, value: "published" }); expect(result.admission).toBe(known);
    expect(f.disk().admissions).toEqual([{ ...known, state: "ready" }]);
  });

  test("a real binding refusal persists no intent and never calls native creation", async () => {
    const f = await fixture();
    await expect(beginConversationCreation(f.service, { ...f.input, cwd: f.data }, { harness: "oc", kind: "created", create: unexpected }))
      .rejects.toMatchObject({ status: 409, code: "execution-mismatch" });
    expect(f.disk()).toEqual({ version: 1, admissions: [] }); expect(f.service.list()).toEqual([]);
  });

  test("real repository registration retains exact parent, source and checkout binding through ready and explicit retry", async () => {
    const f = await fixture(true);
    const parentNative: NativeConversationCreation = { harness: "cc", kind: "allocated", allocate: () => crypto.randomUUID() };
    const parent = await beginConversationCreation(f.service, f.input, parentNative);
    await completeConversationCreation(f.service, parent, parentNative, async () => undefined);
    const ref: ConversationRef = { harness: "cc", authorityId: parent.source.authorityId, nativeId: parent.nativeId! };
    const nativeId = crypto.randomUUID(); let allocations = 0;
    const native: NativeConversationCreation = { harness: "cc", kind: "allocated", allocate: () => { allocations++; return nativeId; } };
    const a = await beginConversationCreation(f.service, { ...f.input, sessionId: crypto.randomUUID(), parent: ref }, native);
    expect(a.parent).toEqual(ref); expect(a.binding).toEqual(parent.binding); expect(a.source).toEqual(parent.source);
    expect(a.binding.domain.mode).toBe("repository"); expect(a.binding.checkoutPin?.path).toBe(f.cwd);
    const publish = async (received: Admission) => { expect(received.parent).toEqual(ref); expect(received.binding).toEqual(a.binding); return "associated"; };
    const result = await completeConversationCreation(f.service, a, native, publish);
    expect(result.admission).toBe(a); expect(result.admission.state).toBe("identity_known");
    const ready = f.service.get(a.sessionId)!;
    expect(ready).toEqual({ ...a, state: "ready" });
    expect((await completeConversationCreation(f.service, ready, native, publish)).admission).toBe(ready);
    expect(allocations).toBe(1);
    const adapter = await f.router.forAdmission(ready);
    const registered = adapter!.domain.getConversation({ harness: "cc", authorityId: a.source.authorityId, nativeId });
    expect(registered?.parent).toEqual(ref);
    expect(f.disk().admissions.find(record => record.sessionId === a.sessionId)).toEqual(ready);
  });
});
