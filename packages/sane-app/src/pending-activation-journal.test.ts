import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { PendingActivationJournals, type PendingActivationInput, type PendingActivationPreparation } from "./pending-activation-journal";
import { RunJournalWriter } from "./run-journal";
import type { Event } from "./history";

const temporary = "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(harnessId: "claude-code" | "opencode" = "opencode") {
  const root = fs.realpathSync(fs.mkdtempSync(join(temporary, "pending-activation-test-"))); roots.push(root);
  const storeId = crypto.randomUUID(), sessionId = crypto.randomUUID(), failures: unknown[] = [];
  const manifest = join(root, "manifest.json");
  fs.writeFileSync(manifest, JSON.stringify({ format: "sane-app-store", version: 1, storeId, createdAt: new Date().toISOString() }));
  const input: PendingActivationInput = { sessionId, identity: { kind: "assistant", role: "engineering" },
    activation: { saneExecution: { schema: 1, revision: "e".repeat(64) }, saneContext: { version: 1, framework: "pinned framework", package: { schema: 1, revision: "c".repeat(64), delivery: "standing-native-role" } } },
    source: { harnessId, authorityId: `sane-native-v1:${harnessId === "opencode" ? "oc" : "cc"}:${"a".repeat(64)}`, cwd: root } };
  const deps = { assertStorage() {}, failClosed(error: unknown) { failures.push(error); } };
  const fresh = () => { const writer = new RunJournalWriter(root, deps); return { writer, helper: new PendingActivationJournals(root, storeId, writer, deps) }; };
  const initial = fresh(), recordPath = join(root, "activations", sessionId, "activation.json");
  const readRecord = () => JSON.parse(fs.readFileSync(recordPath, "utf8"));
  const journal = (runId: string) => join(root, `${runId}.jsonl`);
  const events = (runId: string) => fs.readFileSync(journal(runId), "utf8").trimEnd().split("\n").map(line => JSON.parse(line) as Event);
  const mutateRecord = (change: (record: any) => void) => { const record = readRecord(); change(record); fs.writeFileSync(recordPath, JSON.stringify(record)); };
  return { root, storeId, manifest, input, deps, fresh, failures, ...initial, recordPath, readRecord, journal, events, mutateRecord };
}

