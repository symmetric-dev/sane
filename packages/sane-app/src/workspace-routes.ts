import type { CatalogService } from "./catalog";
import type { GitOperationsService } from "./git-operations";
import type { WorkspaceCreationService } from "./workspace-creation";
import { WorkspaceError, workspaceError, type WorkspaceService } from "./workspace";
import { workspaceImageResponse } from "./workspace-image";
import { body, json } from "./bridge-http";

type WorkspaceOperations = Pick<WorkspaceService,
  "resolve" | "list" | "file" | "write" | "search" | "paths" | "copy" | "rename" | "create" | "delete" | "status" | "diff" | "captureMedia" | "mediaVersion"
>;

export interface WorkspaceRoutePorts {
  catalog: Pick<CatalogService, "getNavigation" | "putNavigation" | "list" | "register" | "setAlias" | "get" | "removeWorktree">;
  workspace: WorkspaceOperations;
  worktrees: WorkspaceOperations;
  workspaceCreations: Pick<WorkspaceCreationService, "create">;
  gitOperations: Pick<GitOperationsService, "get" | "run">;
  searches: {
    assertOpen(): void;
    run<T>(requestSignal: AbortSignal, action: (signal: AbortSignal) => Promise<T>): Promise<T>;
  };
  authenticated(req: Request): boolean;
  terminalToken(req: Request): string | undefined;
  assertDomainMutationOpen(): void;
  canCreate(req: Request): boolean;
  canRunGit(req: Request, token: string | undefined): boolean;
  beforeRemoveWorktree(workspaceId: string, worktreeId: string): Promise<void>;
  withWorktreeRemoval?<T>(workspaceId: string, worktreeId: string, action: () => Promise<T>): Promise<T>;
}

const aliasPattern = /^\/api\/workspaces\/([^/]+)\/worktrees\/([^/]+)\/alias$/;
const gitOperationsPattern = /^\/api\/workspaces\/([^/]+)\/worktrees\/([^/]+)\/git-operations$/;
const catalogPattern = /^\/api\/workspaces\/([^/]+)(?:\/worktrees\/([^/]+)(?:\/(list|file|image|copy|rename|git|diff|search|paths))?)?$/;
const workspacePattern = /^\/api\/sessions\/([^/]+)\/workspace(?:\/(list|file|image|copy|rename|git|diff|search|paths))?$/;

export function matchesWorkspaceRoute(path: string): boolean {
  return path === "/api/navigation"
    || path === "/api/workspaces/create"
    || path === "/api/workspaces"
    || aliasPattern.test(path)
    || gitOperationsPattern.test(path)
    || catalogPattern.test(path)
    || workspacePattern.test(path);
}

