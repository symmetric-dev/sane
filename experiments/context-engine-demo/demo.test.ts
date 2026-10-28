import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { childEnvironment } from "../../scripts/check-offline";
import type { DemoReplayResult } from "./contract";

test("isolated real engine/store/dispatch/journal path replays in a fresh read-only process", () => {
  const temporary = mkdtempSync("/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-demo-e2e-test-");
  const root = join(temporary, "run");
  try {
    const child = spawnSync(process.execPath, ["--tsconfig-override", join(import.meta.dir, "tsconfig.json"), join(import.meta.dir, "cli.ts"), "run", "--output", root], {
      env: childEnvironment(process.env), encoding: "utf8", timeout: 20000, maxBuffer: 32 * 1024 * 1024,
    });
    expect({ exitCode: child.status, error: child.error?.message, stderr: child.stderr, stdout: child.status === 0 ? "completed" : child.stdout })
      .toEqual({ exitCode: 0, error: undefined, stderr: "", stdout: "completed" });
    const replay: DemoReplayResult = JSON.parse(readFileSync(join(root, "replay.json"), "utf8"));
    const verification = JSON.parse(readFileSync(join(root, "verification.json"), "utf8"));
    expect(replay.passed).toBe(true);
    expect(replay.scenarios.map(item => item.scenario.id)).toEqual(["activation", "ordinary", "update", "stale-source", "owner-refusal", "persistence-failure", "attempt-unresolved"]);
    expect(replay.scenarios.every(item => item.checks.every(check => check.passed))).toBe(true);
    const ordinary = replay.scenarios.find(item => item.scenario.id === "ordinary")!;
    expect(ordinary.scenario.contextLoads).toBe(0);
    expect(ordinary.scenario.executionLoads).toBeGreaterThan(0);
    expect(ordinary.scenario.pairingChecks).toBe(0);
    const trace = ordinary.scenario.trace;
    expect(trace.slice(trace.indexOf("prepare:start"), trace.indexOf("prepare:complete"))).not.toContain("load:execution");
    expect(trace.slice(trace.indexOf("setup:simulated-native-execution:start"), trace.indexOf("setup:simulated-native-execution:complete"))).toContain("load:execution");
    expect(ordinary.message!.transport.text).toBe(ordinary.message!.body.text);
    expect(ordinary.message!.segments).toEqual([]);
    expect(replay.scenarios.find(item => item.scenario.id === "activation")!.scenario.pairingChecks).toBe(1);
    const update = replay.scenarios.find(item => item.scenario.id === "update")!;
    expect(update.scenario.contextLoads).toBe(0);
    expect(update.scenario.pairingChecks).toBe(0);
    const unresolved = replay.scenarios.find(item => item.scenario.id === "attempt-unresolved")!;
    expect(unresolved.projection.fact).toBe("attempt-unresolved");
    expect(unresolved.scenario.mockSends).toBe(1);
    for (const id of ["stale-source", "owner-refusal", "persistence-failure"]) expect(replay.scenarios.find(item => item.scenario.id === id)!.scenario.mockSends).toBe(0);
    expect(replay.variants.map(item => [item.id, item.projection.fact, item.projection.coverage.state])).toEqual([["torn", "unknown", "partial"], ["missing", "unknown", "partial"]]);
    expect(verification.readOnlyReplay).toBe(true);
    expect(verification.fixtureBeforeReplay).toEqual(verification.fixtureAfterReplay);
    expect(verification.passed).toBe(true);
  } finally { rmSync(temporary, { recursive: true }); }
}, 30000);
