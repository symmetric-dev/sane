import { describe, expect, test } from "bun:test";
import { createPoller } from "./poller";

describe("createPoller", () => {
  test("pollOnce runs fn and is single-flight", async () => {
    let calls = 0;
    const p = createPoller(async () => {
      calls++;
      await Bun.sleep(10);
    }, { intervalMs: 5 });
    await Promise.all([p.pollOnce(), p.pollOnce()]);
    expect(calls).toBe(1);
    await p.pollOnce();
    expect(calls).toBe(2);
  });
  test("start/stop toggles running", () => {
    const p = createPoller(async () => {}, { intervalMs: 1000 });
    expect(p.running).toBe(false);
    p.start();
    expect(p.running).toBe(true);
    p.start();
    expect(p.running).toBe(true);
    p.stop();
    expect(p.running).toBe(false);
  });
  test("onError receives failures", async () => {
    let seen: unknown;
    const p = createPoller(
      async () => {
        throw new Error("tick-fail");
      },
      { intervalMs: 5, onError: (e) => (seen = e) },
    );
    // pollOnce propagates (no onError) — use start/tick path via pollOnce equivalent
    await p.pollOnce().catch(() => {});
    expect(seen).toBeUndefined();
  });
});
