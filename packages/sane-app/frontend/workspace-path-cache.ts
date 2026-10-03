import type { WorkspacePaths } from "../src/workspace-contract";
import { safeRelativePath } from "./chat-path-token";
import { createWorkspacePathIndex, type WorkspacePathIndex } from "./workspace-path-matcher";

export type PathInventoryResult = { inventory?: WorkspacePaths; index?: WorkspacePathIndex; error?: string };
export type PathInventoryFreshness = { revision: number; resultRevision: number; settledAt: number };
export type PathInventoryRequest = {
  result?: PathInventoryResult;
  promise?: Promise<PathInventoryResult>;
  freshness: PathInventoryFreshness;
};
export type WorktreePathInventories = {
  /** Synchronous stale-while-refresh read, fenced by the owning lease. */
  readPaths: (prefix?: string) => { result?: PathInventoryResult; freshness?: Readonly<PathInventoryFreshness>; fresh: boolean; loading: boolean; current: boolean };
  listPaths: (prefix?: string) => Promise<PathInventoryResult>;
  pathsNeedsRefresh: (prefix: string, result?: PathInventoryResult) => boolean;
};
export const PATH_INVENTORY_SUCCESS_FRESH_MS = 30_000;
export const PATH_INVENTORY_ERROR_FRESH_MS = 5_000;
export const PATH_INVENTORY_MAX_PREFIXES = 8;
export const PATH_INVENTORY_MAX_ENTRIES = 10_000;
const MAX_TOTAL_ENTRIES = 20_000;
// Approximate retained UTF-16 code units, including parsed/lowercase copies.
const MAX_INVENTORY_CHARS = 1_000_000;
const MAX_TOTAL_CHARS = 2_000_000;
const unavailable = (): PathInventoryResult => ({ error: "Workspace changed or unavailable. Reopen its files or choose an available worktree." });
const related = (a: string, b: string) => !a || !b || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/** One instance per worktree/auth/binding lease owner, not per query or consumer.
 * Consumer cancellation is deliberately absent; only last-lease disposal may
 * abort discovery. Fetch cancellation never inserts an error into a new owner. */
