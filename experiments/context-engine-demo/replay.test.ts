import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DemoRunResult } from "./contract";
import { readDemoRun, replayDemoRun } from "./replay";

const temporary = "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): DemoRunResult {
  const root = mkdtempSync(join(temporary, "demo-replay-unit-")); roots.push(root);
  const checkout = join(root, "checkout"); mkdirSync(checkout);
  return { schema: 1, type: "mock-context-demo-run", simulation: true, root, checkout, scenarios: [{
    id: "activation", title: "Activation", journalDirectory: join(root, "journal-activation"),
    identity: { source: { harnessId: "mock-context-demo", sessionId: "fixture-session", authorityId: "fixture-authority", nativeSessionId: "fixture-native", cwd: checkout }, runId: "fixture-run", nativeCommandId: "fixture-message" },
    messageId: "fixture-message", expectedFact: "accepted", expectedMockSends: 1, mockSends: 1, contextLoads: 1, executionLoads: 1, pairingChecks: 1,
    trace: ["mock only"], checks: [{ name: "recorded mock assertion", passed: true, detail: "Not independent native evidence" }],
  }] };
}
function save(value: DemoRunResult | Record<string, unknown>, root: string): string {
  const path = join(root, "run.json"); writeFileSync(path, JSON.stringify(value)); return path;
}
describe("bounded read-only demo replay manifest", () => {
  test("round trips the exact original query", () => {
    const run = fixture(); expect(readDemoRun(save(run, run.root))).toEqual(run);
  });
  test("rejects schema, type, simulation and extra fields", () => {
    const run = fixture();
    for (const change of [{ schema: 2 }, { type: "native-run" }, { simulation: false }, { extra: true }]) {
      expect(() => readDemoRun(save({ ...run, ...change }, run.root))).toThrow();
    }
  });
  test("rejects unknown and duplicate scenario IDs", () => {
    const run = fixture();
    expect(() => readDemoRun(save({ ...run, scenarios: [run.scenarios[0], run.scenarios[0]] }, run.root))).toThrow("duplicate scenario");
    expect(() => readDemoRun(save({ ...run, scenarios: [{ ...run.scenarios[0], id: "native-proof" }] }, run.root))).toThrow("unknown or duplicate");
  });
  test("rejects arbitrary root redirect before checking redirected paths", () => {
    const run = fixture();
    expect(() => readDemoRun(save({ ...run, root: "/does-not-exist-outside-fixture" }, run.root))).toThrow("manifest root differs");
  });
  test("rejects path traversal, outside journals and checkout journals", () => {
    const run = fixture();
    for (const journalDirectory of [join(run.root, "..").concat("/outside"), `${run.root}/nested/../journal`, "/etc", run.checkout, join(run.checkout, "journal")]) {
      expect(() => readDemoRun(save({ ...run, scenarios: [{ ...run.scenarios[0], journalDirectory }] }, run.root))).toThrow();
    }
  });
  test("rejects journal symlink escapes", () => {
    const run = fixture(); symlinkSync(temporary, run.scenarios[0]!.journalDirectory);
    expect(() => readDemoRun(save(run, run.root))).toThrow("symbolic link");
  });
  test("rejects nonmock bindings, unbounded arrays and invalid counters", () => {
    const run = fixture(), s = run.scenarios[0]!;
    for (const change of [{ mockSends: -1 }, { executionLoads: 1.5 }, { checks: [{ name: "x", passed: "yes", detail: "x" }] }, { trace: Array(257).fill("x") },
      { identity: { ...s.identity, source: { ...s.identity.source, harnessId: "opencode" } } }]) {
      expect(() => readDemoRun(save({ ...run, scenarios: [{ ...s, ...change }] }, run.root))).toThrow();
    }
  });
  test("rejects a variant that substitutes its own query", () => {
    const run = fixture(), s = run.scenarios[0]!;
    expect(() => readDemoRun(save({ ...run, replayVariants: [{ id: "missing", directory: join(run.root, "missing"), identity: s.identity, messageId: "different", expectedFact: "unknown" }] }, run.root))).toThrow("original activation");
  });
  test("rejects overlarge manifests before JSON decoding", () => {
    const run = fixture(), path = join(run.root, "run.json"); writeFileSync(path, " ".repeat(512 * 1024 + 1));
    expect(() => readDemoRun(path)).toThrow("bounded regular file");
  });
  test("a missing protected owner never borrows the manifest's claimed acceptance", () => {
    const run = fixture(), result = replayDemoRun(run), s = result.scenarios[0]!;
    expect(result.passed).toBe(false);
    expect(s.projection.identity).toEqual(run.scenarios[0]!.identity);
    expect(s.projection.messageId).toBe(run.scenarios[0]!.messageId);
    expect(s.projection.fact).toBe("unknown");
    expect(s.message).toBeNull();
    expect(s.checks.find(c => c.name === "protected owner association")?.passed).toBe(false);
  });
  test("missing variant retains original activation query and stays unknown", () => {
    const run = fixture(), s = run.scenarios[0]!;
    const result = replayDemoRun({ ...run, replayVariants: [{ id: "missing", directory: join(run.root, "missing"), identity: s.identity, messageId: s.messageId, expectedFact: "unknown" }] });
    expect(result.variants[0]?.projection.fact).toBe("unknown");
    expect(result.variants[0]?.projection.coverage.state).not.toBe("complete");
    expect(result.variants[0]?.checks.every(c => c.passed)).toBe(true);
  });
});
