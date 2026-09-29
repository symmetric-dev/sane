import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync, renameSync, unlinkSync, linkSync } from "node:fs"
import { randomUUID } from "node:crypto"
import type { Stats } from "node:fs"
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path"
import { LifecycleAccessError, type LifecycleFileSystem } from "./lifecycle-filesystem.ts"

/**
 * Same-event-loop confinement, not an external-process atomic sandbox.
 * Ancestor checks + access are synchronous; leaf opens use O_NOFOLLOW. Node/Bun
 * lacks directory-fd-relative traversal here, so external syscall races remain.
 */
export class ConfinedLifecycleFileSystem implements LifecycleFileSystem {
  private readonly directories = new Map<string, { dev: number; ino: number }>()
  private readonly root: string
  private readonly readRoots: string[]
  constructor(root: string, readRoots: string[] = []) {
    this.root = resolve(root)
    this.readRoots = [this.root, ...readRoots.map(path => resolve(path))]
    for (const path of this.readRoots) this.check(path, false, false)
    this.assertTree()
  }
  private reject(path: string, reason: string): never { throw new LifecycleAccessError(`Unsafe lifecycle access: ${reason}: ${path}`) }
  private within(root: string, path: string): boolean {
    const rel = relative(root, path)
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  }
  private directory(path: string, stat: Stats): void {
    if (!stat.isDirectory()) this.reject(path, "expected directory, not a symlink or other file type")
    const pin = this.directories.get(path)
    if (pin && (pin.dev !== stat.dev || pin.ino !== stat.ino)) this.reject(path, "directory identity changed")
    this.directories.set(path, { dev: stat.dev, ino: stat.ino })
  }
  private check(path: string, write: boolean, missing: boolean): Stats | undefined {
    if (!isAbsolute(path) || path.includes("\0")) this.reject(path, "expected absolute path")
    path = resolve(path)
    if (!(write ? [this.root] : this.readRoots).some(root => this.within(root, path))) this.reject(path, "outside explicit roots")
    let cursor = parse(path).root
    const parts = path.slice(cursor.length).split(sep).filter(Boolean)
    for (let i = 0; i < parts.length; i++) {
      cursor = join(cursor, parts[i]!)
      let stat: Stats
      try { stat = lstatSync(cursor) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          if (this.directories.has(cursor)) this.reject(cursor, "pinned directory disappeared")
          if (missing) return undefined
        }
        throw error
      }
      if (stat.isSymbolicLink()) this.reject(cursor, "symlink is not permitted")
      if (this.directories.has(cursor)) this.directory(cursor, stat)
      if (i < parts.length - 1 || stat.isDirectory()) this.directory(cursor, stat)
      else if (!stat.isFile() || stat.nlink !== 1) this.reject(cursor, "expected unshared regular file")
      if (i === parts.length - 1) return stat
    }
    return lstatSync(cursor)
  }
  stat(path: string): Stats { return this.check(path, false, false)! }
  private fileDescriptor(path: string, flags: number): number {
    const before = this.check(path, false, false)
    if (!before?.isFile()) this.reject(path, "expected regular file")
    const fd = openSync(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const actual = fstatSync(fd)
      if (!actual.isFile() || actual.nlink !== 1 || before.dev !== actual.dev || before.ino !== actual.ino) this.reject(path, "file identity changed")
      this.check(path, false, false)
      return fd
    } catch (error) { closeSync(fd); throw error }
  }
  readBytes(path: string): Buffer {
    const fd = this.fileDescriptor(path, constants.O_RDONLY)
    try { return readFileSync(fd) } finally { closeSync(fd) }
  }
  readText(path: string): string { return this.readBytes(path).toString("utf8") }
  listNames(path: string): string[] {
    if (!this.check(path, false, false)?.isDirectory()) this.reject(path, "expected directory")
    return readdirSync(path)
  }
  mkdir(path: string): void {
    this.check(path, true, true)
    // Create/check one component at a time, pinning every created ancestor.
    const ensure = (directory: string): void => {
      const stat = this.check(directory, true, true)
      if (stat) { if (!stat.isDirectory()) this.reject(directory, "expected directory"); return }
      ensure(dirname(directory))
      this.check(directory, true, true)
      mkdirSync(directory)
      this.check(directory, true, false)
    }
    ensure(resolve(path))
  }
  writeBytes(path: string, bytes: Buffer, exclusive: boolean): void {
    const before = this.check(path, true, true)
    if (exclusive && before) throw Object.assign(new Error(`File exists: ${path}`), { code: "EEXIST" })
    const temporary = join(dirname(path), `.sane-${randomUUID()}.tmp`)
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1) this.reject(path, "expected unshared regular file")
      writeFileSync(fd, bytes)
      const current = this.check(path, true, true)
      if ((before && (!current || before.dev !== current.dev || before.ino !== current.ino)) || (!before && current)) this.reject(path, "publication target identity changed")
      this.check(temporary, true, false)
      // link+unlink provides exclusive no-replace publication of a new file;
      // replacements use checked same-directory rename. External syscall races
      // remain outside this cooperative confinement contract.
      if (!before) { linkSync(temporary, path); unlinkSync(temporary) }
      else renameSync(temporary, path)
    } finally { closeSync(fd); try { unlinkSync(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error } }
  }
  /** Synchronous final admission before returning evidence or committing authority. */
  assertTree(): void {
    const visit = (path: string): void => {
      const stat = this.check(path, false, false)!
      if (stat.isDirectory()) for (const name of this.listNames(path)) visit(join(path, name))
    }
    visit(this.root)
  }
}
