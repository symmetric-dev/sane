import { constants, openSync, closeSync, lstatSync, fstatSync, realpathSync, readSync, writeSync, fsyncSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isImageUploadReceipt, type ImageUploadReceipt } from "../shared/image-upload-contract";
import type { ImageUploadFs } from "./image-upload-fs";
import { WorkspaceError } from "./workspace";
import type { ExclusiveMove } from "./workspace-safe-rename";

const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const unavailable = () => new WorkspaceError(503, "image-upload-storage", "Image upload recovery storage is unavailable; do not retry with a new request ID");
export const imageUploadStorageKey = (workspaceId: string, worktreeId: string, uploadId: string) => createHash("sha256").update(JSON.stringify([workspaceId, worktreeId, uploadId.toLowerCase()])).digest("hex");

/** Two immutable, fsynced records: intent BEFORE repo creation, receipt AFTER
 * verification. An orphan intent is deliberately uncertain, never auto-replayed.
 * Metadata is independent of the mutable repo and survives process restarts. */
export class ImageUploadStore {
  readonly path: string;
  private dataIdentity?: Stats;
  private identity?: Stats;
  private failed = false;
  constructor(private dataDir: string, private fs: ImageUploadFs, private publish: ExclusiveMove, private assertAcl: (fd: number) => void) { this.path = join(dataDir, "image-uploads"); }
  withRoot<T>(action: (fd: number, check: () => void) => T): T {
    if (this.failed) throw unavailable();
    let dataFd: number | undefined, fd: number | undefined;
    try {
      const ancestors: { path: string; info: Stats }[] = [];
      for (let path = dirname(this.dataDir);;) {
        ancestors.push({ path, info: lstatSync(path) });
        const parent = dirname(path); if (parent === path) break; path = parent;
      }
      const checkAncestors = () => {
        for (const pin of ancestors) {
          const current = lstatSync(pin.path);
          if (!same(current, pin.info) || !current.isDirectory() || current.isSymbolicLink()
            || current.uid !== process.getuid?.() && current.uid !== 0
            || (current.mode & 0o022) !== 0 && (current.mode & 0o1000) === 0
            || realpathSync(pin.path) !== pin.path) throw unavailable();
          const parentFd = openSync(pin.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          try {
            if (!same(fstatSync(parentFd), current)) throw unavailable();
            this.assertAcl(parentFd);
          } finally { closeSync(parentFd); }
        }
      };
      checkAncestors();
      const data = lstatSync(this.dataDir);
      if (!data.isDirectory() || data.isSymbolicLink() || data.uid !== process.getuid?.() || data.mode & 0o022 || realpathSync(this.dataDir) !== this.dataDir || this.dataIdentity && !same(data, this.dataIdentity)) throw unavailable();
      this.dataIdentity ??= data;
      dataFd = openSync(this.dataDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      if (!same(fstatSync(dataFd), data)) throw unavailable();
      this.assertAcl(dataFd);
      try { fd = this.fs.openAt(dataFd, "image-uploads", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || this.identity) throw error;
        this.fs.mkdirAt(dataFd, "image-uploads", 0o700); fsyncSync(dataFd);
        fd = this.fs.openAt(dataFd, "image-uploads", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      }
      const info = fstatSync(fd);
      if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o700 || this.identity && !same(info, this.identity)) throw unavailable();
      this.assertAcl(fd);
      this.identity ??= info;
      const check = () => {
        checkAncestors();
        const nowData = lstatSync(this.dataDir), now = lstatSync(this.path);
        if (!same(nowData, data) || !same(now, info) || !same(fstatSync(fd!), info) || nowData.isSymbolicLink() || now.isSymbolicLink() || nowData.mode & 0o022 || (now.mode & 0o7777) !== 0o700 || realpathSync(this.path) !== this.path) throw unavailable();
        this.assertAcl(dataFd!); this.assertAcl(fd!);
      };
      check(); const result = action(fd, check); check(); return result;
    } catch (error) {
      if (error instanceof WorkspaceError && error.code !== "image-upload-storage") throw error;
      this.failed = true; throw unavailable();
    } finally { if (fd !== undefined) closeSync(fd); if (dataFd !== undefined) closeSync(dataFd); }
  }
  private read(fd: number, name: string): ImageUploadReceipt | undefined {
    let file: number;
    try { file = this.fs.openAt(fd, name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    try {
      const before = fstatSync(file);
      if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || (before.mode & 0o7777) !== 0o400 || before.size < 1 || before.size > 32 * 1024) throw unavailable();
      const bytes = Buffer.alloc(before.size); let at = 0;
      while (at < bytes.length) { const n = readSync(file, bytes, at, bytes.length - at, at); if (!n) throw unavailable(); at += n; }
      const after = fstatSync(file);
      if (!same(before, after) || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.nlink !== 1) throw unavailable();
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!isImageUploadReceipt(value)) throw unavailable(); return value;
    } finally { closeSync(file); }
  }
  lookup(key: string): { intent?: ImageUploadReceipt; receipt?: ImageUploadReceipt } {
    return this.withRoot(fd => {
      const intent = this.read(fd, `${key}.intent`), receipt = this.read(fd, `${key}.receipt`);
      if (receipt && (!intent || JSON.stringify(receipt) !== JSON.stringify(intent))) throw unavailable();
      for (const value of [intent, receipt]) if (value && imageUploadStorageKey(value.workspaceId, value.worktreeId, value.uploadId) !== key) throw unavailable();
      return { intent, receipt };
    });
  }
  write(key: string, phase: "intent" | "receipt", value: ImageUploadReceipt): void {
    this.withRoot((fd, check) => {
      if (!isImageUploadReceipt(value) || imageUploadStorageKey(value.workspaceId, value.worktreeId, value.uploadId) !== key) throw unavailable();
      check();
      // The 0700 app-owned root trusts same-UID processes, not other OS users.
      // Never expose a partial final record: a crashed private temporary is
      // ignored, whereas a complete intent without receipt remains uncertain.
      const temporary = `.metadata-${randomUUID()}.tmp`, destination = `${key}.${phase}`;
      const bytes = Buffer.from(JSON.stringify(value)), digest = createHash("sha256").update(bytes).digest("hex");
      if (bytes.length > 32 * 1024) throw unavailable();
      const file = this.fs.openAt(fd, temporary, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
      let committed = false;
      try {
        let at = 0;
        while (at < bytes.length) { const n = writeSync(file, bytes, at, bytes.length - at, at); if (!n) throw unavailable(); at += n; }
        fsyncSync(file);
        const info = fstatSync(file);
        if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o400 || info.size !== bytes.length) throw unavailable();
        const actual = Buffer.alloc(bytes.length); at = 0;
        while (at < actual.length) { const n = readSync(file, actual, at, actual.length - at, at); if (!n) throw unavailable(); at += n; }
        if (createHash("sha256").update(actual).digest("hex") !== digest) throw unavailable();
        const source = this.fs.openAt(fd, temporary, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const linked = fstatSync(source), opened = fstatSync(file);
          if (!same(linked, info) || !same(opened, info) || linked.nlink !== 1 || opened.nlink !== 1 || opened.size !== info.size || opened.mtimeMs !== info.mtimeMs || opened.ctimeMs !== info.ctimeMs) throw unavailable();
          check(); this.publish(fd, temporary, fd, destination); committed = true;
        } finally { closeSync(source); }
        fsyncSync(fd); check();
        const final = this.fs.openAt(fd, destination, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try { const current = fstatSync(final); if (!same(current, info) || current.nlink !== 1 || current.size !== info.size || current.mtimeMs !== info.mtimeMs) throw unavailable(); }
        finally { closeSync(final); }
      } finally {
        try {
          if (!committed) {
            check();
            const source = this.fs.openAt(fd, temporary, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
              const current = fstatSync(source), owned = fstatSync(file);
              if (same(current, owned) && current.isFile() && current.nlink === 1) this.fs.unlinkAt(fd, temporary);
            } finally { closeSync(source); }
          }
        } finally { closeSync(file); }
      }
    });
  }
}
