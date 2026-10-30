/** Raster formats shared by chat media and the workspace image preview. */
export const IMAGE_PREVIEW_MIME_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" } as const;
export type ImagePreviewMimeType = typeof IMAGE_PREVIEW_MIME_TYPES[keyof typeof IMAGE_PREVIEW_MIME_TYPES];

export function imagePreviewMimeType(path: string): ImagePreviewMimeType | undefined {
  const extension = /\.[^./]+$/.exec(path)?.[0]?.toLowerCase();
  return extension && Object.hasOwn(IMAGE_PREVIEW_MIME_TYPES, extension) ? IMAGE_PREVIEW_MIME_TYPES[extension as keyof typeof IMAGE_PREVIEW_MIME_TYPES] : undefined;
}
