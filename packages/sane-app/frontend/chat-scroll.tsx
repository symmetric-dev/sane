import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { FiArrowDown } from "react-icons/fi";
import { useSendNavigation, type SendNavigationState } from "./send-navigation";

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

export function ChatScroll({ children, footer, resetKey, replacement, active = true, sendNavigation }: { children: ReactNode; footer: ReactNode; resetKey?: string; replacement?: ReactNode; active?: boolean; sendNavigation?: Omit<SendNavigationState, "active"> }) {
  const viewport = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const replaced = useRef(!!replacement); replaced.current = !!replacement;
  const transcriptTop = useRef(0);
  const wasReplaced = useRef(false);
  const activity = useRef(active); activity.current = active;
  const wasActive = useRef(active);
  const policy = useRef(new FollowLatest());
  // A programmatic jump can land near the bottom. Its scroll event must not
  // re-enable following; only another deliberate gesture/latest action can.
  const targetedPause = useRef(false);
  const [following, setFollowing] = useState(true);
  const pause = () => { policy.current.pause(); setFollowing(false); };
  const targetPause = () => { targetedPause.current = true; pause(); };
  const target = useSendNavigation(viewport, { sessionId: resetKey ?? "", loading: true, connected: false, connectionError: "", handoffLoading: true, ...sendNavigation, active: active && !replacement && !!sendNavigation }, targetPause);
  const latest = () => {
    target.cancel(); targetedPause.current = false;
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
    if (target.targeting) { targetPause(); return; }
    targetedPause.current = false;
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
  const interrupt = () => { target.cancel(); targetedPause.current = false; };
  return <><div ref={viewport} className="viewport" hidden={!!replacement} style={replacement ? { display: "none" } : undefined} onWheel={event => { interrupt(); if (event.deltaY < 0) pause(); }} onTouchStart={() => { interrupt(); pause(); }}
    onPointerDown={() => { interrupt(); pause(); }} onKeyDown={event => { if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) { interrupt(); pause(); } }}
    onScroll={event => { if (replaced.current || !activity.current) return; const el = event.currentTarget; transcriptTop.current = el.scrollTop; if (targetedPause.current) return; policy.current.scrolled(el.scrollTop, el.scrollHeight, el.clientHeight); setFollowing(policy.current.following); }}>
    <div ref={content}>{children}</div>
  </div>{replacement}<div className="composer-dock">{target.notice && <p className="notice send-navigation-notice" role="status">{target.notice}</p>}{!replacement && !following && <button type="button" className="scroll-bottom" aria-label="Scroll to latest message" onClick={latest}><FiArrowDown size={15} aria-hidden="true" /></button>}{footer}</div></>;
}
