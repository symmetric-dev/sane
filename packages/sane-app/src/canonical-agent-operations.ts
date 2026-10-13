import { ccAgentName, parseSaneAgent, type SaneAgentSpec } from "../../sane-cli/src/agent-serialization";
import { injectAgentModel, type AgentModelOverride } from "../../sane-cli/src/agent-model-config";
import { WORKER_AGENT_IDS } from "sane-core/agent-catalog";
import { createHash } from "node:crypto";
import { managedScoutCrew } from "./scout-crew-lifecycle";

export type OperationPermission = { action: string; resource: string; effect: "allow" | "ask" | "deny" };
export type OperationModel = { providerID: string; id: string; variant?: string };
export type CanonicalAgentOperations = {
  schema: 1;
  source: { markdown: string; modelOverride?: AgentModelOverride };
  spec: SaneAgentSpec;
  permissions: OperationPermission[];
  temperature?: number;
  model?: OperationModel;
};
export type OpenCodeExecutionConfiguration = {
  sessionID: string;
  directory: string;
  /** Actual generated primary ID; initial native session creation can use build. */
  agent: string;
  executionAgent: string;
  permissions: OperationPermission[];
  model?: OperationModel;
  /** Legacy wire/storage field only. New renders omit authored temperature. */
  temperature?: number;
  nativeChildren: { id: string; canonicalId: string; description: string; system: string; permissions: OperationPermission[]; model?: OperationModel; temperature?: number; children: string[] }[];
  delegation: Record<string, string>;
  directChildren: string[];
};

