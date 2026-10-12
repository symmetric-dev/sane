import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { contextAsset, contextHash, createContextPackage, renderContextDelivery, validateContextComposition, validateContextDelivery, validateContextPackage, type ContextDelivery } from "../src/context-package";
import { ContextPackageStore } from "../src/context-package-store";
import { assertContextCurrent, contextReceipt, prepareContextDelivery } from "../src/context-delivery";

const binding = { sessionId: "s", nativeSessionId: "n", authorityId: "a", harness: "opencode", cwd: "/repo" };
const worker = () => createContextPackage({ kind: "worker", role: "scout" }, [contextAsset("role.worker.scout", "role.md", "Scout role", "role")]);
const delivery = () => renderContextDelivery(worker(), binding, {}, "Session roots");
const trustedProvider = (d: ContextDelivery) => Object.assign(async () => d, {
  validate: (candidate: ContextDelivery) => validateContextComposition(candidate, { bundle: worker(), binding, paths: {}, dynamic: "Session roots", injectRole: false }),
});

describe("canonical context foundations", () => {
  test("composition is deterministic, detached, and explicit role injection is exclusive", () => {
    const role = contextAsset("role.worker.scout", "role.md", "Scout role", "role");
    const bundle = createContextPackage({ kind: "worker", role: "scout" }, [role]);
    role.text = "mutated";
    validateContextPackage(bundle);
    expect(bundle.revision).toBe(worker().revision);
    const referenced = renderContextDelivery(bundle, binding, {}, "Session");
    const injected = renderContextDelivery(bundle, binding, {}, "Session", undefined, true);
    expect(referenced.standing).not.toContain("Scout role");
    expect(injected.standing.match(/Scout role/g)).toHaveLength(1);
    expect(injected.standing.startsWith("Scout role\n\n# SANE Context")).toBe(true);
    expect(injected.segments.some(s => s.channel === "native-role-reference")).toBe(false);
    validateContextDelivery(referenced);
    validateContextDelivery(injected);
  });

  test("assistant identity precedes framework and only Pickup is inlined", () => {
    const role = contextAsset("role.assistant.engineering", "engineering.md", "You are a SANE Engineering Assistant Agent.", "role");
    const procedures = ["pickup", "assistance", "delivery"].map(phase => contextAsset(`sane-assistant-engineering-${phase}`, `${phase}.md`, `Unique ${phase} procedure body`, "procedure"));
    const bundle = createContextPackage({ kind: "assistant", role: "engineering" }, [role, ...procedures]);
    const paths = Object.fromEntries(procedures.map(p => [p.id, `/pinned/${p.id}/SKILL.md`]));
    const d = renderContextDelivery(bundle, binding, paths, "Current Session", undefined, true);
    expect(d.standing.startsWith(role.text + "\n\n# SANE Context")).toBe(true);
    expect(d.standing.indexOf("# SANE Context")).toBeLessThan(d.standing.indexOf("# SANE private procedures"));
    expect(d.standing.indexOf("# SANE private procedures")).toBeLessThan(d.standing.indexOf(procedures[0]!.text));
    expect(d.standing).not.toContain(procedures[1]!.text);
    expect(d.standing).not.toContain(procedures[2]!.text);
    expect(d.standing).toContain(paths[procedures[1]!.id]!);
    expect(d.standing).toContain(paths[procedures[2]!.id]!);
    validateContextDelivery(d);
  });

  test("workers split pinned procedure once and reject changed procedure prefixes", () => {
    const bundle = worker(), procedure = bundle.assets.find(a => a.id === "worker-procedure.scout")!;
    const d = renderContextDelivery(bundle, binding, {}, "Session", `${procedure.text}\n\nAssigned roots`);
    expect(d.segments.find(s => s.id === "worker-assignment")?.text).toBe("Assigned roots");
    expect(d.standing.split(procedure.text)).toHaveLength(2);
    expect(d.standing).not.toContain("Pickup");
    expect(() => renderContextDelivery(bundle, binding, {}, "Session", "Changed procedure\n\nAssigned roots")).toThrow();
    expect(() => renderContextDelivery(bundle, binding, {}, "Session", `${procedure.text}\n\n`)).toThrow();
  });

  test("delivery verifies every byte and segment hash", () => {
    for (const field of ["standing", "dynamic", "staticHash", "dynamicHash", "payloadHash"] as const) {
      const d = delivery(); d[field] += "changed";
      expect(() => validateContextDelivery(d)).toThrow();
    }
    const d = delivery(); d.segments[0].text += "changed";
    expect(() => validateContextDelivery(d)).toThrow();
    expect(() => renderContextDelivery(worker(), { ...binding, harness: "" }, {}, "Session")).toThrow();
  });

  test("retry rechecks reference provenance even when injected bytes are unchanged", async () => {
    const d = delivery(), changed = structuredClone(d);
    changed.segments.find(s => s.channel === "native-role-reference")!.source = "another-role.md";
    expect(changed.payloadHash).toBe(d.payloadHash);
    await expect(assertContextCurrent(d, trustedProvider(changed), () => {})).rejects.toThrow("trusted pinned inputs");
    const equivalent = { ...d, binding: { cwd: "/repo", harness: "opencode", authorityId: "a", nativeSessionId: "n", sessionId: "s" } };
    await assertContextCurrent(d, trustedProvider(equivalent), () => {});
    expect(contextReceipt(d, "configured", "system").stage).toBe("configured");
  });

  test("prepared trace snapshots provider bytes and refuses mismatched run", async () => {
    const d = delivery();
    const session = { ...binding, saneContext: { package: { revision: d.packageRevision } } } as any;
    const run = { sessionId: "s", cwd: "/repo" } as any;
    const events: any[] = [];
    const prepared = await prepareContextDelivery(session, run, trustedProvider(d), async (_r, _k, event) => { events.push(event); }, () => {});
    d.standing = "later mutation";
    expect(prepared?.standing).not.toBe(d.standing);
    expect(events[0].stage).toBe("prepared");
    await expect(prepareContextDelivery(session, { ...run, sessionId: "other" }, trustedProvider(delivery()), async () => {}, () => {})).rejects.toThrow();
  });

  test("self-consistent payloads cannot omit or reclassify pinned composition", async () => {
    const rehash = (d: ContextDelivery) => {
      d.standing = d.segments.filter(s => s.channel === "standing").map(s => s.text).join("\n\n");
      d.staticHash = contextHash(d.standing);
      d.payloadHash = contextHash(`${d.standing}\n\n${d.dynamic}`);
      validateContextDelivery(d);
      return d;
    };
    const omitted = delivery(); omitted.segments = omitted.segments.filter(s => s.channel === "dynamic");
    const reclassified = delivery();
    reclassified.segments = reclassified.segments.filter(s => s.channel !== "native-role-reference");
    reclassified.segments[0].channel = "native-role-reference";
    const rolePolicy = renderContextDelivery(worker(), binding, {}, "Session roots", undefined, true);
    for (const forged of [rehash(omitted), rehash(reclassified), rolePolicy]) {
      const session = { ...binding, saneContext: { package: { revision: forged.packageRevision } } } as any;
      let emitted = false;
      await expect(prepareContextDelivery(session, { sessionId: "s", cwd: "/repo" } as any, trustedProvider(forged), async () => { emitted = true; }, () => {})).rejects.toThrow("trusted pinned inputs");
      expect(emitted).toBe(false);
      await expect(assertContextCurrent(delivery(), trustedProvider(forged), () => {})).rejects.toThrow("trusted pinned inputs");
    }
    await expect(assertContextCurrent(delivery(), async () => delivery(), () => {})).rejects.toThrow("validator is unavailable");
  });

  test("prepared events and receipt bindings are detached in both directions", async () => {
    const d = delivery(), session = { ...binding, saneContext: { package: { revision: d.packageRevision } } } as any;
    let event: any;
    const prepared = await prepareContextDelivery(session, { sessionId: "s", cwd: "/repo" } as any, trustedProvider(d), async (_r, _k, data) => {
      event = data;
      event.delivery.binding.cwd = "/emitter-mutated";
      event.delivery.segments[0].text = "emitter mutation";
    }, () => {});
    expect(prepared).toEqual(d);
    prepared!.binding.cwd = "/caller-mutated";
    prepared!.segments[0].text = "caller mutation";
    expect(event.delivery.binding.cwd).toBe("/emitter-mutated");
    expect(event.delivery.segments[0].text).toBe("emitter mutation");
    const receipt = contextReceipt(d, "configured", "system");
    receipt.binding.cwd = "/receipt-mutated";
    expect(d.binding.cwd).toBe("/repo");
    d.binding.cwd = "/delivery-mutated";
    expect(receipt.binding.cwd).toBe("/receipt-mutated");
  });

  test("historical packages validate from their own bytes, fresh historical roles refuse", () => {
    const p = worker() as any;
    p.identity = { kind: "assistant", role: "knowledge" };
    p.assets = p.assets.filter((a: any) => !a.id.startsWith("worker-procedure."));
    p.assets.find((a: any) => a.kind === "role").id = "role.assistant.knowledge";
    p.revision = contextHash(JSON.stringify({ schema: p.schema, identity: p.identity, assets: p.assets, initial: p.initial }));
    validateContextPackage(p);
    expect(() => createContextPackage(p.identity, [])).toThrow("archived role");
  });
});

