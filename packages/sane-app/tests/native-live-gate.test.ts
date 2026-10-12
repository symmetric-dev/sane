import { expect, test } from "bun:test";
import { nativeLiveGate } from "./native-live-gate";

test("live suites are inert by default and require deliberate arming, evidence and cleanup", () => {
  expect(nativeLiveGate({})).toBe(false);
  expect(nativeLiveGate({ SANE_RUN_LIVE_NATIVE_TESTS: "1" })).toBe(false);
  const armed = { SANE_RUN_LIVE_NATIVE_TESTS: "I_ACCEPT_REAL_MODEL_CALLS" };
  expect(() => nativeLiveGate(armed)).toThrow("NATIVE_EVIDENCE_DIR");
  expect(() => nativeLiveGate({ ...armed, NATIVE_EVIDENCE_DIR: "relative" })).toThrow("absolute");
  expect(() => nativeLiveGate({ ...armed, NATIVE_EVIDENCE_DIR: "/fixture/evidence" })).toThrow("NATIVE_CLEANUP");
  const bounded = { ...armed, NATIVE_EVIDENCE_DIR: "/fixture/evidence", NATIVE_CLEANUP: "close-and-remove" };
  expect(nativeLiveGate(bounded)).toBe(true);
  expect(() => nativeLiveGate({ ...bounded, NATIVE_KEEP_FIXTURES: "1" })).toThrow("cleanup");
});
