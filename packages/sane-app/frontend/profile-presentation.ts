import { isStoredAssistantAgentId, isWorkerAgentId, WORKER_AGENT_CATALOG } from "sane-core/agent-catalog";
import { profileForSnapshot, storedAssistantLabel, type AgentProfile, type AgentProfiles, type HistoricalAgentProfile } from "../src/agent-profiles-contract";
import type { AgentSnapshot } from "../src/history";
import type { Harness } from "./types";

export type DisplayProfile = AgentProfile | HistoricalAgentProfile;
/** Raw UI evidence stays string-valued; only validated identities enter the resolver. */
export type ProfileSnapshot = { agent?: string; agentKind?: "assistant" | "worker"; nativeAgentSelected?: boolean; profileId?: string; harness?: Harness; model?: string; effort?: string };
export function validatedAgentSnapshot(snapshot: ProfileSnapshot): AgentSnapshot | undefined {
  if (snapshot.agentKind !== undefined && snapshot.agentKind !== "assistant" && snapshot.agentKind !== "worker") return;
  if (snapshot.nativeAgentSelected !== undefined && typeof snapshot.nativeAgentSelected !== "boolean") return;
  const agent = snapshot.agent || undefined;
  if (agent !== undefined) {
    if (snapshot.agentKind === "worker" ? !isWorkerAgentId(agent) : snapshot.agentKind === "assistant" ? !isStoredAssistantAgentId(agent) : !isStoredAssistantAgentId(agent) && !isWorkerAgentId(agent)) return;
    if (isStoredAssistantAgentId(agent) || isWorkerAgentId(agent)) return { agent, agentKind: snapshot.agentKind, nativeAgentSelected: snapshot.nativeAgentSelected };
  }
  if (snapshot.agentKind !== undefined || snapshot.nativeAgentSelected !== undefined) return;
  return {};
}
/** Session evidence wins. An optional fallback must belong to this session. */
export function savedProfileSnapshot(session: ProfileSnapshot, last?: ProfileSnapshot): ProfileSnapshot {
  const identity = session.agent ? session : last?.agent ? last : session;
  return { ...session, profileId: session.profileId ?? last?.profileId, agent: session.agent || last?.agent, agentKind: identity?.agentKind, nativeAgentSelected: identity?.nativeAgentSelected, model: session.model || last?.model, effort: session.effort || last?.effort };
}
export function displayProfile(profiles: AgentProfiles, snapshot: ProfileSnapshot): DisplayProfile | undefined {
  const identity = validatedAgentSnapshot(snapshot);
  if (!identity) return;
  return profileForSnapshot(profiles, { ...snapshot, ...identity, agent: identity.agent });
}
export function profileDisplayLabel(profile: DisplayProfile | undefined, snapshot: ProfileSnapshot): string {
  if (profile) return profile.label;
  const identity = validatedAgentSnapshot(snapshot);
  if (identity?.agent && isStoredAssistantAgentId(identity.agent)) return storedAssistantLabel(identity.agent);
  if (identity?.agent && isWorkerAgentId(identity.agent)) return WORKER_AGENT_CATALOG[identity.agent].label;
  return snapshot.agent || "Base";
}
