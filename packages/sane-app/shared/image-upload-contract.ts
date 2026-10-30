/** User-selected images become ordinary repository files, not model attachments. */
export const IMAGE_UPLOAD_LIMITS = Object.freeze({
  files: 16, imageBytes: 10 * 1024 * 1024, totalBytes: 160 * 1024 * 1024,
  dimension: 16384, pixels: 40_000_000, uploadMs: 30_000, concurrent: 2,
});
export const DEFAULT_IMAGE_UPLOAD_DIRECTORY = "data/images/uploads";
export type ImageUploadMimeType = "image/png" | "image/jpeg" | "image/webp";
export interface ImageUploadReceipt {
  version: 1;
  uploadId: string;
  workspaceId: string;
  worktreeId: string;
  bindingRevision: string;
  directory: string;
  path: string;
  name: string;
  mimeType: ImageUploadMimeType;
  bytes: number;
  sha256: string;
}
const invalidText = /[\u0000-\u001f\u007f-\u009f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const segment = (s: string) => !!s && s !== "." && s !== ".." && ![".git", ".sane"].includes(s.toLowerCase()) && !/[\\/:]/.test(s) && !invalidText.test(s) && !/[. ]$/.test(s) && new TextEncoder().encode(s).length <= 255;
/** Empty directory means the repository root. No normalization or sanitizing. */
export function isImageUploadDirectory(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096 && (value === "" || value.split("/").every(segment));
}
export function imageUploadMimeType(name: string): ImageUploadMimeType | undefined {
  const extension = name.split(".").pop()!.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  return undefined;
}
export function isImageUploadFilename(value: unknown): value is string {
  return typeof value === "string" && segment(value) && !!imageUploadMimeType(value) && value.lastIndexOf(".") > 0;
}
export function isImageUploadRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$(?![\s\S])/i.test(value);
}
export function isImageUploadScopeId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096 && !!value.trim() && !invalidText.test(value) && !/[\\/]/.test(value) && value !== "." && value !== "..";
}
export function isImageUploadReceipt(value: unknown): value is ImageUploadReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const keys = ["version", "uploadId", "workspaceId", "worktreeId", "bindingRevision", "directory", "path", "name", "mimeType", "bytes", "sha256"];
  if (Object.keys(v).length !== keys.length || !keys.every(k => Object.hasOwn(v, k))) return false;
  return v.version === 1 && isImageUploadRequestId(v.uploadId) && [v.workspaceId, v.worktreeId, v.bindingRevision].every(isImageUploadScopeId)
    && isImageUploadDirectory(v.directory) && isImageUploadFilename(v.name)
    && v.path === (v.directory ? `${v.directory}/${v.name}` : v.name) && (v.path as string).length <= 4096
    && v.mimeType === imageUploadMimeType(v.name) && typeof v.bytes === "number" && Number.isSafeInteger(v.bytes) && v.bytes > 0 && v.bytes <= IMAGE_UPLOAD_LIMITS.imageBytes
    && typeof v.sha256 === "string" && /^[a-f0-9]{64}$(?![\s\S])/.test(v.sha256);
}
