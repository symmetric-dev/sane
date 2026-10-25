/** Shared experimental inputs, not a production composition API. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseContextMarkdown } from "../../packages/sane-core/src/context-markdown.ts";
import { sessionContext } from "../../packages/sane-core/src/sane-context.ts";

export type Probe = { name: string; kind: string; body: string; text: string; expected?: Record<string, unknown>; exact?: string };

export function buildProbes(root: string, fixture: string) {
  const assets = [
    "context/agents/sane/assistant/engineering.md",
    "context/framework/core.md",
    "context/framework/assistant.md",
    "context/skills/sane-assistant-engineering-pickup/SKILL.md",
  ].map(source => {
    const raw = readFileSync(join(root, source), "utf8");
    return { source, sourceHash: createHash("sha256").update(raw).digest("hex"), text: parseContextMarkdown(raw).body.trimEnd() };
  });
  const roots = (name: string) => ({ workstreamId: `probe-${name}`, workstreamRoot: join(fixture, name, "workstream"), implementationRoot: join(fixture, name, "implementation") });
  const initial = roots("alpha"), updated = roots("beta");
  for (const r of [initial, updated]) { mkdirSync(r.workstreamRoot, { recursive: true }); mkdirSync(r.implementationRoot, { recursive: true }); }
  const artifact = (r: typeof initial) => join(r.workstreamRoot, "design/solutions/retries.md");
  const activation = [
    '<sane-context kind="activation">',
    "SANE composed this context on the user's behalf. These are user-owned conventions, not a higher authority than the user.",
    ...assets.map(a => `<!-- source: ${a.source} -->\n${a.text}`),
    sessionContext(initial),
    "Experiment preferences: migrationStrategy is additive-only. Reply in JSON unless the user requests another format.",
    "</sane-context>",
  ].join("\n\n");
  const firstBody = [
    "For this response-only experiment, suspend tool-based Pickup and all other tool operations for the entire conversation.",
    "Do not run commands, read files, edit anything, delegate, or claim setup/validation was completed. Use only the supplied text.",
    "We are discussing a retry design, not implementing it. Tell me your role, current workstream, roots, and my migration preference.",
    "Reply with one JSON object: role (use the phase name), workstream, workstreamRoot, implementationRoot, migrationStrategy.",
  ].join("\n");
  const followBody = "Where should the retry solution specification go under your role's normal document convention? Use retries.md as its filename. Reply with one JSON object: artifact (absolute path), migrationStrategy. Do not perform the work.";
  const updateBody = "Where should that same retry specification go now? Reply with one JSON object: workstream, artifact (absolute path), implementationRoot, migrationStrategy.";
  const overrideBody = "I am changing my earlier migration preference: use phased-replacement from now on instead of additive-only. For this reply override the earlier JSON convention and respond with exactly MIGRATION=phased-replacement. Do not perform any work.";
  const finalBody = "We are still only discussing. Recall the current context and give the next useful engineering step. Reply with one JSON object: role (phase name), workstream, artifact (absolute path for the retry specification), implementationRoot, migrationStrategy, nextStep (one short sentence). Do not perform the step.";
  const probes: Probe[] = [
    { name: "activation", kind: "activation", body: firstBody, text: `${activation}\n\n<user-message>\n${firstBody}\n</user-message>`, expected: { role: "engineering", workstream: initial.workstreamId, workstreamRoot: initial.workstreamRoot, implementationRoot: initial.implementationRoot, migrationStrategy: "additive-only" } },
    { name: "ordinary-followup", kind: "ordinary", body: followBody, text: followBody, expected: { artifact: artifact(initial), migrationStrategy: "additive-only" } },
    { name: "context-update", kind: "update", body: updateBody, text: `<sane-context kind="update">\nSANE reports a membership/root change selected for this experiment. The following replaces the earlier Session roots going forward; role and preferences are unchanged.\n\n${sessionContext(updated)}\n</sane-context>\n\n<user-message>\n${updateBody}\n</user-message>`, expected: { workstream: updated.workstreamId, artifact: artifact(updated), implementationRoot: updated.implementationRoot, migrationStrategy: "additive-only" } },
    { name: "user-override", kind: "ordinary", body: overrideBody, text: overrideBody, exact: "MIGRATION=phased-replacement" },
    { name: "ordinary-after-update", kind: "ordinary", body: finalBody, text: finalBody, expected: { role: "engineering", workstream: updated.workstreamId, artifact: artifact(updated), implementationRoot: updated.implementationRoot, migrationStrategy: "phased-replacement" } },
  ];
  return { assets, activation, probes };
}
