import { describe, expect, mock, test } from "bun:test";
import { claudeConversationCreation, openCodeConversationCreation } from "./native-conversation-creation";
import type { OpenCodeAdapter, OpenCodeLaunch } from "./opencode";

// Only this structural port is supplied: no native adapter, service, resolver,
// recovery, or prompt/execution methods are available to these offline tests.
type CreationPort = Pick<OpenCodeAdapter, "createResolved">;
const cwd = "/offline/pinned checkout";
const session = (id: string) => ({ id, time: { created: 0, updated: 0 } });

describe("Claude conversation creation", () => {
  test("keeps the injected allocator lazy and allocates once per explicit call", () => {
    let allocations = 0;
    const allocate = mock(() => `allocated-${++allocations}`);
    const native = claudeConversationCreation(allocate);

    expect(native.harness).toBe("cc");
    expect(native.kind).toBe("allocated");
    expect(Object.keys(native).sort()).toEqual(["allocate", "harness", "kind"]);
    expect(allocate).toHaveBeenCalledTimes(0);
    if (native.kind !== "allocated") throw new Error("Expected allocated creation");
    expect(native.allocate).toBe(allocate);
    expect(native.allocate()).toBe("allocated-1");
    expect(allocate).toHaveBeenCalledTimes(1);
    expect(native.allocate()).toBe("allocated-2");
    expect(allocate).toHaveBeenCalledTimes(2);
    expect(allocate.mock.calls).toEqual([[], []]);
  });

  test("the default allocator returns distinct valid UUID v4 identities", () => {
    const native = claudeConversationCreation();
    if (native.kind !== "allocated") throw new Error("Expected allocated creation");

    const first = native.allocate();
    const second = native.allocate();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(first).toMatch(uuid);
    expect(second).toMatch(uuid);
    expect(second).not.toBe(first);
  });

  test("propagates an injected allocation refusal without retrying", () => {
    const refusal = new Error("allocation refused");
    const allocate = mock((): string => { throw refusal; });
    const native = claudeConversationCreation(allocate);
    expect(allocate).toHaveBeenCalledTimes(0);
    if (native.kind !== "allocated") throw new Error("Expected allocated creation");

    let caught: unknown;
    try { native.allocate(); } catch (error) { caught = error; }
    expect(caught).toBe(refusal);
    expect(allocate).toHaveBeenCalledTimes(1);
  });
});

