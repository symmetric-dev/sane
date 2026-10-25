import type { StoredSaneAgentIdentity } from "sane-core/agent-catalog";
import type { DispatchIdentity } from "../../packages/sane-app/shared/conversation/dispatch-contract";
import type { CanonicalActivation } from "../../packages/sane-app/src/canonical-activation-validation";
import type { ContextMessage } from "../../packages/sane-app/src/context-message";
import type { ContextMessageDispatchObservation, ContextMessageEvidenceSnapshot, ContextMessageRestartFact, ContextMessageRestartProjection, ContextMessageSubmission } from "../../packages/sane-app/src/context-message-evidence";
import type { Event, Run } from "../../packages/sane-app/src/history";

/** Experiment-only contracts. Nothing here is imported by the running App. */
export type DemoJournalOwner = Readonly<{
  schema: 1;
  type: "mock-context-demo-owner";
  run: Run;
  dispatch: DispatchIdentity;
  messageId: string;
  agent: StoredSaneAgentIdentity;
  activation: CanonicalActivation;
}>;
export type DemoJournal = Readonly<{
  directory: string;
  owner: DemoJournalOwner;
  append: (kind: Event["kind"], data: unknown) => Event;
  persist: (submission: ContextMessageSubmission, observation: ContextMessageDispatchObservation) => void;
  /** Marks coverage partial. It must never upgrade a failed write to complete. */
  fail: (reason: string) => void;
  /** Close and publish an integrity-bound coverage checkpoint, not admission. */
  seal: () => void;
}>;
export type DemoJournalRead = Readonly<{
  owner: DemoJournalOwner | null;
  snapshot: ContextMessageEvidenceSnapshot;
  issues: readonly string[];
}>;
export type DemoCheck = Readonly<{ name: string; passed: boolean; detail: string }>;
export type DemoScenarioId = "activation" | "ordinary" | "update" | "stale-source" | "owner-refusal" | "persistence-failure" | "attempt-unresolved";
export type DemoScenarioResult = Readonly<{
  id: DemoScenarioId;
  title: string;
  journalDirectory: string;
  identity: DispatchIdentity;
  messageId: string;
  expectedFact: ContextMessageRestartFact;
  expectedMockSends: number;
  mockSends: number;
  contextLoads: number;
  executionLoads: number;
  pairingChecks: number;
  trace: readonly string[];
  checks: readonly DemoCheck[];
  error?: string;
}>;
export type DemoRunResult = Readonly<{
  schema: 1;
  type: "mock-context-demo-run";
  simulation: true;
  root: string;
  checkout: string;
  scenarios: readonly DemoScenarioResult[];
  replayVariants?: readonly Readonly<{
    id: "torn" | "missing";
    directory: string;
    identity: DispatchIdentity;
    messageId: string;
    expectedFact: "unknown";
  }>[];
}>;
export type DemoReplayScenario = Readonly<{
  scenario: DemoScenarioResult;
  projection: ContextMessageRestartProjection;
  message: ContextMessage | null;
  issues: readonly string[];
  checks: readonly DemoCheck[];
}>;
export type DemoReplayResult = Readonly<{
  schema: 1;
  type: "mock-context-demo-replay";
  simulation: true;
  root: string;
  scenarios: readonly DemoReplayScenario[];
  variants: readonly Readonly<{
    id: "torn" | "missing";
    directory: string;
    projection: ContextMessageRestartProjection;
    checks: readonly DemoCheck[];
  }>[];
  passed: boolean;
}>;
