import { useRef, useState } from "react";
import { FiImage } from "react-icons/fi";

/** Callers key this reader by content identity to reset decode failures on reload. */
export function SnapshotImage({ src, name, thumbnail = false, retry }: { src: string; name: string; thumbnail?: boolean; retry?: () => void }) {
  const ref = useRef<HTMLImageElement>(null);
  const [failed, setFailed] = useState(false);
  if (failed) return thumbnail ? <FiImage aria-hidden="true" /> : <p role="status">Image could not be decoded. {retry && <button type="button" onClick={retry}>Retry preview</button>}</p>;
  return <img ref={ref} src={src} alt={thumbnail ? "" : name} loading="lazy" decoding="async" onError={() => setFailed(true)} onLoad={event => {
    const image = event.currentTarget;
    if (image.decode) void image.decode().catch(() => { if (ref.current === image) setFailed(true); });
  }} />;
}
