import { describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { validateCanonicalActivation, validateCanonicalExecution, type CanonicalActivation } from "./canonical-activation-validation";
import type { CanonicalAgentOperations } from "./canonical-agent-operations";
import type { CanonicalExecutionRef, CanonicalExecutionSnapshot } from "./canonical-execution-store";
import type { StoredSaneAgentIdentity } from "sane-core/agent-catalog";
import type { ContextPackage } from "./context-package";

// Deliberately no store implementation/parser import: these fixtures exercise the
// inactive validator without disk I/O, authored context, or harness dependencies.
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const identity: StoredSaneAgentIdentity = { kind: "assistant", role: "engineering" };
function policy(kind: "assistant" | "worker" = "assistant", role = "engineering"): CanonicalAgentOperations {
  const name = `sane/${kind}/${role}`;
  return { schema: 1, source: { markdown: "synthetic pinned markdown", modelOverride: { model: "example/model", variant: "careful" } },
    spec: { name, kind, shortId: kind === "assistant" ? role : name, description: "Synthetic policy", body: `${name} role bytes\r\n`, temperature: 0.25,
      ccPermissions: { allow: ["Read"], ask: ["Bash"], deny: ["Write"] } },
    permissions: [{ action: "read", resource: "src/**", effect: "allow" }, { action: "shell", resource: "*", effect: "ask" }, { action: "edit", resource: "secrets/**", effect: "deny" }],
    model: { providerID: "example", id: "family/model", variant: "careful" }, temperature: 0.25 };
}
function snapshot(main = policy(), children = [policy("worker", "implementer"), policy("worker", "reviewer")]): CanonicalExecutionSnapshot {
  const body = { schema: 1 as const, policy: main, children };
  return { ...body, revision: hash(body) };
}
const ref = (execution: CanonicalExecutionSnapshot): CanonicalExecutionRef => ({ schema: 1, revision: execution.revision });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("canonical execution-only validation", () => {
  test("preserves complete pinned models, permissions, temperatures, and native children without translation", async () => {
    const execution = snapshot(), before = structuredClone(execution), load = mock(async () => execution);
    const result = await validateCanonicalExecution(ref(execution), identity, { load });
    expect(result).toEqual(before);
    expect(execution).toEqual(before);
    expect(result.policy.model).toEqual({ providerID: "example", id: "family/model", variant: "careful" });
    expect(result.policy.permissions).toEqual(before.policy.permissions);
    expect(result.children).toEqual(before.children);
    expect(result.children[0]!.model).toEqual(before.children[0]!.model);
  });

  test("historical Knowledge and valid worker identities retain their own stored policies", async () => {
    for (const selected of [{ kind: "assistant", role: "knowledge" }, { kind: "worker", role: "tester" }] as const) {
      const execution = snapshot(policy(selected.kind, selected.role));
      expect(await validateCanonicalExecution(ref(execution), selected, { load: async () => execution })).toEqual(execution);
    }
  });

  for (const invalid of [null, { kind: "assistant", role: "prototype" }, { kind: "assistant", role: "implementer" }, { kind: "worker", role: "engineering" }, { kind: "unknown", role: "engineering" }]) test(`invalid trusted identity rejects before load: ${JSON.stringify(invalid)}`, async () => {
    const execution = snapshot(), load = mock(async () => execution);
    await expect(validateCanonicalExecution(ref(execution), invalid as StoredSaneAgentIdentity, { load })).rejects.toThrow("valid identity");
    expect(load).not.toHaveBeenCalled();
  });

  for (const invalid of [null, { schema: 2, revision: "a".repeat(64) }, { schema: 1, revision: "A".repeat(64) }, { schema: 1, revision: "../snapshot" }, { schema: 1, revision: "a".repeat(63) }]) test(`invalid pin rejects before load: ${JSON.stringify(invalid)}`, async () => {
    const load = mock(async () => snapshot());
    await expect(validateCanonicalExecution(invalid as CanonicalExecutionRef, identity, { load })).rejects.toThrow("Invalid canonical execution reference");
    expect(load).not.toHaveBeenCalled();
  });

  test("captures ref and identity before initial guard await, not mutable caller objects", async () => {
    const execution = snapshot(), pin = ref(execution), selected = { ...identity }, entered = deferred(), release = deferred(); let first = true;
    const load = mock(async () => execution);
    const pending = validateCanonicalExecution(pin, selected, { load }, { async assertCurrent() { if (first) { first = false; entered.resolve(); await release.promise; } } });
    await entered.promise; pin.revision = "a".repeat(64); Object.assign(selected, { role: "planning" }); release.resolve();
    expect(await pending).toEqual(execution);
    expect(load).toHaveBeenCalledWith(ref(execution));
  });

  for (const boundary of ["before load", "after load"] as const) test(`owner guard refuses ${boundary}`, async () => {
    const execution = snapshot(), entered = deferred(), release = deferred(); let live = boundary !== "before load";
    const load = mock(async () => { entered.resolve(); await release.promise; return execution; });
    const pending = validateCanonicalExecution(ref(execution), identity, { load }, { assertCurrent() { if (!live) throw new Error("owner gate lost"); } });
    if (boundary === "after load") { await entered.promise; live = false; release.resolve(); }
    await expect(pending).rejects.toThrow("owner gate lost");
    if (boundary === "before load") expect(load).not.toHaveBeenCalled();
  });

  const corruptions: [string, (execution: CanonicalExecutionSnapshot) => void][] = [
    ["snapshot revision", execution => { execution.revision = "a".repeat(64); }],
    ["snapshot schema", execution => { Object.assign(execution, { schema: 2 }); }],
    ["missing child list", execution => { Object.assign(execution, { children: null }); }],
    ["role bytes", execution => { execution.policy.spec.body += "tampered"; }],
    ["parent model", execution => { execution.policy.model!.id += "tampered"; }],
    ["parent permission", execution => { execution.policy.permissions[0]!.effect = "deny"; }],
    ["child bytes", execution => { execution.children[0]!.spec.body += "tampered"; }],
    ["child model", execution => { execution.children[0]!.model!.variant = "different"; }],
  ];
  for (const [name, corrupt] of corruptions) test(`rejects changed pinned ${name}`, async () => {
    const execution = snapshot(), pin = ref(execution); corrupt(execution);
    await expect(validateCanonicalExecution(pin, identity, { load: async () => execution })).rejects.toThrow();
  });

  const invalidPolicies: [string, (value: CanonicalAgentOperations) => void][] = [
    ["permission effect", value => { Object.assign(value.permissions[0]!, { effect: "maybe" }); }],
    ["permission resource", value => { Object.assign(value.permissions[0]!, { resource: 7 }); }],
    ["model provider", value => { value.model!.providerID = "bad/provider"; }],
    ["model id", value => { value.model!.id = "bad model"; }],
    ["model variant", value => { value.model!.variant = "bad#variant"; }],
    ["model override", value => { Object.assign(value.source, { modelOverride: { model: 7 } }); }],
    ["nonfinite temperature", value => { value.temperature = Infinity; }],
    ["invalid CC permission", value => { Object.assign(value.spec.ccPermissions, { allow: [7] }); }],
    ["spec identity mismatch", value => { value.spec.shortId = "planning"; }],
  ];
  for (const [name, invalidate] of invalidPolicies) test(`rejects invalid policy even with matching hash: ${name}`, async () => {
    const main = policy(); invalidate(main); const execution = snapshot(main);
    await expect(validateCanonicalExecution(ref(execution), identity, { load: async () => execution })).rejects.toThrow("Invalid canonical execution policy");
  });

  test("valid but wrong main role is not interchangeable", async () => {
    const execution = snapshot(policy("assistant", "planning"));
    await expect(validateCanonicalExecution(ref(execution), identity, { load: async () => execution })).rejects.toThrow("role differs from its trusted identity");
  });
  for (const children of [[policy(), policy("worker", "tester")], [policy("worker", "tester"), policy("worker", "tester")]]) test(`rejects non-worker or duplicate native child identities: ${children.map(item => item.spec.name).join(",")}`, async () => {
    const execution = snapshot(policy(), children);
    await expect(validateCanonicalExecution(ref(execution), identity, { load: async () => execution })).rejects.toThrow("Invalid canonical native child policy");
  });
});

function pairedFixture() {
  const execution = snapshot();
  const bundle: ContextPackage = { schema: 1, identity: { ...identity }, initial: [], revision: "c".repeat(64), assets: [
    { id: "role.assistant.engineering", kind: "role", text: execution.policy.spec.body, source: "synthetic/role", sha256: "d".repeat(64), description: "" },
  ] };
  // These fake loaders model already-verified store bytes. The wrapper's job is
  // pair/identity/role matching, not duplicating context-store package validation.
  const pair: CanonicalActivation = { saneExecution: ref(execution), saneContext: { version: 1, framework: "synthetic", package: { schema: 1, revision: bundle.revision, delivery: "standing-native-role" } } };
  return { execution, bundle, pair };
}
describe("full paired activation validation", () => {
  test("still loads execution AND context and returns unmodified execution", async () => {
    const { execution, bundle, pair } = pairedFixture(), executionLoad = mock(async () => execution), contextLoad = mock(async () => ({ bundle }));
    expect(await validateCanonicalActivation(pair, identity, { execution: { load: executionLoad }, context: { load: contextLoad } })).toEqual(execution);
    expect(executionLoad).toHaveBeenCalledWith(pair.saneExecution);
    expect(contextLoad).toHaveBeenCalledWith(pair.saneContext.package);
  });
  for (const change of ["role bytes", "identity", "context revision", "missing role"] as const) test(`paired validation rejects mismatched ${change}`, async () => {
    const { execution, bundle, pair } = pairedFixture();
    if (change === "role bytes") bundle.assets[0]!.text += "changed";
    else if (change === "identity") bundle.identity = { kind: "assistant", role: "planning" };
    else if (change === "context revision") bundle.revision = "e".repeat(64);
    else bundle.assets = [];
    await expect(validateCanonicalActivation(pair, identity, { execution: { load: async () => execution }, context: { load: async () => ({ bundle }) } })).rejects.toThrow("context and execution role bytes differ");
  });
  test("missing context pin is not treated as an ordinary execution-only success", async () => {
    const { execution, pair } = pairedFixture(), load = mock(async () => execution);
    delete pair.saneContext.package;
    await expect(validateCanonicalActivation(pair, identity, { execution: { load }, context: { load: async () => { throw new Error("unexpected load"); } } })).rejects.toThrow("paired context and execution references");
    expect(load).not.toHaveBeenCalled();
  });
  for (const invalid of [{ schema: 2 }, { revision: "A".repeat(64) }, { delivery: "unknown" }, { activation: "resume" }]) test(`invalid context ref refuses before either loader: ${JSON.stringify(invalid)}`, async () => {
    const { execution, pair } = pairedFixture();
    Object.assign(pair.saneContext.package!, invalid);
    const executionLoad = mock(async () => execution), contextLoad = mock(async () => { throw new Error("unexpected context load"); });
    await expect(validateCanonicalActivation(pair, identity, { execution: { load: executionLoad }, context: { load: contextLoad } })).rejects.toThrow("Invalid context package reference");
    expect(executionLoad).not.toHaveBeenCalled(); expect(contextLoad).not.toHaveBeenCalled();
  });
  for (const which of ["execution", "context"] as const) test(`paired validation guards ${which} load await`, async () => {
    const { execution, bundle, pair } = pairedFixture(), entered = deferred(), release = deferred(); let live = true;
    const pause = async () => { entered.resolve(); await release.promise; };
    const pending = validateCanonicalActivation(pair, identity, {
      execution: { async load() { if (which === "execution") await pause(); return execution; } },
      context: { async load() { if (which === "context") await pause(); return { bundle }; } },
    }, { assertCurrent() { if (!live) throw new Error("binding lost"); } });
    await entered.promise; live = false; release.resolve();
    await expect(pending).rejects.toThrow("binding lost");
  });
});
