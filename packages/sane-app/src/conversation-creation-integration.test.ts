import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript";
import { canonicalSlot, DomainError } from "sane-core/server";
import { isAssistantAgentId, isStoredAssistantAgentId, nativeAgentId } from "sane-core/agent-catalog";
import { agentLaunchSnapshot, saneContextSnapshot, workerAssignmentOnly } from "./agent-launch";
import { genericSessionTitle, legacyProfileId, type AgentProfiles } from "./agent-profiles-contract";
import { beginConversationCreation, completeConversationCreation } from "./conversation-creation";
import { synchronousDispatchHook } from "./dispatch-evidence";
import { createExecutionPreparationService } from "./execution-preparation-service";
import { dispatchHarness, requireOperation, validateHarness } from "./harness-operations";
import { toSessionHarness } from "./harness-names";
import { type Metadata, type Session, uuid } from "./history";
import { MetadataPublisher } from "./metadata-publication";
import { claudeConversationCreation, openCodeConversationCreation } from "./native-conversation-creation";
import {
  assertPreparedUserInputCurrent, prepareUserInput, revalidatePreparedUserInput, UserInputPreparationError,
} from "./user-input-preparation";
import { WorkstreamAdapterError } from "./workstreams";

// EXECUTABLE SOURCE-WIRING coverage, NOT a booted bridge integration test.
// The tree has no reusable offline bridge-boot fixture. Select complete, unedited
// production closures by AST (not source regex) and inject their lexical ports.
// Real: bridge control flow, creation helpers/native factories, prepared-input
// guards, activation reservation IO, metadata publication, assignment rendering.
// Doubles: admissions/domain/catalog, coordinator, native adapter and executor.
// In particular, the executor marks an invocation, NOT native/model acceptance;
// this does not cover HTTP, startOwned initialization or native run installation.
// No mock.module, processes, listeners, installed profiles or native services.
const bridge = ts.createSourceFile("bridge.ts", readFileSync(new URL("./bridge.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function selectNode(predicate: (node: ts.Node) => boolean): ts.Node {
  const matches: ts.Node[] = [];
  const visit = (node: ts.Node) => { if (predicate(node)) matches.push(node); ts.forEachChild(node, visit); };
  visit(bridge);
  if (matches.length !== 1) throw new Error(`Bridge fixture requires exactly one AST match; found ${matches.length}`);
  return matches[0]!;
}
function bridgeClosure(name: string, ports: Record<string, unknown>): any {
  const node = selectNode(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  return compileClosure(`(${node.getText(bridge)})`, ports);
}
function workerLaunch(ports: Record<string, unknown>): any {
  const declaration = selectNode(node => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "workers") as ts.VariableDeclaration;
  const initializer = declaration.initializer;
  if (!initializer || !ts.isNewExpression(initializer)) throw new Error("WorkerService initialization changed");
  const methods = initializer.arguments?.[1];
  if (!methods || !ts.isObjectLiteralExpression(methods)) throw new Error("WorkerService ports changed");
  const method = methods.properties.find(node => ts.isMethodDeclaration(node) && node.name.getText(bridge) === "launch");
  if (!method) throw new Error("Worker launch method missing");
  return compileClosure(`({${method.getText(bridge)}}).launch`, ports);
}
function compileClosure(expression: string, ports: Record<string, unknown>) {
  const { outputText } = ts.transpileModule(`const selected = ${expression};`, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None } });
  return new Function(...Object.keys(ports), `${outputText}\nreturn selected;`)(...Object.values(ports));
}

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
type Harness = "claude-code" | "opencode";

function fixture(harness: Harness) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "conversation-creation-wiring-")));
  roots.push(root);
  const sessionId = crypto.randomUUID(), storeId = crypto.randomUUID();
  const nativeHarness = harness === "opencode" ? "oc" : "cc";
  const authorityId = `sane-native-v1:${nativeHarness}:${"a".repeat(64)}`;
  const nativeId = harness === "opencode" ? "ses_creation_fixture" : crypto.randomUUID();
  const association = { association: "resolved", workspaceId: "fixture-workspace", worktreeId: "fixture-worktree" };
  const meta: Metadata & { version: 1 } = { version: 1, sessions: [], runs: [], reconciliationRequired: false };
  const order: string[] = [], rows = new Map<string, any>();
  const state = { holds: true, authorityId, failMetadata: false, failAssociation: false };
  const callbacks = { afterAssociate: () => {}, afterBegin: () => {}, afterNativeCreate: () => {} };
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ format: "sane-app-store", version: 1, storeId, createdAt: "2026-10-27T00:00:00.000Z" }), { mode: 0o600 });
  writeFileSync(join(root, "metadata.json"), JSON.stringify(meta), { mode: 0o600 });
  const publisher = new MetadataPublisher(root, storeId, { assertStorage: () => {}, failClosed: error => { throw error; } });
  const disk = () => JSON.parse(readFileSync(join(root, "metadata.json"), "utf8")) as Metadata;
  const persist = mock(async () => {
    if (state.failMetadata) throw new Error("fixture metadata publication failed");
    publisher.commitSerialized(JSON.stringify(meta)); order.push("metadata");
  });
  const knownAdmission = (id = sessionId, phase = "identity_known") => ({
    sessionId: id, state: phase, operation: "create", nativeId,
    source: { authorityId, descriptor: { harness: nativeHarness } },
    binding: { ...association, executionCheckout: root, domain: { mode: "repository", repositoryId: "fixture-repository" } },
  });
  const admissions = {
    get: (id: string) => rows.get(id),
    begin: mock(async (input: any) => {
      order.push("begin");
      const row = { ...knownAdmission(input.sessionId, input.nativeId ? "identity_known" : "intent"), nativeId: input.nativeId };
      rows.set(input.sessionId, row); callbacks.afterBegin(); return row;
    }),
    createNative: mock(async (id: string, create: () => Promise<string>) => {
      const row = rows.get(id); row.state = "native_creation_unknown"; order.push("unknown");
      row.nativeId = await create(); row.state = "identity_known"; return row;
    }),
    register: mock(async (id: string) => { expect(rows.get(id).nativeId).toBe(nativeId); order.push("register"); }),
    ready: mock((id: string) => { rows.get(id).state = "ready"; order.push("ready"); }),
  };
  const catalog = {
    register: mock(async () => { order.push("catalog-register"); return association; }),
    associate: mock(async () => {
      order.push("associate"); if (state.failAssociation) throw new Error("fixture association failed");
      callbacks.afterAssociate(); return association;
    }),
  };
  const allocate = mock(() => { order.push("allocate"); return nativeId; });
  const oc = {
    createResolved: mock(async (_cwd: string, _launch: unknown) => { order.push("native-create"); callbacks.afterNativeCreate(); return { id: nativeId }; }),
    resolveLaunch: mock(async () => { order.push("resolve-launch"); return { agent: "build" }; }),
    recoverLaunch: mock(async () => { order.push("recover-launch"); return { agent: "build" }; }),
    activity: mock(async () => ({ active: false, pending: false })),
    assertIdle: mock(async () => {}),
  };
  const forbidden = mock((): never => { throw new Error("Unexpected canonical package read in legacy/base fixture"); });
  const activationService = createExecutionPreparationService({ dataDir: root,
    executionPackages: { create: forbidden, load: forbidden }, contextPackages: { create: forbidden, load: forbidden },
    getSession: id => meta.sessions.find(s => s.sessionId === id), getAdmission: admissions.get, executionContext: forbidden,
  });
  const prepareSaneContext = mock(async () => ({ saneContext: { version: 1, framework: "Synthetic reserved framework" } }));
  const executionReservation = mock(activationService.executionReservation);
  const lease = { id: "fixture-lease" };
  const coordinator = {
    holdsAdmission: (candidate: unknown) => candidate === lease && state.holds,
    hasOwner: () => false, hasReconciliation: () => false,
    inspectReadiness: () => ({ ready: true }),
    releaseAdmission: mock(() => { order.push("release"); }),
  };
  const domain = {
    resolveContext: mock(() => { order.push("assignment"); return { artifactsRoot: null, executionCheckout: root, workstream: null }; }),
  };
  const router = { forAdmission: mock(async () => ({ domain })), forWorkspace: mock(async () => ({ domain })) };
  const profiles: AgentProfiles = { version: 1, defaultId: "base:cc", profiles: [] };
  const preparationState = () => ({ getSession: (id: string) => meta.sessions.find(s => s.sessionId === id), profiles, sourceAuthorityId: () => state.authorityId });
  const executePrompt = mock((_lease: unknown, session: Session, run: any, prompt: string, _resume: boolean, _origin: string, options: any) => {
    // This is the fixture's terminal boundary, not an actual native effect. Its
    // disk checks prove publication wasn't merely enqueued before invocation.
    expect(disk().sessions.find(row => row.sessionId === session.sessionId)).toEqual(session);
    expect(admissions.get(session.sessionId).state).toBe("ready");
    options.validate?.();
    order.push("run", "prompt");
    expect(prompt).toContain("authored prompt");
    return { admission: Promise.resolve({ state: "admitted" }), owner: { run } };
  });
  // Intentionally loose lexical port types: these are test doubles for private
  // closures, not a proposed public bridge dependency-injection API.
  const ports: Record<string, any> = {
    meta, admissions, catalog, oc, coordinator, router, persist, executionReservation, prepareSaneContext,
    beginConversationCreation, completeConversationCreation, dispatchHarness, openCodeConversationCreation,
    claudeConversationCreation: () => claudeConversationCreation(allocate),
    assertPreparedUserInputCurrent, revalidatePreparedUserInput, UserInputPreparationError, WorkstreamAdapterError, DomainError,
    genericSessionTitle, legacyProfileId, isAssistantAgentId, isStoredAssistantAgentId, nativeAgentId, canonicalSlot,
    validateHarness, requireOperation, toSessionHarness, uuid, agentLaunchSnapshot, saneContextSnapshot, workerAssignmentOnly,
    preparationState, sessionProfileId: (session: Session) => session.profileId ?? legacyProfileId(session.harness ?? "claude-code", session.agent),
    nativeSource: () => state.authorityId, closing: false, storageFailed: false, retainOwner: false,
    executePrompt, synchronousDispatchHook, failClosed: forbidden, dispatchRegistry: { assertSupport: mock(() => {}) },
    pendingActivations: { hasPending: () => false },
    ensureDirectory: async () => { if (!existsSync(root)) throw new Error("fixture cwd disappeared"); },
    execution: mock(async () => root), branches: { list: () => [] },
    scienceSubmissions: { get: forbidden },
    replyIntegration: { requestRefresh: mock(() => { order.push("refresh"); }) },
    assertStartupReady: () => {}, attachmentTasks: new Set(), reserve: () => lease,
    handoffContextTitle: mock(async () => "Engineering #2"),
    store: { manifest: { storeId } },
    managedWorkerCoordination: () => undefined,
    claudeAgentSettings: mock(async () => { order.push("claude-settings"); }), claudeRoot: root,
    admitExplicitWorker: mock(async () => ({})),
    canonicalJSON: JSON.stringify,
  };
  ports.conversationCreation = bridgeClosure("conversationCreation", ports);
  const prepare = (continuation = false) => prepareUserInput({ prompt: "  authored prompt é😀\r\n", harness,
    ...(continuation ? { sessionId } : { cwd: root }),
  }, {
    ...preparationState(), defaultCwd: root, conversationId: () => sessionId,
    selectedDirectory: async () => root, ensureDirectory: ports.ensureDirectory,
    validateOpenCodeModel: () => {}, resolveOpenCodeLaunch: oc.resolveLaunch,
  });
  const session = (overrides: Partial<Session> = {}): Session => ({ sessionId, harness, nativeSessionId: nativeId, authorityId, cwd: root, lastRunId: null, lastStatus: "unknown", ...overrides });
  return { root, sessionId, nativeId, authorityId, association, meta, state, callbacks, rows, order, disk,
    admissions, catalog, oc, allocate, persist, knownAdmission, session, prepare, ports, lease,
    executionReservation, prepareSaneContext, executePrompt, coordinator };
}

