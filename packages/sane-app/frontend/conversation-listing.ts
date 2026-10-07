import type { ConversationClient } from "./types";

type Listing = Awaited<ReturnType<ConversationClient["conversations"]>>;
type Request = { controller: AbortController; promise: Promise<Listing>; consumers: number };

/** Acquisition only: callers retain their own publication and lifecycle fences. */
export class ConversationListing {
  revision = 0;
  private cached?: { value: Listing; at: number };
  private pending?: Request;
  constructor(private load: ConversationClient["conversations"], private freshnessMs = 1000, private now = () => performance.now()) {}

  invalidate() {
    this.revision++;
    this.cached = undefined;
    const pending = this.pending;
    this.pending = undefined;
    pending?.controller.abort();
  }

  async read(signal: AbortSignal): Promise<{ value: Listing; revision: number }> {
    for (;;) {
      signal.throwIfAborted();
      const revision = this.revision;
      if (this.cached && this.now() - this.cached.at < this.freshnessMs) return { value: this.cached.value, revision };
      const request = this.pending ?? this.start();
      try {
        const value = await this.join(request, signal);
        signal.throwIfAborted();
        if (revision === this.revision) return { value, revision };
      } catch (error) {
        signal.throwIfAborted();
        // A mutation invalidates all old reads. Live consumers join its successor;
        // auth teardown aborts consumers first, so they cannot cross that boundary.
        if (revision === this.revision) throw error;
      }
    }
  }

  private start(): Request {
    const controller = new AbortController();
    const request: Request = { controller, consumers: 0, promise: Promise.resolve().then(() => { controller.signal.throwIfAborted(); return this.load(controller.signal); }) };
    this.pending = request;
    request.promise = request.promise.then(value => {
      if (!Array.isArray(value.conversations) || value.conversations.some(conversation => !conversation || typeof conversation.id !== "string" || !conversation.id)) throw new Error("Invalid conversation listing.");
      if (this.pending === request && !controller.signal.aborted) this.cached = { value, at: this.now() };
      return value;
    }).finally(() => { if (this.pending === request) this.pending = undefined; });
    return request;
  }

  private join(request: Request, signal: AbortSignal): Promise<Listing> {
    request.consumers++;
    let abort: () => void;
    return new Promise<Listing>((resolve, reject) => {
      abort = () => reject(signal.aborted ? signal.reason : request.controller.signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      request.controller.signal.addEventListener("abort", abort, { once: true });
      request.promise.then(resolve, reject);
      if (signal.aborted || request.controller.signal.aborted) abort();
    }).finally(() => {
      signal.removeEventListener("abort", abort);
      request.controller.signal.removeEventListener("abort", abort);
      if (--request.consumers === 0 && this.pending === request) {
        this.pending = undefined;
        request.controller.abort();
      }
    });
  }
}
