import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, gzip } from "node:zlib";

const MIN_BYTES = 1024;
const BUFFER_BYTES = 64 * 1024;
const GZIP_LEVEL = 4;

function encodings(header: string | null): { gzip: number; identity: number } {
  const qualities = new Map<string, number>();
  for (const entry of (header ?? "").split(",")) {
    const [coding, ...parameters] = entry.toLowerCase().split(";");
    const name = coding?.trim();
    if (!name) continue;
    let quality = 1;
    for (const parameter of parameters) {
      const match = /^\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/.exec(parameter);
      if (!match) { quality = 0; break; }
      quality = Math.min(quality, Number(match[1]));
    }
    // Be conservative about contradictory duplicate declarations, especially q=0.
    qualities.set(name, Math.min(qualities.get(name) ?? 1, quality));
  }
  return {
    gzip: qualities.get("gzip") ?? qualities.get("*") ?? 0,
    identity: qualities.get("identity") ?? (qualities.get("*") === 0 ? 0 : 1),
  };
}

function noTransform(headers: Headers): boolean {
  return (headers.get("cache-control") ?? "").split(",").some(value => value.trim().toLowerCase() === "no-transform");
}

function vary(headers: Headers): void {
  const current = headers.get("vary");
  const names = (current ?? "").split(",").map(value => value.trim().toLowerCase());
  if (!names.includes("*") && !names.includes("accept-encoding")) {
    headers.set("vary", current ? `${current}, Accept-Encoding` : "Accept-Encoding");
  }
}

function encodedHeaders(headers: Headers, length?: number): Headers {
  const encoded = new Headers(headers);
  encoded.set("content-encoding", "gzip");
  encoded.delete("content-length");
  if (length !== undefined) encoded.set("content-length", String(length));
  // These describe the unencoded bytes. Do not publish stale integrity/range metadata.
  for (const name of ["content-md5", "digest", "content-digest", "repr-digest", "accept-ranges"]) encoded.delete(name);
  const etag = encoded.get("etag");
  if (etag && !etag.startsWith("W/")) encoded.set("etag", `W/${etag}`);
  return encoded;
}

function responseWith(response: Response, body: BodyInit | null, headers: Headers): Response {
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

/** Peek only a bounded prefix; a single oversized upstream chunk is retained, not copied. */
async function peek(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let done = false;
  let failed = false;
  let failure: unknown;
  const abort = () => {
    failed = true;
    failure = signal.reason;
    void reader.cancel(failure).catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    while (bytes <= BUFFER_BYTES) {
      const next = await reader.read();
      if (next.done) { done = true; reader.releaseLock(); break; }
      if (next.value.byteLength) { chunks.push(next.value); bytes += next.value.byteLength; }
    }
  } catch (error) {
    failed = true;
    failure = error;
    reader.releaseLock();
  } finally {
    signal.removeEventListener("abort", abort);
  }
  // No tee(): a slow client must not cause an unbounded identity backup queue.
  const replay = () => {
    let index = 0;
    let finished = done || failed;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (index < chunks.length) { controller.enqueue(chunks[index++]!); return; }
        if (finished) {
          if (failed) controller.error(failure);
          else controller.close();
          return;
        }
        try {
          const next = await reader.read();
          if (finished) return; // Cancellation may have resolved a pending read.
          if (next.done) { finished = true; reader.releaseLock(); controller.close(); }
          else controller.enqueue(next.value);
        } catch (error) {
          if (finished) return;
          finished = true;
          reader.releaseLock();
          controller.error(error);
        }
      },
      async cancel(reason) {
        if (finished) return;
        finished = true;
        try { await reader.cancel(reason); }
        finally { reader.releaseLock(); }
      },
    }, { highWaterMark: 0 });
  };
  return { bytes, chunks, done, failed, replay };
}

function gzipBuffer(bytes: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gzip(bytes, { level: GZIP_LEVEL }, (error, compressed) => error ? reject(error) : resolve(compressed));
  });
}

