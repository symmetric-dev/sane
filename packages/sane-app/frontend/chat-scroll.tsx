import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { FiArrowDown } from "react-icons/fi";

/** Gesture intent wins over concurrent content growth, independent of layout. */
export class FollowLatest {
  following = true;
  private lastTop = 0;
  pause() { this.following = false; }
  follow() { this.following = true; }
  scrolled(top: number, height: number, client: number) {
    if (top < this.lastTop) this.following = false;
    else if (height - client - top <= 4) this.following = true;
    this.lastTop = top;
  }
}

export function ChatScroll({ children, footer, resetKey, replacement, active = true }: { children: ReactNode; footer: ReactNode; resetKey?: string; replacement?: ReactNode; active?: boolean }) {
  const viewport = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const replaced = useRef(!!replacement); replaced.current = !!replacement;
  const transcriptTop = useRef(0);
  const wasReplaced = useRef(false);
  const activity = useRef(active); activity.current = active;
  const wasActive = useRef(active);
  const policy = useRef(new FollowLatest());
  const [following, setFollowing] = useState(true);
  const latest = () => {
    policy.current.follow(); setFollowing(true);
    const element = viewport.current;
    if (element) { element.scrollTop = element.scrollHeight; transcriptTop.current = element.scrollTop; policy.current.scrolled(element.scrollTop, element.scrollHeight, element.clientHeight); }
  };
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => { if (activity.current && !replaced.current && policy.current.following) latest(); });
    observer.observe(content.current!); observer.observe(viewport.current!);
    return () => observer.disconnect();
  }, []);
  // Conversation switches reset the follow policy without unmounting, so the
  // transcript, focus, and composer buffer survive.
  useLayoutEffect(() => {
    policy.current.follow(); setFollowing(true);
    const element = viewport.current;
    if (element) { element.scrollTop = element.scrollHeight; transcriptTop.current = element.scrollTop; policy.current.scrolled(element.scrollTop, element.scrollHeight, element.clientHeight); }
  }, [resetKey]);
  useLayoutEffect(() => {
    if (replacement) { policy.current.pause(); setFollowing(false); }
    if (!replacement && wasReplaced.current && viewport.current) viewport.current.scrollTop = transcriptTop.current;
    wasReplaced.current = !!replacement;
  }, [!!replacement]);
  useLayoutEffect(() => {
    if (active && !wasActive.current && !replacement && viewport.current) viewport.current.scrollTop = transcriptTop.current;
    wasActive.current = active;
  }, [active, !!replacement]);
  const pause = () => { policy.current.pause(); setFollowing(false); };
  return <><div ref={viewport} className="viewport" hidden={!!replacement} style={replacement ? { display: "none" } : undefined} onWheel={event => { if (event.deltaY < 0) pause(); }} onTouchStart={pause}
    onPointerDown={pause} onKeyDown={event => { if (["ArrowUp", "PageUp", "Home"].includes(event.key)) pause(); }}
    onScroll={event => { if (replaced.current || !activity.current) return; const el = event.currentTarget; transcriptTop.current = el.scrollTop; policy.current.scrolled(el.scrollTop, el.scrollHeight, el.clientHeight); setFollowing(policy.current.following); }}>
    <div ref={content}>{children}</div>
  </div>{replacement}<div className="composer-dock">{!replacement && !following && <button type="button" className="scroll-bottom" aria-label="Scroll to latest message" onClick={latest}><FiArrowDown size={15} aria-hidden="true" /></button>}{footer}</div></>;
}
