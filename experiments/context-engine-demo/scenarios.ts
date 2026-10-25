import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { validateCanonicalActivation } from "../../packages/sane-app/src/canonical-activation-validation";
import type { CanonicalExecutionSnapshot } from "../../packages/sane-app/src/canonical-execution-store";
import { contextMessageBody, type ContextMessage, type ContextMessageBinding, type ContextMessageFragment, type ContextMessageInput } from "../../packages/sane-app/src/context-message";
import { assertContextMessageCurrent, canonicalContextMessageExecutionValidator, prepareContextMessage, type ContextMessageGuards, type ContextMessagePreparation, type SelectedContextMessageInput } from "../../packages/sane-app/src/context-message-engine";
import { decorateContextMessageEvidence, projectContextMessageRestart, recordContextMessageSubmission } from "../../packages/sane-app/src/context-message-evidence";
import { DispatchPreNativeRefusal } from "../../packages/sane-app/src/dispatch-evidence";
import { HarnessDispatchRegistry, sameDispatchSource, terminalDispatchReadiness } from "../../packages/sane-app/src/harness-dispatch";
import type { DispatchEvidenceHooks, DispatchIdentity } from "../../packages/sane-app/shared/conversation/dispatch-contract";
import type { Run } from "../../packages/sane-app/src/history";
import type { RunOwner } from "../../packages/sane-app/src/run-owner";
import type { DemoCheck, DemoRunResult, DemoScenarioId, DemoScenarioResult } from "./contract";
import type { DemoFixture } from "./fixture";
import { createDemoJournal, readDemoJournal } from "./journal";

const ids: readonly DemoScenarioId[] = ["activation", "ordinary", "update", "stale-source", "owner-refusal", "persistence-failure", "attempt-unresolved"];
const titles: Record<DemoScenarioId, string> = {
  activation: "Activation bootstrap / simulated harness acceptance",
  ordinary: "Ordinary continuation / exact authored bytes",
  update: "Explicit fixture Session root A → B update",
  "stale-source": "Source drift across a controlled await / preparation rejection",
  "owner-refusal": "Original synchronous owner pause / certified withholding",
  "persistence-failure": "Uncertified refusal-class persistence fault / fail closed",
  "attempt-unresolved": "One simulated effect / deliberately unknown outcome (not a process kill)",
};
const body = "\uFEFF  Fixture-authored body 😀\r\n[SANE CONTEXT MESSAGE v1]\n[/SANE CONTEXT SEGMENT]\n# Session\nThese are literal authored markers, not metadata.\n";
function same(a: unknown, b: unknown): boolean {
  const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(",")}]`
    : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`
      : JSON.stringify(value) ?? "undefined";
  return stable(a) === stable(b);
}
function requireFact(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error(reason); }
function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return `${error.name}: ${error.message}${error.cause ? `; cause: ${errorText(error.cause)}` : ""}`;
}
function session(fixture: DemoFixture, root: "A" | "B"): ContextMessageFragment {
  return { id: "session", category: "session", text: `# Session\nSynthetic experiment-owned session only.\nroot: ${join(fixture.checkout, "roots", root)}\nNo App project or workstream records exist.`,
    source: `fixture:${fixture.root}/synthetic-session`, revision: `fixture-root-${root}`, reason: root === "A" ? "Explicit synthetic activation state" : "Explicit synthetic root selection changed A → B" };
}
type AcceptedBootstrap = Readonly<{ directory: string; identity: DispatchIdentity; messageId: string; transportSha256: string }>;
type PendingSubmission = Readonly<{ identity: DispatchIdentity; messageId: string; text: string }>;

/** Single owner holder per scenario; the real registry owns all dispatch/evidence
 * transitions. The adapter simulates only pending submission and recipient result. */
