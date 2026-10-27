import type { DispatchOrigin } from "../shared/conversation/dispatch-contract";
import { sha256, snapshotIdentity } from "./agent-launch";
import type { ContextMessageInput } from "./context-message";
import { prepareContextMessage, assertContextMessageCurrent, type ContextMessagePreparation, type ContextMessageGuards } from "./context-message-engine";
import type { OwnedContextMessageRequest } from "./context-message-transport";
import type { ContextPackageStore } from "./context-package-store";
import { synchronousDispatchHook } from "./dispatch-evidence";
import type { Run, Session } from "./history";
import { canonicalJSON } from "./prepared-input-codec";
import type { ContextBinding, createSessionMessageSource } from "./session-context-source";
import { validateCanonicalActivation } from "./user-input-preparation";
import type { WorkerStore } from "./worker-store";
import { WorkstreamAdapterError } from "./workstreams";

export type SubmissionMessageIntent = Readonly<{
  kind: "assistant-activation" | "assistant-upgrade" | "worker-launch";
  source: string;
  assertCurrent: () => void;
  workerId?: string;
}> | Readonly<{
  kind: "selected";
  source: string;
  readCurrent: () => ContextMessageInput | Promise<ContextMessageInput>;
  assertCurrent: () => void;
}>;

export type OwnedMessagePreparationPorts = {
  storeId: string;
  contextPackages: Pick<ContextPackageStore, "load">;
  activationStores: Parameters<typeof validateCanonicalActivation>[2];
  /** Preparation-entry lifecycle authority for an already admitted paired activation.
   * Synchronous metadata/pin check only: no journal/native-history reconstruction,
   * package reload or repository discovery. Refuse known unsupported legacy,
   * branch or compaction states; absence is never bootstrap/migration authority.
   * This does not continuously recertify out-of-band native history retention. */
  assertQualifiedContinuation: (session: Session, activeRun: Run) => void;
  sessionMessageSource: ReturnType<typeof createSessionMessageSource>;
  contextBinding: ContextBinding;
  readWorker: WorkerStore["get"];
  assertCleanContextChannel: (nativeId: string, cwd: string) => Promise<void>;
};

