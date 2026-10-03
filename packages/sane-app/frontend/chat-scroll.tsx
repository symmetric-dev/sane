import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { FiArrowDown } from "react-icons/fi";
import { useSendNavigation, type SendNavigationState } from "./send-navigation";

/** Gesture intent wins over concurrent content growth, independent of layout. */
export class FollowLatest {
  following = true;
  private lastTop = 0;
  pause() { this.following = false; }
  follow() { this.following = true; }
  position(top: number) { this.lastTop = top; }
  /** Deliberate scrolling only. Layout/reset observations use position(). */
  scrolled(top: number, height: number, client: number) {
    if (top < this.lastTop) this.following = false;
    else if (height - client - top <= 4) this.following = true;
    this.lastTop = top;
  }
}

export function ChatScroll({ children, footer, resetKey, replacement, active = true, sendNavigation, history }: { children: ReactNode; footer: ReactNode; resetKey?: string; replacement?: ReactNode; active?: boolean; sendNavigation?: Omit<SendNavigationState, "active">; history?: { key: string; canLoad: boolean; load: () => void } }) {
  const viewport = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const replaced = useRef(!!replacement); replaced.current = !!replacement;
  const transcriptTop = useRef(0);
  const wasReplaced = useRef(false);
  const activity = useRef(active); activity.current = active;
  const wasActive = useRef(active);
  const policy = useRef(new FollowLatest());
  const historyRef = useRef(history); historyRef.current = history;
  const navigationRef = useRef(sendNavigation); navigationRef.current = sendNavigation;
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const programmedTop = useRef<number | null>(null);
  const upwardIntent = useRef(false), pointerIntent = useRef(false), touchY = useRef<number | null>(null);
  const gesture = useRef<{ direction: number; until: number }>({ direction: 0, until: 0 });
  const selectionStart = useRef<{ x: number; y: number } | null>(null);
  const restoreFrame = useRef(0);
  // A programmatic jump can land near the bottom. Its scroll event must not
  // re-enable following; only another deliberate gesture/latest action can.
  const targetedPause = useRef(false);
  const targeting = useRef(false);
  const [following, setFollowing] = useState(true);
  const captureAnchor = () => {
    const root = viewport.current;
    if (!root || replaced.current || !activity.current || targetedPause.current && targeting.current) return;
    const bounds = root.getBoundingClientRect();
    const message = [...root.querySelectorAll<HTMLElement>("[data-transcript-message]")].find(element => { const rect = element.getBoundingClientRect(); return rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom; });
    anchor.current = message ? { id: message.dataset.transcriptMessage!, offset: message.getBoundingClientRect().top - bounds.top } : null;
  };
  const pause = () => { policy.current.pause(); setFollowing(false); captureAnchor(); };
  const targetPause = () => { targetedPause.current = true; targeting.current = true; anchor.current = null; upwardIntent.current = false; gesture.current = { direction: 0, until: 0 }; pause(); };
  const target = useSendNavigation(viewport, { sessionId: resetKey ?? "", loading: true, connected: false, connectionError: "", handoffLoading: true, ...sendNavigation, active: active && !replacement && !!sendNavigation }, targetPause);
  targeting.current = target.targeting;
  useLayoutEffect(() => { if (targetedPause.current && !target.targeting) captureAnchor(); }, [target.targeting]);
  const placeLatest = () => {
    const element = viewport.current;
    // resetKey can change before assistant-ui publishes the new transcript.
    // Keep bottom intent, but don't position against the previous session's DOM.
    if (navigationRef.current && element?.querySelector<HTMLElement>("[data-send-transcript-ready]")?.dataset.sendTranscriptReady !== navigationRef.current.sessionId) return;
    if (element) { element.scrollTop = element.scrollHeight; programmedTop.current = element.scrollTop; transcriptTop.current = element.scrollTop; policy.current.position(element.scrollTop); }
  };
  const latest = () => {
    target.cancel(); targetedPause.current = false;
    anchor.current = null; upwardIntent.current = false; gesture.current = { direction: 0, until: 0 };
    policy.current.follow(); setFollowing(true); placeLatest();
  };
  const restore = () => {
    const root = viewport.current;
    if (!root || !activity.current || replaced.current || targetedPause.current && targeting.current) return;
    if (policy.current.following) { placeLatest(); return; }
    const saved = anchor.current;
    if (!saved) { captureAnchor(); return; }
    const message = [...root.querySelectorAll<HTMLElement>("[data-transcript-message]")].find(element => element.dataset.transcriptMessage === saved.id);
    if (!message) return; // external assistant-ui runtime may still be catching up
    const delta = message.getBoundingClientRect().top - root.getBoundingClientRect().top - saved.offset;
    if (Math.abs(delta) > 0.5) { root.scrollTop += delta; programmedTop.current = root.scrollTop; }
    transcriptTop.current = root.scrollTop; policy.current.position(root.scrollTop);
  };
  const scheduleRestore = () => {
    cancelAnimationFrame(restoreFrame.current);
    restoreFrame.current = requestAnimationFrame(restore);
  };
  useLayoutEffect(() => {
    const schedule = () => { restore(); scheduleRestore(); };
    // Mutation handles the runtime's delayed prepend; resize handles later
    // markdown/code layout. A visible message ID, not scrollHeight, is the anchor.
    const observer = new ResizeObserver(schedule);
    observer.observe(content.current!); observer.observe(viewport.current!);
    const mutations = new MutationObserver(schedule); mutations.observe(content.current!, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-send-transcript-ready", "hidden"] });
    const release = () => { pointerIntent.current = false; selectionStart.current = null; };
    const document = viewport.current!.ownerDocument;
    document.addEventListener("pointerup", release); document.addEventListener("pointercancel", release);
    return () => { observer.disconnect(); mutations.disconnect(); cancelAnimationFrame(restoreFrame.current); document.removeEventListener("pointerup", release); document.removeEventListener("pointercancel", release); };
  }, []);
  // Conversation switches reset the follow policy without unmounting, so the
  // transcript, focus, and composer buffer survive.
  useLayoutEffect(() => {
    pointerIntent.current = false; selectionStart.current = null; touchY.current = null;
    gesture.current = { direction: 0, until: 0 };
    if (target.targeting) { targetPause(); return; }
    anchor.current = null; upwardIntent.current = false; programmedTop.current = null;
    targetedPause.current = false;
    policy.current = new FollowLatest(); setFollowing(true);
    placeLatest(); scheduleRestore();
  }, [resetKey]);
  useLayoutEffect(() => {
    if (!replacement && wasReplaced.current && viewport.current) { viewport.current.scrollTop = transcriptTop.current; programmedTop.current = viewport.current.scrollTop; policy.current.position(viewport.current.scrollTop); restore(); }
    wasReplaced.current = !!replacement;
  }, [!!replacement]);
  useLayoutEffect(() => {
    if (active && !wasActive.current && !replacement && viewport.current) { viewport.current.scrollTop = transcriptTop.current; programmedTop.current = viewport.current.scrollTop; policy.current.position(viewport.current.scrollTop); restore(); }
    wasActive.current = active;
  }, [active, !!replacement]);
  const interrupt = () => { target.cancel(); targetedPause.current = false; };
  const readGesture = (direction: number) => {
    interrupt(); programmedTop.current = null;
    gesture.current = { direction, until: performance.now() + 350 };
    if (direction < 0) { upwardIntent.current = true; pause(); loadNearTop(); }
  };
  const loadNearTop = () => {
    if (!upwardIntent.current || !activity.current || replaced.current || targetedPause.current || !historyRef.current?.canLoad || (viewport.current?.scrollTop ?? Infinity) > 160) return;
    upwardIntent.current = false; captureAnchor(); historyRef.current.load();
  };
  return <><div ref={viewport} className="viewport" hidden={!!replacement} style={{ overflowAnchor: "none", ...(replacement ? { display: "none" } : {}) }} onWheel={event => { if (event.deltaY) readGesture(Math.sign(event.deltaY)); }} onTouchStart={event => { interrupt(); touchY.current = event.touches[0]?.clientY ?? null; }}
    onTouchMove={event => { const y = event.touches[0]?.clientY; if (y !== undefined && touchY.current !== null && y !== touchY.current) readGesture(Math.sign(touchY.current - y)); touchY.current = y ?? null; }} onTouchEnd={() => { touchY.current = null; }} onTouchCancel={() => { touchY.current = null; }}
    onPointerDown={event => {
      interrupt();
      const root = event.currentTarget, element = event.target as HTMLElement;
      const bounds = root.getBoundingClientRect();
      pointerIntent.current = event.pointerType !== "touch" && element === root && event.clientX >= bounds.left + root.clientWidth;
      selectionStart.current = event.pointerType === "mouse" && !element.closest("button, summary, a, input, textarea, [role=tab]") ? { x: event.clientX, y: event.clientY } : null;
      if (pointerIntent.current) { programmedTop.current = null; gesture.current = { direction: 0, until: 0 }; pause(); }
    }} onClickCapture={event => {
      // Capture before the tool/history control changes layout. A touch-down
      // on a tool row may begin a swipe, so only activation pauses reading.
      if ((event.target as HTMLElement).closest("button, summary, [role=tab]")) { interrupt(); programmedTop.current = null; gesture.current = { direction: 0, until: 0 }; pause(); }
    }} onPointerMove={event => {
      const start = selectionStart.current;
      if (start && event.buttons && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4 && viewport.current?.ownerDocument.getSelection()?.type === "Range") { selectionStart.current = null; pause(); }
    }} onKeyDownCapture={event => {
      const element = event.target as HTMLElement;
      if (element.closest("input, textarea, select, [contenteditable=true]")) return;
      const control = element.closest("button, summary, [role=tab]");
      // Anchor before activation/tab navigation can expand or collapse a body.
      // Native scroll keys on ordinary buttons/summaries are handled in bubble.
      if (control && ["Enter", " "].includes(event.key) || element.closest("[role=tab]") && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        interrupt(); programmedTop.current = null; gesture.current = { direction: 0, until: 0 }; pause();
      }
    }} onKeyDown={event => {
      if (event.defaultPrevented || !activity.current || replaced.current) return;
      const element = event.target as HTMLElement;
      if (element.closest("input, textarea, select, [contenteditable=true]")) return;
      if (element.closest("button, summary") && ["Enter", " "].includes(event.key)) return;
      // Handled activity-tab keys prevent default and stop propagation, so only
      // unhandled native scrolling reaches here, before browser default action.
      if (!["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) return;
      const direction = ["ArrowUp", "PageUp", "Home"].includes(event.key) || event.key === " " && event.shiftKey ? -1 : 1;
      readGesture(direction);
    }} onScroll={event => {
      if (event.target !== event.currentTarget || replaced.current || !activity.current) return;
      const el = event.currentTarget, oldTop = transcriptTop.current;
      transcriptTop.current = el.scrollTop;
      if (targetedPause.current) { policy.current.position(el.scrollTop); return; }
      if (programmedTop.current !== null && Math.abs(programmedTop.current - el.scrollTop) < 1) { programmedTop.current = null; policy.current.position(el.scrollTop); return; }
      programmedTop.current = null;
      const direction = el.scrollTop - oldTop;
      const deliberate = pointerIntent.current || performance.now() <= gesture.current.until && Math.sign(direction) === gesture.current.direction;
      if (!deliberate || !direction) {
        // Clamping after collapse/reset is not a user gesture and must not
        // replace a reading anchor or consume initial bottom intent.
        policy.current.position(el.scrollTop); scheduleRestore(); return;
      }
      if (direction < 0) upwardIntent.current = true;
      policy.current.scrolled(el.scrollTop, el.scrollHeight, el.clientHeight); setFollowing(policy.current.following);
      if (policy.current.following) anchor.current = null; else captureAnchor();
      loadNearTop();
    }}>
    <div ref={content}>{children}</div>
  </div>{replacement}<div className="composer-dock">{target.notice && <p className="notice send-navigation-notice" role="status">{target.notice}</p>}{!replacement && !following && <button type="button" className="scroll-bottom" aria-label="Scroll to latest message" onClick={latest}><FiArrowDown size={15} aria-hidden="true" /></button>}{footer}</div></>;
}
