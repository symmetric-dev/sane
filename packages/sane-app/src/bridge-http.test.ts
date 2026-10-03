import { expect, test } from "bun:test";
import { body, equal, json, loopback } from "./bridge-http";

test("loopback helper retains its exact finite allowlist", () => {
  for (const host of ["127.0.0.1", "::1", "localhost", "[::1]", "::ffff:127.0.0.1"]) expect(loopback(host)).toBe(true);
  for (const host of ["", "LOCALHOST", "localhost.", "127.0.0.2", "127.1", "0.0.0.0", "[::ffff:127.0.0.1]", "::ffff:7f00:1", "192.0.2.1"]) expect(loopback(host)).toBe(false);
});

test("equal compares UTF-8 bytes and handles unequal byte lengths", () => {
  for (const [a, b, expected] of [["", "", true], ["secret", "secret", true], ["secret", "Secret", false], ["a", "long", false], ["é", "é", true], ["é", "é", false], ["é", "ab", false]] as const) expect(equal(a, b)).toBe(expected);
});

test("json keeps status and no-store default with explicit header overrides", async () => {
  const result = json({ error: "fixture" }, 403, { "set-cookie": "sane_app=fixture" });
  expect(result.status).toBe(403); expect(await result.json()).toEqual({ error: "fixture" });
  expect(result.headers.get("cache-control")).toBe("no-store"); expect(result.headers.get("set-cookie")).toBe("sane_app=fixture");
  expect(json(null).status).toBe(200); expect(json(null, 200, { "cache-control": "private" }).headers.get("cache-control")).toBe("private");
});

test("body retains missing, malformed and advertised limit rejection order", async () => {
  await expect(body(new Request("http://fixture", { method: "POST", headers: { "content-length": "1048577" } }))).rejects.toThrow("Body too large");
  await expect(body(new Request("http://fixture", { method: "POST" }))).rejects.toThrow("Missing body");
  await expect(body(new Request("http://fixture", { method: "POST", body: "not JSON" }))).rejects.toBeInstanceOf(SyntaxError);
  await expect(body(new Request("http://fixture", { method: "POST", body: "" }))).rejects.toBeInstanceOf(SyntaxError);
  expect(await body(new Request("http://fixture", { method: "POST", headers: { "content-length": "invalid" }, body: "null" }))).toBeNull();
});

test("body parses split UTF-8 and accepts exactly 1 MiB", async () => {
  const bytes = Buffer.from('{"text":"é"}');
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  expect(await body(new Request("http://fixture", { method: "POST", body: stream }))).toEqual({ text: "é" });
  const data = '"' + "a".repeat(1024 * 1024 - 2) + '"';
  expect((await body(new Request("http://fixture", { method: "POST", headers: { "content-length": String(data.length) }, body: data }))).length).toBe(1024 * 1024 - 2);
});

test("streamed size limit overrides a small advertised length and cancels", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); controller.enqueue(Uint8Array.of(1)); }, cancel() { cancelled = true; } });
  await expect(body(new Request("http://fixture", { method: "POST", headers: { "content-length": "1" }, body: stream }))).rejects.toThrow("Body too large");
  expect(cancelled).toBe(true);
});
