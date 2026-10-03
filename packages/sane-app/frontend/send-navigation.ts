import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { catalog } from "./catalog";
import { store } from "./store";

export type SendTarget = { kind: "worker" | "handoff"; id: string; sessionId: string };
type Jump = SendTarget & { serial: number };
export type SendNavigationState = {
  sessionId: string; active: boolean; loading: boolean; connected: boolean; connectionError: string;
  workerError?: string; workerLoading?: boolean; handoffLoading: boolean; handoffError?: string;
};

// Only the mounted chat viewport owns navigation. Panels/history never become
// anchor-search roots, even when they render another copy of the same card.
let navigator: ((target: SendTarget) => boolean) | undefined;
export const goToSend = (target: SendTarget) => navigator?.(target) ?? false;

export function useSendNavigation(viewport: RefObject<HTMLDivElement | null>, state: SendNavigationState, pause: () => void) {
  const [jump, setJump] = useState<Jump | null>(null);
  const [notice, setNotice] = useState<{ sessionId: string; text: string } | null>(null);
  const [loaded, setLoaded] = useState<{ serial: number; outcome: "loaded" | "missing" | "legacy" | "error" } | null>(null);
  const current = useRef({ state, pause }); current.current = { state, pause };
  const pending = useRef<Jump | null>(null), serial = useRef(0);
  const cleanup = useRef<() => void>(() => {});
  const highlightCleanup = useRef<() => void>(() => {});
  const cancel = () => { pending.current = null; cleanup.current(); cleanup.current = () => {}; setJump(null); };
  const finish = (request: Jump, text?: string) => {
    if (pending.current !== request) return;
    cancel();
    setNotice(text ? { sessionId: request.sessionId, text } : null);
  };

  useLayoutEffect(() => {
    const navigate = (target: SendTarget) => {
      const live = store.snapshot();
      if (!target.sessionId || !current.current.state.active || live.sending || live.phase !== "ready") return false;
      cancel(); highlightCleanup.current(); setNotice(null);
      const request = { ...target, serial: ++serial.current };
      // Pause synchronously, before choose/resetKey or any content resize.
      current.current.pause(); pending.current = request; setJump(request);
      if (live.selected !== target.sessionId) store.openConversation(target.sessionId);
      if (store.snapshot().selected !== target.sessionId || catalog.snapshot().navigation.view !== "chat") { cancel(); return false; }
      const navigation = catalog.snapshot().navigation;
      const fence = () => {
        const next = catalog.snapshot().navigation, chat = store.snapshot();
        if (chat.selected !== target.sessionId || chat.sending || chat.phase !== "ready" || next.view !== "chat" || next.conversationId !== navigation.conversationId || next.workspaceId !== navigation.workspaceId || next.worktreeId !== navigation.worktreeId) { cancel(); setNotice(null); }
      };
      const unstore = store.subscribe(fence), uncatalog = catalog.subscribe(fence);
      const controller = new AbortController();
      let removeGestures = () => {};
      cleanup.current = () => { controller.abort(); unstore(); uncatalog(); removeGestures(); };
      void store.loadSendTarget(target, controller.signal).then(outcome => {
        if (pending.current === request && !controller.signal.aborted) setLoaded({ serial: request.serial, outcome });
      }, () => { if (pending.current === request && !controller.signal.aborted) setLoaded({ serial: request.serial, outcome: "error" }); });
      // Defer past the initiating Go to send event. Capture subsequent input
      // throughout the app, including the composer/header outside our viewport.
      // Focus itself is not a gesture: navigation/remounts may focus controls.
      queueMicrotask(() => {
        if (pending.current !== request) return;
        const document = viewport.current?.ownerDocument;
        if (!document) return;
        const interrupt = () => { if (pending.current === request) { cancel(); setNotice(null); } };
        const keydown = (event: KeyboardEvent) => { if (!["Shift", "Control", "Alt", "Meta", "AltGraph"].includes(event.key)) interrupt(); };
        document.addEventListener("keydown", keydown, true);
        document.addEventListener("pointerdown", interrupt, true);
        document.addEventListener("wheel", interrupt, { capture: true, passive: true });
        document.addEventListener("touchstart", interrupt, { capture: true, passive: true });
        removeGestures = () => {
          document.removeEventListener("keydown", keydown, true);
          document.removeEventListener("pointerdown", interrupt, true);
          document.removeEventListener("wheel", interrupt, true);
          document.removeEventListener("touchstart", interrupt, true);
        };
      });
      return true;
    };
    navigator = navigate;
    return () => { if (navigator === navigate) navigator = undefined; pending.current = null; cleanup.current(); highlightCleanup.current(); };
  }, []);

  useLayoutEffect(() => {
    if (!state.active) { cancel(); highlightCleanup.current(); setNotice(null); }
    else if (notice && notice.sessionId !== state.sessionId) setNotice(null);
  }, [state.active, state.sessionId]);

  useLayoutEffect(() => {
    if (!jump || pending.current !== jump || !state.active || state.sessionId !== jump.sessionId) return;
    if (loaded?.serial !== jump.serial) return;
    if (loaded.outcome === "missing") { finish(jump, "Original send unavailable"); return; }
    if (loaded.outcome === "error") { finish(jump, "Could not load original send. Try again."); return; }
    if (state.connectionError) { finish(jump, "Could not load original send. Try again."); return; }
    if (state.loading || !state.connected || jump.kind === "handoff" && state.handoffLoading || jump.kind === "worker" && state.workerLoading) return;
    const root = viewport.current;
    if (!root) return;
    let frame = 0;
    const scan = () => {
      const live = store.snapshot();
      if (pending.current !== jump || live.selected !== jump.sessionId || live.loading || !live.connected || jump.kind === "worker" && live.workerLoading) return;
      // assistant-ui publishes its external transcript separately from the
      // projection. Do not declare a miss against an earlier runtime render.
      const ready = root.querySelector<HTMLElement>("[data-send-transcript-ready]");
      if (ready?.dataset.sendTranscriptReady !== jump.sessionId) return;
      let card = [...root.querySelectorAll<HTMLElement>("[data-send-kind][data-send-id]")].find(element => element.dataset.sendKind === jump.kind && element.dataset.sendId === jump.id);
      let statusError: string | undefined;
      if (!card) {
        const error = jump.kind === "handoff" ? state.handoffError : state.workerError;
        if (loaded.outcome === "loaded") {
          const messageId = store.snapshot().transcript?.target?.messageId;
          card = [...root.querySelectorAll<HTMLElement>("[data-transcript-message]")].find(element => element.dataset.transcriptMessage === messageId);
          if (error) statusError = "Original send status unavailable. Try again.";
        }
        if (!card) { finish(jump, error || loaded.outcome === "loaded" ? "Could not show original send. Try again." : "Original send unavailable"); return; }
      }
      current.current.pause();
      highlightCleanup.current();
      card.focus({ preventScroll: true });
      // Scroll only this viewport, never the page or a surrounding panel.
      root.scrollTop += card.getBoundingClientRect().top - root.getBoundingClientRect().top - 16;
      card.classList.add("send-target-highlight");
      const timer = setTimeout(() => card.classList.remove("send-target-highlight"), 1800);
      highlightCleanup.current = () => { clearTimeout(timer); card.classList.remove("send-target-highlight"); };
      finish(jump, statusError);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(scan); };
    const observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-send-transcript-ready", "data-send-id"] });
    schedule();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [jump, loaded, state.sessionId, state.active, state.loading, state.connected, state.connectionError, state.workerError, state.workerLoading, state.handoffLoading, state.handoffError]);

  return { targeting: pending.current?.sessionId === state.sessionId, notice: notice?.sessionId === state.sessionId ? notice.text : "", cancel };
}
