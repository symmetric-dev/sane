import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, statSync, writeFileSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

type Pin = { dev: number; ino: number };
const same = (a: Pin, b: Pin) => a.dev === b.dev && a.ino === b.ino;
function unsafe(): never { throw new Error("Unsafe or replaced science storage path"); }

/** Mirrors EnvironmentFileSystem / ConfinedLifecycleFileSystem's cooperative
 * contract. Linux procfs permits traversal relative to held directory handles.
 * Darwin (and Linux without procfs) uses checked absolute paths: Node's fs API
 * provides no openat/renameat. Checks cannot exclude an external syscall race.
 * Handles are scoped to each operation; pins retain only explicitly admitted
 * data/generation/chat directories, never the unbounded set of content versions.
 */
export class ScienceStorageFiles {
  private pins = new Map<string, Pin>();
  constructor(private root: string) {}
  private within(path: string) {
    if (!isAbsolute(this.root) || resolve(this.root) !== this.root || resolve(path) !== path || path !== this.root && !path.startsWith(this.root + sep)) unsafe();
  }
  private directory<T>(path: string, action: (access: string, fd: number, verify: () => void) => T): T {
    this.within(path);
    const held: { path: string; fd: number; stat: Stats }[] = [];
    const verify = () => {
      for (const h of held) {
        const current = lstatSync(h.path), actual = fstatSync(h.fd), pin = this.pins.get(h.path);
        if (!current.isDirectory() || current.isSymbolicLink() || !actual.isDirectory() || !same(current, actual) || !same(h.stat, actual) || pin && !same(pin, actual)) unsafe();
      }
    };
    try {
      let cursor = parse(path).root, access = cursor;
      for (const part of ["", ...path.slice(cursor.length).split(sep).filter(Boolean)]) {
        if (part) { cursor = join(cursor, part); access = join(access, part); }
        const fd = openSync(access, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let stat: Stats;
        try { stat = fstatSync(fd); } catch (e) { closeSync(fd); throw e; }
        held.push({ path: cursor, fd, stat });
        verify();
        access = cursor;
        if (process.platform === "linux") {
          const relative = `/proc/self/fd/${fd}`;
          try { if (same(statSync(relative), stat)) access = relative; }
          catch { /* No procfs: the documented cooperative absolute-path mode. */ }
        }
      }
      verify();
      if (path === this.root) for (const h of held) this.pins.set(h.path, h.stat);
      const result = action(access, held.at(-1)!.fd, verify);
      verify(); return result;
    } finally { for (const h of held.reverse()) closeSync(h.fd); }
  }
  pin(path: string) {
    this.directory(path, (_access, fd) => { this.pins.set(path, fstatSync(fd)); });
  }
  mkdir(parent: string, name: string, existing = false) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) unsafe();
    const path = join(parent, name);
    this.directory(parent, (access, fd, verify) => {
      verify();
      try { mkdirSync(join(access, name), { mode: 0o700 }); }
      catch (e) { if (!existing || (e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
      verify(); fsyncSync(fd);
    });
    this.directory(path, () => {});
    return path;
  }
  read(path: string, limit: number, optional = false): string | undefined {
    this.within(path);
    return this.directory(dirname(path), (access, _directoryFd, verify) => {
      const name = path.slice(dirname(path).length + 1);
      let fd: number;
      try { fd = openSync(join(access, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (e) { if (optional && (e as NodeJS.ErrnoException).code === "ENOENT") { verify(); return undefined; } throw e; }
      try {
        const before = fstatSync(fd);
        if (!before.isFile() || before.nlink !== 1 || before.size > limit) unsafe();
        verify();
        // Even a concurrently growing file consumes at most limit + 1 bytes.
        const chunks: Buffer[] = []; let size = 0;
        while (size <= limit) {
          const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - size));
          const count = readSync(fd, chunk, 0, chunk.length, null);
          if (!count) break;
          size += count;
          if (size > limit) throw new Error("Science storage read exceeds byte budget");
          chunks.push(chunk.subarray(0, count));
        }
        const after = fstatSync(fd), current = lstatSync(join(access, name));
        if (!after.isFile() || after.nlink !== 1 || !current.isFile() || !same(current, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || size !== after.size) unsafe();
        verify(); return Buffer.concat(chunks, size).toString("utf8");
      } finally { closeSync(fd); }
    });
  }
  write(path: string, text: string) {
    this.within(path);
    this.directory(dirname(path), (access, directoryFd, verify) => {
      const name = path.slice(dirname(path).length + 1), target = join(access, name);
      const temporary = join(access, `.${name}.${randomUUID()}.tmp`);
      let before: Stats | undefined;
      try { before = lstatSync(target); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      if (before && (!before.isFile() || before.nlink !== 1)) unsafe();
      verify();
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        const created = fstatSync(fd);
        if (!created.isFile() || created.nlink !== 1) unsafe();
        verify(); writeFileSync(fd, text); fsyncSync(fd);
        let current: Stats | undefined;
        try { current = lstatSync(target); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
        if (before ? !current || !same(before, current) || !current.isFile() || current.nlink !== 1 : current) unsafe();
        const staged = lstatSync(temporary);
        if (!staged.isFile() || staged.nlink !== 1 || !same(staged, created)) unsafe();
        verify(); // Last admission before atomic reference publication.
        renameSync(temporary, target);
        verify();
        const published = lstatSync(target);
        if (!published.isFile() || published.nlink !== 1 || !same(published, created)) unsafe();
        fsyncSync(directoryFd); verify();
      } finally { closeSync(fd); }
    });
  }
}
