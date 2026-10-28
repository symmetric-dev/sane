import { isDeepStrictEqual } from "node:util";
import { composeContextMessage, type ContextMessage, type ContextMessageInput } from "./context-message";

/** Shared guarded preparation. No transport, journal writer, queue, or activation
 * registry lives here. Callers choose placement from lifecycle intent, NEVER
 * from resume/process/revision changes or serialized composition metadata. */
export type ContextMessageGuards = Readonly<{
  assertOwnership: () => void | Promise<void>;
  assertSource: () => void | Promise<void>;
  assertNotCancelled: () => void | Promise<void>;
}>;
export type OrdinaryContextMessageInput = Extract<ContextMessageInput, { placement: { kind: "body-only" } }>;
export type SelectedContextMessageInput = Exclude<ContextMessageInput, OrdinaryContextMessageInput>;

export type ContextMessagePreparation = Readonly<{ guards: ContextMessageGuards }> & (
  | Readonly<{
    kind: "ordinary";
    /** Current authored body, binding and placement only. Lifecycle admission and
     * native execution policy belong to their owners, not this composer. */
    readCurrentOrdinary: () => OrdinaryContextMessageInput | Promise<OrdinaryContextMessageInput>;
  }>
  | Readonly<{
    kind: "context";
    /** Retained owner-owned selection/source check. Package loading and activation
     * validation happen once at explicit selection, not during every assertion. */
    assertSelectionCurrent: () => void | Promise<void>;
  }>
);

export async function assertContextMessageGuards(guards: ContextMessageGuards): Promise<void> {
  await guards.assertOwnership();
  await guards.assertSource();
  await guards.assertNotCancelled();
}

async function guarded<T>(guards: ContextMessageGuards, read: () => T | Promise<T>): Promise<T> {
  await assertContextMessageGuards(guards);
  const value = await read();
  await assertContextMessageGuards(guards);
  return value;
}

/** Compose trusted, already validated inputs once. This is not submission proof:
 * the owner still checks current dispatch authority at each native boundary. */
export async function prepareContextMessage(input: ContextMessageInput, preparation: ContextMessagePreparation): Promise<ContextMessage> {
  const trusted = structuredClone(input);
  await assertContextMessageGuards(preparation.guards);
  const message = composeContextMessage(trusted);
  return assertContextMessageCurrent(message, preparation);
}

/** Freshness check for an already composed immutable message, not an untrusted
 * message decoder. External readers and actual-submission binding retain their
 * byte validation. This API cannot load packages, reconstruct activation history
 * or validate native execution policy. It grants no queue lease or bootstrap. */
export async function assertContextMessageCurrent(message: ContextMessage, preparation: ContextMessagePreparation): Promise<ContextMessage> {
  const { guards } = preparation;
  await assertContextMessageGuards(guards);
  if ((message.placement.kind === "body-only") !== (preparation.kind === "ordinary")) throw new Error("Context message preparation path differs from explicit placement");
  if (preparation.kind === "ordinary") {
    const current = await guarded(guards, async () => structuredClone(await preparation.readCurrentOrdinary()));
    if (current.placement.kind !== "body-only" || current.body !== message.body.text || current.origin !== message.origin
      || !isDeepStrictEqual(current.binding, message.binding) || !isDeepStrictEqual(current.placement, message.placement)) throw new Error("Context message differs from current authored input or binding");
  } else {
    await guarded(guards, preparation.assertSelectionCurrent);
  }
  await assertContextMessageGuards(guards);
  return message;
}
