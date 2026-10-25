import { describe, expect, mock, test } from "bun:test";
import { assertContextMessageCurrent, assertContextMessageGuards, canonicalContextMessageExecutionValidator, prepareContextMessage, type ContextMessageGuards, type ContextMessagePreparation, type OrdinaryContextMessageInput, type SelectedContextMessageInput } from "./context-message-engine";
import { composeContextMessage, type ContextMessage, type ContextMessageInput } from "./context-message";
import { contextAsset, contextHash, type ContextPackage } from "./context-package";
import type { CanonicalExecutionSnapshot } from "./canonical-execution-store";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const guards = (): ContextMessageGuards => ({ assertOwnership() {}, assertSource() {}, assertNotCancelled() {} });
const ordinary = (): OrdinaryContextMessageInput => ({
  body: "\uFEFF  authored 😀\r\n[SANE CONTEXT MESSAGE v1]\n[/SANE CONTEXT SEGMENT]\n",
  binding: { harnessId: "synthetic", sessionId: "app-session", authorityId: "owner", nativeSessionId: "native-session", cwd: "/synthetic/worktree" },
  origin: "user", placement: { kind: "body-only" },
});
type Selected = Extract<ContextMessageInput, { selections: unknown }>;
function selected(): Selected {
  return { ...ordinary(), origin: "context-update", placement: { kind: "selected", purpose: "update" }, selections: [
    { kind: "fragment", fragment: { id: "session", category: "session", text: "membership", source: "owner/session", revision: "state-1", reason: "Membership changed" } },
    { kind: "fragment", fragment: { id: "shared", category: "shared", text: "shared bytes", source: "owner/artifact", revision: "artifact-1", reason: "Explicit sharing" } },
  ] };
}
function withPackage(): Selected {
  const body = { schema: 1 as const, identity: { kind: "assistant" as const, role: "engineering" as const }, assets: [
    contextAsset("role.assistant.engineering", "synthetic/role", "role bytes", "role"),
    contextAsset("framework.core", "synthetic/core", "core bytes", "framework"),
  ], initial: [] };
  const bundle: ContextPackage = { ...body, revision: contextHash(JSON.stringify(body)) };
  return { ...selected(), context: { bundle, paths: { "framework.core": "/synthetic/pinned/core.md" } }, selections: [{ kind: "asset", assetId: "framework.core", reason: "Explicit core update" }] };
}
const base = (read: () => OrdinaryContextMessageInput | Promise<OrdinaryContextMessageInput>, gate = guards()): ContextMessagePreparation => ({ kind: "ordinary", guards: gate, readCurrentOrdinary: read, policy: { kind: "base" } });
const context = (read: () => SelectedContextMessageInput | Promise<SelectedContextMessageInput>, validate: () => void | Promise<void> = () => {}, gate = guards()): ContextMessagePreparation => ({ kind: "context", guards: gate, readCurrentContext: read, validateSelectedContext: validate });

