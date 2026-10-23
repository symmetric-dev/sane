import type { SystemPromptSnapshot } from "../shared/conversation/system-prompt";
import { request } from "./cc-client";
import { active, type Config, type RunMetadata } from "./types";

// Config identity scopes this memory-only cache to an authenticated connection.
// Signing in/reconnecting gets a new config; old entries can be collected.
const caches = new WeakMap<Config, Map<string, SystemPromptSnapshot>>();
const MAX_SNAPSHOTS = 20;

export async function loadSystemPrompt(config: Config, run: RunMetadata, signal: AbortSignal): Promise<SystemPromptSnapshot> {
  if (!config.authenticated || !config.storeId) throw new Error("System prompt storage identity unavailable.");
  let cache = caches.get(config);
  if (!cache) { cache = new Map(); caches.set(config, cache); }
  const key = JSON.stringify([run.conversationId, run.id, run.status]);
  const cached = cache.get(key);
  if (cached && !active(run.status)) return cached;
  const snapshot: SystemPromptSnapshot = await request(`/api/runs/${encodeURIComponent(run.id)}/system-prompt?${new URLSearchParams({ storeId: config.storeId })}`, { signal });
  if (snapshot?.schema !== 1 || snapshot.scope !== "sane" || snapshot.storeId !== config.storeId
    || snapshot.sessionId !== run.conversationId || snapshot.runId !== run.id
    || !["starting", "running", "completed", "failed", "interrupted", "unknown"].includes(snapshot.status)
    || !["recorded", "pending", "unavailable"].includes(snapshot.state)
    || snapshot.state === "recorded" && (typeof snapshot.standing !== "string" || typeof snapshot.injected !== "string"
      || snapshot.nativeRoleReference !== null && typeof snapshot.nativeRoleReference !== "string")) throw new Error("Recorded system prompt response is invalid.");
  // Active runs can still gain preparation evidence. Never freeze a pending
  // response or an in-progress run, and do not retain failures.
  if (!signal.aborted && snapshot.state === "recorded" && !active(snapshot.status)) {
    cache.set(key, snapshot);
    if (cache.size > MAX_SNAPSHOTS) cache.delete(cache.keys().next().value!);
  }
  return snapshot;
}