/** Preparation only; lifecycle ownership and final source publication stay with the caller. */
export function createPrepareOwnedMessage({ storeId, contextPackages, activationStores, assertQualifiedContinuation,
  sessionMessageSource, contextBinding, readWorker, assertCleanContextChannel }: OwnedMessagePreparationPorts) {
  return async function prepareOwnedMessage(session: Session, activeRun: Run, originalBody: string, origin: DispatchOrigin,
    intent: SubmissionMessageIntent | undefined, request: OwnedContextMessageRequest, assertCurrent: () => void, publishSourceCheck: (check: () => void) => void) {
    const body = request.liveInput ? request.body : originalBody;
    if (request.body !== body) throw new WorkstreamAdapterError(409, "context-source-changed", "Adapter authored input differs from the original admitted body");
    const guards: ContextMessageGuards = { assertOwnership: assertCurrent, assertSource: assertCurrent, assertNotCancelled: assertCurrent };
    const identity = snapshotIdentity(session), sane = identity !== undefined;
    const binding = structuredClone(contextBinding(session));
    const assertBoundInput = () => {
      assertCurrent();
      if (request.body !== body || canonicalJSON(contextBinding(session)) !== canonicalJSON(binding)) throw new WorkstreamAdapterError(409, "context-source-changed", "Authored body or native binding changed before submission");
    };
    const assertContinuation = () => {
      if (!identity || !session.saneExecution) throw new WorkstreamAdapterError(409, "context-activation-unproven", "SANE execution has no immutable pinned execution policy");
      synchronousDispatchHook(() => assertQualifiedContinuation(session, activeRun));
    };
    let sourceCheck = assertBoundInput;
    const retain = (check: () => void) => {
      sourceCheck = () => { assertBoundInput(); check(); };
      publishSourceCheck(sourceCheck);
    };
    const ordinary = request.liveInput || !intent;
    if (ordinary || intent.kind === "selected") {
      assertBoundInput();
      if (sane) assertContinuation();
    }
    let preparation: ContextMessagePreparation;
    let input: ContextMessageInput;
    if (ordinary) {
      publishSourceCheck(sourceCheck);
      const read = () => { sourceCheck(); return { body, binding, origin, placement: { kind: "body-only" as const } }; };
      preparation = { kind: "ordinary", guards, readCurrentOrdinary: read };
      input = read();
    } else if (intent.kind === "selected") {
      retain(() => { synchronousDispatchHook(intent.assertCurrent); });
      const read = async () => {
        sourceCheck();
        const selected = structuredClone(await intent.readCurrent());
        sourceCheck();
        if (selected.placement.kind !== "selected" || selected.body !== body || canonicalJSON(selected.binding) !== canonicalJSON(binding)) throw new WorkstreamAdapterError(409, "context-source-changed", "Explicit selected update differs from its original body or native binding");
        return selected as Exclude<ContextMessageInput, { placement: { kind: "body-only" } }>;
      };
      preparation = { kind: "context", guards, assertSelectionCurrent: () => sourceCheck() };
      input = await read();
    } else {
      if (request.liveInput || !identity || !session.saneExecution || !session.saneContext?.package) throw new WorkstreamAdapterError(409, "context-activation-unproven", "Explicit activation has no canonical identity and paired pins");
      const read = async () => {
        assertCurrent(); synchronousDispatchHook(intent.assertCurrent);
        const pinned = await contextPackages.load(session.saneContext!.package!);
        const roots = await sessionMessageSource(session, assertCurrent);
        const worker = intent.kind === "worker-launch" && intent.workerId ? readWorker(intent.workerId) : undefined;
        const assignment = worker ? session.saneContext!.assignment : undefined;
        if (intent.kind === "worker-launch" && (!worker || worker.sessionId !== session.sessionId || worker.input.worker !== identity.role || !assignment)) throw new WorkstreamAdapterError(409, "context-source-unavailable", "Worker bootstrap has no original structured assignment authority");
        const workerPin = worker && canonicalJSON({ input: worker.input, protocol: worker.protocol, assignment });
        const workerCheck = () => {
          if (!worker) return;
          const current = readWorker(worker.id);
          if (!current || canonicalJSON({ input: current.input, protocol: current.protocol, assignment: session.saneContext?.assignment }) !== workerPin) throw new WorkstreamAdapterError(409, "context-source-changed", "Worker assignment or protocol changed before bootstrap");
        };
        retain(() => { synchronousDispatchHook(intent.assertCurrent); roots.check(); workerCheck(); });
        const runtimeSelections = worker?.protocol?.id === "explicit-v1" ? [
          { kind: "asset" as const, assetId: "framework.worker-protocol", reason: "Original explicit worker protocol activation" },
          { kind: "fragment" as const, fragment: { id: "worker-protocol-state", category: "protocol" as const,
            text: `Worker protocol: explicit-v1.\nWaiting: ${worker.wait?.reason ?? "none"}.${worker.wait?.correlationId ? `\nMessage correlation: ${worker.wait.correlationId}.` : ""}`,
            source: `app:${storeId}/worker:${worker.id}/protocol`, revision: sha256(canonicalJSON({ protocol: worker.protocol, wait: worker.wait ?? null })), reason: "Original authoritative worker protocol state" } },
        ] : [];
        return { body, binding, origin: intent.kind === "worker-launch" ? "worker-launch" as const : "activation" as const,
          placement: { kind: "bootstrap" as const, ...(worker ? { workerMode: worker.input.worker === "implementer" && !worker.input.jobs?.length ? "free" as const : "assigned" as const } : {}) },
          context: pinned, session: roots.fragment,
          ...(worker ? { assignment: { id: "worker-assignment", category: "worker-assignment" as const, text: assignment!, source: intent.source,
            revision: sha256(workerPin!), reason: "Original worker launch paths and assigned jobs, excluding the procedure" }, runtimeSelections } : {}) };
      };
      // Lifecycle validation belongs to explicit activation preparation, not a
      // generic assertCurrent callback that is replayed around dispatch awaits.
      assertBoundInput(); synchronousDispatchHook(intent.assertCurrent);
      await validateCanonicalActivation({ saneExecution: session.saneExecution, saneContext: session.saneContext }, identity, activationStores);
      assertBoundInput(); synchronousDispatchHook(intent.assertCurrent);
      if (session.harness === "opencode") await assertCleanContextChannel(session.nativeSessionId!, session.cwd);
      assertBoundInput(); synchronousDispatchHook(intent.assertCurrent);
      preparation = { kind: "context", guards, assertSelectionCurrent: () => sourceCheck() };
      input = await read();
    }
    const message = await prepareContextMessage(input, preparation);
    return { message, assertCurrent: async () => { await assertContextMessageCurrent(message, preparation); } };
  };
}
