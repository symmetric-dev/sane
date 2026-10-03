import { timingSafeEqual } from "node:crypto";

export const loopback = (host: string) => ["127.0.0.1", "::1", "localhost", "[::1]", "::ffff:127.0.0.1"].includes(host);
export const equal = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(data, { status, headers: { "cache-control": "no-store", ...headers } });

/** Keep the bridge's advertised and streamed 1 MiB limits and parse errors. */
export async function body(req: Request): Promise<any> {
  if (Number(req.headers.get("content-length")) > 1024 * 1024) throw new Error("Body too large");
  const reader = req.body?.getReader(); if (!reader) throw new Error("Missing body");
  let size = 0; const parts: Uint8Array[] = [];
  while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 1024 * 1024) { await reader.cancel(); throw new Error("Body too large"); } parts.push(value); }
  return JSON.parse(Buffer.concat(parts).toString());
}
