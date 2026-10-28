import { body, json } from "./bridge-http";
import {
  authenticatedWorkstreamRoute, validateWorkstreamInput, WorkstreamAdapterError,
  type RepositoryRouter, type WorkstreamAdapter,
} from "./workstreams";
import type {
  WorkstreamAction, WorkstreamActionInput, WorkstreamActionResult,
  WorkstreamCompleteInput, WorkstreamCompleteResult,
} from "./workstreams-contract";

export type ValidatedWorkstreamInput = Parameters<WorkstreamAdapter["manage"]>[2];
export type WorkstreamSessionOperation = "conversation" | "associate" | "phase/assign" | "phase/end" | "context";

/** The bridge binds the adapter and retains all guarded mutation critical sections. */
export interface WorkstreamRouteScope {
  overview: () => ReturnType<WorkstreamAdapter["overview"]>;
  list: WorkstreamAdapter["list"];
  status: WorkstreamAdapter["status"];
  manage: (input: ValidatedWorkstreamInput) => ReturnType<WorkstreamAdapter["manage"]>;
  create: WorkstreamAdapter["create"];
  setDefaultCheckout: WorkstreamAdapter["setDefaultCheckout"];
  resolveTarget: WorkstreamAdapter["resolveTarget"];
  session: (operation: WorkstreamSessionOperation, input: ValidatedWorkstreamInput) => Promise<unknown>;
}

export interface WorkstreamRoutePorts {
  authenticated: (req: Request) => boolean;
  inspect: RepositoryRouter["inspect"];
  initialize: (id: string) => ReturnType<RepositoryRouter["initialize"]>;
  artifacts: (workspaceId: string, repositoryId: string) => Promise<Pick<WorkstreamAdapter, "documentCatalog" | "listArtifacts" | "readArtifactSnapshot">>;
  open: (workspaceId: string, readOnly: boolean) => Promise<WorkstreamRouteScope>;
  action: (workspaceId: string, operation: WorkstreamAction | "complete", input: WorkstreamActionInput | WorkstreamCompleteInput) => Promise<WorkstreamActionResult | WorkstreamCompleteResult>;
}

export function matchesWorkstreamRoute(path: string): boolean {
  return path === "/api/workstreams" || path.startsWith("/api/workstreams/");
}

/** Host/Origin and other outer security guards remain at the bridge call site. */
export function createWorkstreamRoute(ports: WorkstreamRoutePorts): (req: Request, url: URL) => Promise<Response | null> {
  return async (req, url) => {
    const path = url.pathname;
    if (!matchesWorkstreamRoute(path)) return null;
    return await authenticatedWorkstreamRoute(req, request => ports.authenticated(request) ? null : json({ error: "Authentication required" }, 401), async () => {
      const workspaceId = url.searchParams.get("workspaceId");
      if (!workspaceId) throw new WorkstreamAdapterError(400, "workspace-required", "Select a repository workspace");
      if (path === "/api/workstreams/inspect" && req.method === "GET") return ports.inspect(workspaceId);
      if (path === "/api/workstreams/init" && req.method === "POST") return ports.initialize(workspaceId);
      const operation = path.slice("/api/workstreams/".length);
      if (operation === "artifacts/catalog" || operation === "artifacts/list" || operation === "artifacts/read") {
        if (req.method !== "POST") throw new WorkstreamAdapterError(405, "method-not-allowed", "Method not allowed");
        const input: ValidatedWorkstreamInput = await body(req);
        validateWorkstreamInput(operation, input);
        const artifacts = await ports.artifacts(workspaceId, input.repositoryId);
        if (operation === "artifacts/catalog") return artifacts.documentCatalog(input.id);
        if (operation === "artifacts/list") return artifacts.listArtifacts(input.id);
        return artifacts.readArtifactSnapshot(input.id, input.path);
      }
      const scope = await ports.open(workspaceId, req.method === "GET");
      if (path === "/api/workstreams/overview" && req.method === "GET") {
        if (!workspaceId) throw new WorkstreamAdapterError(400, "workspace-required", "Select a repository workspace");
        return scope.overview();
      }
      if (path === "/api/workstreams" && req.method === "GET") return scope.list();
      if (req.method === "GET" && operation === "status") return scope.status(url.searchParams.get("id") ?? "");
      if (req.method !== "POST") throw new WorkstreamAdapterError(405, "method-not-allowed", "Method not allowed");
      const input: ValidatedWorkstreamInput = await body(req);
      if (operation === "artifacts/write") throw new WorkstreamAdapterError(405, "read-only-artifacts", "App workstream artifacts are read-only");
      if (operation === "manage") {
        if (!workspaceId) throw new WorkstreamAdapterError(400, "workspace-required", "Select a repository workspace");
        if (!input || !["associate", "phase/assign", "phase/end"].includes(input.operation)) throw new WorkstreamAdapterError(400, "invalid-request", "Unknown management action");
        validateWorkstreamInput(input.operation, { ...input, sessionId: "qualified-native-reference" });
        return scope.manage(input);
      }
      validateWorkstreamInput(path === "/api/workstreams" ? "create" : operation, input);
      if (operation === "validate" || operation === "provide" || operation === "complete") {
        return ports.action(workspaceId, operation, input as WorkstreamActionInput | WorkstreamCompleteInput);
      }
      if (path === "/api/workstreams") return scope.create({ id: input.id, title: input.title, type: input.type, defaultCheckout: input.defaultCheckout });
      if (operation === "default-checkout") return scope.setDefaultCheckout(input.id, input.checkout);
      if (operation === "target") return scope.resolveTarget(input.id, input.phase, input.target);
      if (operation === "conversation" || operation === "associate" || operation === "phase/assign" || operation === "phase/end" || operation === "context") {
        return scope.session(operation, input);
      }
      throw new WorkstreamAdapterError(404, "not-found", "Unknown workstream operation");
    });
  };
}
