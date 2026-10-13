import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { claudeExecutionConfiguration, openCodeExecutionConfiguration, parseCanonicalAgentOperations, requiredNativeChildren } from "./canonical-agent-operations";
import { managedScoutCrew } from "./scout-crew-lifecycle";

test("new crew policy has only App delegation and no native child mapping in either harness", () => {
  const markdown = readFileSync(new URL("../../../opencode/agents/sane/worker/scout-crew.md", import.meta.url), "utf8");
  const policy = parseCanonicalAgentOperations(markdown, "sane/worker/scout-crew");
  expect(managedScoutCrew(policy)).toBe(true);
  expect(requiredNativeChildren(policy)).toEqual([]);
  const oc = openCodeExecutionConfiguration({ policy, sessionID: "crew", directory: "/repo" });
  expect(oc.delegation).toEqual({});
  expect(oc.nativeChildren).toEqual([]);
  expect(oc.permissions).toContainEqual({ action: "subagent", resource: "*", effect: "deny" });
  const cc = claudeExecutionConfiguration({ policy });
  expect(cc.permissions.deny).toContain("Agent");
  expect(cc.permissions.allow).toContain("mcp__sane__sane_worker_start");
  const old = parseCanonicalAgentOperations(markdown.replace("  sane_worker_start: allow", '    "sane/worker/scout": allow'), "sane/worker/scout-crew");
  expect(managedScoutCrew(old)).toBe(false);
  expect(requiredNativeChildren(old)).toEqual(["sane/worker/scout"]);
});
