import { afterEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import type { DispatchIdentity, DispatchSubmissionEvidence } from "../shared/conversation/dispatch-contract";
import { parseCanonicalAgentOperations } from "./canonical-agent-operations";
import { validateCanonicalActivation } from "./canonical-activation-validation";
import type { CanonicalExecutionSnapshot } from "./canonical-execution-store";
import type { ContextMessageInput } from "./context-message";
import {
  assertContextMessageActivation, contextMessageJournalSnapshot, decodeContextMessageActivationPairing,
  type ContextMessageActivationExpected, type ContextMessageActivationPairing, type ContextMessageActivationRetention,
} from "./context-message-activation";
import {
  assertContextMessageCurrent, prepareContextMessage,
  type ContextMessagePreparation, type OrdinaryContextMessageInput,
} from "./context-message-engine";
import type { ContextMessageDispatchObservation, ContextMessageSubmission } from "./context-message-evidence";
import { createContextMessageJournalPersistence } from "./context-message-journal";
import { assertContextMessageNativeContinuity } from "./context-message-native";
import { createOwnedContextMessages } from "./context-message-owner";
import { ContextMessageJournalReader } from "./context-message-reader";
import { captureContextMessageSources } from "./context-message-source";
import type { ActualContextSubmission, OwnedContextMessageRequest, PreparedOwnedContextMessage } from "./context-message-transport";
import { contextAsset, contextHash, type ContextPackage } from "./context-package";
import { createDispatchEvidence } from "./dispatch-evidence";
import { validateMetadata, type Event, type Metadata, type Run, type Session } from "./history";
import {
  captureMetadataDispatchBinding, MetadataPublisher, type CommittedMetadataReceipt,
} from "./metadata-publication";
import type { MessageSnapshot } from "./oc-contract";
import { RunJournalWriter } from "./run-journal";

// Offline cross-module contract integration, NOT App boot or native acceptance.
// Only the native effect/history and bridge orchestration are fixtures. Composer,
// engine, owner factory, evidence lifecycle, publisher, writer, source pinner,
// protected reader, activation reader and native continuity checker are real.
// No native imports, processes, network, dependency installation or git fixtures.
const temporary = "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true }); });
const clone = <T>(value: T): T => structuredClone(value);
const authored = "\uFEFF  authored é😀\r\n[SANE CONTEXT MESSAGE v1]\n";
const roleText = "Synthetic engineering role é😀";
const pickupText = "Synthetic initial Pickup (once only)";
const sessionText = "Synthetic protected Session membership";
type Harness = "claude-code" | "opencode";

function fixture(harness: Harness) {
  const root = fs.realpathSync(fs.mkdtempSync(join(temporary, "context-message-integration-")));
  roots.push(root);
  const storeId = crypto.randomUUID(), createdAt = "2026-10-26T00:00:00.000Z";
  const identity = { kind: "assistant", role: "engineering" } as const;
  const assets = [contextAsset("role.assistant.engineering", "fixture/role", roleText, "role"),
    contextAsset("framework.core", "fixture/core", "Synthetic core conventions", "framework"),
    contextAsset("framework.assistant", "fixture/assistant", "Synthetic assistant conventions", "framework"),
    contextAsset("sane-assistant-engineering-pickup", "fixture/pickup", pickupText, "procedure")];
  const bundleBody = { schema: 1 as const, identity, assets, initial: ["sane-assistant-engineering-pickup"] };
  const bundle: ContextPackage = { ...bundleBody, revision: contextHash(JSON.stringify(bundleBody)) };
  const paths: Record<string, string> = {};
  fs.mkdirSync(join(root, "pinned"));
  for (const asset of assets) {
    paths[asset.id] = join(root, "pinned", `${asset.id}.md`);
    fs.writeFileSync(paths[asset.id]!, asset.text, { mode: 0o600 });
  }
  const executionBody = { schema: 1 as const,
    policy: parseCanonicalAgentOperations(`---\ndescription: Offline integration policy\n---\n${roleText}`, "sane/assistant/engineering"), children: [] };
  const execution: CanonicalExecutionSnapshot = { ...executionBody, revision: contextHash(JSON.stringify(executionBody)) };
  const expected: ContextMessageActivationExpected = {
    binding: { harnessId: harness, sessionId: crypto.randomUUID(),
      authorityId: `sane-native-v1:${harness === "opencode" ? "oc" : "cc"}:${"a".repeat(64)}`,
      nativeSessionId: harness === "opencode" ? "ses_offline_integration" : crypto.randomUUID(), cwd: root },
    identity, context: { schema: 1, revision: bundle.revision, delivery: "standing-native-role" },
    execution: { schema: 1, revision: execution.revision },
  };
  const binding = expected.binding;
  const config = { agent: identity.role, agentKind: identity.kind, nativeAgentSelected: true,
    saneExecution: expected.execution, profileId: "template:engineering", model: "fixture-model", saneContextVersion: 1 } as const;
  const session: Session = { ...config, sessionId: binding.sessionId, harness, nativeSessionId: binding.nativeSessionId,
    authorityId: binding.authorityId, cwd: root, lastRunId: null, lastStatus: "unknown", attachment: { state: "ready", source: "native" },
    saneContext: { version: 1, framework: "Synthetic pinned framework", package: expected.context } };
  const metadata: Metadata & { version: 1 } = { version: 1, sessions: [session], runs: [], reconciliationRequired: false };
  validateMetadata(metadata);
  fs.writeFileSync(join(root, "manifest.json"), JSON.stringify({ format: "sane-app-store", version: 1, storeId, createdAt }), { mode: 0o600 });
  fs.writeFileSync(join(root, "metadata.json"), JSON.stringify(metadata), { mode: 0o600 });
  let dead = false, receipt: CommittedMetadataReceipt | undefined;
  const failures: unknown[] = [], order: string[] = [], queue: (() => void)[] = [], published: string[] = [];
  const failClosed = (error: unknown) => { dead = true; failures.push(error); };
  const assertStorage = () => { if (dead) throw new Error("Original offline storage failed closed"); };
  const publisher = new MetadataPublisher(root, storeId, { assertStorage, failClosed });
  const writer = new RunJournalWriter(root, { assertStorage, failClosed });
  const reader = new ContextMessageJournalReader(root, storeId, { assertStorage });
  const source = (runId: string) => `app:${storeId}/run:${runId}/context-messages`;
  const events = new Map<string, Event[]>();
  const originalFacts: DispatchSubmissionEvidence[] = [];
  // Independently captured from the simulated wire effect, never journal text.
  const simulatedNativeHistory: MessageSnapshot[] = [];
  const contextLoad = mock(async () => { captureContextMessageSources({ bundle, paths })(); return { bundle: clone(bundle) }; });
  const executionLoad = mock(async () => clone(execution));
  const forbiddenOrdinaryProof = mock((): never => { throw new Error("Ordinary path must never load context, execution or historical proof"); });
  let activationRun: Run | undefined;

  function publishMetadata() {
    const serialized = JSON.stringify(metadata); // captured at enqueue, not commit
    queue.push(() => { receipt = publisher.commitSerialized(serialized); order.push("metadata:committed"); });
  }
  function drainQueue() { for (const commit of queue.splice(0)) commit(); }
  function read(run: Run) { return reader.read(run); }
  // Explicit inspector only: neither preparation nor a native boundary calls it.
  const readActivation = mock((state: "complete" | "partial" = "complete", nativeContext: ContextMessageActivationRetention["nativeContext"] = "retained") => {
    if (!activationRun) throw new Error("No original activation run");
    // Bridge readContextActivation awaits its existing serial queue before the
    // nonrepairing read. This fixture's queue is synchronous and explicit.
    drainQueue();
    const original = read(activationRun);
    const standard = original.events.find(event => event.kind === "submission");
    if (!standard) throw new Error("Original standard submission missing");
    // History is deliberately simulated and source-scoped by this fixture, NOT a
    // production native read. The checker still enforces exact native ID + bytes.
    assertContextMessageNativeContinuity(binding, standard.data, clone(simulatedNativeHistory));
    const covered = metadata.runs.slice(metadata.runs.indexOf(activationRun));
    const reads = covered.filter(run => events.get(run.runId)?.length).map(run => read(run));
    for (const snapshot of reads) snapshot.assertCurrent();
    original.assertCurrent();
    return assertContextMessageActivation({ expected,
      snapshot: contextMessageJournalSnapshot(original.events, { state, source: source(activationRun.runId) }),
      retention: { binding, coverage: { state, source: "fixture:protected-metadata-and-simulated-native-history" }, nativeContext,
        runs: covered.map(run => ({ runId: run.runId, sessionId: run.sessionId, ...(run.operation ? { operation: run.operation } : {}) })) } });
  });

  function startRun(bootstrap: boolean, queued = false) {
    // Fixture settlement, not a native completion claim. Real metadata forbids
    // two simultaneously running owners for one session.
    for (const previous of metadata.runs) if (previous.status === "running") {
      previous.status = "completed"; previous.endedAt = createdAt;
    }
    const queuedFollowupId = queued ? crypto.randomUUID() : undefined;
    const run: Run = { ...config, runId: crypto.randomUUID(), sessionId: binding.sessionId, cwd: root,
      status: "running", createdAt, operation: "prompt",
      ...(harness === "opencode" ? { nativeCommandId: `msg_${crypto.randomUUID()}`, nativePhase: "preparing" } : {}),
      ...(queuedFollowupId && harness === "claude-code" ? { queuedFollowupId } : {}) };
    metadata.runs.push(run); session.lastRunId = run.runId; session.lastStatus = "running";
    validateMetadata(metadata);
    if (bootstrap) activationRun = run;
    const dispatch: DispatchIdentity = { source: binding, runId: run.runId, nativeCommandId: run.nativeCommandId ?? null, requestId: crypto.randomUUID() };
    const metadataPins = captureMetadataDispatchBinding(session, run, dispatch);
    const list: Event[] = []; events.set(run.runId, list);
    let staged: ContextMessageActivationPairing | undefined, sourceCheck = () => {}, pairedValidation = false;
    let current = true;
    const observeCurrent = () => { assertStorage(); if (!current) throw new Error("Original source/owner association changed"); };
    const launchCurrent = () => { observeCurrent(); sourceCheck(); };
    const reserve = (kind: Event["kind"], data: unknown) => {
      const reservation = writer.reserve(run, list, kind, data, event => { published.push(`${event.runId}:${event.seq}`); });
      list.push(reservation.event);
      queue.push(() => writer.commit(reservation));
      return reservation;
    };
    const emitStandard = (submission: ContextMessageSubmission) => {
      order.push("emit:submission"); reserve("submission", submission);
      if (staged) {
        expect(staged.messageId).toBe(submission.messageId);
        order.push("emit:pairing"); reserve("context", staged); staged = undefined;
      }
    };
    let originalReceipt: CommittedMetadataReceipt | undefined;
    const assertMetadataCommitted = (_submission: ContextMessageSubmission, observation: ContextMessageDispatchObservation) => {
      if (observation.stage === "before-native") {
        publisher.assertCommitted(receipt!, metadataPins); originalReceipt ??= receipt;
      } else publisher.assertOriginalAssociation(originalReceipt!, dispatch);
    };
    const persist = createContextMessageJournalPersistence({ writer, readIdentity: () => dispatch, readEvents: () => list,
      assertCurrent: observeCurrent, assertMetadataCommitted,
      reserveObservation: observation => reserve("context", observation), failClosed });
    const owned = createOwnedContextMessages({ readIdentity: () => dispatch, assertObservationCurrent: observeCurrent, assertBeforeNative: launchCurrent,
      originalHooks: {
        beforeNative: fact => { launchCurrent(); order.push("original:before"); originalFacts.push(fact); },
        outcome: fact => { order.push("original:outcome"); originalFacts.push(fact); },
      },
      prepare: async (request, adapterGuard) => {
        const selected = bootstrap && !request.liveInput;
        sourceCheck = selected ? captureContextMessageSources({ bundle, paths }) : () => {};
        const guards = { assertOwnership: () => { launchCurrent(); adapterGuard(); }, assertSource: observeCurrent, assertNotCancelled: observeCurrent };
        const ordinaryInput = (): OrdinaryContextMessageInput => ({ body: request.body, binding, origin: "user", placement: { kind: "body-only" } });
        const input: ContextMessageInput = selected
          ? { body: request.body, binding, origin: "activation", placement: { kind: "bootstrap" }, context: { bundle, paths },
            session: { id: "session", category: "session", text: sessionText, source: "fixture:protected-membership", revision: "membership-1", reason: "Explicit activation Session" } }
          : ordinaryInput();
        if (selected) {
          // Selection/load-time admission belongs to this fixture owner. It is
          // performed once before composition, never by generic refresh.
          await validateCanonicalActivation({ saneContext: session.saneContext!, saneExecution: expected.execution }, identity,
            { context: { load: contextLoad }, execution: { load: executionLoad } }, { assertCurrent: launchCurrent });
          pairedValidation = true;
        }
        const preparation: ContextMessagePreparation = selected
          ? { kind: "context", guards, assertSelectionCurrent: launchCurrent }
          : Object.assign({ kind: "ordinary" as const, guards, readCurrentOrdinary: () => clone(ordinaryInput()) },
            { context: { load: forbiddenOrdinaryProof }, execution: { load: forbiddenOrdinaryProof },
              readCurrentContext: forbiddenOrdinaryProof, packageProvider: forbiddenOrdinaryProof, readActivation: forbiddenOrdinaryProof,
              policy: { kind: "sane", assertDurableActivationPairing: forbiddenOrdinaryProof, validateExecution: forbiddenOrdinaryProof } });
        const message = await prepareContextMessage(input, preparation);
        return { message, assertCurrent: async () => { await assertContextMessageCurrent(message, preparation); } };
      },
      onBound: (submission, message, request) => {
        launchCurrent(); order.push("bound");
        if (request.liveInput || message.placement.kind !== "bootstrap") return;
        expect(pairedValidation).toBe(true);
        staged = decodeContextMessageActivationPairing({ schema: 1, type: "context-message-activation-pairing", ...expected,
          dispatch, messageId: submission.messageId, transportSha256: message.transport.sha256,
          intent: "assistant-activation", source: source(run.runId) });
      },
      persist: (submission, observation) => {
        order.push(`journal:${observation.stage}`); persist(submission, observation); order.push(`fenced:${observation.stage}`);
      }, failClosed });
    // ONE existing dispatch-evidence state per run. The engine and live CC
    // message boundary never create another owner or evidence lifecycle.
    const lifecycle = createDispatchEvidence(dispatch, owned.hooks, failClosed);
    reserve("status", { status: "running" }); publishMetadata();
    const request: OwnedContextMessageRequest = { messageId: run.nativeCommandId ?? `${run.runId}:user`, body: authored,
      boundary: "run-initial", ...(queuedFollowupId ? { queuedFollowupId } : {}) };
    return { run, dispatch, list, lifecycle, transport: owned.transport, request, emitStandard, launchCurrent,
      changeOwner: () => { current = false; } };
  }

  function encode(owner: ReturnType<typeof startRun>, request: OwnedContextMessageRequest, prepared: PreparedOwnedContextMessage) {
    const uuid = request.liveInput ? request.messageId.slice(`${owner.run.runId}:user:`.length) : owner.run.runId;
    // Explicit simulated wire encoders, using the same DTOs as the adapters.
    // The reader parses the retained actual pending bytes afresh; it does NOT
    // echo the candidate or read a standard submission from the journal.
    let pending = harness === "claude-code"
      ? JSON.stringify({ type: "user", uuid, session_id: binding.nativeSessionId,
        message: { role: "user", content: prepared.message.transport.text }, parent_tool_use_id: null }) + "\n"
      : JSON.stringify({ id: request.messageId, text: prepared.message.transport.text });
    const readActual = (): ActualContextSubmission => {
      const wire = JSON.parse(pending);
      if (harness === "claude-code") {
        if (wire.uuid !== uuid || wire.session_id !== binding.nativeSessionId || wire.type !== "user" || wire.message.role !== "user") throw new Error("Encoded CC identity changed");
        return { identity: clone(owner.dispatch), messageId: `${owner.run.runId}:user${request.liveInput ? `:${wire.uuid}` : ""}`, text: wire.message.content };
      }
      return { identity: clone(owner.dispatch), messageId: wire.id, text: wire.text };
    };
    const effect = () => {
      const actual = readActual(), wire = JSON.parse(pending);
      order.push("simulated-native-effect");
      simulatedNativeHistory.push({ messageId: harness === "claude-code" ? wire.uuid : wire.id, role: "user",
        parts: [{ id: crypto.randomUUID(), type: "text", text: actual.text }], status: "completed", createdAt });
    };
    return { readActual, effect, mutate: () => {
      const wire = JSON.parse(pending);
      if (harness === "claude-code") wire.message.content += " altered pending line";
      else wire.text += " altered HTTP body";
      pending = JSON.stringify(wire) + (harness === "claude-code" ? "\n" : "");
    } };
  }
  async function bind(owner: ReturnType<typeof startRun>, request = owner.request) {
    const prepared = await owner.transport.prepare(request, owner.launchCurrent);
    await prepared.assertCurrent();
    const wire = encode(owner, request, prepared), submission = prepared.bindActual(wire.readActual);
    owner.emitStandard(submission);
    return { prepared, wire, submission };
  }
  async function send(owner: ReturnType<typeof startRun>, request = owner.request) {
    // Publish installed metadata first. The standard submission + pairing stay
    // queued for the bootstrap fence below, proving it drains predecessors too.
    drainQueue();
    const bound = await bind(owner, request);
    await bound.prepared.assertCurrent();
    if (bound.prepared.message.placement.kind === "bootstrap") {
      expect(read(owner.run).events.map(event => event.kind)).toEqual(["status"]);
      expect(queue.length).toBeGreaterThanOrEqual(2);
    }
    if (request.liveInput) bound.prepared.beforeMessageNative(); else owner.lifecycle.beforeNative();
    // The real synchronous writer fence must have reached the SAME file before
    // this deliberately fake native effect. Queue callbacks are still pending.
    expect(queue.length).toBeGreaterThan(0);
    const beforeEffect = read(owner.run).events;
    expect((beforeEffect.at(-1)!.data as { stage: string }).stage).toBe("before-native");
    expect(beforeEffect.filter(event => event.kind === "submission" && (event.data as ContextMessageSubmission).messageId === request.messageId)).toHaveLength(1);
    bound.wire.effect();
    if (request.liveInput) bound.prepared.messageOutcome("submitted", "unknown");
    else owner.lifecycle.outcome("submitted", harness === "opencode" ? "accepted" : "unknown");
    return bound;
  }
  return { root, storeId, binding, expected, metadata, session, publisher, reader, writer, paths, order, queue, published,
    originalFacts, failures, simulatedNativeHistory, contextLoad, executionLoad, forbiddenOrdinaryProof,
    startRun, encode, bind, send, read, readActivation, drainQueue, publishMetadata,
    journalPath: (run: Run) => join(root, `${run.runId}.jsonl`) };
}

describe("offline shared context-message lifecycle integration", () => {
  for (const harness of ["claude-code", "opencode"] as const) {
    test(`${harness}: ordinary preparation and simulated native boundary never load context, execution or activation history`, async () => {
      const f = fixture(harness), owner = f.startRun(false);
      const sent = await f.send(owner);
      expect(sent.prepared.message.transport.text).toBe(authored);
      expect(sent.prepared.message.segments).toEqual([]);
      expect(sent.prepared.message.packageRevision).toBeNull();
      expect(f.contextLoad).not.toHaveBeenCalled();
      expect(f.executionLoad).not.toHaveBeenCalled();
      expect(f.readActivation).not.toHaveBeenCalled();
      expect(f.forbiddenOrdinaryProof).not.toHaveBeenCalled();
      expect(f.simulatedNativeHistory).toHaveLength(1);
      expect(f.failures).toEqual([]);
    });

    test(`${harness}: original outcome metadata proof survives later launch-setting publication`, async () => {
      const f = fixture(harness), first = f.startRun(true);
      f.drainQueue();
      const sent = await f.bind(first);
      first.lifecycle.beforeNative(); sent.wire.effect();
      f.session.model = "changed-model"; first.run.model = "changed-model";
      f.publishMetadata(); f.drainQueue();
      first.lifecycle.outcome("submitted", harness === "opencode" ? "accepted" : "unknown");
      expect(f.failures).toEqual([]);
      expect(f.read(first.run).events.at(-1)!.data).toMatchObject({ stage: "outcome", evidence: { submission: "submitted" } });
    });
    test(`${harness}: bootstrap -> exact protected activation -> body-only same-journal and later-run continuation`, async () => {
      const f = fixture(harness), first = f.startRun(true, true);
      const bootstrap = await f.send(first);
      expect(f.order).toEqual(["metadata:committed", "bound", "emit:submission", "emit:pairing", "original:before",
        "journal:before-native", "fenced:before-native", "simulated-native-effect", "original:outcome", "journal:outcome", "fenced:outcome"]);
      const activation = f.readActivation();
      expect(activation.association).toEqual({ schema: 1, type: "context-message-activation-pairing", ...f.expected, dispatch: first.dispatch,
        messageId: first.request.messageId, transportSha256: bootstrap.prepared.message.transport.sha256,
        intent: "assistant-activation", source: `app:${f.storeId}/run:${first.run.runId}/context-messages` });
      expect(activation.restart.fact).toBe(harness === "claude-code" ? "submitted-unconfirmed" : "accepted");
      expect(activation.restart.composition).toEqual(bootstrap.submission.composition);
      expect(bootstrap.submission.queuedFollowupId).toBe(first.request.queuedFollowupId);
      expect(bootstrap.prepared.message.segments.filter(segment => segment.category === "role")).toHaveLength(1);
      expect(bootstrap.prepared.message.segments.filter(segment => segment.category === "session")).toHaveLength(1);
      expect(bootstrap.prepared.message.segments.filter(segment => segment.id === "sane-assistant-engineering-pickup")).toHaveLength(1);
      expect(f.simulatedNativeHistory[0]!.messageId).toBe(harness === "claude-code" ? first.run.runId : first.run.nativeCommandId!);
      const contextReads = f.contextLoad.mock.calls.length;
      expect(contextReads).toBe(1);
      expect(f.executionLoad).toHaveBeenCalledTimes(1);
      f.drainQueue();
      if (harness === "claude-code") {
        const live = { body: "  same-run ordinary 😀\r\n", messageId: `${first.run.runId}:user:${crypto.randomUUID()}`, boundary: "message" as const, liveInput: true };
        const sent = await f.send(first, live);
        expect(sent.prepared.message.transport.text).toBe(live.body);
        expect(sent.prepared.message.segments).toEqual([]);
        expect(sent.submission.queuedFollowupId).toBeUndefined();
        expect(f.originalFacts.map(fact => fact.submission)).toEqual(["attempted", "submitted"]);
        expect(f.readActivation().restart.fact).toBe("submitted-unconfirmed");
        f.drainQueue();
      }
      const later = f.startRun(false), ordinary = await f.send(later, { ...later.request, body: "\uFEFF  next-run ordinary é😀\r\n" });
      expect(ordinary.prepared.message.transport.text).toBe("\uFEFF  next-run ordinary é😀\r\n");
      expect(ordinary.prepared.message.segments).toEqual([]);
      expect(ordinary.prepared.message.packageRevision).toBeNull();
      expect(f.contextLoad.mock.calls.length).toBe(contextReads);
      expect(f.forbiddenOrdinaryProof).not.toHaveBeenCalled();
      expect(f.executionLoad).toHaveBeenCalledTimes(1);
      f.drainQueue();
      const all = [first, later].flatMap(owner => f.read(owner.run).events);
      expect(all.filter(event => event.kind === "context" && (event.data as { type?: string }).type === "context-message-activation-pairing")).toHaveLength(1);
      for (const text of [roleText, pickupText, sessionText]) {
        const submissions = all.filter(event => event.kind === "submission" && (event.data as ContextMessageSubmission).text.includes(text));
        expect(submissions).toHaveLength(1);
      }
      for (const owner of [first, later]) {
        const bytes = fs.readFileSync(f.journalPath(owner.run), "utf8");
        f.drainQueue(); expect(fs.readFileSync(f.journalPath(owner.run), "utf8")).toBe(bytes);
      }
      expect(new Set(f.published).size).toBe(f.published.length);
      expect(f.published).toHaveLength(all.length);
      expect(f.originalFacts.map(fact => [fact.runId, fact.submission, fact.nativeAcceptance])).toEqual([
        [first.run.runId, "attempted", "unknown"], [first.run.runId, "submitted", harness === "opencode" ? "accepted" : "unknown"],
        [later.run.runId, "attempted", "unknown"], [later.run.runId, "submitted", harness === "opencode" ? "accepted" : "unknown"],
      ]);
      expect(f.readActivation().association).toEqual(activation.association);
      expect(f.failures).toEqual([]);
    });

    for (const boundary of ["bind", "before-native"] as const) test(`${harness}: mutated actual encoded payload refuses at ${boundary} before fake effect`, async () => {
      const f = fixture(harness), owner = f.startRun(true), prepared = await owner.transport.prepare(owner.request, owner.launchCurrent);
      const wire = f.encode(owner, owner.request, prepared);
      if (boundary === "before-native") { owner.emitStandard(prepared.bindActual(wire.readActual)); f.drainQueue(); }
      wire.mutate();
      expect(() => {
        if (boundary === "bind") prepared.bindActual(wire.readActual); else owner.lifecycle.beforeNative();
        wire.effect();
      }).toThrow();
      expect(f.simulatedNativeHistory).toEqual([]);
      expect(f.originalFacts).toEqual([]);
      expect(f.failures.length).toBeGreaterThan(0);
    });

    test(`${harness}: journal fence cannot substitute for an original metadata publication receipt`, async () => {
      const f = fixture(harness), owner = f.startRun(true);
      const bound = await f.bind(owner); // metadata bytes exist, but publication is still queued
      expect(() => { owner.lifecycle.beforeNative(); bound.wire.effect(); }).toThrow("committed metadata receipt");
      expect(fs.existsSync(f.journalPath(owner.run))).toBe(false);
      expect(f.simulatedNativeHistory).toEqual([]);
    });

    test(`${harness}: tampered pinned source refuses after binding, before original native effect`, async () => {
      const f = fixture(harness), owner = f.startRun(true), bound = await f.bind(owner);
      f.drainQueue();
      fs.writeFileSync(f.paths["role.assistant.engineering"]!, "tampered source bytes");
      await expect(bound.prepared.assertCurrent()).rejects.toThrow();
      expect(() => { owner.lifecycle.beforeNative(); bound.wire.effect(); }).toThrow();
      expect(f.originalFacts).toEqual([]); expect(f.simulatedNativeHistory).toEqual([]);
    });

    for (const pins of ["session", "run"] as const) test(`${harness}: real metadata publication with changed ${pins} pins cannot authorize the bound message`, async () => {
      const f = fixture(harness), owner = f.startRun(true), bound = await f.bind(owner);
      if (pins === "session") f.session.model = "changed-fixture-model";
      else owner.run.model = "changed-fixture-model";
      f.publishMetadata(); f.drainQueue();
      expect(() => { owner.lifecycle.beforeNative(); bound.wire.effect(); }).toThrow("dispatch configuration changed");
      expect(f.simulatedNativeHistory).toEqual([]);
      expect(owner.list.filter(event => (event.data as { stage?: string }).stage === "before-native")).toEqual([]);
    });
  }

  test("CC live UUID messages keep their own boundaries, never repeat initial queued-claim hooks", async () => {
    const f = fixture("claude-code"), owner = f.startRun(true, true);
    await f.send(owner); f.drainQueue();
    const initialFacts = clone(f.originalFacts), ids = [crypto.randomUUID(), crypto.randomUUID()];
    for (const uuid of ids) {
      const request: OwnedContextMessageRequest = { messageId: `${owner.run.runId}:user:${uuid}`, body: `live ${uuid}\r\n`, boundary: "message", liveInput: true };
      const sent = await f.send(owner, request);
      expect(sent.submission.liveInput).toBe(true);
      expect(sent.submission.queuedFollowupId).toBeUndefined();
      assertContextMessageNativeContinuity(f.binding, sent.submission, clone(f.simulatedNativeHistory));
      f.drainQueue();
    }
    expect(f.originalFacts).toEqual(initialFacts);
    const observations = f.read(owner.run).events.filter(event => event.kind === "context" && (event.data as { type?: string }).type === "context-message-dispatch");
    expect(observations.map(event => { const data = event.data as { messageId: string; boundary: string; stage: string }; return [data.messageId, data.boundary, data.stage]; })).toEqual([
      [owner.request.messageId, "run-initial", "before-native"], [owner.request.messageId, "run-initial", "outcome"],
      ...ids.flatMap(uuid => [[`${owner.run.runId}:user:${uuid}`, "message", "before-native"], [`${owner.run.runId}:user:${uuid}`, "message", "outcome"]]),
    ]);
    expect(() => owner.lifecycle.beforeNative()).toThrow("replay forbidden");
    expect(f.failures).toEqual([]);
  });

  test("CC native continuity refuses logical App IDs and foreign UUIDs despite identical activation text", async () => {
    const f = fixture("claude-code"), owner = f.startRun(true), sent = await f.send(owner);
    for (const wrongId of [owner.request.messageId, crypto.randomUUID()]) {
      const foreign = clone(f.simulatedNativeHistory); foreign[0]!.messageId = wrongId;
      expect(() => assertContextMessageNativeContinuity(f.binding, sent.submission, foreign)).toThrow();
    }
    expect(f.readActivation().restart.fact).toBe("submitted-unconfirmed");
  });

  for (const gap of ["partial", "torn", "rewritten", "missing", "reset", "native-id", "native-bytes", "legacy"] as const) {
    test(`explicit activation inspector refuses ${gap} historical evidence without context reload or fake effect`, async () => {
      const f = fixture("opencode"), owner = f.startRun(true);
      await f.send(owner); f.drainQueue();
      const original = f.read(owner.run), path = f.journalPath(owner.run), bytes = fs.readFileSync(path, "utf8");
      const contextReads = f.contextLoad.mock.calls.length, effects = f.simulatedNativeHistory.length;
      if (gap === "torn") fs.appendFileSync(path, '{"seq":');
      if (gap === "rewritten") fs.writeFileSync(path, bytes.replace(roleText, "Changed engineering role é😀"));
      if (gap === "missing") fs.unlinkSync(path);
      if (gap === "legacy") fs.writeFileSync(path, bytes.split("\n").filter(line => !line.includes('"type":"context-message-activation-pairing"')).join("\n"));
      if (gap === "reset") f.simulatedNativeHistory.push({ messageId: "msg_reset", role: "system", parts: [], status: "completed", createdAt: owner.run.createdAt, contextReset: true });
      if (gap === "native-id") f.simulatedNativeHistory[0]!.messageId = "msg_foreign";
      if (gap === "native-bytes") f.simulatedNativeHistory[0]!.parts = [{ id: "changed", type: "text", text: "not the submitted activation" }];
      if (["torn", "rewritten", "missing", "legacy"].includes(gap)) expect(() => original.assertCurrent()).toThrow();
      expect(() => f.readActivation(gap === "partial" ? "partial" : "complete")).toThrow();
      expect(f.simulatedNativeHistory).toHaveLength(effects + (gap === "reset" ? 1 : 0));
      expect(f.contextLoad.mock.calls.length).toBe(contextReads);
      expect(f.forbiddenOrdinaryProof).not.toHaveBeenCalled();
    });
  }

  test("a complete legacy-only journal without a pairing is not activation (no reader rewrite shortcut)", async () => {
    const f = fixture("claude-code"), owner = f.startRun(false);
    const legacy = f.writer.reserve(owner.run, owner.list, "context", { type: "canonical-activation", delivered: true });
    owner.list.push(legacy.event); f.queue.push(() => f.writer.commit(legacy)); f.drainQueue();
    const protectedRead = f.read(owner.run);
    expect(() => assertContextMessageActivation({ expected: f.expected,
      snapshot: contextMessageJournalSnapshot(protectedRead.events, { state: "complete", source: "fixture:legacy-journal" }),
      retention: { binding: f.binding, coverage: { state: "complete", source: "fixture:metadata" }, nativeContext: "retained", runs: [{ runId: owner.run.runId, sessionId: owner.run.sessionId }] } })).toThrow("Exactly one protected activation pairing");
    expect(f.simulatedNativeHistory).toEqual([]);
    expect(f.failures).toEqual([]);
  });
});
