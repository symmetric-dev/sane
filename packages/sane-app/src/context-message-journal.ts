import { isDeepStrictEqual } from "node:util";
import type { DispatchIdentity } from "../shared/conversation/dispatch-contract";
import { decodeContextMessageDispatchObservation, decodeContextMessageSubmission, type ContextMessageDispatchObservation, type ContextMessageSubmission } from "./context-message-evidence";
import { synchronousDispatchHook } from "./dispatch-evidence";
import type { Event } from "./history";
import type { RunJournalReservation, RunJournalWriter } from "./run-journal";

/** Inactive adapter for the bridge's SAME run writer. No native registration,
 * activation ledger, placement inference, transport, repair, or retry lives here.
 *
 * The native adapter must first reserve its actual standard submission INCLUDING
 * composition metadata through the ordinary bridge emit path. This adapter only
 * verifies that record and appends correlated observations: prompt text is never
 * stored again. Bare old-format submissions cannot be retrofitted into evidence.
 *
 * assertMetadataCommitted is a mandatory independent owner capability. Draining
 * journal reservations cannot flush the bridge's asynchronous metadata queue.
 * Pending-activation reuse and original native-byte reads must be established
 * before wiring this into decorateContextMessageEvidence at an actual boundary. */
export function createContextMessageJournalPersistence(deps: Readonly<{
  writer: RunJournalWriter;
  readIdentity: () => DispatchIdentity;
  readEvents: () => readonly Event[];
  assertCurrent: () => void;
  assertMetadataCommitted: () => void;
  reserveObservation: (observation: ContextMessageDispatchObservation) => RunJournalReservation;
  failClosed: (error: unknown) => void;
}>): (submission: ContextMessageSubmission, observation: ContextMessageDispatchObservation) => void {
  return (supplied, fact) => {
    try {
      synchronousDispatchHook(() => deps.assertCurrent());
      synchronousDispatchHook(() => deps.assertMetadataCommitted());
      const submission = decodeContextMessageSubmission(supplied), observation = decodeContextMessageDispatchObservation(fact);
      let current: DispatchIdentity | undefined;
      synchronousDispatchHook(() => { current = deps.readIdentity(); return current; });
      const expected = submission.composition.dispatch;
      const { submission: _submission, nativeAcceptance: _acceptance, ...observed } = observation.evidence;
      if (!isDeepStrictEqual(current, expected) || !isDeepStrictEqual(observed, expected)
        || observation.messageId !== submission.messageId || observation.transportSha256 !== submission.composition.transport.sha256
        || submission.liveInput === true && observation.boundary !== "message") throw new Error("Context journal observation differs from original message/owner");
      let events: readonly Event[] | undefined;
      synchronousDispatchHook(() => { events = deps.readEvents(); return events; });
      if (!events) throw new Error("Context journal events unavailable");
      const matches = events.filter(event => event.kind === "submission" && !!event.data && typeof event.data === "object"
        && (event.data as { messageId?: unknown }).messageId === submission.messageId);
      const standard = matches[0];
      if (matches.length !== 1 || !standard || standard.runId !== expected.runId || standard.sessionId !== expected.source.sessionId
        || !isDeepStrictEqual(decodeContextMessageSubmission(standard.data), submission)) throw new Error("Context journal requires its one actual composed standard submission");
      // Historical/copy-equivalent records are not live writer capabilities.
      deps.writer.reservation(standard);
      const prior = events.filter(event => event.kind === "context" && !!event.data && typeof event.data === "object"
        && (event.data as { type?: unknown }).type === "context-message-dispatch"
        && (event.data as { messageId?: unknown }).messageId === submission.messageId);
      for (const event of prior) {
        deps.writer.reservation(event);
        const decoded = decodeContextMessageDispatchObservation(event.data);
        const { submission: _s, nativeAcceptance: _n, ...identity } = decoded.evidence;
        if (event.runId !== expected.runId || event.sessionId !== expected.source.sessionId || event.seq <= standard.seq
          || !isDeepStrictEqual(identity, expected) || decoded.transportSha256 !== observation.transportSha256 || decoded.boundary !== observation.boundary) throw new Error("Context journal contains foreign message observations");
      }
      if (observation.stage === "outcome" && observation.evidence.submission !== "not-submitted"
        && !prior.some(event => (event.data as ContextMessageDispatchObservation).stage === "before-native")) throw new Error("Context journal outcome lacks its original attempt");
      const duplicate = prior.find(event => isDeepStrictEqual(event.data, observation));
      let reservation: RunJournalReservation | undefined;
      if (duplicate) reservation = deps.writer.reservation(duplicate);
      else synchronousDispatchHook(() => { reservation = deps.reserveObservation(observation); return reservation; });
      if (!reservation || reservation.event.kind !== "context" || reservation.event.runId !== expected.runId
        || reservation.event.sessionId !== expected.source.sessionId || reservation.event.seq <= standard.seq
        || !isDeepStrictEqual(reservation.event.data, observation)) throw new Error("Context journal reserved a different observation");
      synchronousDispatchHook(() => deps.assertCurrent());
      synchronousDispatchHook(() => deps.assertMetadataCommitted());
      deps.writer.flushThrough(reservation);
      synchronousDispatchHook(() => deps.assertCurrent());
    } catch (error) {
      try { synchronousDispatchHook(() => deps.failClosed(error)); } finally { throw error; }
    }
  };
}