/**
 * Wrap ONLY the primary browser listener, not the native hook listener.
 * The handler executes exactly once; its auth, errors and mutations are authoritative.
 *
 * Negotiation boundary: this post-handler wrapper never emits 406. If both gzip and
 * identity are forbidden, or identity is forbidden but transformation is unsafe, it
 * preserves the original acknowledgement (identity) rather than hiding an executed
 * operation. Strict rejection must happen BEFORE dispatch, at an application-aware
 * boundary after auth/Host/Origin checks. That cannot be inferred safely here.
 *
 * Responses <=64 KiB use async gzip with identity fallback on compressor failure.
 * Larger reads stream with bounded queues; failures after streaming begins terminate
 * the body, never replay the request. The application can explicitly classify a
 * read-only POST; never derive that assertion from client-controlled parameters.
 * Larger mutation acknowledgements stay identity so a late compression error
 * cannot obscure a completed mutation.
 */
export async function withApiCompression(
  req: Request,
  handle: () => Response | undefined | Promise<Response | undefined>,
  options: { readOnly?: boolean } = {},
): Promise<Response | undefined> {
  const response = await handle();
  if (!response || !new URL(req.url).pathname.startsWith("/api/")
    || req.method === "HEAD" || req.headers.has("upgrade") || req.headers.has("range") || req.headers.has("if-range")
    || response.status < 200 || [204, 205, 206, 304].includes(response.status)
    || !response.body || response.bodyUsed || response.body.locked
    || response.headers.has("content-encoding") || response.headers.has("content-range")
    || noTransform(req.headers) || noTransform(response.headers)) return response;

  const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (type !== "application/json" && !/^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(type)) return response;

  const headers = new Headers(response.headers);
  vary(headers);
  const quality = encodings(req.headers.get("accept-encoding"));
  if (quality.gzip === 0 || quality.gzip < quality.identity) return responseWith(response, response.body, headers);

  const length = response.headers.get("content-length");
  const knownLength = length !== null && /^\d+$/.test(length) ? Number(length) : undefined;
  const mutation = req.method !== "GET" && !options.readOnly;
  if ((quality.identity > 0 && knownLength !== undefined && knownLength < MIN_BYTES)
    || (mutation && knownLength !== undefined && knownLength > BUFFER_BYTES)) {
    return responseWith(response, response.body, headers);
  }

  const prefix = await peek(response.body, req.signal);
  const identity = () => responseWith(response, prefix.replay(), headers);
  if (prefix.failed) return identity();
  if (quality.identity > 0 && prefix.bytes < MIN_BYTES) return identity();
  if (prefix.done) {
    // Both allocations are bounded, independently of the overall response size.
    try {
      const compressed = await gzipBuffer(Buffer.concat(prefix.chunks, prefix.bytes));
      if (quality.identity > 0 && compressed.byteLength >= prefix.bytes) return identity();
      // zlib owns an ordinary ArrayBuffer; use a view, not a second payload copy.
      const bytes = new Uint8Array(compressed.buffer as ArrayBuffer, compressed.byteOffset, compressed.byteLength);
      return responseWith(response, bytes, encodedHeaders(headers, compressed.byteLength));
    } catch {
      return identity();
    }
  }
  if (mutation) return identity();

  // Construct the compressor before handing it the original body, permitting a
  // setup-failure fallback without consuming or duplicating the underlying stream.
  let compressor: ReturnType<typeof createGzip>;
  try { compressor = createGzip({ level: GZIP_LEVEL, chunkSize: 16 * 1024 }); }
  catch { return identity(); }
  // Installed DOM and node:stream/web declarations differ in their extension
  // methods/reader overloads; both adapters operate on standard web streams.
  const source = Readable.fromWeb(prefix.replay() as unknown as Parameters<typeof Readable.fromWeb>[0], {
    highWaterMark: BUFFER_BYTES, signal: req.signal,
  });
  const body = Readable.toWeb(compressor, {
    strategy: { highWaterMark: BUFFER_BYTES, size: (chunk: Uint8Array) => chunk.byteLength },
  });
  // Pipeline forwards errors and cancellation to both streams. Always observe its
  // rejection: downstream cancellation is normal and must not be an unhandled promise.
  void pipeline(source, compressor).catch(() => {});
  return responseWith(response, body as unknown as ReadableStream<Uint8Array>, encodedHeaders(headers));
}