describe("ordinary creation: executable bridge source wiring", () => {
  for (const harness of ["claude-code", "opencode"] as const) {
    test(`${harness}: first creation publishes exact metadata and ready admission before executor invocation`, async () => {
      const f = fixture(harness), prepared = await f.prepare(); f.order.length = 0;
      const result = await bridgeClosure("admitPreparedInput", f.ports)(prepared, f.lease);
      expect(result.nativeSessionId).toBe(f.nativeId);
      expect(f.order).toEqual(["associate", ...(harness === "claude-code" ? ["allocate", "begin"] : ["begin", "unknown", "native-create"]), "metadata", "register", "ready", "refresh", "run", "prompt"]);
      expect(f.admissions.begin.mock.calls[0]![0]).toMatchObject({ operation: "create", harness: harness === "opencode" ? "oc" : "cc", sessionId: f.sessionId, cwd: f.root, workspaceId: f.association.workspaceId, worktreeId: f.association.worktreeId });
      expect(f.meta.sessions).toHaveLength(1); expect(f.meta.runs).toEqual([]);
      if (harness === "opencode") expect(f.oc.createResolved).toHaveBeenCalledWith(f.root, prepared.nativeLaunch);
      expect(f.executionReservation).not.toHaveBeenCalled();
    });

    test(`${harness}: ordinary continuation never begins, allocates or creates`, async () => {
      const f = fixture(harness), session = f.session({ title: "Keep exact title" });
      f.meta.sessions.push(session); f.rows.set(f.sessionId, f.knownAdmission(f.sessionId, "ready")); await f.persist();
      const prepared = await f.prepare(true); f.order.length = 0;
      await bridgeClosure("admitPreparedInput", f.ports)(prepared, f.lease);
      expect(f.order).toEqual(["associate", "run", "prompt"]);
      expect(f.admissions.begin).not.toHaveBeenCalled(); expect(f.admissions.createNative).not.toHaveBeenCalled();
      expect(f.allocate).not.toHaveBeenCalled(); expect(f.oc.createResolved).not.toHaveBeenCalled();
      expect(f.executionReservation).not.toHaveBeenCalled(); expect(session.title).toBe("Keep exact title");
    });

    test(`${harness}: lost admission after awaited association refuses before native creation`, async () => {
      const f = fixture(harness), prepared = await f.prepare();
      f.callbacks.afterAssociate = () => { f.state.holds = false; };
      await expect(bridgeClosure("admitPreparedInput", f.ports)(prepared, f.lease)).rejects.toThrow("admission unavailable");
      expect(f.admissions.begin).not.toHaveBeenCalled(); expect(f.allocate).not.toHaveBeenCalled();
      expect(f.oc.createResolved).not.toHaveBeenCalled(); expect(f.executePrompt).not.toHaveBeenCalled();
    });

    test(`${harness}: changed source after begin refuses before metadata publication or executor`, async () => {
      const f = fixture(harness), prepared = await f.prepare();
      f.callbacks.afterBegin = () => { f.state.authorityId = `sane-native-v1:${harness === "opencode" ? "oc" : "cc"}:${"b".repeat(64)}`; };
      await expect(bridgeClosure("admitPreparedInput", f.ports)(prepared, f.lease)).rejects.toThrow("configuration changed");
      expect(f.persist).not.toHaveBeenCalled(); expect(f.admissions.createNative).not.toHaveBeenCalled();
      expect(f.admissions.register).not.toHaveBeenCalled(); expect(f.executePrompt).not.toHaveBeenCalled();
    });

    test(`${harness}: failed publication cannot register, ready or invoke executor`, async () => {
      const f = fixture(harness), prepared = await f.prepare(); f.state.failMetadata = true;
      await expect(bridgeClosure("admitPreparedInput", f.ports)(prepared, f.lease)).rejects.toThrow("metadata publication failed");
      expect(f.disk().sessions).toEqual([]); expect(f.admissions.register).not.toHaveBeenCalled();
      expect(f.admissions.ready).not.toHaveBeenCalled(); expect(f.executePrompt).not.toHaveBeenCalled();
    });
  }

  test("OpenCode: lost lease during native creation is checked again by the metadata publication callback", async () => {
    const f = fixture("opencode"), prepared = await f.prepare();
    f.callbacks.afterNativeCreate = () => { f.state.holds = false; };
    await expect(bridgeClosure("admitPreparedInput", f.ports)(prepared, f.lease)).rejects.toThrow("admission unavailable");
    expect(f.oc.createResolved).toHaveBeenCalledTimes(1); expect(f.persist).not.toHaveBeenCalled();
    expect(f.admissions.get(f.sessionId)).toMatchObject({ state: "identity_known", nativeId: f.nativeId });
    expect(f.meta.sessions).toEqual([]); expect(f.executePrompt).not.toHaveBeenCalled();
  });
});

