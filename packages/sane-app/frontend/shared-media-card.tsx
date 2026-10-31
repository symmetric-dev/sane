import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { FiChevronLeft, FiChevronRight, FiImage, FiVideo, FiX } from "react-icons/fi";
import type { MediaShareItem, MediaShareRecord } from "../shared/media-share-contract";
import type { MediaShareProjection } from "./media-share-client";
import { mediaShareContentUrl, mediaShareFilename } from "./media-share-presentation";
import { MediaSaveButton } from "./media-save-button";
import { MediaImageCache } from "./media-image-cache";
import { MediaGalleryImage } from "./media-gallery-image";
import { ShellDialog } from "./shell-dialog";
import { SnapshotImage } from "./snapshot-image";
import { ChatButton, ChatCard, ChatCardBody, ChatCardHeader, ChatIconButton, ChatNotice } from "./chat-ui";
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
  return failed ? <p role="status">Video could not be played. <ChatButton onClick={retry}>Retry preview</ChatButton></p> : <video ref={ref} src={src} aria-label={name} controls playsInline preload="metadata" onError={event => { event.currentTarget.pause(); setFailed(true); }}>Your browser cannot play this MP4. Use Save / Share to save the video instead.</video>;
}

function MediaPreview({ share, item, open }: { share: MediaShareRecord; item: MediaShareItem; open?: () => void }) {
  const [attempt, setAttempt] = useState(0);
  const src = mediaShareContentUrl(share, item), name = mediaShareFilename(item);
  const retry = () => setAttempt(value => value + 1);
  return item.kind === "video" ? <SnapshotVideo key={attempt} src={src} name={name} retry={retry} /> : <SnapshotImage key={attempt} src={src} name={name} retry={retry} open={open} />;
}

