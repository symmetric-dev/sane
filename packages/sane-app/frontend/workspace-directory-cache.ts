import type { WorktreeResolution } from "../src/catalog-contract";
import type { WorkspaceList } from "../src/workspace-contract";
import { catalog } from "./catalog";
import { workspaceClient, WorkspaceError } from "./workspace-client";
import { workspaceEpoch, workspaceFailure } from "./workspace-store";

export type DirectoryResult = { listing?: WorkspaceList; error?: string };
export type DirectoryRequest = {
  result?: DirectoryResult; promise?: Promise<DirectoryResult>;
  freshness?: { revision: number; resultRevision: number; settledAt: number };
};
export type WorktreeDirectories = {
  workspace: WorktreeResolution;
  directories: Map<string, DirectoryRequest>;
  listDirectory: (path: string) => Promise<DirectoryResult>;
  directoryNeedsRefresh: (path: string, result?: DirectoryResult) => boolean;
  invalidate: (paths: Iterable<string>, mutation?: boolean) => void;
  current: () => boolean;
};
const registry = new Map<string, { leases: number; ready: Promise<WorktreeDirectories> }>();
export const DIRECTORY_SUCCESS_FRESH_MS = 30_000;
const DIRECTORY_ERROR_FRESH_MS = 5_000;
const unavailable = () => ({ error: "Workspace changed or unavailable. Reopen its files or choose an available worktree." });
function canonicalRoot(root: string) {
  return root.startsWith("/") && !/[\\\u0000-\u001f\u007f]/.test(root)
    && (root === "/" || root.slice(1).split("/").every(part => !!part && part !== "." && part !== ".."));
}
function freshness(request: DirectoryRequest) {
  return request.freshness ??= { revision: 0, resultRevision: request.result ? 0 : -1, settledAt: 0 };
}
function fresh(request?: DirectoryRequest) {
  const state = request?.freshness;
  return !!request?.result && !!state && state.resultRevision === state.revision
    && Date.now() - state.settledAt < (request.result.error ? DIRECTORY_ERROR_FRESH_MS : DIRECTORY_SUCCESS_FRESH_MS);
}

/** Shared metadata ownership is independent of any browsing or input generation.
 * The last lease drops the registry entry; cleanup never aborts another reader. */
export function acquireWorktreeDirectories(scopeId: string, expectedBindingRevision?: string) {
  const auth = workspaceEpoch();
  const key = JSON.stringify([scopeId, expectedBindingRevision, auth]);
  let entry = registry.get(key);
  if (!entry) {
    const [workspaceId, worktreeId] = JSON.parse(scopeId) as [string, string];
    const catalogWorktree = () => catalog.state.workspaces.find(w => w.workspaceId === workspaceId)?.worktrees.find(w => w.worktreeId === worktreeId);
    const record = catalogWorktree();
    // Capture primitive identity fields, never a mutable catalog record.
    const source = record ? { root: record.root, revision: record.bindingRevision } as const : undefined;
    // Files can bootstrap before catalog hydration. This is not an admission
    // fallback for a ready catalog, and autocomplete cannot acquire it pre-ready.
    const bootstrap = !catalog.state.ready && !source;
    let resolvedSource: Readonly<{ root: string; revision: string }> | undefined;
    const owner = { leases: 0, ready: null! as Promise<WorktreeDirectories> };
    const valid = () => {
      const live = catalogWorktree(), identity = source ?? resolvedSource;
      if (!owner.leases || auth !== workspaceEpoch() || !identity) return false;
      if (live) return live.state === "available" && live.bindingRevision === identity.revision && live.root === identity.root;
      return bootstrap && !catalog.state.ready && !!resolvedSource;
    };
    owner.ready = workspaceClient.resolve(scopeId).then(workspace => {
      const root = workspace.root, revision = workspace.bindingRevision;
      if (!canonicalRoot(root) || !revision || workspace.workspaceId !== revision
        || workspace.catalogWorkspaceId !== workspaceId || workspace.worktreeId !== worktreeId
        || expectedBindingRevision !== undefined && workspace.bindingRevision !== expectedBindingRevision
        || source && (revision !== source.revision || root !== source.root)) {
        throw new WorkspaceError(unavailable().error, 409, "workspace-changed");
      }
      resolvedSource = { root, revision };
      if (!valid()) {
        throw new WorkspaceError(unavailable().error, 409, "workspace-changed");
      }
      const directories = new Map<string, DirectoryRequest>();
      const service: WorktreeDirectories = {
        workspace, directories, current: valid,
        directoryNeedsRefresh: (path, result) => valid() && (!result || directories.get(path)?.result !== result || !fresh(directories.get(path))),
        invalidate: (paths, mutation = false) => {
          for (const path of paths) {
            const request = directories.get(path);
            if (!request) continue;
            const state = freshness(request);
            if (mutation || (!request.promise && state.resultRevision === state.revision)) state.revision++;
          }
        },
        listDirectory: async path => {
          if (!valid()) return unavailable();
          let request = directories.get(path);
          if (!request) { request = {}; directories.set(path, request); }
          const state = freshness(request), record = request;
          if (record.promise) return record.promise;
          if (fresh(record)) return record.result!;
          const current = () => valid() && directories.get(path) === record;
          record.promise = (async () => {
            try {
              while (current()) {
                const revision = state.revision;
                let result: DirectoryResult;
                try { result = { listing: await workspaceClient.list(scopeId, workspace.workspaceId, path) }; }
                catch (error) { result = { error: auth === workspaceEpoch() ? workspaceFailure(error) : unavailable().error }; }
                if (!current()) break;
                if (revision !== state.revision) continue;
                record.result = result; state.resultRevision = revision; state.settledAt = Date.now();
                return result;
              }
              return unavailable();
            } finally { record.promise = undefined; }
          })();
          return record.promise;
        },
      };
      return service;
    }).catch(error => {
      // A failed resolve owns no metadata map. New acquisitions may retry without
      // forcing all existing consumers to release their failed leases first.
      if (registry.get(key) === owner) registry.delete(key);
      throw new Error(auth === workspaceEpoch() ? workspaceFailure(error) : unavailable().error);
    });
    registry.set(key, owner); entry = owner;
  }
  entry.leases++;
  const owner = entry;
  let released = false;
  return { ready: owner.ready.then(reader => {
    // A previously resolved bootstrap lease may now face an authoritative
    // catalog. Do not reacquire it as successful metadata after revocation.
    if (!reader.current()) throw new Error(unavailable().error);
    return reader;
  }), release: () => {
    if (released) return;
    released = true;
    if (--owner.leases === 0 && registry.get(key) === owner) registry.delete(key);
  } };
}
