import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CanonicalExecutionStore } from "./canonical-execution-store";
import { ContextPackageStore } from "./context-package-store";
import { createCanonicalActivation, prepareUserInput, reserveActivation, validateCanonicalActivation, type ActivationReservation } from "./user-input-preparation";
import { seedAgentProfiles } from "./agent-profiles-contract";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sane-activation-"))); roots.push(root);
  const source = join(root, "source"), repository = resolve(import.meta.dir, "../../..");
  await mkdir(join(source, "opencode/agents"), { recursive: true });
  await cp(join(repository, "opencode/agents/sane"), join(source, "opencode/agents/sane"), { recursive: true });
  for (const phase of ["pickup", "assistance", "delivery"]) {
    const skill = `sane-assistant-engineering-${phase}`;
    await cp(join(repository, "skills", skill), join(source, "skills", skill), { recursive: true });
  }
  return { source, stores: { execution: new CanonicalExecutionStore(source, join(root, "execution")), context: new ContextPackageStore(source, join(root, "context")) } };
}
const worker = { kind: "worker", role: "implementer" } as const;

test("paired activation detects authored drift during publication before reservation", async () => {
  const { source, stores } = await fixture();
  let writes = 0;
  const changing = { ...stores, context: { load: stores.context.load.bind(stores.context), create: async () => {
    const ref = await stores.context.create(worker);
    const file = join(source, "opencode/agents/sane/worker/implementer.md");
    await writeFile(file, (await readFile(file, "utf8")) + "\nChanged while publishing.\n");
    return ref;
  } } };
  await expect(reserveActivation(worker, { read: async () => undefined, write: async () => { writes++; }, create: () => createCanonicalActivation(worker, changing), validate: async () => {} })).rejects.toThrow("changed during activation");
  expect(writes).toBe(0);
});

test("recovery loads the reserved pair after mode toggle and authored source removal", async () => {
  const { source, stores } = await fixture();
  let saved: ActivationReservation | undefined;
  const validate = async (pair: Awaited<ReturnType<typeof reserveActivation>>) => {
    if (!pair.saneContext || !pair.saneExecution) throw new Error("missing pair");
    await validateCanonicalActivation({ saneContext: pair.saneContext, saneExecution: pair.saneExecution }, worker, stores);
  };
  const pair = await reserveActivation(worker, { read: async () => saved, write: async record => { saved = structuredClone(record); }, create: () => createCanonicalActivation(worker, stores), validate });
  await rm(source, { recursive: true });
  let consultedCurrentMode = false;
  const recovered = await reserveActivation(worker, { read: async () => saved, write: async () => { throw new Error("must not rewrite"); }, create: async () => { consultedCurrentMode = true; return {}; }, validate });
  expect(consultedCurrentMode).toBe(false);
  expect(recovered).toEqual(pair);
});

test("execution-only pre-feature reservations fail precisely rather than reconstructing context", async () => {
  let created = false;
  await expect(reserveActivation(worker, { read: async () => ({ schema: 1, revision: "a".repeat(64) }), write: async () => {}, create: async () => { created = true; return {}; }, validate: async () => {} })).rejects.toThrow("Unpaired legacy execution reservation requires reconciliation");
  expect(created).toBe(false);
});

test("individually valid context and policy snapshots cannot form a mixed activation", async () => {
  const { source, stores } = await fixture();
  const first = await createCanonicalActivation(worker, stores);
  const file = join(source, "opencode/agents/sane/worker/implementer.md");
  await writeFile(file, (await readFile(file, "utf8")) + "\nNew role instruction.\n");
  const second = await createCanonicalActivation(worker, stores);
  await expect(validateCanonicalActivation({ saneExecution: first.saneExecution, saneContext: second.saneContext }, worker, stores)).rejects.toThrow("context and execution role bytes differ");
});

test("prepared user creation carries one immutable pair across later source changes", async () => {
  const { source, stores } = await fixture();
  let preparations = 0;
  const prepared = await prepareUserInput({ prompt: "Implement", harness: "opencode", agent: "engineering" }, {
    profiles: seedAgentProfiles(), getSession: () => undefined, defaultCwd: source,
    conversationId: () => "00000000-0000-4000-8000-000000000001", sourceAuthorityId: () => "source:oc",
    selectedDirectory: async () => source, ensureDirectory: async () => {}, validateOpenCodeModel: () => {},
    resolveOpenCodeLaunch: async (_cwd, settings) => { expect(settings.agent).toBe("build"); return { agent: "build" }; },
    prepareCanonicalExecution: async role => { preparations++; return createCanonicalActivation({ kind: "assistant", role }, stores); },
  });
  await rm(source, { recursive: true });
  const { saneExecution, saneContext } = prepared.configuration;
  if (!saneExecution || !saneContext) throw new Error("prepared pair missing");
  await validateCanonicalActivation({ saneExecution, saneContext }, { kind: "assistant", role: "engineering" }, stores);
  expect(preparations).toBe(1);
  expect(Object.isFrozen(saneContext.package)).toBe(true);
  expect(Object.isFrozen(saneExecution)).toBe(true);
  expect(prepared.configuration.nativeAgentSelected).toBe(false);
});