function handoffFixture(harness: Harness) {
  const f = fixture(harness);
  const handoff: any = { id: "fixture-handoff", repositoryId: "fixture-repository", input: { to: "engineering" }, workstreamId: "fixture-workstream",
    recipient: { sessionId: f.sessionId, harness: harness === "opencode" ? "oc" : "cc", authorityId: f.authorityId, checkout: { path: f.root }, ref: null } };
  f.ports.router.forWorkspace = async () => ({ domain: { getHandoff: () => handoff } });
  // The service's create-path callback is the boundary under test. Enrollment,
  // bindRecipient and its repository-domain transaction are outside this file.
  f.ports.handoffs = { prepareRecipient: async (_workspace: string, _id: string, create: (h: any) => Promise<void>) => {
    await create(handoff); handoff.recipient.ref = { harness: handoff.recipient.harness, authorityId: f.authorityId, nativeId: f.nativeId }; return handoff;
  } };
  return { ...f, handoff, run: () => bridgeClosure("prepareHandoffRecipient", f.ports)("fixture-workspace", handoff.id) };
}

describe("handoff creation: executable bridge source wiring", () => {
  for (const harness of ["claude-code", "opencode"] as const) {
    test(`${harness}: known identity plus existing metadata neither duplicates nor renames, still associates and registers`, async () => {
      const f = handoffFixture(harness), session = f.session({ agent: "engineering", agentKind: "assistant", profileId: "template:engineering", title: "Original title", titleSource: "fallback", titleRevision: 7 });
      f.rows.set(f.sessionId, f.knownAdmission()); f.meta.sessions.push(session); await f.persist(); f.order.length = 0;
      await f.run();
      expect(f.meta.sessions).toEqual([session]); expect(session.title).toBe("Original title"); expect(session.titleRevision).toBe(7);
      expect(f.order).toEqual(["associate", "register", "ready", "refresh", "release"]);
      expect(f.admissions.begin).not.toHaveBeenCalled(); expect(f.allocate).not.toHaveBeenCalled();
      expect(f.oc.createResolved).not.toHaveBeenCalled(); expect(f.oc.recoverLaunch).not.toHaveBeenCalled();
      expect(f.executionReservation).not.toHaveBeenCalled(); expect(f.persist).toHaveBeenCalledTimes(1);
    });

    test(`${harness}: fresh handoff reserves activation, publishes, associates then registers ready`, async () => {
      const f = handoffFixture(harness); await f.run();
      expect(existsSync(join(f.root, "activations", f.sessionId, "activation.json"))).toBe(true);
      expect(f.prepareSaneContext).toHaveBeenCalledTimes(1);
      // Legacy handoffs without executionConfig also backfill profileId after
      // registration; that second publication must not move the first one.
      expect(f.order).toEqual(["catalog-register", ...(harness === "claude-code" ? ["allocate", "begin"] : ["begin", "resolve-launch", "unknown", "native-create"]), "metadata", "associate", "register", "ready", "refresh", "metadata", "release"]);
      expect(f.disk().sessions).toHaveLength(1); expect(f.executePrompt).not.toHaveBeenCalled();
    });

    test(`${harness}: existing known identity with missing activation reservation refuses instead of reconstructing`, async () => {
      const f = handoffFixture(harness); f.rows.set(f.sessionId, f.knownAdmission());
      await expect(f.run()).rejects.toThrow("no paired activation reservation");
      expect(f.prepareSaneContext).not.toHaveBeenCalled(); expect(f.allocate).not.toHaveBeenCalled();
      expect(f.oc.createResolved).not.toHaveBeenCalled(); expect(f.persist).not.toHaveBeenCalled();
      expect(f.admissions.register).not.toHaveBeenCalled(); expect(f.meta.sessions).toEqual([]);
      expect(f.coordinator.releaseAdmission).toHaveBeenCalledTimes(1);
    });
  }

  test("OpenCode: known identity without metadata reuses its saved reservation and recovers launch without recreation", async () => {
    const f = handoffFixture("opencode"); f.rows.set(f.sessionId, f.knownAdmission());
    await f.executionReservation(f.sessionId, { kind: "assistant", role: "engineering" }, f.prepareSaneContext);
    f.prepareSaneContext.mockClear(); await f.run();
    expect(f.prepareSaneContext).not.toHaveBeenCalled(); expect(f.admissions.begin).not.toHaveBeenCalled();
    expect(f.oc.createResolved).not.toHaveBeenCalled(); expect(f.oc.recoverLaunch).toHaveBeenCalledWith(f.nativeId, f.root, "sane/assistant/engineering");
    expect(f.order).toEqual(["recover-launch", "metadata", "associate", "register", "ready", "refresh", "metadata", "release"]);
    expect(f.meta.sessions[0]!.nativeSessionId).toBe(f.nativeId);
  });
});

