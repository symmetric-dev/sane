import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { RunJournalWriter, type RunJournalReservation } from "./run-journal";
import type { Event, Run } from "./history";

const temporary = "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true }); });
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(temporary, "run-journal-test-"))); roots.push(root);
  const run: Run = { runId: crypto.randomUUID(), sessionId: crypto.randomUUID(), cwd: root, status: "running", createdAt: new Date().toISOString() };
  const events: Event[] = [], published: number[] = [], failures: unknown[] = [];
  let owned = true, guard: () => void = () => {};
  const storageChecks = { count: 0 };
  const writer = new RunJournalWriter(root, { assertStorage: () => { storageChecks.count++; guard(); if (!owned) throw new Error("ownership lost"); }, failClosed: error => { failures.push(error); } });
  const reserve = (kind: Event["kind"] = "stdout", data: unknown = "record", callback = (event: Event) => { published.push(event.seq); }) => {
    const token = writer.reserve(run, events, kind, data, callback); events.push(token.event); return token;
  };
  const path = join(root, `${run.runId}.jsonl`);
  const read = () => fs.readFileSync(path, "utf8").trimEnd().split("\n").map(line => JSON.parse(line) as Event);
  return { root, run, events, writer, failures, reserve, path, read, published, storageChecks,
    guard: (action: () => void) => { guard = action; }, loseOwnership: () => { owned = false; } };
}

