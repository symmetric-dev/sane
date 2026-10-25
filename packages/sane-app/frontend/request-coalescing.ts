type Entry = {
  key: string;
  promise: Promise<Response>;
  controller: AbortController;
  consumers: number;
  handedOut: boolean;
  retired: boolean;
  deadline: ReturnType<typeof setTimeout>;
  expiry?: ReturnType<typeof setTimeout>;
  response?: Response;
  expiresAt?: number;
};

const entries = new Map<string, Entry>();

function requestDeadline(controller: AbortController) {
  // Separate scope so the timer cannot retain the response/cache entry.
  return setTimeout(() => controller.abort(new DOMException("The request timed out.", "TimeoutError")), 30000);
}

function discardSpareResponse(entry: Entry) {
  const response = entry.response;
  entry.response = undefined;
  // Cancel only our unused tee branch, never a clone handed to a caller. Do
  // not await: tee cancellation can wait for the other branches to finish.
  void response?.body?.cancel().catch(() => {});
}

function retireEntry(entry: Entry) {
  if (entries.get(entry.key) === entry) entries.delete(entry.key);
  entry.retired = true;
  clearTimeout(entry.expiry);
  entry.expiry = undefined;
  // Pending join callbacks must clone the response before we drop our branch.
  if (entry.consumers === 0) discardSpareResponse(entry);
}

/**
 * Retire cached AND in-flight entries from reuse, without aborting consumers.
 * Existing callers still need their own auth/epoch/publication fences. A retired
 * pending request is aborted only if its final waiting caller detaches.
 */
export function invalidateCoalescedRequests(matches: (url: string) => boolean = () => true) {
  for (const [key, entry] of entries) if (matches(key.slice(4))) retireEntry(entry);
}

function detachEntry(entry: Entry) {
  if (--entry.consumers !== 0) return;
  if (!entry.handedOut) {
    retireEntry(entry);
    clearTimeout(entry.deadline);
    entry.controller.abort();
  } else if (entry.retired) discardSpareResponse(entry);
}

function joinEntry(entry: Entry, callerSignal: AbortSignal | null): Promise<Response> {
  if (callerSignal?.aborted) return Promise.reject(callerSignal.reason);
  entry.consumers++;
  return new Promise<Response>((resolve, reject) => {
    let attached = true;
    const detach = () => {
      if (!attached) return false;
      attached = false;
      callerSignal?.removeEventListener("abort", onAbort);
      detachEntry(entry);
      return true;
    };
    const onAbort = () => {
      if (detach()) reject(callerSignal?.reason);
    };
    callerSignal?.addEventListener("abort", onAbort, { once: true });
    entry.promise.then(
      (response) => {
        if (!attached) return;
        if (callerSignal?.aborted) { onAbort(); return; }
        try {
          const clone = response.clone();
          // fetch settles at headers, not body completion. Ownership transfers
          // to the clone: releasing the last header waiter MUST NOT abort its
          // body (or any other clone). As before, caller signals stop governing
          // the response after handoff; the shared 30s deadline still bounds it.
          entry.handedOut = true;
          resolve(clone);
        } catch (error) {
          reject(error);
        } finally { detach(); }
      },
      (error) => {
        if (detach()) reject(error);
      },
    );
  });
}

export function coalescedFetch(url: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? "GET";
  if ((typeof method === "string" ? method.toUpperCase() : method) !== "GET" || init?.body !== undefined) {
    return fetch(url, init);
  }
  const callerSignal = init?.signal ?? null;
  if (callerSignal?.aborted) return Promise.reject(callerSignal.reason);
  const key = "GET " + url;
  const existing = entries.get(key);
  if (existing) {
    if (existing.response !== undefined && existing.expiresAt !== undefined) {
      if (Date.now() < existing.expiresAt) return joinEntry(existing, callerSignal);
      retireEntry(existing);
    } else if (existing.response === undefined) {
      return joinEntry(existing, callerSignal);
    }
  }
  const controller = new AbortController();
  // Keep this deadline beyond headers to bound slow/stalled response bodies.
  // It captures only the controller, not a cached Response/Entry. Early failure
  // or last-waiter cancellation clears it; successful bodies retain the same
  // maximum lifetime as the previous AbortSignal.timeout(30000) implementation.
  const deadline = requestDeadline(controller);
  const sharedInit = { ...(init ?? {}), signal: controller.signal };
  const sharedPromise = Promise.resolve().then(() => {
    controller.signal.throwIfAborted();
    return fetch(url, sharedInit);
  });
  const entry: Entry = { key, promise: sharedPromise, controller, consumers: 0, handedOut: false, retired: false, deadline };
  entries.set(key, entry);
  void sharedPromise.then(
    (response) => {
      entry.response = response;
      if (!entry.retired && entries.get(key) === entry) {
        entry.expiresAt = Date.now() + 1000;
        // Evict even if this URL is never requested again (e.g. advancing
        // event cursors); otherwise one map entry leaks per distinct URL.
        entry.expiry = setTimeout(() => retireEntry(entry), 1000);
      } else if (entry.consumers === 0) discardSpareResponse(entry);
    },
    () => {
      clearTimeout(deadline);
      retireEntry(entry);
    },
  );
  return joinEntry(entry, callerSignal);
}