export async function runDemoScenarios(fixture: DemoFixture): Promise<DemoRunResult> {
  const scenarios: DemoScenarioResult[] = [];
  const sharedBinding: ContextMessageBinding = { harnessId: "mock-context-demo", sessionId: randomUUID(), authorityId: `fixture-authority-${randomUUID()}`,
    nativeSessionId: `fixture-native-${randomUUID()}`, cwd: fixture.checkout };
  let bootstrap: AcceptedBootstrap | undefined;

  for (const id of ids) {
    const trace: string[] = [], checks: DemoCheck[] = [];
    let contextLoads = 0, executionLoads = 0, pairingChecks = 0, mockSends = 0;
    let pinnedExecution: CanonicalExecutionSnapshot | undefined;
    const loadContext = fixture.context.load.bind(fixture.context), loadExecution = fixture.execution.load.bind(fixture.execution);
    // Instrument the real methods, not predicted counts: paired validation and
    // nested callbacks call these same wrappers too. Restored even on failure.
    fixture.context.load = async ref => { contextLoads++; trace.push("load:context"); return loadContext(ref); };
    fixture.execution.load = async ref => { executionLoads++; trace.push("load:execution"); pinnedExecution = await loadExecution(ref); return pinnedExecution; };
    try {
      const source = ["activation", "ordinary", "update"].includes(id) ? { ...sharedBinding } : { ...sharedBinding, sessionId: randomUUID(), nativeSessionId: `fixture-native-${randomUUID()}` };
      let liveSource = { ...source };
      const runId = randomUUID(), messageId = `fixture-message-${randomUUID()}`;
      const identity: DispatchIdentity = { source, runId, nativeCommandId: messageId };
      const run: Run = { runId, sessionId: source.sessionId, cwd: fixture.checkout, createdAt: new Date().toISOString(), status: "running", operation: "prompt",
        nativeCommandId: messageId, agent: fixture.agent.role, agentKind: fixture.agent.kind, saneExecution: { ...fixture.activation.saneExecution }, saneContextVersion: fixture.activation.saneContext.version };
      const journalDirectory = join(fixture.root, "journals", id);
      const journal = createDemoJournal(journalDirectory, { schema: 1, type: "mock-context-demo-owner", run, dispatch: identity, messageId,
        agent: fixture.agent, activation: fixture.activation });
      const owners = new Map<string, RunOwner>();
      let installed: RunOwner | undefined, storageFailed = false, terminated = false, preparationRejected = false, caught: string | undefined;
      let pending: PendingSubmission | undefined;
      const failClosed = (error: unknown) => {
        storageFailed = true;
        caught ??= errorText(error);
        trace.push(`failClosed:${errorText(error)}`);
        journal.fail(errorText(error));
      };
      const syncGate = () => {
        trace.push("gate:sync-source-ownership-cancel");
        requireFact(sameDispatchSource(source, liveSource), "Fixture source changed during controlled await");
        if (installed) {
          requireFact(owners.get(source.sessionId) === installed, "Fixture owner changed");
          requireFact(!installed.cancelling && !installed.stopRequested && !installed.stopping, "Fixture owner cancelled");
        }
        requireFact(!storageFailed, "Fixture storage failure is sticky");
      };
      const guards: ContextMessageGuards = {
        assertOwnership: () => { if (installed) requireFact(owners.get(source.sessionId) === installed, "Fixture owner changed"); },
        assertSource: () => requireFact(sameDispatchSource(source, liveSource), "Fixture source changed during controlled await"),
        assertNotCancelled: () => { if (installed) requireFact(!installed.cancelling && !installed.stopRequested, "Fixture owner cancelled"); },
      };
      const assertPairing = () => {
        pairingChecks++; trace.push("pairing:read-same-owner-journal");
        requireFact(bootstrap, "No accepted bootstrap journal available");
        const durable = readDemoJournal(bootstrap.directory);
        requireFact(durable.owner, "Bootstrap owner metadata unavailable");
        const projection = projectContextMessageRestart({ identity: bootstrap.identity, messageId: bootstrap.messageId }, durable.snapshot);
        requireFact(projection.fact === "accepted" && projection.composition?.transport.sha256 === bootstrap.transportSha256, "Bootstrap exact accepted evidence unavailable");
        requireFact(same(durable.owner.dispatch.source, source) && same(durable.owner.agent, fixture.agent)
          && same(durable.owner.activation, fixture.activation), "Durable bootstrap source/role/context/execution pins differ");
        const paired = durable.snapshot.events.find(event => event.kind === "context" && (event.data as { type?: string })?.type === "demo-activation-pairing");
        const value = paired?.data as { source?: unknown; agent?: unknown; activation?: unknown; accepted?: unknown } | undefined;
        requireFact(value && same(value.source, source) && same(value.agent, fixture.agent) && same(value.activation, fixture.activation)
          && same(value.accepted, bootstrap), "Exact owner-journal activation pairing association unavailable");
        syncGate();
      };
      const fullPair = async () => {
        pairingChecks++; trace.push("pairing:real-full-validator");
        return validateCanonicalActivation(fixture.activation, fixture.agent, fixture, { assertCurrent: syncGate });
      };
      const readSelected = async (): Promise<SelectedContextMessageInput> => id === "update"
        ? { body, binding: { ...liveSource }, origin: "context-update", placement: { kind: "selected", purpose: "update" }, selections: [{ kind: "fragment", fragment: session(fixture, "B") }] }
        : { body, binding: { ...liveSource }, origin: "activation", placement: { kind: "bootstrap" }, context: await fixture.context.load(fixture.activation.saneContext.package!), session: session(fixture, "A") };
      const preparation: ContextMessagePreparation = id === "ordinary" ? {
        kind: "ordinary", guards,
        readCurrentOrdinary: () => ({ body, binding: { ...liveSource }, origin: "user", placement: { kind: "body-only" } }),
        policy: { kind: "sane", assertDurableActivationPairing: assertPairing,
          validateExecution: canonicalContextMessageExecutionValidator({ execution: fixture.execution,
            readTrustedExecution: () => ({ ref: { ...fixture.activation.saneExecution }, identity: { ...fixture.agent } }) }) },
      } : {
        kind: "context", guards, readCurrentContext: readSelected,
        validateSelectedContext: async () => { await fullPair(); if (id === "update") assertPairing(); },
      };
      const input: ContextMessageInput = id === "ordinary"
        ? { body, binding: source, origin: "user", placement: { kind: "body-only" } } : await readSelected();
      trace.push("prepare:start");
      const message = await prepareContextMessage(input, preparation);
      trace.push("prepare:complete");
      // This is a prepared comparison candidate. The evidence reader below must
      // still bind it to independently captured adapter-owned pending bytes.
      const submission = recordContextMessageSubmission(message, { messageId, text: message.transport.text }, identity);
      requireFact(pinnedExecution, "Preparation did not load the real execution policy");
      journal.append("context", { schema: 1, type: "demo-owner-pinned-execution", source, agent: fixture.agent, activation: fixture.activation,
        execution: pinnedExecution, installedIntoNativeHarness: false });
      journal.append("context", { schema: 1, type: "demo-lifecycle-intent", placement: input.placement, simulation: true,
        readiness: "mocked", settlement: "mocked", sourceRoot: fixture.sourceRoot,
        ...(id === "ordinary" || id === "update" ? { pairingReference: bootstrap } : {}) });

      const originalHooks: DispatchEvidenceHooks = {
        beforeNative: attempt => {
          trace.push("original:beforeNative");
          syncGate();
          if (id === "owner-refusal") {
            journal.append("hook", { schema: 1, type: "demo-owner-pause", reason: "Fixture owner synchronously paused before intent mutation", identity });
            trace.push("original:pause-durable");
            const refusal = new DispatchPreNativeRefusal(new Error("Fixture owner paused before native intent"));
            caught = errorText(refusal); trace.push(`original:certified-refusal:${caught}`);
            throw refusal;
          }
          journal.append("hook", { schema: 1, type: "demo-owner-intent", evidence: attempt });
          trace.push("original:intent-durable");
        },
        outcome: evidence => { journal.append("hook", { schema: 1, type: "demo-owner-outcome", evidence }); trace.push(`original:outcome:${evidence.submission}`); },
      };
      const decorated = decorateContextMessageEvidence({ submission, boundary: "message", hooks: originalHooks,
        readActualSubmission: () => { trace.push("adapter:read-actual-pending"); requireFact(pending, "Mock adapter has no pending submission"); return pending; },
        persist: (actual, observation) => {
          if (id === "persistence-failure" && observation.stage === "before-native") {
            trace.push("persist:injected-refusal-class-fault");
            throw new DispatchPreNativeRefusal(new Error("Injected decorator persistence failure, NOT an owner refusal"));
          }
          journal.persist(actual, observation); trace.push(`persist:${observation.stage}:${observation.evidence.submission}`);
        }, failClosed });
      const registry = new HarnessDispatchRegistry();
      registry.register({ id: "mock-context-demo", automation: {},
        readiness: async bound => { trace.push("readiness:mocked"); return { source: bound, readiness: { ready: true } }; },
        successfulSettlement: async (_owner, _source, terminal) => { trace.push("settlement:mocked"); return terminalDispatchReadiness(terminal()); },
        execute: async (owner, prompt, _resume, ready) => {
          // Deliberately capture from the actual adapter argument and owner. This
          // is not a reader closure returning `submission` or composition bytes.
          pending = { identity: { source: { ...liveSource }, runId: owner.run.runId, nativeCommandId: owner.run.nativeCommandId ?? null },
            messageId: owner.run.nativeCommandId!, text: prompt };
          trace.push("adapter:pending-captured");
          trace.push("adapter:controlled-await");
          await Promise.resolve();
          if (id === "stale-source") { liveSource = { ...liveSource, nativeSessionId: `fixture-drift-${randomUUID()}` }; trace.push("source:drifted"); }
          try {
            trace.push("revalidate:after-await");
            await assertContextMessageCurrent(message, preparation);
          } catch (error) {
            if (id !== "stale-source") throw error;
            caught = errorText(error); preparationRejected = true;
            journal.append("context", { schema: 1, type: "demo-preparation-rejection", reason: caught, certification: "none", identity });
            trace.push("preparation:rejection-durable");
            owner.run.status = "failed"; ready(false); return;
          }
          // No await between this boundary (original synchronous gate + fsync)
          // and the sole scripted recipient effect.
          owner.dispatchEvidence!.beforeNative();
          mockSends++; trace.push("mock:effect");
          journal.append("hook", { schema: 1, type: "demo-mock-send", messageId: pending.messageId, simulation: true });
          ready(true);
          if (id === "attempt-unresolved") {
            owner.dispatchEvidence!.outcome("unknown"); trace.push("mock:outcome-unknown-not-process-kill"); owner.run.status = "failed";
          } else {
            owner.dispatchEvidence!.outcome("submitted", "accepted"); trace.push("mock:simulated-acceptance"); owner.run.status = "completed";
          }
        },
      });
      await registry.readiness(source, "user");
      const lifecycle = registry.start({ source, origin: "user", prompt: message.transport.text, resume: id === "ordinary" || id === "update" }, {
        // A preparation rejection is deliberately NOT a submitted composition or
        // certified withholding. Existing lifecycle unknown completion is logged
        // only as a raw owner hook; no per-message evidence is fabricated.
        evidence: id === "stale-source" ? { outcome: originalHooks.outcome } : decorated,
        install: done => {
          syncGate(); requireFact(!owners.has(source.sessionId), "Owner already installed");
          installed = { run, done, settled: false, beforeSend: syncGate };
          owners.set(source.sessionId, installed); trace.push("owner:installed-once");
          journal.append("launch", { schema: 1, type: "demo-owner-installed", runId });
          return installed;
        },
        owns: owner => owners.get(source.sessionId) === owner,
        settle: owner => { owner.settled = true; owner.run.endedAt = new Date().toISOString(); if (owner.run.status === "running") owner.run.status = "failed";
          journal.append("status", { status: owner.run.status, simulation: true }); trace.push("owner:settled"); },
        release: owner => { if (!storageFailed && owners.get(source.sessionId) === owner) { owners.delete(source.sessionId); trace.push("owner:released"); } else trace.push("owner:retained-failClosed"); },
        failClosed,
        terminate: async owner => { terminated = true; owner.run.status = "failed"; trace.push("lifecycle:terminate-mocked"); },
        guards: owner => ({ settled: owner.settled, released: !owners.has(source.sessionId), status: owner.run.status, cancelling: !!owner.cancelling,
          stopRequested: !!owner.stopRequested, stopping: !!owner.stopping, closing: false, storageFailed, reconciliationRequired: storageFailed }),
      });
      await lifecycle.done;
      const admission = await lifecycle.admission, settlement = await lifecycle.successfulSettlement();
      trace.push(`lifecycle:admission-${admission.state}`, `lifecycle:settlement-${settlement.ready ? "mocked-ready" : "denied"}`);
      if (id === "activation") {
        bootstrap = { directory: journalDirectory, identity, messageId, transportSha256: message.transport.sha256 };
        journal.append("context", { schema: 1, type: "demo-activation-pairing", source, agent: fixture.agent, activation: fixture.activation,
          accepted: bootstrap, execution: pinnedExecution, semantics: "Fixture owner association with simulated acceptance only; not native settings or model consumption" });
      }
      journal.seal();
      const durable = readDemoJournal(journalDirectory);
      const projected = projectContextMessageRestart({ identity, messageId }, durable.snapshot);
      const expectedFact = id === "stale-source" ? "no-evidence" : id === "owner-refusal" ? "withheld"
        : id === "persistence-failure" ? "unknown" : id === "attempt-unresolved" ? "attempt-unresolved" : "accepted";
      const expectedMockSends = ["stale-source", "owner-refusal", "persistence-failure"].includes(id) ? 0 : 1;
      const check = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });
      check("restart-fact", projected.fact === expectedFact, `${projected.fact}; expected ${expectedFact}; ${projected.reason}`);
      check("mock-send-count", mockSends === expectedMockSends, `${mockSends}; expected ${expectedMockSends}; simulated effects only`);
      check("authored-body-preserved", contextMessageBody(message) === body, "UTF-8 body including BOM/CRLF/emoji/SANE-looking markers is preserved");
      check("one-owner-installation", trace.filter(item => item === "owner:installed-once").length === 1, "Real registry.start installs exactly one fixture RunOwner");
      check("measured-load-calls", executionLoads > 0 && (id === "ordinary" ? contextLoads === 0 : contextLoads > 0), `Actual instrumented methods: context=${contextLoads}; execution=${executionLoads}; pairing=${pairingChecks}`);
      if (mockSends) check("durable-before-effect", trace.indexOf("original:intent-durable") < trace.indexOf("persist:before-native:attempted")
        && trace.indexOf("persist:before-native:attempted") < trace.indexOf("mock:effect"), "Original owner intent → synchronous composition persistence → single mock effect");
      if (id === "activation") checkBootstrap(message, check);
      if (id === "ordinary") {
        check("exact-body-only", message.transport.text === body && !message.segments.length && message.packageRevision === null, "No context prefix, role, framework, index, Pickup or Session selected");
        check("real-execution-and-durable-pairing", executionLoads > 0 && pairingChecks > 0 && contextLoads === 0, "Execution-only real validator plus accepted exact owner-journal source/role/context/execution pairing; zero context loads including callbacks");
      }
      if (id === "update") check("only-selected-session", message.segments.length === 1 && message.segments[0]?.category === "session"
        && message.segments[0]?.text === session(fixture, "B").text, "Only fixture Session root B; no role/framework/index/Pickup resend");
      if (id === "stale-source") check("uncertified-preparation-rejection", preparationRejected && !terminated && !storageFailed && projected.fact === "no-evidence", "Controlled await changed live source; rejection journaled, no local-refusal or freshness claim");
      if (id === "owner-refusal") check("genuine-owner-refusal-nonfatal", !storageFailed && !terminated && trace.includes("original:pause-durable")
        && trace.includes("persist:outcome:not-submitted"), "Original synchronous pause certifies refusal; registry finish durably records withholding, without termination");
      if (id === "persistence-failure") check("uncertified-refusal-fails-closed", storageFailed && terminated && durable.snapshot.coverage.state === "partial"
        && !!caught?.includes("Uncertified context message pre-native refusal") && trace.includes("original:intent-durable")
        && trace.includes("owner:retained-failClosed"), "Refusal-class decorator persistence fault is wrapped, sticky partial, terminated and owner retained; never certified as local pause");
      if (id === "attempt-unresolved") check("honest-unresolved-effect", mockSends === 1 && durable.snapshot.coverage.state === "complete" && projected.fact === "attempt-unresolved",
        "Explicit unknown outcome after one simulated effect; no process was killed, no exact acceptance and no retry");
      scenarios.push({ id, title: titles[id], journalDirectory, identity, messageId, expectedFact, expectedMockSends, mockSends,
        contextLoads, executionLoads, pairingChecks, trace, checks, ...(caught ? { error: caught } : {}) });
    } finally {
      fixture.context.load = loadContext;
      fixture.execution.load = loadExecution;
    }
  }
  return { schema: 1, type: "mock-context-demo-run", simulation: true, root: fixture.root, checkout: fixture.checkout, scenarios };
}

function checkBootstrap(message: ContextMessage, check: (name: string, passed: boolean, detail: string) => void) {
  check("bootstrap-required-segments", message.segments.filter(segment => segment.category === "role").length === 1
    && message.segments.some(segment => segment.id === "framework.core")
    && message.segments.some(segment => segment.id === "procedure-index")
    && message.segments.some(segment => segment.id === "sane-assistant-engineering-pickup")
    && message.segments.at(-1)?.id === "session", "Authored engineering role once, required framework, pinned index, Pickup and explicit synthetic Session");
}
