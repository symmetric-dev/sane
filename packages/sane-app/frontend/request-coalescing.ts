type Entry = {
  promise: Promise<Response>;
  response?: Response;
  expiresAt?: number;
};

const entries = new Map<string, Entry>();

function joinEntry(entry: Entry, callerSignal: AbortSignal | null): Promise<Response> {
  if (!callerSignal) return entry.promise.then((response) => response.clone());
  if (callerSignal.aborted) return Promise.reject(callerSignal.reason);
  return new Promise<Response>((resolve, reject) => {
    const onAbort = () => {
      callerSignal.removeEventListener("abort", onAbort);
      reject(callerSignal.reason);
    };
    callerSignal.addEventListener("abort", onAbort, { once: true });
    entry.promise.then(
      (response) => {
        callerSignal.removeEventListener("abort", onAbort);
        if (callerSignal.aborted) {
          reject(callerSignal.reason);
          return;
        }
        try {
          resolve(response.clone());
        } catch (error) {
          reject(error);
        }
      },
      (error) => {
        callerSignal.removeEventListener("abort", onAbort);
        reject(error);
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
      entries.delete(key);
    } else if (existing.response === undefined) {
      return joinEntry(existing, callerSignal);
    }
  }
  const sharedPromise = fetch(url, { ...(init ?? {}), signal: AbortSignal.timeout(30000) });
  const entry: Entry = { promise: sharedPromise };
  entries.set(key, entry);
  void sharedPromise.then(
    (response) => {
      if (entries.get(key) === entry) {
        entry.response = response;
        entry.expiresAt = Date.now() + 1000;
        // Evict even if this URL is never requested again (e.g. advancing
        // event cursors); otherwise one map entry leaks per distinct URL.
        setTimeout(() => {
          if (entries.get(key) === entry) entries.delete(key);
        }, 1000);
      }
    },
    () => {
      if (entries.get(key) === entry) entries.delete(key);
    },
  );
  return joinEntry(entry, callerSignal);
}
