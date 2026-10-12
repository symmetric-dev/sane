import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { ASSISTANT_AGENT_IDS, WORKER_AGENT_IDS } from "sane-core/agent-catalog";
import { claudeExecutionConfiguration, openCodeExecutionConfiguration, openCodeExecutionRpcRequest, parseCanonicalAgentOperations, requiredNativeChildren, type OperationPermission } from "./canonical-agent-operations";
import { executionModelMatches, executionPermissionsMatch, registerExecutionOperations } from "../../../opencode/plugins/sane/execution";

const source = async (role: string, kind = "worker") => parseCanonicalAgentOperations(await readFile(new URL(`../../../opencode/agents/sane/${kind}/${role}.md`, import.meta.url), "utf8"), `sane/${kind}/${role}`);

describe("canonical execution policy", () => {
  test("all current authored definitions parse without installed config", async () => {
    for (const role of WORKER_AGENT_IDS) expect((await source(role)).schema).toBe(1);
    for (const role of ASSISTANT_AGENT_IDS) expect((await source(role, "assistant")).schema).toBe(1);
    expect(requiredNativeChildren(await source("engineering", "assistant"))).toEqual([]);
  });
  test("preserves ordered native permissions and legacy aliases", async () => {
    const scout = await source("scout"), implementer = await source("implementer");
    expect(scout.permissions).toContainEqual({ action: "shell", resource: "*", effect: "allow" });
    expect(scout.permissions).toContainEqual({ action: "edit", resource: "*", effect: "deny" });
    expect(requiredNativeChildren(scout)).toEqual([]);
    expect(requiredNativeChildren(implementer).sort()).toEqual(["sane/worker/researcher", "sane/worker/scout"]);
  });
  test("explicit profile model does not inherit an authored model's variant", async () => {
    const policy = await source("scout");
    policy.model = { providerID: "openai", id: "authored", variant: "high" };
    const config = openCodeExecutionConfiguration({ policy, sessionID: "one", directory: "/repo", model: "anthropic/selected" });
    expect(config.model).toEqual({ providerID: "anthropic", id: "selected" });
    expect(config.agent).toBe(config.executionAgent);
    expect(config.executionAgent).toMatch(/^sane-execution-[a-f0-9]{64}$/);
    expect(JSON.stringify(config)).not.toContain(policy.spec.body);
    expect(openCodeExecutionConfiguration({ policy, sessionID: "one", directory: "/repo", effort: "low" }).model?.variant).toBe("low");
  });
  test("installer model overrides remain usable and unknown fields fail closed", () => {
    const text = "---\ndescription: Example\nmode: subagent\ntemperature: 0.1\npermission:\n  task: deny\n---\nRole";
    expect(parseCanonicalAgentOperations(text, "sane/worker/scout", { model: "openai/test", variant: "high" }).model).toEqual({ providerID: "openai", id: "test", variant: "high" });
    expect(parseCanonicalAgentOperations(text, "sane/worker/scout", "openai/test").source).toEqual({ markdown: text, modelOverride: "openai/test" });
    expect(() => parseCanonicalAgentOperations(text.replace("temperature: 0.1", "steps: 2"), "sane/worker/scout")).toThrow("Unsupported canonical execution field");
  });
  test("CC launch-local child prompts are authored roles, selected role injected once", async () => {
    const policy = await source("implementer"), children = await Promise.all([source("scout"), source("researcher")]);
    const result = claudeExecutionConfiguration({ policy, children, model: "opus", effort: "high", childProfiles: { "sane/worker/scout": { model: "sonnet", effort: "low" } } });
    expect(result.agents[result.agent]?.prompt).toBe("");
    expect(result.minimumVersion).toBe("2.1.281");
    expect(result.agents["sane-worker-scout"]?.prompt).toBe(children[0]!.spec.body);
    expect(result.agents["sane-worker-scout"]?.model).toBe("sonnet");
    expect(result.args).toContain("--agents");
    expect(result.args).toContain("opus");
    expect(result.permissions.allow).toContain("Agent(sane-worker-scout)");
    expect(JSON.stringify(result.agents)).not.toContain("SANE_WORKER_PROCEDURES");
    expect(() => claudeExecutionConfiguration({ policy })).toThrow("Canonical native child policy required");
  });
  test("CC production rendering consumes pinned child model/effort and removes Scout write tools", async () => {
    const authored = await source("scout");
    const scout = parseCanonicalAgentOperations(authored.source.markdown, authored.spec.name, { model: "anthropic/claude-sonnet-4-6", variant: "high" });
    const result = claudeExecutionConfiguration({ policy: await source("implementer"), children: [scout, await source("researcher")] });
    // Exercise the serialized launch path without the optional childProfiles map.
    const definitions = JSON.parse(result.args[result.args.indexOf("--agents") + 1]!);
    expect(definitions["sane-worker-scout"].model).toBe("claude-sonnet-4-6");
    expect(definitions["sane-worker-scout"].effort).toBe("high");
    expect(definitions["sane-worker-scout"].disallowedTools).toEqual(expect.arrayContaining(["Edit", "Write", "NotebookEdit", "Agent", "WebFetch", "WebSearch", "AskUserQuestion", "Skill"]));
    expect(definitions["sane-worker-scout"].permissions).toBeUndefined();
    expect(definitions["sane-worker-scout"].permissionMode).toBeUndefined();
    expect(definitions["sane-worker-researcher"].disallowedTools).not.toContain("Edit");
    expect(result.policyTranslation.children.find(child => child.canonicalId === scout.spec.name)).toMatchObject({
      model: { source: "pinned", value: "claude-sonnet-4-6" }, effort: { source: "pinned", value: "high" },
    });
    expect(result.policyTranslation.diagnostics).toContainEqual(expect.objectContaining({ agent: scout.spec.name, code: "resource-deny-widened", tools: ["Skill"] }));
  });
  test("CC unsupported pinned provider/variant fail rather than inheriting parent selection", async () => {
    const policy = await source("scout-crew"), scout = await source("scout");
    scout.model = { providerID: "openai", id: "gpt-example", variant: "high" };
    expect(() => claudeExecutionConfiguration({ policy, children: [scout] })).toThrow("cannot map pinned openai");
    scout.model = { providerID: "anthropic", id: "claude-sonnet-4-6", variant: "adaptive-budget" };
    expect(() => claudeExecutionConfiguration({ policy, children: [scout] })).toThrow("no supported Claude effort mapping");
    const override = claudeExecutionConfiguration({ policy, children: [scout], childProfiles: { [scout.spec.name]: { model: "opus", effort: "max" } } });
    expect(override.agents["sane-worker-scout"]).toMatchObject({ model: "opus", effort: "max" });
    expect(override.policyTranslation.children[0]?.model.source).toBe("profile");
    const replacement = claudeExecutionConfiguration({ policy, children: [scout], childProfiles: { [scout.spec.name]: { model: "sonnet" } } });
    expect(replacement.agents["sane-worker-scout"]?.effort).toBeUndefined();
    expect(() => claudeExecutionConfiguration({ policy, children: [scout], childProfiles: { [scout.spec.name]: { model: "openai/gpt-example" } } })).toThrow("unsupported explicit Claude model");
  });
  test("CC resource-level denies conservatively remove a whole tool and report the difference", async () => {
    const policy = await source("scout-crew"), scout = await source("scout");
    scout.permissions = [{ action: "shell", resource: "*", effect: "allow" }, { action: "shell", resource: "rm *", effect: "deny" }];
    const result = claudeExecutionConfiguration({ policy, children: [scout] });
    expect(result.agents["sane-worker-scout"]?.disallowedTools).toEqual(["Bash", "PowerShell"]);
    expect(result.policyTranslation.children[0]?.restrictions[0]).toMatchObject({ translation: "conservative-whole-tool", rule: { resource: "rm *" } });
    expect(JSON.stringify(result.agents["sane-worker-scout"]?.disallowedTools)).not.toContain("Bash(");
    scout.permissions.push({ action: "shell", resource: "*", effect: "allow" });
    expect(claudeExecutionConfiguration({ policy, children: [scout] }).agents["sane-worker-scout"]?.disallowedTools).toBeUndefined();
    scout.permissions = [{ action: "external_directory", resource: "*", effect: "deny" }];
    expect(() => claudeExecutionConfiguration({ policy, children: [scout] })).toThrow("cannot enforce denied external_directory");
  });
  test("CC nested child allowlists disable Agent explicitly instead of claiming Agent(type) works", async () => {
    const policy = await source("implementer"), crew = await source("scout-crew"), scout = await source("scout");
    policy.permissions = [{ action: "subagent", resource: "sane/worker/scout-crew", effect: "allow" }];
    const result = claudeExecutionConfiguration({ policy, children: [crew, scout] });
    expect(result.agents["sane-worker-scout-crew"]?.disallowedTools).toContain("Agent");
    expect(result.policyTranslation.diagnostics).toContainEqual(expect.objectContaining({ agent: crew.spec.name, code: "nested-agent-restriction-widened", tools: ["Agent"] }));
    expect("permissionMode" in result.agents["sane-worker-scout-crew"]!).toBe(false);
  });
  test("all shipped CC role pipelines render with bounded translation evidence", async () => {
    const children = await Promise.all(WORKER_AGENT_IDS.map(role => source(role)));
    const policies = [...children, ...await Promise.all(ASSISTANT_AGENT_IDS.map(role => source(role, "assistant")))];
    for (const policy of policies) {
      const result = claudeExecutionConfiguration({ policy, children });
      expect(result.policyTranslation.schema).toBe(1);
      expect(result.policyTranslation.scope).toBe("native-child-definitions");
      for (const child of result.policyTranslation.children) expect(result.agents[child.nativeId]?.disallowedTools ?? []).toEqual(child.disallowedTools);
    }
  });
});

