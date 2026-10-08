import { expect, test } from "bun:test";
import { ChatStore } from "./store";
import { ApiError } from "./cc-client";
import { pendingInputClient, PendingInputApiError } from "./pending-input-client";
import type { Config, ConversationClient } from "./types";
import type { PendingInputRemovalRequest, PendingInputRequest, PendingInputResumeRequest } from "../shared/conversation/pending-input-contract";
import type { PendingInputView } from "./pending-input-presentation";
import { isPendingInputView } from "./pending-input-presentation";
import { pendingInputLid, pendingInputPrimaryAction } from "./pending-input-primary-action";

test("pending-input refresh keeps validated queue presentation quiet and retains warnings until fresh success", async () => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage"), previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { hidden: true } });
  const capability = { protocol: "pending-input", version: 1, supported: true, maxWaiting: 3, removal: true, resume: true } as const;
  const config: Config = { authRequired: false, authenticated: true, storeId: "00000000-0000-4000-8000-000000000001", pendingInputCapability: capability };
  const source = { harnessId: "opencode", conversationId: "A", authorityId: "authority-fixture", nativeSessionId: "native-A", cwd: "/fixture" };
  const configuration = { cwd: "/fixture", profileId: "base:opencode", model: "original" };
  const item = { version: 1 as const, requestId: "original-input", conversationId: "A", text: "waiting text", source, configuration, itemId: "item-original", sequence: 1, state: "waiting" as const };
  const paused: PendingInputView = {
    snapshot: { version: 1, conversationId: "A", revision: 7, paused: true, reason: "Stopped", items: [item], tombstones: [] },
    presentation: { maxWaiting: 3, waitingCount: 1, chainLocked: true, chainId: "chain-original", source, configuration, currentAssertions: { source, configuration },
      removals: [{ itemId: item.itemId, allowed: true, code: null }], unresolved: null, pauseCode: "stopped", enqueue: { allowed: true, code: null, reason: null },
      removalAllowed: true, resumeAllowed: true, automation: { supported: true, reason: null }, hidden: false },
  };
  let read = async () => paused;
  const client: ConversationClient = {
    config: async () => config, login: async () => {}, logout: async () => {},
    conversations: async () => ({ conversations: [], availability: { canSend: true } }), runs: async () => [], events: async () => ({ events: [], nextCursor: 0, status: "completed" }),
    models: async () => [], interactions: async () => [], reply: async () => {}, cancel: async () => ({ interrupted: false }), submit: async () => { throw new Error("No input should be submitted"); },
    pendingInputs: async () => read(),
  };
  const store = new ChatStore(client);
  store.state = { ...store.state, phase: "ready", config, selected: "A", connected: true, loading: false, availability: { canSend: true },
    conversations: [{ id: "A", harness: "opencode", authorityId: source.authorityId, nativeSessionId: source.nativeSessionId, cwd: source.cwd, lastRunId: null, status: "completed" }] };
  const deferRead = () => {
    const entered = Promise.withResolvers<void>(), response = Promise.withResolvers<PendingInputView>();
    read = async () => { entered.resolve(); return response.promise; };
    return { entered: entered.promise, response, completion: store.refreshPendingInputs() };
  };
  const lid = () => pendingInputLid(store.state, store.pendingInputSupported());
  const action = () => pendingInputPrimaryAction({ state: store.state, supported: store.pendingInputSupported(), chainLocked: store.pendingInputChainLocked(),
    command: false, text: "next message", sendBlocked: false, sendReason: null, queueReason: store.pendingInputUnavailable() || null, inactive: false, composing: false });
  try {
    const initial = deferRead();
    expect(store.state.pendingInputLoading).toBe(true); expect(lid()?.text).toBe("Checking queue…");
    await initial.entered; initial.response.resolve(paused); expect(await initial.completion).toBe(true);
    const pausedLid = lid(), pausedAction = action();
    expect(pausedLid).toEqual({ text: "Queue paused", waitingLabel: "Waiting 1/3", state: "paused" });
    expect(pausedAction).toMatchObject({ mode: "add-paused", disabled: false, reason: null });
    const background = deferRead(); await background.entered;
    expect(store.state.pendingInputLoading).toBe(false); expect(store.state.pendingInputs).toBe(paused);
    expect(lid()).toEqual(pausedLid); expect(action()).toEqual(pausedAction); expect(store.pendingInputUnavailable()).toBe("");
    background.response.reject(new Error("offline")); expect(await background.completion).toBe(false);
    expect(store.state.pendingInputs).toBe(paused); expect(store.pendingInputChainLocked()).toBe(true);
    const warning = store.state.pendingInputError ?? "";
    expect(warning).toContain("offline"); expect(store.pendingInputUnavailable()).toBe(warning);
    expect(lid()).toEqual({ text: "Queue needs attention", waitingLabel: "Waiting 1/3", state: "reconciliation" });
    const retry = deferRead(); await retry.entered;
    expect(store.state.pendingInputLoading).toBe(false); expect(store.state.pendingInputError).toBe(warning);
    expect(lid()?.text).toBe("Queue needs attention"); expect(action().disabled).toBe(true);
    const empty: PendingInputView = { snapshot: { ...paused.snapshot, revision: 8, paused: false, reason: null, items: [] },
      presentation: { ...paused.presentation, waitingCount: 0, chainLocked: false, chainId: null, removals: [], pauseCode: null, resumeAllowed: false } };
    retry.response.resolve(empty); expect(await retry.completion).toBe(true);
    expect(store.state.pendingInputError).toBe(""); expect(store.state.pendingInputs).toBe(empty);
    expect(store.pendingInputChainLocked()).toBe(false); expect(store.pendingInputUnavailable()).toBe(""); expect(lid()).toBeNull();
    const emptyAction = action(), emptyPoll = deferRead(); await emptyPoll.entered;
    expect(store.state.pendingInputLoading).toBe(false); expect(lid()).toBeNull(); expect(action()).toEqual(emptyAction);
    expect(store.pendingInputUnavailable()).toBe(""); emptyPoll.response.resolve(empty); expect(await emptyPoll.completion).toBe(true);

    // A changed native-source fence needs new proof, not a reassuring cached lid.
    store.state = { ...store.state, conversations: [{ ...store.state.conversations[0]!, nativeSessionId: "native-B" }] };
    const sourceRead = deferRead(); await sourceRead.entered;
    expect(store.state.pendingInputLoading).toBe(true);
    // Source failures remain visible even when queue support fails closed.
    sourceRead.response.resolve(empty); expect(await sourceRead.completion).toBe(false);
    expect(store.pendingInputSupported()).toBe(false); expect(lid()?.text).toBe("Queue needs attention");
    const sourceWarning = store.state.pendingInputError, sourceRetry = deferRead(); await sourceRetry.entered;
    expect(store.state.pendingInputLoading).toBe(false); expect(store.state.pendingInputError).toBe(sourceWarning);
    expect(lid()?.text).toBe("Queue needs attention");
    const newSource = { ...source, nativeSessionId: "native-B" };
    const corrected: PendingInputView = { ...empty, presentation: { ...empty.presentation, source: newSource, currentAssertions: { source: newSource, configuration } } };
    sourceRetry.response.resolve(corrected); expect(await sourceRetry.completion).toBe(true); expect(lid()).toBeNull();

    // Explicit uncertainty outranks checking even if a foreground read is needed.
    const uncertain: PendingInputView = { snapshot: { ...paused.snapshot, items: [{ ...item, source: newSource, state: "claimed" }] },
      presentation: { ...paused.presentation, source: newSource, currentAssertions: { source: newSource, configuration }, waitingCount: 0, resumeAllowed: false,
        removals: [{ itemId: item.itemId, allowed: false, code: "pending-input-claimed" }], unresolved: { itemId: item.itemId, requestId: item.requestId, classification: "uncertain" } } };
    expect(isPendingInputView(uncertain, "A")).toBe(true);
    expect(pendingInputLid({ ...store.state, pendingInputs: uncertain, pendingInputLoading: true }, true)?.text).toBe("Reconciliation needed");
    const unknown = { ...store.state, pendingInputLoading: true, pendingInputOperations: { original: { requestId: "original", conversationId: "A", kind: "enqueue" as const, state: "unknown" as const } } };
    expect(pendingInputLid(unknown, true)?.text).toBe("Request unconfirmed");
    expect(pendingInputPrimaryAction({ state: unknown, supported: true, chainLocked: true, command: false, text: "next", sendBlocked: false,
      sendReason: null, queueReason: "Resolve original request", inactive: false, composing: false })).toMatchObject({ mode: "check-request", disabled: false });
  } finally {
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage); else Reflect.deleteProperty(globalThis, "localStorage");
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else Reflect.deleteProperty(globalThis, "document");
  }
});