describe("OpenCode conversation creation", () => {
  test("is lazy, passes the exact cwd and resolved launch, and returns only the native ID", async () => {
    const launch: OpenCodeLaunch = {
      agent: "selected-agent",
      model: { id: "selected-model", providerID: "offline-provider", variant: "high" },
    };
    const resolvedLaunch = mock(() => launch);
    const createResolved = mock(async (_cwd: string, _launch: OpenCodeLaunch) => session("ses_offline_created"));
    const adapter = { createResolved } satisfies CreationPort;
    const native = openCodeConversationCreation(adapter, cwd, resolvedLaunch);

    expect(Object.keys(adapter)).toEqual(["createResolved"]);
    expect(native.harness).toBe("oc");
    expect(native.kind).toBe("created");
    expect(Object.keys(native).sort()).toEqual(["create", "harness", "kind"]);
    expect(resolvedLaunch).toHaveBeenCalledTimes(0);
    expect(createResolved).toHaveBeenCalledTimes(0);
    if (native.kind !== "created") throw new Error("Expected created creation");

    expect(await native.create()).toBe("ses_offline_created");
    expect(resolvedLaunch.mock.calls).toEqual([[]]);
    expect(createResolved).toHaveBeenCalledTimes(1);
    expect(createResolved.mock.calls[0]![0]).toBe(cwd);
    expect(createResolved.mock.calls[0]![1]).toBe(launch);
  });

  test("evaluates the launch callback at each create, not factory construction", async () => {
    let current: OpenCodeLaunch = { agent: "before-construction" };
    const resolvedLaunch = mock(() => current);
    let creations = 0;
    const createResolved = mock(async (_cwd: string, _launch: OpenCodeLaunch) => session(`ses_explicit_${++creations}`));
    const native = openCodeConversationCreation({ createResolved }, cwd, resolvedLaunch);
    if (native.kind !== "created") throw new Error("Expected created creation");

    const first: OpenCodeLaunch = { model: { id: "first", providerID: "offline" } };
    current = first;
    expect(await native.create()).toBe("ses_explicit_1");
    const second: OpenCodeLaunch = {};
    current = second;
    expect(await native.create()).toBe("ses_explicit_2");

    expect(resolvedLaunch).toHaveBeenCalledTimes(2);
    expect(createResolved).toHaveBeenCalledTimes(2);
    expect(createResolved.mock.calls[0]![1]).toBe(first);
    expect(createResolved.mock.calls[1]![1]).toBe(second);
    expect(createResolved.mock.calls.map(args => args[0])).toEqual([cwd, cwd]);
  });

  test("waits for a pending acknowledgement without another launch or creation", async () => {
    let acknowledge!: (value: ReturnType<typeof session>) => void;
    const acknowledgement = new Promise<ReturnType<typeof session>>(resolve => { acknowledge = resolve; });
    const resolvedLaunch = mock(() => ({}));
    const createResolved = mock((_cwd: string, _launch: OpenCodeLaunch) => acknowledgement);
    const native = openCodeConversationCreation({ createResolved }, cwd, resolvedLaunch);
    if (native.kind !== "created") throw new Error("Expected created creation");

    let settled = false;
    const creating = native.create().then(id => { settled = true; return id; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(resolvedLaunch).toHaveBeenCalledTimes(1);
    expect(createResolved).toHaveBeenCalledTimes(1);
    acknowledge(session("ses_acknowledged"));
    expect(await creating).toBe("ses_acknowledged");
    expect(resolvedLaunch).toHaveBeenCalledTimes(1);
    expect(createResolved).toHaveBeenCalledTimes(1);
  });

  test("concurrent explicit calls each create exactly once and retain their own result", async () => {
    const acknowledge: Array<(value: ReturnType<typeof session>) => void> = [];
    const resolvedLaunch = mock(() => ({}));
    const createResolved = mock((_cwd: string, _launch: OpenCodeLaunch) =>
      new Promise<ReturnType<typeof session>>(resolve => { acknowledge.push(resolve); }));
    const native = openCodeConversationCreation({ createResolved }, cwd, resolvedLaunch);
    if (native.kind !== "created") throw new Error("Expected created creation");

    const first = native.create();
    const second = native.create();
    expect(resolvedLaunch).toHaveBeenCalledTimes(2);
    expect(createResolved).toHaveBeenCalledTimes(2);
    acknowledge[1]!(session("ses_second"));
    expect(await second).toBe("ses_second");
    acknowledge[0]!(session("ses_first"));
    expect(await first).toBe("ses_first");
    expect(createResolved).toHaveBeenCalledTimes(2);
  });

  test("a lost acknowledgement propagates unchanged without retry or recovery", async () => {
    const lostAck = new Error("native session created but acknowledgement lost");
    const mutations: string[] = [];
    const resolvedLaunch = mock(() => ({}));
    const createResolved = mock(async (_cwd: string, _launch: OpenCodeLaunch) => {
      mutations.push("ses_created_before_ack_lost");
      throw lostAck;
    });
    const native = openCodeConversationCreation({ createResolved }, cwd, resolvedLaunch);
    if (native.kind !== "created") throw new Error("Expected created creation");

    await expect(native.create()).rejects.toBe(lostAck);
    await Promise.resolve();
    expect(mutations).toEqual(["ses_created_before_ack_lost"]);
    expect(resolvedLaunch).toHaveBeenCalledTimes(1);
    expect(createResolved).toHaveBeenCalledTimes(1);
  });

  test("propagates a synchronous adapter error without retrying", async () => {
    const failure = new Error("adapter refused creation");
    const resolvedLaunch = mock(() => ({}));
    const createResolved = mock((_cwd: string, _launch: OpenCodeLaunch): Promise<ReturnType<typeof session>> => { throw failure; });
    const native = openCodeConversationCreation({ createResolved }, cwd, resolvedLaunch);
    if (native.kind !== "created") throw new Error("Expected created creation");

    await expect(native.create()).rejects.toBe(failure);
    expect(resolvedLaunch).toHaveBeenCalledTimes(1);
    expect(createResolved).toHaveBeenCalledTimes(1);
  });

  test("a create-time launch guard refuses before native mutation", async () => {
    const refusal = new Error("resolved launch is no longer admissible");
    let allowed = true;
    const resolvedLaunch = mock((): OpenCodeLaunch => {
      if (!allowed) throw refusal;
      return { agent: "selected-agent" };
    });
    const createResolved = mock(async (_cwd: string, _launch: OpenCodeLaunch) => session("ses_must_not_exist"));
    const native = openCodeConversationCreation({ createResolved }, cwd, resolvedLaunch);
    expect(resolvedLaunch).toHaveBeenCalledTimes(0);
    allowed = false;
    if (native.kind !== "created") throw new Error("Expected created creation");

    await expect(native.create()).rejects.toBe(refusal);
    expect(resolvedLaunch).toHaveBeenCalledTimes(1);
    expect(createResolved).toHaveBeenCalledTimes(0);
  });
});
