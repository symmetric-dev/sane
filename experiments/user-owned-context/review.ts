/** Reassess saved responses without native discovery, session creation, or model calls. */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkContent } from "./checks.ts";

if (process.argv.length !== 3) throw new Error("Usage: bun experiments/user-owned-context/review.ts <run-directory>");
const directory = resolve(process.argv[2]!);
const evidence = JSON.parse(readFileSync(join(directory, "evidence.json"), "utf8"));
const inputs = JSON.parse(readFileSync(join(directory, "inputs.json"), "utf8"));
const transportKeys = new Set(["sameSession", "sonnetResolved", "noTools", "exactUserMessage", "activationOnce", "selectedModel", "noSyntheticContext", "noInstructionEntries", "noObservedToolCalls", "requestedModelReported"]);
const results = evidence.results.map((r: { harness: string; turn: string; response: string; checks: Record<string, boolean> }) => {
  const probe = inputs.probes.find((p: { name: string }) => p.name === r.turn);
  if (!probe) throw new Error(`Missing input for ${r.turn}`);
  const assessment = checkContent(probe, r.response);
  const transportChecks = Object.fromEntries(Object.entries(r.checks).filter(([key]) => transportKeys.has(key)));
  return { harness: r.harness, turn: r.turn, response: r.response, format: assessment.format, contentChecks: assessment.checks, originalTransportChecks: transportChecks };
});
const passed = results.length > 0 && results.every((r: { contentChecks: Record<string, boolean>; originalTransportChecks: Record<string, boolean> }) =>
  Object.values(r.contentChecks).every(Boolean) && Object.values(r.originalTransportChecks).every(Boolean));
writeFileSync(join(directory, "review.json"), JSON.stringify({
  kind: "offline-reassessment", realModelCalls: 0, originalRunComplete: evidence.complete,
  note: "Original evidence/results are unchanged. Fenced JSON is parsed explicitly; role labels compare case-insensitively. Original transport checks are reused, not independently re-verified. This does not complete an interrupted run.",
  passed, results,
}, null, 2) + "\n", { mode: 0o600 });
console.log(`${passed ? "PASS" : "FAIL"}: ${results.length} saved responses; zero model calls. Original run complete: ${evidence.complete}.`);
if (!passed) process.exitCode = 1;