type Configuration = ReturnType<typeof openCodeExecutionConfiguration> & { readOnly?: boolean };
type Native = { id: string; parentID?: string; location: { directory: string }; agent: string; permissions: OperationPermission[]; metadata: Record<string, unknown>; model?: { providerID: string; id: string; variant?: string } };
type Event = { sessionID: string; agent: string; options: Record<string, unknown>; system: { type: string; text: string }[] };
type Agent = { system?: string; mode?: string; permissions?: OperationPermission[]; description?: string; hidden?: boolean; model?: unknown };
function runtime(options: { old?: boolean; directory?: string; missingCreate?: boolean; normalize?: boolean; failModelOnce?: boolean; failReadyOnce?: boolean; abortAfterAgent?: AbortController } = {}) {
  let configure!: (input: Configuration, call: { signal: AbortSignal }) => Promise<unknown>;
  let hook!: (event: Event) => Promise<void>;
  let transform: ((editor: { get: (id: string) => Agent | undefined; update: (id: string, fn: (draft: Agent) => void) => void }) => void) | undefined;
  const calls: string[] = [];
  const original = new Map<string, Agent>([["build", { system: "Ordinary", mode: "primary" }], ["sane/worker/scout", { system: "User customized scout", mode: "subagent" }]]);
  let catalog = new Map(original);
  const storage = new Map<string, unknown>();
  const sessions = new Map<string, Native>(["one", "two"].map(id => [id, { id, location: { directory: options.directory ?? "/repo" }, agent: "build", permissions: [], metadata: {} }]));
  const reload = async () => {
    catalog = new Map(structuredClone([...original]));
    transform?.({ get: id => catalog.get(id), update: (id, fn) => { if (options.missingCreate && !catalog.has(id)) return; const draft = catalog.get(id) ?? {}; fn(draft); catalog.set(id, draft); } });
    if (options.normalize) for (const [id, agent] of catalog) if (id.startsWith("sane-")) {
      agent.permissions = [...(agent.permissions ?? []), { action: "browser", resource: "*", effect: "deny" }];
      if (agent.model) agent.model = { ...(agent.model as object), variant: (agent.model as { variant?: string }).variant ?? "default" };
    }
  };
  const ctx = {
    app: { version: options.old ? "2.0.8" : "2.0.26" },
    location: { directory: "/repo" },
    storage: {
      scan: async ({ prefix }: { prefix: string }) => ({ entries: [...storage].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) }),
      set: async (key: string, value: { state: string }) => { calls.push("storage"); if (options.failReadyOnce && value.state === "ready") { options.failReadyOnce = false; throw new Error("Commit interrupted"); } storage.set(key, structuredClone(value)); },
    },
    rpc: { register: async (_definition: unknown, methods: { configure: typeof configure }) => { configure = methods.configure; return { dispose: async () => { calls.push("dispose-rpc"); } }; } },
    agent: { get: async ({ agentID }: { agentID: string }) => { const data = catalog.get(agentID); if (!data) throw new Error("Missing agent"); return { data }; }, reload,
      transform: async (fn: typeof transform) => { transform = fn; await reload(); return { dispose: async () => { transform = undefined; await reload(); } }; } },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => structuredClone(sessions.get(sessionID)!),
      update: async ({ sessionID, ...update }: { sessionID: string; permissions?: OperationPermission[]; metadata?: Record<string, unknown> }) => { Object.assign(sessions.get(sessionID)!, structuredClone(update)); calls.push("permissions"); },
      switchModel: async ({ sessionID, model }: { sessionID: string; model: Native["model"] }) => { calls.push("model"); if (options.failModelOnce) { options.failModelOnce = false; throw new Error("Model selection interrupted"); } sessions.get(sessionID)!.model = options.normalize && model ? { ...model, variant: model.variant ?? "default" } : model; },
      switchAgent: async ({ sessionID, agent }: { sessionID: string; agent: string }) => { sessions.get(sessionID)!.agent = agent; calls.push("agent"); options.abortAfterAgent?.abort(); },
      hook: async (_event: string, callback: typeof hook) => { hook = callback; return { dispose: async () => { calls.push("dispose-hook"); } }; },
    },
  } as unknown as Parameters<typeof registerExecutionOperations>[0];
  return { ctx, calls, sessions, original, storage, catalog: () => catalog, reload, configure: (input: Configuration, signal = new AbortController().signal) => configure(input, { signal }), hook: (event: Event) => hook(event),
    inventory: (id: string, action = "edit") => { const session = sessions.get(id)!; let effect = "allow"; for (const rule of [...(catalog.get(session.agent)?.permissions ?? []), ...session.permissions]) if ((rule.action === "*" || rule.action === action) && rule.resource === "*") effect = rule.effect; return effect; },
    child: (id: string, parentID: string, agent: string) => { sessions.set(id, { id, parentID, agent, location: { directory: "/repo" }, metadata: {}, permissions: structuredClone(sessions.get(parentID)!.permissions) }); } };
}
const event = (sessionID: string, agent = "build"): Event => ({ sessionID, agent, options: {}, system: [] });

