import { AppStoreError } from "./app-store";
import { builtinProfiles, BASE_PROFILE_IDS, type AgentProfile, type AgentProfiles } from "./agent-profiles-contract";
import { body, json } from "./bridge-http";

const profileInputKeys = ["label", "description", "harness", "model", "effort", "icon", "color", "hidden", "workerProfiles"];

function applyProfileInput(profile: AgentProfile, input: Record<string, unknown>): AgentProfile {
  const bad = Object.keys(input).find(k => !profileInputKeys.includes(k));
  if (bad) throw new AppStoreError("APP_STORE_CORRUPT", `Unknown agent profile field: ${bad}`);
  const next = { ...profile, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)), updatedAt: new Date().toISOString() } as AgentProfile;
  if (typeof next.label === "string") next.label = next.label.trim();
  if (next.hidden === false) delete next.hidden;
  return next;
}

/** The bridge owns request guards and profile validation, publication and persistence. */
export function createAgentProfileRoute({ readProfiles, commitProfiles }: {
  readProfiles: () => AgentProfiles;
  commitProfiles: (next: AgentProfiles) => Promise<void>;
}): (req: Request, url: URL) => Promise<Response | null> {
  return async (req, url) => {
    const path = url.pathname;
    if (path !== "/api/agents" && !path.startsWith("/api/agents/")) return null;
    try {
      if (path === "/api/agents" && req.method === "GET") return json(readProfiles());
      // Read the body before cloning so concurrent edits never overwrite each other.
      const input = req.method === "PUT" || req.method === "POST" && !path.endsWith("/reset") ? await body(req) : undefined;
      const next = structuredClone(readProfiles());
      if (path === "/api/agents" && req.method === "POST") {
        const { fromId, ...fields } = input ?? {};
        const from = next.profiles.find(p => p.id === fromId);
        if (!from) return json({ error: "Unknown agent profile" }, 404);
        const profile = applyProfileInput({ ...from, id: crypto.randomUUID(), builtin: false, locked: false, order: Math.max(...next.profiles.map(p => p.order)) + 1 }, fields);
        next.profiles.push(profile); await commitProfiles(next);
        return json({ profile });
      }
      if (path === "/api/agents/order" && req.method === "PUT") {
        if (input?.order !== undefined) {
          if (!Array.isArray(input.order) || input.order.length !== next.profiles.length || new Set(input.order).size !== input.order.length || next.profiles.some(p => !input.order.includes(p.id))) return json({ error: "order must list every agent profile id exactly once" }, 400);
          for (const p of next.profiles) p.order = input.order.indexOf(p.id);
        }
        if (input?.defaultId !== undefined) next.defaultId = input.defaultId;
        if (input?.workerDefaults !== undefined) next.workerDefaults = input.workerDefaults;
        await commitProfiles(next);
        return json(readProfiles());
      }
      const match = /^\/api\/agents\/([^/]+)(\/reset)?$/.exec(path);
      const index = match ? next.profiles.findIndex(p => p.id === decodeURIComponent(match[1]!)) : -1;
      if (!match || index < 0) return json({ error: "Unknown agent profile" }, 404);
      const current = next.profiles[index]!;
      if (match[2] && req.method === "POST") {
        if (!current.builtin) return json({ error: "Only builtin profiles can be reset" }, 400);
        const profile = { ...builtinProfiles().find(p => p.id === current.id)!, order: current.order };
        next.profiles[index] = profile; await commitProfiles(next);
        return json({ profile });
      }
      if (!match[2] && req.method === "PUT") {
        if (current.builtin && current.kind === "base" && input?.harness !== undefined && input.harness !== current.harness) return json({ error: "Base profile harness cannot change" }, 400);
        const profile = applyProfileInput(current, input ?? {});
        if (profile.hidden && next.defaultId === profile.id) return json({ error: "The default agent cannot be hidden" }, 400);
        next.profiles[index] = profile; await commitProfiles(next);
        return json({ profile });
      }
      if (!match[2] && req.method === "DELETE") {
        if (current.builtin) return json({ error: "Builtin profiles cannot be deleted" }, 400);
        next.profiles.splice(index, 1);
        if (next.defaultId === current.id) next.defaultId = BASE_PROFILE_IDS["claude-code"];
        await commitProfiles(next);
        return json({ ok: true });
      }
      return json({ error: "Method not allowed" }, 405);
    } catch (error) { if (error instanceof AppStoreError) return json({ error: error.message }, 400); throw error; }
  };
}
