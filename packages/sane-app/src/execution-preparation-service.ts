import { mkdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isStoredAssistantAgentId, isWorkerAgentId, type AssistantAgentId } from "sane-core/agent-catalog";
import { saneSessionContext } from "./agent-launch";
import { atomicAppRecord, type Admission } from "./app-store";
import { validateCanonicalExecution } from "./canonical-activation-validation";
import type { CanonicalExecutionRef, CanonicalExecutionSnapshot, CanonicalExecutionStore } from "./canonical-execution-store";
import type { ContextPackageStore } from "./context-package-store";
import { uuid, type Session } from "./history";
import { createCanonicalActivation, reserveActivation, validateCanonicalActivation, type ActivationSnapshot } from "./user-input-preparation";
import type { ExecutionContext } from "./workstreams";

export type ExecutionPreparationDependencies = {
  dataDir: string;
  executionPackages: Pick<CanonicalExecutionStore, "create" | "load">;
  contextPackages: Pick<ContextPackageStore, "create" | "load">;
  getSession: (sessionId: string) => Session | undefined;
  getAdmission: (sessionId: string) => Admission | undefined;
  executionContext: (sessionId: string) => Promise<ExecutionContext>;
};

/** Uses the caller's existing stores and admission authority; owns no execution lifecycle. */
export function createExecutionPreparationService({ dataDir, executionPackages, contextPackages, getSession, getAdmission, executionContext }: ExecutionPreparationDependencies) {
  const activationStores = { execution: executionPackages, context: contextPackages };
  const executionReservation = async (sessionId: string, identity: NonNullable<Parameters<typeof saneSessionContext>[0]>, create?: () => Promise<ActivationSnapshot>) => {
    if (!uuid(sessionId)) throw new Error("Invalid execution reservation identity");
    const directory = join(dataDir, "activations", sessionId), name = "activation.json";
    return reserveActivation(identity, {
      read: async () => {
        let text: string;
        try { text = await readFile(join(directory, name), "utf8"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
        return JSON.parse(text);
      },
      write: async record => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        if (await realpath(directory) !== resolve(directory)) throw new Error("Activation reservation directory cannot contain symbolic links");
        atomicAppRecord(directory, name, record);
      },
      create,
      validate: async pair => {
        if (pair.saneExecution) {
          if (!pair.saneContext) throw new Error("Reserved execution requires its pinned context");
          await validateCanonicalActivation({ saneExecution: pair.saneExecution, saneContext: pair.saneContext }, identity, activationStores);
        } else if (pair.saneContext?.package) throw new Error("Unpaired canonical context reservation requires reconciliation");
      },
    });
  };
  const prepareCanonicalExecution = async (role: AssistantAgentId) => {
    const pair = await createCanonicalActivation({ kind: "assistant", role }, activationStores);
    const { policy } = await executionPackages.load(pair.saneExecution);
    return { ...pair, ...(policy.model ? { model: `${policy.model.providerID}/${policy.model.id}`, effort: policy.model.variant } : {}) };
  };
  const canonicalExecution = async (sessionId: string): Promise<CanonicalExecutionSnapshot | null> => {
    const session = getSession(sessionId);
    if (!session?.saneExecution) return null;
    // Titles are independently editable while execution is being prepared.
    const executionPin = (value: Session) => JSON.stringify({ ...value, title: undefined, titleSource: undefined, titleRevision: undefined, titleAutoEligible: undefined, titleGeneration: undefined });
    const pin = executionPin(session);
    const assertBinding = () => {
      const current = getSession(sessionId), a = getAdmission(sessionId);
      if (!current || executionPin(current) !== pin || !a || a.state !== "ready" || a.nativeId !== session.nativeSessionId || a.source.authorityId !== session.authorityId || a.binding.executionCheckout !== session.cwd || a.source.descriptor.harness !== (session.harness === "opencode" ? "oc" : "cc")) throw new Error("Canonical execution requires an exact ready admission");
    };
    assertBinding();
    if (!session.saneContext) throw new Error("Canonical execution requires paired context");
    const identity = session.agentKind === "worker" && isWorkerAgentId(session.agent) ? { kind: "worker" as const, role: session.agent } : isStoredAssistantAgentId(session.agent) ? { kind: "assistant" as const, role: session.agent } : undefined;
    if (!identity) throw new Error("Canonical execution requires a valid identity");
    const snapshot = await validateCanonicalExecution(session.saneExecution, identity, executionPackages);
    if (snapshot.policy.spec.name !== `sane/${session.agentKind}/${session.agent}`) throw new Error("Execution policy role differs from its conversation");
    await executionContext(sessionId);
    assertBinding();
    return snapshot;
  };
  const prepareSaneContext = async (...args: Parameters<typeof saneSessionContext>) => {
    const result: ReturnType<typeof saneSessionContext> & { saneExecution?: CanonicalExecutionRef } = saneSessionContext(...args);
    if (result.saneContext && args[0] && args[0].role !== "knowledge") {
      return createCanonicalActivation(args[0], activationStores);
    }
    return result;
  };
  return { executionReservation, prepareCanonicalExecution, canonicalExecution, prepareSaneContext };
}