/** One reader, with lazy image thumbnails and no video thumbnail requests. */
function MediaGalleryReader({ share, imageCache, page, select, active = true, expanded = false, openModal, closeModal, containerRef, inactiveMessage = "Preview paused while this transcript is inactive." }: {
  share: MediaShareRecord; imageCache: MediaImageCache; page: number; select: (index: number) => void; active?: boolean; expanded?: boolean; openModal?: () => void; closeModal?: () => void; containerRef?: RefObject<HTMLElement | null>; inactiveMessage?: string;
}) {
  const panel = useId();
  const thumbnails = useRef<HTMLOListElement>(null), focusSelection = useRef(false);
  useLayoutEffect(() => {
    const list = thumbnails.current, button = list?.querySelector<HTMLButtonElement>(`button[data-media-page="${page}"]`);
    if (active && list && button) {
      if (focusSelection.current) button.focus({ preventScroll: true });
      // Scroll only the selector, never the surrounding transcript.
      const bounds = list.getBoundingClientRect(), selected = button.getBoundingClientRect();
      if (selected.left < bounds.left) list.scrollLeft += selected.left - bounds.left;
      else if (selected.right > bounds.right) list.scrollLeft += selected.right - bounds.right;
      if (selected.top < bounds.top) list.scrollTop += selected.top - bounds.top;
      else if (selected.bottom > bounds.bottom) list.scrollTop += selected.bottom - bounds.bottom;
    }
    focusSelection.current = false;
  }, [active, page]);
  useEffect(() => {
    if (!active || share.media[page]?.kind !== "image") return;
    for (const offset of [1, -1, 2, -2]) {
      const neighbor = share.media[page + offset];
      if (neighbor?.kind === "image") imageCache.prefetch(mediaShareContentUrl(share, neighbor));
    }
  }, [active, page, share, imageCache]);
  const item = share.media[page];
  if (!item) return null;
  const name = mediaShareFilename(item), count = share.media.length;
  // Reserve both neighbor slots at the ends so the current item never shifts
  // away from the middle of the full-view selector.
  const thumbnailIndices = expanded ? [page - 1, page, page + 1] : share.media.map((_, index) => index);
  const previous = <ChatIconButton aria-label="Previous media item" title="Previous" disabled={!active || page === 0} onClick={() => select(page - 1)}><FiChevronLeft /></ChatIconButton>;
  const next = <ChatIconButton aria-label="Next media item" title="Next" disabled={!active || page === count - 1} onClick={() => select(page + 1)}><FiChevronRight /></ChatIconButton>;
  const navigate = (event: KeyboardEvent<HTMLElement>) => {
    // Native video controls own their arrows, space, Home and End keys.
    if (!active || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !(event.target instanceof Element) || event.target.closest("video, input, select, textarea, [contenteditable=true]")) return;
    const next = event.key === "ArrowLeft" || event.key === "ArrowUp" ? Math.max(0, page - 1) : event.key === "ArrowRight" || event.key === "ArrowDown" ? Math.min(count - 1, page + 1) : event.key === "Home" ? 0 : event.key === "End" ? count - 1 : null;
    if (next !== null) {
      event.preventDefault();
      if (next !== page) focusSelection.current = !!event.target.closest(".shared-media-thumbnails");
      select(next);
    }
  };
  return <ChatCard ref={containerRef} tabIndex={-1} density="compact" className={`shared-media-card shared-media-gallery${count > 1 ? " shared-media-multiple" : ""}${expanded ? " shared-media-expanded" : ""}`} aria-label="Shared media gallery" onKeyDown={navigate}>
    <ChatCardHeader className="shared-media-header" title={<><span className="shared-media-heading-name" title={name}>{item.kind === "video" && openModal ? <button type="button" className="shared-media-video-open" aria-label={`Open ${name} in full view`} onClick={openModal}>{name}</button> : name}</span>{count > 1 && <span className="shared-media-count" role="status" aria-live="polite">{page + 1} / {count}</span>}</>}
      actions={<>
      {expanded ? <>
        <MediaSaveButton key={item.id} share={share} item={item} />
        {count > 1 && <MediaSaveButton share={share} label="Share All" />}
      </> : <MediaSaveButton share={share} />}
      {closeModal && <ChatIconButton aria-label="Close media gallery" onClick={closeModal}><FiX /></ChatIconButton>}
    </>} />
    <ChatCardBody flush id={panel} data-media-index={page} className="shared-media-preview" tabIndex={active && !openModal ? 0 : -1} aria-label={`Preview: ${name}`}>
      {active ? item.kind === "image" ? <MediaGalleryImage cache={imageCache} share={share} item={item} open={openModal} /> : <MediaPreview key={item.id} share={share} item={item} /> : <p className="shared-media-caption">{inactiveMessage}</p>}
    </ChatCardBody>
    {count > 1 && <nav className="shared-media-navigation" aria-label="Media navigation">
      {expanded ? previous : <div className="shared-media-pagination">{previous}{next}</div>}
      <ol ref={thumbnails} className="shared-media-thumbnails" aria-label="Media items">
        {thumbnailIndices.map(index => {
          const entry = share.media[index];
          if (!entry) return <li key={`empty-${index}`} aria-hidden="true" />;
          const filename = mediaShareFilename(entry);
          return <li key={entry.id}><button type="button" data-media-page={index} disabled={!active} aria-pressed={index === page} aria-controls={panel} aria-label={`Show item ${index + 1}: ${filename}`} title={filename} onClick={() => select(index)}>
            <span className="shared-media-thumbnail">{entry.kind === "video" ? <FiVideo aria-hidden="true" /> : active ? <SnapshotImage src={mediaShareContentUrl(share, entry)} name={filename} thumbnail /> : <FiImage aria-hidden="true" />}</span>
            <span className="shared-media-item-name">{filename}</span>
          </button></li>;
        })}
      </ol>
      {expanded && next}
    </nav>}
  </ChatCard>;
}

