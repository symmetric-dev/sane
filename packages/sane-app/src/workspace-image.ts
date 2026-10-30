import { imagePreviewMimeType } from "../shared/image-preview-contract";
import { MEDIA_SHARE_LIMITS as LIMITS } from "../shared/media-share-contract";
import { validateImageBytes } from "./media-share-format";
import { WorkspaceError, type WorkspaceService } from "./workspace";

// Shared by catalog/worktree and legacy-session routes, not one budget per tab.
let previews = 0;

/** A bounded, validated disk read, not a durable chat share or a live path URL. */
export async function workspaceImageResponse(req: Request, workspace: Pick<WorkspaceService, "captureMedia">, key: string, revision: unknown, path: string, assertAuthorized: () => void): Promise<Response> {
  const mimeType = imagePreviewMimeType(path);
  if (!mimeType) throw new WorkspaceError(415, "image-format", "Only PNG, JPEG and WebP images can be previewed");
  if (typeof revision !== "string" || !revision) throw new WorkspaceError(400, "workspace-required", "Resolve the workspace first");
  assertAuthorized();
  if (previews >= LIMITS.concurrentCaptures) throw new WorkspaceError(429, "image-preview-busy", "Image preview is busy; try again shortly");
  const deadline = Date.now() + LIMITS.captureMs;
  const check = () => {
    if (req.signal.aborted) throw new WorkspaceError(499, "image-preview-aborted", "Image preview cancelled");
    if (Date.now() >= deadline) throw new WorkspaceError(504, "image-preview-time-limit", "Image preview deadline reached");
    assertAuthorized();
  };
  previews++;
  try {
    check();
    const chunks: Buffer[] = [];
    const captured = await workspace.captureMedia(key, revision, path, LIMITS.imageBytes, async chunk => {
      check();
      // captureMedia reuses its chunk buffer; keep an owned copy until fenced.
      chunks.push(Buffer.from(chunk));
    }, { signal: req.signal, deadline });
    check();
    const bytes = Buffer.concat(chunks, captured.bytes);
    try { validateImageBytes(bytes, mimeType); }
    catch { throw new WorkspaceError(415, "image-format", "Invalid or unsupported image. Use a static PNG, JPEG or WebP within the image size and dimension limits."); }
    check();
    return new Response(bytes, { headers: {
      "content-type": mimeType,
      "content-length": String(bytes.length),
      "content-disposition": `inline; filename="preview.${mimeType === "image/jpeg" ? "jpg" : mimeType === "image/png" ? "png" : "webp"}"`,
      "cache-control": "private, no-store, no-transform",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
    } });
  } catch (error) {
    check();
    if (error instanceof WorkspaceError && error.code === "media-size") throw new WorkspaceError(413, "image-size", "Images must be nonempty and no larger than 10 MiB");
    throw error;
  } finally { previews--; }
}
