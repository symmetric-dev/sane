/** Agent Profile contract shared by the bridge and the browser bundle.
 * No node imports: frontend code imports this file directly.
 *
 * A profile is a configured client: a behaviour (Base = none, or one SANE
 * assistant or worker role) bound to one harness with model/effort defaults and visuals.
 * Base = harness defaults with no SANE instructions; Base builtins allow model,
 * effort and visual edits but keep their harness.
 * Persisted globally in <dataDir>/agents.json. Sessions snapshot the resolved
 * role/model/effort at creation (or on Base -> assistant upgrade); later profile
 * edits only affect new conversations.
 */
import { ASSISTANT_AGENT_DESCRIPTIONS, ASSISTANT_AGENT_IDS, ASSISTANT_AGENT_LABELS, WORKER_AGENT_IDS, WORKER_AGENT_CATALOG, isWorkerAgentId, isAssistantAgentId, nativeAgentId, type SaneAgentIdentity, type WorkerAgentId, type AssistantAgentId } from "sane-core/agent-catalog";
import type { Harness } from "./oc-contract";

export const AGENT_ICON_IDS = [
  "circle", "compass", "pen-tool", "layers", "cpu", "zap", "book-open", "clipboard", "search", "code", "terminal", "tool",
  "target", "flag", "feather", "box", "database", "git-branch", "globe", "shield", "star", "sun", "moon", "coffee",
] as const;
export type AgentIconId = (typeof AGENT_ICON_IDS)[number];

export const AGENT_COLOR_IDS = ["slate", "violet", "blue", "teal", "green", "amber", "orange", "rose"] as const;
export type AgentColorId = (typeof AGENT_COLOR_IDS)[number];
export type AgentColor = AgentColorId | `#${string}`;

export type AgentProfileKind = "base" | "assistant" | "worker";
export type WorkerProfileMappings = Partial<Record<WorkerAgentId, string>>;

export type AgentProfile = {
  id: string;                        // uuid for custom; base:*, template:<assistant>, worker:<worker> for builtins
  kind: AgentProfileKind;
  role: AssistantAgentId | WorkerAgentId | null; // null iff kind === "base"
  workerProfiles?: WorkerProfileMappings; // Execution choices, never an allowlist.
  harness: Harness;
  model: string;                     // "" = configured agent model, then harness default
  effort: string;                    // CC effort or OC variant; "" = default
  label: string;
  description: string;
  icon: AgentIconId;
  color: AgentColor;
  builtin: boolean;                  // seeded; cannot be deleted, can be reset (Base builtins keep a fixed harness)
  locked: boolean;                   // legacy flag; always false (older files had true on Base builtins)
  hidden?: boolean;
  order: number;
  updatedAt: string;
};

export type AgentProfiles = { version: 1; defaultId: string; profiles: AgentProfile[]; workerDefaults?: WorkerProfileMappings };

/** Editable fields accepted by POST/PUT /api/agents. */
export type AgentProfileInput = Partial<Pick<AgentProfile, "label" | "description" | "harness" | "model" | "effort" | "icon" | "color" | "hidden" | "workerProfiles">>;

export const BASE_PROFILE_IDS: Record<Harness, string> = { "claude-code": "base:cc", opencode: "base:oc" };
export const templateProfileId = (role: AssistantAgentId) => `template:${role}`;
export const workerTemplateProfileId = (role: WorkerAgentId) => `worker:${role}`;
export const builtinWorkerDefaults = (): WorkerProfileMappings => Object.fromEntries(WORKER_AGENT_IDS.map(role => [role, workerTemplateProfileId(role)]));

const TEMPLATE_VISUALS: Record<AssistantAgentId, { icon: AgentIconId; color: AgentColorId }> = {
  design: { icon: "pen-tool", color: "violet" },
  engineering: { icon: "cpu", color: "blue" },
  execution: { icon: "zap", color: "orange" },
  knowledge: { icon: "book-open", color: "green" },
  planning: { icon: "clipboard", color: "amber" },
  research: { icon: "search", color: "teal" },
};

/** Builtin template values; used for seeding and for reset. */
export function builtinProfiles(now = new Date().toISOString()): AgentProfile[] {
  const base = (harness: Harness, order: number): AgentProfile => ({
    id: BASE_PROFILE_IDS[harness], kind: "base", role: null, harness, model: "", effort: "",
    label: harness === "opencode" ? "Base · OpenCode" : "Base · Claude Code",
    description: "Harness defaults. No SANE instructions.",
    icon: "circle", color: "slate", builtin: true, locked: false, order, updatedAt: now,
  });
  return [
    base("claude-code", 0), base("opencode", 1),
    ...ASSISTANT_AGENT_IDS.map((role, i): AgentProfile => ({
      id: templateProfileId(role), kind: "assistant", role, harness: "claude-code", model: "", effort: "",
      label: ASSISTANT_AGENT_LABELS[role], description: ASSISTANT_AGENT_DESCRIPTIONS[role],
      ...TEMPLATE_VISUALS[role], builtin: true, locked: false, order: 10 + i, updatedAt: now,
    })),
    ...WORKER_AGENT_IDS.map((role, i): AgentProfile => ({
      id: workerTemplateProfileId(role), kind: "worker", role, harness: "opencode", model: "", effort: "",
      label: WORKER_AGENT_CATALOG[role].label, description: WORKER_AGENT_CATALOG[role].description,
      icon: "tool", color: "slate", builtin: true, locked: false, order: 30 + i, updatedAt: now,
    })),
  ];
}

