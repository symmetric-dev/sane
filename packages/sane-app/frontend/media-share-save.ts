import type { MediaShareItem, MediaShareRecord } from "../shared/media-share-contract";
import { mediaShareContentUrl, mediaShareFilename } from "./media-share-presentation";
import { mediaShareArchive } from "./media-share-archive";

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

  downloadFile(file);
}

/** Share every file in one native sheet, or save one archive when multi-file
 * sharing is unavailable. Keep prepared bytes for a fresh user gesture. */
export async function saveSharedMediaCollection(share: MediaShareRecord, signal: AbortSignal, prepared?: File[]): Promise<File[] | undefined> {
  const first = share.media[0];
  if (!first) throw new Error("No shared media is available.");
  if (share.media.length === 1) {
    const file = await saveSharedMedia(share, first, signal, prepared?.[0]);
    return file ? [file] : undefined;
  }
  const name = `shared-media-${share.id.slice(0, 12)}.zip`;
  const picker = (window as MediaSaveWindow).showSaveFilePicker;
  // Desktop save pickers must be opened directly from the user's click.
  const handle = picker ? await picker.call(window, { suggestedName: name, types: [{ description: "Media collection", accept: { "application/zip": [".zip"] } }] }) : undefined;
  const files: File[] = prepared ?? [];
  if (!prepared) {
    // Bound fetch/decode memory and stop fetching the rest on cancellation.
    for (const item of share.media) {
      signal.throwIfAborted();
      files.push(await loadMediaFile(share, item, signal));
    }
  }
  signal.throwIfAborted();
  if (!handle && navigator.share && navigator.canShare?.({ files })) {
    if (!prepared && navigator.userActivation?.isActive !== true) return files;
    try {
      await navigator.share({ files });
    } catch (error) {
      if (!prepared && error instanceof Error && error.name === "NotAllowedError") return files;
      throw error;
    }
    return;
  }
  const archive = await mediaShareArchive(files, name, signal);
  signal.throwIfAborted();
  if (handle) {
    const writable = await handle.createWritable();
    try {
      await writable.write(archive);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
  } else downloadFile(archive);
}

function downloadFile(file: File) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
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
