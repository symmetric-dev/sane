import {
  IMAGE_UPLOAD_LIMITS, imageUploadMimeType, isImageUploadDirectory, isImageUploadFilename,
  isImageUploadReceipt, type ImageUploadReceipt,
} from "../shared/image-upload-contract";
import { workspaceClient, notifyWorkspaceMutation } from "./workspace-client";

export type ImageUploadTarget = { workspaceId: string; worktreeId: string };
export type ImageUploadBinding = ImageUploadTarget & { bindingRevision: string; root?: string };
export type ImageUploadInput = ImageUploadBinding & { directory: string; filename: string; requestId: string; file: File };

export class ImageUploadError extends Error {
  constructor(message: string, readonly status = 0, readonly code?: string,
    readonly uncertain = false, readonly suggestedFilename?: string) { super(message); }
}

export const imageUploadScopeId = (target: ImageUploadTarget) => JSON.stringify([target.workspaceId, target.worktreeId]);
const base = (target: ImageUploadTarget) => `/api/workspaces/${encodeURIComponent(target.workspaceId)}/worktrees/${encodeURIComponent(target.worktreeId)}`;
const signalFor = (signal?: AbortSignal) => signal
  ? AbortSignal.any([signal, AbortSignal.timeout(IMAGE_UPLOAD_LIMITS.uploadMs)])
  : AbortSignal.timeout(IMAGE_UPLOAD_LIMITS.uploadMs);

/** Both Files metadata and Git must reconcile committed writes (including recovered receipts). */
function notify(binding: ImageUploadBinding, paths: string[]) {
  notifyWorkspaceMutation(imageUploadScopeId(binding), binding.bindingRevision, paths);
}

async function jsonRequest(url: string, init: RequestInit, mutation = false): Promise<unknown> {
  let response: Response;
  try { response = await fetch(url, { credentials: "same-origin", cache: "no-store", ...init, signal: signalFor(init.signal ?? undefined) }); }
  catch (error) {
    throw new ImageUploadError(error instanceof Error ? error.message : "The server could not be reached.", 0, undefined, mutation);
  }
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const code = typeof body?.code === "string" ? body.code : undefined;
    // An abort or failed post-publication check is not proof of non-commit.
    // Retain the exact request identity and recover before allowing a rename.
    const uncertain = mutation && (response.status >= 500 || response.status === 408 || response.status === 499
      || code === "image-upload-uncertain" || code === "image-upload-in-progress" || code === "image-upload-changed");
    throw new ImageUploadError(
      typeof body?.error === "string" ? body.error : `Image request failed (${response.status}).`, response.status,
      code, uncertain, typeof body?.suggestedFilename === "string" ? body.suggestedFilename : undefined,
    );
  }
  return body;
}

function checkedReceipt(value: unknown, input: ImageUploadBinding & { requestId: string }): ImageUploadReceipt {
  if (!isImageUploadReceipt(value) || value.workspaceId !== input.workspaceId || value.worktreeId !== input.worktreeId
    || value.bindingRevision !== input.bindingRevision || value.uploadId !== input.requestId) {
    throw new ImageUploadError("The server did not return a matching upload receipt. Check its status before retrying.", 0, "invalid-receipt", true);
  }
  return value;
}

function suggestedFilename(name: string): string | undefined {
  const dot = name.lastIndexOf("."), stem = name.slice(0, dot), extension = name.slice(dot);
  const numbered = /^(.*) \((\d{1,6})\)$/.exec(stem);
  const candidate = `${numbered ? numbered[1] : stem} (${numbered ? Number(numbered[2]) + 1 : 2})${extension}`;
  return isImageUploadFilename(candidate) ? candidate : undefined;
}

/** Client checks improve feedback only; the server validates bytes and filesystem safety. */
export function validateImageUploadFile(file: File, filename = file.name): string | undefined {
  if (!file.size) return "The image is empty.";
  if (file.size > IMAGE_UPLOAD_LIMITS.imageBytes) return "The image exceeds 10 MiB.";
  const originalMime = file.type || imageUploadMimeType(file.name);
  if (!originalMime || !["image/png", "image/jpeg", "image/webp"].includes(originalMime)) return "Choose a PNG, JPEG, or WebP image.";
  if (!isImageUploadFilename(filename)) return "Use a safe filename ending in .png, .jpg, .jpeg, or .webp.";
  if (imageUploadMimeType(filename) !== originalMime) return "Keep the image’s original format when renaming it.";
  return undefined;
}

