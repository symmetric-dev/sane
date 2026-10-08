import type { DispatchIdentity, DispatchSubmissionEvidence } from "../shared/conversation/dispatch-contract";
import { OpenCodeError, OpenCodeSourceMismatchError } from "./opencode";
import type { OpenCodeRunService, OpenCodeRecoveryObservation } from "./opencode-run-service";
import { PendingInputDomainError, PendingInputStorageError, type PendingInputLiveValidation, type PendingInputStoredItem } from "./pending-input-contract";
import type { PendingInputStore } from "./pending-input-store";
import type { PendingInputPreflight } from "./pending-input-service";
import { equal } from "./prepared-input-codec";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { uuid, type Event } from "./history";

/** Original journal authority independent of mutable Run metadata. This never
 * creates/repairs a Run or log, and never caches a safe protocol observation. */
export function createOriginalRecoveryJournal(dataDir: string, storeId: string) {
  const root = lstatSync(dataDir);
  const pins = new WeakMap<PendingInputStoredItem, { association: string; file: { dev: number; ino: number } | null }>();
  function rootCurrent() {
    const current = lstatSync(dataDir);
    if (!current.isDirectory() || current.isSymbolicLink() || realpathSync(dataDir) !== dataDir || current.dev !== root.dev || current.ino !== root.ino)
      throw new PendingInputStorageError("Original App journal directory changed");
  }
  function readPinned(path: string) {
    rootCurrent();
    const before = lstatSync(path), fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || before.isSymbolicLink() || realpathSync(path) !== path || opened.nlink !== 1 || before.dev !== opened.dev || before.ino !== opened.ino)
        throw new PendingInputStorageError("Original App journal file is unsafe");
      const raw = readFileSync(fd, "utf8"), after = lstatSync(path);
      rootCurrent();
      if (after.isSymbolicLink() || after.nlink !== 1 || after.dev !== opened.dev || after.ino !== opened.ino)
        throw new PendingInputStorageError("Original App journal file changed during read");
      return { raw, dev: opened.dev, ino: opened.ino };
    } finally { closeSync(fd); }
  }
  const manifestPath = join(dataDir, "manifest.json"), manifestPin = readPinned(manifestPath);
  const storedManifest = JSON.parse(manifestPin.raw);
  if (storedManifest.format !== "sane-app-store" || storedManifest.version !== 1 || storedManifest.storeId !== storeId)
    throw new PendingInputStorageError("Original App journal store is invalid");
  function namespace(original: PendingInputStoredItem) {
    const identity = original.claim?.identity;
    if (!identity || !uuid(identity.runId) || !uuid(identity.source.sessionId) || !uuid(storeId))
      throw new PendingInputStorageError("Invalid original App journal namespace");
    const currentManifest = readPinned(manifestPath), manifest = JSON.parse(currentManifest.raw);
    if (currentManifest.dev !== manifestPin.dev || currentManifest.ino !== manifestPin.ino)
      throw new PendingInputStorageError("Original App journal manifest was replaced");
    if (manifest.format !== "sane-app-store" || manifest.version !== 1 || manifest.storeId !== storeId)
      throw new PendingInputStorageError("Original App journal store changed");
    return { identity, path: join(dataDir, `${identity.runId}.jsonl`), association: JSON.stringify({ storeId, itemId: original.itemId,
      chainId: original.chainId, requestId: original.requestId, conversationId: original.request.conversationId,
      attemptId: original.claim!.attemptId, identity }) };
  }
  function capture(original: PendingInputStoredItem) {
    if (pins.has(original)) throw new PendingInputStorageError("Original run journal was already captured");
    const { path, association } = namespace(original);
    let file: { dev: number; ino: number } | null;
    try { const current = readPinned(path); file = { dev: current.dev, ino: current.ino }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      rootCurrent(); file = null; // Absence is also immutable: no later external file may become original.
    }
    pins.set(original, { association, file });
  }
  function read(original: PendingInputStoredItem) {
    const { identity, path, association } = namespace(original), pin = pins.get(original);
    if (!pin || pin.association !== association) throw new PendingInputStorageError("Original run journal association was not captured");
    let file;
    try { file = readPinned(path); }
    catch (error) {
      // An unlinked, never-attempted claim has no historical journal to consult.
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !pin.file && !original.claim!.possibleNative) return undefined;
      throw error;
    }
    if (!pin.file || file.dev !== pin.file.dev || file.ino !== pin.file.ino) throw new PendingInputStorageError("Original run journal was replaced");
    const records: Event[] = [];
    if (!file.raw.endsWith("\n")) throw new PendingInputStorageError("Original run journal has an uncertain partial append");
    for (const line of file.raw.slice(0, -1).split("\n")) {
      const event = JSON.parse(line);
      if (!event || typeof event !== "object" || Array.isArray(event) || !Number.isSafeInteger(event.seq) || event.seq <= (records.at(-1)?.seq ?? 0)
        || typeof event.time !== "string" || !Number.isFinite(Date.parse(event.time)) || event.runId !== identity.runId || event.sessionId !== identity.source.sessionId
        || !["stdout", "stderr", "hook", "status", "submission", "message", "launch", "context"].includes(event.kind) || !("data" in event))
        throw new PendingInputStorageError("Original run journal identity or record changed");
      records.push(event);
    }
    return { path, dev: file.dev, ino: file.ino, records };
  }
  return Object.freeze({ capture, read });
}