describe("one bridge-owned run journal", () => {
  test("private reservation, progress and authority queries guard once without reading journal bytes", () => {
    const f = fixture(), token = f.reserve(), unclaimed = crypto.randomUUID();
    const original = fixture(); original.writer.excludeOriginal(original.run.runId);
    const reads = spyOn(fs, "readFileSync");
    try {
      f.storageChecks.count = 0;
      expect(f.writer.reservation(token.event)).toBe(token);
      expect(f.storageChecks.count).toBe(1);
      expect(f.writer.progress(token)).toEqual({ reserved: 1, appended: 0, durable: 0 });
      expect(f.storageChecks.count).toBe(2);
      f.writer.assertUnclaimed(unclaimed);
      expect(f.storageChecks.count).toBe(3);
      original.storageChecks.count = 0;
      original.writer.assertOriginal(original.run.runId);
      expect(original.storageChecks.count).toBe(1);
      expect(reads).not.toHaveBeenCalled();
    } finally { reads.mockRestore(); }
    expect(fs.existsSync(f.path)).toBe(false);
    expect(f.failures).toEqual([]); expect(original.failures).toEqual([]);
  });

  test("mutations and physical baseline reads retain both guards", () => {
    const f = fixture();
    const twice = (action: () => void) => {
      f.storageChecks.count = 0; action(); expect(f.storageChecks.count).toBe(2);
    };
    twice(() => f.writer.claimNew(f.run));
    let token!: RunJournalReservation;
    twice(() => { token = f.reserve(); });
    twice(() => f.writer.commit(token));
    twice(() => f.writer.flushThrough(token));
    f.storageChecks.count = 0;
    const baseline = f.writer.adoptExisting(f.run);
    expect(f.storageChecks.count).toBe(2);
    twice(() => f.writer.assertCurrentBaseline(baseline));
    twice(() => f.writer.excludeOriginal(f.run.runId));
    expect(f.failures).toEqual([]);
  });

  for (const query of ["reservation", "progress", "unclaimed", "original"] as const) {
    for (const drift of ["ownership", "root", "reentry"] as const) test(`${query} single guard still refuses ${drift}`, () => {
      const f = fixture(), token = f.reserve();
      const unclaimed = crypto.randomUUID(), original = crypto.randomUUID();
      if (query === "original") f.writer.excludeOriginal(original);
      const read = () => {
        if (query === "reservation") return f.writer.reservation(token.event);
        if (query === "progress") return f.writer.progress(token);
        if (query === "unclaimed") return f.writer.assertUnclaimed(unclaimed);
        return f.writer.assertOriginal(original);
      };
      if (drift === "ownership") f.loseOwnership();
      if (drift === "root") {
        const moved = f.root + "-moved"; fs.renameSync(f.root, moved); roots.push(moved); fs.mkdirSync(f.root);
      }
      if (drift === "reentry") f.guard(() => { read(); });
      expect(read).toThrow(drift === "ownership" ? "ownership lost" : drift === "root" ? "directory changed" : "Reentrant");
      f.guard(() => {});
      expect(read).toThrow("reconciliation");
      expect(() => f.writer.commit(token)).toThrow("reconciliation");
      expect(fs.existsSync(f.path)).toBe(false);
      expect(f.failures.length).toBeGreaterThan(0);
    });
  }

  for (const query of ["reservation", "progress"] as const) {
    for (const source of ["copied", "foreign"] as const) test(`${query} refuses ${source} identity without poisoning a valid append`, () => {
      const f = fixture(), token = f.reserve();
      const invalid = source === "copied" ? { event: structuredClone(token.event) } : fixture().reserve();
      f.storageChecks.count = 0;
      expect(() => query === "reservation" ? f.writer.reservation(invalid.event) : f.writer.progress(invalid)).toThrow(query === "reservation" ? "original" : "Foreign");
      expect(f.storageChecks.count).toBe(1);
      expect(f.failures).toEqual([]);
      expect(f.writer.reservation(token.event)).toBe(token);
      f.writer.commit(token);
      expect(f.read()).toEqual(f.events);
      expect(f.failures).toEqual([]);
    });
  }

  test("progress refuses a relinquished token without poisoning another namespace", () => {
    const f = fixture(), token = f.reserve(); f.writer.commit(token); f.writer.excludeOriginal(f.run.runId);
    f.storageChecks.count = 0;
    expect(() => f.writer.progress(token)).toThrow("relinquished");
    expect(f.storageChecks.count).toBe(1);
    expect(f.failures).toEqual([]);
    const run = { runId: crypto.randomUUID(), sessionId: crypto.randomUUID() };
    const next = f.writer.reserveNew(run, "stdout", "record"); f.writer.commit(next);
    expect(fs.readFileSync(join(f.root, `${run.runId}.jsonl`), "utf8")).toBe(JSON.stringify(next.event) + "\n");
    expect(f.failures).toEqual([]);
  });

  for (const namespace of ["reserved", "original"] as const) test(`assertUnclaimed refuses ${namespace} namespace without poisoning a valid append`, () => {
    const f = fixture(), token = f.reserve(), original = crypto.randomUUID();
    if (namespace === "original") f.writer.excludeOriginal(original);
    f.storageChecks.count = 0;
    expect(() => f.writer.assertUnclaimed(namespace === "reserved" ? f.run.runId : original)).toThrow("cannot be repaired");
    expect(f.storageChecks.count).toBe(1);
    expect(f.failures).toEqual([]);
    f.writer.commit(token);
    expect(f.read()).toEqual(f.events);
    expect(f.failures).toEqual([]);
  });

  for (const namespace of ["unclaimed", "reserved"] as const) test(`assertOriginal refuses ${namespace} namespace without poisoning a valid append`, () => {
    const f = fixture(), token = f.reserve();
    f.storageChecks.count = 0;
    expect(() => f.writer.assertOriginal(namespace === "reserved" ? f.run.runId : crypto.randomUUID())).toThrow("exclusive recovery authority");
    expect(f.storageChecks.count).toBe(1);
    expect(f.failures).toEqual([]);
    f.writer.commit(token);
    expect(f.read()).toEqual(f.events);
    expect(f.failures).toEqual([]);
  });

  test("captures immutable bytes before queued work and appends once in reserved order", () => {
    const f = fixture(), data = { text: "\uFEFF 😀\r\nfirst", nested: { value: 1 } };
    const a = f.reserve("stdout", data), b = f.reserve("stderr", "second"), c = f.reserve("context", { type: "third" });
    data.text = "changed"; data.nested.value = 9;
    expect(fs.existsSync(f.path)).toBe(false);
    expect(f.writer.progress(c)).toEqual({ reserved: 3, appended: 0, durable: 0 });
    // A late queued callback can drain predecessors, but cannot reorder them.
    f.writer.commit(b);
    expect(f.read().map(event => event.seq)).toEqual([1, 2]);
    expect(f.read()[0]!.data).toEqual({ text: "\uFEFF 😀\r\nfirst", nested: { value: 1 } });
    f.writer.commit(a); f.writer.commit(c); f.writer.commit(b);
    expect(f.read()).toEqual(f.events);
    expect(f.published).toEqual([1, 2, 3]);
    expect(f.writer.progress(c)).toEqual({ reserved: 3, appended: 3, durable: 0 });
    expect(Object.isFrozen(a.event.data)).toBe(true);
    expect(f.failures).toEqual([]);
  });

  test("synchronous fence consumes pending queued writes without reappend or duplicate publication", async () => {
    const f = fixture(), a = f.reserve(), b = f.reserve(), c = f.reserve("context", { type: "boundary" });
    const later = Promise.resolve().then(() => { f.writer.commit(a); f.writer.commit(b); f.writer.commit(c); });
    f.writer.flushThrough(c);
    expect(f.writer.progress(c)).toEqual({ reserved: 3, appended: 3, durable: 3 });
    const bytes = fs.readFileSync(f.path);
    await later;
    expect(fs.readFileSync(f.path)).toEqual(bytes);
    expect(f.published).toEqual([1, 2, 3]);
  });

  test("normal drains do not fsync each stdout; durable fence syncs file and directory", () => {
    const f = fixture(), sync = spyOn(fs, "fsyncSync");
    try {
      const a = f.reserve(); f.writer.commit(a);
      expect(sync).not.toHaveBeenCalled();
      const b = f.reserve(); f.writer.flushThrough(b);
      expect(sync).toHaveBeenCalledTimes(2);
      expect(f.writer.progress(b).durable).toBe(2);
    } finally { sync.mockRestore(); }
  });
  test("storage ownership is rechecked after the physical fence before publication", () => {
    const f = fixture(), token = f.reserve(), sync = fs.fsyncSync;
    const changed = spyOn(fs, "fsyncSync").mockImplementation(fd => { sync(fd); f.loseOwnership(); });
    try { expect(() => f.writer.flushThrough(token)).toThrow("ownership lost"); }
    finally { changed.mockRestore(); }
    expect(f.published).toEqual([]);
    expect(f.failures.length).toBeGreaterThan(0);
  });

  test("short successful writes continue from the exact byte offset", () => {
    const f = fixture(), token = f.reserve("stdout", "😀".repeat(80)), write = fs.writeSync;
    const partial = spyOn(fs, "writeSync").mockImplementation(((fd: number, bytes: Buffer, offset: number, length: number) => write(fd, bytes, offset, Math.min(length, 11))) as typeof fs.writeSync);
    try { f.writer.flushThrough(token); expect(f.read()).toEqual(f.events); }
    finally { partial.mockRestore(); }
  });

  test("a partial append followed by failure is sticky and never retried from zero", () => {
    const f = fixture(), token = f.reserve("stdout", "payload".repeat(20)), write = fs.writeSync;
    let calls = 0;
    const partial = spyOn(fs, "writeSync").mockImplementation(((fd: number, bytes: Buffer, offset: number, length: number) => {
      if (calls++) throw new Error("injected write failure");
      return write(fd, bytes, offset, Math.min(length, 17));
    }) as typeof fs.writeSync);
    try { expect(() => f.writer.flushThrough(token)).toThrow("injected write failure"); }
    finally { partial.mockRestore(); }
    const bytes = fs.readFileSync(f.path);
    expect(bytes.length).toBe(17);
    expect(f.published).toEqual([]);
    expect(() => f.writer.commit(token)).toThrow("reconciliation");
    expect(fs.readFileSync(f.path)).toEqual(bytes);
    expect(f.failures.length).toBeGreaterThan(0);
  });

  for (const which of ["file", "directory"] as const) test(`${which} fsync failure cannot publish a durable fence or recover through a later commit`, () => {
    const f = fixture(), token = f.reserve(), sync = fs.fsyncSync;
    let calls = 0;
    const broken = spyOn(fs, "fsyncSync").mockImplementation(fd => {
      if (++calls === (which === "file" ? 1 : 2)) throw new Error(`injected ${which} sync failure`);
      return sync(fd);
    });
    try { expect(() => f.writer.flushThrough(token)).toThrow(`injected ${which}`); }
    finally { broken.mockRestore(); }
    expect(f.published).toEqual([]);
    expect(() => f.writer.flushThrough(token)).toThrow("reconciliation");
    expect(f.read()).toEqual(f.events);
  });

  test("a verified historical prefix can be appended without rewriting it or claiming restart completeness", () => {
    const f = fixture(), event: Event = { seq: 5, time: f.run.createdAt, runId: f.run.runId, sessionId: f.run.sessionId, kind: "status", data: { status: "running" } };
    const bytes = JSON.stringify(event) + "\n";
    fs.writeFileSync(f.path, bytes); f.events.push(event);
    const token = f.reserve();
    expect(token.event.seq).toBe(6);
    expect(f.writer.progress(token).durable).toBe(0);
    f.writer.flushThrough(token);
    expect(fs.readFileSync(f.path, "utf8").startsWith(bytes)).toBe(true);
    expect(f.read()).toEqual(f.events);
  });

  for (const kind of ["missing", "torn", "different", "symlink", "hardlink"] as const) test(`refuses ${kind} historical baseline without repair/overwrite`, () => {
    const f = fixture(), event: Event = { seq: 1, time: f.run.createdAt, runId: f.run.runId, sessionId: f.run.sessionId, kind: "status", data: { status: "running" } };
    f.events.push(event);
    if (kind === "torn") fs.writeFileSync(f.path, JSON.stringify(event) + '\n{"seq":2');
    if (kind === "different") fs.writeFileSync(f.path, JSON.stringify({ ...event, data: "other" }) + "\n");
    if (kind === "symlink" || kind === "hardlink") {
      const target = join(f.root, "target"); fs.writeFileSync(target, JSON.stringify(event) + "\n");
      if (kind === "symlink") fs.symlinkSync(target, f.path); else fs.linkSync(target, f.path);
    }
    const before = fs.existsSync(f.path) ? fs.readFileSync(f.path) : null;
    expect(() => f.reserve()).toThrow();
    expect(fs.existsSync(f.path) ? fs.readFileSync(f.path) : null).toEqual(before);
  });

  for (const kind of ["replacement", "truncate", "same-size-edit", "ownership", "namespace"] as const) test(`refuses ${kind} after reservation and retains failure`, () => {
    const f = fixture(), first = f.reserve(); f.writer.commit(first);
    const token = f.reserve();
    if (kind === "replacement") { const replacement = join(f.root, "replacement"); fs.copyFileSync(f.path, replacement); fs.renameSync(replacement, f.path); }
    if (kind === "truncate") fs.truncateSync(f.path, 0);
    if (kind === "same-size-edit") { const bytes = fs.readFileSync(f.path); const index = bytes.indexOf("record"); bytes[index] = "X".charCodeAt(0); fs.writeFileSync(f.path, bytes); }
    if (kind === "ownership") f.loseOwnership();
    if (kind === "namespace") { const replacement = `${f.root}-renamed`; fs.renameSync(f.root, replacement); roots.push(replacement); fs.mkdirSync(f.root); }
    expect(() => f.writer.flushThrough(token)).toThrow();
    expect(f.failures.length).toBeGreaterThan(0);
  });

  test("copied reservations/events never become writer capabilities", () => {
    const f = fixture(), token = f.reserve();
    expect(() => f.writer.commit({ event: token.event })).toThrow("Foreign");
    expect(() => f.writer.commit(token)).toThrow("reconciliation");
    expect(f.failures.length).toBeGreaterThan(0);
    const other = fixture(); const original = other.reserve();
    expect(() => other.writer.reservation(structuredClone(original.event))).toThrow("original");
  });

  test("original-recovery transfer requires consumed reservations and permanently excludes live appends", () => {
    const f = fixture(), token = f.reserve(); f.writer.commit(token);
    f.writer.excludeOriginal(f.run.runId); f.writer.assertOriginal(f.run.runId);
    const bytes = fs.readFileSync(f.path);
    expect(() => f.writer.commit(token)).toThrow("relinquished");
    expect(fs.readFileSync(f.path)).toEqual(bytes);
    const pending = fixture(); pending.reserve();
    expect(() => pending.writer.excludeOriginal(pending.run.runId)).toThrow("pending");
    const excluded = fixture(); excluded.writer.excludeOriginal(excluded.run.runId);
    expect(() => excluded.reserve()).toThrow("Original-recovery");
  });

  test("repair guard refuses an active reservation", () => {
    const f = fixture(); f.writer.assertUnclaimed(f.run.runId); f.reserve();
    expect(() => f.writer.assertUnclaimed(f.run.runId)).toThrow("cannot be repaired");
  });
  test("flushed bytes alone cannot transfer authority while old queue callbacks remain", () => {
    const f = fixture(), token = f.reserve(); f.writer.flushThrough(token);
    expect(() => f.writer.excludeOriginal(f.run.runId)).toThrow("queued callbacks");
    const drained = fixture(), record = drained.reserve(); drained.writer.flushThrough(record); drained.writer.commit(record);
    drained.writer.excludeOriginal(drained.run.runId); drained.writer.assertOriginal(drained.run.runId);
  });

  test("optional publication failure/reentry cannot interrupt a completed append or publish it twice", () => {
    const f = fixture(); let token!: RunJournalReservation, notifications = 0;
    token = f.reserve("stdout", "record", () => { notifications++; f.writer.commit(token); });
    f.writer.commit(token); f.writer.commit(token);
    expect(notifications).toBe(1);
    expect(f.failures).toEqual([]);
    expect(f.read()).toEqual(f.events);
    const next = f.reserve(); f.writer.flushThrough(next);
    expect(f.writer.progress(next).durable).toBe(2);
  });

  test("must-exist baselines retain original live events and reservations without appending", () => {
    const f = fixture(), token = f.reserve("context", { type: "preparation" });
    f.writer.commit(token); f.writer.flushThrough(token);
    const bytes = fs.readFileSync(f.path), baseline = f.writer.adoptExisting(f.run);
    expect(baseline.events[0]).toBe(token.event);
    expect(f.writer.reservation(baseline.events[0]!)).toBe(token);
    f.writer.assertCurrentBaseline(baseline);
    expect(fs.readFileSync(f.path)).toEqual(bytes);
    const status = f.reserve("status", { status: "running" });
    f.writer.commit(status);
    expect(f.read().map(event => event.seq)).toEqual([1, 2]);
    expect(() => f.writer.assertCurrentBaseline(baseline)).toThrow("advanced");
  });

  test("restart baseline events never acquire live reservation branding", () => {
    const f = fixture(), token = f.reserve(); f.writer.commit(token); f.writer.flushThrough(token);
    const writer = new RunJournalWriter(f.root, { assertStorage() {}, failClosed() {} });
    const baseline = writer.adoptExisting({ runId: f.run.runId, sessionId: f.run.sessionId });
    expect(baseline.events).toEqual(f.events);
    expect(baseline.events[0]).not.toBe(token.event);
    writer.assertCurrentBaseline(baseline);
    expect(() => writer.reservation(baseline.events[0]!)).toThrow("original");
  });

  for (const kind of ["missing", "empty", "torn", "unterminated"] as const) test(`must-exist adoption refuses ${kind} bytes without repair`, () => {
    const f = fixture();
    const event = { seq: 1, time: f.run.createdAt, runId: f.run.runId, sessionId: f.run.sessionId, kind: "context", data: {} };
    if (kind !== "missing") fs.writeFileSync(f.path, kind === "empty" ? "" : JSON.stringify(event) + (kind === "torn" ? '\n{"seq":2' : ""));
    const before = fs.existsSync(f.path) ? fs.readFileSync(f.path) : null;
    expect(() => f.writer.adoptExisting(f.run)).toThrow();
    expect(fs.existsSync(f.path) ? fs.readFileSync(f.path) : null).toEqual(before);
    expect(f.failures.length).toBeGreaterThan(0);
  });

  test("must-exist adoption cannot ignore queued commit callbacks or reopen excluded originals", () => {
    const f = fixture(), reservation = f.reserve(); f.writer.flushThrough(reservation);
    expect(() => f.writer.adoptExisting(f.run)).toThrow("queued callbacks");
    const other = fixture(), token = other.reserve(); other.writer.commit(token); other.writer.flushThrough(token);
    other.writer.excludeOriginal(other.run.runId);
    expect(() => other.writer.adoptExisting(other.run)).toThrow("cannot be adopted");
  });

  test("baseline current assertion rehashes the complete protected file and is sticky", () => {
    const f = fixture(), token = f.reserve(); f.writer.commit(token); f.writer.flushThrough(token);
    const baseline = f.writer.adoptExisting(f.run), bytes = fs.readFileSync(f.path);
    bytes[bytes.indexOf("record")] = 88; fs.writeFileSync(f.path, bytes);
    expect(() => f.writer.assertCurrentBaseline(baseline)).toThrow("changed");
    expect(() => f.writer.adoptExisting(f.run)).toThrow("reconciliation");
  });

  test("new namespace reservation refuses preexisting empty files", () => {
    const f = fixture(); fs.writeFileSync(f.path, "");
    expect(() => f.writer.reserveNew(f.run, "context", {})).toThrow("already exists");
    expect(fs.readFileSync(f.path, "utf8")).toBe("");
  });

  test("new namespace stays exclusive if a file appears in a later mandatory guard", () => {
    const root = fs.realpathSync(fs.mkdtempSync(join(temporary, "run-journal-race-test-"))); roots.push(root);
    const target = { runId: crypto.randomUUID(), sessionId: crypto.randomUUID() }, path = join(root, `${target.runId}.jsonl`);
    let guards = 0;
    const writer = new RunJournalWriter(root, { assertStorage() { if (++guards === 2) fs.writeFileSync(path, ""); }, failClosed() {} });
    const token = writer.reserveNew(target, "context", {});
    expect(() => writer.commit(token)).toThrow();
    expect(fs.readFileSync(path, "utf8")).toBe("");
  });

  test("adoption cannot expose mutable historical events different from protected bytes", () => {
    const f = fixture(), event: Event = { seq: 1, time: f.run.createdAt, runId: f.run.runId, sessionId: f.run.sessionId, kind: "context", data: { original: true } };
    fs.writeFileSync(f.path, JSON.stringify(event) + "\n"); f.events.push(event);
    const token = f.reserve(); f.writer.commit(token); f.writer.flushThrough(token);
    event.data = { changed: true };
    expect(() => f.writer.adoptExisting(f.run)).toThrow("events changed");
  });
});