test("pending-input recovery preserves immutable intent across selection, reload, 404 and explicit replay; resume retains its original CAS", async () => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage"), previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document"), previousFetch = globalThis.fetch;
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { hidden: true } });
  const posts: PendingInputRequest[] = [], resumes: PendingInputResumeRequest[] = [], cancellations: string[] = [];
  const entered = Promise.withResolvers<void>(), response = Promise.withResolvers<never>();
  const capability = { protocol: "pending-input", version: 1, supported: true, maxWaiting: 3, removal: true, resume: true } as const;
  let model = "configured-original", revision = 0, paused = false, waiting: PendingInputRequest | undefined;
  const source = (id: string) => ({ harnessId: "opencode", conversationId: id, authorityId: "authority-fixture", nativeSessionId: `native-${id}`, cwd: "/fixture" });
  const view = (id: string): PendingInputView => {
    const assertions = { source: source(id), configuration: { cwd: "/fixture", profileId: "base:opencode", model } };
    const item = waiting && id === "A" ? { ...waiting, itemId: "item-original", sequence: 1, state: "waiting" as const } : undefined;
    return { snapshot: { version: 1, conversationId: id, revision, paused, reason: paused ? "Stopped" : null, items: item ? [item] : [], tombstones: [] }, presentation: {
      maxWaiting: 3, waitingCount: item ? 1 : 0, chainLocked: !!item, chainId: item ? "chain-original" : null,
      source: item?.source ?? assertions.source, configuration: item?.configuration ?? assertions.configuration, currentAssertions: assertions,
      removals: item ? [{ itemId: item.itemId, allowed: true, code: null }] : [], unresolved: null, pauseCode: paused ? "stopped" : null,
      enqueue: { allowed: true, code: null, reason: null }, removalAllowed: true, resumeAllowed: !!item, automation: { supported: true, reason: null }, hidden: false,
    } };
  };
  const receipt = (input: PendingInputRequest) => ({ version: 1 as const, outcome: "enqueued" as const, conversationId: input.conversationId, requestId: input.requestId, itemId: "item-original", sequence: 1, revision: 1 });
  const client: ConversationClient = {
    config: async () => ({ authRequired: false, authenticated: true, storeId: "00000000-0000-4000-8000-000000000001", pendingInputCapability: capability }), login: async () => {}, logout: async () => {},
    conversations: async () => ({ conversations: [], availability: { canSend: true } }), runs: async () => [], events: async () => ({ events: [], nextCursor: 0, status: "completed" }),
    models: async () => [], interactions: async () => [], reply: async () => {}, cancel: async id => { cancellations.push(id); return { interrupted: false }; }, submit: async () => { throw new Error("Ordinary input must remain blocked"); },
    pendingInputs: async id => view(id),
    enqueuePendingInput: async (_id, input) => {
      expect([...values.values()].some(raw => raw.includes(input.requestId))).toBe(true);
      posts.push(structuredClone(input));
      if (posts.length === 1) { entered.resolve(); return response.promise; }
      waiting = input; revision = 1; return receipt(input);
    },
    pendingInputStatus: async () => { throw new ApiError("Original receipt missing", 404); },
    resumePendingInputs: async (_id, input) => {
      resumes.push(structuredClone(input));
      if (resumes.length === 1) throw new PendingInputApiError("Response lost after durable resume", 503, "pending-input-storage", { conversationId: input.conversationId, requestId: input.requestId, reconciliationRequired: true });
      throw new PendingInputApiError("Original observed revision is stale", 409, "pending-input-stale", { error: "Original observed revision is stale", code: "pending-input-stale" });
    },
  };
  const makeStore = () => {
    const store = new ChatStore(client);
    store.state = { ...store.state, phase: "ready", config: { authRequired: false, authenticated: true, storeId: "00000000-0000-4000-8000-000000000001", pendingInputCapability: capability },
      selected: "A", connected: true, loading: false, availability: { canSend: true }, conversations: ["A", "B"].map(id => ({ id, harness: "opencode", authorityId: "authority-fixture", nativeSessionId: `native-${id}`, cwd: "/fixture", lastRunId: null, status: "completed" })) };
    (store as any).poll = async () => {};
    store.executionUnavailable = () => ""; store.modelUnavailable = () => false;
    return store;
  };
  try {
    const first = makeStore(); first.setDraft({ text: "original\n日本" });
    const submission = first.enqueuePendingInput(first.draft().text); await entered.promise;
    const original = structuredClone(posts[0]!);
    first.setDraft({ text: "new draft" }); first.choose("B");
    response.reject(new Error("network timeout")); expect(await submission).toEqual({ status: "unknown" });
    expect(first.state.selected).toBe("B"); expect(first.state.pendingInputOperations?.[original.requestId]).toBeUndefined();
    expect(first.draft("A").text).toBe("new draft"); expect(posts).toHaveLength(1);

    const restored = makeStore(); restored.setDraft({ text: "new draft" });
    await restored.refreshPendingInputs(); expect(restored.state.pendingInputOperations?.[original.requestId]?.state).toBe("unknown");
    expect(restored.pendingInputChainLocked()).toBe(true); expect(posts).toHaveLength(1);
    await restored.checkPendingInput(original.requestId); expect(restored.state.pendingInputOperations?.[original.requestId]?.state).toBe("unknown");
    expect(await restored.enqueuePendingInput("different text")).toEqual({ status: "blocked" }); expect(await restored.send("different text")).toEqual({ status: "blocked" });
    model = "configured-changed"; restored.state.config = { ...restored.state.config!, cwd: "/changed-settings" };
    await restored.refreshPendingInputs(); expect(posts).toHaveLength(1);
    await restored.retransmitPendingInput(original.requestId);
    expect(posts).toEqual([original, original]); expect(restored.draft().text).toBe("new draft");
    expect(restored.state.pendingTurn).toBeUndefined(); expect(restored.state.messages).toEqual([]);
    expect(restored.state.pendingInputOperations?.[original.requestId]?.state).toBe("confirmed");
    restored.capabilities = () => ({ cancelRun: false });
    await restored.cancel(); expect(cancellations).toEqual(["A"]); expect(restored.state.actionNotice).toContain("Waiting messages paused; native cancellation not confirmed");

    model = "configured-original"; paused = true; revision = 7; await restored.resumePendingInputs();
    expect(resumes).toHaveLength(1); expect(resumes[0]!.expectedRevision).toBe(7);
    const resumeId = resumes[0]!.requestId;
    await restored.cancel(); expect(restored.state.pendingInputOperations?.[resumeId]?.state).toBe("unknown"); expect(restored.state.actionNotice).toContain("late original POST may still commit");
    paused = false; revision = 8; await restored.checkPendingInput(resumeId);
    expect(restored.state.pendingInputOperations?.[resumeId]?.state).toBe("unknown"); expect(restored.state.pendingInputError).toContain("cannot confirm");
    await restored.resumePendingInputs(); expect(resumes).toHaveLength(1);
    await restored.retransmitPendingInput(resumeId); expect(resumes).toEqual([resumes[0]!, resumes[0]!]);
    expect(restored.state.pendingInputOperations?.[resumeId]?.state).toBe("rejected");

    const wrongStore = makeStore(); wrongStore.state.config = { ...wrongStore.state.config!, storeId: "00000000-0000-4000-8000-000000000002" };
    await wrongStore.refreshPendingInputs(); expect(wrongStore.state.pendingInputOperations).toEqual({});
    wrongStore.choose("B"); wrongStore.setDraft({ text: "retain when storage fails" });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: () => { throw new Error("Quota unavailable"); } } });
    expect(await wrongStore.enqueuePendingInput(wrongStore.draft().text)).toEqual({ status: "blocked" });
    expect(wrongStore.draft().text).toBe("retain when storage fails"); expect(posts).toHaveLength(2);
    const removal = { version: 1 as const, conversationId: "A", requestId: "removal-identity", inputRequestId: original.requestId, itemId: "item-original" };
    globalThis.fetch = (async () => Response.json({ ...removal, outcome: "claimed", revision: 9, runId: "busy-head" }, { status: 409 })) as unknown as typeof fetch;
    expect(await pendingInputClient.removePendingInput("A", removal)).toMatchObject({ outcome: "claimed", requestId: removal.requestId });
    globalThis.fetch = (async () => Response.json({ error: "reconcile", code: "pending-input-storage", conversationId: "A", requestId: original.requestId, reconciliationRequired: true }, { status: 503 })) as unknown as typeof fetch;
    try { await pendingInputClient.enqueuePendingInput("A", original); throw new Error("503 must not become success"); }
    catch (error) { expect(error).toBeInstanceOf(PendingInputApiError); expect((error as PendingInputApiError).body).toMatchObject({ requestId: original.requestId, reconciliationRequired: true }); }
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage); else Reflect.deleteProperty(globalThis, "localStorage");
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else Reflect.deleteProperty(globalThis, "document");
  }
});

