import { describe, expect, mock, test } from "bun:test";
import { assertContextMessageCurrent, assertContextMessageGuards, prepareContextMessage, type ContextMessageGuards, type ContextMessagePreparation, type OrdinaryContextMessageInput } from "./context-message-engine";
import { composeContextMessage, type ContextMessageInput } from "./context-message";
import { contextAsset, contextHash, type ContextPackage } from "./context-package";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const guards = (): ContextMessageGuards => ({ assertOwnership() {}, assertSource() {}, assertNotCancelled() {} });
const ordinary = (): OrdinaryContextMessageInput => ({
  body: "\uFEFF  authored é😀\r\n[SANE CONTEXT MESSAGE v1]\n[/SANE CONTEXT SEGMENT]\n",
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
const base = (read: () => OrdinaryContextMessageInput | Promise<OrdinaryContextMessageInput>, gate = guards()): ContextMessagePreparation => ({ kind: "ordinary", guards: gate, readCurrentOrdinary: read });
const context = (assertSelectionCurrent: () => void | Promise<void> = () => {}, gate = guards()): ContextMessagePreparation => ({ kind: "context", guards: gate, assertSelectionCurrent });

describe("guarded compose-once context message preparation", () => {
  test("ordinary is byte-exact body-only and never invokes injected context, execution or historical proof callbacks", async () => {
    const input = ordinary(), forbidden = mock(() => { throw new Error("Inactive dependency reached"); });
    // Extra runtime properties must not revive hidden proof work in old callers.
    const preparation = Object.assign(base(() => structuredClone(input)), {
      readCurrentContext: forbidden, validateSelectedContext: forbidden, assertSelectionCurrent: forbidden,
      context: { load: forbidden }, execution: { load: forbidden }, packageProvider: forbidden,
      readActivation: forbidden, validateExecution: forbidden, assertDurableActivationPairing: forbidden,
      policy: { kind: "sane", validateExecution: forbidden, assertDurableActivationPairing: forbidden },
    });
    const result = await prepareContextMessage(input, preparation);
    expect(await assertContextMessageCurrent(result, preparation)).toBe(result);
    expect(Buffer.from(result.transport.text)).toEqual(Buffer.from(input.body));
    expect(result.transport.byteLength).toBe(Buffer.byteLength(input.body));
    expect(result.body.range).toEqual({ offset: 0, length: Buffer.byteLength(input.body) });
    expect(result.segments).toEqual([]);
    expect(result.packageRevision).toBeNull();
    expect(forbidden).not.toHaveBeenCalled();
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

  const ordinaryChanges: [string, (input: OrdinaryContextMessageInput) => OrdinaryContextMessageInput][] = [
    ["authored body", input => ({ ...input, body: input.body + "changed" })],
    ...(["harnessId", "sessionId", "authorityId", "nativeSessionId", "cwd"] as const).map(key => [key, (input: OrdinaryContextMessageInput) => ({ ...input, binding: { ...input.binding, [key]: input.binding[key] + "-changed" } })] as [string, (input: OrdinaryContextMessageInput) => OrdinaryContextMessageInput]),
    ["origin", input => ({ ...input, origin: "queued-user" })],
    ["placement inheritance", input => ({ ...input, placement: { kind: "body-only", inherited: { source: input.binding, packageRevision: "a".repeat(64), transportHashes: ["b".repeat(64)], reason: "Independent inherited history" } } })],
  ];
  for (const [name, change] of ordinaryChanges) for (const boundary of ["preparation", "retained boundary"] as const) test(`ordinary rejects changed ${name} at ${boundary}`, async () => {
    const input = ordinary(); let current = structuredClone(input);
    const preparation = base(() => current);
    const message = boundary === "retained boundary" ? await prepareContextMessage(input, preparation) : undefined;
    current = change(current);
    await expect(message ? assertContextMessageCurrent(message, preparation) : prepareContextMessage(input, preparation))
      .rejects.toThrow("differs from current authored input or binding");
  });

  test("ordinary compares the authored input returned after an actual asynchronous read", async () => {
    const input = ordinary(), entered = deferred(), release = deferred(); let current = input;
    const pending = prepareContextMessage(input, base(async () => { entered.resolve(); await release.promise; return current; }));
    await entered.promise; current = { ...input, body: "edited while read was pending" }; release.resolve();
    await expect(pending).rejects.toThrow("differs from current authored input or binding");
  });

  for (const loss of ["ownership", "source", "cancellation"] as const) {
    test(`${loss} loss before work refuses without reading or checking selection`, async () => {
      const forbidden = mock((): never => { throw new Error("Work should not start"); });
      const refuse = () => { throw new Error(`${loss} lost`); };
      const gate = { ...guards(), [loss === "ownership" ? "assertOwnership" : loss === "source" ? "assertSource" : "assertNotCancelled"]: refuse };
      await expect(prepareContextMessage(ordinary(), base(forbidden, gate))).rejects.toThrow(`${loss} lost`);
      await expect(prepareContextMessage(selected(), context(forbidden, gate))).rejects.toThrow(`${loss} lost`);
      expect(forbidden).not.toHaveBeenCalled();
    });
    for (const boundary of ["ordinary read", "selection guard"] as const) for (const phase of ["preparation", "retained boundary"] as const) test(`${loss} loss during ${boundary} wait refuses ${phase}`, async () => {
      const entered = deferred(), release = deferred(); let live = true, pause = false;
      const assertLive = () => { if (!live) throw new Error(`${loss} lost`); };
      const gate = { ...guards(), [loss === "ownership" ? "assertOwnership" : loss === "source" ? "assertSource" : "assertNotCancelled"]: assertLive };
      const wait = async () => { if (pause) { entered.resolve(); await release.promise; } };
      const input = boundary === "ordinary read" ? ordinary() : selected();
      const preparation = boundary === "ordinary read" ? base(async () => { await wait(); return ordinary(); }, gate) : context(wait, gate);
      const message = phase === "retained boundary" ? await prepareContextMessage(input, preparation) : undefined;
      pause = true;
      const pending = message ? assertContextMessageCurrent(message, preparation) : prepareContextMessage(input, preparation);
      await entered.promise; live = false; release.resolve();
      await expect(pending).rejects.toThrow(`${loss} lost`);
    });
  }

  test("fragment selection propagates its owner's initial refusal", async () => {
    const assertSelectionCurrent = mock(() => { throw new Error("selected source refused"); });
    await expect(prepareContextMessage(selected(), context(assertSelectionCurrent))).rejects.toThrow("selected source refused");
    expect(assertSelectionCurrent).toHaveBeenCalled();
  });

  test("retained selection guard rejects actual mutable intent loss after its asynchronous wait", async () => {
    const input = selected(), entered = deferred(), release = deferred(); let selectedIntent = true, pause = false;
    const preparation = context(async () => {
      if (pause) { entered.resolve(); await release.promise; }
      if (!selectedIntent) throw new Error("Explicit selection no longer current");
    });
    const message = await prepareContextMessage(input, preparation);
    pause = true;
    const pending = assertContextMessageCurrent(message, preparation);
    await entered.promise; selectedIntent = false; release.resolve();
    await expect(pending).rejects.toThrow("Explicit selection no longer current");
  });

  test("selected refresh returns the same composition without rebuilding packages or rereading selected inputs", async () => {
    const input = withPackage(), forbidden = mock(() => { throw new Error("Selected rebuild reached"); });
    const preparation = Object.assign(context(), { readCurrentContext: forbidden, validateSelectedContext: forbidden,
      packageProvider: forbidden, context: { load: forbidden }, execution: { load: forbidden }, readActivation: forbidden });
    const message = await prepareContextMessage(input, preparation), original = structuredClone(message);
    // Currency belongs to the retained owner guard, not the caller's later
    // mutations of the original loaded package object.
    Object.assign(input.context!.bundle, { revision: "no longer a valid package" });
    Object.assign(input, { selections: [], body: "later caller object" });
    expect(await assertContextMessageCurrent(message, preparation)).toBe(message);
    expect(message).toEqual(original);
    expect(forbidden).not.toHaveBeenCalled();
  });

  for (const mode of ["original remains current", "mutated becomes current"] as const) test(`ordinary input is snapshotted before initial guard await: ${mode}`, async () => {
    const input = ordinary(), original = structuredClone(input), entered = deferred(), release = deferred(); let first = true;
    const gate = { ...guards(), async assertOwnership() { if (first) { first = false; entered.resolve(); await release.promise; } } };
    const pending = prepareContextMessage(input, base(() => mode === "original remains current" ? original : input, gate));
    await entered.promise;
    Object.assign(input, { body: "mutated body", binding: { ...input.binding, nativeSessionId: "new-native" } });
    release.resolve();
    if (mode === "original remains current") expect((await pending).transport.text).toBe(original.body);
    else await expect(pending).rejects.toThrow("differs from current authored input or binding");
    expect(Object.isFrozen(input)).toBe(false);
  });

  test("engine returns deeply immutable detached selected output without freezing source inputs", async () => {
    const input = withPackage(), before = structuredClone(input);
    const result = await prepareContextMessage(input, context());
    const assertFrozen = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      expect(Object.isFrozen(value)).toBe(true);
      Object.values(value).forEach(assertFrozen);
    };
    assertFrozen(result); expect(input).toEqual(before); expect(Object.isFrozen(input.binding)).toBe(false);
    expect(Object.isFrozen(input.context!.bundle)).toBe(false);
    Object.assign(input.binding, { authorityId: "later-owner" });
    Object.assign(input.context!.paths, { "framework.core": "/synthetic/later/core.md" });
    expect(result).toEqual(composeContextMessage(before));
  });

  test("nested selected intent is copied before the first asynchronous guard", async () => {
    const input = selected(), original = structuredClone(input), entered = deferred(), release = deferred(); let first = true;
    const gate = { ...guards(), async assertOwnership() { if (first) { first = false; entered.resolve(); await release.promise; } } };
    const pending = prepareContextMessage(input, context(() => {}, gate));
    await entered.promise;
    const fragment = input.selections[0]!;
    if (fragment.kind !== "fragment") throw new Error("Synthetic fragment fixture changed");
    Object.assign(fragment.fragment, { text: "mutated nested bytes", source: "mutated-source" });
    Object.assign(input.placement, { purpose: "sharing" });
    release.resolve();
    expect(await pending).toEqual(composeContextMessage(original));
    expect(Object.isFrozen(fragment.fragment)).toBe(false);
  });

  test("ordinary and selected preparation paths cannot be interchanged", async () => {
    const read = mock(() => ordinary()), selectionGuard = mock(() => {});
    await expect(assertContextMessageCurrent(composeContextMessage(selected()), base(read))).rejects.toThrow("path differs");
    await expect(assertContextMessageCurrent(composeContextMessage(ordinary()), context(selectionGuard))).rejects.toThrow("path differs");
    expect(read).not.toHaveBeenCalled(); expect(selectionGuard).not.toHaveBeenCalled();
  });

  test("ordinary refresh refuses a runtime placement mismatch instead of bootstrapping", async () => {
    const current = ordinary();
    Object.assign(current, { placement: { kind: "selected", purpose: "update" } });
    await expect(prepareContextMessage(ordinary(), base(() => current))).rejects.toThrow("differs from current authored input or binding");
  });

  for (const origin of ["activation", "context-update", "branch"] as const) test(`${origin} origin alone never implies bootstrap or context delivery`, async () => {
    const input = { ...ordinary(), origin };
    const message = await prepareContextMessage(input, base(() => input));
    expect(message.placement.kind).toBe("body-only");
    expect(message.transport.text).toBe(input.body);
    expect(message.segments).toEqual([]);
  });
});
