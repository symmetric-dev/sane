import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import * as ts from "typescript";
import { DomainError } from "sane-core/server";
import { isAssistantAgentId } from "sane-core/agent-catalog";
import { isHarness } from "../shared/conversation/harness-capabilities";
import { saneContextSnapshot } from "./agent-launch";
import { body, json } from "./bridge-http";
import { synchronousDispatchHook } from "./dispatch-evidence";
import { requireOperation } from "./harness-operations";
import { toNativeHarness, toSessionHarness } from "./harness-names";
import { uuid } from "./history";
import { OpenCodeError } from "./opencode";
import { canonicalJSON } from "./prepared-input-codec";
import { UserInputPreparationError } from "./user-input-preparation";
import { WorkspaceError } from "./workspace";
import { WorkstreamAdapterError } from "./workstreams";

// Executable production-closure coverage. Same offline AST fixture as
// conversation-creation-integration.test.ts: no HTTP server, browser, or native CLI.
const bridge = ts.createSourceFile("bridge.ts", readFileSync(new URL("./bridge.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function selectNode(predicate: (node: ts.Node) => boolean): ts.Node {
  const matches: ts.Node[] = [];
  const visit = (node: ts.Node) => { if (predicate(node)) matches.push(node); ts.forEachChild(node, visit); };
  visit(bridge);
  if (matches.length !== 1) throw new Error(`Bridge fixture requires exactly one AST match; found ${matches.length}`);
  return matches[0]!;
}
function compileClosure(expression: string, ports: Record<string, unknown>) {
  const { outputText } = ts.transpileModule(`const selected = ${expression};`, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None } });
  return new Function(...Object.keys(ports), `${outputText}\nreturn selected;`)(...Object.values(ports));
}
function bridgeFunction(name: string, ports: Record<string, unknown>) {
  const node = selectNode(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  return compileClosure(`(${node.getText(bridge)})`, ports);
}
function bridgeConst(name: string, ports: Record<string, unknown>) {
  const node = selectNode(node => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && !!node.initializer) as ts.VariableDeclaration;
  return compileClosure(`(${node.initializer!.getText(bridge)})`, ports);
}

const cwd = "/repo";
const nativeId = "native-1";
const authorityId = "auth-1";
const sessionId = "session-1";
const pair = { saneExecution: { schema: 1, revision: "a".repeat(64) }, saneContext: { version: 1, package: { schema: 1, revision: "b".repeat(64) } } };
function admission(native: "cc" | "oc" | "grok") {
  return { state: "ready", nativeId, source: { authorityId, descriptor: { harness: native } }, binding: { executionCheckout: cwd, workspaceId: "w", worktreeId: "t" } };
}
function session(harness?: string) {
  return { sessionId, harness, nativeSessionId: nativeId, authorityId, cwd, lastRunId: null, lastStatus: "unknown", title: "Conversation", saneExecution: pair.saneExecution, saneContext: pair.saneContext };
}

describe("bridge harness authorization refuses unknown identities", () => {
  test("branchDomain: omitted and unknown refuse; claude-code/cc and opencode/oc match", async () => {
    let row = admission("cc");
    const passed: string[] = [];
    const branchDomain = bridgeFunction("branchDomain", {
      admissions: { get: () => row }, toSessionHarness,
      router: { execution: async () => { passed.push(row.source.descriptor.harness); throw new Error("passed-harness-check"); } },
    });
    const source = session("claude-code");
    await expect(branchDomain(source)).rejects.toThrow("passed-harness-check");
    row = admission("oc");
    await expect(branchDomain(session("opencode"))).rejects.toThrow("passed-harness-check");
    expect(passed).toEqual(["cc", "oc"]);
    row = admission("cc");
    await expect(branchDomain(session(undefined))).rejects.toThrow("Source identity or execution checkout differs from its admission");
    await expect(branchDomain(session("opencode"))).rejects.toThrow("Source identity or execution checkout differs from its admission");
    row = admission("grok");
    await expect(branchDomain(source)).rejects.toThrow(TypeError);
    await expect(branchDomain(source)).rejects.toThrow("Unknown native harness");
    expect(passed).toEqual(["cc", "oc"]);
  });

  test("enrollBranch: omitted session harness throws; known identities begin as cc/oc", async () => {
    const begun: { harness: string }[] = [];
    const original = { binding: { workspaceId: "w", worktreeId: "t", domain: { mode: "app-only" } }, source: { authorityId, descriptor: { harness: "cc" } } };
    const enrollBranch = bridgeFunction("enrollBranch", {
      meta: { sessions: [] }, toNativeHarness,
      admissions: {
        get: (id: string) => id === sessionId ? original : undefined,
        begin: async (input: { harness: string }) => { begun.push(input); throw new Error("stop-after-begin"); },
      },
    });
    const op = { destinationId: "dest", nativeId };
    await expect(enrollBranch(op, session("claude-code"))).rejects.toThrow("stop-after-begin");
    await expect(enrollBranch(op, session("opencode"))).rejects.toThrow("stop-after-begin");
    expect(begun.map(input => input.harness)).toEqual(["cc", "oc"]);
    await expect(enrollBranch(op, session(undefined))).rejects.toThrow(TypeError);
    await expect(enrollBranch(op, session("grok"))).rejects.toThrow("Unknown session harness");
    expect(begun).toHaveLength(2);
  });

  test("assertQualifiedContinuation: omitted session and unknown native refuse; known pairs match", () => {
    let row = admission("cc");
    const assertQualifiedContinuation = bridgeConst("assertQualifiedContinuation", {
      admissions: { get: () => row }, toSessionHarness, WorkstreamAdapterError,
      branches: { list: () => [] }, meta: { runs: [] },
    });
    const run = { sessionId };
    expect(() => assertQualifiedContinuation(session("claude-code"), run)).not.toThrow();
    row = admission("oc");
    expect(() => assertQualifiedContinuation(session("opencode"), run)).not.toThrow();
    row = admission("cc");
    expect(() => assertQualifiedContinuation(session(undefined), run)).toThrow("Continuation requires its original ready native admission");
    expect(() => assertQualifiedContinuation(session("opencode"), run)).toThrow(WorkstreamAdapterError);
    row = admission("grok");
    expect(() => assertQualifiedContinuation(session("claude-code"), run)).toThrow(TypeError);
    expect(() => assertQualifiedContinuation(session("claude-code"), run)).toThrow("Unknown native harness");
  });

  test("launchCurrent: omitted session and unknown native refuse; known pairs match", () => {
    let row = admission("cc");
    let current = session("claude-code");
    const runs = [current];
    const meta = { runs: [] as unknown[], sessions: runs, reconciliationRequired: false };
    let matched = false;
    const executePrompt = bridgeFunction("executePrompt", {
      dispatchSnapshot: () => "snap", requireOperation: () => {}, sessionHarness: (value: { harness?: string }) => value.harness,
      pendingInputControls: { evidence: () => ({}) },
      dispatchSource: () => ({ harnessId: current.harness, sessionId, authorityId, nativeSessionId: nativeId, cwd }),
      synchronousDispatchHook, assertStartupReady: () => {}, prepareRunJournalInstallation: () => [],
      runJournalDirectory: "/journals", meta, events: new Map(), deferredJournals: new Set(),
      pendingActivations: { hasPending: () => false }, runJournals: { claimNew: () => {} },
      assertDispatchSnapshot: () => {}, installOwner: () => {}, ownerMetadata: new Map(),
      captureMetadataDispatchBinding: () => ({}), assertStorageOwned: () => {}, storageFailed: false,
      coordinator: { owns: () => true }, closing: false, retainOwner: false, sameDispatchSource: () => true,
      admissions: { get: () => row }, toSessionHarness, WorkstreamAdapterError, contextBinding: () => ({}),
      releaseOwner: () => {}, cleanupOwner: () => {},
      createDispatchContextBinding: (ports: { assertLaunchCurrent: () => void }) => {
        ports.assertLaunchCurrent(); matched = true;
        return { transport: {}, hooks: {}, assertSourceCurrent: () => {} };
      },
      dispatchRegistry: { start(_request: unknown, hooks: { install: (done: () => void) => unknown }) { hooks.install(() => {}); throw new Error("launch-current-returned"); } },
    });
    const run = { runId: "run-1", sessionId, cwd, status: "running", nativeCommandId: null };
    const launch = () => executePrompt({ id: "lease" }, current, run, "prompt", false, "user", {});
    expect(() => launch()).toThrow("launch-current-returned");
    row = admission("oc"); current = session("opencode");
    expect(() => launch()).toThrow("launch-current-returned");
    expect(matched).toBe(true);
    row = admission("cc"); current = session(undefined); matched = false;
    expect(() => launch()).toThrow("Context message source differs from its ready native admission");
    row = admission("oc"); current = session("claude-code");
    expect(() => launch()).toThrow(WorkstreamAdapterError);
    row = admission("grok");
    expect(() => launch()).toThrow(TypeError);
    expect(() => launch()).toThrow("Unknown native harness");
    expect(matched).toBe(false);
  });

  test("assertActivationPreparation: unknown session harness throws; known cc/oc pairs match", async () => {
    let harness: string = "claude-code";
    let row = admission("cc");
    let matched = false;
    const active = session("claude-code");
    const meta = { sessions: [active], runs: [] as unknown[], reconciliationRequired: false };
    const admitPreparedInput = bridgeFunction("admitPreparedInput", {
      meta, store: { manifest: { storeId: "store-1" } }, closing: false, storageFailed: false, retainOwner: false, toNativeHarness, canonicalJSON, UserInputPreparationError, WorkstreamAdapterError,
      isAssistantAgentId, synchronousDispatchHook, saneContextSnapshot, sessionHarness: (value: { harness?: string }) => value.harness,
      nativeSource: () => authorityId, execution: async () => {}, ensureDirectory: async () => {},
      oc: { activity: async () => ({ active: false, pending: false }), assertIdle: async () => {} },
      assertPreparedUserInputCurrent: () => {}, revalidatePreparedUserInput: async () => {}, preparationState: () => ({}),
      coordinator: { holdsAdmission: () => true, hasOwner: () => false, hasReconciliation: () => false, inspectReadiness: () => ({ ready: true }) },
      dispatchRegistry: { assertSupport: () => {} },
      enqueue: async (task: () => Promise<void> | void) => { await task(); },
      prepareActivationWhileAdmitted: (_assert: () => void, prepare: () => unknown) => ({ prepared: prepare() }),
      pendingActivations: {
        hasPending: () => true,
        prepare: () => ({ runId: "run-activation", nativeCommandId: null, activation: pair, events: [] }),
        assertCurrent: () => { matched = true; },
      },
      catalog: { associate: async () => ({ association: "resolved", workspaceId: "w", worktreeId: "t" }) },
      admissions: { get: () => row },
      sessionProfileId: () => "base:cc",
      executePrompt: (_lease: unknown, _session: unknown, _run: unknown, _prompt: string, _resume: boolean, _origin: string, options: { activationPreparation?: { assertCurrent: () => void } }) => {
        options.activationPreparation?.assertCurrent();
        return { admission: Promise.resolve({ state: "admitted" }) };
      },
    });
    const prepared = () => ({
      binding: { conversationId: sessionId, cwd, harness, authorityId, nativeSessionId: nativeId },
      normalized: {}, configuration: { ...pair, agent: "engineering" }, prompt: "authored prompt", resume: true,
      version: 1, requested: {}, associationSelection: {}, nativeStopped: false,
    });
    active.harness = "claude-code";
    await admitPreparedInput(prepared(), { id: "lease" });
    harness = "opencode"; row = admission("oc"); active.harness = "opencode";
    await admitPreparedInput(prepared(), { id: "lease" });
    expect(matched).toBe(true);
    harness = "claude-code"; row = admission("oc"); active.harness = "claude-code"; matched = false;
    await expect(admitPreparedInput(prepared(), { id: "lease" })).rejects.toThrow("Activation journal has no exact ready original native admission and pinned pair");
    expect(matched).toBe(false);
    harness = "grok"; row = admission("cc"); active.harness = "grok";
    await expect(admitPreparedInput(prepared(), { id: "lease" })).rejects.toThrow(TypeError);
    await expect(admitPreparedInput(prepared(), { id: "lease" })).rejects.toThrow("Unknown session harness");
  });

  test("admitExplicitWorker: unknown launch harness throws; known launches prove cc/oc", async () => {
    const seen: string[] = [];
    const admitExplicitWorker = bridgeConst("admitExplicitWorker", {
      contextPackages: { load: async () => {} }, toNativeHarness, options: {}, claudeRoot: "/claude", oc: {},
      proveInstalledExplicitWorkerRuntime: async (_root: string, harness: string) => { seen.push(harness); return undefined; },
    });
    const pinned = { saneContext: { package: { revision: "p" } }, saneExecution: { revision: "e" } };
    const rejected = await admitExplicitWorker({ launch: { harness: "claude-code" }, checkout: cwd }, pinned);
    const rejectedOc = await admitExplicitWorker({ launch: { harness: "opencode" }, checkout: cwd }, pinned);
    expect(seen).toEqual(["cc", "oc"]);
    expect(rejected.reject).toContain("installed runtime is not proven");
    expect(rejectedOc.reject).toContain("installed runtime is not proven");
    await expect(admitExplicitWorker({ launch: { harness: "grok" }, checkout: cwd }, pinned)).rejects.toThrow(TypeError);
    await expect(admitExplicitWorker({ launch: { harness: undefined }, checkout: cwd }, pinned)).rejects.toThrow("Unknown session harness");
    expect(seen).toEqual(["cc", "oc"]);
  });

  test("attach begin: unknown harness is rejected before begin; known identities begin as cc/oc", async () => {
    const begun: { harness: string }[] = [];
    const handle = bridgeFunction("handle", {
      json, body, isHarness, isAbsolute, uuid, requireOperation, toNativeHarness, OpenCodeError, WorkstreamAdapterError, WorkspaceError, DomainError,
      auth: { browserBoundary: () => "token", authenticated: () => true }, startupReady: true,
      pendingInputRoute: async () => undefined, pendingInputs: {}, meta: { sessions: [] }, assertCatalogActive: () => {},
      branches: { replaced: () => false, pending: () => false },
      matchesWorkstreamRoute: () => false, matchesTerminalRoute: () => false, matchesWorkspaceRoute: () => false, matchesSessionCatalogRoute: () => false,
      attaching: new Set(), availability: () => ({ canSend: true }), reserve: () => ({ id: "lease" }), attachmentTasks: new Set(),
      coordinator: { releaseAdmission: () => {} }, realpath: async (value: string) => value,
      catalog: { discover: async () => ({ root: cwd, commonDir: "/repo.git" }), register: async () => ({ workspaceId: "w", worktreeId: "t" }) },
      admissions: { get: () => undefined, begin: async (input: { harness: string }) => { begun.push(input); throw new Error("stop-after-begin"); } },
    });
    const call = (harness: string, nativeSessionId: string) => handle(new Request("http://127.0.0.1/api/sessions/attach", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ harness, nativeSessionId, cwd }),
    }), { requestIP: () => ({ address: "127.0.0.1" }), port: 1 });
    const cc = await call("claude-code", crypto.randomUUID());
    const oc = await call("opencode", "ses_attach_fixture");
    expect(cc.status).toBe(503); expect(oc.status).toBe(503);
    expect(begun.map(input => input.harness)).toEqual(["cc", "oc"]);
    begun.length = 0;
    const unknown = await call("grok", crypto.randomUUID());
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: "Provide harness, valid native session ID and absolute execution directory" });
    expect(begun).toEqual([]);
  });
});
