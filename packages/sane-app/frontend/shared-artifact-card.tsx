import { useEffect, useId, useRef, useState } from "react";
import { FiArrowUpRight, FiCode, FiHelpCircle, FiImage, FiVideo } from "react-icons/fi";
import { ChatButton, ChatCard, ChatCardFooter, ChatCardHeader } from "./chat-ui";
import type { MediaImageCache } from "./media-image-cache";
import type { SharedArtifact } from "./shared-artifacts-model";

/** Only near-visible panel rows lease bytes; no gallery or media player mounts. */
function ArtifactThumbnail({ url, name, imageCache }: { url: string; name: string; imageCache: MediaImageCache }) {
  const target = useRef<HTMLSpanElement>(null);
  const [preview, setPreview] = useState<{ src?: string; loaded?: boolean }>({});
  useEffect(() => {
    const node = target.current;
    const root = node?.closest(".conversation-interactions-body, .workers-panel-body");
    // Without visibility observation, retain the lightweight fallback instead
    // of eagerly fetching an entire panel's images.
    if (!node || !root || typeof IntersectionObserver === "undefined") return;
    let lease: ReturnType<MediaImageCache["acquire"]> | undefined;
    let generation = 0;
    let disposed = false;
    const release = () => { generation++; lease?.release(); lease = undefined; };
    setPreview({});
    const observer = new IntersectionObserver(entries => {
      if (disposed) return;
      const entry = entries.at(-1);
      if (!entry?.isIntersecting) {
        release();
        setPreview({});
        return;
      }
      if (lease) return;
      lease = imageCache.acquire(url);
      const current = ++generation;
      void lease.ready.then(src => {
        if (current === generation) setPreview({ src });
      }, () => {
        if (current === generation) setPreview({});
      });
    }, { root, rootMargin: "80px 0px", threshold: 0 });
    observer.observe(node.closest(".interaction-artifact-card") ?? node);
    return () => { disposed = true; observer.disconnect(); release(); };
  }, [url, imageCache]);
  return <span ref={target} className="interaction-artifact-thumbnail" title={name}>
    <FiImage size={28} aria-hidden="true" />
    {preview.src && <img src={preview.src} alt="" width={40} height={40} loading="lazy" decoding="async" data-loaded={!!preview.loaded}
      onLoad={() => setPreview(value => ({ ...value, loaded: true }))} onError={() => setPreview({})} />}
  </span>;
}

export function SharedArtifactCard({ artifact, disabled = false, onSelect, imageCache }: {
  artifact: SharedArtifact;
  disabled?: boolean;
  onSelect: (artifact: SharedArtifact) => void;
  imageCache: MediaImageCache;
}) {
  const id = useId();
  const date = new Date(artifact.createdAt);
  const validDate = Number.isFinite(date.getTime());
  const timestamp = validDate ? date.toLocaleString() : artifact.createdAt;
  const shortTimestamp = validDate ? date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : artifact.createdAt;
  const action = artifact.kind === "questions" ? "Go to questions" : "Go to chat";
  const Glyph = artifact.kind === "code-share" ? FiCode : artifact.kind === "questions" ? FiHelpCircle : artifact.videoOnly ? FiVideo : FiImage;
  const image = artifact.kind === "media-share" && artifact.representativeImageUrl;
  const metadata = [artifact.kindLabel, artifact.itemLabel, timestamp].filter(Boolean).join(" · ");
  return <ChatCard density="compact" className="interaction-artifact-card" aria-labelledby={`${id}-title`} aria-describedby={`${id}-metadata${artifact.status ? ` ${id}-status` : ""}`}>
    <ChatCardHeader className="worker-two-row-header" titleId={`${id}-title`} title={<span title={artifact.title}>{artifact.title}</span>}
      icon={<span className="interaction-artifact-visual" title={artifact.representativeImageName ?? artifact.itemLabel}>
        {image ? <ArtifactThumbnail key={image} url={image} name={artifact.representativeImageName ?? artifact.title} imageCache={imageCache} /> : <Glyph size={40} aria-hidden="true" />}
        {artifact.kind === "media-share" && (image ? artifact.itemCount > 1 : artifact.videoOnly) && <span className="interaction-artifact-count">{image ? `+${artifact.itemCount - 1}` : artifact.itemCount}</span>}
      </span>}
      description={<span id={`${id}-metadata`} title={metadata}>{artifact.kindLabel}{artifact.itemLabel && <> · {artifact.itemLabel}</>} · <time dateTime={validDate ? artifact.createdAt : undefined} title={timestamp}>{shortTimestamp}</time></span>}
      actions={<ChatButton variant="ghost" icon={<FiArrowUpRight size={13} aria-hidden="true" />} disabled={disabled} aria-label={`${action}: ${artifact.title}`} title={`${action}: ${artifact.title}`} onClick={() => onSelect(artifact)}>{action}</ChatButton>} />
    {artifact.status && <ChatCardFooter className="interaction-artifact-footer"><span id={`${id}-status`} title={artifact.status}>{artifact.status}</span></ChatCardFooter>}
  </ChatCard>;
}