/** Process-private original association, NOT a dispatch attempt, Run, lifecycle,
 * owner registry, or wire authorization. The coordinator's static recovered
 * occupancy remains after these bounded read-only observations finish. */
export function createPendingInputRecovery(deps: {
  store: PendingInputStore;
  originals: readonly PendingInputStoredItem[];
  service: OpenCodeRunService;
  available: (observationWrite: boolean) => void;
  association: (original: PendingInputStoredItem) => void;
  pins: (original: PendingInputStoredItem, signal: AbortSignal) => Promise<PendingInputPreflight>;
  protocolUnsafe: (original: PendingInputStoredItem) => boolean;
  protocolMismatch: (original: PendingInputStoredItem, reason: string, validate: () => void) => Promise<void>;
  terminalProof: (original: PendingInputStoredItem) => { status: "completed" | "failed" | "interrupted"; basis: "exact-native-terminal" } | undefined;
  terminalize: (original: PendingInputStoredItem, status: "completed" | "failed" | "interrupted", basis: "not-submitted" | "exact-native-terminal", validate: () => void) => Promise<void>;
  settled: (original: PendingInputStoredItem) => void;
  failClosed: () => void;
}) {
  const shutdown = new AbortController();
  const storeId = deps.store.storeId;
  let observationsOpen = true;
  // This exact object never leaves the synchronous journal closure. DTOs cannot
  // enter its scope, including during startup or the bounded closing drain.
  let writing: { original: PendingInputStoredItem; identity: DispatchIdentity; validate: () => void; stage: "outcome" | "not-submitted" | "settlement" } | undefined;
  let diagnosticWriting = false;
  const stopping = new Map<PendingInputStoredItem, Promise<{ interrupted: boolean; reconciliationRequired: true }>>();
  const stopFences = new Set<PendingInputStoredItem>();
  const observing = new Map<PendingInputStoredItem, Promise<{ interrupted: boolean }>>();
  function unresolved(original: PendingInputStoredItem) {
    const live = deps.store.lookup(original.request.conversationId, original.requestId)?.item;
    return !!live?.claim?.uncertain && ["claimed", "run-linked"].includes(live.state);
  }
  const refuseSubmission = (): never => { throw new PendingInputDomainError("observation-only-recovery", "Recovered originals can never execute or submit again"); };
  function originalCurrent(original: PendingInputStoredItem) {
    deps.available(true);
    if (!observationsOpen || !deps.originals.includes(original)) throw new PendingInputDomainError("pending-input-owner-unavailable", "Original recovery observation is closed", 503);
    const live = deps.store.lookup(original.request.conversationId, original.requestId)?.item;
    if (!original.claim || !live?.claim || !live.claim.uncertain || !["claimed", "run-linked"].includes(live.state)
      || live.itemId !== original.itemId || live.chainId !== original.chainId || live.claim.attemptId !== original.claim.attemptId
      || !equal(live.claim.identity, original.claim.identity) || !equal(live.claim.authorization, original.claim.authorization)
      || !equal(live.snapshot, original.snapshot) || deps.store.storeId !== storeId)
      throw new PendingInputDomainError("scheduler-identity", "Immutable original recovery association changed");
    deps.association(original);
    return live;
  }
  function validateDispatch(input: PendingInputLiveValidation) {
    if (!writing) return false;
    const { original, identity, validate, stage } = writing;
    if (input.stage !== stage || input.authorization !== undefined && stage !== "settlement" || input.chainId !== original.chainId
      || !equal(input.identity, identity) || !equal(input.snapshot, original.snapshot))
      throw new PendingInputDomainError("scheduler-identity", "Recovery scope permits only the exact original outcome");
    if (stage === "settlement" && (!input.authorization || input.authorization.kind !== "settlement"
      || input.authorization.chainId !== original.chainId || input.authorization.predecessorRunId !== identity.runId
      || !equal(input.authorization.source, identity.source)))
      throw new PendingInputDomainError("scheduler-identity", "Recovery settlement authorization changed");
    validate(); originalCurrent(original);
    return true;
  }
  async function observe(original: PendingInputStoredItem, stop: boolean) {
    try {
      if (stop && !stopFences.has(original)) throw new PendingInputDomainError("pending-input-unproven", "Original Stop actor was not fenced");
      deps.available(false); deps.protocolUnsafe(original); originalCurrent(original);
      let pins: PendingInputPreflight;
      try { pins = await deps.pins(original, shutdown.signal); }
      finally { deps.protocolUnsafe(original); } // Authority loss overrides even a local preflight refusal.
      deps.available(false); originalCurrent(original); pins.validate();
      const validate = () => {
        if (stop && !stopFences.has(original)) throw new PendingInputDomainError("pending-input-unproven", "Original Stop actor changed");
        deps.available(true); deps.protocolUnsafe(original); originalCurrent(original); pins.validate();
        deps.protocolUnsafe(original); // Fresh journal/storage observation after every awaited boundary.
      };
      const identity = original.claim!.identity;
      const protocolUnsafe = () => { validate(); return deps.protocolUnsafe(original); };
      const withheld = originalCurrent(original);
      if (!withheld.claim!.possibleNative && withheld.claim!.evidence?.submission === "not-submitted"
        && withheld.claim!.evidence?.nativeAcceptance === "not-accepted" && !protocolUnsafe()) {
        await deps.terminalize(original, identity.source.harnessId === "claude-code" ? "interrupted" : "failed", "not-submitted", validate);
        validate();
        writing = { original, identity, validate, stage: "not-submitted" };
        try { deps.store.archiveNotSubmitted(identity, { kind: "definitely-not-submitted", identity }); }
        finally { writing = undefined; }
        deps.settled(original);
        return { interrupted: false };
      }
      const priorTerminal = deps.terminalProof(original);
      if (priorTerminal && withheld.state === "run-linked" && withheld.claim!.possibleNative
        && withheld.claim!.evidence?.submission === "submitted" && withheld.claim!.evidence?.nativeAcceptance === "accepted" && !protocolUnsafe()) {
        await deps.terminalize(original, priorTerminal.status, priorTerminal.basis, validate);
        validate();
        writing = { original, identity, validate, stage: "settlement" };
        try { deps.store.settle(identity, priorTerminal.status, { kind: "settlement", authorizationId: crypto.randomUUID(),
          chainId: original.chainId, predecessorRunId: identity.runId, source: identity.source }); }
        finally { writing = undefined; }
        deps.settled(original);
        return { interrupted: false };
      }
      const scope: OpenCodeRecoveryObservation = Object.freeze({ identity, validate,
        beforeNative: refuseSubmission, execute: refuseSubmission,
        protocolUnsafe,
        protocolMismatch: async (reason: string) => {
          validate();
          if (protocolUnsafe()) return;
          // This is an awaited original-journal write, not a void dispatch hook.
          // Any partial writer failure is storage-fatal even if domain-shaped.
          try { await deps.protocolMismatch(original, reason, validate); }
          catch (error) { deps.failClosed(); throw new PendingInputStorageError("Original protocol marker write failed", error); }
          validate();
          if (!protocolUnsafe()) throw new PendingInputStorageError("Original protocol marker was not durably observed");
        },
        accepted: () => {
          if (protocolUnsafe()) return false;
          const live = originalCurrent(original);
          return live.claim!.possibleNative && live.claim!.evidence?.submission === "submitted" && live.claim!.evidence.nativeAcceptance === "accepted";
        },
        outcome: () => {
          validate();
          if (protocolUnsafe()) return;
          const live = originalCurrent(original);
          // A receipt cannot rewrite a never-attempted/unlinked original claim.
          if (live.state !== "run-linked" || !live.claim!.possibleNative) return;
          const evidence: DispatchSubmissionEvidence = { ...identity, submission: "submitted", nativeAcceptance: "accepted" };
          if (equal(live.claim!.evidence, evidence)) return;
          if (writing) throw new Error("Reentrant recovery observation");
          writing = { original, identity, validate, stage: "outcome" };
          try { deps.store.hooks(identity).outcome!(evidence); } finally { writing = undefined; }
        },
      });
      const result = await deps.service.observeRecoveredInput(scope, stop);
      validate();
      if (protocolUnsafe()) return result;
      const live = originalCurrent(original);
      const terminal = result.terminal;
      if (terminal && live.state === "run-linked" && live.claim!.possibleNative && live.claim!.evidence?.submission === "submitted"
        && live.claim!.evidence?.nativeAcceptance === "accepted" && equal(terminal.identity, identity)
        && ["completed", "failed", "interrupted"].includes(terminal.status)) {
        await deps.terminalize(original, terminal.status, "exact-native-terminal", validate);
        validate();
        const authorization = { kind: "settlement" as const, authorizationId: crypto.randomUUID(), chainId: original.chainId,
          predecessorRunId: identity.runId, source: identity.source };
        writing = { original, identity, validate, stage: "settlement" };
        try { deps.store.settle(identity, terminal.status, authorization); }
        finally { writing = undefined; }
        deps.settled(original);
      }
      return result;
    } catch (error) {
      if (error instanceof OpenCodeSourceMismatchError) error = new PendingInputDomainError("source-changed", error.message);
      if (error instanceof PendingInputDomainError) {
        if (!shutdown.signal.aborted && ["source-changed", "configuration-changed", "context-changed"].includes(error.code)) {
          try {
            deps.available(false);
            diagnosticWriting = true;
            try { deps.store.pause(original.request.conversationId, { code: error.code as "source-changed" | "configuration-changed" | "context-changed", reason: error.message }); }
            finally { diagnosticWriting = false; }
          } catch (writeError) { deps.failClosed(); throw writeError; }
        }
        return { interrupted: false };
      }
      if (error instanceof OpenCodeError) return { interrupted: false }; // Native unavailability is not a storage failure.
      deps.failClosed();
      throw error instanceof PendingInputStorageError ? error : new PendingInputStorageError("Recovery observation failed", error);
    }
  }
  function observeOnce(original: PendingInputStoredItem, stop: boolean): Promise<{ interrupted: boolean }> {
    const prior = observing.get(original);
    if (prior) return stop ? prior.then(() => observeOnce(original, true)) : prior;
    if (shutdown.signal.aborted || !observationsOpen || !unresolved(original)) return Promise.resolve({ interrupted: false });
    const task = observe(original, stop).finally(() => observing.delete(original));
    observing.set(original, task);
    return task;
  }
  async function refresh() {
    for (const original of deps.originals) {
      if (shutdown.signal.aborted || !observationsOpen) break;
      if (original.claim?.identity.source.harnessId === "opencode"
        || !original.claim?.possibleNative && original.claim?.evidence?.submission === "not-submitted") await observeOnce(original, false);
    }
  }
  return Object.freeze({
    writing: () => (!!writing || diagnosticWriting) && observationsOpen,
    validateDispatch,
    startup: refresh,
    // Retry observation, never execution. A native run still active (or offline)
    // during App startup must not become an operator-only permanent reservation.
    refresh,
    stop(conversationId: string) {
      const original = deps.originals.find(item => item.claim?.identity.source.sessionId === conversationId);
      if (!original || original.claim!.identity.source.harnessId !== "opencode") return Promise.resolve({ interrupted: false, reconciliationRequired: true as const });
      const prior = stopping.get(original); if (prior) return prior;
      // The bridge already durably paused waiting text and fenced any original
      // owner before entering here. Stop is intentional, not submission consent.
      stopFences.add(original); // Sticky original observation actor fence BEFORE the first await.
      const task = observeOnce(original, true).then(result => ({ ...result, reconciliationRequired: true as const })).finally(() => stopping.delete(original));
      stopping.set(original, task); return task;
    },
    close: () => shutdown.abort(),
    closeObservations: () => { observationsOpen = false; },
  });
}
export type PendingInputRecovery = ReturnType<typeof createPendingInputRecovery>;
