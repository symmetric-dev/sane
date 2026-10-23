import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contextAsset, contextHash, createContextPackage, renderContextDelivery, validateContextComposition, type ContextAsset, type ContextComposition, type ContextDelivery } from "../src/context-package";
import { parseCanonicalAgentOperations } from "../src/canonical-agent-operations";
import type { ContextProvider } from "../src/context-delivery";
import type { Session } from "../src/history";

/** Test-owned package and exact binding: no installed profile or provider discovery. */
const compositions = new WeakMap<ContextDelivery, ContextComposition>();
export function canonicalFixture(session: Session, kind: "assistant" | "worker" = "assistant", upgrade = false, dynamic = "# Session\nworkstream: fixture\ncheckout: fixture", role?: ContextAsset, injectRole = upgrade) {
  session.authorityId = "fixture-authority";
  const identity = kind === "assistant" ? { kind, role: "design" as const } : { kind, role: "implementer" as const };
  const assets = [role ?? contextAsset(`role.${identity.kind}.${identity.role}`, "mock:role", "Fixture role instruction", "role")];
  if (kind === "assistant") assets.push(contextAsset("sane-assistant-design-pickup", "mock:pickup", "Fixture pickup instruction", "procedure"));
  const bundle = createContextPackage(identity, assets);
  session.saneContext = { version: 1, framework: "fixture", package: { schema: 1, revision: bundle.revision, delivery: "standing-native-role", ...(upgrade ? { activation: "upgrade" as const } : {}) } };
  const composition = { bundle, binding: { sessionId: session.sessionId, nativeSessionId: session.nativeSessionId!, harness: session.harness!, authorityId: session.authorityId, cwd: session.cwd }, paths: { "sane-assistant-design-pickup": "/fixture/pinned-pickup.md" }, dynamic, assignment: kind === "worker" ? "Fixture bounded worker assignment" : undefined, injectRole };
  const delivery = renderContextDelivery(bundle, composition.binding, composition.paths, dynamic, composition.assignment, injectRole);
  compositions.set(delivery, structuredClone(composition));
  return delivery;
}

/** Actual authored role source, with fully injected execution/runtime boundaries. */
export function canonicalSourceFixture(session: Session) {
  const source = "context/agents/sane/assistant/design.md";
  const markdown = readFileSync(new URL(`../../../${source}`, import.meta.url), "utf8");
  const policy = parseCanonicalAgentOperations(markdown, "sane/assistant/design");
  const role = contextAsset("role.assistant.design", source, policy.spec.body, "role", policy.spec.description);
  const delivery = canonicalFixture(session, "assistant", false, "# Session\nworkstream: fixture", role, true);
  const body = { schema: 1 as const, policy, children: [] };
  return { delivery, role, execution: { ...body, revision: contextHash(JSON.stringify(body)) } };
}

export function canonicalProvider(delivery: ContextDelivery, read: () => Promise<ContextDelivery | null> = async () => delivery): ContextProvider {
  let trusted = compositions.get(delivery);
  if (!trusted) throw new Error("Missing trusted fixture composition");
  const provider = async () => {
    const current = await read();
    // Only separately authored test fixtures can update trusted inputs. Modified
    // return objects never become their own validation authority.
    if (current && compositions.has(current)) trusted = compositions.get(current)!;
    return current;
  };
  return Object.assign(provider, { validate: (value: ContextDelivery) => validateContextComposition(value, trusted!) });
}

/** Optional reusable evidence. Never claim that mocked native storage is model consumption. */
export function captureContextEvidence(scenario: string, data: unknown) {
  const dir = process.env.SANE_MOCK_CONTEXT_EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${scenario}.json`), JSON.stringify({ schema: 1, evidenceKind: "deterministic-mock", realModelInvoked: false, runId: process.env.SANE_MOCK_CONTEXT_EVIDENCE_RUN_ID ?? null, capturedAt: new Date().toISOString(), scenario, data }, null, 2) + "\n");
}