const mapping = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const effect = (value: unknown): OperationPermission["effect"] => {
  if (value !== "allow" && value !== "ask" && value !== "deny") throw new Error("Unsupported canonical permission effect");
  return value;
};
const action = (name: string) => ({ bash: "shell", task: "subagent", write: "edit", patch: "edit" }[name] ?? name);
export function operationModel(value: string, effort?: string): OperationModel {
  const match = /^([^/\s#]+)\/([^\s#]+)(?:#([^\s#]+))?$/.exec(value);
  if (!match || effort !== undefined && !/^[^\s#]+$/.test(effort)) throw new Error("Invalid canonical model or variant");
  const variant = effort ?? match[3];
  return { providerID: match[1]!, id: match[2]!, ...(variant ? { variant } : {}) };
}

/** Pure, serializable policy snapshot from authored Markdown, never installed files.
 * The supported subset is deliberately explicit: new execution fields must not silently disappear.
 * OC migration reference: https://opencode.ai/v2/docs/migrate-v1#agents-and-modes */
export function parseCanonicalAgentOperations(content: string, name: string, override?: AgentModelOverride): CanonicalAgentOperations {
  if (!/^sane\/(assistant|worker)\/[a-z][a-z-]*$/.test(name)) throw new Error("Invalid canonical agent name");
  const rendered = injectAgentModel(content, override), spec = parseSaneAgent(rendered, name);
  const match = /^\uFEFF?---\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(rendered)!;
  const metadata = Bun.YAML.parse(match[1]!) as Record<string, unknown>;
  const supported = new Set(["description", "mode", "temperature", "permission", "permissions", "model", "variant"]);
  for (const key of Object.keys(metadata)) if (!supported.has(key)) throw new Error(`Unsupported canonical execution field: ${key}`);
  if (metadata.temperature !== undefined && (typeof metadata.temperature !== "number" || !Number.isFinite(metadata.temperature))) throw new Error("Invalid canonical temperature");
  if (metadata.variant !== undefined && typeof metadata.variant !== "string") throw new Error("Invalid canonical variant");
  if (metadata.model !== undefined && typeof metadata.model !== "string") throw new Error("Invalid canonical model");
  if (metadata.variant !== undefined && metadata.model === undefined) throw new Error("Canonical variant requires a model");
  const permissions: OperationPermission[] = [];
  if (metadata.permissions !== undefined) {
    if (metadata.permission !== undefined || !Array.isArray(metadata.permissions)) throw new Error("Mixed or invalid canonical permissions");
    for (const rule of metadata.permissions) {
      if (!mapping(rule) || typeof rule.action !== "string" || typeof rule.resource !== "string") throw new Error("Invalid canonical permission rule");
      permissions.push({ action: rule.action, resource: rule.resource, effect: effect(rule.effect) });
    }
  } else if (metadata.permission !== undefined) {
    if (!mapping(metadata.permission)) throw new Error("Invalid canonical permissions");
    for (const [tool, decision] of Object.entries(metadata.permission)) {
      if (mapping(decision)) for (const [resource, value] of Object.entries(decision)) permissions.push({ action: action(tool), resource, effect: effect(value) });
      else permissions.push({ action: action(tool), resource: "*", effect: effect(decision) });
    }
  }
  return { schema: 1, source: { markdown: content, ...(override === undefined ? {} : { modelOverride: structuredClone(override) }) }, spec, permissions, ...(spec.temperature === undefined ? {} : { temperature: spec.temperature }), ...(typeof metadata.model === "string" ? { model: operationModel(metadata.model, metadata.variant as string | undefined) } : {}) };
}

const matches = (pattern: string, value: string) => new RegExp(`^${pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(value);
export function requiredNativeChildren(policy: CanonicalAgentOperations): string[] {
  return WORKER_AGENT_IDS.map(role => `sane/worker/${role}`).filter(id => {
    // Broad permission to use ordinary subagents is not a declaration that every
    // SANE worker must be installed. Provision only explicitly authored delegates.
    let allowed = false;
    for (const rule of policy.permissions) if (matches(rule.action, "subagent") && matches(rule.resource, id)) {
      if (rule.effect === "deny") allowed = false;
      else if (rule.action === "subagent" && rule.resource.startsWith("sane/worker/")) allowed = true;
    }
    return allowed;
  });
}

/** Rewrite references without changing the pinned authored source. */
export function rewriteOperationDelegation(text: string, aliases: Record<string, string>): string {
  return text.replace(/sane\/worker\/[a-z][a-z-]*/g, id => aliases[id] ?? id);
}
function childClosure(policy: CanonicalAgentOperations, supplied: CanonicalAgentOperations[] = []): CanonicalAgentOperations[] {
  const found = new Map<string, CanonicalAgentOperations>();
  const visit = (parent: CanonicalAgentOperations) => {
    for (const id of requiredNativeChildren(parent)) {
      if (found.has(id)) continue;
      const child = supplied.find(item => item.spec.name === id);
      if (!child) throw new Error(`Canonical native child policy required: ${id}`);
      found.set(id, child); visit(child);
    }
  };
  visit(policy); return [...found.values()];
}
/** Generated IDs are root/policy-specific and never replace existing native IDs.
 * Empty catalog prompts are populated only after verifying native ancestry. */
export function openCodeExecutionConfiguration(input: {
  policy: CanonicalAgentOperations; sessionID: string; directory: string;
  children?: CanonicalAgentOperations[]; model?: string; effort?: string; defaultModel?: OperationModel;
}): OpenCodeExecutionConfiguration {
  const { policy } = input;
  let model = input.model ? operationModel(input.model, input.effort) : policy.model ?? input.defaultModel;
  if (!input.model && input.effort) {
    if (!model) throw new Error("Select a model before selecting a variant");
    model = operationModel(`${model.providerID}/${model.id}`, input.effort);
  }
  const children = childClosure(policy, input.children);
  const prefix = createHash("sha256").update(JSON.stringify([input.sessionID, input.directory, children])).digest("hex");
  const delegation = Object.fromEntries(children.map(child => [child.spec.name, `sane-private-${prefix}-${child.spec.name.split("/").at(-1)}`]));
  const rewritePermissions = (rules: OperationPermission[]) => rules.flatMap(rule => {
    if (rule.action !== "subagent" || !rule.resource.startsWith("sane/worker/")) return [{ ...rule }];
    const aliases = Object.entries(delegation).filter(([id]) => matches(rule.resource, id)).map(([, id]) => ({ ...rule, resource: id }));
    return rule.effect === "deny" ? [{ ...rule }, ...aliases] : aliases;
  });
  const nativeChildren = children.map(child => ({ id: delegation[child.spec.name]!, canonicalId: child.spec.name, description: child.spec.description,
    system: rewriteOperationDelegation(child.spec.body, delegation), permissions: rewritePermissions(child.permissions),
    ...(child.model ? { model: child.model } : {}),
    children: requiredNativeChildren(child).map(id => delegation[id]!) }));
  const executionAgent = `sane-execution-${createHash("sha256").update(JSON.stringify([input.sessionID, input.directory, policy, children])).digest("hex")}`;
  return { sessionID: input.sessionID, directory: input.directory, agent: executionAgent, executionAgent, permissions: rewritePermissions(policy.permissions), nativeChildren, delegation,
    directChildren: requiredNativeChildren(policy).map(id => delegation[id]!),
    ...(model ? { model: { ...model } } : {}) };
}

export type ClaudeChildProfile = { model?: string; effort?: "low" | "medium" | "high" | "xhigh" | "max" };
export type ClaudePolicyDiagnostic = {
  agent: string;
  code: "resource-deny-widened" | "nested-agent-restriction-widened" | "headless-ask-to-allow" | "temperature-unavailable";
  message: string;
  rule?: OperationPermission;
  tools?: string[];
};
export class ClaudeCanonicalPolicyError extends Error {
  constructor(readonly code: "unsupported-model" | "unsupported-effort" | "unsupported-restriction", readonly agent: string, detail: string) {
    super(`Canonical Claude child ${agent}: ${detail}`);
  }
}
export type ClaudeChildPolicyEvidence = {
  canonicalId: string; nativeId: string;
  model: { source: "pinned" | "profile" | "native-inheritance"; value?: string };
  effort: { source: "pinned" | "profile" | "native-inheritance"; value?: string };
  disallowedTools: string[];
  restrictions: { rule: OperationPermission; tools: string[]; translation: "whole-tool" | "conservative-whole-tool" }[];
};
export type ClaudePolicyTranslation = {
  schema: 1;
  scope: "native-child-definitions";
  parentPermissions: "legacy-headless-settings";
  children: ClaudeChildPolicyEvidence[];
  diagnostics: ClaudePolicyDiagnostic[];
};

const ccEfforts = new Set(["low", "medium", "high", "xhigh", "max"]);
// No provider remapping: Bedrock/OpenRouter/etc. IDs are not Anthropic CLI IDs.
const ccModel = (value: string) => ["sonnet", "opus", "haiku", "fable", "inherit"].includes(value) || /^claude-[a-z0-9][a-z0-9._-]*(?:\[1m\])?$/.test(value);
function claudeChildModel(child: CanonicalAgentOperations, profile?: ClaudeChildProfile) {
  const id = child.spec.name;
  const explicitModel = profile?.model !== undefined;
  let model: string | undefined;
  if (explicitModel) {
    if (!ccModel(profile.model!)) throw new ClaudeCanonicalPolicyError("unsupported-model", id, `unsupported explicit Claude model ${JSON.stringify(profile.model)}`);
    model = profile.model;
  } else if (child.model) {
    if (child.model.providerID !== "anthropic" || !/^claude-[a-z0-9][a-z0-9._-]*(?:\[1m\])?$/.test(child.model.id)) {
      throw new ClaudeCanonicalPolicyError("unsupported-model", id, `cannot map pinned ${child.model.providerID}/${child.model.id} to a Claude native model; configure an explicit supported child profile`);
    }
    model = child.model.id;
  }
  // An explicit replacement model never inherits another model's variant.
  const effort = profile?.effort ?? (explicitModel ? undefined : child.model?.variant);
  if (effort !== undefined && !ccEfforts.has(effort)) throw new ClaudeCanonicalPolicyError("unsupported-effort", id, `pinned/profile variant ${JSON.stringify(effort)} has no supported Claude effort mapping`);
  return {
    fields: { ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) },
    model: { source: explicitModel ? "profile" as const : model ? "pinned" as const : "native-inheritance" as const, ...(model === undefined ? {} : { value: model }) },
    effort: { source: profile?.effort !== undefined ? "profile" as const : effort ? "pinned" as const : "native-inheritance" as const, ...(effort === undefined ? {} : { value: effort }) },
  };
}

const ccChildTools: Readonly<Record<string, readonly string[]>> = {
  ask: ["AskUserQuestion"], question: ["AskUserQuestion"], read: ["Read"], glob: ["Glob"], grep: ["Grep"], list: ["Glob"],
  edit: ["Edit", "Write", "NotebookEdit"], shell: ["Bash", "PowerShell"], webfetch: ["WebFetch"], websearch: ["WebSearch"], skill: ["Skill"], subagent: ["Agent"],
};

/** CC child definitions accept tool names, not permission rules. Resource-scoped
 * disallowedTools entries remove the entire tool; Agent(type) restrictions are
 * ineffective in nested children. Widen those denies explicitly, never weaken
 * them. Unknown restrictive actions cannot be mapped safely and fail closed.
 * https://code.claude.com/docs/en/sub-agents#available-tools */
function claudeChildRestrictions(child: CanonicalAgentOperations, diagnostics: ClaudePolicyDiagnostic[]) {
  const disallowed = new Set<string>();
  const restrictions: ClaudeChildPolicyEvidence["restrictions"] = [];
  for (const [index, rule] of child.permissions.entries()) {
    if (rule.effect === "allow") continue;
    const later = child.permissions.slice(index + 1);
    // Exact or unconditional later rules can fully supersede this restriction.
    // Overlapping non-identical resource patterns are conservatively restricted.
    if (later.some(next => (next.action === rule.action || next.action === "*") && (next.resource === rule.resource || next.resource === "*") && next.effect !== "deny")) continue;
    if (rule.effect === "ask") {
      diagnostics.push({ agent: child.spec.name, code: "headless-ask-to-allow", rule: { ...rule }, message: "Child inherits the parent's headless permission mode; authored ask is not an independent approval boundary." });
      continue;
    }
    const tools = ccChildTools[rule.action];
    if (!tools) throw new ClaudeCanonicalPolicyError("unsupported-restriction", child.spec.name, `cannot enforce denied ${rule.action}:${rule.resource} with documented Claude child tool restrictions`);
    const exceptions = later.some(next => matches(next.action, rule.action) && next.effect !== "deny");
    const conservative = rule.resource !== "*" || exceptions;
    for (const tool of tools) disallowed.add(tool);
    restrictions.push({ rule: { ...rule }, tools: [...tools], translation: conservative ? "conservative-whole-tool" : "whole-tool" });
    if (conservative) diagnostics.push({ agent: child.spec.name,
      code: rule.action === "subagent" ? "nested-agent-restriction-widened" : "resource-deny-widened", rule: { ...rule }, tools: [...tools],
      message: rule.action === "subagent" ? "Claude cannot enforce a nested Agent(type) allowlist. The entire Agent tool is disabled for this child, including allowed exceptions."
        : `Claude child definitions cannot enforce this resource rule independently. Disabled the whole ${tools.join("/")} tool, including otherwise allowed resources.` });
  }
  if (child.temperature !== undefined) diagnostics.push({ agent: child.spec.name, code: "temperature-unavailable", message: `App-managed execution does not send temperature; authored temperature ${child.temperature} is retained only in the policy snapshot.` });
  return { disallowedTools: [...disallowed].sort(), restrictions };
}

/** CC's documented --agents definitions are launch-scoped. The selected role is
 * delivered by the App's standing context exactly once; native children retain
 * their actual role prompts, without App worker procedures or assignments.
 * https://code.claude.com/docs/en/cli-reference#cli-flags */
export function claudeExecutionConfiguration(input: {
  policy: CanonicalAgentOperations; children?: CanonicalAgentOperations[]; model?: string; effort?: string;
  childProfiles?: Record<string, ClaudeChildProfile>;
}) {
  const { policy } = input;
  const agents: Record<string, { description: string; prompt: string; model?: string; effort?: string; disallowedTools?: string[] }> = {};
  const diagnostics: ClaudePolicyDiagnostic[] = [];
  const childEvidence: ClaudeChildPolicyEvidence[] = [];
  for (const child of childClosure(policy, input.children)) {
    const id = child.spec.name;
    const selection = claudeChildModel(child, input.childProfiles?.[id]);
    const restriction = claudeChildRestrictions(child, diagnostics);
    const nativeId = ccAgentName(id);
    agents[nativeId] = { description: child.spec.description || child.spec.shortId, prompt: child.spec.body, ...selection.fields,
      ...(restriction.disallowedTools.length ? { disallowedTools: restriction.disallowedTools } : {}) };
    childEvidence.push({ canonicalId: id, nativeId, model: selection.model, effort: selection.effort, ...restriction });
  }
  // A separate execution ID avoids replacing a native child definition when an
  // App worker is itself allowed to launch a child with the same role.
  const agent = "sane-app-execution";
  // Since CC 2.1.281, an empty main-agent prompt preserves the ordinary system
  // prompt. A nonempty placeholder would replace that prompt, changing behavior.
  agents[agent] = { description: "App-managed execution", prompt: "" };
  const { allow, ask, deny } = policy.spec.ccPermissions;
  const permissions = { allow: [...new Set([...allow, ...ask])], ...(deny.length ? { deny: [...deny] } : {}) };
  if (managedScoutCrew(policy)) {
    permissions.deny = [...new Set([...(permissions.deny ?? []), "Agent", "Task"])];
    permissions.allow.push(...["start", "status", "wait", "acknowledge", "cancel", "cancel_all"].map(operation => `mcp__sane__sane_worker_${operation}`));
  }
  const args = ["--agents", JSON.stringify(agents), "--agent", agent];
  if (input.model) args.push("--model", input.model);
  if (input.effort) args.push("--effort", input.effort);
  const policyTranslation: ClaudePolicyTranslation = { schema: 1, scope: "native-child-definitions", parentPermissions: "legacy-headless-settings", children: childEvidence, diagnostics };
  return { agent, agents, args, permissions, injectRole: true as const, minimumVersion: "2.1.281" as const,
    policyTranslation };
}

/** Wire request for the existing authenticated App transport; no client SDK import.
 * Contract: POST /api/rpc/{rpcID}/{method}, {input}, response {output}. */
export function openCodeExecutionRpcRequest(configuration: OpenCodeExecutionConfiguration & { readOnly?: boolean }) {
  return { method: "POST" as const, path: `/api/rpc/sane-execution/configure?location%5Bdirectory%5D=${encodeURIComponent(configuration.directory)}`, body: { input: configuration } };
}
