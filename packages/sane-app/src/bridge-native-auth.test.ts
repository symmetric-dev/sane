import { describe, expect, test } from "bun:test";
import { requireNativeBearer, requireStartupReady } from "./bridge-native-auth";

const token = "test-token-123";

function req(init?: { method?: string; origin?: string; auth?: string }): Request {
  const headers: Record<string, string> = {};
  if (init?.origin) headers["origin"] = init.origin;
  if (init?.auth) headers["authorization"] = init.auth;
  return new Request("http://127.0.0.1/native/handoffs", { method: init?.method ?? "POST", headers });
}

describe("requireNativeBearer", () => {
  test("allows valid POST with bearer and no origin", () => {
    expect(requireNativeBearer(req({ auth: `Bearer ${token}` }), token)).toBeUndefined();
  });
  test("rejects wrong method", async () => {
    const res = requireNativeBearer(req({ method: "GET", auth: `Bearer ${token}` }), token)!;
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "Native authorization required" });
  });
  test("rejects origin header", () => {
    expect(requireNativeBearer(req({ auth: `Bearer ${token}`, origin: "http://x" }), token)?.status).toBe(401);
  });
  test("rejects wrong token", () => {
    expect(requireNativeBearer(req({ auth: "Bearer wrong" }), token)?.status).toBe(401);
  });
  test("rejects missing auth", () => {
    expect(requireNativeBearer(req({}), token)?.status).toBe(401);
  });
});

describe("requireStartupReady", () => {
  test("passes when ready", () => {
    expect(requireStartupReady(true)).toBeUndefined();
  });
  test("503 with startup-classifying code when not ready", async () => {
    const res = requireStartupReady(false)!;
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "startup-classifying" });
  });
});
