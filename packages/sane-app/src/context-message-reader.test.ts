import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import { ContextMessageHistoryError, ContextMessageJournalReader } from "./context-message-reader";
import { decodeLog, type Event } from "./history";
import { RunJournalWriter } from "./run-journal";

const temporary = "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(temporary, "context-reader-test-"))); roots.push(root);
  const storeId = crypto.randomUUID(), target = { runId: crypto.randomUUID(), sessionId: crypto.randomUUID() };
  const manifest = join(root, "manifest.json"), path = join(root, `${target.runId}.jsonl`);
  fs.writeFileSync(manifest, JSON.stringify({ format: "sane-app-store", version: 1, storeId, createdAt: new Date().toISOString() }));
  let hook = () => {}, calls = 0;
  const reader = new ContextMessageJournalReader(root, storeId, { assertStorage: () => { calls++; return hook(); } });
  const event = (seq = 1): Event => ({ ...target, seq, time: "2026-10-26T00:00:00.000Z", kind: "context", data: { type: "historical", nested: { text: "😀original" } } });
  const line = (seq = 1) => JSON.stringify(event(seq)) + "\n";
  return { root, storeId, manifest, path, target, reader, event, line, hook: (next: () => void) => { hook = next; }, calls: () => calls };
}
function scoped(action: () => unknown, code?: ContextMessageHistoryError["code"]) {
  let failure: unknown;
  try { action(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(ContextMessageHistoryError);
  if (code) expect((failure as ContextMessageHistoryError).code).toBe(code);
}

describe("protected context-message history reader", () => {
  test("captures deep-frozen historical events and an exact whole-file source without writing", () => {
    const f = fixture(), original = f.line(); fs.writeFileSync(f.path, original);
    const before = fs.statSync(f.path, { bigint: true }), names = fs.readdirSync(f.root);
    const result = f.reader.read(f.target);
    expect(result.events).toEqual([f.event()]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.events)).toBe(true);
    expect(Object.isFrozen(result.events[0])).toBe(true);
    expect(Object.isFrozen((result.events[0]!.data as { nested: unknown }).nested)).toBe(true);
    expect(result.source).toContain(f.storeId);
    expect(result.source).toContain(f.target.runId);
    expect(result.source).toContain(f.target.sessionId);
    expect(result.source).toContain(createHash("sha256").update(original).digest("hex"));
    result.assertCurrent();
    expect(fs.readFileSync(f.path, "utf8")).toBe(original);
    const after = fs.statSync(f.path, { bigint: true });
    expect([after.ino, after.size, after.mtimeNs, after.ctimeNs]).toEqual([before.ino, before.size, before.mtimeNs, before.ctimeNs]);
    expect(fs.readdirSync(f.root)).toEqual(names);
  });

  for (const kind of ["missing", "empty", "torn", "unterminated", "malformed", "foreign-run", "foreign-session", "invalid-utf8", "bom"] as const) {
    test(`refuses ${kind} history without repair, creation, or poisoning later valid reads`, () => {
      const f = fixture();
      let bytes: Buffer | undefined;
      if (kind === "empty") bytes = Buffer.alloc(0);
      if (kind === "torn") bytes = Buffer.from(f.line() + '{"seq":2');
      if (kind === "unterminated") bytes = Buffer.from(f.line().trimEnd());
      if (kind === "malformed") bytes = Buffer.from(f.line() + "not-json\n");
      if (kind === "foreign-run") bytes = Buffer.from(JSON.stringify({ ...f.event(), runId: crypto.randomUUID() }) + "\n");
      if (kind === "foreign-session") bytes = Buffer.from(JSON.stringify({ ...f.event(), sessionId: crypto.randomUUID() }) + "\n");
      if (kind === "invalid-utf8") bytes = Buffer.concat([Buffer.from(f.line()), Buffer.from([0xff, 0x0a])]);
      if (kind === "bom") bytes = Buffer.from("\uFEFF" + f.line());
      if (bytes) fs.writeFileSync(f.path, bytes);
      scoped(() => f.reader.read(f.target), kind === "missing" ? "context-source-unavailable" : "context-activation-unproven");
      expect(fs.existsSync(f.path) ? fs.readFileSync(f.path) : undefined).toEqual(bytes && Buffer.from(bytes));
      fs.writeFileSync(f.path, f.line());
      expect(f.reader.read(f.target).events).toEqual([f.event()]);
    });
  }

  test("explicitly refuses both decoder-repairable incomplete and unterminated logs", () => {
    const f = fixture();
    for (const raw of [f.line() + '{"seq":2', f.line().trimEnd()]) {
      expect(decodeLog(raw, f.target).repaired).toBeDefined();
      fs.writeFileSync(f.path, raw);
      scoped(() => f.reader.read(f.target), "context-activation-unproven");
      expect(fs.readFileSync(f.path, "utf8")).toBe(raw);
    }
  });

  for (const kind of ["symlink", "hardlink", "directory", "fifo", "oversized"] as const) {
    test(`rejects ${kind} source with bounded nonblocking reads`, () => {
      const f = fixture(), other = join(f.root, "other");
      fs.writeFileSync(other, f.line());
      if (kind === "symlink") fs.symlinkSync(other, f.path);
      if (kind === "hardlink") fs.linkSync(other, f.path);
      if (kind === "directory") fs.mkdirSync(f.path);
      if (kind === "fifo") {
        const made = Bun.spawnSync(["mkfifo", f.path]); expect(made.exitCode).toBe(0);
      }
      if (kind === "oversized") { fs.writeFileSync(f.path, ""); fs.truncateSync(f.path, 16 * 1024 * 1024 + 1); }
      const before = fs.lstatSync(f.path, { bigint: true });
      const read = spyOn(fs, "readSync");
      const open = spyOn(fs, "openSync");
      try {
        scoped(() => f.reader.read(f.target), "context-source-unavailable");
        expect(read.mock.calls.every(call => Number((call as readonly unknown[])[3]) <= 64 * 1024)).toBe(true);
        expect(open.mock.calls.some(call => call[0] === f.path && typeof call[1] === "number"
          && !!(call[1] & fs.constants.O_NONBLOCK) && !!(call[1] & fs.constants.O_NOFOLLOW))).toBe(true);
        expect(read.mock.calls.length).toBeLessThan(10); // Only small manifest reads, never the rejected source.
      } finally { read.mockRestore(); open.mockRestore(); }
      const after = fs.lstatSync(f.path, { bigint: true });
      expect([after.ino, after.size, after.mtimeNs, after.ctimeNs]).toEqual([before.ino, before.size, before.mtimeNs, before.ctimeNs]);
      expect(fs.readFileSync(other, "utf8")).toBe(f.line());
    });
  }

  for (const kind of ["manifest-edit", "manifest-replace", "manifest-missing", "manifest-symlink", "root-replace"] as const) {
    test(`refuses ${kind} on fresh reads and saved snapshot assertions`, () => {
      const f = fixture(); fs.writeFileSync(f.path, f.line());
      const result = f.reader.read(f.target);
      if (kind === "manifest-edit") fs.writeFileSync(f.manifest, fs.readFileSync(f.manifest, "utf8") + " ");
      if (kind === "manifest-replace") { const replacement = join(f.root, "replacement"); fs.copyFileSync(f.manifest, replacement); fs.renameSync(replacement, f.manifest); }
      if (kind === "manifest-missing") fs.unlinkSync(f.manifest);
      if (kind === "manifest-symlink") { const other = join(f.root, "other"); fs.renameSync(f.manifest, other); fs.symlinkSync(other, f.manifest); }
      if (kind === "root-replace") { const old = f.root + "-old"; fs.renameSync(f.root, old); roots.push(old); fs.mkdirSync(f.root); }
      scoped(() => f.reader.read(f.target), "context-source-unavailable");
      scoped(() => result.assertCurrent(), "context-source-unavailable");
    });
  }

  test("constructor requires canonical root, exact manifest identity and synchronous storage guard", () => {
    const f = fixture(), alias = f.root + "-alias"; fs.symlinkSync(f.root, alias); roots.push(alias);
    scoped(() => new ContextMessageJournalReader(alias, f.storeId, { assertStorage() {} }));
    scoped(() => new ContextMessageJournalReader(f.root, crypto.randomUUID(), { assertStorage() {} }));
    scoped(() => new ContextMessageJournalReader(f.root, f.storeId, { assertStorage: async () => {} }));
    fs.writeFileSync(f.manifest, "{}");
    scoped(() => new ContextMessageJournalReader(f.root, f.storeId, { assertStorage() {} }));
  });

  test("new reads allow valid later bridge appends, but old snapshots refuse them after awaits", async () => {
    const f = fixture(); fs.writeFileSync(f.path, f.line());
    const first = f.reader.read(f.target);
    await Promise.resolve();
    fs.appendFileSync(f.path, f.line(2));
    const before = fs.readFileSync(f.path);
    scoped(() => first.assertCurrent(), "context-retention-unproven");
    const second = f.reader.read(f.target);
    expect(second.events).toEqual([f.event(), f.event(2)]);
    expect(second.source).not.toBe(first.source);
    second.assertCurrent();
    expect(first.events).toEqual([f.event()]);
    expect(fs.readFileSync(f.path)).toEqual(before);
  });

  for (const kind of ["same-size-edit", "prefix-edit-and-append", "replacement", "truncate"] as const) {
    test(`saved snapshots and subsequent reads refuse ${kind} without changing disk`, () => {
      const f = fixture(); fs.writeFileSync(f.path, f.line());
      const first = f.reader.read(f.target);
      if (kind === "same-size-edit" || kind === "prefix-edit-and-append") fs.writeFileSync(f.path, f.line().replace("original", "modified") + (kind === "prefix-edit-and-append" ? f.line(2) : ""));
      if (kind === "replacement") { const replacement = join(f.root, "replacement"); fs.copyFileSync(f.path, replacement); fs.renameSync(replacement, f.path); }
      if (kind === "truncate") fs.truncateSync(f.path, 0);
      const before = fs.readFileSync(f.path);
      scoped(() => first.assertCurrent(), "context-retention-unproven");
      scoped(() => f.reader.read(f.target), "context-retention-unproven");
      expect(fs.readFileSync(f.path)).toEqual(before);
    });
  }

  test("storage guard is checked on each operation; missing proof never fails a writer or claims reservations", () => {
    const f = fixture(), writer = new RunJournalWriter(f.root, { assertStorage() {}, failClosed() {} });
    const adopt = spyOn(RunJournalWriter.prototype, "adoptExisting"), reserve = spyOn(RunJournalWriter.prototype, "reservation"), commit = spyOn(RunJournalWriter.prototype, "commit");
    try {
      scoped(() => f.reader.read(f.target));
      const token = writer.reserve(f.target, [], "context", { original: true }); writer.commit(token);
      commit.mockClear();
      const result = f.reader.read(f.target);
      expect(result.events[0]).toEqual(token.event);
      expect(result.events[0]).not.toBe(token.event);
      result.assertCurrent();
      expect(adopt).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
      f.hook(() => { throw new Error("ownership lost"); });
      scoped(() => result.assertCurrent(), "context-source-unavailable");
      f.hook(() => {});
      result.assertCurrent(); // No global fail-closed latch in this reader.
      expect(writer.canAppend(f.target.runId)).toBe(true);
    } finally { adopt.mockRestore(); reserve.mockRestore(); commit.mockRestore(); }
  });

  test("refuses async and read-only reentrant callbacks without queues or sticky failure", () => {
    const f = fixture(); fs.writeFileSync(f.path, f.line());
    f.hook(async () => {});
    scoped(() => f.reader.read(f.target), "context-source-unavailable");
    f.hook(() => { f.reader.read(f.target); });
    scoped(() => f.reader.read(f.target), "context-source-unavailable");
    f.hook(() => {});
    const result = f.reader.read(f.target);
    f.hook(() => { result.assertCurrent(); });
    scoped(() => result.assertCurrent(), "context-source-unavailable");
    f.hook(() => {}); result.assertCurrent();
  });

  test("rechecks sources after the final mandatory storage callback", () => {
    const f = fixture(); fs.writeFileSync(f.path, f.line());
    let calls = 0;
    f.hook(() => { if (++calls === 2) fs.appendFileSync(f.path, f.line(2)); });
    scoped(() => f.reader.read(f.target), "context-retention-unproven");
    f.hook(() => {});
    const result = f.reader.read(f.target);
    calls = 0;
    f.hook(() => { if (++calls === 2) fs.appendFileSync(f.path, f.line(3)); });
    scoped(() => result.assertCurrent(), "context-retention-unproven");
    expect(fs.readFileSync(f.path, "utf8")).toBe(f.line() + f.line(2) + f.line(3));
  });

  test("rejects changes during a physical read and always closes the descriptor", () => {
    const f = fixture(); fs.writeFileSync(f.path, f.line());
    const read = fs.readSync, descriptors: number[] = [], close = spyOn(fs, "closeSync");
    let changed = false;
    const mutate = spyOn(fs, "readSync").mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
      const count = read(fd, buffer, offset, length, position);
      if (!changed && buffer.subarray(offset, offset + count).includes(Buffer.from(f.target.runId))) {
        changed = true; descriptors.push(fd); fs.appendFileSync(f.path, f.line(2));
      }
      return count;
    }) as typeof fs.readSync);
    try {
      scoped(() => f.reader.read(f.target));
      expect(changed).toBe(true);
      expect(close.mock.calls.some(call => call[0] === descriptors[0])).toBe(true);
    } finally { mutate.mockRestore(); close.mockRestore(); }
  });

  test("rejects traversal identities and session changes rather than finding another namespace", () => {
    const f = fixture(); fs.writeFileSync(f.path, f.line()); f.reader.read(f.target);
    scoped(() => f.reader.read({ ...f.target, runId: "../manifest" }));
    scoped(() => f.reader.read({ ...f.target, sessionId: crypto.randomUUID() }), "context-retention-unproven");
    expect(fs.readFileSync(f.path, "utf8")).toBe(f.line());
  });
});
