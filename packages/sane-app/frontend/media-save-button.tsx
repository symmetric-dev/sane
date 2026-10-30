import { useLayoutEffect, useRef, useState } from "react";
import { FiAlertCircle, FiShare2 } from "react-icons/fi";
import type { MediaShareItem, MediaShareRecord } from "../shared/media-share-contract";
import { mediaShareFilename } from "./media-share-presentation";
import { saveSharedMedia } from "./media-share-save";

export function MediaSaveButton({ share, item, iconOnly = false }: { share: MediaShareRecord; item: MediaShareItem; iconOnly?: boolean }) {
  const [status, setStatus] = useState<"idle" | "busy" | "ready" | "error">("idle");
  const [message, setMessage] = useState("");
  const controller = useRef<AbortController | null>(null);
  const prepared = useRef<File | undefined>(undefined);
  useLayoutEffect(() => () => { controller.current?.abort(); prepared.current = undefined; }, []);
  const name = mediaShareFilename(item);
  const label = status === "busy" ? "Preparing…" : status === "ready" ? "Share file" : status === "error" ? "Retry save" : "Save / Share";
  const description = `${label}: ${name}${message ? `. ${message}` : ""}`;
  const save = async () => {
    if (controller.current) return;
    const request = new AbortController();
    controller.current = request;
    setStatus("busy");
    setMessage("");
    try {
      const file = await saveSharedMedia(share, item, request.signal, prepared.current);
      if (request.signal.aborted) return;
      prepared.current = file;
      setStatus(file ? "ready" : "idle");
      setMessage(file ? "File ready. Tap again to open the share sheet." : "");
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
  return <>
    <button type="button" className="shared-media-save" aria-label={description} title={description} disabled={status === "busy"} onClick={save}>
      {status === "error" ? <FiAlertCircle aria-hidden="true" /> : <FiShare2 aria-hidden="true" />}{(!iconOnly || status === "ready" || status === "error") && label}
    </button>
    <span className="sr-only" role="status">{message}</span>
  </>;
}
