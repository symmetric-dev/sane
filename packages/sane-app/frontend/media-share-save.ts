import type { MediaShareItem, MediaShareRecord } from "../shared/media-share-contract";
import { mediaShareContentUrl, mediaShareFilename } from "./media-share-presentation";

type MediaSaveWindow = Window & {
  showSaveFilePicker?: (options: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<{
    createWritable: () => Promise<{
      write: (data: Blob) => Promise<void>;
      close: () => Promise<void>;
      abort: () => Promise<void>;
    }>;
  }>;
};

async function loadMediaFile(share: MediaShareRecord, item: MediaShareItem, signal: AbortSignal): Promise<File> {
  const response = await fetch(mediaShareContentUrl(share, item), { signal });
  if (!response.ok) throw new Error(`Could not load media (HTTP ${response.status}).`);
  return new File([await response.blob()], mediaShareFilename(item), { type: item.mimeType });
}

/** Returns a prepared file when the share sheet needs a fresh user gesture.
 * Never navigate to the content URL, even when native saving is unavailable. */
export async function saveSharedMedia(share: MediaShareRecord, item: MediaShareItem, signal: AbortSignal, prepared?: File): Promise<File | undefined> {
  const name = mediaShareFilename(item);
  const picker = (window as MediaSaveWindow).showSaveFilePicker;
  if (picker) {
    // Open before fetching so the picker keeps the click's user activation.
    const handle = await picker.call(window, {
      suggestedName: name,
      types: [{ description: item.kind === "image" ? "Image" : "Video", accept: { [item.mimeType]: [`.${name.split(".").at(-1)}`] } }],
    });
    const file = prepared ?? await loadMediaFile(share, item, signal);
    signal.throwIfAborted();
    const writable = await handle.createWritable();
    try {
      await writable.write(file);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
    return;
  }

  const file = prepared ?? await loadMediaFile(share, item, signal);
  signal.throwIfAborted();
  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    // A slow fetch can consume transient activation, especially in iOS PWAs.
    // Keep the bytes for a second tap instead of navigating or forcing a download.
    if (!prepared && navigator.userActivation?.isActive !== true) return file;
    try {
      await navigator.share({ files: [file] });
    } catch (error) {
      // Some browsers report activation but still reject a post-fetch share.
      if (!prepared && error instanceof Error && error.name === "NotAllowedError") return file;
      throw error;
    }
    return;
  }

  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Give the browser time to consume the blob before releasing it.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