function workerFixture(harness: Harness) {
  const f = fixture(harness), parentId = crypto.randomUUID();
  const parentNative = { harness: harness === "opencode" ? "oc" : "cc", authorityId: f.authorityId, nativeId: harness === "opencode" ? "ses_parent_fixture" : crypto.randomUUID() };
  f.rows.set(parentId, { ...f.knownAdmission(parentId, "ready"), nativeId: parentNative.nativeId });
  const worker: any = { id: "fixture-worker", sessionId: f.sessionId, checkout: f.root,
    parent: { sessionId: parentId, runId: crypto.randomUUID(), native: parentNative },
    launch: { harness, profileId: "worker:implementer", agent: nativeAgentId({ kind: "worker", role: "implementer" }, harness), identity: { kind: "worker", role: "implementer" } },
    input: { worker: "implementer", prompt: "authored prompt for worker", context: "bounded context", jobs: [] },
  };
  f.ports.workerStore = {
    get: () => worker,
    update: mock((_id: string, change: any) => {
      if (change.child) f.order.push("child-link");
      Object.assign(worker, change); return worker;
    }),
  };
  return { ...f, worker, parentNative, run: () => workerLaunch(f.ports)(worker) };
}

describe("worker creation: executable bridge source wiring", () => {
  for (const harness of ["claude-code", "opencode"] as const) {
    test(`${harness}: binds native parent and commits child-link -> metadata -> catalog/register/ready -> assignment -> executor`, async () => {
      const f = workerFixture(harness); await f.run();
      expect(f.admissions.begin.mock.calls[0]![0]).toMatchObject({ parent: f.parentNative, workspaceId: f.association.workspaceId, worktreeId: f.association.worktreeId, operation: "create" });
      expect(f.order).toEqual([...(harness === "claude-code" ? ["claude-settings", "allocate", "begin"] : ["resolve-launch", "begin", "unknown", "native-create"]), "child-link", "metadata", "associate", "register", "ready", "refresh", "assignment", "metadata", "run", "prompt", "release"]);
      expect(f.worker.child).toEqual({ harness: harness === "opencode" ? "oc" : "cc", authorityId: f.authorityId, nativeId: f.nativeId });
      expect(f.disk().sessions[0]!.saneContext!.assignment).toContain(f.root);
      expect(f.executePrompt.mock.calls[0]![3]).toBe("authored prompt for worker\n\nSupplied context:\nbounded context");
      expect(f.executePrompt.mock.calls[0]![4]).toBe(false);
    });
  }

  test("worker publication failure retains child identity but cannot register, assign or invoke executor", async () => {
    const f = workerFixture("opencode"); f.state.failMetadata = true;
    await expect(f.run()).rejects.toThrow("metadata publication failed");
    expect(f.worker.child.nativeId).toBe(f.nativeId); expect(f.disk().sessions).toEqual([]);
    expect(f.admissions.register).not.toHaveBeenCalled(); expect(f.admissions.ready).not.toHaveBeenCalled();
    expect(f.order).not.toContain("assignment"); expect(f.executePrompt).not.toHaveBeenCalled();
    expect(f.coordinator.releaseAdmission).toHaveBeenCalledTimes(1);
  });

  test("worker association failure cannot advance ready or resolve assignment", async () => {
    const f = workerFixture("opencode"); f.state.failAssociation = true;
    await expect(f.run()).rejects.toThrow("association failed");
    expect(f.disk().sessions).toHaveLength(1); expect(f.worker.child.nativeId).toBe(f.nativeId);
    expect(f.admissions.register).not.toHaveBeenCalled(); expect(f.admissions.ready).not.toHaveBeenCalled();
    expect(f.order).not.toContain("assignment"); expect(f.executePrompt).not.toHaveBeenCalled();
  });
});
