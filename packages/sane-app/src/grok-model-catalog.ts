import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicAppRecord } from "./app-store";
import { GrokAcpOperationError, initializeGrokCatalog } from "./grok-acp";
import type { ModelChoice } from "../shared/conversation/types";
import type { ModelCatalog } from "../shared/conversation/model-catalog";

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 200 && !/[\x00-\x1f\x7f]/.test(v);
const TTL = 10 * 60_000;
const FILE = "grok-model-catalog.json";
type Entry = { key: string; fetchedAt: string; models: ModelChoice[] };

/** Decode only the observed ACP modelState shape; preserve native IDs verbatim. */
export function grokModelsFromInitialize(value: unknown): ModelChoice[] {
  if (!object(value) || value.protocolVersion !== 1) throw new Error("Invalid Grok initialize response");
  const meta = object(value._meta) ? value._meta : object(value.meta) ? value.meta : undefined;
  const state = object(meta?.modelState) ? meta.modelState : undefined;
  if (!Array.isArray(state?.availableModels) || state.availableModels.length > 1000) throw new Error("Grok did not advertise a model catalog");
  const models: ModelChoice[] = [], seen = new Set<string>();
  for (const row of state.availableModels) {
    if (!object(row) || !text(row.modelId) || seen.has(row.modelId)) throw new Error("Invalid Grok model catalog entry");
    seen.add(row.modelId);
    const metadata = object(row._meta) ? row._meta : object(row.meta) ? row.meta : {};
    const efforts: ModelChoice["efforts"] = [], effortIds = new Set<string>();
    if (metadata.supportsReasoningEffort !== false && Array.isArray(metadata.reasoningEfforts)) {
      for (const effort of metadata.reasoningEfforts) {
        if (!object(effort)) continue;
        const id = effort.value ?? effort.id;
        if (!text(id) || effortIds.has(id)) continue;
        effortIds.add(id);
        efforts.push({ id, name: text(effort.label) ? effort.label : id });
      }
    }
    models.push({ id: row.modelId, name: text(row.name) ? row.name : row.modelId, efforts,
      ...(typeof metadata.totalContextTokens === "number" && Number.isSafeInteger(metadata.totalContextTokens) && metadata.totalContextTokens > 0
        ? { contextWindow: metadata.totalContextTokens } : {}) });
  }
  if (!models.length) throw new Error("Grok has no advertised models");
  return models;
}

