import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MediaShareItem, MediaShareRecord } from "../shared/media-share-contract";
import { ChatButton } from "./chat-ui";
import type { MediaImageCache } from "./media-image-cache";
import { mediaShareContentUrl, mediaShareFilename } from "./media-share-presentation";

function ImageFrame({ cache, share, item, attempt, visible, ready, failed }: {
  cache: MediaImageCache; share: MediaShareRecord; item: MediaShareItem; attempt: number; visible: boolean;
  ready: (item: MediaShareItem) => void; failed: (id: string) => void;
}) {
  const url = mediaShareContentUrl(share, item);
  const [preview, setPreview] = useState<{ src?: string; error?: boolean; attempt: number }>({ attempt });
  const image = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const lease = cache.acquire(url);
    let current = true;
    setPreview({ attempt });
    void lease.ready.then(src => { if (current) setPreview({ src, attempt }); }, () => { if (current) setPreview({ error: true, attempt }); });
    return () => { current = false; lease.release(); };
  }, [cache, url, attempt]);
  useEffect(() => { if (preview.error && preview.attempt === attempt) failed(item.id); }, [preview.error, preview.attempt, attempt, failed, item.id]);
  if (!preview.src || preview.attempt !== attempt) return null;
  return <img ref={image} className="shared-media-image-frame" data-visible={visible} aria-hidden={!visible} src={preview.src} alt={visible ? mediaShareFilename(item) : ""} decoding="async" onLoad={event => {
    const node = event.currentTarget;
    // The actual incoming DOM image must decode before retiring the old frame.
    void (node.decode ? node.decode() : Promise.resolve()).then(() => {
      if (image.current === node && node.isConnected) ready(item);
    }, () => { if (image.current === node && node.isConnected) failed(item.id); });
  }} onError={() => failed(item.id)} />;
}

/** Keep at most two mounted frames: the last rendered image and its replacement.
 * Keyed frames survive promotion from hidden candidate to visible image. */
export function MediaGalleryImage({ cache, share, item, open }: {
  cache: MediaImageCache; share: MediaShareRecord; item: MediaShareItem; open?: () => void;
}) {
  const [shown, setShown] = useState<MediaShareItem>();
  const [failure, setFailure] = useState<string>();
  const [attempts, setAttempts] = useState<Record<string, number>>({});
  const selected = useRef(item.id);
  useLayoutEffect(() => { selected.current = item.id; setFailure(undefined); }, [item.id]);
  const ready = useCallback((loaded: MediaShareItem) => {
    if (selected.current !== loaded.id) return;
    setShown(loaded); setFailure(undefined);
  }, []);
  const failed = useCallback((id: string) => { if (selected.current === id) setFailure(id); }, []);
  const current = shown?.id === item.id, error = failure === item.id;
  const frames = shown && !current ? [shown, item] : [item];
  const images = frames.map(frame => <ImageFrame key={frame.id} cache={cache} share={share} item={frame} attempt={attempts[frame.id] ?? 0} visible={frame.id === shown?.id} ready={ready} failed={failed} />);
  const name = mediaShareFilename(item);
  const retry = () => {
    cache.invalidate(mediaShareContentUrl(share, item));
    setFailure(undefined);
    setAttempts(values => ({ ...values, [item.id]: (values[item.id] ?? 0) + 1 }));
  };
  return <div className="shared-media-image-stage" aria-busy={!current && !error}>
    {open ? <button type="button" className="snapshot-image-open" aria-label={`Open ${shown ? mediaShareFilename(shown) : name} in full view`} disabled={!current} onClick={open}>{images}</button> : images}
    {(!current || error) && <div className="shared-media-image-message" role="status">
      {error ? <>Could not load {name}.{shown && !current && " Previous image is still shown."} <ChatButton variant="ghost" onClick={retry}>Retry</ChatButton></> : <>Loading {name}…</>}
    </div>}
  </div>;
}
