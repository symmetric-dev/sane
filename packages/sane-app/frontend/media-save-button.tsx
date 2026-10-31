import { useLayoutEffect, useRef, useState } from "react";
import { FiAlertCircle, FiShare2 } from "react-icons/fi";
import type { MediaShareItem, MediaShareRecord } from "../shared/media-share-contract";
import { mediaShareFilename } from "./media-share-presentation";
import { saveSharedMedia, saveSharedMediaCollection } from "./media-share-save";
import { ChatButton } from "./chat-ui";

export function MediaSaveButton({ share, item, label: shareLabel = "Share" }: { share: MediaShareRecord; item?: MediaShareItem; label?: string }) {
  const [status, setStatus] = useState<"idle" | "busy" | "ready" | "error">("idle");
  const [message, setMessage] = useState("");
  const controller = useRef<AbortController | null>(null);
  const prepared = useRef<File[] | undefined>(undefined);
  useLayoutEffect(() => () => { controller.current?.abort(); prepared.current = undefined; }, []);
  const first = share.media[0];
  const name = item ? mediaShareFilename(item) : share.media.length === 1 && first ? mediaShareFilename(first) : `all ${share.media.length} media files`;
  const label = status === "busy" ? "Preparing…" : status === "ready" ? `${shareLabel} now` : status === "error" ? "Retry" : shareLabel;
  const description = `${label}: ${name}${message ? `. ${message}` : ""}`;
  const save = async () => {
    if (controller.current) return;
    const request = new AbortController();
    controller.current = request;
    setStatus("busy");
    setMessage("");
    try {
      const files = item
        ? await saveSharedMedia(share, item, request.signal, prepared.current?.[0]).then(file => file ? [file] : undefined)
        : await saveSharedMediaCollection(share, request.signal, prepared.current);
      if (request.signal.aborted) return;
      prepared.current = files;
      setStatus(files ? "ready" : "idle");
      setMessage(files ? `Files ready. Tap ${shareLabel} again to open the share sheet.` : "");
    } catch (error) {
      if (request.signal.aborted) return;
      if (error instanceof Error && error.name === "AbortError") {
        // Dismissing a native picker or share sheet is not a failed download.
        setStatus(prepared.current ? "ready" : "idle");
      } else {
        setStatus("error");
        setMessage("Could not save media. Please try again.");
      }
    } finally {
      if (controller.current === request) controller.current = null;
    }
  };
  const icon = status === "error" ? <FiAlertCircle /> : <FiShare2 />;
  return <>
    <ChatButton variant="ghost" className="shared-media-save" aria-label={description} title={description} busy={status === "busy"} icon={icon} onClick={save}>{label}</ChatButton>
    <span className="sr-only" role="status">{message}</span>
  </>;
}
