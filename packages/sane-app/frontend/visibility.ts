import { subscribeWake } from "./poll-wake";

export const documentHidden = () => typeof document !== "undefined" && document.hidden;
export const jitteredDelay = (delay: number) => delay * (0.85 + Math.random() * 0.3);

export function subscribeVisibility(listener: () => void) {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

export function pollWhileVisible(read: (signal: AbortSignal) => Promise<number>, wake?: { sessionIds: readonly string[]; onWake: () => void }) {
  let disposed = false;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let confirmWake = false;
  const poll = async () => {
    clearTimeout(timer); timer = undefined;
    if (disposed || documentHidden() || controller) return;
    const request = controller = new AbortController();
    let delay = 60_000;
    try { delay = await read(request.signal); }
    catch {}
    finally {
      if (controller === request) {
        controller = undefined;
        if (confirmWake && !disposed && !documentHidden()) {
          // The immediate read may join a pre-wake shared GET (cached for 1s).
          // Confirm after that cache expires before accepting an idle cadence.
          confirmWake = false; wake?.onWake(); delay = 1500;
        }
        if (!disposed && !documentHidden()) timer = setTimeout(() => void poll(), jitteredDelay(delay));
      }
    }
  };
  const update = () => {
    clearTimeout(timer); timer = undefined;
    if (documentHidden()) {
      controller?.abort(); controller = undefined;
    } else void poll();
  };
  const unsubscribe = subscribeVisibility(update);
  const unsubscribeWake = wake ? subscribeWake(sessionId => {
    if (disposed || sessionId !== undefined && !wake.sessionIds.includes(sessionId)) return;
    confirmWake = true;
    wake.onWake();
    // Replace any pre-mutation read; its aborted signal fences late publication.
    controller?.abort(); controller = undefined;
    update();
  }) : () => {};
  update();
  return () => {
    disposed = true; unsubscribe(); unsubscribeWake(); clearTimeout(timer);
    controller?.abort(); controller = undefined;
  };
}