describe("bounded pending canonical activation preparation", () => {
  for (const harness of ["claude-code", "opencode"] as const) test(`${harness}: durable prep precedes ordinary seq 2 and preserves original live event`, () => {
    const f = fixture(harness);
    expect(f.helper.hasPending(f.input.sessionId)).toBe(false);
    expect([...f.helper.anchoredRunIds()]).toEqual([]);
    const token = f.helper.prepare(f.input), record = f.readRecord(), bytes = fs.readFileSync(f.journal(token.runId));
    expect(record.schema).toBe(3);
    expect(record.runId).toBe(token.runId);
    expect(record.nativeCommandId).toBe(token.nativeCommandId);
    expect(harness === "opencode" ? /^msg_/.test(token.nativeCommandId!) : token.nativeCommandId === null).toBe(true);
    expect(f.events(token.runId)).toEqual(token.events.slice());
    expect(token.events[0]!.kind).toBe("context");
    expect(token.events[0]!.data).toMatchObject({ schema: 1, type: "activation-preparation", storeId: f.storeId });
    expect(Object.isFrozen(token)).toBe(true);
    expect(Object.isFrozen(token.activation.saneContext)).toBe(true);
    expect(Object.isFrozen(token.events)).toBe(true);
    expect(f.helper.prepare(structuredClone(f.input))).toBe(token);
    expect(f.helper.hasPending(f.input.sessionId)).toBe(true);
    expect([...f.helper.anchoredRunIds()]).toEqual([token.runId]);
    f.helper.assertCurrent(token, f.input);
    expect(fs.readFileSync(f.journal(token.runId))).toEqual(bytes);
    const installed = token.events.slice(), original = f.writer.reservation(installed[0]!);
    expect(original.event).toBe(token.events[0]);
    const status = f.writer.reserve({ runId: token.runId, sessionId: f.input.sessionId }, installed, "status", { status: "running" });
    installed.push(status.event); f.writer.commit(status);
    expect(status.event.seq).toBe(2);
    expect(installed[0]).toBe(original.event);
    expect(f.events(token.runId)).toEqual(installed);
    // Startup scanning does not mistake actual Run history for prep-only.
    expect([...f.helper.anchoredRunIds()]).toEqual([token.runId]);
    expect(() => f.helper.assertCurrent(token, f.input)).toThrow("advanced");
  });

  test("new directories and anchored record are synced before journal creation", () => {
    const f = fixture(), sync = fs.fsyncSync, synced = new Set<number>();
    const syncSpy = spyOn(fs, "fsyncSync").mockImplementation(fd => { synced.add(fs.fstatSync(fd).ino); sync(fd); });
    const reserve = f.writer.reserveNew.bind(f.writer);
    const reserveSpy = spyOn(f.writer, "reserveNew").mockImplementation((...args) => {
      for (const path of [f.root, join(f.root, "activations"), join(f.root, "activations", f.input.sessionId), f.recordPath]) expect(synced.has(fs.lstatSync(path).ino)).toBe(true);
      expect(fs.existsSync(f.journal(args[0].runId))).toBe(false);
      return reserve(...args);
    });
    try { f.helper.prepare(f.input); } finally { reserveSpy.mockRestore(); syncSpy.mockRestore(); }
  });

  test("fresh writer/helper adopt the same IDs and bytes, without branding decoded events", () => {
    const f = fixture(), token = f.helper.prepare(f.input), bytes = fs.readFileSync(f.journal(token.runId));
    const next = f.fresh(), adopted = next.helper.prepare(f.input);
    expect(adopted.runId).toBe(token.runId);
    expect(adopted.nativeCommandId).toBe(token.nativeCommandId);
    expect(adopted.events).toEqual(token.events);
    expect(adopted.events[0]).not.toBe(token.events[0]);
    next.helper.assertCurrent(adopted, f.input);
    expect(fs.readFileSync(f.journal(token.runId))).toEqual(bytes);
    expect(() => next.writer.reservation(adopted.events[0]!)).toThrow("original");
  });

  test("independent same-process helpers never rotate anchored IDs or lose original reservations", () => {
    const f = fixture(), token = f.helper.prepare(f.input);
    const next = new PendingActivationJournals(f.root, f.storeId, f.writer, f.deps), adopted = next.prepare(f.input);
    expect(adopted.runId).toBe(token.runId);
    expect(adopted.nativeCommandId).toBe(token.nativeCommandId);
    expect(adopted.events[0]).toBe(token.events[0]);
    expect(f.writer.reservation(adopted.events[0]!)).toBe(f.writer.reservation(token.events[0]!));
  });

  for (const damage of ["missing", "empty", "torn", "unterminated", "submission", "native", "duplicate-prep"] as const) test(`restart refuses ${damage} journal, without writes or repair`, () => {
    const f = fixture(), token = f.helper.prepare(f.input), path = f.journal(token.runId);
    if (damage === "missing") fs.unlinkSync(path);
    if (damage === "empty") fs.writeFileSync(path, "");
    if (damage === "torn") fs.appendFileSync(path, '{"seq":2');
    if (damage === "unterminated") fs.writeFileSync(path, fs.readFileSync(path, "utf8").trimEnd());
    if (["submission", "native", "duplicate-prep"].includes(damage)) fs.appendFileSync(path, JSON.stringify({ ...token.events[0], seq: 2,
      kind: damage === "submission" ? "submission" : damage === "native" ? "stdout" : "context", data: damage === "duplicate-prep" ? token.events[0]!.data : {} }) + "\n");
    const before = fs.existsSync(path) ? fs.readFileSync(path) : null, record = fs.readFileSync(f.recordPath);
    const next = f.fresh();
    expect([...next.helper.anchoredRunIds()]).toEqual([token.runId]);
    expect(() => next.helper.prepare(f.input)).toThrow();
    expect(fs.existsSync(path) ? fs.readFileSync(path) : null).toEqual(before);
    expect(fs.readFileSync(f.recordPath)).toEqual(record);
    expect(() => next.helper.prepare(f.input)).toThrow("reconciliation");
  });

  test("crash after durable record but before journal remains unknown forever", () => {
    const f = fixture(), reserve = spyOn(f.writer, "reserveNew").mockImplementation(() => { throw new Error("crash gap"); });
    try { expect(() => f.helper.prepare(f.input)).toThrow("crash gap"); } finally { reserve.mockRestore(); }
    const record = f.readRecord(), bytes = fs.readFileSync(f.recordPath);
    expect(fs.existsSync(f.journal(record.runId))).toBe(false);
    for (let i = 0; i < 2; i++) {
      const next = f.fresh();
      expect(next.helper.hasPending(f.input.sessionId)).toBe(true);
      expect([...next.helper.anchoredRunIds()]).toEqual([record.runId]);
      expect(() => next.helper.prepare(f.input)).toThrow("missing");
      expect(fs.readFileSync(f.recordPath)).toEqual(bytes);
      expect(fs.existsSync(f.journal(record.runId))).toBe(false);
    }
  });

  test("legacy schema 2 stays untouched and is ignored by startup discovery", () => {
    const f = fixture(), directory = join(f.root, "activations", f.input.sessionId);
    fs.mkdirSync(directory, { recursive: true });
    const bytes = JSON.stringify({ schema: 2, identity: f.input.identity, activation: f.input.activation }); fs.writeFileSync(f.recordPath, bytes);
    expect(f.helper.hasPending(f.input.sessionId)).toBe(false);
    expect([...f.helper.anchoredRunIds()]).toEqual([]);
    expect(() => f.helper.prepare(f.input)).toThrow("Legacy");
    expect(fs.readFileSync(f.recordPath, "utf8")).toBe(bytes);
    expect(f.failures).toEqual([]);
    expect(f.helper.hasPending(f.input.sessionId)).toBe(false);
  });
  test("a schema-only downgrade cannot hide an anchored journal from startup repair exclusion", () => {
    const f = fixture(), token = f.helper.prepare(f.input);
    fs.appendFileSync(f.journal(token.runId), '{"seq":2');
    f.mutateRecord(record => { record.schema = 2; });
    const bytes = fs.readFileSync(f.journal(token.runId)), next = f.fresh();
    expect(() => next.helper.anchoredRunIds()).toThrow("shape");
    expect(fs.readFileSync(f.journal(token.runId))).toEqual(bytes);
    expect(f.failures.length).toBeGreaterThan(0);
  });
  for (const damage of ["same-bytes", "substituted-ids"] as const) test(`replacement at original anchor close (${damage}) cannot become the initial pin`, () => {
    const f = fixture(), close = fs.closeSync;
    let replaced = false, originalRunId: string | undefined;
    const spy = spyOn(fs, "closeSync").mockImplementation(fd => {
      const opened = fs.fstatSync(fd);
      const isAnchor = fs.existsSync(f.recordPath) && fs.lstatSync(f.recordPath).ino === opened.ino;
      close(fd);
      if (isAnchor && !replaced) {
        replaced = true;
        const record = f.readRecord(); originalRunId = record.runId;
        if (damage === "substituted-ids") { record.runId = crypto.randomUUID(); record.nativeCommandId = "msg_substituted"; }
        const replacement = join(f.root, "replacement-anchor");
        fs.writeFileSync(replacement, JSON.stringify(record)); fs.renameSync(replacement, f.recordPath);
      }
    });
    try { expect(() => f.helper.prepare(f.input)).toThrow("pinned bytes changed"); }
    finally { spy.mockRestore(); }
    expect(replaced).toBe(true);
    expect(originalRunId).toBeDefined();
    expect(fs.existsSync(f.journal(originalRunId!))).toBe(false);
    expect(f.failures.length).toBeGreaterThan(0);
  });

  for (const field of ["identity", "activation", "source", "storeId", "sessionId", "runId", "nativeCommandId"] as const) test(`foreign anchor ${field} refuses preparation`, () => {
    const f = fixture(), token = f.helper.prepare(f.input);
    f.mutateRecord(record => {
      if (field === "identity") record.identity.role = "planning";
      if (field === "activation") record.activation.saneExecution.revision = "f".repeat(64);
      if (field === "source") record.source.authorityId = `sane-native-v1:oc:${"b".repeat(64)}`;
      if (field === "storeId" || field === "sessionId" || field === "runId") record[field] = crypto.randomUUID();
      if (field === "nativeCommandId") record.nativeCommandId = "msg_other";
    });
    const before = fs.readFileSync(f.recordPath), journal = fs.readFileSync(f.journal(token.runId));
    const next = f.fresh();
    expect(() => next.helper.prepare(f.input)).toThrow();
    expect(fs.readFileSync(f.recordPath)).toEqual(before);
    expect(fs.readFileSync(f.journal(token.runId))).toEqual(journal);
  });

  for (const field of ["identity", "activation", "source", "storeId", "sessionId", "runId", "nativeCommandId", "prompt", "submission", "attempt", "activated"] as const) test(`foreign preparation marker ${field} refuses adoption`, () => {
    const f = fixture(), token = f.helper.prepare(f.input), events = f.events(token.runId), marker = events[0]!.data as any;
    if (field === "identity") marker.identity.role = "planning";
    else if (field === "activation") marker.activation.saneContext.framework = "other";
    else if (field === "source") marker.source.cwd = "/elsewhere";
    else marker[field] = field === "nativeCommandId" ? "msg_other" : "foreign";
    fs.writeFileSync(f.journal(token.runId), JSON.stringify(events[0]) + "\n");
    const next = f.fresh(), before = fs.readFileSync(f.journal(token.runId));
    expect(() => next.helper.prepare(f.input)).toThrow("does not match");
    expect(fs.readFileSync(f.journal(token.runId))).toEqual(before);
  });

  for (const damage of ["record-symlink", "journal-symlink", "record-hardlink", "journal-hardlink", "directory-symlink", "manifest-replacement", "root-replacement", "record-replacement", "journal-replacement", "record-edit", "journal-edit"] as const) test(`physical ${damage} is sticky`, () => {
    const f = fixture(), token = f.helper.prepare(f.input), path = damage.startsWith("journal") ? f.journal(token.runId) : f.recordPath;
    if (damage.endsWith("symlink") && damage !== "directory-symlink" || damage.endsWith("hardlink")) {
      const target = join(f.root, "target"); fs.renameSync(path, target);
      if (damage.endsWith("symlink")) fs.symlinkSync(target, path); else fs.linkSync(target, path);
    } else if (damage === "directory-symlink") {
      const directory = join(f.root, "activations", f.input.sessionId), target = join(f.root, "moved");
      fs.renameSync(directory, target); fs.symlinkSync(target, directory);
    } else if (["manifest-replacement", "record-replacement", "journal-replacement"].includes(damage)) {
      const original = damage === "manifest-replacement" ? f.manifest : path;
      const replacement = join(f.root, "replacement"); fs.copyFileSync(original, replacement); fs.renameSync(replacement, original);
    } else if (damage === "root-replacement") {
      const moved = `${f.root}-moved`; roots.push(moved); fs.renameSync(f.root, moved); fs.mkdirSync(f.root);
    } else fs.appendFileSync(path, " ");
    expect(() => f.helper.assertCurrent(token, f.input)).toThrow();
    expect(() => f.helper.hasPending(f.input.sessionId)).toThrow("reconciliation");
    expect(f.failures.length).toBeGreaterThan(0);
  });

  test("startup discovery rejects symlinked session directories without loading or repairing journals", () => {
    const f = fixture(), directory = join(f.root, "activations"); fs.mkdirSync(directory);
    const target = join(f.root, "outside"); fs.mkdirSync(target); fs.symlinkSync(target, join(directory, f.input.sessionId));
    expect(() => f.helper.anchoredRunIds()).toThrow("Unsafe");
    expect(fs.readdirSync(target)).toEqual([]);
  });

  test("pre-install extra reservations and still-queued callbacks cannot be hidden", () => {
    const f = fixture(), token = f.helper.prepare(f.input);
    const reservation = f.writer.reserve({ runId: token.runId, sessionId: f.input.sessionId }, token.events, "status", { status: "running" });
    f.writer.flushThrough(reservation);
    expect(() => f.helper.assertCurrent(token, f.input)).toThrow("queued callbacks");
  });

  test("copied tokens and mismatched caller scope are not installation capabilities", () => {
    const f = fixture(), token = f.helper.prepare(f.input);
    expect(() => f.helper.assertCurrent({ ...token } as PendingActivationPreparation, f.input)).toThrow("Foreign");
    const other = fixture(), valid = other.helper.prepare(other.input), changed = structuredClone(other.input); changed.source.cwd = "/other";
    expect(() => other.helper.assertCurrent(valid, changed)).toThrow("changed");
  });
});