export function seedAgentProfiles(now?: string): AgentProfiles {
  return { version: 1, defaultId: BASE_PROFILE_IDS["claude-code"], profiles: builtinProfiles(now), workerDefaults: builtinWorkerDefaults() };
}

/** Profile a legacy session (no profileId) maps to. */
export function legacyProfileId(harness: Harness, agent: AssistantAgentId | WorkerAgentId | undefined): string {
  return agent ? isWorkerAgentId(agent) ? workerTemplateProfileId(agent) : templateProfileId(agent) : BASE_PROFILE_IDS[harness];
}

export type AssignCheck = { ok: true } | { ok: false; reason: string };

/** Composer agent transition rule. `current` is the session's profile (undefined for a new conversation).
 * New conversation: visible Base/assistant profiles. Base session: assistant profiles on the same harness.
 * Assistant session: none. */
export function canAssign(current: Pick<AgentProfile, "kind" | "harness"> | undefined, next: Pick<AgentProfile, "kind" | "harness" | "hidden">): AssignCheck {
  if (next.kind === "worker" || current?.kind === "worker") return { ok: false, reason: "Workers are launched through worker orchestration" };
  if (!current) return next.hidden ? { ok: false, reason: "Hidden agent" } : { ok: true };
  if (current.kind === "assistant") return { ok: false, reason: "Session already has an assistant" };
  if (next.kind === "base") return { ok: false, reason: "Session already uses Base" };
  if (next.harness !== current.harness) return { ok: false, reason: "Different harness" };
  return { ok: true };
}

export type ResolvedAgentLaunch = {
  profileId: string;
  harness: Harness;
  identity?: SaneAgentIdentity;
  agent?: string;
  model?: string;
  effort?: string;
};
export class AgentProfileResolutionError extends Error {}
/** Snapshot a profile without inheriting any parent model or effort. */
export function resolveAgentLaunch(profile: AgentProfile): ResolvedAgentLaunch {
  if (profile.harness !== "opencode" && profile.harness !== "claude-code") throw new AgentProfileResolutionError(`Invalid harness for profile ${profile.id}`);
  let identity: SaneAgentIdentity | undefined;
  if (profile.kind === "assistant" && isAssistantAgentId(profile.role)) identity = { kind: "assistant", role: profile.role };
  else if (profile.kind === "worker" && isWorkerAgentId(profile.role)) identity = { kind: "worker", role: profile.role };
  else if (profile.kind !== "base" || profile.role !== null) throw new AgentProfileResolutionError(`Invalid kind/role for profile ${profile.id}`);
  return { profileId: profile.id, harness: profile.harness, ...(identity ? { identity, agent: nativeAgentId(identity, profile.harness) } : {}), ...(profile.model ? { model: profile.model } : {}), ...(profile.effort ? { effort: profile.effort } : {}) };
}
/** Caller mapping wins by presence. An invalid mapping never falls back. */
export function resolveWorkerProfile(profiles: AgentProfiles, role: WorkerAgentId, callerProfileId?: string): ResolvedAgentLaunch {
  if (!isWorkerAgentId(role)) throw new AgentProfileResolutionError(`Unknown worker role: ${role}`);
  const caller = callerProfileId === undefined ? undefined : profiles.profiles.find(p => p.id === callerProfileId);
  if (callerProfileId !== undefined && !caller) throw new AgentProfileResolutionError(`Caller profile ${callerProfileId} is missing; configure its worker mappings`);
  const id = caller?.workerProfiles && Object.hasOwn(caller.workerProfiles, role) ? caller.workerProfiles[role] : profiles.workerDefaults?.[role];
  if (!id) throw new AgentProfileResolutionError(`No profile mapped for worker ${role}; configure workerDefaults or the caller's workerProfiles`);
  const profile = profiles.profiles.find(p => p.id === id);
  if (!profile) throw new AgentProfileResolutionError(`Worker ${role} maps to missing profile ${id}`);
  if (profile.kind !== "worker" || profile.role !== role) throw new AgentProfileResolutionError(`Worker ${role} requires a worker profile for that role; ${id} is incompatible`);
  return resolveAgentLaunch(profile);
}