describe("inactive context message preparation", () => {
  for (const policyKind of ["base", "sane"] as const) test(`${policyKind} ordinary is exact body-only and cannot reach accidentally supplied context dependencies`, async () => {
    const input = ordinary(), forbidden = mock(() => { throw new Error("context provider reached"); });
    const execution = mock((_message: ContextMessage, _guards: ContextMessageGuards) => {}), pairing = mock(() => {});
    const preparation = Object.assign(base(() => structuredClone(input)), {
      readCurrentContext: forbidden, validateSelectedContext: forbidden, context: { load: forbidden }, packageProvider: forbidden,
      policy: policyKind === "base"
        ? { kind: "base" as const, validateExecution: forbidden, assertDurableActivationPairing: forbidden }
        : { kind: "sane" as const, validateExecution: execution, assertDurableActivationPairing: pairing },
    });
    const result = await prepareContextMessage(input, preparation);
    expect(result.transport.text).toBe(input.body);
    expect(result.transport.byteLength).toBe(Buffer.byteLength(input.body));
    expect(result.segments).toEqual([]);
    expect(result.packageRevision).toBeNull();
    expect(forbidden).not.toHaveBeenCalled();
    if (policyKind === "sane") {
      expect(execution).toHaveBeenCalled();
      expect(pairing).toHaveBeenCalled();
      expect(execution.mock.calls[0]![0]).toEqual(result);
    }
  });

  test("guards await ownership, then source, then cancellation", async () => {
    const entered = deferred(), release = deferred(), order: string[] = [];
    const pending = assertContextMessageGuards({
      async assertOwnership() { order.push("ownership"); entered.resolve(); await release.promise; },
      assertSource() { order.push("source"); }, assertNotCancelled() { order.push("cancellation"); },
    });
    await entered.promise;
    expect(order).toEqual(["ownership"]);
    release.resolve(); await pending;
    expect(order).toEqual(["ownership", "source", "cancellation"]);
  });

  test("SANE brackets each independent read and policy await with all guards, and verifies pairing around execution", async () => {
    const input = ordinary(), order: string[] = [];
    const gate = { assertOwnership() { order.push("ownership"); }, assertSource() { order.push("source"); }, assertNotCancelled() { order.push("cancellation"); } };
    await prepareContextMessage(input, { kind: "ordinary", guards: gate,
      readCurrentOrdinary() { order.push("read"); return structuredClone(input); },
      policy: { kind: "sane", async assertDurableActivationPairing() { order.push("pairing"); }, async validateExecution() { order.push("execution"); } },
    });
    const work = order.filter(event => ["read", "pairing", "execution"].includes(event));
    expect(work[0]).toBe("read"); expect(work.at(-1)).toBe("read");
    const executionIndex = work.indexOf("execution");
    expect(work.slice(0, executionIndex)).toContain("pairing");
    expect(work.slice(executionIndex + 1)).toContain("pairing");
    for (let index = 0; index < order.length; index++) if (["read", "pairing", "execution"].includes(order[index]!)) {
      expect(order.slice(index - 3, index)).toEqual(["ownership", "source", "cancellation"]);
      expect(order.slice(index + 1, index + 4)).toEqual(["ownership", "source", "cancellation"]);
    }
  });

  for (const evidence of ["missing", "uncertain", "wrong binding"] as const) test(`SANE refuses ${evidence} durable activation/pairing before execution`, async () => {
    const input = ordinary(), execution = mock(() => {});
    const policy = evidence === "missing" ? { kind: "sane", validateExecution: execution } : {
      kind: "sane", validateExecution: execution,
      assertDurableActivationPairing() { throw new Error(evidence); },
    };
    // A runtime caller can omit required callbacks despite the compile-time contract.
    const preparation = { ...base(() => input), policy } as ContextMessagePreparation;
    await expect(prepareContextMessage(input, preparation)).rejects.toThrow();
    expect(execution).not.toHaveBeenCalled();
  });

  test("pairing lost during execution validation is checked again", async () => {
    const input = ordinary(), entered = deferred(), release = deferred(); let paired = true;
    const pending = prepareContextMessage(input, { kind: "ordinary", guards: guards(), readCurrentOrdinary: () => input,
      policy: { kind: "sane", assertDurableActivationPairing() { if (!paired) throw new Error("pairing lost"); },
        async validateExecution() { entered.resolve(); await release.promise; } },
    });
    await entered.promise; paired = false; release.resolve();
    await expect(pending).rejects.toThrow("pairing lost");
  });

  test("SANE execution-policy refusal propagates rather than returning body-only success", async () => {
    const input = ordinary();
    await expect(prepareContextMessage(input, { kind: "ordinary", guards: guards(), readCurrentOrdinary: () => input,
      policy: { kind: "sane", assertDurableActivationPairing() {}, async validateExecution() { throw new Error("pinned execution refused"); } },
    })).rejects.toThrow("pinned execution refused");
  });

  test("fragment-only selected updates still require selected-context validation", async () => {
    const input = selected(), validate = mock(async () => { throw new Error("selected source refused"); });
    await expect(prepareContextMessage(input, context(() => input, validate))).rejects.toThrow("selected source refused");
    expect(validate).toHaveBeenCalled();
  });

  const ordinaryChanges: [string, (input: OrdinaryContextMessageInput) => OrdinaryContextMessageInput][] = [
    ["authored body", input => ({ ...input, body: input.body + "changed" })],
    ...(["harnessId", "sessionId", "authorityId", "nativeSessionId", "cwd"] as const).map(key => [key, (input: OrdinaryContextMessageInput) => ({ ...input, binding: { ...input.binding, [key]: input.binding[key] + "-changed" } })] as [string, (input: OrdinaryContextMessageInput) => OrdinaryContextMessageInput]),
    ["origin", input => ({ ...input, origin: "queued-user" })],
    ["placement inheritance", input => ({ ...input, placement: { kind: "body-only", inherited: { source: input.binding, packageRevision: "a".repeat(64), transportHashes: ["b".repeat(64)], reason: "Independent inherited history" } } })],
  ];
  for (const [name, change] of ordinaryChanges) for (const boundary of ["independent reread", "policy await"] as const) test(`ordinary rejects changed ${name} after ${boundary}`, async () => {
    const input = ordinary(); let current = structuredClone(input), reads = 0;
    const entered = deferred(), release = deferred();
    const preparation: ContextMessagePreparation = boundary === "independent reread"
      ? base(() => ++reads === 1 ? current : change(current))
      : { kind: "ordinary", guards: guards(), readCurrentOrdinary: () => current,
        policy: { kind: "sane", assertDurableActivationPairing() {}, async validateExecution() { entered.resolve(); await release.promise; } } };
    const pending = prepareContextMessage(input, preparation);
    if (boundary === "policy await") { await entered.promise; current = change(current); release.resolve(); }
    await expect(pending).rejects.toThrow("composition does not match independent trusted inputs");
  });

  const selectedChanges: [string, (input: Selected) => Selected][] = [
    ["authored body", input => ({ ...input, body: "changed body" })],
    ["selection order", input => ({ ...input, selections: [...input.selections].reverse() })],
    ["origin", input => ({ ...input, origin: "branch" })],
    ["placement purpose", input => ({ ...input, placement: { kind: "selected", purpose: "sharing" } })],
    ...(["source", "revision", "reason", "text"] as const).map(key => [key, (input: Selected) => ({ ...input, selections: input.selections.map((selection, index) => index === 0 && selection.kind === "fragment" ? { ...selection, fragment: { ...selection.fragment, [key]: selection.fragment[key] + "-changed" } } : selection) })] as [string, (input: Selected) => Selected]),
  ];
  for (const [name, change] of selectedChanges) for (const boundary of ["independent reread", "validator await"] as const) test(`selected context rejects changed ${name} after ${boundary}`, async () => {
    const input = selected(); let current = structuredClone(input), reads = 0;
    const entered = deferred(), release = deferred();
    const preparation = boundary === "independent reread" ? context(() => ++reads === 1 ? current : change(current))
      : context(() => current, async () => { entered.resolve(); await release.promise; });
    const pending = prepareContextMessage(input, preparation);
    if (boundary === "validator await") { await entered.promise; current = change(current); release.resolve(); }
    await expect(pending).rejects.toThrow("composition does not match independent trusted inputs");
  });

  for (const change of ["package revision", "pinned path", "asset source"] as const) for (const boundary of ["independent reread", "validator await"] as const) test(`context rejects changed ${change} after ${boundary}`, async () => {
    const input = withPackage(), next = structuredClone(input); let reads = 0;
    const bundle = next.context!.bundle as ContextPackage;
    if (change === "pinned path") (next.context!.paths as Record<string, string>)["framework.core"] = "/synthetic/different/core.md";
    else {
      // Rehash a valid package, so rejection is dependency currency, not a corrupt fixture.
      bundle.assets[change === "package revision" ? 0 : 1]!.source += "-changed";
      bundle.revision = contextHash(JSON.stringify({ schema: bundle.schema, identity: bundle.identity, assets: bundle.assets, initial: bundle.initial }));
    }
    const entered = deferred(), release = deferred(); let current = input;
    const preparation = boundary === "independent reread" ? context(() => ++reads === 1 ? input : next)
      : context(() => current, async () => { entered.resolve(); await release.promise; });
    const pending = prepareContextMessage(input, preparation);
    if (boundary === "validator await") { await entered.promise; current = next; release.resolve(); }
    await expect(pending).rejects.toThrow("composition does not match independent trusted inputs");
  });

  test("final context refresh follows the last asynchronous validation", async () => {
    const input = selected(), entered = deferred(), release = deferred(); let validations = 0, current = input;
    const pending = prepareContextMessage(input, context(() => current, async () => {
      if (++validations === 2) { entered.resolve(); await release.promise; }
    }));
    await entered.promise; current = { ...input, body: "changed during final validation" }; release.resolve();
    await expect(pending).rejects.toThrow("composition does not match independent trusted inputs");
  });

  for (const loss of ["ownership", "source", "cancellation"] as const) for (const boundary of ["before work", "ordinary read", "pairing", "execution", "context read", "context validation"] as const) test(`${loss} loss at ${boundary} refuses preparation`, async () => {
    const entered = deferred(), release = deferred(); let live = boundary !== "before work";
    const assertLive = () => { if (!live) throw new Error(`${loss} lost`); };
    const gate: ContextMessageGuards = {
      assertOwnership: loss === "ownership" ? assertLive : () => {},
      assertSource: loss === "source" ? assertLive : () => {},
      assertNotCancelled: loss === "cancellation" ? assertLive : () => {},
    };
    const pause = async () => { entered.resolve(); await release.promise; };
    const input = boundary.startsWith("context") ? selected() : ordinary();
    const read = mock(async () => { if (boundary === "ordinary read") await pause(); return ordinary(); });
    const execution = mock(async () => { if (boundary === "execution") await pause(); });
    const preparation: ContextMessagePreparation = boundary.startsWith("context")
      ? context(async () => { if (boundary === "context read") await pause(); return selected(); }, async () => { if (boundary === "context validation") await pause(); }, gate)
      : { kind: "ordinary", guards: gate, readCurrentOrdinary: read, policy: { kind: "sane", validateExecution: execution, async assertDurableActivationPairing() { if (boundary === "pairing") await pause(); } } };
    const pending = prepareContextMessage(input, preparation);
    if (boundary !== "before work") { await entered.promise; live = false; release.resolve(); }
    await expect(pending).rejects.toThrow(`${loss} lost`);
    if (boundary === "before work") { expect(read).not.toHaveBeenCalled(); expect(execution).not.toHaveBeenCalled(); }
    if (boundary === "ordinary read" || boundary === "pairing") expect(execution).not.toHaveBeenCalled();
  });

  for (const mode of ["original remains current", "mutated becomes current"] as const) test(`input is snapshotted before initial guard await: ${mode}`, async () => {
    const input = ordinary(), original = structuredClone(input), entered = deferred(), release = deferred(); let first = true;
    const gate = { ...guards(), async assertOwnership() { if (first) { first = false; entered.resolve(); await release.promise; } } };
    const pending = prepareContextMessage(input, base(() => mode === "original remains current" ? original : input, gate));
    await entered.promise;
    Object.assign(input, { body: "mutated body", binding: { ...input.binding, nativeSessionId: "new-native" } });
    release.resolve();
    if (mode === "original remains current") expect((await pending).transport.text).toBe(original.body);
    else await expect(pending).rejects.toThrow("composition does not match independent trusted inputs");
    expect(Object.isFrozen(input)).toBe(false);
  });

  test("engine returns deeply immutable detached output without freezing trusted source inputs", async () => {
    const input = selected(), before = structuredClone(input);
    const result = await prepareContextMessage(input, context(() => input));
    const assertFrozen = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      expect(Object.isFrozen(value)).toBe(true);
      Object.values(value).forEach(assertFrozen);
    };
    assertFrozen(result); expect(input).toEqual(before); expect(Object.isFrozen(input.binding)).toBe(false);
    Object.assign(input.binding, { authorityId: "later-owner" });
    expect(result.binding.authorityId).toBe(before.binding.authorityId);
  });

  test("nested selected intent is copied before the first asynchronous guard", async () => {
    const input = selected(), original = structuredClone(input), entered = deferred(), release = deferred(); let first = true;
    const gate = { ...guards(), async assertOwnership() { if (first) { first = false; entered.resolve(); await release.promise; } } };
    const pending = prepareContextMessage(input, context(() => original, () => {}, gate));
    await entered.promise;
    const fragment = input.selections[0]!;
    if (fragment.kind !== "fragment") throw new Error("Synthetic fragment fixture changed");
    Object.assign(fragment.fragment, { text: "mutated nested bytes", source: "mutated-source" });
    Object.assign(input.placement, { purpose: "sharing" });
    release.resolve();
    const result = await pending;
    expect(result).toEqual(composeContextMessage(original));
    expect(Object.isFrozen(fragment.fragment)).toBe(false);
  });

  test("ordinary and selected preparation paths cannot be interchanged", async () => {
    const read = mock(() => ordinary()), validate = mock(() => {});
    await expect(assertContextMessageCurrent(composeContextMessage(selected()), base(read))).rejects.toThrow("path differs");
    await expect(assertContextMessageCurrent(composeContextMessage(ordinary()), context(() => selected(), validate))).rejects.toThrow("path differs");
    expect(read).not.toHaveBeenCalled(); expect(validate).not.toHaveBeenCalled();
  });

  test("ordinary refresh cannot silently upgrade into context placement", async () => {
    await expect(prepareContextMessage(ordinary(), base(() => selected() as unknown as OrdinaryContextMessageInput))).rejects.toThrow("must not select context");
  });

  test("selected refresh cannot silently downgrade into body-only placement", async () => {
    await expect(prepareContextMessage(selected(), context(() => ordinary() as unknown as SelectedContextMessageInput))).rejects.toThrow("requires explicit selected context");
  });
});

