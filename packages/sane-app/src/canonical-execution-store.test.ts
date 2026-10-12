import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CanonicalExecutionStore } from "./canonical-execution-store";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(modelConfig?: string) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "sane-execution-policy-")); roots.push(root);
  return { root, store: new CanonicalExecutionStore(resolve(import.meta.dir, "../../.."), root, modelConfig) };
}

test("execution policy pins authored definitions and native-child roles independently of installed assets", async () => {
  const { store } = await fixture();
  const refs = await Promise.all(Array.from({ length: 3 }, () => store.create({ kind: "assistant", role: "engineering" })));
  expect(new Set(refs.map(ref => ref.revision)).size).toBe(1);
  const snapshot = await store.load(refs[0]);
  expect(snapshot.policy.spec.name).toBe("sane/assistant/engineering");
  expect(snapshot.children).toHaveLength(9);
  expect(snapshot.children.find(child => child.spec.name === "sane/worker/scout")?.spec.body).not.toContain("# SANE Procedure");
  expect(snapshot.policy.temperature).toBe(0.2);
});

test("execution snapshots refuse tampered bytes and symlink substitution", async () => {
  const { root, store } = await fixture();
  const ref = await store.create({ kind: "worker", role: "scout" }), path = join(root, `${ref.revision}.json`);
  const bytes = await readFile(path, "utf8");
  const modified = JSON.parse(bytes); modified.policy.permissions = [];
  await writeFile(path, JSON.stringify(modified));
  await expect(store.load(ref)).rejects.toThrow("changed");
  await rm(path);
  await writeFile(join(root, "replacement.json"), bytes);
  await symlink(join(root, "replacement.json"), path);
  await expect(store.load(ref)).rejects.toThrow("symbolic links");
});

test("fresh archival execution cannot silently become a current role", async () => {
  const { store } = await fixture();
  await expect(store.create({ kind: "assistant", role: "knowledge" })).rejects.toThrow("archived");
});
