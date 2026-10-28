import type { DispatchEvidenceHooks, DispatchIdentity } from "../shared/conversation/dispatch-contract";
import { snapshotIdentity } from "./agent-launch";
import type { ContextMessageBinding } from "./context-message";
import { decodeContextMessageActivationPairing, type ContextMessageActivationPairing } from "./context-message-activation";
import { createContextMessageJournalPersistence } from "./context-message-journal";
import { createOwnedContextMessages, type OwnedContextMessagesDependencies } from "./context-message-owner";
import { synchronousDispatchHook } from "./dispatch-evidence";
import type { Session } from "./history";
import type { SubmissionMessageIntent } from "./owned-message-preparation";

type JournalPersistencePorts = Parameters<typeof createContextMessageJournalPersistence>[0];

/** Assembly for one already-installed dispatch. Ownership, metadata proofs and
 * journal reservations remain capabilities of the bridge's original owner and
 * writer; this binding creates no owner registry, write queue or retry authority. */
export type DispatchContextBindingPorts = Readonly<{
  identity: DispatchIdentity;
  session: Session;
  readIntent: () => SubmissionMessageIntent | undefined;
  originalHooks: DispatchEvidenceHooks;
  writer: JournalPersistencePorts["writer"];
  readEvents: JournalPersistencePorts["readEvents"];
  reserveObservation: JournalPersistencePorts["reserveObservation"];
  assertObservationCurrent: () => void;
  assertLaunchCurrent: () => void;
  assertAdmissionMetadata: () => void;
  assertOriginalMetadataAssociation: () => void;
  prepare: (
    request: Parameters<OwnedContextMessagesDependencies["prepare"]>[0],
    assertCurrent: () => void,
    publishSourceCheck: (check: () => void) => void,
  ) => ReturnType<OwnedContextMessagesDependencies["prepare"]>;
  contextBinding: (session: Session) => ContextMessageBinding;
  contextJournalSource: () => string;
  stageActivationPairing: (pairing: ContextMessageActivationPairing) => void;
  evidenceFailed: (error: unknown) => void;
  messageFailed: (error: unknown) => void;
}>;

export function createDispatchContextBinding(ports: DispatchContextBindingPorts) {
  let sourceCheck = () => {};
  const persistMessage = createContextMessageJournalPersistence({ writer: ports.writer, readIdentity: () => ports.identity,
    readEvents: ports.readEvents, assertCurrent: ports.assertObservationCurrent,
    assertMetadataCommitted: (_submission, observation) => {
      if (observation.stage === "before-native") return ports.assertAdmissionMetadata();
      ports.assertOriginalMetadataAssociation();
    },
    reserveObservation: ports.reserveObservation, failClosed: ports.evidenceFailed });
  const messages = createOwnedContextMessages({ readIdentity: () => ports.identity, originalHooks: ports.originalHooks,
    prepare: (request, adapterGuard) => ports.prepare(request,
      () => { ports.assertLaunchCurrent(); adapterGuard(); }, check => { sourceCheck = check; }),
    assertObservationCurrent: ports.assertObservationCurrent,
    assertBeforeNative: () => { ports.assertLaunchCurrent(); sourceCheck(); }, persist: persistMessage,
    onBound: (submission, message, request) => {
      ports.assertObservationCurrent(); sourceCheck();
      if (request.liveInput || message.placement.kind !== "bootstrap") return;
      const intent = ports.readIntent(), identity = snapshotIdentity(ports.session);
      if (!intent || intent.kind === "selected" || !identity || !ports.session.saneExecution || !ports.session.saneContext?.package) throw new Error("Bootstrap has no independently selected activation authority");
      synchronousDispatchHook(intent.assertCurrent);
      ports.stageActivationPairing(decodeContextMessageActivationPairing({ schema: 1, type: "context-message-activation-pairing",
        dispatch: ports.identity, binding: ports.contextBinding(ports.session), identity, context: ports.session.saneContext.package, execution: ports.session.saneExecution,
        messageId: submission.messageId, transportSha256: message.transport.sha256, intent: intent.kind, source: ports.contextJournalSource() }));
    }, failClosed: ports.messageFailed });
  return { ...messages, assertSourceCurrent: () => sourceCheck() };
}