function executionFixture(): CanonicalExecutionSnapshot {
  const body = { schema: 1 as const, policy: { schema: 1 as const, source: { markdown: "synthetic authored policy" },
    spec: { name: "sane/assistant/engineering", kind: "assistant" as const, shortId: "engineering", description: "Synthetic", body: "role bytes", ccPermissions: { allow: [], ask: [], deny: [] } }, permissions: [] }, children: [] };
  return { ...body, revision: contextHash(JSON.stringify(body)) };
}

describe("concrete ordinary execution-only policy adapter", () => {
  test("loads trusted execution only, with exact binding, without accidental context dependencies", async () => {
    const snapshot = executionFixture(), input = ordinary(), forbidden = mock(() => { throw new Error("context reached"); });
    const read = mock(() => ({ ref: { schema: 1 as const, revision: snapshot.revision }, identity: { kind: "assistant" as const, role: "engineering" as const } }));
    const load = mock(async () => snapshot);
    const validate = canonicalContextMessageExecutionValidator(Object.assign({ readTrustedExecution: read, execution: { load } }, { context: { load: forbidden }, readCurrentContext: forbidden }));
    await validate(composeContextMessage(input), guards());
    expect(read).toHaveBeenCalledWith(input.binding); expect(load).toHaveBeenCalledWith({ schema: 1, revision: snapshot.revision });
    expect(forbidden).not.toHaveBeenCalled();
  });

  for (const change of ["revision", "schema", "identity role", "identity kind"] as const) test(`detects trusted ${change} change during execution load`, async () => {
    const snapshot = executionFixture(), entered = deferred(), release = deferred();
    const trusted = { ref: { schema: 1 as const, revision: snapshot.revision }, identity: { kind: "assistant" as const, role: "engineering" as const } };
    const validate = canonicalContextMessageExecutionValidator({ readTrustedExecution: () => trusted, execution: { async load() { entered.resolve(); await release.promise; return snapshot; } } });
    const pending = validate(composeContextMessage(ordinary()), guards());
    await entered.promise;
    if (change === "revision") trusted.ref.revision = "a".repeat(64);
    else if (change === "schema") Object.assign(trusted.ref, { schema: 2 });
    else Object.assign(trusted.identity, change === "identity role" ? { role: "planning" } : { kind: "worker", role: "implementer" });
    release.resolve(); await expect(pending).rejects.toThrow("selection changed before dispatch");
  });

  for (const boundary of ["trusted selection", "execution load", "final selection"] as const) test(`guards ${boundary} await against source loss`, async () => {
    const snapshot = executionFixture(), entered = deferred(), release = deferred(); let live = true, reads = 0;
    const pause = async () => { entered.resolve(); await release.promise; };
    const load = mock(async () => { if (boundary === "execution load") await pause(); return snapshot; });
    const validate = canonicalContextMessageExecutionValidator({ async readTrustedExecution() {
      if ((++reads === 1 && boundary === "trusted selection") || (reads > 1 && boundary === "final selection")) await pause();
      return { ref: { schema: 1, revision: snapshot.revision }, identity: { kind: "assistant", role: "engineering" } };
    }, execution: { load } });
    const pending = validate(composeContextMessage(ordinary()), { ...guards(), assertSource() { if (!live) throw new Error("source lost"); } });
    await entered.promise; live = false; release.resolve();
    await expect(pending).rejects.toThrow("source lost");
    if (boundary === "trusted selection") expect(load).not.toHaveBeenCalled();
  });
});
