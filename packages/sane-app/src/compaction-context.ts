import { standingFrameworkNames } from "sane-core/sane-framework";
import { composeContextMessage, decodeContextMessage, type ContextMessage, type ContextMessageBinding,
  type ContextMessageFragment, type ContextMessageSelection, type PinnedMessageContext } from "./context-message";
import { compactionRestorationParts } from "../shared/compaction-context-contract";

/** A restoration is NOT another activation or evidence that the old native
 * prefix survived. The owning App validates the original context/execution pair
 * before configuring this bounded, user-channel payload on its native runtime. */
export type CompactionContext = Readonly<{
  schema: 1;
  executionRevision: string;
  message: ContextMessage;
  parts: readonly string[];
}>;
export type PreparedCompactionContext = Readonly<{ context: CompactionContext; assertCurrent: () => void }>;
export type CompactionContextProvider = (sessionId: string, assertCurrent: () => void) => Promise<PreparedCompactionContext | null>;

export function composeCompactionContext(input: {
  binding: ContextMessageBinding;
  executionRevision: string;
  context: PinnedMessageContext;
  session: ContextMessageFragment;
  worker?: { assignment: ContextMessageFragment; free: boolean; protocol?: readonly ContextMessageSelection[] };
}): CompactionContext {
  const { identity } = input.context.bundle;
  const reason = "Restore pinned standing context after native compaction without restarting the lifecycle";
  const selections: ContextMessageSelection[] = [
    { kind: "asset", assetId: `role.${identity.kind}.${identity.role}`, reason },
    ...standingFrameworkNames(identity).map(name => ({ kind: "asset" as const, assetId: `framework.${name}`, reason })),
  ];
  if (input.context.bundle.assets.some(asset => asset.kind === "resource" || asset.kind === "procedure" && !asset.id.startsWith("worker-procedure.")))
    selections.push({ kind: "procedure-index", reason });
  if (identity.kind === "worker") {
    if (!input.worker) throw new Error("Worker restoration requires its original structured assignment");
    if (!input.worker.free) selections.push({ kind: "asset", assetId: `worker-procedure.${identity.role}`, reason });
    selections.push({ kind: "fragment", fragment: input.worker.assignment }, ...(input.worker.protocol ?? []));
  } else if (input.worker) throw new Error("Assistant restoration cannot select a worker assignment");
  selections.push({ kind: "fragment", fragment: input.session });
  const message = composeContextMessage({ body: "", binding: input.binding, origin: "context-update",
    placement: { kind: "selected", purpose: "compaction-restore" }, context: input.context, selections });
  return decodeCompactionContext({ schema: 1, executionRevision: input.executionRevision, message,
    parts: compactionRestorationParts(message.transport.text, message.transport.sha256) });
}

/** Structural transport validation only; this does not authorize activation,
 * migration, a foreign native binding, or a context/execution pair. */
export function decodeCompactionContext(value: unknown): CompactionContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid compaction context");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== 4 || item.schema !== 1 || typeof item.executionRevision !== "string"
    || !/^[a-f0-9]{64}$/.test(item.executionRevision)) throw new Error("Invalid compaction context pins");
  const message = decodeContextMessage(item.message);
  if (message.placement.kind !== "selected" || message.placement.purpose !== "compaction-restore"
    || message.origin !== "context-update" || message.body.text !== "" || !message.packageRevision
    || message.segments[0]?.category !== "role" || message.segments.filter(segment => segment.category === "role").length !== 1
    || !message.segments.some(segment => segment.id === "framework.core")
    || message.segments.at(-1)?.id !== "session"
    || message.segments.some(segment => segment.id.startsWith("sane-assistant-") && segment.id.endsWith("-pickup")))
    throw new Error("Compaction context must restore standing instructions, not initial Pickup or an authored task");
  const parts = compactionRestorationParts(message.transport.text, message.transport.sha256);
  if (JSON.stringify(item.parts) !== JSON.stringify(parts)) throw new Error("Compaction restoration parts differ from their exact composed bytes");
  return Object.freeze({ schema: 1, executionRevision: item.executionRevision, message, parts });
}
