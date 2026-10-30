import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { FiChevronLeft, FiChevronRight, FiDownload, FiImage, FiMaximize2, FiVideo } from "react-icons/fi";
import type { MediaShareItem, MediaShareRecord } from "../shared/media-share-contract";
import type { MediaShareProjection } from "./media-share-client";
import { mediaShareContentUrl, mediaShareFilename } from "./media-share-presentation";
import { ShellDialog } from "./shell-dialog";
import { SnapshotImage } from "./snapshot-image";
import "./shared-media.css";

function SnapshotVideo({ src, name, retry }: { src: string; name: string; retry: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  useLayoutEffect(() => {
    const video = ref.current;
    // Restore src after development effect replay as well as normal mounting.
    if (video && video.getAttribute("src") !== src) video.setAttribute("src", src);
    return () => {
      if (!video) return;
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [src]);
  return failed ? <p role="status">Video could not be played. <button type="button" onClick={retry}>Retry preview</button></p> : <video ref={ref} src={src} aria-label={name} controls playsInline preload="metadata" onError={event => { event.currentTarget.pause(); setFailed(true); }}>Your browser cannot play this MP4. Download the video instead.</video>;
}

function MediaPreview({ share, item }: { share: MediaShareRecord; item: MediaShareItem }) {
  const [attempt, setAttempt] = useState(0);
  const src = mediaShareContentUrl(share, item), name = mediaShareFilename(item);
  const retry = () => setAttempt(value => value + 1);
  return item.kind === "video" ? <SnapshotVideo key={attempt} src={src} name={name} retry={retry} /> : <SnapshotImage key={attempt} src={src} name={name} retry={retry} />;
}

/** One reader, with bounded image thumbnails and no video thumbnail requests. */
function MediaGalleryReader({ share, page, select, active = true, expanded = false, openModal, inactiveMessage = "Preview paused while this transcript is inactive." }: {
  share: MediaShareRecord; page: number; select: (index: number) => void; active?: boolean; expanded?: boolean; openModal?: () => void; inactiveMessage?: string;
}) {
  const panel = useId();
  const root = useRef<HTMLElement>(null), focusSelection = useRef(false);
  useLayoutEffect(() => {
    if (active && focusSelection.current) root.current?.querySelector<HTMLButtonElement>(".shared-media-thumbnails button[aria-pressed=true]")?.focus();
    focusSelection.current = false;
  }, [active, page]);
  const item = share.media[page];
  if (!item) return null;
  const name = mediaShareFilename(item), count = share.media.length;
  const start = Math.max(0, Math.min(page - 2, count - 5));
  const navigate = (event: KeyboardEvent<HTMLElement>) => {
    // Native video controls own their arrows, space, Home and End keys.
    if (!active || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !(event.target instanceof Element) || event.target.closest("video, input, select, textarea, [contenteditable=true]")) return;
    const next = event.key === "ArrowLeft" ? Math.max(0, page - 1) : event.key === "ArrowRight" ? Math.min(count - 1, page + 1) : event.key === "Home" ? 0 : event.key === "End" ? count - 1 : null;
    if (next !== null) {
      event.preventDefault();
      if (next !== page) focusSelection.current = !!event.target.closest(".shared-media-thumbnails");
      select(next);
    }
  };
  return <section ref={root} className={`shared-media-card shared-media-gallery${count > 1 ? " shared-media-multiple" : ""}${expanded ? " shared-media-expanded" : ""}`} aria-label="Shared media gallery" onKeyDown={navigate}>
    <header>
      <strong title={name}>{name}</strong>
      {count > 1 && <span className="shared-media-count" role="status" aria-live="polite">{page + 1} of {count}</span>}
      <a href={mediaShareContentUrl(share, item)} download={name}><FiDownload aria-hidden="true" />Download</a>
      {openModal && <button type="button" aria-label="Expand media gallery" title="Expand media gallery" onClick={openModal}><FiMaximize2 aria-hidden="true" /></button>}
    </header>
    <div id={panel} className="shared-media-preview" tabIndex={active ? 0 : -1} aria-label={`Preview: ${name}`}>
      {active ? <MediaPreview key={item.id} share={share} item={item} /> : <p className="shared-media-caption">{inactiveMessage}</p>}
    </div>
    {count > 1 && <nav className="shared-media-navigation" aria-label="Media navigation">
      <div className="shared-media-pagination">
        <button type="button" aria-label="Previous media item" title="Previous" disabled={!active || page === 0} onClick={() => select(page - 1)}><FiChevronLeft aria-hidden="true" /></button>
        <button type="button" aria-label="Next media item" title="Next" disabled={!active || page === count - 1} onClick={() => select(page + 1)}><FiChevronRight aria-hidden="true" /></button>
      </div>
      <ol className="shared-media-thumbnails" start={start + 1} aria-label="Nearby media items">
        {share.media.slice(start, start + 5).map((entry, offset) => {
          const index = start + offset, filename = mediaShareFilename(entry);
          return <li key={entry.id}><button type="button" disabled={!active} aria-pressed={index === page} aria-controls={panel} aria-label={`Show item ${index + 1}: ${filename}`} title={filename} onClick={() => select(index)}>
            <span className="shared-media-thumbnail">{entry.kind === "video" ? <FiVideo aria-hidden="true" /> : active ? <SnapshotImage src={mediaShareContentUrl(share, entry)} name={filename} thumbnail /> : <FiImage aria-hidden="true" />}</span>
            <span className="shared-media-item-name">{filename}</span>
          </button></li>;
        })}
      </ol>
    </nav>}
  </section>;
}

function MediaShareGallery({ share, active }: { share: MediaShareRecord; active: boolean }) {
  const [page, setPage] = useState(0), [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => { if (!active) setExpanded(false); }, [active]);
  const selected = Math.min(page, share.media.length - 1);
  const reader = { share, page: selected, select: setPage };
  return <>
    <MediaGalleryReader {...reader} active={active && !expanded} openModal={active ? () => setExpanded(true) : undefined} inactiveMessage={active && expanded ? "Preview open in expanded gallery." : undefined} />
    {active && expanded && <ShellDialog title={mediaShareFilename(share.media[selected]!)} subtitle={share.media.length > 1 ? `${selected + 1} of ${share.media.length}` : undefined} className="shared-media-dialog" close={() => setExpanded(false)}><MediaGalleryReader {...reader} expanded /></ShellDialog>}
  </>;
}

export function SharedMediaCard({ share, active = true }: { share: MediaShareRecord; active?: boolean }) {
  // Identity changes unmount all players, reset selection, and close the dialog.
  // Presentation inactivity releases previews and dialogs but retains selection.
  return <MediaShareGallery key={`${share.sessionId}:${share.id}`} share={share} active={active} />;
}

export function MediaShareStatus({ projection }: { projection?: MediaShareProjection }) {
  return projection?.error ? <p className="shared-media-notice" role="alert">Shared media refresh unavailable: {projection.error} <button type="button" onClick={projection.retry}>Retry shared media</button></p> : null;
}

export function PendingMediaShare({ projection, running, failed }: { projection?: MediaShareProjection; running: boolean; failed?: boolean }) {
  const reportedError = failed ? "Media sharing reported an error. " : "";
  const status = projection?.error
    ? `${reportedError}Saved snapshot persistence is unconfirmed because shared media could not be refreshed.`
    : projection?.loading
      ? `${reportedError}Checking for a saved snapshot; persistence is unconfirmed…`
      : !projection?.loaded
        ? `${reportedError}Saved snapshot persistence is unconfirmed; retry the snapshot read.`
        : running
          ? `${reportedError}Waiting for the saved media snapshot…`
          : failed ? "Media sharing reported an error; no saved snapshot is available for this call." : "No saved media snapshot is available for this call.";
  return <section className="shared-media-card shared-media-pending" aria-label="Shared media snapshot"><p role="status">{status}</p><button type="button" onClick={projection?.retry} disabled={!projection || projection.loading}>Retry snapshot</button></section>;
}
