export const MEDIA_IMAGE_CACHE_LIMITS = { items: 5, bytes: 50 * 1024 * 1024, requests: 2 } as const;

type Entry = {
  url: string;
  users: number;
  controller: AbortController;
  ready: Promise<string>;
  resolve: (src: string) => void;
  reject: (error: unknown) => void;
  src?: string;
  bytes: number;
};

/** Per-share cache of immutable compressed bytes, not decoded bitmaps. Visible
 * frames hold leases so prefetching can never evict the image still on screen. */
export class MediaImageCache {
  private entries = new Map<string, Entry>();
  private queue: Entry[] = [];
  private running = 0;
  private bytes = 0;

  acquire(url: string, prefetch = false) {
    let entry = this.entries.get(url);
    if (!entry) {
      let resolve!: Entry["resolve"], reject!: Entry["reject"];
      const ready = new Promise<string>((done, fail) => { resolve = done; reject = fail; });
      entry = { url, users: 0, controller: new AbortController(), ready, resolve, reject, bytes: 0 };
      this.entries.set(url, entry);
      this.queue.push(entry);
    }
    const owner = entry;
    owner.users++;
    this.entries.delete(url); this.entries.set(url, owner);
    if (!prefetch) {
      const queued = this.queue.indexOf(owner);
      if (queued >= 0) { this.queue.splice(queued, 1); this.queue.unshift(owner); }
    }
    this.trim(); this.drain();
    let released = false;
    return { ready: owner.ready, release: () => {
      if (released) return;
      released = true;
      owner.users--;
      this.trim();
    } };
  }

  prefetch(url: string) {
    const lease = this.acquire(url, true);
    void lease.ready.catch(() => {});
    lease.release();
  }

  invalidate(url: string) {
    const entry = this.entries.get(url);
    if (entry) this.remove(entry);
  }

  clear() { for (const entry of this.entries.values()) this.remove(entry); }

  private remove(entry: Entry) {
    if (this.entries.get(entry.url) !== entry) return;
    this.entries.delete(entry.url);
    this.queue = this.queue.filter(queued => queued !== entry);
    entry.controller.abort();
    entry.reject(new DOMException("Image preview released", "AbortError"));
    if (entry.src) URL.revokeObjectURL(entry.src);
    this.bytes -= entry.bytes;
  }

  private trim() {
    while (this.entries.size > MEDIA_IMAGE_CACHE_LIMITS.items || this.bytes > MEDIA_IMAGE_CACHE_LIMITS.bytes) {
      const oldest = [...this.entries.values()].find(entry => !entry.users);
      if (!oldest) break;
      this.remove(oldest);
    }
  }

  private drain() {
    while (this.running < MEDIA_IMAGE_CACHE_LIMITS.requests && this.queue.length) {
      const entry = this.queue.shift();
      if (!entry || this.entries.get(entry.url) !== entry) continue;
      this.running++;
      void this.read(entry).finally(() => { this.running--; this.drain(); });
    }
  }

  private async read(entry: Entry) {
    const signal = AbortSignal.any([entry.controller.signal, AbortSignal.timeout(30000)]);
    try {
      const response = await fetch(entry.url, { credentials: "same-origin", signal });
      if (!response.ok) throw new Error(`Could not load image (HTTP ${response.status}).`);
      const blob = await response.blob();
      signal.throwIfAborted();
      if (this.entries.get(entry.url) !== entry) return;
      if (blob.size > MEDIA_IMAGE_CACHE_LIMITS.bytes) throw new Error("Image exceeds the preview memory limit.");
      entry.src = URL.createObjectURL(blob);
      entry.bytes = blob.size;
      this.bytes += blob.size;
      entry.resolve(entry.src);
      this.trim();
    } catch (error) {
      entry.reject(error);
      this.remove(entry);
    }
  }
}