export const imageUploadClient = {
  async resolve(target: ImageUploadTarget): Promise<ImageUploadBinding> {
    const result = await workspaceClient.resolve(imageUploadScopeId(target));
    if (result.catalogWorkspaceId !== target.workspaceId || result.worktreeId !== target.worktreeId || !result.bindingRevision) {
      throw new ImageUploadError("The selected worktree could not be resolved. Reopen the dialog.");
    }
    return { ...target, bindingRevision: result.bindingRevision, root: result.root };
  },
  async upload(input: ImageUploadInput, signal?: AbortSignal): Promise<ImageUploadReceipt> {
    const invalid = validateImageUploadFile(input.file, input.filename);
    if (invalid || !isImageUploadDirectory(input.directory)) throw new ImageUploadError(invalid ?? "Choose a safe project directory.");
    const query = new URLSearchParams({ bindingRevision: input.bindingRevision, directory: input.directory,
      filename: input.filename, requestId: input.requestId });
    let value: unknown;
    try {
      value = await jsonRequest(`${base(input)}/image-uploads?${query}`, {
        method: "POST", headers: { "Content-Type": imageUploadMimeType(input.filename)! }, body: input.file, signal,
      }, true);
    } catch (error) {
      if (error instanceof ImageUploadError && error.code === "image-upload-exists" && !error.suggestedFilename) {
        throw new ImageUploadError(error.message, error.status, error.code, error.uncertain, suggestedFilename(input.filename));
      }
      throw error;
    }
    const receipt = checkedReceipt(value, input);
    if (receipt.directory !== input.directory || receipt.name !== input.filename || receipt.bytes !== input.file.size
      || receipt.mimeType !== imageUploadMimeType(input.filename)) {
      throw new ImageUploadError("The upload receipt does not match this file. Check its status before retrying.", 0, "invalid-receipt", true);
    }
    notify(input, [receipt.path]);
    return receipt;
  },
  async recover(input: ImageUploadBinding & { requestId: string }, signal?: AbortSignal): Promise<ImageUploadReceipt | null> {
    const query = new URLSearchParams({ bindingRevision: input.bindingRevision });
    try {
      const receipt = checkedReceipt(await jsonRequest(`${base(input)}/image-uploads/${encodeURIComponent(input.requestId)}?${query}`, { signal }), input);
      notify(input, [receipt.path]);
      return receipt;
    } catch (error) {
      if (error instanceof ImageUploadError && error.status === 404) return null;
      throw error;
    }
  },
  async createDirectory(binding: ImageUploadBinding, path: string, signal?: AbortSignal): Promise<string> {
    if (!path || !isImageUploadDirectory(path)) throw new ImageUploadError("Enter a safe relative folder path.");
    const result = await jsonRequest(`${base(binding)}/image-upload-directories`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bindingRevision: binding.bindingRevision, path }), signal,
    }, true) as { path?: unknown; bindingRevision?: unknown } | null;
    if (result?.path !== path || result.bindingRevision !== binding.bindingRevision) {
      throw new ImageUploadError("Folder creation was not confirmed. Refresh the folder list before trying again.", 0, undefined, true);
    }
    notify(binding, [path]);
    return path;
  },
};

/** Preview URLs are derived from validated receipts, never arbitrary repository path strings. */
export function imageUploadContentUrl(receipt: ImageUploadReceipt): string {
  if (!isImageUploadReceipt(receipt)) throw new Error("Invalid image upload receipt.");
  return `${base(receipt)}/image-uploads/${encodeURIComponent(receipt.uploadId)}/content?${new URLSearchParams({ bindingRevision: receipt.bindingRevision })}`;
}

function directoryKey(target: ImageUploadTarget, storeId?: string) {
  return `sane:image-upload-directory:v1:${JSON.stringify([location.origin, storeId ?? "", target.workspaceId, target.worktreeId])}`;
}
/** Only explicit selections are remembered, and never across a changed worktree binding. */
export function readImageUploadDirectory(binding: ImageUploadBinding, storeId?: string): string | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(directoryKey(binding, storeId)) ?? "null");
    if (value?.bindingRevision === binding.bindingRevision && isImageUploadDirectory(value.path)) return value.path;
    if (value) localStorage.removeItem(directoryKey(binding, storeId));
  } catch { /* Storage is optional. */ }
  return undefined;
}
export function writeImageUploadDirectory(binding: ImageUploadBinding, path: string, storeId?: string) {
  if (!isImageUploadDirectory(path)) return;
  try { localStorage.setItem(directoryKey(binding, storeId), JSON.stringify({ bindingRevision: binding.bindingRevision, path })); }
  catch { /* Selection still works without persistence. */ }
}
