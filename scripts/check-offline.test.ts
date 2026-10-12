import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { childEnvironment, discoverTests, parseSummary, selectTests } from "./check-offline";

test("parses normal, bailout, skipped, and singular Bun stderr footers", () => {
  expect(parseSummary(" 3 pass\n 0 fail\nRan 3 tests across 1 file. [2ms]")).toEqual({ passed: 3, failed: 0, skipped: 0, todo: 0, ran: 3, valid: true });
  expect(parseSummary("(pass) ok\n(fail) bad\nRan 2 tests across 1 file.\nBailed out after 1 failure").passed).toBe(1);
  expect(parseSummary("(fail) bad\nRan 8 tests across 1 file.\nBailed out after 1 failure").passed).toBeNull();
  expect(parseSummary(" 1 pass\n 1 skip\n 1 todo\n 0 fail\nRan 3 tests across 1 file.").valid).toBe(true);
  expect(parseSummary("\u001b[32m 1 pass\u001b[0m\n 0 fail\nRan 1 test across 1 file.").valid).toBe(true);
});

test("does not certify empty, missing, inconsistent, or multi-file summaries", () => {
  for (const text of ["", "0 pass\n0 fail\nRan 0 tests across 1 file.", "1 pass\n0 fail", "1 pass\n0 fail\nRan 2 tests across 1 file.", "2 pass\n0 fail\nRan 2 tests across 2 files."]) expect(parseSummary(text).valid).toBe(false);
});

test("parses real Bun pass and bail output including skipped tests", () => {
  const cwd = mkdtempSync(join(tmpdir(), "offline-parser-"));
  try {
    const path = join(cwd, "fixture.test.ts");
    for (const fail of [false, true]) {
      writeFileSync(path, `import {test,expect} from "bun:test";
test("ok",()=>expect(1).toBe(1));
test.skip("skip",()=>{});
test.todo("todo");
${fail ? 'test("failure",()=>expect(1).toBe(2));' : ''}`);
      const junit = join(cwd, "results.xml");
      const result = spawnSync(process.execPath, ["test", path, "--no-orphans", "--bail=1", "--timeout", "20000", "--reporter=junit", "--reporter-outfile", junit], { env: childEnvironment(process.env) });
      expect(result.status).toBe(fail ? 1 : 0);
      expect(parseSummary(result.stderr.toString(), readFileSync(junit, "utf8"))).toEqual({ passed: 1, failed: fail ? 1 : 0, skipped: 1, todo: 1, ran: fail ? 4 : 3, valid: true });
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("selection deduplicates NUL filenames, excludes live suites before filtering", () => {
  const result = selectTests("a.test.ts\0a.test.ts\0space name.spec.tsx\0z.spec.js\0x.integration.test.ts\0native-handoff.test.ts\0native-recovery.test.js\0agent-session-smoke.test.ts\0helper.ts\0", "test");
  expect(result.selected).toEqual(["a.test.ts"]);
  expect(result.excluded.length).toBe(4);
  expect(result.filtered).toEqual(["space name.spec.tsx", "z.spec.js"]);
});

test("git discovery includes tracked and untracked tests, excludes ignored artifacts", () => {
  const cwd = mkdtempSync(join(tmpdir(), "offline-discovery-"));
  try {
    expect(spawnSync("git", ["init", "-q", cwd]).status).toBe(0);
    writeFileSync(join(cwd, ".gitignore"), "node_modules/\n");
    writeFileSync(join(cwd, "tracked.test.ts"), "");
    expect(spawnSync("git", ["-C", cwd, "add", "."]).status).toBe(0);
    writeFileSync(join(cwd, "new.spec.js"), "");
    mkdirSync(join(cwd, "node_modules"));
    writeFileSync(join(cwd, "node_modules", "hidden.test.ts"), "");
    expect(discoverTests(cwd).selected).toEqual(["new.spec.js", "tracked.test.ts"]);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("clears caller, bootstrap, live arming, and ambient capture settings", () => {
  const source = { PATH: "/bin", HOME: "/home", SANE_CALLER_CONTEXT: "caller", SANE_SESSION_ID: "session", OPENCODE_SESSION_ID: "oc", CC_WEB_BOOTSTRAP: "yes", AGENT_LIVE: "1", SANE_RUN_LIVE_NATIVE_TESTS: "1", SANE_ARM_CLAUDE_CAPTURE: "ZERO_PAID_MODEL", SANE_NATIVE_CAPTURE: "1", SANE_MOCK_CONTEXT_EVIDENCE_DIR: "/ambient", NATIVE_EVIDENCE_DIR: "/ambient" };
  expect(childEnvironment(source)).toEqual({ PATH: "/bin", HOME: "/home", NO_COLOR: "1", FORCE_COLOR: "0" });
  expect(source.AGENT_LIVE).toBe("1");
  expect(childEnvironment(source, { directory: "/explicit", runId: "run" }).SANE_MOCK_CONTEXT_EVIDENCE_DIR).toBe("/explicit");
});