function MediaTilesReader({ share, type, active, openModal, inactiveMessage, containerRef }: {
  share: MediaShareRecord; type: "row" | "grid"; active: boolean; openModal?: (index: number) => void; inactiveMessage: string; containerRef: RefObject<HTMLElement | null>;
}) {
  return <ChatCard ref={containerRef} tabIndex={-1} density="compact" className={`shared-media-card shared-media-tiles shared-media-${type}`} aria-label={`Shared media ${type}`}>
    <ChatCardHeader className="shared-media-header" title={<><span className="shared-media-heading-name">Shared media</span><span className="shared-media-count">{share.media.length} items</span></>} actions={<MediaSaveButton share={share} />} />
    <ol className="shared-media-tile-list" style={type === "row" ? { gridTemplateColumns: `repeat(${share.media.length}, minmax(0, 1fr))` } : undefined}>
      {share.media.map((item, index) => {
        const name = mediaShareFilename(item);
        return <li key={item.id} data-media-index={index} className="shared-media-tile">
          <div className="shared-media-preview">
            {active ? <MediaPreview share={share} item={item} open={openModal ? () => openModal(index) : undefined} /> : <p className="shared-media-caption">{inactiveMessage}</p>}
          </div>
          <span className="shared-media-caption shared-media-tile-name" title={name}>{item.kind === "video" && openModal ? <button type="button" className="shared-media-video-open" aria-label={`Open ${name} in full view`} onClick={() => openModal(index)}>{name}</button> : name}</span>
        </li>;
      })}
    </ol>
  </ChatCard>;
}

function MediaShareLayout({ share, active }: { share: MediaShareRecord; active: boolean }) {
  const [page, setPage] = useState(0), [expanded, setExpanded] = useState(false);
  const [imageCache] = useState(() => new MediaImageCache());
  useEffect(() => { if (!active) imageCache.clear(); return () => imageCache.clear(); }, [active, imageCache]);
  const containerRef = useRef<HTMLElement>(null), focusIndex = useRef(0);
  useLayoutEffect(() => { if (!active) setExpanded(false); }, [active]);
  const selected = Math.min(page, share.media.length - 1);
  const reader = { share, imageCache, page: selected, select: setPage };
  const type = share.input.type ?? "gallery";
  const inlineActive = active && !expanded;
  const inactiveMessage = active && expanded ? "Preview open in expanded gallery." : "Preview paused while this transcript is inactive.";
  const openModal = (index: number) => { focusIndex.current = index; setPage(index); setExpanded(true); };
  const restoreFocus = () => containerRef.current?.querySelector<HTMLElement>(`[data-media-index="${focusIndex.current}"] .snapshot-image-open, [data-media-index="${focusIndex.current}"] .shared-media-video-open`) ?? containerRef.current?.querySelector<HTMLElement>(".snapshot-image-open, .shared-media-video-open") ?? containerRef.current;
  return <>
    {type === "gallery"
      ? <MediaGalleryReader {...reader} containerRef={containerRef} active={inlineActive} openModal={inlineActive ? () => openModal(selected) : undefined} inactiveMessage={inactiveMessage} />
      : <MediaTilesReader share={share} containerRef={containerRef} type={type} active={inlineActive} openModal={inlineActive ? openModal : undefined} inactiveMessage={inactiveMessage} />}
    {active && expanded && <ShellDialog title="Shared media gallery" className="shared-media-dialog" bare restoreFocus={restoreFocus} close={() => setExpanded(false)}><MediaGalleryReader {...reader} expanded closeModal={() => setExpanded(false)} /></ShellDialog>}
  </>;
}

export function SharedMediaCard({ share, active = true }: { share: MediaShareRecord; active?: boolean }) {
  // Identity changes unmount all players, reset selection, and close the dialog.
  // Presentation inactivity releases previews and dialogs but retains selection.
  return <MediaShareLayout key={`${share.sessionId}:${share.id}`} share={share} active={active} />;
}

export function MediaShareStatus({ projection }: { projection?: MediaShareProjection }) {
  return projection?.error ? <ChatNotice className="shared-media-notice" tone="warning" role="alert" actions={<ChatButton onClick={projection.retry}>Retry shared media</ChatButton>}>Shared media refresh unavailable: {projection.error}</ChatNotice> : null;
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
  return <ChatNotice className="shared-media-pending" aria-label="Shared media snapshot" role="status" tone={failed || projection?.error ? "warning" : "neutral"} actions={<ChatButton onClick={projection?.retry} disabled={!projection || projection.loading}>Retry snapshot</ChatButton>}>{status}</ChatNotice>;
}
