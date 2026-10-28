import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { classifyCaller, parseCliCommand, type CallerSignals } from "./cli-arguments";
import { callerSignals, executeCliCommand } from "./cli-command";

const source = { version: 1, harness: "cc", kind: "local-profile", profileRoot: "/explicit/profile" };
const envelope = { version: 1, repository: "/explicit/repo", source, authorityId: "test-authority", nativeId: "test-native" };
const flags = { "caller-repo": envelope.repository, "caller-source": JSON.stringify(source), "caller-authority": envelope.authorityId, "caller-native-id": envelope.nativeId };
const flagArgs = Object.entries(flags).flatMap(([key, value]) => [`--${key}`, value]);

describe("unqualified Grok native callers", () => {
  test("marker and Grok session presence refuse, including present-empty values and explicit CC/OC callers", () => {
    for (const key of ["SANE_UNQUALIFIED_NATIVE", "GROK_SESSION_ID"] as const) {
      for (const value of ["", "1", "false", "native-session"]) {
        for (const context of [undefined, JSON.stringify(envelope), JSON.stringify({ version: 1, harness: "oc", nativeId: "ses-test" })]) {
          const signals: CallerSignals = { [key]: value, SANE_CALLER_CONTEXT: context };
          expect(() => classifyCaller(signals, flags)).toThrow("Native caller evidence");
          for (const command of [["init"], ["upgrade"], ["select", "--workstream", "test"], ["create", "--name", "test", "--type", "feature"]]) {
            expect(parseCliCommand(command, signals)).toMatchObject({ kind: "error", code: "NATIVE_CONTEXT_UNAVAILABLE" });
            expect(parseCliCommand([...command, ...flagArgs], signals)).toMatchObject({ kind: "error", code: "NATIVE_CONTEXT_UNAVAILABLE" });
          }
        }
      }
    }
  });

  test("human and existing CC/OC classification is unchanged when markers are absent", () => {
    expect(classifyCaller({})).toEqual({ actorKind: "local" });
    expect(parseCliCommand(["upgrade"], {})).toMatchObject({ kind: "command", intent: { caller: { actorKind: "local" } } });
    expect(classifyCaller({ SANE_CALLER_CONTEXT: JSON.stringify(envelope), SANE_SESSION_ID: envelope.nativeId })).toEqual({ actorKind: "native", envelope });
    expect(classifyCaller({}, flags)).toEqual({ actorKind: "native", envelope });
    const ref = { version: 1, harness: "oc", nativeId: "ses-test" };
    expect(classifyCaller({ SANE_CALLER_CONTEXT: JSON.stringify(ref), OPENCODE_SESSION_ID: ref.nativeId })).toEqual({ actorKind: "native-ref", ref });
  });

  test("environment snapshot preserves empty markers", () => {
    expect(callerSignals({ SANE_UNQUALIFIED_NATIVE: "", GROK_SESSION_ID: "" })).toMatchObject({ SANE_UNQUALIFIED_NATIVE: "", GROK_SESSION_ID: "" });
    expect(parseCliCommand(["upgrade"], callerSignals({ SANE_UNQUALIFIED_NATIVE: "" }))).toMatchObject({ kind: "error", code: "NATIVE_CONTEXT_UNAVAILABLE" });
  });

  test("execution rejects before any repository discovery, initialization, mutation or upgrade", async () => {
    for (const signals of [{ SANE_UNQUALIFIED_NATIVE: "" }, { GROK_SESSION_ID: "native-id" }]) {
      for (const args of [["init"], ["upgrade"], ["create", "--name", "test", "--type", "feature"], ["init", ...flagArgs]]) {
        await expect(executeCliCommand(args, { cwd: "/nonexistent/no-repository-access", signals })).rejects.toMatchObject({ code: "NATIVE_CONTEXT_UNAVAILABLE" });
      }
    }
  });

  test("absolute installed CLI entry inherits present-empty refusal from its environment", async () => {
    const entry = fileURLToPath(new URL("../../../bin/sane.ts", import.meta.url));
    for (const marker of ["SANE_UNQUALIFIED_NATIVE", "GROK_SESSION_ID"]) {
      const child = Bun.spawn([process.execPath, entry, "upgrade", "--repo", "/nonexistent/no-repository-access", ...flagArgs], {
        env: { [marker]: "" }, stdout: "pipe", stderr: "pipe",
      });
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited).toBe(1);
      expect(JSON.parse(stderr)).toMatchObject({ code: "NATIVE_CONTEXT_UNAVAILABLE" });
    }
  });
});