describe("private context package storage", () => {
  async function fixture(fn: (root: string, store: ContextPackageStore) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), "context-foundations-"));
    try {
      await mkdir(join(root, "source/opencode/agents/sane/worker"), { recursive: true });
      await writeFile(join(root, "source/opencode/agents/sane/worker/scout.md"), "---\ndescription: scout\n---\nScout role\n");
      await fn(root, new ContextPackageStore(join(root, "source"), join(root, "store")));
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  test("concurrent independent publishers agree; source changes never replace pinned bytes", async () => fixture(async (root, store) => {
    const other = new ContextPackageStore(join(root, "source"), join(root, "store"));
    const identity = { kind: "worker", role: "scout" } as const;
    const refs = await Promise.all([store.create(identity), other.create(identity), store.create(identity)]);
    expect(new Set(refs.map(r => r.revision)).size).toBe(1);
    await writeFile(join(root, "source/opencode/agents/sane/worker/scout.md"), "---\ndescription: scout\n---\nChanged role\n");
    const loaded = await store.load(refs[0]);
    expect(loaded.bundle.assets.find(a => a.kind === "role")?.text).toBe("Scout role\n");
    const next = await store.create(identity);
    expect(next.revision).not.toBe(refs[0].revision);
    await writeFile(loaded.paths["role.worker.scout"], "tampered");
    await expect(store.load(refs[0])).rejects.toThrow("changed");
  }));
  test("source and stored symlinks refuse", async () => fixture(async (root, store) => {
    const ref = await store.create({ kind: "worker", role: "scout" });
    const { paths } = await store.load(ref);
    const path = paths["role.worker.scout"], bytes = await readFile(path);
    await writeFile(join(root, "outside.md"), bytes);
    await rm(path); await symlink(join(root, "outside.md"), path);
    await expect(store.load(ref)).rejects.toThrow();
    const source = join(root, "source/opencode/agents/sane/worker/scout.md");
    await rm(source); await symlink(join(root, "outside.md"), source);
    await expect(store.create({ kind: "worker", role: "scout" })).rejects.toThrow();
    await expect(store.create({ kind: "assistant", role: "knowledge" })).rejects.toThrow("archived role");
  }));
  test("all current authored assistant packages close over existing resources", async () => {
    const root = await mkdtemp(join(tmpdir(), "context-authored-"));
    try {
      const store = new ContextPackageStore(resolve(import.meta.dir, "../../.."), root);
      for (const role of ["design", "engineering", "execution", "planning", "curation", "research", "experimentation"] as const) {
        const ref = await store.create({ kind: "assistant", role });
        const { bundle, paths } = await store.load(ref);
        const rendered = renderContextDelivery(bundle, binding, paths, "Session roots");
        const expected = { bundle, binding, paths, dynamic: "Session roots", injectRole: false };
        validateContextComposition(rendered, expected);
        const missingPickup = structuredClone(rendered);
        missingPickup.segments = missingPickup.segments.filter(s => !bundle.initial.includes(s.id));
        missingPickup.standing = missingPickup.segments.filter(s => s.channel === "standing").map(s => s.text).join("\n\n");
        missingPickup.staticHash = contextHash(missingPickup.standing);
        missingPickup.payloadHash = contextHash(`${missingPickup.standing}\n\n${missingPickup.dynamic}`);
        validateContextDelivery(missingPickup);
        expect(() => validateContextComposition(missingPickup, expected)).toThrow("trusted pinned inputs");
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("dangling relative resources fail before manifest publication", async () => fixture(async (root, store) => {
    await mkdir(join(root, "source/opencode/agents/sane/assistant"), { recursive: true });
    await writeFile(join(root, "source/opencode/agents/sane/assistant/design.md"), "---\ndescription: design\n---\nDesign role");
    for (const phase of ["pickup", "assistance", "delivery"]) {
      const directory = join(root, `source/skills/sane-assistant-design-${phase}`);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "SKILL.md"), "---\ndescription: procedure\n---\nRead `resources/MISSING.md`.");
    }
    await expect(store.create({ kind: "assistant", role: "design" })).rejects.toThrow("Dangling context resource");
  }));
  test("invalid UTF-8 cannot silently change pinned source bytes", async () => fixture(async (root, store) => {
    await writeFile(join(root, "source/opencode/agents/sane/worker/scout.md"), Buffer.from([0xff]));
    await expect(store.create({ kind: "worker", role: "scout" })).rejects.toThrow();
  }));
  test("Markdown resource destinations strip fragments; literal backtick paths do not", async () => fixture(async (root, store) => {
    await mkdir(join(root, "source/opencode/agents/sane/assistant"), { recursive: true });
    await writeFile(join(root, "source/opencode/agents/sane/assistant/design.md"), "---\ndescription: design\n---\nDesign role");
    for (const phase of ["pickup", "assistance", "delivery"]) {
      const directory = join(root, `source/skills/sane-assistant-design-${phase}`);
      await mkdir(join(directory, "resources"), { recursive: true });
      await writeFile(join(directory, "resources/guide.md"), "# Section\nGuidance");
      await writeFile(join(directory, "SKILL.md"), "---\ndescription: procedure\n---\nRead [guide](resources/guide.md#section) and [query](resources/guide.md?v=1#section).");
    }
    await store.load(await store.create({ kind: "assistant", role: "design" }));
    await writeFile(join(root, "source/skills/sane-assistant-design-pickup/SKILL.md"), "---\ndescription: procedure\n---\nRead `resources/guide.md#section`.");
    await expect(store.create({ kind: "assistant", role: "design" })).rejects.toThrow("Dangling context resource");
  }));
});