export function createWorktreePathInventories(options: {
  workspaceId: string;
  current: () => boolean;
  fetch: (prefix: string, signal: AbortSignal) => Promise<WorkspacePaths>;
  failure: (error: unknown) => string;
}) {
  type Record = PathInventoryRequest & { controller?: AbortController; count: number; chars: number };
  const records = new Map<string, Record>();
  let disposed = false;
  const current = () => !disposed && options.current();
  const fresh = (record?: Record) => !!record?.result && record.freshness.resultRevision === record.freshness.revision
    && Date.now() - record.freshness.settledAt < (record.result.error ? PATH_INVENTORY_ERROR_FRESH_MS : PATH_INVENTORY_SUCCESS_FRESH_MS);
  const touch = (prefix: string, record: Record) => { records.delete(prefix); records.set(prefix, record); };
  const drop = (prefix: string, record: Record) => { records.delete(prefix); record.controller?.abort(); };
  const trim = (keep: Record) => {
    let count = 0, chars = 0;
    for (const record of records.values()) { count += record.count; chars += record.chars; }
    for (const [prefix, record] of records) {
      if (count <= MAX_TOTAL_ENTRIES && chars <= MAX_TOTAL_CHARS) break;
      if (record === keep) continue;
      // Do not evict/abort another prefix's shared in-flight refresh. Discard its
      // stale payload instead; its request will apply the budget when it settles.
      if (record.promise) {
        count -= record.count; chars -= record.chars;
        record.result = undefined; record.count = 0; record.chars = 0;
        record.freshness.resultRevision = -1;
        continue;
      }
      count -= record.count; chars -= record.chars; drop(prefix, record);
    }
  };
  const service: WorktreePathInventories = {
    readPaths: (prefix = "") => {
      if (!current() || !safeRelativePath(prefix)) return { current: false, fresh: false, loading: false };
      const record = records.get(prefix);
      if (record) touch(prefix, record);
      return { result: record?.result, freshness: record ? { ...record.freshness } : undefined,
        fresh: fresh(record), loading: !!record?.promise, current: true };
    },
    pathsNeedsRefresh: (prefix, result) => current() && safeRelativePath(prefix)
      && (!result || records.get(prefix)?.result !== result || !fresh(records.get(prefix))),
    listPaths: async (prefix = "") => {
      if (!current()) return unavailable();
      if (!safeRelativePath(prefix)) return { error: "Choose a safe workspace-relative directory prefix." };
      let record = records.get(prefix);
      if (!record) {
        // In-flight requests count toward the prefix cap too, but a new consumer
        // must never cancel another consumer's shared discovery.
        while (records.size >= PATH_INVENTORY_MAX_PREFIXES) {
          const candidate = [...records].find(([, value]) => !value.promise);
          if (!candidate) return { error: "Path discovery is busy. Wait for an existing directory scan, then retry." };
          drop(candidate[0], candidate[1]);
        }
        record = { freshness: { revision: 0, resultRevision: -1, settledAt: 0 }, count: 0, chars: 0 };
      }
      touch(prefix, record);
      if (record.promise) return record.promise;
      if (fresh(record)) return record.result!;
      const owned = record, state = owned.freshness;
      const valid = () => current() && records.get(prefix) === owned;
      owned.controller = new AbortController();
      const signal = AbortSignal.any([owned.controller.signal, AbortSignal.timeout(25_000)]);
      owned.promise = Promise.resolve().then(async () => {
        try {
          while (valid()) {
            const revision = state.revision;
            let result: PathInventoryResult, count = 0, chars = 0;
            try {
              const response = await options.fetch(prefix, signal);
              if (response.workspaceId !== options.workspaceId || response.path !== prefix) return unavailable();
              const entries: WorkspacePaths["entries"] = [];
              let truncated = response.truncated;
              for (const entry of response.entries) {
                const cost = (entry.path.length + entry.name.length) * 4;
                if (entries.length >= PATH_INVENTORY_MAX_ENTRIES || chars + cost > MAX_INVENTORY_CHARS) { truncated = true; break; }
                entries.push(entry); chars += cost;
              }
              const inventory = { ...response, entries, truncated };
              result = { inventory, index: createWorkspacePathIndex(inventory) }; count = entries.length;
            } catch (error) {
              result = { error: current() ? options.failure(error) : unavailable().error };
            }
            if (!valid()) break;
            // A mutation during discovery retries under the same shared promise;
            // no consumer can ever observe a stale completion as fresh metadata.
            if (revision !== state.revision) {
              if (signal.aborted) break;
              continue;
            }
            owned.result = result; owned.count = count; owned.chars = chars;
            state.resultRevision = revision; state.settledAt = Date.now(); trim(owned);
            return result;
          }
          return unavailable();
        } finally { owned.promise = undefined; owned.controller = undefined; }
      });
      return owned.promise;
    },
  };
  return { ...service,
    invalidate: (paths: Iterable<string>, mutation = false) => {
      const affected = [...paths];
      for (const [prefix, record] of records) {
        // Parent directory invalidations also cover .gitignore saves and scopes
        // below that parent; exact ignore filenames have the same coverage.
        const relevant = affected.some(path => {
          if (!safeRelativePath(path)) return false;
          const directory = path.split("/").at(-1) === ".gitignore" ? path.slice(0, Math.max(0, path.lastIndexOf("/"))) : path;
          return related(prefix, directory);
        });
        if (relevant && (mutation || (!record.promise && record.freshness.resultRevision === record.freshness.revision))) record.freshness.revision++;
      }
    },
    dispose: () => { disposed = true; for (const [prefix, record] of records) drop(prefix, record); },
  };
}
