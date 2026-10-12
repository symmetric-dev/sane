import { expect, test } from "bun:test";
import { OpenCodeAdapter } from "./opencode";
import { captureContextEvidence } from "../tests/canonical-fixture";

/** Native request boundary only; no socket, discovery, real harness or provider. */
function entryFixture(initial?: string) {
  const adapter = new OpenCodeAdapter("http://127.0.0.1:1");
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const state = { value: initial, mismatch: false, lostAck: false, duplicate: false };
  adapter.request = async <T>(path: string, method = "GET", body?: unknown, guard?: () => void): Promise<T> => {
    guard?.(); calls.push({ path, method, body });
    expect(path).toStartWith("/api/experimental/session/ses_fixture/instructions/entries");
    if (method === "PUT") {
      state.value = state.mismatch ? "foreign bytes" : (body as { value: string }).value;
      if (state.lostAck) throw new Error("lost native write acknowledgement");
      return {} as T;
    }
    const data = state.value === undefined ? [] : [{ key: "sane.context", value: state.value }];
    if (state.duplicate) data.push(...data);
    return { data } as T;
  };
  return { adapter, calls, state };
}

test("canonical native entry exact readback is idempotent, and queued work cannot edit differing bytes", async () => {
  const f = entryFixture();
  await f.adapter.deliverContextEntry("ses_fixture", "exact é bytes", true, () => {});
  expect(f.calls.map(c => c.method)).toEqual(["GET", "PUT", "GET"]);
  await f.adapter.deliverContextEntry("ses_fixture", "exact é bytes", false, () => {});
  expect(f.calls.map(c => c.method)).toEqual(["GET", "PUT", "GET", "GET"]);
  await expect(f.adapter.deliverContextEntry("ses_fixture", "changed", false, () => {})).rejects.toThrow("wait for native idle");
  expect(f.state.value).toBe("exact é bytes");
  captureContextEvidence("native-entry-idempotence", { calls: f.calls, storage: f.state.value });
});

for (const fault of ["mismatch", "lostAck", "duplicate"] as const) test(`native context ${fault} is not a verified receipt`, async () => {
  const f = entryFixture(fault === "duplicate" ? "old" : undefined); f.state[fault] = true;
  await expect(f.adapter.deliverContextEntry("ses_fixture", "pinned bytes", true, () => {})).rejects.toThrow();
  expect(f.calls.filter(c => c.method === "PUT")).toHaveLength(fault === "duplicate" ? 0 : 1);
  if (fault === "lostAck") {
    f.state.lostAck = false;
    await f.adapter.deliverContextEntry("ses_fixture", "pinned bytes", true, () => {});
    expect(f.calls.filter(c => c.method === "PUT")).toHaveLength(1); // read-only recovery, never replay
  }
});

test("native context cancellation after initial read prevents mutation", async () => {
  const f = entryFixture(); let guards = 0;
  await expect(f.adapter.deliverContextEntry("ses_fixture", "pinned", true, () => { if (++guards === 2) throw new Error("cancelled"); })).rejects.toThrow("cancelled");
  expect(f.calls.map(c => c.method)).toEqual(["GET"]);
});