function storedEntry(v: unknown): v is Entry {
  return object(v) && typeof v.key === "string" && /^[a-f0-9]{64}$/.test(v.key) && typeof v.fetchedAt === "string"
    && Number.isFinite(Date.parse(v.fetchedAt)) && Array.isArray(v.models) && v.models.length > 0 && v.models.length <= 1000
    && v.models.every(m => object(m) && text(m.id) && text(m.name) && Array.isArray(m.efforts)
      && m.efforts.every(e => object(e) && text(e.id) && text(e.name))
      && (m.contextWindow === undefined || typeof m.contextWindow === "number" && Number.isSafeInteger(m.contextWindow) && m.contextWindow > 0));
}
function fingerprint(path: string): string {
  try { const s = lstatSync(path, { bigint: true }); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}`; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent"; throw error; }
}

/** App-owned advisory cache. Last-good discovery survives restart, while errors
 * never replace models or mutate profile defaults. There are no repo DB writes. */
export class GrokModelCatalog {
  private entries = new Map<string, Entry>();
  private failures = new Map<string, { error: string; at: number }>();
  private pending = new Map<string, { controller: AbortController; promise: Promise<Entry> }>();
  private closing = false;
  private drained = true;
  constructor(private options: { dataDir: string; executable?: string; homeRoot?: string; authorityId: () => string | undefined; assertOpen: () => void }) {
    try {
      const path = join(options.dataDir, FILE), stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) return;
      const data: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (object(data) && data.version === 1 && Array.isArray(data.entries)) {
        for (const entry of data.entries.slice(-16)) if (storedEntry(entry)) this.entries.set(entry.key, entry);
      }
    } catch { /* Missing/corrupt advisory cache is rediscovered, never a startup failure. */ }
  }
  private scope(cwd: string) {
    const { executable, homeRoot } = this.options, authorityId = this.options.authorityId();
    if (!executable || !homeRoot || !authorityId) throw new Error("Configure the Grok runtime before discovering models");
    // Auth/config fingerprints detect account/config changes without reading or
    // persisting credentials. Cache identity is not native source identity.
    const cwdStat = lstatSync(cwd);
    const key = createHash("sha256").update(JSON.stringify([authorityId, executable, homeRoot, cwd, `${cwdStat.dev}:${cwdStat.ino}`,
      fingerprint(executable), ...["auth.json", "config.toml", "managed_config.toml", "requirements.toml"].map(f => fingerprint(join(homeRoot, f))),
      createHash("sha256").update(process.env.XAI_API_KEY ?? "").digest("hex")])).digest("hex");
    return { key, executable, homeRoot, cwd };
  }
  async read(cwd: string, refresh = false): Promise<ModelCatalog> {
    this.options.assertOpen();
    if (this.closing || !this.drained) throw new Error("Grok model discovery is shutting down or its previous process has not drained");
    const scope = this.scope(cwd), cached = this.entries.get(scope.key), failure = this.failures.get(scope.key);
    const stale = !cached || !!failure || Date.now() - Date.parse(cached.fetchedAt) >= TTL;
    if (cached && !refresh) {
      if (stale && (!failure || Date.now() - failure.at > 60_000)) void this.refresh(scope).catch(() => {});
      return { models: cached.models, fetchedAt: cached.fetchedAt, stale, ...(failure ? { error: failure.error } : {}) };
    }
    try {
      const entry = await this.refresh(scope);
      return { models: entry.models, fetchedAt: entry.fetchedAt, stale: false };
    } catch (error) {
      if (cached) return { models: cached.models, fetchedAt: cached.fetchedAt, stale: true, error: error instanceof Error ? error.message : "Grok discovery failed" };
      throw error;
    }
  }
  private refresh(scope: { key: string; executable: string; homeRoot: string; cwd: string }): Promise<Entry> {
    const existing = this.pending.get(scope.key);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const promise = (async () => {
      try {
        const result = await initializeGrokCatalog({ ...scope, signal: controller.signal, initializeTimeoutMs: 15_000 });
        this.options.assertOpen();
        if (this.closing || this.scope(scope.cwd).key !== scope.key) throw new Error("Grok catalog source changed during discovery; refresh again");
        const entry = { key: scope.key, models: grokModelsFromInitialize(result), fetchedAt: new Date().toISOString() };
        this.entries.delete(scope.key); this.entries.set(scope.key, entry);
        while (this.entries.size > 16) this.entries.delete(this.entries.keys().next().value!);
        // Cache persistence is advisory: a write failure must not hide a valid
        // native catalog or poison the authoritative App store.
        try { atomicAppRecord(this.options.dataDir, FILE, { version: 1, entries: [...this.entries.values()] }); } catch { /* Rediscover on restart. */ }
        this.failures.delete(scope.key);
        return entry;
      } catch (error) {
        if (error instanceof GrokAcpOperationError && !error.evidence.processGroupGone) this.drained = false;
        this.failures.set(scope.key, { error: error instanceof Error ? error.message : "Grok model discovery failed", at: Date.now() });
        throw error;
      } finally { this.pending.delete(scope.key); }
    })();
    this.pending.set(scope.key, { controller, promise });
    return promise;
  }
  async close(): Promise<boolean> {
    this.closing = true;
    for (const request of this.pending.values()) request.controller.abort();
    await Promise.allSettled([...this.pending.values()].map(request => request.promise));
    return this.drained;
  }
}