/** The bridge retains root guards, search lifetime ownership and worktree cleanup. */
export function createWorkspaceRoute({
  catalog, workspace, worktrees, workspaceCreations, gitOperations, searches,
  authenticated, terminalToken, assertDomainMutationOpen, canCreate, canRunGit, beforeRemoveWorktree, withWorktreeRemoval,
}: WorkspaceRoutePorts): (req: Request, url: URL) => Promise<Response | null> {
  const image = (req: Request, service: WorkspaceOperations, key: string, revision: unknown, path: string) => {
    const token = terminalToken(req);
    return workspaceImageResponse(req, service, key, revision, path, () => {
      if (!token || !authenticated(req) || terminalToken(req) !== token) throw new WorkspaceError(401, "authentication-required", "Authentication revoked");
    });
  };
  return async (req, url) => {
    const path = url.pathname;
    if (path === "/api/navigation") {
      if (req.method === "GET") return json(catalog.getNavigation());
      if (req.method === "PUT") return json(await catalog.putNavigation(await body(req)));
      return json({ error: "Method not allowed" }, 405);
    }
    if (path === "/api/workspaces/create") {
      if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return json(await workspaceCreations.create(await body(req), () => canCreate(req)), 201);
    }
    if (path === "/api/workspaces") {
      if (req.method === "GET") return json(await catalog.list());
      if (req.method === "POST") { const input = await body(req); return json(await catalog.register(input?.cwd), 201); }
      return json({ error: "Method not allowed" }, 405);
    }
    const aliasMatch = aliasPattern.exec(path);
    if (aliasMatch) {
      try {
        if (req.method !== "PUT") return json({ error: "Method not allowed" }, 405);
        const workspaceId = decodeURIComponent(aliasMatch[1]!), worktreeId = decodeURIComponent(aliasMatch[2]!);
        const input = await body(req);
        return json({ workspace: await catalog.setAlias(workspaceId, worktreeId, input?.alias ?? null) });
      } catch (error) { const failure = workspaceError(error); return json({ error: failure.message, code: failure.code }, failure.status); }
    }
    const gitOperationsMatch = gitOperationsPattern.exec(path);
    if (gitOperationsMatch) {
      try {
        const workspaceId = decodeURIComponent(gitOperationsMatch[1]!), worktreeId = decodeURIComponent(gitOperationsMatch[2]!);
        const token = terminalToken(req);
        if (req.method === "GET") {
          const result = await gitOperations.get(workspaceId, worktreeId, url.searchParams.get("bindingRevision"));
          if (!token || terminalToken(req) !== token) return json({ error: "Authentication revoked" }, 401);
          return json(result);
        }
        if (req.method === "POST") {
          assertDomainMutationOpen();
          const input = await body(req);
          return json(await gitOperations.run(workspaceId, worktreeId, input, () => canRunGit(req, token)));
        }
        return json({ error: "Method not allowed" }, 405);
      } catch (error) { const failure = workspaceError(error); return json({ error: failure.message, code: failure.code }, failure.status); }
    }
    const catalogMatch = catalogPattern.exec(path);
    if (catalogMatch) {
      try {
        const workspaceId = decodeURIComponent(catalogMatch[1]!), worktreeId = catalogMatch[2] && decodeURIComponent(catalogMatch[2]), operation = catalogMatch[3];
        if (!worktreeId && req.method === "GET") return json(await catalog.get(workspaceId));
        const key = `${workspaceId}/${worktreeId}`, revision = url.searchParams.get("workspaceId") ?? url.searchParams.get("bindingRevision"), filePath = url.searchParams.get("path") ?? "";
        if (!operation && worktreeId && req.method === "GET") { const resolved = await worktrees.resolve(key); return json({ ...resolved, catalogWorkspaceId: workspaceId, worktreeId, bindingRevision: resolved.workspaceId }); }
        if (!operation && worktreeId && req.method === "DELETE") {
          const input = await body(req).catch(() => ({}));
          const remove = () => catalog.removeWorktree(workspaceId, worktreeId, {
            force: input?.force === true,
            beforeRemove: () => beforeRemoveWorktree(workspaceId, worktreeId),
          });
          const result = withWorktreeRemoval ? await withWorktreeRemoval(workspaceId, worktreeId, remove) : await remove();
          return json(result);
        }
        if (operation === "list" && req.method === "GET") return json(await worktrees.list(key, revision, filePath));
        if (operation === "image" && ["GET", "HEAD"].includes(req.method)) return await image(req, worktrees, key, revision, filePath);
        if (operation === "file" && req.method === "GET") return json(await worktrees.file(key, revision, filePath));
        if (operation === "file" && req.method === "PUT") { const input = await body(req); return json(await worktrees.write(key, { ...input, workspaceId: input?.bindingRevision ?? input?.workspaceId })); }
        if (operation === "search" && req.method === "POST") {
          searches.assertOpen();
          const input = await body(req);
          return json(await searches.run(req.signal, signal => worktrees.search(key, { ...input, workspaceId: input?.bindingRevision ?? input?.workspaceId }, signal)));
        }
        if (operation === "paths" && req.method === "POST") {
          searches.assertOpen();
          const input = await body(req);
          const result = await searches.run(req.signal, signal => worktrees.paths(key, { ...input, workspaceId: input?.bindingRevision ?? input?.workspaceId }, signal));
          if (!authenticated(req)) return json({ error: "Authentication revoked" }, 401);
          return json(result);
        }
        if ((operation === "file" && ["POST", "DELETE"].includes(req.method)) || (["copy", "rename"].includes(operation ?? "") && req.method === "POST")) {
          const input = await body(req), boundInput = { ...input, workspaceId: input?.bindingRevision ?? input?.workspaceId };
          if (operation === "copy") return json(await worktrees.copy(key, boundInput), 201);
          if (operation === "rename") return json(await worktrees.rename(key, boundInput));
          if (req.method === "POST") return json(await worktrees.create(key, boundInput), 201);
          return json(await worktrees.delete(key, boundInput));
        }
        if (operation === "git" && req.method === "GET") return json(await worktrees.status(key, revision));
        if (operation === "diff" && req.method === "GET") return json(await worktrees.diff(key, revision, filePath, url.searchParams.get("comparison") ?? ""));
        return json({ error: "Method not allowed" }, 405);
      } catch (error) { const failure = workspaceError(error); return json({ error: failure.message, code: failure.code }, failure.status); }
    }
    const workspaceMatch = workspacePattern.exec(path);
    if (workspaceMatch) {
      try {
        const sessionId = decodeURIComponent(workspaceMatch[1]!);
        const operation = workspaceMatch[2], workspaceId = url.searchParams.get("workspaceId"), filePath = url.searchParams.get("path") ?? "";
        if (!operation && req.method === "GET") return json(await workspace.resolve(sessionId));
        if (operation === "list" && req.method === "GET") return json(await workspace.list(sessionId, workspaceId, filePath));
        if (operation === "image" && ["GET", "HEAD"].includes(req.method)) return await image(req, workspace, sessionId, workspaceId, filePath);
        if (operation === "file" && req.method === "GET") return json(await workspace.file(sessionId, workspaceId, filePath));
        if (operation === "file" && req.method === "PUT") return json(await workspace.write(sessionId, await body(req)));
        if (operation === "search" && req.method === "POST") {
          searches.assertOpen();
          const input = await body(req);
          return json(await searches.run(req.signal, signal => workspace.search(sessionId, { ...input, workspaceId: input?.bindingRevision ?? input?.workspaceId }, signal)));
        }
        if (operation === "paths" && req.method === "POST") {
          searches.assertOpen();
          const input = await body(req);
          const result = await searches.run(req.signal, signal => workspace.paths(sessionId, { ...input, workspaceId: input?.bindingRevision ?? input?.workspaceId }, signal));
          if (!authenticated(req)) return json({ error: "Authentication revoked" }, 401);
          return json(result);
        }
        if (operation === "file" && req.method === "POST") return json(await workspace.create(sessionId, await body(req)), 201);
        if (operation === "file" && req.method === "DELETE") return json(await workspace.delete(sessionId, await body(req)));
        if (operation === "copy" && req.method === "POST") return json(await workspace.copy(sessionId, await body(req)), 201);
        if (operation === "rename" && req.method === "POST") return json(await workspace.rename(sessionId, await body(req)));
        if (operation === "git" && req.method === "GET") return json(await workspace.status(sessionId, workspaceId));
        if (operation === "diff" && req.method === "GET") return json(await workspace.diff(sessionId, workspaceId, filePath, url.searchParams.get("comparison") ?? ""));
        return json({ error: "Method not allowed", code: "method-not-allowed" }, 405);
      } catch (error) { const failure = workspaceError(error); return json({ error: failure.message, code: failure.code }, failure.status); }
    }
    return null;
  };
}
