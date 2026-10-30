import type { MediaShareStore } from "./media-share-store";

const privateHeaders = () => new Headers({
  "cache-control": "private, no-store, no-transform",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
});
function json(value: unknown, status = 200, allow?: string) {
  const headers = privateHeaders(); headers.set("content-type", "application/json; charset=utf-8"); if (allow) headers.set("allow", allow);
  return new Response(JSON.stringify(value), { status, headers });
}
/** Strict single-range policy: malformed units/syntax, unsafe integers and
 * multiple ranges return 416, just like an unsatisfiable range. If-Range must
 * match our strong digest ETag exactly; dates/weak tags fall back to full 200. */
function range(value: string, size: number): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || !match[1] && !match[2]) return;
  const number = (value: string) => { const n = Number(value); return Number.isSafeInteger(n) && n >= 0 ? n : NaN; };
  if (!match[1]) {
    const suffix = number(match[2]!); if (!Number.isFinite(suffix) || suffix === 0 || !size) return;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = number(match[1]), end = match[2] ? number(match[2]) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || end < start) return;
  return { start, end: Math.min(end, size - 1) };
}
export async function mediaShareRoute(req: Request, store: MediaShareStore): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  const listing = /^\/api\/sessions\/([^/]+)\/media-shares$/.exec(path);
  const content = /^\/api\/sessions\/([^/]+)\/media-shares\/([a-f0-9]{64})\/items\/([a-f0-9]{64})\/content$/.exec(path);
  if (!listing && !content) return null;
  let sessionId: string;
  try { sessionId = decodeURIComponent((listing ?? content)![1]!); if (!sessionId || /[\x00-\x1f\x7f/\\]/.test(sessionId)) return json({ error: "Invalid conversation" }, 400); }
  catch { return json({ error: "Invalid conversation" }, 400); }
  if (listing) {
    if (req.method !== "GET") return json({ error: "Method not allowed" }, 405, "GET");
    return json({ shares: store.list(sessionId) });
  }
  if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "Method not allowed" }, 405, "GET, HEAD");
  const opened = await store.openContent(sessionId, content![2]!, content![3]!, req.signal);
  if (!opened) return json({ error: "Media not found" }, 404);
  const { handle, item, check } = opened, headers = privateHeaders(), etag = `"sha256-${item.sha256}"`;
  headers.set("content-type", item.mimeType);
  headers.set("etag", etag); headers.set("accept-ranges", "bytes");
  const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4" }[item.mimeType];
  // No source path, control character, quote or Unicode can enter disposition.
  headers.set("content-disposition", `inline; filename="media-${item.id.slice(0, 16)}.${extension}"`);
  let start = 0, end = item.bytes - 1, status = 200;
  // Range is defined for GET. HEAD describes the full representation and
  // closes its checked descriptor without creating a response stream.
  const requested = req.method === "GET" ? req.headers.get("range") : null, ifRange = req.headers.get("if-range");
  if (requested !== null && (ifRange === null || ifRange === etag)) {
    const selected = range(requested, item.bytes);
    if (!selected) {
      await handle.close(); headers.set("content-range", `bytes */${item.bytes}`); headers.set("content-length", "0");
      return new Response(null, { status: 416, headers });
    }
    ({ start, end } = selected); status = 206; headers.set("content-range", `bytes ${start}-${end}/${item.bytes}`);
  }
  headers.set("content-length", String(end - start + 1));
  if (req.method === "HEAD") { await handle.close(); return new Response(null, { status, headers }); }
  let offset = start, stopped = false, closing: Promise<void> | undefined;
  let streamController: ReadableStreamDefaultController<Uint8Array>;
  const close = () => { req.signal.removeEventListener("abort", abort); return closing ??= handle.close(); };
  const abort = () => {
    if (stopped) return; stopped = true;
    streamController.error(new DOMException("Media read cancelled", "AbortError"));
    void close().catch(() => {});
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller; req.signal.addEventListener("abort", abort, { once: true }); if (req.signal.aborted) abort();
    },
    async pull(controller) {
      if (stopped) return;
      try {
        await check(); if (stopped) return;
        const chunk = Buffer.alloc(Math.min(64 * 1024, end - offset + 1));
        const read = await handle.read(chunk, 0, chunk.length, offset);
        if (stopped) return;
        if (!read.bytesRead) throw new Error("Truncated immutable media snapshot");
        await check(); if (stopped) return;
        offset += read.bytesRead; controller.enqueue(chunk.subarray(0, read.bytesRead));
        if (offset > end) { stopped = true; await close(); controller.close(); }
      } catch (error) {
        if (!stopped) { stopped = true; controller.error(error); }
        await close();
      }
    },
    async cancel() { stopped = true; await close(); },
  }, { highWaterMark: 1 });
  return new Response(stream, { status, headers });
}