test("pending-input mutations fence fresh App identity and selected source, retain ambiguous receipts, and ignore pre-ack queue reads", async () => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage"), previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document"), previousFetch = globalThis.fetch;
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { hidden: true } });
  const capability = { protocol: "pending-input", version: 1, supported: true, maxWaiting: 3, removal: true, resume: true } as const;
  const configA: Config = { authRequired: false, authenticated: true, storeId: "00000000-0000-4000-8000-000000000001", pendingInputCapability: capability };
  let freshConfig: Config = configA, revision = 7, model = "original", enqueueAllowed = true;
  const selectedSource = { harnessId: "opencode", conversationId: "A", authorityId: "authority-fixture", nativeSessionId: "native-A", cwd: "/fixture" };
  let chainSource = selectedSource, assertionSource = selectedSource;
  let waiting: PendingInputRequest | undefined = { version: 1, requestId: "00000000-0000-4000-8000-000000000003", conversationId: "A", text: "original waiting input", source: selectedSource, configuration: { cwd: "/fixture", profileId: "base:opencode", model } };
  const view = (): PendingInputView => {
    const configuration = { cwd: "/fixture", profileId: "base:opencode", model };
    const item = waiting ? { ...waiting, source: chainSource, itemId: "item-original", sequence: 1, state: "waiting" as const } : undefined;
    return { snapshot: { version: 1, conversationId: "A", revision, paused: !!item, reason: item ? "Stopped" : null, items: item ? [item] : [], tombstones: [] }, presentation: {
      maxWaiting: 3, waitingCount: item ? 1 : 0, chainLocked: !!item, chainId: item ? "chain-original" : null,
      source: item?.source ?? assertionSource, configuration: item?.configuration ?? configuration, currentAssertions: { source: assertionSource, configuration },
      removals: item ? [{ itemId: item.itemId, allowed: true, code: null }] : [], unresolved: null, pauseCode: item ? "stopped" : null,
      enqueue: { allowed: enqueueAllowed, code: enqueueAllowed ? null : "pending-input-chain-conflict", reason: enqueueAllowed ? null : "Pins changed" },
      removalAllowed: true, resumeAllowed: !!item, automation: { supported: true, reason: null }, hidden: false,
    } };
  };
  const resumes: PendingInputResumeRequest[] = [], removals: PendingInputRemovalRequest[] = [], posts: PendingInputRequest[] = [];
  let cancels = 0, hides = 0;
  let resumeFailure: unknown = new Error("Lost original resume response");
  let read = async () => view();
  const postEntered = Promise.withResolvers<void>(), postResponse = Promise.withResolvers<any>();
  const client: ConversationClient = {
    config: async () => freshConfig, login: async () => {}, logout: async () => {},
    conversations: async () => ({ conversations: [], availability: { canSend: true } }), runs: async () => [], events: async () => ({ events: [], nextCursor: 0, status: "completed" }),
    models: async () => [], interactions: async () => [], reply: async () => {}, cancel: async () => { cancels++; return { interrupted: false }; },
    hide: async () => { hides++; }, submit: async () => { throw new Error("Ordinary input must remain blocked"); },
    pendingInputs: async () => read(),
    resumePendingInputs: async (_id, input) => { resumes.push(structuredClone(input)); throw resumeFailure; },
    removePendingInput: async (id, input) => { removals.push(structuredClone(input)); return pendingInputClient.removePendingInput(id, input); },
    enqueuePendingInput: async (_id, input) => { posts.push(structuredClone(input)); postEntered.resolve(); return postResponse.promise; },
  };
  const makeStore = () => {
    const store = new ChatStore(client);
    store.state = { ...store.state, phase: "ready", config: configA, selected: "A", connected: true, loading: false, availability: { canSend: true },
      conversations: [{ id: "A", harness: "opencode", authorityId: "authority-fixture", nativeSessionId: "native-A", cwd: "/fixture", lastRunId: null, status: "completed" }] };
    (store as any).poll = async () => {};
    store.executionUnavailable = () => ""; store.modelUnavailable = () => false;
    return store;
  };
  try {
    const originalStore = makeStore(); await originalStore.resumePendingInputs();
    const original = structuredClone(resumes[0]!), originalLedger = [...values.values()][0]!;
    expect(resumes).toHaveLength(1); expect(originalStore.state.pendingInputOperations?.[original.requestId]?.state).toBe("unknown");
    freshConfig = { ...configA, storeId: "00000000-0000-4000-8000-000000000002" };
    originalStore.capabilities = () => ({ cancelRun: false });
    await originalStore.cancel(); await originalStore.hide("A");
    await originalStore.retransmitPendingInput(original.requestId);
    expect(resumes).toEqual([original]); expect(cancels).toBe(0); expect(hides).toBe(0);
    expect([...values.values()]).toEqual([originalLedger]); expect(originalStore.state.pendingInputOperations).toEqual({});
    expect(originalStore.pendingInputSupported()).toBe(false);
    freshConfig = { ...configA, storeId: undefined };
    await originalStore.retransmitPendingInput(original.requestId); expect(resumes).toHaveLength(1); expect([...values.values()]).toEqual([originalLedger]);
    freshConfig = { ...configA, authenticated: false };
    await originalStore.retransmitPendingInput(original.requestId); expect(resumes).toHaveLength(1); expect([...values.values()]).toEqual([originalLedger]);

    freshConfig = configA; await originalStore.refreshPendingInputs();
    resumeFailure = new PendingInputApiError("Unrecognized conflict", 409, "future-conflict", { error: "Unrecognized conflict", code: "future-conflict" });
    await originalStore.retransmitPendingInput(original.requestId);
    expect(resumes).toEqual([original, original]); expect(originalStore.state.pendingInputOperations?.[original.requestId]?.state).toBe("unknown");
    expect(JSON.parse([...values.values()][0]!)[0].body).toEqual(original);
    resumeFailure = new PendingInputApiError("Stale but miscorrelated", 409, "pending-input-stale", { error: "Stale", code: "pending-input-stale", requestId: "another-request" });
    await originalStore.retransmitPendingInput(original.requestId);
    expect(resumes.at(-1)).toEqual(original); expect(originalStore.state.pendingInputOperations?.[original.requestId]?.state).toBe("unknown");
    resumeFailure = new PendingInputApiError("Original revision stale", 409, "pending-input-stale", { error: "Original revision stale", code: "pending-input-stale" });
    revision = 8; await originalStore.retransmitPendingInput(original.requestId);
    expect(resumes.at(-1)).toEqual(original); expect(originalStore.state.pendingInputOperations?.[original.requestId]?.state).toBe("rejected");
    expect(JSON.parse([...values.values()][0]!)).toEqual([]);
    await originalStore.resumePendingInputs(); expect(resumes.at(-1)!.requestId).not.toBe(original.requestId); expect(resumes.at(-1)!.expectedRevision).toBe(8);

    values.clear(); resumes.length = 0;
    const sourceStore = makeStore(); chainSource = { ...selectedSource, nativeSessionId: "native-B" }; assertionSource = chainSource;
    await sourceStore.resumePendingInputs(); expect(resumes).toEqual([]); expect(values.size).toBe(0); expect(sourceStore.state.pendingInputs).toBeNull();
    chainSource = selectedSource;
    await sourceStore.resumePendingInputs(); expect(resumes).toEqual([]); expect(values.size).toBe(0); expect(sourceStore.pendingInputSupported()).toBe(false);
    assertionSource = selectedSource; model = "changed"; enqueueAllowed = false;
    await sourceStore.resumePendingInputs(); expect(resumes).toEqual([]); expect(values.size).toBe(0);

    // Removal is pinned to the original waiter, not today's enqueue configuration.
    globalThis.fetch = (async (_url, init) => {
      const input = JSON.parse(init!.body as string);
      return Response.json({ ...input, inputRequestId: "wrong-original-input", outcome: "claimed", revision: 9, runId: "other-run" }, { status: 409 });
    }) as typeof fetch;
    await sourceStore.removePendingInput("item-original");
    const removal = structuredClone(removals[0]!);
    expect(removals).toHaveLength(1); expect(sourceStore.state.pendingInputOperations?.[removal.requestId]?.state).toBe("unknown");
    expect(JSON.parse([...values.values()][0]!)[0].body).toEqual(removal);
    globalThis.fetch = (async (_url, init) => Response.json({ ...JSON.parse(init!.body as string), outcome: "claimed", revision: 9, runId: "original-target-run" }, { status: 409 })) as typeof fetch;
    revision = 9; await sourceStore.retransmitPendingInput(removal.requestId);
    expect(removals).toEqual([removal, removal]); expect(sourceStore.state.pendingInputOperations?.[removal.requestId]?.state).toBe("confirmed");
    expect(sourceStore.state.pendingInputs?.snapshot.items[0]?.requestId).toBe(waiting!.requestId);

    values.clear(); waiting = undefined; model = "original"; enqueueAllowed = true; revision = 0;
    const ackStore = makeStore(); ackStore.setDraft({ text: "queued text" });
    const admission = ackStore.enqueuePendingInput(ackStore.draft().text); await postEntered.promise;
    const oldEntered = Promise.withResolvers<void>(), oldResponse = Promise.withResolvers<PendingInputView>();
    const freshEntered = Promise.withResolvers<void>(), freshResponse = Promise.withResolvers<PendingInputView>();
    const emptyBeforeAck = view(); let queueReads = 0;
    read = async () => { if (++queueReads === 1) { oldEntered.resolve(); return oldResponse.promise; } freshEntered.resolve(); return freshResponse.promise; };
    const oldPoll = ackStore.refreshPendingInputs(); await oldEntered.promise;
    const confirmed = Promise.withResolvers<void>();
    const unsubscribe = ackStore.subscribe(() => { if (ackStore.state.pendingInputOperations?.[posts[0]!.requestId]?.state === "confirmed") confirmed.resolve(); });
    waiting = posts[0]!; revision = 10;
    postResponse.resolve({ version: 1, outcome: "enqueued", conversationId: "A", requestId: waiting.requestId, itemId: "item-original", sequence: 1, revision });
    await confirmed.promise;
    expect(ackStore.pendingInputChainLocked()).toBe(true);
    oldResponse.resolve(emptyBeforeAck); expect(await oldPoll).toBe(false); await freshEntered.promise;
    expect(queueReads).toBe(2); expect(ackStore.pendingInputChainLocked()).toBe(true);
    expect(await ackStore.send("ordinary input")).toEqual({ status: "blocked" });
    ackStore.setDraft({ upgradeId: "must-not-stage" }); expect(ackStore.draft().upgradeId).toBe("");
    await ackStore.compact(); expect(ackStore.state.compactError).toContain("existing input chain");
    expect(ackStore.state.messages).toEqual([]); expect(ackStore.state.pendingTurn).toBeUndefined();
    freshResponse.resolve(view()); expect(await admission).toEqual({ status: "queued", conversationId: "A", requestId: posts[0]!.requestId });
    expect(ackStore.pendingInputChainLocked()).toBe(true); expect(ackStore.draft().text).toBe("");
    unsubscribe(); read = async () => view(); waiting = undefined; revision = 11;
    expect(await ackStore.refreshPendingInputs()).toBe(true); expect(ackStore.pendingInputChainLocked()).toBe(false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage); else Reflect.deleteProperty(globalThis, "localStorage");
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else Reflect.deleteProperty(globalThis, "document");
  }
});
