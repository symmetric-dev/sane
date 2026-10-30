import { IMAGE_UPLOAD_LIMITS } from "../shared/image-upload-contract";
import { WorkspaceError, workspaceError, workspaceOperationWait } from "./workspace";
import type { ImageUploadService, ImageUploadScope } from "./image-upload-service";

const pattern = /^\/api\/workspaces\/([^/]+)\/worktrees\/([^/]+)\/(image-uploads(?:\/([^/]+)(\/content)?)?|image-upload-directories)$/;
export function matchesImageUploadRoute(path: string): boolean { return pattern.test(path); }
export interface ImageUploadRoutePorts {
  service: ImageUploadService;
  authenticated(req: Request): boolean;
  assertOpen(): void;
  run?<T>(requestSignal: AbortSignal, action: (signal: AbortSignal) => Promise<T>): Promise<T>;
}
function headers(): Headers {
  return new Headers({ "cache-control": "private, no-store, no-transform", "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin" });
}
function json(value: unknown, status = 200, allow?: string): Response {
  const h = headers(); h.set("content-type", "application/json; charset=utf-8"); if (allow) h.set("allow", allow);
  return new Response(JSON.stringify(value), { status, headers: h });
}
/** The bridge owns authentication identity pinning, lifecycle admission and
 * shutdown draining. These callbacks are rechecked after awaits and at commit. */
export function createImageUploadRoute({ service, authenticated, assertOpen, run }: ImageUploadRoutePorts): (req: Request, url?: URL) => Promise<Response | null> {
  return async (req, suppliedUrl) => {
    const url = suppliedUrl ?? new URL(req.url), match = pattern.exec(url.pathname);
    if (!match) return null;
    try {
      const check = () => { assertOpen(); if (!authenticated(req)) throw new WorkspaceError(401, "image-upload-auth", "Authentication was revoked"); };
      check();
      const workspaceId = decodeURIComponent(match[1]!), worktreeId = decodeURIComponent(match[2]!);
      const directories = match[3] === "image-upload-directories", uploadId = match[4] && decodeURIComponent(match[4]), content = !!match[5];
      const allowed = directories || !uploadId ? "POST" : content ? "GET, HEAD" : "GET";
      if (!allowed.split(", ").includes(req.method)) return json({ error: "Method not allowed", code: "method-not-allowed" }, 405, allowed);
      const action = async (signal: AbortSignal) => {
        check();
        if (directories) {
          // Explicit folder creation has a tiny bounded JSON body; never use
          // Request.json() on the globally enlarged binary upload body limit.
          const reader = req.body?.getReader();
          if (!reader) throw new WorkspaceError(400, "invalid-request", "Supply a folder creation request");
          const chunks: Buffer[] = []; let total = 0, done = false;
          try {
            while (true) {
              const next = await workspaceOperationWait(() => reader.read(), { signal, deadline: started + IMAGE_UPLOAD_LIMITS.uploadMs }); check();
              if (next.done) { done = true; break; }
              total += next.value.byteLength;
              if (total > 16 * 1024) throw new WorkspaceError(413, "invalid-request", "Folder request is too large");
              chunks.push(Buffer.from(next.value));
            }
          } finally { if (!done) void reader.cancel().catch(() => {}); reader.releaseLock(); }
          const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total)));
          if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["path", "bindingRevision"].includes(k)) || typeof input.path !== "string" || typeof input.bindingRevision !== "string") throw new WorkspaceError(400, "invalid-request", "Supply path and bindingRevision");
          const scope: ImageUploadScope = { workspaceId, worktreeId, bindingRevision: input.bindingRevision };
          const result = await service.createDirectory(scope, input.path, { signal, assertCurrent: check }); check(); return json(result, 201);
        }
        for (const name of ["bindingRevision", "directory", "filename", "requestId"]) if (url.searchParams.getAll(name).length > 1) throw new WorkspaceError(400, "invalid-request", "Do not repeat image upload parameters");
        const scope: ImageUploadScope = { workspaceId, worktreeId, bindingRevision: url.searchParams.get("bindingRevision") ?? "" };
        if (!uploadId) {
          const receipt = await service.upload(scope, { filename: url.searchParams.get("filename") ?? "", requestId: url.searchParams.get("requestId") ?? "", ...(url.searchParams.has("directory") ? { directory: url.searchParams.get("directory")! } : {}) }, req, { signal, assertCurrent: check });
          check(); return json(receipt, 201);
        }
        if (!content) { const receipt = await service.receipt(scope, uploadId, { signal, assertCurrent: check }); check(); return json(receipt); }
        const result = await service.content(scope, uploadId, { signal, assertCurrent: check }); check();
        const h = headers(); h.set("content-type", result.receipt.mimeType); h.set("content-length", String(result.receipt.bytes));
        h.set("content-disposition", `inline; filename="image-${result.receipt.uploadId}.${result.receipt.mimeType === "image/png" ? "png" : result.receipt.mimeType === "image/webp" ? "webp" : "jpg"}"`);
        return new Response(req.method === "HEAD" ? null : new Uint8Array(result.bytes), { headers: h });
      };
      const started = Date.now();
      return run ? await run(req.signal, action) : await action(req.signal);
    } catch (error) {
      if (error instanceof URIError || error instanceof TypeError || error instanceof SyntaxError) return json({ error: "Invalid image upload request", code: "invalid-request" }, 400);
      const failure = workspaceError(error);
      if (failure.code === "search-time-limit") return json({ error: "The image operation exceeded its 30-second limit", code: "image-upload-timeout" }, 504);
      if (failure.code === "search-aborted") return json({ error: "Image operation cancelled", code: "image-upload-aborted" }, 499);
      return json({ error: failure.message, code: failure.code }, failure.status);
    }
  };
}
