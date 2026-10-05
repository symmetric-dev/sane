import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicAppRecord } from "./app-store";
import { isOpenCodeReplyBindingRecord, OpenCodeReplyBindings, type OpenCodeReplyBindingRecord } from "./opencode-reply-bindings";
import { openCodeIncarnation } from "../shared/conversation/oc-reply-reducer";

const TEMP = "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode";
const dirs: string[] = [], filename = "opencode-reply-bindings.json";
function record(id = "healthy", native = `ses_${id}`): OpenCodeReplyBindingRecord {
  const creation = { eventId: `evt_created_${id}`, createdAt: Date.parse("2026-10-01T00:00:00Z") };
  return { version: 1, conversationId: id, creation, source: { harness: "opencode", authorityId: "fake-authority", nativeSessionId: native, incarnation: openCodeIncarnation(creation) }, initialBaselineThrough: 12, registrationRevision: `revision_${id}`, nativeVersion: "2.0.21" };
}
function fixture(rows?: unknown[], save?: typeof atomicAppRecord) {
  const dir = mkdtempSync(join(TEMP, "oc-reply-bindings-test-")); dirs.push(dir);
  const path = join(dir, filename);
  if (rows) writeFileSync(path, JSON.stringify({ version: 1, bindings: rows }));
  const bindings = new OpenCodeReplyBindings(dir, save); bindings.load();
  return { dir, path, bindings };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("first creation/fence is durably published before exposure; input and output snapshots cannot mutate it", () => {
  const value = record(); let owner: OpenCodeReplyBindings | undefined;
  const f = fixture(undefined, (dir, name, next) => {
    expect(owner!.get(value.conversationId)).toBeUndefined();
    atomicAppRecord(dir, name, next);
  }); owner = f.bindings;
  expect(existsSync(f.path)).toBe(false); f.bindings.admit(value);
  const expected = structuredClone(value);
  value.creation.createdAt++; value.initialBaselineThrough = 999; value.source.nativeSessionId = "ses_changed";
  const exposed = f.bindings.get("healthy")!; exposed.creation.createdAt++; exposed.initialBaselineThrough++;
  expect(f.bindings.get("healthy")).toEqual(expected);
  const restart = new OpenCodeReplyBindings(f.dir); restart.load(); expect(restart.get("healthy")).toEqual(expected);
  const before = readFileSync(f.path, "utf8"); restart.admit(expected); expect(readFileSync(f.path, "utf8")).toBe(before);
  for (const patch of [{ initialBaselineThrough: 100 }, { registrationRevision: "new" }, { nativeVersion: "2.0.22" }]) {
    expect(() => restart.admit({ ...expected, ...patch })).toThrow("cannot be replaced");
  }
  const replacement = record("healthy", "ses_rebound");
  expect(() => restart.admit(replacement)).toThrow("cannot be replaced");
  expect(readFileSync(f.path, "utf8")).toBe(before);
});

test("ABA registration renewal rotates only revision, preserving first fence, creation time, source and native version across restart", () => {
  const original = record(), f = fixture([original]);
  const first = f.bindings.renewRegistration("healthy"), second = f.bindings.renewRegistration("healthy");
  expect(first.registrationRevision).not.toBe(original.registrationRevision); expect(second.registrationRevision).not.toBe(first.registrationRevision);
  expect({ ...second, registrationRevision: original.registrationRevision }).toEqual(original);
  first.creation.createdAt = 0; second.initialBaselineThrough = 1000;
  const restart = new OpenCodeReplyBindings(f.dir); restart.load();
  expect({ ...restart.get("healthy"), registrationRevision: original.registrationRevision }).toEqual(original);
  expect(() => restart.admit(original)).toThrow("cannot be replaced");
});

test("malformed optional record is not rewritten and does not poison unrelated records or later admissions", () => {
  const bad = { ...record("bad"), initialBaselineThrough: -1 }, good = record(), f = fixture([bad, good]);
  const before = readFileSync(f.path, "utf8"); f.bindings.load();
  expect(f.bindings.get("bad")).toBeUndefined(); expect(f.bindings.problem("bad", bad.source)).toContain("invalid or ambiguous");
  expect(f.bindings.get("healthy")).toEqual(good); expect(f.bindings.problem("healthy", good.source)).toBeUndefined();
  expect(readFileSync(f.path, "utf8")).toBe(before);
  f.bindings.admit(record("new")); expect(JSON.parse(readFileSync(f.path, "utf8")).bindings[0]).toEqual(bad);
  expect(f.bindings.get("new")).toEqual(record("new"));
});

for (const mode of ["conversation", "native-alias", "corrupt-alias"] as const) test(`${mode} ambiguity excludes each implicated record but not a healthy authority/source`, () => {
  const a = record("a"), b = mode === "conversation" ? record("a", "ses_other") : record("b", a.source.nativeSessionId);
  const rows = mode === "corrupt-alias" ? [a, { ...b, initialBaselineThrough: -1 }] : [a, b];
  const otherAuthority = { ...record("other", a.source.nativeSessionId), source: { ...record("other", a.source.nativeSessionId).source, authorityId: "other-authority" } };
  const f = fixture([...rows, record(), otherAuthority]);
  expect(f.bindings.get("a")).toBeUndefined(); expect(f.bindings.problem("a", a.source)).toBeDefined();
  expect(f.bindings.get(b.conversationId)).toBeUndefined(); expect(f.bindings.problem(b.conversationId, b.source)).toBeDefined();
  expect(f.bindings.get("healthy")).toEqual(record()); expect(f.bindings.get("other")).toEqual(otherAuthority);
  expect(() => f.bindings.admit(record("alias", a.source.nativeSessionId))).toThrow();
});

test("new duplicate native alias is rejected without changing durable or in-memory state", () => {
  const f = fixture([record()]), before = readFileSync(f.path, "utf8");
  expect(() => f.bindings.admit(record("alias", "ses_healthy"))).toThrow("already admitted");
  expect(readFileSync(f.path, "utf8")).toBe(before); expect(f.bindings.get("healthy")).toEqual(record());
});

for (const raw of ["{broken", JSON.stringify({ version: 2, bindings: [] }), JSON.stringify({ version: 1, bindings: [], unexpected: true })]) test("corrupt optional container fails closed without rewriting", () => {
  const f = fixture(); writeFileSync(f.path, raw);
  const bindings = new OpenCodeReplyBindings(f.dir); expect(() => bindings.load()).not.toThrow();
  expect(bindings.problem("healthy")).toContain("Optional"); expect(() => bindings.admit(record())).toThrow();
  expect(readFileSync(f.path, "utf8")).toBe(raw);
});

for (const operation of ["admit", "renew"] as const) test(`ambiguous ${operation} save failure disables optional storage only, retaining disk evidence`, () => {
  const f = fixture([record()], (dir, name, next) => { atomicAppRecord(dir, name, next); throw new Error("fake post-rename failure"); });
  expect(() => operation === "admit" ? f.bindings.admit(record("new")) : f.bindings.renewRegistration("healthy")).toThrow("publication failed");
  expect(f.bindings.problem("healthy")).toContain("Optional"); expect(f.bindings.get("healthy")).toBeUndefined();
  expect(() => f.bindings.admit(record("later"))).toThrow();
  const restart = new OpenCodeReplyBindings(f.dir); restart.load(); expect(restart.get("healthy")).toBeDefined();
  if (operation === "admit") expect(restart.get("new")).toEqual(record("new"));
  else expect(restart.get("healthy")!.registrationRevision).not.toBe(record().registrationRevision);
});

test("capacity rejection does not publish or rewrite healthy rows", () => {
  // Opaque malformed row has no attributable native identity and is preserved.
  const f = fixture([record(), "x".repeat(4 * 1024 * 1024 - 1000)]), before = readFileSync(f.path, "utf8");
  const large = record("n".repeat(500)); expect(isOpenCodeReplyBindingRecord(large)).toBe(true);
  expect(() => f.bindings.admit(large)).toThrow("capacity exceeded");
  expect(readFileSync(f.path, "utf8")).toBe(before); expect(f.bindings.get("healthy")).toEqual(record());
});

test("binding validation rejects invented incarnation, noninteger fence, extra fields and malformed creation", () => {
  const good = record(); expect(isOpenCodeReplyBindingRecord(good)).toBe(true);
  for (const bad of [null, { ...good, extra: true }, { ...good, source: { ...good.source, incarnation: "invented" } },
    { ...good, initialBaselineThrough: 1.5 }, { ...good, registrationRevision: "" }, { ...good, creation: { ...good.creation, extra: true } },
    { ...good, creation: { eventId: "", createdAt: NaN } }, { ...good, nativeVersion: "\u0000" }]) expect(isOpenCodeReplyBindingRecord(bad)).toBe(false);
});