describe("OC private execution RPC", () => {
  test("first inventory uses each agent's policy and child overrides survive continuations", async () => {
    const fake = runtime(), dispose = await registerExecutionOperations(fake.ctx);
    const policy = await source("implementer"), children = [await source("scout"), await source("researcher")];
    const config = openCodeExecutionConfiguration({ policy, children, sessionID: "one", directory: "/repo" });
    await fake.configure(config);
    const id = config.delegation["sane/worker/scout"]!;
    fake.child("child", "one", id);
    // Mirrors native order: registry inventory is captured BEFORE context hooks.
    expect(fake.inventory("one")).toBe("allow");
    expect(fake.inventory("child")).toBe("deny");
    expect(fake.sessions.get("one")!.permissions).toEqual([]);
    const override = { action: "read", resource: "/private/*", effect: "deny" as const };
    fake.sessions.get("child")!.permissions.push(override);
    fake.calls.length = 0;
    await fake.hook(event("child", id)); await fake.hook(event("child", id));
    expect(fake.sessions.get("child")!.permissions).toEqual([override]);
    expect(fake.calls).toEqual([]);
    await dispose();
  });
  test("accepts native default variant/browser deny, rejects broader normalization", async () => {
    const authored: OperationPermission[] = [{ action: "edit", resource: "*", effect: "deny" }];
    expect(executionPermissionsMatch([...authored, { action: "browser", resource: "*", effect: "deny" }], authored)).toBe(true);
    expect(executionPermissionsMatch([...authored, { action: "edit", resource: "*", effect: "allow" }], authored)).toBe(false);
    expect(executionPermissionsMatch([...authored, { action: "read", resource: "*", effect: "deny" }], authored)).toBe(false);
    expect(executionPermissionsMatch([{ action: "browser", resource: "*", effect: "deny" }, ...authored], authored)).toBe(false);
    expect(executionModelMatches({ providerID: "openai", id: "test", variant: "high" }, { providerID: "openai", id: "test" })).toBe(false);
    const fake = runtime({ normalize: true }), dispose = await registerExecutionOperations(fake.ctx);
    const config = openCodeExecutionConfiguration({ policy: await source("scout"), sessionID: "one", directory: "/repo", model: "openai/test" });
    const receipt = await fake.configure(config);
    expect(receipt).toMatchObject({ agent: config.executionAgent, executionAgent: config.executionAgent });
    fake.calls.length = 0;
    await fake.configure({ ...config, readOnly: true });
    expect(fake.calls).toEqual([]);
    await dispose();
  });
  test("partial native selection stays pending and idle retry recovers after restart", async () => {
    const fake = runtime({ failModelOnce: true }), dispose = await registerExecutionOperations(fake.ctx);
    const config = openCodeExecutionConfiguration({ policy: await source("scout"), sessionID: "one", directory: "/repo", model: "openai/test" });
    await expect(fake.configure(config)).rejects.toThrow("Model selection interrupted");
    expect(fake.sessions.get("one")!.agent).toBe(config.executionAgent);
    await expect(fake.hook(event("one", config.executionAgent))).rejects.toThrow("incomplete");
    await dispose();
    const resumed = await registerExecutionOperations(fake.ctx);
    await expect(fake.configure({ ...config, readOnly: true })).rejects.toThrow("idle reconfiguration");
    await fake.configure(config); await fake.configure({ ...config, readOnly: true });
    expect(fake.calls).not.toContain("permissions");
    await resumed();
  });
  test("cancellation after agent selection withholds model selection and leaves retryable intent", async () => {
    const controller = new AbortController(), fake = runtime({ abortAfterAgent: controller });
    const dispose = await registerExecutionOperations(fake.ctx);
    const config = openCodeExecutionConfiguration({ policy: await source("scout"), sessionID: "one", directory: "/repo", model: "openai/test" });
    await expect(fake.configure(config, controller.signal)).rejects.toThrow();
    expect(fake.calls).not.toContain("model");
    await expect(fake.configure({ ...config, readOnly: true })).rejects.toThrow("idle reconfiguration");
    await fake.configure(config); // fresh request signal; retry is not poisoned by cancellation
    await fake.configure({ ...config, readOnly: true });
    await dispose();
  });
  test("legacy metadata-only crash and full old policy recover without assuming atomic writes", async () => {
    const baseline = [{ action: "read", resource: "secret", effect: "deny" as const }];
    const managed = [{ action: "edit", resource: "*", effect: "allow" as const }, ...baseline];
    for (const current of [baseline, managed]) {
      const fake = runtime(), session = fake.sessions.get("one")!;
      session.permissions = structuredClone(current);
      session.metadata = { saneCanonicalExecution: { schema: 1, root: "one", permissions: baseline }, saneCanonicalPermissions: managed };
      const dispose = await registerExecutionOperations(fake.ctx);
      const config = openCodeExecutionConfiguration({ policy: await source("scout"), sessionID: "one", directory: "/repo" });
      await fake.configure(config); await fake.configure(config);
      expect(session.permissions).toEqual(baseline);
      expect(session.metadata.saneCanonicalPermissions).toEqual(managed);
      await dispose();
    }
  });
  test("a legacy child's inherited managed layer is blocked, never rewritten after inventory", async () => {
    const fake = runtime(), session = fake.sessions.get("one")!;
    const retired: OperationPermission[] = [{ action: "edit", resource: "*", effect: "allow" }];
    session.permissions = retired;
    session.metadata = { saneCanonicalExecution: { schema: 1, root: "one", permissions: [] }, saneCanonicalPermissions: retired };
    const dispose = await registerExecutionOperations(fake.ctx);
    const config = openCodeExecutionConfiguration({ policy: await source("scout-crew"), children: [await source("scout")], sessionID: "one", directory: "/repo" });
    await fake.configure(config);
    const id = config.nativeChildren[0]!.id;
    fake.child("old-child", "one", id); fake.sessions.get("old-child")!.permissions = structuredClone(retired);
    fake.calls.length = 0;
    await expect(fake.hook(event("old-child", id))).rejects.toThrow("legacy managed permissions");
    expect(fake.calls).toEqual([]);
    expect(fake.sessions.get("old-child")!.permissions).toEqual(retired);
    await dispose();
  });
  test("invalid native-child aliases fail before session or registry mutations", async () => {
    const fake = runtime(), dispose = await registerExecutionOperations(fake.ctx);
    const config = openCodeExecutionConfiguration({ policy: await source("scout-crew"), children: [await source("scout")], sessionID: "one", directory: "/repo" });
    config.nativeChildren[0]!.id = "build";
    await expect(fake.configure(config)).rejects.toThrow("native-child identifier");
    expect(fake.calls).toEqual([]);
    await dispose();
  });
  test("queued verification is read-only and refuses absent or altered configuration", async () => {
    const fake = runtime(), dispose = await registerExecutionOperations(fake.ctx);
    const config = openCodeExecutionConfiguration({ policy: await source("scout"), sessionID: "one", directory: "/repo" });
    await expect(fake.configure({ ...config, readOnly: true })).rejects.toThrow("idle reconfiguration");
    expect(fake.calls).toEqual([]);
    await fake.configure(config);
    fake.calls.length = 0;
    await fake.configure({ ...config, readOnly: true });
    expect(fake.calls).toEqual([]);
    fake.catalog().get(config.executionAgent)!.permissions!.push({ action: "edit", resource: "*", effect: "allow" });
    await expect(fake.configure({ ...config, readOnly: true })).rejects.toThrow("verification failed");
    expect(fake.calls).toEqual([]);
    await dispose();
  });
  test("options stay session-private and lifecycle cleanup disposes hooks", async () => {
    const fake = runtime(), dispose = await registerExecutionOperations(fake.ctx);
    const config = openCodeExecutionConfiguration({ policy: await source("scout"), sessionID: "one", directory: "/repo", model: "openai/test" });
    await fake.configure(config);
    const owned = event("one", config.executionAgent), ordinary = event("two");
    await fake.hook(owned); await fake.hook(ordinary);
    expect(owned.options).toEqual({ temperature: 0.1 }); expect(ordinary.options).toEqual({});
    expect(fake.calls).toEqual(["storage", "agent", "model", "storage"]);
    await dispose();
    expect(fake.calls.slice(-2)).toEqual(["dispose-hook", "dispose-rpc"]);
  });
  test("location mismatch and missing runtime capability fail before mutations", async () => {
    const config = openCodeExecutionConfiguration({ policy: await source("scout"), sessionID: "one", directory: "/repo" });
    for (const options of [{ old: true }, { directory: "/other" }]) {
      const fake = runtime(options), dispose = await registerExecutionOperations(fake.ctx);
      await expect(fake.configure(config)).rejects.toThrow();
      expect(fake.calls).toEqual([]); await dispose();
    }
  });
  test("creates/replays empty native child definitions without replacing user agents", async () => {
    const fake = runtime(), dispose = await registerExecutionOperations(fake.ctx);
    const policy = await source("scout-crew"), children = [await source("scout")];
    children[0]!.model = { providerID: "openai", id: "child-model", variant: "high" };
    const config = openCodeExecutionConfiguration({ policy, children, sessionID: "one", directory: "/repo" });
    await fake.configure(config); await fake.reload();
    const id = config.nativeChildren[0]!.id;
    expect(fake.catalog().get(id)?.system).toBe("");
    expect(fake.catalog().get(id)?.model).toEqual(children[0]!.model);
    expect(fake.catalog().get("sane/worker/scout")?.system).toBe("User customized scout");
    fake.child("child", "one", id);
    const request = event("child", id); await fake.hook(request);
    expect(request.system).toEqual([{ type: "text", text: children[0]!.spec.body }]);
    expect(fake.sessions.get("child")!.permissions).toEqual([]);
    fake.child("foreign", "two", id);
    await expect(fake.hook(event("foreign", id))).rejects.toThrow("not authorized");
    await dispose(); expect(fake.catalog().has(id)).toBe(false);
    const resumed = await registerExecutionOperations(fake.ctx);
    await fake.configure({ ...config, readOnly: true });
    const recovered = event("child", id); await fake.hook(recovered);
    expect(recovered.system).toEqual(request.system);
    await resumed();
  });
  test("genuine session overrides survive replay/restart without being rewritten", async () => {
    const fake = runtime(), initial = { action: "shell", resource: "rm *", effect: "deny" as const };
    fake.sessions.get("one")!.permissions = [initial];
    const config = openCodeExecutionConfiguration({ policy: await source("scout"), sessionID: "one", directory: "/repo" });
    const dispose = await registerExecutionOperations(fake.ctx);
    await fake.configure(config); await fake.configure(config); await dispose();
    const resumed = await registerExecutionOperations(fake.ctx);
    await fake.hook(event("one", config.executionAgent));
    await fake.configure(config);
    expect(fake.sessions.get("one")!.permissions).toEqual([initial]);
    const approval = { action: "read", resource: "/outside/*", effect: "allow" as const };
    fake.sessions.get("one")!.permissions.push(approval);
    await fake.configure(config); await fake.configure(config);
    expect(fake.sessions.get("one")!.permissions).toEqual([initial, approval]);
    expect(fake.calls).not.toContain("permissions");
    await resumed();
  });
  test("cancelled configuration and missing agent creation fail closed", async () => {
    const config = openCodeExecutionConfiguration({ policy: await source("scout-crew"), children: [await source("scout")], sessionID: "one", directory: "/repo" });
    const fake = runtime({ missingCreate: true }), dispose = await registerExecutionOperations(fake.ctx);
    const aborted = new AbortController(); aborted.abort();
    await expect(fake.configure(config, aborted.signal)).rejects.toThrow(); expect(fake.calls).toEqual([]);
    await expect(fake.configure(config)).rejects.toThrow("Missing agent");
    await expect(fake.hook(event("one"))).rejects.toThrow("incomplete");
    expect(fake.catalog().size).toBe(2); await dispose();
  });
  test("alias collisions preserve existing catalogs and raw HTTP uses the authenticated RPC envelope", async () => {
    const config = openCodeExecutionConfiguration({ policy: await source("scout-crew"), children: [await source("scout")], sessionID: "one", directory: "/repo" });
    const fake = runtime(); fake.original.set(config.nativeChildren[0]!.id, { system: "Existing" });
    const dispose = await registerExecutionOperations(fake.ctx);
    await expect(fake.configure(config)).rejects.toThrow("alias collision");
    expect(fake.catalog().get(config.nativeChildren[0]!.id)?.system).toBe("Existing");
    expect(openCodeExecutionRpcRequest(config)).toEqual({ method: "POST", path: "/api/rpc/sane-execution/configure?location%5Bdirectory%5D=%2Frepo", body: { input: config } });
    await dispose();
  });
  test("ready commit interruption is recoverable after restart without metadata/permission writes", async () => {
    const fake = runtime({ failReadyOnce: true }), dispose = await registerExecutionOperations(fake.ctx);
    const config = openCodeExecutionConfiguration({ policy: await source("engineering", "assistant"), sessionID: "one", directory: "/repo" });
    expect(config.nativeChildren).toEqual([]);
    await expect(fake.configure(config)).rejects.toThrow("Commit interrupted");
    await expect(fake.hook(event("one"))).rejects.toThrow("incomplete");
    await dispose();
    const resumed = await registerExecutionOperations(fake.ctx);
    await expect(fake.configure({ ...config, readOnly: true })).rejects.toThrow("idle reconfiguration");
    await fake.configure(config); await fake.hook(event("one", config.executionAgent));
    expect(fake.calls).not.toContain("permissions");
    await resumed();
  });
  test("nested native children require every actual parent edge and receive only their own role", async () => {
    const policy = await source("implementer"), crew = await source("scout-crew"), scout = await source("scout");
    policy.permissions = [{ action: "subagent", resource: "*", effect: "deny" }, { action: "subagent", resource: "sane/worker/scout-crew", effect: "allow" }];
    const config = openCodeExecutionConfiguration({ policy, children: [crew, scout], sessionID: "one", directory: "/repo" });
    const fake = runtime(), dispose = await registerExecutionOperations(fake.ctx);
    await fake.configure(config);
    const crewId = config.delegation[crew.spec.name]!, scoutId = config.delegation[scout.spec.name]!;
    fake.child("crew", "one", crewId); fake.child("scout", "crew", scoutId);
    const crewRequest = event("crew", crewId); await fake.hook(crewRequest);
    expect(crewRequest.system[1]?.text).toContain(scoutId);
    const scoutRequest = event("scout", scoutId); await fake.hook(scoutRequest);
    expect(scoutRequest.system).toEqual([{ type: "text", text: scout.spec.body }]);
    fake.child("wrong", "one", scoutId);
    await expect(fake.hook(event("wrong", scoutId))).rejects.toThrow("not authorized");
    await dispose();
  });
});
